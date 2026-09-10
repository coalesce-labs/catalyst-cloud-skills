// smoke-publish.test.ts — CTC-1926's broken-publish gate: pack the REAL tarball (prepack builds
// dist), install it into a clean directory as npm would, and run the installed `join` against a
// fixture /me server with a redirected HOME. If any publish-facing seam breaks — prepack build,
// bin wiring, skills/ omitted from files, dist missing — this fails before npm publish can ship it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

import { CUSTOMER_SKILLS } from "../src/cli";
import { FIXTURE_ME_BODY, startMeFixture, type FixtureServer } from "./fixture";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const SMOKE_TIMEOUT = 240_000;

let tarball: string;
let packDir: string;
let server: FixtureServer;

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(cmd, args, {
    cwd: opts.cwd ?? pkgRoot,
    encoding: "utf8",
    env: opts.env ?? process.env,
  });
}

// Async on purpose: the fixture /me server lives in THIS process, so a spawnSync child would
// block the event loop that has to answer it (measured: join times out at its own 15s budget).
function runAsync(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? pkgRoot,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

beforeAll(async () => {
  server = await startMeFixture();
  packDir = mkdtempSync(join(tmpdir(), "catalyst-skills-pack-"));
  const packed = run("npm", ["pack", "--json", "--pack-destination", packDir]);
  expect(packed.status, `npm pack failed:\n${packed.stdout}\n${packed.stderr}`).toBe(0);
  const files = JSON.parse(packed.stdout) as { filename: string }[];
  expect(files.length).toBeGreaterThan(0);
  tarball = join(packDir, files[0]!.filename);
}, SMOKE_TIMEOUT);

afterAll(async () => {
  await server.close();
  if (packDir) rmSync(packDir, { recursive: true, force: true });
});

test(
  "a clean-directory install of the packed tarball joins against a fixture /me",
  { timeout: SMOKE_TIMEOUT },
  async () => {
    const installDir = mkdtempSync(join(tmpdir(), "catalyst-skills-clean-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "catalyst-skills-home-"));
    const installed = await runAsync(
      "npm",
      ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball],
      { cwd: installDir },
    );
    expect(
      installed.status,
      `clean install failed:\n${installed.stdout}\n${installed.stderr}`,
    ).toBe(0);

    const binPath = join(
      installDir,
      "node_modules",
      "@catalyst-cloud",
      "catalyst-skills",
      "bin",
      "catalyst-skills.js",
    );
    expect(existsSync(binPath)).toBe(true);

    const joined = await runAsync(
      "node",
      [binPath, "join", "--key", "fixture-key", "--base-url", server.url],
      {
        env: { ...process.env, HOME: fakeHome, CATALYST_SKILLS_HOME: fakeHome },
      },
    );
    expect(joined.status, `join failed:\n${joined.stdout}\n${joined.stderr}`).toBe(0);
    expect(joined.stdout).toContain(`Joined ${FIXTURE_ME_BODY.name} (${FIXTURE_ME_BODY.slug})`);

    const configPath = join(fakeHome, ".config", "catalyst-cloud", "customer.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { account: string; key: string };
    expect(cfg.account).toBe(FIXTURE_ME_BODY.account);
    expect(cfg.key).toBe("fixture-key");

    const placed = readdirSync(join(fakeHome, ".claude", "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(placed).toEqual([...CUSTOMER_SKILLS]);

    const status = await runAsync("node", [binPath, "status"], {
      env: { ...process.env, HOME: fakeHome, CATALYST_SKILLS_HOME: fakeHome },
    });
    expect(status.status).toBe(0);
    expect(status.stdout).toContain(FIXTURE_ME_BODY.name);
  },
);
