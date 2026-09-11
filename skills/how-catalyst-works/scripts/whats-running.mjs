#!/usr/bin/env node
// whats-running.mjs — what Catalyst is executing right now (fleet activity, the agent roster, lease
// attributions), optionally the dispatch queue and the coding-account line.
import { exitOnFailure, parseFlags, parseJson, relayStderr, runCli, wantsHelp } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/whats-running.mjs [--queue] [--accounts] [--team <key>] [--json]

Prints what is executing on your tenant. Wraps: catalyst-skills running, queue, accounts.

  --queue        also print the dispatch queue (what runs next, in order)
  --team <key>   with --queue: one team's queue
  --accounts     also print the coding-account line (provider, state, windows — never a credential)
  --json         one JSON document: { running, queue?, accounts? }
  --help         this text

Exit 0, 1 on a usage error, 2 when this machine is not connected to a tenant or the cloud refused
a read (the line says which).`;

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
  console.log(HELP);
  process.exit(0);
}
const { flags } = parseFlags(argv, { bool: ["queue", "accounts", "json"], value: ["team"] });

const out = {};
const running = runCli(["running", "--json"]);
exitOnFailure(running);
relayStderr(running);
out.running = parseJson(running.stdout) ?? running.stdout.trimEnd();

if (flags.queue) {
  const args = ["queue", "--json"];
  if (flags.team) args.push("--team", flags.team);
  const queue = runCli(args);
  exitOnFailure(queue);
  relayStderr(queue);
  out.queue = parseJson(queue.stdout) ?? queue.stdout.trimEnd();
}

if (flags.accounts) {
  const accounts = runCli(["accounts"]);
  exitOnFailure(accounts);
  relayStderr(accounts);
  out.accounts = accounts.stdout.trimEnd();
}

if (flags.json) {
  console.log(JSON.stringify(out));
  process.exit(0);
}

const section = (title, value) => {
  console.log(`== ${title}`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
};
if (out.running && typeof out.running === "object") {
  section("fleet activity", out.running.fleetActivity ?? out.running);
  if (out.running.agentRoster !== undefined) section("agent roster", out.running.agentRoster);
  if (out.running.leaseAttributions !== undefined) section("lease attributions", out.running.leaseAttributions);
} else {
  section("running", out.running);
}
if (out.queue !== undefined) section("dispatch queue", out.queue);
if (out.accounts !== undefined) section("coding accounts", out.accounts);
