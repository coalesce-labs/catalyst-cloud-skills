// skill-scripts-credential.test.ts — every skill's scripts run for a machine connected either way: a
// personal key, or the keyless login (an `auth` block and no `key`, the recommended rail since 0.4.0).
// Each case runs a real script of that skill as a `node` process against a home holding a
// customer.json and a stand-in CLI at the recorded cliPath, so what is under test is the script's
// own launcher (`scripts/lib/cli.mjs`), not a mock of it. The spawned CLI does the credential work
// itself (including refreshing a login's token); the launcher's only job is to see the machine is
// connected and spawn it.
//
// Plus the drift gate: the credential check lives in ONE file, `skill-lib/credential.mjs`, vendored
// byte-identical into every skill (`npm run skill-lib:sync`), and no launcher checks a credential
// field inline.
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CUSTOMER_SKILLS } from "../src/cli";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(pkgRoot, "skills");

/** One real script per skill, with arguments that reach the CLI. */
const CASES: Record<(typeof CUSTOMER_SKILLS)[number], { script: string; args: string[] }> = {
  "catalyst-github": { script: "read-pr.mjs", args: ["ENG-2"] },
  "catalyst-linear": { script: "read-ticket.mjs", args: ["ENG-2"] },
  "catalyst-setup": { script: "check.mjs", args: [] },
  "connect-me": { script: "verify-connection.mjs", args: [] },
  "how-catalyst-works": { script: "explain-ticket.mjs", args: ["ENG-2"] },
  "run-this-project": { script: "scope-status.mjs", args: ["--team", "ENG"] },
  unstick: { script: "unstick.mjs", args: ["ENG-2"] },
  "what-needs-me": { script: "inbox.mjs", args: [] },
  "whats-happening": { script: "explain.mjs", args: ["ENG-2"] },
};

const OAUTH = {
  kind: "oauth",
  accessToken: "access-fixture",
  refreshToken: "refresh-fixture",
  expiresAt: "2099-01-01T00:00:00Z",
  sessionId: "session-fixture",
};

/** A home with customer.json (the given credential fields) and a stand-in CLI that logs its argv. */
function connectedHome(credential: Record<string, unknown>): { home: string; calls: () => string[][] } {
  const home = mkdtempSync(join(tmpdir(), "skill-credential-"));
  const log = join(home, "calls.log");
  const cli = join(home, "fake-cli.mjs");
  writeFileSync(
    cli,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      'process.stdout.write("{}\\n");',
    ].join("\n"),
  );
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(
    join(home, ".config", "catalyst-cloud", "customer.json"),
    JSON.stringify({ baseUrl: "https://cloud.example", account: "tenant-fixture", cliPath: cli, ...credential }),
  );
  return {
    home,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[])
        : [],
  };
}

function runScript(skill: keyof typeof CASES, home: string) {
  const { script, args } = CASES[skill];
  return spawnSync(process.execPath, [join(skillsRoot, skill, "scripts", script), ...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, CATALYST_SKILLS_HOME: home, HOME: home },
  });
}

describe("every skill's scripts run for either credential", () => {
  test("positive control: the case table covers exactly the shipped skills", () => {
    expect(Object.keys(CASES).sort()).toEqual([...CUSTOMER_SKILLS]);
  });

  for (const skill of CUSTOMER_SKILLS) {
    test(`${skill}: a keyless login (auth block, no key) is connected and reaches the CLI`, () => {
      const { home, calls } = connectedHome({ auth: OAUTH });
      const r = runScript(skill, home);
      expect(r.stderr, `${skill} stderr`).not.toMatch(/not connected/i);
      expect(r.status, `${skill} exit (stderr: ${r.stderr})`).not.toBe(2);
      expect(calls().length, `${skill} never spawned the CLI`).toBeGreaterThan(0);
    });

    test(`${skill}: a personal key is connected and reaches the CLI (unchanged)`, () => {
      const { home, calls } = connectedHome({ key: "ctc_user_fixture" });
      const r = runScript(skill, home);
      expect(r.stderr).not.toMatch(/not connected/i);
      expect(r.status).not.toBe(2);
      expect(calls().length).toBeGreaterThan(0);
    });
  }

  // connect-me's verifier deliberately runs `status` even with no usable config (asking the CLI
  // whether it is connected IS its job), so it is not a launcher gate and has no negative case here.
  for (const skill of CUSTOMER_SKILLS.filter((s) => s !== "connect-me")) {
    test(`${skill}: a config holding neither credential is not connected — exit 2, the CLI never spawned`, () => {
      const { home, calls } = connectedHome({});
      const r = runScript(skill, home);
      expect(r.status).toBe(2);
      expect(calls()).toEqual([]);
    });
  }
});

describe("the credential check lives in one vendored file", () => {
  const canonicalPath = join(pkgRoot, "skill-lib", "credential.mjs");

  test("every skill carries scripts/lib/credential.mjs byte-identical to skill-lib/credential.mjs", () => {
    expect(existsSync(canonicalPath), "skill-lib/credential.mjs is the one source").toBe(true);
    const canonical = readFileSync(canonicalPath, "utf8");
    const dirs = readdirSync(skillsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    expect(dirs).toEqual([...CUSTOMER_SKILLS]);
    for (const skill of dirs) {
      const copy = join(skillsRoot, skill, "scripts", "lib", "credential.mjs");
      expect(existsSync(copy), `${skill} is missing scripts/lib/credential.mjs — run: npm run skill-lib:sync`).toBe(true);
      expect(readFileSync(copy, "utf8"), `${skill}'s copy drifted — run: npm run skill-lib:sync`).toBe(canonical);
    }
  });

  const INLINE_CHECK = /\.(key|auth)\s*!==|typeof\s+\w+(\?)?\.(key|auth)\b/;

  test("positive control: the inline-check matcher finds the shapes the launchers used to carry", () => {
    expect('typeof cfg.key !== "string"').toMatch(INLINE_CHECK);
    expect('typeof parsed.key !== "string"').toMatch(INLINE_CHECK);
    expect('typeof cfg?.auth === "object"').toMatch(INLINE_CHECK);
  });

  test("every launcher imports the shared check and checks no credential field inline", () => {
    for (const skill of CUSTOMER_SKILLS) {
      const lib = readFileSync(join(skillsRoot, skill, "scripts", "lib", "cli.mjs"), "utf8");
      expect(lib, `${skill} lib must import ./credential.mjs`).toMatch(/from\s+["']\.\/credential\.mjs["']/);
      expect(lib, `${skill} lib checks a credential inline`).not.toMatch(INLINE_CHECK);
    }
  });

  test("the sync script's --check agrees with the gate", () => {
    expect(existsSync(join(pkgRoot, "scripts", "sync-skill-lib.mjs"))).toBe(true);
    const r = spawnSync(process.execPath, [join(pkgRoot, "scripts", "sync-skill-lib.mjs"), "--check"], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
