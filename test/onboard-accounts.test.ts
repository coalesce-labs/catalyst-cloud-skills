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
import type { OnboardJournal } from "../src/onboard.js";
import type { OnboardUi } from "../src/onboard-ui.js";

const homes: string[] = [];
const origin = "https://accounts-fixture.invalid";
const now = Date.parse("2026-10-01T04:00:00Z");
const accountPath = "/api/v1/coding-accounts";
const validatePath = "/api/v1/coding-accounts/claude-one/validate";
interface Route {
  method: "GET" | "POST";
  path: string;
  personalBearer: boolean;
}
const routes = (): Route[] => [
  { method: "GET", path: accountPath, personalBearer: true },
  {
    method: "POST",
    path: "/api/v1/coding-accounts/:slot/validate",
    personalBearer: true,
  },
];
function slot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  // Match TenantWireAccount metadata, including nullable subscription facts. No credential DTO.
  return {
    accountSlot: "claude-one",
    provider: "claude",
    harness: "claude",
    label: "Fixture",
    declaredState: "active",
    observedState: "unobserved",
    observedStatus: "unobserved",
    status: "unobserved",
    renewalStatus: null,
    accessEndsAtMs: null,
    revokedAtMs: null,
    window5h: { usedPercent: null, resetsAtMs: null },
    window7d: { usedPercent: null, resetsAtMs: null },
    bindingWindow: null,
    bindingUsedPercent: null,
    bindingResetsAtMs: null,
    usageObservedAtMs: null,
    lastPolledAtMs: null,
    walled: false,
    quarantined: false,
    quarantineReason: null,
    pollFailureCount: 0,
    lastPollErrorCode: null,
    needsCredential: false,
    liveHoldsCount: 0,
    liveHolds: [],
    ownedByMe: true,
    ...overrides,
  };
}
interface State {
  routes: Route[];
  accounts: unknown;
  observedAtMs: number;
  validation: unknown;
  inventoryResponse?: () => Response;
  postResponse?: () => Promise<Response>;
  message?: (text: string) => void;
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "onboard-accounts-"));
  homes.push(home);
  const messages: string[] = [];
  const calls: Array<{ method: string; path: string; init?: RequestInit }> = [];
  let currentTime = now;
  const ctx: Ctx = {
    ...defaultCtx(),
    home,
    env: { CATALYST_CLOUD_TOKEN: "ctc_unused_ambient_synthetic" },
    now: () => new Date(currentTime),
    stdout: vi.fn(),
    stderr: vi.fn(),
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
    key: "ctc_person_synthetic",
    joinedAt: ctx.now().toISOString(),
    lastSkillBundleVersion: "0.14.6",
  });
  const journal: OnboardJournal = {
    schema: 1,
    runId: "accounts-fixture",
    cli: "0.14.6",
    installer: null,
    tenant: "account-a",
    account: "account-a",
    membershipId: "person-a",
    baseUrl: origin,
    steps: [],
    changes: [],
    exit: null,
  };
  const state: State = {
    routes: routes(),
    accounts: [slot()],
    observedAtMs: now,
    validation: { provider: "claude", result: "working", checkedAtMs: now },
  };
  ctx.fetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    expect(url.origin).toBe(origin);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer ctc_person_synthetic",
    );
    calls.push({ method, path: url.pathname, init });
    if (url.pathname === "/api/v1/agent/contract" && method === "GET")
      return Response.json({
        account: { id: "account-a" },
        contractVersion: "2.16.0",
        onboarding: {
          schema: 1,
          routes: state.routes,
          web: {
            connections: "/a/account/connections",
            personalConnections: "/settings/connected-accounts",
          },
        },
      });
    if (url.pathname === accountPath && method === "GET")
      return state.inventoryResponse
        ? state.inventoryResponse()
        : Response.json({
            accounts: state.accounts,
            observedAtMs: state.observedAtMs,
          });
    if (url.pathname === validatePath && method === "POST") {
      expect(init?.body).toBeUndefined();
      return state.postResponse
        ? state.postResponse()
        : Response.json(state.validation);
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  });
  const ui: OnboardUi = {
    signal: new AbortController().signal,
    plan: () => {},
    confirmPlan: async () => ({ proceed: false, localSync: false }),
    stepStart: () => {},
    stepEnd: () => {},
    finish: () => {},
    dispose: () => {},
    wait: async (_text, work) => work(),
    message: (text) => {
      messages.push(text);
      state.message?.(text);
    },
  };
  const makeAdapter = () => {
    const adapter = createOnboardRuntime(parseArgs(["onboard", "--yes"]), ctx, {
      ui,
      login: async () => {
        throw new Error("Unexpected login in accounts fixture");
      },
      ready: async () => ({ state: "waiting", reason: "fixture_unverified" }),
    }).adapters?.accounts;
    if (!adapter?.act) throw new Error("Real accounts runtime adapter missing");
    return adapter;
  };
  return {
    home,
    ctx,
    state,
    journal,
    messages,
    calls,
    adapter: makeAdapter(),
    makeAdapter,
    posts: () => calls.filter((call) => call.method === "POST"),
    configBytes: () => readFileSync(configPathFor(home)),
    setTime: (time: number) => {
      currentTime = time;
    },
  };
}
function switchConfig(home: string, dimension: string) {
  const cfg = loadConfig(home);
  if (!cfg?.user) throw new Error("Fixture personal config missing");
  if (dimension === "person") cfg.user.id = "person-replacement";
  if (dimension === "account") cfg.account = "account-replacement";
  if (dimension === "origin") cfg.baseUrl = "https://replacement.invalid";
  if (dimension === "role") cfg.user.role = "member";
  writeConfig(home, cfg);
}
function heldJson(value: unknown) {
  let enteredResolve = () => {};
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  let release = () => {};
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
  vi.spyOn(response, "json").mockImplementation(() => {
    enteredResolve();
    return json();
  });
  return { response, entered, release: () => release() };
}
afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("advertised accounts reads and one existing Claude probe", () => {
  test.each(["GET", "POST"])(
    "missing advertised %s prevents its real endpoint call",
    async (method) => {
      const f = fixture();
      f.state.routes = f.state.routes.filter(
        (route) => route.method !== method,
      );
      expect((await f.adapter.act!(f.ctx, f.journal)).reason).toBe(
        "cloud_capability_unavailable",
      );
      expect(f.posts()).toEqual([]);
      if (method === "GET")
        expect(f.calls.map((call) => call.path)).toEqual([
          "/api/v1/agent/contract",
        ]);
      else
        expect(f.calls.map((call) => call.path)).toEqual([
          "/api/v1/agent/contract",
          accountPath,
          "/api/v1/agent/contract",
        ]);
    },
  );
  test("advertisement with personalBearer false does not authorize the probe", async () => {
    const f = fixture();
    f.state.routes = routes().map((route) => ({
      ...route,
      personalBearer: route.method !== "POST",
    }));
    expect((await f.adapter.act!(f.ctx, f.journal)).state).toBe("waiting");
    expect(f.posts()).toEqual([]);
  });
  test("working proof needs the real post-act inventory check and never uses cached receipt proof", async () => {
    const f = fixture();
    const before = f.configBytes();
    f.state.accounts = [
      slot({
        accessToken: "hidden-provider-token",
        enrolledEmail: "hidden@example.invalid",
      }),
    ];
    f.state.validation = {
      provider: "claude",
      result: "working",
      checkedAtMs: now,
      token: "hidden-provider-token",
    };
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({
      state: "pending",
    });
    const result = await f.adapter.act!(f.ctx, f.journal);
    expect(result).toEqual({
      state: "done",
      evidence: {
        accountSlot: "claude-one",
        provider: "claude",
        checkedAt: new Date(now).toISOString(),
      },
    });
    expect(f.calls.slice(-2).map((call) => call.path)).toEqual([
      "/api/v1/agent/contract",
      accountPath,
    ]);
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual(result);
    expect(f.posts()).toHaveLength(1);
    const serialized = JSON.stringify([result, f.messages]);
    expect(serialized).not.toContain("hidden-provider-token");
    expect(serialized).not.toContain("hidden@example.invalid");
    expect(serialized).not.toContain("ctc_unused_ambient_synthetic");
    expect(f.messages.join("\n")).toContain("one-token provider request");
    expect(f.messages.join("\n")).toContain("does not reserve a runner");
    f.journal.steps = [
      { id: "accounts", state: "done", evidence: result.evidence },
    ];
    expect(await f.makeAdapter().check(f.ctx, f.journal)).toEqual({
      state: "pending",
    });
    expect(f.posts()).toHaveLength(1);
    expect(f.configBytes()).toEqual(before);
  });
  test.each([
    { result: "walled", reason: "account_provider_walled" },
    { result: "rejected", reason: "account_provider_rejected" },
    { result: "inconclusive", reason: "account_provider_access_unverified" },
  ])(
    "$result spends exactly one attempt and never produces proof",
    async (outcome) => {
      const f = fixture();
      f.state.validation = {
        provider: "claude",
        result: outcome.result,
        checkedAtMs: now,
      };
      expect(await f.adapter.act!(f.ctx, f.journal)).toEqual({
        state: "waiting",
        reason: outcome.reason,
      });
      expect((await f.adapter.check(f.ctx, f.journal)).state).toBe("waiting");
      expect((await f.adapter.act!(f.ctx, f.journal)).state).toBe("waiting");
      expect(f.posts()).toHaveLength(1);
    },
  );

  test("exactly 1000 distinct valid slots still selects only one Claude probe", async () => {
    const f = fixture();
    f.state.accounts = [
      slot(),
      ...Array.from({ length: 999 }, (_, index) =>
        slot({ accountSlot: `zzz-claude-${index}` }),
      ),
    ];
    expect((await f.adapter.act!(f.ctx, f.journal)).state).toBe("done");
    expect(f.posts()).toHaveLength(1);
    expect(f.posts()[0]?.path).toBe(validatePath);
  });
  test("no slots requires enrollment without provider or credential requests", async () => {
    const f = fixture();
    f.state.accounts = [];
    expect(await f.adapter.check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "account_enrollment_required",
    });
    expect(f.posts()).toEqual([]);
  });
  test("fresh inventory cannot extend expired in-memory provider proof", async () => {
    const f = fixture();
    expect((await f.adapter.act!(f.ctx, f.journal)).state).toBe("done");
    f.setTime(now + 30001);
    f.state.observedAtMs = now + 30001;
    expect((await f.adapter.check(f.ctx, f.journal)).state).toBe("waiting");
    expect(f.posts()).toHaveLength(1);
  });
  test.each([401, 500, null])(
    "HTTP/transport failure %s never exposes raw errors or retries",
    async (status) => {
      const f = fixture();
      f.state.postResponse = async () => {
        if (status === null) throw new Error("hidden-provider-error-token");
        return Response.json(
          { error: "hidden-provider-error-token" },
          { status },
        );
      };
      expect((await f.adapter.act!(f.ctx, f.journal)).reason).toBe(
        "account_validation_unavailable",
      );
      expect((await f.adapter.act!(f.ctx, f.journal)).state).toBe("waiting");
      expect(f.posts()).toHaveLength(1);
      expect(f.messages.join("\n")).not.toContain(
        "hidden-provider-error-token",
      );
    },
  );

  test("success is invalidated by a fresh revoked inventory without another probe", async () => {
    const f = fixture();
    expect((await f.adapter.act!(f.ctx, f.journal)).state).toBe("done");
    f.state.accounts = [slot({ revokedAtMs: now })];
    expect((await f.adapter.check(f.ctx, f.journal)).state).toBe("waiting");
    expect((await f.adapter.act!(f.ctx, f.journal)).state).toBe("waiting");
    expect(f.posts()).toHaveLength(1);
  });
});

describe("account metadata cannot substitute for provider access", () => {
  test.each([
    { declaredState: "inactive" },
    { ownedByMe: false },
    { needsCredential: true },
    { walled: true },
    { quarantined: true },
    { revokedAtMs: 0 },
    { renewalStatus: "canceled", accessEndsAtMs: now + 86400000 },
    { accessEndsAtMs: now },
  ])("excluded slot %# has no provider request", async (change) => {
    const f = fixture();
    f.state.accounts = [slot(change)];
    expect((await f.adapter.check(f.ctx, f.journal)).state).toBe("waiting");
    expect((await f.adapter.act!(f.ctx, f.journal)).state).toBe("waiting");
    expect(f.posts()).toEqual([]);
  });
  test("canceled Codex never triggers validation, enrollment or credential rotation", async () => {
    const f = fixture();
    const before = f.configBytes();
    f.state.accounts = [
      slot({
        provider: "codex",
        renewalStatus: "canceled",
        accessEndsAtMs: now - 1,
      }),
    ];
    expect((await f.adapter.check(f.ctx, f.journal)).reason).toBe(
      "codex_provider_access_unverified",
    );
    expect((await f.adapter.act!(f.ctx, f.journal)).state).toBe("waiting");
    expect(f.posts()).toEqual([]);
    expect(
      f.calls.every(
        (call) =>
          call.path === accountPath || call.path === "/api/v1/agent/contract",
      ),
    ).toBe(true);
    expect(f.configBytes()).toEqual(before);
  });
  test.each([
    { renewalStatus: "unknown" },
    { revokedAtMs: "0" },
    { accessEndsAtMs: "tomorrow" },
    { declaredState: "disabled" },
  ])(
    "malformed nullable/declared metadata %# refuses the inventory",
    async (change) => {
      const f = fixture();
      f.state.accounts = [slot(change)];
      expect((await f.adapter.act!(f.ctx, f.journal)).reason).toBe(
        "account_inventory_unverified",
      );
      expect(f.posts()).toEqual([]);
    },
  );
  test.each(["duplicate", "over-limit", "future", "stale"])(
    "%s inventory cannot grant a probe",
    async (kind) => {
      const f = fixture();
      if (kind === "duplicate") f.state.accounts = [slot(), slot()];
      if (kind === "over-limit")
        f.state.accounts = Array.from({ length: 1001 }, (_, index) =>
          slot({ accountSlot: `claude-${index}` }),
        );
      if (kind === "future") f.state.observedAtMs = now + 5001;
      if (kind === "stale") f.state.observedAtMs = now - 30001;
      expect((await f.adapter.act!(f.ctx, f.journal)).reason).toBe(
        "account_inventory_unverified",
      );
      expect(f.posts()).toEqual([]);
    },
  );
  test.each([
    { provider: "codex", result: "working", checkedAtMs: now },
    { provider: "claude", result: "working", checkedAtMs: now + 5001 },
    { provider: "claude", result: "working", checkedAtMs: now - 30001 },
    { provider: "claude", result: "unexpected", checkedAtMs: now },
  ])("validation result %# cannot become fresh proof", async (validation) => {
    const f = fixture();
    f.state.validation = validation;
    expect((await f.adapter.act!(f.ctx, f.journal)).reason).toBe(
      "account_validation_unverified",
    );
    expect((await f.adapter.check(f.ctx, f.journal)).state).toBe("waiting");
    expect(f.posts()).toHaveLength(1);
  });
});

describe("identity and cancellation guard the actual quota-consuming send", () => {
  test.each(["person", "account", "origin", "role"])(
    "queued %s switch prevents the actual POST",
    async (dimension) => {
      const f = fixture();
      const beforeJournal = JSON.stringify(f.journal);
      f.state.message = (text) => {
        if (text.startsWith("Checking one stored"))
          queueMicrotask(() => switchConfig(f.home, dimension));
      };
      expect(await f.adapter.act!(f.ctx, f.journal)).toEqual({
        state: "waiting",
        reason: "account_identity_unverified",
      });
      expect(f.posts()).toEqual([]);
      expect(JSON.stringify(f.journal)).toBe(beforeJournal);
    },
  );
  test.each(["person", "account", "origin", "role"])(
    "%s switch during native GET body prevents a probe",
    async (dimension) => {
      const f = fixture();
      const held = heldJson({ accounts: [slot()], observedAtMs: now });
      f.state.inventoryResponse = () => held.response;
      const pending = f.adapter.act!(f.ctx, f.journal);
      await held.entered;
      switchConfig(f.home, dimension);
      held.release();
      const replacement = f.configBytes();
      expect((await pending).reason).toBe("account_identity_unverified");
      expect(f.posts()).toEqual([]);
      expect(f.configBytes()).toEqual(replacement);
    },
  );
  test.each(["person", "account", "origin", "role"])(
    "%s switch during native POST body prevents done proof",
    async (dimension) => {
      const f = fixture();
      const held = heldJson(f.state.validation);
      f.state.postResponse = async () => held.response;
      const pending = f.adapter.act!(f.ctx, f.journal);
      await held.entered;
      switchConfig(f.home, dimension);
      held.release();
      const replacement = f.configBytes();
      const result = await pending;
      expect(result).toEqual({
        state: "waiting",
        reason: "account_identity_unverified",
      });
      expect(result.evidence).toBeUndefined();
      expect(f.posts()).toHaveLength(1);
      expect(f.configBytes()).toEqual(replacement);
      expect(f.messages.join("\n")).not.toContain(
        "provider access was verified",
      );
    },
  );
  test("a queued stop from the display callback prevents the actual POST", async () => {
    const f = fixture();
    const stop = new AbortController();
    f.state.message = (text) => {
      if (text.startsWith("Checking one stored"))
        queueMicrotask(() => stop.abort());
    };
    expect(await f.adapter.act!(f.ctx, f.journal, stop.signal)).toEqual({
      state: "waiting",
      reason: "interrupted",
    });
    expect(f.posts()).toEqual([]);
  });
  test("abort during a native validation body never records late success or retries", async () => {
    const f = fixture();
    const stop = new AbortController();
    const held = heldJson(f.state.validation);
    f.state.postResponse = async () => held.response;
    const pending = f.adapter.act!(f.ctx, f.journal, stop.signal);
    await held.entered;
    stop.abort();
    expect(await pending).toEqual({ state: "waiting", reason: "interrupted" });
    held.release();
    await Promise.resolve();
    await Promise.resolve();
    expect((await f.adapter.act!(f.ctx, f.journal)).state).toBe("waiting");
    expect(f.posts()).toHaveLength(1);
    expect(f.messages.join("\n")).not.toContain("provider access was verified");
  });
  test("the real 15s validation deadline refuses an ignoring native body", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const held = heldJson(f.state.validation);
    f.state.postResponse = async () => held.response;
    const pending = f.adapter.act!(f.ctx, f.journal);
    await held.entered;
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toEqual({
      state: "waiting",
      reason: "account_validation_unavailable",
    });
    expect(f.posts()[0]?.init?.signal?.aborted).toBe(true);
    held.release();
    await Promise.resolve();
    expect(f.messages.join("\n")).not.toContain("provider access was verified");
  });
});
