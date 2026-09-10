#!/usr/bin/env node
// replica-status.mjs — is the optional local replica alive, and how far behind is it? Wraps
// `catalyst-skills replica status`, which needs no network (a pidfile, a writer-lock heartbeat and
// the cursor row); `--probe` adds the one network call that compares the cursor with the cloud's
// head. The CLI's exit code passes straight through: 0 fresh, 1 present but stale, 2 not connected,
// 3 absent. A skill reads that code to choose its source; it never refuses to work over it.
import { runCli } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/replica-status.mjs [--probe] [--json]

  --probe   also fetch the cloud's head cursor and print how far behind the replica is
  --json    print the CLI's status document {verdict, exitCode, cursor, heartbeatAgeMs, ...}

Exit codes, passed through from catalyst-skills replica status:
  0  fresh: a live writer, a young heartbeat, a cursor — skills read the replica
  1  stale: the file exists but the writer is gone or behind — skills read the API and say so
  2  not connected to a tenant — run: CATALYST_CLOUD_TOKEN=<account key> npx @catalyst-cloud/catalyst-skills login
  3  absent: no replica file — optional; start one with: catalyst-skills replica start --detach`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const unknown = args.filter((a) => a !== "--probe" && a !== "--json");
if (unknown.length > 0) {
  console.error(`unknown argument: ${unknown.join(" ")}`);
  console.log(HELP);
  process.exit(1);
}

const cliArgs = ["replica", "status"];
if (args.includes("--probe")) cliArgs.push("--probe");
if (args.includes("--json")) cliArgs.push("--json");
const res = runCli(cliArgs);
if (res.stdout.trim()) console.log(res.stdout.trimEnd());
if (res.code !== 0 && res.stderr.trim()) console.error(res.stderr.trimEnd());

const meaning = {
  0: "fresh — skills read the replica",
  1: "stale — skills read the API and name that source",
  2: "not connected to a tenant",
  3: "absent — the replica is optional; nothing is wrong",
};
if (!args.includes("--json")) console.log(`verdict ${res.code}: ${meaning[res.code] ?? "unexpected exit code"}`);
process.exit(res.code);
