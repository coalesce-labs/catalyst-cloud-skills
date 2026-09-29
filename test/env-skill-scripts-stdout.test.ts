// env-skill-scripts-stdout.test.ts — M-3 (CTC-2496 validate attempt 29): the what-this-repo-needs
// scripts must not lose stdout they already wrote.
//
// ⛔ THESE TESTS MUST DRIVE THE REAL SCRIPT THROUGH A PIPE. `bin/catalyst-skills.js` documents this
// rule in full and obeys it; the two new scripts beside it reintroduced the defect by calling
// `process.exit(res.code)` straight after forwarding the CLI's stdout. On a pipe, process.stdout is
// asynchronous, so the exit severs the in-flight write AND STILL REPORTS THE ORIGINAL EXIT CODE:
// measured at 385,633 bytes of `--json` arriving as 65,536 bytes of invalid JSON at exit 0. Writing
// to a FILE hides it, because a file gives stdout a synchronous write path — which is exactly why
// this must be a pipe.
//
// The CLI under the script is a stand-in that emits a payload of a known size, so what is under test
// is the SCRIPT's own forwarding and exit, not the inventory scan (covered elsewhere).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsRoot = join(pkgRoot, "skills", "what-this-repo-needs", "scripts");
/** The pipe buffer on Linux/macOS is 64KB; the payload has to be comfortably past it. */
const PIPE_BUFFER_BYTES = 64 * 1024;
const ROWS = 4000;

/** A home whose recorded cliPath is a stand-in CLI printing `ROWS` rows of JSON and exiting `code`. */
function homeWithBigPayloadCli(code: number): string {
  const home = mkdtempSync(join(tmpdir(), "env-script-stdout-"));
  const cli = join(home, "fake-cli.mjs");
  writeFileSync(
    cli,
    [
      "const rows = Array.from({ length: " + ROWS + " }, (_, i) => ({ name: `NAME_${i}`, note: 'x'.repeat(40) }));",
      'process.stdout.write(JSON.stringify(rows));',
      `process.exitCode = ${code};`,
    ].join("\n"),
  );
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(join(home, ".config", "catalyst-cloud", "customer.json"), JSON.stringify({ baseUrl: "https://cloud.example", account: "tenant-fixture", cliPath: cli }));
  return home;
}

/** Spawn a skill script the way an agent harness does: stdout on a PIPE, read to the end. */
function runPiped(script: string, args: string[], home: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(scriptsRoot, script), ...args], {
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

describe.each([
  { script: "inventory.mjs", args: [".", "--json"] },
  { script: "check.mjs", args: ["catalyst.env.json", "--json"] },
])("$script forwards a --json answer larger than the pipe buffer complete", ({ script, args }) => {
  test("the body arrives whole and parses", { timeout: 30_000 }, async () => {
    const r = await runPiped(script, args, homeWithBigPayloadCli(0));
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(r.stdout);
    }, `stdout was cut off at ${r.stdout.length} bytes`).not.toThrow();
    expect((parsed as unknown[]).length).toBe(ROWS);
    // Positive control on the instrument, asserted against the COMPLETE payload: had it fitted in
    // the pipe buffer, a green parse above would have proved nothing about `process.exit`.
    expect(r.stdout.length, "the payload must clear the pipe buffer, or this test proves nothing").toBeGreaterThan(PIPE_BUFFER_BYTES);
  });

  test("a non-zero exit code still survives the drain", { timeout: 30_000 }, async () => {
    const r = await runPiped(script, args, homeWithBigPayloadCli(1));
    expect(r.status).toBe(1);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});
