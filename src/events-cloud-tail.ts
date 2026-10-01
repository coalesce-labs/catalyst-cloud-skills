// The cloud half of `events tail` and `events wait-for`: one NDJSON line per event, in the same
// shape the local event file stores, flushed line by line for Monitor, grep and jq.
import type { Ctx } from "./config.js";
import type { CachedEvent } from "./events.js";
import { cloudEvents, type CloudEventDeps, type CloudEventFilter } from "./events-cloud.js";

/** The slice of a Writable the tail needs; `process.stdout` satisfies it. */
export interface NdjsonSink {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}
export interface CloudTailDeps extends CloudEventDeps {
  events?: (ctx: Ctx, options: { after?: number; filter?: CloudEventFilter; signal: AbortSignal }, deps: CloudEventDeps) => AsyncIterable<CachedEvent>;
}
export interface CloudTailOptions {
  /** Exclusive: the first printed event is the one after this sequence. Absent means future only. */
  after?: number;
  filter?: CloudEventFilter;
  out: NdjsonSink;
  signal: AbortSignal;
  /** Narrows beyond type and ticket, on the client only. */
  where?: (event: CachedEvent) => boolean;
  /** Stop after the first printed event (wait-for). */
  once?: boolean;
}
/** `closed` means the reader of our output went away (EPIPE): a normal end for `| head`. */
export type CloudTailOutcome = "matched" | "ended" | "aborted" | "closed";
export interface CloudTailResult {
  outcome: CloudTailOutcome;
  /** The last sequence printed or deliberately skipped: the next run's `--after`. */
  cursor?: number;
  written: number;
  event?: CachedEvent;
}

/** The same matching rules as the local tail, so a filter means one thing from either source. */
export function eventMatches(filter: CloudEventFilter): (event: CachedEvent) => boolean {
  const ticket = filter.ticket?.toUpperCase();
  return (event) =>
    (!filter.type || event.type === filter.type) &&
    (!ticket || payloadReferences(event.payload, ticket));
}

function payloadReferences(value: unknown, ticket: string): boolean {
  if (typeof value === "string") return value.toUpperCase() === ticket;
  if (Array.isArray(value)) return value.some((item) => payloadReferences(item, ticket));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) =>
    ["ticket", "identifier", "workItemKey", "issueIdentifier"].includes(key) && typeof item === "string"
      ? item.toUpperCase() === ticket
      : payloadReferences(item, ticket),
  );
}

function pipeClosed(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

// Resolves once the line has left this process, so a consumer sees it before the next is read.
function writeLine(out: NdjsonSink, line: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve();
    const abort = () => resolve();
    signal.addEventListener("abort", abort, { once: true });
    const settle = (error?: unknown) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    try {
      out.write(line, (error) => settle(error));
    } catch (error) { settle(error); }
  });
}

/** Print every matching cloud event as one NDJSON line until aborted, matched, or the pipe closes. */
export async function tailCloudEvents(ctx: Ctx, options: CloudTailOptions, deps: CloudTailDeps = {}): Promise<CloudTailResult> {
  const { out } = options;
  const filter = options.filter ?? {};
  const filtered = eventMatches(filter);
  const matches = (event: CachedEvent) => filtered(event) && (options.where?.(event) ?? true);
  const reader = new AbortController();
  const stop = () => reader.abort(options.signal.reason);
  if (options.signal.aborted) stop();
  else options.signal.addEventListener("abort", stop, { once: true });
  let closed = false;
  let failure: unknown;
  const broken = (error: unknown) => {
    if (pipeClosed(error)) closed = true;
    else failure ??= error;
    reader.abort(error);
  };
  out.on("error", broken);
  let cursor = options.after;
  let written = 0;
  let matched: CachedEvent | undefined;
  // The server narrows what it sends when it can; every event is still matched here.
  const serverFilter: CloudEventFilter = {
    ...(filter.type ? { type: filter.type } : {}),
    ...(filter.ticket ? { ticket: filter.ticket.toUpperCase() } : {}),
  };
  try {
    const events = (deps.events ?? cloudEvents)(ctx, { after: options.after, filter: serverFilter, signal: reader.signal }, deps);
    for await (const event of events) {
      if (reader.signal.aborted) break;
      // A reconnect may replay what was already printed; the sequence is the identity.
      if (cursor !== undefined && event.sequence <= cursor) continue;
      if (matches(event)) {
        await writeLine(out, `${JSON.stringify(event)}\n`, reader.signal);
        // Aborted mid-write: the line was not confirmed, so it does not move the cursor.
        if (reader.signal.aborted) break;
        written += 1;
        cursor = event.sequence;
        if (options.once) { matched = event; break; }
      } else cursor = event.sequence;
    }
  } catch (error) {
    if (pipeClosed(error)) closed = true;
    else if (!reader.signal.aborted) failure ??= error;
  } finally {
    options.signal.removeEventListener("abort", stop);
    reader.abort();
    // After EPIPE the stream can still emit its error; the listener stays so that cannot crash.
    if (!closed) out.off("error", broken);
  }
  if (failure !== undefined) throw failure;
  if (matched) return { outcome: "matched", cursor, written, event: matched };
  if (closed) return { outcome: "closed", cursor, written };
  return { outcome: options.signal.aborted ? "aborted" : "ended", cursor, written };
}

export interface CloudWaitOptions {
  after?: number;
  filter?: CloudEventFilter;
  /** Narrows beyond type and ticket; the first printed event it accepts ends the wait. */
  predicate?: (event: CachedEvent) => boolean;
  timeoutMs: number;
  out: NdjsonSink;
  signal?: AbortSignal;
}
export interface CloudWaitResult extends Omit<CloudTailResult, "outcome"> {
  outcome: CloudTailOutcome | "timeout";
}

/** Print the first matching cloud event and stop, or report a timeout with nothing printed. */
export async function waitForCloudEvent(ctx: Ctx, options: CloudWaitOptions, deps: CloudTailDeps = {}): Promise<CloudWaitResult> {
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(new Error("event wait timed out")), options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timer.signal]) : timer.signal;
  try {
    const result = await tailCloudEvents(ctx, { after: options.after, filter: options.filter, out: options.out, signal, where: options.predicate, once: true }, deps);
    if (result.outcome === "aborted" && timer.signal.aborted && !options.signal?.aborted) return { ...result, outcome: "timeout" };
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
