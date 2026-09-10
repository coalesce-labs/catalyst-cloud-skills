// ask.ts — `ask raise|accept|list`: raise a decision through the contract's ask route (the cloud
// renders the body from its own template, so this passes fields, never headings), record an answer
// through ask-accept, and list open asks ranked by the work each one holds.
import { flagBool, flagList, flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { loadContract, teamByKey } from "./contract.js";
import type { TenantContract } from "./contract-types.js";
import { UsageError } from "./errors.js";
import { apiClient, type ApiClient } from "./http.js";
import { rowsOf } from "./query.js";
import { fetchWorkflowStates, postAgent, resolveIssue } from "./write.js";

export async function cmdAsk(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [sub, ...rest] = positionals(args);
  if (!sub) throw new UsageError("ask needs a subcommand: raise | accept | list");
  if (sub === "raise" && !flagBool(args, "nothing-to-block") && flagList(args, "blocks").length === 0) {
    throw new UsageError("ask raise needs --blocks <ticket>... (what this decision holds) or --nothing-to-block");
  }
  const cfg = requireConfig(ctx);
  const { doc } = await loadContract(ctx, cfg);
  const api = apiClient(cfg, ctx);
  switch (sub) {
    case "raise":
      return raise(args, ctx, doc, api);
    case "accept":
      return accept(args, ctx, doc, api, rest);
    case "list":
      return list(args, ctx, doc, api);
    default:
      throw new UsageError(`unknown ask subcommand: ${sub}`);
  }
}

async function raise(args: ParsedArgs, ctx: Ctx, doc: TenantContract, api: ApiClient): Promise<number> {
  const teamKey = flagString(args, "team");
  const title = flagString(args, "title");
  if (!teamKey || !title) throw new UsageError("ask raise needs --team <key> and --title <question>");
  const team = teamByKey(doc, teamKey);
  const options = flagList(args, "option");
  if (options.length > doc.askTemplate.maxLetteredOptions) {
    throw new UsageError(`ask raise takes at most ${doc.askTemplate.maxLetteredOptions} options`);
  }
  const blocks: string[] = [];
  for (const t of flagList(args, "blocks")) blocks.push((await resolveIssue(api, t)).id);
  const body: Record<string, unknown> = { title, teamId: team.id };
  if (flagString(args, "context")) body.context = flagString(args, "context");
  if (options.length) body.options = options;
  if (flagString(args, "default")) body.defaultIfSilent = flagString(args, "default");
  if (blocks.length) body.blocks = blocks;
  if (flagBool(args, "nothing-to-block")) body.nothingToBlock = true;
  if (flagString(args, "ask-key")) body.askKey = flagString(args, "ask-key");
  const result = await postAgent<Record<string, unknown>>(api, doc, "ask", body);
  ctx.stdout(args.json ? JSON.stringify(result) : `ask raised: ${String(result.identifier ?? result.id ?? "ok")}${blocks.length ? ` (blocks ${blocks.length})` : ""}`);
  return 0;
}

async function accept(args: ParsedArgs, ctx: Ctx, doc: TenantContract, api: ApiClient, rest: string[]): Promise<number> {
  const askTicket = rest[0];
  const answer = flagString(args, "answer");
  const role = flagString(args, "role");
  if (!askTicket || !answer || !role) throw new UsageError("ask accept needs <askTicket> --answer <commentId> --role <role>");
  const ask = await resolveIssue(api, askTicket);
  const result = await postAgent<Record<string, unknown>>(api, doc, "ask-accept", {
    askIssueId: ask.id,
    answerCommentId: answer,
    acceptedByRole: role,
  });
  ctx.stdout(args.json ? JSON.stringify(result) : `ask ${ask.identifier}: answer ${answer} recorded by ${role}`);
  return 0;
}

export interface RankedAsk {
  identifier: string;
  title: string;
  state: string;
  blocks: string[];
  score: number;
}

/** Rank open asks by the priority-weighted count of open tickets each one blocks. Priority 1 (urgent)
 *  weighs 4, 4 (low) weighs 1, 0 (none) weighs 1. */
export function rankAsks(issues: Record<string, unknown>[], doc: TenantContract, openState: (issue: Record<string, unknown>) => boolean): RankedAsk[] {
  const askIds = new Set<string>();
  for (const team of doc.teams) for (const l of team.labels.ask) for (const id of [l.unscopedId, l.teamScopedId, l.preferredId]) if (id) askIds.add(id);
  const isAsk = (issue: Record<string, unknown>): boolean => {
    const labels = Array.isArray(issue.labels) ? (issue.labels as { id?: unknown; name?: unknown }[]) : [];
    return labels.some((l) => (typeof l.id === "string" && askIds.has(l.id)) || (typeof l.name === "string" && (l.name === doc.vocabulary.askMarkerLabel || l.name.startsWith(doc.vocabulary.askLabelPrefix))));
  };
  const byIdentifier = new Map<string, Record<string, unknown>>();
  for (const i of issues) if (typeof i.identifier === "string") byIdentifier.set(i.identifier, i);
  const weight = (issue: Record<string, unknown> | undefined): number => {
    const p = typeof issue?.priority === "number" ? issue.priority : 0;
    return p >= 1 && p <= 4 ? 5 - p : 1;
  };
  const out: RankedAsk[] = [];
  for (const issue of issues) {
    if (!isAsk(issue) || !openState(issue)) continue;
    const relations = Array.isArray(issue.relations) ? (issue.relations as { type?: unknown; issue_identifier?: unknown; related_identifier?: unknown }[]) : [];
    const blocked = relations
      .filter((r) => r.type === "blocks" && r.issue_identifier === issue.identifier && typeof r.related_identifier === "string")
      .map((r) => r.related_identifier as string)
      .filter((id) => {
        const t = byIdentifier.get(id);
        return !t || openState(t);
      });
    out.push({
      identifier: String(issue.identifier),
      title: String(issue.title ?? ""),
      state: String(issue.state ?? ""),
      blocks: blocked,
      score: blocked.reduce((sum, id) => sum + weight(byIdentifier.get(id)), 0),
    });
  }
  return out.sort((a, b) => b.score - a.score || a.identifier.localeCompare(b.identifier));
}

async function list(args: ParsedArgs, ctx: Ctx, doc: TenantContract, api: ApiClient): Promise<number> {
  const [issuesRes, states] = await Promise.all([api.getJson<unknown>("/api/v1/issues", { query: { limit: 500 } }), fetchWorkflowStates(api)]);
  const issues = rowsOf(issuesRes.body);
  const terminal = new Set(states.filter((s) => ["completed", "canceled", "cancelled"].includes(s.type.toLowerCase())).map((s) => s.name.toLowerCase()));
  const openState = (issue: Record<string, unknown>) => !terminal.has(String(issue.state ?? "").toLowerCase());
  const ranked = rankAsks(issues, doc, openState);
  if (args.json) {
    ctx.stdout(JSON.stringify(ranked));
    return 0;
  }
  if (ranked.length === 0) {
    ctx.stdout("no open asks");
    return 0;
  }
  for (const a of ranked) ctx.stdout(`${a.identifier}  holds ${a.blocks.length} ticket${a.blocks.length === 1 ? "" : "s"} (weight ${a.score})${a.blocks.length ? `: ${a.blocks.join(", ")}` : ""}  ${a.title}`);
  return 0;
}
