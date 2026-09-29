import { afterEach, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { replicaDbPath } from "../src/config.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function setup() { const home = mkdtempSync(join(tmpdir(), "replica-paths-")); homes.push(home); return home; }
function manifest(home: string, replicaDb?: string) {
  const file = join(home, ".config/catalyst/paths.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, paths: {
    repoRoot: `${home}/repos`, worktrees: `${home}/wt`, logs: `${home}/logs`, events: `${home}/events`,
    config: `${home}/.config/catalyst-cloud`, cache: `${home}/cache`, state: `${home}/state`, skills: `${home}/skills`,
    ...(replicaDb ? { replicaDb } : {}),
  }, provenance: {} }));
  return file;
}

test("writer and reader select the declared replica instead of a legacy login default", () => {
  const home = setup();
  manifest(home, `${home}/state/replica/replica.db`);
  expect(replicaDbPath({ replicaDb: `${home}/.config/catalyst-cloud/replica.db` }, home, {})).toBe(`${home}/state/replica/replica.db`);
});

test("an optional replica omitted from the machine record reports not configured", async () => {
  const home = setup();
  manifest(home);
  const { replicaStatus } = await import("../src/replica.js");
  const { makeCtx } = await import("./helpers.js");
  const cfg = { baseUrl: "https://example.test", account: "test", slug: "test", name: "Test", permissions: null, principal: "service" as const, joinedAt: "2026-09-24", lastSkillBundleVersion: "1" };
  expect(replicaStatus(makeCtx(home), cfg)).toMatchObject({ verdict: "not-configured", dbPath: null });
});

test("a broken machine manifest symlink cannot silently start a fresh legacy database", async () => {
  const home = setup();
  const { symlinkSync } = await import("node:fs");
  const file = join(home, ".config/catalyst/paths.json");
  mkdirSync(dirname(file), { recursive: true });
  symlinkSync(`${home}/missing.json`, file);
  expect(() => replicaDbPath({}, home, {})).toThrow();
});

test("environment overrides manifest and invalid declared paths fail closed", () => {
  const home = setup();
  const file = manifest(home, `${home}/selected.db`);
  expect(replicaDbPath({}, home, { CATALYST_REPLICA_DB: `${home}/override.db` })).toBe(`${home}/override.db`);
  expect(() => replicaDbPath({}, home, { CATALYST_REPLICA_DB: "relative.db" })).toThrow(/absolute/);
  writeFileSync(file, '{"version":2}');
  expect(() => replicaDbPath({}, home, {})).toThrow(/version/);
  expect(() => replicaDbPath({}, home, { CATALYST_PATHS_FILE: `${home}/missing.json` })).toThrow();
});

test("adopting a legacy replica retains its saved cursor and observes replacement locks", async () => {
  const home = setup();
  const { DatabaseSync } = await import("node:sqlite");
  const { unlinkSync } = await import("node:fs");
  const { replicaStatus } = await import("../src/replica.js");
  const { makeCtx } = await import("./helpers.js");
  const path = `${home}/.config/catalyst-cloud/replica.db`;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE sync_meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO sync_meta VALUES('cursor','87654321')");
  db.close();
  manifest(home, path);
  const cfg = { baseUrl: "https://example.test", account: "test", slug: "test", name: "Test", permissions: null, principal: "service" as const, joinedAt: "2026-09-24", lastSkillBundleVersion: "1" };
  writeFileSync(`${path}.writer.lock`, JSON.stringify({ pid: process.pid, heartbeat: 0 }));
  expect(replicaStatus(makeCtx(home), cfg).verdict).toBe("stale");
  unlinkSync(`${path}.writer.lock`);
  writeFileSync(`${path}.writer.lock`, JSON.stringify({ pid: process.pid, heartbeat: Date.now() }));
  expect(replicaStatus(makeCtx(home), cfg)).toMatchObject({ verdict: "fresh", dbPath: path, cursor: 87654321 });
});

test("the canonical skills directory variable leaves a saved login connected", async () => {
  const home = setup();
  const { defaultCtx, loadConfig, saveConfig } = await import("../src/config.js");
  const before = { HOME: process.env.HOME, CATALYST_SKILLS_HOME: process.env.CATALYST_SKILLS_HOME, CATALYST_SKILLS_DIR: process.env.CATALYST_SKILLS_DIR };
  try {
    process.env.HOME = home;
    delete process.env.CATALYST_SKILLS_HOME;
    process.env.CATALYST_SKILLS_DIR = `${home}/.local/share/catalyst`;
    saveConfig(home, { baseUrl: "https://example.test", key: "fixture", account: "existing", slug: "test", name: "Test", permissions: null, principal: "service", joinedAt: "2026-09-24", lastSkillBundleVersion: "1" });
    expect(loadConfig(defaultCtx().home)?.account).toBe("existing");
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("the vendored canonical runtime matches its pinned generation hashes", async () => {
  const { execFileSync } = await import("node:child_process");
  expect(() => execFileSync(process.execPath, ["scripts/vendor-paths.mjs", "--check"])).not.toThrow();
});
