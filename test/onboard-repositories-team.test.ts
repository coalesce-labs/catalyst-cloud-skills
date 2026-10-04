// CTC-4742: Choose repositories lists every repository the team already uses (pre-selected), never
// unregisters one, and offers the repositories the GitHub App can reach as unselected options.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseArgs } from "../src/args.js";
import { defaultCtx, writeConfig, type Ctx } from "../src/config.js";
import type { OnboardJournal } from "../src/onboard.js";
import {
  existingRepositoryAdapter,
  type ChooseExistingRepositories,
  type OnboardRepositoryChoice,
} from "../src/onboard-repositories.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const now = new Date("2026-10-04T02:00:00Z");
const TEAM = "team-ctc";
const NAMES = [
  "catalyst-cloud",
  "catalyst-cloud-marketing",
  "catalyst-cloud-sdk",
  "catalyst-cloud-skills",
  "catalyst-dev-skills",
  "catalyst-pm-skills",
  "catalyst-skills",
];
const agentRepo = (name: string, projects: unknown[]) => ({
  id: `account-a:${name}`,
  owner: "coalesce-labs",
  name,
  fullName: `coalesce-labs/${name}`,
  status: "active",
  projects,
});
const ctcProject = { id: "account-a:catalyst-cloud", name: "Catalyst Cloud", teamKey: "CTC", status: "active" };

function fixture(role: "owner" | "member" = "owner", choose?: ChooseExistingRepositories, argv: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), "onboard-repositories-team-"));
  homes.push(home);
  writeConfig(home, {
    account: "account-a", slug: "a", name: "A", permissions: null, principal: "session",
    baseUrl: "https://fixture.invalid", key: "ctc_user_fixture",
    user: { id: "person-a", role, label: "A", email: "a@example.invalid", linearUserId: null },
    joinedAt: now.toISOString(), lastSkillBundleVersion: "0.15.4",
  });
  const registered = new Set(NAMES);
  const agentRepos = () => [
    ...NAMES.filter((name) => registered.has(name)).map((name) => agentRepo(name, [ctcProject])),
    // Registered to CTC since this run started (POST below).
    ...[...registered].filter((name) => !NAMES.includes(name)).map((name) => agentRepo(name, [ctcProject])),
    agentRepo("catalyst", [{ id: "account-a:catalyst", name: "Catalyst", teamKey: "CTL", status: "active" }]),
    agentRepo("evergreen-e2e-demo", [{ id: "account-a:m1", name: "M1", teamKey: "CTC", status: "archived" }]),
  ];
  const contract = () => ({
    contractVersion: "2.26.0",
    account: { id: "account-a" },
    teams: [{ id: TEAM, key: "CTC" }, { id: "team-ctl", key: "CTL" }],
    routes: [{ method: "POST", path: "/api/v1/agent/project-repositories" }],
    merge: {
      repositories: agentRepos().map((row) => ({ repoId: row.id, owner: row.owner, name: row.name })),
    },
  });
  const calls: string[] = [];
  const posts: unknown[] = [];
  const ctx: Ctx = {
    ...defaultCtx(), home, env: {}, now: () => now, stdout: () => {}, stderr: () => {},
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      if (method === "GET" && path === "/api/v1/agent/repos")
        return Response.json({ repositories: agentRepos(), canManage: role === "owner" });
      if (method === "GET" && path === "/api/v1/repos")
        return Response.json({ repos: [{ owner: "coalesce-labs", name: "catalyst-cloud", teamId: TEAM }] });
      if (method === "GET" && path === "/api/v1/agent/contract") return Response.json(contract());
      if (method === "GET" && path === "/api/v1/me/repositories/options")
        return Response.json({
          linear: { connected: true, error: null, teams: [{ id: TEAM, key: "CTC" }] },
          github: {
            connected: true, error: null, truncated: false,
            repositories: [...NAMES, "catalyst-design-skills"].map((name) => ({ owner: "coalesce-labs", name })),
          },
          taken: [],
        });
      if (method === "POST" && path === "/api/v1/agent/project-repositories") {
        const body = JSON.parse(String(init?.body)) as { teamId: string; repository: string };
        posts.push(body);
        registered.add(body.repository.split("/")[1]!);
        return Response.json({ registered: { repoId: `account-a:${body.repository.split("/")[1]}` } });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  };
  const journal: OnboardJournal = {
    schema: 1, runId: "run-ctc", installer: null, cli: "0.15.4", tenant: "account-a", account: "account-a",
    membershipId: "person-a", baseUrl: "https://fixture.invalid", exit: null, changes: [],
    steps: [{ id: "linear.team", state: "done", evidence: { team: TEAM } }],
  };
  const adapter = existingRepositoryAdapter(parseArgs(["onboard", ...argv]), choose);
  return { ctx, journal, adapter, calls, posts };
}

test("every repository registered to the team is listed and pre-selected, other teams' and archived projects' are not", async () => {
  let offered: readonly OnboardRepositoryChoice[] = [];
  const f = fixture("owner", async (rows) => {
    offered = rows;
    return ["coalesce-labs/catalyst-cloud"];
  });
  await f.adapter.act!(f.ctx, f.journal);
  const registered = offered.filter((row) => row.registered !== false).map((row) => row.name);
  expect(registered).toEqual(NAMES);
  expect(offered.map((row) => row.name)).not.toContain("catalyst");
  expect(offered.map((row) => row.name)).not.toContain("evergreen-e2e-demo");
  for (const row of offered.filter((r) => r.registered !== false)) expect(row.repoId).toBe(`account-a:${row.name}`);
});

test("confirming with one repository selected keeps the other six registered", async () => {
  const f = fixture("owner", async () => ["coalesce-labs/catalyst-cloud"]);
  const result = await f.adapter.act!(f.ctx, f.journal);
  expect(result.state).toBe("done");
  expect(JSON.parse(String(result.evidence?.repository))).toEqual([
    { teamId: TEAM, owner: "coalesce-labs", name: "catalyst-cloud", repoId: "account-a:catalyst-cloud" },
  ]);
  expect(f.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  expect(f.calls.some((call) => call.includes("/remove"))).toBe(false);
});

test("a repository the App can reach but the team does not use is offered unselected, and selecting it registers it to the team", async () => {
  let offered: readonly OnboardRepositoryChoice[] = [];
  const f = fixture("owner", async (rows) => {
    offered = rows;
    return ["coalesce-labs/catalyst-cloud", "coalesce-labs/catalyst-design-skills"];
  });
  const result = await f.adapter.act!(f.ctx, f.journal);
  const design = offered.find((row) => row.name === "catalyst-design-skills");
  expect(design?.registered).toBe(false);
  expect(f.posts).toEqual([{ teamId: TEAM, repository: "coalesce-labs/catalyst-design-skills" }]);
  expect(result.state).toBe("done");
  expect(JSON.parse(String(result.evidence?.repository)).map((row: { name: string }) => row.name)).toEqual([
    "catalyst-cloud",
    "catalyst-design-skills",
  ]);
});

test("a member sees the team's registered repositories and is never offered or able to register others", async () => {
  let offered: readonly OnboardRepositoryChoice[] = [];
  const f = fixture("member", async (rows) => {
    offered = rows;
    return ["coalesce-labs/catalyst-cloud"];
  });
  await f.adapter.act!(f.ctx, f.journal);
  expect(offered.every((row) => row.registered !== false)).toBe(true);
  expect(f.calls).not.toContain("GET /api/v1/me/repositories/options");
  expect(f.posts).toEqual([]);
});

test("an explicit --repo for a registered repository other than the team default resolves without a question", async () => {
  const f = fixture("owner", undefined, ["--repo", "coalesce-labs/catalyst-cloud-sdk"]);
  const result = await f.adapter.check(f.ctx, f.journal);
  expect(result.state).toBe("done");
  expect(JSON.parse(String(result.evidence?.repository))[0].repoId).toBe("account-a:catalyst-cloud-sdk");
});
