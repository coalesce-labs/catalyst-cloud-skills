// execution.ts — what Catalyst is doing: `explain <ticket>`, `running`, `queue`, `accounts`.
// `explain` turns one work-eligibility row into a paragraph a human can act on, translating every
// exclusion reason and unknown the cloud names; an unlisted reason prints its raw string, never nothing.
import { flagBool, flagString, positionals, type ParsedArgs } from "./args.js";
import { normalizeBaseUrl, requireConfig, type Ctx } from "./config.js";
import { loadContract } from "./contract.js";
import { UsageError } from "./errors.js";
import { apiClient } from "./http.js";

/** Every exclusion reason the eligibility evaluator names, in plain English. */
export const EXCLUSION_REASONS: Record<string, string> = {
  ticket_terminal: "the ticket is in a done or canceled state, so there is nothing left to run",
  pipeline_complete: "every relay phase has already completed",
  not_at_dispatch_stage: "the card is not in the team's dispatch column, so nothing is offered until it is moved there",
  not_at_pr_stage: "merge is next but the card is not in the PR column",
  blocked: "a live blocking relation holds it — the blocker has to close first",
  cooling_down: "the offered phase is parked; a callback or an operator releases it, not a clock",
  lease_held: "a live container already holds the lease for the offered phase",
  intake_lease_held: "a later phase is offered while an intake container still holds this ticket",
  ask_ticket: "it carries an ask label, and a question is never work",
  ask_shape_suspected: "its own text reads as a decision request; a human releases it with the not-an-ask label",
  externally_claimed: "a worker outside the cloud has claimed it",
  environment_check_required: "the repository's environment check has not been run",
  environment_check_running: "the repository's environment check is in flight",
  environment_check_failed: "the repository's environment check failed",
  environment_check_expired: "the repository's environment check verdict aged out",
  environment_check_hash_mismatch: "the environment changed since its recorded verdict",
  scope_overlap: "its declared file scope intersects a ticket already in flight",
  waiting_on: "a merge-gate failure with no remediable cause holds the card at PR",
  branch_missing: "the ticket branch has never been seen, so a branch-dependent phase has nothing to clone",
  branch_gone: "the ticket branch was deleted after it existed",
  pr_merged: "its PR has merged and no other PR is open — nothing is left to clone or re-merge",
  no_change_hold: "a remediate round changed nothing; a human comment or a new push releases it",
  validate_class_spent: "this validate failure already spent its one repair round in this episode",
  stale_failure_episode: "the ladder advanced after the recorded failure, so the round would repair a phase already passed",
  runner_image_breaker: "fleet-wide: the live runner image is failing every phase at startup; dispatch resumes when the pin moves",
  no_branch_to_remediate: "a remediate round is queued on a ticket with no recorded branch",
  retry_backoff: "the failed phase is retrying in place and waiting out its backoff",
  routing_unavailable: "the unit was claimed and refused at kickoff (no route, no eligible coding-account slot, or the provider is unavailable)",
  repo_paused: "an operator paused the repository",
  remediate_parked: "the remediate phase is parked, so the failing phase has nowhere to be repaired",
};

/** Every fail-closed unknown the evaluator names. */
export const UNKNOWN_REASONS: Record<string, string> = {
  ordering_never_published: "the dispatch order has never been published for this team",
  ordering_stale: "the dispatch order is stale",
  workflow_mapping_unknown: "the team's workflow mapping could not be read",
  ticket_unknown: "the ticket is not in the mirror",
  dependency_snapshot_unknown: "the dependency snapshot has never completed",
  blocker_unknown: "a blocking relation could not be resolved",
  label_snapshot_unknown: "the labels poll has never completed, so ask labels cannot be read",
  prior_artifact_unknown: "a prior phase artifact could not be read",
  scope_unknown: "the ticket declared no scope, or the declaration was truncated",
  scope_occupancy_unknown: "an in-flight ticket's state could not be resolved",
  branch_snapshot_unknown: "the pull-request poll has never completed, so branch evidence cannot be read",
};

export const ADVISORIES: Record<string, string> = {
  human_addressed_unlabeled_ask_suspect: "assigned to a human with no delegate: this may be an unlabelled ask",
};

export interface EligibilityRow {
  position?: number;
  ticket?: string;
  status?: string;
  reason?: string;
  phase?: string;
  unknown?: string;
  advisories?: string[];
  detail?: string;
  marker?: string;
  release?: string;
  nextPhase?: string;
  failure?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export function describeReason(reason: string | undefined): string {
  if (!reason) return "no reason was given";
  return EXCLUSION_REASONS[reason] ?? UNKNOWN_REASONS[reason] ?? `reason "${reason}" (not in this bundle's table; read it as the cloud spelled it)`;
}

export function renderExplain(ticket: string, row: EligibilityRow | null, team: string): string {
  if (!row) return `${ticket}: not in the ${team} eligibility explainer — the ticket is unknown to the mirror, terminal, or on another team.`;
  const parts: string[] = [];
  const pos = typeof row.position === "number" ? `position ${row.position}` : "no queue position";
  const status = row.status ?? "unknown";
  if (status === "offered" || status === "eligible") {
    parts.push(`${ticket} is ${status} (${pos})${row.phase ? ` for phase ${row.phase}` : ""}.`);
  } else if (status === "unknown") {
    parts.push(`${ticket} cannot be judged (${pos}): ${describeReason(row.unknown ?? row.reason)}.`);
  } else {
    parts.push(`${ticket} is ${status} (${pos}): ${describeReason(row.reason)}.`);
  }
  if (row.detail) parts.push(`Detail: ${row.detail}.`);
  if (row.marker) parts.push(`Marker: ${row.marker}.`);
  if (row.nextPhase) parts.push(`Next phase would be ${row.nextPhase}.`);
  if (row.release) parts.push(`Release: ${row.release}.`);
  if (row.failure && typeof row.failure === "object") {
    const f = row.failure;
    const bits = ["phase", "class", "attempts", "consecutive", "lastFailedAt", "message", "summary"]
      .filter((k) => f[k] !== undefined && f[k] !== null)
      .map((k) => `${k}=${typeof f[k] === "string" ? f[k] : JSON.stringify(f[k])}`);
    parts.push(`Last failure: ${bits.length ? bits.join(", ") : JSON.stringify(f)}.`);
  }
  if (row.advisories && row.advisories.length > 0) {
    parts.push(`Advisories: ${row.advisories.map((a) => ADVISORIES[a] ?? a).join("; ")}.`);
  }
  return parts.join(" ");
}

export async function cmdExplain(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [ticket] = positionals(args);
  if (!ticket) throw new UsageError("explain needs a ticket: explain <ticket>");
  const cfg = requireConfig(ctx);
  if (flagBool(args, "history")) {
    ctx.stdout(`${ticket}: per-ticket execution history is not visible to an account key yet — read it at ${normalizeBaseUrl(cfg.baseUrl)}/settings`);
    return 0;
  }
  const { doc } = await loadContract(ctx, cfg);
  const dash = ticket.indexOf("-");
  if (dash <= 0) throw new UsageError(`"${ticket}" is not a ticket identifier (expected KEY-123)`);
  const team = ticket.slice(0, dash).toUpperCase();
  const api = apiClient(cfg, ctx);
  const res = await api.getJson<{ eligibility?: { rows?: EligibilityRow[] }; rows?: EligibilityRow[] }>("/api/v1/work-eligibility", {
    query: { team, capabilities: doc.ladder.phases.join(",") },
  });
  const rows = res.body.eligibility?.rows ?? res.body.rows ?? [];
  const row = rows.find((r) => String(r.ticket ?? "").toUpperCase() === ticket.toUpperCase()) ?? null;
  if (args.json) {
    ctx.stdout(JSON.stringify({ ticket, row, explanation: renderExplain(ticket, row, team) }));
  } else {
    ctx.stdout(renderExplain(ticket, row, team));
  }
  return 0;
}

export async function cmdRunning(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const cfg = requireConfig(ctx);
  const api = apiClient(cfg, ctx);
  const [activity, roster, leases] = await Promise.all([
    api.getJson<unknown>("/api/v1/fleet-activity/current"),
    api.getJson<unknown>("/api/v1/agent-roster/current"),
    api.getJson<unknown>("/api/v1/lease/attributions"),
  ]);
  const out = { fleetActivity: activity.body, agentRoster: roster.body, leaseAttributions: leases.body };
  if (args.json) {
    ctx.stdout(JSON.stringify(out));
    return 0;
  }
  ctx.stdout(`fleet activity: ${JSON.stringify(out.fleetActivity)}`);
  ctx.stdout(`agent roster: ${JSON.stringify(out.agentRoster)}`);
  ctx.stdout(`lease attributions: ${JSON.stringify(out.leaseAttributions)}`);
  return 0;
}

export async function cmdQueue(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const cfg = requireConfig(ctx);
  const api = apiClient(cfg, ctx);
  const res = await api.getJson<unknown>("/api/v1/dispatch-queue/current", { query: { team: flagString(args, "team") } });
  ctx.stdout(args.json ? JSON.stringify(res.body) : JSON.stringify(res.body, null, 2));
  return 0;
}

export function cmdAccounts(ctx: Ctx): number {
  const cfg = requireConfig(ctx);
  ctx.stdout(`coding-account status is not visible to an account key yet — read it at ${normalizeBaseUrl(cfg.baseUrl)}/settings/coding-accounts`);
  return 0;
}
