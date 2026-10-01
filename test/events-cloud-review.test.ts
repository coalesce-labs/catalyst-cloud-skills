// events-cloud-review.test.ts — CTC-4554 review fixes:
// 1. a ticket filter resolves the ticket as the cloud's event index does (entity, payload.ticket,
//    the lease that caused it), on the cloud and the cache paths, with the real event shapes;
// 2. a body-unavailable stub is a valid event, and an over-limit event is skipped with a warning;
// 3. status and query on an unreachable cloud are named failures, and status reports index lag;
// 4. wait-for tells an outage from a timeout, tail warns after a minute unreachable, SIGINT is 130;
// 5. a filtered tail names the server's 400 reason.
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { main } from "../src/cli";
import { saveConfig } from "../src/config";
import type { CachedEvent, EventsSdk } from "../src/events";
import { cloudEvents, type EventSocket } from "../src/events-cloud";
import { eventMatches, type CloudTailDeps } from "../src/events-cloud-tail";
import { makeCtx, tempHome, type TestCtx } from "./helpers";

class Socket extends EventTarget implements EventSocket {
  readyState = 0;
  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}
class Sink extends Writable {
  chunks: string[] = [];
  constructor() {
    super({ decodeStrings: false });
  }
  override _write(chunk: string, _encoding: string, callback: (error?: Error | null) => void) {
    this.chunks.push(chunk);
    callback();
  }
}
function context(fetchImpl?: (url: URL) => Response | Promise<Response>): TestCtx {
  const ctx = makeCtx(tempHome());
  saveConfig(ctx.home, {
    baseUrl: "https://cloud.test/",
    key: "private-token",
    account: "tenant-1",
    slug: "test",
    name: "Test",
    permissions: [],
    principal: "session",
    joinedAt: "2026-10-01T00:00:00Z",
    lastSkillBundleVersion: "0.14.6",
  });
  if (fetchImpl)
    ctx.fetch = (async (input: string | URL | Request) =>
      fetchImpl(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url))) as typeof fetch;
  return ctx;
}
const headProbe = (url: URL, head: number) =>
  url.searchParams.get("since") === String(Number.MAX_SAFE_INTEGER)
    ? new Response(null, { status: 409, headers: { "x-catalyst-event-backbone-head-seq": String(head) } })
    : undefined;
const noCache = async (): Promise<EventsSdk> => {
  throw new Error("the local event cache was loaded");
};

// The real shapes, from the producers in catalyst-cloud (phase-accept.ts, dispatch-events.ts).
const relayCompleted = {
  tenantId: "tenant-1",
  sequence: 7,
  eventId: "evt-7",
  type: "relay.phase.completed",
  schemaVersion: 1,
  recordedAt: "2026-10-01T00:00:00.000Z",
  entity: { type: "ticket", id: "CTC-42" },
  payload: { phase: "implement", nonce: 3, artifactRef: "artifacts/CTC-42/implement/3" },
} as unknown as CachedEvent;
const phaseComplete = {
  ...relayCompleted,
  sequence: 8,
  eventId: "evt-8",
  type: "phase.implement.complete",
  entity: undefined,
  causationId: "lease:CTC-42/implement#3",
  payload: { summary: "done" },
} as unknown as CachedEvent;
const phaseFailed = { ...phaseComplete, sequence: 9, eventId: "evt-9", type: "phase.validate.failed", causationId: "lease:CTC-42/validate#4" } as unknown as CachedEvent;
const dispatchFailed = {
  ...relayCompleted,
  sequence: 10,
  eventId: "evt-10",
  type: "phase.dispatch.failed",
  entity: undefined,
  causationId: "lease:CTC-42/plan#2",
  payload: { ticket: "CTC-42", phase: "plan", reason: "no account" },
} as unknown as CachedEvent;
const stub = {
  tenantId: "tenant-1",
  sequence: 11,
  eventId: "evt-11",
  type: "relay.phase.completed",
  ticket: "CTC-42",
  bodyUnavailable: true,
  reason: "archive_write_failed",
} as unknown as CachedEvent;

test("a ticket filter resolves the ticket as the cloud index does, for every real phase shape", () => {
  const ctc42 = eventMatches({ ticket: "ctc-42" });
  for (const event of [relayCompleted, phaseComplete, phaseFailed, dispatchFailed, stub]) expect(ctc42(event), event.type).toBe(true);
  expect(eventMatches({ ticket: "CTC-4" })(relayCompleted)).toBe(false);
  // The index reads only those three places, so a ticket elsewhere in the payload is not a match.
  expect(eventMatches({ ticket: "CTC-42" })({ ...relayCompleted, entity: undefined, payload: { workItem: { identifier: "CTC-42" } } } as unknown as CachedEvent)).toBe(false);
});

test("wait-for --ticket --type relay.phase.completed matches from the cloud and from the cache", async () => {
  const cloudOut = new Sink();
  const source: NonNullable<CloudTailDeps["events"]> = async function* () {
    yield relayCompleted;
  };
  expect(
    await main(["events", "wait-for", "--ticket", "CTC-42", "--type", "relay.phase.completed", "--timeout", "5"], context(), {
      events: { loadSdk: noCache, out: cloudOut, cloud: { events: source } },
    }),
  ).toBe(0);
  expect(cloudOut.chunks).toHaveLength(1);

  const ctx = context();
  const cache: EventsSdk = {
    CatalystEventSync: class {
      async start() {}
      async stop() {}
    },
    defaultEventCacheDirectory: () => `${ctx.home}/events`,
    readCachedEvents: async () => [],
    async *tailCachedEvents() {
      yield relayCompleted;
    },
  };
  expect(
    await main(["events", "wait-for", "--from-cache", "--ticket", "CTC-42", "--type", "relay.phase.completed", "--timeout", "5"], ctx, {
      events: { loadSdk: async () => cache },
    }),
  ).toBe(0);
  expect(ctx.out).toHaveLength(1);
});

test("a filtered tail accepts a body-unavailable stub, prints it, and moves past it", async () => {
  const ctx = context((url) =>
    headProbe(url, 11) ??
    Response.json({ events: [stub], next: null, coverage: { indexedFromSeq: 1, indexedToSeq: 11 } }),
  );
  const abort = new AbortController();
  const got: CachedEvent[] = [];
  for await (const event of cloudEvents(ctx, { after: 10, filter: { ticket: "CTC-42" }, signal: abort.signal }, { socket: () => new Socket() })) {
    got.push(event);
    abort.abort();
  }
  expect(got).toEqual([stub]);
});

test("an event over the page limit is skipped with a warning naming its sequence", async () => {
  const later = { ...relayCompleted, sequence: 13, eventId: "evt-13" };
  const ctx = context((url) => {
    const head = headProbe(url, 13);
    if (head) return head;
    if (url.searchParams.get("afterSeq") === "11")
      return Response.json({ error: "event_too_large", sequence: 12, maxBytes: 1048576, eventBytes: 2000000, next: { param: "afterSeq", value: 12 } }, { status: 413 });
    return Response.json({ events: [later], next: null, coverage: { indexedFromSeq: 1, indexedToSeq: 13 } });
  });
  const abort = new AbortController();
  const got: number[] = [];
  for await (const event of cloudEvents(ctx, { after: 11, filter: { ticket: "CTC-42" }, signal: abort.signal }, { socket: () => new Socket() })) {
    got.push(event.sequence);
    abort.abort();
  }
  expect(got).toEqual([13]);
  expect(ctx.err.join("\n")).toContain("skipped event 12");
});

test("a filtered tail names the server's 400 reason", async () => {
  const ctx = context((url) => headProbe(url, 5) ?? Response.json({ error: "unknown_event_type", types: ["nope"] }, { status: 400 }));
  const code = await main(["events", "tail", "--type", "nope", "--after", "1"], ctx, {
    events: { loadSdk: noCache, out: new Sink(), cloud: { socket: () => new Socket() } },
  });
  expect(code).toBe(2);
  expect(ctx.err.join("\n")).toContain("unknown_event_type");
});

test("status on an unreachable cloud is a named failure, and --json still answers", async () => {
  const down = () => {
    throw new TypeError("fetch failed");
  };
  const json = context(down);
  expect(await main(["events", "status", "--json"], json, { events: { loadSdk: noCache } })).toBe(4);
  expect(JSON.parse(json.out.join("\n"))).toMatchObject({ source: "cloud", reachable: false, error: "network error" });
  const human = context(down);
  expect(await main(["events", "status"], human, { events: { loadSdk: noCache } })).toBe(4);
  expect(human.err.join("\n")).toContain("the cloud event service is unreachable (network error)");
  expect(human.err.join("\n")).not.toContain("failed to load");
});

test("query on a cloud answering 503 is a named failure", async () => {
  const ctx = context(() => new Response("", { status: 503 }));
  expect(await main(["events", "query", "--ticket", "CTC-42"], ctx, { events: { loadSdk: noCache } })).toBe(4);
  expect(ctx.err.join("\n")).toContain("the cloud event service is unreachable (service unavailable)");
});

test("status measures the filtered index's lag behind the head instead of claiming zero", async () => {
  const ctx = context((url) =>
    headProbe(url, 42) ??
    (url.pathname === "/api/v1/events/query"
      ? Response.json({ events: [], next: null, coverage: { indexedFromSeq: 1, indexedToSeq: 40 } })
      : undefined)!,
  );
  expect(await main(["events", "status", "--json"], ctx, { events: { loadSdk: noCache } })).toBe(0);
  expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ source: "cloud", reachable: true, head: 42, behind: null, indexedToSeq: 40, indexLag: 2 });
});

test("wait-for exits 4 on an outage, distinct from a timeout", async () => {
  const outage: NonNullable<CloudTailDeps["events"]> = async function* (_ctx, options, deps) {
    for (let failures = 1; failures <= 5; failures++) deps.onTrouble?.({ failures, sinceMs: Date.now() - failures * 1_000 });
    if (!options.signal.aborted)
      await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const ctx = context();
  expect(
    await main(["events", "wait-for", "--ticket", "CTC-42", "--timeout", "30"], ctx, {
      events: { loadSdk: noCache, out: new Sink(), cloud: { events: outage } },
    }),
  ).toBe(4);
  expect(ctx.err.join("\n")).toContain("unreachable for 5 attempts");
  expect(ctx.err.join("\n")).not.toContain("no matching event within");
});

test("tail warns once on stderr when the cloud has been unreachable for over a minute", async () => {
  const outage: NonNullable<CloudTailDeps["events"]> = async function* (_ctx, _options, deps) {
    deps.onTrouble?.({ failures: 1, sinceMs: Date.now() - 10_000 });
    deps.onTrouble?.({ failures: 6, sinceMs: Date.now() - 61_000 });
    deps.onTrouble?.({ failures: 7, sinceMs: Date.now() - 70_000 });
    deps.onHealthy?.();
    yield relayCompleted;
  };
  const ctx = context();
  expect(await main(["events", "tail"], ctx, { events: { loadSdk: noCache, out: new Sink(), cloud: { events: outage } } })).toBe(0);
  const warnings = ctx.err.filter((line) => line.includes("unreachable for"));
  expect(warnings).toHaveLength(1);
  expect(ctx.err.join("\n")).toContain("reachable again");
});

test("an interrupted tail exits 130", async () => {
  const hold: NonNullable<CloudTailDeps["events"]> = async function* (_ctx, options) {
    await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  let interrupt = () => {};
  const code = main(["events", "tail"], context(), {
    events: {
      loadSdk: noCache,
      out: new Sink(),
      cloud: { events: hold },
      onInterrupt: (handler) => {
        interrupt = handler;
        return () => {};
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  interrupt();
  expect(await code).toBe(130);
});

test("the cloud and cache paths print the same events for one ticket filter, following the index exactly", async () => {
  const long = `CTC-${"9".repeat(70)}`;
  const fixtures = [
    relayCompleted,
    phaseComplete,
    dispatchFailed,
    // The index reads only a `ticket` entity's id: an `issue` entity, or an identifier field, is not a ticket.
    { ...relayCompleted, sequence: 20, eventId: "evt-20", entity: { type: "issue", id: "CTC-42" } },
    { ...relayCompleted, sequence: 21, eventId: "evt-21", entity: { type: "ticket", identifier: "CTC-42" } },
    // A ticket over the index's 64-byte bound is not indexed, so it never matches.
    { ...relayCompleted, sequence: 22, eventId: "evt-22", entity: { type: "ticket", id: long } },
  ] as unknown as CachedEvent[];
  const expected = [7, 8, 10];

  const cloudOut = new Sink();
  const source: NonNullable<CloudTailDeps["events"]> = async function* () {
    yield* fixtures;
  };
  expect(await main(["events", "tail", "--ticket", "CTC-42"], context(), { events: { loadSdk: noCache, out: cloudOut, cloud: { events: source } } })).toBe(0);
  const fromCloud = cloudOut.chunks.map((chunk) => (JSON.parse(chunk) as CachedEvent).sequence);

  const ctx = context();
  const cache: EventsSdk = {
    CatalystEventSync: class {
      async start() {}
      async stop() {}
    },
    defaultEventCacheDirectory: () => `${ctx.home}/events`,
    readCachedEvents: async () => fixtures,
    async *tailCachedEvents() {
      yield* fixtures;
    },
  };
  expect(await main(["events", "query", "--from-cache", "--ticket", "CTC-42", "--limit", "50"], ctx, { events: { loadSdk: async () => cache } })).toBe(0);
  const fromCache = ctx.out.map((line) => (JSON.parse(line) as CachedEvent).sequence);

  expect(fromCloud).toEqual(expected);
  expect(fromCache).toEqual(expected);
  expect(eventMatches({ ticket: long })(fixtures[5]!)).toBe(false);
});
