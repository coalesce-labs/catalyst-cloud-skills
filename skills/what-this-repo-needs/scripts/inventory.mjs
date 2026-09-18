#!/usr/bin/env node
// inventory.mjs — lists the environment variable NAMES this repository needs, grouped build/test,
// deploy-only and bindings, each with where it was found, what uses it, and where a local value
// would come from. Never reads or prints a value. Offline: no login, no network — wraps
// `catalyst-skills env inventory`.
import { runCliOffline } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/inventory.mjs [path] [--json]

Scans a repository (default: the current directory) for the environment variable names it needs and
prints them in three groups: build/test, deploy-only, bindings. For each name: where it was found
(file:line), what uses it, and where a local value would come from. Never reads or prints a value.

--json prints the same data as JSON. This is a local, offline scan: no login, no network required.`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const json = args.includes("--json");
const path = args.find((a) => a !== "--json") ?? ".";

const res = runCliOffline(["env", "inventory", path, ...(json ? ["--json"] : [])]);
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
process.exit(res.code);
