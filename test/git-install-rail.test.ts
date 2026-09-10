// git-install-rail.test.ts — `npm install -g github:coalesce-labs/catalyst-cloud-skills#<ref>` must
// never leave a `catalyst-skills` on PATH that does not run.
//
// ⛔ THIS RAIL CANNOT BUILD, AND THAT IS A FACT ABOUT NPM, NOT ABOUT THIS PACKAGE. For a git
// dependency npm runs **`prepare`** in the clone and then packs; it does NOT run `prepack`. 0.2.0
// declared only `prepack`, so nothing built, the pack carried `skills/` and nothing else — no
// `bin/`, no `dist/` — and npm STILL EXITED 0 and STILL wrote a `catalyst-skills` symlink onto PATH
// pointing at a file that was not there. The customer got `catalyst-skills: no such file or
// directory` from an install that reported success. `test/smoke-publish.test.ts` stayed green
// throughout, because `npm pack` DOES run prepack.
//
// ⛔ AND `prepare` CANNOT FIX IT. Measured against npm 11.11.1: at `prepare` time the git clone has
// **no `node_modules` at all** — npm installs nothing before running it, so there is no `tsc` and no
// `@types/node` to build with. (A homebrew `tsc` on the operator's PATH makes this look like a
// missing-types problem instead of a missing-toolchain one; it is not.) The only ways to make the
// rail produce a CLI are committing `dist/` to git or fetching a compiler from inside a lifecycle
// script, and neither is worth it for a rail no document advertises — the README ships the plugin,
// `npx skills add` and the npm registry install, and none of them is this.
//
// So the property under test is the one that actually protects a customer: the install either
// yields a working CLI, or it FAILS LOUDLY AND LEAVES NOTHING. A success code over a broken shim is
// the defect. Declaring `prepare` is what buys that: it runs, it fails, npm aborts the install and
// unwinds it, and no shim is written.
//
// The repo is assembled here from the CURRENT WORKING TREE (tracked files, working-tree contents)
// and served over `git+file://`, so the test needs no network for the clone and covers the code in
// front of you rather than the last commit.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const RAIL_TIMEOUT = 300_000;

let scratch: string;
let repoDir: string;
let homeDir: string;

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", env });
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "catalyst-skills-rail-"));
  repoDir = join(scratch, "repo");
  homeDir = join(scratch, "home");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(homeDir, "npm-global"), { recursive: true });

  // Every tracked path, taken from the working tree — the shape a customer's `#<branch>` install sees.
  const listed = run("git", ["ls-files", "-z"], pkgRoot);
  expect(listed.status, listed.stderr).toBe(0);
  for (const rel of listed.stdout.split("\0").filter(Boolean)) {
    const dest = join(repoDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(pkgRoot, rel), dest);
  }
  expect(run("git", ["init", "-q", "-b", "main"], repoDir).status).toBe(0);
  run("git", ["config", "user.email", "rail@test.invalid"], repoDir);
  run("git", ["config", "user.name", "rail"], repoDir);
  expect(run("git", ["add", "-A"], repoDir).status).toBe(0);
  expect(run("git", ["commit", "-qm", "rail"], repoDir).status).toBe(0);
}, RAIL_TIMEOUT);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test(
  "a git install never leaves a catalyst-skills on PATH that does not run",
  { timeout: RAIL_TIMEOUT },
  () => {
    const installed = run(
      "npm",
      [
        "install",
        "-g",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        `git+file://${repoDir}#main`,
      ],
      scratch,
      { ...process.env, HOME: homeDir, npm_config_prefix: join(homeDir, "npm-global") },
    );

    const shim = join(homeDir, "npm-global", "bin", "catalyst-skills");
    const pkgDir = join(homeDir, "npm-global", "lib", "node_modules", "@catalyst-cloud", "catalyst-skills");

    if (installed.status === 0) {
      // If npm ever starts giving `prepare` a toolchain, the rail becomes real — and then it must be
      // real all the way down: the files the shim needs, and a shim that runs.
      expect(existsSync(join(pkgDir, "bin", "catalyst-skills.js")), "an install that succeeds must ship bin/").toBe(true);
      expect(existsSync(join(pkgDir, "dist", "cli.js")), "an install that succeeds must ship a built dist/").toBe(true);
      expect(existsSync(shim), "an install that succeeds must place the shim").toBe(true);
      const version = run(shim, ["--version"], scratch, { ...process.env, HOME: homeDir });
      expect(version.status, `the installed shim did not run:\n${version.stdout}\n${version.stderr}`).toBe(0);
      expect(version.stdout).toContain("@catalyst-cloud/catalyst-skills");
      return;
    }

    // ⛔ The failure this test exists for: exit 0 with a shim pointing at nothing. A non-zero exit is
    // fine — a customer sees it and stops — but only if PATH is left clean.
    expect(existsSync(shim), "a failed git install must leave no catalyst-skills on PATH").toBe(false);
    expect(existsSync(pkgDir), "a failed git install must leave no half-unpacked package").toBe(false);
  },
);

test("the README does not advertise the git rail it cannot serve", () => {
  // The doc half of the same decision: nobody re-adds `npm i -g github:…` to the install section
  // without first making the rail produce a CLI, which is what the test above would then hold them to.
  const readme = readFileSync(join(pkgRoot, "README.md"), "utf8");
  expect(readme).not.toMatch(/npm\s+install\s+-g\s+(github:|git\+)/);
});
