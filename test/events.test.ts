import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { main } from "../src/cli";
import {
  createEventSync,
  type CachedEvent,
  type EventsSdk,
} from "../src/events";
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

  test("wait-for catches an event already cached after a pre-move cursor", async () => {
    const fixture = sdk();
    fixture.tailCachedEvents = async function* ({ after }) {
      // This models the SDK: absent --after starts at the current local cursor (5),
      // while the pre-move cursor (3) replays event 4 cached before wait-for began.
      const localHead = 5;
      let cursor = after ?? localHead;
      for (const event of rows.filter((row) => row.sequence > cursor)) {
        cursor = event.sequence;
        yield event;
      }
    };
    expect(
      await main(
        ["events", "wait-for", "--ticket", "CTC-1352", "--timeout", "1"],
        ctx,
        { events: { loadSdk: async () => fixture } },
      ),
    ).toBe(1);
    expect(
      await main(
        [
          "events",
          "wait-for",
          "--ticket",
          "CTC-1352",
          "--after",
          "3",
          "--timeout",
          "1",
        ],
        ctx,
        { events: { loadSdk: async () => fixture } },
      ),
    ).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toEqual(rows[0]);
  });

  test("tail honors an explicit cursor and nested ticket references", async () => {
    const fixture = sdk();
    fixture.tailCachedEvents = async function* ({ after, directory, signal }) {
      expect(after).toBe(4);
      expect(directory).toBe(`${home}/chosen-events`);
      expect(signal.aborted).toBe(false);
      yield {
        ...rows[1]!,
        payload: { related: [{ issueIdentifier: "ctc-1352" }] },
      };
    };
    expect(
      await main(
        [
          "events",
          "tail",
          "--after",
          "4",
          "--ticket",
          "CTC-1352",
          "--directory",
          `${home}/chosen-events`,
        ],
        ctx,
        { events: { loadSdk: async () => fixture } },
      ),
    ).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ sequence: 5 });
  });

  test("wait-for returns one on timeout or an exhausted cache", async () => {
    const empty = sdk();
    empty.tailCachedEvents = async function* () {};
    expect(
      await main(["events", "wait-for", "--timeout", "1"], ctx, {
        events: { loadSdk: async () => empty },
      }),
    ).toBe(1);

    const waiting = sdk();
    waiting.tailCachedEvents = async function* ({ signal }) {
      if (signal.aborted) return;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    };
    const abort = new AbortController();
    abort.abort(new Error("caller stopped"));
    expect(
      await main(["events", "wait-for", "--timeout", "30"], makeCtx(home), {
        events: { loadSdk: async () => waiting, signal: abort.signal },
      }),
    ).toBe(1);

    const timed = sdk();
    timed.tailCachedEvents = async function* ({ signal }) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw signal.reason;
    };
    expect(
      await main(["events", "wait-for", "--timeout", "0"], makeCtx(home), {
        events: { loadSdk: async () => timed },
      }),
    ).toBe(1);
  });

  test("an absent cache names the start command and exits unavailable", async () => {
    const missing = sdk();
    missing.tailCachedEvents = async function* () {
      const error = new Error("missing") as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    };
    expect(
      await main(["events", "tail"], ctx, {
        events: { loadSdk: async () => missing },
      }),
    ).toBe(3);
    expect(ctx.err.join("\n")).toContain("replica start --detach");
  });

  test("subcommand and cursor validation fail before reading the cache", async () => {
    expect(await main(["events"], ctx)).toBe(1);
    expect(await main(["events", "nope"], makeCtx(home))).toBe(1);
    for (const after of ["-1", "1.5", "not-a-number"]) {
      expect(
        await main(["events", "query", "--after", after], makeCtx(home), {
          events: { loadSdk: async () => sdk() },
        }),
      ).toBe(1);
    }
  });

  test("query applies the requested limit after filtering", async () => {
    expect(
      await main(["events", "query", "--limit", "1"], ctx, {
        events: { loadSdk: async () => sdk() },
      }),
    ).toBe(0);
    expect(ctx.out.map((line) => JSON.parse(line))).toEqual([rows[1]]);
  });

  test("tail skips non-matches and a caller abort ends cleanly", async () => {
    const fixture = sdk();
    fixture.tailCachedEvents = async function* ({ signal }) {
      yield rows[0]!;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw signal.reason;
    };
    const abort = new AbortController();
    setTimeout(() => abort.abort(new Error("done")), 1);
    expect(
      await main(["events", "tail", "--type", "never"], ctx, {
        events: { loadSdk: async () => fixture, signal: abort.signal },
      }),
    ).toBe(0);
    expect(ctx.out).toEqual([]);
  });

  test("query ticket matching handles strings, nulls, and unrelated objects", async () => {
    const fixture = sdk();
    fixture.readCachedEvents = async () => [
      { ...rows[0]!, payload: "ctc-1352" },
      { ...rows[1]!, payload: null },
      { ...rows[1]!, sequence: 6, payload: { ticket: "CTC-OTHER" } },
    ];
    expect(
      await main(["events", "query", "--ticket", "CTC-1352"], ctx, {
        events: { loadSdk: async () => fixture },
      }),
    ).toBe(0);
    expect(ctx.out.map((line) => JSON.parse(line).sequence)).toEqual([4]);
  });

  test("unexpected cache failures are not converted to cache absence", async () => {
    const fixture = sdk();
    fixture.tailCachedEvents = async function* () {
      throw new Error("read failed");
    };
    await expect(
      main(["events", "tail"], ctx, {
        events: { loadSdk: async () => fixture },
      }),
    ).rejects.toThrow("read failed");
  });

  test("event sync uses the joined tenant, API, token, and injected fetch", async () => {
    let options: ConstructorParameters<EventsSdk["CatalystEventSync"]>[0] | undefined;
    const fixture = sdk();
    fixture.CatalystEventSync = class {
      constructor(received: ConstructorParameters<EventsSdk["CatalystEventSync"]>[0]) {
        options = received;
      }
      async start() {}
      async stop() {}
    };
    const handle = await createEventSync(ctx, { loadSdk: async () => fixture });
    expect(handle).toBeInstanceOf(fixture.CatalystEventSync);
    expect(options).toMatchObject({
      baseUrl: `${server.url}/api/v1`,
      tenantId: "tenant-3",
      auth: { kind: "token", token: "fixture-key" },
      fetch: ctx.fetch,
    });

    await expect(createEventSync(ctx)).resolves.toBeDefined();
  });

  test("query can load the published SDK events entry directly", async () => {
    expect(
      await main(
        ["events", "query", "--directory", `${home}/missing-events`],
        ctx,
      ),
    ).toBe(0);
    expect(ctx.out).toEqual([]);
  });
});
