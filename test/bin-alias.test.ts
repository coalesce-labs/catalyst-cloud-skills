// bin-alias.test.ts — CTC-3479. The package is @catalyst-cloud/cli and its command is `catalyst`.
// `catalyst-skills` stays as a deprecated second name: it prints ONE line on stderr that names
// `catalyst`, and otherwise behaves exactly like `catalyst` (same stdout, same exit code, same
// remaining stderr). On a pipe that line comes after the program's own stderr. The old package name keeps publishing as a thin forwarder, so a machine whose
// daily job still installs @catalyst-cloud/catalyst-skills@latest gets the same CLI release.
//
// The launchers are driven through a PIPE, the way every skill script spawns them.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

import { tempHome } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const forwarderRoot = join(pkgRoot, "packages", "catalyst-skills");

interface Manifest {
  name: string;
  version: string;
  bin: Record<string, string>;
  files?: string[];
  exports?: unknown;
  dependencies?: Record<string, string>;
  license?: string;
  publishConfig?: { access?: string };
  repository?: { url?: string };
}
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Manifest;
const manifest = readJson(join(pkgRoot, "package.json"));

function runPiped(bin: string, args: string[], home: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: pkgRoot,
      env: { ...process.env, HOME: home, CATALYST_SKILLS_HOME: home, CATALYST_SKILLS_OFFLINE: "1" },
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

const lines = (s: string) => s.split("\n").filter((l) => l !== "");

describe("the package is @catalyst-cloud/cli and its command is catalyst", () => {
  test("package.json names the new package and ships both bins", () => {
    expect(manifest.name).toBe("@catalyst-cloud/cli");
    expect(manifest.bin).toEqual({
      catalyst: "bin/catalyst.js",
      "catalyst-skills": "bin/catalyst-skills.js",
    });
    for (const file of Object.values(manifest.bin)) {
      expect(existsSync(join(pkgRoot, file)), `${file} must exist`).toBe(true);
      expect(readFileSync(join(pkgRoot, file), "utf8").startsWith("#!/usr/bin/env node\n"), `${file} needs a node shebang`).toBe(true);
    }
    expect(manifest.files).toContain("bin");
  });

  test("the package declares no exports map, so the forwarder can import its launchers by path", () => {
    // An `exports` field would make `@catalyst-cloud/cli/bin/catalyst.js` unresolvable from the
    // forwarder unless it listed that subpath too. Adding one is a forwarder change, not a free edit.
    expect(manifest.exports).toBeUndefined();
  });

  test("the deprecation line is one line and names catalyst", async () => {
    const { DEPRECATED_NAME_LINE } = (await import(pathToFileURL(join(pkgRoot, "bin", "launch.js")).href)) as { DEPRECATED_NAME_LINE: string };
    expect(DEPRECATED_NAME_LINE).not.toContain("\n");
    expect(DEPRECATED_NAME_LINE).toMatch(/deprecated/);
    expect(DEPRECATED_NAME_LINE).toMatch(/\bcatalyst\b(?!-)/);
    expect(DEPRECATED_NAME_LINE).not.toContain("—");
  });
});

describe("catalyst-skills behaves as catalyst, plus one deprecation line", () => {
  let DEPRECATED_NAME_LINE: string;
  beforeAll(async () => {
    // The launchers load dist/cli.js, so the compiled output must be current.
    const built = spawnSync("npm", ["run", "build"], { cwd: pkgRoot, encoding: "utf8" });
    expect(built.status, `build failed:\n${built.stdout}\n${built.stderr}`).toBe(0);
    ({ DEPRECATED_NAME_LINE } = (await import(pathToFileURL(join(pkgRoot, "bin", "launch.js")).href)) as { DEPRECATED_NAME_LINE: string });
  }, 120_000);

  const CASES: { name: string; args: string[] }[] = [
    { name: "--version", args: ["--version"] },
    { name: "ready (not connected, so it exits non-zero)", args: ["ready"] },
    { name: "a usage error", args: ["definitely-not-a-verb"] },
  ];

  for (const c of CASES) {
    test(`${c.name}: same stdout and exit code, one extra stderr line`, { timeout: 60_000 }, async () => {
      const home = tempHome();
      const primary = await runPiped(join(pkgRoot, "bin", "catalyst.js"), c.args, home);
      const alias = await runPiped(join(pkgRoot, "bin", "catalyst-skills.js"), c.args, home);

      expect(alias.stdout).toBe(primary.stdout);
      expect(alias.status).toBe(primary.status);
      // On a pipe the line comes LAST: skill scripts report the first stderr line as the error.
      expect(lines(alias.stderr)).toEqual([...lines(primary.stderr), DEPRECATED_NAME_LINE]);
      expect(primary.stderr, "catalyst itself must not print the deprecation line").not.toContain(DEPRECATED_NAME_LINE);
    });
  }

  test("a piped caller that reads the first stderr line still gets the real error", { timeout: 60_000 }, async () => {
    // where-am-i.mjs and its siblings do `(x.stderr || x.stdout).trim().split("\n")[0]` on failure.
    const r = await runPiped(join(pkgRoot, "bin", "catalyst-skills.js"), ["me"], tempHome());
    expect(r.status, `launcher stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(2);
    const first = r.stderr.trim().split("\n")[0];
    expect(first).toMatch(/not connected yet/);
    expect(lines(r.stderr)).toContain(DEPRECATED_NAME_LINE);
  });

  test("catalyst --version prints the package version", { timeout: 60_000 }, async () => {
    const r = await runPiped(join(pkgRoot, "bin", "catalyst.js"), ["--version"], tempHome());
    expect(r.status, `launcher stderr:\n${r.stderr}\nstdout:\n${r.stdout}`).toBe(0);
    expect(r.stdout).toContain(`@catalyst-cloud/cli ${manifest.version}`);
  });
});

describe("the @catalyst-cloud/catalyst-skills forwarder", () => {
  const forwarder = readJson(join(forwarderRoot, "package.json"));

  test("is the old name, at the same version, pinned to exactly that @catalyst-cloud/cli", () => {
    expect(forwarder.name).toBe("@catalyst-cloud/catalyst-skills");
    expect(forwarder.version).toBe(manifest.version);
    expect(forwarder.dependencies).toEqual({ "@catalyst-cloud/cli": manifest.version });
    expect(forwarder.publishConfig?.access).toBe("public");
    expect(forwarder.license).toBe("MIT");
    expect(forwarder.repository?.url).toBe((manifest.repository as { url?: string } | undefined)?.url);
  });

  test("exposes both command names, each forwarding to the same-named launcher in @catalyst-cloud/cli", () => {
    expect(forwarder.bin).toEqual({
      catalyst: "bin/catalyst.js",
      "catalyst-skills": "bin/catalyst-skills.js",
    });
    for (const [name, file] of Object.entries(forwarder.bin)) {
      const path = join(forwarderRoot, file);
      expect(existsSync(path), `${file} must exist`).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
      expect(text).toContain(`import "@catalyst-cloud/cli/bin/${name}.js";`);
      // The cli package must actually ship the file the forwarder imports.
      expect(manifest.bin[name]).toBe(`bin/${name}.js`);
    }
    // bin/catalyst-skills.js keeps its path: older logins recorded it in customer.json as cliPath.
    expect(forwarder.bin["catalyst-skills"]).toBe("bin/catalyst-skills.js");
  });

  test("ships only its launchers and README", () => {
    expect(forwarder.files).toEqual(["bin", "README.md"]);
    expect(existsSync(join(forwarderRoot, "README.md"))).toBe(true);
  });
});

describe("npm run version:sync keeps the forwarder on the package's version", () => {
  function scratchTree(forwarder: { version: string; dependencies: Record<string, string> }): string {
    const root = mkdtempSync(join(tmpdir(), "catalyst-forwarder-sync-"));
    for (const dir of ["scripts", ".claude-plugin", "skills", join("packages", "catalyst-skills")]) mkdirSync(join(root, dir), { recursive: true });
    copyFileSync(join(pkgRoot, "scripts", "sync-plugin-version.mjs"), join(root, "scripts", "sync-plugin-version.mjs"));
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "@catalyst-cloud/cli", version: "9.9.9" })}\n`);
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), `${JSON.stringify({ version: "9.9.9" })}\n`);
    writeFileSync(join(root, "packages", "catalyst-skills", "package.json"), `${JSON.stringify({ name: "@catalyst-cloud/catalyst-skills", ...forwarder })}\n`);
    return root;
  }
  const sync = (root: string, args: string[] = []) =>
    spawnSync(process.execPath, [join(root, "scripts", "sync-plugin-version.mjs"), ...args], { encoding: "utf8" });

  test("--check fails when the forwarder's version or pin drifts, and a sync fixes both", () => {
    const root = scratchTree({ version: "9.9.8", dependencies: { "@catalyst-cloud/cli": "9.9.8" } });
    const checked = sync(root, ["--check"]);
    expect(checked.status, checked.stdout + checked.stderr).toBe(1);
    expect(checked.stderr).toContain("packages/catalyst-skills");

    expect(sync(root).status).toBe(0);
    const synced = readJson(join(root, "packages", "catalyst-skills", "package.json"));
    expect(synced.version).toBe("9.9.9");
    expect(synced.dependencies).toEqual({ "@catalyst-cloud/cli": "9.9.9" });
    expect(sync(root, ["--check"]).status).toBe(0);
  });

  test("--check passes when the forwarder already matches (the positive control for the test above)", () => {
    const root = scratchTree({ version: "9.9.9", dependencies: { "@catalyst-cloud/cli": "9.9.9" } });
    const checked = sync(root, ["--check"]);
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  });
});
