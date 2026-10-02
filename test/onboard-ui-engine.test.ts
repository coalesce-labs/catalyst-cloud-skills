import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { main } from "../src/cli.js";
import { parseArgs } from "../src/args.js";
import { defaultCtx } from "../src/config.js";
import {
  cmdOnboard,
  ONBOARD_STEPS,
  onboardStatePath,
  onboardLockPath,
  type OnboardDeps,
  type OnboardStep,
  type OnboardJournal,
} from "../src/onboard.js";
import {
  createClackOnboardUi,
  type ClackOnboardPort,
  type OnboardUi,
} from "../src/onboard-ui.js";
import { createOnboardRuntime } from "../src/onboard-runtime.js";

const homes: string[] = [];
function fixture(localSync = false) {
  const home = mkdtempSync(join(tmpdir(), "onboard-ui-engine-"));
  homes.push(home);
  const output: string[] = [];
  const controller = new AbortController();
  const prompts: boolean[] = [];
  const ended: OnboardStep[] = [];
  const finished: OnboardJournal[] = [];
  let disposed = false;
  const ui: OnboardUi = {
    signal: controller.signal,
    plan: () => {},
    confirmPlan: async (initial) => {
      prompts.push(initial);
      return { proceed: true, localSync };
    },
    stepStart: () => {},
    stepEnd: (step) => ended.push({ ...step }),
    message: () => {},
    finish: (value) => finished.push(JSON.parse(JSON.stringify(value))),
    wait: async (_message, run) => run(),
    dispose: () => {
      disposed = true;
      controller.abort();
    },
  };
  const ctx = {
    ...defaultCtx(),
    home,
    env: {} as NodeJS.ProcessEnv,
    stdout: (text: string) => output.push(text),
    stderr: (_text: string) => {},
  };
  const receipt = () =>
    JSON.parse(readFileSync(onboardStatePath(home), "utf8"));
  return {
    ctx,
    ui,
    controller,
    prompts,
    ended,
    finished,
    output,
    receipt,
    disposed: () => disposed,
  };
}
function complete(): NonNullable<OnboardDeps["adapters"]> {
  return Object.fromEntries(
    ONBOARD_STEPS.map((id) => [
      id,
      { check: async () => ({ state: "done" as const }) },
    ]),
  );
}
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

test("one UI plan choice persists optional local sync and the native daemon honors it", async () => {
  const f = fixture(true);
  const args = parseArgs(["onboard"]);
  const runtime = createOnboardRuntime(args, f.ctx, {
    login: async () => 0,
    ready: async () => ({ state: "done" }),
  });
  const adapters = complete();
  adapters.daemon = runtime.adapters!.daemon;
  expect(
    await cmdOnboard(args, f.ctx, { ui: f.ui, adapters, bindSignals: false }),
  ).toBe(11);
  expect(f.prompts).toEqual([false]);
  expect(f.receipt()).toMatchObject({ localSync: true, complete: false });
  expect(
    f.receipt().steps.find((step: OnboardStep) => step.id === "daemon"),
  ).toMatchObject({
    state: "waiting",
    reason: "local_sync_capability_unavailable",
  });
});

test("authenticated bootstrap handoff still requires reviewed identity acceptance", async () => {
  const f = fixture();
  const path = onboardLockPath(f.ctx.home);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "owner.json"),
    JSON.stringify({ pid: process.pid, token: "ui-handoff" }),
  );
  writeFileSync(join(path, "pid"), String(process.pid));
  f.ctx.env.CATALYST_INSTALL_LOCK_TOKEN = "ui-handoff";
  const identity = {
    account: "tenant-a",
    membershipId: "person-a",
    baseUrl: "https://staging.catalystcloud.dev",
    role: "owner" as const,
    display: {
      personLabel: "Reviewed person",
      email: null,
      workspaceName: "Reviewed workspace",
      workspaceSlug: "reviewed",
    },
  };
  let displayed = false;
  f.ui.plan = (_journal, shown) => {
    expect(shown).toEqual(identity);
    displayed = true;
  };
  f.ui.confirmPlan = async (initial) => {
    expect(displayed).toBe(true);
    f.prompts.push(initial);
    return { proceed: true, localSync: false };
  };
  expect(
    await cmdOnboard(
      parseArgs(["onboard", "--resume-from", "install"]),
      f.ctx,
      {
        ui: f.ui,
        adapters: complete(),
        bindSignals: false,
        identity: async () => identity,
      },
    ),
  ).toBe(0);
  expect(f.prompts).toEqual([false]);
  expect(existsSync(path)).toBe(false);
});

test("stopping the bootstrap identity review preserves its receipt and lock", async () => {
  const f = fixture();
  const path = onboardLockPath(f.ctx.home);
  mkdirSync(path, { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, token: "ui-handoff-stop" });
  writeFileSync(join(path, "owner.json"), owner);
  writeFileSync(join(path, "pid"), String(process.pid));
  f.ctx.env.CATALYST_INSTALL_LOCK_TOKEN = "ui-handoff-stop";
  const receiptPath = onboardStatePath(f.ctx.home);
  mkdirSync(join(receiptPath, ".."), { recursive: true });
  const original = JSON.stringify({
    schema: 1,
    runId: "review-stop",
    installer: "0.13.6",
    cli: "0.14.6",
    tenant: null,
    exit: 11,
    steps: [],
    changes: [],
  });
  writeFileSync(receiptPath, original);
  let checks = 0;
  f.ui.confirmPlan = async (initial) => {
    f.prompts.push(initial);
    return { proceed: false, localSync: false };
  };
  const adapters = complete();
  adapters.signin = {
    check: async () => {
      checks++;
      return { state: "done" };
    },
  };
  expect(
    await cmdOnboard(
      parseArgs(["onboard", "--resume-from", "install"]),
      f.ctx,
      { ui: f.ui, adapters, bindSignals: false },
    ),
  ).toBe(0);
  expect(f.prompts).toEqual([false]);
  expect(checks).toBe(0);
  expect(readFileSync(receiptPath, "utf8")).toBe(original);
  expect(readFileSync(join(path, "owner.json"), "utf8")).toBe(owner);
});

test.each(["check", "act"] as const)(
  "UI cancellation during adapter %s saves interruption and releases the lock",
  async (phase) => {
    const f = fixture();
    const adapters = complete();
    adapters.legacy =
      phase === "check"
        ? {
            check: async (_ctx, _journal, signal) => {
              f.controller.abort();
              expect(signal?.aborted).toBe(true);
              return { state: "done" };
            },
          }
        : {
            check: async () => ({ state: "pending" }),
            act: async (_ctx, _journal, signal) => {
              f.controller.abort();
              expect(signal?.aborted).toBe(true);
              return { state: "done" };
            },
          };
    expect(
      await cmdOnboard(parseArgs(["onboard", "--only", "legacy"]), f.ctx, {
        ui: f.ui,
        adapters,
        bindSignals: false,
      }),
    ).toBe(11);
    expect(f.receipt()).toMatchObject({ exit: 11, complete: false });
    expect(
      f.receipt().steps.find((step: OnboardStep) => step.id === "legacy"),
    ).toMatchObject({ state: "failed", reason: "interrupted" });
    expect(existsSync(onboardLockPath(f.ctx.home))).toBe(false);
    expect(f.disposed()).toBe(true);
  },
);

test("verified full completion reaches the UI finish with its exact saved receipt", async () => {
  const f = fixture();
  expect(
    await cmdOnboard(parseArgs(["onboard"]), f.ctx, {
      ui: f.ui,
      adapters: complete(),
      bindSignals: false,
    }),
  ).toBe(0);
  expect(f.finished).toEqual([f.receipt()]);
  expect(f.finished[0]).toMatchObject({ exit: 0, complete: true });
  expect(f.ended.map((step) => step.id)).toEqual([...ONBOARD_STEPS]);
});

test("UI receives results for unavailable capabilities, blocked prerequisites, and member skips", async () => {
  const f = fixture();
  expect(
    await cmdOnboard(parseArgs(["onboard"]), f.ctx, {
      ui: f.ui,
      bindSignals: false,
      identity: async () => ({
        account: "tenant-a",
        membershipId: "person-a",
        baseUrl: "https://staging.catalystcloud.dev",
        role: "member",
      }),
      adapters: {
        signin: {
          check: async () => ({ state: "waiting", reason: "approval_pending" }),
        },
      },
    }),
  ).toBe(11);
  expect(f.ended).toContainEqual(
    expect.objectContaining({
      id: "machine",
      state: "waiting",
      reason: "step_not_available_in_this_release",
    }),
  );
  expect(f.ended).toContainEqual(
    expect.objectContaining({
      id: "github.personal",
      state: "waiting",
      reason: "prerequisite_not_ready",
    }),
  );
  expect(f.ended).toContainEqual(
    expect.objectContaining({
      id: "github.install",
      state: "skipped",
      reason: "member_scope",
    }),
  );
});

test("CLI JSON dry run emits one plain receipt without interactive plan or progress text", async () => {
  const f = fixture();
  expect(await main(["onboard", "--json", "--dry-run"], f.ctx)).toBe(0);
  expect(f.output).toHaveLength(1);
  expect(JSON.parse(f.output[0]!)).toMatchObject({
    schema: 1,
    mode: "plan",
    complete: false,
  });
  expect(f.output[0]).not.toContain("\u001b");
  expect(existsSync(onboardStatePath(f.ctx.home))).toBe(false);
  expect(existsSync(onboardLockPath(f.ctx.home))).toBe(false);
});

test("choosing cloud mode clears persisted local sync and the daemon follows the new choice", async () => {
  const f = fixture(false);
  const path = onboardStatePath(f.ctx.home);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      schema: 1,
      runId: "persisted-local",
      installer: null,
      cli: "0.14.1",
      tenant: null,
      exit: 11,
      localSync: true,
      steps: [],
      changes: [],
    }),
  );
  const args = parseArgs(["onboard"]);
  const native = createOnboardRuntime(args, f.ctx, {
    login: async () => 0,
    ready: async () => ({ state: "done" }),
  });
  const adapters = complete();
  adapters.daemon = native.adapters!.daemon;
  expect(
    await cmdOnboard(args, f.ctx, { ui: f.ui, adapters, bindSignals: false }),
  ).toBe(0);
  expect(f.prompts).toEqual([true]);
  expect(f.receipt().localSync).toBe(false);
  expect(
    f.receipt().steps.find((step: OnboardStep) => step.id === "daemon"),
  ).toMatchObject({ state: "skipped", reason: "local_sync_not_selected" });
});

test("cancelling the plan before lock acquisition returns waiting with no state mutations", async () => {
  const f = fixture();
  f.ui.confirmPlan = async () => {
    f.controller.abort();
    return { proceed: false, localSync: false };
  };
  expect(
    await cmdOnboard(parseArgs(["onboard"]), f.ctx, {
      ui: f.ui,
      adapters: complete(),
      bindSignals: false,
    }),
  ).toBe(11);
  expect(existsSync(onboardStatePath(f.ctx.home))).toBe(false);
  expect(existsSync(onboardLockPath(f.ctx.home))).toBe(false);
  expect(f.ended).toEqual([]);
  expect(f.finished).toEqual([]);
});

function renderedUi() {
  const events: Array<{ kind: string; text: string }> = [];
  const signals = new EventEmitter();
  let questions = 0;
  const log = (kind: string) => (text: string) => {
    events.push({ kind, text });
  };
  const port: ClackOnboardPort = {
    intro: log("intro"),
    outro: log("outro"),
    log: {
      message: log("message"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    },
    select: async () => {
      questions++;
      return "cloud";
    },
    isCancel: (value) => typeof value === "symbol",
  };
  const ui = createClackOnboardUi(
    port,
    { input: new PassThrough(), output: new PassThrough() },
    {
      signals,
      progress: { start: log("start"), stop: () => {}, dispose: () => {} },
    },
  );
  return {
    ui,
    events,
    questions: () => questions,
    cancel: () => signals.emit("SIGINT"),
  };
}

test("engine and Clack renderer present one coherent journey with honest waiting evidence", async () => {
  const f = fixture();
  const rendered = renderedUi();
  const adapters = complete();
  // A required step: deferred steps such as settings no longer hold the exit code.
  adapters.accounts = {
    check: async () => ({
      state: "waiting",
      reason: "onboarding_checks_pending",
    }),
  };
  expect(
    await cmdOnboard(parseArgs(["onboard"]), f.ctx, {
      ui: rendered.ui,
      adapters,
      bindSignals: false,
    }),
  ).toBe(11);
  expect(rendered.questions()).toBe(1);
  expect(
    rendered.events.filter((event) => event.kind === "intro"),
  ).toHaveLength(1);
  expect(
    rendered.events.filter((event) => event.kind === "outro"),
  ).toHaveLength(1);
  const messages = rendered.events
    .filter((event) => event.kind === "message")
    .map((event) => event.text);
  expect(messages).toEqual(
    expect.arrayContaining([
      "This computer",
      "Catalyst sign-in",
      "Connections",
      "Project setup",
      "Runner and services",
      "Work and readiness",
    ]),
  );
  expect(rendered.events).toContainEqual(
    expect.objectContaining({
      kind: "warn",
      text: expect.stringContaining("unverified"),
    }),
  );
  expect(
    rendered.events.filter((event) => event.kind === "outro")[0]!.text,
  ).toMatch(/resume/i);
  expect(rendered.events.map((event) => event.text).join("\n")).not.toContain(
    "Onboarding complete",
  );
  expect(f.receipt()).toMatchObject({ exit: 11, complete: false });
});

test("engine cancellation renders saved progress as paused rather than complete", async () => {
  const f = fixture();
  const rendered = renderedUi();
  const adapters = complete();
  adapters.legacy = {
    check: async () => {
      rendered.cancel();
      return { state: "done" };
    },
  };
  expect(
    await cmdOnboard(parseArgs(["onboard", "--only", "legacy"]), f.ctx, {
      ui: rendered.ui,
      adapters,
      bindSignals: false,
    }),
  ).toBe(11);
  const outro = rendered.events.find((event) => event.kind === "outro")!.text;
  expect(outro).toMatch(/paused.*saved/is);
  expect(outro).not.toMatch(/complete/i);
  expect(
    f.receipt().steps.find((step: OnboardStep) => step.id === "legacy"),
  ).toMatchObject({ state: "failed", reason: "interrupted" });
  expect(existsSync(onboardLockPath(f.ctx.home))).toBe(false);
});
