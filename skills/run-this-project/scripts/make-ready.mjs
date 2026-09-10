#!/usr/bin/env node
// make-ready.mjs — the two card moves a steward makes. Dispatch is a move into the team's dispatch
// slot; parking is a move into the team's backlog-type state, which is not a slot, so the CLI
// resolves it from the team's live workflow states. Every id comes from the contract or the live
// state list; nothing here names a stage.
import { CHECK_FAILED_EXIT, guard, parseFlags, parseJson, requireConfigured, runCli, wantsHelp } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/make-ready.mjs <ticket> [--park] [--note <text>] [--json]

Without --park: moves the card into the team's dispatch column, so the cloud offers its next phase.
With --park:    moves the card into the team's backlog-type state, so nothing further is offered.

Options:
  --note <text>   also post a bookkeeping comment saying why (prefixed with the contract's marker,
                  so it wakes nothing)
  --json          print the CLI's JSON answers instead of the summary lines
  --help          this text

After a dispatch move the script asks the eligibility explainer about the ticket and prints its
verdict. A verdict about a stale or unpublished ordering right after a move is normal: the cloud
re-derives the queue within a pass; ask again in a minute.

Exit codes: 2 not connected; 1 the move was refused (the CLI's reason is printed); 0 moved.`;

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
  console.log(HELP);
  process.exit(0);
}
const { flags, positionals } = parseFlags(argv, { values: ["note"], booleans: ["park", "json"] });
const ticket = positionals[0];
if (!ticket || positionals.length !== 1) {
  console.error("make-ready needs exactly one ticket identifier (see --help)");
  process.exit(CHECK_FAILED_EXIT);
}
requireConfigured();

const moveArgs = flags.park ? ["write", "state", ticket, "--state-type", "backlog"] : ["write", "state", ticket, "--slot", "dispatch"];
const moved = guard(await runCli([...moveArgs, "--json"]));
if (moved.code !== 0) {
  process.stderr.write(moved.stderr || moved.stdout);
  process.exit(CHECK_FAILED_EXIT);
}
const out = { ticket, action: flags.park ? "parked" : "dispatched", move: parseJson(moved.stdout) };

if (flags.note) {
  const body = `${flags.park ? "parked" : "dispatched"} by run-this-project: ${flags.note}`;
  const noted = guard(await runCli(["write", "comment", ticket, "--bookkeeping", "--body", body, "--json"]));
  out.note = noted.code === 0 ? parseJson(noted.stdout) : { failed: (noted.stderr || noted.stdout).trim() };
}

if (!flags.park) {
  const explained = guard(await runCli(["explain", ticket, "--json"]));
  out.eligibility = explained.code === 0 ? parseJson(explained.stdout) : { failed: (explained.stderr || explained.stdout).trim() };
}

if (flags.json) {
  console.log(JSON.stringify(out));
} else {
  console.log(`${ticket}: ${out.action}`);
  if (out.note) console.log(out.note.failed ? `note: not posted (${out.note.failed})` : "note: posted as a bookkeeping comment");
  if (out.eligibility) console.log(out.eligibility.failed ? `eligibility: unknown (${out.eligibility.failed})` : `eligibility: ${out.eligibility.explanation}`);
}
process.exit(0);
