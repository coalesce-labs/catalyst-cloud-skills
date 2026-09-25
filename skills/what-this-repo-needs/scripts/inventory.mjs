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
await finish(res.code);

/**
 * ⛔ NEVER `process.exit(code)` STRAIGHT AFTER A WRITE — the same rule `bin/catalyst-skills.js`
 * states in full, reintroduced here at validate attempt 29 (M-3). When this script's own stdout is a
 * PIPE — which is how an agent harness runs it — writes are asynchronous, so `process.exit` severs
 * whatever is still in flight AND STILL REPORTS THE ORIGINAL EXIT CODE. Measured: a `--json` body of
 * 385,633 bytes arrived as 65,536 bytes of invalid JSON at exit 0. Writing to a FILE hides it,
 * because a file gives stdout a synchronous write path.
 *
 * So: park the code on `process.exitCode`, wait for both streams to drain, and only then exit.
 */
function drained(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.destroyed || stream.writableEnded) return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once("error", done);
    try {
      stream.write("", done);
    } catch {
      done();
    }
  });
}

async function finish(code) {
  process.exitCode = code;
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
  process.exit(code);
}
