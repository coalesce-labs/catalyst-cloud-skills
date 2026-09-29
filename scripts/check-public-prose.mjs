#!/usr/bin/env node
// check-public-prose.mjs — the skills, the README and the install block are public: anyone can
// install this pack into any harness. This check keeps them to what a stranger can act on: bare
// skill names, the `catalyst` command, the two published packs and public docs. The rule list
// matches coalesce-labs/catalyst-dev-skills' check of the same name, so both packs read alike.
//
// Usage: node scripts/check-public-prose.mjs   (exit 1 and one line per finding when any rule fires)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Each rule: an id, the pattern, and whether it reads inside fenced code (dates in examples are fine). */
export const RULES = [
  { id: "plugin-prefix", re: /\bcatalyst-(?:dev|cloud|pm):[a-z]/, inFences: true },
  { id: "named-person", re: /\b(?:Ryan|Rozich)\b/i, inFences: true },
  // Real team keys only, so a placeholder such as ENG-123 in an example passes.
  { id: "ticket-id", re: /\b(?:CTC|CTL|ADV|OTL|CRM|POS|MCP|EVR|SLI|OBS|JOB|COA)-\d+\b/, inFences: true },
  { id: "adr-id", re: /\bADR[- ]?\d|\bADR-\d{8}T/, inFences: true },
  { id: "dated-history", re: /\b20\d\d-\d\d-\d\d\b/, inFences: false },
  { id: "retired-cli", re: /(?<![\w-])catalyst-skills\b/, inFences: true },
  {
    id: "private-reference",
    re: /coalesce-labs\/(?:catalyst-cloud(?!-skills)|thoughts)\b|\bLantern\b|\bexecution-core\b/,
    inFences: true,
  },
];

/** Lines allowed to name the old command or package, each by a substring of the one line it exempts. */
export const RETIRED_CLI_ALLOWED = [
  // The machine stamp the CLI reads to recognise and version the skills it installed.
  "<!-- vendored-from: @catalyst-cloud/catalyst-skills@",
  // The README's one deprecation note.
  "`catalyst-skills` still works as a deprecated alias",
];

/** Findings for one file's text: [{ line, rule, text }]. */
export function scanText(text) {
  const findings = [];
  let fenced = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    for (const rule of RULES) {
      if (fenced && !rule.inFences) continue;
      if (!rule.re.test(line)) continue;
      if (rule.id === "retired-cli" && RETIRED_CLI_ALLOWED.some((a) => line.includes(a))) continue;
      findings.push({ line: i + 1, rule: rule.id, text: line.trim() });
    }
  });
  return findings;
}

function markdownUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...markdownUnder(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** The files this check reads: every skill's Markdown, the README and the install block. */
export function publicFiles(root) {
  return [...markdownUnder(join(root, "skills")), join(root, "README.md"), join(root, ".agents", "install-block.md")];
}

/** The frontmatter description, folded: inline, or a `>`/`|` block running to the next key. */
function descriptionOf(front) {
  const lines = front.split("\n");
  const start = lines.findIndex((l) => l.startsWith("description:"));
  if (start === -1) return "";
  const parts = [lines[start].slice("description:".length).replace(/^\s*[>|]-?\s*$/, "")];
  for (const l of lines.slice(start + 1)) {
    if (/^[a-z-]+:/.test(l)) break;
    parts.push(l);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Agent Skills spec: name matches its folder and is 1-64 lowercase-hyphen characters; description ≤ 1024. */
export function specProblems(root) {
  const problems = [];
  for (const dir of readdirSync(join(root, "skills"))) {
    const md = readFileSync(join(root, "skills", dir, "SKILL.md"), "utf8");
    const front = md.split(/^---$/m)[1] ?? "";
    const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const desc = descriptionOf(front);
    if (name !== dir) problems.push(`skills/${dir}: name "${name}" does not match its folder`);
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) problems.push(`skills/${dir}: name must be 1-64 lowercase letters, digits and hyphens`);
    if (desc.length === 0 || desc.length > 1024) problems.push(`skills/${dir}: description is ${desc.length} characters (1-1024)`);
  }
  return problems;
}

export function checkTree(root) {
  const lines = [];
  for (const file of publicFiles(root)) {
    for (const f of scanText(readFileSync(file, "utf8"))) lines.push(`${relative(root, file)}:${f.line} [${f.rule}] ${f.text}`);
  }
  lines.push(...specProblems(root));
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(import.meta.dirname, "..");
  const lines = checkTree(root);
  for (const l of lines) console.error(l);
  if (lines.length > 0) {
    console.error(`${lines.length} finding(s): the public skills text names something a reader outside this project cannot use`);
    process.exit(1);
  }
  console.log(`public prose clean: ${publicFiles(root).length} files, ${RULES.length} rules, skill spec checked`);
}
