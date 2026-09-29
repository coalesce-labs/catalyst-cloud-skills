#!/usr/bin/env node
// check.mjs — checks the repository settings TOML offline. Never reads or prints a value. Offline:
// no login, no network — wraps `catalyst env check`.
import { runCliOffline } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/check.mjs [path] [--json]

Checks TOML syntax and the environment variable table in .catalyst/catalyst.toml (default), or at
the repo-relative path you name. Prints "valid" or refusal reasons — never a value. A legacy root
catalyst.env.json is not read by the cloud. Exit 0 valid or absent, 1 invalid or unreadable.

--json prints {state, errors}. This is a local, offline check: no login, no network required.`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const json = args.includes("--json");
const file = args.find((a) => a !== "--json");
const res = runCliOffline([
  "env",
  "check",
  ...(file ? [file] : []),
  ...(json ? ["--json"] : []),
]);
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
await finish(res.code);

/**
 * ⛔ NEVER `process.exit(code)` STRAIGHT AFTER A WRITE — the same rule `bin/launch.js`
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
