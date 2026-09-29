// project.ts — `catalyst project wip-limit get|set`: a project's new-start WIP limit, on the
// person's own login. Any active member reads it; a workspace owner or admin sets it. The limit is
// per Catalyst project (one Linear team across all its repositories): the project's stored value,
// else the workspace value, else the default the cloud reports. It holds only NEW starts, so the
// reply carries the work in progress beside the limit: that count, not a runner count, is what a
// person compares. The route is the cloud's own member route; the reply shape is the cloud's, so a
// field this CLI does not know is passed through under --json untouched.
import { flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { loadContract } from "./contract.js";
import type { ContractTeam, TenantContract } from "./contract-types.js";
import { UsageError } from "./errors.js";
import { apiClient } from "./transport.js";

/** The limit's bounds, as the cloud clamps them. A value outside is refused here, before any request. */
export const WIP_LIMIT_MIN = 0;
export const WIP_LIMIT_MAX = 9999;

/** The agent twin of the member route: a bearer reads it with `?team=<key or id>` and writes it with a
 *  body naming the team, the way the team-workflow verbs do. The contract's route table lists these
 *  two strings, so `capabilities` can judge them. */
export const WIP_LIMIT_ROUTE = "/api/v1/agent/team-wip-limit";
export const wipLimitPath = (team: string): string =>
  `${WIP_LIMIT_ROUTE}?team=${encodeURIComponent(team)}`;

/** Admin-readable inventory of every Catalyst project, including projects with no saved stages. */
export const PROJECT_LIST_ROUTE_SUFFIX = "/tenant/repositories";

export interface TenantProject {
  id: string;
  name: string;
  linearTeamId: string;
  linearTeamKey: string | null;
  githubRepoOwner: string;
  githubRepoName: string;
  status: string;
}

export interface WipLimitView {
  team?: { id?: string; key?: string | null };
  limit?: number;
  source?: "project" | "flag" | "default" | string;
  stored?: number | null;
  inProgress?: number;
  /** The tickets holding WIP, when the cloud sends them (identifiers, or objects naming one). */
  inProgressTickets?: unknown;
  countedAt?: number;
  error?: string;
  reason?: string;
  message?: string;
  code?: string;
}

const SOURCE_TEXT: Record<string, string> = {
  project: "set for this project",
  flag: "workspace value",
  default: "default",
};
const sourceText = (source: unknown): string =>
  SOURCE_TEXT[String(source)] ?? String(source ?? "unknown");

/** The project `--team` names, or the only mapped project when the flag is absent. Never a guess between two. */
export function resolveTeam(
  doc: TenantContract,
  wanted: string | undefined,
): ContractTeam {
  const teams = Array.isArray(doc.teams) ? doc.teams : [];
  if (wanted !== undefined) {
    const lower = wanted.toLocaleLowerCase();
    const found = teams.find(
      (t) => (t.key ?? "").toLocaleLowerCase() === lower || t.id === wanted,
    );
    if (!found)
      throw new UsageError(
        `no mapped project has the team key ${wanted}${teams.length ? ` (mapped: ${teams.map((t) => t.key ?? t.id).join(", ")})` : " (no project is mapped yet)"}`,
      );
    return found;
  }
  if (teams.length === 1) return teams[0]!;
  if (teams.length === 0)
    throw new UsageError(
      "no project is mapped yet; map one first (catalyst team map <KEY>)",
    );
  throw new UsageError(
    `--team is needed: ${teams.length} projects are mapped (${teams.map((t) => t.key ?? t.id).join(", ")})`,
  );
}

/** `set`'s value: an integer inside the cloud's bounds, or the word default. Parsed before any request. */
export function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined)
    throw new UsageError(
      "project wip-limit set needs a value: an integer, or default",
    );
  if (raw === "default") return null;
  if (!/^-?\d+$/.test(raw))
    throw new UsageError(
      `the limit must be an integer from ${WIP_LIMIT_MIN} to ${WIP_LIMIT_MAX}, or default (got ${raw})`,
    );
  const n = Number(raw);
  if (n < WIP_LIMIT_MIN || n > WIP_LIMIT_MAX)
    throw new UsageError(
      `the limit must be from ${WIP_LIMIT_MIN} to ${WIP_LIMIT_MAX} (got ${raw}); 0 holds every new start`,
    );
  return n;
}

/** The in-progress tickets as identifiers, tolerant of the cloud sending strings or objects; [] when absent. */
export function ticketIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((t) =>
      typeof t === "string"
        ? t
        : t && typeof t === "object"
          ? String(
              (t as Record<string, unknown>).identifier ??
                (t as Record<string, unknown>).id ??
                "",
            )
          : "",
    )
    .filter((t) => t !== "");
}

/** One line naming what holds the WIP, capped so a big team does not scroll; null when the cloud sent none. */
function inProgressLine(view: WipLimitView): string | null {
  const ids = ticketIds(view.inProgressTickets);
  if (ids.length === 0) return null;
  const shown = ids.slice(0, 12);
  return `in progress: ${shown.join(", ")}${ids.length > shown.length ? ` and ${ids.length - shown.length} more` : ""} — these are what a new ticket waits on; unstick them, not the queue`;
}

function line(key: string, view: WipLimitView): string {
  const limit = view.limit;
  const inProgress = view.inProgress;
  const at =
    typeof limit === "number" &&
    typeof inProgress === "number" &&
    inProgress >= limit
      ? " — at the limit: a new ticket waits until one in progress finishes"
      : "";
  return `${key}: ${typeof inProgress === "number" ? inProgress : "?"} in progress, limit ${typeof limit === "number" ? limit : "?"} (${sourceText(view.source)})${at}`;
}

export async function cmdProject(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [sub, action, value, ...extra] = positionals(args);
  if (sub === "list") {
    if (action !== undefined || value !== undefined || extra.length > 0)
      throw new UsageError("project list takes no arguments");
    const cfg = requireConfig(ctx);
    const { doc } = await loadContract(ctx, cfg);
    const route = doc.routes.find(
      (r) => r.method === "GET" && r.path.endsWith(PROJECT_LIST_ROUTE_SUFFIX),
    );
    if (!route)
      throw new UsageError(
        "this cloud does not publish the tenant project list route yet (needs a newer cloud)",
      );
    const response = await apiClient(cfg, ctx).getJson<{
      repositories?: TenantProject[];
      canManage?: boolean;
    }>(route.path, { accept: [403, 404] });
    if (response.status === 403) {
      const message = (response.body as { message?: string } | undefined)
        ?.message;
      throw new UsageError(
        `listing tenant projects needs a workspace owner or admin${message ? ` (${message})` : ""}`,
      );
    }
    if (response.status === 404)
      throw new UsageError(
        "this cloud does not serve tenant project listing yet (needs a newer cloud)",
      );
    const projects = Array.isArray(response.body?.repositories)
      ? response.body.repositories
      : [];
    if (projects.length === 0 && !Array.isArray(response.body?.repositories)) {
      throw new UsageError(
        "the tenant project list response did not contain repositories",
      );
    }
    if (args.json) ctx.stdout(JSON.stringify(projects));
    else {
      for (const project of projects) {
        ctx.stdout(
          `${project.name} | ${project.linearTeamKey ?? project.linearTeamId} | ${project.githubRepoOwner}/${project.githubRepoName} | ${project.status} | ${project.id}`,
        );
      }
    }
    return 0;
  }
  if (sub !== "wip-limit")
    throw new UsageError("project needs wip-limit <get|set <n>|default>");
  if (action !== "get" && action !== "set")
    throw new UsageError("project wip-limit needs get, or set <n>|default");
  if (action === "get" && value !== undefined)
    throw new UsageError("project wip-limit get takes no value; set does");
  if (extra.length > 0)
    throw new UsageError("project wip-limit takes one value at most");
  const limit = action === "set" ? parseLimit(value) : null;
  const cfg = requireConfig(ctx);
  const { doc } = await loadContract(ctx, cfg);
  const team = resolveTeam(doc, flagString(args, "team"));
  const key = team.key ?? team.id;
  const client = apiClient(cfg, ctx);
  const accept = [400, 403, 404];
  const emit = (body: Record<string, unknown>, lines: string[]) => {
    if (args.json) ctx.stdout(JSON.stringify(body));
    else for (const l of lines) ctx.stdout(l);
  };
  const refuse = (status: number, reply: WipLimitView | undefined): number => {
    // The cloud's error bodies carry `error` (the code to match on) and a human `message`.
    const body: WipLimitView = reply ?? {};
    const detail =
      body.message || body.reason
        ? ` (${String(body.message ?? body.reason)})`
        : "";
    const why =
      status === 403
        ? `setting the limit needs a workspace owner or admin; any member can read it with catalyst project wip-limit get${detail}`
        : status === 404 && body.error === "team-unknown"
          ? `this cloud does not know a team ${key}; check the key with catalyst team list${detail}`
          : status === 404
            ? "this Catalyst Cloud does not serve the wip-limit route yet (needs a newer cloud)"
            : `${String(body.error ?? body.code ?? "bad request")}${detail}`;
    emit({ status, team: { id: team.id, key }, ...body }, [
      `refused (${status}): ${why}`,
    ]);
    return 1;
  };
  const before = await client.getJson<WipLimitView>(wipLimitPath(team.id), {
    accept,
    parseAccepted: true,
  });
  if (before.status !== 200) return refuse(before.status, before.body);
  if (action === "get") {
    emit({ team: { id: team.id, key }, ...before.body }, [
      line(key, before.body),
      ...(inProgressLine(before.body) === null
        ? []
        : [inProgressLine(before.body)!]),
      `change it: catalyst project wip-limit set <n> --team ${key} (owner or admin; set default returns to the workspace value)`,
    ]);
    return 0;
  }
  const after = await client.postJson<WipLimitView>(
    WIP_LIMIT_ROUTE,
    { team: team.id, limit },
    { accept },
  );
  if (after.status !== 200) return refuse(after.status, after.body);
  emit(
    {
      team: { id: team.id, key },
      ...after.body,
      previous: { limit: before.body.limit, source: before.body.source },
    },
    [
      `${key}: limit ${String(before.body.limit)} (${sourceText(before.body.source)}) → ${String(after.body.limit)} (${sourceText(after.body.source)})${after.body.limit === 0 ? "; 0 holds every new start" : ""}`,
      line(key, after.body),
    ],
  );
  return 0;
}
