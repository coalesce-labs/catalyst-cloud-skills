// skill-shape.ts — `validateSkillDir(dir)`: every problem with one skill directory, one string each.
// The rules are the packaging pipeline's, the plugin shape gate's, the cloud validator's, and this
// bundle's own content prohibitions, so a skill that passes here installs and publishes everywhere.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const PROVENANCE_MARKER = "vendored-from: @catalyst-cloud/catalyst-skills";
export const MAX_SKILL_LINES = 80;
export const MAX_REFERENCE_LINES = 150;
export const MAX_DESCRIPTION_CHARS = 1024;

/** The first release whose SKILL.md files carry a version on the provenance line. An installed
 *  skill with the marker and no version predates this release — but that only PROVES staleness
 *  once a release at or above it has actually been published (CTC-2160 D4). */
export const FIRST_STAMPED_VERSION = "0.7.0";

const PROVENANCE_VERSION_RE = new RegExp(`${PROVENANCE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@(\\S+)`);

/** The version stamped on a provenance comment line, or null when the line carries none. */
export function parseProvenanceVersion(line: string): string | null {
  const m = PROVENANCE_VERSION_RE.exec(line);
  return m ? m[1]! : null;
}

/** Strings no customer-facing skill file may contain. */
export const FORBIDDEN_CONTENT: { name: string; re: RegExp }[] = [
  { name: "the maintainer tenant (tenant-0)", re: /tenant-0/ },
  // The public bundle repository is `coalesce-labs/catalyst-cloud-skills`, whose name CONTAINS the
  // private repository's, so this one has to end at a word boundary or it bans its own README.
  { name: "the private catalyst repository (coalesce-labs/catalyst)", re: /coalesce-labs\/catalyst(?![-\w])/ },
  { name: "the fleet thoughts repository (thoughts/)", re: /thoughts\// },
  { name: "an internal ticket id", re: /\bC[TL]C-\d+\b/ },
  { name: "a Linear CLI name (linearis)", re: /linearis/i },
  { name: "the internal replica tool name (catalyst-replica)", re: /catalyst-replica/ },
  // A tenant workflow writes through the tenant's agent proxy as the app actor. A personal Linear
  // token, or a call straight to Linear's API, is the path these skills exist to replace.
  { name: "a personal Linear API token (LINEAR_API_TOKEN / LINEAR_API_KEY)", re: /LINEAR_API_(?:TOKEN|KEY)/ },
  { name: "Linear's API host (api.linear.app)", re: /api\.linear\.app/ },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export interface Frontmatter {
  fields: Record<string, string>;
  /** The line index of the closing fence, or -1. */
  closeIndex: number;
}

/** A flat `key: value` parser with block-scalar support for one key spanning indented lines. */
export function parseFrontmatter(lines: string[]): Frontmatter | null {
  if (lines[0] !== "---") return null;
  const fields: Record<string, string> = {};
  let closeIndex = -1;
  let current: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "---") {
      closeIndex = i;
      break;
    }
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/.exec(line);
    if (m && !/^\s/.test(line)) {
      current = m[1]!;
      const v = m[2]!.trim();
      fields[current] = v === "|" || v === ">" || v === "|-" || v === ">-" ? "" : v.replace(/^"(.*)"$/, "$1");
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      fields[current] = `${fields[current]}${fields[current] ? " " : ""}${line.trim()}`;
    }
  }
  return closeIndex === -1 ? { fields, closeIndex } : { fields, closeIndex };
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

export function validateSkillDir(dir: string): string[] {
  const problems: string[] = [];
  const name = basename(dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [`${dir} is not a directory`];
  const skillMd = join(dir, "SKILL.md");
  if (!existsSync(skillMd)) return [`${name}: SKILL.md is missing`];
  const md = readFileSync(skillMd, "utf8");
  const lines = md.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > MAX_SKILL_LINES) problems.push(`${name}: SKILL.md is ${lines.length} lines (max ${MAX_SKILL_LINES})`);

  const fm = parseFrontmatter(lines);
  let manualOnlyFrontmatter = false;
  if (!fm) problems.push(`${name}: SKILL.md must start with YAML frontmatter (---)`);
  else {
    if (fm.closeIndex === -1) problems.push(`${name}: SKILL.md is missing a closing frontmatter fence`);
    if (!fm.fields.name) problems.push(`${name}: frontmatter is missing "name"`);
    else if (fm.fields.name !== name) problems.push(`${name}: frontmatter name "${fm.fields.name}" must match the directory`);
    if (fm.fields.description === undefined || fm.fields.description.trim() === "") problems.push(`${name}: frontmatter is missing "description"`);
    else if (fm.fields.description.length > MAX_DESCRIPTION_CHARS) problems.push(`${name}: description is ${fm.fields.description.length} characters (max ${MAX_DESCRIPTION_CHARS})`);
    manualOnlyFrontmatter = fm.fields["disable-model-invocation"] === "true";
    if (fm.closeIndex !== -1) {
      const after = lines[fm.closeIndex + 1] ?? "";
      if (!(after.startsWith("<!--") && after.includes(PROVENANCE_MARKER))) {
        problems.push(`${name}: the line after the frontmatter must be the HTML provenance comment containing "${PROVENANCE_MARKER}"`);
      }
    }
  }

  const refsDir = join(dir, "references");
  if (existsSync(refsDir)) {
    const refs = readdirSync(refsDir).filter((f) => f.endsWith(".md")).sort();
    if (refs.length === 0) problems.push(`${name}: references/ is empty`);
    const table = /^## Load on demand\s*$/m.test(md);
    if (refs.length > 0 && !table) problems.push(`${name}: SKILL.md has no "## Load on demand" table`);
    for (const f of refs) {
      const body = readFileSync(join(refsDir, f), "utf8").split("\n");
      if (body.at(-1) === "") body.pop();
      if (body.length > MAX_REFERENCE_LINES) problems.push(`${name}: references/${f} is ${body.length} lines (max ${MAX_REFERENCE_LINES})`);
      if (!md.includes(`references/${f}`)) problems.push(`${name}: references/${f} is not linked from SKILL.md by its literal path`);
    }
  }

  const scriptsDir = join(dir, "scripts");
  if (existsSync(scriptsDir)) {
    for (const p of walk(scriptsDir).filter((f) => f.endsWith(".mjs"))) {
      const rel = relative(dir, p);
      const src = readFileSync(p, "utf8");
      if (!src.startsWith("#!/usr/bin/env node")) problems.push(`${name}: ${rel} must start with #!/usr/bin/env node`);
      if (!src.includes("--help")) problems.push(`${name}: ${rel} has no --help`);
      for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1]!;
        if (!(spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/"))) {
          problems.push(`${name}: ${rel} imports "${spec}"; scripts may import only node: modules and relative files`);
        }
      }
    }
  }

  // Invocation is one choice written in three places: SKILL.md's `disable-model-invocation`, the
  // OpenAI sidecar's `allow_implicit_invocation`, and portability's `invocation`. They must agree.
  // Whether a skill writes (`mutating`) is a separate fact: a skill that writes can still be picked
  // by the model, and its own scoped controls (a write budget, a preview) govern the write.
  const portability = join(dir, "agents", "portability.yaml");
  const openai = join(dir, "agents", "openai.yaml");
  let explicitPortability: boolean | null = null;
  let implicitFalse: boolean | null = null;
  if (!existsSync(portability)) problems.push(`${name}: agents/portability.yaml is missing`);
  else {
    const y = readFileSync(portability, "utf8");
    if (!/^effects:\s*.*$/m.test(y)) problems.push(`${name}: agents/portability.yaml does not declare "effects"`);
    if (!/^exposure:\s*\[\s*"?catalog"?\s*\]\s*$/m.test(y)) problems.push(`${name}: agents/portability.yaml must declare exposure: [catalog]`);
    const mutating = /^mutating:\s*true\s*$/m.test(y);
    const effectsEmpty = /^effects:\s*\[\s*\]\s*$/m.test(y);
    if (mutating && effectsEmpty) problems.push(`${name}: agents/portability.yaml says mutating: true but lists no effects`);
    if (!mutating && /^effects:\s*\[\s*[^\]\s]/m.test(y)) problems.push(`${name}: agents/portability.yaml lists effects but lacks mutating: true`);
    const inv = /^invocation:\s*(\w+)\s*$/m.exec(y)?.[1];
    explicitPortability = inv === undefined ? null : inv === "explicit";
  }
  if (!existsSync(openai)) problems.push(`${name}: agents/openai.yaml is missing`);
  else {
    const y = readFileSync(openai, "utf8");
    if (!/^policy:\s*$/m.test(y)) problems.push(`${name}: agents/openai.yaml has no "policy:" block`);
    if (!/allow_implicit_invocation:\s*(true|false)/.test(y)) problems.push(`${name}: agents/openai.yaml does not set policy.allow_implicit_invocation`);
    else implicitFalse = /allow_implicit_invocation:\s*false/.test(y);
  }
  const manualFlags = [manualOnlyFrontmatter, implicitFalse, explicitPortability].filter((v): v is boolean => v !== null);
  if (new Set(manualFlags).size > 1) {
    problems.push(
      `${name}: the invocation fields disagree about whether the model may pick this skill (SKILL.md disable-model-invocation: ${manualOnlyFrontmatter}, agents/openai.yaml allow_implicit_invocation: ${implicitFalse === null ? "unset" : !implicitFalse}, agents/portability.yaml invocation: ${explicitPortability === null ? "unset" : explicitPortability ? "explicit" : "implicit"})`,
    );
  }

  for (const p of walk(dir)) {
    const rel = relative(dir, p);
    if (/\.log$/i.test(rel)) problems.push(`${name}: ${rel} is a log file; no *.log may ship in a skill`);
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const f of FORBIDDEN_CONTENT) if (f.re.test(text)) problems.push(`${name}: ${rel} mentions ${f.name}`);
  }
  return problems;
}
