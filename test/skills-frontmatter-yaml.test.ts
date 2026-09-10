// skills-frontmatter-yaml.test.ts — every shipped skill's frontmatter must parse as YAML, and
// every field a tool reads as text must come back a STRING.
//
// ⛔ THE FAILURE THIS GUARDS IS SILENT AND PARTIAL. `npx skills add` parses each SKILL.md's
// frontmatter with a real YAML parser. A plain (unquoted) scalar containing a COLON FOLLOWED BY A
// SPACE is not a string to YAML — it is a nested mapping. The installer then finds no `description`
// string, skips the skill, prints a warning among its progress lines, and STILL EXITS 0. In 0.2.0
// that silently installed 5 of the 8 skills (catalyst-github, catalyst-setup and how-catalyst-works
// were dropped) and every customer on Codex, Cursor or OpenCode got a bundle missing its GitHub
// skill, its readiness skill and the whole how-it-works reference set. The Claude Code plugin rail
// reads the directory rather than the frontmatter, so it installs all eight and hides the bug.
//
// ⛔ THIS MUST NOT BE A LIST OF THE THREE KNOWN FILES. It sweeps every SKILL.md and every
// agents/*.yaml sidecar, because the whole cost of the defect is that ONE MORE `: ` added later
// reintroduces it with no signal. `src/skill-shape.ts`'s own `parseFrontmatter` is a hand-rolled
// line scanner that accepts the broken form happily — it is what let this ship — so this file
// deliberately uses the real `yaml` parser instead.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const skillsRoot = join(pkgRoot, "skills");

const skillDirs = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

/** The frontmatter block: everything between the opening `---` and the next `---` on its own line. */
function frontmatterOf(md: string): string {
  const lines = md.split("\n");
  expect(lines[0], "SKILL.md must open with a --- frontmatter fence").toBe("---");
  const close = lines.indexOf("---", 1);
  expect(close, "SKILL.md must close its frontmatter fence").toBeGreaterThan(0);
  return lines.slice(1, close).join("\n");
}

/**
 * Every frontmatter/sidecar field that a tool reads as prose, and what it means for it to be wrong.
 * A value that parses to an object instead of a string is the whole defect: YAML swallowed a `: `.
 */
function assertTextField(where: string, key: string, value: unknown): void {
  expect(
    typeof value,
    `${where}: "${key}" parsed as ${Array.isArray(value) ? "an array" : typeof value} — a plain YAML scalar containing ": " becomes a nested map, not text. Quote the value or drop the colon-space. Parsed: ${JSON.stringify(value)?.slice(0, 200)}`,
  ).toBe("string");
  expect((value as string).trim().length, `${where}: "${key}" is empty`).toBeGreaterThan(0);
}

describe("shipped skill frontmatter is valid YAML with string fields", () => {
  test("there are skills to check at all", () => {
    // ⛔ A sweep over an empty set passes vacuously. Assert the denominator before the verdict.
    expect(skillDirs.length).toBeGreaterThanOrEqual(8);
  });

  test.each(skillDirs)("%s/SKILL.md frontmatter", (name) => {
    const path = join(skillsRoot, name, "SKILL.md");
    const where = relative(pkgRoot, path);
    const block = frontmatterOf(readFileSync(path, "utf8"));

    let doc: unknown;
    expect(() => {
      doc = parseYaml(block);
    }, `${where}: frontmatter is not parseable YAML`).not.toThrow();

    expect(doc, `${where}: frontmatter must parse to a mapping`).toBeTypeOf("object");
    const fields = doc as Record<string, unknown>;

    assertTextField(where, "name", fields.name);
    expect(fields.name, `${where}: frontmatter name must match the directory`).toBe(name);
    assertTextField(where, "description", fields.description);

    // No frontmatter field may be a nested map. `description` is where this has bitten, but the
    // same `: ` swallows any other unquoted scalar (allowed-tools, the next field someone adds).
    for (const [key, value] of Object.entries(fields)) {
      expect(
        value === null || typeof value !== "object" || Array.isArray(value),
        `${where}: "${key}" parsed as a nested mapping — an unquoted ": " in its value. Parsed: ${JSON.stringify(value)?.slice(0, 200)}`,
      ).toBe(true);
    }
  });

  test.each(skillDirs)("%s/agents/*.yaml sidecars", (name) => {
    const agentsDir = join(skillsRoot, name, "agents");
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
    expect(files.length, `${name}: no agents/*.yaml sidecars to check`).toBeGreaterThan(0);

    for (const file of files) {
      const path = join(agentsDir, file);
      const where = relative(pkgRoot, path);
      let doc: unknown;
      expect(() => {
        doc = parseYaml(readFileSync(path, "utf8"));
      }, `${where}: not parseable YAML`).not.toThrow();

      // Any key whose name says it holds prose must hold a string, however deeply it is nested.
      const visit = (node: unknown, path: string[]): void => {
        if (node === null || typeof node !== "object") return;
        if (Array.isArray(node)) {
          node.forEach((v, i) => visit(v, [...path, String(i)]));
          return;
        }
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (/description|prompt|title|summary|name$/i.test(key)) {
            assertTextField(where, [...path, key].join("."), value);
          }
          visit(value, [...path, key]);
        }
      };
      visit(doc, []);
    }
  });
});

describe("the instrument itself", () => {
  // ⛔ A green sweep proves nothing unless the same assertion demonstrably FAILS on the broken
  // shape. This is the positive control: the exact frontmatter form that shipped in 0.2.0.
  test("an unquoted colon-space in a plain scalar is caught", () => {
    const broken = ["name: catalyst-github", "description:", "  Catalyst's GitHub: show a ticket's pull request."].join("\n");
    const parsed = parseYaml(broken) as Record<string, unknown>;
    expect(typeof parsed.description, "the YAML parser must turn this into a map, or the premise is wrong").toBe("object");
    expect(() => assertTextField("synthetic", "description", parsed.description)).toThrow(/parsed as object/);
  });

  test("the same text, quoted, is a string", () => {
    const fixed = ["name: catalyst-github", "description: >-", "  Catalyst's GitHub: show a ticket's pull request."].join("\n");
    const parsed = parseYaml(fixed) as Record<string, unknown>;
    expect(() => assertTextField("synthetic", "description", parsed.description)).not.toThrow();
  });
});
