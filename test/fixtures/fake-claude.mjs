#!/usr/bin/env node
// fake-claude.mjs — a shim for `claude` in run-evals-script.test.ts, so every branch of
// scripts/run-evals.mjs's verdict logic is testable with no credential and no network. It
// distinguishes the two calls run-evals.mjs makes exactly as the real CLI's own args do: the
// early-access self-test never passes --json, the scored run always does.
//
//   FAKE_CLAUDE_GATE     "open" (default) or "closed" — controls the self-test's answer.
//   FAKE_CLAUDE_RESULT   JSON text written to the --json path when the self-test is open.
//   FAKE_CLAUDE_KILL     set — the scored run dies on a signal before writing anything, standing
//                        in for a CLI the runner killed (OOM, job timeout) mid-suite.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const jsonIndex = args.indexOf("--json");

if (jsonIndex === -1) {
  const gate = process.env.FAKE_CLAUDE_GATE ?? "open";
  if (gate === "closed") {
    console.error("`plugin eval` is currently in early access");
    process.exit(1);
  }
  console.log("No eval cases found under /fake/empty-dir.");
  process.exit(1);
} else {
  const outPath = args[jsonIndex + 1];
  if (process.env.FAKE_CLAUDE_KILL) process.kill(process.pid, "SIGKILL");
  writeFileSync(outPath, process.env.FAKE_CLAUDE_RESULT ?? "{}");
  process.exit(0);
}
