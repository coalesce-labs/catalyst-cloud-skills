// contract.ts — GET /api/v1/agent/contract, cached with its ETag at ~/.config/catalyst-cloud/contract.json.
// Every tenant fact a verb needs (stage ids, label ids, route paths, the bookkeeping marker, thresholds)
// is read from here; no verb carries a literal fallback for any of them.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { contractPathFor, readManifest, type Ctx, type CustomerConfig } from "./config.js";
import type { ContractTeam, TenantContract, WorkflowSlot } from "./contract-types.js";
import { CliError, MeError } from "./errors.js";
import { apiClient } from "./http.js";

export const CONTRACT_ROUTE = "/api/v1/agent/contract";

export interface ContractCache {
  etag: string | null;
  fetchedAt: string;
  contractVersion: string;
  doc: TenantContract;
}

export interface LoadedContract {
  doc: TenantContract;
  source: "cache" | "network" | "revalidated";
  ageSeconds: number;
  path: string;
}

export function readContractCache(home: string): ContractCache | null {
  const path = contractPathFor(home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ContractCache>;
    if (typeof parsed.fetchedAt !== "string" || typeof parsed.contractVersion !== "string" || !parsed.doc) return null;
    return parsed as ContractCache;
  } catch {
    return null;
  }
}

export function writeContractCache(home: string, cache: ContractCache): string {
  const path = contractPathFor(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** `1.x` → major 1; `1.2.3` → exact; `unpinned` → anything. Returns null when the range is unparseable. */
export function contractVersionInRange(version: string, range: string): boolean | null {
  if (range === "unpinned") return true;
  const major = /^(\d+)\.x$/.exec(range);
  if (major) return version.split(".")[0] === major[1];
  if (/^\d+\.\d+\.\d+$/.test(range)) return version === range;
  return null;
}

export function assertContractRange(version: string, range: string): void {
  const ok = contractVersionInRange(version, range);
  if (ok === null) throw new CliError(`tenantContractRange "${range}" in package.json is not a range this CLI understands`, "contract-range");
  if (!ok) {
    throw new CliError(
      `the tenant serves contract version ${version} but this bundle accepts ${range} — update the bundle (npm update -g @catalyst-cloud/catalyst-skills) or ask your tenant admin which version is live`,
      "contract-version",
    );
  }
}

export interface LoadContractOptions {
  refresh?: boolean;
  /** Skip the network entirely: use the cache if any, else refuse. */
  offline?: boolean;
}

/**
 * Load the contract per the cloud's own cache policy: a cache younger than `doc.cache.maxAgeSeconds`
 * is used as-is; otherwise a conditional GET revalidates it (304 refreshes `fetchedAt`, 200 replaces
 * the document). A network failure on a cache older than `staleRefusalSeconds` refuses; a 403 (a
 * workstation key) refuses naming the account key; a major version outside the bundle's range refuses
 * naming both versions.
 */
export async function loadContract(
  ctx: Ctx,
  cfg: CustomerConfig,
  opts: LoadContractOptions = {},
): Promise<LoadedContract> {
  const path = contractPathFor(ctx.home);
  const cached = readContractCache(ctx.home);
  const nowMs = ctx.now().getTime();
  const ageSeconds = cached ? Math.max(0, Math.floor((nowMs - Date.parse(cached.fetchedAt)) / 1000)) : Infinity;
  const range = readManifest().tenantContractRange;

  if (cached && !opts.refresh && ageSeconds < cached.doc.cache.maxAgeSeconds) {
    assertContractRange(cached.contractVersion, range);
    return { doc: cached.doc, source: "cache", ageSeconds, path };
  }
  if (opts.offline) {
    if (cached) {
      assertContractRange(cached.contractVersion, range);
      return { doc: cached.doc, source: "cache", ageSeconds, path };
    }
    throw new CliError("no cached contract and network reads are disabled", "contract-missing");
  }

  const api = apiClient(cfg, ctx);
  let res;
  try {
    res = await api.getJson<TenantContract>(CONTRACT_ROUTE, { etag: cached?.etag ?? null, accept: [304] });
  } catch (err) {
    if (err instanceof CliError && err.status === 403) {
      throw new CliError(
        `GET ${CONTRACT_ROUTE} refused (403): the contract needs an account key (ctc_acct_…); this key is a workstation key — ask your tenant admin for an account key`,
        "contract-forbidden",
        2,
        403,
      );
    }
    if (err instanceof MeError && err.kind === "network" && cached) {
      if (ageSeconds >= cached.doc.cache.staleRefusalSeconds) {
        throw new CliError(
          `the cached contract is ${ageSeconds}s old (refusal after ${cached.doc.cache.staleRefusalSeconds}s) and the refresh failed: ${err.message}`,
          "contract-stale",
        );
      }
      assertContractRange(cached.contractVersion, range);
      return { doc: cached.doc, source: "cache", ageSeconds, path };
    }
    throw err;
  }

  if (res.status === 304) {
    if (!cached) throw new CliError(`GET ${CONTRACT_ROUTE} answered 304 with no cache to revalidate`, "contract-shape");
    assertContractRange(cached.contractVersion, range);
    writeContractCache(ctx.home, { ...cached, fetchedAt: ctx.now().toISOString() });
    return { doc: cached.doc, source: "revalidated", ageSeconds: 0, path };
  }
  const doc = res.body;
  if (!doc || typeof doc !== "object" || typeof doc.contractVersion !== "string" || !Array.isArray(doc.teams) || !Array.isArray(doc.routes)) {
    throw new CliError(`GET ${CONTRACT_ROUTE} returned an unexpected shape`, "contract-shape");
  }
  const version = res.headers.get("x-catalyst-contract-version") ?? doc.contractVersion;
  assertContractRange(version, range);
  writeContractCache(ctx.home, {
    etag: res.headers.get("etag"),
    fetchedAt: ctx.now().toISOString(),
    contractVersion: version,
    doc,
  });
  return { doc, source: "network", ageSeconds: 0, path };
}

// ── helpers every verb uses ──────────────────────────────────────────────────────────────────────

export function teamByKey(doc: TenantContract, key: string): ContractTeam {
  const wanted = key.toUpperCase();
  const team = doc.teams.find((t) => (t.key ?? "").toUpperCase() === wanted);
  if (!team) {
    const known = doc.teams.map((t) => t.key ?? t.id).join(", ") || "none";
    throw new CliError(`team "${key}" is not on this tenant's contract (teams: ${known})`, "team-unknown");
  }
  return team;
}

export function teamById(doc: TenantContract, id: string): ContractTeam | null {
  return doc.teams.find((t) => t.id === id) ?? null;
}

/** The team a ticket identifier belongs to, by its `KEY-` prefix. */
export function teamForTicket(doc: TenantContract, ticket: string): ContractTeam {
  const dash = ticket.indexOf("-");
  if (dash <= 0) throw new CliError(`"${ticket}" is not a ticket identifier (expected KEY-123)`, "ticket-shape");
  return teamByKey(doc, ticket.slice(0, dash));
}

export function stageIdForSlot(team: ContractTeam, slot: string): string {
  const stage = team.stages[slot as WorkflowSlot];
  if (!stage) {
    const mapped = Object.keys(team.stages).join(", ") || "none";
    throw new CliError(`slot "${slot}" is not mapped for team ${team.key ?? team.id} (mapped: ${mapped})`, "slot-unmapped");
  }
  if (!stage.stateStillExists) {
    throw new CliError(
      `slot "${slot}" on team ${team.key ?? team.id} maps to state ${stage.stateId}, which no longer exists in Linear — fix the mapping in settings first`,
      "slot-stale",
    );
  }
  return stage.stateId;
}

/** Resolve a label by name through the contract's ask/hold/release lists; an unknown name is returned
 *  as-is when it looks like an id (the contract only lists Catalyst's own labels). */
export function labelId(team: ContractTeam, nameOrId: string): string {
  const all = [...team.labels.ask, ...team.labels.hold, ...team.labels.release];
  const hit = all.find((l) => l.name === nameOrId);
  if (hit) {
    if (!hit.preferredId) {
      throw new CliError(`label "${nameOrId}" is absent from this workspace (contract scope: ${hit.scope}) — create it in Linear first`, "label-absent");
    }
    return hit.preferredId;
  }
  return nameOrId;
}

/** The route whose last path segment is `name` (e.g. `issue-comment`). The path itself is never assumed. */
export function routePath(doc: TenantContract, name: string): string {
  const route = doc.routes.find((r) => r.path.split("/").filter(Boolean).at(-1) === name);
  if (!route) {
    throw new CliError(`the tenant contract serves no "${name}" route (routes: ${doc.routes.map((r) => r.path).join(", ")})`, "route-unknown");
  }
  return route.path;
}

export function bookkeepingPrefix(doc: TenantContract): string {
  return doc.vocabulary.bookkeeping.marker;
}

/** Walk a dotted path (`teams.0.stages`) into the document. */
export function pickPath(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const seg of path.split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
