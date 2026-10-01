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
    await response.body?.cancel();
    if (response.status >= 500 || response.status === 429) {
      const raw = response.headers.get("retry-after");
      const seconds = raw === null ? NaN : Number(raw);
      const delay = Number.isFinite(seconds) ? seconds * 1_000 : raw ? Date.parse(raw) - ctx.now().getTime() : 0;
      throw new RetryRequest(Number.isFinite(delay) ? Math.min(300_000, Math.max(0, delay)) : 0);
    }
    throw new CliError(`cloud event request refused (HTTP ${response.status})`, "events-http", 2, response.status);
  }
  return response;
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
  const event = value as Partial<CachedEvent>;
  return event.tenantId === requireConfig(ctx).account && sequence(event.sequence) && event.sequence > cursor &&
    typeof event.eventId === "string" && typeof event.type === "string" && typeof event.recordedAt === "string" && "payload" in event;
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
  const response = await send(ctx, url, "application/json", [404], signal);
  if (response.status === 404) { await response.body?.cancel(); return "absent"; }
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
  while (!signal.aborted) {
    let socket: EventSocket | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    const wakes = new EventTarget();
    let failure: Error | undefined;
    let retryDelay = 0;
    let opened = false;
    let notifiedHead = 0;
    const wake = () => wakes.dispatchEvent(new Event("wake"));
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
      const head = frame as { type?: unknown; accountId?: unknown; seq?: unknown };
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
      while (!signal.aborted) {
        if (failure) throw failure;
        const start: number = cursor;
        let end = indexed ? yield* follow(queryPage(ctx, start, filter, signal)) : yield* follow(replay(ctx, start, signal));
        const queried = indexed && end !== "absent" && end !== "uncovered";
        if (end === "absent") indexed = false;
        if (end === "absent" || end === "uncovered") end = yield* follow(replay(ctx, cursor, signal));
        if (!end) return;
        backoff = 1_000;
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
        // A bounded replay also catches a lost notification or a silent half-open socket.
        await pause(30_000, signal, wakes);
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof CliError) throw error;
      if (error instanceof RetryRequest) retryDelay = error.delayMs;
      // Never propagate socket URLs or transport exceptions: they can contain bearer credentials.
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
