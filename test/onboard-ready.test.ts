import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeContractCache } from "../src/contract.js";
import { buildFixtureContract } from "./fixture-contract.js";
import { writeConfig } from "../src/config.js";
import { defaultCtx } from "../src/config.js";
import { onboardStatePath } from "../src/onboard.js";
import { onboardingReadyReport, observeCloudOnboarding } from "../src/onboard-ready.js";

const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "onboard-ready-")); homes.push(home);
  return { ...defaultCtx(), home, env: {} as NodeJS.ProcessEnv, stdout: (_line: string) => {}, stderr: (_line: string) => {} };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const cloudPass = { id: "cloud.setup", state: "pass" as const, required: true, evidence: { account: "tenant-a" } };
const observed = { state: "observed" as const, ticket: "ENG-1", phaseStartedAt: "2026-09-30T14:00:00Z" };

describe("onboarding readiness report", () => {
  test("an unavailable observation stays unknown without exposing provider text", async () => {
    const report = await onboardingReadyReport(fixture(), { observe: async () => { throw new Error("provider_token=never-publish"); } });
    expect(report.state).toBe("unknown");
    expect(JSON.stringify(report)).not.toContain("never-publish");
  });
  test("default cloud reads without an observer are unknown rather than complete or failed", async () => {
    const report = await onboardingReadyReport(fixture(), {});
    expect(report).toMatchObject({ schema: 1, readMode: "cloud", state: "unknown", work: { state: "unknown" } });
    expect(report.checks.filter(check => check.required).length).toBeGreaterThan(0);
    expect(report.checks.filter(check => check.required).every(check => check.state === "unknown")).toBe(true);
  });

  test("required observed setup failures make the report incomplete", async () => {
    const report = await onboardingReadyReport(fixture(), { observe: async () => ({ checks: [{ ...cloudPass, state: "fail", reason: "grant_revoked" }], work: observed }) });
    expect(report.state).toBe("incomplete");
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "cloud.setup", state: "fail", reason: "grant_revoked", required: true }));
    expect(report.work).toEqual(observed);
  });

  test("observed project work remains observed while setup evidence is unknown", async () => {
    const report = await onboardingReadyReport(fixture(), { observe: async () => ({ checks: [{ ...cloudPass, state: "unknown", reason: "not_checked" }], work: observed }) });
    expect(report.state).toBe("unknown");
    expect(report.work).toEqual(observed);
  });

  test("optional local sync failure does not block the default cloud workflow", async () => {
    const report = await onboardingReadyReport(fixture(), { observe: async () => ({ checks: [cloudPass, { id: "local.replica", state: "fail", required: false, reason: "not_running" }], work: observed }) });
    expect(report).toMatchObject({ readMode: "cloud", state: "complete", work: observed });
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "local.replica", state: "fail", required: false }));
  });

  test("local sync mode is explicitly selected instead of inferred from receipt presence", async () => {
    const report = await onboardingReadyReport(fixture(), { localSync: true, observe: async () => ({ checks: [cloudPass], work: observed }) });
    expect(report.readMode).toBe("local");
  });

  test("explicit local sync cannot complete from cloud evidence alone", async () => {
    const report = await onboardingReadyReport(fixture(), { localSync: true, observe: async () => ({ checks: [cloudPass], work: observed }) });
    expect(report.state).toBe("unknown");
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "local.sync", state: "unknown", required: true }));
  });

  test("passing setup checks do not prove that project work was observed", async () => {
    const report = await onboardingReadyReport(fixture(), { observe: async () => ({ checks: [cloudPass], work: { state: "not_observed" } }) });
    expect(report.state).toBe("incomplete");
    expect(report.work.state).toBe("not_observed");
  });

  test("a completed receipt cannot substitute for live work or setup observations", async () => {
    const ctx = fixture();
    const path = onboardStatePath(ctx.home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ schema: 1, complete: true, exit: 0, steps: [{ id: "first-ticket", state: "done", evidence: { ticket: "ENG-1", phaseStarted: true } }, { id: "ready", state: "done" }] }));
    const report = await onboardingReadyReport(ctx, {});
    expect(report.state).toBe("unknown");
    expect(report.work).toEqual({ state: "unknown" });
  });

  test("complete requires live passing required checks and observed work", async () => {
    const report = await onboardingReadyReport(fixture(), { observe: async () => ({ checks: [cloudPass], work: observed }) });
    expect(report).toMatchObject({ schema: 1, readMode: "cloud", state: "complete", work: observed });
  });

  test("no required setup checks cannot be mistaken for complete", async () => {
    const report = await onboardingReadyReport(fixture(), { observe: async () => ({ checks: [], work: observed }) });
    expect(report.state).not.toBe("complete");
    expect(report.work).toEqual(observed);
  });

  test("unknown work prevents completion even when setup checks pass", async () => {
    const report = await onboardingReadyReport(fixture(), { observe: async () => ({ checks: [cloudPass], work: { state: "unknown" } }) });
    expect(report.state).toBe("unknown");
  });

  test("a cached contract fallback cannot claim current cloud checks passed or failed", async () => {
    const ctx = fixture();
    const now = Date.now();
    ctx.now = () => new Date(now);
    const doc = buildFixtureContract();
    for (const team of doc.teams) {
      team.readiness.checkedAt = now - 1_000;
      team.readiness.expiresAt = now + 60_000;
      team.readiness.checks = [{ id: "token_live", state: "pass" }];
    }
    writeConfig(ctx.home, { baseUrl: "https://staging.catalystcloud.dev", key: "ctc_user_fixture", account: doc.account.id, slug: doc.account.slug, name: doc.account.name, principal: "session", permissions: null, user: { id: "person-a", label: "Test Person", email: null, role: "owner", linearUserId: null }, joinedAt: new Date(now).toISOString(), lastSkillBundleVersion: "0.14.0" });
    writeContractCache(ctx.home, { etag: null, fetchedAt: new Date(now - 1_000).toISOString(), contractVersion: doc.contractVersion, doc });
    ctx.fetch = (async () => { throw new TypeError("fixture offline"); }) as typeof fetch;
    const observation = await observeCloudOnboarding(ctx, { teamIds: doc.teams.map(team => team.id) });
    expect(observation.checks.length).toBeGreaterThan(0);
    expect(observation.checks.every(check => check.state === "unknown")).toBe(true);
    expect(observation.work.state).toBe("unknown");
  });

  test("secret fields and unsafe free-text reasons do not survive output sanitation", async () => {
    const secret = "fixture-secret-never-publish";
    const report = await onboardingReadyReport(fixture(), { observe: async () => ({ checks: [{ ...cloudPass, reason: `token=${secret}`, evidence: { account: "tenant-a", token: secret, accessToken: secret, password: secret, count: 1 } }], work: observed }) });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.checks.find(check => check.id === "cloud.setup")).toMatchObject({ evidence: { account: "tenant-a", count: 1 } });
  });
  test("observed work and verified required local sync can complete explicit local mode", async () => {
    const report = await onboardingReadyReport(fixture(), { localSync: true, observe: async () => ({ checks: [cloudPass, { id: "local.sync", state: "pass", required: true, evidence: { supervised: true, lag: 1 } }], work: observed }) });
    expect(report).toMatchObject({ state: "complete", readMode: "local" });
    expect(report.checks.filter(check => check.id === "local.sync")).toHaveLength(1);
  });

  test("observer failures become unknown without exposing transport secrets", async () => {
    const report = await onboardingReadyReport(fixture(), { observe: async () => { throw new Error("fixture-private-provider-token"); } });
    expect(report.state).toBe("unknown");
    expect(JSON.stringify(report)).not.toContain("fixture-private-provider-token");
  });

  test("observed work metadata drops invalid ticket names and dates", async () => {
    const report = await onboardingReadyReport(fixture(), { observe: async () => ({ checks: [cloudPass], work: { state: "observed", ticket: "token=private", phaseStartedAt: "not-a-date" } }) });
    expect(report.work).toEqual({ state: "observed" });
  });

  test("cloud observation without personal login reports the missing person", async () => {
    expect(await observeCloudOnboarding(fixture())).toMatchObject({ checks: [{ id: "signin", state: "fail", required: true, reason: "personal_login_required" }], work: { state: "unknown" } });
  });

  test.each(["fresh", "expired", "unchecked", "empty", "wrong-workspace", "no-projects"] as const)("live %s contract preserves project readiness evidence", async scenario => {
    const ctx = fixture();
    const now = Date.now(); ctx.now = () => new Date(now);
    const doc = buildFixtureContract();
    const account = doc.account.id;
    for (const team of doc.teams) {
      team.readiness.checkedAt = scenario === "unchecked" ? null : now - 1_000;
      team.readiness.expiresAt = scenario === "expired" ? now - 1 : now + 60_000;
      team.readiness.checks = scenario === "empty" ? [] : [{ id: "token_live", state: "pass", count: 1 }];
    }
    if (scenario === "wrong-workspace") doc.account.id = "different-tenant";
    if (scenario === "no-projects") doc.teams = [];
    writeConfig(ctx.home, { baseUrl: "https://staging.catalystcloud.dev", key: "ctc_user_fixture", account, slug: doc.account.slug, name: doc.account.name, principal: "session", permissions: null, user: { id: "person-a", label: "Test Person", email: null, role: "owner", linearUserId: null }, joinedAt: new Date(now).toISOString(), lastSkillBundleVersion: "0.14.0" });
    ctx.fetch = (async () => Response.json(doc)) as typeof fetch;
    const observation = await observeCloudOnboarding(ctx, { teamIds: doc.teams.map(team => team.id) });
    expect(observation.work.state).toBe("unknown");
    if (scenario === "fresh") {
      expect(observation.checks.every(check => check.state === "pass")).toBe(true);
      expect(observation.checks[0]).toMatchObject({ required: true, evidence: { checkedAt: now - 1_000, count: 1 } });
    } else if (scenario === "wrong-workspace") expect(observation.checks).toEqual([{ id: "workspace", state: "fail", required: true, reason: "workspace_mismatch" }]);
    else expect(observation.checks.every(check => check.state === "unknown")).toBe(true);
  });

});
