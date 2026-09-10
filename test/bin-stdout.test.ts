// bin-stdout.test.ts — the bin must not lose stdout it already wrote.
//
// ⛔ THIS TEST MUST DRIVE THE REAL BINARY THROUGH A PIPE. On a pipe, process.stdout is asynchronous,
// so `process.exit(code)` severs an in-flight write and the process still exits 0 — the caller gets
// a truncated body with a success code and cannot tell it from a complete one. A test that captures
// to a file or a tty gets a SYNCHRONOUS stdout and passes on the broken code, which is exactly how
// this shipped in 0.2.0. Every skill script spawns the CLI with `stdio: ["ignore", "pipe", "pipe"]`,
// so the pipe is the real caller's shape, not a contrivance.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

import { startMeFixture, type FixtureServer } from "./fixture";
import { joinedConfig, tempHome } from "./helpers";
import { configPathFor } from "../src/config";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const BIN = join(pkgRoot, "bin", "catalyst-skills.js");
/** The pipe buffer on Linux/macOS is 64KB; the payload has to be comfortably past it. */
const PIPE_BUFFER_BYTES = 64 * 1024;
const ROWS = 500;

let server: FixtureServer;
let home: string;

/** One issue row, padded so 500 of them clear the pipe buffer several times over. */
function bigIssue(n: number): Record<string, unknown> {
  return {
    id: `lin-big-${n}`,
    identifier: `ENG-${1000 + n}`,
    title: `Row ${n} — ${"padding ".repeat(20)}`,
    state: "Todo",
    assignee_name: null,
    priority: 3,
    project_id: null,
    team_id: "team-eng",
    updated_at: 1_756_100_000_000 + n,
    labels: [],
    relations: [],
    description: "x".repeat(200),
  };
}

beforeAll(async () => {
  // The bin loads dist/cli.js, so the compiled output has to be current for this test to be about
  // the bin at all. Building here (rather than assuming a prior `npm run build`) is what keeps a
  // stale dist from turning a real failure into a false pass.
  const built = spawnSync("npm", ["run", "build"], { cwd: pkgRoot, encoding: "utf8" });
  expect(built.status, `build failed:\n${built.stdout}\n${built.stderr}`).toBe(0);
  expect(existsSync(join(pkgRoot, "dist", "cli.js"))).toBe(true);

  server = await startMeFixture();
  server.issues = Array.from({ length: ROWS }, (_, i) => bigIssue(i));
  home = tempHome();
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(configPathFor(home), JSON.stringify(joinedConfig(server), null, 2), { mode: 0o600 });
}, 120_000);

afterAll(async () => {
  await server.close();
});

/** Spawn the bin the way a skill script does: stdout on a PIPE, read to the end. */
function runPiped(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: pkgRoot,
      env: { ...process.env, HOME: home, CATALYST_SKILLS_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test(
  "a --json answer larger than the pipe buffer arrives complete, not truncated",
  { timeout: 60_000 },
  async () => {
    const r = await runPiped(["query", "issues", "--json", "--limit", String(ROWS)]);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);

    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(r.stdout);
    }, `stdout was cut off at ${r.stdout.length} bytes`).not.toThrow();
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(ROWS);
    // Positive control on the instrument, asserted against the COMPLETE payload: had it fitted in
    // the pipe buffer, a green parse above would have proved nothing about `process.exit`.
    expect(
      JSON.stringify(parsed).length,
      "the payload must clear the pipe buffer, or this test proves nothing",
    ).toBeGreaterThan(PIPE_BUFFER_BYTES);
  },
);

test("a failing verb still exits non-zero through a pipe", { timeout: 60_000 }, async () => {
  const r = await runPiped(["query", "issue", "NOPE-404", "--json"]);
  expect(r.status).toBe(1);
});

test("a usage error still exits 1 through a pipe", { timeout: 60_000 }, async () => {
  const r = await runPiped(["definitely-not-a-verb"]);
  expect(r.status).toBe(1);
});
