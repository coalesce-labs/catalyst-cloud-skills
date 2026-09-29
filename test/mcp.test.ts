import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { main } from "../src/cli";
import { readManifest, saveConfig } from "../src/config";
import { buildFixtureContract } from "./fixture-contract";
import { makeCtx, tempHome } from "./helpers";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const input = { name: "linear", url: "https://mcp.linear.app/mcp", auth: { kind: "bearer", secretName: "LINEAR_API_KEY" } };
const server = { id: "srv-1", ...input, status: "pending" };

function setup(body: unknown = { outcome: "registered", server }, status = 201, withRoutes = true) {
  const home = tempHome();
  homes.push(home);
  const calls: { method: string; url: string; body: unknown; headers: Headers }[] = [];
  const doc = buildFixtureContract();
  if (withRoutes) doc.routes = [...doc.routes,
    { method: "GET", path: "/api/v1/agent/portal-servers", takesWriteBudgetUnit: false, since: "1.18.0" },
    { method: "POST", path: "/api/v1/agent/portal-servers/register", takesWriteBudgetUnit: false, since: "1.18.0" },
    { method: "POST", path: "/api/v1/agent/portal-servers/remove", takesWriteBudgetUnit: false, since: "1.18.0" },
  ];
  const ctx = makeCtx(home, { fetch: async (target, init) => {
    const url = String(target);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null, headers: new Headers(init?.headers) });
    if (url.endsWith("/agent/contract")) return Response.json(doc, { headers: { etag: '"mcp"' } });
    return Response.json(body, { status });
  } });
  saveConfig(home, { baseUrl: "https://cloud.example", key: "ctc_acct_test", account: "tenant-test", slug: "test", name: "Test", permissions: ["mirror:read", "mirror:write"], principal: "service", joinedAt: "2026-09-23T00:00:00Z", lastSkillBundleVersion: readManifest().version });
  return { ctx, calls };
}

describe("catalyst-skills mcp", () => {
  it("registers a bearer reference and explains pending approval", async () => {
    const { ctx, calls } = setup();
    expect(await main(["mcp", "add", "linear", "--url", input.url, "--bearer", "LINEAR_API_KEY"], ctx)).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ method: "POST", body: input });
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer ctc_acct_test");
    expect(ctx.out.join(" ")).toContain("waiting for admin approval");
    expect(ctx.out.join(" ")).toContain("srv-1");
  });

  it("shows catalog readiness and preserves machine-readable server status", async () => {
    const { ctx } = setup({ outcome: "registered", server: { ...server, status: "ready" } });
    expect(await main(["mcp", "add", "catalog", "--url", input.url, "--auth", "none", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out[0] ?? "{}").server.status).toBe("ready");
  });

  it("passes a header bundle as named references", async () => {
    const { ctx, calls } = setup();
    expect(await main(["mcp", "add", "hyperdx", "--url", "https://hyperdx.example/mcp", "--header", "CF-Access-Client-Id=ACCESS_ID", "--header", "CF-Access-Client-Secret=ACCESS_SECRET", "--header", "Authorization=HYPERDX_AUTH"], ctx)).toBe(0);
    expect(calls[1]?.body).toMatchObject({ auth: { kind: "headers", headers: [
      { name: "CF-Access-Client-Id", secretName: "ACCESS_ID" },
      { name: "CF-Access-Client-Secret", secretName: "ACCESS_SECRET" },
      { name: "Authorization", secretName: "HYPERDX_AUTH" },
    ] } });
  });

  it("lists metadata and removes by name through the SDK", async () => {
    const a = setup({ outcome: "ok", servers: [server] }, 200);
    expect(await main(["mcp", "list"], a.ctx)).toBe(0);
    expect(a.calls[1]?.method).toBe("GET");
    expect(a.ctx.out.join(" ")).toContain(input.url);
    expect(a.ctx.out.join(" ")).toContain("LINEAR_API_KEY");
    expect(a.ctx.out.join(" ")).toContain("waiting for admin approval");
    const b = setup({ outcome: "removed", removed: false }, 200);
    expect(await main(["mcp", "remove", "linear", "--json"], b.ctx)).toBe(0);
    expect(b.calls[1]?.body).toEqual({ name: "linear" });
    expect(JSON.parse(b.ctx.out[0] ?? "{}")).toMatchObject({ outcome: "removed", removed: false });
  });

  it("names a missing secret and returns a failure exit", async () => {
    const { ctx } = setup({ error: "secret_not_found", reason: "vault secret NOPE is absent" }, 400);
    expect(await main(["mcp", "add", "linear", "--url", input.url, "--bearer", "NOPE"], ctx)).toBe(2);
    expect(ctx.err.join(" ")).toContain("NOPE");
    expect(ctx.out).toHaveLength(0);
  });

  it("does not write when the cloud does not advertise the route", async () => {
    const { ctx, calls } = setup({}, 200, false);
    expect(await main(["mcp", "add", "linear", "--url", input.url, "--auth", "none"], ctx)).toBe(2);
    expect(calls).toHaveLength(1);
    expect(ctx.err.join(" ")).toContain("portal-servers/register");
  });

  it.each([
    ["--bearer", "literal-secret-with-dashes"],
    ["--bearer", "KEY", "--auth", "none"],
    ["--header", "X-Key=KEY", "--header", "x-key=OTHER"],
    ["--header", "Host=HOST"],
    ["--header", "Proxy-Authorization=KEY"],
    ["--header", "Connection=KEY"],
    ["--header", "Transfer-Encoding=KEY"],
    ["--header", "Content-Length=KEY"],
  ])("refuses unsafe or conflicting auth before a request: %j", async (...flags) => {
    const { ctx, calls } = setup();
    expect(await main(["mcp", "add", "linear", "--url", input.url, ...flags], ctx)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(ctx.err.join(" ")).not.toContain("literal-secret-with-dashes");
  });

  it.each([
    ["mcp", "list", "extra"],
    ["mcp", "list", "--bearer", "KEY"],
    ["mcp", "remove"],
    ["mcp", "remove", "linear", "--url", input.url],
    ["mcp", "add", "linear", "--url", "https://user:secret@example.com", "--auth", "none"],
    ["mcp", "add", "linear", "--url", "https://example.com/#secret", "--auth", "none"],
    ["mcp", "add", "linear", "--url", "http://example.com", "--auth", "none"],
    ["mcp", "add", "linear", "--url", "https://example.com/?user_id=someone", "--auth", "none"],
    ["mcp", "add", "linear", "--url", "https://example.com/?", "--auth", "none"],
    ["mcp", "add", "linear", "--url", "https://example.com/#", "--auth", "none"],
  ])("rejects invalid command input before any request: %j", async (...argv) => {
    const { ctx, calls } = setup();
    expect(await main(argv, ctx)).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("documents all three verbs", async () => {
    const { ctx, calls } = setup();
    expect(await main(["mcp", "--help"], ctx)).toBe(0);
    expect(ctx.out.join(" ")).toContain("mcp <add");
    expect(ctx.out.join(" ")).toContain("--header");
    expect(calls).toHaveLength(0);
  });
  it("does not describe an egress-held custom server as ready", async () => {
    const { ctx } = setup({ outcome: "ok", servers: [{ ...server, status: "pending_egress_guard" }] }, 200);
    expect(await main(["mcp", "list"], ctx)).toBe(0);
    expect(ctx.out.join(" ")).toContain("waiting for public egress guard");
    expect(ctx.out.join(" ")).not.toContain(": ready");
  });

});
