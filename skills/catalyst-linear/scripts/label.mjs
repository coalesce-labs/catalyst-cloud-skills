#!/usr/bin/env node
// label.mjs — add or remove labels on a ticket. A Catalyst label name (ask, hold, release) resolves
// to the id the contract lists for this team; anything else is passed through as a label id.
import { exitOnFailure, parseFlags, parseJson, relayStderr, runCli, usage, wantsHelp } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/label.mjs <ticket> [--add <name|id>]... [--remove <name|id>]... [--json]

Adds and/or removes labels. Wraps: catalyst-skills write label. One write-budget unit per call
direction (add, remove), whatever the label count.

  <ticket>              the Linear identifier, e.g. KEY-123
  --add <name|id>       a label to add (repeatable)
  --remove <name|id>    a label to remove (repeatable)
  --json                print the CLI's JSON result

Names the contract knows (the ask marker, the hold label, the release label) resolve to this team's
label id; a name the workspace lacks is refused rather than guessed. Any other value is sent as a
label id unchanged.

Exit 0 written, 1 on a usage error, 2 when this machine is not connected to a tenant or the write
was refused (a Catalyst label the workspace lacks, the daily budget spent; the line says which).`;

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
  console.log(HELP);
  process.exit(0);
}
const { flags, positionals } = parseFlags(argv, { bool: ["json"], repeat: ["add", "remove"] });
const ticket = positionals[0];
if (!ticket) usage("label needs a ticket identifier (see --help)");
const add = flags.add ?? [];
const remove = flags.remove ?? [];
if (add.length === 0 && remove.length === 0) usage("label needs --add and/or --remove (see --help)");

const args = ["write", "label", ticket, "--json"];
for (const a of add) args.push("--add", a);
for (const x of remove) args.push("--remove", x);
const r = runCli(args);
exitOnFailure(r);
relayStderr(r);
const result = parseJson(r.stdout);
if (flags.json) console.log(JSON.stringify(result ?? {}));
else {
  const bits = [];
  if (add.length) bits.push(`added ${add.join(", ")}`);
  if (remove.length) bits.push(`removed ${remove.join(", ")}`);
  console.log(`${ticket}: ${bits.join("; ")}`);
}
