// skills-content.test.ts — the content gate for the eight customer skills: the directory set equals
// the CLI's constant, every skill passes the shape validator (frontmatter, provenance, budgets,
// linked references, node-only scripts, the mutating triple), every file under skills/ plus the
// README and the current CHANGELOG entry are free of internal names, each skill's scripts reach the
// cloud only through the catalyst-skills verbs it promises, and the README states what a customer
// needs in the order they need it.
import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { CUSTOMER_SKILLS, PROVENANCE_MARKER } from "../src/cli";
import { FORBIDDEN_CONTENT, MAX_REFERENCE_LINES, MAX_SKILL_LINES, validateSkillDir } from "../src/skill-shape";
import { buildFixtureContract } from "./fixture-contract";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const skillsRoot = join(pkgRoot, "skills");
const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
  publishConfig: { access: string };
  catalystCloud?: { tenantContractRange?: string };
  dependencies?: Record<string, string>;
};

const EIGHT = [
  "am-i-set-up",
  "catalyst-github",
  "catalyst-linear",
  "how-catalyst-works",
  "join",
  "run-this-project",
  "what-needs-me",
  "whats-happening",
] as const;

/** The four skills whose scripts write something; they carry the mutating triple. */
const MUTATING = new Set(["catalyst-linear", "what-needs-me", "run-this-project", "join"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const skill = (name: string) => readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8");
const scriptsOf = (name: string) =>
  walk(join(skillsRoot, name, "scripts"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
const referencesOf = (name: string) => {
  const dir = join(skillsRoot, name, "references");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
};
const lineCount = (text: string) => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
};

describe("the eight customer skills ship, with provenance", () => {
  test("exactly the eight skills the design names are present, sorted, and equal the CLI's constant", () => {
    const dirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...EIGHT]);
    expect([...CUSTOMER_SKILLS]).toEqual([...EIGHT]);
  });

  for (const name of EIGHT) {
    test(`${name}: passes the shape validator with no findings`, () => {
      expect(validateSkillDir(join(skillsRoot, name))).toEqual([]);
    });

    test(`${name}: frontmatter name matches, description present, provenance comment on the line after the fence`, () => {
      const md = skill(name);
      expect(md.startsWith("---\n")).toBe(true);
      expect(md).toContain(`name: ${name}\n`);
      expect(md).toMatch(/^description:\n? +\S/m);
      expect(md).toContain(PROVENANCE_MARKER);
      const lines = md.split("\n");
      const close = lines.indexOf("---", 1);
      expect(close).toBeGreaterThan(0);
      expect(lines[close + 1]).toMatch(/^<!--.*vendored-from: @catalyst-cloud\/catalyst-skills/);
    });

    test(`${name}: SKILL.md stays inside ${MAX_SKILL_LINES} lines and every reference inside ${MAX_REFERENCE_LINES}, each linked by its literal path`, () => {
      const md = skill(name);
      expect(lineCount(md)).toBeLessThanOrEqual(MAX_SKILL_LINES);
      const refs = referencesOf(name);
      expect(refs.length, `${name} must carry at least one reference`).toBeGreaterThan(0);
      expect(md).toMatch(/^## Load on demand\s*$/m);
      for (const f of refs) {
        expect(lineCount(readFileSync(join(skillsRoot, name, "references", f), "utf8"))).toBeLessThanOrEqual(MAX_REFERENCE_LINES);
        expect(md, `${name} must link references/${f}`).toContain(`references/${f}`);
      }
    });

    test(`${name}: every script is a node script with --help that reaches the cloud only by spawning the CLI`, () => {
      const files = walk(join(skillsRoot, name, "scripts")).filter((f) => f.endsWith(".mjs"));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const src = readFileSync(f, "utf8");
        const rel = relative(skillsRoot, f);
        expect(src.startsWith("#!/usr/bin/env node"), `${rel} must start with #!/usr/bin/env node`).toBe(true);
        expect(src, `${rel} must print --help`).toContain("--help");
        expect(src, `${rel} must not call the cloud itself`).not.toMatch(/\bfetch\s*\(/);
        expect(src, `${rel} must not import an HTTP client`).not.toMatch(/["']node:https?["']/);
        expect(src, `${rel} must not import a package`).not.toMatch(/from\s+["'](?!node:|\.\.?\/)[^"']+["']/);
      }
      expect(existsSync(join(skillsRoot, name, "scripts", "lib", "cli.mjs"))).toBe(true);
      const lib = readFileSync(join(skillsRoot, name, "scripts", "lib", "cli.mjs"), "utf8");
      expect(lib).toContain("customer.json");
      expect(lib).toContain("cliPath");
      expect(lib).toContain("npx @catalyst-cloud/catalyst-skills");
    });

    test(`${name}: the mutating triple is ${MUTATING.has(name) ? "present as a set" : "absent as a set"}`, () => {
      const md = skill(name);
      const portability = readFileSync(join(skillsRoot, name, "agents", "portability.yaml"), "utf8");
      const openai = readFileSync(join(skillsRoot, name, "agents", "openai.yaml"), "utf8");
      expect(portability).toMatch(/^effects:\s*\[.*\]\s*$/m);
      expect(portability).toMatch(/^exposure:\s*\[\s*"?catalog"?\s*\]\s*$/m);
      expect(openai).toMatch(/^policy:\s*$/m);
      const triple = [
        /^mutating:\s*true\s*$/m.test(portability),
        /^disable-model-invocation:\s*true\s*$/m.test(md),
        /allow_implicit_invocation:\s*false/.test(openai),
      ];
      expect(triple).toEqual(MUTATING.has(name) ? [true, true, true] : [false, false, false]);
      if (MUTATING.has(name)) expect(portability).not.toMatch(/^effects:\s*\[\s*\]\s*$/m);
      else expect(portability).toMatch(/^effects:\s*\[\s*\]\s*$/m);
    });
  }

  test("no *.log file anywhere under skills/", () => {
    expect(walk(skillsRoot).filter((f) => /\.log$/i.test(f))).toEqual([]);
  });
});

describe("no internal name reaches a customer", () => {
  const CUSTOMER_TEXT: { label: string; text: string }[] = [
    ...walk(skillsRoot).map((f) => ({ label: relative(pkgRoot, f), text: readFileSync(f, "utf8") })),
    { label: "README.md", text: readFileSync(join(pkgRoot, "README.md"), "utf8") },
    { label: `CHANGELOG.md ## ${manifest.version}`, text: changelogEntry(manifest.version) },
  ];

  function changelogEntry(version: string): string {
    const md = readFileSync(join(pkgRoot, "CHANGELOG.md"), "utf8");
    const start = md.indexOf(`## ${version}\n`);
    expect(start, `CHANGELOG.md must carry a ## ${version} entry`).toBeGreaterThanOrEqual(0);
    const rest = md.slice(start + `## ${version}\n`.length);
    const next = rest.indexOf("\n## ");
    return next === -1 ? rest : rest.slice(0, next);
  }

  test("positive control: the same matcher finds every planted string in a temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "catalyst-skills-planted-"));
    const planted = join(dir, "planted.md");
    writeFileSync(
      planted,
      ["tenant-0", "coalesce-labs/catalyst", "thoughts/shared", "CTC-1", "CTL-22", "Linearis", "catalyst-replica"].join("\n"),
    );
    const text = readFileSync(planted, "utf8");
    const hits = FORBIDDEN_CONTENT.filter((f) => f.re.test(text)).map((f) => f.name);
    expect(hits).toHaveLength(FORBIDDEN_CONTENT.length);
  });

  for (const f of FORBIDDEN_CONTENT) {
    test(`nothing customer-facing mentions ${f.name}`, () => {
      const offenders = CUSTOMER_TEXT.filter((t) => f.re.test(t.text)).map((t) => t.label);
      expect(offenders).toEqual([]);
    });
  }

  test("no skill text composes a request itself: no curl, no fetch, no node:http anywhere under skills/", () => {
    const offenders = walk(skillsRoot)
      .filter((f) => !f.endsWith(".json"))
      .filter((f) => /\bcurl\s|\bfetch\s*\(|node:https?\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(pkgRoot, f));
    expect(offenders).toEqual([]);
  });

  test("how-catalyst-works restates no tenant value: no state id and no team key from the contract fixture", () => {
    const contract = buildFixtureContract();
    const stateIds = contract.teams.flatMap((t) => Object.values(t.stages).map((s) => s.stateId));
    const teamKeys = contract.teams.map((t) => t.key);
    expect(stateIds.length).toBeGreaterThan(0);
    expect(teamKeys.length).toBeGreaterThan(0);
    const text = referencesOf("how-catalyst-works")
      .map((f) => readFileSync(join(skillsRoot, "how-catalyst-works", "references", f), "utf8"))
      .join("\n");
    for (const id of stateIds) expect(text).not.toContain(id);
    for (const key of teamKeys) expect(text).not.toMatch(new RegExp(`\\b${key}\\b`));
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

describe("each skill's scripts spawn the catalyst-skills verbs it teaches", () => {
  const verbs: Record<(typeof EIGHT)[number], RegExp[]> = {
    "am-i-set-up": [/"ready"/, /"replica",\s*"status"/],
    "catalyst-github": [/"query",\s*"pull"/, /"contract"/, /"replica",\s*"status"/],
    "catalyst-linear": [/"query",\s*"issue"/, /"query",\s*"search"/, /"write",\s*"comment"/, /"write",\s*"state"/, /"write",\s*"label"/, /"write",\s*"create"/],
    "how-catalyst-works": [/"explain"/, /"running"/, /"queue"/, /"accounts"/, /"contract",\s*"--path"/],
    join: [/"status"/, /"contract",\s*"--path"/, /"replica",\s*"status"/],
    "run-this-project": [/"watch"/, /"write",\s*"state"/, /"write",\s*"comment"/],
    "what-needs-me": [/"ask",\s*"list"/, /"ask",\s*"raise"/, /"ask",\s*"accept"/],
    "whats-happening": [/"contract"/, /"running"/, /"queue"/, /"ask",\s*"list"/, /"replica",\s*"status"/, /"explain"/],
  };
  for (const name of EIGHT) {
    test(`${name}`, () => {
      const src = scriptsOf(name);
      for (const re of verbs[name]) expect(src, `${name} scripts must spawn ${re}`).toMatch(re);
      expect(src, "every script passes --json to the CLI for machine-read output").toContain("--json");
    });
  }

  test("skills that write move cards by slot or state type, never by a stage name literal", () => {
    for (const name of ["catalyst-linear", "run-this-project", "what-needs-me"]) {
      const src = scriptsOf(name);
      expect(src).toMatch(/--slot|--state-type/);
      expect(src).not.toMatch(/--state-id",\s*"[0-9a-f-]{20,}/);
    }
  });

  test("the four asking skills point at the fact skills instead of restating them", () => {
    expect(skill("whats-happening")).toContain("how-catalyst-works");
    expect(skill("whats-happening")).toContain("catalyst-linear");
    expect(skill("whats-happening")).toContain("catalyst-github");
    expect(skill("whats-happening")).toContain("what-needs-me");
    expect(skill("join")).toContain("am-i-set-up");
    expect(skill("run-this-project")).toContain("what-needs-me");
  });
});

describe("the install page (README) states what a customer needs, in the order they need it", () => {
  const readme = readFileSync(join(pkgRoot, "README.md"), "utf8");
  const contributing = readFileSync(join(pkgRoot, "CONTRIBUTING.md"), "utf8");

  test("one-step install: the env-var form leads, the --key form follows, then npm install -g", () => {
    const envForm = "CATALYST_CLOUD_TOKEN=<your-account-key> npx @catalyst-cloud/catalyst-skills join";
    const keyForm = "npx @catalyst-cloud/catalyst-skills join --key <your-account-key>";
    expect(readme).toContain(envForm);
    expect(readme).toContain(keyForm);
    expect(readme.indexOf(envForm), "a key on the command line lands in shell history; the env form must come first").toBeLessThan(
      readme.indexOf(keyForm),
    );
    expect(readme).toContain("npm install -g @catalyst-cloud/catalyst-skills");
    expect(readme).toContain("catalyst-skills login");
  });

  test("tenant discovery from the key alone via GET /api/v1/me; config path, mode and the contract cache stated", () => {
    expect(readme).toContain("GET /api/v1/me");
    expect(readme).toContain("~/.config/catalyst-cloud/customer.json");
    expect(readme).toContain("0600");
    expect(readme).toContain("~/.config/catalyst-cloud/contract.json");
    expect(readme).toContain("GET /api/v1/agent/contract");
  });

  test("every skill is linked, and the reader is never told to read the skills before installing", () => {
    for (const name of CUSTOMER_SKILLS) {
      expect(readme, `README must link skills/${name}/SKILL.md`).toContain(`skills/${name}/SKILL.md`);
    }
    expect(readme).not.toMatch(/read the skills first/i);
    expect(readme).not.toMatch(/marketplace add[^\n]*is how (customers|you) install/);
  });

  test("states the minimum versions: Claude Code 2.0, Node 22 with its built-in SQLite, Bun optional", () => {
    expect(readme).toMatch(/Claude Code 2\.0/);
    expect(readme).toMatch(/Node 22/);
    expect(readme).not.toMatch(/Node 18/);
    expect(readme).toMatch(/built-in SQLite/);
    expect(readme).toMatch(/better-sqlite3/);
    expect(readme).toMatch(/Bun 1\.0/);
  });

  test("states the pinned tenant contract range in present tense, with no internal ticket ids anywhere", () => {
    expect(readme).toContain("`1.x`");
    expect(readme).not.toContain("`0.x`");
    expect(readme).toContain("tenantContractRange");
    expect(readme, "a customer README names no internal ticket").not.toMatch(/\bC[TL]C-\d+\b/);
    expect(readme).toContain("vendored-from");
  });

  test("says what has to be running: nothing by default, the optional replica with its four exit codes, the watch", () => {
    expect(readme).toMatch(/^## What has to be running$/m);
    expect(readme).toContain("catalyst-skills replica start");
    expect(readme).toContain("--detach");
    expect(readme).toContain("catalyst-skills replica status");
    expect(readme).toMatch(/`0` for fresh, `1` for present but stale, `2` for not joined, `3` for absent/);
    expect(readme).toContain("catalyst-skills watch");
    expect(readme).toContain("Nothing rotates");
  });

  test("names what a key cannot see yet and where those facts live, and the one join", () => {
    expect(readme).toMatch(/^## What a key cannot see yet$/m);
    expect(readme).toContain("settings/coding-accounts");
    expect(readme).toContain("not visible to an account key yet");
    expect(readme).toContain("explain --history");
    expect(readme).toMatch(/^### One join$/m);
    expect(readme).toContain("setup skill");
    expect(readme).toContain("account key");
    expect(readme).not.toMatch(/\bAPI key\b/);
  });

  test("documents the one-line update notice and the uninstall of everything it wrote; the publish secret lives in CONTRIBUTING", () => {
    expect(readme).toContain("[catalyst-skills] updated");
    expect(readme).toContain("npm update -g @catalyst-cloud/catalyst-skills");
    for (const name of CUSTOMER_SKILLS) expect(readme).toContain(`~/.claude/skills/${name}`);
    for (const f of ["customer.json", "contract.json", "replica.db", "replica.db.pid", "replica.db.writer.lock", "watch-cursor.json"]) {
      expect(readme, `uninstall must name ${f}`).toContain(f);
    }
    expect(readme).not.toContain("NPM_PUBLISH_TOKEN");
    expect(contributing).toContain("NPM_PUBLISH_TOKEN");
    expect(contributing).toContain("skills-bundle-v<version>");
  });
});

describe("the package manifest", () => {
  test("is the documented name, public, and carries exactly the SDK as its runtime dependency", () => {
    expect(manifest.name).toBe("@catalyst-cloud/catalyst-skills");
    expect(manifest.publishConfig.access).toBe("public");
    expect(manifest.dependencies).toEqual({ "@catalyst-cloud/sdk": expect.stringMatching(/^\^0\.8\./) });
  });

  test("bin, shipped files, engines, and the pinned contract range are wired", () => {
    expect(manifest.bin["catalyst-skills"]).toBe("bin/catalyst-skills.js");
    for (const f of ["bin", "dist", "skills", "README.md", "CHANGELOG.md", "LICENSE"]) {
      expect(manifest.files).toContain(f);
    }
    expect(existsSync(join(pkgRoot, manifest.bin["catalyst-skills"]!))).toBe(true);
    expect(manifest.engines.node).toBe(">=22");
    expect(manifest.catalystCloud?.tenantContractRange).toBe("1.x");
  });

  test("the version matches the CHANGELOG's top entry, which is 0.2.0", () => {
    const changelog = readFileSync(join(pkgRoot, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`## ${manifest.version}\n`);
    expect(changelog.indexOf("## 0.2.0")).toBe(changelog.indexOf("## "));
    expect(manifest.version).toBe("0.2.0");
  });
});
