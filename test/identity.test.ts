import { beforeEach, describe, expect, test } from "vitest";
import type { TenantClient, LinearIdentityResult } from "@catalyst-cloud/sdk";
import { main } from "../src/cli";
import { readManifest, writeConfig, type CustomerConfig } from "../src/config";
import { makeCtx, tempHome, type TestCtx } from "./helpers";
let ctx: TestCtx;
let config: CustomerConfig;
beforeEach(() => {
  const home = tempHome(); ctx = makeCtx(home);
  config = { baseUrl: "https://cloud.example", key: "ctc_user_self", account: "tenant", slug: "tenant", name: "Tenant", permissions: ["mirror:read"], principal: "service", user: { id: "self", label: "Self", email: null, role: "member", linearUserId: null }, joinedAt: "2026-09-25T00:00:00Z", lastSkillBundleVersion: readManifest().version };
  writeConfig(home, config);
});
function fake(readback: LinearIdentityResult, selected: LinearIdentityResult = readback) {
  const calls: string[] = [];
  const linearIdentity: TenantClient["linearIdentity"] = {
    get: async () => { calls.push("get"); return readback; },
    set: async (id) => { calls.push(`set:${id}`); return selected; },
  };
  return { calls, client: { linearIdentity } };
}
const manual = { outcome: "ok", identity: { resolution: "manual", linearUserId: "lin_self", resolvedAt: 123, resolvedBy: "self" } } as const;
describe("identity linear", () => {
  test("shows an unresolved identity and offered choices through the typed SDK", async () => {
    const f = fake({ outcome: "ok", identity: { resolution: "no_match" }, options: [{ id: "lin_self", name: "Self", displayName: null, avatarUrl: null }] });
    expect(await main(["identity", "linear", "options", "--json"], ctx, { identity: { createClient: () => f.client } })).toBe(0);
    expect(JSON.parse(ctx.out.join(""))).toMatchObject({ identity: { resolution: "no_match" }, options: [{ id: "lin_self" }] });
    expect(f.calls).toEqual(["get"]);
  });
  test("sets an explicit choice and verifies it with a fresh GET", async () => {
    const f = fake(manual);
    expect(await main(["identity", "linear", "set", "lin_self", "--json"], ctx, { identity: { createClient: () => f.client } })).toBe(0);
    expect(f.calls).toEqual(["set:lin_self", "get"]);
    expect(JSON.parse(ctx.out.join(""))).toEqual(manual);
  });
  test("does not claim success when readback is unresolved or different", async () => {
    const f = fake({ outcome: "ok", identity: { resolution: "no_match" } }, manual);
    expect(await main(["identity", "linear", "set", "lin_self"], ctx, { identity: { createClient: () => f.client } })).toBe(1);
    expect(ctx.out.join("\n")).toContain("not confirmed");
  });
  test("stops on an existing resolved identity conflict without a second write", async () => {
    const f = fake(manual, { outcome: "conflict", status: 409, reason: "already_resolved" });
    expect(await main(["identity", "linear", "set", "lin_self"], ctx, { identity: { createClient: () => f.client } })).toBe(1);
    expect(f.calls).toEqual(["set:lin_self"]);
    expect(ctx.out.join("\n")).toContain("already_resolved");
  });
  test("distinguishes an unavailable choice list from an empty roster", async () => {
    const f = fake({ outcome: "ok", identity: { resolution: "no_match" } });
    expect(await main(["identity", "linear", "options"], ctx, { identity: { createClient: () => f.client } })).toBe(0);
    expect(ctx.out.join("\n")).toContain("No choices were offered");
  });
  test("requires member login and an explicit id before calling the SDK", async () => {
    const f = fake(manual);
    expect(await main(["identity", "linear", "set"], ctx, { identity: { createClient: () => f.client } })).not.toBe(0);
    delete config.user; writeConfig(ctx.home, config);
    expect(await main(["identity", "linear", "status"], ctx, { identity: { createClient: () => f.client } })).not.toBe(0);
    expect(f.calls).toEqual([]);
  });
});
