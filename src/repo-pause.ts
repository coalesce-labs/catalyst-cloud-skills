// repo-pause.ts — `catalyst repo status|pause|resume`: a workspace's registered repositories with their
// paused state, and pausing or resuming one, on the person's own login. Any member reads the list (the
// cloud narrows it to the projects they can see); pausing and resuming need a workspace owner or
// admin, and the cloud records who, when and why. The routes are the agent twins of the member
// routes, listed in the contract's route table so `capabilities` can judge them.
import { flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { UsageError } from "./errors.js";
import { apiClient } from "./transport.js";

export const REPOS_ROUTE = "/api/v1/agent/repos";
export const REPOS_PAUSE_ROUTE = `${REPOS_ROUTE}/pause`;
export const REPOS_RESUME_ROUTE = `${REPOS_ROUTE}/resume`;
export const PAUSE_REASON_MAX = 500;

export interface RepoItem {
  id?: string;
  owner?: string;
  name?: string;
  fullName?: string;
  status?: "active" | "paused" | "archived" | string;
  pausedAt?: number | null;
  pausedBy?: { actor?: string; email?: string } | null;
  pauseReason?: string | null;
  projects?: unknown[];
}
interface ListView { repositories?: RepoItem[]; canManage?: boolean; error?: string; message?: string; reason?: string }
interface WriteView { repository?: RepoItem; error?: string; message?: string; reason?: string }

/** "3 hours ago", from an epoch-ms instant to now. */
export function ago(ms: number, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

const fullName = (r: RepoItem): string => r.fullName ?? `${r.owner ?? "?"}/${r.name ?? "?"}`;

/** One line per repository: the state, and for a paused one who, when and why. */
export function repoLine(r: RepoItem, now: Date): string {
  const projects = Array.isArray(r.projects) && r.projects.length > 0 ? ` (${r.projects.map((p) => (typeof p === "string" ? p : String((p as { key?: string; name?: string }).key ?? (p as { name?: string }).name ?? ""))).filter(Boolean).join(", ")})` : "";
  if (r.status === "paused") {
    const who = r.pausedBy?.actor ?? r.pausedBy?.email ?? "an operator";
    const when = typeof r.pausedAt === "number" ? ` ${ago(r.pausedAt, now)}` : "";
    return `${fullName(r)}: paused by ${who}${when}${r.pauseReason ? `: ${r.pauseReason}` : ""}${projects}`;
  }
  return `${fullName(r)}: ${r.status ?? "unknown"}${projects}`;
}

function refusal(ctx: Ctx, args: ParsedArgs, status: number, body: { error?: string; message?: string; reason?: string } | undefined, what: string): number {
  const b = body ?? {};
  const detail = b.message || b.reason ? ` (${String(b.message ?? b.reason)})` : "";
  const why = status === 403
    ? `${what} needs a workspace owner or admin${detail}`
    : status === 404
      ? b.error === "not_found" ? `the cloud has no such repository in this workspace${detail}` : "this Catalyst Cloud does not serve the repository routes yet (needs a newer cloud)"
      : status === 409
        ? `the repository is archived and cannot be ${what === "pausing" ? "paused" : "resumed"}${detail}`
        : `${String(b.error ?? "bad request")}${detail}`;
  if (args.json) ctx.stdout(JSON.stringify({ status, ...b }));
  else ctx.stdout(`refused (${status}): ${why}`);
  return 1;
}

export async function cmdRepoPause(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [sub, target, ...extra] = positionals(args);
  if (sub !== "status" && sub !== "pause" && sub !== "resume") throw new UsageError("repo needs status | pause <owner/name> --reason <text> | resume <owner/name>");
  if (extra.length > 0) throw new UsageError(`repo ${sub} takes one repository at most`);
  const reason = flagString(args, "reason")?.trim();
  if (sub === "status" && (target !== undefined || reason !== undefined)) throw new UsageError("repo status takes no repository and no --reason");
  if (sub !== "status" && !target) throw new UsageError(`repo ${sub} needs the repository as owner/name`);
  if (sub === "pause" && !reason) throw new UsageError("repo pause needs --reason <text>: the record says why, for whoever reads it later");
  if (reason !== undefined && reason.length > PAUSE_REASON_MAX) throw new UsageError(`--reason is ${reason.length} characters; the cloud keeps at most ${PAUSE_REASON_MAX}`);
  const cfg = requireConfig(ctx);
  const client = apiClient(cfg, ctx);
  const accept = [400, 403, 404, 409];
  const list = await client.getJson<ListView>(REPOS_ROUTE, { accept, parseAccepted: true });
  if (list.status !== 200) return refusal(ctx, args, list.status, list.body, "reading the repositories");
  const repos = Array.isArray(list.body?.repositories) ? list.body.repositories : [];
  const now = ctx.now();
  if (sub === "status") {
    if (args.json) { ctx.stdout(JSON.stringify(list.body)); return 0; }
    if (repos.length === 0) { ctx.stdout("no repository is registered to this workspace yet"); return 0; }
    const paused = repos.filter((r) => r.status === "paused").length;
    ctx.stdout(`${repos.length} repositor${repos.length === 1 ? "y" : "ies"}, ${paused} paused`);
    for (const r of repos) ctx.stdout(`  ${repoLine(r, now)}`);
    ctx.stdout(list.body?.canManage === false
      ? "pausing or resuming one needs a workspace owner or admin"
      : "change one: catalyst repo pause <owner/name> --reason <why>, catalyst repo resume <owner/name>");
    return 0;
  }
  const wanted = target!.toLowerCase();
  const repo = repos.find((r) => fullName(r).toLowerCase() === wanted);
  if (!repo || !repo.id) throw new UsageError(`no repository ${target} is registered to this workspace${repos.length ? ` (registered: ${repos.map(fullName).join(", ")})` : ""}`);
  const body = sub === "pause" ? { repoId: repo.id, reason } : reason ? { repoId: repo.id, reason } : { repoId: repo.id };
  const res = await client.postJson<WriteView>(sub === "pause" ? REPOS_PAUSE_ROUTE : REPOS_RESUME_ROUTE, body, { accept });
  if (res.status !== 200) return refusal(ctx, args, res.status, res.body, sub === "pause" ? "pausing" : "resuming");
  const after = res.body?.repository ?? repo;
  if (args.json) ctx.stdout(JSON.stringify({ repository: after, previous: { status: repo.status, pausedAt: repo.pausedAt ?? null, pausedBy: repo.pausedBy ?? null, pauseReason: repo.pauseReason ?? null } }));
  else {
    ctx.stdout(sub === "pause" ? `${fullName(after)}: paused; new work in it stops dispatching now, work in progress finishes` : `${fullName(after)}: resumed; dispatch continues at its configured cap`);
    ctx.stdout(`  ${repoLine(after, now)}`);
  }
  return 0;
}
