// skills.ts — copying the bundled skills into the user's skills directory, and the one-line update
// notice a new version prints on its next session.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, defaultSkillsDirFor, type Ctx, type CustomerConfig } from "./config.js";
import { PROVENANCE_MARKER } from "./skill-shape.js";

export interface SkillsInstallResult {
  installed: string[];
  skipped: { name: string; reason: "foreign-skill-dir" }[];
}

export function skillsSourceDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

/** Copy every `skills/<name>/` that has a SKILL.md. A target directory whose SKILL.md lacks the
 *  provenance marker was not installed by this package and is skipped unless `force`. */
export function installSkills(
  targetDir: string,
  opts: { force?: boolean },
  sourceDir: string = skillsSourceDir(),
): SkillsInstallResult {
  const result: SkillsInstallResult = { installed: [], skipped: [] };
  const names = readdirSync(sourceDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    const src = join(sourceDir, name);
    if (!existsSync(join(src, "SKILL.md"))) continue;
    const dst = join(targetDir, name);
    const existingMd = join(dst, "SKILL.md");
    if (existsSync(existingMd) && !opts.force) {
      const existing = readFileSync(existingMd, "utf8");
      if (!existing.includes(PROVENANCE_MARKER)) {
        result.skipped.push({ name, reason: "foreign-skill-dir" });
        continue;
      }
    }
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
    result.installed.push(name);
  }
  return result;
}

export function resolveSkillsDir(args: { skillsDir?: string }, ctx: Ctx, cfg: CustomerConfig | null): string {
  return args.skillsDir ?? ctx.env.CATALYST_SKILLS_CLAUDE_DIR ?? cfg?.skillsDir ?? defaultSkillsDirFor(ctx.home);
}

export function parseChangelogEntry(changelog: string, version: string): string | null {
  const lines = changelog.split("\n");
  const heading = `## ${version}`;
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (t === "") continue;
    if (t.startsWith("#")) break;
    return t;
  }
  return null;
}

export function readChangelog(): string {
  return readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
}

export function updateNoticeLine(previous: string, current: string, entry: string | null): string {
  const summary = entry ?? "see CHANGELOG.md";
  return `[catalyst-skills] updated ${previous} → ${current}: ${summary} · update with: npm update -g ${PACKAGE_NAME} (or: npx ${PACKAGE_NAME}@latest join)`;
}
