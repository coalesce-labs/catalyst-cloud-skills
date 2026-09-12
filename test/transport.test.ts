// transport.test.ts — the credential-aware transport's status lines: 401, 403, 429 with and without the
// budget, a non-JSON error body, a generic status, a network failure on POST, fetchMe's shape errors,
// and (CTC-2112) an OAuth config refreshing its bearer before a request.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { CliError, MeError } from "../src/errors";
import { ApiClient, apiClient, fetchMe } from "../src/transport";
import type { CustomerConfig } from "../src/config";
import { resetDiscoveryCache } from "../src/oauth";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, tempHome } from "./helpers";

let server: Server;
let url: string;
let mode: { status: number; body: string; headers?: Record<string, string> };

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(mode.status, { "content-type": "application/json", ...(mode.headers ?? {}) });
    res.end(mode.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function client(): ApiClient {
  return new ApiClient(`${url}/`, async () => "k", fetch);
}

describe("ApiClient", () => {
  test("url joins the base, the path and only defined query values", () => {
    expect(client().url("/api/v1/x", { a: "1", b: undefined, c: 2 })).toBe(`${url}/api/v1/x?a=1&c=2`);
  });
  test("401 → unauthorized line without the key", async () => {
    mode = { status: 401, body: JSON.stringify({ error: "unauthorized" }) };
    const err = await client().getJson("/api/v1/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("unauthorized");
    expect((err as Error).message).not.toContain("k)");
  });
  test("403 → forbidden line naming the reason", async () => {
    mode = { status: 403, body: JSON.stringify({ reason: "machine-principal-required" }) };
    const err = (await client().postJson("/api/v1/x", {}).catch((e: unknown) => e)) as CliError;
    expect(err.code).toBe("forbidden");
    expect(err.message).toContain("machine-principal-required");
  });
  test("429 without a budget word is rate-limited; with it, budget", async () => {
    mode = { status: 429, body: JSON.stringify({ error: "slow down" }), headers: { "retry-after": "5" } };
    const a = (await client().getJson("/api/v1/x").catch((e: unknown) => e)) as CliError;
    expect(a.code).toBe("rate-limited");
    expect(a.message).toContain("retry after 5s");
    mode = { status: 429, body: JSON.stringify({ message: "write budget exhausted" }) };
    const b = (await client().postJson("/api/v1/x", {}).catch((e: unknown) => e)) as CliError;
    expect(b.code).toBe("budget");
  });
  test("a non-JSON error body becomes the reason; a JSON 200 with garbage is a shape error", async () => {
    mode = { status: 500, body: "<html>oops</html>" };
    const err = (await client().getJson("/api/v1/x").catch((e: unknown) => e)) as CliError;
    expect(err.code).toBe("http");
    expect(err.message).toContain("<html>oops</html>");
    mode = { status: 200, body: "not json" };
    await expect(client().getJson("/api/v1/x")).rejects.toMatchObject({ kind: "shape" });
    await expect(client().postJson("/api/v1/x", {})).rejects.toMatchObject({ kind: "shape" });
  });
  test("accepted statuses return an empty body instead of throwing", async () => {
    mode = { status: 404, body: JSON.stringify({ error: "nope" }) };
    const res = await client().getJson("/api/v1/x", { accept: [404] });
    expect(res.status).toBe(404);
    expect(res.body).toBeUndefined();
  });
  test("a dead server is a network MeError on GET and POST", async () => {
    const dead = new ApiClient("http://127.0.0.1:1", async () => "k", fetch);
    await expect(dead.getJson("/x")).rejects.toMatchObject({ kind: "network" });
    await expect(dead.postJson("/x", {})).rejects.toMatchObject({ kind: "network" });
  });
});

describe("apiClient — the OAuth rail refreshes before a request (CTC-2112)", () => {
  let oauthServer: FixtureServer;
  beforeAll(async () => {
    oauthServer = await startMeFixture();
  });
  afterAll(async () => {
    await oauthServer.close();
  });

  test("a request with an oauth config within 60s of expiry refreshes first, then sends the rotated bearer", async () => {
    resetDiscoveryCache();
    const home = tempHome();
    const now = new Date("2026-09-12T12:00:00Z");
    const ctx = makeCtx(home, { now: () => now });
    const cfg: CustomerConfig = {
      baseUrl: oauthServer.url,
      account: "acct",
      slug: "s",
      name: "n",
      permissions: null,
      principal: "service",
      joinedAt: now.toISOString(),
      lastSkillBundleVersion: "0.4.0",
      auth: { kind: "oauth", accessToken: "stale", refreshToken: "rt-old", expiresAt: new Date(now.getTime() + 30_000).toISOString(), sessionId: "session_fixture" },
    };
    const res = await apiClient(cfg, ctx).getJson("/api/v1/issues");
    expect(res.status).toBe(200);
    expect(oauthServer.oauth.refreshCount).toBe(1);
    // the issues request carried the rotated bearer, not the stale one
    const issuesReq = oauthServer.requests.find((r) => r.path === "/api/v1/issues");
    const sentBearer = String(issuesReq?.headers.authorization ?? "").replace("Bearer ", "");
    expect(oauthServer.oauth.issuedAccessTokens.has(sentBearer)).toBe(true);
    expect(sentBearer).not.toBe("stale");
  });
});

describe("fetchMe", () => {
  test("a non-401 failure carries the reason; a non-JSON failure carries the status", async () => {
    mode = { status: 503, body: JSON.stringify({ reason: "tenant-offline" }) };
    await expect(fetchMe(url, "k", fetch)).rejects.toThrow(/tenant-offline/);
    mode = { status: 502, body: "bad gateway" };
    await expect(fetchMe(url, "k", fetch)).rejects.toThrow(/HTTP 502/);
  });
  test("a non-JSON 200 is a shape error; a wrong principal is a shape error", async () => {
    mode = { status: 200, body: "nope" };
    await expect(fetchMe(url, "k", fetch)).rejects.toMatchObject({ kind: "shape" });
    mode = { status: 200, body: JSON.stringify({ account: "a", slug: "s", name: "n", permissions: null, principal: "robot" }) };
    const err = await fetchMe(url, "k", fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeError);
    expect((err as MeError).kind).toBe("shape");
  });
});
