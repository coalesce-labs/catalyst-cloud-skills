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

const scannedHeader = "x-catalyst-event-backbone-scanned-seq";
function filtered(head: number, scanned: number, rows: unknown[] = []) {
  const reply = response(head, rows);
  reply.headers.set(scannedHeader, String(scanned));
  return reply;
}

test("filters ride the replay request, never the head probe", async () => {
  const ctx = context();
  const urls: URL[] = [];
  ctx.fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    return url.searchParams.get("since") === String(Number.MAX_SAFE_INTEGER) ? response(5, [], 409) : response(5, [row(5)]);
  };
  const stream = cloudEvents(ctx, { after: 4, filter: { type: "phase.completed", ticket: "CTC-4511" }, signal: new AbortController().signal }, { socket: () => new Socket() });
  expect((await stream.next()).value?.sequence).toBe(5);
  await stream.return(undefined);
  expect([...required(urls[0]).searchParams.keys()]).toEqual(["since"]);
  expect(required(urls[1]).searchParams.get("type")).toBe("phase.completed");
  expect(required(urls[1]).searchParams.get("ticket")).toBe("CTC-4511");
});

test("a server-filtered page advances the cursor to its scanned sequence, even when empty", async () => {
  const ctx = context();
  let socket: Socket | undefined;
  const requested: number[] = [];
  ctx.fetch = async (input) => {
    const since = Number(new URL(String(input)).searchParams.get("since"));
    if (since === Number.MAX_SAFE_INTEGER) return response(9, [], 409);
    requested.push(since);
    if (since === 4) return filtered(9, 6, []);
    if (since === 6) return filtered(9, 9, [row(8)]);
    return filtered(12, 12, [row(12)]);
  };
  const stream = cloudEvents(ctx, { after: 4, filter: { type: "phase.completed" }, signal: new AbortController().signal }, { socket: () => socket = new Socket() });
  expect((await stream.next()).value?.sequence).toBe(8);
  const next = stream.next();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Scanned through the head: the reader waits for a push instead of asking again.
  expect(requested).toEqual([4, 6]);
  required(socket).head(12);
  expect((await next).value?.sequence).toBe(12);
  expect(requested).toEqual([4, 6, 9]);
  await stream.return(undefined);
});

test.each([
  ["behind the cursor", filtered(9, 3, [])],
  ["beyond the head", filtered(9, 10, [])],
  ["short of a delivered row", filtered(9, 6, [row(7)])],
  ["not a sequence", filtered(9, Number.NaN, [])],
])("a scanned sequence %s fails before output", async (_name, reply) => {
  const ctx = context();
  ctx.fetch = async (input) => Number(new URL(String(input)).searchParams.get("since")) === Number.MAX_SAFE_INTEGER ? response(9, [], 409) : reply;
  const stream = cloudEvents(ctx, { after: 4, signal: new AbortController().signal }, { socket: () => new Socket() });
  await expect(stream.next()).rejects.toThrow("scanned sequence");
});
