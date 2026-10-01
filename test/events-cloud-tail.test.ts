import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { readCachedEvents } from "@catalyst-cloud/sdk/events";
import type { CachedEvent } from "../src/events";
import type { EventSocket } from "../src/events-cloud";
import { eventMatches, tailCloudEvents, waitForCloudEvent, type CloudTailDeps } from "../src/events-cloud-tail";
import { requireConfig, saveConfig } from "../src/config";
import { resetDiscoveryCache } from "../src/oauth";
import { makeCtx, tempHome } from "./helpers";

class Socket extends EventTarget implements EventSocket {
  readyState = 0;
  closed = false;
  constructor() {
    super();
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
  }
  send() {}
  close() { this.closed = true; this.readyState = 3; }
  disconnect(code = 1006) {
    const event = new Event("close");
    Object.defineProperty(event, "code", { value: code });
    this.dispatchEvent(event);
  }
}
function context() {
  const ctx = makeCtx(tempHome());
  saveConfig(ctx.home, { baseUrl: "https://cloud.test/", key: "private-token", account: "tenant-1", slug: "test", name: "Test", permissions: [], principal: "session", joinedAt: "2026-10-01T00:00:00Z", lastSkillBundleVersion: "0.14.6" });
  return ctx;
}
const row = (sequence: number, type = "phase.completed", ticket = "CTC-4511"): CachedEvent => ({ tenantId: "tenant-1", sequence, eventId: `evt-${sequence}`, type, recordedAt: "2026-10-01T00:00:00Z", payload: { ticket } });
function response(head: number, rows: unknown[] = [], status = 200) {
  return new Response(rows.map((item) => JSON.stringify(item)).join("\n"), { status, headers: { "x-catalyst-event-backbone-head-seq": String(head) } });
}

/** A sink that records each write() call and lets a test hold its completion. */
class Sink extends Writable {
  chunks: string[] = [];
  held: (() => void)[] = [];
  hold = false;
  fail?: (chunk: string) => Error | undefined;
  constructor() { super({ decodeStrings: false }); }
  override _write(chunk: string, _encoding: string, callback: (error?: Error | null) => void) {
    const error = this.fail?.(chunk);
    if (error) return callback(error);
    this.chunks.push(chunk);
    if (this.hold) this.held.push(() => callback());
    else callback();
  }
  sequences() { return this.chunks.map((chunk) => (JSON.parse(chunk) as CachedEvent).sequence); }
}

/** A scripted source standing in for the cloud reader, recording how it was opened and closed. */
function source(rows: CachedEvent[], opts: { finish?: boolean } = {}) {
  const calls: { after?: number; filter?: unknown }[] = [];
  let closed = false;
  const events: NonNullable<CloudTailDeps["events"]> = async function* (_ctx, options) {
    calls.push({ after: options.after, filter: options.filter });
    try {
      for (const event of rows) {
        if (options.signal.aborted) return;
        yield event;
      }
      if (!opts.finish) await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
    } finally { closed = true; }
  };
  return { events, calls, closed: () => closed };
}
afterEach(() => vi.useRealTimers());

test("each event is one complete line in its own write, and the next waits for the last to flush", async () => {
  const sink = new Sink();
  sink.hold = true;
  const abort = new AbortController();
  const fake = source([row(1), row(2)]);
  const tail = tailCloudEvents(context(), { out: sink, signal: abort.signal }, { events: fake.events });
  await vi.waitFor(() => expect(sink.chunks).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(sink.chunks).toHaveLength(1);
  sink.held.shift()?.();
  await vi.waitFor(() => expect(sink.chunks).toHaveLength(2));
  sink.held.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (const chunk of sink.chunks) expect(chunk).toMatch(/^\{[^\n]*\}\n$/);
  abort.abort();
  expect(await tail).toEqual({ outcome: "aborted", cursor: 2, written: 2 });
  expect(fake.closed()).toBe(true);
});

test("a reconnect that replays already printed events prints each event once", async () => {
  const sink = new Sink();
  const fake = source([row(1), row(2), row(3), row(2), row(3), row(4)], { finish: true });
  const result = await tailCloudEvents(context(), { out: sink, signal: new AbortController().signal }, { events: fake.events });
  expect(sink.sequences()).toEqual([1, 2, 3, 4]);
  expect(result).toEqual({ outcome: "ended", cursor: 4, written: 4 });
});

test("an explicit --after cursor is exclusive and is handed to the reader", async () => {
  const sink = new Sink();
  const fake = source([row(7), row(8)], { finish: true });
  await tailCloudEvents(context(), { after: 7, filter: { type: "phase.completed" }, out: sink, signal: new AbortController().signal }, { events: fake.events });
  expect(sink.sequences()).toEqual([8]);
  expect(fake.calls).toEqual([{ after: 7, filter: { type: "phase.completed" } }]);
});

test("type and ticket filter on the client too, so an unfiltering server still prints only matches", async () => {
  const sink = new Sink();
  const nested = { ...row(4), payload: { workItem: { identifier: "ctc-4511" } } };
  const fake = source([row(1, "phase.started"), row(2, "phase.completed", "CTC-1"), row(3), nested], { finish: true });
  const result = await tailCloudEvents(context(), { filter: { type: "phase.completed", ticket: "ctc-4511" }, out: sink, signal: new AbortController().signal }, { events: fake.events });
  expect(sink.sequences()).toEqual([3, 4]);
  expect(result.cursor).toBe(4);
});

test("matching follows the local tail: whole identifiers anywhere in the payload, any case", () => {
  const ticket = eventMatches({ ticket: "CTC-9" });
  expect(ticket({ ...row(1), payload: "ctc-9" })).toBe(true);
  expect(ticket({ ...row(1), payload: [{ issueIdentifier: "CTC-9" }] })).toBe(true);
  expect(ticket({ ...row(1), payload: { ticket: "CTC-90" } })).toBe(false);
  expect(ticket({ ...row(1), payload: { title: "about CTC-9" } })).toBe(false);
  expect(ticket({ ...row(1), payload: null })).toBe(false);
  expect(eventMatches({})(row(1))).toBe(true);
});

test.each(["EPIPE", "ERR_STREAM_DESTROYED"])("a closed downstream pipe (%s) ends the tail quietly and closes the reader", async (code) => {
  const sink = new Sink();
  sink.fail = (chunk) => (JSON.parse(chunk) as CachedEvent).sequence === 2 ? Object.assign(new Error("write EPIPE"), { code }) : undefined;
  const fake = source([row(1), row(2), row(3)]);
  const result = await tailCloudEvents(context(), { out: sink, signal: new AbortController().signal }, { events: fake.events });
  expect(result).toEqual({ outcome: "closed", cursor: 1, written: 1 });
  expect(fake.closed()).toBe(true);
  // A late EPIPE from the same pipe must not crash the process after the tail returns.
  expect(() => sink.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
});

test("any other write failure is reported, not swallowed", async () => {
  const sink = new Sink();
  sink.fail = () => Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const fake = source([row(1)]);
  await expect(tailCloudEvents(context(), { out: sink, signal: new AbortController().signal }, { events: fake.events })).rejects.toThrow("disk full");
  expect(fake.closed()).toBe(true);
});

test("an abort while a write is stuck on a full pipe still returns", async () => {
  const sink = new Sink();
  sink.hold = true;
  const abort = new AbortController();
  const tail = tailCloudEvents(context(), { out: sink, signal: abort.signal }, { events: source([row(1)]).events });
  await vi.waitFor(() => expect(sink.chunks).toHaveLength(1));
  abort.abort();
  expect(await tail).toEqual({ outcome: "aborted", written: 0 });
});

test("a reader failure propagates after the reader is closed", async () => {
  const events: NonNullable<CloudTailDeps["events"]> = async function* () {
    yield row(1);
    throw new Error("cloud event replay contains invalid JSON");
  };
  const sink = new Sink();
  await expect(tailCloudEvents(context(), { out: sink, signal: new AbortController().signal }, { events })).rejects.toThrow("invalid JSON");
  expect(sink.sequences()).toEqual([1]);
});

test("wait-for prints the first match and stops", async () => {
  const sink = new Sink();
  const fake = source([row(1, "phase.started"), row(2), row(3)]);
  const result = await waitForCloudEvent(context(), { filter: { type: "phase.completed" }, timeoutMs: 60_000, out: sink }, { events: fake.events });
  expect(result).toEqual({ outcome: "matched", cursor: 2, written: 1, event: row(2) });
  expect(sink.sequences()).toEqual([2]);
  expect(fake.closed()).toBe(true);
});

test("wait-for takes an extra predicate beyond the type and ticket filters", async () => {
  const sink = new Sink();
  const fake = source([row(1), row(2), row(3)]);
  const result = await waitForCloudEvent(context(), { predicate: (event) => event.sequence > 2, timeoutMs: 60_000, out: sink }, { events: fake.events });
  expect(result.event?.sequence).toBe(3);
  expect(sink.sequences()).toEqual([3]);
});

test("wait-for times out without output, and a caller abort is told apart from the timeout", async () => {
  vi.useFakeTimers();
  const sink = new Sink();
  const waiting = waitForCloudEvent(context(), { filter: { type: "never" }, timeoutMs: 5_000, out: sink }, { events: source([row(1)]).events });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await waiting).toEqual({ outcome: "timeout", cursor: 1, written: 0 });
  expect(sink.chunks).toEqual([]);

  const abort = new AbortController();
  const stopped = waitForCloudEvent(context(), { timeoutMs: 5_000, out: sink, signal: abort.signal }, { events: source([]).events });
  abort.abort();
  expect((await stopped).outcome).toBe("aborted");
});

test("a printed line has the same schema and bytes as the local event file's line for that event", async () => {
  const ctx = context();
  // The envelope the backbone serves and the event cache stores verbatim, optional fields included.
  const fixture = '{"tenantId":"tenant-1","sequence":5,"eventId":"evt-5","type":"phase.completed","schemaVersion":1,"recordedAt":"2026-10-01T00:00:00.000Z","occurredAt":"2026-10-01T00:00:00.000Z","entity":{"type":"issue","id":"CTC-4511"},"actor":{"type":"agent","id":"runner"},"correlationId":"c-1","payload":{"ticket":"CTC-4511","phase":"implement","ok":true,"n":2}}';
  const directory = join(ctx.home, "cache");
  mkdirSync(directory);
  writeFileSync(join(directory, "2026-10-01.jsonl"), `${fixture}\n`);
  const [local] = await readCachedEvents({ tenantId: "tenant-1", directory });
  ctx.fetch = async (input) => Number(new URL(String(input)).searchParams.get("since")) === Number.MAX_SAFE_INTEGER
    ? response(5, [], 409)
    : new Response(`${fixture}\n`, { headers: { "x-catalyst-event-backbone-head-seq": "5" } });
  const sink = new Sink();
  const waited = await waitForCloudEvent(ctx, { after: 4, timeoutMs: 60_000, out: sink }, { socket: () => new Socket() });
  expect(waited.outcome).toBe("matched");
  expect(sink.chunks).toEqual([`${JSON.stringify(local)}\n`]);
  expect(sink.chunks).toEqual([`${fixture}\n`]);
});

test("a token refresh mid-tail neither repeats nor skips an event", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  resetDiscoveryCache();
  const ctx = context();
  const cfg = requireConfig(ctx);
  delete cfg.key;
  cfg.auth = { kind: "oauth", accessToken: "old-access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 120_000).toISOString(), sessionId: "session-1" };
  saveConfig(ctx.home, cfg);
  const sockets: Socket[] = [];
  const tokens: string[] = [];
  // The access token expires and the socket closes with 4401 (routine expiry) before the next page.
  const sink = new Sink();
  const stop = new AbortController();
  let served = 0;
  ctx.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/auth/cli") return Response.json({ clientId: "cli", issuer: "https://cloud.test", deviceAuthorizationUrl: "https://cloud.test/device", tokenUrl: "https://cloud.test/token", jwksUrl: "https://cloud.test/jwks" });
    if (url.pathname === "/token") return Response.json({ access_token: "new-access", refresh_token: "new-refresh" });
    tokens.push(String((init?.headers as Record<string, string>).authorization));
    const since = Number(url.searchParams.get("since"));
    if (since === Number.MAX_SAFE_INTEGER) return response(20, [], 409);
    served += 1;
    return response(since + 1, [row(since + 1)]);
  };
  const refreshing = tailCloudEvents(ctx, { after: 10, out: sink, signal: stop.signal }, { socket: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(sink.sequences()).toEqual([11]));
  vi.setSystemTime(new Date(Date.now() + 120_000));
  sockets[0]?.disconnect(4401);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(sink.sequences()).toEqual([11, 12]));
  stop.abort();
  expect(await refreshing).toMatchObject({ outcome: "aborted", cursor: 12 });
  expect(served).toBe(2);
  expect(tokens.at(0)).toBe("Bearer old-access");
  expect(tokens.at(-1)).toBe("Bearer new-access");
});
