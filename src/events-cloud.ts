// The backbone cursor belongs to tenant_events, never the replica's change_log.
import { normalizeBaseUrl, requireConfig, type Ctx } from "./config.js";
import { CliError } from "./errors.js";
import { bearerFor } from "./oauth.js";
import type { CachedEvent } from "./events.js";

const headHeader = "x-catalyst-event-backbone-head-seq";
// A server that filters says how far it looked, so an empty filtered page still moves the cursor.
const scannedHeader = "x-catalyst-event-backbone-scanned-seq";
const maxLine = 1_048_576;
export interface EventSocket extends EventTarget {
  readyState: number;
  send(data: string): void;
  close(): void;
}
/** Narrows the replay on the server when it supports it; callers still filter what arrives. */
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
async function request(ctx: Ctx, since: number, signal: AbortSignal, filter: CloudEventFilter = {}): Promise<Response> {
  const cfg = requireConfig(ctx);
  const url = new URL(`${normalizeBaseUrl(cfg.baseUrl)}/api/v1/events/backbone`);
  url.searchParams.set("since", String(since));
  if (filter.type) url.searchParams.set("type", filter.type);
  if (filter.ticket) url.searchParams.set("ticket", filter.ticket);
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const token = await eventBearer(ctx, bounded);
  bounded.throwIfAborted();
  const response = await ctx.fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/x-ndjson" },
    signal: bounded,
    redirect: "error",
  });
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new CliError("cloud event access refused; check catalyst status and sign in again", "events-auth", 2, response.status);
  }
  if (response.status !== 200 && response.status !== 409) {
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

interface ReplayEnd {
  /** The page's target: the reader asks again until its cursor reaches it. */
  head: number;
  /** The last sequence the server examined, when it filtered; absent means every row was sent. */
  scanned?: number;
}

function responseScanned(response: Response, after: number, head: number): number | undefined {
  const raw = response.headers.get(scannedHeader);
  if (raw === null) return undefined;
  const scanned = raw.trim() === "" ? NaN : Number(raw);
  if (!sequence(scanned) || scanned < after || scanned > head)
    throw protocol("cloud event scanned sequence is outside the replayed range");
  return scanned;
}

async function* replay(ctx: Ctx, after: number, signal: AbortSignal, filter?: CloudEventFilter): AsyncGenerator<CachedEvent, ReplayEnd> {
  const response = await request(ctx, after, signal, filter);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const head = responseHead(response);
    if (response.status === 409)
      throw new CliError(`cloud refused event cursor ${after} (head ${head}); history may be missing or the cursor may be ahead. Inspect events status before choosing a new --after cursor`, "events-gap", 2, 409);
    if (head < after) throw protocol("cloud event head moved behind the requested cursor");
    const scanned = responseScanned(response, after, head);
    if (!response.body) throw protocol("cloud event replay body is absent");
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let cursor = after;
    const parse = (line: string): CachedEvent => {
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw protocol("cloud event replay contains invalid JSON"); }
      if (!value || typeof value !== "object") throw protocol("cloud event replay contains an invalid event");
      const event = value as Partial<CachedEvent>;
      if (event.tenantId !== requireConfig(ctx).account || !sequence(event.sequence) || event.sequence <= cursor || typeof event.eventId !== "string" || typeof event.type !== "string" || typeof event.recordedAt !== "string" || !("payload" in event))
        throw protocol("cloud event replay contains an invalid tenant or event sequence");
      if (scanned !== undefined && event.sequence > scanned)
        throw protocol("cloud event scanned sequence is short of a delivered row");
      cursor = event.sequence;
      return event as CachedEvent;
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
    if (Math.max(cursor, scanned ?? cursor) === after && after < head) throw protocol("cloud event replay made no progress toward its head");
    return { head, scanned };
  } finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    else await response.body?.cancel();
  }
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
  let cursor = options.after;
  let backoff = 1_000;
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
      while (!signal.aborted) {
        if (failure) throw failure;
        const page = replay(ctx, cursor, signal, options.filter);
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
        } finally { await page.return({ head: cursor }); }
        backoff = 1_000;
        if (failure) throw failure;
        // Rows the server filtered out are behind its scanned sequence; never ask for them again.
        cursor = Math.max(cursor, result.value.scanned ?? cursor);
        if (cursor < result.value.head || cursor < notifiedHead) continue;
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
