import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { main } from "../src/cli";
import type { CachedEvent, EventsSdk } from "../src/events";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";
import { startMeFixture, type FixtureServer } from "./fixture";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

const rows: CachedEvent[] = [
  {
    tenantId: "account-1",
    sequence: 4,
    eventId: "evt-4",
    type: "phase.completed",
    recordedAt: "2026-09-16T20:00:00.000Z",
    payload: { workItemKey: "CTC-1352" },
  },
  {
    tenantId: "account-1",
    sequence: 5,
    eventId: "evt-5",
    type: "pull_request.merged",
    recordedAt: "2026-09-16T20:01:00.000Z",
    payload: { identifier: "CTC-999" },
  },
];

function sdk(): EventsSdk {
  return {
    CatalystEventSync: class {
      async start() {}
      async stop() {}
    },
    defaultEventCacheDirectory: () => `${home}/events`,
    readCachedEvents: async ({ after }) =>
      rows.filter((event) => event.sequence > (after ?? -1)),
    async *tailCachedEvents({ after }) {
      for (const event of rows) if (event.sequence > (after ?? -1)) yield event;
    },
  };
}

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  home = tempHome();
  ctx = makeCtx(home);
  await seedJoined(home, server);
});

describe("events", () => {
  test("query reads the cache and filters by exact type and ticket", async () => {
    expect(
      await main(
        [
          "events",
          "query",
          "--type",
          "phase.completed",
          "--ticket",
          "CTC-1352",
        ],
        ctx,
        {
          events: { loadSdk: async () => sdk() },
        },
      ),
    ).toBe(0);
    expect(ctx.out.map((line) => JSON.parse(line))).toEqual([rows[0]]);
  });

  test("wait-for defaults to the current local head and emits the first later match", async () => {
    const fixture = sdk();
    fixture.readCachedEvents = async () => [rows[0]!];
    fixture.tailCachedEvents = async function* ({ after }) {
      expect(after).toBeUndefined();
      yield rows[1]!;
    };
    expect(
      await main(
        [
          "events",
          "wait-for",
          "--type",
          "pull_request.merged",
          "--timeout",
          "1",
        ],
        ctx,
        {
          events: { loadSdk: async () => fixture },
        },
      ),
    ).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toEqual(rows[1]);
  });
});
