#!/usr/bin/env node
// explain-ticket.mjs — why one ticket is, or is not, about to run: the cloud's own eligibility row
// for it, rendered as one paragraph, plus the raw row so the failure block is not lost.
import { exitOnFailure, parseFlags, parseJson, relayStderr, runCli, usage, wantsHelp } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/explain-ticket.mjs <ticket> [--json]

Asks Catalyst Cloud for the ticket's eligibility row (position, status, the exclusion reason in plain
English, the last failure, advisories) and prints it as one paragraph. Wraps: catalyst-skills explain.

  <ticket>   the Linear identifier, e.g. KEY-123
  --json     print the CLI's JSON document instead of the paragraph

Exit 0 explained (even when the ticket is excluded), 1 when the ticket is unknown to the mirror or
a usage error, 2 when this machine is not connected to a tenant or the cloud refused the read
(the line says which).`;

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
  console.log(HELP);
  process.exit(0);
}
const { flags, positionals } = parseFlags(argv, { bool: ["json"] });
const ticket = positionals[0];
if (!ticket) usage("explain-ticket needs a ticket identifier (see --help)");

const r = runCli(["explain", ticket, "--json"]);
exitOnFailure(r);
relayStderr(r);
const doc = parseJson(r.stdout);
if (!doc || typeof doc.explanation !== "string") {
  console.log(r.stdout.trimEnd());
  process.exit(1);
}
if (flags.json) {
  console.log(JSON.stringify(doc));
} else {
  console.log(doc.explanation);
  if (doc.row) console.log(`row: ${JSON.stringify(doc.row)}`);
}
process.exit(doc.row ? 0 : 1);
