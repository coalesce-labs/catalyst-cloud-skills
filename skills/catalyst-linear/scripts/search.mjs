#!/usr/bin/env node
// search.mjs — tenant search across ticket identifiers and titles, pull-request titles, project and
// initiative names. Always the origin-fresh API (the replica holds no search view).
import { exitOnFailure, parseFlags, parseJson, relayStderr, runCli, usage, wantsHelp } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/search.mjs <terms...> [--limit <n>] [--json]

Searches your tenant for tickets, pull requests, projects and initiatives matching the terms.
Wraps: catalyst-skills query search.

  <terms>       one or more words; matched against identifiers, titles and names
  --limit <n>   max rows (default 50)
  --json        print the rows as JSON

Exit 0 (an empty result is still 0 and prints "no matches"), 1 on a usage error, 2 when this
machine is not connected to a tenant or the cloud refused the search (the line says which).`;

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
  console.log(HELP);
  process.exit(0);
}
const { flags, positionals } = parseFlags(argv, { bool: ["json"], value: ["limit"] });
if (positionals.length === 0) usage("search needs at least one term (see --help)");

const args = ["query", "search", ...positionals, "--json"];
if (flags.limit) args.push("--limit", flags.limit);
const r = runCli(args);
exitOnFailure(r);
relayStderr(r);
const rows = parseJson(r.stdout);
if (flags.json) {
  console.log(JSON.stringify(rows ?? r.stdout.trimEnd()));
  process.exit(0);
}
const list = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? Object.values(rows).flat() : [];
if (list.length === 0) {
  console.log("no matches");
  process.exit(0);
}
for (const row of list) {
  if (!row || typeof row !== "object") {
    console.log(String(row));
    continue;
  }
  const kind = row.kind ?? (row.identifier ? "issue" : row.number ? "pull" : "row");
  const id = row.identifier ?? (row.number !== undefined ? `#${row.number}` : row.id ?? "");
  console.log(`${kind}  ${id}  ${row.title ?? row.name ?? ""}${row.state ? `  (${row.state})` : ""}`);
}
