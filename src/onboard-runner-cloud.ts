import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, normalizeBaseUrl, readManifest, type Ctx } from "./config.js";
import { contractVersionInRange } from "./contract.js";
import type { OnboardJournal } from "./onboard.js";

const ADMISSION = "/api/v1/agent/runner-admission";
const KEYS = "/api/v1/agent/runner-keys";
const KEY_RESOURCE = `${KEYS}/:requestId`;
const SCOPES = ["mirror:read", "mirror:write", "mirror:feed"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
type Refusal = { reason: string };
type Binding = Pick<OnboardJournal, "account" | "tenant" | "membershipId" | "baseUrl">;

function identity(ctx: Ctx, binding: Binding) {
  const cfg = loadConfig(ctx.home);
  if (!cfg?.user || !["owner", "admin"].includes(cfg.user.role) || cfg.account !== (binding.account ?? binding.tenant) || cfg.user.id !== binding.membershipId || !binding.baseUrl || normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(binding.baseUrl)) return null;
  const expiry = cfg.auth ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime() : 0;
  const bearer = cfg.key || (cfg.auth && Number.isFinite(expiry) && expiry > 30_000 ? cfg.auth.accessToken : undefined);
  try {
    const url=new URL(cfg.baseUrl);
    if (url.protocol!=="https:" || url.username || url.password || url.search || url.hash || url.pathname!=="/") return null;
    return bearer ? { account: cfg.account, origin: url.origin, bearer } : null;
  } catch { return null; }
}

/** Mutation failures and provider bodies never become terminal/receipt text. */
async function request(ctx: Ctx, binding: Binding, path: string, method: "GET" | "PUT" | "POST", body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> | null } | Refusal> {
  const who = identity(ctx, binding);
  if (!who) return { reason: "runner_identity_unverified" };
  if (signal?.aborted) return { reason: "interrupted" };
  try {
    const response = await ctx.fetch(`${who.origin}${path}`, { method, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${who.bearer}`, accept: "application/json", "cache-control": "no-cache", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = object(await response.json().catch(() => null));
    if (signal?.aborted) return { reason: "interrupted" };
    const current = identity(ctx, binding);
    if (!current || current.account !== who.account || current.origin !== who.origin || current.bearer !== who.bearer) return { reason: "runner_identity_unverified" };
    return { status: response.status, body: value };
  } catch { return { reason: signal?.aborted ? "interrupted" : "runner_cloud_unavailable" }; }
}

export interface RunnerRouteRequirement { method: "GET" | "PUT" | "POST" | "DELETE"; path: string }
const RUNNER_ROUTES = new Map([
  ["GET", ADMISSION], ["PUT", ADMISSION], ["POST", KEYS], ["GET", KEY_RESOURCE], ["DELETE", KEY_RESOURCE],
].map(([method,path])=>[`${method} ${path}`,method === "POST" ? "requestId" : null]));

/** Optional runner discovery never widens either legacy route parser. A fresh same-account
 * personal response advertises exact deployed operations, not authorization or consent. */
export async function verifyRunnerRoutes(ctx: Ctx, binding: Binding, requirements: readonly RunnerRouteRequirement[], signal?: AbortSignal): Promise<{origin:string}|Refusal> {
  const who=identity(ctx,binding);
  if (!who) return {reason:"runner_identity_unverified"};
  const read=await request(ctx,binding,"/api/v1/agent/contract","GET",undefined,signal);
  if ("reason" in read) return read;
  const body=read.body;
  if (read.status!==200) return {reason:"runner_capability_unavailable"};
  if (object(body?.account)?.id!==who.account) return {reason:"runner_identity_unverified"};
  if (!body || typeof body.contractVersion!=="string" || contractVersionInRange(body.contractVersion,readManifest().tenantContractRange)!==true) return {reason:"runner_capability_unverified"};
  if (body.runnerOnboarding===undefined) return {reason:"cloud_capability_unavailable"};
  const section=object(body.runnerOnboarding);
  if (!section || section.schema!==1 || !Array.isArray(section.routes) || section.routes.length>RUNNER_ROUTES.size) return {reason:"runner_capability_unverified"};
  const routes=new Set<string>();
  for (const value of section.routes) {
    const row=object(value);
    if (!row || typeof row.method!=="string" || typeof row.path!=="string") return {reason:"runner_capability_unverified"};
    const key=`${row.method} ${row.path}`;
    if (!RUNNER_ROUTES.has(key) || routes.has(key) || row.personalBearer!==true || row.takesWriteBudgetUnit!==false || row.idempotencyKeyField!==RUNNER_ROUTES.get(key)) return {reason:"runner_capability_unverified"};
    routes.add(key);
  }
  if (requirements.some(row=>!routes.has(`${row.method} ${row.path}`))) return {reason:"cloud_capability_unavailable"};
  return {origin:who.origin};
}

/** Read mode never changes admission. Act sends only the approved field; safe defaults and policy
 * refusal belong to the server. A successful PUT still requires a fresh same-team readback. */
export async function runnerAdmission(ctx: Ctx, journal: Binding, teamId: string, allowAct: boolean, signal?: AbortSignal): Promise<{ ready: boolean } | Refusal> {
  if (!identity(ctx, journal)) return { reason: "runner_identity_unverified" };
  const support = await verifyRunnerRoutes(ctx, journal, [{ method: "GET", path: ADMISSION }, ...(allowAct ? [{ method: "PUT" as const, path: ADMISSION }] : [])], signal);
  if ("reason" in support) return { reason: support.reason };
  const path = `${ADMISSION}?account=${encodeURIComponent((journal.account ?? journal.tenant)!)}&team=${encodeURIComponent(teamId)}`;
  if (allowAct) {
    const write = await request(ctx, journal, path, "PUT", { admissionEnabled: true }, signal);
    if ("reason" in write) return write;
    if (write.status === 409) return { reason: "runner_admission_operator" };
    if (write.status === 403) return { reason: "runner_identity_unverified" };
    if (write.status !== 200) return { reason: "runner_admission_unverified" };
    if (write.body?.account !== (journal.account ?? journal.tenant) || write.body?.team !== teamId || write.body?.admissionEnabled !== true) return { reason: "runner_admission_unverified" };
  }
  const read = await request(ctx, journal, path, "GET", undefined, signal);
  if ("reason" in read) return read;
  if (read.status === 409) return { reason: "runner_admission_operator" };
  if (read.status !== 200 || read.body?.account !== (journal.account ?? journal.tenant) || read.body?.team !== teamId || typeof read.body?.admissionEnabled !== "boolean") return { reason: "runner_admission_unverified" };
  return { ready: read.body.admissionEnabled };
}

interface KeySetup { dir: string; teamId: string; hostName: string }
interface KeyRequest { version: 1; requestId: string; account: string; origin: string; membershipId: string; teamId: string; hostName: string }
/** Exclusive private marker, fsynced before POST. Malformed/foreign markers fail closed; they are
 * never deleted or replaced to obtain a fresh provider key after an uncertain outcome. */
function keyRequest(ctx: Ctx, journal: Binding, setup: KeySetup): { marker: KeyRequest; existing: boolean } | Refusal {
  const who = identity(ctx, journal);
  if (!who || !journal.membershipId) return { reason: "runner_identity_unverified" };
  const path = join(setup.dir, "key-request.json");
  try {
    mkdirSync(setup.dir, { recursive: true, mode: 0o700 });
    if (lstatSync(setup.dir).isSymbolicLink()) return { reason: "runner_org_key_journal_unavailable" };
    const marker: KeyRequest = { version: 1, requestId: randomUUID(), account: who.account, origin: who.origin, membershipId: journal.membershipId, teamId: setup.teamId, hostName: setup.hostName };
    let fd: number;
    try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") return { reason: "runner_org_key_journal_unavailable" };
      const info = lstatSync(path);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096) return { reason: "runner_org_key_journal_unavailable" };
      const old = object(JSON.parse(readFileSync(path, "utf8")));
      if (!old || old.version !== 1 || typeof old.requestId !== "string" || !UUID.test(old.requestId) || Object.entries(marker).some(([key, value]) => key !== "requestId" && old[key] !== value)) return { reason: "runner_org_key_journal_unavailable" };
      return { marker: { ...marker, requestId: old.requestId }, existing: true };
    }
    try { writeFileSync(fd, JSON.stringify(marker)+"\n"); fsyncSync(fd); } finally { closeSync(fd); }
    const directory = openSync(setup.dir, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return { marker, existing: false };
  } catch { return { reason: "runner_org_key_journal_unavailable" }; }
}

/** Called only for an explicitly selected runner that needs a key. One response may carry its
 * value; it goes directly to the private volume. Recovered issuance never silently rotates,
 * revokes or mints a second key. The caller revalidates the stored key before reporting ready. */
export async function issueRunnerOrgKey(ctx: Ctx, journal: Binding, setup: KeySetup, store: (value: string) => Promise<boolean>, signal?: AbortSignal): Promise<{ stored: true } | Refusal> {
  if (!identity(ctx, journal)) return { reason: "runner_identity_unverified" };
  const support = await verifyRunnerRoutes(ctx, journal, [{ method: "POST", path: KEYS }, { method: "GET", path: KEY_RESOURCE }], signal);
  if ("reason" in support) return { reason: support.reason };
  if (signal?.aborted) return { reason: "interrupted" };
  const saved = keyRequest(ctx, journal, setup);
  if ("reason" in saved) return saved;
  const { marker } = saved;
  const suffix = `?account=${encodeURIComponent(marker.account)}`;
  if (saved.existing) {
    const read = await request(ctx, journal, `${KEYS}/${marker.requestId}${suffix}`, "GET", undefined, signal);
    if ("reason" in read) return read;
    // Only the exact deployed no-record response can retry this same UUID. The server's atomic
    // claim prevents a delayed/concurrent POST from minting twice. Pending claims, missing orgs,
    // malformed responses and lost issued values never authorize a new UUID or rotation.
    const absent = read.status === 404 && read.body?.error === "not_found" && Object.keys(read.body).length === 1;
    if (!absent) {
      if (read.status !== 200 || read.body?.account !== marker.account || read.body?.requestId !== marker.requestId) return { reason: "runner_org_key_reconciliation_pending" };
      return { reason: "runner_org_key_recovery_required" };
    }
  }
  const issued = await request(ctx, journal, `${KEYS}${suffix}`, "POST", { requestId: marker.requestId, name: setup.hostName }, signal);
  if ("reason" in issued) return issued;
  if (issued.status === 403) return { reason: "runner_identity_unverified" };
  if (issued.status === 409) return { reason: "runner_org_key_recovery_required" };
  const key = object(issued.body?.key);
  if (issued.status !== 201 || issued.body?.account !== marker.account || issued.body?.requestId !== marker.requestId || issued.body?.status !== "issued" || !key || typeof key.value !== "string" || !/^[\x21-\x7e]{16,1024}$/.test(key.value) || !Array.isArray(key.permissions) || key.permissions.length !== SCOPES.length || !SCOPES.every(scope => (key.permissions as unknown[]).includes(scope))) return { reason: "runner_org_key_response_unverified" };
  if (signal?.aborted) return { reason: "interrupted" };
  try { return await store(key.value) ? { stored: true } : { reason: "runner_org_key_write_failed" }; }
  catch { return { reason: "runner_org_key_write_failed" }; }
}
