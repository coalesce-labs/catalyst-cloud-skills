import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { configPathFor, saveConfig, type Ctx, type CustomerConfig, type MeIdentity } from "../src/config.js";
import { onboardFirstTicketAdapter } from "../src/onboard-first-ticket-http.js";
import { firstTicketIntent, type FirstTicketReceipt } from "../src/onboard-first-ticket.js";
import type { OnboardJournal, OnboardStepResult } from "../src/onboard.js";
import { loadHttpSdk, resetSdkCache } from "../src/sdk.js";

const origin = "https://first-ticket-fixture.invalid";
const base = 1_700_000_000_000, now = base + 3_000;
const key = "first-ticket-fixture-key";
const bearer = "ctc_user_private_http_fixture";
const paths = {
  contract: "/api/v1/agent/contract", me: "/api/v1/me", defaults: "/api/v1/me/team-repository",
  workflow: "/api/v1/agent/team-workflow", readiness: "/api/v1/agent/tenant/readiness",
  capacity: "/api/v1/me/runner-capacity", feed: "/api/v1/coordination/changes",
  create: "/api/v1/agent/issue-create", request: "/api/v1/agent/work/request",
  execution: "/api/v1/issues/CTC-41/execution", issue: "/api/v1/issues/CTC-41", fleet: "/api/v1/fleet-activity/current",
};
const readinessIds = ["oauth_scope", "token_live", "team_visible", "mapped_states_exist", "mapping_total", "types_compatible", "labels_present", "writes_land", "webhook_covers_team", "hosts_current", "environment_declared", "tools_resolvable", "required_values", "reviewer_required", "reviewer_configured", "reviewer_answering", "linear_automation_pr_open", "linear_automation_pr_review", "linear_automation_pr_ready", "linear_automation_pr_merge", "merge_queue_configured", "coding_account_enrolled", "github_app_installed", "thoughts_reachable"];
function contract() {
  return { contractVersion: "1.0.0", account: { id: "account-1" },
    onboarding: { schema: 1, routes: [paths.defaults, paths.capacity].map(path => ({ method: "GET", path, personalBearer: true })) },
    routes: [paths.workflow, paths.readiness].map(path => ({ method: "GET", path }))
      .concat([paths.create, paths.request].map(path => ({ method: "POST", path }))),
    feeds: [{ method: "GET", path: paths.feed }],
    reads: ["/api/v1/issues/{identifier}", "/api/v1/issues/{identifier}/execution", paths.fleet].map(path => ({ method: "GET", path })) };
}
function workflow() {
  const slots = ["dispatch", "intake", "pr", "done", "canceled"];
  const types = ["unstarted", "backlog", "started", "completed", "canceled"];
  return { config: { teamId: "team-1", mode: "mapped-existing", gitAutomation: "off", workflowRev: 7 },
    rows: slots.map((slot, i) => ({ slot, linearStateId: "state-" + i, stateStillExists: true, source: "chosen" })),
    stages: slots.map((name, i) => ({ id: "state-" + i, name, type: types[i], position: i })),
    stageSource: "mirror", mappingHash: "a".repeat(64),
    readiness: { teamId: "team-1", teamKey: "CTC", workflowRev: 9, checkedAt: now,
      status: "ready", checks: readinessIds.map(id => ({ id, state: "pass" })) } };
}
function ready() { return { readiness: { teamId: "team-1", teamKey: "CTC", workflowRev: 9,
  checkedAt: now, status: "ready", checks: readinessIds.map(id => ({ id, state: "pass" })) } }; }
function defaults() { return { status: "ok", account: "account-1", personId: "person-1", teamId: "team-1", teamKey: "CTC",
  repository: { repoId: "repo-sdk", owner: "Acme", name: "SDK", fullName: "Acme/SDK", status: "active", rule: "team_default" }, observedAtMs: now }; }
function capacity() { return { status: "ok", scope: "mapped-team-defaults", observedAtMs: now,
  buckets: [{ repoId: "repo-sdk", effectiveLimit: 2, occupiedUnits: 0,
    teams: [{ teamKey: "CTC", defaultLimit: 2, configuredLimit: null, paused: false, admissionEnabled: true,
      effectiveTeamLimit: 2, source: "default", remainingUnits: 2 }] }] }; }
function receipt(stage: FirstTicketReceipt["stage"] = "requested"): FirstTicketReceipt {
  const intent = firstTicketIntent({ account: "account-1", person: "person-1", origin, teamId: "team-1", teamKey: "CTC",
    repoId: "repo-sdk", repoName: "Acme/SDK", dispatchStateId: "state-0", starter: "contributing-tests" }, key);
  if (!intent) throw new Error("positive HTTP intent fixture refused");
  return { schema: 1, intent: { ...intent }, stage,
    ticket: stage === "creating" ? null : { id: "cf113ae0-85c0-5d0a-baea-b1dbcb6d94d4", identifier: "CTC-41", url: null },
    baseline: stage === "requested" || stage === "requesting" ? { cursor: 10, at: base } : null,
    requestId: stage === "requested" ? 17 : null };
}
function events() { return [
  { seq: 11, host: null, event_id: "work-request-CTC-41-intake-17", event_name: "work.request.accepted", ts: new Date(base).toISOString(), caused_by: null,
    attributes: { ticket: "CTC-41", phase: "intake", requestId: 17, disposition: "queued" }, resource: {} },
  { seq: 12, host: "node-a", event_id: "phase-dispatch-launched.CTC-41.intake.7", event_name: "phase.dispatch.launched", ts: new Date(base + 1_000).toISOString(), caused_by: "lease:CTC-41/intake#7",
    attributes: { ticket: "CTC-41", phase: "intake", nonce: 7, repository_id: "repo-sdk", repository_name: "acme/sdk", repository_rule: "team_default" }, resource: {} },
  { seq: 13, host: "node-a", event_id: "phase-outcome.fixture.CTC-41.intake.7", event_name: "phase.intake.complete", ts: new Date(base + 2_000).toISOString(), caused_by: "lease:CTC-41/intake#7",
    attributes: { ticket: "CTC-41", nonce: 7 }, resource: {} },
]; }
function execution() { return { ticket: "CTC-41", attemptHistory: "latest-per-phase", observedAtMs: now, unreadable: [],
  phases: [{ phase: "intake", attempt: 3, status: "ready", startedAtMs: base + 1_000,
    attempts: [{ generation: 7, startedAtMs: base + 1_000, imageSha: "fixture-image", ranOn: null }] }],
  lease: [{ phase: "intake", generation: 7, holder: "node-a", deadlineMs: now + 60_000 }] }; }
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const homes: string[] = [], stops: AbortController[] = [], joins: Promise<unknown>[] = [];
const releases: Array<() => void> = [], disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop.abort();
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(joins.splice(0));
  for (const dispose of disposals.splice(0)) await dispose();
  resetSdkCache();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
type Intercept = (url: URL, init: RequestInit | undefined) => Promise<Response | undefined>;
function fixture(saved = false) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "first-ticket-http-")); homes.push(home);
  const me: MeIdentity = { account: "account-1", slug: "fixture", name: "Fixture", principal: "service", permissions: ["mirror:read", "mirror:feed"],
    user: { id: "person-1", role: "owner", label: "Fixture", email: null, linearUserId: null } };
  const cfg: CustomerConfig = { ...me, baseUrl: origin, key: bearer, joinedAt: new Date(now).toISOString(), lastSkillBundleVersion: "fixture" };
  saveConfig(home, cfg);
  const journal: OnboardJournal = { schema: 1, runId: "fixture", installer: null, cli: "0.14.6", tenant: me.account, account: me.account,
    membershipId: "person-1", baseUrl: origin, operations: { "first-ticket": key }, exit: null, changes: [],
    steps: [{ id: "linear.team", state: "done", evidence: { team: "team-1" } },
      { id: "github.repos", state: "done", evidence: { repository: JSON.stringify([{ teamId: "team-1", owner: "Acme", name: "SDK", repoId: "repo-sdk" }]) } },
      { id: "first-ticket", state: "pending", ...(saved ? { evidence: { firstTicket: JSON.stringify(receipt()) } } : {}) }] };
  const stop = new AbortController(); stops.push(stop);
  const calls: Array<{ url: URL; init: RequestInit | undefined; method: string }> = [];
  const state: { now: number; intercept?: Intercept; advertised: ReturnType<typeof contract> } = { now, advertised: contract() };
  async function reply(url: URL): Promise<Response> {
    if (url.pathname === paths.contract) return Response.json(state.advertised);
    if (url.pathname === paths.me) return Response.json(me);
    if (url.pathname === paths.defaults) return Response.json(defaults());
    if (url.pathname === paths.workflow) return Response.json(workflow());
    if (url.pathname === paths.readiness) return Response.json(ready());
    if (url.pathname === paths.capacity) return Response.json(capacity());
    if (url.pathname === paths.feed) return new Response(events().map(row => JSON.stringify(row)).join("\n") + "\n", {
      headers: { "content-type": "application/x-ndjson", "x-catalyst-coordination-head-seq": "13", "x-catalyst-server-time-ms": String(now) } });
    if (url.pathname === paths.execution) return Response.json(execution());
    if (url.pathname === paths.issue) return Response.json({ id: receipt().ticket!.id, identifier: "CTC-41", team_id: "team-1", comments: [{
      // Independent fixed fanout vector, not computed with the adapter's corroboration helper.
      id: "906398ac-4667-499d-83a5-df0d634ee949", body: "**Phase complete**\n\n**Phase**: `intake`", created_at: base + 2_500 }] });
    if (url.pathname === paths.fleet) return Response.json([{ ticket: "CTC-41", host_id: "node-a", phase: "intake", last_event_ts: base + 2_000, started_at: base + 1_000 }]);
    if (url.pathname === paths.create) return Response.json({ outcome: "succeeded", attempts: 1, id: receipt().ticket!.id, identifier: "CTC-41", url: null });
    if (url.pathname === paths.request) return Response.json({ status: "queued", ticket: "CTC-41", phase: "intake", instruction: "none", disposition: "queued", priorArtifacts: [], requestId: 17 });
    throw new Error("unexpected first-ticket fixture path");
  }
  const ctx: Ctx = { home, env: { CATALYST_CLOUD_TOKEN: "ambient-not-used" }, now: () => new Date(state.now), stdout: () => {}, stderr: () => {},
    fetch: async (input, init) => { const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ url, init, method: init?.method ?? (input instanceof Request ? input.method : "GET") });
      return await state.intercept?.(url, init) ?? reply(url); } };
  const checkpoints: FirstTicketReceipt[] = [];
  const checkpoint = (text: string) => { const value: FirstTicketReceipt = JSON.parse(text); checkpoints.push(value);
    journal.steps.find(step => step.id === "first-ticket")!.evidence = { firstTicket: text }; };
  const track = (task: Promise<OnboardStepResult>) => { joins.push(task); void task.catch(() => {}); return task; };
  const check = () => track(onboardFirstTicketAdapter().check(ctx, journal, stop.signal));
  return { home, cfg, me, journal, ctx, state, stop, calls, checkpoints, checkpoint, check, track, reply };
}
function configBytes(f: ReturnType<typeof fixture>) { return readFileSync(configPathFor(f.home)); }
async function drainMicrotasks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }


function requireInstalled0131() {
  const require = createRequire(import.meta.url), entry = require.resolve("@catalyst-cloud/sdk");
  const metadata: unknown = JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"));
  expect(metadata).toMatchObject({ name: "@catalyst-cloud/sdk", version: "0.13.1" });
}
const barriers = ["capacity", "me", "default"] as const;
type Barrier = typeof barriers[number];
function hold(f: ReturnType<typeof fixture>, barrier: Barrier, afterRelease: () => void, adjustWorkflow?: (value: ReturnType<typeof workflow>, count: number) => void) {
  const entered = deferred<void>(), release = deferred<void>();
  let meCount = 0, defaultCount = 0, workflowCount = 0, stopped = false;
  releases.push(() => release.resolve());
  f.state.intercept = async url => {
    if (url.pathname === paths.me) meCount++;
    if (url.pathname === paths.defaults) defaultCount++;
    if (!stopped && (barrier === "capacity" && url.pathname === paths.capacity ||
      barrier === "me" && url.pathname === paths.me && meCount === 2 ||
      barrier === "default" && url.pathname === paths.defaults && defaultCount === 2)) {
      stopped = true; entered.resolve(); await release.promise; afterRelease();
    }
    if (url.pathname === paths.workflow) {
      workflowCount++; const value = workflow(); adjustWorkflow?.(value, workflowCount); return Response.json(value);
    }
    return undefined;
  };
  return { entered: entered.promise, release: () => release.resolve() };
}

describe("actual SDK first-ticket independent workflow revisions", () => {
  it("accepts stable team mapping7/account readiness9 with the genuine installed HTTP SDK", async () => {
    requireInstalled0131(); resetSdkCache(); expect(typeof (await loadHttpSdk()).createTenantClient).toBe("function");
    const f = fixture(), before = configBytes(f);
    expect(workflow().config.workflowRev).toBe(7); expect(ready().readiness.workflowRev).toBe(9);
    expect(await f.check()).toEqual({ state: "pending" });
    expect(f.calls.filter(call => call.url.pathname === paths.workflow)).toHaveLength(2);
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
    expect(f.checkpoints).toHaveLength(0); expect(configBytes(f)).toEqual(before);
  });
  it("corroborates a saved request without conflating the revision counters or replaying writes", async () => {
    requireInstalled0131(); const f = fixture(true), before = configBytes(f);
    expect(await f.check()).toMatchObject({ state: "done", evidence: { ticket: "CTC-41", phaseStarted: true, linearComment: true, fleetActivity: true } });
    expect(f.calls.filter(call => call.url.pathname === paths.workflow).length).toBeGreaterThanOrEqual(4);
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
    expect(f.checkpoints).toHaveLength(0); expect(configBytes(f)).toEqual(before);
  });
  it.each(barriers)("an unchanged tuple after held %s permits the explicit Q5 refusal without a write", async barrier => {
    requireInstalled0131(); const f = fixture(), before = configBytes(f); let approvals = 0;
    const gate = hold(f, barrier, () => {});
    const adapter = onboardFirstTicketAdapter({ approve: async () => { approvals++; return false; } });
    let settled = false; const task = f.track(adapter.act!(f.ctx, f.journal, f.stop.signal, f.checkpoint)); void task.then(() => { settled = true; });
    await gate.entered; await drainMicrotasks(); expect(settled).toBe(false); expect(approvals).toBe(0);
    gate.release(); expect(await task).toMatchObject({ state: "skipped", reason: "first_ticket_not_selected" });
    expect(approvals).toBe(1); expect(f.calls.some(call => call.method === "POST")).toBe(false);
    expect(f.checkpoints).toHaveLength(0); expect(configBytes(f)).toEqual(before);
  });
  it.each(barriers.flatMap(barrier => ["hash", "mapping", "readiness"].map(field => ({ barrier, field }))))("$field tuple change during held $barrier refuses before Q5 or POST", async ({ barrier, field }) => {
    requireInstalled0131(); const f = fixture(), before = configBytes(f); let changed = false, approvals = 0;
    const gate = hold(f, barrier, () => { changed = true; }, value => {
      if (!changed) return;
      if (field === "hash") value.mappingHash = "b".repeat(64);
      if (field === "mapping") value.config.workflowRev = 8;
      if (field === "readiness") value.readiness.workflowRev = 10;
    });
    const adapter = onboardFirstTicketAdapter({ approve: async () => { approvals++; return false; } });
    const task = f.track(adapter.act!(f.ctx, f.journal, f.stop.signal, f.checkpoint));
    await gate.entered; expect(approvals).toBe(0); gate.release();
    expect(await task).toMatchObject({ state: "waiting", reason: "first_ticket_readiness_unverified" });
    expect(approvals).toBe(0); expect(f.calls.some(call => call.method === "POST")).toBe(false);
    expect(f.checkpoints).toHaveLength(0); expect(configBytes(f)).toEqual(before);
  });
});

describe("original constituent ages after final workflow IO", () => {
  it.each(["capacity", "readiness", "workflow"] as const)("does not mint fresh authority over aged original %s proof", async kind => {
    requireInstalled0131(); const f = fixture(), before = configBytes(f), entered = deferred<void>(), release = deferred<void>();
    let workflowCount = 0, approvals = 0; releases.push(() => release.resolve());
    f.state.intercept = async url => {
      if (url.pathname === paths.capacity && kind === "capacity") return Response.json({ ...capacity(), observedAtMs: now - 29_000 });
      if (url.pathname === paths.readiness && kind === "readiness") return Response.json({ readiness: { ...ready().readiness, checkedAt: now - 299_000 } });
      if (url.pathname === paths.workflow) {
        workflowCount++; const value = workflow();
        if (workflowCount === 1 && kind === "workflow") value.readiness.checkedAt = now - 299_000;
        if (workflowCount === 2) { entered.resolve(); await release.promise; f.state.now = now + 1_000; value.readiness.checkedAt = f.state.now; }
        return Response.json(value);
      }
      return undefined;
    };
    const adapter = onboardFirstTicketAdapter({ approve: async () => { approvals++; return false; } });
    let settled = false; const task = f.track(adapter.act!(f.ctx, f.journal, f.stop.signal, f.checkpoint)); void task.then(() => { settled = true; });
    await entered.promise; await drainMicrotasks(); expect(settled).toBe(false); expect(approvals).toBe(0);
    release.resolve(); expect(await task).toMatchObject({ state: "waiting", reason: "first_ticket_readiness_unverified" });
    expect(approvals).toBe(0); expect(f.calls.some(call => call.method === "POST")).toBe(false);
    expect(f.checkpoints).toHaveLength(0); expect(configBytes(f)).toEqual(before);
  });
});
