#!/usr/bin/env node
// move.mjs — move a card by SLOT, never by stage name: the CLI resolves the slot to this team's
// live state id from the contract and refuses a slot that is unmapped or whose state is gone.
import { exitOnFailure, parseFlags, parseJson, relayStderr, runCli, usage, wantsHelp } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/move.mjs <ticket> (--slot <slot> | --state-type <type>) [--json]

Moves a ticket's card. Wraps: catalyst-skills write state. Spends one unit of the daily write budget.

  <ticket>              the Linear identifier, e.g. KEY-123
  --slot <slot>         one of the eleven slots: dispatch, intake, research, plan, implement,
                        remediate, verify, review, pr, done, canceled. Moving to dispatch is how
                        work is dispatched.
  --state-type <type>   the team's first state of this Linear type, resolved from its live
                        workflow states; use "backlog" to park a card (Backlog is not a slot)
  --json                print the CLI's JSON result

Exit 0 moved, 1 on a usage error, 2 when this machine is not connected to a tenant or the move
was refused (the slot is unmapped for the team, its state no longer exists in Linear, the daily
budget is spent; the line says which).`;

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
  console.log(HELP);
  process.exit(0);
}
const { flags, positionals } = parseFlags(argv, { bool: ["json"], value: ["slot", "state-type"] });
const ticket = positionals[0];
if (!ticket) usage("move needs a ticket identifier (see --help)");
if (!flags.slot && !flags["state-type"]) usage("move needs --slot <slot> or --state-type <type> (see --help)");
if (flags.slot && flags["state-type"]) usage("give --slot or --state-type, not both");

const args = ["write", "state", ticket, "--json"];
if (flags.slot) args.push("--slot", flags.slot);
else args.push("--state-type", flags["state-type"]);
const r = runCli(args);
exitOnFailure(r);
relayStderr(r);
const result = parseJson(r.stdout);
if (flags.json) console.log(JSON.stringify(result ?? {}));
else console.log(`${ticket} moved to ${flags.slot ? `slot ${flags.slot}` : `the team's ${flags["state-type"]} state`}`);
