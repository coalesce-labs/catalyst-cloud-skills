// project.test.ts — `catalyst project wip-limit get|set` against the agent twin of the cloud's member route, with the
// reply shape the cloud pins: { team:{id,key}, limit, source, stored, inProgress, countedAt }, and its
// error bodies { error, message } (forbidden, team-unknown, invalid-limit).
// Any member reads; an owner or admin sets; a value outside 0..9999 never leaves this machine.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { main } from "../src/cli";
import { contractPathFor } from "../src/config";
import { WIP_LIMIT_ROUTE, parseLimit, resolveTeam, ticketIds, wipLimitPath } from "../src/project";
import type { TenantContract } from "../src/contract-types";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

type Body = Record<string, unknown>;
type Recorded = { method: string; path: string; body: Body | null; authorization: string | null };

const view = (over: Body = {}): Body => ({ team: { id: "team-eng", key: "ENG" }, limit: 12, source: "default", stored: null, inProgress: 12, countedAt: 1_790_000_000_000, ...over });

let fixture: FixtureServer;
let ctx: TestCtx;
let home: string;
let requests: Recorded[];
let response: (method: string, path: string, body: Body | null) => [number, unknown];

function cachedContract(): TenantContract {
  return (JSON.parse(readFileSync(contractPathFor(home), "utf8")) as { doc: TenantContract }).doc;
}
function rewriteTeams(teams: TenantContract["teams"]): void {
  const path = contractPathFor(home);
  const cache = JSON.parse(readFileSync(path, "utf8")) as { doc: TenantContract };
  cache.doc.teams = teams;
  writeFileSync(path, JSON.stringify(cache));
}
const engId = () => cachedContract().teams.find((t) => t.key === "ENG")!.id;

beforeAll(async () => { fixture = await startMeFixture(); });
afterAll(async () => { await fixture.close(); });
beforeEach(async () => {
  home = tempHome();
  await seedJoined(home, fixture);
  requests = [];
  response = (method, _path, body) => {
    if (method === "GET") return [200, view()];
    if (method === "POST") {
      const limit = body?.limit as number | null;
      return [200, view({ limit: limit ?? 12, source: limit === null ? "default" : "project", stored: limit })];
    }
    return [404, { error: "missing" }];
  };
  ctx = makeCtx(home, {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== WIP_LIMIT_ROUTE) return fetch(input, init);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Body) : null;
      requests.push({ method, path: url.pathname + url.search, body, authorization: new Headers(init?.headers).get("authorization") });
      const [status, payload] = response(method, url.pathname, body);
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    },
  });
});

describe("get", () => {
  test("reads the member route for the named project with the person's bearer, and says count, limit, source and how to change it", async () => {
    expect(await main(["project", "wip-limit", "get", "--team", "ENG"], ctx)).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "GET", path: wipLimitPath(engId()) });
    expect(requests[0]!.authorization).toMatch(/^Bearer /);
    expect(ctx.out[0]).toBe("ENG: 12 in progress, limit 12 (default) — at the limit: a new ticket waits until one in progress finishes");
    expect(ctx.out[1]).toContain("catalyst project wip-limit set <n> --team ENG");
    expect(ctx.out[1]).toContain("owner or admin");
  });

  test("--json passes the cloud's shape through with the project named", async () => {
    response = () => [200, view({ limit: 20, source: "project", stored: 20, inProgress: 3, extraField: "kept" })];
    expect(await main(["project", "wip-limit", "get", "--team", "eng", "--json"], ctx)).toBe(0);
    const doc = JSON.parse(ctx.out.join("\n")) as Body;
    expect(doc).toMatchObject({ team: { key: "ENG" }, limit: 20, source: "project", stored: 20, inProgress: 3, extraField: "kept" });
  });

  test("inProgressTickets, when the cloud sends them, are named on their own line in either shape; absent, no line", async () => {
    response = () => [200, view({ inProgressTickets: ["ENG-4", "ENG-9", { identifier: "ENG-12" }, { id: "ENG-15" }] })];
    expect(await main(["project", "wip-limit", "get", "--team", "ENG"], ctx)).toBe(0);
    expect(ctx.out[1]).toBe("in progress: ENG-4, ENG-9, ENG-12, ENG-15 — these are what a new ticket waits on; unstick them, not the queue");
    expect(ctx.out[2]).toContain("change it:");
    ctx.out.length = 0;
    response = () => [200, view({ inProgressTickets: Array.from({ length: 15 }, (_, i) => `ENG-${i + 1}`) })];
    expect(await main(["project", "wip-limit", "get", "--team", "ENG"], ctx)).toBe(0);
    expect(ctx.out[1]).toMatch(/^in progress: ENG-1, .*ENG-12 and 3 more — /);
    ctx.out.length = 0;
    response = () => [200, view()];
    expect(await main(["project", "wip-limit", "get", "--team", "ENG"], ctx)).toBe(0);
    expect(ctx.out).toHaveLength(2);
    expect(ticketIds(undefined)).toEqual([]);
    expect(ticketIds("ENG-1")).toEqual([]);
  });

  test("below the limit the line carries no at-the-limit clause", async () => {
    response = () => [200, view({ inProgress: 4 })];
    expect(await main(["project", "wip-limit", "get", "--team", "ENG"], ctx)).toBe(0);
    expect(ctx.out[0]).toBe("ENG: 4 in progress, limit 12 (default)");
  });

  test("with two mapped projects and no --team it asks for one, and sends nothing", async () => {
    expect(await main(["project", "wip-limit", "get"], ctx)).not.toBe(0);
    expect(ctx.err.join("\n")).toMatch(/--team is needed: 2 projects are mapped \(ENG, OPS\)/);
    expect(requests).toHaveLength(0);
  });

  test("with one mapped project, no --team means that project", async () => {
    const eng = cachedContract().teams.find((t) => t.key === "ENG")!;
    rewriteTeams([eng]);
    expect(await main(["project", "wip-limit", "get"], ctx)).toBe(0);
    expect(requests[0]!.path).toBe(wipLimitPath(eng.id));
  });

  test("an unknown key names the mapped ones", async () => {
    expect(await main(["project", "wip-limit", "get", "--team", "NOPE"], ctx)).not.toBe(0);
    expect(ctx.err.join("\n")).toMatch(/no mapped project has the team key NOPE \(mapped: ENG, OPS\)/);
  });

  test("a cloud without the route says so, exit 1; a 404 team-unknown names the key instead", async () => {
    response = () => [404, { error: "not_found" }];
    expect(await main(["project", "wip-limit", "get", "--team", "ENG"], ctx)).toBe(1);
    expect(ctx.out[0]).toBe("refused (404): this Catalyst Cloud does not serve the wip-limit route yet (needs a newer cloud)");
    ctx.out.length = 0;
    response = () => [404, { error: "team-unknown", message: "no team ENG in this workspace" }];
    expect(await main(["project", "wip-limit", "get", "--team", "ENG"], ctx)).toBe(1);
    expect(ctx.out[0]).toBe("refused (404): this cloud does not know a team ENG; check the key with catalyst team list (no team ENG in this workspace)");
  });
});

describe("set", () => {
  test("POSTs {team, limit:n} after reading the current value, and prints before → after", async () => {
    expect(await main(["project", "wip-limit", "set", "8", "--team", "ENG"], ctx)).toBe(0);
    expect(requests.map((r) => r.method)).toEqual(["GET", "POST"]);
    expect(requests[1]).toMatchObject({ method: "POST", path: WIP_LIMIT_ROUTE, body: { team: engId(), limit: 8 } });
    expect(ctx.out[0]).toBe("ENG: limit 12 (default) → 8 (set for this project)");
    expect(ctx.out[1]).toBe("ENG: 12 in progress, limit 8 (set for this project) — at the limit: a new ticket waits until one in progress finishes");
  });

  test("set default POSTs {limit:null}", async () => {
    response = (method, _p, body) => (method === "GET" ? [200, view({ limit: 8, source: "project", stored: 8 })] : [200, view({ limit: body?.limit === null ? 12 : 0, source: "default", stored: null })]);
    expect(await main(["project", "wip-limit", "set", "default", "--team", "ENG"], ctx)).toBe(0);
    expect(requests[1]!.body).toEqual({ team: engId(), limit: null });
    expect(ctx.out[0]).toBe("ENG: limit 8 (set for this project) → 12 (default)");
  });

  test("set 0 says it holds every new start", async () => {
    expect(await main(["project", "wip-limit", "set", "0", "--team", "ENG"], ctx)).toBe(0);
    expect(ctx.out[0]).toContain("0 holds every new start");
  });

  test("--json carries the new view and the previous limit", async () => {
    expect(await main(["project", "wip-limit", "set", "8", "--team", "ENG", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ team: { key: "ENG" }, limit: 8, source: "project", previous: { limit: 12, source: "default" } });
  });

  test("a value outside 0..9999, a non-integer, or no value never reaches the cloud", async () => {
    for (const argv of [["set", "12000"], ["set", "abc"], ["set", "1.5"], ["set"]]) {
      ctx.err.length = 0;
      expect(await main(["project", "wip-limit", ...argv, "--team", "ENG"], ctx), argv.join(" ")).not.toBe(0);
      expect(ctx.err.join("\n"), argv.join(" ")).toMatch(/0 to 9999|needs a value/);
    }
    expect(requests).toHaveLength(0);
  });

  test("a member's set is refused with who can do it, exit 1, after the read succeeded", async () => {
    response = (method) => (method === "GET" ? [200, view()] : [403, { error: "forbidden", message: "setting the WIP limit needs an owner or admin" }]);
    expect(await main(["project", "wip-limit", "set", "8", "--team", "ENG"], ctx)).toBe(1);
    expect(ctx.out[0]).toBe("refused (403): setting the limit needs a workspace owner or admin; any member can read it with catalyst project wip-limit get (setting the WIP limit needs an owner or admin)");
    expect(requests.map((r) => r.method)).toEqual(["GET", "POST"]);
  });

  test("a 400 reports the cloud's code", async () => {
    response = (method) => (method === "GET" ? [200, view()] : [400, { error: "invalid-limit", message: "limit must be a finite number or null" }]);
    expect(await main(["project", "wip-limit", "set", "8", "--team", "ENG"], ctx)).toBe(1);
    expect(ctx.out[0]).toBe("refused (400): invalid-limit (limit must be a finite number or null)");
  });
});

describe("the pure parts", () => {
  test("parseLimit", () => {
    expect(parseLimit("default")).toBeNull();
    expect(parseLimit("0")).toBe(0);
    expect(parseLimit("9999")).toBe(9999);
    expect(() => parseLimit("10000")).toThrow(/0 to 9999/);
  });
  test("resolveTeam matches a key case-insensitively or an id", () => {
    const doc = { teams: [{ id: "t-1", key: "ENG" }, { id: "t-2", key: null }] } as unknown as TenantContract;
    expect(resolveTeam(doc, "eng").id).toBe("t-1");
    expect(resolveTeam(doc, "t-2").id).toBe("t-2");
    expect(() => resolveTeam(doc, undefined)).toThrow(/--team is needed/);
  });
  test("usage: project needs wip-limit, and get takes no value", async () => {
    expect(await main(["project"], ctx)).not.toBe(0);
    expect(await main(["project", "wip-limit"], ctx)).not.toBe(0);
    expect(await main(["project", "wip-limit", "get", "5", "--team", "ENG"], ctx)).not.toBe(0);
    expect(requests).toHaveLength(0);
  });
});
