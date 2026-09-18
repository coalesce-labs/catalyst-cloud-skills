#!/usr/bin/env node
// check.mjs — validates a catalyst.env.json file offline, with the same rules this bundle vendors
// from the cloud's own validator. Never reads or prints a value. Offline: no login, no network —
// wraps `catalyst-skills env check`.
import { runCliOffline } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/check.mjs <file> [--json]

Validates a catalyst.env.json file against this bundle's offline copy of the cloud's rules. Prints
"valid" or the refusal reasons — never a value. Exit 0 valid, 1 invalid or unreadable.

--json prints {state, errors}. This is a local, offline check: no login, no network required.`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const json = args.includes("--json");
const file = args.find((a) => a !== "--json");
if (!file) {
  console.error("env check needs a file: node scripts/check.mjs <path to catalyst.env.json>");
  console.log(HELP);
  process.exit(1);
}

const res = runCliOffline(["env", "check", file, ...(json ? ["--json"] : [])]);
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
process.exit(res.code);
