import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { main } from "../src/cli";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";
import { startMeFixture, type FixtureServer } from "./fixture";
import type { EventsSdk } from "../src/events";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;
beforeAll(async () => { server = await startMeFixture(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  home = tempHome();
  ctx = makeCtx(home);
  await seedJoined(home, server);
  mkdirSync(`${home}/events`, { recursive: true });
  writeFileSync(`${home}/events/cursor.json`, JSON.stringify({ version: 1, cursor: 14, floor: 0 }));
  writeFileSync(`${home}/events/.sync.writer.lock`, JSON.stringify({ pid: process.pid, heartbeat: Date.now(), owner: "test" }));
});

const sdk = (): EventsSdk => ({
  defaultEventCacheDirectory: () => `${home}/events`,
  CatalystEventSync: class { async start() {} async stop() {} },
  readCachedEvents: async () => [],
  async *tailCachedEvents() { /* not called by status */ },
});
const command = () => main(["events", "status", "--probe", "--json"], ctx, { events: { loadSdk: async () => sdk() } });

test("event status requires the cloud head and a live cache lock", async () => {
  ctx.fetch = async () => new Response("", { status: 200, headers: { "x-catalyst-event-backbone-head-seq": "14" } });
  expect(await command()).toBe(0);
  expect(JSON.parse(ctx.out.at(-1)!).verdict).toBe("current");

  ctx.fetch = async () => new Response("", { status: 200, headers: { "x-catalyst-event-backbone-head-seq": "15" } });
  expect(await command()).toBe(1);
  expect(JSON.parse(ctx.out.at(-1)!).reasons).toContain("event cache cursor 14 differs from cloud head 15");

  ctx.fetch = async () => new Response("", { status: 200 });
  expect(await command()).toBe(2);
  expect(JSON.parse(ctx.out.at(-1)!).verdict).toBe("unknown");
  expect(JSON.parse(ctx.out.at(-1)!).reasons).toContain("cloud event head could not be verified");
});

test("a stale lock refuses current even with an equal cursor", async () => {
  writeFileSync(`${home}/events/.sync.writer.lock`, JSON.stringify({ pid: process.pid, heartbeat: Date.now() - 30_000, owner: "test" }));
  ctx.fetch = async () => new Response("", { status: 200, headers: { "x-catalyst-event-backbone-head-seq": "14" } });
  expect(await command()).toBe(1);
  expect(JSON.parse(ctx.out.at(-1)!).reasons).toContain("event writer heartbeat is absent or stale");
});

test("a cache gap is stale, while a failed cloud probe is unknown", async () => {
  ctx.fetch = async () => new Response(JSON.stringify({ error: "cursor_underflow" }), {
    status: 409,
    headers: { "x-catalyst-event-backbone-head-seq": "14" },
  });
  expect(await command()).toBe(1);
  expect(JSON.parse(ctx.out.at(-1)!).verdict).toBe("stale");
  expect(JSON.parse(ctx.out.at(-1)!).reasons).toContain("cloud refused the event cursor (HTTP 409)");

  ctx.fetch = async () => { throw new Error("cloud unavailable"); };
  expect(await command()).toBe(2);
  expect(JSON.parse(ctx.out.at(-1)!).verdict).toBe("unknown");
  expect(JSON.parse(ctx.out.at(-1)!).reasons[0]).toContain("cloud event head is unknown");
});

test("an absent cache has its own verdict and does not probe the cloud", async () => {
  rmSync(`${home}/events/cursor.json`);
  let fetched = false;
  ctx.fetch = async () => { fetched = true; return new Response(""); };
  expect(await command()).toBe(3);
  expect(JSON.parse(ctx.out.at(-1)!).verdict).toBe("absent");
  expect(fetched).toBe(false);
});
