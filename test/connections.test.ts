import { beforeEach, describe, expect, test } from "vitest";
import type { TenantClient } from "@catalyst-cloud/sdk";
import { main } from "../src/cli";
import { readManifest, writeConfig, type CustomerConfig } from "../src/config";
import { makeCtx, tempHome, type TestCtx } from "./helpers";

const URL = "https://cloud.example/connect/linear/personal/start?handoff=signed";
let ctx: TestCtx;
let config: CustomerConfig;

beforeEach(() => {
  const home = tempHome();
  ctx = makeCtx(home);
  config = {
    baseUrl: "https://cloud.example",
    key: "ctc_user_member",
    account: "tenant-1",
    slug: "example",
    name: "Example",
    permissions: ["mirror:read"],
    principal: "service",
    user: { id: "member-1", label: "Member", email: null, role: "member", linearUserId: null },
    joinedAt: "2026-09-24T00:00:00Z",
    lastSkillBundleVersion: readManifest().version,
  };
  writeConfig(home, config);
});

function fakeClient(statuses: Awaited<ReturnType<TenantClient["personalConnections"]["status"]>>[]) {
  let index = 0;
  const personalConnections: TenantClient["personalConnections"] = {
    start: async () => ({ outcome: "ok", status: 200, authorizationUrl: URL, expiresAt: 1_800_000_000_000 }),
    status: async () => statuses[Math.min(index++, statuses.length - 1)]!,
  };
  return { personalConnections };
}

describe("connections personal", () => {
  test("starts consent through the typed SDK, opens the browser, and prints a resumable status command", async () => {
    const opened: string[] = [];
    const keys: string[] = [];
    const code = await main(["connections", "personal", "linear", "start"], ctx, {
      connections: {
        createClient: (options) => {
          keys.push(options.key);
          return fakeClient([{ outcome: "absent", status: 200 }]);
        },
        openBrowser: (url) => opened.push(url),
      },
    });
    expect(code).toBe(0);
    expect(keys).toEqual(["ctc_user_member"]);
    expect(opened).toEqual([URL]);
    expect(ctx.out.join("\n")).toContain(`catalyst-skills connections personal linear status`);
  });

  test("--json returns only the SDK result and leaves browser opening to the caller", async () => {
    const opened: string[] = [];
    expect(await main(["connections", "personal", "linear", "start", "--json"], ctx, {
      connections: { createClient: () => fakeClient([{ outcome: "absent", status: 200 }]), openBrowser: (url) => opened.push(url) },
    })).toBe(0);
    expect(JSON.parse(ctx.out.join(""))).toEqual({ outcome: "ok", status: 200, authorizationUrl: URL, expiresAt: 1_800_000_000_000 });
    expect(opened).toEqual([]);
  });

  test("status preserves absent, lapsed, connected, and uncertain results", async () => {
    const statuses = [
      { outcome: "absent", status: 200 } as const,
      { outcome: "lapsed", status: 200, lapsedAt: null } as const,
      { outcome: "connected", status: 200, provider: "linear", linearUserId: "lin-1", grantedScope: null, updatedAt: 1, expiresAt: null } as const,
      { outcome: "unavailable", status: 503, provider: "linear" } as const,
    ];
    const fake = fakeClient(statuses);
    const deps = { connections: { createClient: () => fake } };
    expect(await main(["connections", "personal", "linear", "status", "--json"], ctx, deps)).toBe(0);
    expect(await main(["connections", "personal", "linear", "status", "--json"], ctx, deps)).toBe(0);
    expect(await main(["connections", "personal", "linear", "status", "--json"], ctx, deps)).toBe(0);
    expect(await main(["connections", "personal", "linear", "status", "--json"], ctx, deps)).toBe(1);
    expect(ctx.out.map((line) => JSON.parse(line).outcome)).toEqual(["absent", "lapsed", "connected", "unavailable"]);
  });

  test("--wait is bounded and the final result is resumable", async () => {
    const sleeps: number[] = [];
    const fake = fakeClient([
      { outcome: "absent", status: 200 },
      { outcome: "connected", status: 200, provider: "linear", linearUserId: "lin-1", grantedScope: null, updatedAt: 1, expiresAt: null },
    ]);
    expect(await main(["connections", "personal", "linear", "start", "--wait", "20", "--json"], ctx, {
      connections: { createClient: () => fake, sleep: async (ms) => { sleeps.push(ms); } },
    })).toBe(0);
    expect(sleeps).toEqual([10_000]);
    expect(JSON.parse(ctx.out.join(""))).toMatchObject({ status: { outcome: "connected" }, waitedSeconds: 10 });
  });

  test("a host credential and malformed arguments refuse before an SDK call", async () => {
    writeConfig(ctx.home, { ...config, key: "ctc_acct_host", user: undefined });
    let called = false;
    expect(await main(["connections", "personal", "linear", "status"], ctx, {
      connections: { createClient: () => { called = true; return fakeClient([{ outcome: "absent", status: 200 }]); } },
    })).toBeGreaterThan(0);
    expect(called).toBe(false);
    expect(ctx.err.join("\n")).toContain("member credential");
    expect(await main(["connections", "personal", "jira", "status"], ctx)).toBe(1);
  });
});
