// skills.test.ts — installedBundleVersion (CTC-2160): what skill-bundle version is actually sitting
// on disk, read only from the provenance comment; a directory this package did not write is ignored.
import { describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVENANCE_MARKER } from "../src/skill-shape";
import { installedBundleVersion } from "../src/skills";
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
