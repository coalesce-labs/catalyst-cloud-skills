#!/usr/bin/env node
// explain.mjs — "why is this ticket stuck?" in one paragraph. A thin wrapper over
// `catalyst-skills explain <ticket>`, which reads the cloud's eligibility explainer for the ticket's
// team and translates the exclusion reason, the failure block and any advisories into plain English.
import { mustRun, parseFlags, printHelp } from "./lib/cli.mjs";

const SPEC = {
  json: { value: false, help: "print the raw eligibility row and the explanation as JSON" },
  history: { value: false, help: "ask for the per-ticket execution history (the CLI says when a key cannot see it yet)" },
};

const { help, flags, positionals } = parseFlags(process.argv.slice(2), SPEC);
const ticket = positionals[0];
if (help || !ticket) {
  printHelp("node scripts/explain.mjs <ticket> [--json] [--history] [--help]", SPEC, [
    "The ticket is its identifier (the KEY-123 shape). The explanation names the queue position, the status,",
    "the reason nothing is offered, the last failure, and what releases it; an unknown reason is printed as the",
    "cloud spelled it. Read references/why-is-it-stuck.md to turn the reason into the next action.",
  ]);
  process.exit(help ? 0 : 1);
}

const args = ["explain", ticket];
if (flags.history) args.push("--history");
if (flags.json) args.push("--json");
const r = mustRun(args);
process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
process.exit(0);
