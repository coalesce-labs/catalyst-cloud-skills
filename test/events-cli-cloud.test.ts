// events-cli-cloud.test.ts — CTC-4554: `catalyst events tail | wait-for | query | status` read the
// cloud by default and need no local file; `--from-cache` is the opt-in local source.
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { main } from "../src/cli";
import { saveConfig } from "../src/config";
import type { CachedEvent, EventsSdk } from "../src/events";
import type { CloudTailDeps } from "../src/events-cloud-tail";
import { makeCtx, tempHome, type TestCtx } from "./helpers";

const row = (sequence: number, type = "phase.completed", ticket = "CTC-4511"): CachedEvent => ({
  tenantId: "tenant-1",
  sequence,
  eventId: `evt-${sequence}`,
  type,
  recordedAt: "2026-10-01T00:00:00Z",
  payload: { ticket },
});

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

/** The cloud path must never load the SDK's local event cache. */
const noCache = async (): Promise<EventsSdk> => {
  throw new Error("the local event cache was loaded");
};

function context(fetchImpl?: (url: URL) => Response | undefined): TestCtx {
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
  if (fetchImpl) {
    ctx.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const answer = fetchImpl(url);
      if (!answer) throw new Error(`unexpected request ${url.pathname}`);
      return answer;
    }) as typeof fetch;
  }
  return ctx;
}

/** A scripted cloud source; `hold` keeps it open until the caller aborts. */
function source(rows: CachedEvent[], hold = false) {
  const calls: { after?: number; filter?: unknown }[] = [];
  const events: NonNullable<CloudTailDeps["events"]> = async function* (_ctx, options) {
    calls.push({ after: options.after, filter: options.filter });
    for (const event of rows) yield event;
    if (hold)
      await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  return { calls, events };
}

test("tail streams matching cloud events as NDJSON lines with no local file", async () => {
  const ctx = context();
  const out = new Sink();
  const cloud = source([row(5), row(6, "pull_request.merged"), row(7, "phase.completed", "CTC-9")]);
  const code = await main(["events", "tail", "--type", "phase.completed", "--ticket", "ctc-4511", "--after", "4"], ctx, {
    events: { loadSdk: noCache, out, cloud: { events: cloud.events } },
  });
  expect(code).toBe(0);
  expect(out.chunks.every((chunk) => chunk.endsWith("\n"))).toBe(true);
  expect(out.chunks.map((chunk) => (JSON.parse(chunk) as CachedEvent).sequence)).toEqual([5]);
  expect(cloud.calls).toEqual([{ after: 4, filter: { type: "phase.completed", ticket: "CTC-4511" } }]);
  expect(ctx.err.join("\n")).toContain("resume with --after 7");
});

test("wait-for prints the first cloud match and stops", async () => {
  const ctx = context();
  const out = new Sink();
  const cloud = source([row(8, "pull_request.merged"), row(9), row(10)], true);
  const code = await main(["events", "wait-for", "--ticket", "CTC-4511", "--type", "phase.completed", "--timeout", "5"], ctx, {
    events: { loadSdk: noCache, out, cloud: { events: cloud.events } },
  });
  expect(code).toBe(0);
  expect(out.chunks.map((chunk) => (JSON.parse(chunk) as CachedEvent).sequence)).toEqual([9]);
});

test("wait-for exits 1 with nothing printed when no cloud event matches in time", async () => {
  const ctx = context();
  const out = new Sink();
  const cloud = source([row(8, "pull_request.merged")], true);
  const code = await main(["events", "wait-for", "--type", "phase.completed", "--timeout", "1"], ctx, {
    events: { loadSdk: noCache, out, cloud: { events: cloud.events } },
  });
  expect(code).toBe(1);
  expect(out.chunks).toEqual([]);
  expect(ctx.err.join("\n")).toContain("no matching event within 1 s");
});

test("query asks the cloud's filtered events query, newest first by default", async () => {
  const seen: URL[] = [];
  const ctx = context((url) => {
    if (url.pathname !== "/api/v1/events/query") return undefined;
    seen.push(url);
    return Response.json({
      events: [row(12), row(11)],
      next: { param: "beforeSeq", value: 11 },
      coverage: { indexedFromSeq: 3, indexedToSeq: 12 },
    });
  });
  const code = await main(["events", "query", "--ticket", "ctc-4511", "--type", "phase.completed", "--limit", "2"], ctx, {
    events: { loadSdk: noCache },
  });
  expect(code).toBe(0);
  expect(ctx.out.map((line) => (JSON.parse(line) as CachedEvent).sequence)).toEqual([12, 11]);
  const params = seen[0]!.searchParams;
  expect(params.get("ticket")).toBe("CTC-4511");
  expect(params.get("type")).toBe("phase.completed");
  expect(params.get("limit")).toBe("2");
  expect(params.get("order")).toBe("desc");
  expect(ctx.err.join("\n")).toContain("more: re-run with --before 11");
});

test("query --order asc --after pages forward from a cursor", async () => {
  const seen: URL[] = [];
  const ctx = context((url) => {
    seen.push(url);
    return Response.json({ events: [row(21)], next: null, coverage: { indexedFromSeq: 3, indexedToSeq: 30 } });
  });
  expect(await main(["events", "query", "--order", "asc", "--after", "20"], ctx, { events: { loadSdk: noCache } })).toBe(0);
  expect(seen[0]!.searchParams.get("order")).toBe("asc");
  expect(seen[0]!.searchParams.get("afterSeq")).toBe("20");
  expect(seen[0]!.searchParams.get("limit")).toBe("50");
});

test("an empty cloud page says what the index covers instead of implying nothing happened", async () => {
  const ctx = context(() =>
    Response.json({ events: [], next: null, coverage: { indexedFromSeq: 40, indexedToSeq: 90 } }),
  );
  expect(await main(["events", "query", "--ticket", "CTC-1"], ctx, { events: { loadSdk: noCache } })).toBe(0);
  expect(ctx.out).toEqual([]);
  expect(ctx.err.join("\n")).toContain("the cloud index holds sequences 40 to 90");
});

test("query refuses a limit the cloud page cannot hold, and an unknown order", async () => {
  expect(await main(["events", "query", "--limit", "201"], context(), { events: { loadSdk: noCache } })).toBe(1);
  expect(await main(["events", "query", "--order", "sideways"], context(), { events: { loadSdk: noCache } })).toBe(1);
});

test("a cloud refusal of the query is named with the server's reason", async () => {
  const ctx = context(() => Response.json({ error: "unknown_event_type", types: ["nope"] }, { status: 400 }));
  expect(await main(["events", "query", "--type", "nope"], ctx, { events: { loadSdk: noCache } })).not.toBe(0);
  expect(ctx.err.join("\n")).toContain("unknown_event_type");
});

test("status names the cloud stream as the source and how far behind it is", async () => {
  const head = (url: URL) =>
    url.pathname === "/api/v1/events/backbone"
      ? new Response(null, { status: 409, headers: { "x-catalyst-event-backbone-head-seq": "42" } })
      : undefined;
  const json = context(head);
  expect(await main(["events", "status", "--json"], json, { events: { loadSdk: noCache } })).toBe(0);
  expect(JSON.parse(json.out.join("\n"))).toMatchObject({ source: "cloud", head: 42, behind: 0 });
  const human = context(head);
  expect(await main(["events", "status"], human, { events: { loadSdk: noCache } })).toBe(0);
  const line = human.out.join("\n");
  expect(line).toContain("events: cloud stream at head 42, 0 behind");
  expect(line).toContain("--from-cache");
});

test("--directory reads the local cache only, so it needs --from-cache", async () => {
  const ctx = context();
  expect(await main(["events", "tail", "--directory", "/tmp/x"], ctx, { events: { loadSdk: noCache } })).toBe(1);
  expect(ctx.err.join("\n")).toContain("--from-cache");
});
