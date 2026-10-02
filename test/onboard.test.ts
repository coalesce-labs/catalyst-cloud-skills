import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  configPathFor,
  contractPathFor,
  defaultCtx,
  loadConfig,
  writeConfig,
  type CustomerConfig,
} from "../src/config.js";
import { CliError } from "../src/errors.js";
import {
  stageOnboardLogin,
  type OnboardLoginCandidate,
} from "../src/onboard-login-candidate.js";
import type { OnboardUi } from "../src/onboard-ui.js";
import { main } from "../src/cli.js";
import {
  cmdOnboard,
  ONBOARD_STEPS,
  onboardLockPath,
  onboardStatePath,
  readOnboardJournal,
  type OnboardDeps,
  type OnboardIdentity,
  type OnboardJournal,
} from "../src/onboard.js";
import { parseArgs } from "../src/args.js";

const homes: string[] = [];
function home(): string {
  const path = mkdtempSync(join(tmpdir(), "catalyst-onboard-"));
  homes.push(path);
  return path;
}

afterEach(() => {
  for (const path of homes.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function context(path: string, output: string[] = [], errors: string[] = []) {
  const base = defaultCtx();
  return {
    ...base,
    home: path,
    env: {} as NodeJS.ProcessEnv,
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errors.push(line),
    now: () => new Date("2026-09-30T14:00:00.000Z"),
  };
}

describe("catalyst onboard", () => {
  test("a refresh-required step saves its cause and stops before later adapters", async () => {
    const path = home();
    let laterChecks = 0;
    const done = { check: async () => ({ state: "done" as const }) };
    const code = await cmdOnboard(parseArgs(["onboard", "--yes"]), context(path), {
      bindSignals: false,
      adapters: {
        machine: done, cli: done, skills: done, legacy: done, signin: done,
        "linear.workspace": { check: async () => ({ state: "waiting", reason: "workspace_login_refresh_required" }) },
        // GitHub install depends only on sign-in, so base code would enter it
        // even after the Linear workspace step asks for a refreshed login.
        "github.install": { check: async () => { laterChecks++; return { state: "pending" }; } },
      },
    }, "0.14.7");
    expect(code).toBe(11);
    expect(laterChecks).toBe(0);
    const journal = readOnboardJournal(onboardStatePath(path), "0.14.7");
    expect(journal?.steps.find(step => step.id === "linear.workspace")).toMatchObject({ state: "waiting", reason: "workspace_login_refresh_required" });
    expect(journal?.steps.find(step => step.id === "github.install")).toMatchObject({ id: "github.install", state: "pending" });
    expect(journal?.complete).toBe(false);
    expect(existsSync(onboardLockPath(path))).toBe(false);
  });

  test("JSON dry run prints one plan object and creates no state or lock", async () => {
    const path = home();
    const output: string[] = [];
    const errors: string[] = [];
    const code = await main(
      ["onboard", "--dry-run", "--json"],
      context(path, output, errors),
    );
    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    const printed = JSON.parse(output[0]!);
    expect(printed).toMatchObject({ schema: 1, exit: null });
    expect(printed.steps[0]).toEqual({ id: "machine", state: "pending" });
    expect(errors).toHaveLength(0);
    expect(() => readFileSync(onboardStatePath(path))).toThrow();
    expect(() => readFileSync(join(onboardLockPath(path), "pid"))).toThrow();
  });

  test("migrates the installer 0.13.4 receipt without losing completed steps", () => {
    const path = home();
    const statePath = onboardStatePath(path);
    mkdirSync(join(path, ".local", "state", "catalyst", "install"), {
      recursive: true,
    });
    writeFileSync(
      statePath,
      JSON.stringify({
        schema: "catalyst-install-last-run/1",
        revision: "0.13.4",
        state: "interrupted",
        exitCode: null,
        startedAt: "2026-09-30T13:00:00.000Z",
        updatedAt: "2026-09-30T13:15:00.000Z",
        steps: [
          { id: "cli", result: "done" },
          { id: "skills", result: "already_done" },
          { id: "folders", result: "done" },
          { id: "sign_in", result: "pending" },
        ],
      }),
    );
    expect(
      readOnboardJournal(
        statePath,
        "0.14.0",
        new Date("2026-09-30T14:00:00.000Z"),
      ),
    ).toMatchObject({
      schema: 1,
      installer: "0.13.4",
      exit: null,
      steps: [
        { id: "cli", state: "done" },
        { id: "skills", state: "done" },
        { id: "machine", state: "done" },
        { id: "signin", state: "pending" },
      ],
    });
  });

  test("records a failed step, then resumes it once the interrupted work can continue", async () => {
    const path = home();
    const output: string[] = [];
    const errors: string[] = [];
    const args = parseArgs(["onboard", "--only", "legacy", "--yes"]);
    const ctx = context(path, output, errors);
    const deps: OnboardDeps = {
      token: () => "first",
      runStep: async () => {
        throw new Error("tool unavailable");
      },
    };
    expect(await cmdOnboard(args, ctx, deps, "0.14.0")).toBe(10);
    expect(
      readOnboardJournal(onboardStatePath(path), "0.14.0")?.steps,
    ).toContainEqual(
      expect.objectContaining({
        id: "legacy",
        state: "failed",
        reason: "step_failed",
      }),
    );
    const resumed = await cmdOnboard(
      args,
      ctx,
      {
        token: () => "second",
        runStep: async () => ({
          state: "done",
          evidence: { found: 1, remaining: 0 },
        }),
      },
      "0.14.0",
    );
    expect(resumed).toBe(0);
    expect(
      readOnboardJournal(onboardStatePath(path), "0.14.0")?.steps,
    ).toContainEqual(
      expect.objectContaining({
        id: "legacy",
        state: "done",
        evidence: { found: 1, remaining: 0 },
      }),
    );
    expect(errors.join("\n")).toContain("safe reason is saved");
  });

  test("refuses to remove another live install lock", async () => {
    const path = home();
    const lock = onboardLockPath(path);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 4242, token: "other" }),
    );
    const output: string[] = [];
    const errors: string[] = [];
    const code = await cmdOnboard(
      parseArgs(["onboard", "--yes"]),
      context(path, output, errors),
      {
        processId: 100,
        isProcessAlive: (pid) => pid === 4242,
      },
    );
    expect(code).toBe(10);
    expect(errors.join("\n")).toContain("already running (pid 4242)");
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toContain("4242");
  });

  test("adopts and releases only the lock handed off by this process", async () => {
    const path = home();
    const lock = onboardLockPath(path);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "77\n");
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 77, token: "handoff-123" }),
    );
    const ctx = context(path);
    ctx.env.CATALYST_INSTALL_LOCK_TOKEN = "handoff-123";
    const code = await cmdOnboard(
      parseArgs(["onboard", "--only", "legacy", "--yes"]),
      ctx,
      {
        processId: 77,
        isProcessAlive: () => true,
      },
    );
    expect(code).toBe(0);
    expect(() => readFileSync(join(lock, "owner.json"))).toThrow();
  });

  test("JSON execution prints the exact receipt written to last-run.json", async () => {
    const path = home();
    mkdirSync(join(path, ".catalyst"));
    writeFileSync(join(path, ".catalyst", "sentinel"), "kept data");
    const output: string[] = [];
    const errors: string[] = [];
    const code = await main(
      ["onboard", "--only", "legacy", "--yes", "--json"],
      context(path, output, errors),
    );
    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual(
      JSON.parse(readFileSync(onboardStatePath(path), "utf8")),
    );
    expect(JSON.parse(output[0]!).steps).toContainEqual(
      expect.objectContaining({
        id: "legacy",
        state: "skipped",
        reason: "fake_home_report_only",
      }),
    );
    expect(existsSync(join(path, ".catalyst"))).toBe(true);
    expect(readFileSync(join(path, ".catalyst", "sentinel"), "utf8")).toBe(
      "kept data",
    );
  });

  test("does not release a lock whose owner token changed while a step ran", async () => {
    const path = home();
    const lock = onboardLockPath(path);
    const code = await cmdOnboard(
      parseArgs(["onboard", "--only", "legacy", "--yes"]),
      context(path),
      {
        processId: 91,
        token: () => "mine",
        runStep: async () => {
          writeFileSync(
            join(lock, "owner.json"),
            JSON.stringify({ pid: 92, token: "replacement" }),
          );
          return { state: "done" };
        },
      },
    );
    expect(code).toBe(0);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toContain(
      "replacement",
    );
  });
});

type Q1Answer = Awaited<ReturnType<OnboardUi["confirmPlan"]>>;
function q1Fixture() {
  const path = home();
  const output: string[] = [];
  const errors: string[] = [];
  const ctx = context(path, output, errors);
  const original: OnboardIdentity = {
    account: "original-account",
    membershipId: "original-person",
    baseUrl: "https://original-cloud.example",
    role: "owner",
  };
  const next: OnboardIdentity = {
    account: "next-account",
    membershipId: "next-person",
    baseUrl: original.baseUrl,
    role: "owner",
  };
  const cfg = (who: OnboardIdentity): CustomerConfig => ({
    baseUrl: who.baseUrl,
    account: who.account,
    slug: who.account,
    name: who.account,
    permissions: null,
    principal: "session",
    user: {
      id: who.membershipId,
      label: who.membershipId,
      email: null,
      role: who.role,
      linearUserId: null,
    },
    key: `fixture-key-${who.membershipId}`,
    joinedAt: ctx.now().toISOString(),
    lastSkillBundleVersion: "0.14.5",
  });
  writeConfig(path, cfg(original));
  const beforeConfig = readFileSync(configPathFor(path), "utf8");
  const statePath = onboardStatePath(path);
  const receipt = (who?: OnboardIdentity): OnboardJournal => ({
    schema: 1,
    runId: "original-run",
    installer: null,
    cli: "0.14.5",
    tenant: who?.account ?? null,
    ...(who
      ? {
          account: who.account,
          membershipId: who.membershipId,
          baseUrl: who.baseUrl,
        }
      : {}),
    exit: null,
    steps: [],
    changes: [],
  });
  const seedReceipt = (value: OnboardJournal) => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(value));
    return readFileSync(statePath, "utf8");
  };
  const stop = new AbortController();
  const statuses: Array<"saved" | "required" | "unavailable" | undefined> = [];
  const answers: Q1Answer[] = [
    { proceed: false, localSync: false, signin: true },
    { proceed: true, localSync: false },
  ];
  let confirm: OnboardUi["confirmPlan"] = async (_local, status) => {
    statuses.push(status);
    return answers.shift() ?? { proceed: false, localSync: false };
  };
  const ui: OnboardUi = {
    signal: stop.signal,
    plan: () => {},
    confirmPlan: (local, status) => confirm(local, status),
    stepStart: () => {},
    stepEnd: () => {},
    message: (line) => output.push(line),
    finish: () => {},
    dispose: () => {},
    wait: async (_message, run) => run(),
  };
  let published = false;
  let acceptCalls = 0;
  let stageCalls = 0;
  let actions = 0;
  let who = original;
  let acceptance: (
    signal: AbortSignal | undefined,
    beforePublish: (() => void) | undefined,
  ) => Promise<void> = async (_signal, beforePublish) => {
    beforePublish?.();
    writeConfig(path, cfg(next));
    who = next;
    published = true;
  };
  const candidate: OnboardLoginCandidate = {
    identity: next,
    get accepted() {
      return published;
    },
    accept: async (signal, beforePublish) => {
      acceptCalls++;
      expect(existsSync(onboardLockPath(path))).toBe(true);
      return acceptance(signal, beforePublish);
    },
  };
  const deps: OnboardDeps = {
    ui,
    bindSignals: false,
    identity: async () => who,
    stageSignin: async () => {
      stageCalls++;
      return candidate;
    },
    adapters: {
      machine: {
        check: async () => {
          actions++;
          return { state: "done" };
        },
      },
    },
  };
  const run = () =>
    cmdOnboard(
      parseArgs(["onboard", "--only", "machine"]),
      ctx,
      deps,
      "0.14.5",
    );
  return {
    path,
    ctx,
    output,
    errors,
    original,
    next,
    cfg,
    beforeConfig,
    statePath,
    receipt,
    seedReceipt,
    stop,
    statuses,
    answers,
    candidate,
    deps,
    run,
    setConfirm: (value: OnboardUi["confirmPlan"]) => {
      confirm = value;
    },
    setAcceptance: (value: typeof acceptance) => {
      acceptance = value;
    },
    setPublished: (value: boolean) => {
      published = value;
    },
    setIdentity: (value: OnboardIdentity) => {
      who = value;
    },
    counts: () => ({ acceptCalls, stageCalls, actions }),
  };
}

describe("plain finish names what is left (CTC-4477)", () => {
  const run = async (
    waits: Partial<Record<string, string>>,
    failures: readonly string[] = [],
  ) => {
    const path = home();
    writeConfig(path, {
      baseUrl: "https://cloud.example.dev/",
      account: "tenant-a",
      slug: "tenant-a",
      name: "tenant-a",
      permissions: null,
      principal: "session",
      key: "personal-key",
      joinedAt: "2026-09-30T13:00:00.000Z",
      lastSkillBundleVersion: "0.14.0",
    });
    const output: string[] = [];
    const adapters: NonNullable<OnboardDeps["adapters"]> = Object.fromEntries(
      ONBOARD_STEPS.map((id) => [
        id,
        {
          check: async () =>
            failures.includes(id)
              ? { state: "failed" as const, reason: "step_failed" }
              : id === "linear.team"
              ? {
                  state: "done" as const,
                  evidence: { team: "team-1", teamKey: "ENG" },
                }
              : waits[id]
                ? { state: "waiting" as const, reason: waits[id] }
                : { state: "done" as const },
        },
      ]),
    );
    const code = await cmdOnboard(
      parseArgs(["onboard", "--yes"]),
      context(path, output),
      { adapters, bindSignals: false },
      "0.14.0",
    );
    const receipt = readOnboardJournal(onboardStatePath(path), "0.14.0")!;
    return { code, text: output.join("\n"), receipt };
  };

  test("--yes lists each unfinished step with its action and keeps the waiting exit", async () => {
    const { code, text } = await run({
      accounts: "account_enrollment_required",
      capacity: "capacity_admission_unverified",
      housekeeping: "housekeeping_service_unverified",
    });
    expect(code).toBe(11);
    expect(text).toContain("Setup still needs 4 checks.");
    expect(text).toContain(
      "Check coding accounts: No coding account is enrolled.",
    );
    expect(text).toContain(
      "https://cloud.example.dev/settings/coding-accounts",
    );
    expect(text).toContain("Check runner capacity: No runner is allowed");
    expect(text).toContain("Schedule the daily update: ");
    expect(text).toContain('Start a first ticket: Runs after "Check coding accounts".');
    expect(text).not.toContain("Onboarding complete");
    expect(text).not.toContain("Move a ticket");
    expect(text).toContain("resume: catalyst onboard");
  });

  test("deferred steps that wait still exit 0 as ready for work, without claiming complete", async () => {
    const { code, text, receipt } = await run({
      settings: "settings_checkout_unverified",
      housekeeping: "housekeeping_service_unverified",
    });
    expect(code).toBe(0);
    expect(receipt).toMatchObject({ exit: 0, complete: false });
    expect(receipt.steps.find((step) => step.id === "values")).toMatchObject({
      state: "waiting",
      reason: "prerequisite_not_ready",
    });
    // first-ticket needs what dispatch needs; repository settings are not part of it.
    expect(
      receipt.steps.find((step) => step.id === "first-ticket"),
    ).toMatchObject({ state: "done" });
    expect(text).toContain("Ready for work.");
    expect(text).toContain("Next, when you want:");
    expect(text).toContain("Review repository settings: ");
    expect(text).toContain(
      'Import selected local values: Runs after "Review repository settings".',
    );
    expect(text).toContain("Schedule the daily update: ");
    expect(text).toContain(
      "Move a ticket in ENG to Todo; `catalyst explain <ticket>` says why it is or is not starting.",
    );
    expect(text).not.toContain("Onboarding complete");
    expect(text).not.toContain("Setup still needs");
  });

  test.each([
    ["capacity", "capacity_admission_unverified"],
    ["linear.adopt", "workflow_mapping_unverified"],
    ["ready", "onboarding_checks_pending"],
  ])("a waiting required step %s still exits 11", async (id, reason) => {
    const { code, receipt } = await run({
      [id]: reason,
      housekeeping: "housekeeping_service_unverified",
    });
    expect(code).toBe(11);
    expect(receipt.complete).toBe(false);
  });

  test.each(["settings", "housekeeping"])(
    "a failed deferred step %s still exits 10",
    async (id) => {
      const { code, text, receipt } = await run({}, [id]);
      expect(code).toBe(10);
      expect(receipt.complete).toBe(false);
      expect(text).not.toContain("Ready for work.");
    },
  );

  test("every step done exits 0 and says onboarding is complete", async () => {
    const { code, text, receipt } = await run({});
    expect(code).toBe(0);
    expect(receipt.complete).toBe(true);
    expect(text).toContain("Onboarding complete.");
    expect(text).not.toContain("Ready for work.");
  });
});

describe("fresh Q1 follows staged identity once", () => {
  function fresh() {
    const f = q1Fixture();
    rmSync(configPathFor(f.path));
    f.deps.identity = async () => (f.candidate.accepted ? f.next : null);
    f.answers.splice(0, f.answers.length, {
      proceed: true,
      localSync: false,
    });
    return f;
  }

  test.each([false, true])(
    "fresh sign-in displays verified identity before its only approval, localSync=%s",
    async (localSync) => {
      const f = fresh();
      const events: string[] = [];
      const stage = f.deps.stageSignin!;
      f.deps.stageSignin = async (signal) => {
        events.push("stage");
        expect(signal).toBe(f.stop.signal);
        expect(f.statuses).toEqual([]);
        expect(existsSync(configPathFor(f.path))).toBe(false);
        expect(existsSync(contractPathFor(f.path))).toBe(false);
        expect(existsSync(f.statePath)).toBe(false);
        expect(existsSync(onboardLockPath(f.path))).toBe(false);
        return stage(signal);
      };
      f.deps.ui!.plan = (_journal, identity) => {
        events.push(identity ? "verified-plan" : "unbound-plan");
        if (identity) expect(identity).toEqual(f.next);
      };
      f.setConfirm(async (initialLocalSync, status) => {
        f.statuses.push(status);
        events.push("question");
        expect(events).toEqual([
          "unbound-plan",
          "stage",
          "verified-plan",
          "question",
        ]);
        expect(initialLocalSync).toBe(false);
        expect(status).toBe("unavailable");
        expect(f.candidate.accepted).toBe(false);
        expect(existsSync(configPathFor(f.path))).toBe(false);
        expect(existsSync(contractPathFor(f.path))).toBe(false);
        expect(existsSync(f.statePath)).toBe(false);
        expect(existsSync(onboardLockPath(f.path))).toBe(false);
        return { proceed: true, localSync };
      });
      f.setAcceptance(async (_signal, beforePublish) => {
        events.push("accept");
        expect(events.at(-2)).toBe("question");
        beforePublish?.();
        writeConfig(f.path, f.cfg(f.next));
        f.setPublished(true);
      });
      expect(await f.run()).toBe(0);
      expect(f.statuses).toEqual(["unavailable"]);
      expect(f.counts()).toEqual({ stageCalls: 1, acceptCalls: 1, actions: 1 });
      expect(loadConfig(f.path)?.account).toBe(f.next.account);
      expect(readOnboardJournal(f.statePath, "0.14.5")).toMatchObject({
        account: f.next.account,
        membershipId: f.next.membershipId,
        baseUrl: f.next.baseUrl,
        localSync,
      });
      expect(f.output.join("\n")).toContain(
        "Your saved connection stays unchanged until you approve that plan",
      );
    },
  );

  test("cancelling C1 asks no plan question and creates no account-local state", async () => {
    const f = fresh();
    let stageCalls = 0;
    f.deps.stageSignin = async (signal) => {
      stageCalls++;
      expect(signal).toBe(f.stop.signal);
      f.stop.abort();
      expect(signal?.aborted).toBe(true);
      throw new CliError("Sign-in paused", "onboard-signin-paused", 11);
    };
    expect(await f.run()).toBe(11);
    expect(stageCalls).toBe(1);
    expect(f.statuses).toEqual([]);
    expect(f.counts()).toEqual({ stageCalls: 0, acceptCalls: 0, actions: 0 });
    expect(existsSync(configPathFor(f.path))).toBe(false);
    expect(existsSync(contractPathFor(f.path))).toBe(false);
    expect(existsSync(f.statePath)).toBe(false);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test("an explicit local-sync preference can be declined inside the only post-sign-in Q1", async () => {
    const f = fresh();
    f.setConfirm(async (initialLocalSync, status) => {
      f.statuses.push(status);
      expect(initialLocalSync).toBe(true);
      return { proceed: true, localSync: false };
    });
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "machine", "--local-sync"]),
        f.ctx,
        f.deps,
        "0.14.5",
      ),
    ).toBe(0);
    expect(f.statuses).toEqual(["unavailable"]);
    expect(f.counts()).toEqual({ stageCalls: 1, acceptCalls: 1, actions: 1 });
    expect(readOnboardJournal(f.statePath, "0.14.5")?.localSync).toBe(false);
  });

  test.each([false, true])(
    "stopping its only post-sign-in Q1 preserves absent config, stale cache and receipt, cancel=%s",
    async (cancel) => {
      const f = fresh();
      writeFileSync(contractPathFor(f.path), "existing-unbound-cache");
      const receiptBytes = f.seedReceipt(f.receipt());
      const displayed: Array<OnboardIdentity | null | undefined> = [];
      f.deps.ui!.plan = (_journal, identity) => displayed.push(identity);
      f.setConfirm(async (_local, status) => {
        f.statuses.push(status);
        expect(displayed.at(-1)).toEqual(f.next);
        if (cancel) f.stop.abort();
        return { proceed: false, localSync: false };
      });
      expect(await f.run()).toBe(cancel ? 11 : 0);
      expect(f.statuses).toEqual(["unavailable"]);
      expect(f.counts()).toEqual({ stageCalls: 1, acceptCalls: 0, actions: 0 });
      expect(existsSync(configPathFor(f.path))).toBe(false);
      expect(readFileSync(contractPathFor(f.path), "utf8")).toBe(
        "existing-unbound-cache",
      );
      expect(readFileSync(f.statePath, "utf8")).toBe(receiptBytes);
      expect(existsSync(onboardLockPath(f.path))).toBe(false);
    },
  );

  test.each(["C1", "Q1"])(
    "an unbound installer handoff stopped at %s preserves bootstrap receipt and owner bytes",
    async (stopAt) => {
      const f = fresh();
      const receiptBytes = f.seedReceipt(f.receipt());
      const lock = onboardLockPath(f.path);
      mkdirSync(lock, { recursive: true });
      const ownerBytes = JSON.stringify({
        pid: 77,
        token: "fresh-handoff-token",
      });
      writeFileSync(join(lock, "owner.json"), ownerBytes);
      writeFileSync(contractPathFor(f.path), "bootstrap-cache");
      f.ctx.env.CATALYST_INSTALL_LOCK_TOKEN = "fresh-handoff-token";
      f.deps.processId = 77;
      f.deps.isProcessAlive = () => true;
      if (stopAt === "C1") {
        f.deps.stageSignin = async () => {
          throw new CliError("Sign-in paused", "onboard-signin-paused", 11);
        };
      } else {
        f.setConfirm(async (_local, status) => {
          f.statuses.push(status);
          return { proceed: false, localSync: false };
        });
      }
      expect(
        await cmdOnboard(
          parseArgs(["onboard", "--resume-from", "install"]),
          f.ctx,
          f.deps,
          "0.14.5",
        ),
      ).toBe(stopAt === "C1" ? 11 : 0);
      expect(f.statuses).toEqual(stopAt === "C1" ? [] : ["unavailable"]);
      expect(f.counts().acceptCalls).toBe(0);
      expect(f.counts().actions).toBe(0);
      expect(existsSync(configPathFor(f.path))).toBe(false);
      expect(readFileSync(contractPathFor(f.path), "utf8")).toBe(
        "bootstrap-cache",
      );
      expect(readFileSync(f.statePath, "utf8")).toBe(receiptBytes);
      expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(ownerBytes);
    },
  );

  test.each(["account", "membershipId", "baseUrl"])(
    "automatic renewal refuses a changed bound %s before asking Q1",
    async (field) => {
      const f = q1Fixture();
      const bound: OnboardIdentity =
        field === "account"
          ? { ...f.next, account: "bound-original-account" }
          : field === "membershipId"
            ? { ...f.next, membershipId: "bound-original-person" }
            : { ...f.next, baseUrl: "https://bound-original-cloud.example" };
      writeConfig(f.path, f.cfg(bound));
      const configBytes = readFileSync(configPathFor(f.path), "utf8");
      const receiptBytes = f.seedReceipt(f.receipt(bound));
      writeFileSync(contractPathFor(f.path), "bound-cache");
      f.deps.identity = async () => {
        throw new CliError("Renew login", "onboard-login-refresh-required", 11);
      };
      expect(await f.run()).toBe(12);
      expect(f.statuses).toEqual([]);
      expect(f.counts()).toEqual({ stageCalls: 1, acceptCalls: 0, actions: 0 });
      expect(readFileSync(configPathFor(f.path), "utf8")).toBe(configBytes);
      expect(readFileSync(contractPathFor(f.path), "utf8")).toBe("bound-cache");
      expect(readFileSync(f.statePath, "utf8")).toBe(receiptBytes);
      expect(existsSync(onboardLockPath(f.path))).toBe(false);
    },
  );

  test("automatic same-person renewal asks once and preserves run and operation identity", async () => {
    const f = q1Fixture();
    writeConfig(f.path, f.cfg(f.next));
    const receipt = f.receipt(f.next);
    receipt.operations = { "linear.personal": "existing-operation" };
    f.seedReceipt(receipt);
    f.deps.identity = async () => {
      throw new CliError("Renew login", "onboard-login-refresh-required", 11);
    };
    f.setConfirm(async (_local, status) => {
      f.statuses.push(status);
      return { proceed: true, localSync: false };
    });
    expect(await f.run()).toBe(0);
    expect(f.statuses).toEqual(["unavailable"]);
    expect(f.counts()).toEqual({ stageCalls: 1, acceptCalls: 1, actions: 1 });
    expect(readOnboardJournal(f.statePath, "0.14.5")).toMatchObject({
      runId: "original-run",
      account: f.next.account,
      membershipId: f.next.membershipId,
      baseUrl: f.next.baseUrl,
      operations: { "linear.personal": "existing-operation" },
    });
  });

  test("stopping after automatic same-person renewal preserves saved config, cache and bound receipt bytes", async () => {
    const f = q1Fixture();
    writeConfig(f.path, f.cfg(f.next));
    const configBytes = readFileSync(configPathFor(f.path), "utf8");
    const receiptBytes = f.seedReceipt(f.receipt(f.next));
    writeFileSync(contractPathFor(f.path), "renewal-cache");
    f.deps.identity = async () => {
      throw new CliError("Renew login", "onboard-login-refresh-required", 11);
    };
    f.setConfirm(async (_local, status) => {
      f.statuses.push(status);
      return { proceed: false, localSync: false };
    });
    expect(await f.run()).toBe(0);
    expect(f.statuses).toEqual(["unavailable"]);
    expect(f.counts()).toEqual({ stageCalls: 1, acceptCalls: 0, actions: 0 });
    expect(readFileSync(configPathFor(f.path), "utf8")).toBe(configBytes);
    expect(readFileSync(contractPathFor(f.path), "utf8")).toBe("renewal-cache");
    expect(readFileSync(f.statePath, "utf8")).toBe(receiptBytes);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test("a verified saved login continues with one Q1 and no staging or config rewrite", async () => {
    const f = q1Fixture();
    f.setConfirm(async (_local, status) => {
      f.statuses.push(status);
      return { proceed: true, localSync: false };
    });
    expect(await f.run()).toBe(0);
    expect(f.statuses).toEqual(["saved"]);
    expect(f.counts()).toEqual({ stageCalls: 0, acceptCalls: 0, actions: 1 });
    expect(readFileSync(configPathFor(f.path), "utf8")).toBe(f.beforeConfig);
    expect(readOnboardJournal(f.statePath, "0.14.5")).toMatchObject({
      account: f.original.account,
      membershipId: f.original.membershipId,
      baseUrl: f.original.baseUrl,
    });
  });

  test("switching a saved login displays the new identity for a second Q1 before acceptance", async () => {
    const f = q1Fixture();
    const displayed: Array<OnboardIdentity | null | undefined> = [];
    f.deps.ui!.plan = (_journal, identity) => displayed.push(identity);
    f.setConfirm(async (_local, status) => {
      f.statuses.push(status);
      expect(f.candidate.accepted).toBe(false);
      expect(readFileSync(configPathFor(f.path), "utf8")).toBe(f.beforeConfig);
      if (status === "saved") {
        expect(displayed.at(-1)).toEqual(f.original);
        return { proceed: false, localSync: false, signin: true };
      }
      expect(status).toBe("unavailable");
      expect(displayed.at(-1)).toEqual(f.next);
      return { proceed: true, localSync: false };
    });
    expect(await f.run()).toBe(0);
    expect(f.statuses).toEqual(["saved", "unavailable"]);
    expect(f.counts()).toEqual({ stageCalls: 1, acceptCalls: 1, actions: 1 });
    expect(loadConfig(f.path)?.account).toBe(f.next.account);
  });
});

describe("Q1 staged identity publication", () => {
  test("stopping after the live staged preview preserves original credentials and absent receipt", async () => {
    const f = q1Fixture();
    f.answers[1] = { proceed: false, localSync: false };
    writeFileSync(contractPathFor(f.path), "original-account-cache");
    expect(await f.run()).toBe(0);
    expect(readFileSync(contractPathFor(f.path), "utf8")).toBe(
      "original-account-cache",
    );
    expect(readFileSync(configPathFor(f.path), "utf8")).toBe(f.beforeConfig);
    expect(existsSync(f.statePath)).toBe(false);
    expect(f.counts()).toEqual({ stageCalls: 1, acceptCalls: 0, actions: 0 });
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test.each([false, true])(
    "a fresh receipt accepts the displayed identity before any adapter, with localSync=%s",
    async (localSync) => {
      const f = q1Fixture();
      f.answers[1] = { proceed: true, localSync };
      f.deps.adapters = {
        machine: {
          check: async () => {
            expect(loadConfig(f.path)?.account).toBe(f.next.account);
            expect(readOnboardJournal(f.statePath, "0.14.5")).toMatchObject({
              account: f.next.account,
              membershipId: f.next.membershipId,
              baseUrl: f.next.baseUrl,
              localSync,
            });
            return { state: "done" };
          },
        },
      };
      expect(await f.run()).toBe(0);
      expect(f.counts().acceptCalls).toBe(1);
      expect(readOnboardJournal(f.statePath, "0.14.5")?.localSync).toBe(
        localSync,
      );
      expect(f.statuses).toEqual(["saved", "unavailable"]);
    },
  );

  test.each(["account", "membershipId", "baseUrl"])(
    "a bound receipt refuses a different candidate %s without either publication",
    async (field) => {
      const f = q1Fixture();
      // Use separate complete identities, rather than a private production cast or bypass.
      const bound: OnboardIdentity =
        field === "account"
          ? { ...f.next, account: "other-account" }
          : field === "membershipId"
            ? { ...f.next, membershipId: "other-person" }
            : { ...f.next, baseUrl: "https://another-cloud.example" };
      f.setIdentity(bound);
      const beforeReceipt = f.seedReceipt(f.receipt(bound));
      expect(await f.run()).toBe(12);
      expect(readFileSync(configPathFor(f.path), "utf8")).toBe(f.beforeConfig);
      expect(readFileSync(f.statePath, "utf8")).toBe(beforeReceipt);
      expect(f.counts()).toEqual({ stageCalls: 1, acceptCalls: 0, actions: 0 });
    },
  );

  test("same-identity renewal preserves the original run and operation identity", async () => {
    const f = q1Fixture();
    const bound = f.receipt(f.next);
    bound.operations = { "linear.personal": "original-operation" };
    f.seedReceipt(bound);
    f.setIdentity(f.next);
    expect(await f.run()).toBe(0);
    expect(readOnboardJournal(f.statePath, "0.14.5")).toMatchObject({
      runId: "original-run",
      account: f.next.account,
      membershipId: f.next.membershipId,
      operations: { "linear.personal": "original-operation" },
    });
    expect(f.counts().acceptCalls).toBe(1);
  });

  test("a receipt replaced during review is preserved and prevents cfg acceptance even with unchanged binding", async () => {
    const f = q1Fixture();
    const initial = f.receipt(f.next);
    f.seedReceipt(initial);
    f.setIdentity(f.next);
    let questions = 0;
    let foreign = "";
    f.setConfirm(async () => {
      if (++questions === 1)
        return { proceed: false, localSync: false, signin: true };
      foreign = f.seedReceipt({ ...initial, runId: "concurrent-run" });
      return { proceed: true, localSync: false };
    });
    expect(await f.run()).toBe(11);
    expect(readFileSync(configPathFor(f.path), "utf8")).toBe(f.beforeConfig);
    expect(readFileSync(f.statePath, "utf8")).toBe(foreign);
    expect(f.counts().acceptCalls).toBe(0);
  });

  test("SIGINT during candidate revalidation does not create a foreign-bound receipt or publish config", async () => {
    const f = q1Fixture();
    const prior = new Set(process.listeners("SIGINT"));
    f.deps.bindSignals = true;
    f.setAcceptance(async (signal) => {
      // Deliver only this command's newly installed handler; do not signal the test harness.
      const owned = process
        .listeners("SIGINT")
        .filter((listener) => !prior.has(listener));
      expect(owned).toHaveLength(1);
      for (const listener of owned) listener("SIGINT");
      expect(signal?.aborted).toBe(true);
      throw new CliError("Sign-in paused", "onboard-signin-paused", 11);
    });
    expect(await f.run()).toBe(11);
    expect(readFileSync(configPathFor(f.path), "utf8")).toBe(f.beforeConfig);
    expect(existsSync(f.statePath)).toBe(false);
    expect(f.counts().actions).toBe(0);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
    expect(process.listeners("SIGINT")).toEqual([...prior]);
  });

  test("an accepted connection with a failed receipt write is explicitly incomplete and safely resumable", async () => {
    const f = q1Fixture();
    f.setAcceptance(async (_signal, beforePublish) => {
      beforePublish?.();
      writeConfig(f.path, f.cfg(f.next));
      f.setIdentity(f.next);
      f.setPublished(true);
      writeFileSync(dirname(f.statePath), "receipt-parent-blocked");
    });
    expect(await f.run()).toBe(11);
    expect(loadConfig(f.path)?.account).toBe(f.next.account);
    expect(f.errors.join("\n")).toContain("connection was accepted");
    expect(f.errors.join("\n")).not.toContain("Nothing was changed");
    expect(f.counts().actions).toBe(0);
    rmSync(dirname(f.statePath));
    f.answers.push({ proceed: true, localSync: false });
    expect(await f.run()).toBe(0);
    expect(readOnboardJournal(f.statePath, "0.14.5")).toMatchObject({
      account: f.next.account,
      membershipId: f.next.membershipId,
    });
  });

  test("one staged attempt cannot introduce a repeated sign-in question loop", async () => {
    const f = q1Fixture();
    f.setConfirm(async (_local, status) => {
      f.statuses.push(status);
      return { proceed: false, localSync: false, signin: true };
    });
    expect(await f.run()).toBe(0);
    expect(f.counts().stageCalls).toBe(1);
    expect(f.statuses).toEqual(["saved", "unavailable"]);
    expect(f.counts().acceptCalls).toBe(0);
  });

  test("an installer handoff lock never substitutes for personal Q1 consent", async () => {
    const f = q1Fixture();
    const lock = onboardLockPath(f.path);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 77, token: "handoff-token" }),
    );
    f.ctx.env.CATALYST_INSTALL_LOCK_TOKEN = "handoff-token";
    f.deps.processId = 77;
    f.deps.isProcessAlive = () => true;
    f.setConfirm(async () => {
      f.statuses.push("saved");
      return { proceed: false, localSync: false };
    });
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--resume-from", "install"]),
        f.ctx,
        f.deps,
      ),
    ).toBe(0);
    expect(f.statuses).toHaveLength(1);
    expect(readFileSync(configPathFor(f.path), "utf8")).toBe(f.beforeConfig);
    expect(existsSync(f.statePath)).toBe(false);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toContain(
      "handoff-token",
    );
  });

  test("an untrusted staged network error cannot expose credential text in the Q1 output", async () => {
    const f = q1Fixture();
    const sentinel = "private-credential-in-transport-error";
    f.deps.stageSignin = async () => {
      throw new Error(sentinel);
    };
    expect(await f.run()).toBe(11);
    expect([...f.output, ...f.errors].join("\n")).not.toContain(sentinel);
    expect(f.output.join("\n")).toContain("Sign-in could not be verified");
    expect(readFileSync(configPathFor(f.path), "utf8")).toBe(f.beforeConfig);
    expect(existsSync(f.statePath)).toBe(false);
    expect(f.counts().actions).toBe(0);
  });

  test("an untrusted acceptance network error cannot expose credential text or record an unaccepted identity", async () => {
    const f = q1Fixture();
    const sentinel = "private-credential-in-accept-error";
    f.setAcceptance(async () => {
      throw new Error(sentinel);
    });
    expect(await f.run()).toBe(11);
    expect([...f.output, ...f.errors].join("\n")).not.toContain(sentinel);
    expect(f.errors.join("\n")).toContain("Sign-in was not accepted");
    expect(readFileSync(configPathFor(f.path), "utf8")).toBe(f.beforeConfig);
    expect(existsSync(f.statePath)).toBe(false);
    expect(f.counts().actions).toBe(0);
  });

  test("a real staged candidate refuses a receipt change during its second live contract read", async () => {
    const f = q1Fixture();
    const access = `e30.${Buffer.from(JSON.stringify({ exp: f.ctx.now().getTime() / 1000 + 3600, sid: "real-stage" })).toString("base64url")}.fixture`;
    let contracts = 0;
    let foreign = "";
    f.ctx.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/v1/auth/cli"))
        return Response.json({
          clientId: "fixture",
          issuer: "https://auth.example",
          deviceAuthorizationUrl: "https://auth.example/device",
          tokenUrl: "https://auth.example/token",
          jwksUrl: "https://auth.example/jwks",
        });
      if (url.endsWith("/device"))
        return Response.json({
          device_code: "fixture-device",
          user_code: "TEST-1234",
          verification_uri: "https://auth.example/approve",
          expires_in: 300,
          interval: 1,
        });
      if (url.endsWith("/token"))
        return Response.json({
          access_token: access,
          refresh_token: "fixture-refresh",
        });
      if (url.endsWith("/api/v1/me"))
        return Response.json({
          account: f.next.account,
          slug: "next",
          name: "Next",
          principal: "session",
          permissions: null,
          user: {
            id: f.next.membershipId,
            label: "Next Person",
            email: null,
            role: "owner",
            linearUserId: null,
          },
        });
      if (url.endsWith("/api/v1/agent/contract")) {
        if (++contracts === 2)
          foreign = f.seedReceipt({
            ...f.receipt(),
            runId: "foreign-during-validation",
          });
        return Response.json({
          account: { id: f.next.account },
          contractVersion: "2.10.0",
          teams: [],
          routes: [],
        });
      }
      throw new Error("unexpected fixture route");
    };
    f.deps.stageSignin = (signal) =>
      stageOnboardLogin(f.ctx, {
        signal,
        device: { isTty: () => false, sleep: async () => {} },
      });
    expect(await f.run()).toBe(11);
    expect(contracts).toBe(2);
    expect(readFileSync(configPathFor(f.path), "utf8")).toBe(f.beforeConfig);
    expect(readFileSync(f.statePath, "utf8")).toBe(foreign);
    expect(f.counts().actions).toBe(0);
    expect(f.errors.join("\n")).toContain("setup record changed");
  });
});
