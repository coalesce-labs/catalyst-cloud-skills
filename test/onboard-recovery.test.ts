import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseArgs } from "../src/args.js";
import { defaultCtx } from "../src/config.js";
import { CliError } from "../src/errors.js";
import {
  cmdOnboard, ONBOARD_STEPS, onboardLockPath, onboardStatePath, onboardStateRoot,
  readOnboardJournal, writeOnboardJournal,
  type OnboardDeps, type OnboardIdentity, type OnboardJournal,
} from "../src/onboard.js";

const homes: string[] = [];
const seat: OnboardIdentity = {
  account: "recovery-tenant", membershipId: "recovery-member",
  baseUrl: "https://staging.catalystcloud.dev", role: "admin",
};
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "onboard-recovery-"));
  homes.push(home);
  const output: string[] = [];
  const errors: string[] = [];
  const ctx = {
    ...defaultCtx(), home, env: {} as NodeJS.ProcessEnv,
    stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line),
    now: () => new Date("2026-09-30T15:00:00.000Z"),
  };
  const receipt = () => JSON.parse(readFileSync(onboardStatePath(home, ctx.env), "utf8")) as OnboardJournal;
  const seed = (value: unknown) => {
    const path = onboardStatePath(home, ctx.env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };
  return { home, ctx, output, errors, receipt, seed };
}
function journal(extra: Partial<OnboardJournal> = {}): OnboardJournal {
  return {
    schema: 1, runId: "recovery-run", installer: null, cli: "0.14.0", tenant: seat.account,
    account: seat.account, membershipId: seat.membershipId, baseUrl: seat.baseUrl,
    steps: [], changes: [], exit: null, ...extra,
  };
}
function checkedAdapters(): NonNullable<OnboardDeps["adapters"]> {
  return Object.fromEntries(ONBOARD_STEPS.map(id => [id, {
    check: async () => ({ state: "done" as const }),
  }]));
}
const scopedArgs = () => parseArgs(["onboard", "--only", "legacy", "--yes", "--json"]);
const fullArgs = () => parseArgs(["onboard", "--yes", "--json"]);
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("onboarding saved-state recovery boundaries", () => {
  test.each([
    ["truncated JSON", '{"schema":1,"steps":'],
    ["unknown receipt shape", JSON.stringify({ schema: 1, steps: {} })],
    ["future schema", JSON.stringify({ schema: 2, steps: [] })],
  ])("%s refuses before mutation and preserves recovery evidence", async (_name, raw) => {
    const f = fixture();
    const path = f.seed(raw);
    let acted = false;
    await expect(cmdOnboard(scopedArgs(), f.ctx, {
      runStep: async () => { acted = true; return { state: "done" }; },
    })).rejects.toMatchObject({ exitCode: 12 });
    expect(acted).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("a symlink receipt refuses without changing its target", async () => {
    const f = fixture();
    const target = join(f.home, "other-install.json");
    const bytes = JSON.stringify(journal());
    writeFileSync(target, bytes);
    const path = onboardStatePath(f.home);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
    await expect(cmdOnboard(scopedArgs(), f.ctx)).rejects.toMatchObject({ code: "onboard-state-symlink", exitCode: 12 });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(bytes);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("old installer aliases migrate, duplicate observations keep the latest state and unsafe evidence is excluded", () => {
    const f = fixture();
    const path = f.seed({
      schema: "catalyst-install-last-run/1", revision: "0.13.4", state: "stopped", exitCode: 10,
      startedAt: "2026-09-30T13:00:00Z", steps: [
        { id: "folders", result: "done" },
        { id: "login", result: "already_done", updatedAt: "2026-09-30T13:01:00Z" },
        { id: "sign_in", result: "interrupted", reason: "provider_retry", evidence: { count: 2, password: "omit-me", checks: { raw: "not-scalar" } } },
        { id: "daily_updates", result: "not_approved" },
        { id: "final_check", result: "needs_you" },
        { id: "not-an-onboard-step", result: "done" },
      ], changes: [{ kind: "service", label: "old service", undo: "catalyst uninstall" }, { kind: "service", label: "no undo" }],
    });
    const migrated = readOnboardJournal(path, "0.14.0")!;
    expect(migrated).toMatchObject({ schema: 1, installer: "0.13.4", cli: "0.14.0", exit: null });
    expect(migrated.steps).toEqual([
      { id: "machine", state: "done", at: "2026-09-30T13:00:00Z" },
      { id: "signin", state: "failed", at: "2026-09-30T13:00:00Z", reason: "provider_retry", evidence: { count: 2 } },
      { id: "housekeeping", state: "waiting", at: "2026-09-30T13:00:00Z" },
      { id: "ready", state: "waiting", at: "2026-09-30T13:00:00Z" },
    ]);
    expect(migrated.changes).toEqual([{ kind: "service", label: "old service", undo: "catalyst uninstall" }]);
    expect(JSON.stringify(migrated)).not.toContain("omit-me");
    // Reading migrates in memory; the old receipt remains available for a stopped run's recovery.
    expect(JSON.parse(readFileSync(path, "utf8")).schema).toBe("catalyst-install-last-run/1");
  });

  test("a resumed receipt roundtrip retains identity, selected local sync and safe operation keys without credential extras", () => {
    const f = fixture();
    const saved = journal({
      installer: "0.13.4", scope: "onboarding", mode: "run", complete: false,
      localSync: true, exit: 11,
      operations: { legacy: "recovery-run:legacy", signin: "invalid operation key with spaces" },
      steps: [{ id: "signin", state: "waiting", at: "2026-09-30T14:00:00Z", reason: "consent_pending", evidence: { principal: "person", account: seat.account, count: 1 } }],
      changes: [{ kind: "service", label: "local sync", undo: "catalyst daemon stop" }],
    });
    const path = f.seed({ ...saved, operations: { ...saved.operations, "obsolete-provider": "recovery-run:obsolete" }, accessToken: "fixture-credential-must-not-migrate" });
    const restored = readOnboardJournal(path, "0.14.0")!;
    expect(restored).toEqual({ ...saved, operations: { legacy: "recovery-run:legacy" } });
    writeOnboardJournal(path, restored);
    expect(readOnboardJournal(path)).toEqual(restored);
    expect(readFileSync(path, "utf8")).not.toContain("fixture-credential-must-not-migrate");
  });

  test("a receipt directory symlink cannot redirect an atomic journal write", () => {
    const f = fixture();
    const target = join(f.home, "other-state");
    mkdirSync(target);
    writeFileSync(join(target, "sentinel"), "keep other state");
    const link = join(f.home, "redirected-install");
    symlinkSync(target, link);
    expect(() => writeOnboardJournal(join(link, "last-run.json"), journal())).toThrowError(expect.objectContaining({ code: "onboard-state-path", exitCode: 12 }));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(target)).toEqual(["sentinel"]);
    expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("keep other state");
  });

  test("atomic replacement keeps receipt and directory private and leaves no temporary file", () => {
    const f = fixture();
    const path = f.seed(journal({ exit: 11 }));
    writeOnboardJournal(path, journal({ exit: 0, scope: "step", complete: false }));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(path))).toEqual(["last-run.json"]);
    expect(readOnboardJournal(path)).toMatchObject({ exit: 0, scope: "step", complete: false });
  });

  test("a selected state directory or paths file cannot silently fall back to another lock root", () => {
    const f = fixture();
    expect(() => onboardStateRoot(f.home, { CATALYST_INSTALL_STATE_DIR: "relative/state" })).toThrowError(expect.objectContaining({ exitCode: 12 }));
    expect(() => onboardStateRoot(f.home, { CATALYST_PATHS_FILE: join(f.home, "absent.json") })).toThrowError(expect.objectContaining({ exitCode: 12 }));
    const bootstrap = join(f.home, "bootstrap-state");
    expect(onboardStateRoot(f.home, { CATALYST_INSTALL_STATE_DIR: bootstrap, CATALYST_STATE_DIR: join(f.home, "other-state") })).toBe(bootstrap);
    expect(readdirSync(f.home)).toEqual([]);
  });

  test("declining Continue returns one incomplete JSON object without acquiring state", async () => {
    const f = fixture();
    const questions: string[] = [];
    expect(await cmdOnboard(parseArgs(["onboard", "--json"]), f.ctx, {
      isTty: () => true, confirm: async question => { questions.push(question); return false; },
    })).toBe(0);
    expect(questions).toEqual(["Continue? [Y/n] "]);
    expect(f.output).toHaveLength(1);
    expect(JSON.parse(f.output[0]!)).toMatchObject({ complete: false, exit: null });
    expect(readdirSync(f.home)).toEqual([]);
  });
});

describe("onboarding lock ownership recovery", () => {
  test("an exited owner's legacy PID lock is reclaimed, private new ownership is observed, then released", async () => {
    const f = fixture();
    const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8", timeout: 5000 });
    expect(dead.status).toBe(0);
    const deadPid = Number(dead.stdout.trim());
    expect(deadPid).toBeGreaterThan(0);
    expect(() => process.kill(deadPid, 0)).toThrow();
    const lock = onboardLockPath(f.home);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), String(deadPid));
    writeFileSync(join(lock, "old-owner-marker"), "stale");
    expect(await cmdOnboard(scopedArgs(), f.ctx, {
      token: () => "replacement-token", runStep: async () => {
        expect(existsSync(join(lock, "old-owner-marker"))).toBe(false);
        expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"))).toEqual({ pid: process.pid, token: "replacement-token" });
        expect(statSync(lock).mode & 0o777).toBe(0o700);
        expect(statSync(join(lock, "owner.json")).mode & 0o777).toBe(0o600);
        return { state: "done" };
      },
    })).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  test.each([
    ["different handoff token", "original-token", "wrong-token"],
    ["same PID without a handoff token", "original-token", undefined],
    ["same PID without an owner nonce", "", "supplied-token"],
  ])("%s cannot adopt a live lock", async (_name, token, handoff) => {
    const f = fixture();
    const lock = onboardLockPath(f.home);
    mkdirSync(lock, { recursive: true });
    const bytes = JSON.stringify({ pid: process.pid, token });
    writeFileSync(join(lock, "owner.json"), bytes);
    if (handoff !== undefined) f.ctx.env.CATALYST_INSTALL_LOCK_TOKEN = handoff;
    expect(await cmdOnboard(scopedArgs(), f.ctx)).toBe(10);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(bytes);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
  });

  test("a lock symlink is refused without touching the referenced owner's files", async () => {
    const f = fixture();
    const target = join(f.home, "other-owner");
    mkdirSync(target);
    writeFileSync(join(target, "pid"), String(process.pid));
    const lock = onboardLockPath(f.home);
    mkdirSync(dirname(lock), { recursive: true });
    symlinkSync(target, lock);
    expect(await cmdOnboard(scopedArgs(), f.ctx)).toBe(12);
    expect(lstatSync(lock).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, "pid"), "utf8")).toBe(String(process.pid));
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
  });

  test("stale reclamation refuses an owner that changed after the liveness probe", async () => {
    const f = fixture();
    const lock = onboardLockPath(f.home);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 987654, token: "dead-owner" }));
    const replacement = { pid: process.pid, token: "new-live-owner" };
    expect(await cmdOnboard(scopedArgs(), f.ctx, {
      isProcessAlive: () => { writeFileSync(join(lock, "owner.json"), JSON.stringify(replacement)); return false; },
    })).toBe(12);
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"))).toEqual(replacement);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
  });

  test("cleanup cannot delete another owner's symlink replacement", async () => {
    const f = fixture();
    const target = join(f.home, "other-lock");
    mkdirSync(target);
    writeFileSync(join(target, "sentinel"), "keep");
    const lock = onboardLockPath(f.home);
    expect(await cmdOnboard(scopedArgs(), f.ctx, {
      runStep: async () => {
        rmSync(lock, { recursive: true }); symlinkSync(target, lock);
        return { state: "done" };
      },
    })).toBe(0);
    expect(lstatSync(lock).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("keep");
  });
});

describe("onboarding interruption and changing permissions", () => {
  test("SIGTERM while an action is pending records interruption, releases ownership and resumes the same operation", async () => {
    const f = fixture();
    const existing = process.listeners("SIGTERM");
    const adapters = checkedAdapters();
    let restored = false;
    let operation: string | undefined;
    const signals: AbortSignal[] = [];
    f.ctx.fetch = async (_input, init) => {
      const signal = init?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      signals.push(signal!);
      const handler = process.listeners("SIGTERM").find(listener => !existing.includes(listener));
      expect(handler).toBeDefined();
      // Invoke only this run's registered signal handler, not Vitest's process listeners.
      handler!("SIGTERM");
      expect(signal!.aborted).toBe(true);
      throw new DOMException("fixture request interrupted", "AbortError");
    };
    adapters.legacy = {
      check: async () => restored ? { state: "done" } : { state: "pending" },
      act: async (ctx, saved) => {
        operation = saved.operations?.legacy;
        await ctx.fetch("https://offline.invalid/control");
        return { state: "done" };
      },
    };
    expect(await cmdOnboard(fullArgs(), f.ctx, { adapters, bindSignals: true })).toBe(11);
    expect(signals).toHaveLength(1);
    expect(f.receipt()).toMatchObject({ exit: 11, complete: false });
    expect(f.receipt().steps.find(step => step.id === "legacy")).toMatchObject({ state: "failed", reason: "interrupted" });
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
    expect(process.listeners("SIGTERM")).toEqual(existing);
    adapters.legacy.act = async (_ctx, saved) => {
      expect(saved.operations?.legacy).toBe(operation);
      restored = true; return { state: "done" };
    };
    expect(await cmdOnboard(scopedArgs(), f.ctx, { adapters })).toBe(0);
    expect(f.receipt()).toMatchObject({ exit: 0, scope: "step", complete: false });
    expect(f.receipt().steps.find(step => step.id === "legacy")?.state).toBe("done");
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("external cancellation during the final scoped action returns waiting rather than a failed setup", async () => {
    const f = fixture();
    const controller = new AbortController();
    const adapters = checkedAdapters();
    f.ctx.fetch = async (_input, init) => {
      expect(init?.signal?.aborted).toBe(false);
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException("aborted fixture action", "AbortError");
    };
    adapters.legacy = {
      check: async () => ({ state: "pending" }),
      act: async ctx => { await ctx.fetch("https://offline.invalid/control"); return { state: "done" }; },
    };
    expect(await cmdOnboard(scopedArgs(), f.ctx, {
      signal: controller.signal, bindSignals: false, adapters,
    })).toBe(11);
    expect(f.receipt()).toMatchObject({ exit: 11, complete: false });
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
    expect(f.output).toHaveLength(1);
    expect(JSON.parse(f.output[0]!)).toEqual(f.receipt());
  });

  test("an admin demoted after a check cannot perform the pending workspace write", async () => {
    const f = fixture();
    let role: OnboardIdentity["role"] = "admin";
    let wrote = false;
    const adapters = checkedAdapters();
    adapters["linear.workspace"] = {
      check: async () => { role = "member"; return { state: "pending" }; },
      act: async () => { wrote = true; return { state: "done" }; },
    };
    expect(await cmdOnboard(parseArgs(["onboard", "--only", "linear.workspace", "--yes"]), f.ctx, {
      identity: async () => ({ ...seat, role }), adapters,
    })).toBe(0);
    expect(wrote).toBe(false);
    expect(f.receipt().steps.find(step => step.id === "linear.workspace")).toMatchObject({ state: "skipped", reason: "member_scope" });
    expect(f.receipt().complete).toBe(false);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("resume from settings rechecks earlier recorded success but cannot retry an earlier provider action", async () => {
    const f = fixture();
    f.seed(journal({ localSync: true, steps: ONBOARD_STEPS.map(id => ({ id, state: "done" })) }));
    const adapters = checkedAdapters();
    let consentStarted = false;
    let selectedLocalSync: boolean | undefined;
    adapters["linear.workspace"] = {
      check: async () => ({ state: "pending", reason: "grant_revoked" }),
      act: async () => { consentStarted = true; return { state: "done" }; },
    };
    adapters.daemon = { check: async (_ctx, saved) => { selectedLocalSync = saved.localSync; return { state: "done" }; } };
    expect(await cmdOnboard(parseArgs(["onboard", "--resume-from", "settings", "--yes", "--json"]), f.ctx, {
      identity: async () => seat, adapters,
    })).toBe(11);
    expect(consentStarted).toBe(false);
    expect(selectedLocalSync).toBe(true);
    expect(f.receipt().steps.find(step => step.id === "linear.workspace")).toMatchObject({ state: "waiting", reason: "grant_revoked" });
    expect(f.receipt().steps.find(step => step.id === "settings")).toMatchObject({ state: "waiting", reason: "prerequisite_not_ready" });
    expect(f.receipt().complete).toBe(false);
  });

  test.each(["reported", "thrown"])("a %s authorization refusal stops later independent actions", async form => {
    const f = fixture();
    const adapters = checkedAdapters();
    let later = false;
    adapters.legacy = {
      check: async () => ({ state: "pending" }),
      act: async () => {
        if (form === "thrown") throw new CliError("fixture permission changed", "permission-changed", 12);
        return { state: "refused", reason: "permission_changed" };
      },
    };
    adapters.housekeeping = {
      check: async () => ({ state: "pending" }),
      act: async () => { later = true; return { state: "done" }; },
    };
    expect(await cmdOnboard(fullArgs(), f.ctx, { adapters })).toBe(12);
    expect(later).toBe(false);
    expect(f.receipt()).toMatchObject({ exit: 12, complete: false });
    expect(f.receipt().steps.find(step => step.id === "legacy")).toMatchObject({ state: "failed", reason: "permission_changed" });
    expect(f.receipt().steps.find(step => step.id === "housekeeping")?.state).toBe("pending");
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("a failed action records a safe error and still verifies independent housekeeping", async () => {
    const f = fixture();
    const adapters = checkedAdapters();
    const scheduled = join(f.home, "scheduled");
    adapters["linear.workspace"] = {
      check: async () => ({ state: "pending" }),
      act: async () => { throw new CliError("provider body contains fixture-private-data", "provider-temporarily-unavailable", 10); },
    };
    adapters.housekeeping = {
      check: async () => existsSync(scheduled) ? { state: "done", evidence: { scheduled: true } } : { state: "pending" },
      act: async () => { writeFileSync(scheduled, "created"); return { state: "done" }; },
    };
    expect(await cmdOnboard(fullArgs(), f.ctx, { identity: async () => seat, adapters })).toBe(10);
    expect(f.receipt().steps.find(step => step.id === "linear.workspace")).toMatchObject({ state: "failed", reason: "provider_temporarily_unavailable" });
    expect(f.receipt().steps.find(step => step.id === "housekeeping")).toMatchObject({ state: "done", evidence: { scheduled: true } });
    expect(f.receipt().steps.find(step => step.id === "projects")).toMatchObject({ state: "waiting", reason: "prerequisite_not_ready" });
    expect(f.errors.join("\n") + f.output.join("\n") + JSON.stringify(f.receipt())).not.toContain("fixture-private-data");
  });
});
