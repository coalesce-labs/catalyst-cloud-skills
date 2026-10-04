import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import {
  configPathFor,
  defaultCtx,
  loadConfig,
  writeConfig,
  type Ctx,
} from "../src/config.js";
import { createOnboardRuntime } from "../src/onboard-runtime.js";
import { selectedOnboardRepositories } from "../src/onboard-repositories.js";
import type { OnboardJournal, OnboardStepResult } from "../src/onboard.js";
import type { OnboardUi } from "../src/onboard-ui.js";

const homes: string[] = [];
const origin = "https://project-fixture.invalid";
const teamId = "team-engineering";
const selected = { owner: "example", name: "app", teamId };
const registered = { ...selected, repoId: "account-a:example__app" };
const route = (method: "GET" | "POST", path: string) => ({
  method,
  path,
  personalBearer: true,
});
const routes = () => [
  route("GET", "/api/v1/repos"),
  route("GET", "/api/v1/agent/contract"),
  route("GET", "/api/v1/me/repositories/options"),
  route("POST", "/api/v1/me/repositories"),
];
const web = {
  connections: "/a/account/connections",
  personalConnections: "/settings/connected-accounts",
};
const options = () => ({
  linear: {
    connected: true,
    error: null as string | null,
    teams: [{ id: teamId, key: "ENG", name: "Engineering" }],
  },
  github: {
    connected: true,
    error: null as string | null,
    truncated: false,
    repositories: [
      {
        installationId: "installation-a",
        owner: "example",
        name: "app",
        private: true,
        defaultBranch: "main",
      },
      {
        installationId: "installation-a",
        owner: "example",
        name: "web",
        private: false,
        defaultBranch: "main",
      },
    ],
  },
  taken: [] as Array<{
    id: string;
    name: string;
    status: string;
    linearTeamId: string;
    githubRepoOwner: string;
    githubRepoName: string;
  }>,
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  argv: string[] = ["--repo", "example/app"],
  choice?: () => Promise<string | null>,
) {
  const home = mkdtempSync(join(tmpdir(), "onboard-projects-"));
  homes.push(home);
  const messages: string[] = [];
  const ctx: Ctx = {
    ...defaultCtx(),
    home,
    env: {},
    now: () => new Date("2026-10-01T03:00:00Z"),
    stdout: vi.fn(),
    stderr: (text) => messages.push(text),
  };
  writeConfig(home, {
    baseUrl: origin,
    account: "account-a",
    slug: "fixture",
    name: "Fixture",
    principal: "session",
    permissions: null,
    user: {
      id: "person-a",
      role: "owner",
      label: "Fixture",
      email: null,
      linearUserId: null,
    },
    key: "ctc_user_synthetic",
    joinedAt: ctx.now().toISOString(),
    lastSkillBundleVersion: "0.14.6",
  });
  const journal: OnboardJournal = {
    schema: 1,
    runId: "project-fixture",
    cli: "0.14.6",
    installer: null,
    tenant: "account-a",
    account: "account-a",
    membershipId: "person-a",
    baseUrl: origin,
    exit: null,
    changes: [],
    steps: [
      { id: "linear.team", state: "done", evidence: { team: teamId } },
      {
        id: "github.repos",
        state: "done",
        evidence: { repository: JSON.stringify([selected]) },
      },
    ],
  };
  const state = {
    advertised: routes(),
    contractAccount: "account-a",
    schema: 1,
    oldServer: false,
    inventory: [] as Array<{ teamId: string; owner: string; name: string }>,
    ids: [] as Array<{ repoId: string; owner: string; name: string }>,
    options: options(),
    optionBody: undefined as undefined | (() => Promise<Response>),
    post: async (): Promise<Response> => new Response(null, { status: 201 }),
  };
  const calls: Array<{ method: string; path: string; init?: RequestInit }> = [];
  ctx.fetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, init });
    expect(url.origin).toBe(origin);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer ctc_user_synthetic",
    );
    if (url.pathname === "/api/v1/agent/contract")
      return Response.json({
        account: { id: state.contractAccount },
        contractVersion: "2.16.0",
        merge: { repositories: state.ids },
        ...(state.oldServer
          ? {}
          : {
              onboarding: {
                schema: state.schema,
                routes: state.advertised,
                web,
              },
            }),
      });
    // CTC-4742: these fixtures model a server without the per-person repository list.
    if (url.pathname === "/api/v1/agent/repos")
      return new Response(null, { status: 404 });
    if (url.pathname === "/api/v1/repos")
      return Response.json({ repos: state.inventory });
    if (url.pathname === "/api/v1/me/repositories/options")
      return state.optionBody
        ? state.optionBody()
        : Response.json(state.options);
    if (url.pathname === "/api/v1/me/repositories" && method === "POST")
      return state.post();
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  });
  const ui: OnboardUi | undefined = choice
    ? {
        signal: new AbortController().signal,
        plan: () => {},
        confirmPlan: async () => ({ proceed: false, localSync: false }),
        chooseFirstRepository: choice,
        stepStart: () => {},
        stepEnd: () => {},
        message: (text) => messages.push(text),
        finish: () => {},
        wait: async (_message, work) => work(),
        dispose: () => {},
      }
    : undefined;
  const adapters = () =>
    createOnboardRuntime(parseArgs(["onboard", ...argv]), ctx, {
      ui,
      login: async () => {
        throw new Error("Unexpected sign-in in first-project fixture");
      },
      ready: async () => ({
        state: "waiting",
        reason: "fixture_readiness_unverified",
      }),
    }).adapters!;
  const bind = () => {
    state.inventory = [{ teamId, owner: selected.owner, name: selected.name }];
    state.ids = [
      { owner: selected.owner, name: selected.name, repoId: registered.repoId },
    ];
  };
  const saveSelection = (result: OnboardStepResult) => {
    expect(result.state).toBe("done");
    journal.steps[1] = {
      id: "github.repos",
      state: "done",
      evidence: result.evidence,
    };
  };
  return {
    ctx,
    home,
    journal,
    state,
    calls,
    messages,
    adapters,
    bind,
    saveSelection,
    posts: () => calls.filter((call) => call.method === "POST"),
    configBytes: () => readFileSync(configPathFor(home)),
  };
}
afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("first project uses live provider choices and actual bindings", () => {
  test("first fresh choice records names without inventing a registered ID or readiness", async () => {
    const f = fixture();
    const before = f.configBytes();
    const result = await f.adapters()["github.repos"]!.check(f.ctx, f.journal);
    f.saveSelection(result);
    expect(JSON.parse(String(result.evidence?.repository))).toEqual([selected]);
    expect(selectedOnboardRepositories(f.journal)).toEqual([]);
    expect(await f.adapters().projects!.check(f.ctx, f.journal)).toEqual({
      state: "pending",
    });
    expect(f.posts()).toEqual([]);
    expect(f.configBytes()).toEqual(before);
  });
  test("POST sends the server create DTO, and only independently observed binding can finish registration", async () => {
    const f = fixture();
    f.state.post = async () => {
      f.bind();
      return Response.json(
        { repository: { id: "untrusted-response-id" } },
        { status: 201 },
      );
    };
    const result = await f.adapters().projects!.act!(f.ctx, f.journal);
    expect(result.state).toBe("done");
    expect(JSON.parse(String(result.evidence?.repository))).toEqual([
      registered,
    ]);
    expect(f.posts()).toHaveLength(1);
    expect(JSON.parse(String(f.posts()[0]!.init?.body))).toEqual({
      name: "example/app",
      linearTeamId: teamId,
      linearTeamKey: "ENG",
      githubRepoOwner: "example",
      githubRepoName: "app",
    });
    expect(f.posts()[0]!.init).toMatchObject({ redirect: "error" });
    const lastPost = f.calls.findIndex((call) => call.method === "POST");
    expect(
      f.calls.slice(lastPost + 1).some((call) => call.path === "/api/v1/repos"),
    ).toBe(true);
    expect(
      f.calls
        .slice(lastPost + 1)
        .some((call) => call.path === "/api/v1/agent/contract"),
    ).toBe(true);
  });
  test.each([201, 409])(
    "HTTP %s without a current ACL binding is never registration evidence",
    async (status) => {
      const f = fixture();
      f.state.post = async () =>
        Response.json({ repository: { ...registered } }, { status });
      expect(
        (await f.adapters().projects!.act!(f.ctx, f.journal)).state,
      ).not.toBe("done");
      expect(f.posts()).toHaveLength(1);
    },
  );
  test("uncertain POST resumes through the actual binding without sending a duplicate create", async () => {
    const f = fixture();
    f.state.post = async () => {
      f.bind();
      throw new Error("response lost after commit");
    };
    expect(await f.adapters().projects!.act!(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "project_create_unverified",
    });
    const resumed = await f.adapters().projects!.check(f.ctx, f.journal);
    expect(resumed.state).toBe("done");
    expect(JSON.parse(String(resumed.evidence?.repository))).toEqual([
      registered,
    ]);
    expect(f.posts()).toHaveLength(1);
  });
  test.each(["acl", "id", "foreign-contract"])(
    "%s evidence missing after POST cannot finish",
    async (missing) => {
      const f = fixture();
      f.state.post = async () => {
        f.bind();
        if (missing === "acl") f.state.inventory = [];
        if (missing === "id") f.state.ids = [];
        if (missing === "foreign-contract")
          f.state.contractAccount = "account-foreign";
        return new Response(null, { status: 201 });
      };
      expect(
        (await f.adapters().projects!.act!(f.ctx, f.journal)).state,
      ).not.toBe("done");
      expect(f.posts()).toHaveLength(1);
    },
  );
  test("a resumed names-only Q3 receipt obtains the actual ID without another repository question", async () => {
    const choose = vi.fn(async () => {
      throw new Error("Q3 was already answered before registration");
    });
    const f = fixture([], choose);
    f.bind();
    const result = await f.adapters()["github.repos"]!.check(f.ctx, f.journal);
    expect(result.state).toBe("done");
    expect(JSON.parse(String(result.evidence?.repository))).toEqual([
      registered,
    ]);
    expect(choose).not.toHaveBeenCalled();
    expect(f.calls.some((call) => call.path.endsWith("/options"))).toBe(false);
    expect(f.posts()).toEqual([]);
  });
  test("interactive first choice is re-read before its receipt is accepted", async () => {
    const choose = vi.fn(async () => "example/web");
    const f = fixture([], choose);
    f.journal.steps = f.journal.steps.slice(0, 1);
    const adapters = f.adapters();
    expect(await adapters["github.repos"]!.check(f.ctx, f.journal)).toEqual({
      state: "pending",
    });
    f.saveSelection(await adapters["github.repos"]!.act!(f.ctx, f.journal));
    expect(choose).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(f.journal.steps[1]!.evidence?.repository)),
    ).toEqual([{ ...selected, name: "web" }]);
    expect(
      f.calls.filter((call) => call.path.endsWith("/options")),
    ).toHaveLength(3);
    expect(f.posts()).toEqual([]);
  });
  test("choice disappearing on the fresh provider read is rejected", async () => {
    const f = fixture([], async () => {
      f.state.options.github.repositories = [];
      return "example/app";
    });
    expect(await f.adapters()["github.repos"]!.act!(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "repository_selection_unverified",
    });
    expect(f.posts()).toEqual([]);
  });
  test("truncated inventory is explained while a displayed repository remains selectable", async () => {
    const f = fixture([], async () => "example/app");
    f.state.options.github.truncated = true;
    expect(
      (await f.adapters()["github.repos"]!.act!(f.ctx, f.journal)).state,
    ).toBe("done");
    expect(f.messages.join("\n")).toContain("part of its repository list");
    expect(f.posts()).toEqual([]);
  });
});

describe("fresh capability and personal binding guards", () => {
  test.each(["old", "get-missing", "schema", "non-personal"])(
    "%s options capability makes no unsupported options or create call",
    async (mode) => {
      const f = fixture();
      if (mode === "old") f.state.oldServer = true;
      if (mode === "get-missing")
        f.state.advertised = f.state.advertised.filter(
          (row) => !row.path.endsWith("/options"),
        );
      if (mode === "schema") f.state.schema = 2;
      if (mode === "non-personal")
        f.state.advertised = f.state.advertised.map((row) =>
          row.path.endsWith("/options")
            ? { ...row, personalBearer: false }
            : row,
        );
      expect(
        (await f.adapters()["github.repos"]!.check(f.ctx, f.journal)).state,
      ).toBe("waiting");
      expect(f.calls.some((call) => call.path.endsWith("/options"))).toBe(
        false,
      );
      expect(f.posts()).toEqual([]);
      if (mode === "old")
        expect(f.messages.join("\n")).toContain(
          `${origin}/a/account/connections`,
        );
    },
  );
  test.each(["missing", "wrong-method", "revoked-after-options"])(
    "%s POST advertisement refuses mutation",
    async (mode) => {
      const f = fixture();
      const revoke = () => {
        f.state.advertised = f.state.advertised.filter(
          (row) => row.method !== "POST",
        );
      };
      if (mode === "missing") revoke();
      if (mode === "wrong-method") {
        revoke();
        f.state.advertised.push(route("GET", "/api/v1/me/repositories"));
      }
      if (mode === "revoked-after-options")
        f.state.optionBody = async () => {
          revoke();
          return Response.json(f.state.options);
        };
      expect(await f.adapters().projects!.act!(f.ctx, f.journal)).toEqual({
        state: "waiting",
        reason: "cloud_capability_unavailable",
      });
      expect(f.posts()).toEqual([]);
    },
  );
  test.each(["account", "person", "origin", "unbound", "no-person"])(
    "%s journal cannot perform tenant IO",
    async (mismatch) => {
      const f = fixture();
      if (mismatch === "account") f.journal.account = "foreign";
      if (mismatch === "person") f.journal.membershipId = "foreign";
      if (mismatch === "origin") f.journal.baseUrl = "https://foreign.invalid";
      if (mismatch === "unbound") {
        delete f.journal.account;
        f.journal.tenant = null;
        delete f.journal.membershipId;
      }
      if (mismatch === "no-person") {
        const cfg = loadConfig(f.home)!;
        delete cfg.user;
        writeConfig(f.home, cfg);
      }
      expect((await f.adapters().projects!.act!(f.ctx, f.journal)).state).toBe(
        "waiting",
      );
      expect(f.calls).toEqual([]);
    },
  );
  test("member can inspect existing ACL bindings but cannot fetch fresh admin inventory or create", async () => {
    const f = fixture();
    const cfg = loadConfig(f.home)!;
    cfg.user!.role = "member";
    writeConfig(f.home, cfg);
    expect(await f.adapters()["github.repos"]!.check(f.ctx, f.journal)).toEqual(
      { state: "waiting", reason: "project_identity_unverified" },
    );
    expect(f.calls.some((call) => call.path.endsWith("/options"))).toBe(false);
    expect(f.posts()).toEqual([]);
  });
  test.each(["person", "account", "origin", "role"])(
    "changing %s while the options body is pending rejects choice evidence",
    async (mismatch) => {
      const f = fixture();
      const body = deferred<Response>();
      const entered = deferred<void>();
      f.state.optionBody = () => {
        entered.resolve();
        return body.promise;
      };
      const result = f.adapters()["github.repos"]!.check(f.ctx, f.journal);
      await entered.promise;
      const cfg = loadConfig(f.home)!;
      if (mismatch === "person") cfg.user!.id = "person-replacement";
      if (mismatch === "account") cfg.account = "account-replacement";
      if (mismatch === "origin") cfg.baseUrl = "https://replacement.invalid";
      if (mismatch === "role") cfg.user!.role = "member";
      writeConfig(f.home, cfg);
      body.resolve(Response.json(f.state.options));
      const observation = await result;
      expect(observation.state).toBe("waiting");
      expect(observation.evidence?.repository).toBeUndefined();
      expect(f.posts()).toEqual([]);
    },
  );
});

describe("provider and existing holder conflicts", () => {
  test.each([
    "archived-team",
    "archived-repo",
    "other-active-team",
    "same-active",
  ])("%s holder never authorizes another create", async (conflict) => {
    const f = fixture();
    f.state.options.taken = [
      {
        id: "holder",
        name: "Existing",
        status: conflict.startsWith("archived") ? "archived" : "active",
        linearTeamId: conflict === "archived-repo" ? "team-other" : teamId,
        githubRepoOwner: "example",
        githubRepoName: conflict === "other-active-team" ? "other" : "app",
      },
    ];
    const result = await f.adapters().projects!.act!(f.ctx, f.journal);
    expect(result).toEqual({
      state: "waiting",
      reason:
        conflict === "same-active"
          ? "project_registration_visibility_pending"
          : "project_binding_conflict",
    });
    expect(f.posts()).toEqual([]);
  });
  test.each([
    "github-disconnected",
    "linear-error",
    "missing-team",
    "missing-repository",
    "duplicate-repository",
  ])("%s inventory cannot authorize create", async (missing) => {
    const f = fixture();
    if (missing === "github-disconnected")
      f.state.options.github.connected = false;
    if (missing === "linear-error")
      f.state.options.linear.error = "provider unavailable";
    if (missing === "missing-team") f.state.options.linear.teams = [];
    if (missing === "missing-repository")
      f.state.options.github.repositories = [];
    if (missing === "duplicate-repository")
      f.state.options.github.repositories.push({
        ...f.state.options.github.repositories[0]!,
      });
    expect((await f.adapters().projects!.act!(f.ctx, f.journal)).state).toBe(
      "waiting",
    );
    expect(f.posts()).toEqual([]);
  });
  test("an archived holder appearing on the final options recheck stops before POST", async () => {
    const f = fixture();
    let reads = 0;
    f.state.optionBody = async () => {
      if (++reads === 2)
        f.state.options.taken = [
          {
            id: "holder",
            name: "Archived",
            status: "archived",
            linearTeamId: teamId,
            githubRepoOwner: "example",
            githubRepoName: "app",
          },
        ];
      return Response.json(f.state.options);
    };
    expect(await f.adapters().projects!.act!(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "project_binding_conflict",
    });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(f.posts()).toEqual([]);
  });
  test("a real create authorization refusal remains unfinished without fabricated binding evidence", async () => {
    const f = fixture();
    f.state.post = async () =>
      Response.json({ error: "forbidden" }, { status: 403 });
    expect(await f.adapters().projects!.act!(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "project_create_unverified",
    });
    expect(f.posts()).toHaveLength(1);
    expect(selectedOnboardRepositories(f.journal)).toEqual([]);
  });
  test("existing multi-repository receipt stays ACL checked and bypasses fresh registration", async () => {
    const f = fixture([]);
    const rows = [
      registered,
      { ...registered, name: "web", repoId: "project-web" },
    ];
    f.state.inventory = rows.map(({ teamId, owner, name }) => ({
      teamId,
      owner,
      name,
    }));
    f.state.ids = rows.map(({ repoId, owner, name }) => ({
      repoId,
      owner,
      name,
    }));
    f.journal.steps[1]!.evidence = { repository: JSON.stringify(rows) };
    const result = await f.adapters().projects!.act!(f.ctx, f.journal);
    expect(result.state).toBe("done");
    expect(JSON.parse(String(result.evidence?.repository))).toEqual(rows);
    expect(f.calls.some((call) => call.path.endsWith("/options"))).toBe(false);
    expect(f.posts()).toEqual([]);
  });
});

describe("cancellation retains an uncertain operation without inventing evidence", () => {
  test("a pre-aborted signal performs zero tenant requests or mutations", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    expect(
      await f.adapters().projects!.act!(f.ctx, f.journal, abort.signal),
    ).toMatchObject({ state: "waiting", reason: "interrupted" });
    expect(f.calls).toEqual([]);
  });
  test("aborting an unanswered picker stops without a write and ignores a later answer", async () => {
    let answer!: (value: string) => void;
    const entered = deferred<void>();
    const f = fixture([], () => {
      entered.resolve();
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    const abort = new AbortController(),
      before = f.configBytes();
    const result = f.adapters()["github.repos"]!.act!(
      f.ctx,
      f.journal,
      abort.signal,
    );
    await entered.promise;
    abort.abort();
    expect(await result).toEqual({ state: "waiting", reason: "interrupted" });
    answer("example/app");
    await Promise.resolve();
    expect(f.posts()).toEqual([]);
    expect(f.configBytes()).toEqual(before);
  });
  test("abort during uncertain create returns interrupted; resume independently recovers a committed binding", async () => {
    const entered = deferred<void>();
    let finish!: (response: Response) => void;
    const f = fixture();
    const abort = new AbortController();
    const before = f.configBytes();
    f.state.post = () => {
      entered.resolve();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const result = f.adapters().projects!.act!(f.ctx, f.journal, abort.signal);
    await entered.promise;
    abort.abort();
    expect(await result).toEqual({ state: "waiting", reason: "interrupted" });
    const dispatched = f.posts()[0]!.init?.signal;
    expect(dispatched?.aborted).toBe(true);
    f.bind();
    finish(new Response(null, { status: 201 }));
    await Promise.resolve();
    expect((await f.adapters().projects!.check(f.ctx, f.journal)).state).toBe(
      "done",
    );
    expect(f.posts()).toHaveLength(1);
    expect(f.configBytes()).toEqual(before);
  });
  test("owned create deadline cannot turn late HTTP success into readiness", async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    let finish!: (response: Response) => void;
    const f = fixture();
    f.state.post = () => {
      entered.resolve();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const result = f.adapters().projects!.act!(f.ctx, f.journal);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toEqual({
      state: "waiting",
      reason: "project_create_unverified",
    });
    expect(f.posts()[0]!.init?.signal?.aborted).toBe(true);
    finish(new Response(null, { status: 201 }));
    await Promise.resolve();
    expect(f.posts()).toHaveLength(1);
    expect(selectedOnboardRepositories(f.journal)).toEqual([]);
  });
});

describe("pending selection may use only exact verified registration evidence", () => {
  test("matching team and repository returns the registered ID, with case-insensitive repository names", () => {
    const f = fixture();
    f.journal.steps.push({
      id: "projects",
      state: "done",
      evidence: {
        repository: JSON.stringify([{ ...registered, owner: "Example" }]),
      },
    });
    expect(selectedOnboardRepositories(f.journal)).toEqual([
      { ...registered, owner: "Example" },
    ]);
  });
  test.each(["team", "repository", "not-done", "multiple", "malformed"])(
    "%s previous project evidence is never a pending selection fallback",
    (mismatch) => {
      const f = fixture();
      const row = {
        ...registered,
        ...(mismatch === "team" ? { teamId: "team-foreign" } : {}),
        ...(mismatch === "repository" ? { name: "foreign" } : {}),
      };
      f.journal.steps.push({
        id: "projects",
        state: mismatch === "not-done" ? "waiting" : "done",
        evidence: {
          repository:
            mismatch === "malformed"
              ? "{bad"
              : JSON.stringify(
                  mismatch === "multiple"
                    ? [row, { ...row, name: "second" }]
                    : [row],
                ),
        },
      });
      expect(selectedOnboardRepositories(f.journal)).toEqual([]);
    },
  );
});

// Source-only regression packet: real runtime adapters, real Response.json body reads.
describe("registered evidence remains bound throughout ACL and contract body reads", () => {
  const cases = [
    { phase: "acl-body", changed: "person" },
    { phase: "after-acl-body", changed: "person" },
    { phase: "contract-body", changed: "account" },
    { phase: "contract-body", changed: "origin" },
  ];
  function controls(step: "github.repos" | "projects") {
    test.each(cases)(
      `${step} refuses $changed switch at $phase before recording any binding`,
      async ({ phase, changed }) => {
        const f = fixture();
        f.bind();
        const beforeReceipt = JSON.stringify(f.journal);
        const entered = deferred<void>();
        const requests: Array<{
          path: string;
          origin: string;
          bearer: string | null;
        }> = [];
        let contracts = 0;
        let release = () => {};
        let replacement: Buffer | undefined;
        const changeConfig = () => {
          const cfg = loadConfig(f.home);
          if (!cfg?.user) throw new Error("Fixture personal config missing");
          if (changed === "person") {
            cfg.user.id = "person-replacement";
            cfg.key = "ctc_user_replacement_synthetic";
          }
          if (changed === "account") cfg.account = "account-replacement";
          if (changed === "origin") cfg.baseUrl = "https://replacement.invalid";
          writeConfig(f.home, cfg);
          replacement = f.configBytes();
        };
        f.ctx.fetch = vi.fn<typeof fetch>(async (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );
          expect(init?.method ?? "GET").toBe("GET");
          expect(init?.redirect).toBe("error");
          requests.push({
            path: url.pathname,
            origin: url.origin,
            bearer: new Headers(init?.headers).get("authorization"),
          });
          let value: unknown;
          let hold = false;
          // CTC-4742: this server has no per-person repository list, so the registry answers.
          if (url.pathname === "/api/v1/agent/repos")
            return new Response(null, { status: 404 });
          if (url.pathname === "/api/v1/agent/contract") {
            contracts++;
            value = {
              account: { id: "account-a" },
              contractVersion: "2.16.0",
              merge: { repositories: f.state.ids },
              onboarding: { schema: 1, routes: routes(), web },
            };
            // First contract is the real capability guard; second joins the ACL binding.
            hold = phase === "contract-body" && contracts === 2;
          } else if (url.pathname === "/api/v1/repos") {
            value = { repos: f.state.inventory };
            hold = phase !== "contract-body";
          } else {
            throw new Error(`Unexpected request ${url.pathname}`);
          }
          if (!hold) return Response.json(value);
          const bytes = new TextEncoder().encode(JSON.stringify(value));
          const response = new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 1));
                release = () => {
                  controller.enqueue(bytes.subarray(1));
                  controller.close();
                };
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
          const json = response.json.bind(response);
          vi.spyOn(response, "json").mockImplementation(async () => {
            entered.resolve();
            const body: unknown = await json();
            // This seam is after the native ACL body has parsed, before the next request.
            if (phase === "after-acl-body") changeConfig();
            return body;
          });
          return response;
        });
        const result = f.adapters()[step]!.check(f.ctx, f.journal);
        await entered.promise;
        if (phase !== "after-acl-body") changeConfig();
        release();
        const observation = await result;
        expect(observation.state).toBe("waiting");
        expect(observation.evidence?.repository).toBeUndefined();
        expect(JSON.stringify(f.journal)).toBe(beforeReceipt);
        expect(f.configBytes()).toEqual(replacement);
        expect(requests.every((request) => request.origin === origin)).toBe(
          true,
        );
        expect(
          requests.every(
            (request) => request.bearer === "Bearer ctc_user_synthetic",
          ),
        ).toBe(true);
        // Person replacement must be rejected before its credential can fetch contract IDs.
        if (phase !== "contract-body") expect(contracts).toBe(1);
        expect(
          requests.some((request) => request.path === "/api/v1/repos"),
        ).toBe(true);
      },
    );
    test(`${step} still resolves a real unchanged ACL and contract binding`, async () => {
      const f = fixture();
      f.bind();
      const before = f.configBytes();
      const observation = await f.adapters()[step]!.check(f.ctx, f.journal);
      expect(observation.state).toBe("done");
      expect(JSON.parse(String(observation.evidence?.repository))).toEqual([
        registered,
      ]);
      expect(f.calls.map((call) => call.path)).toEqual([
        "/api/v1/agent/contract",
        "/api/v1/agent/repos",
        "/api/v1/repos",
        "/api/v1/agent/contract",
      ]);
      expect(f.posts()).toEqual([]);
      expect(f.configBytes()).toEqual(before);
    });
  }
  controls("github.repos");
  controls("projects");
});
