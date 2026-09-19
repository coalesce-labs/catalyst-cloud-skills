#!/usr/bin/env node
// fake-scanner.mjs — stands in for skill-scanner's scan_skill.py in scan-skills-script.test.ts, so
// scripts/scan-skills.mjs's classification logic (accepted vs. blocking vs. stale) is testable with
// no uv, no network and no Python. Findings are supplied per skill via FAKE_SCANNER_FINDINGS (a JSON
// object keyed by skill name); a skill with no entry reports zero findings, exactly like a clean
// scan_skill.py run. The printed shape matches scan_skill.py's real result document closely enough
// for scan-skills.mjs to consume unmodified: skill_name, structure.script_files, findings.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

function usage() {
  console.log("Usage: fake-scanner.mjs <skill-directory>");
}

const dir = process.argv[2];
if (process.argv.includes("--help") || !dir) {
  usage();
  process.exit(0);
}

const skillMd = join(dir, "SKILL.md");
const nameMatch = existsSync(skillMd) ? /^name:\s*(\S+)\s*$/m.exec(readFileSync(skillMd, "utf8")) : null;
const skillName = nameMatch ? nameMatch[1] : basename(dir);

// FAKE_SCANNER_NO_SCRIPTS stands in for a scanner that read no script at all — what the real
// scan_skill.py reports when the mirrored extensions stop matching its filter.
const scriptsDir = join(dir, "scripts");
const scriptFiles = process.env.FAKE_SCANNER_NO_SCRIPTS
  ? []
  : existsSync(scriptsDir)
  ? readdirSync(scriptsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(py|sh|js|ts)$/.test(e.name))
      .map((e) => e.name)
      .sort()
  : [];

const findingsMap = JSON.parse(process.env.FAKE_SCANNER_FINDINGS ?? "{}");
const findings = findingsMap[skillName] ?? [];

const findingCounts = {};
for (const f of findings) findingCounts[f.severity] = (findingCounts[f.severity] ?? 0) + 1;

console.log(
  JSON.stringify({
    skill_name: skillName,
    skill_dir: dir,
    structure: {
      has_skill_md: existsSync(skillMd),
      has_references: existsSync(join(dir, "references")),
      has_scripts: existsSync(scriptsDir),
      reference_files: [],
      script_files: scriptFiles,
    },
    frontmatter: null,
    tools: null,
    findings,
    finding_counts: findingCounts,
    total_findings: findings.length,
    urls: { total: 0, untrusted: [], trusted_count: 0 },
    description_body_overlap: 0,
  }),
);
