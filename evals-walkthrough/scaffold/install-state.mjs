#!/usr/bin/env node
// install-state.mjs — put a sandbox HOME into one onboarding starting state, so `/catalyst-onboard`
// can be run against it and graded on what it says next. It writes a stand-in catalyst-skills CLI
// that answers each verb from the chosen state, and the customer config that points the skill's
// scripts at it. Nothing here reaches a real cloud; every verb answers from the tables below.
//
//   node install-state.mjs <state> [--home <dir>]
//
// States, in the order the guide should walk them:
//   nothing-connected     the machine holds no credential: the first step is connecting it
//   claude-only           one active Claude account, nothing else: the coding account is done, the
//                         Linear integration is next
//   api-key-only          one active Qwen account (an API key), nothing else: same next step
//   cancelled-account     a cancelled Claude account beside a healthy one: kept for reporting, never re-token,
//                         and setup is not held on it; the Linear integration is next
//   no-project            Linear connected, no project mapped: mapping one project is next
//   project-no-toml       a mapped project whose default repository has no .catalyst/catalyst.toml:
//                         the repository's settings file is next
//   all-ready             every part is finished: run `ready`, then move one ticket
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATES = ["nothing-connected", "claude-only", "api-key-only", "cancelled-account", "no-project", "project-no-toml", "all-ready"];
const args = process.argv.slice(2);
const state = args[0];
const homeFlag = args.indexOf("--home");
const home = homeFlag === -1 ? homedir() : args[homeFlag + 1];
if (!STATES.includes(state)) {
  process.stderr.write(`usage: node install-state.mjs <${STATES.join("|")}> [--home <dir>]\n`);
  process.exit(64);
}

const CLOUD = "https://cloud.example";
const account = (slot, provider, extra = {}) => ({ accountSlot: slot, provider, status: "active", quarantined: false, quarantineReason: null, label: extra.label ?? `${provider} for the team`, ...extra });
const CLAUDE = account("claude-1", "claude", { label: "Work laptop" });
const QWEN = account("qwen-1", "qwen", { label: "Qwen coding plan" });
const CANCELLED = account("claude-2", "claude", { label: "Old personal plan", status: "ended", quarantined: true, quarantineReason: "subscription ended", renewalStatus: "canceled" });
const enrolled = (n) => ({ state: "enrolled", activeCount: n, line: "At least one coding account is enrolled and active for this tenant.", enrolledBy: "owner_or_admin", enrolledByLine: "A tenant owner or admin, in Catalyst settings.", page: "/settings/coding-accounts" });
const NONE = { state: "none_enrolled", activeCount: 0, line: "No coding account is enrolled for this tenant.", enrolledBy: "owner_or_admin", enrolledByLine: "A tenant owner or admin, in Catalyst settings.", page: "/settings/coding-accounts" };
const team = (checks) => [{ key: "ENG", dispatchGate: { status: "open" }, readiness: { status: "degraded", checks } }];
const PASSING = [{ id: "oauth_scope", state: "pass" }, { id: "hosts_current", state: "pass" }, { id: "environment_declared", state: "pass" }];
const NO_TOML = [{ id: "oauth_scope", state: "pass" }, { id: "hosts_current", state: "pass" }, { id: "environment_declared", state: "fail", reason: "no_environment_declaration" }];
const READINESS_CHECKS = [
  { id: "oauth_scope", severity: "blocking", needsAnswer: true, fixedBy: "owner_or_admin", fixedByLine: "A tenant owner or admin, in Catalyst settings." },
  { id: "hosts_current", severity: "degrading", needsAnswer: false, fixedBy: "host_operator", fixedByLine: "Whoever runs the Catalyst host that is behind." },
  { id: "environment_declared", severity: "degrading", needsAnswer: false, fixedBy: "owner_or_admin", fixedByLine: "A tenant owner or admin, in Catalyst settings." },
];
const person = (linear, github) => ({
  "me --json": { user: { label: "Sam Example", role: "owner", linearUserId: linear === "connected" ? "lin-sam" : null } },
  "connections personal linear status --json": { outcome: linear, status: 200 },
  "connections personal github status --json": { outcome: github, status: 200 },
});
const workspace = (connected) => ({ "contract --path account --json": connected ? { name: "Example Co", slug: "example", linearWorkspaceSlug: "example-ws" } : { name: "Example Co", slug: "example" } });

/** Every verb the skill's scripts read, for a connected machine, per state. */
function answers(s) {
  const base = {
    "ready --json": { ready: true, checks: [{ id: "config", ok: true, line: "config: connected" }] },
    "replica status --probe --json": { outcome: "absent" },
    "events status --probe --json": { outcome: "absent" },
    "environment read --json": { current: null },
    "contract --path readinessChecks --json": READINESS_CHECKS,
  };
  switch (s) {
    case "claude-only":
      return { ...base, ...person("absent", "absent"), ...workspace(false), "contract --path teams --json": [], "contract --path merge.repositories --json": [], "contract --path codingAccounts --json": enrolled(1), "accounts --json": { accounts: [CLAUDE] } };
    case "api-key-only":
      return { ...base, ...person("absent", "absent"), ...workspace(false), "contract --path teams --json": [], "contract --path merge.repositories --json": [], "contract --path codingAccounts --json": enrolled(1), "accounts --json": { accounts: [QWEN] } };
    case "cancelled-account":
      return { ...base, ...person("absent", "absent"), ...workspace(false), "contract --path teams --json": [], "contract --path merge.repositories --json": [], "contract --path codingAccounts --json": enrolled(1), "accounts --json": { accounts: [CLAUDE, CANCELLED] } };
    case "no-project":
      return { ...base, ...person("absent", "absent"), ...workspace(true), "contract --path teams --json": [], "contract --path merge.repositories --json": [], "contract --path codingAccounts --json": enrolled(1), "accounts --json": { accounts: [CLAUDE] } };
    case "project-no-toml":
      return { ...base, ...person("connected", "connected"), ...workspace(true), "contract --path teams --json": team(NO_TOML), "contract --path merge.repositories --json": [{ owner: "example", name: "app" }], "contract --path codingAccounts --json": enrolled(1), "accounts --json": { accounts: [CLAUDE] } };
    case "all-ready":
      return { ...base, ...person("connected", "connected"), ...workspace(true), "contract --path teams --json": team(PASSING), "contract --path merge.repositories --json": [{ owner: "example", name: "app" }], "contract --path codingAccounts --json": enrolled(1), "accounts --json": { accounts: [CLAUDE] } };
    default:
      return { ...base, ...person("absent", "absent"), ...workspace(false), "contract --path teams --json": [], "contract --path merge.repositories --json": [], "contract --path codingAccounts --json": NONE };
  }
}

const dir = join(home, ".catalyst-onboard-eval");
mkdirSync(dir, { recursive: true });
const connected = state !== "nothing-connected";
const cli = join(dir, "catalyst-skills.mjs");
writeFileSync(
  cli,
  [
    "#!/usr/bin/env node",
    `const answers = ${JSON.stringify(answers(state))};`,
    `const connected = ${connected};`,
    "const a = process.argv.slice(2).join(' ');",
    "main();",
    "function main() {",
    `if (a === "status") { console.log(connected ? "Tenant: example\\nAPI: ${CLOUD} (ok)\\nBundle: 0.9.3" : "Not connected to a tenant. Run: catalyst-skills login"); process.exit(connected ? 0 : 2); }`,
    // A login that never completes: it prints the code and URL a real one prints, then waits for an
    // approval no browser will give, so the guide has to hand the step over and stop.
    `if (a === "login" || a.startsWith("login ")) { console.log("Open ${CLOUD}/device and enter the code WXYZ-1234 to approve this machine.\\nWaiting for approval (the code expires in 5 minutes)..."); setTimeout(() => { process.stderr.write("the login code expired after 5 minutes; run login again\\n"); process.exit(1); }, 20_000); return; }`,
    'if (!connected) { process.stderr.write("not connected to a tenant — run: catalyst-skills login\\n"); process.exit(2); }',
    'if (a === "ready") { console.log("READY"); process.exit(0); }',
    "if (a in answers) { console.log(JSON.stringify(answers[a])); process.exit(0); }",
    'if (a.startsWith("contract --path ")) { process.stderr.write(`contract: 2.2.0 from cache\\nthe contract has nothing at "${a.split(" ")[2]}"\\n`); process.exit(2); }',
    'if (a.startsWith("explain ")) { console.log("ENG-1: eligible; it will run on the next pull (coding account Work laptop, project ENG, repository example/app)."); process.exit(0); }',
    "process.stderr.write(`unknown verb: ${a}\\n`); process.exit(9);",
    "}",
  ].join("\n"),
);
chmodSync(cli, 0o755);
// The skill's scripts find the CLI through the customer config's cliPath and run it on node.
const configDir = join(home, ".config", "catalyst-cloud");
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "customer.json"), JSON.stringify(connected ? { baseUrl: CLOUD, account: "example", cliPath: cli, key: "ctc_user_example" } : { baseUrl: CLOUD, account: "example", cliPath: cli }));
// A `catalyst-skills` on PATH for the agent's own Bash, and a `gh` that sees no thoughts repository.
const bin = join(dir, "bin");
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "catalyst-skills"), `#!/bin/sh\nexec node "${cli}" "$@"\n`);
writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'GraphQL: Could not resolve to a Repository' >&2\nexit 1\n");
chmodSync(join(bin, "catalyst-skills"), 0o755);
chmodSync(join(bin, "gh"), 0o755);
console.log(`state ${state}: stand-in CLI at ${cli}; config at ${join(configDir, "customer.json")}; add ${bin} to PATH`);
