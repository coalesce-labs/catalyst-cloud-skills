import { expectJsonJournalMatches } from "./json-journal.js";
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
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { main } from "../src/cli.js";
import {
  configPathFor,
  contractPathFor,
  defaultCtx,
  discoveryCachePathFor,
  loadConfig,
  writeConfig,
  type CustomerConfig,
} from "../src/config.js";
import { CliError } from "../src/errors.js";
import type { OnboardLoginCandidate } from "../src/onboard-login-candidate.js";
import type { OnboardUi } from "../src/onboard-ui.js";
import {
  cmdOnboard,
  onboardLockPath,
  onboardStatePath,
  type OnboardAdapter,
  type OnboardDeps,
  type OnboardIdentity,
  type OnboardJournal,
} from "../src/onboard.js";

const homes: string[] = [];
const cloud = "https://plain-staging.example";
const now = new Date("2026-09-30T14:00:00Z");
function home() {
  const path = mkdtempSync(join(tmpdir(), "onboard-plain-staging-"));
  homes.push(path);
  return path;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of homes.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function engineFixture(samePerson = false) {
  const path = home();
  const out: string[] = [];
  const err: string[] = [];
  const original: OnboardIdentity = {
    account: "original-account",
    membershipId: "original-person",
    baseUrl: cloud,
    role: "owner",
  };
  const next: OnboardIdentity = samePerson
    ? original
    : {
        account: "next-account",
        membershipId: "next-person",
        baseUrl: cloud,
        role: "owner",
        display: {
          personLabel: "Next Person",
          email: "next@example.com",
          workspaceName: "Next Workspace",
          workspaceSlug: "next",
        },
      };
  const cfg = (who: OnboardIdentity): CustomerConfig => ({
    baseUrl: cloud,
    account: who.account,
    slug: who.account,
    name: who.account,
    permissions: null,
    principal: "session",
    key: `synthetic-${who.membershipId}`,
    user: {
      id: who.membershipId,
      label: who.membershipId,
      email: null,
      role: who.role,
      linearUserId: null,
    },
    joinedAt: now.toISOString(),
    lastSkillBundleVersion: "0.14.6",
  });
  const env: NodeJS.ProcessEnv = {};
  const ctx = {
    ...defaultCtx(),
    home: path,
    env,
    now: () => now,
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    fetch: vi.fn<typeof fetch>(async () => {
      throw new Error("unexpected network");
    }),
  };
  const statePath = onboardStatePath(path);
  const receipt = (who?: OnboardIdentity): OnboardJournal => ({
    schema: 1,
    runId: "kept-run",
    installer: null,
    cli: "0.14.6",
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
    operations: { "linear.personal": "kept-operation" },
  });
  const seedReceipt = (value = receipt()) => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(value));
    return readFileSync(statePath, "utf8");
  };
  const stop = new AbortController();
  let published = false;
  let current: OnboardIdentity | null = null;
  let stageCalls = 0;
  let acceptCalls = 0;
  let checks = 0;
  let acts = 0;
  let accept: OnboardLoginCandidate["accept"] = async (
    signal,
    beforePublish,
  ) => {
    expect(signal?.aborted).toBe(false);
    expect(existsSync(onboardLockPath(path))).toBe(true);
    beforePublish?.();
    writeConfig(path, cfg(next));
    published = true;
    current = next;
  };
  const candidate: OnboardLoginCandidate = {
    identity: next,
    get accepted() {
      return published;
    },
    accept: async (signal, beforePublish) => {
      acceptCalls++;
      return accept(signal, beforePublish);
    },
  };
  const deps: OnboardDeps = {
    bindSignals: false,
    signal: stop.signal,
    isTty: () => false,
    identity: async () => current,
    stageSignin: async (signal) => {
      stageCalls++;
      expect(signal).toBe(stop.signal);
      return candidate;
    },
    adapters: {
      signin: {
        check: async () => {
          checks++;
          return published ? { state: "done" } : { state: "pending" };
        },
        act: async () => {
          acts++;
          throw new Error("publishing login fallback must not run");
        },
      },
    },
  };
  return {
    path,
    ctx,
    out,
    err,
    original,
    next,
    cfg,
    stop,
    statePath,
    receipt,
    seedReceipt,
    deps,
    candidate,
    setAccept: (value: typeof accept) => {
      accept = value;
    },
    setCurrent: (value: OnboardIdentity | null) => {
      current = value;
    },
    publish: () => {
      published = true;
      current = next;
    },
    counts: () => ({ stageCalls, acceptCalls, checks, acts }),
  };
}

function result(out: string[]) {
  expect(out).toHaveLength(1);
  return JSON.parse(out[0]!);
}

describe("plain engine staged sign-in", () => {
  test.each([false, true])(
    "explicit Yes displays the returned identity before publication, JSON=%s",
    async (json) => {
      const f = engineFixture();
      f.setAccept(async (_signal, beforePublish) => {
        const displayed = (json ? f.err : f.out).join("\n");
        expect(displayed).toContain(
          "Signed in as Next Person (next@example.com)",
        );
        expect(displayed).toContain("Workspace: Next Workspace (next) · owner");
        expect(existsSync(configPathFor(f.path))).toBe(false);
        expect(existsSync(contractPathFor(f.path))).toBe(false);
        expect(existsSync(f.statePath)).toBe(false);
        beforePublish?.();
        writeConfig(f.path, f.cfg(f.next));
        f.publish();
      });
      expect(
        await cmdOnboard(
          parseArgs([
            "onboard",
            "--only",
            "signin",
            "--yes",
            ...(json ? ["--json"] : []),
          ]),
          f.ctx,
          f.deps,
          "0.14.6",
        ),
      ).toBe(0);
      expect(f.counts()).toEqual({
        stageCalls: 1,
        acceptCalls: 1,
        checks: 1,
        acts: 0,
      });
      const receiptText = readFileSync(f.statePath, "utf8");
      expect(JSON.parse(receiptText)).toMatchObject({
        account: f.next.account,
        membershipId: f.next.membershipId,
        localSync: false,
        exit: 0,
      });
      if (json)
        expectJsonJournalMatches(
          result(f.out),
          JSON.parse(receiptText),
          "ready",
        );
      expect(receiptText).not.toContain("next@example.com");
      expect(receiptText).not.toContain("Next Workspace");
    },
  );

  test.each(["signin", "projects", "accounts"] as const)(
    "headless %s without Yes makes zero stage, network, lock or action calls",
    async (only) => {
      for (const json of [false, true]) {
        const f = engineFixture();
        expect(
          await cmdOnboard(
            parseArgs(["onboard", "--only", only, ...(json ? ["--json"] : [])]),
            f.ctx,
            f.deps,
            "0.14.6",
          ),
        ).toBe(11);
        expect(f.counts()).toEqual({
          stageCalls: 0,
          acceptCalls: 0,
          checks: 0,
          acts: 0,
        });
        expect(f.ctx.fetch).not.toHaveBeenCalled();
        expect(existsSync(configPathFor(f.path))).toBe(false);
        expect(existsSync(f.statePath)).toBe(false);
        expect(existsSync(onboardLockPath(f.path))).toBe(false);
        if (json)
          expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
      }
    },
  );

  test("JSON is representation rather than fresh sign-in intent even with a terminal", async () => {
    const f = engineFixture();
    f.deps.isTty = () => true;
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "signin", "--json"]),
        f.ctx,
        f.deps,
        "0.14.6",
      ),
    ).toBe(11);
    expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    expect(f.counts().stageCalls).toBe(0);
    expect(existsSync(f.statePath)).toBe(false);
  });

  test("stdout alone is not plain input or permission to stage a fresh login", async () => {
    const f = engineFixture();
    const inputDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    const outputDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    f.deps.isTty = undefined;
    try {
      expect(
        await cmdOnboard(
          parseArgs(["onboard", "--only", "signin"]),
          f.ctx,
          f.deps,
          "0.14.6",
        ),
      ).toBe(11);
      expect(f.counts()).toEqual({
        stageCalls: 0,
        acceptCalls: 0,
        checks: 0,
        acts: 0,
      });
      expect(existsSync(configPathFor(f.path))).toBe(false);
      expect(existsSync(f.statePath)).toBe(false);
    } finally {
      if (inputDescriptor)
        Object.defineProperty(process.stdin, "isTTY", inputDescriptor);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      if (outputDescriptor)
        Object.defineProperty(process.stdout, "isTTY", outputDescriptor);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });

  test.each([false, true])(
    "headless saved identity without Yes waits without rewriting any bytes, JSON=%s",
    async (json) => {
      const f = engineFixture();
      writeConfig(f.path, f.cfg(f.original));
      const cfgBytes = readFileSync(configPathFor(f.path), "utf8");
      const receiptBytes = f.seedReceipt(f.receipt(f.original));
      f.setCurrent(f.original);
      expect(
        await cmdOnboard(
          parseArgs([
            "onboard",
            "--only",
            "signin",
            ...(json ? ["--json"] : []),
          ]),
          f.ctx,
          f.deps,
          "0.14.6",
        ),
      ).toBe(11);
      expect(f.counts()).toEqual({
        stageCalls: 0,
        acceptCalls: 0,
        checks: 0,
        acts: 0,
      });
      expect(readFileSync(configPathFor(f.path), "utf8")).toBe(cfgBytes);
      expect(readFileSync(f.statePath, "utf8")).toBe(receiptBytes);
      expect(existsSync(onboardLockPath(f.path))).toBe(false);
      if (json)
        expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    },
  );

  test("a headless local-only request without Yes waits rather than silently claiming completion", async () => {
    const f = engineFixture();
    let localChecks = 0;
    f.deps.adapters = {
      machine: {
        check: async () => {
          localChecks++;
          return { state: "done" };
        },
      },
    };
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "machine", "--json"]),
        f.ctx,
        f.deps,
        "0.14.6",
      ),
    ).toBe(11);
    expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    expect(localChecks).toBe(0);
    expect(f.counts().stageCalls).toBe(0);
    expect(existsSync(f.statePath)).toBe(false);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test("a saved verified identity cannot turn JSON without Yes into interactive approval", async () => {
    const f = engineFixture();
    writeConfig(f.path, f.cfg(f.original));
    const cfgBytes = readFileSync(configPathFor(f.path), "utf8");
    f.setCurrent(f.original);
    f.deps.isTty = () => true;
    f.deps.confirm = async () => {
      throw new Error("JSON must not ask a hidden terminal question");
    };
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "signin", "--json"]),
        f.ctx,
        f.deps,
        "0.14.6",
      ),
    ).toBe(11);
    expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    expect(f.counts()).toEqual({
      stageCalls: 0,
      acceptCalls: 0,
      checks: 0,
      acts: 0,
    });
    expect(readFileSync(configPathFor(f.path), "utf8")).toBe(cfgBytes);
    expect(existsSync(f.statePath)).toBe(false);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test("plain terminal Stop follows staged identity and preserves old receipt/cache bytes", async () => {
    const f = engineFixture();
    const receiptBytes = f.seedReceipt();
    mkdirSync(dirname(contractPathFor(f.path)), { recursive: true });
    writeFileSync(contractPathFor(f.path), "stale-unbound-cache");
    f.deps.isTty = () => true;
    const confirm = vi.fn(async () => {
      expect(f.out.join("\n")).toContain("Signed in as Next Person");
      expect(existsSync(configPathFor(f.path))).toBe(false);
      expect(readFileSync(f.statePath, "utf8")).toBe(receiptBytes);
      return false;
    });
    f.deps.confirm = confirm;
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "signin"]),
        f.ctx,
        f.deps,
        "0.14.6",
      ),
    ).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(f.counts()).toEqual({
      stageCalls: 1,
      acceptCalls: 0,
      checks: 0,
      acts: 0,
    });
    expect(readFileSync(f.statePath, "utf8")).toBe(receiptBytes);
    expect(readFileSync(contractPathFor(f.path), "utf8")).toBe(
      "stale-unbound-cache",
    );
    expect(existsSync(configPathFor(f.path))).toBe(false);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test.each(["machine", "cli", "skills", "legacy", "housekeeping"] as const)(
    "plain local-only %s never starts C1",
    async (only) => {
      const f = engineFixture();
      let localChecks = 0;
      const adapter: OnboardAdapter = {
        check: async () => {
          localChecks++;
          return { state: "done" };
        },
      };
      f.deps.adapters = { [only]: adapter };
      expect(
        await cmdOnboard(
          parseArgs(["onboard", "--only", only, "--yes", "--json"]),
          f.ctx,
          f.deps,
          "0.14.6",
        ),
      ).toBe(0);
      expect(localChecks).toBe(1);
      expect(f.counts().stageCalls).toBe(0);
      expect(f.counts().acceptCalls).toBe(0);
      expect(f.ctx.fetch).not.toHaveBeenCalled();
      expect(existsSync(configPathFor(f.path))).toBe(false);
      expect(result(f.out)).toMatchObject({ tenant: null, exit: 0 });
    },
  );

  test("ready-only remains an unverified diagnostic with zero C1", async () => {
    const f = engineFixture();
    f.deps.adapters = {
      ready: {
        check: async () => ({
          state: "waiting",
          reason: "fixture_readiness_unverified",
        }),
      },
    };
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "ready", "--yes", "--json"]),
        f.ctx,
        f.deps,
        "0.14.6",
      ),
    ).toBe(11);
    expect(f.counts().stageCalls).toBe(0);
    expect(result(f.out).steps).toContainEqual(
      expect.objectContaining({
        id: "ready",
        state: "waiting",
        reason: "fixture_readiness_unverified",
      }),
    );
  });

  test.each(["account", "membershipId", "baseUrl"] as const)(
    "plain bound renewal rejects a changed %s before identity approval and keeps bytes",
    async (field) => {
      const f = engineFixture();
      const bound: OnboardIdentity = {
        ...f.next,
        [field]:
          field === "baseUrl"
            ? "https://original-origin.example"
            : `original-${field}`,
      };
      writeConfig(f.path, { ...f.cfg(bound), baseUrl: bound.baseUrl });
      const cfgBytes = readFileSync(configPathFor(f.path), "utf8");
      writeFileSync(contractPathFor(f.path), "bound-cache");
      const receiptBytes = f.seedReceipt(f.receipt(bound));
      f.deps.identity = async () => {
        throw new CliError("Renew login", "onboard-login-refresh-required", 11);
      };
      expect(
        await cmdOnboard(
          parseArgs(["onboard", "--only", "signin", "--yes", "--json"]),
          f.ctx,
          f.deps,
          "0.14.6",
        ),
      ).toBe(12);
      expect(result(f.out)).toMatchObject({ exit: 12, complete: false });
      expect(f.err.join("\n")).not.toContain("Signed in as Next Person");
      expect(f.counts()).toEqual({
        stageCalls: 1,
        acceptCalls: 0,
        checks: 0,
        acts: 0,
      });
      expect(readFileSync(configPathFor(f.path), "utf8")).toBe(cfgBytes);
      expect(readFileSync(contractPathFor(f.path), "utf8")).toBe("bound-cache");
      expect(readFileSync(f.statePath, "utf8")).toBe(receiptBytes);
      expect(existsSync(onboardLockPath(f.path))).toBe(false);
    },
  );

  test("same-person plain renewal retains original run and operation identity", async () => {
    const f = engineFixture(true);
    writeConfig(f.path, f.cfg(f.original));
    f.seedReceipt(f.receipt(f.original));
    f.deps.identity = async () => {
      if (!f.candidate.accepted)
        throw new CliError("Renew login", "onboard-login-refresh-required", 11);
      return f.original;
    };
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "signin", "--yes", "--json"]),
        f.ctx,
        f.deps,
        "0.14.6",
      ),
    ).toBe(0);
    expect(result(f.out)).toMatchObject({
      runId: "kept-run",
      account: f.original.account,
      membershipId: f.original.membershipId,
      operations: { "linear.personal": "kept-operation" },
    });
    expect(f.counts().acceptCalls).toBe(1);
  });

  test("receipt replacement during plain staging blocks acceptance and emits one refused result", async () => {
    const f = engineFixture();
    f.seedReceipt();
    let replacement = "";
    f.deps.stageSignin = async () => {
      replacement = f.seedReceipt({ ...f.receipt(), runId: "concurrent-run" });
      return f.candidate;
    };
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "signin", "--yes", "--json"]),
        f.ctx,
        f.deps,
        "0.14.6",
      ),
    ).toBe(11);
    expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    expect(f.counts().acceptCalls).toBe(0);
    expect(readFileSync(f.statePath, "utf8")).toBe(replacement);
    expect(existsSync(configPathFor(f.path))).toBe(false);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test("candidate acceptance failure emits one waiting JSON object without publishing", async () => {
    const f = engineFixture();
    const receiptBytes = f.seedReceipt();
    f.setAccept(async () => {
      throw new Error("synthetic-private-token-error");
    });
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "signin", "--yes", "--json"]),
        f.ctx,
        f.deps,
        "0.14.6",
      ),
    ).toBe(11);
    expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    expect([...f.out, ...f.err].join("\n")).not.toContain(
      "synthetic-private-token-error",
    );
    expect(readFileSync(f.statePath, "utf8")).toBe(receiptBytes);
    expect(existsSync(configPathFor(f.path))).toBe(false);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test("C1 abort before candidate return preserves an unbound handoff and emits one waiting JSON result", async () => {
    const f = engineFixture();
    const receiptBytes = f.seedReceipt();
    const lock = onboardLockPath(f.path);
    mkdirSync(lock, { recursive: true });
    const ownerBytes = JSON.stringify({ pid: 77, token: "unaccepted-handoff" });
    writeFileSync(join(lock, "owner.json"), ownerBytes);
    f.ctx.env.CATALYST_INSTALL_LOCK_TOKEN = "unaccepted-handoff";
    f.deps.stageSignin = async (signal) => {
      expect(signal).toBe(f.stop.signal);
      f.stop.abort();
      throw new CliError("Sign-in paused", "onboard-signin-paused", 11);
    };
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--resume-from", "install", "--yes", "--json"]),
        f.ctx,
        f.deps,
        "0.14.6",
      ),
    ).toBe(11);
    expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    expect(f.counts().acceptCalls).toBe(0);
    expect(readFileSync(f.statePath, "utf8")).toBe(receiptBytes);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(ownerBytes);
    expect(existsSync(configPathFor(f.path))).toBe(false);
  });

  test("UI and caller abort signals both remain effective before candidate publication", async () => {
    const f = engineFixture();
    const uiAbort = new AbortController();
    const receiptBytes = f.seedReceipt();
    const ui: OnboardUi = {
      signal: uiAbort.signal,
      plan: () => {},
      confirmPlan: async () => {
        throw new Error("aborted staging must never ask Q1");
      },
      stepStart: () => {},
      stepEnd: () => {},
      message: () => {},
      finish: () => {},
      dispose: () => {},
      wait: async (_message, run) => run(),
    };
    f.deps.ui = ui;
    let stageCalls = 0;
    f.deps.stageSignin = async (signal) => {
      stageCalls++;
      expect(signal).toBeDefined();
      expect(signal).not.toBe(uiAbort.signal);
      expect(signal).not.toBe(f.stop.signal);
      expect(signal?.aborted).toBe(false);
      f.stop.abort();
      expect(uiAbort.signal.aborted).toBe(false);
      expect(signal?.aborted).toBe(true);
      throw new CliError("Sign-in paused", "onboard-signin-paused", 11);
    };
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "signin"]),
        f.ctx,
        f.deps,
        "0.14.6",
      ),
    ).toBe(11);
    expect(stageCalls).toBe(1);
    expect(f.counts().acceptCalls).toBe(0);
    expect(readFileSync(f.statePath, "utf8")).toBe(receiptBytes);
    expect(existsSync(configPathFor(f.path))).toBe(false);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test("owned Ctrl-C before candidate config publication keeps original receipt and emits waiting JSON", async () => {
    const f = engineFixture();
    const receiptBytes = f.seedReceipt();
    const prior = new Set(process.listeners("SIGINT"));
    f.deps.bindSignals = true;
    f.setAccept(async (signal) => {
      const owned = process
        .listeners("SIGINT")
        .filter((listener) => !prior.has(listener));
      expect(owned).toHaveLength(1);
      for (const listener of owned) listener("SIGINT");
      expect(signal?.aborted).toBe(true);
      throw new CliError("Sign-in paused", "onboard-signin-paused", 11);
    });
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "signin", "--yes", "--json"]),
        f.ctx,
        f.deps,
        "0.14.6",
      ),
    ).toBe(11);
    expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    expect(readFileSync(f.statePath, "utf8")).toBe(receiptBytes);
    expect(existsSync(configPathFor(f.path))).toBe(false);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
    expect(process.listeners("SIGINT")).toEqual([...prior]);
  });

  test("accepted-but-unrecorded failure emits one truthful JSON result and preserves the accepted config", async () => {
    const f = engineFixture();
    f.setAccept(async (_signal, beforePublish) => {
      beforePublish?.();
      writeConfig(f.path, f.cfg(f.next));
      f.publish();
      writeFileSync(dirname(f.statePath), "blocked-receipt-parent");
    });
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "signin", "--yes", "--json"]),
        f.ctx,
        f.deps,
        "0.14.6",
      ),
    ).toBe(11);
    expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    expect(loadConfig(f.path)?.account).toBe(f.next.account);
    expect(f.err.join("\n")).toContain("connection was accepted");
    expect(f.err.join("\n")).not.toContain("Nothing was changed");
    expect(f.counts().checks).toBe(0);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test.each([false, true])(
    "dry-run keeps staging, identity, network and files unused, JSON=%s",
    async (json) => {
      const f = engineFixture();
      const identity = vi.fn(async () => {
        throw new Error("dry-run preview forbidden");
      });
      f.deps.identity = identity;
      expect(
        await cmdOnboard(
          parseArgs([
            "onboard",
            "--yes",
            "--dry-run",
            ...(json ? ["--json"] : []),
          ]),
          f.ctx,
          f.deps,
          "0.14.6",
        ),
      ).toBe(0);
      expect(identity).not.toHaveBeenCalled();
      expect(f.counts()).toEqual({
        stageCalls: 0,
        acceptCalls: 0,
        checks: 0,
        acts: 0,
      });
      expect(f.ctx.fetch).not.toHaveBeenCalled();
      expect(existsSync(configPathFor(f.path))).toBe(false);
      expect(existsSync(f.statePath)).toBe(false);
      expect(existsSync(onboardLockPath(f.path))).toBe(false);
      if (json)
        expect(result(f.out)).toMatchObject({
          mode: "plan",
          exit: null,
          complete: false,
        });
    },
  );
});

function cliFixture() {
  const path = home();
  const out: string[] = [];
  const err: string[] = [];
  const user = {
    id: "device-person",
    label: "Device Person",
    email: "device@example.com",
    role: "member",
    linearUserId: null,
  };
  const me = {
    account: "device-account",
    slug: "device",
    name: "Device Workspace",
    permissions: null,
    principal: "session",
    user,
  };
  const access = `e30.${Buffer.from(JSON.stringify({ exp: now.getTime() / 1000 + 3600, sid: "synthetic-device-session" })).toString("base64url")}.synthetic-signature`;
  const refresh = "synthetic-private-refresh";
  const env: NodeJS.ProcessEnv = {};
  let meReads = 0;
  let contractReads = 0;
  let beforeMe: (count: number) => void = () => {};
  let beforeContract: (count: number) => void = () => {};
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${cloud}/api/v1/auth/cli`)
      return Response.json({
        clientId: "synthetic-client",
        issuer: "https://auth.example",
        deviceAuthorizationUrl: "https://auth.example/device",
        tokenUrl: "https://auth.example/token",
        jwksUrl: "https://auth.example/jwks",
      });
    if (url === "https://auth.example/device")
      return Response.json({
        device_code: "synthetic-device",
        user_code: "TEST-4321",
        verification_uri: "https://auth.example/approve",
        verification_uri_complete:
          "https://auth.example/approve?code=TEST-4321",
        expires_in: 300,
        interval: 1,
      });
    if (url === "https://auth.example/token") {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:device_code",
      );
      return Response.json({ access_token: access, refresh_token: refresh });
    }
    if (url === `${cloud}/api/v1/me`) {
      beforeMe(++meReads);
      return Response.json(me);
    }
    if (url === `${cloud}/api/v1/agent/contract`) {
      beforeContract(++contractReads);
      // This is the public contract bootstrap required to verify C1, not a provider readiness mock.
      return Response.json({
        account: { id: me.account },
        contractVersion: "2.10.0",
        teams: [],
        routes: [],
      });
    }
    throw new Error(`unexpected synthetic route ${url}`);
  });
  const ctx = {
    ...defaultCtx(),
    home: path,
    env,
    now: () => now,
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    fetch,
  };
  const openBrowser = vi.fn<(url: string) => void>(() => {});
  const deps = { isTty: () => false, openBrowser, sleep: async () => {} };
  return {
    path,
    ctx,
    out,
    err,
    me,
    access,
    refresh,
    fetch,
    openBrowser,
    deps,
    setBeforeMe: (value: typeof beforeMe) => {
      beforeMe = value;
    },
    setBeforeContract: (value: typeof beforeContract) => {
      beforeContract = value;
    },
    reads: () => ({ meReads, contractReads }),
  };
}

describe("CLI dispatch stages the real device candidate", () => {
  test("JSON Yes keeps device instructions and complete reviewed defaults on stderr before config publication", async () => {
    const f = cliFixture();
    f.setBeforeContract((count) => {
      expect(existsSync(configPathFor(f.path))).toBe(false);
      expect(existsSync(discoveryCachePathFor(f.path))).toBe(false);
      expect(existsSync(onboardStatePath(f.path))).toBe(false);
      if (count === 1) {
        expect(existsSync(onboardLockPath(f.path))).toBe(false);
      } else if (count === 2) {
        expect(f.out).toEqual([]);
        const reviewed = f.err.join("\n");
        expect(reviewed).toContain("TEST-4321");
        expect(reviewed).toContain(
          "Signed in as Device Person (device@example.com)",
        );
        expect(reviewed).toContain(
          "Workspace: Device Workspace (device) · member",
        );
        expect(reviewed).toContain(
          "Local sync stays off, so Catalyst reads from the cloud.",
        );
        expect(reviewed).toContain(
          "one short request, which counts toward its usage",
        );
        expect(reviewed).toContain("Codex credentials are not refreshed");
        expect(reviewed).not.toContain("quota");
      }
    });
    expect(
      await main(
        ["onboard", "--only", "signin", "--yes", "--json", "--base-url", cloud],
        f.ctx,
        f.deps,
      ),
    ).toBe(0);
    const printed = result(f.out);
    const receiptText = readFileSync(onboardStatePath(f.path), "utf8");
    expectJsonJournalMatches(printed, JSON.parse(receiptText), "ready");
    expect(printed).toMatchObject({
      account: f.me.account,
      membershipId: f.me.user.id,
      exit: 0,
      complete: false,
    });
    expect(f.reads().contractReads).toBe(2);
    expect(loadConfig(f.path)?.auth?.accessToken).toBe(f.access);
    expect(f.openBrowser).not.toHaveBeenCalled();
    expect(existsSync(discoveryCachePathFor(f.path))).toBe(false);
    for (const text of [f.out[0]!, receiptText, f.err.join("\n")]) {
      expect(text).not.toContain(f.access);
      expect(text).not.toContain(f.refresh);
    }
    for (const text of [f.out[0]!, receiptText]) {
      expect(text).not.toContain(f.me.user.email);
      expect(text).not.toContain(f.me.user.label);
      expect(text).not.toContain(f.me.name);
      expect(text).not.toContain("personLabel");
    }
  });

  test("plain Yes stages read-only, then displays the verified identity and plan before real acceptance", async () => {
    const f = cliFixture();
    f.setBeforeMe((count) => {
      if (count !== 2) return;
      expect(f.out.join("\n")).toContain(
        "Signed in as Device Person (device@example.com)",
      );
      expect(f.out.join("\n").replace(/\s+/g, " ")).toContain(
        "Local sync stays off, so Catalyst reads from the cloud.",
      );
      expect(existsSync(configPathFor(f.path))).toBe(false);
      expect(existsSync(onboardStatePath(f.path))).toBe(false);
    });
    expect(
      await main(
        ["onboard", "--only", "signin", "--yes", "--base-url", cloud],
        f.ctx,
        f.deps,
      ),
    ).toBe(0);
    expect(loadConfig(f.path)?.account).toBe(f.me.account);
    expect(f.out.join("\n")).toContain("TEST-4321");
    expect(f.out.join("\n")).not.toContain("\x1b");
    expect(f.openBrowser).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "headless CLI without Yes never reaches device discovery, JSON=%s",
    async (json) => {
      const f = cliFixture();
      expect(
        await main(
          [
            "onboard",
            "--only",
            "signin",
            ...(json ? ["--json"] : []),
            "--base-url",
            cloud,
          ],
          f.ctx,
          f.deps,
        ),
      ).toBe(11);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.openBrowser).not.toHaveBeenCalled();
      expect(existsSync(configPathFor(f.path))).toBe(false);
      expect(existsSync(discoveryCachePathFor(f.path))).toBe(false);
      expect(existsSync(onboardStatePath(f.path))).toBe(false);
      expect(existsSync(onboardLockPath(f.path))).toBe(false);
      if (json)
        expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    },
  );

  test("an already-aborted CLI caller never mints a device code or publishes credentials", async () => {
    const f = cliFixture();
    const stopped = new AbortController();
    stopped.abort();
    expect(
      await main(
        ["onboard", "--only", "signin", "--yes", "--json", "--base-url", cloud],
        f.ctx,
        { ...f.deps, signal: stopped.signal },
      ),
    ).toBe(11);
    expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.openBrowser).not.toHaveBeenCalled();
    expect(existsSync(configPathFor(f.path))).toBe(false);
    expect(existsSync(discoveryCachePathFor(f.path))).toBe(false);
    expect(existsSync(onboardStatePath(f.path))).toBe(false);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test("explicit Yes on a real terminal opens the synthetic device approval once while keeping JSON stdout structured", async () => {
    const f = cliFixture();
    expect(
      await main(
        ["onboard", "--only", "signin", "--yes", "--json", "--base-url", cloud],
        f.ctx,
        { ...f.deps, isTty: () => true },
      ),
    ).toBe(0);
    expect(result(f.out)).toMatchObject({ account: f.me.account, exit: 0 });
    expect(f.openBrowser).toHaveBeenCalledTimes(1);
    expect(f.openBrowser).toHaveBeenCalledWith(
      "https://auth.example/approve?code=TEST-4321",
    );
    expect(f.err.join("\n")).toContain("Opened your browser");
  });

  test.each(["flag", "environment"] as const)(
    "a supplied %s key is refused without replacing its identity through OAuth",
    async (where) => {
      const f = cliFixture();
      const key = "synthetic-personal-key-never-display";
      if (where === "environment") f.ctx.env.CATALYST_CLOUD_TOKEN = key;
      expect(
        await main(
          [
            "onboard",
            "--only",
            "signin",
            "--yes",
            "--json",
            "--base-url",
            cloud,
            ...(where === "flag" ? ["--key", key] : []),
          ],
          f.ctx,
          f.deps,
        ),
      ).toBe(12);
      expect(result(f.out)).toMatchObject({ exit: 12, complete: false });
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.openBrowser).not.toHaveBeenCalled();
      expect([...f.out, ...f.err].join("\n")).not.toContain(key);
      expect(f.err.join("\n")).toContain("catalyst login");
      expect(existsSync(configPathFor(f.path))).toBe(false);
      expect(existsSync(onboardStatePath(f.path))).toBe(false);
      expect(existsSync(onboardLockPath(f.path))).toBe(false);
    },
  );

  test("failed actual candidate revalidation preserves old cache, absent config and one JSON result", async () => {
    const f = cliFixture();
    mkdirSync(dirname(contractPathFor(f.path)), { recursive: true });
    writeFileSync(contractPathFor(f.path), "existing-stale-contract");
    f.setBeforeMe((count) => {
      if (count === 2) throw new Error("synthetic-private-transport-detail");
    });
    expect(
      await main(
        ["onboard", "--only", "signin", "--yes", "--json", "--base-url", cloud],
        f.ctx,
        f.deps,
      ),
    ).toBe(11);
    expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    expect([...f.out, ...f.err].join("\n")).not.toContain(
      "synthetic-private-transport-detail",
    );
    expect(readFileSync(contractPathFor(f.path), "utf8")).toBe(
      "existing-stale-contract",
    );
    expect(existsSync(configPathFor(f.path))).toBe(false);
    expect(existsSync(discoveryCachePathFor(f.path))).toBe(false);
    expect(existsSync(onboardStatePath(f.path))).toBe(false);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test("malformed personal identity response yields one waiting JSON result without accepted state", async () => {
    const f = cliFixture();
    const originalFetch = f.ctx.fetch;
    f.ctx.fetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${cloud}/api/v1/me`)
        return Response.json({ ...f.me, user: null });
      return originalFetch(input, init);
    });
    expect(
      await main(
        ["onboard", "--only", "signin", "--yes", "--json", "--base-url", cloud],
        f.ctx,
        f.deps,
      ),
    ).toBe(11);
    expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    expect(existsSync(configPathFor(f.path))).toBe(false);
    expect(existsSync(contractPathFor(f.path))).toBe(false);
    expect(existsSync(discoveryCachePathFor(f.path))).toBe(false);
    expect(existsSync(onboardStatePath(f.path))).toBe(false);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test("valid service identity without a person is one JSON refusal without accepted state", async () => {
    const f = cliFixture();
    const originalFetch = f.ctx.fetch;
    f.ctx.fetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${cloud}/api/v1/me`)
        return Response.json({
          ...f.me,
          principal: "service",
          user: undefined,
        });
      return originalFetch(input, init);
    });
    expect(
      await main(
        ["onboard", "--only", "signin", "--yes", "--json", "--base-url", cloud],
        f.ctx,
        f.deps,
      ),
    ).toBe(12);
    expect(result(f.out)).toMatchObject({ exit: 12, complete: false });
    expect(existsSync(configPathFor(f.path))).toBe(false);
    expect(existsSync(contractPathFor(f.path))).toBe(false);
    expect(existsSync(discoveryCachePathFor(f.path))).toBe(false);
    expect(existsSync(onboardStatePath(f.path))).toBe(false);
    expect(existsSync(onboardLockPath(f.path))).toBe(false);
  });

  test("a saved verified person on JSON Yes never starts a new device flow", async () => {
    const f = cliFixture();
    const saved: CustomerConfig = {
      ...f.me,
      principal: "session",
      user: { ...f.me.user, role: "member" },
      baseUrl: cloud,
      key: "synthetic-existing-personal-key",
      joinedAt: now.toISOString(),
      lastSkillBundleVersion: "0.14.6",
    };
    writeConfig(f.path, saved);
    const before = readFileSync(configPathFor(f.path), "utf8");
    expect(
      await main(
        ["onboard", "--only", "signin", "--yes", "--json", "--base-url", cloud],
        f.ctx,
        f.deps,
      ),
    ).toBe(0);
    expect(result(f.out)).toMatchObject({
      account: saved.account,
      membershipId: saved.user?.id,
      exit: 0,
    });
    expect(
      f.fetch.mock.calls.every(
        ([input]) =>
          (input instanceof Request ? input.url : String(input)) ===
          `${cloud}/api/v1/me`,
      ),
    ).toBe(true);
    expect(f.openBrowser).not.toHaveBeenCalled();
    expect(readFileSync(configPathFor(f.path), "utf8")).toBe(before);
  });

  test("JSON dry-run with a supplied key does not call staging or inspect that key online", async () => {
    const f = cliFixture();
    f.ctx.env.CATALYST_CLOUD_TOKEN = "synthetic-unused-key";
    expect(
      await main(["onboard", "--yes", "--dry-run", "--json"], f.ctx, f.deps),
    ).toBe(0);
    expect(result(f.out)).toMatchObject({
      mode: "plan",
      exit: null,
      complete: false,
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.openBrowser).not.toHaveBeenCalled();
    expect(existsSync(configPathFor(f.path))).toBe(false);
    expect(existsSync(onboardStatePath(f.path))).toBe(false);
  });

  test("headless installer handoff without explicit Yes preserves bootstrap state and asks for sign-in intent", async () => {
    const f = cliFixture();
    const state = onboardStatePath(f.path);
    const lock = onboardLockPath(f.path);
    mkdirSync(dirname(state), { recursive: true });
    const receiptBytes = JSON.stringify({
      schema: 1,
      runId: "bootstrap-run",
      installer: "0.14.6",
      cli: "0.14.6",
      tenant: null,
      exit: null,
      steps: [],
      changes: [],
    });
    writeFileSync(state, receiptBytes);
    mkdirSync(lock, { recursive: true });
    const ownerBytes = JSON.stringify({
      pid: process.pid,
      token: "bootstrap-intent-is-not-personal-consent",
    });
    writeFileSync(join(lock, "owner.json"), ownerBytes);
    f.ctx.env.CATALYST_INSTALL_LOCK_TOKEN =
      "bootstrap-intent-is-not-personal-consent";
    expect(
      await main(
        ["onboard", "--resume-from", "install", "--json", "--base-url", cloud],
        f.ctx,
        f.deps,
      ),
    ).toBe(11);
    expect(result(f.out)).toMatchObject({ exit: 11, complete: false });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.openBrowser).not.toHaveBeenCalled();
    expect(readFileSync(state, "utf8")).toBe(receiptBytes);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(ownerBytes);
    expect(existsSync(configPathFor(f.path))).toBe(false);
  });
});
