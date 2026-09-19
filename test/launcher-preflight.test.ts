// launcher-preflight.test.ts — CTC-2158. The launcher's preflight is the ONLY code that runs on a
// runtime too old to load dist/cli.js, so it is tested by spawning the real bin, not by importing
// anything. `CATALYST_SKILLS_RUNTIME_FACTS` is the test-only injection seam that lets these tests
// drive an unsupported/supported runtime without installing one for real.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { tempHome } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const BIN = join(pkgRoot, "bin", "catalyst-skills.js");

beforeAll(() => {
  const built = spawnSync("npm", ["run", "build"], { cwd: pkgRoot, encoding: "utf8" });
  expect(built.status, `build failed:\n${built.stdout}\n${built.stderr}`).toBe(0);
  expect(existsSync(join(pkgRoot, "dist", "cli.js"))).toBe(true);
}, 120_000);

function spawnBin(args: string[], env: Record<string, string> = {}, home = tempHome()): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: pkgRoot,
      env: { ...process.env, HOME: home, CATALYST_SKILLS_HOME: home, ...env },
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

/** Write a fake pinned "node" that echoes its argv and exits with a chosen code — enough to prove
 *  the launcher re-execs, forwards argv, and forwards the exit code, without a real Node download. */
function installFakePin(home: string, exitCode = 7): void {
  const dir = join(home, ".cache", "catalyst-cloud", "catalyst-skills", "runtimes", "fakebin");
  mkdirSync(dir, { recursive: true });
  const nodePath = join(dir, "node");
  writeFileSync(
    nodePath,
    `#!/usr/bin/env node\nconsole.log("PINNED " + JSON.stringify(process.argv.slice(2)));\nprocess.exit(${exitCode});\n`,
  );
  chmodSync(nodePath, 0o755);
  writeFileSync(
    join(home, ".cache", "catalyst-cloud", "catalyst-skills", "runtimes", "pin.json"),
    JSON.stringify({ version: "24.21.0", nodePath }),
  );
}

test("an unsupported ambient runtime with no pin prints the named reason and the ONE command, on stderr, exit 1", async () => {
  const r = await spawnBin(["ready"], { CATALYST_SKILLS_RUNTIME_FACTS: JSON.stringify({ kind: "bun", version: "1.3.14", nodeCompat: "24.3.0" }) });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/bun 1\.3\.14/);
  expect(r.stderr).toMatch(/node:sqlite/);
  expect(r.stderr).toContain("runtime install");
  expect(r.stderr).not.toMatch(/ResolveMessage/);
});

test("`runtime install` is exempt from the preflight — the fix command must run on the broken runtime", async () => {
  const r = await spawnBin(["runtime", "--help"], { CATALYST_SKILLS_RUNTIME_FACTS: JSON.stringify({ kind: "bun", version: "1.3.14", nodeCompat: "24.3.0" }) });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("status");
});

test("an unsupported ambient runtime WITH a pin re-execs into the pinned node and forwards its exit code and argv", async () => {
  const home = tempHome();
  installFakePin(home, 7);
  const r = await spawnBin(["ready", "--json"], { CATALYST_SKILLS_RUNTIME_FACTS: JSON.stringify({ kind: "node", version: "22.14.0", nodeCompat: "22.14.0" }) }, home);
  expect(r.status).toBe(7);
  // The fake "node" is itself a shebang script, not a real interpreter, so its own argv[0]/argv[1]
  // carry one extra layer of indirection than a real `node <script> <args>` would — what matters is
  // that the forwarded args arrived intact and in order.
  expect(r.stdout).toContain('"ready","--json"]');
});

test("a supported ambient runtime with no pin runs IN PROCESS — no re-exec, no extra process", async () => {
  const r = await spawnBin(["--version"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("@catalyst-cloud/catalyst-skills");
  expect(r.stderr).toBe("");
});

test("CATALYST_SKILLS_RUNTIME=ambient forces the in-process path even with a pin present", async () => {
  const home = tempHome();
  installFakePin(home, 7);
  const r = await spawnBin(["--version"], { CATALYST_SKILLS_RUNTIME: "ambient" }, home);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("@catalyst-cloud/catalyst-skills");
  expect(r.stdout).not.toContain("PINNED");
});

test("CATALYST_SKILLS_RUNTIME=pinned with no pin installed fails with the one command, not silently", async () => {
  const r = await spawnBin(["ready"], { CATALYST_SKILLS_RUNTIME: "pinned" });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("runtime install");
});
