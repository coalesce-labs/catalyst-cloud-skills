#!/usr/bin/env node
// sync-plugin-version.mjs — the plugin manifest AND every skill's provenance comment carry the
// package version, and one that never moves looks to Claude Code like a bundle that never shipped
// (the plugin) or leaves a customer with no way to tell an install is stale (the skills, CTC-2160).
// This copies package.json's version into .claude-plugin/plugin.json and stamps it onto every
// `skills/*/SKILL.md` provenance line; `--check` reports drift and exits 1 instead of writing,
// which is what CI runs.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Usage: node scripts/sync-plugin-version.mjs [--check]

Copies the version in package.json into .claude-plugin/plugin.json and stamps it onto every
skills/*/SKILL.md provenance line.

Options:
  --check  do not write; exit 1 when anything is out of sync
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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgUrl = new URL("../package.json", import.meta.url);
const pluginUrl = new URL("../.claude-plugin/plugin.json", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, "utf8"));
const pluginText = readFileSync(pluginUrl, "utf8");
const plugin = JSON.parse(pluginText);

let drift = 0;

if (plugin.version === pkg.version) {
  console.log(`plugin.json is at ${plugin.version}, matching package.json`);
} else if (check) {
  console.error(`plugin.json is at ${plugin.version} but package.json is at ${pkg.version} — run: npm run version:sync`);
  drift += 1;
} else {
  plugin.version = pkg.version;
  writeFileSync(pluginUrl, `${JSON.stringify(plugin, null, 2)}\n`);
  console.log(`plugin.json ${fileURLToPath(pluginUrl)} set to ${pkg.version}`);
}

// The provenance marker every skill already carries; PROVENANCE_VERSION_RE mirrors
// src/skill-shape.ts's own pattern so the two cannot silently drift apart.
const PROVENANCE_MARKER = "vendored-from: @catalyst-cloud/catalyst-skills";
const PROVENANCE_LINE_RE = new RegExp(`${PROVENANCE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(@\\S+)?`);

const skillNames = readdirSync(join(root, "skills"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

let stampable = 0;
for (const name of skillNames) {
  const skillMdPath = join(root, "skills", name, "SKILL.md");
  // A skills/ subdirectory with no SKILL.md is not a skill — installSkills (src/skills.ts) skips this
  // exact state on purpose, and reading it unguarded here killed `npm run version:sync` (a release
  // step) with an uncaught ENOENT instead of passing over it.
  if (!existsSync(skillMdPath)) continue;
  stampable += 1;
  const text = readFileSync(skillMdPath, "utf8");
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.includes(PROVENANCE_MARKER));
  if (idx === -1) continue;
  const stamped = lines[idx].replace(PROVENANCE_LINE_RE, `${PROVENANCE_MARKER}@${pkg.version}`);
  if (stamped === lines[idx]) continue;
  drift += 1;
  if (check) {
    console.error(`skills/${name}/SKILL.md provenance line does not stamp ${pkg.version} — run: npm run version:sync`);
    continue;
  }
  lines[idx] = stamped;
  writeFileSync(skillMdPath, lines.join("\n"));
  console.log(`skills/${name}/SKILL.md stamped at ${pkg.version}`);
}

if (check && drift > 0) process.exit(1);
if (drift === 0) console.log(`all ${stampable} skills already stamp ${pkg.version}`);
