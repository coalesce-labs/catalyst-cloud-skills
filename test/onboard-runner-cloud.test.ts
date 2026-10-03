import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { defaultCtx, writeConfig } from "../src/config.js";
import { runnerAdmission, issueRunnerOrgKey, verifyRunnerRoutes } from "../src/onboard-runner-cloud.js";
import { verifyOnboardRoutes } from "../src/onboard-capabilities.js";
import { onboardRunnerAdapter } from "../src/onboard-runner.js";
import { isTenantContract } from "@catalyst-cloud/sdk";
import { buildFixtureContract } from "./fixture-contract.js";
import type { OnboardJournal } from "../src/onboard.js";

const rows = [
  ["GET", "runner-admission"], ["PUT", "runner-admission"],
  ["POST", "runner-keys"], ["GET", "runner-keys/:requestId"], ["DELETE", "runner-keys/:requestId"],
].map(([method,path]) => ({method,path:"/api/v1/agent/"+path,personalBearer:true,takesWriteBudgetUnit:false,idempotencyKeyField:method === "POST" ? "requestId" : null}));
const legacyRow = { method:"GET" as const, path:"/api/v1/me/connections/linear/workspace", personalBearer:true };
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const origin = "https://runner-cloud.test";
const scopes = ["mirror:read", "mirror:write", "mirror:feed"];
const secret = "ctc_acct_fixture_only_runner_key";
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "runner-cloud-")); homes.push(home);
  const ctx = { ...defaultCtx(), home, env: {}, now: () => new Date("2026-10-02T16:00:00Z"), stdout: () => {}, stderr: () => {} };
  writeConfig(home, { baseUrl: origin, account: "account-a", slug: "a", name: "Fixture", principal: "service", permissions: ["mirror:read", "mirror:write"], key: "ctc_user_fixture_only", user: { id: "person-a", role: "owner", label: "Fixture", email: null, linearUserId: null }, joinedAt: ctx.now().toISOString(), lastSkillBundleVersion: "fixture" });
  const journal: OnboardJournal = { schema: 1, runId: "fixture", cli: "fixture", installer: null, tenant: "account-a", account: "account-a", membershipId: "person-a", baseUrl: origin, steps: [], changes: [], exit: null };
  const setup = { dir: join(home, "runner"), teamId: "team-a", hostName: "catalyst-fixture" };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const stores: string[] = [];
  const state = { advertised: true, admitted: false, unsafe: false, mintLost: false, writeFails: false, issued: false, keyAccount: "account-a", permissions: scopes, keyPosts: 0, runnerSection: { schema: 1, routes: rows } as unknown, contractAccount: "account-a" };
  ctx.fetch = async (input, init) => {
    const url = new URL(String(input)); expect(url.origin).toBe(origin);
    expect(init?.redirect).toBe("error"); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ctc_user_fixture_only");
    const method = init?.method ?? "GET"; const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/v1/agent/contract") {
      const doc=buildFixtureContract();
      return Response.json({...doc,account:{...doc.account,id:state.contractAccount}, onboarding:{schema:1,routes:[legacyRow],web:{connections:"/a/account/connections",personalConnections:"/settings/connected-accounts"}}, ...(state.advertised ? {runnerOnboarding:state.runnerSection} : {})});
    }
    if (url.pathname === "/api/v1/agent/runner-admission") {
      expect(url.searchParams.get("team")).toBe("team-a"); expect(url.searchParams.get("account")).toBe("account-a");
      if (method === "PUT") {
        expect(body).toEqual({ admissionEnabled: true });
        if (state.unsafe) return Response.json({ refusal: "unsafe_policy" }, { status: 409 });
        state.admitted = true;
      }
      return Response.json({ account: "account-a", team: "team-a", admissionEnabled: state.admitted, revision: 1, changed: method === "PUT" });
    }
    if (url.pathname === "/api/v1/agent/runner-keys" && method === "POST") {
      const marker = JSON.parse(readFileSync(join(setup.dir, "key-request.json"), "utf8"));
      expect(marker.requestId).toBe(body.requestId); expect(Object.keys(body).sort()).toEqual(["name", "requestId"]);
      state.keyPosts++; state.issued = true;
      if (state.mintLost) throw new Error("provider secret must never escape "+secret);
      return Response.json({ account: state.keyAccount, requestId: body.requestId, status: "issued", key: { id: "key-fixture", name: setup.hostName, permissions: state.permissions, obfuscatedValue: "ctc_acct_…", createdAt: ctx.now().toISOString(), value: secret }, revoke: { method: "DELETE", path: "/api/v1/agent/runner-keys/"+body.requestId } }, { status: 201 });
    }
    if (url.pathname.startsWith("/api/v1/agent/runner-keys/")) return state.issued
      ? Response.json({ account: "account-a", requestId: url.pathname.split("/").at(-1), status: "issued", secretAvailable: false, key: { id: "key-fixture", permissions: scopes } })
      : new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  };
  const store = async (value: string) => { if (state.writeFails) return false; stores.push(value); return true; };
  return { ctx, journal, setup, state, calls, stores, store };
}

test("a read never enables admission; an explicit act submits only admissionEnabled", async () => {
  const f = fixture();
  expect(await runnerAdmission(f.ctx, f.journal, "team-a", false)).toEqual({ ready: false });
  expect(f.calls.some(call => call.method === "PUT")).toBe(false);
  expect(await runnerAdmission(f.ctx, f.journal, "team-a", true)).toEqual({ ready: true });
  expect(f.calls.filter(call => call.method === "PUT")).toHaveLength(1);
});

test("unsafe existing policy remains an operator refusal", async () => {
  const f = fixture(); f.state.unsafe = true;
  expect(await runnerAdmission(f.ctx, f.journal, "team-a", true)).toEqual({ reason: "runner_admission_operator" });
  expect(f.state.admitted).toBe(false);
});

test("unadvertised routes cannot mint or change admission", async () => {
  const f = fixture(); f.state.advertised = false;
  expect(await runnerAdmission(f.ctx, f.journal, "team-a", true)).toMatchObject({ reason: "cloud_capability_unavailable" });
  expect(await issueRunnerOrgKey(f.ctx, f.journal, f.setup, f.store)).toMatchObject({ reason: "cloud_capability_unavailable" });
  expect(f.calls.some(call => call.method !== "GET")).toBe(false); expect(existsSync(f.setup.dir)).toBe(false);
});

test("request UUID is persisted before mint and the one-time value reaches only the volume store", async () => {
  const f = fixture();
  const result = await issueRunnerOrgKey(f.ctx, f.journal, f.setup, f.store);
  expect(result).toEqual({ stored: true }); expect(f.stores).toEqual([secret]);
  expect(JSON.stringify(result)+readFileSync(join(f.setup.dir, "key-request.json"), "utf8")).not.toContain(secret);
});

test("a lost mint response reconciles the same UUID without a second key or revoke", async () => {
  const f = fixture(); f.state.mintLost = true;
  const first = await issueRunnerOrgKey(f.ctx, f.journal, f.setup, f.store);
  expect(JSON.stringify(first)).not.toContain(secret);
  const marker = readFileSync(join(f.setup.dir, "key-request.json"), "utf8");
  const second = await issueRunnerOrgKey(f.ctx, f.journal, f.setup, f.store);
  expect(second).toEqual({ reason: "runner_org_key_recovery_required" });
  expect(readFileSync(join(f.setup.dir, "key-request.json"), "utf8")).toBe(marker);
  expect(f.state.keyPosts).toBe(1); expect(f.stores).toEqual([]);
  expect(f.calls.some(call => call.method === "DELETE")).toBe(false);
});

test("a volume write failure cannot cause a second provider key on retry", async () => {
  const f = fixture(); f.state.writeFails = true;
  expect(await issueRunnerOrgKey(f.ctx, f.journal, f.setup, f.store)).toEqual({ reason: "runner_org_key_write_failed" });
  expect(await issueRunnerOrgKey(f.ctx, f.journal, f.setup, f.store)).toEqual({ reason: "runner_org_key_recovery_required" });
  expect(f.state.keyPosts).toBe(1);
});

test.each(["foreign tenant", "broad scopes"])("a %s mint response cannot be stored", async (kind) => {
  const f = fixture(); if (kind === "foreign tenant") f.state.keyAccount = "account-b"; else f.state.permissions = [...scopes,"admin:write"];
  expect(await issueRunnerOrgKey(f.ctx, f.journal, f.setup, f.store)).toMatchObject({ reason: "runner_org_key_response_unverified" });
  expect(f.stores).toEqual([]);
});


test("an isolated additive fixture preserves the unchanged legacy reader and default-no runner", async () => {
  const f=fixture();
  const response=await f.ctx.fetch(origin+"/api/v1/agent/contract",{redirect:"error",headers:{authorization:"Bearer ctc_user_fixture_only"}});
  const doc: unknown=await response.json();
  if(!doc || typeof doc!=="object" || !("routes" in doc) || !Array.isArray(doc.routes))throw new Error("fixture shape");
  expect(isTenantContract(doc)).toBe(true);
  // Source SHA is byte-identical to skills-bundle-v0.14.10; this calls the unchanged legacy reader.
  expect(await verifyOnboardRoutes(f.ctx,f.journal,[legacyRow])).toEqual({origin});
  const calls=f.calls.length;
  expect(await onboardRunnerAdapter({selected:false}).check(f.ctx,f.journal)).toMatchObject({state:"skipped"});
  expect(f.calls).toHaveLength(calls);
  expect(isTenantContract({...doc,routes:[...doc.routes,{method:"DELETE",path:"/api/v1/agent/runner-keys/:requestId",takesWriteBudgetUnit:false,since:"2.3.0"}]})).toBe(false);
});

test.each([undefined,{schema:2,routes:rows},{schema:1,routes:"bad"},{schema:1,routes:[...rows,rows[0]]},
  ...["method","path","personalBearer","takesWriteBudgetUnit","idempotencyKeyField"].map(field=>({schema:1,routes:[{...rows[0],[field]:field === "method" ? "DELETE" : field === "path" ? "/api/v1/agent/runner-keys/:anything" : field === "idempotencyKeyField" ? "requestId" : field === "personalBearer" ? false : true}]}))
])("a malformed optional runner section refuses only runner support (%j)",async section=>{
  const f=fixture();f.state.runnerSection=section;
  expect(await verifyOnboardRoutes(f.ctx,f.journal,[legacyRow])).toEqual({origin});
  expect(await verifyRunnerRoutes(f.ctx,f.journal,[{method:"GET",path:"/api/v1/agent/runner-admission"}])).toMatchObject({reason:section === undefined ? "cloud_capability_unavailable" : "runner_capability_unverified"});
  expect(f.calls.some(c=>c.method!=="GET")).toBe(false);
});

test("runner capability requires exact tenant and a known row",async()=>{
 const f=fixture();f.state.contractAccount="account-b";
 expect(await verifyRunnerRoutes(f.ctx,f.journal,[{method:"GET",path:"/api/v1/agent/runner-admission"}])).toMatchObject({reason:"runner_identity_unverified"});
 f.state.contractAccount="account-a";f.state.runnerSection={schema:1,routes:[rows[0]]};
 expect(await verifyRunnerRoutes(f.ctx,f.journal,[{method:"PUT",path:"/api/v1/agent/runner-admission"}])).toMatchObject({reason:"cloud_capability_unavailable"});
});


test("a POST lost before its claim retries the same UUID after exact not_found",async()=>{
 const f=fixture(),fetch=f.ctx.fetch;let fail=true;
 f.ctx.fetch=async(input,init)=>{
  const url=new URL(String(input));
  if(url.pathname==="/api/v1/agent/runner-keys" && init?.method==="POST" && fail){fail=false;throw new Error("request never arrived");}
  if(url.pathname.startsWith("/api/v1/agent/runner-keys/") && !f.state.issued)return Response.json({error:"not_found"},{status:404});
  return fetch(input,init);
 };
 expect(await issueRunnerOrgKey(f.ctx,f.journal,f.setup,f.store)).toEqual({reason:"runner_cloud_unavailable"});
 const marker=readFileSync(join(f.setup.dir,"key-request.json"),"utf8");
 expect(await issueRunnerOrgKey(f.ctx,f.journal,f.setup,f.store)).toEqual({stored:true});
 expect(readFileSync(join(f.setup.dir,"key-request.json"),"utf8")).toBe(marker);
 expect(f.state.keyPosts).toBe(1);expect(f.stores).toEqual([secret]);
 expect(f.calls.find(c=>c.method==="POST")?.body).toMatchObject({requestId:JSON.parse(marker).requestId});
});

test.each([{status:404,body:{error:"organization_not_found"}},{status:404,body:null},{status:404,body:{error:"not_found",account:"account-b"}},{status:409,body:{error:"mint_outcome_unknown"}},{status:503,body:{error:"runner_key_service_unavailable"}}])("an uncertain/foreign key lookup never retries mint (%j)",async response=>{
 const f=fixture();f.state.mintLost=true;
 await issueRunnerOrgKey(f.ctx,f.journal,f.setup,f.store);
 const fetch=f.ctx.fetch;
 f.ctx.fetch=async(input,init)=>String(input).includes("/runner-keys/") ? Response.json(response.body,{status:response.status}):fetch(input,init);
 expect(await issueRunnerOrgKey(f.ctx,f.journal,f.setup,f.store)).toEqual({reason:"runner_org_key_reconciliation_pending"});
 expect(f.state.keyPosts).toBe(1);expect(f.stores).toEqual([]);
});
