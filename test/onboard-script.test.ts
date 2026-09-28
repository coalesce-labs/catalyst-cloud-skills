// onboard-script.test.ts — the onboarding report as a customer's agent runs it: a real `node`
// process, a connected home, and a stand-in CLI that answers each verb from a scenario. Holds that
// setup is not reported finished while no coding account is enrolled or no host is connected, and
// that each of those two parts names who fixes it and where, read off the CLI and the contract.
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "skills", "catalyst-onboard", "scripts", "where-am-i.mjs");

type Check = { id: string; state: string; reason?: string };

interface Scenario {
  /** `accounts --json`. Read on an older cloud whose contract has no `codingAccounts`, and to check
   *  each account's credential when the contract says `enrolled`. Omitted beside a contract
   *  `codingAccounts`, it answers with HEALTHY_ACCOUNTS. `accountsFail` makes the verb fail. */
  accounts?: unknown;
  accountsFail?: boolean;
  /** What the stand-in `gh` says about `<owner>/thoughts`; "absent" takes gh off PATH entirely. */
  thoughts?: "exists" | "missing" | "absent";
  /** The contract's `codingAccounts`; omitted is an older cloud. */
  codingAccounts?: unknown;
  hostsCurrent: Check | null;
  readinessStatus?: string;
  hostFixedWhere?: { page: string; command: string | null } | null;
}

const ENROLLER = "A tenant owner or admin, in Catalyst settings.";
function codingAccounts(state: string, activeCount: number | null, line: string) {
  return { state, activeCount, line, enrolledBy: "owner_or_admin", enrolledByLine: ENROLLER, page: "/settings/coding-accounts" };
}
const NONE_ENROLLED = codingAccounts("none_enrolled", 0, "No coding account is enrolled for this tenant.");
const INACTIVE = codingAccounts("inactive", 0, "This tenant's coding accounts are enrolled but out of rotation, so none is active.");
const UNREAD = codingAccounts("unread", null, "Whether this tenant has a coding account enrolled could not be read.");
const CA_ENROLLED = codingAccounts("enrolled", 1, "At least one coding account is enrolled and active for this tenant.");
const HEALTHY_ACCOUNTS = {
  accounts: [
    { accountSlot: "claude-1", provider: "claude", status: "active", quarantined: false, quarantineReason: null },
    { accountSlot: "codex-1", provider: "codex", status: "attested", quarantined: false, quarantineReason: null },
  ],
  observedAtMs: 1_756_100_000_000,
};

function readinessChecks(hostFixedWhere: Scenario["hostFixedWhere"]) {
  return [
    { id: "oauth_scope", severity: "blocking", needsAnswer: true, fixedBy: "owner_or_admin", fixedByLine: "A tenant owner or admin, in Catalyst settings." },
    {
      id: "hosts_current",
      severity: "degrading",
      needsAnswer: false,
      fixedBy: "host_operator",
      fixedByLine: "Whoever runs the Catalyst host that is behind.",
      ...(hostFixedWhere === undefined ? {} : { fixedWhere: hostFixedWhere }),
    },
  ];
}

/** Linear connected, the GitHub App installed, one repository attached to one mapped project. */
function answers(s: Scenario): Record<string, unknown> {
  const checks: Check[] = [{ id: "oauth_scope", state: "pass" }];
  if (s.hostsCurrent) checks.push(s.hostsCurrent);
  return {
    "ready --json": { ready: true, checks: [{ id: "config", ok: true, line: "config: connected" }] },
    "me --json": { user: { label: "Pat Example", role: "owner", linearUserId: "lin-user-fixture" } },
    // CTC-3212 — both personal grants connected, so the person part is finished in these scenarios.
    "connections personal linear status --json": { outcome: "connected", status: 200 },
    "connections personal github status --json": { outcome: "connected", status: 200 },
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
    "contract --path readinessChecks --json": readinessChecks(s.hostFixedWhere),
    ...(s.accountsFail
      ? {}
      : s.accounts !== undefined
        ? { "accounts --json": s.accounts }
        : s.codingAccounts !== undefined
          ? { "accounts --json": HEALTHY_ACCOUNTS }
          : {}),
    ...(s.codingAccounts === undefined ? {} : { "contract --path codingAccounts --json": s.codingAccounts }),
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
      // what the real CLI prints when the cached contract lacks the path (an older cloud)
      'if (a.startsWith("contract --path ")) { process.stderr.write(`contract: 1.22.0 from cache\\nthe contract has nothing at "${a.split(" ")[2]}"\\n`); process.exit(2); }',
      "process.stderr.write(`unknown verb: ${a}\\n`); process.exit(9);",
    ].join("\n"),
  );
  // A stand-in `gh`, so the thoughts note never reaches the real GitHub from a test.
  const bin = join(home, "bin");
  mkdirSync(bin);
  if (s.thoughts !== "absent") {
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      s.thoughts === "exists"
        ? `#!/bin/sh\necho '{"name":"thoughts"}'\n`
        : `#!/bin/sh\necho "GraphQL: Could not resolve to a Repository with the name '$3'." >&2\nexit 1\n`,
    );
    chmodSync(gh, 0o755);
  }
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
    // Only the stand-in `gh` is on PATH; the script and the stand-in CLI run on this node by path.
    env: { ...process.env, CATALYST_SKILLS_HOME: home, HOME: home, PATH: join(home, "bin") },
  });
}

const NO_HOST: Check = { id: "hosts_current", state: "unknown", reason: "no_host_connected" };
const ENROLLED = [{ accountSlot: "slot-1", provider: "claude", status: "active" }];

type Part = { part: string; verdict: string; lines: string[]; owner: string | null; where: string | null };
type Doc = { parts: Part[]; next: { part: string; action: string; owner: string | null; where: string | null } | null; finished: boolean };
const json = (home: string) => JSON.parse(run(home, ["--json"]).stdout) as Doc;
const part = (doc: Doc, name: string) => doc.parts.find((p) => p.part === name)!;
const PASS: Check = { id: "hosts_current", state: "pass" };

describe("where-am-i.mjs: the two pieces a phase needs", () => {
  test("no coding account and no host: both are the remaining steps, and nothing says ready", () => {
    const home = connectedHome({ codingAccounts: NONE_ENROLLED, hostsCurrent: NO_HOST });

    const out = run(home, ["--json"]);
    expect(out.status, out.stderr).toBe(1);
    const doc = JSON.parse(out.stdout) as Doc;
    // positive control: the parts before these two are all finished, so these two are what is left
    expect(doc.parts.filter((p) => p.verdict !== "ok").map((p) => p.part)).toEqual(["coding accounts", "host"]);
    expect(doc.finished).toBe(false);
    expect(doc.next?.part).toBe("coding accounts");

    const report = run(home, []);
    expect(report.stdout).toMatch(/coding accounts {2}\[unfinished\]/);
    expect(report.stdout).toMatch(/host {2}\[unfinished\]/);
    expect(report.stdout).not.toMatch(/nothing left/);
    expect(run(home, ["--next"]).stdout).not.toMatch(/nothing left/);
  });

  test("an account enrolled but no host: the host alone is left, and it is still not finished", () => {
    const doc = json(connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: NO_HOST }));
    expect(doc.parts.filter((p) => p.verdict !== "ok").map((p) => p.part)).toEqual(["host"]);
    expect(doc.finished).toBe(false);
    expect(doc.next?.part).toBe("host");
  });

  test("a project whose readiness was never checked leaves the host unread, never ok", () => {
    const doc = json(connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: null, readinessStatus: "unchecked" }));
    expect(part(doc, "host").verdict).toBe("unreadable");
    expect(doc.finished).toBe(false);
  });

  test("an enrolled account and a passing host check: setup is finished and the dispatch step is next", () => {
    const home = connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: PASS });
    const out = run(home, ["--json"]);
    expect(out.status, out.stdout).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ finished: true, next: null });
    expect(run(home, ["--next"]).stdout).toMatch(/nothing left/);
  });
});

describe("where-am-i.mjs: the coding account is read from the contract", () => {
  test("none_enrolled: prints the contract's line and page, and names the enroller the contract gives", () => {
    const home = connectedHome({ codingAccounts: NONE_ENROLLED, hostsCurrent: PASS });
    const accounts = part(json(home), "coding accounts");
    expect(accounts.verdict).toBe("unfinished");
    expect(accounts.lines).toContain(NONE_ENROLLED.line);
    expect(accounts.owner).toBe(ENROLLER);
    expect(accounts.where).toBe("https://cloud.example/settings/coding-accounts");
    const report = run(home, []).stdout;
    expect(report).toContain(NONE_ENROLLED.line);
    expect(report).toContain(`who: ${ENROLLER}`);
    expect(report).toContain("where: https://cloud.example/settings/coding-accounts");
  });

  test("the page and the enroller come from the contract, not from a fixed pattern", () => {
    const moved = { ...NONE_ENROLLED, page: "/settings/ai-accounts", enrolledByLine: "Someone else entirely." };
    const accounts = part(json(connectedHome({ codingAccounts: moved, hostsCurrent: PASS })), "coding accounts");
    expect(accounts.where).toBe("https://cloud.example/settings/ai-accounts");
    expect(accounts.owner).toBe("Someone else entirely.");
  });

  test("inactive: says the account is out of rotation and should be reactivated, never to enroll another", () => {
    const home = connectedHome({ codingAccounts: INACTIVE, hostsCurrent: PASS });
    const doc = json(home);
    expect(part(doc, "coding accounts").verdict).toBe("unfinished");
    expect(doc.next?.action).toMatch(/reactivate/i);
    const report = run(home, []).stdout;
    const next = run(home, ["--next"]).stdout;
    expect(report).toMatch(/out of rotation/);
    expect(next).toMatch(/reactivate/i);
    // the one mention of enrolling is the instruction not to
    expect(report).toContain("Do not enroll another account.");
    const ENROL_ONE = /enrol+ (a|an|one|another)\b/i;
    const withoutNegations = (t: string) => t.replaceAll("Do not enroll another account.", "").replaceAll("do not enroll another one", "");
    expect(withoutNegations(report)).not.toMatch(ENROL_ONE);
    expect(withoutNegations(next)).not.toMatch(ENROL_ONE);
  });

  test("unread: says it could not be read, and does not tell them to enroll one", () => {
    const home = connectedHome({ codingAccounts: UNREAD, hostsCurrent: PASS });
    const doc = json(home);
    const accounts = part(doc, "coding accounts");
    expect(accounts.verdict).toBe("unreadable");
    expect(accounts.lines).toContain(UNREAD.line);
    expect(accounts.where).toBeNull();
    expect(doc.finished).toBe(false);
    const next = run(home, ["--next"]).stdout;
    expect(next).toMatch(/could not read/);
    const report = run(home, []).stdout;
    expect(report).toContain("Do not enroll one on this reading.");
    for (const text of [next, report.replace("Do not enroll one on this reading.", "")]) expect(text).not.toMatch(/enrol+ (a|an|one)\b/i);
  });

  test("an older contract with no codingAccounts: falls back to the account list and says the cloud is older", () => {
    const home = connectedHome({ accounts: [], hostsCurrent: PASS });
    const accounts = part(json(home), "coding accounts");
    expect(accounts.verdict).toBe("unfinished");
    expect(accounts.lines[0]).toMatch(/cloud is older than the bundle/);
    expect(accounts.lines).toContain("0 enrolled, 0 able to take work");
    expect(accounts.owner).toBe("a tenant owner or admin");
    expect(accounts.where).toBe("https://cloud.example/settings/coding-accounts");
  });

  test("an older contract: an account that is only expired or revoked does not count as enrolled", () => {
    const home = connectedHome({ accounts: { accounts: [{ accountSlot: "slot-1", status: "expired-or-revoked" }] }, hostsCurrent: PASS });
    expect(part(json(home), "coding accounts").verdict).toBe("unfinished");
  });

  test("an older contract with an enrolled account still finishes", () => {
    const home = connectedHome({ accounts: ENROLLED, hostsCurrent: PASS });
    expect(json(home)).toMatchObject({ finished: true });
  });
});

describe("where-am-i.mjs: the host names where only when the contract does", () => {
  test("fixedWhere null: the owner sentence alone, no page and no invented step", () => {
    const home = connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: NO_HOST, hostFixedWhere: null });
    const host = part(json(home), "host");
    expect(host.owner).toMatch(/host_operator/);
    expect(host.where).toBeNull();
    expect(run(home, []).stdout).not.toMatch(/^ {2}(where|do): /m);
  });

  test("fixedWhere absent (an older cloud) reads the same as null", () => {
    const host = part(json(connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: NO_HOST })), "host");
    expect(host.where).toBeNull();
  });

  test("fixedWhere non-null: prints its page and its command", () => {
    const home = connectedHome({
      codingAccounts: CA_ENROLLED,
      hostsCurrent: NO_HOST,
      hostFixedWhere: { page: "/settings/hosts", command: "catalyst-host join --token <token>" },
    });
    const host = part(json(home), "host");
    expect(host.where).toBe("https://cloud.example/settings/hosts");
    expect(host.lines).toContain("the owner runs: catalyst-host join --token <token>");
  });
});

describe("where-am-i.mjs: an enrolled contract still checks each account's credential", () => {
  const CLAUDE_OK = { accountSlot: "claude-1", provider: "claude", status: "active", quarantined: false, quarantineReason: null };
  const codexFailing = (pollFailureCount: number, lastPollErrorCode = "no_access_token") => ({
    accountSlot: "codex-7",
    provider: "codex",
    // What the cloud reports for this account today: healthy-looking, not quarantined.
    status: "attested",
    quarantined: false,
    quarantineReason: null,
    pollFailureCount,
    lastPollErrorCode,
  });
  const ENROL_ONE = /enrol+ (a|an|one|another)\b/i;
  const withoutNegations = (t: string) => t.replaceAll("Do not enroll another account.", "").replaceAll("Do not enroll one on this reading.", "");

  test("a healthy Claude account and a Codex account failing with no_access_token: the Codex account is the next step", () => {
    const home = connectedHome({ codingAccounts: CA_ENROLLED, accounts: { accounts: [CLAUDE_OK, codexFailing(7)] }, hostsCurrent: PASS });
    const out = run(home, ["--json"]);
    expect(out.status, out.stderr).toBe(1);
    const doc = JSON.parse(out.stdout) as Doc;
    const accounts = part(doc, "coding accounts");
    expect(accounts.verdict).toBe("unfinished");
    expect(accounts.lines).toContain("codex account codex-7 needs a new credential: its last 7 polls failed with no_access_token");
    expect(accounts.lines.join("\n")).not.toMatch(/claude account claude-1 needs/);
    expect(accounts.owner).toBe(ENROLLER);
    expect(accounts.where).toBe("https://cloud.example/settings/coding-accounts");
    expect(doc.finished).toBe(false);
    expect(doc.next?.part).toBe("coding accounts");
    expect(doc.next?.action).toMatch(/^codex account codex-7 needs a new credential\./);
    expect(doc.next?.action).toContain("Replace credential");

    const next = run(home, ["--next"]).stdout;
    expect(next).toContain("codex account codex-7 needs a new credential");
    expect(next).not.toMatch(/nothing left/);
    const report = run(home, []).stdout;
    expect(report).toContain("references/replacing-a-credential.md");
    for (const text of [next, report]) expect(withoutNegations(text)).not.toMatch(ENROL_ONE);
  });

  test("every credential error the poller writes counts, once the streak reaches three", () => {
    for (const code of ["no_access_token", "no_credential", "http_401", "http_403", "usage_unauthorized", "usage_forbidden"]) {
      const doc = json(connectedHome({ codingAccounts: CA_ENROLLED, accounts: [codexFailing(3, code)], hostsCurrent: PASS }));
      expect(part(doc, "coding accounts").verdict, code).toBe("unfinished");
    }
  });

  test("a streak below three, or a failure that is not about the credential, stays ok", () => {
    for (const row of [codexFailing(2), codexFailing(9, "network_error"), codexFailing(9, "exception:TypeError")]) {
      const doc = json(connectedHome({ codingAccounts: CA_ENROLLED, accounts: [CLAUDE_OK, row], hostsCurrent: PASS }));
      expect(part(doc, "coding accounts").verdict, JSON.stringify(row)).toBe("ok");
    }
  });

  test("a quarantined or an expired-or-revoked account needs a new credential too", () => {
    const quarantined = { ...CLAUDE_OK, accountSlot: "claude-2", quarantined: true, quarantineReason: "observed dead (http_401)" };
    const expired = { ...CLAUDE_OK, accountSlot: "claude-3", status: "expired-or-revoked" };
    const accounts = part(json(connectedHome({ codingAccounts: CA_ENROLLED, accounts: [CLAUDE_OK, quarantined, expired], hostsCurrent: PASS })), "coding accounts");
    expect(accounts.verdict).toBe("unfinished");
    expect(accounts.lines).toContain("claude account claude-2 needs a new credential: quarantined: observed dead (http_401)");
    expect(accounts.lines).toContain("claude account claude-3 needs a new credential: expired or revoked");
  });

  test("every account healthy: ok, and it says how many it checked", () => {
    const home = connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: PASS });
    const doc = json(home);
    expect(part(doc, "coding accounts")).toMatchObject({ verdict: "ok" });
    expect(part(doc, "coding accounts").lines).toContain("2 checked, none needs a new credential");
    expect(doc).toMatchObject({ finished: true, next: null });
  });

  test("the account list cannot be read: never silently ok, and it does not tell them to enroll one", () => {
    const home = connectedHome({ codingAccounts: CA_ENROLLED, accountsFail: true, hostsCurrent: PASS });
    const out = run(home, ["--json"]);
    expect(out.status).toBe(1);
    const doc = JSON.parse(out.stdout) as Doc;
    const accounts = part(doc, "coding accounts");
    expect(accounts.verdict).toBe("unreadable");
    expect(accounts.lines.join("\n")).toMatch(/could not be checked in detail/);
    expect(doc.finished).toBe(false);
    expect(doc.next?.part).toBe("coding accounts");
    const next = run(home, ["--next"]).stdout;
    expect(next).toMatch(/could not be checked/);
    expect(withoutNegations(next)).not.toMatch(ENROL_ONE);
  });

  test("a contract that says needs_credential is never ok, even when no row says which account", () => {
    const needs = codingAccounts("needs_credential", 0, "A coding account needs a new credential.");
    const doc = json(connectedHome({ codingAccounts: needs, hostsCurrent: PASS }));
    expect(part(doc, "coding accounts").verdict).toBe("unfinished");
    expect(doc.next?.action).toMatch(/replace the credential/);
  });
});

describe("where-am-i.mjs: the thoughts repository is a note, never proof of App access", () => {
  test("gh sees <owner>/thoughts: says it exists, and that App access is not verifiable from here", () => {
    const repositories = part(json(connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: PASS, thoughts: "exists" })), "repositories");
    expect(repositories.verdict).toBe("ok");
    expect(repositories.lines).toContain("note example/thoughts: exists; App access not verifiable from here. Confirm the GitHub App installation includes it (step 5a).");
  });

  test("gh cannot see it: says it may not exist, and points at step 5a without changing the verdict", () => {
    const doc = json(connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: PASS, thoughts: "missing" }));
    const line = part(doc, "repositories").lines.find((l) => l.startsWith("note example/thoughts:"));
    expect(line).toMatch(/gh could not see it .*Could not resolve to a Repository/);
    expect(line).toMatch(/step 5a/);
    expect(part(doc, "repositories").verdict).toBe("ok");
    expect(doc.finished).toBe(true);
  });

  test("no gh on this machine: says it was not checked", () => {
    const repositories = part(json(connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: PASS, thoughts: "absent" })), "repositories");
    expect(repositories.lines.find((l) => l.startsWith("note example/thoughts:"))).toMatch(/not checked/);
  });

  test("no line anywhere claims the App can reach the thoughts repository", () => {
    const report = run(connectedHome({ codingAccounts: CA_ENROLLED, hostsCurrent: PASS, thoughts: "exists" }), []).stdout;
    expect(report).not.toMatch(/App (?:access|can reach)[^.\n]*(?:verified|confirmed)/i);
  });
});

describe("the onboarding guide walks a dead credential and the thoughts repository", () => {
  const onboard = join(here, "..", "skills", "catalyst-onboard");
  const read = (rel: string) => readFileSync(join(onboard, rel), "utf8");

  test("replacing-a-credential.md gives the Codex steps, the Claude field, and says never to enroll a second account", () => {
    const ref = read("references/replacing-a-credential.md");
    for (const text of [
      "`codex login`",
      "Sign in with ChatGPT",
      "`~/.codex/auth.json`",
      "`$CODEX_HOME/auth.json`",
      "`pbcopy < ~/.codex/auth.json`",
      "Settings → AI accounts",
      "Replacement auth.json contents",
      "Replace credential",
      "Do not enroll a second account.",
      "single-use",
      "sign in to Codex again, separately",
      "Replacement setup token",
      "`node scripts/where-am-i.mjs`",
    ]) {
      expect(ref, text).toContain(text);
    }
    expect(ref).not.toContain("—");
    expect(read("SKILL.md")).toContain("references/replacing-a-credential.md");
    expect(read("references/what-a-phase-needs.md")).toContain("references/replacing-a-credential.md");
  });

  test("enrolled no longer means nothing to do", () => {
    const row = read("references/what-a-phase-needs.md").split("\n").find((l) => l.startsWith("| `enrolled` |"));
    expect(row).toBeDefined();
    expect(row).not.toMatch(/\| nothing \|$/);
    expect(row).toContain("needs a new credential");
  });

  test("step 5a sits between the App install and registering the repository, and step 5 grants <org>/thoughts", () => {
    const path = read("references/the-one-path.md");
    const five = path.indexOf("## 5 — Install the GitHub App");
    const fiveA = path.indexOf("## 5a — The thoughts repository");
    const six = path.indexOf("## 6 — Register the repository");
    expect(five).toBeGreaterThanOrEqual(0);
    expect(fiveA).toBeGreaterThan(five);
    expect(six).toBeGreaterThan(fiveA);
    expect(path.slice(five, fiveA)).toContain("`<org>/thoughts`");
    const stepFiveA = path.slice(fiveA, six);
    for (const text of ["private repository named `thoughts`", "initialized with a README", "All repositories", "never that the App can reach it"]) {
      expect(stepFiveA, text).toContain(text);
    }
    const browser = read("references/what-the-browser-owns.md");
    expect(browser).toContain("`<your GitHub org>/thoughts`");
    expect(browser).toContain("All repositories");
  });

  test("the CLI's account status and the fact skill say Replace credential, never re-enrol", () => {
    const execution = readFileSync(join(here, "..", "src", "execution.ts"), "utf8");
    expect(execution).not.toMatch(/re-enrol/);
    expect(execution).toContain("Settings → AI accounts → the account → Replace credential");
    const facts = readFileSync(join(here, "..", "skills", "how-catalyst-works", "references", "coding-accounts.md"), "utf8");
    expect(facts).not.toContain("only an operator clears it");
    expect(facts).toContain("Replace credential on the account's page clears it");
  });
});
