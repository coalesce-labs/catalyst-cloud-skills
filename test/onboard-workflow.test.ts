import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { parseArgs } from "../src/args.js";
import {
  configPathFor,
  loadConfig,
  saveConfig,
  type Ctx,
  type CustomerConfig,
  type MeIdentity,
} from "../src/config.js";
import {
  onboardWorkflowVerificationAdapter,
  observeOnboardWorkflow,
} from "../src/onboard-workflow.js";
import {
  cmdOnboard,
  onboardLockPath,
  onboardStatePath,
  type OnboardJournal,
} from "../src/onboard.js";
import { loadHttpSdk, resetSdkCache } from "../src/sdk.js";

const origin = "https://cloud.example.test",
  team = "team-one";
const required = ["dispatch", "intake", "pr", "done", "canceled"];
function wire(now = Date.now()) {
  const types = ["unstarted", "backlog", "started", "completed", "canceled"];
  return {
    config: {
      teamId: team,
      mode: "mapped-existing",
      gitAutomation: "off",
      workflowRev: 7,
    },
    rows: required.map((slot, index) => ({
      slot,
      linearStateId: "state-" + index,
      linearStateName: slot,
      linearStateType: types[index]!,
      source: "chosen",
      stateStillExists: true,
    })),
    stages: required.map((name, index) => ({
      id: "state-" + index,
      name,
      type: types[index]!,
      position: index,
    })),
    stageSource: "mirror",
    mappingHash: "a".repeat(64),
    checklist: [] as string[],
    readiness: {
      teamId: team,
      teamKey: "ENG",
      teamName: "Engineering",
      status: "blocked",
      checkedAt: now - 1_000,
      workflowRev: 9,
      checks: [
        "team_visible",
        "mapped_states_exist",
        "mapping_total",
        "types_compatible",
        "labels_present",
      ]
        .map((id) => ({ id, state: "pass" }))
        .concat([
          { id: "linear_automation_pr_open", state: "fail" },
          { id: "linear_automation_pr_review", state: "unknown" },
          { id: "coding_account_enrolled", state: "fail" },
        ]),
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const homes: string[] = [],
  stops: AbortController[] = [],
  joins: Promise<unknown>[] = [],
  releases: Array<() => void> = [];
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop.abort();
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(joins.splice(0));
  for (const dispose of disposals.splice(0)) await dispose();
  resetSdkCache();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "onboard-workflow-"));
  homes.push(home);
  const me: MeIdentity = {
    account: "account-one",
    slug: "fixture",
    name: "Fixture",
    principal: "service",
    permissions: ["mirror:read"],
    user: {
      id: "person-one",
      role: "owner",
      label: "Fixture",
      email: null,
      linearUserId: null,
    },
  };
  const config: CustomerConfig = {
    ...me,
    baseUrl: origin,
    key: "ctc_user_private_fixture",
    joinedAt: new Date().toISOString(),
    lastSkillBundleVersion: "fixture",
  };
  saveConfig(home, config);
  const journal: OnboardJournal = {
    schema: 1,
    runId: "fixture",
    installer: null,
    cli: "0.14.6",
    tenant: me.account,
    account: me.account,
    membershipId: me.user!.id,
    baseUrl: origin,
    exit: null,
    steps: [{ id: "linear.team", state: "done", evidence: { team } }],
    changes: [],
  };
  const stop = new AbortController();
  stops.push(stop);
  const calls: Array<{ method: string; url: URL; init?: RequestInit }> = [];
  const messages: string[] = [];
  const state = {
    advertised: true,
    workflow: wire(),
    me,
    meCount: 0,
    workflowCount: 0,
    now: Date.now(),
    afterWorkflow: undefined as undefined | ((count: number) => void),
    afterMe: undefined as undefined | ((count: number) => void),
    afterContract: undefined as undefined | (() => void),
    message: undefined as undefined | ((text: string) => void),
    second: undefined as ReturnType<typeof wire> | undefined,
  };
  const contract = () => ({
    contractVersion: "1.0.0",
    account: { id: me.account },
    onboarding: {
      schema: 1,
      routes: state.advertised
        ? [
            {
              method: "GET",
              path: "/api/v1/agent/team-workflow",
              personalBearer: true,
            },
          ]
        : [],
      web: {
        connections: "/a/account/connections",
        personalConnections: "/settings/connected-accounts",
      },
    },
  });
  const ctx: Ctx = {
    home,
    env: { CATALYST_CLOUD_TOKEN: "ambient-must-not-be-used" },
    now: () => new Date(state.now),
    stdout: () => {
      throw new Error("unexpected stdout");
    },
    stderr: () => {},
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ method: init?.method ?? "GET", url, init });
      if (url.pathname === "/api/v1/me") {
        state.meCount++;
        const value = structuredClone(state.me);
        state.afterMe?.(state.meCount);
        return Response.json(value);
      }
      if (url.pathname === "/api/v1/agent/contract") {
        const value = contract();
        state.afterContract?.();
        return Response.json(value);
      }
      if (url.pathname === "/api/v1/agent/team-workflow") {
        state.workflowCount++;
        const value = structuredClone(
          state.workflowCount === 2 && state.second
            ? state.second
            : state.workflow,
        );
        state.afterWorkflow?.(state.workflowCount);
        return Response.json(value);
      }
      throw new Error("unexpected workflow request");
    },
  };
  const adapter = onboardWorkflowVerificationAdapter({
    message: (text) => {
      messages.push(text);
      state.message?.(text);
    },
  });
  const run = () => {
    const task = adapter.check(ctx, journal, stop.signal);
    void task.catch(() => {});
    joins.push(task);
    return task;
  };
  return {
    home,
    me,
    config,
    journal,
    stop,
    calls,
    messages,
    state,
    ctx,
    adapter,
    run,
    contract,
  };
}
function assertInstalled0131() {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@catalyst-cloud/sdk");
  const pkg: unknown = JSON.parse(
    readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"),
  );
  if (
    !pkg ||
    typeof pkg !== "object" ||
    !("version" in pkg) ||
    pkg.version !== "0.13.1"
  )
    throw new Error("actual installed SDK 0.13.1 required");
}

describe("existing workflow wire truth", () => {
  test("accepts separately stable team7/account9 revisions and only the five required typed slots", () => {
    const now = Date.now(),
      value = wire(now),
      observation = observeOnboardWorkflow(value, team, now);
    expect(observation).toMatchObject({
      mappingRevision: 7,
      readinessRevision: 9,
      mappedSlots: 5,
    });
    expect(value.readiness.status).toBe("blocked");
    expect(
      value.readiness.checks.find((c) => c.id === "linear_automation_pr_open")
        ?.state,
    ).toBe("fail");
  });
  test.each(required)(
    "missing required %s mapping never passes despite claimed server checks",
    (slot) => {
      const value = wire();
      value.rows = value.rows.filter((row) => row.slot !== slot);
      expect(observeOnboardWorkflow(value, team, Date.now())).toBeNull();
    },
  );
  test.each([
    "mapped_states_exist",
    "mapping_total",
    "types_compatible",
    "labels_present",
    "team_visible",
  ])("missing or unknown %s remains unverified", (id) => {
    const value = wire();
    value.readiness.checks = value.readiness.checks.map((c) =>
      c.id === id ? { ...c, state: "unknown" } : c,
    );
    expect(observeOnboardWorkflow(value, team, Date.now())).toBeNull();
  });
  test.each([
    "dead",
    "wrong-type",
    "duplicate-row",
    "duplicate-stage",
    "duplicate-check",
    "foreign-team",
    "missing-hash",
    "unknown-mode",
    "no-stages",
  ])("refuses actual %s wire defect", (kind) => {
    const value = wire();
    if (kind === "dead") value.rows[0]!.stateStillExists = false;
    if (kind === "wrong-type") value.stages[0]!.type = "completed";
    if (kind === "duplicate-row") value.rows.push(value.rows[0]!);
    if (kind === "duplicate-stage") value.stages.push(value.stages[0]!);
    if (kind === "duplicate-check")
      value.readiness.checks.push(value.readiness.checks[0]!);
    if (kind === "foreign-team") value.config.teamId = "foreign-team";
    if (kind === "missing-hash") value.mappingHash = "";
    if (kind === "unknown-mode") value.config.mode = "not-a-mode";
    if (kind === "no-stages") value.stageSource = "none";
    expect(observeOnboardWorkflow(value, team, Date.now())).toBeNull();
  });
  test.each([299_999, 300_000, -1])(
    "honors exact server five-minute age boundary %s",
    (age) => {
      const now = Date.now(),
        value = wire(now);
      value.readiness.checkedAt = now - age;
      expect(observeOnboardWorkflow(value, team, now) !== null).toBe(
        age === 299_999,
      );
    },
  );
});

describe("actual installed HTTP SDK onboarding verifier", () => {
  test.each(["account", "person", "team", "member", "credential"])(
    "initial %s refusal makes zero network reads and preserves config bytes",
    async (kind) => {
      const f = fixture();
      if (kind === "account") f.journal.account = "foreign-account";
      if (kind === "person") f.journal.membershipId = "foreign-person";
      if (kind === "team") f.journal.steps = [];
      if (kind === "member" || kind === "credential") {
        const cfg = loadConfig(f.home)!;
        if (kind === "member") cfg.user!.role = "member";
        else delete cfg.key;
        saveConfig(f.home, cfg);
      }
      const before = readFileSync(configPathFor(f.home));
      expect((await f.run()).state).toBe("waiting");
      expect(f.calls).toHaveLength(0);
      expect(readFileSync(configPathFor(f.home))).toEqual(before);
    },
  );
  test("actual SDK0.13.1 normal HTTP transport verifies only existing mapping, with zero apply/config writes", async () => {
    assertInstalled0131();
    resetSdkCache();
    const actual = await loadHttpSdk();
    expect(typeof actual.createTenantClient).toBe("function");
    const f = fixture(),
      before = readFileSync(configPathFor(f.home));
    expect(await f.run()).toMatchObject({
      state: "done",
      evidence: { team, revision: 9, mappingRevision: 7, count: 5 },
    });
    expect(f.state.workflowCount).toBe(2);
    expect(f.state.meCount).toBe(3);
    expect(
      f.calls.every((c) => c.method === "GET" && c.init?.redirect === "error"),
    ).toBe(true);
    expect(
      f.calls.every(
        (c) =>
          new Headers(c.init?.headers).get("authorization") ===
          "Bearer ctc_user_private_fixture",
      ),
    ).toBe(true);
    expect(
      f.calls
        .filter((c) => c.url.pathname.endsWith("team-workflow"))
        .every((c) => c.url.search === "?team=team-one"),
    ).toBe(true);
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
    expect(f.adapter.act).toBeUndefined();
  });
  test("missing fresh route advertisement makes zero workflow GETs", async () => {
    const f = fixture();
    f.state.advertised = false;
    expect(await f.run()).toMatchObject({
      state: "waiting",
      reason: "cloud_capability_unavailable",
    });
    expect(f.state.workflowCount).toBe(0);
    expect(f.calls.map((c) => c.url.pathname)).toEqual([
      "/api/v1/me",
      "/api/v1/agent/contract",
    ]);
  });
  test("a real optional null mapping row is not counted as mapped", async () => {
    const f = fixture();
    const body = {
      ...f.state.workflow,
      rows: [
        ...f.state.workflow.rows,
        { slot: "research", linearStateId: null, source: "chosen" },
      ],
    };
    const original = f.ctx.fetch;
    f.ctx.fetch = async (input, init) =>
      new URL(String(input)).pathname.endsWith("team-workflow")
        ? Response.json(body)
        : original(input, init);
    expect(await f.run()).toMatchObject({
      state: "done",
      evidence: { count: 5 },
    });
  });
  test.each(["mappingHash", "mappingRevision", "readinessRevision"])(
    "changed second %s observation never becomes done",
    async (field) => {
      const f = fixture();
      f.state.second = wire(f.state.now);
      if (field === "mappingHash") f.state.second.mappingHash = "b".repeat(64);
      if (field === "mappingRevision") f.state.second.config.workflowRev++;
      if (field === "readinessRevision") f.state.second.readiness.workflowRev++;
      expect(await f.run()).toMatchObject({
        state: "waiting",
        reason: "workflow_mapping_changed",
      });
    },
  );
  test.each(["account", "person", "role", "origin", "bytes", "team"])(
    "%s switch after fresh capability refuses before workflow GET",
    async (kind) => {
      const f = fixture();
      f.state.afterContract = () => {
        if (kind === "team")
          f.journal.steps[0]!.evidence = { team: "foreign-team" };
        else if (kind === "bytes")
          writeFileSync(
            configPathFor(f.home),
            readFileSync(configPathFor(f.home), "utf8") + "\n",
          );
        else {
          const cfg = loadConfig(f.home)!;
          if (kind === "account") cfg.account = "foreign-account";
          if (kind === "person") cfg.user!.id = "foreign-person";
          if (kind === "role") cfg.user!.role = "member";
          if (kind === "origin") cfg.baseUrl = "https://foreign.example.test";
          saveConfig(f.home, cfg);
        }
      };
      expect((await f.run()).state).toBe("waiting");
      expect(f.state.workflowCount).toBe(0);
    },
  );
  test("live remote role revoked during final workflow body is caught by final actual /me", async () => {
    const f = fixture();
    f.state.afterWorkflow = (count) => {
      if (count === 2) f.state.me.user!.role = "member";
    };
    expect(await f.run()).toMatchObject({
      state: "waiting",
      reason: "workflow_identity_unverified",
    });
    expect(f.state.meCount).toBe(3);
  });
  test("config changes during final verified display refuse before publishing done evidence", async () => {
    const f = fixture();
    f.state.message = (text) => {
      if (text.includes("are verified")) {
        const cfg = loadConfig(f.home)!;
        cfg.user!.id = "foreign-person";
        saveConfig(f.home, cfg);
      }
    };
    expect(await f.run()).toMatchObject({
      state: "waiting",
      reason: "workflow_identity_unverified",
    });
  });
  test("original OAuth expiry after final workflow read refuses without refresh or token/config publication", async () => {
    const f = fixture(),
      config = loadConfig(f.home)!;
    delete config.key;
    config.auth = {
      kind: "oauth",
      sessionId: "private-session",
      accessToken: "private-access",
      refreshToken: "private-refresh",
      expiresAt: new Date(f.state.now + 31_000).toISOString(),
    };
    saveConfig(f.home, config);
    const before = readFileSync(configPathFor(f.home));
    f.state.afterWorkflow = (count) => {
      if (count === 2) f.state.now += 32_000;
    };
    expect((await f.run()).state).toBe("waiting");
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
  });
  test.each(["dead-state", "malformed-stage", "missing-labels"])(
    "actual SDK %s result remains waiting",
    async (kind) => {
      const f = fixture();
      if (kind === "dead-state")
        f.state.workflow.rows[0]!.stateStillExists = false;
      if (kind === "malformed-stage") {
        // Use the recorded SDK route while returning a stage without required fields.
        Reflect.deleteProperty(f.state.workflow.stages[0]!, "name");
        Reflect.deleteProperty(f.state.workflow.stages[0]!, "position");
      }
      if (kind === "missing-labels")
        f.state.workflow.readiness.checks =
          f.state.workflow.readiness.checks.filter(
            (check) => check.id !== "labels_present",
          );
      expect(await f.run()).toMatchObject({
        state: "waiting",
        reason: "workflow_mapping_unverified",
      });
      expect(
        f.calls.filter((call) => call.url.pathname.endsWith("team-workflow")),
      ).toHaveLength(1);
    },
  );
});

test("actual native 30s body deadline joins real cancel/socket closure and held cleanup ACK before canonical unlock", async () => {
  assertInstalled0131();
  const f = fixture(),
    entered = deferred<void>(),
    cancelled = deferred<void>(),
    release = deferred<void>(),
    socketClosed = deferred<void>();
  releases.push(() => release.resolve());
  const sockets = new Set<Socket>();
  const native = globalThis.fetch;
  const actualCancels: Promise<void>[] = [];
  const server = createServer((request, response) => {
    response.setHeader("connection", "close");
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path.endsWith("team-workflow")) {
      request.socket.once("close", () => socketClosed.resolve());
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write(" ");
      entered.resolve();
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(path.endsWith("/me") ? f.me : f.contract()));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  disposals.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing native private listener");
  f.ctx.fetch = async (input, init) => {
    const logical = new URL(String(input));
    if (logical.origin !== origin)
      throw new Error("logical HTTPS scope changed");
    const response = await native(
      `http://127.0.0.1:${address.port}${logical.pathname}${logical.search}`,
      init,
    );
    if (logical.pathname.endsWith("team-workflow") && response.body) {
      const getReader: () => ReadableStreamDefaultReader<Uint8Array> =
        response.body.getReader;
      const actualReader = getReader.bind(response.body);
      Object.defineProperty(response.body, "getReader", {
        value: () => {
          const reader = actualReader(),
            cancel = reader.cancel.bind(reader);
          Object.defineProperty(reader, "cancel", {
            value: (reason?: unknown) => {
              const actual = cancel(reason);
              actualCancels.push(actual);
              cancelled.resolve();
              return actual.then(() => release.promise);
            },
          });
          return reader;
        },
      });
    }
    return response;
  };
  const statePath = onboardStatePath(f.home);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(f.journal));
  const before = readFileSync(configPathFor(f.home)),
    started = Date.now();
  // Internal test composition only. Real command lock plus real verifier; no machine readiness or provider proof.
  const task = cmdOnboard(
    parseArgs(["onboard", "--only", "machine", "--yes"]),
    { ...f.ctx, stdout: () => {} },
    {
      signal: f.stop.signal,
      bindSignals: false,
      identity: async () => ({
        account: f.me.account,
        membershipId: f.me.user!.id,
        baseUrl: origin,
        role: "owner",
      }),
      adapters: {
        machine: {
          check: async (ctx, journal, signal) => {
            f.state.now = Date.now();
            return f.adapter.check(ctx, journal, signal);
          },
        },
      },
    },
  );
  void task.catch(() => {});
  joins.push(task);
  let finished = false;
  void task
    .finally(() => {
      finished = true;
    })
    .catch(() => {});
  await entered.promise;
  const owner = JSON.parse(
    readFileSync(join(onboardLockPath(f.home), "owner.json"), "utf8"),
  );
  expect(owner.pid).toBe(process.pid);
  await cancelled.promise;
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(27_000);
  expect(elapsed).toBeLessThanOrEqual(35_000);
  expect(actualCancels).toHaveLength(1);
  await actualCancels[0];
  await socketClosed.promise;
  expect(finished).toBe(false);
  expect(existsSync(onboardLockPath(f.home))).toBe(true);
  expect(
    JSON.parse(
      readFileSync(join(onboardLockPath(f.home), "owner.json"), "utf8"),
    ),
  ).toEqual(owner);
  release.resolve();
  expect(await task).toBe(11);
  expect(existsSync(onboardLockPath(f.home))).toBe(false);
  expect(readFileSync(configPathFor(f.home))).toEqual(before);
  console.info(
    JSON.stringify({
      control: "workflow-native-body-deadline",
      elapsedMs: elapsed,
      actualCancelCount: actualCancels.length,
      nativeSocketClosed: true,
    }),
  );
}, 45_000);
