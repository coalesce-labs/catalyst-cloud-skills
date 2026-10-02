import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { configPathFor, loadConfig, saveConfig, type Ctx, type CustomerConfig, type MeIdentity } from "../src/config.js";
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
    if (url.pathname === paths.request) return Response.json({ status: "queued", ticket: "CTC-41", phase: "intake", instruction: "Call work/acquire", priorArtifacts: [], disposition: "queued", requestId: 17 });
    throw new Error("unexpected first-ticket fixture path");
  }
  const ctx: Ctx = { home, env: { CATALYST_CLOUD_TOKEN: "ambient-not-used" }, now: () => new Date(state.now), stdout: () => {}, stderr: () => {},
    fetch: async (input, init) => { const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ url, init, method: init?.method ?? (input instanceof Request ? input.method : "GET") });
      return await state.intercept?.(url, init) ?? reply(url); } };
  const checkpoints: FirstTicketReceipt[] = [];
  // Explicit synchronous checkpoint port for HTTP ordering. Actual engine owner/atomic durability is tested separately.
  const checkpoint = (text: string) => { const value: FirstTicketReceipt = JSON.parse(text); checkpoints.push(value);
    journal.steps.find(step => step.id === "first-ticket")!.evidence = { firstTicket: text }; };
  const track = (task: Promise<OnboardStepResult>) => { joins.push(task); void task.catch(() => {}); return task; };
  const check = () => track(onboardFirstTicketAdapter().check(ctx, journal, stop.signal));
  return { home, cfg, me, journal, ctx, state, stop, calls, checkpoints, checkpoint, check, track, reply };
}
function configBytes(f: ReturnType<typeof fixture>) { return readFileSync(configPathFor(f.home)); }
async function drainMicrotasks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

describe("first-ticket actual HTTP SDK transport boundaries", () => {
  it("uses genuine installed SDK0.13.1 and verifies the complete existing receipt through actual HTTP DTOs", async () => {
    const require = createRequire(import.meta.url), entry = require.resolve("@catalyst-cloud/sdk");
    const metadata: unknown = JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"));
    expect(metadata).toMatchObject({ name: "@catalyst-cloud/sdk", version: "0.13.1" });
    resetSdkCache(); expect(typeof (await loadHttpSdk()).createTenantClient).toBe("function");
    const f = fixture(true), before = configBytes(f);
    expect(await f.check()).toMatchObject({ state: "done", evidence: { phaseStarted: true, linearComment: true, fleetActivity: true, ticket: "CTC-41" } });
    expect(f.calls.every(c => c.method === "GET" && c.init?.redirect === "error")).toBe(true);
    expect(f.calls.every(c => c.url.origin === origin && new Headers(c.init?.headers).get("authorization") === `Bearer ${bearer}`)).toBe(true);
    expect(f.calls.filter(c => c.url.pathname === paths.feed).map(c => c.url.search)).toEqual(["?since=10"]);
    expect(configBytes(f)).toEqual(before); expect(f.checkpoints).toHaveLength(0);
  });
  it("fresh no-receipt check is pending, never asks Q5 or sends a POST", async () => {
    const f = fixture(), before = configBytes(f);
    expect(await f.check()).toEqual({ state: "pending" });
    expect(f.calls.map(c => c.url.pathname)).toEqual([paths.contract, paths.me, paths.defaults, paths.workflow, paths.readiness, paths.capacity, paths.me, paths.defaults, paths.workflow]);
    expect(configBytes(f)).toEqual(before); expect(f.checkpoints).toHaveLength(0);
  });
  it.each(["account", "person", "member", "principal", "origin", "expiry"])("initial %s refusal enters zero HTTP and preserves saved config", async kind => {
    const f = fixture();
    if (kind === "account") f.journal.account = "foreign-account";
    if (kind === "person") f.journal.membershipId = "foreign-person";
    if (kind === "origin") f.journal.baseUrl = "https://foreign.invalid";
    if (kind === "member" || kind === "principal" || kind === "expiry") {
      const cfg = loadConfig(f.home)!;
      if (kind === "member") cfg.user!.role = "member";
      if (kind === "principal") cfg.principal = "session";
      if (kind === "expiry") { delete cfg.key; cfg.auth = { kind: "oauth", accessToken: "fixture-oauth", refreshToken: "must-not-refresh", sessionId: "session-1", expiresAt: new Date(now + 30_000).toISOString() }; }
      saveConfig(f.home, cfg);
    }
    const before = configBytes(f);
    expect((await f.check()).state).toBe("waiting"); expect(f.calls).toHaveLength(0); expect(configBytes(f)).toEqual(before);
  });
  it.each([
    { name: "defaults", path: paths.defaults }, { name: "capacity", path: paths.capacity },
    { name: "workflow", path: paths.workflow }, { name: "readiness", path: paths.readiness },
    { name: "create", path: paths.create }, { name: "request", path: paths.request }, { name: "feed", path: paths.feed },
    { name: "execution", path: "/api/v1/issues/{identifier}/execution" }, { name: "issue", path: "/api/v1/issues/{identifier}" }, { name: "fleet", path: paths.fleet },
  ])("missing exact $name capability refuses before default or write HTTP", async ({ path }) => {
    const f = fixture(), c = f.state.advertised;
    c.onboarding.routes = c.onboarding.routes.filter(r => r.path !== path);
    c.routes = c.routes.filter(r => r.path !== path); c.feeds = c.feeds.filter(r => r.path !== path); c.reads = c.reads.filter(r => r.path !== path);
    expect(await f.check()).toMatchObject({ state: "waiting" }); expect(f.calls.map(c => c.url.pathname)).toEqual([paths.contract]);
  });
  it.each(["bytes", "operation", "selection", "remote-role"])("%s change at contract/live boundary prevents later default/read/write HTTP", async kind => {
    const f = fixture();
    f.state.intercept = async url => {
      if (url.pathname === paths.contract && kind !== "remote-role") {
        if (kind === "bytes") writeFileSync(configPathFor(f.home), configBytes(f).toString("utf8") + "\n");
        if (kind === "operation") f.journal.operations = { "first-ticket": "foreign-operation" };
        if (kind === "selection") f.journal.steps.find(s => s.id === "github.repos")!.evidence = { repository: JSON.stringify([{ teamId: "team-1", owner: "Acme", name: "Other", repoId: "other-repo" }]) };
      }
      if (url.pathname === paths.me && kind === "remote-role") return Response.json({ ...f.me, user: { ...f.me.user!, role: "member" } });
      return undefined;
    };
    expect((await f.check()).state).toBe("waiting"); expect(f.calls.some(c => c.url.pathname === paths.defaults)).toBe(false);
  });
  it("pre-aborted check enters no fetch", async () => {
    const f = fixture(); f.stop.abort(new Error("fixture-stop"));
    expect(await f.check()).toMatchObject({ state: "waiting", reason: "interrupted" }); expect(f.calls).toHaveLength(0);
  });
  it("non-cooperative late headers remain owned; late body cancellation must acknowledge before check settles", async () => {
    const f = fixture(), headers = deferred<Response>(), entered = deferred<void>(), cancelled = deferred<void>(), release = deferred<void>();
    let cancelCount = 0, settled = false;
    releases.push(() => { headers.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelCount++; cancelled.resolve(); return release.promise; } }))); release.resolve(); });
    f.state.intercept = async () => { entered.resolve(); return headers.promise; };
    const task = f.check(); void task.then(() => { settled = true; });
    await entered.promise; f.stop.abort(new Error("late-headers-stop")); await drainMicrotasks(); expect(settled).toBe(false);
    headers.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelCount++; cancelled.resolve(); return release.promise; } })));
    await cancelled.promise; await drainMicrotasks(); expect(settled).toBe(false); expect(cancelCount).toBe(1);
    release.resolve(); expect(await task).toMatchObject({ state: "waiting", reason: "interrupted" }); expect(cancelCount).toBe(1); expect(f.calls).toHaveLength(1);
  });
  it("actual held body read abort joins the FIRST upstream cancel promise, not an early second cancel", async () => {
    const f = fixture(), entered = deferred<void>(), cancelled = deferred<void>(), release = deferred<void>();
    let count = 0, settled = false; releases.push(() => release.resolve());
    f.state.intercept = async () => new Response(new ReadableStream<Uint8Array>({ pull() { entered.resolve(); }, cancel() { count++; cancelled.resolve(); return release.promise; } }));
    const task = f.check(); void task.then(() => { settled = true; }); await entered.promise; f.stop.abort(new Error("body-stop"));
    await cancelled.promise; await drainMicrotasks(); expect(settled).toBe(false); expect(count).toBe(1);
    release.resolve(); expect(await task).toMatchObject({ state: "waiting", reason: "interrupted" }); expect(count).toBe(1);
  });
  it("actual original30s deadline aborts a held body but never treats pending cancel as completion", async () => {
    const f = fixture(), cancelled = deferred<void>(), release = deferred<void>(); let settled = false;
    releases.push(() => release.resolve());
    f.state.intercept = async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled.resolve(); return release.promise; } }));
    const started = performance.now(), task = f.check(); void task.then(() => { settled = true; });
    await cancelled.promise; const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(27_000); expect(elapsed).toBeLessThanOrEqual(35_000);
    await drainMicrotasks(); expect(settled).toBe(false); release.resolve();
    expect(await task).toMatchObject({ state: "waiting" }); expect(f.calls).toHaveLength(1);
  }, 40_000);
  it("body-limit refusal cancels actual stream once and waits for owned acknowledgement", async () => {
    const f = fixture(), cancelled = deferred<void>(), release = deferred<void>(); let settled = false, count = 0;
    releases.push(() => release.resolve());
    f.state.intercept = async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2_097_153)); }, cancel() { count++; cancelled.resolve(); return release.promise; } }));
    const task = f.check(); void task.then(() => { settled = true; }); await cancelled.promise; await drainMicrotasks();
    expect(settled).toBe(false); release.resolve(); expect((await task).state).toBe("waiting"); expect(count).toBe(1); expect(f.calls).toHaveLength(1);
  });
  it("actual upstream cancel rejection never produces pending/done or a downstream network request", async () => {
    const f = fixture(), entered = deferred<void>(), failure = new Error("actual-cancel-failure"); let count = 0;
    f.state.intercept = async () => new Response(new ReadableStream<Uint8Array>({ pull() { entered.resolve(); }, cancel() { count++; return Promise.reject(failure); } }));
    const task = f.check(); await entered.promise; f.stop.abort(new Error("fixture-stop"));
    expect(await task).toMatchObject({ state: "waiting" }); expect(count).toBe(1); expect(f.calls).toHaveLength(1); expect(f.checkpoints).toHaveLength(0);
  });
  it("malformed real SDK JSON response is refused before another request", async () => {
    const f = fixture(); f.state.intercept = async () => new Response("{broken", { status: 200 });
    expect((await f.check()).state).toBe("waiting"); expect(f.calls).toHaveLength(1);
  });
  it.each([401, 403, 409, 500])("actual HTTP%s failure does not fallback, expose provider details, or modify config", async status => {
    const f = fixture(), before = configBytes(f);
    f.state.intercept = async () => Response.json({ error: `provider-detail-${bearer}` }, { status });
    const result = await f.check();
    expect(result.state).toBe("waiting"); expect(JSON.stringify(result)).not.toContain(bearer);
    expect(f.calls).toHaveLength(1); expect(configBytes(f)).toEqual(before); expect(f.checkpoints).toHaveLength(0);
  });
  it("final workflow non-mapping readiness failure at unchanged team7/account9 revisions refuses Q5", async () => {
    const f = fixture(); let count = 0;
    f.state.intercept = async url => {
      if (url.pathname !== paths.workflow || ++count !== 2) return undefined;
      const value = workflow();
      return Response.json({ ...value, readiness: { ...value.readiness, status: "blocked",
        checks: value.readiness.checks.map(c => c.id === "coding_account_enrolled" ? { id: c.id, state: "fail", reason: "not_enrolled" } : c) } });
    };
    expect(await f.check()).toMatchObject({ state: "waiting", reason: "first_ticket_readiness_unverified" });
    expect(count).toBe(2); expect(f.calls.every(c => c.method === "GET")).toBe(true); expect(f.checkpoints).toHaveLength(0);
  });
  it("explicit Q5 refusal sends zero POST and leaves config and receipt untouched", async () => {
    const f = fixture(), before = configBytes(f), approvals: string[] = [];
    const adapter = onboardFirstTicketAdapter({ approve: async intent => { approvals.push(intent.hash); return false; } });
    expect(await f.track(adapter.act!(f.ctx, f.journal, f.stop.signal, f.checkpoint))).toMatchObject({ state: "skipped", reason: "first_ticket_not_selected" });
    expect(approvals).toHaveLength(1); expect(f.calls.every(c => c.method === "GET")).toBe(true); expect(f.checkpoints).toHaveLength(0); expect(configBytes(f)).toEqual(before);
  });
  it("config switch during approval refuses before checkpoint and provider POST", async () => {
    const f = fixture();
    const adapter = onboardFirstTicketAdapter({ approve: async () => { const cfg = loadConfig(f.home)!; cfg.user!.id = "foreign-person"; saveConfig(f.home, cfg); return true; } });
    expect((await f.track(adapter.act!(f.ctx, f.journal, f.stop.signal, f.checkpoint))).state).toBe("waiting");
    expect(f.checkpoints).toHaveLength(0); expect(f.calls.every(c => c.method === "GET")).toBe(true);
  });
  it("real SDK sends the exact approved create JSON only after acknowledged creating checkpoint; aborted reply stays ambiguous", async () => {
    const f = fixture(), entered = deferred<void>(), headers = deferred<Response>();
    releases.push(() => headers.resolve(Response.json({ outcome: "succeeded", attempts: 1, id: receipt().ticket!.id, identifier: "CTC-41", url: null })));
    f.state.intercept = async (url, init) => {
      if (url.pathname !== paths.create) return undefined;
      expect(f.checkpoints).toHaveLength(1); expect(f.checkpoints[0]!.stage).toBe("creating");
      expect(init?.method).toBe("POST"); expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(typeof init?.body).toBe("string");
      const body: unknown = JSON.parse(String(init?.body));
      expect(body).toEqual({ teamId: "team-1", stateId: "state-0", title: receipt().intent.title, description: receipt().intent.description, idempotencyId: key });
      entered.resolve(); return headers.promise;
    };
    const task = f.track(onboardFirstTicketAdapter({ approve: async () => true }).act!(f.ctx, f.journal, f.stop.signal, f.checkpoint));
    await entered.promise; f.stop.abort(new Error("after-create-entered"));
    headers.resolve(Response.json({ outcome: "succeeded", attempts: 1, id: receipt().ticket!.id, identifier: "CTC-41", url: null }));
    expect((await task).state).toBe("waiting"); expect(f.checkpoints.map(c => c.stage)).toEqual(["creating"]);
    expect(f.calls.filter(c => c.method === "POST").map(c => c.url.pathname)).toEqual([paths.create]);
  });
  it("native loopback HTTP carries actual SDK headers/body and coordination lane without widening logical HTTPS scope", async () => {
    const f = fixture(true), sockets = new Set<Socket>(), received: Array<{ path: string; authorization: string | undefined }> = [];
    const server = createServer((req, res) => {
      if (!req.url) { res.writeHead(500).end(); return; }
      const path = req.url; received.push({ path, authorization: req.headers.authorization });
      void f.reply(new URL(path, origin)).then(async response => {
        res.writeHead(response.status, { ...Object.fromEntries(response.headers), connection: "close" }); res.end(await response.text());
      }).catch(() => { res.writeHead(500).end(); });
    });
    server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    disposals.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("actual native loopback port missing");
    f.state.intercept = async (url, init) => {
      expect(url.origin).toBe(origin);
      return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
    };
    expect(await f.check()).toMatchObject({ state: "done", evidence: { phaseStarted: true, linearComment: true, fleetActivity: true } });
    expect(received.length).toBeGreaterThan(10); expect(received.every(r => r.authorization === `Bearer ${bearer}`)).toBe(true);
    expect(received.some(r => r.path === `${paths.feed}?since=10`)).toBe(true); expect(f.calls.every(c => c.method === "GET")).toBe(true);
  });
  it("native redirect refusal enters only the original loopback request, never the redirect destination", async () => {
    const f = fixture(), received: string[] = [], sockets = new Set<Socket>();
    const server = createServer((req, res) => {
      received.push(req.url ?? "missing-url");
      if (req.url === "/redirect-destination") { res.writeHead(200, { connection: "close" }).end(JSON.stringify(contract())); return; }
      res.writeHead(302, { location: "/redirect-destination", connection: "close" }).end();
    });
    server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    disposals.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("actual native loopback port missing");
    f.state.intercept = async (url, init) => fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
    expect((await f.check()).state).toBe("waiting"); expect(received).toEqual([paths.contract]); expect(f.calls).toHaveLength(1);
  });
});
