import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { main } from "../src/cli.js";
import {
  configPathFor,
  loadConfig,
  writeConfig,
  type Ctx,
  type CustomerConfig,
} from "../src/config.js";
import { CliError } from "../src/errors.js";
import {
  bootstrapPlanHash,
  createBootstrapPreview,
  parseBootstrapPlan,
  type ApprovedBootstrap,
  type BootstrapPlan,
  type OnboardBootstrapPreview,
} from "../src/onboard-bootstrap.js";
import {
  cmdOnboard,
  onboardLockPath,
  onboardStatePath,
  readOnboardJournal,
  type OnboardDeps,
  type OnboardIdentity,
  type OnboardJournal,
  type OnboardStepResult,
} from "../src/onboard.js";
import type { OnboardLoginCandidate } from "../src/onboard-login-candidate.js";
import type { OnboardUi } from "../src/onboard-ui.js";

// These controls exercise public orchestration ports, actual private test homes and real Node children.
// They do not implement or claim the installer/private-FD protocol, device flow or live /me authority.
const homes: string[] = [];
const children: Array<{ child: ChildProcess; joined: Promise<number | null> }> =
  [];
afterEach(async () => {
  // Failure teardown only. Positive tests assert natural child exit before lock release themselves.
  for (const { child, joined } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await joined;
  }
  vi.restoreAllMocks();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function bytes(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
function tree(home: string): Array<[string, string | null]> {
  const rows: Array<[string, string | null]> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name),
        relative = path.slice(home.length + 1);
      rows.push([
        relative,
        entry.isDirectory() ? null : readFileSync(path, "utf8"),
      ]);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(home);
  return rows.sort(([a], [b]) => a.localeCompare(b));
}
function rawPlan(home: string) {
  return {
    schema: 1,
    home,
    origin: "https://cloud.example.test",
    platform: "linux",
    arch: "x64",
    cliPath: join(home, ".local/bin/catalyst"),
    skillsPath: join(home, ".agents/skills"),
    statePath: onboardStatePath(home),
    dailyUpdate: false,
    artifacts: [
      { kind: "runtime", version: "24.21.0", sha256: "a".repeat(64) },
      { kind: "cli", version: "0.14.6", sha256: "b".repeat(64) },
      { kind: "skills", version: "0.14.6", sha256: "c".repeat(64) },
      { kind: "installer", version: "0.14.6", sha256: "d".repeat(64) },
    ],
  };
}
const person: OnboardIdentity = {
  account: "workspace-one",
  membershipId: "person-one",
  baseUrl: "https://cloud.example.test",
  role: "owner",
  display: {
    personLabel: "Verified Person",
    email: "person@example.test",
    workspaceName: "Verified Workspace",
    workspaceSlug: "workspace-one",
  },
};
function config(who: OnboardIdentity): CustomerConfig {
  return {
    account: who.account,
    baseUrl: who.baseUrl,
    key: "ctc_user_private_test_key",
    principal: "service",
    permissions: ["mirror:read"],
    slug: who.account,
    name: who.account,
    user: {
      id: who.membershipId,
      role: who.role,
      label: "Verified Person",
      email: "person@example.test",
      linearUserId: null,
    },
    joinedAt: "2026-10-01T00:00:00.000Z",
    lastSkillBundleVersion: "0.14.6",
  };
}
function fixture(saved = true) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "onboard-bootstrap-"));
  homes.push(home);
  if (saved) writeConfig(home, config(person));
  const events: string[] = [],
    output: string[] = [],
    errors: string[] = [];
  const stop = new AbortController();
  const ctx: Ctx = {
    home,
    env: {},
    now: () => new Date("2026-10-01T09:00:00.000Z"),
    fetch: vi.fn<typeof fetch>(async () => {
      throw new Error("unexpected provider I/O");
    }),
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  };
  let answer = true,
    localSync = false;
  let onConfirm: (() => void) | undefined;
  let recheck: () => Promise<void> = async () => {};
  let continuation: OnboardBootstrapPreview["continue"] = async () => {};
  let assertCurrent = () => {};
  let currentPlan: BootstrapPlan = parseBootstrapPlan(rawPlan(home));
  const childEntry = vi.fn<OnboardBootstrapPreview["continue"]>(
    async (approved, signal) => {
      events.push("continuation");
      await continuation(approved, signal);
    },
  );
  const machine = vi.fn<() => Promise<OnboardStepResult>>(async () => ({
    state: "waiting",
    reason: "fixture_machine_readiness_unverified",
  }));
  const ui: OnboardUi = {
    signal: stop.signal,
    plan: (_journal, identity) =>
      events.push(identity ? "verified-person-plan" : "unbound-plan"),
    confirmPlan: vi.fn(async () => {
      events.push("Q1");
      onConfirm?.();
      return { proceed: answer, localSync };
    }),
    stepStart: () => {},
    stepEnd: () => {},
    message: (text) => {
      if (text.startsWith("Install on ")) events.push("install-plan");
    },
    finish: () => {},
    dispose: () => {},
    wait: async (_text, run) => run(),
  };
  const preview: OnboardBootstrapPreview = {
    get plan() {
      return currentPlan;
    },
    recheck: async () => {
      events.push(
        existsSync(onboardLockPath(home))
          ? "recheck-owned"
          : "recheck-unlocked",
      );
      await recheck();
    },
    assertCurrent: () => {
      events.push("assert-current");
      assertCurrent();
    },
    continue: childEntry,
  };
  const identity = vi.fn(async (): Promise<OnboardIdentity | null> => {
    const cfg = loadConfig(home);
    if (!cfg?.user) return null;
    return {
      account: cfg.account,
      membershipId: cfg.user.id,
      baseUrl: cfg.baseUrl,
      role: cfg.user.role,
      display: person.display,
    };
  });
  const deps: OnboardDeps = {
    bootstrap: preview,
    ui,
    identity,
    bindSignals: false,
    signal: stop.signal,
    adapters: { machine: { check: machine } },
  };
  const run = () => cmdOnboard(parseArgs(["onboard"]), ctx, deps, "0.14.6");
  const stage = () => {
    let accepted = false;
    const candidate: OnboardLoginCandidate = {
      identity: person,
      get accepted() {
        return accepted;
      },
      async accept(signal, beforePublish) {
        expect(signal?.aborted).not.toBe(true);
        expect(existsSync(onboardLockPath(home))).toBe(true);
        beforePublish?.();
        events.push("candidate-accepted");
        writeConfig(home, config(person));
        accepted = true;
      },
    };
    deps.stageSignin = vi.fn(async () => {
      events.push("staged-person");
      return candidate;
    });
    return candidate;
  };
  return {
    home,
    ctx,
    deps,
    stop,
    events,
    output,
    errors,
    ui,
    identity,
    childEntry,
    machine,
    run,
    stage,
    setAnswer: (value: boolean) => {
      answer = value;
    },
    setLocalSync: (value: boolean) => {
      localSync = value;
    },
    setConfirm: (value: () => void) => {
      onConfirm = value;
    },
    setRecheck: (value: typeof recheck) => {
      recheck = value;
    },
    setContinue: (value: typeof continuation) => {
      continuation = value;
    },
    setAssertCurrent: (value: () => void) => {
      assertCurrent = value;
    },
    setPlan: (value: BootstrapPlan) => {
      currentPlan = value;
    },
  };
}
function receipt(home: string): OnboardJournal {
  return {
    schema: 1,
    runId: "existing-run",
    installer: null,
    cli: "0.14.6",
    tenant: person.account,
    account: person.account,
    membershipId: person.membershipId,
    baseUrl: person.baseUrl,
    exit: null,
    steps: [],
    changes: [],
  };
}
function seedReceipt(home: string): string {
  const path = onboardStatePath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(receipt(home)));
  return readFileSync(path, "utf8");
}
function nativeChild(
  approved: ApprovedBootstrap,
  artifact: string,
  partial = false,
  failure = false,
) {
  const entered = deferred<void>();
  const script = `const fs=require('node:fs');const owner=JSON.parse(fs.readFileSync(process.argv[2]+'/owner.json','utf8'));if(owner.pid!==process.ppid||owner.token!==process.argv[3])process.exit(92);${partial ? "fs.writeFileSync(process.argv[1],'partial-native-test-artifact');" : ""}process.stdout.write('entered\\n');process.stdin.once('data',()=>{${failure ? "process.exit(7)" : "process.exit(0)"}});`;
  const child = spawn(
    process.execPath,
    ["-e", script, artifact, approved.lockPath, approved.ownerToken],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const joined = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdout?.on("data", (chunk) => {
    if (String(chunk).includes("entered")) entered.resolve();
  });
  children.push({ child, joined });
  return {
    child,
    entered: entered.promise,
    joined,
    release: () => child.stdin?.end("release\n"),
  };
}

describe("closed bootstrap plan and single-use native capability", () => {
  test("copies and freezes canonical artifact evidence without mutating the caller", () => {
    const f = fixture(false),
      raw = rawPlan(f.home),
      plan = parseBootstrapPlan(raw),
      hash = bootstrapPlanHash(plan);
    raw.artifacts[0]!.sha256 = "f".repeat(64);
    raw.dailyUpdate = true;
    expect(bootstrapPlanHash(plan)).toBe(hash);
    expect(plan.dailyUpdate).toBe(false);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.artifacts)).toBe(true);
    expect(plan.artifacts.every(Object.isFrozen)).toBe(true);
    expect(
      bootstrapPlanHash({ ...plan, artifacts: [...plan.artifacts].reverse() }),
    ).toBe(hash);
  });
  test.each([
    {
      name: "foreign schema",
      change: (p: ReturnType<typeof rawPlan>) => ({ ...p, schema: 2 }),
    },
    {
      name: "unadvertised provider field",
      change: (p: ReturnType<typeof rawPlan>) => ({
        ...p,
        providerUrl: "https://provider.example.test",
      }),
    },
    {
      name: "noncanonical path",
      change: (p: ReturnType<typeof rawPlan>) => ({
        ...p,
        cliPath: p.home + "/../catalyst",
      }),
    },
    {
      name: "relative path",
      change: (p: ReturnType<typeof rawPlan>) => ({
        ...p,
        cliPath: "bin/catalyst",
      }),
    },
    {
      name: "HTTP origin",
      change: (p: ReturnType<typeof rawPlan>) => ({
        ...p,
        origin: "http://cloud.example.test",
      }),
    },
    {
      name: "credential in origin",
      change: (p: ReturnType<typeof rawPlan>) => ({
        ...p,
        origin: "https://token@cloud.example.test",
      }),
    },
    {
      name: "duplicate artifact kind",
      change: (p: ReturnType<typeof rawPlan>) => ({
        ...p,
        artifacts: [p.artifacts[0], p.artifacts[0], ...p.artifacts.slice(2)],
      }),
    },
    {
      name: "malformed SHA",
      change: (p: ReturnType<typeof rawPlan>) => ({
        ...p,
        artifacts: p.artifacts.map((a) => ({ ...a, sha256: "bad" })),
      }),
    },
    {
      name: "terminal control in version",
      change: (p: ReturnType<typeof rawPlan>) => ({
        ...p,
        artifacts: p.artifacts.map((a) => ({
          ...a,
          version: "0.14.6\naccept",
        })),
      }),
    },
  ])("rejects $name before filesystem work", ({ change }) => {
    const f = fixture(false),
      before = tree(f.home);
    expect(() => parseBootstrapPlan(change(rawPlan(f.home)))).toThrow(CliError);
    expect(tree(f.home)).toEqual(before);
  });
  test("consumes before entering a failed continuation, refusing replay and later rechecks", async () => {
    const f = fixture(),
      entry = vi.fn(async () => {
        throw new Error("actual stage refused");
      });
    const plan = parseBootstrapPlan(rawPlan(f.home)),
      preview = createBootstrapPreview(plan, {
        recheck: async () => {},
        assertCurrent: () => {},
        continue: entry,
      });
    const approved: ApprovedBootstrap = {
      plan,
      planHash: bootstrapPlanHash(plan),
      account: person.account,
      person: person.membershipId,
      origin: person.baseUrl,
      role: "owner",
      localSync: false,
      runId: "run-one",
      lockPath: onboardLockPath(f.home),
      ownerPid: process.pid,
      ownerToken: "owned-token",
    };
    await expect(
      preview.continue(approved, new AbortController().signal),
    ).rejects.toThrow("actual stage refused");
    await expect(
      preview.continue(approved, new AbortController().signal),
    ).rejects.toThrow(CliError);
    await expect(preview.recheck()).rejects.toThrow(CliError);
    expect(entry).toHaveBeenCalledTimes(1);
  });
  test("a failed final synchronous witness consumes the preview before any persistent port", async () => {
    const f = fixture(),
      plan = parseBootstrapPlan(rawPlan(f.home)),
      entry = vi.fn(async () => {}),
      check = vi.fn(() => {
        throw new CliError(
          "Artifact witness changed",
          "bootstrap-witness-changed",
          11,
        );
      });
    const preview = createBootstrapPreview(plan, {
      recheck: async () => {},
      assertCurrent: check,
      continue: entry,
    });
    const approved: ApprovedBootstrap = {
      plan,
      planHash: bootstrapPlanHash(plan),
      account: person.account,
      person: person.membershipId,
      origin: person.baseUrl,
      role: "owner",
      localSync: false,
      runId: "run-one",
      lockPath: onboardLockPath(f.home),
      ownerPid: process.pid,
      ownerToken: "owned-token",
    };
    await expect(
      preview.continue(approved, new AbortController().signal),
    ).rejects.toMatchObject({ code: "bootstrap-witness-changed" });
    await expect(
      preview.continue(approved, new AbortController().signal),
    ).rejects.toMatchObject({ code: "onboard-bootstrap-plan" });
    expect(check).toHaveBeenCalledTimes(1);
    expect(entry).not.toHaveBeenCalled();
  });
  test("synchronous final witness reentry reserves one continuation before either persistent stage", async () => {
    const f = fixture(),
      file = join(f.home, "native-port-entry-count");
    const plan = parseBootstrapPlan(rawPlan(f.home));
    const approved: ApprovedBootstrap = {
      plan,
      planHash: bootstrapPlanHash(plan),
      account: person.account,
      person: person.membershipId,
      origin: person.baseUrl,
      role: "owner",
      localSync: false,
      runId: "run-one",
      lockPath: onboardLockPath(f.home),
      ownerPid: process.pid,
      ownerToken: "owned-token",
    };
    let reentered = false;
    let inner: Promise<void> | undefined;
    const preview = createBootstrapPreview(plan, {
      recheck: async () => {},
      assertCurrent: () => {
        if (!reentered) {
          reentered = true;
          inner = preview.continue(approved, new AbortController().signal);
          void inner.catch(() => {});
        }
      },
      continue: async () => {
        writeFileSync(file, String(Number(bytes(file) ?? "0") + 1));
      },
    });
    await preview.continue(approved, new AbortController().signal);
    expect(inner).toBeDefined();
    if (!inner)
      throw new Error("Synchronous witness did not reenter the actual preview");
    await expect(inner).rejects.toThrow(CliError);
    expect(readFileSync(file, "utf8")).toBe("1");
  });
});

describe("internal bootstrap orchestration with actual filesystem state", () => {
  test.each([false, true])(
    "fresh verified person precedes its only Q1 and continuation, localSync=%s",
    async (localSync) => {
      const f = fixture(false);
      f.stage();
      f.setLocalSync(localSync);
      f.setConfirm(() => {
        expect(bytes(configPathFor(f.home))).toBeNull();
        expect(bytes(onboardStatePath(f.home))).toBeNull();
        expect(existsSync(onboardLockPath(f.home))).toBe(false);
      });
      f.setContinue(async (approved) => {
        expect(approved).toMatchObject({
          account: person.account,
          person: person.membershipId,
          origin: person.baseUrl,
          role: "owner",
          localSync,
          ownerPid: process.pid,
        });
        expect(approved.lockPath).toBe(onboardLockPath(f.home));
        expect(
          JSON.parse(
            readFileSync(join(approved.lockPath, "owner.json"), "utf8"),
          ),
        ).toMatchObject({ pid: approved.ownerPid, token: approved.ownerToken });
        expect(
          readOnboardJournal(onboardStatePath(f.home), "0.14.6"),
        ).toMatchObject({
          account: person.account,
          membershipId: person.membershipId,
          localSync,
        });
      });
      expect(await f.run()).toBe(11);
      expect(f.ui.confirmPlan).toHaveBeenCalledTimes(1);
      const verify = f.events.indexOf("verified-person-plan"),
        question = f.events.indexOf("Q1"),
        accepted = f.events.indexOf("candidate-accepted"),
        entered = f.events.indexOf("continuation");
      expect(verify).toBeGreaterThan(f.events.indexOf("staged-person"));
      expect(f.events.slice(verify + 1, question)).toContain("install-plan");
      expect(question).toBeGreaterThan(verify);
      expect(accepted).toBeGreaterThan(question);
      expect(entered).toBeGreaterThan(accepted);
      expect(f.events).toContain("recheck-unlocked");
      expect(f.events).toContain("recheck-owned");
      expect(f.machine).toHaveBeenCalledTimes(1);
      expect(existsSync(onboardLockPath(f.home))).toBe(false);
    },
  );
  test.each([false, true])(
    "declining Q1 preserves every private home byte, saved=%s",
    async (saved) => {
      const f = fixture(saved);
      if (!saved) f.stage();
      const before = tree(f.home);
      f.setAnswer(false);
      expect(await f.run()).toBe(0);
      expect(tree(f.home)).toEqual(before);
      expect(f.ui.confirmPlan).toHaveBeenCalledTimes(1);
      expect(f.childEntry).not.toHaveBeenCalled();
      expect(f.machine).not.toHaveBeenCalled();
      expect(existsSync(onboardLockPath(f.home))).toBe(false);
      expect(existsSync(onboardStatePath(f.home))).toBe(false);
    },
  );
  test("a displayed plan replacement refuses before the canonical lock or child", async () => {
    const f = fixture();
    const before = tree(f.home);
    f.setConfirm(() =>
      f.setPlan(parseBootstrapPlan({ ...rawPlan(f.home), dailyUpdate: true })),
    );
    await expect(f.run()).rejects.toMatchObject({
      code: "onboard-bootstrap-changed",
      exitCode: 11,
    });
    expect(tree(f.home)).toEqual(before);
    expect(f.childEntry).not.toHaveBeenCalled();
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });
  test.each(["config", "receipt"])(
    "preview's actual %s witness refuses changed bytes before child entry",
    async (target) => {
      const f = fixture();
      const path =
        target === "config" ? configPathFor(f.home) : onboardStatePath(f.home);
      if (target === "receipt") seedReceipt(f.home);
      const original = bytes(path);
      let changed = "";
      f.setRecheck(async () => {
        if (bytes(path) !== original)
          throw new CliError(
            "Staged machine snapshot changed",
            "bootstrap-snapshot-changed",
            11,
          );
      });
      f.setConfirm(() => {
        changed =
          target === "config"
            ? readFileSync(path, "utf8").replace(
                "ctc_user_private_test_key",
                "ctc_user_changed_test_key",
              )
            : JSON.stringify({ ...receipt(f.home), runId: "concurrent-run" });
        writeFileSync(path, changed);
      });
      await expect(f.run()).rejects.toMatchObject({
        code: "bootstrap-snapshot-changed",
        exitCode: 11,
      });
      expect(readFileSync(path, "utf8")).toBe(changed);
      expect(changed).not.toBe(original);
      expect(f.childEntry).not.toHaveBeenCalled();
      expect(existsSync(onboardLockPath(f.home))).toBe(false);
    },
  );
  test.each(["config", "receipt"])(
    "the post-lock %s witness refuses before continuation and preserves the replacement",
    async (target) => {
      const f = fixture();
      if (target === "receipt") seedReceipt(f.home);
      const path =
          target === "config"
            ? configPathFor(f.home)
            : onboardStatePath(f.home),
        original = bytes(path);
      let replacement = "";
      f.setRecheck(async () => {
        if (existsSync(onboardLockPath(f.home))) {
          replacement =
            target === "config"
              ? readFileSync(path, "utf8").replace(
                  "ctc_user_private_test_key",
                  "ctc_user_post_lock_replacement",
                )
              : JSON.stringify({
                  ...receipt(f.home),
                  runId: "post-lock-replacement",
                });
          writeFileSync(path, replacement);
        }
        if (bytes(path) !== original)
          throw new CliError(
            "Machine witness changed under owned lock",
            "bootstrap-snapshot-changed",
            11,
          );
      });
      expect(await f.run()).toBe(11);
      expect(replacement).not.toBe("");
      expect(readFileSync(path, "utf8")).toBe(replacement);
      expect(f.childEntry).not.toHaveBeenCalled();
      expect(f.events).toContain("recheck-owned");
      expect(existsSync(onboardLockPath(f.home))).toBe(false);
    },
  );
  test.each([
    { name: "account", next: { ...person, account: "foreign-account" } },
    { name: "person", next: { ...person, membershipId: "foreign-person" } },
    {
      name: "origin",
      next: { ...person, baseUrl: "https://foreign.example.test" },
    },
    { name: "role", next: { ...person, role: "member" as const } },
  ])(
    "fresh identity recheck refuses changed $name before child entry",
    async ({ next }) => {
      const f = fixture();
      let changed = "";
      f.setConfirm(() => {
        writeConfig(f.home, config(next));
        changed = readFileSync(configPathFor(f.home), "utf8");
      });
      expect(await f.run()).toBe(12);
      expect(f.identity.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(readFileSync(configPathFor(f.home), "utf8")).toBe(changed);
      expect(f.childEntry).not.toHaveBeenCalled();
      expect(f.machine).not.toHaveBeenCalled();
      expect(existsSync(onboardLockPath(f.home))).toBe(false);
    },
  );
  test("a config replacement during the final asynchronous identity read refuses before child entry", async () => {
    const f = fixture();
    let changed = "";
    f.identity.mockImplementation(async () => {
      if (f.events.includes("Q1")) {
        writeConfig(f.home, {
          ...config(person),
          key: "ctc_user_replaced_during_read",
        });
        changed = readFileSync(configPathFor(f.home), "utf8");
      }
      return person;
    });
    expect(await f.run()).toBe(12);
    expect(changed).not.toBe("");
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(changed);
    expect(f.childEntry).not.toHaveBeenCalled();
    expect(f.machine).not.toHaveBeenCalled();
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });
  test("the synchronous final artifact witness refuses a replacement made by the last identity await", async () => {
    const f = fixture(),
      staged = join(f.home, "staged-cli-test-artifact");
    writeFileSync(staged, "reviewed artifact");
    f.identity.mockImplementation(async () => {
      if (f.events.includes("Q1"))
        writeFileSync(staged, "concurrent replacement");
      return person;
    });
    f.setAssertCurrent(() => {
      if (readFileSync(staged, "utf8") !== "reviewed artifact")
        throw new CliError(
          "Staged artifact changed",
          "bootstrap-artifact-changed",
          11,
        );
    });
    expect(await f.run()).toBe(11);
    expect(f.events).toContain("assert-current");
    expect(readFileSync(staged, "utf8")).toBe("concurrent replacement");
    expect(f.childEntry).not.toHaveBeenCalled();
    expect(f.machine).not.toHaveBeenCalled();
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });
  test("dry run displays the machine plan without staging, recheck, child entry, or filesystem writes", async () => {
    const f = fixture(false);
    f.stage();
    const before = tree(f.home);
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--dry-run", "--json"]),
        f.ctx,
        f.deps,
        "0.14.6",
      ),
    ).toBe(0);
    expect(f.deps.stageSignin).not.toHaveBeenCalled();
    expect(f.childEntry).not.toHaveBeenCalled();
    expect(f.events).not.toContain("recheck-unlocked");
    expect(tree(f.home)).toEqual(before);
    expect(f.output).toHaveLength(1);
    expect(JSON.parse(f.output[0]!)).toMatchObject({ mode: "plan" });
    expect(f.errors.join("\n")).toContain("Install on linux/x64");
  });
  test("foreign receipt refuses before Q1, lock, or continuation", async () => {
    const f = fixture();
    seedReceipt(f.home);
    const path = onboardStatePath(f.home);
    writeFileSync(
      path,
      JSON.stringify({ ...receipt(f.home), membershipId: "foreign-person" }),
    );
    const before = tree(f.home);
    expect(await f.run()).toBe(12);
    expect(tree(f.home)).toEqual(before);
    expect(f.ui.confirmPlan).not.toHaveBeenCalled();
    expect(f.childEntry).not.toHaveBeenCalled();
  });
  test("an actual child remains joined under the canonical lock after cancellation", async () => {
    const f = fixture(),
      entered = deferred<ReturnType<typeof nativeChild>>();
    f.setContinue(async (approved, signal) => {
      const native = nativeChild(approved, join(f.home, "unused-artifact"));
      entered.resolve(native);
      expect(await native.joined).toBe(0);
      expect(signal.aborted).toBe(true);
      expect(existsSync(approved.lockPath)).toBe(true);
    });
    const task = f.run();
    let finished = false;
    void task.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    const native = await entered.promise;
    await native.entered;
    f.stop.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    expect(existsSync(onboardLockPath(f.home))).toBe(true);
    expect(native.child.exitCode).toBeNull();
    expect(
      readOnboardJournal(onboardStatePath(f.home), "0.14.6")?.steps.find(
        (step) => step.id === "machine",
      )?.state,
    ).toBe("running");
    native.release();
    expect(await task).toBe(11);
    expect(native.child.exitCode).toBe(0);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
    expect(
      readOnboardJournal(onboardStatePath(f.home), "0.14.6"),
    ).toMatchObject({ exit: 11, complete: false });
    expect(f.machine).not.toHaveBeenCalled();
  });
  test.each([false, true])(
    "an actual partial child failure remains truthful after joined cleanup, interrupted=%s",
    async (interrupted) => {
      const f = fixture(false);
      f.stage();
      const partial = join(f.home, "partial-installation"),
        entered = deferred<ReturnType<typeof nativeChild>>();
      f.setContinue(async (approved) => {
        const native = nativeChild(approved, partial, true, true);
        entered.resolve(native);
        const exit = await native.joined;
        expect(exit).toBe(7);
        expect(existsSync(approved.lockPath)).toBe(true);
        throw new CliError(
          "private-child-error-test-token must never be displayed",
          "bootstrap-test-child-failed",
          10,
        );
      });
      const task = f.run(),
        native = await entered.promise;
      await native.entered;
      expect(readFileSync(partial, "utf8")).toBe(
        "partial-native-test-artifact",
      );
      expect(existsSync(onboardLockPath(f.home))).toBe(true);
      if (interrupted) f.stop.abort();
      native.release();
      expect(await task).toBe(interrupted ? 11 : 10);
      expect(native.child.exitCode).toBe(7);
      expect(existsSync(onboardLockPath(f.home))).toBe(false);
      expect(f.machine).not.toHaveBeenCalled();
      expect(readFileSync(partial, "utf8")).toBe(
        "partial-native-test-artifact",
      );
      expect(loadConfig(f.home)?.user?.id).toBe(person.membershipId);
      const journal = readOnboardJournal(onboardStatePath(f.home), "0.14.6");
      expect(journal).toMatchObject({
        exit: interrupted ? 11 : 10,
        complete: false,
        account: person.account,
        membershipId: person.membershipId,
      });
      expect(
        journal?.steps.find((step) => step.id === "machine"),
      ).toMatchObject({
        state: interrupted ? "waiting" : "failed",
        reason: interrupted ? "interrupted" : "bootstrap_install_failed",
      });
      expect(f.errors.join("\n")).not.toContain(
        "private-child-error-test-token",
      );
      expect(f.errors.join("\n")).toContain("original setup command");
      expect(
        journal?.steps.some(
          (step) => step.id === "cli" && step.state === "done",
        ),
      ).toBe(false);
    },
  );
});

describe("unregistered bootstrap dispatcher seam", () => {
  test("real main forwards only an injected preview and refuses JSON without approval before child or home writes", async () => {
    const f = fixture(),
      before = tree(f.home),
      calls: string[] = [];
    f.ctx.fetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(url.href);
      expect(url.origin).toBe(person.baseUrl);
      expect(url.pathname).toBe("/api/v1/me");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer ctc_user_private_test_key",
      );
      return Response.json({
        account: person.account,
        slug: "workspace-one",
        name: "Verified Workspace",
        principal: "service",
        permissions: ["mirror:read"],
        user: {
          id: person.membershipId,
          label: "Verified Person",
          email: "person@example.test",
          role: "owner",
          linearUserId: null,
        },
      });
    });
    // Synthetic HTTPS /me wire reply only. No public flag, artifact download or installer is invoked.
    expect(
      await main(["onboard", "--json"], f.ctx, {
        onboardBootstrap: f.deps.bootstrap,
        isTty: () => false,
      }),
    ).toBe(11);
    expect(calls).toEqual([person.baseUrl + "/api/v1/me"]);
    expect(f.childEntry).not.toHaveBeenCalled();
    expect(tree(f.home)).toEqual(before);
    expect(f.output).toHaveLength(1);
    expect(JSON.parse(f.output[0]!)).toMatchObject({
      exit: 11,
      complete: false,
    });
    const shown = f.errors.join("\n");
    expect(shown).toContain("Install on linux/x64");
    expect(shown).toContain("Verified Person");
    expect(shown).toContain("Verified Workspace");
    expect(shown.indexOf("Verified Person")).toBeLessThan(
      shown.indexOf("Install on linux/x64"),
    );
    expect(shown).toContain("--yes");
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });
});

test("staged approval closes its preview before asking permission to publish the connection", async () => {
  const f = fixture(false);
  f.stage();
  f.ui.stagedSigninEnd = vi.fn((state) => {
    f.events.push(`staged-${state}`);
    expect(loadConfig(f.home)).toBeNull();
    return true;
  });
  await f.run();
  expect(f.ui.stagedSigninEnd).toHaveBeenCalledWith("done");
  expect(f.events.indexOf("staged-done")).toBeLessThan(
    f.events.indexOf("verified-person-plan"),
  );
  expect(f.events.indexOf("staged-done")).toBeLessThan(f.events.indexOf("Q1"));
});

test("staged sign-in refusal preserves the old connection and closes the preview with its cause", async () => {
  const f = fixture(false);
  f.deps.stageSignin = vi.fn(async () => {
    throw new CliError("Approval timed out.", "signin-timeout", 11);
  });
  f.ui.stagedSigninEnd = vi.fn(() => true);
  const messages = vi.spyOn(f.ui, "message");
  expect(await f.run()).toBe(11);
  expect(f.ui.stagedSigninEnd).toHaveBeenCalledWith(
    "waiting",
    "Approval timed out.",
  );
  expect(messages).not.toHaveBeenCalledWith("Approval timed out.");
  expect(loadConfig(f.home)).toBeNull();
  expect(existsSync(onboardStatePath(f.home))).toBe(false);
  expect(f.childEntry).not.toHaveBeenCalled();
});

test("already reviewed setup does not promise a second install-plan review during signin", async () => {
  const f = fixture(false);
  f.deps.reviewedSetup = true;
  f.stage();
  const message = vi.spyOn(f.ui, "message");
  await f.run();
  expect(message).toHaveBeenCalledWith(
    "Sign in in your browser to continue setup.",
  );
  expect(message.mock.calls.flat().join("\n")).not.toContain(
    "Then review your person",
  );
});
