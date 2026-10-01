import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configPathFor,
  defaultCtx,
  loadConfig,
  writeConfig,
} from "../src/config.js";
import {
  onboardSettingsAuthorityPorts,
  readLocalRepositoryName,
} from "../src/onboard-settings-context.js";
import type { OnboardJournal } from "../src/onboard.js";

const scratch: string[] = [];
const origin = "https://cloud.example.test";
const repo = {
  owner: "example",
  name: "service",
  repoId: "repo-a",
  teamId: "team-a",
};
const advertisement = {
  schema: 1,
  web: {
    connections: "/a/account/connections",
    personalConnections: "/settings/connected-accounts",
  },
  routes: [
    "/api/v1/agent/teams",
    "/api/v1/repos",
    "/api/v1/agent/contract",
  ].map((path) => ({ method: "GET", path, personalBearer: true })),
};
const me = { account: "account-a", user: { id: "person-a", role: "owner" } };
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "settings-context-"));
  scratch.push(home);
  writeConfig(home, {
    baseUrl: origin,
    account: me.account,
    slug: "fixture",
    name: "Fixture",
    principal: "session",
    permissions: null,
    user: {
      ...me.user,
      role: "owner",
      label: "Fixture",
      email: null,
      linearUserId: null,
    },
    key: "ctc_user_fixture",
    joinedAt: "2026-09-30T22:00:00Z",
    lastSkillBundleVersion: "0.14.3",
  });
  const journal: OnboardJournal = {
    schema: 1,
    runId: "fixture",
    cli: "0.14.3",
    installer: null,
    tenant: me.account,
    account: me.account,
    membershipId: me.user.id,
    baseUrl: origin,
    exit: null,
    changes: [],
    steps: [
      { id: "linear.team", state: "done", evidence: { team: "team-a" } },
      {
        id: "github.repos",
        state: "done",
        evidence: { repository: JSON.stringify([repo]) },
      },
    ],
  };
  const reads: string[] = [];
  let override: ((path: string) => Response | null) | undefined;
  let localName: string | null = "example/service";
  const ctx = {
    ...defaultCtx(),
    home,
    env: {},
    now: () => new Date("2026-09-30T22:00:00Z"),
    stdout: () => {},
    stderr: () => {},
  };
  ctx.fetch = (async (input, init) => {
    const url = new URL(String(input));
    reads.push(url.pathname);
    expect(url.origin).toBe(origin);
    expect(init?.method ?? "GET").toBe("GET");
    const custom = override?.(url.pathname);
    if (custom) return custom;
    if (url.pathname === "/api/v1/me") return Response.json(me);
    if (url.pathname === "/api/v1/agent/teams")
      return Response.json({
        teams: [{ teamId: "team-a", teamKey: "CTC", teamName: "Fixture" }],
        liveTeamRead: { error: null },
      });
    if (url.pathname === "/api/v1/repos")
      return Response.json({ repos: [repo] });
    if (url.pathname === "/api/v1/agent/contract")
      return Response.json({
        onboarding: advertisement,
        contractVersion: "1.24.0",
        account: { id: me.account },
        merge: { repositories: [repo] },
      });
    throw new Error("unexpected route");
  }) as typeof fetch;
  const ports = onboardSettingsAuthorityPorts({
    ctx,
    journal,
    repository: repo,
    repoRoot: "/selected/repo",
    readRepositoryName: async () => localName,
  });
  return {
    home,
    ctx,
    journal,
    reads,
    ports,
    set: (fn: typeof override) => {
      override = fn;
    },
    local: (name: string | null) => {
      localName = name;
    },
  };
}
afterEach(() => {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("fresh onboarding settings context", () => {
  it("joins current member, team, personal ACL and actual repo ID without reading the disk contract", async () => {
    const f = fixture();
    const before = readFileSync(configPathFor(f.home));
    expect(await f.ports.readContext()).toEqual({
      accountId: me.account,
      personId: me.user.id,
      baseUrl: origin,
      role: "owner",
      teamId: repo.teamId,
      teamKey: "CTC",
      repoId: repo.repoId,
      repoName: "example/service",
      repoRoot: "/selected/repo",
    });
    expect(f.reads).toEqual([
      "/api/v1/agent/contract",
      "/api/v1/me",
      "/api/v1/agent/teams",
      "/api/v1/repos",
      "/api/v1/agent/contract",
    ]);
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
  });

  it.each([
    ["/api/v1/me", { ...me, account: "other-account" }],
    ["/api/v1/me", { ...me, user: { ...me.user, id: "other-person" } }],
    ["/api/v1/me", { ...me, user: { ...me.user, role: "member" } }],
    ["/api/v1/agent/teams", { teams: [], liveTeamRead: { error: null } }],
    [
      "/api/v1/agent/teams",
      {
        teams: [{ teamId: "team-a", teamKey: "CTC", teamName: "Fixture" }],
        liveTeamRead: { error: "unavailable" },
      },
    ],
    ["/api/v1/repos", { repos: [] }],
    ["/api/v1/repos", { repos: [{ ...repo, teamId: "other-team" }] }],
    [
      "/api/v1/agent/contract",
      {
        onboarding: advertisement,
        contractVersion: "1.24.0",
        account: { id: "other-account" },
        merge: { repositories: [repo] },
      },
    ],
    [
      "/api/v1/agent/contract",
      {
        onboarding: advertisement,
        contractVersion: "1.24.0",
        account: { id: me.account },
        merge: { repositories: [{ ...repo, repoId: "other-id" }] },
      },
    ],
  ])("refuses stale or foreign live evidence from %s", async (path, body) => {
    const f = fixture();
    f.set((current) => (current === path ? Response.json(body) : null));
    expect(await f.ports.readContext()).toBeNull();
  });

  it.each([
    undefined,
    { ...advertisement, routes: [] },
    {
      ...advertisement,
      routes: advertisement.routes.map((row) => ({
        ...row,
        personalBearer: false,
      })),
    },
  ])(
    "an older or unsupported cloud stops before member, team and repo reads",
    async (onboarding) => {
      const f = fixture();
      f.set((path) =>
        path === "/api/v1/agent/contract"
          ? Response.json({
              contractVersion: "1.24.0",
              account: { id: me.account },
              onboarding,
            })
          : null,
      );
      const before = readFileSync(configPathFor(f.home));
      expect(await f.ports.readContext()).toBeNull();
      expect(f.reads).toEqual(["/api/v1/agent/contract"]);
      expect(readFileSync(configPathFor(f.home))).toEqual(before);
    },
  );

  it("refuses journal identity mismatch and removed selection before network", async () => {
    const f = fixture();
    f.journal.membershipId = "foreign-person";
    expect(await f.ports.readContext()).toBeNull();
    expect(f.reads).toEqual([]);
    f.journal.membershipId = me.user.id;
    f.journal.steps = [];
    expect(await f.ports.readContext()).toBeNull();
    expect(f.reads).toEqual([]);
  });

  it("refuses a local checkout mismatch or config change after otherwise fresh reads", async () => {
    const f = fixture();
    f.local("example/other");
    expect(await f.ports.readContext()).toBeNull();
    f.local("example/service");
    f.set((path) => {
      if (path === "/api/v1/agent/contract") {
        const cfg = loadConfig(f.home)!;
        cfg.user!.id = "other-person";
        writeConfig(f.home, cfg);
      }
      return null;
    });
    expect(await f.ports.readContext()).toBeNull();
  });

  it("refuses stale OAuth without refreshing or mutating local config", async () => {
    const f = fixture();
    const cfg = loadConfig(f.home)!;
    delete cfg.key;
    cfg.auth = {
      kind: "oauth",
      accessToken: "old-fixture",
      refreshToken: "refresh-fixture",
      sessionId: "fixture",
      expiresAt: "2026-09-30T21:59:00Z",
    };
    writeConfig(f.home, cfg);
    const before = readFileSync(configPathFor(f.home));
    expect(await f.ports.readContext()).toBeNull();
    expect(f.reads).toEqual([]);
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
  });

  it("cancellation and a registry outage cannot authorize an import", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    expect(await f.ports.readContext(abort.signal)).toBeNull();
    expect(f.reads).toEqual([]);
    f.set(() =>
      Response.json({ error: "private diagnostic" }, { status: 503 }),
    );
    expect(await f.ports.readContext()).toBeNull();
  });

  it.each([
    ["git@github.com:Example/Service.git", "example/service"],
    ["https://github.com/Example/Service.git", "example/service"],
    ["https://evil.example/Example/Service.git", null],
    ["https://user:fixture@github.com/Example/Service.git", null],
    ["https://github.com/Example/Service.git?query=one", null],
    ["https://github.com/Example/Service.git#fragment", null],
  ])(
    "reads one supported local Git origin without contacting it",
    async (url, name) => {
      const root = mkdtempSync(join(tmpdir(), "settings-git-origin-"));
      scratch.push(root);
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "config", "remote.origin.url", url]);
      expect(await readLocalRepositoryName(root)).toBe(name);
      execFileSync("git", [
        "-C",
        root,
        "config",
        "--add",
        "remote.origin.url",
        "https://github.com/other/other.git",
      ]);
      expect(await readLocalRepositoryName(root)).toBeNull();
    },
  );
});
