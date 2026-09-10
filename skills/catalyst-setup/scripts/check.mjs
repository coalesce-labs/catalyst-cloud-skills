#!/usr/bin/env node
// check.mjs — "am I set up?" in one verdict: the machine checks the CLI runs (Node, the connection,
// the cached contract, the CLI path, the skills, the SDK, the optional replica) plus every team's
// readiness vector from the tenant contract, then the list of who can click what. Wraps
// `catalyst-skills ready --json`; reports, never repairs. Exit 0 READY, 1 NOT READY, 2 not connected.
import { parseJson, runCli } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/check.mjs [--json]

Prints one line per check (ok / note / FAIL), the fix and who can apply it for every failure, the
verdict, and a "who can click what" list grouped by the person or role each fix needs.
A note never flips the verdict (the replica is optional; an informational readiness check is a note).

--json prints the CLI's report document {ready, checks[]} unchanged.
Exit 0 READY, 1 NOT READY, 2 this machine is not connected to a tenant yet.`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const unknown = args.filter((a) => a !== "--json");
if (unknown.length > 0) {
  console.error(`unknown argument: ${unknown.join(" ")}`);
  console.log(HELP);
  process.exit(1);
}

const res = runCli(["ready", "--json"]);
if (res.code === 2) {
  console.error(res.stderr.trim() || "catalyst-skills ready refused");
  process.exit(2);
}
const report = parseJson(res.stdout);
if (!report || !Array.isArray(report.checks)) {
  console.error(res.stderr.trim() || res.stdout.trim() || "catalyst-skills ready printed no report");
  process.exit(res.code === 0 ? 1 : res.code);
}
if (args.includes("--json")) {
  console.log(JSON.stringify(report));
  process.exit(report.ready ? 0 : 1);
}

const failures = [];
for (const c of report.checks) {
  const tag = c.note ? "note" : c.ok ? "ok  " : "FAIL";
  console.log(`${tag}  ${c.line}`);
  if (!c.ok && !c.note) {
    if (c.fix) console.log(`      fix: ${c.fix}`);
    if (c.who) console.log(`      who: ${c.who}`);
    failures.push(c);
  }
}
console.log(report.ready ? "READY" : "NOT READY");

if (failures.length > 0) {
  console.log("");
  console.log("Who can click what:");
  const byWho = new Map();
  for (const c of failures) {
    const who = c.who ?? "unknown (the check named nobody)";
    if (!byWho.has(who)) byWho.set(who, []);
    byWho.get(who).push(c);
  }
  for (const [who, list] of byWho) {
    console.log(`  ${who}:`);
    for (const c of list) console.log(`    - ${c.id}: ${c.fix ?? c.line}`);
  }
}
const notes = report.checks.filter((c) => c.note && !c.ok);
if (notes.length > 0) {
  console.log("");
  console.log(`Notes that do not block: ${notes.map((c) => c.id).join(", ")} — see references/what-each-check-means.md`);
}
process.exit(report.ready ? 0 : 1);
