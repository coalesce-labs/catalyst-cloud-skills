import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { configPathFor, defaultCtx, writeConfig, type Ctx } from "../src/config.js";
import {
  cmdOnboard, ONBOARD_STEPS, onboardLockPath, onboardStatePath,
  readOnboardJournal, writeOnboardJournal, type OnboardAdapter,
  type OnboardCheckpoint, type OnboardDeps, type OnboardJournal,
} from "../src/onboard.js";
import { firstTicketIntent, parseFirstTicketReceipt, type FirstTicketReceipt } from "../src/onboard-first-ticket.js";

const homes: string[] = [];
const identity = { account: "account-1", membershipId: "person-1", baseUrl: "https://checkpoint-fixture.invalid", role: "owner" as const };
const KEY = "original-run:first-ticket";
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function receipt(key = KEY, stage: FirstTicketReceipt["stage"] = "creating"): FirstTicketReceipt {
  const intent = firstTicketIntent({
    account: identity.account, person: identity.membershipId, origin: identity.baseUrl,
    teamId: "team-1", teamKey: "CTC", repoId: "repo-sdk", repoName: "Acme/SDK",
    dispatchStateId: "state-dispatch", starter: "contributing-tests",
  }, key);
  if (!intent) throw new Error("positive checkpoint intent refused");
  return {
    schema: 1, intent: { ...intent }, stage,
    ticket: stage === "creating" ? null : { id: "derived-issue-id", identifier: "CTC-41", url: null },
    baseline: stage === "requesting" || stage === "requested" ? { cursor: 10, at: 1_700_000_000_000 } : null,
    requestId: stage === "requested" ? 17 : null,
  };
}
function requireCheckpoint(value: OnboardCheckpoint | undefined): OnboardCheckpoint {
  if (!value) throw new Error("engine did not supply owned checkpoint");
  return value;
}
function fixture(initial?: FirstTicketReceipt) {
  const home = mkdtempSync(join(tmpdir(), "onboard-first-checkpoint-"));
  homes.push(home);
  const output: string[] = [], errors: string[] = [];
  const ctx: Ctx = { ...defaultCtx(), home, env: {}, stdout: (text) => output.push(text), stderr: (text) => errors.push(text) };
  writeConfig(home, {
    baseUrl: identity.baseUrl, account: identity.account, slug: "fixture", name: "Fixture",
    permissions: ["mirror:read", "mirror:write"], principal: "service",
    user: { id: identity.membershipId, label: "Fixture Person", email: null, role: "owner", linearUserId: null },
    key: "ctc_user_checkpoint_fixture_only", joinedAt: ctx.now().toISOString(), lastSkillBundleVersion: "0.14.6",
  });
  const statePath = onboardStatePath(home), lockPath = onboardLockPath(home);
  // Historical prerequisite records isolate the engine's checkpoint mechanism.
  // These checks make no current provider/readiness or launched-ticket claim.
  const journal: OnboardJournal = {
    schema: 1, runId: "original-run", installer: null, cli: "0.14.6", tenant: identity.account,
    account: identity.account, membershipId: identity.membershipId, baseUrl: identity.baseUrl,
    exit: 11, complete: false, localSync: false, operations: { "first-ticket": KEY }, changes: [],
    steps: ONBOARD_STEPS.map((id): OnboardJournal["steps"][number] => id === "first-ticket"
      ? { id, state: "waiting", reason: "first_ticket_launch_unconfirmed", ...(initial ? { evidence: { firstTicket: JSON.stringify(initial) } } : {}) }
      : id === "ready" ? { id, state: "waiting", reason: "fixture_readiness_unverified" } : { id, state: "done" }),
  };
  writeOnboardJournal(statePath, journal);
  const controller = new AbortController();
  const adapter: OnboardAdapter = {
    check: async () => ({ state: "pending" }),
    act: async () => ({ state: "waiting", reason: "fixture_launch_unverified" }),
  };
  const adapters: NonNullable<OnboardDeps["adapters"]> = {};
  for (const id of ONBOARD_STEPS) adapters[id] = id === "first-ticket" ? adapter : {
    check: async (_ctx, current) => {
      const saved = current.steps.find((step) => step.id === id);
      return saved?.state === "done" ? { state: "done" } : { state: "waiting", reason: "fixture_readiness_unverified" };
    },
  };
  const deps: OnboardDeps = { adapters, identity: async () => identity, bindSignals: false, signal: controller.signal };
  const run = () => cmdOnboard(parseArgs(["onboard", "--only", "first-ticket", "--yes", "--json"]), ctx, deps, "0.14.6");
  const read = () => {
    const current = readOnboardJournal(statePath);
    if (!current) throw new Error("checkpoint journal disappeared");
    return current;
  };
  const readReceipt = () => {
    const value = read().steps.find((step) => step.id === "first-ticket")?.evidence?.firstTicket;
    if (typeof value !== "string") return null;
    return parseFirstTicketReceipt(JSON.parse(value));
  };
  return { home, ctx, deps, adapter, controller, statePath, lockPath, output, errors, run, read, readReceipt };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("first-ticket engine checkpoint with actual private files", () => {
  it("acknowledges the actual private atomic checkpoint under the current PID/token owner", async () => {
    const f = fixture();
    f.adapter.act = async (_ctx, journal, _signal, checkpoint) => {
      expect(existsSync(f.lockPath)).toBe(true);
      const owner = JSON.parse(readFileSync(join(f.lockPath, "owner.json"), "utf8"));
      expect(owner.pid).toBe(process.pid);
      expect(typeof owner.token).toBe("string");
      expect(journal.operations?.["first-ticket"]).toBe(KEY);
      requireCheckpoint(checkpoint)(JSON.stringify(receipt()));
      expect(f.readReceipt()).toEqual(receipt());
      expect(lstatSync(f.statePath).mode & 0o777).toBe(0o600);
      expect(lstatSync(dirname(f.statePath)).mode & 0o777).toBe(0o700);
      return { state: "waiting", reason: "fixture_launch_unverified" };
    };
    expect(await f.run()).toBe(11);
    expect(f.readReceipt()).toEqual(receipt());
    expect(existsSync(f.lockPath)).toBe(false);
  });
  it.each(["creating", "created", "requesting", "requested"] as const)("preserves the %s receipt through a waiting result and resume with the original operation key", async (stage) => {
    const f = fixture();
    let calls = 0;
    f.adapter.act = async (_ctx, journal, _signal, checkpoint) => {
      calls += 1;
      expect(journal.operations?.["first-ticket"]).toBe(KEY);
      if (calls === 1) requireCheckpoint(checkpoint)(JSON.stringify(receipt(KEY, stage)));
      else expect(journal.steps.find((step) => step.id === "first-ticket")?.evidence?.firstTicket).toBe(JSON.stringify(receipt(KEY, stage)));
      return { state: "waiting", reason: "fixture_launch_unverified", evidence: { phaseStarted: false } };
    };
    expect(await f.run()).toBe(11);
    expect(f.readReceipt()).toEqual(receipt(KEY, stage));
    expect(await f.run()).toBe(11);
    expect(f.read().operations?.["first-ticket"]).toBe(KEY);
    expect(f.readReceipt()).toEqual(receipt(KEY, stage));
    expect(calls).toBe(2);
  });
  it("retains an existing receipt while entering running and after an action exception", async () => {
    const f = fixture(receipt(KEY, "requesting"));
    f.adapter.act = async (_ctx, journal) => {
      expect(journal.steps.find((step) => step.id === "first-ticket")?.evidence?.firstTicket).toBe(JSON.stringify(receipt(KEY, "requesting")));
      throw new Error("fixture lost provider response");
    };
    expect(await f.run()).toBe(10);
    expect(f.readReceipt()).toEqual(receipt(KEY, "requesting"));
    expect(f.read().operations?.["first-ticket"]).toBe(KEY);
  });
  it("preserves a new durable receipt through cancellation and joins entered action cleanup before unlocking", async () => {
    const f = fixture();
    const entered = deferred<void>(), cleanup = deferred<void>();
    let ownedCheckpoint: OnboardCheckpoint | undefined;
    f.adapter.act = async (_ctx, _journal, _signal, checkpoint) => {
      ownedCheckpoint = requireCheckpoint(checkpoint);
      ownedCheckpoint(JSON.stringify(receipt(KEY, "requesting")));
      entered.resolve();
      await cleanup.promise;
      return { state: "waiting", reason: "interrupted" };
    };
    let settled = false;
    const task = f.run().finally(() => { settled = true; });
    await entered.promise;
    f.controller.abort(new Error("fixture caller stop"));
    expect(settled).toBe(false);
    expect(existsSync(f.lockPath)).toBe(true);
    expect(f.readReceipt()).toEqual(receipt(KEY, "requesting"));
    const before = readFileSync(f.statePath, "utf8");
    expect(() => requireCheckpoint(ownedCheckpoint)(JSON.stringify(receipt(KEY, "requested")))).toThrow();
    expect(readFileSync(f.statePath, "utf8")).toBe(before);
    cleanup.resolve();
    expect(await task).toBe(11);
    expect(f.readReceipt()).toEqual(receipt(KEY, "requesting"));
    expect(existsSync(f.lockPath)).toBe(false);
  });
  it("reserves firstTicket evidence against conflicting adapter return values", async () => {
    const f = fixture();
    f.adapter.act = async (_ctx, _journal, _signal, checkpoint) => {
      requireCheckpoint(checkpoint)(JSON.stringify(receipt()));
      return { state: "waiting", reason: "fixture_launch_unverified", evidence: { firstTicket: "not a validated receipt" } };
    };
    expect(await f.run()).toBe(11);
    expect(f.readReceipt()).toEqual(receipt());
  });
  it("refuses a changed original operation key even if the action changes both mutable key and receipt", async () => {
    const f = fixture(receipt());
    let before = "";
    f.adapter.act = async (_ctx, journal, _signal, checkpoint) => {
      before = readFileSync(f.statePath, "utf8");
      journal.operations ??= {};
      journal.operations["first-ticket"] = "replacement-key";
      requireCheckpoint(checkpoint)(JSON.stringify(receipt("replacement-key")));
      return { state: "waiting" };
    };
    expect(await f.run()).toBe(12);
    expect(readFileSync(f.statePath, "utf8")).toBe(before);
    expect(f.readReceipt()).toEqual(receipt());
  });
  it("refuses current config byte changes before checkpoint publication and preserves the last receipt", async () => {
    const f = fixture(receipt());
    let before = "", changedConfig = "";
    f.adapter.act = async (_ctx, _journal, _signal, checkpoint) => {
      before = readFileSync(f.statePath, "utf8");
      changedConfig = `${readFileSync(configPathFor(f.home), "utf8")}\n`;
      writeFileSync(configPathFor(f.home), changedConfig);
      requireCheckpoint(checkpoint)(JSON.stringify(receipt(KEY, "created")));
      return { state: "waiting" };
    };
    expect(await f.run()).toBe(12);
    expect(readFileSync(f.statePath, "utf8")).toBe(before);
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(changedConfig);
  });
  it("refuses a changed in-memory personal binding and does not publish it through the catch path", async () => {
    const f = fixture(receipt());
    let before = "";
    f.adapter.act = async (_ctx, journal, _signal, checkpoint) => {
      before = readFileSync(f.statePath, "utf8");
      journal.membershipId = "other-person";
      requireCheckpoint(checkpoint)(JSON.stringify(receipt(KEY, "created")));
      return { state: "waiting" };
    };
    expect(await f.run()).toBe(12);
    expect(readFileSync(f.statePath, "utf8")).toBe(before);
  });
  it("refuses a changed owner token and preserves foreign owner and journal bytes", async () => {
    const f = fixture(receipt());
    let before = "";
    const foreign = JSON.stringify({ pid: process.pid, token: "foreign-owner-token" });
    f.adapter.act = async (_ctx, _journal, _signal, checkpoint) => {
      before = readFileSync(f.statePath, "utf8");
      writeFileSync(join(f.lockPath, "owner.json"), foreign);
      requireCheckpoint(checkpoint)(JSON.stringify(receipt(KEY, "created")));
      return { state: "waiting" };
    };
    expect(await f.run()).toBe(12);
    expect(readFileSync(f.statePath, "utf8")).toBe(before);
    expect(readFileSync(join(f.lockPath, "owner.json"), "utf8")).toBe(foreign);
  });
  it("preserves a replacement lock directory even when it copies the original PID/token", async () => {
    const f = fixture(receipt());
    let before = "", replacementInode = 0;
    f.adapter.act = async (_ctx, _journal, _signal, checkpoint) => {
      before = readFileSync(f.statePath, "utf8");
      const owner = readFileSync(join(f.lockPath, "owner.json"), "utf8");
      renameSync(f.lockPath, `${f.lockPath}.old-owned`);
      mkdirSync(f.lockPath, { mode: 0o700 });
      writeFileSync(join(f.lockPath, "owner.json"), owner, { mode: 0o600 });
      replacementInode = lstatSync(f.lockPath).ino;
      requireCheckpoint(checkpoint)(JSON.stringify(receipt(KEY, "created")));
      return { state: "waiting" };
    };
    expect(await f.run()).toBe(12);
    expect(readFileSync(f.statePath, "utf8")).toBe(before);
    expect(lstatSync(f.lockPath).ino).toBe(replacementInode);
  });
  it.each(["in-place", "replacement"] as const)("preserves a concurrent %s journal edit after checkpoint refusal and catch", async (mode) => {
    const f = fixture(receipt());
    let foreign = "", inode = 0;
    f.adapter.act = async (_ctx, _journal, _signal, checkpoint) => {
      foreign = `${readFileSync(f.statePath, "utf8")}\n`;
      if (mode === "replacement") {
        const path = `${f.statePath}.foreign`;
        writeFileSync(path, foreign, { mode: 0o600 });
        renameSync(path, f.statePath);
      } else writeFileSync(f.statePath, foreign);
      inode = lstatSync(f.statePath).ino;
      requireCheckpoint(checkpoint)(JSON.stringify(receipt(KEY, "created")));
      return { state: "waiting" };
    };
    expect(await f.run()).toBe(12);
    expect(readFileSync(f.statePath, "utf8")).toBe(foreign);
    expect(lstatSync(f.statePath).ino).toBe(inode);
  });
  it("retires the callback before post-action verification awaits", async () => {
    const f = fixture();
    const checking = deferred<void>(), release = deferred<void>();
    let calls = 0, checkpoint: OnboardCheckpoint | undefined;
    f.adapter.check = async () => {
      calls += 1;
      if (calls === 1) return { state: "pending" };
      checking.resolve();
      await release.promise;
      return { state: "waiting", reason: "fixture_launch_unverified" };
    };
    f.adapter.act = async (_ctx, _journal, _signal, current) => {
      checkpoint = requireCheckpoint(current);
      checkpoint(JSON.stringify(receipt()));
      return { state: "done" };
    };
    const task = f.run();
    await checking.promise;
    const before = readFileSync(f.statePath, "utf8");
    expect(() => requireCheckpoint(checkpoint)(JSON.stringify(receipt(KEY, "created")))).toThrow();
    expect(readFileSync(f.statePath, "utf8")).toBe(before);
    release.resolve();
    expect(await task).toBe(11);
    expect(f.readReceipt()).toEqual(receipt());
  });
  it("refuses a retained callback after return without reacquiring or recreating a lock", async () => {
    const f = fixture();
    let checkpoint: OnboardCheckpoint | undefined;
    f.adapter.act = async (_ctx, _journal, _signal, current) => {
      checkpoint = requireCheckpoint(current);
      checkpoint(JSON.stringify(receipt()));
      return { state: "waiting", reason: "fixture_launch_unverified" };
    };
    expect(await f.run()).toBe(11);
    const before = readFileSync(f.statePath, "utf8");
    expect(() => requireCheckpoint(checkpoint)(JSON.stringify(receipt(KEY, "created")))).toThrow();
    expect(readFileSync(f.statePath, "utf8")).toBe(before);
    expect(existsSync(f.lockPath)).toBe(false);
  });
  it("cleans only the newly owned lock when initial receipt observation finds a changed symlink", async () => {
    const f = fixture();
    const target = join(f.home, "customer-record.json");
    const foreign = readFileSync(f.statePath, "utf8");
    writeFileSync(target, foreign);
    let actions = 0;
    f.adapter.act = async () => { actions += 1; return { state: "waiting" }; };
    f.deps.token = () => {
      rmSync(f.statePath);
      symlinkSync(target, f.statePath);
      return "fixture-new-owner";
    };
    await expect(f.run()).rejects.toMatchObject({ code: "onboard-file-unverified" });
    expect(actions).toBe(0);
    expect(existsSync(f.lockPath)).toBe(false);
    expect(lstatSync(f.statePath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(foreign);
  });
});

describe("first-ticket explicit Later disposition", () => {
  it("keeps the action skipped without a launch receipt and finishes only its requested scope", async () => {
    const f = fixture();
    f.adapter.act = async () => ({ state: "skipped", reason: "first_ticket_not_selected" });
    expect(await f.run()).toBe(0);
    const journal = f.read(), step = journal.steps.find(row => row.id === "first-ticket")!;
    expect(step.state).toBe("skipped"); expect(step.reason).toBe("first_ticket_not_selected");
    expect(step.evidence?.firstTicket).toBeUndefined(); expect(step.evidence?.phaseStarted).toBeUndefined();
    expect(journal.complete).toBe(false); expect(journal.steps.find(row => row.id === "ready")!.state).toBe("waiting");
    expect(existsSync(f.lockPath)).toBe(false);
  });
  it.each(["interrupted", "first_ticket_unavailable", "first_ticket_readiness_unverified"])(
    "does not accept another skipped reason as an optional decision: %s", async reason => {
      const f = fixture(); f.adapter.act = async () => ({ state: "skipped", reason });
      expect(await f.run()).toBe(11); expect(f.read().complete).toBe(false);
      expect(f.read().steps.find(row => row.id === "first-ticket")!.evidence?.phaseStarted).toBeUndefined();
      expect(existsSync(f.lockPath)).toBe(false);
    },
  );
});
