#!/usr/bin/env node
// create-ticket.mjs — file a new ticket on a team as the app actor. The team is named by its key;
// the CLI resolves the team id from the contract. A decision for a human is NOT a ticket filed here:
// that is an ask, raised through the what-needs-me skill so it carries options, a default and blocks.
import { exitOnFailure, parseFlags, parseJson, relayStderr, runCli, usage, wantsHelp } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/create-ticket.mjs --team <key> --title <text> [--label <name|id>]... [--priority <0-4>] [--as-user] [--json]

Creates one ticket. Wraps: catalyst-skills write create. Spends one unit of the daily write budget.

  --team <key>          the team key (the prefix of its ticket identifiers)
  --title <text>        the ticket title
  --label <name|id>     a label to apply (repeatable); Catalyst label names resolve via the contract
  --priority <0-4>      Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low
  --as-user             create with the personal identity instead of the app actor (rare)
  --json                print the CLI's JSON result (carries the new identifier)

Never cite the new ticket's identifier until this script has printed it. Do not use this to ask a
human a question: raise an ask instead (what-needs-me), or the question will look like work.

Exit 0 created, 1 on a usage error, 2 when this machine is not connected to a tenant or the write
was refused (an unknown team key, the daily budget spent; the line says which).`;

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
  console.log(HELP);
  process.exit(0);
}
const { flags } = parseFlags(argv, { bool: ["as-user", "json"], value: ["team", "title", "priority"], repeat: ["label"] });
if (!flags.team || !flags.title) usage("create-ticket needs --team <key> and --title <text> (see --help)");

const args = ["write", "create", "--team", flags.team, "--title", flags.title, "--json"];
for (const l of flags.label ?? []) args.push("--label", l);
if (flags.priority !== undefined) args.push("--priority", flags.priority);
if (flags["as-user"]) args.push("--as-user");
const r = runCli(args);
exitOnFailure(r);
relayStderr(r);
const result = parseJson(r.stdout);
if (flags.json) console.log(JSON.stringify(result ?? {}));
else {
  const ident = result && (result.identifier ?? result.id);
  console.log(`created${ident ? ` ${ident}` : ""} on team ${flags.team}: ${flags.title}`);
}
