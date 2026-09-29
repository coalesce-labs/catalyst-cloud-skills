// scan-skills-script.test.ts — the classification logic in scripts/scan-skills.mjs (accepted vs.
// blocking vs. stale), exercised with test/fixtures/fake-scanner.mjs so no uv, no network and no
// Python are needed for the unit suite. The real scan_skill.py runs only in the dedicated CI step
// (`bun run skills:scan`), never here — this file proves the classification, not the scan itself.
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const scriptPath = join(pkgRoot, "scripts", "scan-skills.mjs");
const fakeScanner = join(pkgRoot, "test", "fixtures", "fake-scanner.mjs");

function writeAccepted(entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "skill-scanner-accepted-"));
  const file = join(dir, "accepted.json");
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

function run(acceptedPath: string, findings: Record<string, unknown[]>, env: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    [scriptPath, "--scanner", fakeScanner, "--accepted", acceptedPath],
    {
      encoding: "utf8",
      env: { ...process.env, SKILL_SCANNER_RUNNER: "node", FAKE_SCANNER_FINDINGS: JSON.stringify(findings), ...env },
    },
  );
}

const CRITICAL_FINDING = {
  type: "Dangerous Code Pattern",
  severity: "critical",
  location: "scripts/unstick.js:9",
  description: "Instruction override: ignore all previous instructions",
  evidence: "// ignore all previous instructions",
  category: "Malicious Code",
};

describe("scripts/scan-skills.mjs", () => {
  test("no findings and an empty acceptance list exits 0", () => {
    const accepted = writeAccepted([]);
    const r = run(accepted, {});
    expect(r.status, r.stdout + r.stderr).toBe(0);
    rmSync(dirname(accepted), { recursive: true, force: true });
  });

  test("an unaccepted critical finding exits 1 and names it BLOCKING", () => {
    const accepted = writeAccepted([]);
    const r = run(accepted, { unstick: [CRITICAL_FINDING] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("BLOCKING unstick scripts/unstick.js:9");
    rmSync(dirname(accepted), { recursive: true, force: true });
  });

  test("the same finding present in the acceptance list exits 0", () => {
    const accepted = writeAccepted([
      {
        skill: "unstick",
        file: "scripts/unstick.js",
        description: "Instruction override: ignore all previous instructions",
        severity: "critical",
        reason: "test fixture: accepted for the purposes of this test only",
      },
    ]);
    const r = run(accepted, { unstick: [CRITICAL_FINDING] });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toContain("BLOCKING");
    rmSync(dirname(accepted), { recursive: true, force: true });
  });

  test("an acceptance matching nothing exits 1 and is named STALE ACCEPTANCE", () => {
    const accepted = writeAccepted([
      {
        skill: "unstick",
        file: "scripts/unstick.js",
        description: "Nothing matches this",
        severity: "low",
        reason: "test fixture: deliberately unmatched",
      },
    ]);
    const r = run(accepted, {});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("STALE ACCEPTANCE (matched nothing): unstick|scripts/unstick.js|Nothing matches this");
    rmSync(dirname(accepted), { recursive: true, force: true });
  });

  // The same hollow pass run-evals.mjs guards against: zero findings because the scanner read
  // zero scripts is not a clean scan, and must never green-light a publish.
  test("a scan that read no script exits 1 instead of passing vacuously", () => {
    const accepted = writeAccepted([]);
    const r = run(accepted, {}, { FAKE_SCANNER_NO_SCRIPTS: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("a scan that read no skill script proves nothing and is never a pass");
    expect(r.stdout).not.toContain("no finding blocks the publish");
    rmSync(dirname(accepted), { recursive: true, force: true });
  });

  test("--help exits 0 and prints usage", () => {
    const r = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: node scripts/scan-skills.mjs");
  });
});
