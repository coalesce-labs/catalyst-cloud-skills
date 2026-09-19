// run-evals-script.test.ts — every verdict branch of scripts/run-evals.mjs, exercised against
// test/fixtures/fake-claude.mjs so no credential, no network and no real `claude` binary are
// needed. `claude plugin eval`'s own exit code is ambiguous (a real regression, a closed
// early-access gate, an empty suite and a bad flag can all exit 1), so this file is what actually
// proves the wrapper never mistakes one of those for the others.
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const scriptPath = join(pkgRoot, "scripts", "run-evals.mjs");
const fakeClaude = join(pkgRoot, "test", "fixtures", "fake-claude.mjs");
const evalsRoot = join(pkgRoot, "evals");

/** The live roster, discovered exactly as scripts/run-evals.mjs discovers it. A result document is
 *  only a pass if it scored all of these, so every case-level branch below is exercised against a
 *  whole-roster document rather than a one-case one. */
const rosterNames = readdirSync(evalsRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(evalsRoot, e.name, "coverage.json")))
  .map((e) => e.name)
  .sort();

interface Grader {
  name: string;
  passed: boolean;
  explanation: string;
}
interface Arm {
  score: number;
  graders?: Grader[];
}
interface EvalCase {
  name: string;
  aggregates: { score: number };
  arms: { with: Arm[]; without: Arm[] };
}

function passingCase(name: string): EvalCase {
  return {
    name,
    aggregates: { score: 1 },
    arms: {
      with: [{ score: 1, graders: [{ name: `routes-to-${name.replace(/-routing$/, "")}`, passed: true, explanation: "" }] }],
      without: [{ score: 0 }],
    },
  };
}

/** A whole-roster result document: every roster case passes cleanly, except those an override
 *  replaces or `drop` removes entirely (the shape a short run writes). */
function fullDocument(overrides: EvalCase[] = [], drop: string[] = []) {
  const byName = new Map(overrides.map((c) => [c.name, c]));
  const dropped = new Set(drop);
  const cases = rosterNames.filter((n) => !dropped.has(n)).map((n) => byName.get(n) ?? passingCase(n));
  return { schemaVersion: 1, partial: false, costUsd: 0.4, cases, aggregates: { casesTotal: cases.length } };
}

function run(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_BIN: fakeClaude, ...env },
  });
}

function runWithDocument(doc: unknown, env: Record<string, string> = {}) {
  return run([], { FAKE_CLAUDE_GATE: "open", FAKE_CLAUDE_RESULT: JSON.stringify(doc), ...env });
}

describe("scripts/run-evals.mjs", () => {
  test("a closed early-access gate exits 1 and says so plainly", () => {
    const r = run(["--precondition-only"], { FAKE_CLAUDE_GATE: "closed" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the plugin-eval early-access gate is CLOSED");
    expect(r.stderr).toContain("This is not a passing suite");
  });

  test("an open gate reports 0 via --precondition-only without running the suite", () => {
    const r = run(["--precondition-only"], { FAKE_CLAUDE_GATE: "open" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("::notice");
  });

  test("a case scoring below 1 with the bundle loaded fails, naming the skill and the grader", () => {
    const r = runWithDocument(
      fullDocument([
        {
          name: "catalyst-linear-routing",
          aggregates: { score: 0.33 },
          arms: {
            with: [{ score: 0, graders: [{ name: "routes-to-catalyst-linear", passed: false, explanation: "Skill called 0x (expected 1..∞)" }] }],
            without: [{ score: 0 }],
          },
        },
      ]),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("catalyst-linear: case catalyst-linear-routing scored 0.33 with the bundle loaded");
    expect(r.stderr).toContain("Skill called 0x (expected 1..∞)");
  });

  test("a case that PASSES its no-plugin baseline arm fails as not testing the skill", () => {
    const r = runWithDocument(
      fullDocument([
        {
          name: "whats-happening-routing",
          aggregates: { score: 1 },
          arms: {
            with: [{ score: 1, graders: [{ name: "routes-to-whats-happening", passed: true, explanation: "" }] }],
            without: [{ score: 1 }],
          },
        },
      ]),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("whats-happening: case whats-happening-routing PASSED without the bundle loaded — it is not testing the skill");
  });

  test("a partial run is never a pass", () => {
    const r = runWithDocument({ schemaVersion: 1, partial: true, partialReason: "auth_failed", cases: [] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("partialReason: auth_failed");
    expect(r.stderr).toContain("a partial run is never a pass");
  });

  // The hollow-pass family: a document with no failing case is NOT a pass unless it actually
  // scored the roster. Before the roster guard, each of these exited 0 printing "every case
  // passed" — the CLI writes exactly this shape when it finds no cases, or when a case file
  // fails to load and is silently left out of the document.
  test("an empty case set fails instead of reporting a hollow pass", () => {
    const r = runWithDocument({ schemaVersion: 1, partial: false, costUsd: 0, cases: [], casesTotal: 0 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`the run scored 0 of the roster's ${rosterNames.length} case(s)`);
    expect(r.stdout).not.toContain("every case passed");
  });

  test("a run that skipped one roster case fails, naming the skill behind it", () => {
    const r = runWithDocument(fullDocument([], ["unstick-routing"]));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`the run scored ${rosterNames.length - 1} of the roster's ${rosterNames.length} case(s)`);
    expect(r.stderr).toContain("Never scored: unstick (unstick-routing)");
  });

  test("a document whose casesTotal disagrees with the cases it carries is never a pass", () => {
    const doc = fullDocument();
    const r = runWithDocument({ ...doc, aggregates: { casesTotal: doc.cases.length + 1 } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`reports casesTotal ${doc.cases.length + 1} but carries ${doc.cases.length} scored case(s)`);
  });

  test("a CLI killed before it finished is never a pass", () => {
    const r = runWithDocument(fullDocument(), { FAKE_CLAUDE_KILL: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("was killed by signal SIGKILL");
  });

  test("every case passing cleanly exits 0", () => {
    const r = runWithDocument(fullDocument());
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`every case passed with the bundle and failed without it — ${rosterNames.length} of ${rosterNames.length} roster case(s)`);
  });

  test("--help exits 0 and prints usage", () => {
    const r = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: node scripts/run-evals.mjs");
  });
});
