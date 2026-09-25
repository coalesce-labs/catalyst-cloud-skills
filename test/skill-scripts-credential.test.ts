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
  "catalyst-onboard": { script: "where-am-i.mjs", args: [] },
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
      'const args = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      'let out = "{}\\n";',
      'if (args[0] === "status") out = "Tenant: Fixture\\nAPI: https://cloud.example/api/v1\\n";',
      'else if (args[0] === "ready") out = JSON.stringify({ ready: true, checks: [] }) + "\\n";',
      'else if (args[0] === "me") out = JSON.stringify({ user: { id: "user-fixture", label: "Fixture", role: "member", linearUserId: "linear-fixture" } }) + "\\n";',
      'else if (args[0] === "connections") out = JSON.stringify({ outcome: "connected" }) + "\\n";',
      'else if (args[0] === "contract" && args[2] === "account") out = JSON.stringify({ name: "Fixture", slug: "fixture", linearWorkspaceSlug: "fixture" }) + "\\n";',
      'else if (args[0] === "contract" && args[2] === "teams") out = JSON.stringify([{ key: "ENG", dispatchGate: { status: "open" }, readiness: { status: "ready" } }]) + "\\n";',
      'else if (args[0] === "contract" && args[2] === "merge.repositories") out = JSON.stringify([{ owner: "coalesce-labs", name: "fixture" }]) + "\\n";',
      'else if (args[0] === "environment") out = JSON.stringify({ current: { revision: 1, canonicalHash: "fixture" }, isApproved: true, delivered: { revision: 1 }, unresolvedReferences: [] }) + "\\n";',
      'else if (args[0] === "replica" && args[1] === "status") out = JSON.stringify({ verdict: "absent", exitCode: 3, dbPath: "/tmp/replica.db", writerAlive: false }) + "\\n";',
      'else if (args[0] === "events" && args[1] === "status") out = JSON.stringify({ verdict: "absent", cursor: null, head: null, writerAlive: false, reasons: ["event cache cursor is absent"] }) + "\\n";',
      'process.stdout.write(out);',
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

  test("catalyst-onboard reports optional local freshness without making it block setup", () => {
    const { home, calls } = connectedHome({ auth: OAUTH });
    const script = join(skillsRoot, "catalyst-onboard", "scripts", "where-am-i.mjs");
    const r = spawnSync(process.execPath, [script, "--json"], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, CATALYST_SKILLS_HOME: home, HOME: home },
    });
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout) as {
      finished: boolean;
      localSync: { assessment: { verdict: string; reason: string } };
      parts: { part: string; lines: string[] }[];
    };
    expect(report.finished).toBe(true);
    expect(report.localSync.assessment.verdict).toBe("absent");
    expect(report.parts.find((part) => part.part === "machine")?.lines.join("\n")).toContain("note optional local sync absent");
    expect(calls()).toContainEqual(["replica", "status", "--probe", "--json"]);
    expect(calls()).toContainEqual(["events", "status", "--probe", "--json"]);
  });

  // Two skills deliberately run `status` even with no usable config, because asking the CLI whether
  // this machine is connected IS their job: connect-me's verifier, and catalyst-onboard's report,
  // whose first reading is the machine grain and whose FIRST STATE is "no credential here yet".
  // Neither is a launcher gate, so neither has a negative case; every other skill must still refuse.
  const REPORTS_NOT_CONNECTED = new Set(["connect-me", "catalyst-onboard"]);
  for (const skill of CUSTOMER_SKILLS.filter((s) => !REPORTS_NOT_CONNECTED.has(s))) {
    test(`${skill}: a config holding neither credential is not connected — exit 2, the CLI never spawned`, () => {
      const { home, calls } = connectedHome({});
      const r = runScript(skill, home);
      expect(r.status).toBe(2);
      expect(calls()).toEqual([]);
      // The not-connected line names the keyless login first, the personal-key form only as the alternative.
      expect(r.stderr).toContain(
        "run: npx @catalyst-cloud/catalyst-skills login (or, with a personal key: CATALYST_CLOUD_TOKEN=<your personal key> npx @catalyst-cloud/catalyst-skills login)",
      );
      expect(r.stderr).not.toMatch(/run: CATALYST_CLOUD_TOKEN=/);
    });
  }

  // Every connect instruction a person reads leads with the keyless login; the key form is the
  // alternative. Codex P2 (#11): read every supported spelling, not three literal strings — the npx
  // or the bare `catalyst-skills` command, any key placeholder, and `--key` — and compare ORDER
  // within the file: the first key-form login must come after the first keyless one.
  const LOGIN = String.raw`(?:npx\s+@catalyst-cloud\/catalyst-skills|\bcatalyst-skills)\s+login`;
  // A key placeholder may carry spaces (`<your personal key>`), so it is a bracketed run or a token.
  const KEY_VALUE = String.raw`(?:<[^>\n]*>|\S+)`;
  const KEY_FORM = new RegExp(String.raw`CATALYST_CLOUD_TOKEN=${KEY_VALUE}\s+${LOGIN}|${LOGIN}\s+--key\b`);
  const KEYLESS_FORM = new RegExp(String.raw`(?<!CATALYST_CLOUD_TOKEN=${KEY_VALUE}\s+(?:npx\s+@catalyst-cloud\/)?)${LOGIN}(?!\s+--key\b)`);

  function keyFirst(text: string): boolean {
    const key = text.search(KEY_FORM);
    if (key === -1) return false;
    const keyless = text.search(KEYLESS_FORM);
    return keyless === -1 || key < keyless;
  }

  test("positive control: the order check catches every key-first spelling and passes the keyless-first ones", () => {
    for (const bad of [
      "2  not connected to a tenant — run: CATALYST_CLOUD_TOKEN=<your personal key> npx @catalyst-cloud/catalyst-skills login",
      "the connect step, not a retry: `CATALYST_CLOUD_TOKEN=<your personal key> npx @catalyst-cloud/catalyst-skills login`",
      "```sh\nCATALYST_CLOUD_TOKEN=<your-personal-key> catalyst-skills login\n```\nor keyless: `catalyst-skills login`",
      "connect with `catalyst-skills login --key <your-personal-key>`, or `npx @catalyst-cloud/catalyst-skills login`",
    ]) {
      expect(keyFirst(bad), bad).toBe(true);
    }
    for (const good of [
      "run: npx @catalyst-cloud/catalyst-skills login (or, with a personal key: CATALYST_CLOUD_TOKEN=<your personal key> npx @catalyst-cloud/catalyst-skills login)",
      "`catalyst-skills login`, or with a key `CATALYST_CLOUD_TOKEN=<your-personal-key> catalyst-skills login`",
      "re-run login",
    ]) {
      expect(keyFirst(good), good).toBe(false);
    }
  });

  test("no skill file tells a person to connect with the key form first", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const files = walk(skillsRoot);
    // The check can see: several skill files do name a key-form login (keyless first).
    expect(files.filter((f) => KEY_FORM.test(readFileSync(f, "utf8"))).length).toBeGreaterThan(3);
    const offenders = files.filter((f) => keyFirst(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.slice(skillsRoot.length + 1))).toEqual([]);
  });
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
