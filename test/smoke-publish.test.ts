// smoke-publish.test.ts — the broken-publish gate: pack the REAL tarball (prepack builds dist),
// install it into a clean directory as npm would, and run the installed `login` against a fixture
// /me server with a redirected HOME. If any publish-facing seam breaks — prepack build, bin wiring,
// skills/ omitted from files, dist missing — this fails before npm publish can ship it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
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

// The installed CLI must run under the REAL node binary — never the bare string "node", which bun may
// alias to itself and which would then transpile the SDK's TypeScript dependencies for us and hide
// exactly the runtime seam this smoke exists to cover (the built-in node:sqlite engine, the
// type-stripping loader). `process.execPath` under vitest is node; it is resolved and printed.
const NODE = realpathSync(process.execPath);
if (!/node/.test(NODE)) throw new Error(`smoke needs a real node binary, got ${NODE}`);
console.log(`runtime: ${NODE} ${process.version}`);

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
  "a clean-directory install of the packed tarball connects against a fixture /me",
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

    const connected = await runAsync(
      NODE,
      [binPath, "login", "--key", "fixture-key", "--base-url", server.url],
      {
        env: { ...process.env, HOME: fakeHome, CATALYST_SKILLS_HOME: fakeHome },
      },
    );
    expect(connected.status, `login failed:\n${connected.stdout}\n${connected.stderr}`).toBe(0);
    expect(connected.stdout).toContain(`Connected to ${FIXTURE_ME_BODY.name} (${FIXTURE_ME_BODY.slug})`);
    expect(connected.stdout).toContain("Tenant contract 1.0.0 cached at");

    const configPath = join(fakeHome, ".config", "catalyst-cloud", "customer.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { account: string; key: string };
    expect(cfg.account).toBe(FIXTURE_ME_BODY.account);
    expect(cfg.key).toBe("fixture-key");

    // login installs nothing; the repair verb is what proves skills/ actually shipped in the
    // tarball, which is the publish-facing seam this test exists to catch.
    expect(existsSync(join(fakeHome, ".claude", "skills")), "login must copy no skills").toBe(false);
    const repaired = await runAsync(NODE, [binPath, "install"], {
      env: { ...process.env, HOME: fakeHome, CATALYST_SKILLS_HOME: fakeHome },
    });
    expect(repaired.status, `install failed:\n${repaired.stdout}\n${repaired.stderr}`).toBe(0);
    const placed = readdirSync(join(fakeHome, ".claude", "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(placed).toEqual([...CUSTOMER_SKILLS]);

    const status = await runAsync(NODE, [binPath, "status"], {
      env: { ...process.env, HOME: fakeHome, CATALYST_SKILLS_HOME: fakeHome },
    });
    expect(status.status).toBe(0);
    expect(status.stdout).toContain(FIXTURE_ME_BODY.name);

    // The SDK dependency actually shipped: contract --help exits 0 from the installed tarball, and
    // `ready` proves the SDK loads under plain node (the type-stripping loader over the TS-source
    // dependencies) and names the replica as absent rather than failing on it.
    const help = await runAsync(NODE, [binPath, "contract", "--help"], {
      env: { ...process.env, HOME: fakeHome, CATALYST_SKILLS_HOME: fakeHome },
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("--refresh");
    const ready = await runAsync(NODE, [binPath, "ready"], {
      env: { ...process.env, HOME: fakeHome, CATALYST_SKILLS_HOME: fakeHome },
    });
    expect(ready.stdout, ready.stderr).toMatch(/^ok {3}sdk: loads/m);
    expect(ready.stdout).toMatch(/^note {2}replica: absent/m);
    expect(ready.stdout.trim().split("\n").at(-1)).toBe("READY");
    expect(ready.status).toBe(0);
    const schema = await runAsync(NODE, [binPath, "replica", "schema"], {
      env: { ...process.env, HOME: fakeHome, CATALYST_SKILLS_HOME: fakeHome },
    });
    expect(schema.status).toBe(3);
  },
);
