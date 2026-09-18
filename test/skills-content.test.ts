// skills-content.test.ts — the content gate for the customer skills: the directory set equals
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

// The roster, in one place. Named for what it is, not for how many rows it has — the count that used
// to live in this identifier's name is the same class of defect as a count written into prose.
const ROSTER = [
  "catalyst-github",
  "catalyst-linear",
  "catalyst-onboard",
  "catalyst-setup",
  "connect-me",
  "how-catalyst-works",
  "run-this-project",
  "unstick",
  "what-needs-me",
  "what-this-repo-needs",
  "whats-happening",
] as const;

/** The skills whose scripts write something, or that drive a person through writes; they carry the
 *  mutating triple. `catalyst-onboard` is here because it connects the machine and walks a person
 *  through tenant setup: the person asks for it by name, an agent never starts it on its own. */
const MUTATING = new Set(["catalyst-linear", "catalyst-onboard", "what-needs-me", "run-this-project", "connect-me", "unstick"]);

/** The per-team readiness checks the engine reports, in wire order. The bundle cannot import the
 *  engine's own READINESS_CHECK_IDS: it lives in @catalyst-cloud/types, which is not published and
 *  is not a dependency of this package (pinned by the dependency test below). This array is the one
 *  place the check vocabulary is written down here — the page's table and the test fixture are both
 *  held to it, so adding a check is one line plus one documented row. */
const TEAM_CHECK_IDS = [
  "oauth_scope", "token_live", "team_visible", "mapped_states_exist", "mapping_total",
  "types_compatible", "labels_present", "writes_land", "webhook_covers_team", "hosts_current",
  "environment_declared", "tools_resolvable", "reviewer_required", "reviewer_configured",
] as const;

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

describe("the customer skills ship, with provenance", () => {
  test("exactly the skills the design names are present, sorted, and equal the CLI's constant", () => {
    const dirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...ROSTER]);
    expect([...CUSTOMER_SKILLS]).toEqual([...ROSTER]);
  });

  for (const name of ROSTER) {
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
      // The fallback when no CLI path is recorded: npx, with this package as the target. Some libs
      // build that argv from a constant, so assert the two parts rather than one joined literal.
      expect(lib, `${name} lib must fall back to npx`).toMatch(/["']npx["']/);
      expect(lib, `${name} lib must name this package`).toContain("@catalyst-cloud/catalyst-skills");
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
  const verbs: Record<(typeof ROSTER)[number], RegExp[]> = {
    "catalyst-setup": [/"ready"/, /"replica",\s*"status"/],
    // Each grain by its own instrument: the machine by `status` and `ready`, the person by `me`, and
    // the account, the projects and the repositories by three DIFFERENT `contract --path` reads. A
    // regression that folded any of these into one call would take this assertion with it.
    "catalyst-onboard": [/"status"/, /"ready",\s*"--json"/, /"me",\s*"--json"/, /"contract",\s*"--path",\s*"account"/, /"contract",\s*"--path",\s*"teams"/, /"contract",\s*"--path",\s*"merge\.repositories"/, /"environment",\s*"read"/],
    "catalyst-github": [/"query",\s*"pull"/, /"contract"/, /"replica",\s*"status"/],
    "catalyst-linear": [/"query",\s*"issue"/, /"query",\s*"search"/, /"write",\s*"comment"/, /"write",\s*"state"/, /"write",\s*"label"/, /"write",\s*"create"/],
    "how-catalyst-works": [/"explain"/, /"running"/, /"queue"/, /"accounts"/, /"contract",\s*"--path"/],
    "connect-me": [/"status"/, /"contract",\s*"--path"/, /"replica",\s*"status"/],
    "run-this-project": [/"watch"/, /"write",\s*"state"/, /"write",\s*"comment"/],
    "what-needs-me": [/"ask",\s*"list"/, /"ask",\s*"raise"/, /"ask",\s*"accept"/],
    "what-this-repo-needs": [/"env",\s*"inventory"/, /"env",\s*"check"/],
    "whats-happening": [/"contract"/, /"running"/, /"queue"/, /"ask",\s*"list"/, /"replica",\s*"status"/, /"explain"/],
    unstick: [/"explain"/, /"--history"/, /"release"/, /"--dry-run"/],
  };
  for (const name of ROSTER) {
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
    expect(skill("connect-me")).toContain("catalyst-setup");
    expect(skill("run-this-project")).toContain("what-needs-me");
  });
});

describe("the install page (README) states what a customer needs, in the order they need it", () => {
  const readme = readFileSync(join(pkgRoot, "README.md"), "utf8");
  const contributing = readFileSync(join(pkgRoot, "CONTRIBUTING.md"), "utf8");

  const installBlock = readFileSync(join(pkgRoot, ".agents", "install-block.md"), "utf8");

  test("the install section leads, and it is the ecosystem's own command per tool, never ours", () => {
    const install = readme.indexOf("\n## Install\n");
    expect(install, "README must carry an ## Install section").toBeGreaterThan(0);
    // Nothing may sit between the title and the install block. A what-it-is preamble first is the
    // failure this asserts against: the headline IS the install command, never an explanation.
    const firstSection = readme.indexOf("\n## ");
    expect(firstSection, "## Install must be the FIRST section in the README").toBe(install);
    const beforeInstall = readme.slice(0, install);
    expect(beforeInstall.split("\n").filter((l) => l.trim().length > 0), "only the title and the badge precede ## Install").toHaveLength(2);
    for (const later of ["## What this is", "## Requirements", "## The skills"]) {
      expect(readme.indexOf(`\n${later}\n`), `${later} must come after ## Install`).toBeGreaterThan(install);
    }
    for (const cmd of [
      "/plugin marketplace add coalesce-labs/catalyst-cloud-skills",
      "/plugin install catalyst@catalyst-cloud",
      "npx skills@latest add coalesce-labs/catalyst-cloud-skills -a codex",
      "npx skills@latest add coalesce-labs/catalyst-cloud-skills -a cursor",
      "npx skills@latest add coalesce-labs/catalyst-cloud-skills",
      "npx skills update -y",
    ]) {
      expect(readme, `the install block must carry ${cmd}`).toContain(cmd);
      expect(installBlock, `.agents/install-block.md must carry ${cmd}`).toContain(cmd);
    }
    expect(readme, "two rails without an exclusivity sentence leave every skill installed twice").toMatch(
      /installing both leaves you with every skill twice/i,
    );
    expect(installBlock).toMatch(/installing both leaves you with every skill twice/i);
    expect(readme, "the copied rail does not auto-update and the README must say so").toMatch(/do not auto-update/i);
    expect(readme).toContain("skills.sh/b/coalesce-labs/catalyst-cloud-skills");
  });

  test("the credential step sits inside the install block, named login, keyless first and the key forms second", () => {
    const install = readme.indexOf("\n## Install\n");
    // Keyless is the preferred rail: the bare `catalyst-skills login` triple leads.
    const keyless = "npm install -g @catalyst-cloud/catalyst-skills\ncatalyst-skills login\ncatalyst-skills ready";
    const envForm = "CATALYST_CLOUD_TOKEN=<your-personal-key> catalyst-skills login";
    // "Beside the install commands" is the property: the connect step is a sub-heading of Install,
    // and the login command lands before the next top-level section starts.
    const connect = readme.indexOf("\n### Then connect to your tenant\n");
    expect(connect, "the connect step must be a ### inside ## Install").toBeGreaterThan(install);
    const nextSection = readme.indexOf("\n## ", install + 1);
    expect(nextSection).toBeGreaterThan(0);
    expect(readme.indexOf(keyless), "the keyless login command must be inside the install section").toBeGreaterThan(install);
    expect(readme.indexOf(keyless)).toBeLessThan(nextSection);
    expect(connect).toBeLessThan(nextSection);
    // The README claims to quote the canonical block; that claim has to be checkable.
    expect(installBlock).toContain("### Then connect to your tenant");
    expect(readme).toContain(keyless);
    expect(installBlock).toContain(keyless);
    expect(readme).toContain(envForm);
    expect(installBlock).toContain(envForm);
    // Keyless leads; the key forms (env, then --key) come after it.
    expect(readme.indexOf(keyless), "keyless login must come before the key fallback").toBeLessThan(readme.indexOf(envForm));
    expect(readme.indexOf("--key <your-personal-key>"), "the env form must come before the --key form").toBeGreaterThan(
      readme.indexOf(envForm),
    );
    // The 0.1 verb must not lead, and `install` is a repair path that never appears as a headline step.
    expect(readme).not.toMatch(/^.*catalyst-skills join\b/m);
    expect(readme.indexOf("catalyst-skills install"), "install is a repair path, never part of the install headline").toBe(-1);
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

  test("states the minimum versions: Node 22 with its built-in SQLite, better-sqlite3 if it resolves, Bun optional", () => {
    expect(readme).toMatch(/^## Requirements$/m);
    expect(readme).toMatch(/Node 22/);
    expect(readme).not.toMatch(/Node 18/);
    expect(readme).toMatch(/built-in SQLite/);
    expect(readme).toMatch(/better-sqlite3/);
    expect(readme).toMatch(/Bun is optional/);
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
    expect(readme).toMatch(/`0` for fresh, `1` for present but stale, `2` for not connected, `3` for absent/);
    expect(readme).toContain("catalyst-skills watch");
    expect(readme).toContain("seven days or 256 MiB");
  });

  test("names what a key cannot see yet and where those facts live, and the one connect step", () => {
    expect(readme).toMatch(/^## What a key cannot see yet$/m);
    expect(readme).toContain("settings/coding-accounts");
    expect(readme).toContain("explain --history");
    // A person releases a park themselves now; the README names the verb and the skill, never an operator.
    expect(readme).toContain("catalyst-skills release");
    expect(readme).not.toMatch(/Release a park\. When a ticket is parked after repeated failures, an operator releases it/);
    expect(readme).toContain("setup skill");
    expect(readme).toContain("the only connect step a customer runs");
    // CTC-2077 — a person connects with their OWN key; the account key is named once, as the host
    // credential it is; "API keys" is the settings page's name, so it may appear in that phrase only.
    expect(readme).toContain("personal key");
    expect(readme).toContain("<your-personal-key>");
    expect(readme).not.toContain("<your-account-key>");
    expect(readme).toContain("Settings → API keys");
    expect(readme.match(/\bAPI keys?\b/g)?.every((m) => m === "API keys") ?? true).toBe(true);
    expect(readme).not.toMatch(/not visible to an account key yet/);
  });

  test("documents the one-line update notice and the uninstall of everything it wrote; the publish secret lives in CONTRIBUTING", () => {
    expect(readme).toContain("[catalyst-skills] updated");
    expect(readme).toContain("npm install -g @catalyst-cloud/catalyst-skills@latest");
    // The install alone does not rewrite customer.json.cliPath — the re-login step must be documented.
    expect(readme).toMatch(/npm install -g @catalyst-cloud\/catalyst-skills@latest && catalyst-skills login/);
    expect(readme).not.toMatch(/npm update -g/);
    for (const name of CUSTOMER_SKILLS) expect(readme, `uninstall must name ${name}`).toContain(`\`${name}\``);
    for (const f of ["customer.json", "contract.json", "replica.db", "replica.db.pid", "replica.db.writer.lock", "watch-cursor.json"]) {
      expect(readme, `uninstall must name ${f}`).toContain(f);
    }
    expect(readme).not.toContain("NPM_PUBLISH_TOKEN");
    expect(contributing).toContain("NPM_PUBLISH_TOKEN");
    expect(contributing).toContain("skills-bundle-v<version>");
  });
});

describe("the package manifest", () => {
  test("is the documented name, public, and carries the SDK plus yaml (env inventory's workflow reader) as its runtime dependencies", () => {
    expect(manifest.name).toBe("@catalyst-cloud/catalyst-skills");
    expect(manifest.publishConfig.access).toBe("public");
    // yaml moved here from devDependencies: a hand-written line scanner over a GitHub workflow
    // silently loses names written in flow style, which is exactly the failure `env inventory`
    // exists to avoid — the real parser costs one dependency with zero transitive dependencies of
    // its own. `test/smoke-publish.test.ts` packs and installs the real tarball, so this is exercised
    // end to end, not just asserted here.
    expect(manifest.dependencies).toEqual({
      "@catalyst-cloud/sdk": expect.stringMatching(/^\^0\.10\./),
      yaml: expect.stringMatching(/^\^2\./),
    });
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

  test("the plugin manifests make this repository its own marketplace, at the package's version", () => {
    const marketplace = JSON.parse(readFileSync(join(pkgRoot, ".claude-plugin", "marketplace.json"), "utf8")) as {
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string; description?: string }[];
    };
    expect(marketplace.name).toBe("catalyst-cloud");
    expect(marketplace.owner.name).toBe("Coalesce Labs");
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({ name: "catalyst", source: "./" });
    expect(marketplace.plugins[0]!.description, "the gallery row needs a one-liner").toBeTruthy();

    const plugin = JSON.parse(readFileSync(join(pkgRoot, ".claude-plugin", "plugin.json"), "utf8")) as {
      name: string;
      description: string;
      version: string;
      author: { name: string };
      skills: string[];
    };
    expect(plugin.name).toBe("catalyst");
    expect(plugin.author.name).toBe("Coalesce Labs");
    expect(plugin.description).toBeTruthy();
    // A plugin whose version never moves looks to Claude Code like a bundle that never shipped;
    // `npm run version:sync` is what keeps these two equal, and --check fails CI on drift.
    expect(plugin.version, "run: npm run version:sync").toBe(manifest.version);
    expect(plugin.skills).toEqual(CUSTOMER_SKILLS.map((n) => `./skills/${n}`));
    for (const p of plugin.skills) {
      expect(existsSync(join(pkgRoot, p, "SKILL.md")), `${p} must exist`).toBe(true);
    }
  });

  test("the version matches the CHANGELOG's top entry, which is 0.7.0", () => {
    const changelog = readFileSync(join(pkgRoot, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`## ${manifest.version}\n`);
    expect(changelog.indexOf("## 0.7.0")).toBe(changelog.indexOf("## "));
    expect(manifest.version).toBe("0.7.0");
  });
});

// A customer's agent read `gitAutomation: "off"` as the reason nothing started. No Catalyst code reads
// that field; an unmapped team is the cause, and it never clears on the next pass.
describe("the dispatch gate is the stage mapping, not git automation", () => {
  const read = (rel: string) => readFileSync(join(skillsRoot, rel), "utf8");

  test("stages-and-mapping no longer claims git automation deletes anything, and says nothing reads it", () => {
    const text = read("how-catalyst-works/references/stages-and-mapping.md");
    expect(text).not.toMatch(/can delete a team's own review automation/);
    expect(text).toMatch(/`teams\[\]\.gitAutomation`[^\n]*nothing reads it/);
  });

  test("the stuck and runs-next references carve an unmapped team out of 'clears on the next pass'", () => {
    for (const rel of ["whats-happening/references/why-is-it-stuck.md", "how-catalyst-works/references/what-runs-next.md"]) {
      expect(read(rel)).toMatch(/`workflow_mapping_unknown`[^\n]*(does not|never) clear/);
    }
  });

  test("catalyst-setup describes setting up one team as the pilot", () => {
    const text = read("catalyst-setup/references/what-each-check-means.md");
    expect(text).toMatch(/one team/i);
    expect(text).toMatch(/no other team/i);
    expect(text).toContain("Map my stages");
  });
});

// CTC-2542: the page documents every readiness check the engine reports, and nothing hand-writes a
// count of them. What this gate actually holds is the PAGE against `TEAM_CHECK_IDS` above — this
// repository's own vendored roster — so a row dropped, renamed, duplicated or left out of wire order
// reddens here, as does a hand-written count coming back. It cannot notice the engine adding a
// fifteenth check: nothing in this repository imports `READINESS_CHECK_IDS` (see the array's comment
// at the top of this file), so a new check is one line there plus one documented row, by hand. That
// is why the page itself names the contract's `readinessChecks[]` as the list of record.
describe("what-each-check-means documents every readiness check, and no file counts them", () => {
  const pagePath = "catalyst-setup/references/what-each-check-means.md";
  const page = () => readFileSync(join(skillsRoot, pagePath), "utf8");
  const HEADING = "## The checks";

  /** Rows of the table directly under `heading`, up to the next `## ` heading. Each row is its
   *  trimmed cells, in file order; the header and separator rows are excluded. */
  function tableRows(text: string, heading: string): string[][] {
    const lines = text.split("\n");
    const start = lines.indexOf(heading);
    expect(start, `heading "${heading}" must be present`).toBeGreaterThanOrEqual(0);
    const rows: string[][] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("## ")) break;
      if (!line.startsWith("|")) continue;
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c))) continue; // separator row
      if (cells[0] === "check id") continue; // header row
      rows.push(cells);
    }
    return rows;
  }

  test("the table lists exactly the fourteen check ids, in wire order", () => {
    const rows = tableRows(page(), HEADING);
    expect(rows.map((r) => r[0])).toEqual(TEAM_CHECK_IDS.map((id) => `\`${id}\``));
  });

  test("every row carries all four columns, none empty", () => {
    const rows = tableRows(page(), HEADING);
    for (const row of rows) {
      expect(row).toHaveLength(4);
      for (const cell of row) expect(cell.length).toBeGreaterThan(0);
    }
  });

  test("no file under skills/ or the README states a hand-written count of the readiness checks", () => {
    const COUNT_WORD = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty)`;
    const CHECK_PHRASE = String.raw`(?:readiness|per-team|team)\s+checks?`;
    const wideRule = new RegExp(String.raw`\b${COUNT_WORD}\b(?:\s+[\w-]+){0,2}\s+${CHECK_PHRASE}\b`, "i");
    const dashCheckRule = new RegExp(String.raw`\b${COUNT_WORD}-checks?\b`, "i");
    // The count can also sit BEFORE a bare "checks" with the readiness noun AFTER it — "fourteen
    // checks per team", "fourteen checks for each team". The pre-noun rule above walks straight past
    // those, so the name of this test would have promised coverage it did not have.
    const postNounRule = new RegExp(
      String.raw`\b${COUNT_WORD}\b(?:\s+[\w-]+){0,2}\s+checks?\s+(?:per|for|on|against)\s+(?:each\s+|every\s+|the\s+|a\s+)?team`,
      "i",
    );
    const RULES = [wideRule, dashCheckRule, postNounRule];
    // The page rule: the whole page is about readiness checks, so any count word before a bare
    // "check"/"checks" here is this defect, even without "readiness"/"per-team"/"team" beside it.
    // It stays scoped to the page — a bare "the two checks" is ordinary prose anywhere else.
    const pageRule = new RegExp(String.raw`\b${COUNT_WORD}\b(?:\s+[\w-]+){0,2}\s+checks?\b`, "i");

    // ⭐ positive control, on fixed strings only, so it still fires when the pages are broken: each
    // phrasing this gate claims to cover must match at least one of its rules. The last two are the
    // post-noun form a mutation proved was walking through (CTC-2542 validate attempt 1, finding 3).
    for (const stale of [
      "the ten per-team readiness checks the cloud runs",
      "The engine always reports all eleven checks",
      "## The eleven checks",
      "tenant readiness from the contract's ten per-team checks",
      "a ten-check readiness vector",
      "The engine reports fourteen checks per team.",
      "fourteen readiness checks for each team",
    ]) {
      expect([...RULES, pageRule].some((r) => r.test(stale)), `no rule matches "${stale}"`).toBe(true);
    }

    const mdFiles = [join(pkgRoot, "README.md"), ...walk(skillsRoot).filter((f) => f.endsWith(".md"))];
    for (const f of mdFiles) {
      const text = readFileSync(f, "utf8");
      const rel = relative(pkgRoot, f);
      for (const rule of RULES) {
        expect(text, `${rel} must not name a readiness-check count`).not.toMatch(rule);
      }
    }

    expect(page(), `${pagePath} must not name any check count`).not.toMatch(pageRule);
  });

  test("the fixture contract's readinessChecks ids equal the documented list", () => {
    const contract = buildFixtureContract();
    expect(contract.readinessChecks.map((c) => c.id)).toEqual([...TEAM_CHECK_IDS]);
  });
});

// A person releases a parked or held ticket from their own seat now (`catalyst-skills release`, the
// `unstick` skill); the references that sent every park to an operator are rewritten, not left beside it.
describe("releasing a park is a verb the person's agent runs, not an operator action", () => {
  const read = (rel: string) => readFileSync(join(skillsRoot, rel), "utf8");
  const OPERATOR_ONLY = [
    ["whats-happening/references/why-is-it-stuck.md", /your key has no unpark verb/],
    ["run-this-project/references/stalls-and-escalation.md", /releasing the park is an operator action/],
    ["run-this-project/references/making-work-ready.md", /releasing a cloud park is an operator action/],
    ["whats-happening/SKILL.md", /a park is released only by an operator/],
  ] as const;

  test("positive control: the matchers find the old sentences in the text they were written against", () => {
    expect("an operator unparks it; your key has no unpark verb, so").toMatch(OPERATOR_ONLY[0][1]);
    expect("file an ask; releasing the park is an operator action").toMatch(OPERATOR_ONLY[1][1]);
    expect("releasing a cloud park is an operator action, not a card move").toMatch(OPERATOR_ONLY[2][1]);
    expect("PR labels and reactions are not mirrored, and a park is released only by an operator;").toMatch(OPERATOR_ONLY[3][1]);
  });

  for (const [rel, re] of OPERATOR_ONLY) {
    test(`${rel} no longer says release is an operator's, and names the release`, () => {
      const text = read(rel);
      expect(text).not.toMatch(re);
      expect(text).toMatch(/`unstick`|catalyst-skills release/);
    });
  }

  test("the unstick playbook runs explain, then history, then a dry run, then the release, and files an ask only for a refusal a person must fix", () => {
    const playbook = read("unstick/references/playbook.md");
    const order = ["catalyst-skills explain", "--history", "--dry-run", "--because"].map((s) => playbook.indexOf(s));
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(playbook).toMatch(/--retry-unchanged/);
    expect(playbook).toContain("what-needs-me");
    expect(playbook).toMatch(/never close a person's pull request/i);
  });
});

// ⭐ THE CHECK COUNT IS THE CLOUD'S, NOT OURS — so customer-facing prose here may not state it.
// `catalyst-setup`'s description said "ten per-team checks", this reference said "eleven" twice and
// tabled eleven rows, and the live engine has fourteen (catalyst-cloud
// `packages/types/src/workflow-readiness.ts`, READINESS_CHECK_IDS). `src/ready.ts` never hardcodes a
// count — it iterates whatever the contract sends — so the drift only ever lived in the prose, which
// is exactly where a type checker cannot reach. The skill's own SKILL.md already states the rule
// ("The live check ids, severities, states and the people who can answer come from the contract");
// its description contradicted it.
//
// ⛔ WHY THIS GATE IS ABOUT THE COUNT, NOT THE TABLE. Completeness IS asserted — by a different
// gate, below: "every readiness check the engine reports has exactly one row on the page a customer
// is sent to" loops `DOCUMENTED_CHECKS` requiring exactly one row per id and then asserts sorted
// equality, so a missing row and an extra row both fail. `DOCUMENTED_CHECKS` is `TEAM_CHECK_IDS`
// (the roster at the top of this file), and `test/fixture-contract.ts` is held to that same roster
// by "the fixture contract's readinessChecks ids equal the documented list" — one list of record,
// three consumers.
//
// What THIS gate holds is narrower and separate: no customer-facing prose may state a COUNT. A
// count is the one claim that cannot be kept true by adding a row, because it goes stale the moment
// a check is added while every table entry is still correct. So the page names the contract as the
// list of record and never says how long it is.
//
// ⚠️ This paragraph previously said the opposite — that this gate does not assert completeness, that
// no roster exists here, and that the fixture is shorter than the live list. All three were false
// when written (PR #20 added the comment alongside its own literal roster and a completeness test),
// and the repair commit that replaced that literal with `TEAM_CHECK_IDS` left the prose behind.
// Corrected against the code, line by line (CTC-2542 validate round 3, code-review finding 1).
//
// Modelled on catalyst-cloud's `apps/mirror/test/agent-guide.test.ts` ("never hard-codes the number
// of team checks"), written after CTC-2028's eleventh check reddened a hard-coded "ten".
// ⭐ CTC-2542 round 3 — the header above describes THIS FILE, so it is drift-gated like the customer
// pages are. The three retired claims are named literally: a future edit that reinstates any of them
// fails here instead of shipping a comment that contradicts the code eight lines below it.
describe("this file's own header does not contradict the gates it heads", () => {
  // ⛔ SCOPED TO THE HEADER, NOT THE WHOLE FILE. The retired phrases are quoted literally below, so
  // a whole-file search matches this gate's own source and fails on itself — the first run did
  // exactly that. The header is everything before this describe, which is the text the claims live
  // in and the only text they can go stale in.
  const FULL = readFileSync(new URL(import.meta.url).pathname, "utf8");
  const MARKER = 'describe("this file\'s own header does not contradict the gates it heads"';
  const SELF = FULL.slice(0, FULL.indexOf(MARKER));

  // ⛔ AND THE INVERSE TRAP, WHICH ROUND 4 WALKED INTO. The gate below names three things it claims
  // exist elsewhere. Searching `FULL` for them cannot fail: the assertion lines ARE those literals,
  // so the needle is always found in the gate's own source. Same self-reference as the warning
  // above, opposite direction — that one failed on itself, this one PASSED on itself.
  //
  // `ELSEWHERE` is the file minus two regions: this describe block (the assertions' own text) and
  // the header comment immediately above it (the prose under audit — it QUOTES one of the two test
  // titles at "…by \"the fixture contract's readinessChecks ids…\"", so a header-inclusive search
  // would let the header vouch for itself). What remains is code this gate does not write, which is
  // the only place a claim about the gates below can be honestly confirmed.
  const END_SENTINEL = "END OF THE SELF-DRIFT GATE — the assertions above may not see past here.";
  const ELSEWHERE = ((): string => {
    const lines = FULL.split("\n");
    const gateStart = lines.findIndex((line) => line.startsWith(MARKER));
    if (gateStart < 0) throw new Error("self-drift gate: could not locate its own describe");
    let headerStart = gateStart;
    while (headerStart > 0 && lines[headerStart - 1].trimStart().startsWith("//")) headerStart -= 1;
    const gateEnd = lines.length - 1 - [...lines].reverse().findIndex((l) => l.includes(END_SENTINEL));
    if (gateEnd < gateStart) throw new Error("self-drift gate: could not locate its end sentinel");
    return [...lines.slice(0, headerStart), ...lines.slice(gateEnd + 1)].join("\n");
  })();

  test("⭐ the three retired false claims never come back", () => {
    // Positive control: the matcher finds a claim that IS present, so an empty result means absent
    // rather than a dead search.
    expect(SELF).toContain("Completeness IS asserted");
    for (const retired of [
      "WHY THIS GATE DOES NOT ASSERT THE TABLE IS COMPLETE",
      "There is no roster in this repository",
      "SHORTER than the live list",
    ]) {
      expect({ retired, present: SELF.includes(retired) }).toEqual({ retired, present: false });
    }
  });

  test("⭐ and the gates the header now points at actually exist", () => {
    // The header says completeness is asserted by a gate below, that DOCUMENTED_CHECKS is the
    // roster, and that the fixture is held to the same list. If any of those stops being true the
    // header is wrong again — so each is pinned by name here, against `ELSEWHERE` rather than the
    // whole file, so that renaming the thing named makes this red.
    //
    // Positive control: a literal that genuinely lives outside both excluded regions is found, so a
    // miss below means the needle is absent rather than the region being empty or mis-sliced.
    expect(ELSEWHERE).toContain("const TEAM_CHECK_IDS = [");
    for (const claimed of [
      "const DOCUMENTED_CHECKS = TEAM_CHECK_IDS;",
      "every readiness check the engine reports has exactly one row on the page a customer is sent to",
      "the fixture contract's readinessChecks ids equal the documented list",
    ]) {
      expect({ claimed, present: ELSEWHERE.includes(claimed) }).toEqual({ claimed, present: true });
    }
  });

  // END OF THE SELF-DRIFT GATE — the assertions above may not see past here.
});

describe("no customer-facing prose states a readiness check count", () => {
  const COUNTED_CHECKS =
    // `{0,3}` because the stale wording put two qualifiers between the count and the noun ("ten
    // per-team readiness checks"). The positive control below is what caught a tighter first draft.
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|\d+)\s+(?:[a-z-]+\s+){0,3}checks\b/i;
  const PAGES = ["catalyst-setup/SKILL.md", "catalyst-setup/references/what-each-check-means.md"] as const;
  const read = (rel: string) => readFileSync(join(skillsRoot, rel), "utf8");

  test("⭐ positive control: the matcher finds every count this gate was written against", () => {
    for (const stale of [
      "tenant readiness from the contract's ten per-team checks",
      "the ten per-team readiness checks the cloud runs",
      "The engine always reports all eleven checks",
      "Three checks are informational by design",
      "## The eleven checks",
    ]) {
      expect(stale).toMatch(COUNTED_CHECKS);
    }
    // Not `.every()` — an empty list satisfies that vacuously, and a mistyped path would read as a pass.
    expect(PAGES).toHaveLength(2);
    for (const rel of PAGES) expect(read(rel).length).toBeGreaterThan(500);
  });

  for (const rel of PAGES) {
    test(`${rel} states no check count`, () => {
      expect(read(rel)).not.toMatch(COUNTED_CHECKS);
    });
  }

  test("the reference names the contract as the list of record, so a newer check reads as missing here rather than as a wrong total", () => {
    const page = read("catalyst-setup/references/what-each-check-means.md");
    expect(page).toContain("`readinessChecks[]` is the list of record");
    expect(page).toMatch(/newer than this page/);
    expect(page).toMatch(/severity/);
  });

  // CTC-2542 asks for a gate that IMPORTS `READINESS_CHECK_IDS` and asserts one documented row per
  // id, so that the next check added to the engine reddens this bundle instead of shipping an
  // incomplete page. That import does not exist from here yet, measured both ways:
  //   • `@catalyst-cloud/types` is not published — `npm view @catalyst-cloud/types version` → E404.
  //   • `@catalyst-cloud/sdk`, our only `@catalyst-cloud` dependency, carries no check id at all:
  //     a search of node_modules/@catalyst-cloud/sdk for `oauth_scope|READINESS_CHECK_IDS|
  //     reviewer_configured` returns nothing, while the same search for `TenantContract` hits four
  //     files including dist/tenant-contract.d.ts — so the instrument reaches the tree.
  // Until one of those carries the ids, the roster below is VENDORED, the way catalyst-cloud's own
  // `apps/mirror/test/fixtures/skills-bundle-verbs.ts` vendors this bundle's surface in the other
  // direction. It catches a row being dropped, renamed or duplicated — the regression this page
  // already suffered twice (the 0.3.0 changelog records the previous manual correction). It CANNOT
  // notice a fifteenth check appearing upstream, which is exactly why the page above also tells the
  // reader the contract is the list of record and that `check.mjs` prints whatever it sends.
  // Upstream: catalyst-cloud `packages/types/src/workflow-readiness.ts`, READINESS_CHECK_IDS, read
  // at origin/main e0b790eb (2026-09-17). Declaration order there IS wire order.
  // One roster, not two: `TEAM_CHECK_IDS` at the top of this file IS the vendored list described
  // above, and the merge that brought these two gates together is exactly when a second hand-written
  // copy would have started drifting from the first.
  const DOCUMENTED_CHECKS = TEAM_CHECK_IDS;

  /**
   * The first cell of every backtick-quoted row in the READINESS table, in page order — scoped to
   * the `## The checks` section, because `## The machine checks the CLI adds` further down carries
   * rows of the same shape for a different set (`node`, `config`, `sdk`…). A first draft of this
   * parser read both tables and the equality below is what caught it.
   */
  const readinessSection = () => {
    const page = read("catalyst-setup/references/what-each-check-means.md");
    const start = page.indexOf("\n## The checks\n");
    if (start === -1) throw new Error("skills-content test: no `## The checks` section");
    const end = page.indexOf("\n## ", start + 1);
    if (end === -1) throw new Error("skills-content test: `## The checks` runs to end of file");
    return page.slice(start, end);
  };
  const tabledCheckIds = () =>
    readinessSection()
      .split("\n")
      .map((l) => /^\| `([a-z_]+)` \|/.exec(l)?.[1])
      .filter((id): id is string => id !== undefined);

  // ⭐ This control asserts ONLY against literals, so it still fires when the page is broken. An
  // earlier draft also asserted against the live page and therefore went red along with the fix it
  // was meant to vouch for — a control that dies with its subject proves nothing about the subject.
  test("⭐ positive control: the row matcher reads a row and rejects a header, on fixed strings", () => {
    expect(/^\| `([a-z_]+)` \|/.exec("| `oauth_scope` | proves | fix | who |")?.[1]).toBe("oauth_scope");
    expect(/^\| `([a-z_]+)` \|/.exec("| id | proves | fix | who |")).toBeNull();
    expect(/^\| `([a-z_]+)` \|/.exec("| -- | -- | -- | -- |")).toBeNull();
    expect(DOCUMENTED_CHECKS.length).toBe(14);
    expect(new Set(DOCUMENTED_CHECKS).size).toBe(DOCUMENTED_CHECKS.length); // the roster has no duplicate
  });

  test("every readiness check the engine reports has exactly one row on the page a customer is sent to", () => {
    const tabled = tabledCheckIds();
    expect(tabled.length).toBeGreaterThan(0); // the section was found and parsed
    for (const id of DOCUMENTED_CHECKS) {
      expect({ id, rows: tabled.filter((t) => t === id).length }).toEqual({ id, rows: 1 });
    }
    // And nothing extra: a row for an id the engine does not report is its own kind of wrong. This
    // equality is what caught a first parser that also swallowed the machine-check table below.
    expect([...tabled].sort()).toEqual([...DOCUMENTED_CHECKS].sort());
  });

  test("the readiness section stops before the machine checks, which carry rows of the same shape", () => {
    expect(readinessSection()).not.toContain("The machine checks the CLI adds");
    for (const machine of ["`cliPath`", "`sdk`", "`node`"]) expect(readinessSection()).not.toContain(machine);
  });
});
