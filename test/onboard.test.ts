import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { defaultCtx } from "../src/config.js";
import { main } from "../src/cli.js";
import {
  cmdOnboard,
  onboardLockPath,
  onboardStatePath,
  readOnboardJournal,
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
      expect.objectContaining({ id: "legacy", state: "skipped", reason: "fake_home_report_only" }),
    );
    expect(existsSync(join(path, ".catalyst"))).toBe(true);
    expect(readFileSync(join(path, ".catalyst", "sentinel"), "utf8")).toBe("kept data");
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
