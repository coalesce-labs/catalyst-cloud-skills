import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseArgs } from "../src/args.js";
import { defaultCtx } from "../src/config.js";
import { UsageError } from "../src/errors.js";
import {
  cmdOnboard,
  onboardLockPath,
  onboardStatePath,
  onboardStateRoot,
  readOnboardJournal,
  type OnboardJournal,
} from "../src/onboard.js";

const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "onboard-main-compat-"));
  homes.push(home);
  const output: string[] = [],
    errors: string[] = [];
  const ctx = {
    ...defaultCtx(),
    home,
    env: {} as NodeJS.ProcessEnv,
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errors.push(line),
  };
  return { home, ctx, output, errors };
}
const legacyArgs = () =>
  parseArgs(["onboard", "--only", "legacy", "--yes", "--json"]);
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("onboarding main compatibility boundaries", () => {
  test("a literal JSON null receipt refuses without replacing recovery evidence", async () => {
    const f = fixture(),
      path = onboardStatePath(f.home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "null\n");
    let acted = false;
    await expect(
      cmdOnboard(legacyArgs(), f.ctx, {
        runStep: async () => {
          acted = true;
          return { state: "done" };
        },
      }),
    ).rejects.toMatchObject({ exitCode: 12 });
    expect(acted).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("null\n");
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });
  test("text dry run prints the human plan without creating state", async () => {
    const f = fixture();
    expect(await cmdOnboard(parseArgs(["onboard", "--dry-run"]), f.ctx)).toBe(
      0,
    );
    expect(f.output[0]).toBe("Catalyst setup plan");
    expect(f.output.some((line) => line.startsWith("Next: "))).toBe(true);
    expect(f.errors).toEqual([]);
    expect(readdirSync(f.home)).toEqual([]);
  });

  test("a live lock refusal emits exactly one JSON plan and retains ownership", async () => {
    const f = fixture(),
      lock = onboardLockPath(f.home);
    mkdirSync(lock, { recursive: true });
    const owner = JSON.stringify({
      pid: process.pid,
      token: "unrelated-live-owner",
    });
    writeFileSync(join(lock, "owner.json"), owner);
    let acted = false;
    expect(
      await cmdOnboard(legacyArgs(), f.ctx, {
        runStep: async () => {
          acted = true;
          return { state: "done" };
        },
      }),
    ).toBe(10);
    expect(acted).toBe(false);
    expect(f.output).toHaveLength(1);
    expect(JSON.parse(f.output[0]!)).toMatchObject({
      schema: 1,
      mode: "plan",
      complete: false,
      exit: 10,
    });
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(owner);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
  });

  test("JSON without Yes preserves an existing receipt and never asks interactive approval", async () => {
    const f = fixture(),
      path = onboardStatePath(f.home);
    const saved: OnboardJournal = {
      schema: 1,
      runId: "existing-run",
      installer: null,
      cli: "0.14.0",
      tenant: null,
      exit: 11,
      complete: false,
      operations: {},
      steps: [
        {
          id: "legacy",
          state: "waiting",
          reason: "action_required",
          at: "2026-09-30T16:00:00.000Z",
        },
      ],
      changes: [],
    };
    const bytes = JSON.stringify(saved, null, 2);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    let confirmations = 0;
    expect(
      await cmdOnboard(parseArgs(["onboard", "--json"]), f.ctx, {
        isTty: () => true,
        confirm: async () => {
          confirmations++;
          return false;
        },
      }),
    ).toBe(11);
    expect(confirmations).toBe(0);
    expect(f.output).toHaveLength(1);
    expect(JSON.parse(f.output[0]!)).toEqual(saved);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("non-TTY without Yes waits without confirmation, action or state", async () => {
    const f = fixture();
    let confirmations = 0,
      actions = 0;
    expect(
      await cmdOnboard(parseArgs(["onboard", "--only", "legacy"]), f.ctx, {
        isTty: () => false,
        confirm: async () => {
          confirmations++;
          return false;
        },
        runStep: async () => {
          actions++;
          return { state: "done" };
        },
      }),
    ).toBe(11);
    expect(confirmations).toBe(0);
    expect(actions).toBe(0);
    expect(f.errors.join("\n")).toContain("--yes");
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("explicit plain TTY Stop is exit zero without actions or state", async () => {
    const f = fixture();
    let confirmations = 0,
      actions = 0;
    expect(
      await cmdOnboard(parseArgs(["onboard", "--only", "legacy"]), f.ctx, {
        isTty: () => true,
        confirm: async () => {
          confirmations++;
          return false;
        },
        runStep: async () => {
          actions++;
          return { state: "done" };
        },
      }),
    ).toBe(0);
    expect(confirmations).toBe(1);
    expect(actions).toBe(0);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });
  test("explicit headless Yes retains the scoped local action and skips interactive confirmation", async () => {
    const f = fixture();
    let confirmations = 0,
      actions = 0;
    expect(
      await cmdOnboard(legacyArgs(), f.ctx, {
        isTty: () => false,
        confirm: async () => {
          confirmations++;
          return false;
        },
        runStep: async () => {
          actions++;
          return { state: "done" };
        },
      }),
    ).toBe(0);
    expect(confirmations).toBe(0);
    expect(actions).toBe(1);
    expect(f.output).toHaveLength(1);
    expect(JSON.parse(f.output[0]!)).toMatchObject({
      scope: "step",
      complete: false,
      exit: 0,
    });
    expect(
      readOnboardJournal(onboardStatePath(f.home))?.steps.find(
        (step) => step.id === "legacy",
      )?.state,
    ).toBe("done");
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });
  test.each([
    { tail: ["--only", "not-a-step"] },
    { tail: ["--resume-from", "not-a-step"] },
    { tail: ["extra"] },
  ])(
    "rejects invalid arguments $tail before accessing state",
    async ({ tail }) => {
      const f = fixture();
      let lookedUp = false;
      f.ctx.env.CATALYST_INSTALL_STATE_DIR = "relative-invalid-root";
      await expect(
        cmdOnboard(parseArgs(["onboard", ...tail]), f.ctx, {
          identity: async () => {
            lookedUp = true;
            return null;
          },
        }),
      ).rejects.toBeInstanceOf(UsageError);
      expect(lookedUp).toBe(false);
      expect(readdirSync(f.home)).toEqual([]);
    },
  );

  test("identity lookup failure emits safe JSON before acquiring the lock", async () => {
    const f = fixture();
    expect(
      await cmdOnboard(legacyArgs(), f.ctx, {
        identity: async () => {
          throw new Error("fixture-private-network-detail");
        },
      }),
    ).toBe(10);
    expect(f.output).toHaveLength(1);
    expect(JSON.parse(f.output[0]!)).toMatchObject({
      schema: 1,
      complete: false,
      exit: 10,
    });
    expect(f.errors.join("\n")).toContain(
      "Could not verify your Catalyst membership",
    );
    expect([...f.output, ...f.errors].join("\n")).not.toContain(
      "fixture-private-network-detail",
    );
    expect(readdirSync(f.home)).toEqual([]);
  });

  test("a pending step without an action remains waiting", async () => {
    const f = fixture();
    expect(
      await cmdOnboard(legacyArgs(), f.ctx, {
        adapters: { legacy: { check: async () => ({ state: "pending" }) } },
      }),
    ).toBe(11);
    expect(readOnboardJournal(onboardStatePath(f.home))?.steps).toContainEqual(
      expect.objectContaining({
        id: "legacy",
        state: "waiting",
        reason: "action_required",
      }),
    );
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("an already-aborted engine signal prevents checks and actions and releases its lock", async () => {
    const f = fixture(),
      controller = new AbortController();
    controller.abort();
    let checks = 0,
      actions = 0;
    expect(
      await cmdOnboard(legacyArgs(), f.ctx, {
        signal: controller.signal,
        bindSignals: false,
        adapters: {
          legacy: {
            check: async () => {
              checks++;
              return { state: "pending" };
            },
            act: async () => {
              actions++;
              return { state: "done" };
            },
          },
        },
      }),
    ).toBe(11);
    expect(checks).toBe(0);
    expect(actions).toBe(0);
    expect(JSON.parse(f.output[0]!)).toMatchObject({
      exit: 11,
      complete: false,
    });
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test.each(["external", "request"] as const)(
    "%s cancellation reaches the composed request signal",
    async (source) => {
      const f = fixture(),
        external = new AbortController(),
        request = new AbortController();
      let received: AbortSignal | undefined;
      f.ctx.fetch = async (_input, init) => {
        received = init?.signal as AbortSignal | undefined;
        expect(received?.aborted).toBe(false);
        (source === "external" ? external : request).abort();
        expect(received?.aborted).toBe(true);
        return new Response("offline stub");
      };
      expect(
        await cmdOnboard(legacyArgs(), f.ctx, {
          signal: external.signal,
          bindSignals: false,
          adapters: {
            legacy: {
              check: async (ctx) => {
                await ctx.fetch("https://example.test", {
                  signal: request.signal,
                });
                return { state: "done" };
              },
            },
          },
        }),
      ).toBe(source === "external" ? 11 : 0);
      expect(received).toBeDefined();
      expect(received).not.toBe(request.signal);
      expect(received).not.toBe(external.signal);
      expect(existsSync(onboardLockPath(f.home))).toBe(false);
    },
  );

  test("a valid selected machine-paths file places the receipt and lock under its state root", async () => {
    const f = fixture(),
      selected = join(f.home, "selected-state"),
      pathsFile = join(f.home, "machine-paths.json");
    const paths = Object.fromEntries(
      [
        "repoRoot",
        "worktrees",
        "logs",
        "events",
        "config",
        "cache",
        "skills",
      ].map((key) => [key, join(f.home, key)]),
    );
    writeFileSync(
      pathsFile,
      JSON.stringify({
        version: 1,
        paths: { ...paths, state: selected },
        provenance: {},
      }),
    );
    f.ctx.env.CATALYST_PATHS_FILE = pathsFile;
    expect(onboardStateRoot(f.home, f.ctx.env)).toBe(selected);
    expect(
      await cmdOnboard(legacyArgs(), f.ctx, {
        runStep: async () => {
          expect(existsSync(join(selected, "install.lock", "owner.json"))).toBe(
            true,
          );
          return { state: "done" };
        },
      }),
    ).toBe(0);
    expect(existsSync(join(selected, "install", "last-run.json"))).toBe(true);
    expect(existsSync(join(selected, "install.lock"))).toBe(false);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
  });
});
