import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { defaultCtx, writeConfig } from "../src/config.js";
import { cmdOnboard, ONBOARD_STEPS, onboardStatePath, type OnboardJournal, type OnboardAdapter } from "../src/onboard.js";
import { readReturningProjects, returningWorkspaceAdapters, type ReturningChoice } from "../src/onboard-returning.js";
import { onboardJsonView, setupFinalScreen } from "../src/setup-onboard-copy.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "returning-workspace-")); homes.push(home);
  const identity = { account: "account-a", membershipId: "person-a", baseUrl: "https://fixture.invalid", role: "owner" as const };
  const now = Date.parse("2026-10-08T12:00:00Z");
  writeConfig(home, { account: identity.account, baseUrl: identity.baseUrl, key: "ctc_user_fixture",
    principal: "session", slug: "a", name: "Workspace A", permissions: null, joinedAt: new Date(now).toISOString(), lastSkillBundleVersion: "0.16.0",
    user: { id: identity.membershipId, role: "owner", label: "Person", email: null, linearUserId: null } });
  const ctx = { ...defaultCtx(), home, env: {}, now: () => new Date(now), stdout: () => {}, stderr: () => {} };
  const projects = [
    { id: "team-cloud", key: "CTC", name: "Catalyst Cloud", repositories: { registered: ["org/cloud", "org/cli"] } },
    { id: "team-sdk", key: "SDK", name: "SDK", repositories: { registered: ["org/sdk"] } },
    { id: "team-unconfigured", key: "OTHER", name: "Other", repositories: { registered: [] } },
  ];
  let contract: unknown = { account: { id: identity.account }, teams: projects, routes: [{ method: "GET", path: "/api/v1/agent/tenant/repositories" }] };
  let rows = projects.slice(0, 2).flatMap(p => p.repositories.registered.map((name, i) => ({ id: `${p.id}-${i}`, name: p.name, linearTeamId: p.id, linearTeamKey: p.key, status: "active", githubRepoOwner: name.split("/")[0], githubRepoName: name.split("/")[1] })));
  let failInventory = false, failReadiness = false;
  const requests: string[] = [];
  ctx.fetch = (async (input, init) => {
    const url = new URL(String(input)); requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (init?.method && init.method !== "GET") throw new Error("unexpected project write");
    if (url.pathname === "/api/v1/agent/teams") return Response.json({ teams: projects.map(p => ({ teamId: p.id, teamKey: p.key, teamName: p.name })) });
    if (url.pathname === "/api/v1/agent/contract") return Response.json(contract, { status: failInventory ? 503 : 200 });
    if (url.pathname === "/api/v1/agent/tenant/repositories") return Response.json({ canManage: true, repositories: rows });
    if (url.pathname === "/api/v1/agent/tenant/readiness") {
      const sdk = url.searchParams.get("team") === "team-sdk";
      return Response.json({ readiness: { teamId: url.searchParams.get("team"), status: sdk ? "blocked" : "ready", checkedAt: now, workflowRev: 1,
        checks: [{ id: "merge_queue_configured", state: sdk ? "fail" : "pass" }] } }, { status: failReadiness ? 503 : 200 });
    }
    throw new Error("unexpected read");
  }) as typeof fetch;
  const journal: OnboardJournal = { schema: 1, runId: "returning", installer: null, cli: "0.16.0", tenant: identity.account,
    ...identity, exit: null, steps: [], changes: [] };
  return { ctx, journal, identity, requests, empty: () => { rows = []; },
    omitMappedTeams: () => { (contract as { teams: unknown[] }).teams = []; },
    archiveSdk: () => { rows = rows.map(row => row.linearTeamId === "team-sdk" ? { ...row, status: "archived" } : row); },
    breakInventory: () => { failInventory = true; }, breakReadiness: () => { failReadiness = true; } };
}

test("counts each configured project once across repositories and names its actual unfinished check", async () => {
  const f = fixture();
  const read = await readReturningProjects(f.ctx, f.journal);
  expect(read).toMatchObject({ projects: [{ id: "team-cloud", status: "Ready" }, { id: "team-sdk" }] });
  if ("reason" in read) throw new Error(read.reason);
  expect(read.projects).toHaveLength(2);
  expect(read.projects[1]!.status).toContain("merge queue");
  expect(read.projects[1]!.status).not.toContain("merge_queue_configured");
});

test("a known empty contract and an unreadable inventory are distinct", async () => {
  const f = fixture(); f.empty();
  expect(await readReturningProjects(f.ctx, f.journal)).toEqual({ projects: [] });
  f.breakInventory();
  expect(await readReturningProjects(f.ctx, f.journal)).toEqual({ reason: "returning_inventory_unverified" });
});

test("a failed readiness read keeps the known project count with unknown statuses", async () => {
  const f = fixture(); f.breakReadiness();
  const read = await readReturningProjects(f.ctx, f.journal);
  expect(read).toMatchObject({ projects: [{ status: expect.stringContaining("could not be checked") }, { status: expect.stringContaining("could not be checked") }] });
});

test("moving on records the project skip, runs machine steps, and never claims the workspace is ready", async () => {
  const f = fixture(), args = parseArgs(["onboard", "--yes"]);
  const executed: string[] = [], messages: string[] = [];
  const adapters = Object.fromEntries(ONBOARD_STEPS.map(id => [id, { check: async () => { executed.push(id); return { state: "done" as const }; } }]));
  returningWorkspaceAdapters(adapters, args, undefined, text => messages.push(text), () => { throw new Error("new project not requested"); });
  expect(await cmdOnboard(args, f.ctx, { adapters, identity: async () => f.identity, bindSignals: false })).toBe(0);
  expect(executed).toEqual(["machine", "cli", "skills", "legacy", "signin", "daemon", "housekeeping", "accounts", "runner"]);
  const receipt = JSON.parse(readFileSync(onboardStatePath(f.ctx.home, f.ctx.env), "utf8")) as OnboardJournal;
  expect(receipt.steps.find(s => s.id === "projects")).toMatchObject({ state: "skipped", reason: "returning_workspace_move_on", evidence: { projectCount: 2 } });
  expect(messages[0]).toBe("This workspace already has 2 Catalyst projects.");
  expect(setupFinalScreen(receipt).heading).toBe("This computer is set up");
  expect(onboardJsonView(receipt).verdict).toBe("machine-complete");
  expect(args.flags.team).toBeUndefined();
  expect(f.requests.every(r => r.startsWith("GET "))).toBe(true);
});

test.each(["new", { repair: "team-sdk" }] as ReturningChoice[])("an explicit project choice carries only the selected context: %j", async choice => {
  const f = fixture(), args = parseArgs(["onboard"]), create = vi.fn(), act = vi.fn(async () => ({ state: "pending" as const }));
  const adapters: Record<"linear.workspace" | "projects", OnboardAdapter> = { "linear.workspace": { check: act }, projects: { check: act } };
  returningWorkspaceAdapters(adapters, args, async () => choice, () => {}, create);
  await adapters["linear.workspace"].check(f.ctx, f.journal);
  expect(act).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledTimes(choice === "new" ? 1 : 0);
  expect(args.flags.team).toBe(choice === "new" ? undefined : "team-sdk");
});

test("unknown inventory blocks project actions instead of treating the workspace as new", async () => {
  const f = fixture(); f.breakInventory();
  const act = vi.fn(async () => ({ state: "pending" as const }));
  const adapters: Record<"linear.workspace" | "projects", OnboardAdapter> = { "linear.workspace": { check: act, act }, projects: { check: act, act } };
  returningWorkspaceAdapters(adapters, parseArgs(["onboard"]), undefined, () => {}, () => {});
  expect(await adapters["linear.workspace"].check(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "returning_inventory_unverified" });
  expect(await adapters.projects.act!(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "returning_inventory_unverified" });
  expect(act).not.toHaveBeenCalled();
});

 test("the complete project read includes projects omitted from mapped-team contract context", async () => {
   const f = fixture(); f.omitMappedTeams();
   expect(await readReturningProjects(f.ctx, f.journal)).toMatchObject({ projects: [{ id: "team-cloud" }, { id: "team-sdk" }] });
 });
 test("archived repository rows do not count as current projects", async () => {
   const f = fixture(); f.archiveSdk();
   const read = await readReturningProjects(f.ctx, f.journal);
   if ("reason" in read) throw new Error(read.reason);
   expect(read.projects.map(p => p.id)).toEqual(["team-cloud"]);
 });
