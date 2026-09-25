import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { main } from "../src/cli";
import { configPathFor, contractPathFor } from "../src/config";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

const base = "/api/v1/agent/team-workflow";
const teamsPath = "/api/v1/agent/teams";
const HASH = "a".repeat(64);
const TOKEN = "1z141z4-3";
const routes = [
  ["GET", teamsPath],
  ["GET", base],
  ...["check", "save", "adopt", "adopt-undo", "migrate"].map((v) => ["POST", `${base}/${v}`]),
] as const;
const stages = [
  { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "s-progress", name: "In Progress", type: "started", position: 2 },
  { id: "s-done", name: "Done", type: "completed", position: 3 },
];
const readiness = { teamId: "team-eng", teamKey: "ENG", teamName: "Engineering", status: "ready", checkedAt: 123, workflowRev: 1, checks: [] };
const config = { teamId: "team-eng", mode: "mapped-existing", gitAutomation: "off", workflowRev: 1 };
const workflow = { config, rows: [{ slot: "dispatch", linearStateId: "s-todo" }], stages, stageSource: "linear", mappingHash: HASH, readiness, checklist: ["Open your Linear team", "Map its stages"] };
const team = (teamKey: string) => ({ ...readiness, teamKey, mode: "mapped-existing", gitAutomation: "off", mappedSlots: 0, mappedLoadBearingSlots: 0, mirrored: true });
const list = (teams: unknown[]) => ({ teams, canManage: true, liveTeamRead: { attempted: false, error: null }, everChecked: false, mirrorRead: true });
const adopt = { teamId: "team-eng", teamKey: "ENG", mode: "adopted-recommended", stages: [{ name: "Plan", type: "started", outcome: "would-create" }], labels: [], unfilledLoadBearing: [], planHash: TOKEN, provenanceGaps: [], labelProvenanceGaps: [], labelsNotCreated: [] };
const source = { stateId: "old", name: "Old", type: "started", ticketCount: 2, destinationStateId: "new", destinationSlot: "implement", because: "chosen", outcome: "ready" };
const preview = { teamId: "team-eng", sources: [source], migrationHash: TOKEN, overLimit: false, issueCount: 2, retireLogReadable: true };
let fixture: FixtureServer;
let ctx: TestCtx;
let requests: { method: string; path: string; body: Record<string, unknown> | null; authorization: string | null }[];
let response: (method: string, path: string, body: Record<string, unknown> | null) => [number, unknown];

beforeAll(async () => { fixture = await startMeFixture(); });
afterAll(async () => { await fixture.close(); });
beforeEach(async () => {
  const home = tempHome();
  await seedJoined(home, fixture);
  const path = contractPathFor(home);
  const cache = JSON.parse(readFileSync(path, "utf8")) as { doc: { routes: unknown[] } };
  cache.doc.routes.push(...routes.map(([method, route]) => ({ method, path: route, since: "1.0.0", takesWriteBudgetUnit: false })));
  writeFileSync(path, JSON.stringify(cache));
  requests = [];
  response = (method, path) => {
    if (method === "GET" && path === teamsPath) return [200, list([team("ENG"), team("OPS")])];
    if (method === "GET" && path === base) return [200, workflow];
    if (path === `${base}/check`) return [200, { readiness, ask: { outcome: "not-needed" } }];
    if (path === `${base}/save`) return [200, { config, readiness, rows: [], stages, stageSource: "linear" }];
    if (path === `${base}/adopt`) return [200, { ...adopt, checklist: [], readiness }];
    if (path === `${base}/migrate`) return [200, { preview }];
    return [404, { error: "missing" }];
  };
  ctx = makeCtx(home, { fetch: async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith("/api/v1/agent/team") ) return fetch(input, init);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ method, path: url.pathname, body, authorization: new Headers(init?.headers).get("authorization") });
    const [status, payload] = response(method, url.pathname, body);
    return Response.json(payload, { status });
  } });
});

test("check names readiness and uses personal bearer", async () => {
  expect(await main(["team", "check", "ENG"], ctx)).toBe(0);
  expect(requests).toMatchObject([{ method: "POST", path: `${base}/check`, body: { team: "ENG" } }]);
  expect(requests[0]?.authorization).toMatch(/^Bearer /);
  expect(ctx.out.join("\n")).toContain("ready");
});

test("team list inventories without creating readiness asks", async () => {
  expect(await main(["team", "list", "--json"], ctx)).toBe(0);
  expect(requests.map((request) => request.path)).toEqual([teamsPath]);
  expect(JSON.parse(ctx.out[0]!)).toMatchObject({ teams: [{ teamKey: "ENG" }, { teamKey: "OPS" }] });
});

test("a fresh contract cache missing team routes is refreshed before refusing", async () => {
  const path = contractPathFor(ctx.home);
  const cache = JSON.parse(readFileSync(path, "utf8")) as { etag: string; doc: { routes: { path: string }[] } };
  cache.doc.routes = cache.doc.routes.filter((route) => !route.path.includes("/team-workflow") && !route.path.endsWith("/teams"));
  writeFileSync(path, JSON.stringify(cache));
  const originalRoutes = [...fixture.contract.routes];
  const liveRoutes = fixture.contract.routes as unknown as typeof originalRoutes;
  const originalVersion = fixture.contractVersion;
  try {
    liveRoutes.push(...routes.map(([method, route]) => ({ method: method as "GET" | "POST", path: route, since: "1.0.0", takesWriteBudgetUnit: false })));
    fixture.contractVersion = "1.0.1";

    expect(await main(["team", "check", "ENG"], ctx)).toBe(0);
    expect(requests).toMatchObject([{ method: "POST", path: `${base}/check`, body: { team: "ENG" } }]);
    expect(fixture.requests.some((request) => request.path === "/api/v1/agent/contract" && request.headers["if-none-match"] === cache.etag)).toBe(true);
  } finally {
    liveRoutes.splice(0, liveRoutes.length, ...originalRoutes);
    fixture.contractVersion = originalVersion;
  }
});

test("check --all checks each listed team and fails on a blocked result", async () => {
  response = (method, path, body) => path === `${base}/check` ? [200, { readiness: { ...readiness, status: body?.team === "OPS" ? "blocked" : "ready", checks: [{ id: "mapping", state: "fail", reason: "missing" }] }, ask: { outcome: "not-needed" } }] : [200, list([team("ENG"), team("OPS")])];
  expect(await main(["team", "check", "--all", "--json"], ctx)).toBe(1);
  expect(requests.map((r) => r.path)).toEqual([teamsPath, `${base}/check`, `${base}/check`]);
  expect(JSON.parse(ctx.out[0]!)).toMatchObject({ results: [{ team: "ENG" }, { team: "OPS" }] });
});

test("check --all reports an empty inventory without claiming readiness", async () => {
  response = () => [200, list([])];
  expect(await main(["team", "check", "--all", "--json"], ctx)).toBe(1);
  expect(requests).toHaveLength(1);
});

test("checklist reads shared lines and refuses unreadable inventory", async () => {
  expect(await main(["team", "checklist", "ENG"], ctx)).toBe(0);
  expect(ctx.out.join("\n")).toContain("Open your Linear team");
  expect(requests).toHaveLength(1);
  response = () => [200, { ...workflow, checklist: null, stageSource: "none" }];
  expect(await main(["team", "checklist", "ENG", "--json"], ctx)).toBe(1);
});

test("map previews resolved live ids and does not save without confirmation", async () => {
  expect(await main(["team", "map", "ENG", "--stage", "dispatch=Todo", "--stage", "done=Done", "--json"], ctx)).toBe(3);
  expect(requests).toHaveLength(1);
  const output = JSON.parse(ctx.out[0]!) as { decision: string; planHash: string; rows: { slot: string; linearStateId: string }[] };
  expect(output.decision).toBe("not-confirmed");
  expect(output.planHash).toMatch(/^[a-f0-9]{64}$/);
  expect(output.rows).toContainEqual({ slot: "done", linearStateId: "s-done", source: "chosen" });
  expect(await main(["team", "map", "ENG", "--stage", "dispatch=Todo", "--stage", "done=Done", "--yes", "--plan-hash", output.planHash], ctx)).toBe(0);
  expect(requests.at(-1)).toMatchObject({ path: `${base}/save`, body: { team: "ENG", mode: "mapped-existing", gitAutomation: "off", expectedMappingHash: HASH, rows: [{ slot: "dispatch", linearStateId: "s-todo", source: "chosen" }, { slot: "done", linearStateId: "s-done", source: "chosen" }] } });
});

test("map preserves managed configuration and refuses a changed reviewed plan", async () => {
  response = (method, path) => method === "GET" && path === base
    ? [200, { ...workflow, config: { ...config, mode: "adopted-recommended", gitAutomation: "managed" } }]
    : [200, {}];
  expect(await main(["team", "map", "ENG", "--stage", "dispatch=Todo", "--json"], ctx)).toBe(3);
  const reviewed = JSON.parse(ctx.out.at(-1)!) as { planHash: string };
  response = (method, path) => method === "GET" && path === base
    ? [200, { ...workflow, config: { ...config, mode: "adopted-recommended", gitAutomation: "managed" }, rows: [] }]
    : [200, {}];
  expect(await main(["team", "map", "ENG", "--stage", "dispatch=Todo", "--yes", "--plan-hash", reviewed.planHash, "--json"], ctx)).toBe(1);
  expect(requests.some((request) => request.path === `${base}/save`)).toBe(false);
  expect(JSON.parse(ctx.out.at(-1)!)).toMatchObject({ error: "plan-hash-mismatch" });
});

test("map refuses an ambiguous or absent stage before save", async () => {
  response = (method, path) => method === "GET" && path === base ? [200, { ...workflow, rows: [], stages: [...stages, { id: "s-todo-2", name: "Todo", type: "unstarted", position: 4 }] }] : [200, {}];
  expect(await main(["team", "map", "ENG", "--stage", "dispatch=Todo"], ctx)).toBe(1);
  expect(requests).toHaveLength(1);
});

test("map refuses a stale mapping hash without retrying the save", async () => {
  response = (method, path) => method === "GET" && path === base
    ? [200, { ...workflow, rows: [] }]
    : [409, { error: "plan-stale", reason: "Mapping changed" }];
  expect(await main(["team", "map", "ENG", "--stage", "dispatch=Todo", "--json"], ctx)).toBe(3);
  const planHash = (JSON.parse(ctx.out.at(-1)!) as { planHash: string }).planHash;
  expect(await main(["team", "map", "ENG", "--stage", "dispatch=Todo", "--yes", "--plan-hash", planHash, "--json"], ctx)).toBe(1);
  expect(requests.map((r) => r.path)).toEqual([base, base, `${base}/save`]);
  expect(requests[2]?.body?.expectedMappingHash).toBe(HASH);
  expect(JSON.parse(ctx.out.at(-1)!)).toMatchObject({ error: "plan-stale" });
});

test("a committed map with unreadable readiness stays a success and asks for a check", async () => {
  expect(await main(["team", "map", "ENG", "--stage", "dispatch=Todo", "--json"], ctx)).toBe(3);
  const planHash = (JSON.parse(ctx.out.at(-1)!) as { planHash: string }).planHash;
  response = (method, path) => method === "GET" && path === base
    ? [200, workflow]
    : [200, { config, rows: [{ slot: "dispatch", linearStateId: "s-todo" }], stages, stageSource: "linear", readiness: null }];
  expect(await main(["team", "map", "ENG", "--stage", "dispatch=Todo", "--yes", "--plan-hash", planHash], ctx)).toBe(0);
  expect(requests.map((r) => r.path)).toEqual([base, base, `${base}/save`]);
  expect(ctx.out.join("\n")).toContain("change landed, but readiness could not be checked; run team check");
});

test("adopt previews then applies the exact hash, preserving refusal detail", async () => {
  expect(await main(["team", "adopt", "ENG", "--json"], ctx)).toBe(3);
  const planHash = (JSON.parse(ctx.out.at(-1)!) as { planHash: string }).planHash;
  expect(requests).toHaveLength(1);
  expect(await main(["team", "adopt", "ENG", "--yes", "--plan-hash", planHash, "--json"], ctx)).toBe(0);
  expect(requests.at(-1)).toMatchObject({ path: `${base}/adopt`, body: { team: "ENG", mode: "apply", planHash: TOKEN } });
  response = (_method, _path, body) => body?.mode === "apply" ? [409, { error: "plan-stale", reason: "Board changed" }] : [200, { ...adopt, checklist: [] }];
  expect(await main(["team", "adopt", "ENG", "--yes", "--plan-hash", planHash, "--json"], ctx)).toBe(1);
  expect(JSON.parse(ctx.out.at(-1)!)).toMatchObject({ error: "plan-stale" });
});

test("undo previews the exact archive candidates and applies only their hash", async () => {
  response = (_method, path, body) => path === `${base}/adopt-undo` && body?.mode === "preview"
    ? [200, { teamId: "team-eng", mode: "preview", candidates: [{ stateId: "created-plan", name: "Plan" }], undoHash: HASH }]
    : [200, { archived: [{ stateId: "created-plan", name: "Plan" }], kept: [], failed: [], readiness }];
  expect(await main(["team", "adopt", "ENG", "--undo", "--json"], ctx)).toBe(3);
  const undoHash = (JSON.parse(ctx.out.at(-1)!) as { planHash: string }).planHash;
  expect(requests).toHaveLength(1);
  expect(JSON.parse(ctx.out[0]!)).toMatchObject({ preview: { candidates: [{ stateId: "created-plan" }] } });
  expect(await main(["team", "adopt", "ENG", "--undo", "--yes", "--plan-hash", undoHash], ctx)).toBe(0);
  expect(requests.at(-1)).toMatchObject({ path: `${base}/adopt-undo`, body: { team: "ENG", mode: "apply", undoHash: HASH } });
  expect(ctx.out.join("\n")).toContain("created-plan");
});

test("migrate previews, uses hash on chunks, and never retires under move consent", async () => {
  response = (_method, path, body) => path === `${base}/migrate` && body?.step === "preview" ? [200, { preview }] : [200, { teamId: "team-eng", migrationHash: TOKEN, moved: 2, remaining: 0, sources: [], readiness }];
  expect(await main(["team", "migrate", "ENG", "--json"], ctx)).toBe(3);
  const planHash = (JSON.parse(ctx.out.at(-1)!) as { planHash: string }).planHash;
  expect(requests).toHaveLength(1);
  expect(await main(["team", "migrate", "ENG", "--yes", "--plan-hash", planHash, "--json"], ctx)).toBe(0);
  expect(requests.map((r) => r.body?.step)).toEqual(["preview", "preview", "migrate"]);
  expect(requests.at(-1)?.body?.migrationHash).toBe(TOKEN);
});

test("migrate refuses a paused preview before offering move or retirement approval", async () => {
  response = () => [200, { preview: { ...preview, actionsAvailable: false } }];
  expect(await main(["team", "migrate", "ENG", "--json"], ctx)).toBe(1);
  expect(JSON.parse(ctx.out.at(-1)!)).toMatchObject({ status: 409, error: "migration-approval-unavailable" });
  expect(requests.map((request) => request.body?.step)).toEqual(["preview"]);
  expect(await main(["team", "migrate", "ENG", "--retire", "--yes", "--plan-hash", "old", "--json"], ctx)).toBe(1);
  expect(JSON.parse(ctx.out.at(-1)!)).toMatchObject({ status: 409, error: "migration-approval-unavailable" });
  expect(requests.map((request) => request.body?.step)).toEqual(["preview", "preview"]);
});

test("migrate preserves a mid-run approval refusal without retrying", async () => {
  response = (_method, _path, body) => body?.step === "preview"
    ? [200, { preview: { ...preview, actionsAvailable: true } }]
    : [409, { error: "migration-approval-unavailable", reason: "The approved ticket snapshot is unavailable" }];
  expect(await main(["team", "migrate", "ENG", "--json"], ctx)).toBe(3);
  const planHash = (JSON.parse(ctx.out.at(-1)!) as { planHash: string }).planHash;
  expect(await main(["team", "migrate", "ENG", "--yes", "--plan-hash", planHash, "--json"], ctx)).toBe(1);
  expect(JSON.parse(ctx.out.at(-1)!)).toMatchObject({ status: 409, error: "migration-approval-unavailable", reason: "The approved ticket snapshot is unavailable" });
  expect(requests.map((request) => request.body?.step)).toEqual(["preview", "preview", "migrate"]);
});

test("migrate carries choices and the returned hash across chunks, with a separate retire invocation", async () => {
  let chunks = 0;
  response = (_method, path, body) => {
    if (path !== `${base}/migrate`) return [404, { error: "missing" }];
    if (body?.step === "preview") return [200, { preview }];
    if (body?.step === "retire") return [200, { retired: [{ stateId: "old", name: "Old" }], kept: [], failed: [], logGaps: [], readiness }];
    chunks++;
    return [200, { teamId: "team-eng", sources: [source], migrationHash: chunks === 1 ? "2z141z4-3" : TOKEN, moved: 1, remaining: chunks === 1 ? 1 : 0, readiness }];
  };
  expect(await main(["team", "migrate", "ENG", "--choice", "old=new", "--json"], ctx)).toBe(3);
  const planHash = (JSON.parse(ctx.out.at(-1)!) as { planHash: string }).planHash;
  expect(await main(["team", "migrate", "ENG", "--choice", "old=new", "--yes", "--plan-hash", planHash], ctx)).toBe(0);
  expect(requests.map((r) => r.body?.step)).toEqual(["preview", "preview", "migrate", "migrate"]);
  expect(requests[2]?.body).toMatchObject({ migrationHash: TOKEN, choices: [{ sourceStateId: "old", destinationStateId: "new" }] });
  expect(requests[3]?.body?.migrationHash).toBe("2z141z4-3");
  expect(await main(["team", "migrate", "ENG", "--retire", "--json"], ctx)).toBe(3);
  const retireHash = (JSON.parse(ctx.out.at(-1)!) as { planHash: string }).planHash;
  expect(requests.at(-1)?.body?.step).toBe("preview");
  expect(await main(["team", "migrate", "ENG", "--retire", "--yes", "--plan-hash", retireHash], ctx)).toBe(0);
  expect(requests.at(-1)?.body).toMatchObject({ step: "retire", migrationHash: TOKEN });
});

test("migrate stops on a stale hash and does not silently re-preview", async () => {
  response = (_method, _path, body) => body?.step === "preview"
    ? [200, { preview }]
    : [409, { error: "plan-stale", reason: "Board changed" }];
  expect(await main(["team", "migrate", "ENG", "--json"], ctx)).toBe(3);
  const planHash = (JSON.parse(ctx.out.at(-1)!) as { planHash: string }).planHash;
  expect(await main(["team", "migrate", "ENG", "--yes", "--plan-hash", planHash, "--json"], ctx)).toBe(1);
  expect(requests.map((r) => r.body?.step)).toEqual(["preview", "preview", "migrate"]);
  expect(JSON.parse(ctx.out.at(-1)!)).toMatchObject({ error: "plan-stale" });
});

test("migrate reports a refused source as partial even when remaining reaches zero", async () => {
  response = (_method, path, body) => path === `${base}/migrate` && body?.step === "preview"
    ? [200, { preview }]
    : [200, { teamId: "team-eng", migrationHash: TOKEN, moved: 1, remaining: 0, sources: [{ ...source, outcome: "partially-moved", reason: "one issue refused" }], readiness }];
  expect(await main(["team", "migrate", "ENG", "--json"], ctx)).toBe(3);
  const hash = (JSON.parse(ctx.out.at(-1)!) as { planHash: string }).planHash;
  expect(await main(["team", "migrate", "ENG", "--yes", "--plan-hash", hash, "--json"], ctx)).toBe(1);
  expect(JSON.parse(ctx.out.at(-1)!)).toMatchObject({ decision: "partial", results: [{ remaining: 0, sources: [{ outcome: "partially-moved", reason: "one issue refused" }] }] });
});

test("yes without the reviewed preview hash refuses without mutation", async () => {
  expect(await main(["team", "adopt", "ENG", "--yes", "--json"], ctx)).toBe(1);
  expect(requests.map((request) => request.path)).toEqual([`${base}/adopt`]);
  expect(JSON.parse(ctx.out[0]!)).toMatchObject({ error: "plan-hash-mismatch" });
});

test("SDK named refusals stay named in JSON and human output", async () => {
  response = () => [403, { error: "not-an-admin", message: "An admin seat is required" }];
  expect(await main(["team", "check", "ENG", "--json"], ctx)).toBe(1);
  expect(JSON.parse(ctx.out[0]!)).toMatchObject({ results: [{ error: "not-an-admin", reason: "An admin seat is required", status: 403 }] });
  ctx.out.length = 0;
  response = () => [400, { error: "no-grant", reason: "Connect your own Linear account" }];
  expect(await main(["team", "adopt", "ENG"], ctx)).toBe(1);
  expect(ctx.out.join("\n")).toContain("no-grant — Connect your own Linear account");
});

test("SDK shape failure is a refusal and never applies", async () => {
  response = () => [200, { checklist: [], stageSource: "linear" }];
  expect(await main(["team", "map", "ENG", "--stage", "dispatch=Todo", "--yes", "--json"], ctx)).toBe(1);
  expect(requests).toHaveLength(1);
  expect(JSON.parse(ctx.out[0]!)).toMatchObject({ error: "shape" });
});


test("migration approval cannot authorize retirement or a changed ticket census", async () => {
  let current = preview;
  response = (_method, _path, body) => body?.step === "preview" ? [200, { preview: current }]
    : body?.step === "retire" ? [200, { retired: [{ stateId: "old", name: "Old" }], kept: [], failed: [], logGaps: [], readiness }]
    : [200, { teamId: "team-eng", migrationHash: TOKEN, moved: 20, remaining: 0, sources: [], readiness }];
  expect(await main(["team", "migrate", "ENG", "--json"], ctx)).toBe(3);
  const hash = (JSON.parse(ctx.out.at(-1)!) as { planHash: string }).planHash;
  expect(await main(["team", "migrate", "ENG", "--retire", "--yes", "--plan-hash", hash, "--json"], ctx)).toBe(1);
  expect(JSON.parse(ctx.out.at(-1)!)).toMatchObject({ error: "plan-hash-mismatch" });
  current = { ...preview, issueCount: 20, sources: [{ ...source, ticketCount: 20 }] };
  expect(await main(["team", "migrate", "ENG", "--yes", "--plan-hash", hash, "--json"], ctx)).toBe(1);
  expect(JSON.parse(ctx.out.at(-1)!)).toMatchObject({ error: "plan-hash-mismatch" });
  expect(requests.map((request) => request.body?.step)).toEqual(["preview", "preview", "preview"]);
});

test("adoption approval binds the label scope even when the server stage hash is unchanged", async () => {
  expect(await main(["team", "adopt", "ENG", "--json"], ctx)).toBe(3);
  const hash = (JSON.parse(ctx.out.at(-1)!) as { planHash: string }).planHash;
  response = () => [200, { ...adopt, labels: [{ name: "new-label", outcome: "would-create" }], checklist: [], readiness }];
  expect(await main(["team", "adopt", "ENG", "--yes", "--plan-hash", hash, "--json"], ctx)).toBe(1);
  expect(JSON.parse(ctx.out.at(-1)!)).toMatchObject({ error: "plan-hash-mismatch" });
  expect(requests.map((request) => request.body?.mode)).toEqual(["preview", "preview"]);
});

test("mapping approval cannot transfer to another account with the same workflow", async () => {
  expect(await main(["team", "map", "ENG", "--json"], ctx)).toBe(3);
  const hash = (JSON.parse(ctx.out.at(-1)!) as { planHash: string }).planHash;
  const path = configPathFor(ctx.home);
  const config = JSON.parse(readFileSync(path, "utf8")) as { account: string };
  writeFileSync(path, JSON.stringify({ ...config, account: "another-account" }));
  expect(await main(["team", "map", "ENG", "--yes", "--plan-hash", hash, "--json"], ctx)).toBe(1);
  expect(JSON.parse(ctx.out.at(-1)!)).toMatchObject({ error: "plan-hash-mismatch" });
  expect(requests.map((request) => request.path)).toEqual([base, base]);
});
