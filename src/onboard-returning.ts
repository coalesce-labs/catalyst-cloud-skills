import type { ParsedArgs } from "./args.js";
import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import { readExistingOnboardJson, readOnboardTeamInventory } from "./onboard-existing.js";
import { teamCheckCopy } from "./ready-copy.js";
import type { OnboardAdapter, OnboardJournal, OnboardStepId, OnboardStepResult } from "./onboard.js";

export interface ReturningProject {
  id: string;
  key: string;
  name: string;
  status: string;
}
export type ReturningChoice = "move-on" | "new" | { repair: string };
export type ReviewReturningProjects = (projects: readonly ReturningProject[]) => Promise<ReturningChoice | null>;
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const repository = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** Count configured teams across their repositories, rather than every visible Linear team. */
export async function readReturningProjects(ctx: Ctx, journal: OnboardJournal, signal?: AbortSignal): Promise<
  { projects: ReturningProject[] } | { reason: string }
> {
  const cfg = loadConfig(ctx.home);
  if (!cfg?.user || cfg.account !== journal.account || cfg.user.id !== journal.membershipId ||
    normalizeBaseUrl(cfg.baseUrl) !== journal.baseUrl) return { reason: "returning_inventory_unverified" };
  const contract = await readExistingOnboardJson(ctx, "/api/v1/agent/contract", signal);
  if ("reason" in contract) return { reason: "returning_inventory_unverified" };
  const doc = object(contract.body);
  if (object(doc?.account)?.id !== cfg.account || !Array.isArray(doc?.routes)) return { reason: "returning_inventory_unverified" };
  const routes = doc.routes.map(object).filter(r => r?.method === "GET" && typeof r.path === "string" &&
    /^\/api\/v1\/[A-Za-z0-9_/-]+\/tenant\/repositories$/.test(r.path));
  if (routes.length !== 1) return { reason: "returning_inventory_unverified" };
  // The contract's mapped teams omit projects that have not adopted a workflow yet. Use the
  // complete project inventory, including paused and archived rows, and group active rows by team.
  const read = await readExistingOnboardJson(ctx, routes[0]!.path as string, signal);
  if ("reason" in read) return { reason: "returning_inventory_unverified" };
  const list = object(read.body);
  if (list?.canManage !== true || !Array.isArray(list.repositories) || list.repositories.length > 10_000)
    return { reason: "returning_inventory_unverified" };
  const inventory = await readOnboardTeamInventory(ctx, signal);
  const configured: ReturningProject[] = [];
  const seen = new Set<string>();
  const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 120);
  for (const value of list.repositories) {
    const row = object(value);
    if (typeof row?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.id) || seen.has(row.id) ||
      typeof row.linearTeamId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.linearTeamId) ||
      typeof row.name !== "string" || !row.name.trim() ||
      !(row.linearTeamKey === null || typeof row.linearTeamKey === "string") ||
      !["active", "paused", "archived"].includes(String(row.status)) ||
      typeof row.githubRepoOwner !== "string" || typeof row.githubRepoName !== "string" ||
      !repository.test(`${row.githubRepoOwner}/${row.githubRepoName}`)) return { reason: "returning_inventory_unverified" };
    seen.add(row.id);
    if (row.status === "archived" || configured.some(p => p.id === row.linearTeamId)) continue;
    const team = "reason" in inventory ? undefined : inventory.teams.find(t => t.id === row.linearTeamId);
    configured.push({ id: row.linearTeamId, key: team?.key ?? clean(row.linearTeamKey as string ?? ""),
      name: team?.name ?? clean(row.name), status: "Readiness could not be checked. Run catalyst ready to check it." });
  }
  // Bound the whole readiness summary, including a workspace with many projects.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 30_000);
  const bounded = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    for (let start = 0; start < configured.length && !bounded.aborted; start += 4) {
      await Promise.all(configured.slice(start, start + 4).map(async project => {
        const read = await readExistingOnboardJson(ctx, `/api/v1/agent/tenant/readiness?team=${encodeURIComponent(project.id)}`, bounded);
        if ("reason" in read) return;
        const row = object(object(read.body)?.readiness);
        if (row?.teamId !== project.id || !["ready", "degraded", "blocked"].includes(String(row.status)) ||
          typeof row.checkedAt !== "number" || !Number.isFinite(row.checkedAt) || row.checkedAt < 0 || row.checkedAt > ctx.now().getTime() ||
          !Array.isArray(row.checks) || !row.checks.length || row.checks.length > 100) return;
        const checks = row.checks.map(object);
        if (!checks.every(c => c && typeof c.id === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(c.id) &&
          ["pass", "fail", "unknown"].includes(String(c.state))) ||
          new Set(checks.map(c => c!.id)).size !== checks.length) return;
        const unfinished = checks.filter(c => c!.state !== "pass");
        if (row.status === "ready" && !unfinished.length) project.status = "Ready";
        else if (unfinished.length) project.status = unfinished.map(c =>
          teamCheckCopy(cfg.baseUrl, project.key, c!.id as string, c!.state as "fail" | "unknown", null).line
            .replace(`team ${project.key}: `, "")).join(" ");
      }));
    }
  } finally { clearTimeout(timer); }
  return { projects: configured };
}

const PROJECT_STEPS = new Set<OnboardStepId>([
  "linear.workspace", "linear.personal", "linear.team", "linear.adopt", "linear.automations",
  "github.install", "github.personal", "github.repos", "projects", "settings", "values", "capacity", "first-ticket", "ready",
]);

/** Scope is enforced in the adapters and receipt, so moving on cannot perform project writes. */
export function returningWorkspaceAdapters(
  adapters: Partial<Record<OnboardStepId, OnboardAdapter>>,
  args: ParsedArgs,
  review: ReviewReturningProjects | undefined,
  message: (text: string) => void,
  newProject: () => void,
  active: () => boolean = () => true,
): void {
  if (args.flags.team !== undefined || args.flags.only !== undefined || args.flags.headless === true) return;
  let mode: "unread" | "continue" | "move-on" | "unknown" = "unread";
  let count = 0;
  const scope = async (ctx: Ctx, journal: OnboardJournal, signal?: AbortSignal): Promise<OnboardStepResult | null> => {
    if (!active()) return null;
    if (mode === "unread") {
      if (!["owner", "admin"].includes(loadConfig(ctx.home)?.user?.role ?? "")) { mode = "continue"; return null; }
      const inventory = await readReturningProjects(ctx, journal, signal);
      if ("reason" in inventory) mode = "unknown";
      else {
        count = inventory.projects.length;
        if (!count) mode = "continue";
        else {
          message(`This workspace already has ${count} Catalyst project${count === 1 ? "" : "s"}.`);
          for (const p of inventory.projects) message(`${p.name} (${p.key}): ${p.status}`);
          const choice = review ? await review(inventory.projects) : "move-on";
          if (!choice || signal?.aborted) return { state: "waiting", reason: "interrupted" };
          if (choice === "move-on") mode = "move-on";
          else if (choice === "new") { mode = "continue"; newProject(); }
          else if (inventory.projects.some(p => p.id === choice.repair)) {
            args.flags.team = choice.repair;
            mode = "continue";
          } else mode = "unknown";
        }
      }
    }
    if (mode === "unknown") return { state: "waiting", reason: "returning_inventory_unverified" };
    return mode === "move-on" ? { state: "skipped", reason: "returning_workspace_move_on", evidence: { projectCount: count } } : null;
  };
  for (const id of PROJECT_STEPS) {
    const adapter = adapters[id];
    if (!adapter) continue;
    adapters[id] = {
      ...adapter,
      check: async (ctx, journal, signal) =>
        (mode === "unread" && id !== "linear.workspace" ? null : await scope(ctx, journal, signal)) ?? adapter.check(ctx, journal, signal),
      ...(adapter.act ? { act: async (ctx: Ctx, journal: OnboardJournal, signal?: AbortSignal) =>
        (mode === "unread" && id !== "linear.workspace" ? null : await scope(ctx, journal, signal)) ?? adapter.act!(ctx, journal, signal) } : {}),
    };
  }
}
