#!/usr/bin/env node
// run-evals.mjs — CTC-2012 Tier 1a: the scored half of the CI gate. `claude plugin eval`'s exit
// code is ambiguous by itself (a real regression, a closed early-access gate, an empty suite and a
// bad flag can all exit 1), so this script never trusts it. It proves the early-access gate is open
// with the CLI's own documented self-test BEFORE reporting any verdict, then parses the written v1
// result document and fails on the four ways a "pass" can be hollow: a partial run (most commonly
// an unconfigured/rejected credential), a run that scored fewer cases than the evals/ roster holds
// (an empty or short suite reports no failing case and would otherwise read as green), a case that
// did not score 1.0 with the bundle loaded, or a case whose no-plugin baseline arm scored 1.0
// anyway (proof the case is not testing the skill).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// Pinned, not aliased — the CLI's own CI guidance is to pin `--model` so a model rollout does not
// look like a plugin regression. A retirement is a one-line change here; a rejected id fails the
// job loudly rather than drifting silently onto whatever an alias resolves to that day.
const EVAL_MODEL = "claude-sonnet-5";
const EVAL_JUDGE_MODEL = "claude-haiku-4-5-20251001";
const THRESHOLD = "1";
// 10 cases × 3 runs × 2 arms = 60 short read-only agent runs and 0 judge calls (every grader here
// is a structural tool_used grader) — this ceiling sits well above the expected bill.
const MAX_COST_USD = "20";

function usage() {
  console.log(`Usage: node scripts/run-evals.mjs [options]

Run the scored "claude plugin eval" suite over every case in evals/, and fail naming the skill
behind any case that did not pass cleanly with the bundle loaded and fail cleanly without it.

Options:
  --precondition-only   Only run the early-access gate self-test and report its verdict; do not
                         run the scored suite. Exit 0 if the gate is open, 1 if it is closed (or
                         gives an unrecognized answer).
  --help                 Show this message and exit 0.

Environment:
  CLAUDE_BIN   The Claude Code CLI binary to invoke (default: "claude"). Overridable so this
               script's own tests can substitute a shim that returns canned output with no
               credential and no network.
`);
}

function claudeBin() {
  return process.env.CLAUDE_BIN || "claude";
}

/** The CLI's own documented self-test: `plugin eval --no-publish` in an EMPTY directory answers
 *  "currently in early access" when the gate is closed, and "No eval cases found" when it is open —
 *  distinct messages, whichever exit code either one happens to return. This is the entire answer
 *  to `claude plugin eval`'s ambiguous exit codes: nothing below this runs, or reports a verdict,
 *  until this self-test has actually distinguished "closed" from "open". */
function probeGate() {
  const probeDir = mkdtempSync(join(tmpdir(), "plugin-eval-probe-"));
  try {
    const res = spawnSync(claudeBin(), ["plugin", "eval", ".", "--no-publish"], {
      cwd: probeDir,
      encoding: "utf8",
    });
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (output.includes("currently in early access")) return { open: false, output };
    if (output.includes("No eval cases found")) return { open: true, output };
    return { open: null, output };
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

function reportPrecondition(probe) {
  if (probe.open === true) {
    console.log("::notice::plugin eval is enabled on this runner (self-test saw 'No eval cases found' in an empty directory)");
    return 0;
  }
  if (probe.open === false) {
    console.error(
      `::error title=plugin eval::the plugin-eval early-access gate is CLOSED for this runner, so no skill was evaluated. This is not a passing suite. Ask whoever holds the early-access invite to add this runner's CLAUDE_CODE_WALNUT_SPIRE value as a repository secret. Probe said: ${probe.output.trim()}`,
    );
    return 1;
  }
  console.error(
    `::error title=plugin eval::the early-access self-test returned neither "currently in early access" nor "No eval cases found" — this is not a passing suite. Probe said: ${probe.output.trim()}`,
  );
  return 1;
}

/** skill name from a case name, by the roster's own `<skill>-routing` convention. */
function skillOf(caseName) {
  return caseName.replace(/-routing$/, "");
}

/** The roster this run has to have scored: every `evals/<name>/` directory carrying a
 *  `coverage.json`, discovered the same way test/evals-suite.test.ts discovers it (which also
 *  excludes the gitignored `evals/results/` run output, and separately pins this roster against
 *  src/cli.ts's CUSTOMER_SKILLS so a deleted case cannot quietly shrink it). Without this list the
 *  wrapper has nothing to compare a result document against, and a document carrying zero cases —
 *  what the CLI writes when it finds no cases at all, or when a case file fails to load — reads as
 *  "no case failed" and passes hollowly. */
function rosterCaseNames() {
  const evalsRoot = join(repoRoot, "evals");
  if (!existsSync(evalsRoot)) return [];
  return readdirSync(evalsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(evalsRoot, e.name, "coverage.json")))
    .map((e) => e.name)
    .sort();
}

function verdictFromDocument(doc, roster) {
  const errors = [];

  if (doc.partial === true) {
    errors.push(`::error title=plugin eval::the suite did not finish (partialReason: ${doc.partialReason}); a partial run is never a pass`);
    // A partial run's later cases never ran; nothing else in the document is trustworthy.
    return errors;
  }

  // The suite is only a pass if it actually scored the whole roster. An empty or short case set
  // produces no per-case error below, so without this check "0 of 10 cases failed" would print as
  // a green build — the exact hollow pass this wrapper exists to prevent.
  const scored = new Set((doc.cases ?? []).map((c) => c.name));
  if (roster.length === 0) {
    errors.push("::error title=plugin eval::no eval case was found under evals/ — an empty roster is never a pass");
  } else {
    const missing = roster.filter((name) => !scored.has(name));
    if (missing.length > 0) {
      const named = missing.map((name) => `${skillOf(name)} (${name})`).join(", ");
      errors.push(
        `::error title=plugin eval::the run scored ${scored.size} of the roster's ${roster.length} case(s) — a run that did not evaluate every case is never a pass. Never scored: ${named}`,
      );
    }
  }

  // casesTotal is the CLI's own count of the cases it ran; when it disagrees with the cases the
  // document actually carries, some case was counted but never recorded, and neither number can be
  // trusted on its own.
  const casesTotal = doc.aggregates?.casesTotal ?? doc.casesTotal;
  if (typeof casesTotal === "number" && casesTotal !== scored.size) {
    errors.push(
      `::error title=plugin eval::the result document reports casesTotal ${casesTotal} but carries ${scored.size} scored case(s) — an inconsistent document is never a pass`,
    );
  }

  for (const c of doc.cases ?? []) {
    const skill = skillOf(c.name);
    const score = c.aggregates?.score;
    if (typeof score === "number" && score < 1) {
      const explanations = new Set();
      for (const run of c.arms?.with ?? []) {
        for (const g of run.graders ?? []) {
          if (!g.passed) explanations.add(g.explanation ?? "no explanation given");
        }
      }
      const why = explanations.size > 0 ? [...explanations].join("; ") : "no failing grader explanation was recorded";
      errors.push(`::error title=plugin eval::${skill}: case ${c.name} scored ${score} with the bundle loaded — ${why}`);
    }

    const withoutPassed = (c.arms?.without ?? []).some((run) => run.score >= 1);
    if (withoutPassed) {
      errors.push(`::error title=plugin eval::${skill}: case ${c.name} PASSED without the bundle loaded — it is not testing the skill`);
    }
  }

  return errors;
}

function runSuite() {
  const outDir = mkdtempSync(join(tmpdir(), "plugin-eval-run-"));
  const outPath = join(outDir, "result.json");
  try {
    // Equivalent to: claude plugin eval . --json <path> --threshold 1 --ablation with-without
    // --model claude-sonnet-5 --judge-model claude-haiku-4-5-20251001 --no-publish --runs 3
    // --max-cost-usd 20
    const res = spawnSync(
      claudeBin(),
      [
        "plugin",
        "eval",
        ".",
        "--json",
        outPath,
        "--threshold",
        THRESHOLD,
        "--ablation",
        "with-without",
        "--model",
        EVAL_MODEL,
        "--judge-model",
        EVAL_JUDGE_MODEL,
        "--no-publish",
        "--runs",
        "3",
        "--max-cost-usd",
        MAX_COST_USD,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );

    // The exit code alone is ambiguous (see this file's header) and is deliberately not trusted as
    // a verdict — but a run that never started, or that was killed, produced no verdict at all and
    // must not fall through to a document that may be stale or absent.
    if (res.error) {
      console.error(`::error title=plugin eval::could not run "${claudeBin()}": ${res.error.message}`);
      return 1;
    }
    if (res.signal) {
      console.error(`::error title=plugin eval::"${claudeBin()}" was killed by signal ${res.signal} before it finished — a killed run is never a pass`);
      return 1;
    }

    let doc;
    try {
      doc = JSON.parse(readFileSync(outPath, "utf8"));
    } catch (err) {
      console.error(
        `::error title=plugin eval::could not read a result document from ${outPath} (the CLI exited ${res.status}): ${err.message}`,
      );
      return 1;
    }

    const roster = rosterCaseNames();
    const errors = verdictFromDocument(doc, roster);
    if (errors.length > 0) {
      for (const e of errors) console.error(e);
      return 1;
    }

    const casesTotal = (doc.cases ?? []).length;
    console.log(
      `every case passed with the bundle and failed without it — ${casesTotal} of ${roster.length} roster case(s), $${doc.costUsd ?? 0}`,
    );
    return 0;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return 0;
  }

  const probe = probeGate();
  if (args.includes("--precondition-only")) {
    return reportPrecondition(probe);
  }
  if (probe.open !== true) {
    return reportPrecondition(probe);
  }

  return runSuite();
}

process.exit(main());
