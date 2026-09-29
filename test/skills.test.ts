// skills.test.ts — installedBundleVersion (CTC-2160): what skill-bundle version is actually sitting
// on disk, read only from the provenance comment; a directory this package did not write is ignored.
import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVENANCE_MARKER } from "../src/skill-shape";
import { installSkills, installedBundleVersion } from "../src/skills";
import { tempHome } from "./helpers";

function writeSkillMd(dir: string, name: string, line: string | null): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const body = ["---", `name: ${name}`, "description: x", "---", ...(line !== null ? [line] : []), "# body"].join("\n");
  writeFileSync(join(skillDir, "SKILL.md"), body);
}

describe("installedBundleVersion", () => {
  test("returns the oldest stamp and the skill that carries it", () => {
    const dir = tempHome();
    writeSkillMd(dir, "catalyst-setup", `<!-- ${PROVENANCE_MARKER}@0.2.1 — x -->`);
    writeSkillMd(dir, "connect-me", `<!-- ${PROVENANCE_MARKER}@0.4.0 — x -->`);
    writeSkillMd(dir, "what-needs-me", `<!-- ${PROVENANCE_MARKER}@0.6.1 — x -->`);
    const found = installedBundleVersion(dir, ["catalyst-setup", "connect-me", "what-needs-me"]);
    expect(found).toEqual({ version: "0.2.1", skill: "catalyst-setup", unstamped: [] });
  });

  test("counts directories that carry the marker with no stamp", () => {
    const dir = tempHome();
    writeSkillMd(dir, "unstick", `<!-- ${PROVENANCE_MARKER} — x -->`);
    const found = installedBundleVersion(dir, ["unstick"]);
    expect(found).toEqual({ version: null, skill: null, unstamped: ["unstick"] });
  });

  test("ignores a skill name that is not installed, and a directory with no SKILL.md", () => {
    const dir = tempHome();
    mkdirSync(join(dir, "empty-dir"), { recursive: true });
    const found = installedBundleVersion(dir, ["not-installed", "empty-dir"]);
    expect(found).toEqual({ version: null, skill: null, unstamped: [] });
  });

  test("ignores a foreign skill directory whose SKILL.md lacks the marker entirely", () => {
    const dir = tempHome();
    writeSkillMd(dir, "foreign", "<!-- not ours -->");
    const found = installedBundleVersion(dir, ["foreign"]);
    expect(found).toEqual({ version: null, skill: null, unstamped: [] });
  });

  test("an empty skills directory yields no version and no unstamped names", () => {
    const dir = tempHome();
    mkdirSync(dir, { recursive: true });
    const found = installedBundleVersion(dir, ["catalyst-setup", "connect-me"]);
    expect(found).toEqual({ version: null, skill: null, unstamped: [] });
  });

  // The reader used to look at a fixed head window, so a skill whose frontmatter wrapped past it went
  // silently invisible — no version AND absent from `unstamped`, i.e. dropped out of the staleness
  // check with no signal at all. `validateSkillDir` caps the file, never the frontmatter.
  test("finds the provenance line when a wrapped frontmatter pushes it past the first dozen lines", () => {
    const dir = tempHome();
    const skillDir = join(dir, "catalyst-setup");
    mkdirSync(skillDir, { recursive: true });
    const lines = [
      "---",
      "name: catalyst-setup",
      "description: >-",
      ...Array.from({ length: 10 }, (_, i) => `  a description long enough to wrap, continued on line ${i}`),
      "---",
      `<!-- ${PROVENANCE_MARKER}@0.6.1 — x -->`,
      "# body",
    ];
    expect(lines.findIndex((l) => l.includes(PROVENANCE_MARKER))).toBeGreaterThan(11);
    writeFileSync(join(skillDir, "SKILL.md"), lines.join("\n"));
    const found = installedBundleVersion(dir, ["catalyst-setup"]);
    expect(found).toEqual({ version: "0.6.1", skill: "catalyst-setup", unstamped: [] });
  });

  test("mixes a stamp and an unstamped skill; the stamp still wins as the reported version", () => {
    const dir = tempHome();
    writeSkillMd(dir, "catalyst-setup", `<!-- ${PROVENANCE_MARKER}@0.5.0 — x -->`);
    writeSkillMd(dir, "unstick", `<!-- ${PROVENANCE_MARKER} — x -->`);
    const found = installedBundleVersion(dir, ["catalyst-setup", "unstick"]);
    expect(found).toEqual({ version: "0.5.0", skill: "catalyst-setup", unstamped: ["unstick"] });
  });
});

// A skill merged away stays on an installed machine until something removes it, and it keeps
// routing. The install and refresh paths remove a folder only when it carries this bundle's stamp.
describe("installSkills removes a retired skill it installed earlier, and nothing else", () => {
  function bundle(names: string[]): string {
    const src = tempHome();
    for (const n of names) writeSkillMd(src, n, `<!-- ${PROVENANCE_MARKER}@0.14.0 — x -->`);
    return src;
  }

  test("⭐ positive control: a stamped folder whose name left the bundle is removed on install and on refresh", () => {
    const src = bundle(["catalyst-onboard", "whats-happening"]);
    for (const onlyExisting of [false, true]) {
      const target = tempHome();
      writeSkillMd(target, "connect-me", `<!-- ${PROVENANCE_MARKER}@0.13.0 — x -->`);
      writeSkillMd(target, "how-catalyst-works", `<!-- ${PROVENANCE_MARKER} — unstamped, older -->`);
      writeSkillMd(target, "catalyst-onboard", `<!-- ${PROVENANCE_MARKER}@0.13.0 — x -->`);
      const result = installSkills(target, { onlyExisting }, src, "0.14.0");
      expect(result.removed).toEqual(["connect-me", "how-catalyst-works"]);
      expect(existsSync(join(target, "connect-me"))).toBe(false);
      expect(existsSync(join(target, "how-catalyst-works"))).toBe(false);
      expect(readFileSync(join(target, "catalyst-onboard", "SKILL.md"), "utf8")).toContain("@0.14.0");
    }
  });

  test("a folder without the stamp is a person's own skill and stays", () => {
    const target = tempHome();
    writeSkillMd(target, "my-own-skill", null);
    writeSkillMd(target, "connect-me", "<!-- written by hand -->");
    const result = installSkills(target, {}, bundle(["catalyst-onboard"]), "0.14.0");
    expect(result.removed).toEqual([]);
    expect(existsSync(join(target, "my-own-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, "connect-me", "SKILL.md"))).toBe(true);
  });

  test("a symlink is never removed, even when it points at a stamped folder", () => {
    const target = tempHome();
    const elsewhere = tempHome();
    writeSkillMd(elsewhere, "connect-me", `<!-- ${PROVENANCE_MARKER}@0.13.0 — x -->`);
    symlinkSync(join(elsewhere, "connect-me"), join(target, "connect-me"));
    const result = installSkills(target, {}, bundle(["catalyst-onboard"]), "0.14.0");
    expect(result.removed).toEqual([]);
    expect(existsSync(join(target, "connect-me", "SKILL.md"))).toBe(true);
    expect(existsSync(join(elsewhere, "connect-me", "SKILL.md"))).toBe(true);
  });

  test("a folder stamped by a newer bundle stays: an older CLI does not know that bundle's roster", () => {
    const target = tempHome();
    writeSkillMd(target, "a-future-skill", `<!-- ${PROVENANCE_MARKER}@0.15.0 — x -->`);
    const result = installSkills(target, {}, bundle(["catalyst-onboard"]), "0.14.0");
    expect(result.removed).toEqual([]);
    expect(existsSync(join(target, "a-future-skill", "SKILL.md"))).toBe(true);
  });
});
