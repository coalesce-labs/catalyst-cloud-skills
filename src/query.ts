// query.ts — `query issues|issue|pulls|pull|projects|cycles|search|changes`: the replica when it is
// explicitly selected, otherwise the API, with the source named on stderr every time. Output shape is the read-model
// view either way. `pull`, `cycles`, `search` and `changes` are API-only (the SDK wraps no view for
// them and the read-model package is not a declared dependency of this bundle).
import {
  flagBool,
  flagInt,
  flagString,
  positionals,
  type ParsedArgs,
} from "./args.js";
import {
  requireConfig,
  replicaDbPath,
  type Ctx,
  type CustomerConfig,
} from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { apiClient } from "./transport.js";
import {
  fetchAllPages,
  fetchPage,
  rowsOf,
  truncationNotice,
} from "./pagination.js";
import { engineFor, replicaStatus, type EngineDeps } from "./replica.js";
import { loadSdk } from "./sdk.js";

export { rowsOf };

export type QuerySource = "replica" | "api";

export interface QueryDeps {
  engineDeps?: EngineDeps;
}

const REPLICA_CAPABLE = new Set(["issues", "issue", "pulls", "projects"]);
/** The two keyset routes `--all` can follow. `projects`/`cycles`/`search` are offset-paged or
 *  unpaginated and send no cursor header. */
const PAGINATED = new Set(["issues", "pulls"]);

interface Filters {
  team?: string;
  project?: string;
  state?: string;
  limit: number;
  all: boolean;
}

export async function cmdQuery(
  args: ParsedArgs,
  ctx: Ctx,
  deps: QueryDeps = {},
): Promise<number> {
  const [sub, ...rest] = positionals(args);
  if (!sub)
    throw new UsageError(
      "query needs a subcommand: issues | issue <id> | pulls | pull <id> | projects | cycles | search <terms> | changes --since <n>",
    );
  const cfg = requireConfig(ctx);
  const filters: Filters = {
    // CTC-4556 — trimmed here, so the value sent and the value compared are the one the mirror reads.
    team: trimmedFlag(args, "team"),
    project: trimmedFlag(args, "project"),
    state: trimmedFlag(args, "state"),
    limit: flagInt(args, "limit", 50),
    all: flagBool(args, "all"),
  };
  const forced = flagString(args, "source");
  if (forced && forced !== "replica" && forced !== "api")
    throw new UsageError("--source must be replica or api");
  if (filters.all && !PAGINATED.has(sub)) {
    throw new UsageError(
      `--all follows the cloud's keyset pages, which only ${[...PAGINATED].join(" and ")} have`,
    );
  }
  if (filters.all && forced === "replica") {
    throw new UsageError(
      "--all follows the cloud's page cursor; --source replica reads a local mirror that has none. Pick one.",
    );
  }
  if (filters.all && flagString(args, "limit") !== undefined) {
    ctx.stderr("--all reads the whole scope, so --limit is ignored");
  }

  const status =
    forced === "replica" && REPLICA_CAPABLE.has(sub)
      ? replicaStatus(ctx, cfg)
      : null;
  let source: QuerySource;
  let why: string;
  if (!REPLICA_CAPABLE.has(sub)) {
    source = "api";
    why = `${sub} is api-only`;
  } else if (forced) {
    source = forced as QuerySource;
    why = `--source ${forced}`;
  } else if (filters.all) {
    source = "api";
    why = "--all follows the cloud's pages";
  } else {
    source = "api";
    why = "cloud reads by default";
  }
  ctx.stderr(
    source === "replica" ? `source: replica (${why})` : `source: api (${why})`,
  );

  let result: unknown;
  if (source === "replica") {
    if (
      !status ||
      status.verdict === "absent" ||
      status.verdict === "not-configured"
    ) {
      throw new UsageError(
        `--source replica but the replica is ${status?.verdict ?? "unavailable"}`,
      );
    }
    result = await fromReplica(ctx, cfg, sub, rest, filters, deps);
  } else {
    result = await fromApi(ctx, cfg, sub, rest, filters, args);
  }
  if (result === null) {
    ctx.stderr(`${sub} ${rest[0] ?? ""}: not found`);
    return 1;
  }
  printResult(ctx, args, sub, result);
  return 0;
}

async function fromReplica(
  ctx: Ctx,
  cfg: CustomerConfig,
  sub: string,
  rest: string[],
  f: Filters,
  deps: QueryDeps,
): Promise<unknown> {
  const sdk = await loadSdk();
  const dbPath = replicaDbPath(cfg, ctx.home, ctx.env);
  const engine = await engineFor(sdk, dbPath, ctx, {
    ...deps.engineDeps,
    readonly: true,
  });
  const replica = await sdk.CatalystReplica.openReadOnly({
    dbPath,
    engine,
    log: () => {},
  });
  try {
    switch (sub) {
      case "issues": {
        const rows = replica.issues({ limit: Math.max(f.limit, 200) });
        return applyFilters(
          rows as unknown as Record<string, unknown>[],
          f,
        ).slice(0, f.limit);
      }
      case "issue":
        return replica.issue(needArg(rest, "issue <identifier>"));
      case "pulls":
        return replica.pulls({ limit: f.limit });
      case "projects":
        return applyFilters(
          replica.projects({
            limit: Math.max(f.limit, 200),
          }) as unknown as Record<string, unknown>[],
          { limit: f.limit, state: f.state },
        ).slice(0, f.limit);
      default:
        throw new UsageError(`${sub} is not readable from the replica`);
    }
  } finally {
    await replica.close();
  }
}

async function fromApi(
  ctx: Ctx,
  cfg: CustomerConfig,
  sub: string,
  rest: string[],
  f: Filters,
  args: ParsedArgs,
): Promise<unknown> {
  const api = apiClient(cfg, ctx);
  // CTC-4556 — the mirror narrows `/issues` by `team_key` and `state_name`; `team` and a state name
  // in `state` narrow nothing there.
  const issueScope = {
    team_key: f.team,
    project: f.project,
    state_name: f.state,
  };
  switch (sub) {
    case "issues": {
      if (f.all) {
        const { rows, scope } = await fetchAllPages(
          api,
          "/api/v1/issues",
          issueScope,
        );
        requireIssueScope(scope, f);
        return applyFilters(rows, f); // no .slice — --all means the whole scope
      }
      const page = await fetchPage(api, "/api/v1/issues", {
        ...issueScope,
        limit: f.limit,
      });
      requireIssueScope(page.scope, f);
      const rows = applyFilters(page.rows, f).slice(0, f.limit);
      const notice = truncationNotice(page);
      if (notice) ctx.stderr(notice);
      return rows;
    }
    case "issue": {
      const id = needArg(rest, "issue <identifier>");
      const res = await api.getJson<unknown>(
        `/api/v1/issues/${encodeURIComponent(id)}`,
        { accept: [404] },
      );
      return res.status === 404 ? null : res.body;
    }
    case "pulls": {
      const ticket = flagString(args, "ticket");
      if (f.all) {
        const { rows } = await fetchAllPages(api, "/api/v1/pulls", { ticket });
        return rows;
      }
      const page = await fetchPage(api, "/api/v1/pulls", {
        limit: f.limit,
        ticket,
      });
      const rows = page.rows.slice(0, f.limit);
      const notice = truncationNotice(page);
      if (notice) ctx.stderr(notice);
      return rows;
    }
    case "pull": {
      const id = needArg(rest, "pull <node id>");
      const res = await api.getJson<unknown>(
        `/api/v1/pulls/${encodeURIComponent(id)}`,
        { accept: [404] },
      );
      return res.status === 404 ? null : res.body;
    }
    case "projects": {
      const res = await api.getJson<unknown>("/api/v1/projects", {
        query: { limit: f.limit },
      });
      return rowsOf(res.body).slice(0, f.limit);
    }
    case "cycles": {
      const res = await api.getJson<unknown>("/api/v1/cycles", {
        query: { team: f.team, limit: f.limit },
      });
      return rowsOf(res.body);
    }
    case "search": {
      const q = rest.join(" ").trim();
      if (!q) throw new UsageError("search needs terms: query search <terms>");
      const res = await api.getJson<unknown>("/api/v1/search", {
        query: { q, limit: f.limit },
      });
      return searchRows(res.body);
    }
    case "changes": {
      const since = flagString(args, "since");
      if (since === undefined)
        throw new UsageError(
          "changes needs --since <cursor>, or --since head to start from now",
        );
      return await readChanges(api, since, f.limit);
    }
    default:
      throw new UsageError(`unknown query subcommand: ${sub}`);
  }
}

/** CTC-137 stamps the live head seq on EVERY `/changes` response — the 200 stream and both 409s. */
const HEAD_SEQ_HEADER = "x-catalyst-head-seq";

/**
 * `query changes --since <cursor|head>`.
 *
 * ⛔ THE CHANGEFEED EVICTS, so a refusal must name a cursor that works. `buildChanges` answers a
 * `since` below the oldest retained seq with 409 `cursor_underflow`, and one past the head with 409
 * `cursor_ahead_of_head` — both `{resync: true}`. `--since 0`, the form the docs show, is therefore
 * a 409 on any tenant whose log has rotated, and 0.2.0 surfaced it as a bare "GET /api/v1/changes
 * failed (409)" that left the customer with no way to learn a usable cursor. The head is stamped on
 * the refusal itself, so there is always something actionable to say.
 */
async function readChanges(
  api: ReturnType<typeof apiClient>,
  since: string,
  limit: number,
): Promise<unknown> {
  const resolved = since === "head" ? String(await headCursor(api)) : since;
  // ⛔ NDJSON ON 200, JSON ON A REFUSAL — see `getNdjson`. Reading this with `getJson` turned every
  // real success into "returned a non-JSON body" while every refusal parsed, which is why the verb
  // looked fine: `--since 0` 409s on a rotated feed, so no 200 was ever reached to fail on.
  const res = await api.getNdjson<Record<string, unknown>>("/api/v1/changes", {
    query: { since: resolved, limit },
    accept: [409],
  });
  const head = res.headers.get(HEAD_SEQ_HEADER);
  if (res.status !== 409) {
    return {
      since: Number(resolved),
      head: head === null ? null : Number(head),
      changes: res.body,
    };
  }
  const where = head === null ? "" : ` The feed's live cursor is ${head}.`;
  throw new CliError(
    `cursor ${resolved} is not usable: it is either past the feed's head or no longer in the change log, which keeps only recent changes.${where} Re-run with \`--since head\` to start from now, or with a cursor the feed still holds.`,
    "changefeed-resync",
    1,
    409,
  );
}

/** The live head, read off any `/changes` response's own header — a 409 carries it too, which is
 *  what makes this work on a tenant whose log has rotated past every cursor the caller could guess. */
async function headCursor(api: ReturnType<typeof apiClient>): Promise<number> {
  const probe = await api.getNdjson<unknown>("/api/v1/changes", {
    query: { since: "0", limit: 1 },
    accept: [409],
  });
  const raw = probe.headers.get(HEAD_SEQ_HEADER);
  const head = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(head)) {
    throw new CliError(
      `--since head needs the feed's live cursor, and this cloud did not send one (no ${HEAD_SEQ_HEADER} header). Pass an explicit --since <cursor>.`,
      "changefeed-head-unknown",
      1,
    );
  }
  return head;
}

function needArg(rest: string[], usage: string): string {
  const v = rest[0];
  if (!v) throw new UsageError(`query ${usage}`);
  return v;
}

/** CTC-4556 — refuse a page the cloud did not narrow by a filter the user asked for. Filtering it
 *  here would print the matches among the newest rows and call that the answer. */
function requireIssueScope(scope: string[] | null, f: Filters): void {
  const asked: [string, string, string | undefined][] = [
    ["--team", "team_key", f.team],
    ["--state", "state_name", f.state],
    ["--project", "project", f.project],
  ];
  for (const [flag, param, value] of asked) {
    if (!value || scope?.includes(param)) continue;
    throw new CliError(
      `the cloud did not apply ${flag} (${scope === null ? "it sent no x-mirror-scope header" : `it applied: ${scope.join(", ") || "nothing"}`}), so the page is not that scope; nothing printed. Read it with --source replica, or drop ${flag}`,
      "filter-not-applied",
      1,
    );
  }
}

function trimmedFlag(args: ParsedArgs, name: string): string | undefined {
  const value = flagString(args, name)?.trim();
  return value === "" ? undefined : value;
}

/** The mirror's comparison for team keys and state names: trimmed and lowercased, nothing more.
 *  "In Progress" and "In_Progress" stay different names. */
const sameName = (a: unknown, b: string) =>
  String(a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

export function applyFilters(
  rows: Record<string, unknown>[],
  f: Partial<Filters>,
): Record<string, unknown>[] {
  return rows.filter((r) => {
    if (
      f.team &&
      !(
        String(r.identifier ?? "")
          .toUpperCase()
          .startsWith(`${f.team.toUpperCase()}-`) ||
        r.team_id === f.team ||
        sameName(r.team_key, f.team)
      )
    )
      return false;
    if (f.project && r.project_id !== f.project) return false;
    if (f.state && !sameName(r.state, f.state)) return false;
    return true;
  });
}

/** The hub answers search in four groups (`issues`, `pulls`, `projects`, `initiatives`, the read
 *  model's SearchView). `rowsOf` returns only the first array it finds, so it dropped every match that
 *  was not a ticket. Every group comes back here, flattened, each row tagged with its `kind`. */
const SEARCH_GROUPS: [string, string][] = [
  ["issues", "issue"],
  ["pulls", "pull"],
  ["projects", "project"],
  ["initiatives", "initiative"],
];
export function searchRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  if (SEARCH_GROUPS.some(([group]) => Array.isArray(b[group]))) {
    return SEARCH_GROUPS.flatMap(([group, kind]) =>
      Array.isArray(b[group])
        ? (b[group] as Record<string, unknown>[]).map((row) => ({
            kind,
            ...row,
          }))
        : [],
    );
  }
  return rowsOf(body);
}

function printResult(
  ctx: Ctx,
  args: ParsedArgs,
  sub: string,
  result: unknown,
): void {
  if (args.json || !Array.isArray(result)) {
    ctx.stdout(JSON.stringify(result, null, args.json ? 0 : 2));
    return;
  }
  for (const row of result as Record<string, unknown>[])
    ctx.stdout(summaryLine(sub, row));
}

export function summaryLine(sub: string, r: Record<string, unknown>): string {
  switch (sub) {
    case "issues":
      return `${r.identifier ?? r.id}  ${r.state ?? "?"}  ${r.title ?? ""}${r.assignee_name || r.assignee ? `  (${r.assignee_name ?? r.assignee})` : ""}`;
    case "pulls":
      return `#${r.number ?? "?"}  ${r.state ?? "?"}${r.merged ? " merged" : ""}  ${r.title ?? ""}  [${r.node_id ?? ""}]`;
    case "projects":
      return `${r.id}  ${r.state ?? "?"}  ${r.name ?? ""}`;
    case "cycles":
      return `cycle ${r.number ?? r.id}  ${r.name ?? ""}  ${r.starts_at ?? ""} → ${r.ends_at ?? ""}`;
    case "search":
      switch (r.kind) {
        case "pull":
          return `pull        #${r.number ?? "?"}  ${r.title ?? ""}${r.repo_id ? `  (${r.repo_id})` : ""}`;
        case "project":
          return `project     ${r.name ?? r.id}`;
        case "initiative":
          return `initiative  ${r.name ?? r.id}`;
        default:
          return `issue       ${r.identifier ?? r.id}  ${r.title ?? ""}`;
      }
    default:
      return JSON.stringify(r);
  }
}
