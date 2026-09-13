#!/usr/bin/env node
// sync-skill-lib.mjs — vendor skill-lib/credential.mjs into every skill's scripts/lib/ (skills install
// one directory at a time, so each needs its own copy). `--check` writes nothing and exits 1 on drift;
// test/skill-scripts-credential.test.ts runs it.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "skill-lib", "credential.mjs"), "utf8");
const check = process.argv.includes("--check");
const skills = readdirSync(join(root, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

let drift = 0;
for (const skill of skills) {
  const target = join(root, "skills", skill, "scripts", "lib", "credential.mjs");
  const same = existsSync(target) && readFileSync(target, "utf8") === source;
  if (same) continue;
  drift += 1;
  if (check) console.log(`drift: skills/${skill}/scripts/lib/credential.mjs`);
  else {
    writeFileSync(target, source);
    console.log(`wrote skills/${skill}/scripts/lib/credential.mjs`);
  }
}
if (check && drift > 0) {
  console.log("run: npm run skill-lib:sync");
  process.exit(1);
}
console.log(check ? `skill-lib: ${skills.length} copies match` : `skill-lib: ${skills.length} skills, ${drift} written`);
