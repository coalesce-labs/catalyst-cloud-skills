// onboard-script.test.ts — the onboarding report as a customer's agent runs it: a real `node`
// process, a connected home, and a stand-in CLI that answers each verb from a scenario. Holds that
// setup is not reported finished while no coding account is enrolled or no host is connected, and
// that each of those two parts names who fixes it and where, read off the CLI and the contract.
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "skills", "catalyst-onboard", "scripts", "where-am-i.mjs");

type Check = { id: string; state: string; reason?: string };

interface Scenario {
  accounts: unknown;
  hostsCurrent: Check | null;
  readinessStatus?: string;
}

const READINESS_CHECKS = [
  { id: "oauth_scope", severity: "blocking", needsAnswer: true, fixedBy: "owner_or_admin", fixedByLine: "A tenant owner or admin, in Catalyst settings." },
  { id: "hosts_current", severity: "degrading", needsAnswer: false, fixedBy: "host_operator", fixedByLine: "Whoever runs the Catalyst host that is behind." },
];

/** Linear connected, the GitHub App installed, one repository attached to one mapped project. */
function answers(s: Scenario): Record<string, unknown> {
  const checks: Check[] = [{ id: "oauth_scope", state: "pass" }];
  if (s.hostsCurrent) checks.push(s.hostsCurrent);
  return {
    "ready --json": { ready: true, checks: [{ id: "config", ok: true, line: "config: connected" }] },
    "me --json": { user: { label: "Pat Example", role: "owner", linearUserId: "lin-user-fixture" } },
    "contract --path account --json": { name: "Example Co", slug: "example", linearWorkspaceSlug: "example-ws" },
    "environment read --json": { current: null },
    "contract --path teams --json": [
      {
        key: "ENG",
        dispatchGate: { status: "open" },
        readiness: { status: s.readinessStatus ?? "degraded", checks: s.readinessStatus === "unchecked" ? [] : checks },
      },
    ],
    "contract --path merge.repositories --json": [{ owner: "example", name: "app" }],
    "contract --path readinessChecks --json": READINESS_CHECKS,
    "accounts --json": s.accounts,
  };
}

function connectedHome(s: Scenario): string {
  const home = mkdtempSync(join(tmpdir(), "onboard-script-"));
  const cli = join(home, "fake-cli.mjs");
  writeFileSync(
    cli,
    [
      `const answers = ${JSON.stringify(answers(s))};`,
      "const a = process.argv.slice(2).join(' ');",
      'if (a === "status") { console.log("Tenant: example\\nAPI: https://cloud.example (ok)"); process.exit(0); }',
      "if (a in answers) { console.log(JSON.stringify(answers[a])); process.exit(0); }",
      "process.stderr.write(`unknown verb: ${a}\\n`); process.exit(9);",
    ].join("\n"),
  );
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(
    join(home, ".config", "catalyst-cloud", "customer.json"),
    JSON.stringify({ baseUrl: "https://cloud.example", account: "tenant-fixture", cliPath: cli, key: "ctc_user_fixture" }),
  );
  return home;
}

function run(home: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, CATALYST_SKILLS_HOME: home, HOME: home },
  });
}

const NO_HOST: Check = { id: "hosts_current", state: "unknown", reason: "no_host_connected" };
const ENROLLED = [{ accountSlot: "slot-1", provider: "claude", status: "active" }];

describe("where-am-i.mjs: the two pieces a phase needs", () => {
  test("no coding account and no host: both are the remaining steps, each with who and where, and nothing says ready", () => {
    const home = connectedHome({ accounts: [], hostsCurrent: NO_HOST });

    const json = run(home, ["--json"]);
    expect(json.status, json.stderr).toBe(1);
    const doc = JSON.parse(json.stdout) as {
      parts: { part: string; verdict: string; owner: string | null; where: string | null }[];
      next: { part: string } | null;
      finished: boolean;
    };
    // positive control: the parts before these two are all finished, so these two are what is left
    const left = doc.parts.filter((p) => p.verdict !== "ok").map((p) => p.part);
    expect(left).toEqual(["coding accounts", "host"]);
    const accounts = doc.parts.find((p) => p.part === "coding accounts")!;
    expect(accounts.owner).toBe("a tenant owner or admin");
    expect(accounts.where).toBe("https://cloud.example/settings/coding-accounts");
    const host = doc.parts.find((p) => p.part === "host")!;
    expect(host.owner).toMatch(/host_operator/);
    expect(host.where).not.toBeNull();
    expect(doc.finished).toBe(false);
    expect(doc.next?.part).toBe("coding accounts");

    const report = run(home, []);
    expect(report.stdout).toMatch(/coding accounts {2}\[unfinished\]/);
    expect(report.stdout).toMatch(/host {2}\[unfinished\]/);
    expect(report.stdout).not.toMatch(/nothing left/);
    expect(run(home, ["--next"]).stdout).not.toMatch(/nothing left/);
  });

  test("an account enrolled but no host: the host alone is left, and it is still not finished", () => {
    const home = connectedHome({ accounts: ENROLLED, hostsCurrent: NO_HOST });
    const doc = JSON.parse(run(home, ["--json"]).stdout) as { parts: { part: string; verdict: string }[]; finished: boolean; next: { part: string } | null };
    expect(doc.parts.filter((p) => p.verdict !== "ok").map((p) => p.part)).toEqual(["host"]);
    expect(doc.finished).toBe(false);
    expect(doc.next?.part).toBe("host");
  });

  test("a project whose readiness was never checked leaves the host unread, never ok", () => {
    const home = connectedHome({ accounts: ENROLLED, hostsCurrent: null, readinessStatus: "unchecked" });
    const doc = JSON.parse(run(home, ["--json"]).stdout) as { parts: { part: string; verdict: string }[]; finished: boolean };
    expect(doc.parts.find((p) => p.part === "host")?.verdict).toBe("unreadable");
    expect(doc.finished).toBe(false);
  });

  test("an account that is only expired or revoked does not count as enrolled", () => {
    const home = connectedHome({ accounts: { accounts: [{ accountSlot: "slot-1", status: "expired-or-revoked" }] }, hostsCurrent: { id: "hosts_current", state: "pass" } });
    const doc = JSON.parse(run(home, ["--json"]).stdout) as { parts: { part: string; verdict: string }[] };
    expect(doc.parts.find((p) => p.part === "coding accounts")?.verdict).toBe("unfinished");
  });

  test("an enrolled account and a passing host check: setup is finished and the dispatch step is next", () => {
    const home = connectedHome({ accounts: ENROLLED, hostsCurrent: { id: "hosts_current", state: "pass" } });
    const json = run(home, ["--json"]);
    expect(json.status, json.stdout).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ finished: true, next: null });
    expect(run(home, ["--next"]).stdout).toMatch(/nothing left/);
  });
});
