import { afterEach, expect, test, vi } from "vitest";
import { cloudEventHead, cloudEvents, type EventSocket } from "../src/events-cloud";
import { makeCtx, tempHome } from "./helpers";
import { saveConfig } from "../src/config";

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
  socket!.head(6);
  expect((await next).value).toEqual(row(6));
  await events.return(undefined);
  expect(socket!.closed).toBe(true);
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
  sockets[0]!.disconnect();
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
