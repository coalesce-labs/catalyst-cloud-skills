// skills-content.test.ts — CTC-1926 content gate: the bundle ships the six customer skills with
// provenance, no fleet-owner defaults, and an install page that states provenance, dependency
// posture, minimum versions, and the pinned contract range. CTC-1949: the page is a customer's
// first read in the public repository, so it links every skill and names no internal ticket.
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CUSTOMER_SKILLS, PROVENANCE_MARKER } from "../src/cli";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
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

describe("the six customer skills ship, with provenance", () => {
  test("exactly the six skills the ticket names are present", () => {
    const dirs = readdirSync(join(pkgRoot, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...CUSTOMER_SKILLS]);
  });

  for (const name of CUSTOMER_SKILLS) {
    test(`${name}: frontmatter name matches, description present, provenance line carried`, () => {
      const md = readFileSync(join(pkgRoot, "skills", name, "SKILL.md"), "utf8");
      expect(md.startsWith("---\n")).toBe(true);
      expect(md).toContain(`name: ${name}\n`);
      expect(md).toMatch(/^description:\n? +\S/m);
      expect(md).toContain(PROVENANCE_MARKER);
    });
  }

  test("no fleet-owner defaults leak into customer skills", () => {
    for (const name of CUSTOMER_SKILLS) {
      const md = readFileSync(join(pkgRoot, "skills", name, "SKILL.md"), "utf8");
      expect(md, `${name} must not default to the maintainer tenant`).not.toMatch(/tenant-0/);
      expect(md, `${name} must not point at the private catalyst repository`).not.toMatch(
        /coalesce-labs\/catalyst/,
      );
      expect(md, `${name} must not reference the fleet thoughts repo`).not.toMatch(/thoughts\//);
      expect(md, `${name} must not carry internal ticket ids`).not.toMatch(/\bC[TL]C-\d+\b/);
    }
  });
});

describe("Codex round 1: the skills teach the routes the mirror actually implements", () => {
  const skill = (name: string) => readFileSync(join(pkgRoot, "skills", name, "SKILL.md"), "utf8");

  test("linearis: a ticket read is gated on /api/v1/freshness and reports stale/inconclusive", () => {
    const md = skill("linearis");
    expect(md).toContain("/api/v1/freshness?account=<account>");
    expect(md).toContain("/api/v1/issues/<id>?account=<account>");
    expect(md.indexOf("/api/v1/freshness")).toBeLessThan(md.indexOf("/api/v1/issues/<id>"));
    for (const field of ["last_reconcile_ms", "has_error", "unproven_legs", "server_time_ms"]) {
      expect(md, `the freshness verdict must read ${field}`).toContain(field);
    }
    expect(md).toMatch(/\*\*stale\*\*/);
    expect(md).toMatch(/\*\*inconclusive\*\*/);
  });

  test("linearis: search goes to /api/v1/search?q= and never to an ignored q on /api/v1/issues", () => {
    const md = skill("linearis");
    expect(md).toContain("/api/v1/search?q=<terms>&account=<account>");
    expect(md).not.toMatch(/\/api\/v1\/issues\?[^\s`"]*\bq=/);
  });

  test("ask: every active-work ask is a ticket; no status-summary substitute, no default without a ticket", () => {
    const md = skill("ask");
    expect(md).toContain("catalyst-ask");
    expect(md).not.toContain("## Asks open");
    expect(md).not.toMatch(/record asks in the scope's status summary/);
    expect(md).toContain("File the ask BEFORE proceeding on the default");
    expect(md).toContain("cannot be filed, so the default does not fire");
    expect(md).toContain("do not proceed on the default while no ticket exists");
  });

  test("concierge + steward: recent history is a bounded /api/v1/changes read; /api/v1/events is named as a stream", () => {
    for (const name of ["concierge", "steward"]) {
      const md = skill(name);
      expect(md, `${name} must name the bounded read`).toContain("/api/v1/changes?since=");
      expect(md, `${name} must say what /api/v1/events is`).toMatch(
        /\/api\/v1\/events[^\n]*(live|stream)/,
      );
      expect(md, `${name} must not offer the stream as recent history`).not.toMatch(
        /what changed recently \(`\/api\/v1\/events`\)/,
      );
    }
    const concierge = skill("concierge");
    expect(concierge).toContain("head_seq");
    expect(concierge).toContain("mirror:feed");
    expect(concierge).toContain("resync");
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
  });

  test("tenant discovery from the key alone via GET /api/v1/me, config path and mode stated", () => {
    expect(readme).toContain("GET /api/v1/me");
    expect(readme).toContain("~/.config/catalyst-cloud/customer.json");
    expect(readme).toContain("0600");
  });

  test("every skill is linked so it can be read before it is installed", () => {
    for (const name of CUSTOMER_SKILLS) {
      expect(readme, `README must link skills/${name}/SKILL.md`).toContain(`skills/${name}/SKILL.md`);
    }
  });

  test("states which skills are vendored from the catalyst-dev plugin, and never sells the private marketplace", () => {
    expect(readme).toContain("catalyst-dev");
    expect(readme).toContain("vendored-from");
    for (const name of ["concierge", "steward", "ask", "linearis"]) expect(readme).toContain(name);
    expect(readme).not.toMatch(/marketplace add[^\n]*is how (customers|you) install/);
  });

  test("states the minimum versions of Claude Code, Node and Bun", () => {
    expect(readme).toMatch(/Claude Code 2\.0/);
    expect(readme).toMatch(/Node 18\.17/);
    expect(readme).toMatch(/Bun 1\.0/);
  });

  test("states the pinned tenant contract range in present tense, with no internal ticket ids anywhere", () => {
    expect(readme).toContain("0.x");
    expect(readme).toContain("tenantContractRange");
    expect(readme, "a customer README names no internal ticket").not.toMatch(/\bC[TL]C-\d+\b/);
  });

  test("documents the one-line update notice; the publish secret lives in CONTRIBUTING, not the README", () => {
    expect(readme).toContain("[catalyst-skills] updated");
    expect(readme).toContain("npm update -g @catalyst-cloud/catalyst-skills");
    expect(readme).not.toContain("NPM_PUBLISH_TOKEN");
    expect(contributing).toContain("NPM_PUBLISH_TOKEN");
    expect(contributing).toContain("skills-bundle-v<version>");
  });
});

describe("the package manifest", () => {
  test("is the documented name, public, and zero runtime dependencies (offline-real smoke)", () => {
    expect(manifest.name).toBe("@catalyst-cloud/catalyst-skills");
    expect(manifest.publishConfig.access).toBe("public");
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  test("bin, shipped files, engines, and the pinned contract range are wired", () => {
    expect(manifest.bin["catalyst-skills"]).toBe("bin/catalyst-skills.js");
    for (const f of ["bin", "dist", "skills", "README.md", "CHANGELOG.md", "LICENSE"]) {
      expect(manifest.files).toContain(f);
    }
    expect(existsSync(join(pkgRoot, manifest.bin["catalyst-skills"]!))).toBe(true);
    expect(manifest.engines.node).toBe(">=18.17");
    expect(manifest.catalystCloud?.tenantContractRange).toBe("0.x");
  });

  test("the version matches the CHANGELOG's top entry", () => {
    const changelog = readFileSync(join(pkgRoot, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`## ${manifest.version}\n`);
  });
});
