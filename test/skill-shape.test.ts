// skill-shape.test.ts — synthetic skill trees: one passing tree returns [], and one tree per rule
// returns exactly that rule's line (a positive control for every rule).
import { describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVENANCE_MARKER, parseFrontmatter, validateSkillDir } from "../src/skill-shape";
import { tempHome } from "./helpers";

interface Tree {
  [path: string]: string;
}

function goodSkill(name = "good-skill", over: Tree = {}): Tree {
  const base: Tree = {
    "SKILL.md": [
      "---",
      `name: ${name}`,
      "description:",
      "  A skill that answers a question.",
      "---",
      `<!-- ${PROVENANCE_MARKER} — written here -->`,
      "# Good",
      "",
      "## Run first",
      "- `node scripts/check.mjs --help`",
      "",
      "## Load on demand",
      "",
      "| when | read |",
      "| -- | -- |",
      "| always | `references/one.md` |",
      "",
    ].join("\n"),
    "references/one.md": "# One\n\nRestates an invariant.\n",
    "scripts/check.mjs": '#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nimport { runCli } from "./lib/cli.mjs";\nif (process.argv.includes("--help")) { console.log("usage"); process.exit(0); }\n',
    "scripts/lib/cli.mjs": '#!/usr/bin/env node\n// --help\nexport function runCli() {}\n',
    "agents/portability.yaml": "identity: { pack: catalyst-cloud-skills, skill: good-skill }\neffects: []\ninvocation: implicit\nexposure: [catalog]\n",
    "agents/openai.yaml": 'interface:\n  display_name: "Good"\n  short_description: "good"\n  default_prompt: "Use $good-skill"\npolicy:\n  allow_implicit_invocation: true\n',
  };
  return { ...base, ...over };
}

function write(root: string, name: string, tree: Tree): string {
  const dir = join(root, name);
  for (const [rel, content] of Object.entries(tree)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function mutatingSkill(name: string, drop: "portability" | "frontmatter" | "openai" | null): Tree {
  const t = goodSkill(name, {
    "agents/portability.yaml": `identity: { pack: catalyst-cloud-skills, skill: ${name} }\neffects: [external-write]\ninvocation: explicit\nexposure: [catalog]\n${drop === "portability" ? "" : "mutating: true\n"}`,
    "agents/openai.yaml": `interface:\n  display_name: "M"\n  short_description: "m"\n  default_prompt: "Use $${name}"\npolicy:\n  allow_implicit_invocation: ${drop === "openai" ? "true" : "false"}\n`,
  });
  if (drop !== "frontmatter") t["SKILL.md"] = t["SKILL.md"]!.replace("description:", "disable-model-invocation: true\ndescription:");
  return t;
}

describe("validateSkillDir", () => {
  test("a passing tree returns []", () => {
    expect(validateSkillDir(write(tempHome(), "good-skill", goodSkill()))).toEqual([]);
  });
  test("a passing mutating trio returns []", () => {
    expect(validateSkillDir(write(tempHome(), "mut", mutatingSkill("mut", null)))).toEqual([]);
  });

  const cases: [string, Tree | ((root: string) => string), RegExp][] = [
    ["a missing directory", (root) => join(root, "nope"), /is not a directory/],
    ["no SKILL.md", { "agents/portability.yaml": "effects: []\nexposure: [catalog]\n" }, /SKILL.md is missing/],
    ["no frontmatter", goodSkill("x", { "SKILL.md": "# no fence\n", "references/one.md": undefined as unknown as string }), /must start with YAML frontmatter/],
    ["an unclosed fence", goodSkill("x", { "SKILL.md": "---\nname: x\ndescription: d\n# body\n", "references/one.md": undefined as unknown as string }), /missing a closing frontmatter fence/],
    ["a name that differs from the directory", goodSkill("x", { "SKILL.md": goodSkill("other")["SKILL.md"]! }), /name "other" must match the directory/],
    ["no name", goodSkill("x", { "SKILL.md": goodSkill("x")["SKILL.md"]!.replace("name: x\n", "") }), /missing "name"/],
    ["no description", goodSkill("x", { "SKILL.md": goodSkill("x")["SKILL.md"]!.replace("description:\n  A skill that answers a question.\n", "") }), /missing "description"/],
    ["a description over 1024 characters", goodSkill("x", { "SKILL.md": goodSkill("x")["SKILL.md"]!.replace("A skill that answers a question.", "x".repeat(1025)) }), /description is 1025 characters/],
    ["no provenance comment after the fence", goodSkill("x", { "SKILL.md": goodSkill("x")["SKILL.md"]!.replace(`<!-- ${PROVENANCE_MARKER} — written here -->`, "# Good") }), /provenance comment/],
    ["an 81-line SKILL.md", goodSkill("x", { "SKILL.md": `${goodSkill("x")["SKILL.md"]}${"filler\n".repeat(81 - goodSkill("x")["SKILL.md"]!.split("\n").length + 1)}` }), /SKILL.md is 81 lines/],
    ["an empty references dir", goodSkill("x", { "references/.keep": "", "references/one.md": undefined as unknown as string }), /references\/ is empty/],
    ["an unlinked reference", goodSkill("x", { "references/two.md": "# Two\n" }), /references\/two.md is not linked/],
    ["a reference over 150 lines", goodSkill("x", { "references/one.md": "line\n".repeat(151) }), /references\/one.md is 151 lines/],
    ["no Load on demand table", goodSkill("x", { "SKILL.md": goodSkill("x")["SKILL.md"]!.replace("## Load on demand", "## Read later") }), /no "## Load on demand" table/],
    ["a script without the node shebang", goodSkill("x", { "scripts/check.mjs": 'console.log("--help");\n' }), /must start with #!\/usr\/bin\/env node/],
    ["a script without --help", goodSkill("x", { "scripts/check.mjs": "#!/usr/bin/env node\nconsole.log(1);\n" }), /has no --help/],
    ["a script importing a package", goodSkill("x", { "scripts/check.mjs": '#!/usr/bin/env node\n// --help\nimport pkg from "@catalyst-cloud/sdk/node";\n' }), /imports "@catalyst-cloud\/sdk\/node"/],
    ["no portability.yaml", goodSkill("x", { "agents/portability.yaml": undefined as unknown as string }), /agents\/portability.yaml is missing/],
    ["portability without effects", goodSkill("x", { "agents/portability.yaml": "invocation: implicit\nexposure: [catalog]\n" }), /does not declare "effects"/],
    ["portability without catalog exposure", goodSkill("x", { "agents/portability.yaml": "effects: []\nexposure: [internal]\n" }), /must declare exposure: \[catalog\]/],
    ["no openai.yaml", goodSkill("x", { "agents/openai.yaml": undefined as unknown as string }), /agents\/openai.yaml is missing/],
    ["openai without a policy block", goodSkill("x", { "agents/openai.yaml": "interface:\n  display_name: x\n  allow_implicit_invocation: true\n" }), /no "policy:" block/],
    ["openai without allow_implicit_invocation", goodSkill("x", { "agents/openai.yaml": "policy:\n  other: 1\n" }), /does not set policy.allow_implicit_invocation/],
    ["a mutating skill missing mutating: true", mutatingSkill("x", "portability"), /lacks mutating: true/],
    ["a mutating skill missing disable-model-invocation", mutatingSkill("x", "frontmatter"), /does not set disable-model-invocation: true/],
    ["a mutating skill missing allow_implicit_invocation: false", mutatingSkill("x", "openai"), /does not set policy.allow_implicit_invocation: false/],
    ["a .log file", goodSkill("x", { "scripts/run.log": "oops\n" }), /run.log is a log file/],
    ["the word linearis in a reference", goodSkill("x", { "references/one.md": "# One\n\nRun Linearis to read it.\n" }), /references\/one.md mentions a Linear CLI name/],
    ["catalyst-replica in a script", goodSkill("x", { "scripts/check.mjs": '#!/usr/bin/env node\n// --help: wraps catalyst-replica\n' }), /mentions the internal replica tool name/],
    ["tenant-0 in SKILL.md", goodSkill("x", { "references/one.md": "# One\n\nDefaults to tenant-0.\n" }), /mentions the maintainer tenant/],
    ["the private repository", goodSkill("x", { "references/one.md": "# One\n\nSee coalesce-labs/catalyst for detail.\n" }), /mentions the private catalyst repository/],
    ["the thoughts repo", goodSkill("x", { "references/one.md": "# One\n\nWrite to thoughts/shared.\n" }), /mentions the fleet thoughts repository/],
    ["an internal ticket id", goodSkill("x", { "references/one.md": "# One\n\nFixed in CTC-1234.\n" }), /mentions an internal ticket id/],
  ];

  for (const [label, tree, expected] of cases) {
    test(`${label} returns exactly that rule's line`, () => {
      const root = tempHome();
      let dir: string;
      if (typeof tree === "function") dir = tree(root);
      else {
        const filtered: Tree = {};
        for (const [k, v] of Object.entries(tree)) if (v !== undefined) filtered[k] = v;
        dir = write(root, "x", filtered);
      }
      const problems = validateSkillDir(dir);
      expect(problems, problems.join("\n")).toHaveLength(1);
      expect(problems[0]).toMatch(expected);
    });
  }
});

describe("parseFrontmatter", () => {
  test("inline and block descriptions, quoted values, booleans as strings", () => {
    expect(parseFrontmatter(["---", "name: a", 'description: "quoted"', "flag: true", "---"])?.fields).toEqual({ name: "a", description: "quoted", flag: "true" });
    expect(parseFrontmatter(["---", "description: >", "  first", "  second", "---"])?.fields.description).toBe("first second");
    expect(parseFrontmatter(["nope"])).toBeNull();
  });
});
