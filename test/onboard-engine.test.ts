import { expectJsonJournalMatches } from "./json-journal.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseArgs } from "../src/args.js";
import { defaultCtx } from "../src/config.js";
import { cmdOnboard, ONBOARD_STEPS, onboardLockPath, onboardStatePath, type OnboardDeps } from "../src/onboard.js";

const homes: string[] = [];
const identity = { account: "tenant-a", membershipId: "member-a", baseUrl: "https://staging.catalystcloud.dev", role: "owner" as const };
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "onboard-engine-"));
  homes.push(home);
  const output: string[] = [];
  const ctx = { ...defaultCtx(), home, env: {}, stdout: (line: string) => output.push(line), stderr: (_line: string) => {}, now: () => new Date("2026-09-30T14:00:00Z") };
  const receipt = () => JSON.parse(readFileSync(onboardStatePath(home), "utf8"));
  const seed = (extra: Record<string, unknown> = {}) => {
    mkdirSync(join(onboardStatePath(home), ".."), { recursive: true });
    writeFileSync(onboardStatePath(home), JSON.stringify({ schema: 1, runId: "saved", installer: null, cli: "0.14.0", tenant: identity.account, ...identity, exit: null, changes: [], steps: [], ...extra }));
  };
  return { home, ctx, output, receipt, seed };
}
function completeAdapters(): NonNullable<OnboardDeps["adapters"]> {
  return Object.fromEntries(ONBOARD_STEPS.map((id) => [id, { check: async () => ({ state: "done" as const, evidence: { count: 1 } }) }]));
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("onboarding engine contracts", () => {
  test("the local sync choice persists across resume", async () => {
    const f = fixture();
    await cmdOnboard(parseArgs(["onboard", "--only", "legacy", "--yes", "--local-sync"]), f.ctx);
    expect(f.receipt().localSync).toBe(true);
    await cmdOnboard(parseArgs(["onboard", "--only", "legacy", "--yes"]), f.ctx);
    expect(f.receipt().localSync).toBe(true);
  });

  test("JSON identity refusal emits one safe result without touching the saved receipt", async () => {
    const f = fixture(); f.seed();
    const before = readFileSync(onboardStatePath(f.home), "utf8");
    const code = await cmdOnboard(parseArgs(["onboard", "--yes", "--json"]), f.ctx, { identity: async () => ({ ...identity, account: "other" }) });
    expect(code).toBe(12);
    expect(f.output).toHaveLength(1);
    expect(JSON.parse(f.output[0]!)).toMatchObject({ schema: 1, exit: 12, complete: false });
    expect(readFileSync(onboardStatePath(f.home), "utf8")).toBe(before);
  });
  test("default unsupported run waits and records the full plan instead of reporting complete", async () => {
    const f = fixture();
    const code = await cmdOnboard(parseArgs(["onboard", "--yes", "--json"]), f.ctx, { identity: async () => identity });
    expect(code).toBe(11);
    const saved = f.receipt();
    expect(saved.exit).toBe(11);
    expect(saved.steps.map((step: { id: string }) => step.id)).toEqual(expect.arrayContaining([...ONBOARD_STEPS]));
    expect(saved.steps.find((step: { id: string }) => step.id === "signin").state).not.toBe("skipped");
    expectJsonJournalMatches(JSON.parse(f.output[0]!),saved,"not-ready");
  });

  test("explicit legacy scope can succeed while the full run remains incomplete", async () => {
    const f = fixture();
    expect(await cmdOnboard(parseArgs(["onboard", "--only", "legacy", "--yes"]), f.ctx, { runStep: async () => ({ state: "done", evidence: { remaining: 0 } }) })).toBe(0);
    expect(f.receipt()).toMatchObject({ exit: 0, scope: "step" });
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("completed journal entries are rechecked and revoked provider state blocks its dependents", async () => {
    const f = fixture();
    f.seed({ steps: ONBOARD_STEPS.map((id) => ({ id, state: "done" })) });
    const adapters = completeAdapters();
    adapters["linear.workspace"] = { check: async () => ({ state: "waiting", reason: "grant_revoked" }) };
    adapters["linear.team"] = {
      check: async () => ({ state: "pending" }),
      act: async () => { writeFileSync(join(f.home, "team-created"), "unexpected"); return { state: "done" }; },
    };
    expect(await cmdOnboard(parseArgs(["onboard", "--yes"]), f.ctx, { identity: async () => identity, adapters })).toBe(11);
    expect(f.receipt().steps.find((step: { id: string }) => step.id === "linear.workspace")).toMatchObject({ state: "waiting", reason: "grant_revoked" });
    expect(existsSync(join(f.home, "team-created"))).toBe(false);
  });

  test("a failed provider leaves dependent work waiting but completes independent housekeeping", async () => {
    const f = fixture();
    const adapters = completeAdapters();
    adapters["linear.workspace"] = { check: async () => ({ state: "failed", reason: "provider_unavailable" }) };
    const scheduled = join(f.home, "housekeeping-scheduled");
    adapters.housekeeping = {
      check: async () => existsSync(scheduled) ? { state: "done", evidence: { count: 1 } } : { state: "pending" },
      act: async () => { writeFileSync(scheduled, "scheduled"); return { state: "done" }; },
    };
    expect(await cmdOnboard(parseArgs(["onboard", "--yes"]), f.ctx, { identity: async () => identity, adapters })).toBe(10);
    const saved = f.receipt();
    expect(saved.steps.find((step: { id: string }) => step.id === "housekeeping")).toMatchObject({ state: "done", evidence: { count: 1 } });
    expect(saved.steps.find((step: { id: string }) => step.id === "linear.team").state).not.toBe("done");
  });

  test("act must be followed by a fresh check before a step is recorded done", async () => {
    const f = fixture();
    const adapters = completeAdapters();
    adapters.legacy = { check: async () => ({ state: "pending" }), act: async () => ({ state: "done" }) };
    const code = await cmdOnboard(parseArgs(["onboard", "--only", "legacy", "--yes"]), f.ctx, { adapters });
    expect(code).not.toBe(0);
    expect(f.receipt().steps.find((step: { id: string }) => step.id === "legacy").state).not.toBe("done");
  });

  test("a genuinely verified full run records success", async () => {
    const f = fixture();
    expect(await cmdOnboard(parseArgs(["onboard", "--yes"]), f.ctx, { identity: async () => identity, adapters: completeAdapters() })).toBe(0);
    expect(f.receipt().exit).toBe(0);
    expect(f.receipt().steps.every((step: { state: string }) => step.state === "done")).toBe(true);
  });

  test("wrong tenant refuses without changing the receipt or running mutations", async () => {
    const f = fixture();
    f.seed();
    const before = readFileSync(onboardStatePath(f.home), "utf8");
    const adapters = completeAdapters();
    adapters.legacy = { check: async () => ({ state: "pending" }), act: async () => { writeFileSync(join(f.home, "mutation"), "unexpected"); return { state: "done" }; } };
    const code = await cmdOnboard(parseArgs(["onboard", "--yes"]), f.ctx, { identity: async () => ({ ...identity, account: "tenant-b" }), adapters });
    expect(code).toBe(12);
    expect(readFileSync(onboardStatePath(f.home), "utf8")).toBe(before);
    expect(existsSync(join(f.home, "mutation"))).toBe(false);
  });

  test("adapter secrets do not survive the receipt or JSON output boundary", async () => {
    const f = fixture();
    const secret = "fixture-secret-never-persist";
    const adapters = completeAdapters();
    adapters.legacy = { check: async () => ({ state: "done", evidence: { found: 1, token: secret, accessToken: secret, password: secret } }) };
    expect(await cmdOnboard(parseArgs(["onboard", "--only", "legacy", "--yes", "--json"]), f.ctx, { adapters })).toBe(0);
    const stored = readFileSync(onboardStatePath(f.home), "utf8");
    expect(stored).not.toContain(secret);
    expect(f.output.join("\n")).not.toContain(secret);
    expect(f.receipt().steps.find((step: { id: string }) => step.id === "legacy")).toMatchObject({ evidence: { found: 1 } });
  });

  test("member onboarding still verifies a coding account", async () => {
    const f = fixture();
    const adapters = completeAdapters();
    adapters.accounts = { check: async () => ({ state: "waiting", reason: "account_not_enrolled" }) };
    expect(await cmdOnboard(parseArgs(["onboard", "--yes"]), f.ctx, { identity: async () => ({ ...identity, role: "member" }), adapters })).toBe(11);
    expect(f.receipt().steps.find((step: { id: string }) => step.id === "accounts")).toMatchObject({ state: "waiting", reason: "account_not_enrolled" });
  });

  test("only mode checks dependencies without acting on them", async () => {
    const f = fixture();
    const adapters = completeAdapters();
    adapters.signin = { check: async () => ({ state: "pending" }), act: async () => { writeFileSync(join(f.home, "signed-in"), "unexpected"); return { state: "done" }; } };
    expect(await cmdOnboard(parseArgs(["onboard", "--only", "accounts", "--yes"]), f.ctx, { adapters })).toBe(11);
    expect(existsSync(join(f.home, "signed-in"))).toBe(false);
    expect(f.receipt().steps.find((step: { id: string }) => step.id === "accounts")).toMatchObject({ state: "waiting", reason: "prerequisite_not_ready" });
  });

  test("a live skipped required sign-in cannot complete onboarding", async () => {
    const f = fixture();
    const adapters = completeAdapters();
    adapters.signin = { check: async () => ({ state: "skipped" }) };
    expect(await cmdOnboard(parseArgs(["onboard", "--yes"]), f.ctx, { adapters })).toBe(11);
    expect(f.receipt().complete).toBe(false);
    expect(f.receipt().steps.find((step: { id: string }) => step.id === "accounts")).toMatchObject({ state: "waiting", reason: "prerequisite_not_ready" });
  });

  test("unknown journal schema refuses and preserves the original receipt", async () => {
    const f = fixture();
    f.seed({ schema: 999 });
    const before = readFileSync(onboardStatePath(f.home), "utf8");
    let code: number;
    try { code = await cmdOnboard(parseArgs(["onboard", "--yes"]), f.ctx); }
    catch (err) { code = (err as { exitCode: number }).exitCode; }
    expect(code).toBe(12);
    expect(readFileSync(onboardStatePath(f.home), "utf8")).toBe(before);
  });

  test("an ownerless lock is refused without reclaiming its directory", async () => {
    const f = fixture();
    mkdirSync(onboardLockPath(f.home), { recursive: true });
    expect(await cmdOnboard(parseArgs(["onboard", "--only", "legacy", "--yes"]), f.ctx)).toBe(12);
    expect(existsSync(onboardLockPath(f.home))).toBe(true);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
  });
});
