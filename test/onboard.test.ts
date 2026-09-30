import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { defaultCtx } from "../src/config.js";
import { CliError, UsageError } from "../src/errors.js";
import { main } from "../src/cli.js";
import {
  cmdOnboard,
  onboardLockPath,
  onboardStateRoot,
  onboardStatePath,
  readOnboardJournal,
  writeOnboardJournal,
  type OnboardDeps,
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
  const env: NodeJS.ProcessEnv = {
    ...base.env,
    XDG_STATE_HOME: join(path, ".local", "state"),
    CATALYST_INSTALL_STATE_DIR: join(path, ".local", "state", "catalyst"),
  };
  delete env.CATALYST_PATHS_FILE;
  delete env.CATALYST_STATE_DIR;
  return {
    ...base,
    home: path,
    env,
    stdout: (line: string) => output.push(line),
    stderr: (line: string) => errors.push(line),
    now: () => new Date("2026-09-30T14:00:00.000Z"),
  };
}

describe("catalyst onboard", () => {
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

  test("text dry run prints the human plan without locking", async () => {
    const path = home();
    const output: string[] = [];
    expect(await main(["onboard", "--dry-run"], context(path, output))).toBe(0);
    expect(output[0]).toBe("Catalyst setup plan");
    expect(output.join("\n")).toContain("Next: machine");
    expect(() => readFileSync(onboardStatePath(path))).toThrow();
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

  test("a lock refusal in JSON mode emits one plan with the exit code", async () => {
    const path = home();
    const lock = onboardLockPath(path);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 4244, token: "other" }),
    );
    const output: string[] = [];
    const errors: string[] = [];
    const code = await cmdOnboard(
      parseArgs(["onboard", "--only", "legacy", "--yes", "--json"]),
      context(path, output, errors),
      { processId: 100, isProcessAlive: () => true },
    );
    expect(code).toBe(10);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      exit: 10,
      steps: expect.any(Array),
    });
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
      expect.objectContaining({ id: "legacy", state: "done" }),
    );
    expect(errors.join("\n")).toContain("kept: data");
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

  test("reclaims a lock only after its owner process is confirmed gone", async () => {
    const path = home();
    const lock = onboardLockPath(path);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 4243, token: "stale" }),
    );
    const code = await cmdOnboard(
      parseArgs(["onboard", "--only", "legacy", "--yes"]),
      context(path),
      { processId: 101, isProcessAlive: () => false },
    );
    expect(code).toBe(0);
    expect(() => readFileSync(join(lock, "owner.json"))).toThrow();
  });

  test("reclaims a lock from this process only when the bootstrap token does not match", async () => {
    const path = home();
    const lock = onboardLockPath(path);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 101, token: "old-run" }));
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "legacy", "--yes"]),
        context(path),
        { processId: 101, token: () => "new-run" },
      ),
    ).toBe(0);
    expect(() => readFileSync(join(lock, "owner.json"))).toThrow();
  });

  test("reads legacy PID-only locks and protects a reused live installer PID", async () => {
    const staleHome = home();
    const staleLock = onboardLockPath(staleHome);
    mkdirSync(staleLock, { recursive: true });
    writeFileSync(join(staleLock, "pid"), "999999999\n");
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "legacy", "--yes"]),
        context(staleHome),
        { processId: 102 },
      ),
    ).toBe(0);

    const liveHome = home();
    const liveLock = onboardLockPath(liveHome);
    mkdirSync(liveLock, { recursive: true });
    writeFileSync(
      join(liveLock, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "old-run" }),
    );
    const errors: string[] = [];
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "legacy", "--yes"]),
        context(liveHome, [], errors),
        { processId: 103 },
      ),
    ).toBe(10);
    expect(errors.join("\n")).toContain(`already running (pid ${process.pid})`);
  });

  test.each([
    ["ps cannot inspect a live owner", "exit 1", 10],
    ["ps sees an onboarding CLI", "echo 'node catalyst onboard'; exit 0", 10],
    ["ps sees an unrelated process", "echo 'node unrelated'; exit 0", 0],
  ])(
    "uses the process command line to classify a lock owner: %s",
    async (_name, body, expected) => {
      const path = home();
      const bin = join(path, "bin");
      mkdirSync(bin);
      const ps = join(bin, "ps");
      writeFileSync(ps, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}:${previousPath ?? ""}`;
      const lock = onboardLockPath(path);
      mkdirSync(lock, { recursive: true });
      writeFileSync(
        join(lock, "owner.json"),
        JSON.stringify({ pid: process.ppid, token: "other" }),
      );
      try {
        const code = await cmdOnboard(
          parseArgs(["onboard", "--only", "legacy", "--yes"]),
          context(path),
          { processId: process.pid },
        );
        expect(code).toBe(expected);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    },
  );

  test("declining the plan does not write a receipt or acquire a lock", async () => {
    const path = home();
    const errors: string[] = [];
    const code = await cmdOnboard(
      parseArgs(["onboard", "--only", "legacy"]),
      context(path, [], errors),
      { isTty: () => true, confirm: async () => false },
    );
    expect(code).toBe(0);
    expect(errors.join("\n")).toContain("Nothing was changed");
    expect(() => readFileSync(onboardStatePath(path))).toThrow();
  });

  test("declining a JSON plan prints the unchanged receipt, and non-TTY defaults to yes", async () => {
    const declinedHome = home();
    const output: string[] = [];
    const errors: string[] = [];
    const declined = await cmdOnboard(
      parseArgs(["onboard", "--json"]),
      context(declinedHome, output, errors),
      { isTty: () => true, confirm: async () => false },
    );
    expect(declined).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({
      schema: 1,
      complete: false,
    });
    expect(() => readFileSync(onboardStatePath(declinedHome))).toThrow();

    const nonTtyHome = home();
    const nonTtyErrors: string[] = [];
    const nonTty = await cmdOnboard(
      parseArgs(["onboard", "--only", "legacy"]),
      context(nonTtyHome, [], nonTtyErrors),
      { runStep: async () => ({ state: "done" }) },
    );
    expect(nonTty).toBe(0);
    expect(nonTtyErrors.join("\n")).toContain("using the default answer Yes");
  });

  test("a refused step stops the run and returns the refusal exit code", async () => {
    const path = home();
    const code = await cmdOnboard(
      parseArgs(["onboard", "--only", "legacy", "--yes"]),
      context(path),
      {
        adapters: {
          legacy: {
            check: async () => ({
              state: "refused",
              reason: "permission_denied",
            }),
          },
        },
      },
    );
    expect(code).toBe(12);
    expect(readOnboardJournal(onboardStatePath(path))?.steps).toContainEqual(
      expect.objectContaining({
        id: "legacy",
        state: "failed",
        reason: "permission_denied",
      }),
    );
  });

  test("rejects unknown steps and positional arguments before touching state", async () => {
    const path = home();
    const ctx = context(path);
    await expect(
      cmdOnboard(parseArgs(["onboard", "--only", "not-a-step"]), ctx),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      cmdOnboard(parseArgs(["onboard", "--resume-from", "not-a-step"]), ctx),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      cmdOnboard(parseArgs(["onboard", "extra"]), ctx),
    ).rejects.toBeInstanceOf(UsageError);
    expect(() => readFileSync(onboardStatePath(path))).toThrow();
  });

  test("returns an identity lookup failure without acquiring the lock", async () => {
    const path = home();
    const errors: string[] = [];
    const code = await cmdOnboard(
      parseArgs(["onboard", "--yes"]),
      context(path, [], errors),
      {
        identity: async () => {
          throw new Error("network");
        },
      },
    );
    expect(code).toBe(10);
    expect(errors.join("\n")).toContain(
      "Could not verify your Catalyst membership",
    );
    expect(() => readFileSync(onboardLockPath(path))).toThrow();
  });

  test("a step without an action remains waiting and an action needs fresh verification", async () => {
    const path = home();
    const args = parseArgs(["onboard", "--only", "legacy", "--yes"]);
    const waitingCode = await cmdOnboard(args, context(path), {
      adapters: { legacy: { check: async () => ({ state: "pending" }) } },
    });
    expect(waitingCode).toBe(11);
    expect(readOnboardJournal(onboardStatePath(path))?.steps).toContainEqual(
      expect.objectContaining({
        id: "legacy",
        state: "waiting",
        reason: "action_required",
      }),
    );

    const second = home();
    let checks = 0;
    const verificationCode = await cmdOnboard(args, context(second), {
      adapters: {
        legacy: {
          check: async () =>
            ++checks === 1 ? { state: "pending" } : { state: "pending" },
          act: async () => ({ state: "done" }),
        },
      },
    });
    expect(verificationCode).toBe(11);
    expect(readOnboardJournal(onboardStatePath(second))?.steps).toContainEqual(
      expect.objectContaining({
        id: "legacy",
        state: "waiting",
        reason: "verification_pending",
      }),
    );
  });

  test("refreshes identity after sign-in and honors an already-aborted signal", async () => {
    const path = home();
    let identityReads = 0;
    const identity = {
      account: "tenant-a",
      membershipId: "member-a",
      baseUrl: "https://staging.catalystcloud.dev",
      role: "owner" as const,
    };
    const code = await cmdOnboard(
      parseArgs(["onboard", "--only", "signin", "--yes"]),
      context(path),
      {
        identity: async () => (++identityReads === 1 ? null : identity),
        adapters: {
          signin: {
            check: async (_ctx, journal) =>
              journal.account ? { state: "done" } : { state: "pending" },
            act: async () => ({ state: "done" }),
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(identityReads).toBe(3);

    const interruptedHome = home();
    const controller = new AbortController();
    controller.abort();
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "legacy", "--yes"]),
        context(interruptedHome),
        { signal: controller.signal },
      ),
    ).toBe(11);
  });

  test("composes external abort signals into step requests and supports an unbound test runner", async () => {
    const path = home();
    const ctx = context(path);
    let receivedSignal: AbortSignal | undefined;
    ctx.fetch = async (_input, init) => {
      receivedSignal = init?.signal as AbortSignal | undefined;
      return new Response("ok");
    };
    const code = await cmdOnboard(
      parseArgs(["onboard", "--only", "legacy", "--yes"]),
      ctx,
      {
        bindSignals: false,
        adapters: {
          legacy: {
            check: async (stepCtx) => {
              await stepCtx.fetch("https://example.test", {
                signal: new AbortController().signal,
              });
              return { state: "done" };
            },
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(receivedSignal?.aborted).toBe(false);
  });

  test("maps a refused adapter error to a refusal and sanitizes non-CLI exceptions", async () => {
    const refusedHome = home();
    const refused = await cmdOnboard(
      parseArgs(["onboard", "--only", "legacy", "--yes"]),
      context(refusedHome),
      {
        adapters: {
          legacy: {
            check: async () => {
              throw new CliError("no", "permission-denied", 12);
            },
          },
        },
      },
    );
    expect(refused).toBe(12);

    const failedHome = home();
    const errors: string[] = [];
    const failed = await cmdOnboard(
      parseArgs(["onboard", "--only", "legacy", "--yes"]),
      context(failedHome, [], errors),
      {
        adapters: {
          legacy: {
            check: async () => {
              throw new Error("secret=do-not-save");
            },
          },
        },
      },
    );
    expect(failed).toBe(10);
    expect(errors.join("\n")).not.toContain("do-not-save");
    expect(
      readOnboardJournal(onboardStatePath(failedHome))?.steps,
    ).toContainEqual(
      expect.objectContaining({
        id: "legacy",
        state: "failed",
        reason: "step_failed",
      }),
    );
  });

  test("refuses corrupted or symlinked setup receipts without replacing them", () => {
    const path = home();
    const statePath = onboardStatePath(path);
    mkdirSync(join(path, ".local", "state", "catalyst", "install"), {
      recursive: true,
    });
    writeFileSync(statePath, "not json");
    expect(() => readOnboardJournal(statePath)).toThrow(/not valid JSON/);
    rmSync(statePath);
    const target = join(path, "receipt.json");
    writeFileSync(target, JSON.stringify({ schema: 1, steps: [] }));
    symlinkSync(target, statePath);
    expect(() => readOnboardJournal(statePath)).toThrow(
      /cannot be a symbolic link/,
    );
  });

  test("refuses a symbolic-link parent before writing setup state", () => {
    const path = home();
    const target = join(path, "outside");
    mkdirSync(target);
    const parent = join(path, ".local", "state", "catalyst");
    mkdirSync(parent, { recursive: true });
    const installDir = join(parent, "install");
    symlinkSync(target, installDir);
    expect(() =>
      writeOnboardJournal(join(installDir, "last-run.json"), {
        schema: 1,
        runId: "test",
        installer: null,
        cli: "0.14.0",
        tenant: null,
        exit: null,
        steps: [],
        changes: [],
      }),
    ).toThrow(/must be a real directory/);
  });

  test("validates state roots and sanitizes imported journal fields", () => {
    const path = home();
    expect(
      onboardStateRoot(path, {
        CATALYST_INSTALL_STATE_DIR: "/tmp/catalyst-state",
      }),
    ).toBe("/tmp/catalyst-state");
    expect(() =>
      onboardStateRoot(path, { CATALYST_INSTALL_STATE_DIR: "relative" }),
    ).toThrow(/must be absolute/);
    expect(
      onboardStateRoot(path, { CATALYST_STATE_DIR: "/tmp/state-override" }),
    ).toBe("/tmp/state-override");
    expect(() =>
      onboardStateRoot(path, {
        CATALYST_PATHS_FILE: join(path, "absent.json"),
      }),
    ).toThrow(/selected machine paths file is missing/);
    const pathsFile = join(path, "machine-paths.json");
    writeFileSync(
      pathsFile,
      JSON.stringify({
        version: 1,
        paths: {
          repoRoot: "/tmp/repos",
          worktrees: "/tmp/worktrees",
          logs: "/tmp/logs",
          events: "/tmp/events",
          config: "/tmp/config",
          cache: "/tmp/cache",
          state: "/tmp/machine-state",
          skills: "/tmp/skills",
        },
        provenance: {},
      }),
    );
    expect(onboardStateRoot(path, { CATALYST_PATHS_FILE: pathsFile })).toBe(
      "/tmp/machine-state",
    );
    const statePath = onboardStatePath(path);
    mkdirSync(join(path, ".local", "state", "catalyst", "install"), {
      recursive: true,
    });
    writeFileSync(
      statePath,
      JSON.stringify({
        schema: 1,
        steps: [
          null,
          { id: "unknown", state: "done" },
          { id: "legacy", state: "nonsense", evidence: { token: "secret" } },
          {
            id: "legacy",
            state: "done",
            reason: "Not safe",
            evidence: { found: 1, token: "secret" },
          },
          {
            id: "signin",
            result: "interrupted",
            updatedAt: "then",
            evidence: { role: false, count: null, password: "secret" },
          },
          { id: "cli", result: "not_approved" },
          { id: "skills", result: "needs_you" },
          { id: "ready", result: "waiting" },
        ],
        operations: {
          legacy: "op-1",
          unknown: "op-2",
          signin: "has spaces",
          skills: "op:3",
        },
        changes: [
          null,
          { kind: "file", label: "settings", undo: "git checkout" },
          { kind: 1 },
          { kind: "file", label: 2, undo: "no" },
        ],
      }),
    );
    expect(readOnboardJournal(statePath)).toMatchObject({
      operations: { legacy: "op-1", skills: "op:3" },
      steps: [
        { id: "legacy", state: "done", evidence: { found: 1 } },
        { id: "signin", state: "failed" },
        { id: "cli", state: "waiting" },
        { id: "skills", state: "waiting" },
        { id: "ready", state: "waiting" },
      ],
      changes: [{ kind: "file", label: "settings", undo: "git checkout" }],
    });
  });

  test("migrates alternate receipt fields and discards malformed step rows", () => {
    const path = home();
    const statePath = onboardStatePath(path);
    mkdirSync(join(path, ".local", "state", "catalyst", "install"), {
      recursive: true,
    });
    writeFileSync(
      statePath,
      JSON.stringify({
        schema: 1,
        runId: 4,
        installer: "0.14.0-installer",
        cli: 4,
        tenant: "tenant-x",
        exit: null,
        exitCode: 7,
        startedAt: "started",
        steps: [
          { id: 42, state: "done" },
          { id: "legacy", state: 5 },
          {
            id: "legacy",
            result: "done",
            updatedAt: "updated",
            reason: "safe_reason",
          },
        ],
      }),
    );
    expect(readOnboardJournal(statePath)).toMatchObject({
      installer: "0.14.0-installer",
      cli: "0.14.0",
      tenant: "tenant-x",
      exit: 7,
      steps: [
        { id: "legacy", state: "done", at: "updated", reason: "safe_reason" },
      ],
    });
  });

  test.each([null, [], { schema: 1 }, { schema: 1, steps: "pending" }])(
    "refuses an unknown journal shape without replacing it: %s",
    (value) => {
      const path = home();
      const statePath = onboardStatePath(path);
      mkdirSync(join(path, ".local", "state", "catalyst", "install"), {
        recursive: true,
      });
      const original = JSON.stringify(value);
      writeFileSync(statePath, original);
      expect(() => readOnboardJournal(statePath)).toThrow(/unknown shape/);
      expect(readFileSync(statePath, "utf8")).toBe(original);
    },
  );

  test("refuses a symlinked lock path without following it", async () => {
    const path = home();
    const lock = onboardLockPath(path);
    const outside = join(path, "outside-lock");
    mkdirSync(join(path, ".local", "state", "catalyst"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "owner.json"), JSON.stringify({ pid: 99, token: "outside" }));
    symlinkSync(outside, lock);
    const errors: string[] = [];
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "legacy", "--yes"]),
        context(path, [], errors),
      ),
    ).toBe(12);
    expect(errors.join("\n")).toContain("not a real directory");
    expect(readFileSync(join(outside, "owner.json"), "utf8")).toContain("outside");
  });

  test("refuses a regular file at the lock path and preserves it", async () => {
    const path = home();
    const lock = onboardLockPath(path);
    mkdirSync(join(path, ".local", "state", "catalyst"), { recursive: true });
    writeFileSync(lock, "operator evidence");
    const errors: string[] = [];
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "legacy", "--yes"]),
        context(path, [], errors),
      ),
    ).toBe(12);
    expect(errors.join("\n")).toContain("not a real directory");
    expect(readFileSync(lock, "utf8")).toBe("operator evidence");
  });

  test("refuses a symlinked journal instead of treating it as a saved run", () => {
    const path = home();
    const statePath = onboardStatePath(path);
    mkdirSync(join(path, ".local", "state", "catalyst", "install"), {
      recursive: true,
    });
    const outside = join(path, "outside-journal.json");
    writeFileSync(outside, JSON.stringify({ schema: 1, steps: [] }));
    symlinkSync(outside, statePath);
    expect(() => readOnboardJournal(statePath)).toThrow(/symbolic link/);
  });

  test("does not reclaim a dead lock after its owner token changes during the liveness check", async () => {
    const path = home();
    const lock = onboardLockPath(path);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 4243, token: "old" }));
    const errors: string[] = [];
    const code = await cmdOnboard(
      parseArgs(["onboard", "--only", "legacy", "--yes"]),
      context(path, [], errors),
      {
        processId: 101,
        isProcessAlive: () => {
          writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 4243, token: "replacement" }));
          return false;
        },
      },
    );
    expect(code).toBe(12);
    expect(errors.join("\n")).toContain("could not be safely reclaimed");
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toContain("replacement");
  });

  test("does not reclaim a lock path replaced with a file during the liveness check", async () => {
    const path = home();
    const lock = onboardLockPath(path);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 4243, token: "old" }));
    const errors: string[] = [];
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "legacy", "--yes"]),
        context(path, [], errors),
        {
          processId: 101,
          isProcessAlive: () => {
            rmSync(lock, { recursive: true });
            writeFileSync(lock, "replacement file");
            return false;
          },
        },
      ),
    ).toBe(12);
    expect(errors.join("\n")).toContain("could not be safely reclaimed");
    expect(readFileSync(lock, "utf8")).toBe("replacement file");
  });

  test("release leaves a replacement file at the lock path untouched", async () => {
    const path = home();
    const lock = onboardLockPath(path);
    const code = await cmdOnboard(
      parseArgs(["onboard", "--only", "legacy", "--yes"]),
      context(path),
      {
        processId: 101,
        token: () => "owner-token",
        runStep: async () => {
          rmSync(lock, { recursive: true });
          writeFileSync(lock, "replacement file");
          return { state: "done" };
        },
      },
    );
    expect(code).toBe(0);
    expect(readFileSync(lock, "utf8")).toBe("replacement file");
  });

  test.each([
    ["membership", { membershipId: "member-b" }],
    ["cloud", { baseUrl: "https://other.example" }],
  ])("refuses to resume under a different %s", async (_kind, changed) => {
    const path = home();
    mkdirSync(join(path, ".local", "state", "catalyst", "install"), {
      recursive: true,
    });
    writeFileSync(
      onboardStatePath(path),
      JSON.stringify({
        schema: 1,
        runId: "saved",
        cli: "0.14.0",
        tenant: "tenant-a",
        account: "tenant-a",
        membershipId: "member-a",
        baseUrl: "https://staging.catalystcloud.dev",
        steps: [],
        changes: [],
      }),
    );
    const errors: string[] = [];
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "legacy", "--yes"]),
        context(path, [], errors),
        {
          identity: async () => ({
            account: "tenant-a",
            membershipId: "member-a",
            baseUrl: "https://staging.catalystcloud.dev",
            role: "owner" as const,
            ...changed,
          }),
        },
      ),
    ).toBe(12);
    expect(errors.join("\n")).toContain("belongs to another workspace or member");
    expect(() => readFileSync(join(onboardLockPath(path), "owner.json"))).toThrow();
  });

  test("a generic identity lookup failure leaves existing setup state untouched", async () => {
    const path = home();
    const statePath = onboardStatePath(path);
    mkdirSync(join(path, ".local", "state", "catalyst", "install"), {
      recursive: true,
    });
    const original = JSON.stringify({ schema: 1, runId: "saved", steps: [] });
    writeFileSync(statePath, original);
    const errors: string[] = [];
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "legacy", "--yes"]),
        context(path, [], errors),
        { identity: async () => { throw new Error("transport detail"); } },
      ),
    ).toBe(10);
    expect(errors.join("\n")).toContain("Could not verify your Catalyst membership");
    expect(errors.join("\n")).not.toContain("transport detail");
    expect(readFileSync(statePath, "utf8")).toBe(original);
  });

  test("resume-from checks earlier steps without acting on them", async () => {
    const path = home();
    const actions: string[] = [];
    const adapters = Object.fromEntries(
      ["machine", "cli", "skills", "legacy", "signin", "linear.workspace", "linear.personal", "linear.team", "linear.adopt", "linear.automations", "github.install", "github.repos", "projects", "accounts", "settings", "values", "capacity", "daemon", "housekeeping", "first-ticket", "ready"].map((id) => [id, {
        check: async () => id === "legacy" || id === "signin" ? { state: "pending" as const } : { state: "done" as const },
        act: async () => { actions.push(id); return { state: "done" as const }; },
      }]),
    );
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--resume-from", "signin", "--yes"]),
        context(path),
        { adapters },
      ),
    ).toBe(11);
    expect(actions).toContain("signin");
    expect(actions).not.toContain("legacy");
  });

  test("the install handoff resume inherits consent and checks only sign-in", async () => {
    const path = home();
    const errors: string[] = [];
    const ctx = context(path, [], errors);
    ctx.env.CATALYST_INSTALL_LOCK_TOKEN = "bootstrap-token";
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--resume-from", "install", "--only", "signin"]),
        ctx,
        { adapters: { signin: { check: async () => ({ state: "done" }) } } },
      ),
    ).toBe(0);
    expect(errors.join("\n")).not.toContain("Nothing was changed");
    expect(readOnboardJournal(onboardStatePath(path))?.steps).toContainEqual(
      expect.objectContaining({ id: "signin", state: "done" }),
    );
  });

  test("first-ticket dependency closure visits shared prerequisites once and verifies them", async () => {
    const path = home();
    const adapters = Object.fromEntries(
      ["machine", "cli", "skills", "legacy", "signin", "linear.workspace", "linear.personal", "linear.team", "linear.adopt", "linear.automations", "github.install", "github.repos", "projects", "accounts", "settings", "values", "capacity", "daemon", "housekeeping", "first-ticket", "ready"].map((id) => [id, { check: async () => ({ state: "done" as const }) }]),
    );
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "first-ticket", "--yes"]),
        context(path),
        { adapters },
      ),
    ).toBe(0);
    const steps = readOnboardJournal(onboardStatePath(path))!.steps;
    expect(steps.map((step) => step.id)).toEqual([...new Set(steps.map((step) => step.id))]);
    expect(steps.find((step) => step.id === "first-ticket")?.state).toBe("done");
  });

  test("rejects an invalid bootstrap state path before reading or writing a journal", async () => {
    const path = home();
    const ctx = context(path);
    ctx.env.CATALYST_INSTALL_STATE_DIR = "relative-state";
    await expect(
      cmdOnboard(parseArgs(["onboard", "--dry-run"]), ctx),
    ).rejects.toBeInstanceOf(CliError);
    expect(() => readFileSync(onboardStatePath(path))).toThrow();
  });

  test("uses the documented yes default when no terminal is attached", async () => {
    const path = home();
    const errors: string[] = [];
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "legacy"]),
        context(path, [], errors),
      ),
    ).toBe(0);
    expect(errors.join("\n")).toContain("No terminal is attached; using the default answer Yes");
    expect(readOnboardJournal(onboardStatePath(path))?.steps).toContainEqual(
      expect.objectContaining({ id: "legacy", state: "skipped" }),
    );
  });

  test("a confirmed prompt can proceed with an injected terminal reader", async () => {
    const path = home();
    const prompts: string[] = [];
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "legacy"]),
        context(path),
        {
          isTty: () => true,
          confirm: async (question) => { prompts.push(question); return true; },
        },
      ),
    ).toBe(0);
    expect(prompts).toEqual(["Continue? [Y/n] "]);
  });

  test("accepts a resumed action that is still waiting on an external consent", async () => {
    const path = home();
    const code = await cmdOnboard(
      parseArgs(["onboard", "--only", "linear.workspace", "--yes"]),
      context(path),
      {
        adapters: {
          signin: { check: async () => ({ state: "done" }) },
          "linear.workspace": {
            check: async () => ({ state: "pending" }),
            act: async () => ({ state: "waiting", reason: "consent_pending" }),
          },
        },
      },
    );
    expect(code).toBe(11);
    expect(readOnboardJournal(onboardStatePath(path))?.steps).toContainEqual(
      expect.objectContaining({ id: "linear.workspace", state: "waiting", reason: "consent_pending" }),
    );
  });

  test.each([
    ["--only", "not-a-step"],
    ["--resume-from", "not-a-step"],
  ])("rejects an unknown requested onboarding step (%s)", async (flag, value) => {
    await expect(
      cmdOnboard(
        parseArgs(["onboard", flag, value, "--yes"]),
        context(home()),
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });

  test("a workspace change after lock acquisition refuses before running a step", async () => {
    const path = home();
    const statePath = onboardStatePath(path);
    mkdirSync(join(path, ".local", "state", "catalyst", "install"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      schema: 1,
      runId: "saved",
      cli: "0.14.0",
      tenant: "tenant-a",
      account: "tenant-a",
      membershipId: "member-a",
      baseUrl: "https://staging.catalystcloud.dev",
      steps: [],
      changes: [],
    }));
    let reads = 0;
    const errors: string[] = [];
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--only", "legacy", "--yes"]),
        context(path, [], errors),
        {
          identity: async () => {
            reads += 1;
            return {
              account: "tenant-a",
              membershipId: "member-a",
              baseUrl: reads === 1 ? "https://staging.catalystcloud.dev" : "https://other.example",
              role: "owner",
            };
          },
          runStep: async () => { throw new Error("must not run"); },
        },
      ),
    ).toBe(12);
    expect(errors.join("\n")).toContain("onboard_identity_mismatch");
    expect(reads).toBe(2);
  });
});
