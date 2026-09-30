import type { ParsedArgs } from "./args.js";
import { loadConfig, normalizeBaseUrl, readManifest, type Ctx } from "./config.js";
import { contractVersionInRange } from "./contract.js";
import { readExistingOnboardJson, selectedOnboardTeam } from "./onboard-existing.js";
import type { OnboardAdapter, OnboardJournal, OnboardStepResult } from "./onboard.js";

export interface ExistingOnboardRepository { teamId: string; owner: string; name: string; repoId: string }
export type ChooseExistingRepositories = (repositories: readonly ExistingOnboardRepository[]) => Promise<string[] | null>;
const part = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const key = (row: Pick<ExistingOnboardRepository, "owner" | "name">) => `${row.owner}/${row.name}`.toLowerCase();
const waiting = (reason: string): OnboardStepResult => ({ state: "waiting", reason });
const valid = (value: unknown): value is ExistingOnboardRepository => {
  const row = object(value);
  return !!row && typeof row.teamId === "string" && id.test(row.teamId) && typeof row.repoId === "string" && id.test(row.repoId) &&
    typeof row.owner === "string" && part.test(row.owner) && typeof row.name === "string" && part.test(row.name);
};

/** Names/IDs only. A saved selection never proves current access or repository readiness. */
export function selectedOnboardRepositories(journal?: OnboardJournal): ExistingOnboardRepository[] {
  const step = journal?.steps.find(row => row.id === "github.repos" && row.state === "done");
  const receipt = step?.evidence?.repository;
  if (typeof receipt !== "string" || receipt.length > 64_000) return [];
  try {
    const rows: unknown = JSON.parse(receipt);
    if (!Array.isArray(rows) || !rows.length || rows.length > 100 || !rows.every(valid)) return [];
    if (new Set(rows.map(key)).size !== rows.length) return [];
    return rows.map(row => ({ teamId: row.teamId, owner: row.owner, name: row.name, repoId: row.repoId }));
  } catch { return []; }
}

/** The personal ACL inventory chooses bindings; a fresh contract supplies IDs only. No cache read. */
async function inventory(ctx: Ctx, journal: OnboardJournal, signal?: AbortSignal): Promise<{ repositories: ExistingOnboardRepository[] } | { reason: string }> {
  const cfg = loadConfig(ctx.home);
  if (!cfg?.user || !journal.account || cfg.account !== journal.account || journal.membershipId !== cfg.user.id ||
      !journal.baseUrl || normalizeBaseUrl(journal.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)) return { reason: "repository_identity_unverified" };
  const teamId = selectedOnboardTeam(journal);
  if (!teamId) return { reason: "team_selection_unverified" };
  const read = await readExistingOnboardJson(ctx, "/api/v1/repos", signal);
  if ("reason" in read) return { reason: "repository_read_unavailable" };
  const body = object(read.body);
  if (!body || !Array.isArray(body.repos) || body.repos.length > 1_000) return { reason: "repository_inventory_shape" };
  const bindings: Array<{ owner: string; name: string }> = [];
  const seen = new Set<string>();
  for (const value of body.repos) {
    const row = object(value);
    if (!row || typeof row.teamId !== "string" || !id.test(row.teamId) || typeof row.owner !== "string" || !part.test(row.owner) ||
        typeof row.name !== "string" || !part.test(row.name)) return { reason: "repository_inventory_shape" };
    if (row.teamId !== teamId) continue;
    const name = key({ owner: row.owner, name: row.name });
    if (seen.has(name)) return { reason: "repository_binding_ambiguous" };
    seen.add(name); bindings.push({ owner: row.owner, name: row.name });
  }
  if (!bindings.length) return { repositories: [] };
  const contractRead = await readExistingOnboardJson(ctx, "/api/v1/agent/contract", signal);
  if ("reason" in contractRead) return { reason: "repository_contract_unavailable" };
  const doc = object(contractRead.body);
  const account = object(doc?.account);
  const merge = object(doc?.merge);
  if (!doc || account?.id !== journal.account || typeof doc.contractVersion !== "string" ||
      contractVersionInRange(doc.contractVersion, readManifest().tenantContractRange) !== true ||
      !merge || !Array.isArray(merge.repositories) || merge.repositories.length > 10_000) return { reason: "repository_contract_unverified" };
  const lookup = new Map<string, string[]>();
  const idNames = new Map<string, string>();
  for (const value of merge.repositories) {
    const row = object(value);
    if (!row || typeof row.owner !== "string" || !part.test(row.owner) || typeof row.name !== "string" || !part.test(row.name) ||
        typeof row.repoId !== "string" || !id.test(row.repoId)) return { reason: "repository_contract_unverified" };
    const name = key({ owner: row.owner, name: row.name });
    if (idNames.has(row.repoId) && idNames.get(row.repoId) !== name) return { reason: "repository_contract_unverified" };
    idNames.set(row.repoId, name);
    lookup.set(name, [...(lookup.get(name) ?? []), row.repoId]);
  }
  const repositories: ExistingOnboardRepository[] = [];
  for (const binding of bindings) {
    const ids = lookup.get(key(binding));
    if (!ids || ids.length !== 1) return { reason: "repository_id_unverified" };
    repositories.push({ ...binding, teamId, repoId: ids[0]! });
  }
  return { repositories };
}

export function existingRepositoryAdapter(args: ParsedArgs, choose?: ChooseExistingRepositories): OnboardAdapter {
  let chosen: ExistingOnboardRepository[] | undefined;
  const requested = (repositories: ExistingOnboardRepository[], journal: OnboardJournal): ExistingOnboardRepository[] | null => {
    const explicit = args.flags.repo;
    if (explicit !== undefined) {
      const names = Array.isArray(explicit) ? explicit : [explicit];
      if (!names.length || names.length > 100 || !names.every(name => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name))) return null;
      const wanted = names.map(name => String(name).toLowerCase());
      if (new Set(wanted).size !== wanted.length) return null;
      const selected = wanted.map(name => repositories.find(row => key(row) === name));
      return selected.every((row): row is ExistingOnboardRepository => !!row) ? selected : null;
    }
    const saved = chosen ?? selectedOnboardRepositories(journal);
    if (!saved.length) return null;
    const selected = saved.map(row => repositories.find(live => key(live) === key(row) && live.teamId === row.teamId && live.repoId === row.repoId));
    return selected.every((row): row is ExistingOnboardRepository => !!row) ? selected : null;
  };
  const check: OnboardAdapter["check"] = async (ctx, journal, signal) => {
    const list = await inventory(ctx, journal, signal);
    if ("reason" in list) return waiting(list.reason);
    if (!list.repositories.length) return waiting("repository_inventory_empty");
    const rows = requested(list.repositories, journal);
    if (!rows) return args.flags.repo !== undefined || chosen || selectedOnboardRepositories(journal).length
      ? waiting("repository_selection_unverified") : choose ? { state: "pending" } : waiting("repository_choice_required");
    return { state: "done", evidence: { repository: JSON.stringify(rows), count: rows.length, checkedAt: ctx.now().getTime() } };
  };
  return { check, act: async (ctx, journal, signal) => {
    const list = await inventory(ctx, journal, signal);
    if ("reason" in list) return waiting(list.reason);
    if (!list.repositories.length) return waiting("repository_inventory_empty");
    if (!choose) return waiting("repository_choice_required");
    let remove = () => {};
    const answer = await new Promise<string[] | null>((resolve, reject) => {
      const stopped = () => resolve(null);
      if (signal?.aborted) { stopped(); return; }
      signal?.addEventListener("abort", stopped, { once: true });
      remove = () => signal?.removeEventListener("abort", stopped);
      Promise.resolve().then(() => signal?.aborted ? null : choose(list.repositories.map(row => ({ ...row })))).then(resolve, reject);
    }).finally(() => remove());
    if (!answer || signal?.aborted) return waiting("interrupted");
    if (!Array.isArray(answer) || !answer.length || answer.length > 100 || !answer.every(name => typeof name === "string")) return waiting("repository_selection_unverified");
    const names = answer.map(name => name.toLowerCase());
    if (new Set(names).size !== names.length) return waiting("repository_selection_unverified");
    const rows = names.map(name => list.repositories.find(row => key(row) === name));
    if (!rows.every((row): row is ExistingOnboardRepository => !!row)) return waiting("repository_selection_unverified");
    chosen = rows;
    return check(ctx, journal, signal);
  } };
}
