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
import { personalConsentAdapter } from "../src/onboard-personal.js";
import type { OnboardJournal } from "../src/onboard.js";

const origin = "https://cloud.example.test";
const now = Date.parse("2026-09-30T22:00:00Z");
const homes: string[] = [];
function fixture(provider: "linear" | "github" = "linear") {
  const home = mkdtempSync(join(tmpdir(), "personal-consent-"));
  homes.push(home);
  const logs: string[] = [];
  const opened: string[] = [];
  const reads: Array<{ path: string; init?: RequestInit }> = [];
  const ctx = {
    ...defaultCtx(),
    home,
    env: {},
    now: () => new Date(now),
    stdout: (line: string) => logs.push(line),
    stderr: (line: string) => logs.push(line),
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
      role: "member",
      label: "Fixture",
      email: null,
      linearUserId: null,
    },
    key: "ctc_user_fixture",
    joinedAt: new Date(now).toISOString(),
    lastSkillBundleVersion: "0.14.3",
  });
  const journal: OnboardJournal = {
    schema: 1,
    runId: "fixture",
    installer: null,
    cli: "0.14.3",
    tenant: "account-a",
    account: "account-a",
    membershipId: "person-a",
    baseUrl: origin,
    steps: [],
    changes: [],
    exit: null,
  };
  const statusPath = `/api/v1/me/connections/${provider}/personal`;
  const startPath = `/connect/${provider}/personal/start`;
  let status: unknown = { connected: false };
  let code = 200;
  let start: unknown = {
    authorizationUrl: `${origin}${startPath}?handoff=opaque-fixture`,
    expiresAt: now + 600_000,
  };
  let startCode = 200;
  ctx.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    reads.push({ path, init });
    if (path === statusPath)
      return Response.json(opened.length ? { connected: true } : status, {
        status: code,
      });
    if (path === startPath) return Response.json(start, { status: startCode });
    throw new Error("private provider diagnostic");
  }) as typeof fetch;
  const options = {
    provider,
    openBrowser: (url: string) => {
      opened.push(url);
    },
    sleep: async () => {},
    requestTimeoutMs: 20,
    consentTimeoutMs: 50,
  };
  return {
    ctx,
    home,
    journal,
    logs,
    opened,
    reads,
    options,
    statusPath,
    startPath,
    adapter: () => personalConsentAdapter(options),
    status: (body: unknown, http = 200) => {
      status = body;
      code = http;
    },
    start: (body: unknown, http = 200) => {
      start = body;
      startCode = http;
    },
  };
}
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("owned personal consent", () => {
  it.each(["linear", "github"] as const)(
    "uses %s's actual signed path and keeps the credential out of logs",
    async (provider) => {
      const f = fixture(provider);
      const before = readFileSync(configPathFor(f.home));
      expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({
        state: "done",
        evidence: { provider, checkedAt: now },
      });
      expect(f.opened).toEqual([
        `${origin}${f.startPath}?handoff=opaque-fixture`,
      ]);
      expect(f.logs.join("\n")).not.toContain("handoff");
      expect(f.logs.join("\n")).not.toContain("opaque-fixture");
      expect(f.reads).toHaveLength(3);
      expect(
        f.reads.every(
          (row) => row.init?.method === "GET" && row.init.redirect === "error",
        ),
      ).toBe(true);
      expect(readFileSync(configPathFor(f.home))).toEqual(before);
    },
  );

  it("rechecks an available grant without opening another consent", async () => {
    const f = fixture();
    f.status({ connected: true });
    expect((await f.adapter().act!(f.ctx, f.journal)).state).toBe("done");
    expect(f.opened).toEqual([]);
  });

  it.each([
    [],
    { connected: "true" },
    { connected: true, reason: "lapsed" },
    { connected: false, reason: ["lapsed"] },
  ])("rejects malformed or contradictory grant status", async (status) => {
    const f = fixture();
    f.status(status);
    expect((await f.adapter().act!(f.ctx, f.journal)).state).toBe("failed");
    expect(f.opened).toEqual([]);
  });

  it.each([404, 405])(
    "a personal route removed during approval HTTP%s stops waiting immediately",
    async (code) => {
      const f = fixture();
      const adapter = personalConsentAdapter({
        ...f.options,
        openBrowser: (url) => {
          f.opened.push(url);
          f.status({ connected: false }, code);
        },
        sleep: async () => {
          throw new Error("missing route must not retry");
        },
      });
      expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({
        state: "waiting",
        reason: "cloud_capability_unavailable",
      });
      expect(f.reads.map((row) => row.path)).toEqual([
        f.statusPath,
        f.startPath,
        f.statusPath,
      ]);
    },
  );
  it.each([401, 403, 404, 503, 500])(
    "does not mint consent after status HTTP%s",
    async (code) => {
      const f = fixture();
      f.status({ error: "private diagnostic" }, code);
      expect((await f.adapter().act!(f.ctx, f.journal)).state).not.toBe("done");
      expect(f.reads).toHaveLength(1);
      expect(f.opened).toEqual([]);
      expect(f.logs).toEqual([]);
    },
  );

  it.each([
    `${origin}/connect/linear/personal/start?handoff=one&handoff=two`,
    `${origin}/connect/linear/personal/start?handoff=one&next=https://evil.test`,
    `${origin}/connect/github/personal/start?handoff=one`,
    `${origin}/connect/linear/personal/start?handoff=one#fragment`,
    `${origin}/connect/linear/personal/start?handoff=bad%0Atoken`,
    `${origin}/connect/linear/personal/start?handoff=`,
    `${origin}/connect/linear/personal/start?handoff=one\n`,
    "https://evil.test/connect/linear/personal/start?handoff=one",
    "https://user@cloud.example.test/connect/linear/personal/start?handoff=one",
  ])(
    "refuses an invalid signed continuation without launching it",
    async (authorizationUrl) => {
      const f = fixture();
      f.start({ authorizationUrl, expiresAt: now + 60_000 });
      expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({
        state: "refused",
        reason: "personal_consent_handoff",
      });
      expect(f.opened).toEqual([]);
    },
  );

  it.each([now, now - 1, now + 630_001, "future", null])(
    "refuses invalid or expired handoff expiry",
    async (expiresAt) => {
      const f = fixture();
      f.start({
        authorizationUrl: `${origin}${f.startPath}?handoff=opaque`,
        expiresAt,
      });
      expect((await f.adapter().act!(f.ctx, f.journal)).state).toBe("refused");
      expect(f.opened).toEqual([]);
    },
  );

  it.each(["account", "person", "origin"])(
    "refuses a config %s change before browser launch",
    async (change) => {
      const f = fixture();
      const original = f.ctx.fetch;
      f.ctx.fetch = (async (input, init) => {
        const response = await original(input, init);
        if (String(input).endsWith(f.startPath)) {
          const cfg = loadConfig(f.home)!;
          if (change === "account") cfg.account = "other-account";
          if (change === "person") cfg.user!.id = "other-person";
          if (change === "origin") cfg.baseUrl = "https://other.example.test";
          writeConfig(f.home, cfg);
        }
        return response;
      }) as typeof fetch;
      expect((await f.adapter().act!(f.ctx, f.journal)).state).toBe("refused");
      expect(f.opened).toEqual([]);
    },
  );

  it("refuses a journal mismatch before network or local OAuth refresh", async () => {
    const f = fixture();
    const cfg = loadConfig(f.home)!;
    delete cfg.key;
    cfg.auth = {
      kind: "oauth",
      accessToken: "old-fixture",
      refreshToken: "refresh-fixture",
      sessionId: "fixture-session",
      expiresAt: new Date(now - 1).toISOString(),
    };
    writeConfig(f.home, cfg);
    const before = readFileSync(configPathFor(f.home));
    expect(
      (
        await f
          .adapter()
          .check(f.ctx, { ...f.journal, account: "other-account" })
      ).state,
    ).toBe("refused");
    expect((await f.adapter().check(f.ctx, f.journal)).state).toBe("waiting");
    expect(f.reads).toEqual([]);
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
  });

  it.each(["headers", "body"])(
    "bounds a stalled %s and ignores late success",
    async (stall) => {
      const f = fixture();
      let completeHeaders!: (value: Response) => void;
      let completeBody!: (value: unknown) => void;
      f.ctx.fetch = (async () =>
        stall === "headers"
          ? await new Promise<Response>((resolve) => {
              completeHeaders = resolve;
            })
          : {
              status: 200,
              json: () =>
                new Promise<unknown>((resolve) => {
                  completeBody = resolve;
                }),
            }) as typeof fetch;
      expect(await f.adapter().check(f.ctx, f.journal)).toMatchObject({
        state: "waiting",
        reason: "personal_status_unavailable",
      });
      if (stall === "headers")
        completeHeaders(Response.json({ connected: true }));
      else completeBody({ connected: true });
      await Promise.resolve();
      expect(f.opened).toEqual([]);
      expect(f.logs).toEqual([]);
    },
  );

  it("external cancellation stops start-body wait before browser launch", async () => {
    const f = fixture();
    const original = f.ctx.fetch;
    const abort = new AbortController();
    f.ctx.fetch = (async (input, init) => {
      if (!String(input).endsWith(f.startPath)) return original(input, init);
      return {
        status: 200,
        json: () => {
          abort.abort();
          return new Promise(() => {});
        },
      } as Response;
    }) as typeof fetch;
    expect(
      await f.adapter().act!(f.ctx, f.journal, abort.signal),
    ).toMatchObject({ state: "waiting", reason: "interrupted" });
    expect(f.opened).toEqual([]);
  });
  it("without a browser it names the Connected accounts page and keeps waiting, never printing the signed link", async () => {
    const f = fixture();
    const adapter = personalConsentAdapter({
      ...f.options,
      openBrowser: async () => {
        await Promise.resolve();
        f.opened.push("approved elsewhere");
        throw new Error("https://example.test/?handoff=private-opener-value");
      },
    });
    expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({
      state: "done",
    });
    const printed = f.logs.join("\n");
    expect(printed).toContain(`${origin}/settings/connected-accounts`);
    expect(printed).not.toContain("private-opener-value");
    expect(printed).not.toContain("opaque-fixture");
  });
  it("without a browser the deadline asks the person to finish on the web and resume", async () => {
    const f = fixture();
    const adapter = personalConsentAdapter({
      ...f.options,
      openBrowser: async () => {
        throw new Error("no opener");
      },
    });
    expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({
      state: "waiting",
      reason: "personal_browser_unavailable",
    });
  });
  it("login expiry during browser approval stops with its actual cause", async () => {
    const f = fixture();
    const adapter = personalConsentAdapter({
      ...f.options,
      openBrowser: () => {
        const config = loadConfig(f.home)!;
        writeConfig(f.home, { ...config, key: undefined, auth: {
          kind: "oauth", accessToken: "expired-token-sentinel", refreshToken: "unused-refresh-sentinel",
          expiresAt: new Date(now - 1).toISOString(), sessionId: "original-session",
        } });
      },
      sleep: async () => { throw new Error("refresh-required status must not poll again"); },
    });
    expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({
      state: "waiting", reason: "personal_login_refresh_required",
    });
    expect(f.reads).toHaveLength(2);
    expect(f.logs.join("\n")).not.toMatch(/expired-token-sentinel|unused-refresh-sentinel/);
  });
});

describe("CTC-4629: a personal Linear grant whose scopes are out of date", () => {
  const reauthorize = `${origin}/connect/linear/personal/start`;
  const connected = (permissions: unknown) => ({
    connected: true,
    linearUserId: "lin-1",
    grantedScope: "read",
    updatedAt: now - 1000,
    expiresAt: now + 3_600_000,
    permissions,
  });
  const outdated = {
    state: "outdated",
    grant: "linear-personal",
    granted: ["read"],
    missing: ["write"],
    action: { kind: "reauthorize", url: reauthorize, actor: "member" },
  };

  it("waits naming the grant, the missing scope and the person's re-authorize URL, and opens nothing", async () => {
    const f = fixture("linear");
    f.status(connected(outdated));
    const expected = {
      state: "waiting",
      reason: "linear_personal_scope_outdated",
      evidence: {
        provider: "linear",
        grant: "linear-personal",
        granted: "read",
        missing: "write",
        url: reauthorize,
        actor: "member",
      },
    };
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual(expected);
    expect(await f.adapter().act!(f.ctx, f.journal)).toEqual(expected);
    expect(f.opened).toEqual([]);
    expect(f.reads.every((row) => row.path === f.statusPath)).toBe(true);
  });

  it("a current grant is done with its granted scopes", async () => {
    const f = fixture("linear");
    f.status(connected({ state: "current", grant: "linear-personal", granted: ["read", "write"] }));
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "done",
      evidence: { provider: "linear", checkedAt: now, granted: "read, write" },
    });
  });

  it("a verdict it cannot verify is never done", async () => {
    const f = fixture("linear");
    f.status(
      connected({
        ...outdated,
        action: { ...outdated.action, url: "https://elsewhere.invalid/connect/linear/personal/start" },
      }),
    );
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "failed",
      reason: "personal_status_shape",
    });
    f.status(connected({ state: "unknown", grant: "linear-personal", reason: "not-run" }));
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "personal_permissions_unverified",
    });
  });

  it("an older cloud without the verdict stays done as before", async () => {
    const f = fixture("linear");
    f.status({ connected: true });
    expect((await f.adapter().check(f.ctx, f.journal)).state).toBe("done");
  });
});

it("CTC-4629 review: a fresh personal consent that is still short of scopes stops polling and keeps its URL", async () => {
  const f = fixture("linear");
  const reauthorize = `${origin}/connect/linear/personal/start`;
  const outdated = {
    connected: true,
    permissions: {
      state: "outdated",
      grant: "linear-personal",
      granted: ["read"],
      missing: ["write"],
      action: { kind: "reauthorize", url: reauthorize, actor: "member" },
    },
  };
  let reads = 0;
  const fetch = f.ctx.fetch;
  f.ctx.fetch = (async (input, init) => {
    if (new URL(String(input)).pathname === f.statusPath && reads++ > 0)
      return Response.json(outdated);
    return fetch(input, init);
  }) as typeof globalThis.fetch;
  const adapter = personalConsentAdapter({
    ...f.options,
    sleep: async () => {
      throw new Error("an outdated grant must not keep polling");
    },
  });
  expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({
    state: "waiting",
    reason: "linear_personal_scope_outdated",
    evidence: { url: reauthorize, missing: "write" },
  });
});


it("a personal approval with unreadable permissions reports the check failure immediately", async () => {
 const f = fixture("linear"); let reads = 0; const fetch = f.ctx.fetch;
 f.ctx.fetch = (async (input, init) => new URL(String(input)).pathname === f.statusPath && reads++ > 0 ? Response.json({ connected: true, permissions: { state: "unknown", grant: "linear-personal", reason: "grant-unreadable" } }) : fetch(input, init)) as typeof globalThis.fetch;
 const adapter = personalConsentAdapter({ ...f.options, sleep: async () => { throw new Error("permission failure must not poll"); } });
 expect(await adapter.act!(f.ctx, f.journal)).toEqual({ state: "waiting", reason: "personal_permissions_unverified" });
});
