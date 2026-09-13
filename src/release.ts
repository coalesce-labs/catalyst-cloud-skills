// release.ts — `catalyst-skills release`: a person's release of a parked or held ticket, or of every
// ticket on one team parked under one failure class, through the contract's `ticket-release` and
// `ticket-release-class` routes. The cloud reads every governor holding the ticket and either releases
// all of them or releases nothing and names, per governor, the human action that does fix it; this verb
// prints that answer and exits 1 on a refusal so a script can branch on it.
//
// ⛔ NOTHING IS RELEASED WITHOUT A REASON. `--because` (what changed) is required on a real release and
// is recorded in the tenant's release audit; only `--dry-run` may omit it. `--retry-unchanged` is the
// explicit statement that something the mirror cannot see changed — the cloud refuses an unchanged
// cause without it.
import { flagBool, flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { loadContract } from "./contract.js";
import type { TenantContract } from "./contract-types.js";
import { CliError, UsageError } from "./errors.js";
import { needsNewerCloud } from "./execution.js";
import { apiClient } from "./transport.js";

export interface ReleaseAction {
  governor: string;
  phase: string | null;
  op: string;
}

export interface ReleaseRefusal {
  governor: string;
  phase: string | null;
  code: string;
  humanAction: string;
}

export interface TicketReleaseResult {
  ticket?: string;
  outcome?: "released" | "refused" | "nothing-held";
  dryRun?: boolean;
  releasable?: ReleaseAction[];
  released?: ReleaseAction[];
  refused?: ReleaseRefusal[];
  warnings?: string[];
  error?: string;
  expectedTeamKey?: string | null;
  teamKey?: string | null;
  [k: string]: unknown;
}

export interface ClassReleaseResult {
  team?: string;
  class?: string;
  dryRun?: boolean;
  truncated?: boolean;
  released?: TicketReleaseResult[];
  refused?: TicketReleaseResult[];
  nothingHeld?: string[];
  [k: string]: unknown;
}

/** One release written as a person reads it: "unparked implement", "cleared the validate hold". */
export function describeAction(a: ReleaseAction): string {
  switch (a.op) {
    case "unpark":
      return `unparked ${a.phase ?? "a phase"}`;
    case "clear_validate_hold":
      return "cleared the validate hold";
    case "clear_no_change_hold":
      return "cleared the no-change hold";
    case "grant_round_threshold_cycle":
      return "bought one more repair cycle";
    default:
      return `${a.op}${a.phase ? ` at ${a.phase}` : ""}`;
  }
}

const refusalLine = (r: ReleaseRefusal) => `  ${r.code}: ${r.humanAction}`;

export function renderTicketRelease(ticket: string, r: TicketReleaseResult): string[] {
  if (r.error === "team_changed") {
    return [`${ticket} moved from team ${r.expectedTeamKey ?? "(none)"} to ${r.teamKey ?? "(none)"} while the release was being checked — run it again`];
  }
  const lines: string[] = [];
  const dry = r.dryRun === true;
  if (r.outcome === "nothing-held") {
    lines.push(`${ticket}: nothing holds this ticket — run \`catalyst-skills explain ${ticket}\` for why it is not running`);
  } else if (r.outcome === "refused") {
    lines.push(dry ? `${ticket} (dry run): would be refused — nothing would be released:` : `${ticket}: refused — nothing was released:`);
    for (const x of r.refused ?? []) lines.push(refusalLine(x));
    const blocked = r.releasable ?? [];
    if (blocked.length > 0) lines.push(`  (it would otherwise have ${blocked.map(describeAction).join(", ")})`);
  } else if (dry) {
    lines.push(`${ticket} (dry run): would release — ${(r.releasable ?? []).map(describeAction).join(", ")}`);
  } else {
    lines.push(`${ticket}: released — ${(r.released ?? []).map(describeAction).join(", ")}`);
  }
  for (const w of r.warnings ?? []) lines.push(`warning: ${w}`);
  return lines;
}

export function renderClassRelease(r: ClassReleaseResult): string[] {
  const released = r.released ?? [];
  const refused = r.refused ?? [];
  const nothing = r.nothingHeld ?? [];
  const head = `${r.team ?? "?"} ${r.class ?? "?"}${r.dryRun ? " (dry run)" : ""}: released ${released.length}, refused ${refused.length}, nothing held ${nothing.length}${r.truncated ? " (more remain — run it again)" : ""}`;
  const lines = [head];
  for (const t of released) {
    const actions = r.dryRun ? (t.releasable ?? []) : (t.released ?? []);
    lines.push(`  ${r.dryRun ? "would release" : "released"} ${t.ticket ?? "?"}: ${actions.map(describeAction).join(", ")}`);
  }
  for (const t of refused) {
    for (const x of t.refused ?? []) lines.push(`  refused ${t.ticket ?? "?"} — ${x.code}: ${x.humanAction}`);
  }
  if (nothing.length > 0) lines.push(`  nothing held: ${nothing.join(", ")}`);
  return lines;
}

/** The contract's route by name, or the "your cloud is older" error when this tenant does not serve it. */
function releaseRoute(doc: TenantContract, name: string, cfg: { baseUrl: string }): string {
  const route = doc.routes.find((r) => r.method === "POST" && r.path.split("/").filter(Boolean).at(-1) === name);
  if (!route) throw needsNewerCloud(`release (the tenant contract serves no "${name}" route)`, cfg);
  return route.path;
}

export async function cmdRelease(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const [ticket, ...extra] = positionals(args);
  const failureClass = flagString(args, "class");
  const team = flagString(args, "team");
  const because = flagString(args, "because");
  const dryRun = flagBool(args, "dry-run");
  const retryUnchanged = flagBool(args, "retry-unchanged");
  if (extra.length > 0) throw new UsageError("release takes one ticket");
  if (failureClass !== undefined && ticket !== undefined) {
    throw new UsageError("release takes a ticket or --class with --team, not both");
  }
  if (failureClass === undefined && ticket === undefined) {
    throw new UsageError("release needs a ticket, or --class <failure-class> --team <K>");
  }
  if (failureClass !== undefined && team === undefined) throw new UsageError("release --class needs --team <K>");
  if (because === undefined && !dryRun) {
    throw new UsageError("release needs --because <what changed> (recorded in the release audit), or --dry-run to preview");
  }
  const limitRaw = flagString(args, "limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && !Number.isInteger(limit)) throw new UsageError("--limit must be an integer");

  const cfg = requireConfig(ctx);
  const { doc } = await loadContract(ctx, cfg);
  const api = apiClient(cfg, ctx);
  const common = { ...(because !== undefined ? { because } : {}), retryUnchanged, dryRun };

  if (failureClass !== undefined) {
    const path = releaseRoute(doc, "ticket-release-class", cfg);
    const res = await api.postJson<ClassReleaseResult>(path, {
      team,
      class: failureClass,
      ...common,
      ...(limit !== undefined ? { limit } : {}),
    });
    if (args.json) ctx.stdout(JSON.stringify(res.body));
    else for (const line of renderClassRelease(res.body)) ctx.stdout(line);
    return 0;
  }

  const id = ticket as string;
  const path = releaseRoute(doc, "ticket-release", cfg);
  const res = await api.postJson<TicketReleaseResult>(path, { ticket: id, ...common }, { accept: [404, 409] });
  if (res.status === 404) {
    throw new CliError(`ticket ${id} is not in this tenant's mirror — check the identifier`, "ticket-unknown");
  }
  if (args.json) ctx.stdout(JSON.stringify(res.body));
  else for (const line of renderTicketRelease(id, res.body)) ctx.stdout(line);
  const refused = res.status === 409 || (res.body.outcome === "refused" && res.body.dryRun !== true);
  return refused ? 1 : 0;
}
