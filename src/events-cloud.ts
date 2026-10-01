// The backbone cursor belongs to tenant_events, never the replica's change_log.
import { normalizeBaseUrl, requireConfig, type Ctx } from "./config.js";
import { CliError } from "./errors.js";
import { bearerFor } from "./oauth.js";
import type { CachedEvent } from "./events.js";

const headHeader = "x-catalyst-event-backbone-head-seq";
const maxLine = 1_048_576;
// A filtered page is JSON, sized by the server to about 1 MiB; anything far past that is not ours.
const maxQueryBody = 16 * maxLine;
const queryLimit = 200;
const maxLagPoll = 8_000;
// CTC-4562 — once the cloud pushes events, the replay is only a safety net for a silent socket.
const pushedFallback = 600_000;
const polledFallback = 30_000;
export interface EventSocket extends EventTarget {
  readyState: number;
  send(data: string): void;
  close(): void;
}
/** Selects the server's filtered events query; callers still filter what arrives. */
export interface CloudEventFilter {
  type?: string;
  ticket?: string;
}
export interface CloudEventDeps {
  socket?: (url: string) => EventSocket;
  /** Called after each failed attempt while the cloud is unreachable: consecutive failures, and
   *  when the first of them happened (epoch ms). */
  onTrouble?: (state: { failures: number; sinceMs: number }) => void;
  /** Called once the cloud answers again after a failure. */
  onHealthy?: () => void;
}

/** A short, credential-free name for why the cloud could not be reached. */
export function unreachableKind(error: unknown): string {
  if (error instanceof RetryRequest) return "service unavailable";
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timed out";
  if (error instanceof TypeError) return "network error";
  return "service unavailable";
}

/** CTC-4554 — an unreachable cloud is a named failure with its own exit code, never a crash. The
 *  message names only the kind: a transport error can carry a URL with a credential in it. */
export function unreachableError(error: unknown): CliError {
  return new CliError(`the cloud event service is unreachable (${unreachableKind(error)}); try again shortly`, "events-unreachable", 4);
}

function sequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function protocol(message: string): CliError {
  return new CliError(message, "events-protocol");
}
class RetryRequest extends Error {
  constructor(readonly delayMs: number) { super("cloud event service unavailable"); }
}

// Cancel this reader's wait without cancelling a refresh shared with another command.
function eventBearer(ctx: Ctx, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let authStatus: number | undefined;
    const authCtx: Ctx = { ...ctx, fetch: async (input, init) => {
      const response = await ctx.fetch(input, init);
      authStatus = response.status;
      return response;
    } };
    bearerFor(authCtx, requireConfig(ctx)).then(resolve, (error: unknown) => {
      // The shared helper has no typed retry status. Unknown shared failures may retry;
      // a refresh we own records its actual response, including terminal 4xx refusals.
      const transient = error instanceof CliError && (error.code === "network" ||
        authStatus === 429 || (authStatus !== undefined && authStatus >= 500) ||
        (error.code === "session-refresh-failed" && authStatus === undefined));
      reject(error instanceof CliError && !transient
        ? new CliError("cloud event authentication failed; run catalyst login", "events-auth")
        : new Error("cloud event authentication temporarily unavailable"));
    }).finally(() => signal.removeEventListener("abort", abort));
  });
}

function responseHead(response: Response): number {
  const raw = response.headers.get(headHeader);
  const head = raw === null || raw.trim() === "" ? NaN : Number(raw);
  if (!sequence(head)) throw protocol("cloud event head could not be verified");
  return head;
}
function eventsUrl(ctx: Ctx, route: "backbone" | "query", params: Record<string, string | undefined>): URL {
  const url = new URL(`${normalizeBaseUrl(requireConfig(ctx).baseUrl)}/api/v1/events/${route}`);
  for (const [name, value] of Object.entries(params)) if (value) url.searchParams.set(name, value);
  return url;
}
async function request(ctx: Ctx, since: number, signal: AbortSignal): Promise<Response> {
  return send(ctx, eventsUrl(ctx, "backbone", { since: String(since) }), "application/x-ndjson", [409], signal);
}
async function send(ctx: Ctx, url: URL, accept: string, allowed: number[], signal: AbortSignal): Promise<Response> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const token = await eventBearer(ctx, bounded);
  bounded.throwIfAborted();
  const response = await ctx.fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept },
    signal: bounded,
    redirect: "error",
  });
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new CliError("cloud event access refused; check catalyst status and sign in again", "events-auth", 2, response.status);
  }
  if (response.status !== 200 && !allowed.includes(response.status)) {
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel();
      const raw = response.headers.get("retry-after");
      const seconds = raw === null ? NaN : Number(raw);
      const delay = Number.isFinite(seconds) ? seconds * 1_000 : raw ? Date.parse(raw) - ctx.now().getTime() : 0;
      throw new RetryRequest(Number.isFinite(delay) ? Math.min(300_000, Math.max(0, delay)) : 0);
    }
    throw new CliError(`cloud event request refused (HTTP ${response.status}${await refusalReason(response)})`, "events-http", 2, response.status);
  }
  return response;
}

/** The server's own reason for a refusal, e.g. `: unknown_event_type (nope)`; empty when it gave none. */
async function refusalReason(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.length > maxLine) return "";
    const body = JSON.parse(text) as { error?: unknown; types?: unknown };
    if (typeof body.error !== "string") return "";
    return `: ${body.error}${Array.isArray(body.types) ? ` (${body.types.join(", ")})` : ""}`;
  } catch {
    return "";
  }
}

/** Probe the head without downloading the backlog. An ahead-of-head cursor is deliberate. */
export async function cloudEventHead(ctx: Ctx, signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<number> {
  const response = await request(ctx, Number.MAX_SAFE_INTEGER, signal);
  try {
    const head = responseHead(response);
    // A successful empty response is possible only at the maximum safe sequence.
    if (response.status !== 409 && head !== Number.MAX_SAFE_INTEGER)
      throw protocol("cloud event head probe did not return an ahead-of-head response");
    return head;
  } finally { await response.body?.cancel(); }
}

/** One page of the cloud's filtered events query (CTC-4549), as `catalyst events query` prints it. */
export interface CloudEventQueryPage {
  /** Events as the server sent them; one whose archived body is unavailable is a stub with `bodyUnavailable: true`. */
  events: Record<string, unknown>[];
  next: { param: "beforeSeq" | "afterSeq"; value: number } | null;
  coverage: { indexedFromSeq: number | null; indexedToSeq: number | null };
}
export interface CloudEventQuery {
  ticket?: string;
  type?: string;
  limit: number;
  order: "asc" | "desc";
  afterSeq?: number;
  beforeSeq?: number;
}

/** CTC-4554 — read one page of `GET /api/v1/events/query`. A refusal names the server's reason. */
export async function queryCloudEvents(ctx: Ctx, query: CloudEventQuery, signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<CloudEventQueryPage> {
  const url = eventsUrl(ctx, "query", {
    order: query.order,
    limit: String(query.limit),
    type: query.type,
    ticket: query.ticket,
    afterSeq: query.afterSeq === undefined ? undefined : String(query.afterSeq),
    beforeSeq: query.beforeSeq === undefined ? undefined : String(query.beforeSeq),
  });
  let response: Response;
  try {
    response = await send(ctx, url, "application/json", [400, 404, 413], signal);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw unreachableError(error);
  }
  if (response.status === 404) {
    await response.body?.cancel();
    throw new CliError("this cloud does not serve the events query yet; read the local cache with --from-cache", "events-unavailable", 2, 404);
  }
  const text = await response.text();
  if (text.length > maxQueryBody) throw protocol("cloud event query response exceeds its size limit");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw protocol("cloud event query returned invalid JSON"); }
  const page = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (response.status !== 200) {
    const reason = typeof page.error === "string" ? page.error : "no reason given";
    const detail = Array.isArray(page.types) ? ` (${page.types.join(", ")})` : "";
    throw new CliError(`the cloud refused the events query: ${reason}${detail} (HTTP ${response.status})`, "events-http", 2, response.status);
  }
  const account = requireConfig(ctx).account;
  if (!Array.isArray(page.events)) throw protocol("cloud event query returned an invalid page");
  for (const value of page.events) {
    const event = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    if (event.tenantId !== account || !sequence(event.sequence) || typeof event.eventId !== "string" || typeof event.type !== "string")
      throw protocol("cloud event query contains an invalid tenant or event");
  }
  const next = page.next as { param?: unknown; value?: unknown } | null | undefined;
  if (next !== null && !(next && (next.param === "beforeSeq" || next.param === "afterSeq") && sequence(next.value)))
    throw protocol("cloud event query returned an invalid next cursor");
  const coverage = (page.coverage ?? {}) as { indexedFromSeq?: unknown; indexedToSeq?: unknown };
  const bound = (v: unknown) => (sequence(v) ? v : null);
  return {
    events: page.events as Record<string, unknown>[],
    next: next === null ? null : { param: next.param as "beforeSeq" | "afterSeq", value: next.value as number },
    coverage: { indexedFromSeq: bound(coverage.indexedFromSeq), indexedToSeq: bound(coverage.indexedToSeq) },
  };
}

interface PageEnd {
  /** Every event at or below this sequence was delivered or excluded by the server's filter. */
  through: number;
  /** The server has more right now: ask again without waiting. */
  more: boolean;
  /** The backbone head the page saw, when it reports one. */
  head?: number;
}
/** The query route cannot serve this cursor: `absent` for good (404), `uncovered` for this page. */
type Fallback = "absent" | "uncovered";

function validEvent(ctx: Ctx, value: unknown, cursor: number): value is CachedEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<CachedEvent> & { bodyUnavailable?: unknown };
  if (event.tenantId !== requireConfig(ctx).account || !sequence(event.sequence) || event.sequence <= cursor ||
    typeof event.eventId !== "string" || typeof event.type !== "string") return false;
  // CTC-4554 — an event whose archived body is unavailable arrives as a stub (tenantId, sequence,
  // eventId, type, ticket, bodyUnavailable, reason). It is printed as is, and the cursor moves past it.
  if (event.bodyUnavailable === true) return true;
  return typeof event.recordedAt === "string" && "payload" in event;
}

// A page closed early by its consumer ends with undefined.
async function* replay(ctx: Ctx, after: number, signal: AbortSignal): AsyncGenerator<CachedEvent, PageEnd | undefined> {
  const response = await request(ctx, after, signal);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const head = responseHead(response);
    if (response.status === 409)
      throw new CliError(`cloud refused event cursor ${after} (head ${head}); history may be missing or the cursor may be ahead. Inspect events status before choosing a new --after cursor`, "events-gap", 2, 409);
    if (head < after) throw protocol("cloud event head moved behind the requested cursor");
    if (!response.body) throw protocol("cloud event replay body is absent");
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let cursor = after;
    const parse = (line: string): CachedEvent => {
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw protocol("cloud event replay contains invalid JSON"); }
      if (!value || typeof value !== "object") throw protocol("cloud event replay contains an invalid event");
      if (!validEvent(ctx, value, cursor)) throw protocol("cloud event replay contains an invalid tenant or event sequence");
      cursor = value.sequence;
      return value;
    };
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      try { buffer += decoder.decode(value, { stream: !done }); }
      catch { throw protocol("cloud event replay contains invalid UTF-8"); }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        if (newline > maxLine) throw protocol("cloud event exceeds the replay line limit");
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) { signal.throwIfAborted(); yield parse(line); }
      }
      if (buffer.length > maxLine) throw protocol("cloud event exceeds the replay line limit");
      if (done) break;
    }
    if (buffer.trim()) { signal.throwIfAborted(); yield parse(buffer.trim()); }
    if (cursor === after && cursor < head) throw protocol("cloud event replay made no progress toward its head");
    return { through: cursor, more: cursor < head, head };
  } finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    else await response.body?.cancel();
  }
}

// One page of the indexed, filtered query (CTC-4549). The index fills after the archive write, so
// `coverage.indexedToSeq` may trail the head; the reader polls until it catches up.
async function* queryPage(ctx: Ctx, after: number, filter: CloudEventFilter, signal: AbortSignal): AsyncGenerator<CachedEvent, PageEnd | Fallback | undefined> {
  const url = eventsUrl(ctx, "query", { order: "asc", afterSeq: String(after), limit: String(queryLimit), type: filter.type, ticket: filter.ticket });
  const response = await send(ctx, url, "application/json", [404, 413], signal);
  if (response.status === 404) { await response.body?.cancel(); return "absent"; }
  if (response.status === 413) {
    // CTC-4554 — one event over the 1 MiB page limit: skip it with a warning and move past it,
    // rather than failing the tail and hitting the same event on every resume.
    let skipped: { sequence?: unknown; eventBytes?: unknown } = {};
    try { skipped = JSON.parse(await response.text()) as typeof skipped; } catch { /* named below */ }
    if (!sequence(skipped.sequence) || skipped.sequence <= after) throw protocol("cloud event query refused an over-limit event without naming it");
    ctx.stderr(`events: skipped event ${skipped.sequence}: it is larger than the 1 MiB page limit${sequence(skipped.eventBytes) ? ` (${skipped.eventBytes} bytes)` : ""}`);
    return { through: skipped.sequence, more: true };
  }
  const text = await response.text();
  if (text.length > maxQueryBody) throw protocol("cloud event query response exceeds its size limit");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw protocol("cloud event query returned invalid JSON"); }
  const page = (body && typeof body === "object" ? body : {}) as { events?: unknown; next?: unknown; coverage?: { indexedFromSeq?: unknown; indexedToSeq?: unknown } | null };
  if (!Array.isArray(page.events) || !("next" in page)) throw protocol("cloud event query returned an invalid page");
  const from = page.coverage?.indexedFromSeq;
  const to = page.coverage?.indexedToSeq;
  // Nothing indexed yet, or the cursor sits below the index floor: only the backbone has that range.
  if (from === null || to === null || from === undefined || to === undefined) return "uncovered";
  if (!sequence(from) || !sequence(to)) throw protocol("cloud event query coverage is invalid");
  if (after + 1 < from) return "uncovered";
  let cursor = after;
  const events: CachedEvent[] = [];
  for (const value of page.events) {
    if (!validEvent(ctx, value, cursor)) throw protocol("cloud event query contains an invalid tenant or event sequence");
    cursor = value.sequence;
    events.push(value);
  }
  for (const event of events) { signal.throwIfAborted(); yield event; }
  if (page.next !== null) {
    if (cursor === after) throw protocol("cloud event query made no progress toward its next page");
    return { through: cursor, more: true };
  }
  return { through: Math.max(cursor, to), more: false };
}

/** A validated `events` frame (CTC-4562): every match in (after, through], or a range to catch up. */
interface PushFrame {
  after: number;
  through: number;
  /** True when the frame does not carry every match in its range. */
  gap: boolean;
  events: CachedEvent[];
}

function pushFrame(ctx: Ctx, raw: Record<string, unknown>): PushFrame {
  const { after, through } = raw;
  if (!sequence(after) || !sequence(through) || through < after || !Array.isArray(raw.events))
    throw protocol("cloud events frame has invalid bounds");
  let cursor = after;
  let gap = raw.gap === true;
  const events: CachedEvent[] = [];
  for (const value of raw.events) {
    // An event too large to push arrives as a summary; the catch-up read returns it whole.
    if (value && typeof value === "object" && (value as { payloadOmitted?: unknown }).payloadOmitted === true) {
      gap = true;
      const seq = (value as { sequence?: unknown }).sequence;
      if (sequence(seq) && seq > cursor) cursor = seq;
      continue;
    }
    if (!validEvent(ctx, value, cursor) || value.sequence > through)
      throw protocol("cloud events frame contains an invalid tenant or event sequence");
    cursor = value.sequence;
    events.push(value);
  }
  return { after, through, gap, events };
}

function pause(ms: number, signal: AbortSignal, wakes?: EventTarget): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      wakes?.removeEventListener("wake", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    wakes?.addEventListener("wake", done, { once: true });
  });
}

/** Foreground push subscription with durable replay, reconnecting from the last yielded cursor. */
export async function* cloudEvents(ctx: Ctx, options: { after?: number; filter?: CloudEventFilter; signal: AbortSignal }, deps: CloudEventDeps = {}): AsyncGenerator<CachedEvent> {
  const { signal } = options;
  const filter = options.filter ?? {};
  let cursor = options.after;
  let backoff = 1_000;
  // A filter reads the server's index; a server without the route gets the backbone for the whole run.
  let indexed = Boolean(filter.type || filter.ticket);
  let lagPoll = 1_000;
  // CTC-4554 — consecutive failed attempts, so a caller can tell an outage from a quiet stream.
  let failures = 0;
  let failingSince: number | undefined;
  while (!signal.aborted) {
    let socket: EventSocket | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    const wakes = new EventTarget();
    let failure: Error | undefined;
    let retryDelay = 0;
    let opened = false;
    let notifiedHead = 0;
    // CTC-4562 — the cloud acknowledged the events channel, and the frames it has pushed since.
    let pushing = false;
    const pushed: PushFrame[] = [];
    let woken = false;
    const wake = () => { woken = true; wakes.dispatchEvent(new Event("wake")); };
    const stop = () => { socket?.close(); wake(); };
    const failed = () => { failure ??= new Error("cloud event connection interrupted"); wake(); };
    const closed = () => {
      // 4401 is routine authorization expiry. The next authenticated probe refreshes it.
      failure ??= new Error("cloud event connection closed");
      wake();
    };
    const message = (event: Event) => {
      if (!("data" in event) || typeof event.data !== "string" || event.data.length > maxLine) return;
      let frame: unknown;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (!frame || typeof frame !== "object") return;
      const head = frame as { type?: unknown; accountId?: unknown; seq?: unknown; channels?: unknown };
      if (head.type === "channels") {
        pushing = Array.isArray(head.channels) && head.channels.includes("events");
        wake();
        return;
      }
      if (head.type === "events") {
        try { pushed.push(pushFrame(ctx, frame as Record<string, unknown>)); }
        catch (error) { failure = error instanceof Error ? error : protocol("cloud events frame is invalid"); }
        wake();
        return;
      }
      if (head.type !== "event-backbone-head") return;
      if (head.accountId !== requireConfig(ctx).account || !sequence(head.seq)) {
        failure = protocol("cloud event notification has an invalid tenant or head");
        wake();
        return;
      }
      notifiedHead = Math.max(notifiedHead, head.seq);
      wake();
    };
    const open = () => { opened = true; wake(); };
    try {
      // Capture the future-only start before connecting, then replay to close the handshake race.
      const head = await cloudEventHead(ctx, signal);
      let knownHead = head;
      cursor ??= head;
      if (cursor > head) throw new CliError(`cloud refused event cursor ${cursor} (head ${head}); inspect events status before choosing a new --after cursor`, "events-gap", 2, 409);
      if (signal.aborted) break;
      const cfg = requireConfig(ctx);
      const url = new URL(`${normalizeBaseUrl(cfg.baseUrl)}/api/v1/connect`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("account", cfg.account);
      // CTC-4562 — ask to be pushed the matching events, whole, instead of the change feed. A cloud
      // without the channel ignores these and the reader keeps its nudge-and-replay loop.
      url.searchParams.set("channels", "events");
      if (filter.type) url.searchParams.set("type", filter.type);
      if (filter.ticket) url.searchParams.set("ticket", filter.ticket);
      url.searchParams.set("fields", "full");
      url.searchParams.set("token", await eventBearer(ctx, AbortSignal.any([signal, AbortSignal.timeout(15_000)])));
      signal.throwIfAborted();
      socket = (deps.socket ?? ((address) => new WebSocket(address)))(url.toString());
      socket.addEventListener("open", open);
      socket.addEventListener("message", message);
      socket.addEventListener("close", closed);
      socket.addEventListener("error", failed);
      signal.addEventListener("abort", stop, { once: true });
      openTimer = setTimeout(failed, 15_000);
      while (!opened && !failure && !signal.aborted) await pause(15_000, signal, wakes);
      clearTimeout(openTimer);
      if (failure) throw failure;
      if (signal.aborted) break;
      heartbeat = setInterval(() => {
        try { socket?.send(JSON.stringify({ type: "ping" })); } catch { failed(); }
      }, 10_000);
      const follow = async function* <End>(page: AsyncGenerator<CachedEvent, End | undefined>): AsyncGenerator<CachedEvent, End | undefined> {
        let result = await page.next();
        try {
          while (!result.done) {
            if (failure) throw failure;
            signal.throwIfAborted();
            cursor = result.value.sequence;
            yield result.value;
            if (failure) throw failure;
            signal.throwIfAborted();
            result = await page.next();
          }
        } finally { await page.return(undefined); }
        return result.value;
      };
      let catchUp = true;
      while (!signal.aborted) {
        if (failure) throw failure;
        if (!catchUp) {
          // Caught up: apply pushed frames in order. One that starts past the cursor, or carries a
          // gap, sends the reader back to the catch-up read; overlap with it is dropped by sequence.
          while (pushed.length > 0 && !catchUp) {
            const next = pushed.shift() as PushFrame;
            knownHead = Math.max(knownHead, next.through);
            if (next.through <= cursor) continue;
            if (next.gap || next.after > cursor) { catchUp = true; break; }
            for (const event of next.events) {
              if (event.sequence <= cursor) continue;
              if (failure) throw failure;
              signal.throwIfAborted();
              cursor = event.sequence;
              yield event;
            }
            cursor = Math.max(cursor, next.through);
          }
          if (failure) throw failure;
          if (catchUp || cursor < Math.max(knownHead, notifiedHead)) { catchUp = true; continue; }
          woken = false;
          await pause(pushing ? pushedFallback : polledFallback, signal, wakes);
          // A wake with frames is applied without a read; a timeout, or a nudge with no push channel,
          // replays (a bounded replay also catches a lost notification or a silent half-open socket).
          if (!woken || !pushing) catchUp = true;
          continue;
        }
        const start: number = cursor;
        let end = indexed ? yield* follow(queryPage(ctx, start, filter, signal)) : yield* follow(replay(ctx, start, signal));
        const queried = indexed && end !== "absent" && end !== "uncovered";
        if (end === "absent") indexed = false;
        if (end === "absent" || end === "uncovered") end = yield* follow(replay(ctx, cursor, signal));
        if (!end) return;
        backoff = 1_000;
        if (failures > 0) {
          failures = 0;
          failingSince = undefined;
          deps.onHealthy?.();
        }
        if (failure) throw failure;
        cursor = Math.max(cursor, end.through);
        knownHead = Math.max(knownHead, end.head ?? 0, notifiedHead);
        if (end.more) continue;
        if (queried && cursor < knownHead) {
          // The index trails the archive write; poll it instead of spinning or waiting for a push.
          lagPoll = cursor > start ? 1_000 : Math.min(lagPoll * 2, maxLagPoll);
          await pause(lagPoll, signal);
          continue;
        }
        lagPoll = 1_000;
        if (cursor < knownHead) continue;
        catchUp = false;
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof CliError) throw error;
      if (error instanceof RetryRequest) retryDelay = error.delayMs;
      // Never propagate socket URLs or transport exceptions: they can contain bearer credentials.
      failures += 1;
      failingSince ??= ctx.now().getTime();
      deps.onTrouble?.({ failures, sinceMs: failingSince });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(openTimer);
      signal.removeEventListener("abort", stop);
      socket?.removeEventListener("open", open);
      socket?.removeEventListener("message", message);
      socket?.removeEventListener("close", closed);
      socket?.removeEventListener("error", failed);
      socket?.close();
    }
    await pause(Math.max(backoff, retryDelay), signal);
    backoff = Math.min(backoff * 2, 30_000);
  }
}
