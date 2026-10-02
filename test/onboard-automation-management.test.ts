import { afterEach, describe, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "../src/args.js";
import { configPathFor, defaultCtx } from "../src/config.js";
import { onboardAutomationManagementAdapter } from "../src/onboard-automation-management.js";
import { createOnboardRuntime } from "../src/onboard-runtime.js";
import {
  cmdOnboard,
  ONBOARD_STEPS,
  onboardLockPath,
  onboardStatePath,
  readOnboardJournal,
  type OnboardAdapter,
  type OnboardDeps,
  type OnboardIdentity,
  type OnboardJournal,
  type OnboardStepId,
  type OnboardStepResult,
} from "../src/onboard.js";
import type { OnboardUi } from "../src/onboard-ui.js";

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function fixture(role: OnboardIdentity["role"] = "owner") {
  const home = mkdtempSync(join(tmpdir(), "automation-management-"));
  homes.push(home);
  const output: string[] = [],
    errors: string[] = [];
  const network = vi.fn<typeof fetch>(async () => {
    throw new Error("unexpected actual network entry");
  });
  const ctx = {
    ...defaultCtx(),
    home,
    env: {},
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => errors.push(text),
    fetch: network,
    now: () => new Date("2026-10-01T08:00:00Z"),
  };
  const identity: OnboardIdentity = {
    account: "private-account",
    membershipId: "private-person",
    baseUrl: "https://private.example.test",
    role,
  };
  const journal: OnboardJournal = {
    schema: 1,
    runId: "private-management",
    installer: null,
    cli: "0.14.6",
    tenant: identity.account,
    account: identity.account,
    membershipId: identity.membershipId,
    baseUrl: identity.baseUrl,
    exit: null,
    steps: [],
    changes: [],
  };
  const config = configPathFor(home);
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(
    config,
    JSON.stringify({
      privateWitness: "existing off|managed metadata",
      account: identity.account,
    }),
  );
  const receipt = () => {
    const saved = readOnboardJournal(onboardStatePath(home), "0.14.6");
    if (!saved) throw new Error("missing actual engine receipt");
    return saved;
  };
  return {
    home,
    ctx,
    network,
    output,
    errors,
    identity,
    journal,
    config,
    receipt,
  };
}
function files(
  home: string,
): Record<string, { bytes: string; inode: number; mode: number }> {
  const result: Record<string, { bytes: string; inode: number; mode: number }> =
    {};
  function visit(directory: string) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name),
        st = statSync(path);
      if (st.isDirectory()) visit(path);
      else
        result[path.slice(home.length + 1)] = {
          bytes: readFileSync(path).toString("hex"),
          inode: st.ino,
          mode: st.mode,
        };
    }
  }
  visit(home);
  return result;
}
function ui(abort = new AbortController()): OnboardUi {
  return {
    signal: abort.signal,
    plan: vi.fn(),
    stepStart: vi.fn(),
    stepEnd: vi.fn(),
    finish: vi.fn(),
    dispose: vi.fn(),
    message: vi.fn(),
    confirmPlan: vi.fn(async () => {
      throw new Error("unexpected plan prompt");
    }),
    chooseTeam: vi.fn(async () => {
      throw new Error("unexpected team prompt");
    }),
    chooseRepositories: vi.fn(async () => {
      throw new Error("unexpected repository prompt");
    }),
    reviewSettings: vi.fn(async () => {
      throw new Error("unexpected settings prompt");
    }),
    chooseFirstRepository: vi.fn(async () => {
      throw new Error("unexpected first-project prompt");
    }),
    wait: async <T>(
      _message: string,
      operation: () => Promise<T>,
    ): Promise<T> => operation(),
  };
}
function requiredAdapter(
  runtime: OnboardDeps,
  id: OnboardStepId,
): OnboardAdapter {
  const adapter = runtime.adapters?.[id];
  if (!adapter) throw new Error("missing actual runtime adapter: " + id);
  return adapter;
}
function graph(f: ReturnType<typeof fixture>, automation: OnboardAdapter) {
  const adapters: NonNullable<OnboardDeps["adapters"]> = {};
  // These ports isolate the real engine's prerequisite policy; they do not prove provider readiness.
  for (const id of ONBOARD_STEPS)
    adapters[id] = { check: async () => ({ state: "done" }) };
  adapters["linear.automations"] = automation;
  let completed = false;
  const ticket = vi.fn(async (): Promise<OnboardStepResult> => {
    completed = true;
    return { state: "done" };
  });
  adapters["first-ticket"] = {
    check: async () => ({ state: completed ? "done" : "pending" }),
    act: ticket,
  };
  const deps: OnboardDeps = {
    adapters,
    identity: async () => f.identity,
    bindSignals: false,
  };
  return { adapters, ticket, deps };
}

describe("unbuilt automation management disposition", () => {
  test("direct adapter has no action and changes no real file, config, receipt or network state", async () => {
    const f = fixture(),
      before = files(f.home),
      message = vi.fn();
    const journalBefore = JSON.stringify(f.journal);
    const adapter = onboardAutomationManagementAdapter({ message });
    expect(adapter.act).toBeUndefined();
    expect(await adapter.check(f.ctx, f.journal)).toEqual({
      state: "skipped",
      reason: "automation_management_unavailable",
    });
    expect(files(f.home)).toEqual(before);
    expect(JSON.stringify(f.journal)).toBe(journalBefore);
    expect(f.network).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledTimes(1);
    expect(message.mock.calls[0]?.[0]).toContain(
      "Cloud readiness still checks your existing rules",
    );
    expect(f.output).toEqual([]);
    expect(f.errors).toEqual([]);
  });
  test("actual runtime management adapter bypasses capability GET and all prompts", async () => {
    const f = fixture(),
      port = ui(),
      before = files(f.home);
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ui: port,
      login: async () => {
        throw new Error("unexpected sign-in entry");
      },
      ready: async () => ({ state: "waiting", reason: "not_verified" }),
    });
    const adapter = requiredAdapter(runtime, "linear.automations");
    expect(await adapter.check(f.ctx, f.journal)).toEqual({
      state: "skipped",
      reason: "automation_management_unavailable",
    });
    expect(adapter.act).toBeUndefined();
    expect(f.network).not.toHaveBeenCalled();
    expect(files(f.home)).toEqual(before);
    expect(port.confirmPlan).not.toHaveBeenCalled();
    expect(port.chooseTeam).not.toHaveBeenCalled();
    expect(port.chooseRepositories).not.toHaveBeenCalled();
    expect(port.reviewSettings).not.toHaveBeenCalled();
    expect(port.chooseFirstRepository).not.toHaveBeenCalled();
    expect(port.message).toHaveBeenCalledTimes(1);
  });
  test("pre-aborted direct disposition returns waiting with no message or side effect", async () => {
    const f = fixture(),
      before = files(f.home),
      abort = new AbortController(),
      message = vi.fn();
    abort.abort(new Error("private stop"));
    expect(
      await onboardAutomationManagementAdapter({ message }).check(
        f.ctx,
        f.journal,
        abort.signal,
      ),
    ).toEqual({ state: "waiting", reason: "interrupted" });
    expect(message).not.toHaveBeenCalled();
    expect(f.network).not.toHaveBeenCalled();
    expect(files(f.home)).toEqual(before);
  });
  test("abort during synchronous message refuses the skipped positive", async () => {
    const f = fixture(),
      before = files(f.home),
      abort = new AbortController();
    const message = vi.fn(() => abort.abort(new Error("private message stop")));
    expect(
      await onboardAutomationManagementAdapter({ message }).check(
        f.ctx,
        f.journal,
        abort.signal,
      ),
    ).toEqual({ state: "waiting", reason: "interrupted" });
    expect(message).toHaveBeenCalledTimes(1);
    expect(f.network).not.toHaveBeenCalled();
    expect(files(f.home)).toEqual(before);
  });
  test("message failure remains a failure instead of returning an optional positive", async () => {
    const f = fixture(),
      failure = new Error("private renderer failure"),
      before = files(f.home);
    await expect(
      onboardAutomationManagementAdapter({
        message: () => {
          throw failure;
        },
      }).check(f.ctx, f.journal),
    ).rejects.toBe(failure);
    expect(f.network).not.toHaveBeenCalled();
    expect(files(f.home)).toEqual(before);
  });
});

describe("actual cmdOnboard optional-step graph policy", () => {
  test("only the exact skipped disposition satisfies first-ticket prerequisites", async () => {
    const f = fixture(),
      g = graph(f, onboardAutomationManagementAdapter());
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "first-ticket", "--yes", "--json"]),
        f.ctx,
        g.deps,
        "0.14.6",
      ),
    ).toBe(0);
    expect(g.ticket).toHaveBeenCalledTimes(1);
    expect(
      f.receipt().steps.find((step) => step.id === "linear.automations"),
    ).toMatchObject({
      state: "skipped",
      reason: "automation_management_unavailable",
    });
    expect(
      f.receipt().steps.find((step) => step.id === "first-ticket")?.state,
    ).toBe("done");
    expect(f.network).not.toHaveBeenCalled();
  });
  const denied: Array<{ id: OnboardStepId; result: OnboardStepResult }> = [
    {
      id: "linear.adopt",
      result: { state: "skipped", reason: "automation_management_unavailable" },
    },
    {
      id: "projects",
      result: { state: "skipped", reason: "automation_management_unavailable" },
    },
    {
      id: "linear.automations",
      result: {
        state: "skipped",
        reason: "step_not_available_in_this_release",
      },
    },
    {
      id: "linear.automations",
      result: { state: "waiting", reason: "automation_management_unavailable" },
    },
  ];
  test.each(denied)(
    "$id/$result.state/$result.reason remains unsatisfied",
    async ({ id, result }) => {
      const f = fixture(),
        g = graph(f, onboardAutomationManagementAdapter());
      g.adapters[id] = { check: async () => result };
      expect(
        await cmdOnboard(
          parseArgs(["onboard", "--only", "first-ticket", "--yes", "--json"]),
          f.ctx,
          g.deps,
          "0.14.6",
        ),
      ).toBe(11);
      expect(g.ticket).not.toHaveBeenCalled();
      expect(
        f.receipt().steps.find((step) => step.id === "first-ticket"),
      ).toMatchObject({ state: "waiting", reason: "prerequisite_not_ready" });
    },
  );
  test.each(["automation_conflict", "automation_unverified"])(
    "first-ticket's %s refusal survives the optional management skip",
    async (reason) => {
      const f = fixture(),
        g = graph(f, onboardAutomationManagementAdapter());
      g.adapters["first-ticket"] = {
        check: async () => ({ state: "waiting", reason }),
        act: g.ticket,
      };
      expect(
        await cmdOnboard(
          parseArgs(["onboard", "--only", "first-ticket", "--yes", "--json"]),
          f.ctx,
          g.deps,
          "0.14.6",
        ),
      ).toBe(11);
      expect(g.ticket).not.toHaveBeenCalled();
      expect(
        f.receipt().steps.find((step) => step.id === "first-ticket"),
      ).toMatchObject({ state: "waiting", reason });
    },
  );
  test("message abort in the engine produces no green receipt or dependent action", async () => {
    const f = fixture(),
      abort = new AbortController(),
      cfgBefore = readFileSync(f.config),
      g = graph(
        f,
        onboardAutomationManagementAdapter({ message: () => abort.abort() }),
      );
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "first-ticket", "--yes", "--json"]),
        f.ctx,
        { ...g.deps, signal: abort.signal },
        "0.14.6",
      ),
    ).toBe(11);
    expect(g.ticket).not.toHaveBeenCalled();
    expect(f.receipt().exit).toBe(11);
    expect(
      f.receipt().steps.find((step) => step.id === "linear.automations")?.state,
    ).not.toBe("skipped");
    expect(f.output).toHaveLength(1);
    expect(JSON.parse(f.output[0]!).complete).toBe(false);
    expect(readFileSync(f.config)).toEqual(cfgBefore);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });
  test("pre-aborted engine never enters management or a dependent action", async () => {
    const f = fixture(),
      abort = new AbortController(),
      message = vi.fn(),
      cfgBefore = readFileSync(f.config);
    const g = graph(f, onboardAutomationManagementAdapter({ message }));
    abort.abort();
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "first-ticket", "--yes", "--json"]),
        f.ctx,
        { ...g.deps, signal: abort.signal },
        "0.14.6",
      ),
    ).toBe(11);
    expect(message).not.toHaveBeenCalled();
    expect(g.ticket).not.toHaveBeenCalled();
    expect(f.network).not.toHaveBeenCalled();
    expect(f.receipt()).toMatchObject({ exit: 11, complete: false });
    expect(
      f.receipt().steps.find((step) => step.id === "linear.automations")?.state,
    ).not.toBe("skipped");
    expect(readFileSync(f.config)).toEqual(cfgBefore);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });
  test("member administration skips are preserved without entering automation management", async () => {
    const f = fixture("member"),
      management = vi.fn(onboardAutomationManagementAdapter().check),
      g = graph(f, { check: management });
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--yes", "--json"]),
        f.ctx,
        g.deps,
        "0.14.6",
      ),
    ).toBe(0);
    expect(management).not.toHaveBeenCalled();
    expect(g.ticket).not.toHaveBeenCalled();
    expect(
      f.receipt().steps.find((step) => step.id === "linear.automations"),
    ).toMatchObject({ state: "skipped", reason: "member_scope" });
    expect(
      f.receipt().steps.find((step) => step.id === "first-ticket"),
    ).toMatchObject({ state: "skipped", reason: "member_scope" });
  });
  test.each([false, true])(
    "local sync selection %s is kept and does not hold the first ticket",
    async (localSync) => {
      const f = fixture(),
        args = parseArgs([
          "onboard",
          "--only",
          "first-ticket",
          "--yes",
          "--json",
          ...(localSync ? ["--local-sync"] : []),
        ]);
      const runtime = createOnboardRuntime(args, f.ctx, {
        login: async () => {
          throw new Error("unexpected sign-in entry");
        },
        ready: async () => ({ state: "waiting", reason: "not_verified" }),
      });
      const g = graph(f, requiredAdapter(runtime, "linear.automations"));
      g.adapters.daemon = requiredAdapter(runtime, "daemon");
      expect(await cmdOnboard(args, f.ctx, g.deps, "0.14.6")).toBe(0);
      expect(f.receipt().localSync).toBe(localSync);
      // CTC-4477: local sync is optional for dispatch, so a first-ticket run leaves it unchecked.
      expect(
        f.receipt().steps.find((step) => step.id === "daemon"),
      ).toMatchObject({ state: "pending" });
      expect(g.ticket).toHaveBeenCalledTimes(1);
      expect(f.network).not.toHaveBeenCalled();
    },
  );
});
