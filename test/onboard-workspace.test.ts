import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configPathFor, defaultCtx, loadConfig, writeConfig, type Ctx } from "../src/config.js";
import { linearWorkspaceAdapter } from "../src/onboard-workspace.js";
import type { OnboardJournal, OnboardStepResult } from "../src/onboard.js";

const homes: string[] = [];
const now = Date.parse("2026-09-30T20:00:00Z");
const origin = "https://fixture.invalid";
const path = "/api/v1/me/connections/linear/workspace";
const link = `${origin}/connect/linear/workspace/handoff?handoff=opaque-secret-fixture`;
const done = () => ({ connected: true, workspace: { bound: true, workspaceId: "workspace-a", workspaceSlug: "fixture", workspaceName: "Fixture" },
  credential: { stored: true, updatedAt: now - 1000, expiresAt: now + 1000, warmth: "warm" },
  verification: { source: "live-probe", state: "connected", checkedAt: now } });
const absent = () => ({ ...done(), connected: false, verification: { source: "live-probe", state: "not-connected", checkedAt: now } });
function fixture(role: "owner" | "member" = "owner") {
  const home = mkdtempSync(join(tmpdir(), "onboard-workspace-")); homes.push(home);
  const logs: string[] = []; const opened: string[] = []; const reads: Array<{ path: string; init?: RequestInit }> = [];
  const ctx: Ctx = { ...defaultCtx(), home, env: {}, now: () => new Date(now), stdout: text => logs.push(text), stderr: text => logs.push(text) };
  writeConfig(home, { baseUrl: origin, account: "account-a", slug: "fixture", name: "Fixture", principal: "session", permissions: null,
    user: { id: "person-a", role, label: "Fixture", email: null, linearUserId: null }, key: "ctc_user_fake", joinedAt: new Date(now).toISOString(), lastSkillBundleVersion: "0.14.2" });
  const journal: OnboardJournal = { schema: 1, runId: "workspace-fixture", installer: null, cli: "0.14.2", tenant: "account-a", account: "account-a", membershipId: "person-a", baseUrl: origin, steps: [], changes: [], exit: null };
  let status: unknown = done(); let start: unknown = { authorizationUrl: link, expiresAt: now + 600_000 }; let statusCode = 200; let startCode = 200; let statusReads = 0; let flip = false; let fallbackReads = 0;
  let fallbackResult: OnboardStepResult = { state: "waiting", reason: "linear_workspace_unverified" };
  ctx.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input)); reads.push({ path: url.pathname, init });
    if (url.pathname === path) { statusReads++; return Response.json(flip && opened.length ? done() : status, { status: statusCode }); }
    if (url.pathname === `${path}/start`) return Response.json(start, { status: startCode });
    throw new Error("unexpected-provider-secret");
  }) as typeof fetch;
  const options = { fallback: { check: async () => { fallbackReads++; return fallbackResult; } }, openBrowser: (url: string) => { opened.push(url); }, sleep: async () => {}, requestTimeoutMs: 30, consentTimeoutMs: 50 };
  return { ctx, home, journal, logs, opened, reads, options, adapter: () => linearWorkspaceAdapter(options),
    status: (value: unknown) => { status = value; }, start: (value: unknown) => { start = value; }, statusCode: (value: number) => { statusCode = value; }, startCode: (value: number) => { startCode = value; },
    flip: () => { flip = true; }, fallback: (value: OnboardStepResult) => { fallbackResult = value; }, fallbackReads: () => fallbackReads, statusReads: () => statusReads };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("bounded personal-bearer Linear workspace consent", () => {
  test("fresh live bound connection is done without choosing a team or exposing credential metadata", async () => {
    const f = fixture(); const before = readFileSync(configPathFor(f.home));
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({ state: "done", evidence: { provider: "linear", workspace: "workspace-a", checkedAt: now } });
    expect(f.journal.steps).toEqual([]); expect(f.opened).toEqual([]); expect(f.fallbackReads()).toBe(0);
    expect(f.reads[0].init).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: "Bearer ctc_user_fake" } });
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
  });
  test.each([
    { status: { ...done(), connected: false, verification: { source: "none", state: "not-run", checkedAt: null } }, reason: "workspace_status_unavailable" },
    { status: { ...done(), connected: false, verification: { source: "live-probe", state: "unreachable", checkedAt: now } }, reason: "workspace_status_unavailable" },
    { status: { ...done(), workspace: { ...done().workspace, bound: false } }, reason: "linear_workspace_unverified" },
    { status: { ...done(), verification: { ...done().verification, checkedAt: now + 30_001 } }, reason: "workspace_status_shape" },
    { status: { ...done(), verification: { ...done().verification, checkedAt: now - 120_001 } }, reason: "workspace_status_shape" },
    { status: { ...done(), connected: false }, reason: "workspace_status_shape" },
    { status: [], reason: "workspace_status_shape" },
    { status: { ...done(), credential: { ...done().credential, stored: "yes" } }, reason: "workspace_status_shape" },
  ])("uncertain source waits without starting a consent: $reason", async ({ status, reason }) => {
    const f = fixture(); f.status(status);
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason });
    expect(f.opened).toEqual([]); expect(f.reads.every(row => row.path === path)).toBe(true);
  });
  test.each([
    { ...absent(), verification: { ...absent().verification, state: ["not-connected"] } },
    { ...absent(), credential: { ...absent().credential, warmth: ["warm"] } },
  ])("malformed enum arrays cannot mint a consent", async status => {
    const f = fixture(); f.status(status);
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "workspace_status_shape" });
    expect(f.opened).toEqual([]); expect(f.reads.every(row => row.path === path)).toBe(true);
  });
  test.each(["account", "person", "role", "origin"])("config change while start is pending refuses browser launch: %s", async change => {
    const f = fixture(); f.status(absent()); const fetch = f.ctx.fetch;
    f.ctx.fetch = (async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/start")) {
        const cfg = loadConfig(f.home)!;
        if (change === "account") cfg.account = "another-account";
        if (change === "person") cfg.user!.id = "another-person";
        if (change === "role") cfg.user!.role = "member";
        if (change === "origin") cfg.baseUrl = "https://another.invalid";
        writeConfig(f.home, cfg);
      }
      return response;
    }) as typeof fetch;
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: "refused" }); expect(f.opened).toEqual([]);
  });
  test("expired OAuth-only credentials wait without rotation or any read", async () => {
    const f = fixture(); const cfg = loadConfig(f.home)!; delete cfg.key;
    cfg.auth = { kind: "oauth", accessToken: "fixture-expired", refreshToken: "fixture-refresh", expiresAt: new Date(now).toISOString(), sessionId: "fixture-session" };
    writeConfig(f.home, cfg); const before = readFileSync(configPathFor(f.home));
    expect(await f.adapter().check(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "workspace_login_refresh_required" });
    expect(f.reads).toEqual([]); expect(readFileSync(configPathFor(f.home))).toEqual(before);
  });
  test("accepted timestamp and expiry boundaries remain usable", async () => {
    const f = fixture(); f.status({ ...done(), verification: { ...done().verification, checkedAt: now - 120_000 } });
    expect(await f.adapter().check(f.ctx, f.journal)).toMatchObject({ state: "done" });
    f.status({ ...done(), verification: { ...done().verification, checkedAt: now + 30_000 } });
    expect(await f.adapter().check(f.ctx, f.journal)).toMatchObject({ state: "done" });
    f.status(absent()); f.start({ authorizationUrl: link, expiresAt: now + 630_000 }); f.flip();
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: "done" });
  });
  test("start body stall is bounded and cannot launch late", async () => {
    const f = fixture(); f.status(absent()); const fetch = f.ctx.fetch;
    let finish!: (value: unknown) => void;
    f.ctx.fetch = (async (input, init) => String(input).endsWith("/start")
      ? { status: 200, json: () => new Promise(resolve => { finish = resolve; }) } as unknown as Response : fetch(input, init)) as typeof fetch;
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "workspace_status_unavailable" });
    finish({ authorizationUrl: link, expiresAt: now + 600_000 }); await Promise.resolve(); await Promise.resolve(); expect(f.opened).toEqual([]);
  });
  test("old-cloud404 preserves supported read-only proof and cannot open a session route", async () => {
    const f = fixture(); f.statusCode(404); f.fallback({ state: "done", evidence: { checkedAt: now } });
    expect(await f.adapter().check(f.ctx, f.journal)).toMatchObject({ state: "done" });
    f.fallback({ state: "waiting", reason: "linear_workspace_unverified" });
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: "waiting" });
    expect(f.fallbackReads()).toBe(2); expect(f.opened).toEqual([]);
  });
  test.each([401, 403, 503])("status refusal/outage %s never mints a browser handoff", async code => {
    const f = fixture(); f.statusCode(code);
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: code === 503 ? "waiting" : "refused" });
    expect(f.reads.every(row => row.path === path)).toBe(true); expect(f.logs).toEqual([]);
  });
  test("member cannot mint tenant-wide consent even when used outside the engine", async () => {
    const f = fixture("member"); f.status(absent());
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: "refused", reason: "workspace_admin_required" }); expect(f.reads).toEqual([]);
  });
  test("receipt identity mismatch refuses before any read", async () => {
    const f = fixture(); f.journal.account = "another-account";
    expect(await f.adapter().check(f.ctx, f.journal)).toMatchObject({ state: "refused", reason: "workspace_identity_refused" }); expect(f.reads).toEqual([]);
  });
  test("one new handoff opens only in browser, polls a fresh grant and leaves config unchanged", async () => {
    const f = fixture(); f.status(absent()); f.flip(); const before = readFileSync(configPathFor(f.home));
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: "done", evidence: { workspace: "workspace-a" } });
    expect(f.opened).toEqual([link]); expect(f.reads.filter(row => row.path.endsWith("/start"))).toHaveLength(1);
    expect(f.statusReads()).toBe(2); expect(f.logs.join("\n")).not.toContain("opaque-secret-fixture"); expect(readFileSync(configPathFor(f.home))).toEqual(before);
  });
  test.each([
    `${origin}/connect/linear/workspace/handoff?handoff=a&handoff=b`, `${origin}/connect/linear/workspace/handoff?handoff=a&account=other`,
    `${origin}/connect/linear/personal/start?handoff=a`, `https://evil.invalid/connect/linear/workspace/handoff?handoff=a`,
    `http://fixture.invalid/connect/linear/workspace/handoff?handoff=a`, `https://user@fixture.invalid/connect/linear/workspace/handoff?handoff=a`,
    `${origin}/connect/linear/workspace/handoff?handoff=a#secret`, `\n${origin}/connect/linear/workspace/handoff?handoff=a`, `${origin}/connect/linear/workspace/handoff?handoff=a\t`, `${origin}/connect/linear/workspace/handoff?handoff=`,
  ])("malicious or wrong-purpose URL is refused: %s", async authorizationUrl => {
    const f = fixture(); f.status(absent()); f.start({ authorizationUrl, expiresAt: now + 600_000 });
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: "refused", reason: "workspace_consent_handoff" }); expect(f.opened).toEqual([]);
  });
  test.each([now, now - 1, now + 630_001, null])("invalid expiry %s never opens", async expiresAt => {
    const f = fixture(); f.status(absent()); f.start({ authorizationUrl: link, expiresAt });
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: "refused" }); expect(f.opened).toEqual([]);
  });
  test.each([403, 404, 503])("start refusal/missing capability/outage %s is safe", async code => {
    const f = fixture(); f.status(absent()); f.startCode(code);
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: code === 403 ? "refused" : "waiting" }); expect(f.opened).toEqual([]);
  });
  test("stalled transport that ignores abort is bounded and a late body cannot open a browser", async () => {
    const f = fixture(); let finish!: (value: Response) => void;
    f.ctx.fetch = (() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "workspace_status_unavailable" });
    finish(Response.json(absent())); await Promise.resolve(); await Promise.resolve(); expect(f.opened).toEqual([]);
  });
  test("stalled JSON body is bounded as well as headers", async () => {
    const f = fixture(); f.ctx.fetch = (async () => ({ status: 200, json: () => new Promise(() => {}) } as unknown as Response)) as typeof fetch;
    expect(await f.adapter().check(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "workspace_status_unavailable" });
  });
  test("cancel before launch neither opens nor leaks handoff; cancel during polling resumes", async () => {
    const f = fixture(); const controller = new AbortController(); f.status(absent());
    const fetch = f.ctx.fetch; f.ctx.fetch = (async (input, init) => { const result = await fetch(input, init); if (String(input).endsWith("/start")) controller.abort(); return result; }) as typeof fetch;
    expect(await f.adapter().act!(f.ctx, f.journal, controller.signal)).toMatchObject({ state: "waiting", reason: "interrupted" }); expect(f.opened).toEqual([]);
    const g = fixture(); g.status(absent()); const cancel = new AbortController(); g.options.openBrowser = url => { g.opened.push(url); cancel.abort(); };
    expect(await g.adapter().act!(g.ctx, g.journal, cancel.signal)).toMatchObject({ state: "waiting", reason: "interrupted" }); expect(g.logs.join("\n")).not.toContain("opaque-secret-fixture");
  });
  test("consent deadline returns waiting rather than falsely completing from stored warmth", async () => {
    const f = fixture(); f.status(absent());
    expect(await f.adapter().act!(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "consent_timeout" }); expect(f.opened).toHaveLength(1);
  });
});
