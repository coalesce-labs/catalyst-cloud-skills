import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { createSetupRenderer } from "../src/setup-render.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
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
  type OnboardStepResult,
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
              return { state: "waiting", reason: "interrupted" };
            },
          }
        : {
            check: async () => ({ state: "pending" }),
            act: async (_ctx, _journal, signal) => {
              f.controller.abort();
              expect(signal?.aborted).toBe(true);
              return { state: "waiting", reason: "interrupted" };
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
    ).toMatchObject({ state: "waiting", reason: "interrupted" });
    expect(existsSync(onboardLockPath(f.ctx.home))).toBe(false);
    expect(f.ended).toContainEqual(
      expect.objectContaining({
        id: "legacy",
        state: "waiting",
        reason: "interrupted",
      }),
    );
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
      return { state: "waiting", reason: "interrupted" };
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
  expect(rendered.events.find((e) => e.kind === "warn")).toBeDefined();
  expect(
    f.receipt().steps.find((step: OnboardStep) => step.id === "legacy"),
  ).toMatchObject({ state: "waiting", reason: "interrupted" });
  expect(existsSync(onboardLockPath(f.ctx.home))).toBe(false);
});

test.each([false, true])(
  "double Ctrl-C resolves the active shared setup step before the paused verdict (unicode=%s)",
  async (unicode) => {
    const f = fixture();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => (text += chunk));
    if (unicode) Object.assign(output, { isTTY: true, columns: 100 });
    const signals = new EventEmitter();
    const quiet = () => {};
    const ui = createClackOnboardUi(
      {
        intro: quiet,
        outro: quiet,
        log: { message: quiet, info: quiet, warn: quiet, error: quiet },
        select: async () => "stop",
        isCancel: () => false,
      },
      { input: new PassThrough(), output },
      {
        renderer: createSetupRenderer(
          output,
          unicode
            ? { TERM: "xterm-256color", LANG: "C.UTF-8" }
            : { NO_COLOR: "1" },
        ),
        signals,
        consentGiven: true,
        introduced: true,
        interactive: true,
        baseUrl: () => "https://cloud.test",
      },
    );
    const adapters = complete();
    adapters["github.install"] = {
      check: async () => ({ state: "pending" }),
      act: async (_ctx, _j, signal) =>
        ui.wait(
          "Waiting",
          () =>
            new Promise<OnboardStepResult>((resolve) =>
              signal!.addEventListener(
                "abort",
                () => resolve({ state: "waiting", reason: "interrupted" }),
                { once: true },
              ),
            ),
        ),
    };
    const run = cmdOnboard(
      parseArgs(["onboard", "--only", "github.install"]),
      f.ctx,
      { ui, adapters, bindSignals: false },
    );
    await vi.waitFor(() => expect(text).toContain("Ctrl-C skips this step."));
    signals.emit("SIGINT");
    await vi.waitFor(() =>
      expect(text).toContain("Press Ctrl-C again to stop setup."),
    );
    signals.emit("SIGINT");
    expect(await run).toBe(11);
    expect(text).toMatch(
      unicode
        ? /▲.*11 Install Catalyst on GitHub\s+skipped for now/
        : /\[!\].*11 Install Catalyst on GitHub\s+skipped for now/,
    );
    if (unicode) expect(text).toMatch(/\u001b\[\d+A\r\u001b\[J/);
    expect(text.indexOf("skipped for now")).toBeLessThan(
      text.indexOf("Setup paused"),
    );
    expect(
      f.receipt().steps.find((s: OnboardStep) => s.id === "github.install"),
    ).toMatchObject({ state: "waiting", reason: "interrupted" });
    expect(existsSync(onboardLockPath(f.ctx.home))).toBe(false);
  },
);

test("ordinary JSON treats the person-selected runner as required", async () => {
  const f = fixture();
  const adapters = complete();
  adapters.runner = {
    check: async () => ({
      state: "skipped",
      reason: "runner_docker_missing",
      evidence: { selected: true },
    }),
  };
  expect(
    await cmdOnboard(
      parseArgs(["onboard", "--runner", "--yes", "--json"]),
      f.ctx,
      { adapters, bindSignals: false },
    ),
  ).toBe(11);
  const doc = JSON.parse(f.output[0]!);
  expect(doc.verdict).toBe("not-ready");
  expect(doc.actions.map((a: { step: string }) => a.step)).toContain("runner");
});
test.each(["done", "failed"] as const)(
  "a late stop preserves a completed %s adapter result",
  async (state) => {
    const f = fixture();
    const adapters = complete();
    adapters.legacy = {
      check: async () => {
        f.controller.abort();
        return {
          state,
          ...(state === "failed" ? { reason: "verification_failed" } : {}),
        };
      },
    };
    expect(
      await cmdOnboard(parseArgs(["onboard", "--only", "legacy"]), f.ctx, {
        ui: f.ui,
        adapters,
        bindSignals: false,
      }),
    ).toBe(11);
    expect(
      f.receipt().steps.find((s: OnboardStep) => s.id === "legacy").state,
    ).toBe(state);
  },
);
test("JSON pause uses the current run signal when stopped between steps", async () => {
  const f = fixture();
  const adapters = complete();
  expect(
    await cmdOnboard(parseArgs(["onboard", "--yes", "--json"]), f.ctx, {
      adapters,
      beforeStep: async (id) => {
        if (id === "cli") process.emit("SIGHUP", "SIGHUP");
      },
    }),
  ).toBe(11);
  expect(JSON.parse(f.output[0]!).verdict).toBe("paused");
  expect(
    f.receipt().steps.find((s: OnboardStep) => s.id === "machine").state,
  ).toBe("done");
});

test("a display-only UI does not admit browser sign-in", async () => {
  const f = fixture();
  const stageSignin = vi.fn(async () => {
    throw new Error("unauthorized_signin");
  });
  expect(
    await cmdOnboard(parseArgs(["onboard"]), f.ctx, {
      ui: { ...f.ui, interactive: false },
      stageSignin,
      identity: async () => null,
      isTty: () => false,
      adapters: complete(),
      bindSignals: false,
    }),
  ).toBe(11);
  expect(stageSignin).not.toHaveBeenCalled();
});
test("a previous interrupted row does not label an ordinary scoped wait as paused", async () => {
  const f = fixture();
  const adapters = complete();
  adapters.legacy = {
    check: async () => ({ state: "waiting", reason: "interrupted" }),
  };
  expect(
    await cmdOnboard(
      parseArgs(["onboard", "--only", "legacy", "--yes"]),
      f.ctx,
      { adapters, bindSignals: false },
    ),
  ).toBe(11);
  adapters.cli = {
    check: async () => ({ state: "waiting", reason: "cli_install_unverified" }),
  };
  expect(
    await cmdOnboard(
      parseArgs(["onboard", "--only", "cli", "--yes", "--json"]),
      f.ctx,
      { adapters, bindSignals: false },
    ),
  ).toBe(11);
  expect(JSON.parse(f.output.at(-1)!).verdict).toBe("not-ready");
});

test("a display-only UI cannot approve the plan on a noninteractive machine", async () => {
  const f = fixture();
  const adapters = complete();
  const checked = vi.fn(async () => ({ state: "done" as const }));
  adapters.machine = { check: checked };
  expect(
    await cmdOnboard(parseArgs(["onboard"]), f.ctx, {
      ui: { ...f.ui, interactive: false },
      isTty: () => false,
      adapters,
      bindSignals: false,
    }),
  ).toBe(11);
  expect(checked).not.toHaveBeenCalled();
  expect(f.prompts).toEqual([]);
});


test("display-only presentation cannot acquire team-creation prompts", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const signals = new EventEmitter();
  const select = vi.fn(async () => "create");
  const text = vi.fn(async () => "TEAM");
  const port: ClackOnboardPort = {
    intro: () => {}, outro: () => {},
    log: { message: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    select, text, isCancel: () => false,
  };
  const ui = createClackOnboardUi(port, { input, output }, {
    interactive: false, signals,
    progress: { start: () => {}, stop: () => {}, dispose: () => {} },
  });
  const interactive = createClackOnboardUi(port, { input, output }, {
    signals,
    progress: { start: () => {}, stop: () => {}, dispose: () => {} },
  });
  try {
    expect(interactive.chooseTeam).toBeTypeOf("function");
    expect(interactive.nameNewTeam).toBeTypeOf("function");
    expect(ui.chooseTeam).toBeUndefined();
    expect(ui.nameNewTeam).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  } finally { ui.dispose(); interactive.dispose(); }
});

test("CTC-4680: a step that timed out keeps that reason when the person stops at Ready to try again", async () => {
  const f = fixture();
  const args = parseArgs(["onboard"]);
  const adapters = complete();
  adapters["linear.workspace"] = {
    check: async () => {
      // The person answered "Stop here" at the retry question, which aborts the UI.
      f.controller.abort();
      return { state: "waiting" as const, reason: "consent_timeout" };
    },
  };
  await cmdOnboard(args, f.ctx, { ui: f.ui, adapters, bindSignals: false });
  expect(
    f.receipt().steps.find((step: OnboardStep) => step.id === "linear.workspace"),
  ).toMatchObject({ state: "waiting", reason: "consent_timeout" });
});
