import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeConfig, type Ctx, type CustomerConfig } from "../src/config.js";
import {
  dockerRunnerEngine,
  onboardRunnerAdapter,
  RUNNER_HOST_IMAGES,
  runnerDefaultHostName,
  type RunnerEngine,
  type RunnerEngineInfo,
} from "../src/onboard-runner.js";
import type { OnboardJournal } from "../src/onboard.js";

const now = new Date("2026-10-02T12:00:00.000Z");
const SUPERVISOR = `ghcr.io/coalesce-labs/catalyst-supervisor@sha256:${"a".repeat(64)}`;
const WATCHDOG = `ghcr.io/coalesce-labs/catalyst-deadline-watchdog@sha256:${"b".repeat(64)}`;
const RUNNER = `registry.cloudflare.com/acct/catalyst-runner@sha256:${"c".repeat(64)}`;
const JOIN_TOKEN = "cjt_fixture_join_secret";
const ORG_KEY = "ctc_org_fixture_secret";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

interface FakeEngine extends RunnerEngine {
  calls: string[];
  images: Map<string, string>;
  networkState: "ready" | "missing" | "misshaped";
  running: boolean;
  files: Map<string, string>;
  upError: boolean;
}
function fakeEngine(
  info: RunnerEngineInfo | null = { arch: "arm64", vm: true },
): FakeEngine {
  const engine: FakeEngine = {
    calls: [],
    images: new Map([
      [SUPERVISOR, "arm64"],
      [WATCHDOG, "arm64"],
      [RUNNER, "arm64"],
    ]),
    networkState: "missing",
    running: false,
    files: new Map(),
    upError: false,
    info: async () => {
      engine.calls.push("info");
      return info;
    },
    imageArch: async (ref) => {
      engine.calls.push(`imageArch ${ref}`);
      return engine.images.get(ref) ?? null;
    },
    pull: async (ref) => {
      engine.calls.push(`pull ${ref}`);
      return false;
    },
    network: async () => engine.networkState,
    createNetwork: async (name) => {
      engine.calls.push(`createNetwork ${name}`);
      engine.networkState = "ready";
      return true;
    },
    socketGid: async () => 991,
    claimDirs: async (dir, paths) => {
      engine.calls.push(`claimDirs ${paths.length}`);
      return true;
    },
    hasVolumeFile: async (_dir, variable) => engine.files.has(variable),
    writeVolumeFile: async (_dir, variable, value) => {
      engine.calls.push(`writeVolumeFile ${variable}`);
      engine.files.set(variable, value);
      return true;
    },
    composeUp: async () => {
      engine.calls.push("composeUp");
      if (engine.upError) return false;
      engine.running = true;
      return true;
    },
    composeRunning: async () => engine.running,
  };
  return engine;
}

interface Host {
  hostId: string;
  hostName: string;
  team: string;
  enrollmentKind: string;
  revokedAtMs: number | null;
  capability: {
    placeableCapacity: number;
    runtimeLive: boolean;
    failingRequired: string[];
    receivedAtMs: number;
  } | null;
}

function fixture(
  options: {
    role?: "owner" | "admin" | "member";
    engine?: FakeEngine;
    selected?: boolean;
    choose?: () => Promise<boolean | null>;
    env?: NodeJS.ProcessEnv;
    hostRoutes?: boolean;
  } = {},
) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "onboard-runner-"));
  homes.push(home);
  const config: CustomerConfig = {
    baseUrl: "https://cloud.example.test",
    account: "account-a",
    slug: "a",
    name: "Private Workspace",
    permissions: ["mirror:read", "mirror:write"],
    principal: "service",
    key: "ctc_user_fixture_secret",
    user: {
      id: "person-a",
      role: options.role ?? "owner",
      label: "Private Person",
      email: "private@example.test",
      linearUserId: null,
    },
    joinedAt: now.toISOString(),
    lastSkillBundleVersion: "fixture",
  };
  writeConfig(home, config);
  const journal: OnboardJournal = {
    schema: 1,
    runId: "runner-run",
    cli: "fixture",
    installer: null,
    tenant: "account-a",
    account: "account-a",
    membershipId: "person-a",
    baseUrl: config.baseUrl,
    exit: null,
    steps: [
      {
        id: "linear.team",
        state: "done",
        evidence: { team: "team-a", teamKey: "A" },
      },
    ],
    changes: [],
  };
  const routes = [
    {
      method: "GET",
      path: "/api/v1/me/runner-capacity",
      personalBearer: true,
    },
    ...(options.hostRoutes === false
      ? []
      : [
          {
            method: "GET",
            path: "/api/v1/hosts/enrollments",
            personalBearer: true,
          },
          {
            method: "POST",
            path: "/api/v1/hosts/join-tokens",
            personalBearer: true,
          },
        ]),
  ];
  const state = {
    hosts: [] as Host[],
    admission: true,
    // A host enrolls as soon as its supervisor starts with a minted token.
    enrollOnUp: true as boolean,
    capability: {
      placeableCapacity: 2,
      runtimeLive: true,
      failingRequired: [] as string[],
      receivedAtMs: now.getTime(),
    } as Host["capability"],
    mints: [] as unknown[],
  };
  const engine = options.engine ?? fakeEngine();
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe(config.baseUrl);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer ctc_user_fixture_secret",
    );
    expect(new Headers(init?.headers).get("origin")).toBeNull();
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/v1/agent/contract")
      return Response.json({
        contractVersion: "2.3.0",
        account: { id: "account-a" },
        onboarding: {
          schema: 1,
          routes,
          web: {
            connections: "/a/account/connections",
            personalConnections: "/settings/connected-accounts",
          },
        },
      });
    if (url.pathname === "/api/v1/me")
      return Response.json({
        account: config.account,
        principal: config.principal,
        permissions: config.permissions,
        user: config.user,
        name: config.name,
        slug: config.slug,
      });
    if (url.pathname === "/api/v1/agent/teams")
      return Response.json({
        teams: [{ teamId: "team-a", teamKey: "A", teamName: "Team A" }],
        liveTeamRead: { error: null },
      });
    if (url.pathname === "/api/v1/hosts/enrollments" && method === "GET") {
      if (state.enrollOnUp && engine.running && state.mints.length > 0) {
        const minted = state.mints[state.mints.length - 1] as {
          hostName: string;
        };
        if (!state.hosts.some((h) => h.hostName === minted.hostName))
          state.hosts.push({
            hostId: "host-1",
            hostName: minted.hostName,
            team: "A",
            enrollmentKind: "self_hosted",
            revokedAtMs: null,
            capability: state.capability,
          });
      }
      return Response.json({ hosts: state.hosts });
    }
    if (url.pathname === "/api/v1/hosts/join-tokens" && method === "POST") {
      state.mints.push(JSON.parse(String(init?.body)));
      return Response.json(
        {
          ok: true,
          tokenId: "tok-1",
          joinToken: JOIN_TOKEN,
          expiresAtMs: now.getTime() + 3_600_000,
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/api/v1/me/runner-capacity")
      return Response.json({
        status: "ok",
        scope: "mapped-team-defaults",
        observedAtMs: now.getTime(),
        buckets: [
          {
            repoId: "repo-a",
            effectiveLimit: 3,
            occupiedUnits: 0,
            teams: [
              {
                teamKey: "A",
                configuredLimit: null,
                defaultLimit: 3,
                effectiveTeamLimit: 3,
                source: "default",
                paused: false,
                admissionEnabled: state.admission,
                remainingUnits: state.admission ? 3 : null,
              },
            ],
          },
        ],
      });
    return new Response(null, { status: 404 });
  };
  const output: string[] = [];
  const ctx: Ctx = {
    home,
    env: {
      CATALYST_STATE_DIR: join(home, "state"),
      ...(options.env ?? {
        CATALYST_SUPERVISOR_IMAGE: SUPERVISOR,
        CATALYST_WATCHDOG_IMAGE: WATCHDOG,
        CATALYST_RUNNER_IMAGE: RUNNER,
      }),
    },
    fetch: fetchImpl,
    now: () => now,
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
  };
  const messages: string[] = [];
  let asked = 0;
  const adapter = onboardRunnerAdapter({
    selected: options.selected,
    choose: options.choose
      ? async () => {
          asked++;
          return options.choose!();
        }
      : undefined,
    engine,
    hostName: () => "catalyst-laptop",
    sleep: async () => {},
    waitMs: 20_000,
    pollMs: 5_000,
    message: (line) => messages.push(line),
  });
  const dir = join(home, "state", "runner");
  const results: unknown[] = [];
  return {
    results,
    home,
    dir,
    journal,
    state,
    engine,
    requests,
    output,
    messages,
    ctx,
    adapter,
    asked: () => asked,
  };
}

/** What the engine does: check, then act on pending, then check again. */
async function run(f: ReturnType<typeof fixture>) {
  const first = await f.adapter.check(f.ctx, f.journal);
  f.results.push(first);
  if (first.state !== "pending" || !f.adapter.act) return first;
  const acted = await f.adapter.act(f.ctx, f.journal);
  f.results.push(acted);
  const last = acted.state === "done" ? await f.adapter.check(f.ctx, f.journal) : acted;
  f.results.push(last);
  return last;
}

function secretsNowhere(f: ReturnType<typeof fixture>) {
  // What reaches the terminal, the receipt (every step result) and the engine's call log.
  const visible = [
    ...f.messages,
    ...f.output,
    ...f.engine.calls,
    JSON.stringify(f.results),
  ].join("\n");
  expect(visible).not.toContain(JOIN_TOKEN);
  expect(visible).not.toContain(ORG_KEY);
  expect(visible).not.toContain("ctc_user_fixture_secret");
}

describe("opting in", () => {
  test("without a choice and without a terminal it is skipped and touches nothing", async () => {
    const f = fixture();
    expect(await run(f)).toEqual({
      state: "skipped",
      reason: "runner_not_selected",
    });
    expect(f.engine.calls).toEqual([]);
    expect(f.requests).toEqual([]);
    expect(existsSync(f.dir)).toBe(false);
  });

  test("--no-runner wins over the question", async () => {
    const f = fixture({ selected: false, choose: async () => true });
    expect((await run(f)).reason).toBe("runner_not_selected");
    expect(f.asked()).toBe(0);
  });

  test("the question defaults to no", async () => {
    const f = fixture({ choose: async () => false });
    expect((await run(f)).reason).toBe("runner_not_selected");
    expect(f.asked()).toBe(1);
    expect(f.engine.calls).toEqual([]);
  });

  test("a cancelled question is not a yes", async () => {
    const f = fixture({ choose: async () => null });
    expect((await run(f)).reason).toBe("runner_not_selected");
  });

  test("a yes is asked once per run and remembered in the receipt", async () => {
    const f = fixture({ choose: async () => true });
    const result = await run(f);
    expect(result.reason).toBe("runner_org_key_missing");
    expect(f.asked()).toBe(1);
    expect(result.evidence?.selected).toBe(true);
    // A later run reads the saved choice instead of asking again.
    const later = fixture({ choose: async () => false });
    later.journal.steps.push({
      id: "runner",
      state: "waiting",
      reason: "runner_org_key_missing",
      evidence: { selected: true },
    });
    await later.adapter.check(later.ctx, later.journal);
    expect(later.asked()).toBe(0);
  });

  test("an earlier no is not asked again without the flag", async () => {
    const f = fixture({ choose: async () => true });
    f.journal.steps.push({
      id: "runner",
      state: "skipped",
      reason: "runner_not_selected",
      evidence: { selected: false },
    });
    expect((await run(f)).reason).toBe("runner_not_selected");
    expect(f.asked()).toBe(0);
  });
});

describe("prerequisites", () => {
  test("no Docker engine is said plainly and skipped, with nothing written", async () => {
    const f = fixture({ selected: true, engine: fakeEngine(null) });
    expect(await run(f)).toEqual({
      state: "skipped",
      reason: "runner_docker_missing",
      evidence: { selected: true },
    });
    expect(existsSync(f.dir)).toBe(false);
    expect(f.requests).toEqual([]);
  });

  test("a member cannot enroll a host", async () => {
    const f = fixture({ selected: true, role: "member" });
    expect((await run(f)).reason).toBe("runner_identity_unverified");
    expect(f.state.mints).toEqual([]);
  });

  test("a server that does not advertise the host routes waits before any local change", async () => {
    const f = fixture({ selected: true, hostRoutes: false });
    expect((await run(f)).reason).toBe("cloud_capability_unavailable");
    expect(existsSync(f.dir)).toBe(false);
    expect(f.engine.calls).toEqual(["info"]);
  });

  test("missing images are pulled without credentials, and stop the step before a token is minted", async () => {
    const engine = fakeEngine();
    engine.images.delete(SUPERVISOR);
    const f = fixture({ selected: true, engine });
    const result = await run(f);
    expect(result).toMatchObject({
      state: "waiting",
      reason: "runner_images_unavailable",
      evidence: { selected: true, image: SUPERVISOR },
    });
    expect(engine.calls).toContain(`pull ${SUPERVISOR}`);
    expect(f.state.mints).toEqual([]);
    expect(engine.calls).not.toContain("composeUp");
  });

  test("the default host images are digest-pinned", () => {
    for (const ref of Object.values(RUNNER_HOST_IMAGES))
      expect(ref).toMatch(/^ghcr\.io\/coalesce-labs\/[a-z-]+@sha256:[0-9a-f]{64}$/);
  });

  test("without a runner image pin it waits and names the variable", async () => {
    const f = fixture({ selected: true, env: {} });
    expect((await run(f)).reason).toBe("runner_image_unpinned");
    expect(f.state.mints).toEqual([]);
  });

  test("an image reference that is not digest-pinned is refused", async () => {
    const f = fixture({
      selected: true,
      env: {
        CATALYST_SUPERVISOR_IMAGE: "ghcr.io/coalesce-labs/catalyst-supervisor:latest",
        CATALYST_WATCHDOG_IMAGE: WATCHDOG,
        CATALYST_RUNNER_IMAGE: RUNNER,
      },
    });
    expect((await run(f)).reason).toBe("runner_image_unpinned");
  });

  test("a runner image for another architecture would be emulated, so it waits", async () => {
    const engine = fakeEngine();
    engine.images.set(RUNNER, "amd64");
    const f = fixture({ selected: true, engine });
    expect((await run(f)).reason).toBe("runner_image_emulated");
    expect(f.state.mints).toEqual([]);
  });
});

describe("bringing the host up", () => {
  function withOrgKey(f: ReturnType<typeof fixture>) {
    const file = join(f.home, "org-key");
    writeFileSync(file, `${ORG_KEY}\n`, { mode: 0o600 });
    f.ctx.env.CATALYST_RUNNER_ORG_KEY_FILE = file;
  }

  test("enrolls with the person's key, starts Compose and reports capacity", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    const result = await run(f);
    expect(result).toEqual({
      state: "done",
      evidence: {
        selected: true,
        hostName: "catalyst-laptop",
        hostId: "host-1",
        capacity: 2,
      },
    });
    expect(f.state.mints).toEqual([
      {
        version: 1,
        team: "A",
        enrollmentKind: "self_hosted",
        hostName: "catalyst-laptop",
        ttlMs: 3_600_000,
      },
    ]);
    expect(f.requests).toContain(
      "POST /api/v1/hosts/join-tokens?account=account-a",
    );
    expect(f.engine.calls).toContain("createNetwork catalyst-session-v1");
    expect(f.engine.calls).toContain("writeVolumeFile CATALYST_ORG_KEY_FILE");
    expect(f.engine.files.get("CATALYST_ORG_KEY_FILE")).toBe(ORG_KEY);
    expect(f.engine.calls).not.toContain("claimDirs 3");
    expect(f.messages.join("\n")).toContain("2 slots");
    secretsNowhere(f);

    const env = readFileSync(join(f.dir, ".env"), "utf8");
    expect(statSync(join(f.dir, ".env")).mode & 0o777).toBe(0o600);
    expect(env).toContain(`CATALYST_HOST_JOIN_TOKEN=${JOIN_TOKEN}\n`);
    expect(env).toContain("CATALYST_HOST_NAME=catalyst-laptop\n");
    expect(env).toContain("CATALYST_MIRROR_URL=https://cloud.example.test\n");
    expect(env).toContain(`CATALYST_SUPERVISOR_IMAGE=${SUPERVISOR}\n`);
    expect(env).toContain(`CATALYST_RUNNER_IMAGE=${RUNNER}\n`);
    expect(env).toContain("DOCKER_SOCKET_GID=0\n");
    expect(env).toContain(`CATALYST_SLOTS_DIR=${join(f.dir, "slots")}\n`);
    expect(statSync(join(f.dir, "slots")).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(f.dir, "compose.yaml"))).toEqual(
      readFileSync(join(__dirname, "..", "vendor", "self-host", "compose.yaml")),
    );
  });

  test("a rerun on an enrolled, running host mints nothing and changes nothing", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    const env = readFileSync(join(f.dir, ".env"), "utf8");
    f.engine.calls.length = 0;
    const again = await run(f);
    expect(again.state).toBe("done");
    expect(f.state.mints).toHaveLength(1);
    expect(f.engine.calls).not.toContain("composeUp");
    expect(readFileSync(join(f.dir, ".env"), "utf8")).toBe(env);
  });

  test("a native Linux engine gets its socket group and directories handed to the runner uid", async () => {
    const engine = fakeEngine({ arch: "amd64", vm: false });
    for (const ref of [SUPERVISOR, WATCHDOG, RUNNER]) engine.images.set(ref, "amd64");
    const f = fixture({ selected: true, engine });
    withOrgKey(f);
    await run(f);
    expect(readFileSync(join(f.dir, ".env"), "utf8")).toContain(
      "DOCKER_SOCKET_GID=991\n",
    );
    expect(engine.calls).toContain("claimDirs 3");
  });

  test("a saved yes alone only reports: an unattended run never restarts a stopped runner", async () => {
    const f = fixture();
    withOrgKey(f);
    f.journal.steps.push({
      id: "runner",
      state: "done",
      evidence: { selected: true },
    });
    expect(await run(f)).toMatchObject({
      state: "waiting",
      reason: "runner_needs_runner_flag",
    });
    expect(f.engine.calls).not.toContain("composeUp");
    expect(f.state.mints).toEqual([]);
    expect(existsSync(f.dir)).toBe(false);
  });

  test("a person's own .env settings survive a rerun, and do not count as drift", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    writeFileSync(
      join(f.dir, ".env"),
      `${readFileSync(join(f.dir, ".env"), "utf8")}CATALYST_SLOTS=4\n`,
    );
    f.engine.calls.length = 0;
    expect((await run(f)).state).toBe("done");
    expect(f.engine.calls).not.toContain("composeUp");
    // A key the step owns moves; the person's key stays.
    const newer = `ghcr.io/coalesce-labs/catalyst-supervisor@sha256:${"d".repeat(64)}`;
    f.engine.images.set(newer, "arm64");
    f.ctx.env.CATALYST_SUPERVISOR_IMAGE = newer;
    expect((await run(f)).state).toBe("done");
    expect(f.engine.calls).toContain("composeUp");
    const env = readFileSync(join(f.dir, ".env"), "utf8");
    expect(env).toContain(`CATALYST_SUPERVISOR_IMAGE=${newer}\n`);
    expect(env).toContain("CATALYST_SLOTS=4\n");
    expect(env).toContain(`CATALYST_HOST_JOIN_TOKEN=${JOIN_TOKEN}\n`);
    expect(f.state.mints).toHaveLength(1);
  });

  test("an unreadable organization key file is named as invalid, not as missing", async () => {
    const f = fixture({ selected: true });
    await run(f);
    const file = join(f.home, "org-key");
    writeFileSync(file, "two\nlines\n", { mode: 0o600 });
    f.ctx.env.CATALYST_RUNNER_ORG_KEY_FILE = file;
    expect((await run(f)).reason).toBe("runner_org_key_file_invalid");
  });

  test("the default host name carries a random suffix so two machines never share one", () => {
    const a = runnerDefaultHostName(),
      b = runnerDefaultHostName();
    expect(a).not.toBe(b);
    for (const name of [a, b]) expect(name).toMatch(/^catalyst-[A-Za-z0-9._-]+-[0-9a-f]{6}$/);
  });

  test("a misshaped session network is reported, never replaced", async () => {
    const engine = fakeEngine();
    engine.networkState = "misshaped";
    const f = fixture({ selected: true, engine });
    expect((await run(f)).reason).toBe("runner_session_network_misshaped");
    expect(engine.calls).not.toContain("createNetwork catalyst-session-v1");
    expect(f.state.mints).toEqual([]);
  });

  test("a Compose failure fails the step", async () => {
    const engine = fakeEngine();
    engine.upError = true;
    const f = fixture({ selected: true, engine });
    withOrgKey(f);
    expect(await run(f)).toMatchObject({
      state: "failed",
      reason: "runner_compose_failed",
    });
  });

  test("without an organization key the host still enrolls, and the step names the key it needs", async () => {
    const f = fixture({ selected: true });
    const result = await run(f);
    expect(result).toMatchObject({
      state: "waiting",
      reason: "runner_org_key_missing",
      evidence: { selected: true, hostName: "catalyst-laptop" },
    });
    expect(f.engine.calls).toContain("composeUp");
  });

  test("a host that never enrolls waits with the reason", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    f.state.enrollOnUp = false;
    expect((await run(f)).reason).toBe("runner_enrollment_unverified");
  });

  test("a host advertising zero capacity names its failing checks", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    f.state.capability = {
      placeableCapacity: 0,
      runtimeLive: true,
      failingRequired: ["host.session-network"],
      receivedAtMs: now.getTime(),
    };
    expect(await run(f)).toMatchObject({
      state: "waiting",
      reason: "runner_host_not_ready",
      evidence: { failing: "host.session-network", capacity: 0 },
    });
  });

  test("a ready host whose team does not admit hosts names the operator ask", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    f.state.admission = false;
    expect(await run(f)).toMatchObject({
      state: "waiting",
      reason: "runner_admission_operator",
      evidence: { capacity: 2, hostId: "host-1" },
    });
  });

  test("a host whose old enrollment was revoked is not silently re-enrolled over its stale credential", async () => {
    const f = fixture({ selected: true });
    withOrgKey(f);
    await run(f);
    f.state.hosts[0]!.revokedAtMs = now.getTime();
    f.engine.files.set("CATALYST_HOST_CREDENTIAL_FILE", "stale");
    expect((await run(f)).reason).toBe("runner_enrollment_stale");
    expect(f.state.mints).toHaveLength(1);
  });
});

describe("the Docker engine", () => {
  function recordingExec(answers: Record<string, { code: number; stdout?: string }> = {}) {
    const runs: Array<{
      args: string[];
      env: NodeJS.ProcessEnv;
      cwd?: string;
      input?: string;
    }> = [];
    return {
      runs,
      exec: async (
        args: string[],
        opts: { env: NodeJS.ProcessEnv; cwd?: string; input?: string },
      ) => {
        runs.push({ args, ...opts });
        const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
        return { code: key ? answers[key]!.code : 0, stdout: key ? (answers[key]!.stdout ?? "") : "" };
      },
    };
  }

  test("Compose runs in the runner directory with the caller's CATALYST_ variables removed", async () => {
    const r = recordingExec();
    const engine = dockerRunnerEngine({
      exec: r.exec,
      env: { PATH: "/bin", CATALYST_RUNNER_IMAGE: "other", DOCKER_HOST: "unix:///x.sock" },
    });
    expect(await engine.composeUp("/r")).toBe(true);
    expect(r.runs[0]!.args).toEqual([
      "compose",
      "--project-name",
      "catalyst-host",
      "--file",
      "/r/compose.yaml",
      "--env-file",
      "/r/.env",
      "up",
      "--detach",
    ]);
    expect(r.runs[0]!.cwd).toBe("/r");
    expect(r.runs[0]!.env).toEqual({ PATH: "/bin", DOCKER_HOST: "unix:///x.sock" });
  });

  test("handing folders to the runner uid gives root back only CHOWN", async () => {
    const r = recordingExec();
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    await engine.claimDirs("/r", ["/r/slots"]);
    const args = r.runs[0]!.args;
    expect(args.slice(args.indexOf("run"))).toEqual([
      "run",
      "--rm",
      "-T",
      "--no-deps",
      "--user",
      "0",
      "--cap-add",
      "CHOWN",
      "--entrypoint",
      "chown",
      "supervisor",
      "10001:10001",
      "/r/slots",
    ]);
  });

  test("a secret reaches the volume on stdin, never in arguments", async () => {
    const r = recordingExec();
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    await engine.writeVolumeFile("/r", "CATALYST_ORG_KEY_FILE", ORG_KEY);
    expect(r.runs[0]!.input).toBe(`${ORG_KEY}\n`);
    expect(r.runs[0]!.args.join(" ")).not.toContain(ORG_KEY);
    expect(r.runs[0]!.args.join(" ")).toContain('cat > "$CATALYST_ORG_KEY_FILE"');
  });

  test("info reads the engine architecture and whether it runs in a VM", async () => {
    const r = recordingExec({
      "info": {
        code: 0,
        stdout: JSON.stringify({ Architecture: "aarch64", OperatingSystem: "Docker Desktop", OSType: "linux" }),
      },
      "compose version": { code: 0, stdout: "v2.40.0" },
    });
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    expect(await engine.info()).toEqual({ arch: "arm64", vm: true });
  });

  test("no Docker CLI, no engine or no Compose plugin is no engine", async () => {
    const cases: Array<Record<string, { code: number; stdout?: string }>> = [
      { info: { code: 1 } },
      {
        info: { code: 0, stdout: JSON.stringify({ Architecture: "x86_64", OperatingSystem: "Ubuntu", OSType: "linux" }) },
        "compose version": { code: 1 },
      },
      { info: { code: 0, stdout: JSON.stringify({ Architecture: "x86_64", OSType: "windows" }) } },
    ];
    for (const answers of cases) {
      const engine = dockerRunnerEngine({ exec: recordingExec(answers).exec, env: {} });
      expect(await engine.info()).toBeNull();
    }
    const missing = dockerRunnerEngine({
      exec: async () => {
        throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
      },
      env: {},
    });
    expect(await missing.info()).toBeNull();
  });

  test("the session network is created with the isolated shape the supervisor checks", async () => {
    const r = recordingExec();
    const engine = dockerRunnerEngine({ exec: r.exec, env: {} });
    await engine.createNetwork("catalyst-session-v1");
    expect(r.runs[0]!.args).toEqual([
      "network",
      "create",
      "--driver=bridge",
      "--opt",
      "com.docker.network.bridge.enable_icc=false",
      "--opt",
      "com.docker.network.bridge.name=catalyst-sess0",
      "--label",
      "dev.catalystcloud.session-network=v1",
      "catalyst-session-v1",
    ]);
  });

  test("an existing network is ready only with icc off, the bridge name and the label", async () => {
    const shape = (icc: string, name: string, label: string | undefined) =>
      JSON.stringify([
        {
          Driver: "bridge",
          Internal: false,
          EnableIPv6: false,
          Options: {
            "com.docker.network.bridge.enable_icc": icc,
            "com.docker.network.bridge.name": name,
          },
          Labels: label ? { "dev.catalystcloud.session-network": label } : {},
        },
      ]);
    const at = (stdout: string, code = 0) =>
      dockerRunnerEngine({
        exec: recordingExec({ "network inspect": { code, stdout } }).exec,
        env: {},
      }).network("catalyst-session-v1");
    expect(await at(shape("false", "catalyst-sess0", "v1"))).toBe("ready");
    expect(await at(shape("true", "catalyst-sess0", "v1"))).toBe("misshaped");
    expect(await at(shape("false", "docker0", "v1"))).toBe("misshaped");
    expect(await at(shape("false", "catalyst-sess0", undefined))).toBe("misshaped");
    expect(await at("", 1)).toBe("missing");
  });

  test("a pull is a plain docker pull of the pinned reference", async () => {
    const r = recordingExec();
    const engine = dockerRunnerEngine({
      exec: r.exec,
      env: { DOCKER_CONFIG: "/home/x/.docker" },
    });
    await engine.pull(SUPERVISOR);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]!.args).toEqual(["pull", "--quiet", SUPERVISOR]);
  });
});

test("the vendored Compose file matches its recorded provenance", () => {
  const root = join(__dirname, "..", "vendor", "self-host");
  const manifest = JSON.parse(readFileSync(join(root, "provenance.json"), "utf8"));
  expect(
    createHash("sha256").update(readFileSync(join(root, "compose.yaml"))).digest("hex"),
  ).toBe(manifest.sha256["deploy/self-host/compose.yaml"]);
});
