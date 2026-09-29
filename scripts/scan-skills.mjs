#!/usr/bin/env node
// scan-skills.mjs — CTC-2012 Tier 1b: run getsentry/skills' `skill-scanner` (scan_skill.py) over
// every skill in `skills/`, in a form where it actually reads the scripts, and fail the build on
// any finding that is not written down in `scripts/skill-scanner-accepted.json`.
//
// scan_skill.py filters script files to `.py/.sh/.js/.ts` — this bundle's scripts are `.mjs`, so
// pointing the scanner straight at `skills/` reads 0 of the 24 scripts and passes vacuously. This
// script mirrors each skill to a temp directory with `.mjs` renamed to `.js` (keeping the skill's
// own directory name — scan_skill.py compares frontmatter `name` against the directory it is
// handed, and a mismatched mirror name invents a "Frontmatter name does not match directory name"
// finding on every skill) so the scanner reads real content instead of scanning nothing.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const skillsRoot = join(repoRoot, "skills");

// Pinned per the ticket's research: getsentry/skills @ this commit, scan_skill.py at this sha256.
// A pinned fetch (not a vendored copy) keeps an upstream bump a one-line reviewable diff and fails
// closed on any drift, without redistributing and re-licensing third-party code in this repo.
const PINNED_COMMIT = "c2f99a5b04b4cd992ec3022d7c2c3e23e938d241";
const PINNED_SCRIPT_PATH = "skills/skill-scanner/scripts/scan_skill.py";
const PINNED_SHA256 = "58f6f3f0164b5d1b96378207f9c717dd26554175df30d1ebbc7128fbf5d593ac";
const PINNED_URL = `https://raw.githubusercontent.com/getsentry/skills/${PINNED_COMMIT}/${PINNED_SCRIPT_PATH}`;

function usage() {
  console.log(`Usage: node scripts/scan-skills.mjs [options]

Run skill-scanner's scan_skill.py over every skill in skills/, mirrored so the scanner reads
scripts written as .mjs, and fail on any finding not written down in the accepted-findings file.

Options:
  --scanner <path>    Use a local copy of scan_skill.py instead of the pinned fetch (skips the
                       digest check; for offline work and for this script's own tests). Also
                       settable via the SKILL_SCANNER_SCRIPT environment variable.
  --accepted <path>   Accepted-findings JSON file (default: scripts/skill-scanner-accepted.json).
  --json              Print a machine-readable JSON summary instead of the table.
  --help              Show this message and exit 0.

Environment:
  SKILL_SCANNER_SCRIPT   Same as --scanner.
  SKILL_SCANNER_RUNNER   How to invoke the scanner script (default: "uv", run as
                          "uv run --quiet <scanner> <dir>"). Any other value is run directly as
                          "<runner> <scanner> <dir>" — used by this script's tests to substitute a
                          Node fixture with no uv, no network and no Python.
`);
}

function parseArgs(argv) {
  const opts = { scanner: null, accepted: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--scanner") opts.scanner = argv[++i];
    else if (arg === "--accepted") opts.accepted = argv[++i];
    else {
      console.error(`scan-skills: unknown argument "${arg}"`);
      process.exit(1);
    }
  }
  return opts;
}

function sha256Of(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Resolve the scanner script path, verifying its digest unless a local copy was named. */
function resolveScanner(opts, tmpRoot) {
  const local = opts.scanner ?? process.env.SKILL_SCANNER_SCRIPT ?? null;
  if (local) return local;

  const res = spawnSync("curl", ["-sS", "-f", PINNED_URL], { encoding: "utf8", maxBuffer: 1024 * 1024 * 10 });
  if (res.status !== 0) {
    console.error(`scan-skills: could not fetch the pinned scanner from ${PINNED_URL}: ${res.stderr || res.error}`);
    process.exit(1);
  }
  const body = res.stdout;
  const digest = sha256Of(Buffer.from(body, "utf8"));
  if (digest !== PINNED_SHA256) {
    console.error(`scan-skills: pinned scanner digest changed: expected ${PINNED_SHA256}, got ${digest}`);
    process.exit(1);
  }
  const dest = join(tmpRoot, "scan_skill.py");
  writeFileSync(dest, body);
  return dest;
}

function copyMirrored(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    if (entry.isDirectory()) {
      copyMirrored(srcPath, join(destDir, entry.name));
    } else {
      const destName = entry.name.endsWith(".mjs") ? entry.name.slice(0, -".mjs".length) + ".js" : entry.name;
      copyFileSync(srcPath, join(destDir, destName));
    }
  }
}

function runScanner(scannerPath, mirrorDir) {
  const runner = process.env.SKILL_SCANNER_RUNNER || "uv";
  const args = runner === "uv" ? ["run", "--quiet", scannerPath, mirrorDir] : [scannerPath, mirrorDir];
  const bin = runner === "uv" ? "uv" : runner;
  const res = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 10 });
  if (res.status !== 0 && !res.stdout) {
    throw new Error(`scanner failed for ${mirrorDir}: ${res.stderr || res.error}`);
  }
  return JSON.parse(res.stdout);
}

/** Strip a trailing ":<line>" so a line drifting does not silently un-accept a finding. */
function fileOf(location) {
  return location.replace(/:\d+$/, "");
}

function acceptanceKey(entry) {
  return `${entry.skill}|${entry.file}|${entry.description}`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return 0;
  }

  const acceptedPath = opts.accepted ?? join(repoRoot, "scripts", "skill-scanner-accepted.json");
  const accepted = existsSync(acceptedPath) ? JSON.parse(readFileSync(acceptedPath, "utf8")) : [];
  const acceptedUsed = new Set();

  const tmpRoot = mkdtempSync(join(tmpdir(), "skill-scanner-"));
  try {
    const scannerPath = resolveScanner(opts, tmpRoot);

    const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    const rows = [];
    const blocking = [];
    let totalScripts = 0;

    for (const skill of skillNames) {
      const srcDir = join(skillsRoot, skill);
      const mirrorDir = join(tmpRoot, "mirrors", skill);
      copyMirrored(srcDir, mirrorDir);

      const result = runScanner(scannerPath, mirrorDir);
      if (result.error) {
        console.error(`scan-skills: scanner error for ${skill}: ${result.error}`);
        process.exitCode = 1;
        continue;
      }

      const scriptCount = (result.structure?.script_files ?? []).length;
      totalScripts += scriptCount;

      let skillBlocking = 0;
      for (const finding of result.findings) {
        const key = acceptanceKey({ skill, file: fileOf(finding.location), description: finding.description });
        const match = accepted.find((a) => acceptanceKey(a) === key);
        if (match) {
          acceptedUsed.add(acceptanceKey(match));
        } else {
          skillBlocking++;
          blocking.push({ skill, ...finding });
          console.error(`BLOCKING ${skill} ${finding.location} [${finding.severity}] ${finding.description}: ${finding.evidence ?? ""}`);
        }
      }

      rows.push({ skill, scripts: scriptCount, findings: result.findings.length, blocking: skillBlocking });
    }

    const stale = accepted.filter((a) => !acceptedUsed.has(acceptanceKey(a)));
    for (const s of stale) {
      console.error(`STALE ACCEPTANCE (matched nothing): ${s.skill}|${s.file}|${s.description}`);
    }

    if (opts.json) {
      console.log(JSON.stringify({ rows, blocking, stale, totalScripts, totalSkills: skillNames.length, acceptedCount: accepted.length }, null, 2));
    } else {
      console.log(["skill", "scripts", "findings", "blocking"].map((h) => h.padEnd(20)).join(""));
      for (const r of rows) {
        console.log([r.skill, r.scripts, r.findings, r.blocking].map((v) => String(v).padEnd(20)).join(""));
      }
    }

    // scan_skill.py filters script files by extension, so a mirroring regression (or a skills/ tree
    // that lost its scripts) leaves it reading nothing and reporting a clean scan — the same hollow
    // pass the mirroring at the top of this file exists to prevent. A publish gate that scanned no
    // skill script proves nothing, so it fails loudly instead of passing vacuously.
    const scannedNothing = skillNames.length === 0 || totalScripts === 0;
    if (scannedNothing) {
      console.error(
        `scan-skills: scanned ${totalScripts} script(s) across ${skillNames.length} skill(s) — a scan that read no skill script proves nothing and is never a pass`,
      );
    }

    const failed = blocking.length > 0 || stale.length > 0 || scannedNothing;
    if (!failed && !opts.json) {
      console.log(`\nno finding blocks the publish — ${totalScripts} scripts and ${skillNames.length} skills scanned, ${accepted.length} accepted finding(s)`);
    }
    return failed || process.exitCode === 1 ? 1 : 0;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

process.exit(main());
