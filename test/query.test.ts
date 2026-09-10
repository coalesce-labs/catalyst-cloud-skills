// query.test.ts — a fresh replica is chosen and the stderr line says so; a stale one falls back to
// the API and says so; --source forces each; `issue` has the same keys from both sources; `changes`
// hits /api/v1/changes?since=.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { applyFilters, rowsOf, summaryLine } from "../src/query";
import { fixtureIssues, startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, seedReplica, tempHome, type TestCtx } from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

const REPLICA_ISSUES = [
  { id: "lin-eng-1", identifier: "ENG-1", title: "Title of ENG-1", state: "Todo", team_id: "team-eng", project_id: "proj-a", priority: 2 },
  { id: "lin-eng-2", identifier: "ENG-2", title: "Title of ENG-2", state: "In Progress", team_id: "team-eng", project_id: "proj-a", priority: 1 },
  { id: "lin-ops-1", identifier: "OPS-1", title: "Title of OPS-1", state: "Todo", team_id: "team-ops", project_id: "proj-b" },
];

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  home = tempHome();
  ctx = makeCtx(home);
  server.requests.length = 0;
});

describe("source selection", () => {
  test("a fresh replica is used and the stderr line names the cursor", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0, issues: REPLICA_ISSUES });
    expect(await main(["query", "issues", "--json"], ctx)).toBe(0);
    expect(ctx.err[0]).toBe("source: replica (cursor 41)");
    const rows = JSON.parse(ctx.out.join("\n")) as { identifier: string }[];
    expect(rows.map((r) => r.identifier).sort()).toEqual(["ENG-1", "ENG-2", "OPS-1"]);
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/issues"))).toHaveLength(0);
  });
  test("a stale replica falls back to the API and says so", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 60_000, issues: REPLICA_ISSUES });
    expect(await main(["query", "issues", "--json"], ctx)).toBe(0);
    expect(ctx.err[0]).toBe("source: api (replica stale)");
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/issues"))).toHaveLength(1);
  });
  test("an absent replica says absent; no config is exit 2", async () => {
    await seedJoined(home, server);
    expect(await main(["query", "issues"], ctx)).toBe(0);
    expect(ctx.err[0]).toBe("source: api (replica absent)");
    expect(ctx.out.length).toBeGreaterThan(0);
    expect(ctx.out[0]).toMatch(/^ENG-1  Todo  Title of ENG-1/);
    const c2 = makeCtx(tempHome());
    expect(await main(["query", "issues"], c2)).toBe(2);
    expect(c2.err.join("\n")).toContain("not connected");
  });
  test("--source forces each; forcing the replica when absent is a usage error", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 60_000, issues: REPLICA_ISSUES });
    expect(await main(["query", "issues", "--source", "replica", "--json"], ctx)).toBe(0);
    expect(ctx.err[0]).toBe("source: replica (--source replica)");
    const c2 = makeCtx(home);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0, dbPath: `${home}/.config/catalyst-cloud/replica.db` }).catch(() => {});
    expect(await main(["query", "issues", "--source", "api", "--json"], c2)).toBe(0);
    expect(c2.err[0]).toBe("source: api (--source api)");
    const c3 = makeCtx(home);
    expect(await main(["query", "issues", "--source", "wat"], c3)).toBe(1);
  });
  test("api-only subcommands name why", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0, issues: REPLICA_ISSUES });
    expect(await main(["query", "cycles", "--json"], ctx)).toBe(0);
    expect(ctx.err[0]).toBe("source: api (cycles is api-only)");
  });
});

describe("subcommands", () => {
  test("issue <id> has the same keys from both sources", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0, issues: REPLICA_ISSUES });
    expect(await main(["query", "issue", "ENG-1", "--source", "replica", "--json"], ctx)).toBe(0);
    const fromReplica = JSON.parse(ctx.out.join("\n")) as Record<string, unknown>;
    const c2 = makeCtx(home);
    expect(await main(["query", "issue", "ENG-1", "--source", "api", "--json"], c2)).toBe(0);
    const fromApi = JSON.parse(c2.out.join("\n")) as Record<string, unknown>;
    for (const key of Object.keys(fromReplica)) expect(fromApi, `api detail must carry ${key}`).toHaveProperty(key);
    expect(fromReplica.identifier).toBe("ENG-1");
    expect(fromApi.identifier).toBe("ENG-1");
    expect(Array.isArray(fromReplica.comments)).toBe(true);
    expect(Array.isArray(fromApi.comments)).toBe(true);
  });
  test("an unknown issue is exit 1 from either source", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0, issues: REPLICA_ISSUES });
    expect(await main(["query", "issue", "ENG-999", "--source", "replica"], ctx)).toBe(1);
    expect(await main(["query", "issue", "ENG-999", "--source", "api"], makeCtx(home))).toBe(1);
  });
  test("filters: --team and --project on the replica", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0, issues: REPLICA_ISSUES });
    expect(await main(["query", "issues", "--team", "OPS", "--json"], ctx)).toBe(0);
    expect((JSON.parse(ctx.out.join("\n")) as { identifier: string }[]).map((r) => r.identifier)).toEqual(["OPS-1"]);
    const c2 = makeCtx(home);
    expect(await main(["query", "issues", "--project", "proj-a", "--json"], c2)).toBe(0);
    expect((JSON.parse(c2.out.join("\n")) as { identifier: string }[]).length).toBe(2);
  });
  test("pulls, pull, projects, search, cycles from the API", async () => {
    await seedJoined(home, server);
    expect(await main(["query", "pulls", "--ticket", "ENG-2", "--json"], ctx)).toBe(0);
    expect((JSON.parse(ctx.out.join("\n")) as { number: number }[])[0]?.number).toBe(41);
    const c2 = makeCtx(home);
    expect(await main(["query", "pull", "PR_kwDOfixture41", "--json"], c2)).toBe(0);
    expect((JSON.parse(c2.out.join("\n")) as { reviews: unknown[] }).reviews).toHaveLength(1);
    const c3 = makeCtx(home);
    expect(await main(["query", "projects"], c3)).toBe(0);
    expect(c3.out.join("\n")).toContain("Project A");
    const c4 = makeCtx(home);
    expect(await main(["query", "search", "widget"], c4)).toBe(0);
    expect(c4.out.join("\n")).toContain("ENG-7");
    const c5 = makeCtx(home);
    expect(await main(["query", "cycles"], c5)).toBe(0);
    expect(c5.out.join("\n")).toContain("cycle 12");
    const c6 = makeCtx(home);
    expect(await main(["query", "pull", "PR_nope"], c6)).toBe(1);
    const c7 = makeCtx(home);
    expect(await main(["query", "search"], c7)).toBe(1);
  });
  test("changes hits /api/v1/changes?since=", async () => {
    await seedJoined(home, server);
    expect(await main(["query", "changes", "--since", "3", "--json"], ctx)).toBe(0);
    const req = server.requests.find((r) => r.path.startsWith("/api/v1/changes"));
    expect(req?.path).toContain("since=3");
    // ⛔ The 200 is NDJSON (`streamNdjson`), not JSON. Reading it with getJson made every real
    // success "returned a non-JSON body"; asserting only the exit code would not have noticed,
    // because a refusal IS JSON and the smoke never reached a 200. Assert the parsed rows.
    const body = JSON.parse(ctx.out.join("\n")) as { since: number; head: number; changes: Record<string, unknown>[] };
    expect(body.since).toBe(3);
    expect(body.head).toBe(server.headCursor);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({ seq: 4, entity: "issues", entityId: "lin-eng-1", op: "upsert" });
    expect(await main(["query", "changes"], makeCtx(home))).toBe(1);
  });
  // ⛔ THE CHANGEFEED EVICTS, so `--since 0` — the form the docs show — is a 409 resync envelope on
  // any tenant whose log has rotated, and 0.2.0 surfaced it as a bare "GET /api/v1/changes failed
  // (409)" with no way to learn a cursor that works. The head seq is stamped on the 409 itself
  // (`x-catalyst-head-seq`), so the CLI can always say what to use instead.
  test("an evicted --since says so and names a cursor that works", async () => {
    await seedJoined(home, server);
    expect(await main(["query", "changes", "--since", "0", "--json"], ctx)).toBe(1);
    const err = ctx.err.join("\n");
    expect(err).toMatch(/no longer in the change log|evicted/i);
    expect(err).toContain("--since head");
    // The actionable half: the cursor to use, read off the response the refusal itself carried.
    expect(err).toContain(String(server.headCursor));
  });
  test("--since head resolves the live cursor instead of guessing one", async () => {
    await seedJoined(home, server);
    expect(await main(["query", "changes", "--since", "head", "--json"], ctx)).toBe(0);
    const asked = server.requests
      .filter((r) => r.path.startsWith("/api/v1/changes"))
      .map((r) => new URL(r.path, "http://x").searchParams.get("since"));
    // The probe learns the head from the header, then the real read asks for it — never "head".
    expect(asked).toContain(String(server.headCursor));
    expect(asked).not.toContain("head");
    expect((JSON.parse(ctx.out.join("\n")) as { since: number }).since).toBe(server.headCursor);
  });
  test("a cursor past the head is refused with the same actionable line", async () => {
    await seedJoined(home, server);
    expect(await main(["query", "changes", "--since", "99999", "--json"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("--since head");
  });
  test("missing subcommand or positional is a usage error", async () => {
    await seedJoined(home, server);
    expect(await main(["query"], ctx)).toBe(1);
    expect(await main(["query", "issue"], makeCtx(home))).toBe(1);
    expect(await main(["query", "wat"], makeCtx(home))).toBe(1);
  });
});

describe("pure helpers", () => {
  test("rowsOf accepts bare arrays and wrapped rows", () => {
    expect(rowsOf([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(rowsOf({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(rowsOf({ nope: 1 })).toEqual([]);
    expect(rowsOf(null)).toEqual([]);
  });
  test("applyFilters and summaryLine", () => {
    const rows = [{ identifier: "ENG-1", state: "Todo", title: "t", team_id: "team-eng" }, { identifier: "OPS-1", state: "Done", title: "u" }];
    expect(applyFilters(rows, { state: "done" }).map((r) => r.identifier)).toEqual(["OPS-1"]);
    expect(applyFilters(rows, { team: "team-eng" })).toHaveLength(1);
    expect(summaryLine("pulls", { number: 1, state: "open", merged: 1, title: "x", node_id: "n" })).toContain("merged");
    expect(summaryLine("projects", { id: "p", state: "s", name: "n" })).toBe("p  s  n");
    expect(summaryLine("other", { a: 1 })).toBe('{"a":1}');
  });
});

describe("more replica reads", () => {
  test("pulls and projects come from the replica when fresh; --state and --limit filter", async () => {
    await seedJoined(home, server);
    await seedReplica(home, {
      cursor: 41,
      heartbeatAgeMs: 0,
      issues: REPLICA_ISSUES,
      pulls: [{ repo_id: "repo-api", number: 7, node_id: "PR_7", title: "seven", state: "open", linear_issue_identifier: "ENG-1" }],
      projects: [{ id: "proj-a", name: "Project A", state: "started" }, { id: "proj-z", name: "Project Z", state: "completed" }],
    });
    expect(await main(["query", "pulls"], ctx)).toBe(0);
    expect(ctx.err[0]).toMatch(/^source: replica/);
    expect(ctx.out[0]).toContain("#7  open  seven  [PR_7]");
    const c2 = makeCtx(home);
    expect(await main(["query", "projects", "--state", "completed", "--json"], c2)).toBe(0);
    expect((JSON.parse(c2.out.join("\n")) as { id: string }[]).map((p) => p.id)).toEqual(["proj-z"]);
    const c3 = makeCtx(home);
    expect(await main(["query", "issues", "--limit", "1", "--json"], c3)).toBe(0);
    expect(JSON.parse(c3.out.join("\n"))).toHaveLength(1);
    const c4 = makeCtx(home);
    expect(await main(["query", "issues", "--limit", "x"], c4)).toBe(1);
    const c5 = makeCtx(home);
    expect(await main(["query", "issues", "--state", "todo", "--team", "ENG"], c5)).toBe(0);
    expect(c5.out).toHaveLength(1);
  });
  test("api reads honour --team and --project and the issues summary shows an assignee", async () => {
    await seedJoined(home, server);
    server.issues = [...fixtureIssuesWithAssignee()];
    expect(await main(["query", "issues", "--team", "OPS"], ctx)).toBe(0);
    expect(ctx.out).toEqual(["OPS-1  Todo  Title of OPS-1"]);
    const c2 = makeCtx(home);
    expect(await main(["query", "issues", "--project", "proj-a"], c2)).toBe(0);
    expect(c2.out.some((l) => l.includes("(Ana)"))).toBe(true);
    // A caught-up cursor is the head ITSELF, not some number past it: `buildChanges` uses a strict
    // `since > head` for the resync refusal precisely so the steady-state poll stays a 200. This read
    // used 99 and passed only because the fixture answered every cursor 200.
    const c3 = makeCtx(home);
    expect(await main(["query", "changes", "--since", String(server.headCursor), "--json"], c3)).toBe(0);
    expect((JSON.parse(c3.out.join("\n")) as { changes: unknown[] }).changes).toEqual([]);
  });
});

function fixtureIssuesWithAssignee(): Record<string, unknown>[] {
  const rows = fixtureIssues();
  (rows[0] as Record<string, unknown>).assignee_name = "Ana";
  return rows;
}
