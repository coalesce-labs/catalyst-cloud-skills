import { afterEach, expect, test, vi } from "vitest";
import { cloudEventHead, cloudEvents, type EventSocket } from "../src/events-cloud";
import { makeCtx, tempHome } from "./helpers";
import { bearerFor, resetDiscoveryCache } from "../src/oauth";
import { requireConfig, saveConfig } from "../src/config";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture was not initialized");
  return value;
}

class Socket extends EventTarget implements EventSocket {
  readyState = 0;
  closed = false;
  sent: string[] = [];
  constructor() {
    super();
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
  }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; }
  head(seq: number, accountId = "tenant-1") {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "event-backbone-head", accountId, seq }) }));
  }
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
const row = (sequence: number) => ({ tenantId: "tenant-1", sequence, eventId: `evt-${sequence}`, type: "phase.completed", recordedAt: "2026-10-01T00:00:00Z", payload: { ticket: "CTC-4511" } });
function response(head: number, rows: unknown[] = [], status = 200) {
  return new Response(rows.map((row) => JSON.stringify(row)).join("\n"), { status, headers: { "x-catalyst-event-backbone-head-seq": String(head) } });
}
afterEach(() => vi.useRealTimers());

test("head probe is bounded and uses the backbone header and origin once", async () => {
  const ctx = context();
  ctx.fetch = async (input, init) => {
    expect(String(input)).toBe(`https://cloud.test/api/v1/events/backbone?since=${Number.MAX_SAFE_INTEGER}`);
    expect(init?.headers).toMatchObject({ authorization: "Bearer private-token" });
    expect(init?.redirect).toBe("error");
    return response(12, [], 409);
  };
  expect(await cloudEventHead(ctx)).toBe(12);
  ctx.fetch = async () => new Response("", { status: 409, headers: { "x-catalyst-head-seq": "12" } });
  await expect(cloudEventHead(ctx)).rejects.toThrow("could not be verified");
});

test("future-only start replays the handshake race, then follows pushed heads", async () => {
  const ctx = context();
  const controller = new AbortController();
  let socket: Socket | undefined;
  const requested: number[] = [];
  ctx.fetch = async (input) => {
    const since = Number(new URL(String(input)).searchParams.get("since"));
    requested.push(since);
    if (since === Number.MAX_SAFE_INTEGER) return response(4, [], 409);
    if (since === 4) return response(5, [row(5)]);
    return response(6, [row(6)]);
  };
  const events = cloudEvents(ctx, { signal: controller.signal }, { socket: (url) => {
    expect(new URL(url).pathname).toBe("/api/v1/connect");
    expect(new URL(url).searchParams.get("account")).toBe("tenant-1");
    return socket = new Socket();
  } });
  expect((await events.next()).value).toEqual(row(5));
  const next = events.next();
  // A notification during the ongoing replay is retained, not lost by the wait.
  required(socket).head(6);
  expect((await next).value).toEqual(row(6));
  await events.return(undefined);
  expect(required(socket).closed).toBe(true);
  expect(requested).toEqual([Number.MAX_SAFE_INTEGER, 4, 5]);
});

test("explicit cursor pages archived replay before waiting and cancellation closes transport", async () => {
  const ctx = context();
  const abort = new AbortController();
  const sockets: Socket[] = [];
  const requested: number[] = [];
  ctx.fetch = async (input) => {
    const since = Number(new URL(String(input)).searchParams.get("since"));
    if (since === Number.MAX_SAFE_INTEGER) return response(3, [], 409);
    requested.push(since);
    return response(3, [row(since + 1)]);
  };
  const stream = cloudEvents(ctx, { after: 0, signal: abort.signal }, { socket: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  for (const seq of [1, 2, 3]) expect((await stream.next()).value?.sequence).toBe(seq);
  abort.abort();
  expect((await stream.next()).done).toBe(true);
  expect(requested).toEqual([0, 1, 2]);
  expect(sockets.every((socket) => socket.closed)).toBe(true);
});

test("reconnect resumes the last delivered event and never repeats it", async () => {
  vi.useFakeTimers();
  const ctx = context();
  const abort = new AbortController();
  const sockets: Socket[] = [];
  const requested: number[] = [];
  ctx.fetch = async (input) => {
    const since = Number(new URL(String(input)).searchParams.get("since"));
    if (since === Number.MAX_SAFE_INTEGER) return response(20, [], 409);
    requested.push(since);
    return response(since + 1, [row(since + 1)]);
  };
  const stream = cloudEvents(ctx, { after: 7, signal: abort.signal }, { socket: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  await vi.advanceTimersByTimeAsync(0);
  const first = stream.next();
  await vi.advanceTimersByTimeAsync(0);
  expect((await first).value?.sequence).toBe(8);
  required(sockets[0]).disconnect();
  const next = stream.next();
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await next).value?.sequence).toBe(9);
  expect(requested).toEqual([7, 8]);
  await stream.return(undefined);
  expect(sockets).toHaveLength(2);
  expect(sockets.every((socket) => socket.closed)).toBe(true);
});

test.each([401, 403, 409])("HTTP %i refuses the subscription without moving its cursor", async (status) => {
  const ctx = context();
  ctx.fetch = async () => response(20, [], status);
  let socket: Socket | undefined;
  const stream = cloudEvents(ctx, { after: 4, signal: new AbortController().signal }, { socket: () => socket = new Socket() });
  await expect(stream.next()).rejects.toThrow(status === 409 ? "refused event cursor 4" : "access refused");
  expect(socket?.closed ?? true).toBe(true);
});

test("foreign events and backward sequences fail before output", async () => {
  for (const event of [{ ...row(5), tenantId: "other" }, row(4)]) {
    const ctx = context();
    ctx.fetch = async (input) => Number(new URL(String(input)).searchParams.get("since")) === Number.MAX_SAFE_INTEGER ? response(5, [], 409) : response(5, [event]);
    const stream = cloudEvents(ctx, { after: 4, signal: new AbortController().signal }, { socket: () => new Socket() });
    await expect(stream.next()).rejects.toThrow("invalid tenant or event sequence");
  }
});

test("early completion cancels an unfinished response body", async () => {
  const ctx = context();
  let cancelled = false;
  ctx.fetch = async (input) => Number(new URL(String(input)).searchParams.get("since")) === Number.MAX_SAFE_INTEGER ? response(5, [], 409) : new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(`${JSON.stringify(row(5))}\n`)); },
    cancel() { cancelled = true; },
  }), { headers: { "x-catalyst-event-backbone-head-seq": "5" } });
  const stream = cloudEvents(ctx, { after: 4, signal: new AbortController().signal }, { socket: () => new Socket() });
  expect((await stream.next()).value?.sequence).toBe(5);
  await stream.return(undefined);
  expect(cancelled).toBe(true);
});

test("abort after one buffered row prevents further output", async () => {
  const ctx = context();
  const abort = new AbortController();
  ctx.fetch = async (input) => Number(new URL(String(input)).searchParams.get("since")) === Number.MAX_SAFE_INTEGER ? response(6, [], 409) : response(6, [row(5), row(6)]);
  const stream = cloudEvents(ctx, { after: 4, signal: abort.signal }, { socket: () => new Socket() });
  expect((await stream.next()).value?.sequence).toBe(5);
  abort.abort();
  expect((await stream.next()).done).toBe(true);
});

test.each(["none", "refresh", "discovery"])("routine 4401 expiry refreshes OAuth and resumes the same cursor, transient outage %s", async (outage) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  resetDiscoveryCache();
  const ctx = context();
  const cfg = requireConfig(ctx);
  delete cfg.key;
  cfg.auth = { kind: "oauth", accessToken: "old-access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 120_000).toISOString(), sessionId: "session-1" };
  saveConfig(ctx.home, cfg);
  const tokens: string[] = [];
  const sockets: Socket[] = [];
  const cursors: number[] = [];
  let refreshes = 0;
  let discoveries = 0;
  ctx.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/auth/cli" && outage === "discovery" && ++discoveries === 1) return Response.json({}, { status: 503 });
    if (url.pathname === "/api/v1/auth/cli") return Response.json({ clientId: "cli", issuer: "https://cloud.test", deviceAuthorizationUrl: "https://cloud.test/device", tokenUrl: "https://cloud.test/token", jwksUrl: "https://cloud.test/jwks" });
    if (url.pathname === "/token") {
      if (outage === "refresh" && ++refreshes <= 4) return Response.json({ error: "temporarily_unavailable" }, { status: 429 });
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh" });
    }
    const since = Number(url.searchParams.get("since"));
    if (since === Number.MAX_SAFE_INTEGER) return response(20, [], 409);
    cursors.push(since);
    return response(since + 1, [row(since + 1)]);
  };
  const stream = cloudEvents(ctx, { after: 4, signal: new AbortController().signal }, { socket: (url) => {
    tokens.push(new URL(url).searchParams.get("token") ?? "");
    const socket = new Socket(); sockets.push(socket); return socket;
  } });
  const first = stream.next();
  await vi.advanceTimersByTimeAsync(0);
  expect((await first).value?.sequence).toBe(5);
  vi.setSystemTime(new Date(Date.now() + 120_000));
  required(sockets[0]).disconnect(4401);
  const next = stream.next();
  await vi.advanceTimersByTimeAsync(outage !== "none" ? 10_000 : 1_000);
  expect((await next).value?.sequence).toBe(6);
  expect(tokens).toEqual(["old-access", "new-access"]);
  expect(cursors).toEqual([4, 5]);
  await stream.return(undefined);
});

test("cancelled credential waiter leaves an existing shared refresh owned by its caller", async () => {
  resetDiscoveryCache();
  const ctx = context();
  const cfg = requireConfig(ctx);
  delete cfg.key;
  cfg.auth = { kind: "oauth", accessToken: "expired", refreshToken: "refresh", expiresAt: "2000-01-01T00:00:00Z", sessionId: "session-1" };
  saveConfig(ctx.home, cfg);
  let release: (() => void) | undefined;
  const discovery = new Promise<void>((resolve) => { release = resolve; });
  const paths: string[] = [];
  ctx.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === "/api/v1/auth/cli") {
      await discovery;
      return Response.json({ clientId: "cli", issuer: "https://cloud.test", deviceAuthorizationUrl: "https://cloud.test/device", tokenUrl: "https://cloud.test/token", jwksUrl: "https://cloud.test/jwks" });
    }
    return Response.json({ access_token: "new-access", refresh_token: "new-refresh" });
  };
  const shared = bearerFor(ctx, cfg);
  const abort = new AbortController();
  const probe = cloudEventHead(ctx, abort.signal);
  abort.abort(new Error("reader stopped"));
  await expect(probe).rejects.toThrow("reader stopped");
  expect(paths).toEqual(["/api/v1/auth/cli"]);
  required(release)();
  expect(await shared).toBe("new-access");
  expect(paths).toEqual(["/api/v1/auth/cli", "/token"]);
});

test("repeated replay failures retain exponential backoff and honor Retry-After", async () => {
  vi.useFakeTimers();
  const ctx = context();
  const abort = new AbortController();
  const replayTimes: number[] = [];
  const start = Date.now();
  ctx.fetch = async (input) => {
    const since = Number(new URL(String(input)).searchParams.get("since"));
    if (since === Number.MAX_SAFE_INTEGER) return response(20, [], 409);
    replayTimes.push(Date.now() - start);
    return new Response("", { status: 429, headers: replayTimes.length === 3 ? { "retry-after": "5" } : {} });
  };
  const stream = cloudEvents(ctx, { after: 4, signal: abort.signal }, { socket: () => new Socket() });
  const next = stream.next();
  await vi.advanceTimersByTimeAsync(8_000);
  abort.abort();
  expect((await next).done).toBe(true);
  expect(replayTimes).toEqual([0, 1_000, 3_000, 8_000]);
});


test("invalid notification followed by close refuses even already buffered rows", async () => {
  const ctx = context();
  let socket: Socket | undefined;
  ctx.fetch = async (input) => Number(new URL(String(input)).searchParams.get("since")) === Number.MAX_SAFE_INTEGER ? response(6, [], 409) : response(6, [row(5), row(6)]);
  const stream = cloudEvents(ctx, { after: 4, signal: new AbortController().signal }, { socket: () => socket = new Socket() });
  expect((await stream.next()).value?.sequence).toBe(5);
  required(socket).head(6, "another-tenant");
  required(socket).disconnect();
  await expect(stream.next()).rejects.toThrow("invalid tenant or head");
});

// CTC-4549's filtered query: JSON pages from the event index, with the indexed range stated.
function page(events: unknown[], next: unknown = null, coverage: unknown = { indexedFromSeq: 1, indexedToSeq: 1_000 }) {
  return Response.json({ events, next, coverage });
}
function route(input: unknown) {
  const url = new URL(String(input));
  const name = url.pathname.split("/").at(-1);
  const cursor = Number(url.searchParams.get(name === "query" ? "afterSeq" : "since"));
  return { url, name, cursor, probe: cursor === Number.MAX_SAFE_INTEGER };
}
const filter = { type: "phase.completed", ticket: "CTC-4511" };

test("a filtered reader asks the events query with its filters; the head probe stays unfiltered", async () => {
  const ctx = context();
  const urls: URL[] = [];
  ctx.fetch = async (input) => {
    const { url, probe } = route(input);
    urls.push(url);
    return probe ? response(5, [], 409) : page([row(5)], null, { indexedFromSeq: 1, indexedToSeq: 5 });
  };
  const stream = cloudEvents(ctx, { after: 4, filter, signal: new AbortController().signal }, { socket: () => new Socket() });
  expect((await stream.next()).value).toEqual(row(5));
  await stream.return(undefined);
  expect(required(urls[0]).pathname).toBe("/api/v1/events/backbone");
  expect([...required(urls[0]).searchParams.keys()]).toEqual(["since"]);
  expect(required(urls[1]).pathname).toBe("/api/v1/events/query");
  expect(Object.fromEntries(required(urls[1]).searchParams)).toEqual({ order: "asc", afterSeq: "4", limit: "200", type: "phase.completed", ticket: "CTC-4511" });
});

test("a filtered reader follows next pages, then moves to the indexed sequence and waits for a push", async () => {
  const ctx = context();
  let socket: Socket | undefined;
  const requested: string[] = [];
  ctx.fetch = async (input) => {
    const { name, cursor, probe } = route(input);
    if (probe) return response(9, [], 409);
    requested.push(`${name}:${cursor}`);
    if (cursor === 4) return page([row(5)], { param: "afterSeq", value: 5 }, { indexedFromSeq: 1, indexedToSeq: 9 });
    if (cursor === 5) return page([row(8)], null, { indexedFromSeq: 1, indexedToSeq: 9 });
    return page([row(12)], null, { indexedFromSeq: 1, indexedToSeq: 12 });
  };
  const stream = cloudEvents(ctx, { after: 4, filter, signal: new AbortController().signal }, { socket: () => socket = new Socket() });
  expect((await stream.next()).value?.sequence).toBe(5);
  expect((await stream.next()).value?.sequence).toBe(8);
  const next = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Indexed through the head: nothing between 8 and 9 matched, so it waits rather than asking again.
  expect(requested).toEqual(["query:4", "query:5"]);
  required(socket).head(12);
  expect((await next).value?.sequence).toBe(12);
  expect(requested).toEqual(["query:4", "query:5", "query:9"]);
  await stream.return(undefined);
});

test("an empty filtered page still moves the cursor to the indexed sequence", async () => {
  const ctx = context();
  let socket: Socket | undefined;
  const requested: string[] = [];
  ctx.fetch = async (input) => {
    const { name, cursor, probe } = route(input);
    if (probe) return response(9, [], 409);
    requested.push(`${name}:${cursor}`);
    return cursor === 4 ? page([], null, { indexedFromSeq: 1, indexedToSeq: 9 }) : page([row(12)], null, { indexedFromSeq: 1, indexedToSeq: 12 });
  };
  const stream = cloudEvents(ctx, { after: 4, filter, signal: new AbortController().signal }, { socket: () => socket = new Socket() });
  const next = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(requested).toEqual(["query:4"]);
  required(socket).head(12);
  expect((await next).value?.sequence).toBe(12);
  expect(requested).toEqual(["query:4", "query:9"]);
  await stream.return(undefined);
});

test("while the index trails the head, the reader polls with a capped backoff and prints once it is indexed", async () => {
  vi.useFakeTimers();
  const ctx = context();
  const start = Date.now();
  const polls: number[] = [];
  // The event at 6 is appended at t=0 and its index row lands 10 s later (the archive lag).
  ctx.fetch = async (input) => {
    const { probe } = route(input);
    if (probe) return response(6, [], 409);
    const elapsed = Date.now() - start;
    polls.push(elapsed);
    return elapsed >= 10_000 ? page([row(6)], null, { indexedFromSeq: 1, indexedToSeq: 6 }) : page([], null, { indexedFromSeq: 1, indexedToSeq: 5 });
  };
  const stream = cloudEvents(ctx, { after: 4, filter, signal: new AbortController().signal }, { socket: () => new Socket() });
  const next = stream.next();
  await vi.advanceTimersByTimeAsync(15_000);
  expect((await next).value?.sequence).toBe(6);
  // The client adds at most 8 s over the archive lag: 10 s lag, printed at 15 s.
  expect(polls).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
  await stream.return(undefined);
});

test("a server without the query route gets the backbone for the rest of the run", async () => {
  const ctx = context();
  let socket: Socket | undefined;
  const requested: string[] = [];
  ctx.fetch = async (input) => {
    const { name, cursor, probe } = route(input);
    if (probe) return response(6, [], 409);
    requested.push(`${name}:${cursor}`);
    if (name === "query") return new Response("not found", { status: 404 });
    return cursor === 4 ? response(6, [row(5), row(6)]) : response(7, [row(7)]);
  };
  const stream = cloudEvents(ctx, { after: 4, filter, signal: new AbortController().signal }, { socket: () => socket = new Socket() });
  for (const seq of [5, 6]) expect((await stream.next()).value?.sequence).toBe(seq);
  const next = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  required(socket).head(7);
  expect((await next).value?.sequence).toBe(7);
  expect(requested).toEqual(["query:4", "backbone:4", "backbone:6"]);
  await stream.return(undefined);
});

test.each([
  ["below the index floor", { indexedFromSeq: 5, indexedToSeq: 6 }],
  ["with nothing indexed yet", { indexedFromSeq: null, indexedToSeq: null }],
  ["with no coverage", null],
])("a cursor %s reads that range from the backbone, then returns to the query", async (_name, coverage) => {
  const ctx = context();
  let socket: Socket | undefined;
  const requested: string[] = [];
  ctx.fetch = async (input) => {
    const { name, cursor, probe } = route(input);
    if (probe) return response(6, [], 409);
    requested.push(`${name}:${cursor}`);
    if (name === "backbone") return response(6, [row(3), row(6)]);
    return cursor === 2 ? page([row(6)], null, coverage) : page([row(7)], null, { indexedFromSeq: 5, indexedToSeq: 7 });
  };
  const stream = cloudEvents(ctx, { after: 2, filter, signal: new AbortController().signal }, { socket: () => socket = new Socket() });
  for (const seq of [3, 6]) expect((await stream.next()).value?.sequence).toBe(seq);
  const next = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  required(socket).head(7);
  expect((await next).value?.sequence).toBe(7);
  expect(requested).toEqual(["query:2", "backbone:2", "query:6"]);
  await stream.return(undefined);
});

test.each([
  ["invalid JSON", () => new Response("{", { status: 200 }), "invalid JSON"],
  ["no events array", () => Response.json({ next: null, coverage: { indexedFromSeq: 1, indexedToSeq: 9 } }), "invalid page"],
  ["no next", () => Response.json({ events: [], coverage: { indexedFromSeq: 1, indexedToSeq: 9 } }), "invalid page"],
  ["a foreign event", () => page([{ ...row(5), tenantId: "other" }]), "invalid tenant or event sequence"],
  ["a descending page", () => page([row(6), row(5)]), "invalid tenant or event sequence"],
  ["an event at the cursor", () => page([row(4)]), "invalid tenant or event sequence"],
  ["an empty page that claims more", () => page([], { value: 4 }), "made no progress"],
  ["a coverage that is not a sequence", () => page([], null, { indexedFromSeq: 1, indexedToSeq: "9" }), "coverage is invalid"],
  ["an oversized body", () => new Response(" ".repeat(16 * 1_048_576 + 1)), "size limit"],
])("a query page with %s fails before output", async (_name, reply, message) => {
  const ctx = context();
  ctx.fetch = async (input) => route(input).probe ? response(9, [], 409) : reply();
  const stream = cloudEvents(ctx, { after: 4, filter, signal: new AbortController().signal }, { socket: () => new Socket() });
  await expect(stream.next()).rejects.toThrow(message);
});

test("a refused filter is reported, not retried", async () => {
  const ctx = context();
  ctx.fetch = async (input) => route(input).probe ? response(9, [], 409) : Response.json({ error: "unknown_type" }, { status: 400 });
  const stream = cloudEvents(ctx, { after: 4, filter: { type: "phase.completed" }, signal: new AbortController().signal }, { socket: () => new Socket() });
  await expect(stream.next()).rejects.toThrow("refused (HTTP 400)");
});

// CTC-4562 — the events channel: the socket asks for pushed events, and once the cloud acknowledges
// the channel the reader consumes frames instead of replaying on a timer.
function pushing(socket: Socket) {
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "channels", channels: ["events"], fields: "full" }) }));
}
function frame(socket: Socket, f: { after: number; through: number; events?: unknown[]; gap?: boolean }) {
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "events", events: [], ...f }) }));
}
const since = (input: unknown) => {
  const url = new URL(String(input));
  return { name: url.pathname.split("/").at(-1), cursor: Number(url.searchParams.get(url.pathname.endsWith("query") ? "afterSeq" : "since")) };
};

test("the socket asks for the events channel with the filters and full bodies", async () => {
  const ctx = context();
  let address = "";
  ctx.fetch = async (input) => since(input).cursor === Number.MAX_SAFE_INTEGER ? response(5, [], 409) : Response.json({ events: [row(5)], next: null, coverage: { indexedFromSeq: 1, indexedToSeq: 5 } });
  const stream = cloudEvents(ctx, { after: 4, filter: { type: "relay.phase.completed", ticket: "CTC-1" }, signal: new AbortController().signal }, { socket: (url) => { address = url; return new Socket(); } });
  await stream.next();
  await stream.return(undefined);
  const params = new URL(address).searchParams;
  expect(params.get("channels")).toBe("events");
  expect(params.get("type")).toBe("relay.phase.completed");
  expect(params.get("ticket")).toBe("CTC-1");
  expect(params.get("fields")).toBe("full");
});

test("pushed events are yielded in order with no further request, and a replayed overlap is dropped", async () => {
  const ctx = context();
  let socket: Socket | undefined;
  const requested: number[] = [];
  ctx.fetch = async (input) => {
    const { cursor } = since(input);
    if (cursor === Number.MAX_SAFE_INTEGER) return response(5, [], 409);
    requested.push(cursor);
    return response(5, []);
  };
  const stream = cloudEvents(ctx, { after: 5, signal: new AbortController().signal }, { socket: () => socket = new Socket() });
  const first = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  pushing(required(socket));
  frame(required(socket), { after: 5, through: 7, events: [row(6), row(7)] });
  expect((await first).value?.sequence).toBe(6);
  expect((await stream.next()).value?.sequence).toBe(7);
  const next = stream.next();
  // A frame that overlaps what was already yielded (after 5, the cursor is 7): only 9 is new.
  frame(required(socket), { after: 5, through: 9, events: [row(6), row(7), row(9)] });
  expect((await next).value?.sequence).toBe(9);
  expect(requested).toEqual([5]);
  await stream.return(undefined);
});

test.each([
  ["a frame that starts past the cursor", { after: 8, through: 9, events: [row(9)] }],
  ["a frame flagged as a gap", { after: 5, through: 9, gap: true }],
  ["a frame carrying an event too large to push", { after: 5, through: 9, events: [{ tenantId: "tenant-1", sequence: 9, eventId: "evt-9", type: "phase.completed", recordedAt: "2026-10-01T00:00:00Z", payloadOmitted: true }] }],
])("%s sends the reader back to catch up from its cursor", async (_name, f) => {
  const ctx = context();
  let socket: Socket | undefined;
  const requested: number[] = [];
  ctx.fetch = async (input) => {
    const { cursor } = since(input);
    if (cursor === Number.MAX_SAFE_INTEGER) return response(5, [], 409);
    requested.push(cursor);
    return cursor === 5 && requested.length > 1 ? response(9, [row(7), row(9)]) : response(5, []);
  };
  const stream = cloudEvents(ctx, { after: 5, signal: new AbortController().signal }, { socket: () => socket = new Socket() });
  const first = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  pushing(required(socket));
  frame(required(socket), f);
  expect((await first).value?.sequence).toBe(7);
  expect((await stream.next()).value?.sequence).toBe(9);
  expect(requested).toEqual([5, 5]);
  await stream.return(undefined);
});

test("once the channel is acknowledged the safety replay waits ten minutes, not thirty seconds", async () => {
  vi.useFakeTimers();
  const ctx = context();
  let socket: Socket | undefined;
  const requested: number[] = [];
  ctx.fetch = async (input) => {
    const { cursor } = since(input);
    if (cursor === Number.MAX_SAFE_INTEGER) return response(5, [], 409);
    requested.push(cursor);
    return response(5, []);
  };
  const abort = new AbortController();
  const stream = cloudEvents(ctx, { after: 5, signal: abort.signal }, { socket: () => socket = new Socket() });
  const next = stream.next();
  await vi.advanceTimersByTimeAsync(0);
  pushing(required(socket));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(requested).toEqual([5]);
  await vi.advanceTimersByTimeAsync(540_000);
  expect(requested).toEqual([5, 5]);
  abort.abort();
  expect((await next).done).toBe(true);
});

test.each([
  ["a frame whose bounds run backwards", { type: "events", after: 9, through: 7, events: [] }],
  ["a pushed event from another tenant", { type: "events", after: 5, through: 6, events: [{ ...row(6), tenantId: "other" }] }],
  ["a pushed event outside its frame", { type: "events", after: 5, through: 6, events: [row(8)] }],
])("%s fails before output", async (_name, f) => {
  const ctx = context();
  let socket: Socket | undefined;
  ctx.fetch = async (input) => since(input).cursor === Number.MAX_SAFE_INTEGER ? response(5, [], 409) : response(5, []);
  const stream = cloudEvents(ctx, { after: 5, signal: new AbortController().signal }, { socket: () => socket = new Socket() });
  const first = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 5));
  pushing(required(socket));
  required(socket).dispatchEvent(new MessageEvent("message", { data: JSON.stringify(f) }));
  await expect(first).rejects.toThrow(/events frame|invalid tenant/);
});
