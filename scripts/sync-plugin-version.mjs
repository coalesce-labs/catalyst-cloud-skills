#!/usr/bin/env node
// sync-plugin-version.mjs — the plugin manifest carries its own version, and a plugin whose version
// never moves looks to Claude Code like a bundle that never shipped. This copies package.json's
// version into .claude-plugin/plugin.json; `--check` reports drift and exits 1 instead of writing,
// which is what CI runs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HELP = `Usage: node scripts/sync-plugin-version.mjs [--check]

Copies the version in package.json into .claude-plugin/plugin.json.

Options:
  --check  do not write; exit 1 when the two versions differ
  --help   this text`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const check = argv.includes("--check");
const unknown = argv.filter((a) => a !== "--check");
if (unknown.length > 0) {
  console.error(`unexpected argument: ${unknown[0]} (see --help)`);
  process.exit(1);
}

const pkgUrl = new URL("../package.json", import.meta.url);
const pluginUrl = new URL("../.claude-plugin/plugin.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, "utf8"));
const pluginText = readFileSync(pluginUrl, "utf8");
const plugin = JSON.parse(pluginText);

if (plugin.version === pkg.version) {
  console.log(`plugin.json is at ${plugin.version}, matching package.json`);
  process.exit(0);
}
if (check) {
  console.error(`plugin.json is at ${plugin.version} but package.json is at ${pkg.version} — run: npm run version:sync`);
  process.exit(1);
}
plugin.version = pkg.version;
writeFileSync(pluginUrl, `${JSON.stringify(plugin, null, 2)}\n`);
console.log(`plugin.json ${fileURLToPath(pluginUrl)} set to ${pkg.version}`);
