#!/usr/bin/env node
// comment.mjs — post a comment on a ticket as the tenant's app actor through the agent proxy.
// A bookkeeping comment (a machine record, not a turn in a conversation) takes --bookkeeping, which
// prefixes the marker the contract's vocabulary names.
import { readFileSync } from "node:fs";
import { exitOnFailure, parseFlags, parseJson, relayStderr, runCli, usage, wantsHelp } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/comment.mjs <ticket> (--body <text> | --stdin) [--parent <commentId>] [--bookkeeping] [--as-user] [--json]

Posts one comment on a ticket. Wraps: catalyst-skills write comment. Spends one unit of the tenant's
daily write budget.

  <ticket>               the Linear identifier, e.g. KEY-123
  --body <text>          the comment body
  --stdin                read the body from stdin instead
  --parent <commentId>   reply under this comment (reply where the message arrived)
  --bookkeeping          this is a machine record: prefix the contract's bookkeeping marker so it
                         never reads as a human turn
  --as-user              post with the personal identity instead of the app actor (rare; then a
                         record needs --bookkeeping to avoid waking an agent)
  --json                 print the CLI's JSON result

Exit 0 posted, 1 on a usage error, 2 when this machine is not connected to a tenant or the write
was refused (the daily budget is spent, the ticket is unknown, the route is missing; the line
says which).`;

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
  console.log(HELP);
  process.exit(0);
}
const { flags, positionals } = parseFlags(argv, {
  bool: ["stdin", "bookkeeping", "as-user", "json"],
  value: ["body", "parent"],
});
const ticket = positionals[0];
if (!ticket) usage("comment needs a ticket identifier (see --help)");
if (!flags.body && !flags.stdin) usage("comment needs --body <text> or --stdin (see --help)");
if (flags.body && flags.stdin) usage("give --body or --stdin, not both");

let stdin;
const args = ["write", "comment", ticket, "--json"];
if (flags.stdin) {
  stdin = readFileSync(0, "utf8");
  if (!stdin.trim()) usage("stdin was empty");
  args.push("--stdin");
} else {
  args.push("--body", flags.body);
}
if (flags.parent) args.push("--parent", flags.parent);
if (flags.bookkeeping) args.push("--bookkeeping");
if (flags["as-user"]) args.push("--as-user");

const r = runCli(args, { stdin });
exitOnFailure(r);
relayStderr(r);
const result = parseJson(r.stdout);
if (flags.json) console.log(JSON.stringify(result ?? {}));
else console.log(`comment posted on ${ticket}${result && result.id ? ` (${result.id})` : ""}`);
