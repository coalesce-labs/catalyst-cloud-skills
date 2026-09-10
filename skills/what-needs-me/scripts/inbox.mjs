#!/usr/bin/env node
// inbox.mjs — "what needs me?": the open asks on this tenant, ranked by what each answer releases.
// A thin wrapper over `catalyst-skills ask list`, which reads the open tickets carrying the team's
// ask label (from the contract), follows each one's blocking relations, and weights held work by
// priority. Prints the ranked list; --json prints the CLI's rows unchanged.
import { mustRun, parseFlags, parseJson, printHelp } from "./lib/cli.mjs";

const SPEC = {
  json: { value: false, help: "print the ranked rows as JSON: {identifier, title, state, blocks[], score}" },
  team: { value: true, help: "only asks whose identifier carries this team key" },
  all: { value: false, help: "include asks that hold nothing (by default they are listed last, marked)" },
};

const { help, flags } = parseFlags(process.argv.slice(2), SPEC);
if (help) {
  printHelp("node scripts/inbox.mjs [--json] [--team K] [--all] [--help]", SPEC, [
    "Rank: the sum over held open tickets of a priority weight (urgent 4 ... low 1, none 1), highest first.",
    "An ask that holds nothing is real but will not appear in the tenant's Waiting-on-me view; it is",
    "listed last with a marker so you can attach the work it should block (references/reading-the-inbox.md).",
  ]);
  process.exit(0);
}

const rows = parseJson(mustRun(["ask", "list", "--json"], { quiet: true }).stdout, "ask list");
const wanted = flags.team ? rows.filter((r) => String(r.identifier).toUpperCase().startsWith(`${flags.team.toUpperCase()}-`)) : rows;
if (flags.json) {
  process.stdout.write(JSON.stringify(wanted) + "\n");
  process.exit(0);
}
if (wanted.length === 0) {
  process.stdout.write("nothing needs you: no open asks\n");
  process.exit(0);
}
const holding = wanted.filter((r) => r.blocks.length > 0);
const idle = wanted.filter((r) => r.blocks.length === 0);
let n = 0;
for (const r of holding) {
  n += 1;
  process.stdout.write(`${n}. ${r.identifier}  holds ${r.blocks.length} (weight ${r.score}): ${r.blocks.join(", ")}\n   ${r.title}\n`);
}
if (idle.length && (flags.all || holding.length === 0)) {
  process.stdout.write(`${holding.length ? "\n" : ""}asks that hold nothing (not shown in Waiting on me until they block something):\n`);
  for (const r of idle) process.stdout.write(`   ${r.identifier}  ${r.title}\n`);
} else if (idle.length) {
  process.stdout.write(`\n(${idle.length} more ask${idle.length === 1 ? "" : "s"} hold nothing; --all lists them)\n`);
}
process.exit(0);
