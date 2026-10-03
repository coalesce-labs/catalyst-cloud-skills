import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseArgs } from "../src/args.js";
import { defaultCtx, loadConfig, writeConfig, type CustomerConfig } from "../src/config.js";
import {
  CHECKLIST_LABELS,
  CHECKLIST_PATH,
  checklistItemText,
  connectChecklistAdapter,
} from "../src/onboard-checklist.js";
import { createOnboardRuntime } from "../src/onboard-runtime.js";
import type { OnboardJournal } from "../src/onboard.js";
import type { OnboardUi } from "../src/onboard-ui.js";

const homes: string[] = [];
const baseUrl = "https://staging.catalystcloud.dev";
const page = `${baseUrl}/connect-accounts`;
const now = Date.parse("2026-10-03T12:00:00Z");
const GITHUB_STATUS = "/api/v1/me/connections/github/workspace";
const ACCOUNTS = "/api/v1/coding-accounts";
type Item = {
  id: string;
  state: string;
  reason: string | null;
  who: "admin" | "you";
  canAct: boolean;
  actionUrl: string | null;
};
const item = (id: string, state = "needed", reason: string | null = "not_installed"): Item => ({
  id,
  state,
  reason: state === "done" ? null : reason,
  who: "admin",
  canAct: true,
  actionUrl: state === "done" ? null : `${baseUrl}/connect/github/start`,
});

function fixture(options: { checklist?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "onboard-checklist-"));
  homes.push(home);
  const stderr: string[] = [];
  const reads: string[] = [];
  // The clock moves only when setup sleeps, so read spacing is exact.
  let clock = now;
  const checklistReadsAt: number[] = [];
  const failNext: number[] = [];
  /** A status every Catalyst route answers with, from when it is set: a revoked login. */
  const revoked = { status: 0 };
  /** From this checklist read on, the read never answers until it is aborted. */
  const hang = { from: Infinity };
  const state = {
    github: item("github-app"),
    ai: item("ai-account", "needed", "none_usable"),
    page,
    extra: [] as Item[],
    /** The checklist's aiAccountKinds; undefined leaves the field out, as an older cloud does. */
    kinds: undefined as unknown,
    accounts: [] as unknown[],
  };
  const routes = [
    "/api/v1/agent/contract",
    GITHUB_STATUS,
    `${GITHUB_STATUS}/start`,
    ACCOUNTS,
    ...(options.checklist === false ? [] : [CHECKLIST_PATH]),
  ];
  const ctx = {
    ...defaultCtx(),
    home,
    env: {} as NodeJS.ProcessEnv,
    stdout: () => {},
    stderr: (s: string) => stderr.push(s),
    now: () => new Date(clock),
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      reads.push(url.pathname);
      if (revoked.status) return Response.json({ error: "revoked" }, { status: revoked.status });
      if (url.pathname === CHECKLIST_PATH && checklistReadsAt.length + 1 >= hang.from) {
        checklistReadsAt.push(clock);
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
      }
      if (url.pathname === "/api/v1/agent/contract")
        return Response.json({
          account: { id: "tenant-a" },
          contractVersion: "2.16.0",
          onboarding: {
            schema: 1,
            routes: routes.map((path) => ({ method: "GET", path, personalBearer: true })),
            web: {
              connections: "/a/account/connections",
              personalConnections: "/settings/connected-accounts",
            },
          },
        });
      if (url.pathname === CHECKLIST_PATH) {
        checklistReadsAt.push(clock);
        const status = failNext.shift();
        if (status) return Response.json({ error: "fixture" }, { status });
        const items = [state.github, state.ai, ...state.extra];
        return Response.json({
          schema: 1,
          page: state.page,
          remaining: items.filter((row) => row.state !== "done").length,
          allDone: items.every((row) => row.state === "done"),
          checkedAt: now,
          items,
          ...(state.kinds === undefined ? {} : { aiAccountKinds: state.kinds }),
        });
      }
      if (url.pathname === GITHUB_STATUS)
        return Response.json({ connected: false, installations: [], pending: [] });
      if (url.pathname === `${GITHUB_STATUS}/start`)
        return Response.json({
          authorizationUrl: `${baseUrl}/connect/github/workspace/handoff?handoff=signed`,
          expiresAt: now + 60_000,
        });
      if (url.pathname === ACCOUNTS)
        return Response.json({ accounts: state.accounts, observedAtMs: clock });
      return Response.json({ error: "unexpected_route" }, { status: 404 });
    }) as typeof fetch,
  };
  const cfg: CustomerConfig = {
    account: "tenant-a",
    slug: "tenant-a",
    name: "Tenant A",
    permissions: null,
    principal: "session",
    user: {
      id: "person-a",
      label: "Test Person",
      email: "test@example.com",
      role: "owner",
      linearUserId: null,
    },
    baseUrl,
    key: "ctc_user_test_fixture",
    joinedAt: "2026-10-03T12:00:00Z",
    lastSkillBundleVersion: "0.15.0",
  };
  writeConfig(home, cfg);
  const journal: OnboardJournal = {
    schema: 1,
    runId: "checklist-fixture",
    installer: null,
    cli: "0.15.0",
    tenant: "tenant-a",
    account: "tenant-a",
    membershipId: "person-a",
    baseUrl,
    exit: null,
    steps: [],
    changes: [],
  };
  const opened: string[] = [];
  const waits: Array<{ text: string; page?: { url: string; instruction: string } }> = [];
  const notes: string[] = [];
  const sleeps: number[] = [];
  const ui: OnboardUi = {
    signal: new AbortController().signal,
    interactive: true,
    message() {},
    note: (text) => notes.push(text),
    stepStart() {},
    stepEnd() {},
    finish() {},
    dispose() {},
    plan() {},
    confirmPlan: async () => ({ proceed: true, localSync: false }),
    wait: async (text, run, wait) => {
      waits.push({ text, page: wait });
      return run();
    },
  };
  let onSleep = () => {};
  const runtime = (args: string[] = ["onboard"], extra: Partial<OnboardUi> = {}, browser?: (url: string) => void) =>
    createOnboardRuntime(parseArgs(args), ctx, {
      login: async () => 0,
      ready: async () => ({ state: "waiting", reason: "not_ready" }),
      ui: { ...ui, ...extra },
      openBrowser: browser ?? ((url) => void opened.push(url)),
      sleep: async (ms) => {
        sleeps.push(ms);
        // A poll that never ends fails the test instead of spinning on microtasks.
        if (sleeps.length > 100) throw new Error("the wait never ended");
        clock += ms;
        onSleep();
        await new Promise((resolve) => setImmediate(resolve));
      },
    }).adapters!;
  return {
    ctx,
    state,
    journal,
    reads,
    stderr,
    opened,
    waits,
    notes,
    sleeps,
    runtime,
    after: (fn: () => void) => {
      onSleep = fn;
    },
    checklistReadsAt,
    failNext,
    tick: (ms: number) => {
      clock += ms;
    },
    revoked,
    hang,
    home,
    /** No two checklist reads closer than the 10-second poll. */
    spacing: () =>
      checklistReadsAt.slice(1).every((at, i) => at - checklistReadsAt[i]! >= 10_000),
  };
}
/** The per-step GitHub wait, ended at once: these tests only look at which link it started. */
const timedOut = async <T,>() =>
  ({ state: "waiting", reason: "consent_timeout", elapsedMs: 600_000 }) as T;
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("the terminal names each row exactly as the Connect accounts page does", () => {
  expect(Object.values(CHECKLIST_LABELS)).toEqual([
    "Linear workspace",
    "Your Linear account",
    "Catalyst on GitHub",
    "Your GitHub account",
    "AI account",
  ]);
  expect(
    checklistItemText({ id: "github-app", state: "waiting", reason: "approval_pending", who: "admin", canAct: true }),
  ).toBe("Catalyst on GitHub: waiting for an owner of your GitHub organization to approve it.");
});

describe("Catalyst on GitHub, when the cloud has the checklist", () => {
  test("a done row is the step's done, without the GitHub status route", async () => {
    const f = fixture();
    f.state.github = item("github-app", "done");
    expect(await f.runtime()["github.install"]!.check(f.ctx, f.journal)).toMatchObject({
      state: "done",
      evidence: { provider: "github", scope: "checklist" },
    });
    expect(f.reads).not.toContain(GITHUB_STATUS);
  });

  test("a needed row opens the Connect page once and polls it every 10 seconds until done", async () => {
    const f = fixture();
    let polls = 0;
    f.after(() => {
      if (++polls === 2) f.state.github = item("github-app", "done");
    });
    const step = f.runtime()["github.install"]!;
    expect(await step.check(f.ctx, f.journal)).toEqual({ state: "pending" });
    expect(await step.act!(f.ctx, f.journal)).toMatchObject({ state: "done" });
    expect(f.opened).toEqual([page]);
    expect(f.waits).toEqual([
      {
        text: 'Waiting for "Catalyst on GitHub"',
        page: { url: page, instruction: 'Opened your browser. Finish "Catalyst on GitHub" on the page.' },
      },
    ]);
    expect(f.sleeps).toEqual([10_000, 10_000]);
    // check's read serves the act that follows it; each later read is one 10-second poll.
    expect(f.reads.filter((path) => path === CHECKLIST_PATH)).toHaveLength(3);
    // The per-step install link is never started.
    expect(f.reads).not.toContain(`${GITHUB_STATUS}/start`);
  });

  test("a row that starts waiting is named once, in plain words", async () => {
    const f = fixture();
    let polls = 0;
    f.after(() => {
      polls++;
      if (polls === 1 || polls === 2)
        f.state.github = item("github-app", "waiting", "approval_pending");
      if (polls === 3) f.state.github = item("github-app", "done");
    });
    const step = f.runtime()["github.install"]!;
    await step.check(f.ctx, f.journal);
    expect((await step.act!(f.ctx, f.journal)).state).toBe("done");
    expect(f.notes).toEqual([
      "Catalyst on GitHub: waiting for an owner of your GitHub organization to approve it.",
    ]);
    expect(f.notes.join("\n")).not.toMatch(/approval_pending|_/);
  });

  test("with no browser the page is printed on its own line", async () => {
    const f = fixture();
    f.after(() => {
      f.state.github = item("github-app", "done");
    });
    const step = f.runtime(["onboard"], {}, () => {
      throw new Error("no browser");
    })["github.install"]!;
    await step.check(f.ctx, f.journal);
    expect((await step.act!(f.ctx, f.journal)).state).toBe("done");
    expect(f.stderr).toContain(page);
    expect(f.waits[0]!.page).toEqual({
      url: page,
      instruction: 'Open this link and finish "Catalyst on GitHub":',
    });
  });

  test("a timed-out wait still asks to try again, and yes waits on the page already open", async () => {
    const f = fixture();
    const asked: string[] = [];
    let waits = 0;
    const step = f.runtime(["onboard"], {
      wait: async <T,>(_text: string, run: () => Promise<T>) =>
        ++waits === 1
          ? ({ state: "waiting", reason: "consent_timeout", elapsedMs: 600_000 } as T)
          : run(),
      retryTimedOut: async (id) => {
        asked.push(id);
        return true;
      },
    })["github.install"]!;
    f.after(() => {
      f.state.github = item("github-app", "done");
    });
    await step.check(f.ctx, f.journal);
    expect((await step.act!(f.ctx, f.journal)).state).toBe("done");
    expect(asked).toEqual(["github.install"]);
    // CTC-4680: one tab per run; keep waiting points at the page already open.
    expect(f.opened).toEqual([page]);
  });

  test("the AI account step points at the page already open instead of opening it again", async () => {
    const f = fixture();
    f.after(() => {
      f.state.github = item("github-app", "done");
      f.state.ai = item("ai-account", "done");
    });
    const adapters = f.runtime();
    await adapters["github.install"]!.check(f.ctx, f.journal);
    await adapters["github.install"]!.act!(f.ctx, f.journal);
    f.state.ai = item("ai-account", "needed", "none_usable");
    f.state.github = item("github-app", "done");
    // The person spends a while between steps; the next read is a fresh one.
    f.tick(10_000);
    expect(await adapters.accounts!.check(f.ctx, f.journal)).toMatchObject({ state: "pending" });
    expect(await adapters.accounts!.act!(f.ctx, f.journal)).toMatchObject({ state: "done" });
    expect(f.opened).toEqual([page]);
    expect(f.waits[1]).toEqual({
      text: 'Waiting for "AI account"',
      page: { url: page, instruction: 'Finish "AI account" on the page already open in your browser.' },
    });
  });

  test("a page on another origin is never opened; the step keeps its own routes", async () => {
    const f = fixture();
    f.state.page = "https://elsewhere.example/connect-accounts";
    const step = f.runtime(["onboard"], { wait: timedOut })["github.install"]!;
    expect(await step.check(f.ctx, f.journal)).toEqual({ state: "pending" });
    await step.act!(f.ctx, f.journal);
    expect(f.opened).not.toContain(f.state.page);
    expect(f.reads).toContain(`${GITHUB_STATUS}/start`);
  });

});

test("without the checklist route, the GitHub step keeps its own status route and link", async () => {
  const f = fixture({ checklist: false });
  const step = f.runtime(["onboard"], { wait: timedOut })["github.install"]!;
  expect(await step.check(f.ctx, f.journal)).toEqual({ state: "pending" });
  await step.act!(f.ctx, f.journal);
  expect(f.reads).not.toContain(CHECKLIST_PATH);
  expect(f.reads).toContain(`${GITHUB_STATUS}/start`);
  expect(f.opened).toEqual([`${baseUrl}/connect/github/workspace/handoff?handoff=signed`]);
});

describe("AI account, when the cloud has the checklist", () => {
  test("the checklist's row is the answer", async () => {
    const f = fixture();
    f.state.ai = item("ai-account", "done");
    expect(await f.runtime()["accounts"]!.check(f.ctx, f.journal)).toMatchObject({
      state: "done",
      evidence: { provider: "ai-account", scope: "checklist" },
    });
    expect(f.reads).not.toContain(ACCOUNTS);
  });

  test("--yes never waits: a needed row reads the account list for its reason", async () => {
    const f = fixture();
    expect(await f.runtime(["onboard", "--yes"])["accounts"]!.check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "account_enrollment_required",
      evidence: { aiAccountKinds: "api-key" },
    });
    expect(f.waits).toEqual([]);
  });

  test("a named account is checked on its own, not by the checklist", async () => {
    const f = fixture();
    f.state.ai = item("ai-account", "done");
    expect(
      await f.runtime(["onboard", "--yes", "--coding-account", "claude-one"])["accounts"]!.check(
        f.ctx,
        f.journal,
      ),
    ).toEqual({ state: "waiting", reason: "coding_account_not_found" });
    expect(f.reads).not.toContain(CHECKLIST_PATH);
  });
});

describe("the checklist is never read faster than every 10 seconds", () => {
  test("the engine's check after a finished wait reuses the last read", async () => {
    const f = fixture();
    f.after(() => {
      f.state.github = item("github-app", "done");
    });
    const step = f.runtime()["github.install"]!;
    await step.check(f.ctx, f.journal);
    expect((await step.act!(f.ctx, f.journal)).state).toBe("done");
    const afterAct = f.checklistReadsAt.length;
    // src/onboard.ts runs check straight after an act that returns done.
    expect((await step.check(f.ctx, f.journal)).state).toBe("done");
    expect(f.checklistReadsAt).toHaveLength(afterAct);
    expect(f.spacing()).toBe(true);
  });

  test("a retried wait does not read again inside the 10 seconds", async () => {
    const f = fixture();
    let waits = 0;
    const step = f.runtime(["onboard"], {
      wait: async <T,>(_text: string, run: () => Promise<T>) =>
        ++waits === 1 ? (await timedOut<T>()) : run(),
      retryTimedOut: async () => true,
    })["github.install"]!;
    f.after(() => {
      f.state.github = item("github-app", "done");
    });
    await step.check(f.ctx, f.journal);
    expect((await step.act!(f.ctx, f.journal)).state).toBe("done");
    expect(f.spacing()).toBe(true);
  });

  test("the next step's check reuses a read from the step before", async () => {
    const f = fixture();
    f.state.github = item("github-app", "done");
    f.state.ai = item("ai-account", "done");
    const adapters = f.runtime();
    await adapters["github.install"]!.check(f.ctx, f.journal);
    await adapters.accounts!.check(f.ctx, f.journal);
    expect(f.checklistReadsAt).toHaveLength(1);
  });
});

describe("a checklist read that fails during the wait", () => {
  test.each([401, 403])("a %i ends the wait with a named reason", async (status) => {
    const f = fixture();
    const step = f.runtime()["github.install"]!;
    await step.check(f.ctx, f.journal);
    f.failNext.push(status);
    expect(await step.act!(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "connect_checklist_refused",
    });
  });

  test("a login that changes mid-wait ends it", async () => {
    const f = fixture();
    const step = f.runtime()["github.install"]!;
    await step.check(f.ctx, f.journal);
    f.after(() => {
      const cfg = loadConfig(f.home)!;
      writeConfig(f.home, { ...cfg, user: { ...cfg.user!, id: "person-b" } });
    });
    expect(await step.act!(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "connect_checklist_identity_unverified",
    });
  });

  test("a login that expires mid-wait asks for a new one", async () => {
    const f = fixture();
    const step = f.runtime()["github.install"]!;
    await step.check(f.ctx, f.journal);
    f.after(() => {
      const cfg = loadConfig(f.home)!;
      writeConfig(f.home, {
        ...cfg,
        key: undefined,
        auth: {
          kind: "oauth",
          accessToken: "expiring",
          refreshToken: "r",
          sessionId: "s",
          expiresAt: new Date(now).toISOString(),
        },
      });
    });
    expect(await step.act!(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "onboard_login_refresh_required",
    });
  });

  test("reads that keep failing are said once, and the wait carries on", async () => {
    const f = fixture();
    const step = f.runtime()["github.install"]!;
    await step.check(f.ctx, f.journal);
    f.failNext.push(503, 503, 503, 503);
    let polls = 0;
    f.after(() => {
      if (++polls === 5) f.state.github = item("github-app", "done");
    });
    expect((await step.act!(f.ctx, f.journal)).state).toBe("done");
    expect(f.notes).toEqual([
      "Setup could not check the Connect accounts page just now. It keeps checking.",
    ]);
  });
});

describe("a newer cloud's rows never switch the checklist off", () => {
  test.each([
    ["an unknown state", { ...item("linear-workspace"), state: "paused" }],
    ["an unknown who", { ...item("linear-personal"), who: "team" }],
    ["an unknown id", item("slack-workspace")],
  ])("a row with %s is skipped", async (_name, row) => {
    const f = fixture();
    f.state.github = item("github-app", "done");
    f.state.extra = [row as Item];
    expect(await f.runtime()["github.install"]!.check(f.ctx, f.journal)).toMatchObject({
      state: "done",
      evidence: { scope: "checklist" },
    });
  });
});

describe("a revoked login mid-wait ends the wait at once", () => {
  test.each([401, 403])("every route answering %i ends it with the refused reason", async (status) => {
    const f = fixture();
    const step = f.runtime()["github.install"]!;
    await step.check(f.ctx, f.journal);
    f.after(() => {
      f.revoked.status = status;
    });
    expect(await step.act!(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "connect_checklist_refused",
    });
    // The wait read only the checklist; the contract was checked once, when it started.
    expect(f.sleeps).toEqual([10_000]);
  });
});

test("a read cut off at the wait's deadline still counts toward the 10-second spacing", async () => {
  const f = fixture();
  const cache = { last: null };
  const page = { openedBy: null };
  let clockSleeps = 0;
  const adapter = connectChecklistAdapter({
    step: "github.install",
    item: "github-app",
    fallback: { check: async () => ({ state: "waiting", reason: "fixture" }) },
    openBrowser: () => {},
    wait: (_text, run) => run(),
    sleep: async () => {
      clockSleeps++;
      f.tick(10_000);
      await new Promise((resolve) => setImmediate(resolve));
    },
    page,
    cache,
    timeoutMs: 200,
  });
  expect(await adapter.check(f.ctx, f.journal)).toEqual({ state: "pending" });
  // The poll's first fresh read hangs until the wait's deadline cuts it off.
  f.hang.from = 2;
  expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({ reason: "consent_timeout" });
  f.hang.from = Infinity;
  f.state.github = item("github-app", "done");
  // "Yes, give me a new link": the retried act must not read inside 10 s of the cut-off read.
  expect((await adapter.act!(f.ctx, f.journal)).state).toBe("done");
  expect(f.checklistReadsAt.length).toBeGreaterThanOrEqual(3);
  expect(f.spacing()).toBe(true);
  expect(clockSleeps).toBeGreaterThan(0);
});

test("keep waiting does not open the Connect accounts page again: the wait points at the page already open", async () => {
  const f = fixture();
  const opened: string[] = [];
  const instructions: string[] = [];
  const adapter = connectChecklistAdapter({
    step: "github.install",
    item: "github-app",
    fallback: { check: async () => ({ state: "waiting", reason: "fixture" }) },
    openBrowser: (url) => {
      opened.push(url);
    },
    wait: (_text, run, page) => {
      instructions.push(page.instruction);
      return run();
    },
    sleep: async () => {
      f.tick(10_000);
      await new Promise((resolve) => setImmediate(resolve));
    },
    page: { openedBy: null },
    cache: { last: null },
    timeoutMs: 200,
  });
  expect(await adapter.check(f.ctx, f.journal)).toEqual({ state: "pending" });
  expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({ reason: "consent_timeout" });
  // "Yes, keep waiting": the same step waits again on the page it opened, without a new tab.
  expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({ reason: "consent_timeout" });
  expect(opened).toHaveLength(1);
  expect(instructions[1]).toMatch(/already open in your browser/);
});

test("an unknown row without canAct does not switch the checklist off", async () => {
  const f = fixture();
  f.state.github = item("github-app", "done");
  const { canAct: _dropped, ...row } = item("slack-workspace");
  f.state.extra = [row as Item];
  expect(await f.runtime()["github.install"]!.check(f.ctx, f.journal)).toMatchObject({
    state: "done",
    evidence: { scope: "checklist" },
  });
});

describe("which AI accounts the workspace may add follows the checklist", () => {
  test.each([
    [["subscription", "api-key"], "subscription,api-key"],
    [["api-key"], "api-key"],
    [undefined, "api-key"],
    [["api-key", "something-new"], "api-key"],
    ["subscription", "api-key"],
  ])("aiAccountKinds %j reads as %s", async (kinds, expected) => {
    const f = fixture();
    f.state.ai = item("ai-account", "done");
    f.state.kinds = kinds;
    expect(await f.runtime()["accounts"]!.check(f.ctx, f.journal)).toMatchObject({
      state: "done",
      evidence: { aiAccountKinds: expected },
    });
  });
  test("a step that still waits carries the kinds for its text", async () => {
    const f = fixture();
    f.state.kinds = ["subscription", "api-key"];
    expect(await f.runtime(["onboard", "--yes"])["accounts"]!.check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "account_enrollment_required",
      evidence: { aiAccountKinds: "subscription,api-key" },
    });
  });
  test("without the checklist the step says nothing about kinds, and its text falls back to API keys", async () => {
    const f = fixture({ checklist: false });
    expect(await f.runtime(["onboard", "--yes"])["accounts"]!.check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "account_enrollment_required",
    });
  });
});
