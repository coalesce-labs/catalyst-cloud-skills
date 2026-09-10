// join.test.ts — CTC-1926 unit + flow coverage: tenant discovery from the key (GET /me, PR #3332),
// config write, skill install, and the Tier-2 one-line update notice.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CliError,
  CUSTOMER_SKILLS,
  MeError,
  PACKAGE_NAME,
  PROVENANCE_MARKER,
  UsageError,
  configPathFor,
  defaultCtx,
  defaultSkillsDirFor,
  fetchMe,
  installSkills,
  loadConfig,
  main,
  normalizeBaseUrl,
  parseArgs,
  parseChangelogEntry,
  saveConfig,
  updateNoticeLine,
  writeConfig,
  formatMode,
  type CustomerConfig,
  type Ctx,
} from "../src/cli";
import { FIXTURE_ME_BODY, startMeFixture, type FixtureServer } from "./fixture";

let home: string;
let out: string[];
let err: string[];
let server: FixtureServer;

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    env: {},
    home,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch,
    now: () => new Date("2026-09-09T12:00:00Z"),
    ...overrides,
  };
}

function seededConfig(over: Partial<CustomerConfig> = {}): CustomerConfig {
  return {
    baseUrl: "https://example.dev",
    key: "fixture-key",
    account: FIXTURE_ME_BODY.account,
    slug: FIXTURE_ME_BODY.slug,
    name: FIXTURE_ME_BODY.name,
    permissions: [...FIXTURE_ME_BODY.permissions],
    principal: FIXTURE_ME_BODY.principal,
    joinedAt: "2026-09-01T00:00:00Z",
    lastSkillBundleVersion: "0.0.9",
    ...over,
  };
}

function readConfig(): CustomerConfig {
  return JSON.parse(readFileSync(configPathFor(home), "utf8")) as CustomerConfig;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "catalyst-skills-"));
  out = [];
  err = [];
});

afterAll(async () => {
  await server?.close();
});

beforeAll(async () => {
  server = await startMeFixture();
});

describe("parseArgs", () => {
  test("parses join with flags", () => {
    const a = parseArgs([
      "join",
      "--key",
      "k",
      "--base-url",
      "http://x",
      "--skills-dir",
      "/s",
      "--force",
    ]);
    expect(a).toMatchObject({
      command: "join",
      key: "k",
      baseUrl: "http://x",
      skillsDir: "/s",
      force: true,
    });
  });
  test("missing flag value is a UsageError", () => {
    expect(() => parseArgs(["join", "--key"])).toThrow(UsageError);
  });
  test("unknown option is a UsageError", () => {
    expect(() => parseArgs(["--wat"])).toThrow(UsageError);
  });
  test("two positional arguments is a UsageError", () => {
    expect(() => parseArgs(["join", "extra"])).toThrow(UsageError);
  });
  test("help and version flags", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-V"]).version).toBe(true);
  });
});

describe("normalizeBaseUrl", () => {
  test("strips trailing slashes only", () => {
    expect(normalizeBaseUrl("https://x.dev///")).toBe("https://x.dev");
    expect(normalizeBaseUrl("https://x.dev")).toBe("https://x.dev");
  });
});

describe("fetchMe — the key names the tenant (CTC-493 / PR #3332)", () => {
  test("happy path echoes account, slug, name, permissions, principal", async () => {
    const me = await fetchMe(server.url, "fixture-key", fetch);
    expect(me).toEqual(FIXTURE_ME_BODY);
  });
  test("permissions null (unrestricted) round-trips as null", async () => {
    const unrestricted = await startMeFixture(() => ({
      status: 200,
      body: { ...FIXTURE_ME_BODY, permissions: null, principal: "session" },
    }));
    try {
      const me = await fetchMe(unrestricted.url, "fixture-key", fetch);
      expect(me.permissions).toBeNull();
      expect(me.principal).toBe("session");
    } finally {
      await unrestricted.close();
    }
  });
  test("401 becomes a human-readable MeError that never echoes the key", async () => {
    await expect(fetchMe(server.url, "wrong-key", fetch)).rejects.toThrow(
      /credential not accepted/,
    );
    try {
      await fetchMe(server.url, "wrong-key", fetch);
    } catch (e) {
      expect(e).toBeInstanceOf(MeError);
      expect((e as MeError).kind).toBe("http");
      expect((e as MeError).status).toBe(401);
      expect((e as Error).message).not.toContain("wrong-key");
    }
  });
  test("network failure becomes a kind=network MeError naming the URL", async () => {
    const refuse = await startMeFixture();
    const deadUrl = refuse.url;
    await refuse.close();
    await expect(fetchMe(deadUrl, "fixture-key", fetch)).rejects.toMatchObject({ kind: "network" });
  });
  test("a body missing required fields is a shape error", async () => {
    const bad = await startMeFixture(() => ({ status: 200, body: { account: "tenant-3" } }));
    try {
      await expect(fetchMe(bad.url, "fixture-key", fetch)).rejects.toMatchObject({ kind: "shape" });
    } finally {
      await bad.close();
    }
  });
});

describe("config read/write", () => {
  test("absent config loads as null", () => {
    expect(loadConfig(home)).toBeNull();
  });
  test("corrupt config is a loud CliError, not a silent null", () => {
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(configPathFor(home), "{oops");
    expect(() => loadConfig(home)).toThrow(CliError);
  });
  test("config missing fields is a CliError", () => {
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(configPathFor(home), JSON.stringify({ account: "x" }));
    expect(() => loadConfig(home)).toThrow(CliError);
  });
  test("saveConfig writes mode 0600 and round-trips", () => {
    const cfg: CustomerConfig = {
      baseUrl: "https://example.dev",
      key: "k",
      account: "tenant-3",
      slug: "s",
      name: "n",
      permissions: ["mirror:read"],
      principal: "service",
      joinedAt: "2026-09-09T00:00:00Z",
      lastSkillBundleVersion: "0.1.0",
    };
    const path = saveConfig(home, cfg);
    expect(path).toBe(configPathFor(home));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadConfig(home)).toEqual(cfg);
  });
  test("Codex P1: rewriting an existing world-readable config re-applies 0600 (mode is not create-only)", () => {
    const path = configPathFor(home);
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(path, "{corrupt");
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    const written = writeConfig(home, seededConfig());
    expect(written.path).toBe(path);
    expect(written.mode).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(formatMode(written.mode)).toBe("0600");
  });
});

describe("changelog + Tier 2 notice", () => {
  test("parseChangelogEntry finds the entry, skips blanks, stops at the next heading", () => {
    const md = [
      "# Changelog",
      "",
      "## 0.2.0",
      "",
      "first line of 0.2.0",
      "second line",
      "## 0.1.0",
      "entry for 0.1.0",
    ].join("\n");
    expect(parseChangelogEntry(md, "0.2.0")).toBe("first line of 0.2.0");
    expect(parseChangelogEntry(md, "0.1.0")).toBe("entry for 0.1.0");
    expect(parseChangelogEntry(md, "9.9.9")).toBeNull();
  });
  test("the shipped CHANGELOG has an entry for the shipped version", () => {
    const version = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    expect(parseChangelogEntry(changelog, version)).toBeTruthy();
  });
  test("the notice line is ONE line with old version, new version, the entry, and the update command", () => {
    const line = updateNoticeLine("0.1.0", "0.2.0", "added cycles");
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("0.1.0");
    expect(line).toContain("0.2.0");
    expect(line).toContain("added cycles");
    expect(line).toContain(`npm update -g ${PACKAGE_NAME}`);
    expect(updateNoticeLine("0.1.0", "0.2.0", null)).toContain("see CHANGELOG.md");
  });
});

describe("installSkills", () => {
  test("installs all six customer skills, idempotently", () => {
    const target = join(home, "skills");
    const first = installSkills(target, {});
    expect(first.installed.sort()).toEqual([...CUSTOMER_SKILLS]);
    expect(first.skipped).toEqual([]);
    const second = installSkills(target, {});
    expect(second.installed.sort()).toEqual([...CUSTOMER_SKILLS]);
    expect(readFileSync(join(target, "concierge", "SKILL.md"), "utf8")).toContain(
      PROVENANCE_MARKER,
    );
  });
  test("a foreign skill dir is skipped without --force and replaced with it", () => {
    const target = join(home, "skills");
    mkdirSync(join(target, "concierge"), { recursive: true });
    writeFileSync(join(target, "concierge", "SKILL.md"), "---\nname: concierge\n---\nmine");
    const skipped = installSkills(target, {});
    expect(skipped.installed).not.toContain("concierge");
    expect(skipped.skipped).toEqual([{ name: "concierge", reason: "foreign-skill-dir" }]);
    expect(readFileSync(join(target, "concierge", "SKILL.md"), "utf8")).toContain("mine");
    const forced = installSkills(target, { force: true });
    expect(forced.installed).toContain("concierge");
    expect(readFileSync(join(target, "concierge", "SKILL.md"), "utf8")).toContain(
      PROVENANCE_MARKER,
    );
  });
});

describe("main — join", () => {
  test("happy path: discovers the tenant from the key, installs skills, writes 0600 config", async () => {
    const code = await main(["join", "--key", "fixture-key", "--base-url", server.url], ctx());
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toContain(`Joined ${FIXTURE_ME_BODY.name} (${FIXTURE_ME_BODY.slug})`);
    expect(out.join("\n")).toContain(FIXTURE_ME_BODY.account);
    expect(out.join("\n")).toContain("0.x");
    const cfg = readConfig();
    expect(cfg).toMatchObject({
      account: "tenant-3",
      slug: "hagale-technologies",
      baseUrl: server.url,
    });
    expect(cfg.key).toBe("fixture-key");
    expect(statSync(configPathFor(home)).mode & 0o777).toBe(0o600);
    for (const name of CUSTOMER_SKILLS) {
      expect(existsSync(join(defaultSkillsDirFor(home), name, "SKILL.md"))).toBe(true);
    }
  });
  test("key and base URL fall back to CATALYST_CLOUD_TOKEN / CATALYST_CLOUD_BASE_URL", async () => {
    const code = await main(
      ["join"],
      ctx({ env: { CATALYST_CLOUD_TOKEN: "fixture-key", CATALYST_CLOUD_BASE_URL: server.url } }),
    );
    expect(code).toBe(0);
    expect(readConfig().baseUrl).toBe(server.url);
  });
  test("no key anywhere is a usage error (exit 1), not a network call", async () => {
    const code = await main(["join", "--base-url", server.url], ctx());
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("CATALYST_CLOUD_TOKEN");
    expect(existsSync(configPathFor(home))).toBe(false);
  });
  test("a rejected key is exit 2 with a human-readable cause and no config", async () => {
    const code = await main(["join", "--key", "wrong-key", "--base-url", server.url], ctx());
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("credential not accepted");
    expect(err.join("\n")).not.toContain("wrong-key");
    expect(existsSync(configPathFor(home))).toBe(false);
  });
  test("join overwrites a corrupt config instead of refusing to repair it", async () => {
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(configPathFor(home), "{corrupt");
    const code = await main(["join", "--key", "fixture-key", "--base-url", server.url], ctx());
    expect(code).toBe(0);
    expect(readConfig().account).toBe("tenant-3");
  });
  test("Codex P1: repairing a 0644 corrupt config leaves it 0600 and the reported mode is the real one", async () => {
    const path = configPathFor(home);
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(path, "{corrupt");
    chmodSync(path, 0o644);
    const code = await main(["join", "--key", "fixture-key", "--base-url", server.url], ctx());
    expect(code).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const modeLine = out.find((l) => l.startsWith("Config written to"));
    expect(modeLine).toContain("(mode 0600,");
    expect(modeLine).not.toContain("chmod it by hand");
  });
  test("join records the skills dir it copied into, so a later update refreshes the same copies", async () => {
    const skillsDir = join(home, "elsewhere", "skills");
    const code = await main(
      ["join", "--key", "fixture-key", "--base-url", server.url, "--skills-dir", skillsDir],
      ctx(),
    );
    expect(code).toBe(0);
    expect(readConfig().skillsDir).toBe(skillsDir);
  });
});

describe("main — Tier 2 notice (a new version's next session)", () => {
  test("a stale stamp prints exactly one notice line and updates the stamp", async () => {
    saveConfig(home, seededConfig());
    let code = await main(["notice"], ctx());
    expect(code).toBe(0);
    const noticeLines = out.filter((l) => l.startsWith("[catalyst-skills] updated"));
    expect(noticeLines).toHaveLength(1);
    expect(noticeLines[0]).toContain(`npm update -g ${PACKAGE_NAME}`);
    expect(readConfig().lastSkillBundleVersion).not.toBe("0.0.9");
    out = [];
    code = await main(["notice"], ctx());
    expect(code).toBe(0);
    expect(out.filter((l) => l.startsWith("[catalyst-skills]"))).toHaveLength(0);
  });
  test("join after an update also prints the one-line notice", async () => {
    saveConfig(home, seededConfig({ baseUrl: server.url }));
    const code = await main(["join", "--key", "fixture-key", "--base-url", server.url], ctx());
    expect(code).toBe(0);
    expect(out.filter((l) => l.startsWith("[catalyst-skills] updated"))).toHaveLength(1);
    expect(readConfig().lastSkillBundleVersion).not.toBe("0.0.9");
  });
  test("notice with no config is silent and exit 0", async () => {
    const code = await main(["notice"], ctx());
    expect(code).toBe(0);
    expect(out).toEqual([]);
  });
});

describe("main — Codex P2: an update refreshes the copied skills before recording the new version", () => {
  const STALE =
    "---\nname: concierge\n---\n<!-- vendored-from: @catalyst-cloud/catalyst-skills -->\nSTALE COPY FROM 0.0.9\n";

  function seedStaleCopies(skillsDir: string): void {
    for (const name of CUSTOMER_SKILLS) {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(join(skillsDir, name, "SKILL.md"), STALE.replace("concierge", name));
    }
  }

  test("a stale stamp recopies every bundle-owned skill into the recorded skills dir, then stamps", async () => {
    const skillsDir = join(home, "recorded", "skills");
    seedStaleCopies(skillsDir);
    saveConfig(home, seededConfig({ skillsDir }));
    const code = await main(["notice"], ctx());
    expect(code).toBe(0);
    expect(err).toEqual([]);
    for (const name of CUSTOMER_SKILLS) {
      const md = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
      expect(md, `${name} must be the bundled copy after the update`).not.toContain("STALE COPY");
      expect(md).toContain(PROVENANCE_MARKER);
    }
    expect(out.filter((l) => l.startsWith("[catalyst-skills] refreshed"))).toHaveLength(1);
    expect(out.find((l) => l.startsWith("[catalyst-skills] refreshed"))).toContain(skillsDir);
    expect(readConfig().lastSkillBundleVersion).not.toBe("0.0.9");
  });

  test("a config without a recorded skills dir refreshes the default ~/.claude/skills", async () => {
    const skillsDir = defaultSkillsDirFor(home);
    seedStaleCopies(skillsDir);
    saveConfig(home, seededConfig());
    await main(["notice"], ctx());
    expect(readFileSync(join(skillsDir, "ask", "SKILL.md"), "utf8")).not.toContain("STALE COPY");
    expect(readConfig().skillsDir).toBe(skillsDir);
  });

  test("a customer-authored skill dir is left alone and named; the bundle-owned ones still refresh", async () => {
    const skillsDir = defaultSkillsDirFor(home);
    seedStaleCopies(skillsDir);
    writeFileSync(join(skillsDir, "steward", "SKILL.md"), "---\nname: steward\n---\nmine");
    saveConfig(home, seededConfig());
    const code = await main(["notice"], ctx());
    expect(code).toBe(0);
    expect(readFileSync(join(skillsDir, "steward", "SKILL.md"), "utf8")).toContain("mine");
    expect(readFileSync(join(skillsDir, "ask", "SKILL.md"), "utf8")).not.toContain("STALE COPY");
    expect(out.join("\n")).toContain('left "steward" alone');
    expect(readConfig().lastSkillBundleVersion).not.toBe("0.0.9");
  });

  test("a failed refresh keeps the OLD stamp so the next command retries, and names the install command", async () => {
    const skillsDir = join(home, "not-a-dir");
    writeFileSync(skillsDir, "a file where the skills dir should be");
    saveConfig(home, seededConfig({ skillsDir }));
    const code = await main(["notice"], ctx());
    expect(code).toBe(0);
    expect(readConfig().lastSkillBundleVersion).toBe("0.0.9");
    expect(err.join("\n")).toContain("catalyst-skills install");
    expect(out.filter((l) => l.startsWith("[catalyst-skills] refreshed"))).toHaveLength(0);
  });

  test("a config with no stamp at all (pre-notice install) refreshes once and stamps, printing no notice", async () => {
    const skillsDir = defaultSkillsDirFor(home);
    seedStaleCopies(skillsDir);
    saveConfig(home, seededConfig({ lastSkillBundleVersion: "" }));
    const code = await main(["status"], ctx());
    expect(code).toBe(0);
    expect(out.filter((l) => l.startsWith("[catalyst-skills] updated"))).toHaveLength(0);
    expect(readFileSync(join(skillsDir, "join", "SKILL.md"), "utf8")).not.toContain("STALE COPY");
    expect(readConfig().lastSkillBundleVersion).not.toBe("");
  });
});

describe("main — status / install / help / version", () => {
  test("status before join says how to join", async () => {
    const code = await main(["status"], ctx());
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`npx ${PACKAGE_NAME} join`);
  });
  test("status after join names the tenant and contract range", async () => {
    await main(["join", "--key", "fixture-key", "--base-url", server.url], ctx());
    out = [];
    const code = await main(["status"], ctx());
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(FIXTURE_ME_BODY.name);
    expect(out.join("\n")).toContain("0.x");
  });
  test("install places skills without touching config, and names a skipped foreign dir", async () => {
    const skillsDir = join(home, "claude-skills");
    mkdirSync(join(skillsDir, "concierge"), { recursive: true });
    writeFileSync(join(skillsDir, "concierge", "SKILL.md"), "mine");
    const code = await main(["install", "--skills-dir", skillsDir], ctx());
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Skills installed to");
    expect(out.join("\n")).toContain('Skipped "concierge"');
    expect(existsSync(configPathFor(home))).toBe(false);
  });
  test("join names a skipped foreign skill dir too", async () => {
    const skillsDir = join(home, "claude-skills");
    mkdirSync(join(skillsDir, "steward"), { recursive: true });
    writeFileSync(join(skillsDir, "steward", "SKILL.md"), "mine");
    const code = await main(
      ["join", "--key", "fixture-key", "--base-url", server.url, "--skills-dir", skillsDir],
      ctx(),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain('Skipped "steward"');
  });
  test("an empty --key value is a usage error, not an empty credential", async () => {
    const code = await main(["join", "--key", ""], ctx());
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("--key requires a value");
  });
  test("help prints usage, exit 0", async () => {
    const code = await main([], ctx());
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Usage:");
  });
  test("unknown command is exit 1 with usage on stderr", async () => {
    const code = await main(["frobnicate"], ctx());
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("unknown command");
  });
  test("version prints name, version and the contract range", async () => {
    const code = await main(["--version"], ctx());
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(PACKAGE_NAME);
    expect(out.join("\n")).toContain("0.x");
  });
});

describe("defaultCtx", () => {
  test("prefers CATALYST_SKILLS_HOME, then HOME, then /", () => {
    const saved = { ...process.env };
    try {
      process.env.CATALYST_SKILLS_HOME = "/a";
      process.env.HOME = "/b";
      expect(defaultCtx().home).toBe("/a");
      delete process.env.CATALYST_SKILLS_HOME;
      expect(defaultCtx().home).toBe("/b");
      delete process.env.HOME;
      expect(defaultCtx().home).toBe("/");
    } finally {
      process.env.CATALYST_SKILLS_HOME = saved.CATALYST_SKILLS_HOME;
      process.env.HOME = saved.HOME;
    }
  });
});
