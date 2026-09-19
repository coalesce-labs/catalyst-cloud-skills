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
