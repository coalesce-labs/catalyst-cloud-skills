#!/usr/bin/env node
// install-state.mjs — put a sandbox HOME into one onboarding starting state, so `/catalyst-onboard`
// can be run against it and graded on what it says next. It writes a stand-in catalyst CLI
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
//   project-unchecked     a mapped project that has never had a readiness check, an owner whose CLI
//                         has team check: the guide runs `team check ENG` itself, not the Re-check button
//   project-no-toml       a mapped project whose default repository has no .catalyst/catalyst.toml:
//                         the repository's settings file is next
//   repo-claude-only      like project-no-toml, with the repository checked out at ~/repos/app holding a
//                         CLAUDE.md full of guidance, no AGENTS.md and a real .claude/skills: the guide reads
//                         the agent setup, says what it found, and asks before changing anything
//   all-ready             every part is finished: run `ready`, then move one ticket
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STATES = ["nothing-connected", "claude-only", "api-key-only", "cancelled-account", "no-project", "project-unchecked", "project-no-toml", "repo-claude-only", "all-ready"];
// The real CLI, for the verbs that are local logic on a checkout (`repo …`): the stand-in cannot fake
// those honestly, so it hands them to the bin of the checkout this scaffold lives in (dist must be built).
const REAL_CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "catalyst.js");
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
const UNCHECKED = [];
const CAPABILITIES = { cli: { name: "catalyst", version: "0.9.5" }, contract: { version: "2.3.0", fetchedAt: "2026-09-29T00:00:00Z" }, capabilities: [
  { verb: "ready", does: "read readiness", needs: "member", routes: [], since: "0.1.0", availability: "available", missing: [] },
  { verb: "team list", does: "list teams", needs: "member", routes: [], since: "0.9.5", availability: "available", missing: [] },
  { verb: "team check", does: "run a project's readiness check now", needs: "admin", routes: [], since: "0.9.5", availability: "available", missing: [] },
  { verb: "team map", does: "map a project's stages", needs: "admin", routes: [], since: "0.9.5", availability: "available", missing: [] },
  { verb: "team adopt", does: "adopt the workflow", needs: "admin", routes: [], since: "0.9.5", availability: "available", missing: [] },
  { verb: "repo agents-block", does: "add or refresh the Catalyst block in a checkout's AGENTS.md", needs: "member", routes: [], since: "0.13.1", availability: "available", missing: [] },
  { verb: "repo agent-setup", does: "read a checkout's agent setup and make it portable on request", needs: "member", routes: [], since: "0.13.1", availability: "available", missing: [] },
] };
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
    "capabilities --json": CAPABILITIES,
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
    case "project-unchecked":
      return { ...base, ...person("connected", "connected"), ...workspace(true), "contract --path teams --json": team(UNCHECKED), "contract --path merge.repositories --json": [{ owner: "example", name: "app" }], "contract --path codingAccounts --json": enrolled(1), "accounts --json": { accounts: [CLAUDE] } };
    case "repo-claude-only":
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
const cli = join(dir, "catalyst.mjs");
writeFileSync(
  cli,
  [
    "#!/usr/bin/env node",
    "import { existsSync, writeFileSync } from 'node:fs'; import { homedir } from 'node:os'; import { join } from 'node:path'; import { spawnSync } from 'node:child_process';",
    // `repo …` is local logic on a checkout: the real CLI answers it, under the ambient runtime.
    `if (process.argv[2] === "repo") { const r = spawnSync(process.execPath, [${JSON.stringify(REAL_CLI)}, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, CATALYST_SKILLS_RUNTIME: "ambient" } }); process.exit(r.status ?? 1); }`,
    `const answers = ${JSON.stringify(answers(state))};`,
    `const connected = ${connected};`,
    "const a = process.argv.slice(2).join(' ');",
    "main();",
    "function main() {",
    `if (a === "status") { console.log(connected ? "Tenant: example\\nAPI: ${CLOUD} (ok)\\nBundle: 0.9.3" : "Not connected to a tenant. Run: catalyst login"); process.exit(connected ? 0 : 2); }`,
    // A login that never completes: it prints the code and URL a real one prints, then waits for an
    // approval no browser will give, so the guide has to hand the step over and stop.
    `if (a === "login" || a.startsWith("login ")) { console.log("Open ${CLOUD}/device and enter the code WXYZ-1234 to approve this machine.\\nWaiting for approval (the code expires in 5 minutes)..."); setTimeout(() => { process.stderr.write("the login code expired after 5 minutes; run login again\\n"); process.exit(1); }, 20_000); return; }`,
    'if (!connected) { process.stderr.write("not connected to a tenant — run: catalyst login\\n"); process.exit(2); }',
    'if (a === "ready") { console.log("READY"); process.exit(0); }',
    // `--refresh` is a cache instruction, not a different read
    "const key = process.argv.slice(2).filter((x) => x !== '--refresh').join(' ');",
    "const marker = join(homedir(), '.catalyst-onboard-eval', 'checked');",
    "if (key.startsWith('team check')) { writeFileSync(marker, key); console.log(JSON.stringify({ team: 'ENG', status: 'ready', checks: [{ id: 'oauth_scope', state: 'pass' }, { id: 'hosts_current', state: 'pass' }, { id: 'environment_declared', state: 'pass' }] })); console.log('ENG: ready (3 checks pass)'); process.exit(0); }",
    "const mappedMarker = join(homedir(), '.catalyst-onboard-eval', 'mapped');",
    "const isMapped = () => existsSync(mappedMarker) || (Array.isArray(answers['contract --path teams --json']) && answers['contract --path teams --json'].length > 0);",
    "if (key === 'team list' || key === 'team list --json') { console.log(JSON.stringify([{ key: 'ENG', name: 'Engineering', mapped: isMapped() }])); process.exit(0); }",
    "if (key.startsWith('team map ENG') || key.startsWith('team adopt ENG')) { if (key.includes('--yes') && key.includes('--plan-hash')) { writeFileSync(mappedMarker, key); console.log('ENG: mapped (dispatch=Todo, pr=In Review, done=Done, canceled=Canceled). Re-run the readiness check to see the rest.'); process.exit(0); } console.log(JSON.stringify({ team: 'ENG', plan: [{ role: 'dispatch', stage: 'Todo' }, { role: 'pr', stage: 'In Review' }, { role: 'done', stage: 'Done' }, { role: 'canceled', stage: 'Canceled' }], planHash: 'abc123' })); console.log('Preview only. Apply with: catalyst ' + key.split(' ').slice(0, 3).join(' ') + ' --yes --plan-hash abc123'); process.exit(0); }",
    "if (key.startsWith('team ')) { process.stderr.write(`team ${key.split(' ')[1]} needs a team key or is not known to this stand-in\\n`); process.exit(2); }",
    "if (key === 'contract --path teams --json' && existsSync(mappedMarker) && Array.isArray(answers[key]) && answers[key].length === 0) { console.log(JSON.stringify([{ key: 'ENG', dispatchGate: { status: 'open' }, readiness: { status: 'unchecked', checks: [] } }])); process.exit(0); }",
    "if (key === 'contract --path teams --json' && existsSync(marker) && Array.isArray(answers[key]) && answers[key].length > 0) { const t = answers[key].map((x) => ({ ...x, readiness: { status: 'ready', checks: [{ id: 'oauth_scope', state: 'pass' }, { id: 'hosts_current', state: 'pass' }, { id: 'environment_declared', state: 'pass' }] } })); console.log(JSON.stringify(t)); process.exit(0); }",
    "if (key in answers) { console.log(JSON.stringify(answers[key])); process.exit(0); }",
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
// A `catalyst` on PATH for the agent's own Bash (and the old `catalyst-skills` name, so a reply that still
// uses it runs to completion and is then failed by the does-not-say-the-old-name grader), and a `gh` that
// sees no thoughts repository.
const bin = join(dir, "bin");
mkdirSync(bin, { recursive: true });
for (const name of ["catalyst", "catalyst-skills"]) {
  writeFileSync(join(bin, name), `#!/bin/sh\nexec node "${cli}" "$@"\n`);
  chmodSync(join(bin, name), 0o755);
}
writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'GraphQL: Could not resolve to a Repository' >&2\nexit 1\n");
chmodSync(join(bin, "gh"), 0o755);
// The repo-claude-only state: a checkout of the mapped project's repository with a Claude-only layout.
if (state === "repo-claude-only") {
  const repo = join(home, "repos", "app");
  mkdirSync(join(repo, ".claude", "skills", "deploy"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "CLAUDE.md"), "# app\n\nRun `npm test` before opening a pull request. Migrations live in `src/db/`; never edit a shipped one.\n\nUse conventional commits.\n");
  writeFileSync(join(repo, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app to staging.\n---\n\nRun `npm run deploy:staging`.\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "app", private: true, scripts: { test: "node --test", "deploy:staging": "echo deploy" } }, null, 2));
  writeFileSync(join(repo, "src", "index.js"), "export const ok = true;\n");
  console.log(`repository checkout at ${repo} (CLAUDE.md, .claude/skills, no AGENTS.md)`);
}
console.log(`state ${state}: stand-in CLI at ${cli}; config at ${join(configDir, "customer.json")}; add ${bin} to PATH`);
