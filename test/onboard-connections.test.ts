import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dirname, "..", "skills", "catalyst-onboard", "scripts", "where-am-i.mjs");

function readOnboard(linear: string, github: string, repoRegistered = true, staleTeams = false) {
  const home = mkdtempSync(join(tmpdir(), "catalyst-onboard-grants-"));
  const cli = join(home, "fixture-cli.mjs");
  writeFileSync(cli, `
const [verb, ...args] = process.argv.slice(2);
const output = (body) => console.log(JSON.stringify(body));
if (verb === "status") console.log("Tenant: Test Tenant\\nAPI: https://cloud.example");
else if (verb === "ready") output({checks: []});
else if (verb === "me") output({user: {label: "Taylor", role: "member", linearUserId: "lin-taylor"}});
else if (verb === "connections") output({outcome: process.env[args[1] === "linear" ? "TEST_LINEAR" : "TEST_GITHUB"], status: 200});
else if (verb === "contract" && args.includes("--path") && args[args.indexOf("--path") + 1] === "account") output({name:"Test Tenant",slug:"test",linearWorkspaceId:"workspace"});
else if (verb === "contract" && args.includes("--path") && args[args.indexOf("--path") + 1] === "teams") output([{key:"ENG", dispatchGate:{status: process.env.TEST_STALE_TEAMS === "true" && !args.includes("--refresh") ? "mapping_missing" : "open"}}]);
else if (verb === "contract") output(process.env.TEST_REPOSITORY_REGISTERED === "true" ? [{owner:"acme",name:"app"}] : []);
else if (verb === "environment") output({current:null});
else process.exit(3);
`);
  const configDir = join(home, ".config", "catalyst-cloud");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "customer.json"), JSON.stringify({ key: "member-fixture", cliPath: cli }));
  const result = spawnSync(process.execPath, [script, "--json"], {
    encoding: "utf8",
    env: { ...process.env, CATALYST_SKILLS_HOME: home, TEST_LINEAR: linear, TEST_GITHUB: github, TEST_REPOSITORY_REGISTERED: String(repoRegistered), TEST_STALE_TEAMS: String(staleTeams) },
  });
  return { exit: result.status, doc: JSON.parse(result.stdout) as {
    personalConnections: Record<string, string>;
    next: { part: string; blocking: boolean; action: string } | null;
    finished: boolean;
  }, stderr: result.stderr };
}

describe("onboarding personal grants", () => {
  test("a missing member grant is the next step after the tenant workspace is connected", () => {
    const { exit, doc, stderr } = readOnboard("absent", "absent");
    expect(stderr).toBe("");
    expect(exit).toBe(1);
    expect(doc.personalConnections).toEqual({ linear: "absent", github: "absent" });
    expect(doc.next).toMatchObject({ part: "person", blocking: true, action: "connect your personal linear account" });
  });

  test("both connected grants let the agent advance to the first ticket", () => {
    const { exit, doc, stderr } = readOnboard("connected", "connected");
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(doc.finished).toBe(true);
    expect(doc.next).toBeNull();
  });

  test("reads back a successful stage mapping from a refreshed teams contract", () => {
    const { exit, doc, stderr } = readOnboard("connected", "connected", true, true);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(doc.finished).toBe(true);
  });

  test("does not make personal GitHub the next step until repository registration confirms the tenant App", () => {
    const beforeInstall = readOnboard("connected", "absent", false);
    expect(beforeInstall.doc.next?.part).not.toBe("person");
    expect(beforeInstall.doc.next?.action).toContain("register the repository");

    const afterInstall = readOnboard("connected", "absent", true);
    expect(afterInstall.doc.next).toMatchObject({
      part: "person",
      blocking: true,
      action: "connect your personal github account",
    });
  });

  test("the human guide places personal GitHub consent after repository registration", () => {
    const guide = readFileSync(join(import.meta.dirname, "..", "skills", "catalyst-onboard", "references", "the-one-path.md"), "utf8");
    const app = guide.indexOf("## 5 — Install the GitHub App");
    const repository = guide.indexOf("## 6 — Register the repository");
    const personalGithub = guide.indexOf("## 6a — Connect your personal GitHub account");
    expect(app).toBeGreaterThanOrEqual(0);
    expect(repository).toBeGreaterThan(app);
    expect(personalGithub).toBeGreaterThan(repository);
    expect(guide.slice(personalGithub)).toContain("after the GitHub App is installed and the repository is registered");
  });

  test("the human guide discovers the checkout, worktrees, and shared thoughts before code work", () => {
    const guide = readFileSync(join(import.meta.dirname, "..", "skills", "catalyst-onboard", "references", "the-one-path.md"), "utf8");
    expect(guide).toContain("git -C <path> rev-parse --show-toplevel");
    expect(guide).toContain("git -C <root> worktree list");
    expect(guide).toContain("Resolve the shared-notes mapping and symlink");
  });
});
