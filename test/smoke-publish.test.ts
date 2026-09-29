// smoke-publish.test.ts — the broken-publish gate: pack the REAL tarball (prepack builds dist),
// install it into a clean directory as npm would, and run the installed `login` against a fixture
// /me server with a redirected HOME. If any publish-facing seam breaks — prepack build, bin wiring,
// skills/ omitted from files, dist missing — this fails before npm publish can ship it.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

    const binPath = join(installDir, "node_modules", "@catalyst-cloud", "cli", "bin", "catalyst.js");
    expect(existsSync(binPath)).toBe(true);
    // CTC-3479: the install puts both command names on the project's PATH.
    for (const name of ["catalyst", "catalyst-skills"]) {
      expect(existsSync(join(installDir, "node_modules", ".bin", name)), `node_modules/.bin/${name}`).toBe(true);
    }

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

// CTC-3479 — the two global installs a machine can have after the rename. The forwarder's real
// dependency is `@catalyst-cloud/cli@<same version>` from the registry, which does not exist until
// the release publishes it; so the copy installed here points that one dependency at the tarball
// packed above. Everything else (its bins, its launchers, the nested resolution) is the real package.
const forwarderRoot = join(pkgRoot, "packages", "catalyst-skills");
const manifestVersion = (JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version: string }).version;

async function deprecatedNameLine(): Promise<string> {
  const mod = (await import(pathToFileURL(join(pkgRoot, "bin", "launch.js")).href)) as { DEPRECATED_NAME_LINE: string };
  return mod.DEPRECATED_NAME_LINE;
}

function globalEnv(prefix: string, home: string): NodeJS.ProcessEnv {
  return { ...process.env, npm_config_prefix: prefix, HOME: home, CATALYST_SKILLS_HOME: home };
}

test(
  "a global install of @catalyst-cloud/cli puts catalyst and the deprecated catalyst-skills on PATH",
  { timeout: SMOKE_TIMEOUT },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "catalyst-cli-global-"));
    const prefix = join(scratch, "prefix");
    const home = join(scratch, "home");
    const env = globalEnv(prefix, home);
    const installed = await runAsync("npm", ["install", "-g", "--no-audit", "--no-fund", "--loglevel=error", tarball], { cwd: scratch, env });
    expect(installed.status, `global install failed:\n${installed.stdout}\n${installed.stderr}`).toBe(0);

    const catalyst = join(prefix, "bin", "catalyst");
    const legacy = join(prefix, "bin", "catalyst-skills");
    const version = await runAsync(catalyst, ["--version"], { cwd: scratch, env });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout).toContain(`@catalyst-cloud/cli ${manifestVersion}`);

    const ready = await runAsync(catalyst, ["ready"], { cwd: scratch, env });
    const legacyReady = await runAsync(legacy, ["ready"], { cwd: scratch, env });
    expect(ready.stdout).toMatch(/^ok {3}sdk: loads/m);
    expect(legacyReady.stdout).toBe(ready.stdout);
    expect(legacyReady.status).toBe(ready.status);
    expect(legacyReady.stderr.split("\n").filter((l) => l !== "")).toEqual([
      ...ready.stderr.split("\n").filter((l) => l !== ""),
      await deprecatedNameLine(),
    ]);
    // The hints name the package this machine has: installing the forwarder over it fails (EEXIST).
    const nested = (await import(pathToFileURL(join(prefix, "lib", "node_modules", "@catalyst-cloud", "cli", "dist", "config.js")).href)) as {
      updatePackageName: () => string;
    };
    expect(nested.updatePackageName()).toBe("@catalyst-cloud/cli");
    rmSync(scratch, { recursive: true, force: true });
  },
);

/** Pack the forwarder with its one dependency pointed at the CLI tarball packed above. */
function packForwarder(scratch: string): string {
  const src = join(scratch, "forwarder");
  cpSync(forwarderRoot, src, { recursive: true });
  const pkgPath = join(src, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies: Record<string, string> };
  expect(pkg.dependencies["@catalyst-cloud/cli"]).toBe(manifestVersion);
  pkg.dependencies["@catalyst-cloud/cli"] = `file:${tarball}`;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const packed = run("npm", ["pack", "--json", "--pack-destination", scratch], { cwd: src });
  expect(packed.status, `forwarder pack failed:\n${packed.stdout}\n${packed.stderr}`).toBe(0);
  return join(scratch, (JSON.parse(packed.stdout) as { filename: string }[])[0]!.filename);
}

test(
  "a daily `npm install -g @catalyst-cloud/catalyst-skills@latest` gets the same CLI release, under both names",
  { timeout: SMOKE_TIMEOUT },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "catalyst-forwarder-"));
    const prefix = join(scratch, "prefix");
    const home = join(scratch, "home");
    const env = globalEnv(prefix, home);

    const forwarderTarball = packForwarder(scratch);

    const installed = await runAsync("npm", ["install", "-g", "--no-audit", "--no-fund", "--loglevel=error", forwarderTarball], { cwd: scratch, env });
    expect(installed.status, `forwarder install failed:\n${installed.stdout}\n${installed.stderr}`).toBe(0);

    // Both names are links into the forwarder, which carries the CLI release one level down.
    const forwarderDir = join(prefix, "lib", "node_modules", "@catalyst-cloud", "catalyst-skills");
    for (const name of ["catalyst", "catalyst-skills"]) {
      const link = join(prefix, "bin", name);
      expect(lstatSync(link).isSymbolicLink(), `${name} must be an npm bin link`).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(forwarderDir, "bin", `${name}.js`)));
    }
    const nested = JSON.parse(readFileSync(join(forwarderDir, "node_modules", "@catalyst-cloud", "cli", "package.json"), "utf8")) as { name: string; version: string };
    expect(nested).toMatchObject({ name: "@catalyst-cloud/cli", version: manifestVersion });
    // The nested CLI's upgrade hints name the forwarder, the package this machine updates.
    const nestedConfig = (await import(pathToFileURL(join(forwarderDir, "node_modules", "@catalyst-cloud", "cli", "dist", "config.js")).href)) as {
      updatePackageName: () => string;
    };
    expect(nestedConfig.updatePackageName()).toBe("@catalyst-cloud/catalyst-skills");

    const primary = await runAsync(join(prefix, "bin", "catalyst"), ["--version"], { cwd: scratch, env });
    const legacy = await runAsync(join(prefix, "bin", "catalyst-skills"), ["--version"], { cwd: scratch, env });
    expect(primary.status, primary.stderr).toBe(0);
    expect(primary.stdout).toContain(`@catalyst-cloud/cli ${manifestVersion}`);
    expect(primary.stderr).toBe("");
    expect(legacy.status).toBe(0);
    expect(legacy.stdout).toBe(primary.stdout);
    expect(legacy.stderr.trim()).toBe(await deprecatedNameLine());
    rmSync(scratch, { recursive: true, force: true });
  },
);

// KNOWN CASE (CTC-3479 review, handed to CTC-3480): the forwarder ships a `catalyst` bin, as
// Scenario 3 requires. When the npm global bin directory already holds a `catalyst` that npm did
// not link for this package (a shim, another package's bin, an install-cli.sh bin dir that is also
// the npm prefix bin), npm refuses the whole install with EEXIST and the machine stays on its old
// release. This pins that behaviour so CTC-3480's installer handles it on purpose. The daily-install
// test above is the positive control: the same tarball into an empty prefix succeeds.
test(
  "KNOWN CASE: the forwarder install fails with EEXIST when another program owns catalyst in the npm bin dir",
  { timeout: SMOKE_TIMEOUT },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "catalyst-forwarder-eexist-"));
    const prefix = join(scratch, "prefix");
    const home = join(scratch, "home");
    const env = globalEnv(prefix, home);
    const forwarderTarball = packForwarder(scratch);

    mkdirSync(join(prefix, "bin"), { recursive: true });
    const foreign = join(prefix, "bin", "catalyst");
    writeFileSync(foreign, "#!/bin/sh\necho someone-else\n", { mode: 0o755 });

    const installed = await runAsync("npm", ["install", "-g", "--no-audit", "--no-fund", "--loglevel=error", forwarderTarball], { cwd: scratch, env });
    expect(installed.status, `expected npm to refuse:\n${installed.stdout}\n${installed.stderr}`).not.toBe(0);
    expect(installed.stdout + installed.stderr).toMatch(/EEXIST/);
    expect(readFileSync(foreign, "utf8")).toContain("someone-else");
    expect(existsSync(join(prefix, "bin", "catalyst-skills")), "npm installs nothing when it refuses").toBe(false);
    rmSync(scratch, { recursive: true, force: true });
  },
);
