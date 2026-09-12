// oauth.test.ts — CTC-2112: the WorkOS device-authorization login and the silent refresh.
// The fixture stands in for the mirror's `/api/v1/auth/cli` discovery and WorkOS's device/token
// endpoints; every clock and every sleep is injected so nothing here waits on the wall clock.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CustomerConfig } from "../src/config";
import { loadConfig, writeConfig } from "../src/config";
import { CliError } from "../src/errors";
import { authStrategyFor, bearerFor, deviceFlowLogin, fetchDiscovery, resetDiscoveryCache, type OauthAuth } from "../src/oauth";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, tempHome, type TestCtx } from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;
const FIXED_NOW = new Date("2026-09-12T12:00:00Z");

beforeEach(async () => {
  server = await startMeFixture();
  home = tempHome();
  ctx = makeCtx(home, { now: () => FIXED_NOW });
  resetDiscoveryCache();
});
afterEach(async () => {
  await server.close();
});

/** No sleeping on the wall clock: capture the requested delays instead. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: async (ms) => void delays.push(ms) };
}

function oauthConfig(over: Partial<OauthAuth> = {}): CustomerConfig {
  return {
    baseUrl: server.url,
    account: "acct-fixture",
    slug: "hagale-technologies",
    name: "Hagale Technologies",
    permissions: ["mirror:read", "mirror:feed"],
    principal: "service",
    joinedAt: FIXED_NOW.toISOString(),
    lastSkillBundleVersion: "0.4.0",
    auth: { kind: "oauth", accessToken: "at-old", refreshToken: "rt-old", expiresAt: new Date(FIXED_NOW.getTime() + 15 * 60_000).toISOString(), sessionId: "session_fixture", ...over },
  };
}

describe("fetchDiscovery", () => {
  it("reads /api/v1/auth/cli and caches it for an hour (a second read inside the hour makes no request)", async () => {
    const d = await fetchDiscovery(ctx, server.url);
    expect(d.clientId).toBe("client_fixture");
    expect(d.tokenUrl).toBe(`${server.url}/oauth/token`);
    expect(d.deviceAuthorizationUrl).toBe(`${server.url}/oauth/device`);
    const first = server.requests.filter((r) => r.path === "/api/v1/auth/cli").length;
    await fetchDiscovery(ctx, server.url);
    expect(server.requests.filter((r) => r.path === "/api/v1/auth/cli").length).toBe(first);
  });
});

describe("deviceFlowLogin", () => {
  it("⭐ happy path with no TTY: prints the user code and verification URL, polls at `interval`, and returns the oauth tokens", async () => {
    server.oauth.pendingPolls = 2; // two authorization_pending answers, then the token pair
    const { sleep, delays } = fakeSleep();
    const auth = await deviceFlowLogin(ctx, server.url, { isTty: () => false, sleep });
    expect(auth.kind).toBe("oauth");
    expect(auth.refreshToken).toBe("refresh-1");
    expect(auth.sessionId).toBe("session_fixture");
    // expiresAt derived from the JWT exp (~15 min out).
    expect(new Date(auth.expiresAt).getTime()).toBeGreaterThan(FIXED_NOW.getTime());
    // the person sees the code and where to type it
    const printed = ctx.out.join("\n");
    expect(printed).toContain("WXYZ-1234");
    expect(printed).toContain(`${server.url}/activate`);
    // polled at the server's interval (5 s) between the pending answers
    expect(delays.every((d) => d >= 5000)).toBe(true);
    expect(server.oauth.tokenPollCount).toBe(3);
  });

  it("honours slow_down by adding 5 s to the interval", async () => {
    server.oauth.slowDownOnce = true;
    server.oauth.pendingPolls = 0;
    const { sleep, delays } = fakeSleep();
    await deviceFlowLogin(ctx, server.url, { isTty: () => false, sleep });
    // first wait is the base interval, the wait after slow_down is +5 s
    expect(delays).toContain(10000);
  });

  it("with a TTY opens verification_uri_complete via the injected opener, once", async () => {
    server.oauth.pendingPolls = 0;
    const opened: string[] = [];
    const { sleep } = fakeSleep();
    await deviceFlowLogin(ctx, server.url, { isTty: () => true, openBrowser: (u) => opened.push(u), sleep });
    expect(opened).toEqual([`${server.url}/activate?user_code=WXYZ-1234`]);
  });

  it("stops on access_denied with a named CliError and never loops", async () => {
    server.oauth.denied = true;
    const { sleep } = fakeSleep();
    const err = await deviceFlowLogin(ctx, server.url, { isTty: () => false, sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("login-denied");
    expect(server.oauth.tokenPollCount).toBe(1);
  });

  it("stops on expired_token with a named CliError", async () => {
    server.oauth.expired = true;
    const { sleep } = fakeSleep();
    const err = await deviceFlowLogin(ctx, server.url, { isTty: () => false, sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("login-expired");
  });

  it("reads the token lifetime from the JWT `exp`, never a hard-coded 300/900 (probe: 300s today, 900s soon)", async () => {
    server.oauth.pendingPolls = 0;
    const { sleep } = fakeSleep();
    server.oauth.accessTokenTtlSec = 300;
    const short = await deviceFlowLogin(ctx, server.url, { isTty: () => false, sleep });
    const shortTtl = Date.parse(short.expiresAt) - Date.now();
    server.oauth.accessTokenTtlSec = 900;
    const long = await deviceFlowLogin(ctx, server.url, { isTty: () => false, sleep });
    const longTtl = Date.parse(long.expiresAt) - Date.now();
    expect(Math.round(shortTtl / 1000)).toBeGreaterThanOrEqual(295);
    expect(Math.round(shortTtl / 1000)).toBeLessThanOrEqual(305);
    expect(Math.round(longTtl / 1000)).toBeGreaterThanOrEqual(895);
    // 300s vs 900s must actually differ — proof the value is read, not baked in
    expect(longTtl - shortTtl).toBeGreaterThan(500_000);
  });

  it("⭐ retries a transient network failure during polling (one timeout, then success completes the login)", async () => {
    server.oauth.pendingPolls = 0;
    let thrown = false;
    const flakyFetch: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!thrown && url.endsWith("/oauth/token")) {
        thrown = true;
        throw new Error("The operation was aborted due to timeout"); // the peer's observed failure
      }
      return fetch(input as Parameters<typeof fetch>[0], init);
    };
    const c = makeCtx(home, { now: () => FIXED_NOW, fetch: flakyFetch });
    const { sleep } = fakeSleep();
    const auth = await deviceFlowLogin(c, server.url, { isTty: () => false, sleep });
    expect(auth.kind).toBe("oauth"); // the login completed despite the transient failure
    expect(thrown).toBe(true);
    expect(server.oauth.tokenPollCount).toBe(1); // only the successful poll reached the server
  });

  it("retries a transient 5xx during polling until the token pair arrives", async () => {
    server.oauth.pollTransientStatus = 503;
    server.oauth.pollTransientTimes = 2;
    server.oauth.pendingPolls = 0;
    const { sleep } = fakeSleep();
    const auth = await deviceFlowLogin(ctx, server.url, { isTty: () => false, sleep });
    expect(auth.kind).toBe("oauth");
    expect(server.oauth.tokenPollCount).toBe(1); // the two 503s did not advance the pending countdown
  });

  it("an expired device code reports login-expired, NOT a generic network error (Codex P2)", async () => {
    server.oauth.deviceExpiresIn = 0; // the poll deadline fires during the first wait
    const realSleep = (_ms: number) => new Promise<void>((r) => setTimeout(r, 25));
    const err = await deviceFlowLogin(ctx, server.url, { isTty: () => false, sleep: realSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("login-expired");
    expect((err as CliError).code).not.toBe("network");
    expect(server.oauth.tokenPollCount).toBe(0); // never polled past the deadline
  });
});

describe("bearerFor — the silent refresh", () => {
  it("returns the personal key unchanged for a key config (no refresh, no network)", async () => {
    const cfg = { baseUrl: server.url, key: "ctc_user_abc", account: "a", slug: "s", name: "n", permissions: null, principal: "service", joinedAt: "x", lastSkillBundleVersion: "0.4.0" } as CustomerConfig;
    expect(await bearerFor(ctx, cfg)).toBe("ctc_user_abc");
    expect(server.oauth.refreshCount).toBe(0);
  });

  it("returns the stored access token when it is more than 60 s from expiry", async () => {
    const cfg = oauthConfig();
    expect(await bearerFor(ctx, cfg)).toBe("at-old");
    expect(server.oauth.refreshCount).toBe(0);
  });

  it("refreshes (public-client, no client_secret) within 60 s of expiry, persists the rotated pair atomically, then returns the new bearer", async () => {
    const cfg = oauthConfig({ expiresAt: new Date(FIXED_NOW.getTime() + 30_000).toISOString() });
    const token = await bearerFor(ctx, cfg);
    expect(server.oauth.refreshCount).toBe(1);
    expect(server.oauth.issuedAccessTokens.has(token)).toBe(true);
    // no client_secret on the wire
    const refreshReq = server.requests.find((r) => r.path === "/oauth/token" && (r.body as { grant_type?: string })?.grant_type === "refresh_token");
    expect((refreshReq?.body as Record<string, unknown>).client_secret).toBeUndefined();
    expect((refreshReq?.body as Record<string, unknown>).client_id).toBe("client_fixture");
    // the config on disk now holds the rotated tokens
    const { loadConfig } = await import("../src/config");
    const saved = loadConfig(home)!;
    expect(saved.auth?.accessToken).toBe(token);
    expect(saved.auth?.refreshToken).toBe("refresh-2");
    // and the in-memory cfg was updated in place
    expect(cfg.auth?.accessToken).toBe(token);
  });

  it("does NOT clobber a newer on-disk login: a daemon's refresh of its old session leaves a re-login intact (Codex P1)", async () => {
    server.oauth.sessionId = "session_OLD";
    // Someone re-logged-in on disk to a DIFFERENT session (e.g. switched tenant) while an old process runs.
    const newer = oauthConfig({ sessionId: "session_NEW", accessToken: "new-at", refreshToken: "new-rt", expiresAt: new Date(FIXED_NOW.getTime() + 15 * 60_000).toISOString() });
    writeConfig(home, newer);
    // The old process still holds its own near-expiry session and refreshes it.
    const old = oauthConfig({ sessionId: "session_OLD", expiresAt: new Date(FIXED_NOW.getTime() + 30_000).toISOString() });
    await bearerFor(ctx, old);
    // The on-disk re-login is preserved, not overwritten with the daemon's rotated old-session tokens.
    const saved = loadConfig(home)!;
    expect(saved.auth?.sessionId).toBe("session_NEW");
    expect(saved.auth?.accessToken).toBe("new-at");
    expect(saved.auth?.refreshToken).toBe("new-rt");
  });

  it("merges the rotated tokens into the on-disk config when it is still the same session, preserving its other fields", async () => {
    server.oauth.sessionId = "session_fixture";
    const onDisk = oauthConfig({ expiresAt: new Date(FIXED_NOW.getTime() + 30_000).toISOString() });
    onDisk.name = "Preserved Tenant Name";
    writeConfig(home, onDisk);
    const token = await bearerFor(ctx, oauthConfig({ expiresAt: new Date(FIXED_NOW.getTime() + 30_000).toISOString() }));
    const saved = loadConfig(home)!;
    expect(saved.auth?.accessToken).toBe(token); // rotated
    expect(saved.name).toBe("Preserved Tenant Name"); // other fields survive the merge
  });

  it("single-flights concurrent refreshes: two callers at expiry produce exactly one refresh", async () => {
    const cfg = oauthConfig({ expiresAt: new Date(FIXED_NOW.getTime() + 30_000).toISOString() });
    const [a, b] = await Promise.all([bearerFor(ctx, cfg), bearerFor(ctx, cfg)]);
    expect(a).toBe(b);
    expect(server.oauth.refreshCount).toBe(1);
  });

  it("surfaces invalid_grant as CliError 'session-expired' and does not retry", async () => {
    server.oauth.refreshInvalidGrant = true;
    const cfg = oauthConfig({ expiresAt: new Date(FIXED_NOW.getTime() + 30_000).toISOString() });
    const err = await bearerFor(ctx, cfg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("session-expired");
    expect((err as CliError).message).toContain("catalyst-skills login");
    expect(server.oauth.refreshCount).toBe(1);
    // the stored tokens are NOT discarded
    const { loadConfig } = await import("../src/config");
    expect(loadConfig(home)?.auth?.refreshToken ?? "rt-old").toBe("rt-old");
  });

  it("tolerates a grace-window replay: a refresh that echoes the SAME pair is a success, not an error", async () => {
    server.oauth.refreshEchoesToken = true;
    const cfg = oauthConfig({ expiresAt: new Date(FIXED_NOW.getTime() + 30_000).toISOString() });
    const token = await bearerFor(ctx, cfg);
    expect(server.oauth.refreshCount).toBe(1);
    expect(server.oauth.issuedAccessTokens.has(token)).toBe(true);
    // the refresh token came back unchanged (the replay), and that is fine
    const { loadConfig } = await import("../src/config");
    expect(loadConfig(home)?.auth?.refreshToken).toBe("rt-old");
    expect(cfg.auth?.refreshToken).toBe("rt-old");
  });

  it("retries a transient 5xx on refresh with backoff and never discards the tokens", async () => {
    server.oauth.refreshFailStatus = 503;
    server.oauth.refreshFailTimes = 2;
    const cfg = oauthConfig({ expiresAt: new Date(FIXED_NOW.getTime() + 30_000).toISOString() });
    const { sleep } = fakeSleep();
    const token = await bearerFor(ctx, cfg, { sleep });
    expect(server.oauth.refreshCount).toBe(3); // two 503s then success
    expect(server.oauth.issuedAccessTokens.has(token)).toBe(true);
  });
});

describe("authStrategyFor", () => {
  it("is {kind:'token'} for a key config", () => {
    const cfg = { baseUrl: server.url, key: "ctc_user_abc", account: "a", slug: "s", name: "n", permissions: null, principal: "service", joinedAt: "x", lastSkillBundleVersion: "0.4.0" } as CustomerConfig;
    const s = authStrategyFor(ctx, cfg);
    expect(s.kind).toBe("token");
    if (s.kind === "token") expect(s.token).toBe("ctc_user_abc");
  });

  it("is {kind:'bearer', getToken} for an oauth config; getToken refreshes through bearerFor", async () => {
    const cfg = oauthConfig({ expiresAt: new Date(FIXED_NOW.getTime() + 30_000).toISOString() });
    const s = authStrategyFor(ctx, cfg);
    expect(s.kind).toBe("bearer");
    if (s.kind === "bearer") {
      const t = await s.getToken();
      expect(server.oauth.issuedAccessTokens.has(t)).toBe(true);
    }
  });
});
