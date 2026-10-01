import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  configPathFor,
  defaultCtx,
  loadConfig,
  writeConfig,
  type Ctx,
} from "../src/config.js";
import {
  guardOnboardCapabilities,
  verifyOnboardRoutes,
} from "../src/onboard-capabilities.js";
import { linearWorkspaceAdapter } from "../src/onboard-workspace.js";
import type { OnboardAdapter, OnboardJournal } from "../src/onboard.js";

const homes: string[] = [];
const origin = "https://fixture.invalid";
const status = {
  method: "GET" as const,
  path: "/api/v1/me/connections/linear/workspace",
  personalBearer: true,
};
const starter = { ...status, path: `${status.path}/start` };
const web = {
  connections: "/a/account/connections",
  personalConnections: "/settings/connected-accounts",
};
const document = () => ({
  account: { id: "account-a" },
  contractVersion: "2.10.0",
  onboarding: { schema: 1, routes: [status, starter], web },
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "onboard-capabilities-"));
  homes.push(home);
  const messages: string[] = [],
    requests: string[] = [];
  const ctx: Ctx = {
    ...defaultCtx(),
    home,
    env: {},
    now: () => new Date("2026-09-30T23:00:00Z"),
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
    key: "ctc_user_fake",
    joinedAt: ctx.now().toISOString(),
    lastSkillBundleVersion: "0.14.4",
  });
  const journal: OnboardJournal = {
    schema: 1,
    runId: "fixture",
    cli: "0.14.4",
    installer: null,
    tenant: "account-a",
    account: "account-a",
    membershipId: "person-a",
    baseUrl: origin,
    steps: [],
    changes: [],
    exit: null,
  };
  let body: unknown = document(),
    code = 200;
  ctx.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/api/v1/agent/contract")) {
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: {
          authorization: "Bearer ctc_user_fake",
          "cache-control": "no-cache",
        },
      });
      return Response.json(body, { status: code });
    }
    return new Response(null, { status: 403 });
  }) as typeof fetch;
  const adapter: OnboardAdapter = {
    check: vi.fn(async () => ({ state: "pending" as const })),
    act: vi.fn(async () => ({ state: "done" as const })),
  };
  const options = {
    check: [status],
    act: [status, starter],
    fallback: "connections" as const,
    message: (text: string) => {
      messages.push(text);
    },
    requestTimeoutMs: 30,
  };
  return {
    home,
    ctx,
    journal,
    messages,
    requests,
    adapter,
    options,
    guard: (inner = adapter) => guardOnboardCapabilities(inner, options),
    body: (value: unknown) => {
      body = value;
    },
    code: (value: number) => {
      code = value;
    },
  };
}
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
describe("fresh capability before onboarding requests", () => {
  test("Ryan's undeployed workspace route waits with a public fallback and zero unsupported calls", async () => {
    const f = fixture();
    f.body({ account: { id: "account-a" }, contractVersion: "2.10.0" });
    const inner = linearWorkspaceAdapter({
      fallback: { check: vi.fn(async () => ({ state: "pending" as const })) },
      openBrowser: vi.fn(),
    });
    expect(await f.guard(inner).check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "cloud_capability_unavailable",
      evidence: { path: `${origin}${web.connections}` },
    });
    expect(f.requests).toEqual([`${origin}/api/v1/agent/contract`]);
    expect(f.messages.join("\n")).toContain("not available on this server yet");
    expect(f.messages.join("\n")).not.toContain("consent refused");
  });
  test("an advertised actual authorization refusal stays distinct from unavailable capability", async () => {
    const f = fixture();
    const inner = linearWorkspaceAdapter({
      fallback: { check: async () => ({ state: "pending" }) },
      openBrowser: vi.fn(),
    });
    expect((await f.guard(inner).check(f.ctx, f.journal)).state).toBe(
      "refused",
    );
    expect(f.requests).toEqual([
      `${origin}/api/v1/agent/contract`,
      `${origin}${status.path}`,
    ]);
    expect(f.messages).toEqual([]);
  });
  test("check may observe status while a missing starter prevents action", async () => {
    const f = fixture();
    f.body({ ...document(), onboarding: { schema: 1, routes: [status], web } });
    expect((await f.guard().check(f.ctx, f.journal)).state).toBe("pending");
    expect((await f.guard().act!(f.ctx, f.journal)).reason).toBe(
      "cloud_capability_unavailable",
    );
    expect(f.adapter.check).toHaveBeenCalledTimes(1);
    expect(f.adapter.act).not.toHaveBeenCalled();
  });
  test("each act rereads capability rather than accepting a previous check or disk cache", async () => {
    const f = fixture();
    expect((await f.guard().check(f.ctx, f.journal)).state).toBe("pending");
    f.body({ ...document(), onboarding: { schema: 1, routes: [], web } });
    expect((await f.guard().act!(f.ctx, f.journal)).reason).toBe(
      "cloud_capability_unavailable",
    );
    expect(f.adapter.act).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(2);
  });
  test.each([
    { schema: 2, routes: [status], web },
    { schema: 1, routes: [{ ...status, method: "POST" }], web },
    { schema: 1, routes: [{ ...status, personalBearer: false }], web },
    {
      schema: 1,
      routes: [{ ...status, path: "/api/v1/me/connections/linear" }],
      web,
    },
    { schema: 1, routes: [status, status], web },
    {
      schema: 1,
      routes: [{ ...status, path: `${status.path}?account=other` }],
      web,
    },
    {
      schema: 1,
      routes: [status],
      web: { ...web, connections: "https://foreign.invalid" },
    },
    {
      schema: 1,
      routes: [status],
      web: { ...web, connections: "/a/account/connections?handoff=private" },
    },
  ])(
    "malformed or mismatched advertisement cannot authorize the step %#",
    async (onboarding) => {
      const f = fixture();
      f.body({ ...document(), onboarding });
      expect((await f.guard().check(f.ctx, f.journal)).state).toBe("waiting");
      expect(f.adapter.check).not.toHaveBeenCalled();
    },
  );
  test.each([401, 403, 404, 503])(
    "contract status %s waits without parsing diagnostics or running the route",
    async (code) => {
      const f = fixture();
      f.code(code);
      expect((await f.guard().check(f.ctx, f.journal)).state).toBe("waiting");
      expect(f.adapter.check).not.toHaveBeenCalled();
    },
  );
  test.each(["account", "membershipId", "baseUrl"] as const)(
    "foreign journal %s makes zero requests",
    async (key) => {
      const f = fixture();
      f.journal[key] = "foreign";
      expect((await f.guard().check(f.ctx, f.journal)).reason).toBe(
        "onboarding_capability_identity_unverified",
      );
      expect(f.requests).toEqual([]);
    },
  );
  test("a fresh contract from another account cannot authorize even matching advertised paths", async () => {
    const f = fixture();
    f.body({ ...document(), account: { id: "foreign" } });
    expect((await f.guard().check(f.ctx, f.journal)).reason).toBe(
      "onboarding_capability_identity_unverified",
    );
    expect(f.adapter.check).not.toHaveBeenCalled();
  });
  test("current config changes during a response body invalidate its capability", async () => {
    const f = fixture();
    f.ctx.fetch = (async () =>
      ({
        status: 200,
        json: async () => {
          const cfg = loadConfig(f.home)!;
          cfg.user!.id = "foreign";
          writeConfig(f.home, cfg);
          return document();
        },
      }) as unknown as Response) as typeof fetch;
    expect((await f.guard().check(f.ctx, f.journal)).reason).toBe(
      "onboarding_capability_identity_unverified",
    );
    expect(f.adapter.check).not.toHaveBeenCalled();
  });
  test("expired OAuth waits without refreshing or rewriting local login", async () => {
    const f = fixture();
    const cfg = loadConfig(f.home)!;
    cfg.key = "";
    cfg.auth = {
      kind: "oauth",
      accessToken: "synthetic",
      refreshToken: "synthetic",
      expiresAt: "2026-09-30T22:00:00Z",
      sessionId: "fixture",
    };
    writeConfig(f.home, cfg);
    const before = readFileSync(configPathFor(f.home));
    expect((await f.guard().check(f.ctx, f.journal)).reason).toBe(
      "onboarding_capability_login_refresh_required",
    );
    expect(f.requests).toEqual([]);
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
  });
  test("a hanging contract body is bounded and late advertisements cannot run the route", async () => {
    const f = fixture();
    let complete!: (value: unknown) => void;
    f.ctx.fetch = (async () =>
      ({
        status: 200,
        json: () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      }) as unknown as Response) as typeof fetch;
    expect((await f.guard().check(f.ctx, f.journal)).reason).toBe(
      "onboarding_capability_unavailable",
    );
    complete(document());
    await Promise.resolve();
    await Promise.resolve();
    expect(f.adapter.check).not.toHaveBeenCalled();
  });
  test("interruption before the gate makes zero requests", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    expect((await f.guard().act!(f.ctx, f.journal, abort.signal)).reason).toBe(
      "interrupted",
    );
    expect(f.requests).toEqual([]);
    expect(f.adapter.act).not.toHaveBeenCalled();
  });
});

describe("only the advertised coding-account validation template is supported", () => {
  const template = "/api/v1/coding-accounts/:slot/validate";
  const advertised = {
    method: "POST" as const,
    path: template,
    personalBearer: true,
  };
  test("the actual server template permits capability verification without any provider request", async () => {
    const f = fixture();
    f.body({
      ...document(),
      onboarding: { schema: 1, routes: [status, advertised], web },
    });
    expect(
      await verifyOnboardRoutes(f.ctx, f.journal, [
        { method: "POST", path: template },
      ]),
    ).toEqual({ origin });
    expect(await verifyOnboardRoutes(f.ctx, f.journal, [status])).toEqual({
      origin,
    });
    expect(f.requests).toEqual([
      `${origin}/api/v1/agent/contract`,
      `${origin}/api/v1/agent/contract`,
    ]);
    expect(f.adapter.check).not.toHaveBeenCalled();
    expect(f.adapter.act).not.toHaveBeenCalled();
  });
  test.each([
    "/api/v1/coding-accounts/:other/validate",
    "/api/v1/coding-accounts/:slot/validate/extra",
    "/api/v1/coding-accounts/:slot/revoke",
    "/api/v1/foreign/:slot/validate",
    "/api/v1/coding-accounts/%3Aslot/validate",
    "/api/v1/coding-accounts/%253Aslot/validate",
    "/api/v1/coding-accounts/../:slot/validate",
    "/api/v1/coding-accounts/:slot/validate?account=other",
    "https://foreign.invalid/api/v1/coding-accounts/:slot/validate",
    "//foreign.invalid/api/v1/coding-accounts/:slot/validate",
  ])(
    "template-like path %s cannot authorize even an unrelated valid read",
    async (path) => {
      const f = fixture();
      f.body({
        ...document(),
        onboarding: {
          schema: 1,
          routes: [status, { ...advertised, path }],
          web,
        },
      });
      expect(await verifyOnboardRoutes(f.ctx, f.journal, [status])).toEqual({
        reason: "onboarding_capability_unavailable",
        origin,
      });
      expect(f.requests).toEqual([`${origin}/api/v1/agent/contract`]);
      expect(f.adapter.check).not.toHaveBeenCalled();
      expect(f.adapter.act).not.toHaveBeenCalled();
    },
  );
  test("the known template still requires an explicit personal bearer advertisement", async () => {
    const f = fixture();
    f.body({
      ...document(),
      onboarding: {
        schema: 1,
        routes: [{ ...advertised, personalBearer: false }],
        web,
      },
    });
    expect(
      await verifyOnboardRoutes(f.ctx, f.journal, [
        { method: "POST", path: template },
      ]),
    ).toEqual({ reason: "onboarding_capability_unavailable", origin });
    expect(f.requests).toEqual([`${origin}/api/v1/agent/contract`]);
  });
  test("GET advertisement does not authorize the real POST template", async () => {
    const f = fixture();
    f.body({
      ...document(),
      onboarding: {
        schema: 1,
        routes: [{ ...advertised, method: "GET" }],
        web,
      },
    });
    const support = await verifyOnboardRoutes(f.ctx, f.journal, [
      { method: "POST", path: template },
    ]);
    expect(support).toEqual({ reason: "cloud_capability_unavailable", origin });
    expect(f.requests).toEqual([`${origin}/api/v1/agent/contract`]);
    expect(f.adapter.act).not.toHaveBeenCalled();
  });
});
