// Team setup uses the person's saved login and the SDK's typed personal-admin methods.
// A fresh SDK client per call refreshes a device-login token across a multi-chunk migration.
import { createHash } from "node:crypto";
import type { TenantClient, TenantClientOptions, TeamMappingSaveInput, TeamWorkflowResult } from "@catalyst-cloud/sdk";
import { flagBool, flagList, flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { loadContract } from "./contract.js";
import type { TenantContract } from "./contract-types.js";
import { UsageError } from "./errors.js";
import { bearerFor } from "./oauth.js";
import { loadHttpSdk } from "./sdk.js";

type Body = Record<string, unknown>;
type Reply = { status: number; body: Body };
type TeamClient = Pick<TenantClient, "teamWorkflow">;
export interface TeamDeps { createClient?: (options: TenantClientOptions) => Promise<TeamClient> | TeamClient }
type Routes = { teams: string; read: string; check: string; save: string; adopt: string; undo: string; migrate: string };
type ReadView = { config?: { mode?: TeamMappingSaveInput["mode"]; gitAutomation?: TeamMappingSaveInput["gitAutomation"] }; rows?: { slot: string; linearStateId: string | null }[]; stages?: { id: string; name: string; type: string }[]; stageSource?: string; mappingHash?: string; checklist?: string[] | null; readiness?: Body };
type Preview = { migrationHash?: string; sources?: { stateId: string; name: string; destinationStateId: string | null; ticketCount: number; outcome: string; reason?: string }[]; overLimit?: boolean; issueCount?: number; actionsAvailable?: boolean };

const SLOTS = ["dispatch", "intake", "research", "plan", "implement", "remediate", "verify", "review", "pr", "done", "canceled"] as const;
type Slot = typeof SLOTS[number];
function isSlot(value: string): value is Slot { return (SLOTS as readonly string[]).includes(value); }
const NAMES: Record<string, string[]> = {
  dispatch: ["todo", "to do", "ready"], intake: ["intake", "triage"], research: ["research"],
  plan: ["plan", "planning"], implement: ["implement", "in progress", "doing"],
  remediate: ["remediate", "fix"], verify: ["verify", "validate", "testing"], review: ["review"],
  pr: ["pr", "in review", "pull request"], done: ["done", "completed"], canceled: ["canceled", "cancelled"],
};
const MAX_CHUNKS = 100;
const MAX_RUN_MS = 5 * 60_000;

function routes(doc: TenantContract): Routes {
  const read = doc.routes.find((r) => r.method === "GET" && r.path.endsWith("/team-workflow"))?.path;
  if (!read) throw new UsageError("team setup needs a newer Catalyst Cloud (team-workflow route absent)");
  const desired = { teams: read.replace(/\/team-workflow$/, "/teams"), read, check: `${read}/check`, save: `${read}/save`, adopt: `${read}/adopt`, undo: `${read}/adopt-undo`, migrate: `${read}/migrate` };
  for (const [name, path] of Object.entries(desired)) {
    const method = name === "teams" || name === "read" ? "GET" : "POST";
    if (!doc.routes.some((r) => r.method === method && r.path === path)) throw new UsageError(`team setup needs a newer Catalyst Cloud (${method} ${path} absent)`);
  }
  return desired;
}

function key(args: ParsedArgs): string {
  const [sub, team, ...extra] = positionals(args);
  if (extra.length > 0) throw new UsageError(`team ${sub ?? ""} takes one team key`);
  if (!team && !(sub === "list" || (sub === "check" && flagBool(args, "all")))) throw new UsageError(`team ${sub ?? ""} needs a team key`);
  if (team && flagBool(args, "all")) throw new UsageError("team check takes a key or --all, not both");
  return team ?? "";
}

function emit(ctx: Ctx, args: ParsedArgs, value: Body, lines: string[]): void {
  if (args.json) ctx.stdout(JSON.stringify(value));
  else for (const line of lines) ctx.stdout(line);
}

function refusal(ctx: Ctx, args: ParsedArgs, reply: Reply): number {
  const { body, status } = reply;
  emit(ctx, args, { status, ...body }, [`refused (${status}): ${String(body.error ?? "http")}${body.reason || body.message ? ` — ${String(body.reason ?? body.message)}` : ""}`]);
  return 1;
}

function readinessLines(value: unknown): string[] {
  if (value === null || typeof value !== "object") return ["the change landed, but readiness could not be checked; run team check"];
  const r = value as Body;
  return [`readiness: ${String(r.status ?? "unknown")}; checked at ${String(r.checkedAt ?? "unknown")}`,
    ...((Array.isArray(r.checks) ? r.checks : []) as Body[]).filter((c) => c.state === "fail").map((c) => `  ${String(c.id)}: ${String(c.reason ?? "failed")} (${String(c.owner ?? c.whoCanFix ?? "team admin")})`)];
}

function fromSdk<T extends object>(result: TeamWorkflowResult<T>): Reply {
  if (result.outcome === "ok") {
    const { outcome: _outcome, status, ...body } = result;
    return { status, body: body as Body };
  }
  return {
    status: result.outcome === "shape" ? 502 : "status" in result ? result.status : 503,
    body: { error: "error" in result ? result.error ?? result.outcome : result.outcome, reason: result.reason, ...(result.outcome === "shape" ? { upstreamStatus: result.status } : {}) },
  };
}

function isRefusal(reply: Reply): boolean { return typeof reply.body.error === "string" || !((reply.status >= 200 && reply.status < 300) || reply.status === 304); }

function assignments(values: string[], label: string): [string, string][] {
  return values.map((value) => {
    const split = value.indexOf("=");
    if (split <= 0 || split === value.length - 1) throw new UsageError(`--${label} needs left=right (got ${value})`);
    return [value.slice(0, split), value.slice(split + 1)];
  });
}

function mapping(view: ReadView, explicit: [string, string][]): { rows: TeamMappingSaveInput["rows"]; diff: Body[]; unresolved: string[] } {
  if (view.stageSource === "none" || !Array.isArray(view.stages)) throw new UsageError("live Linear stages are unreadable; retry team map after the connection is healthy");
  const stages = view.stages;
  const selected = new Map<Slot, string>();
  const unresolved: string[] = [];
  if (explicit.length > 0) {
    for (const [slot, stateName] of explicit) {
      if (!isSlot(slot)) throw new UsageError(`unknown workflow role: ${slot}`);
      if (selected.has(slot)) throw new UsageError(`duplicate workflow role: ${slot}`);
      const found = stages.filter((s) => s.name.toLocaleLowerCase() === stateName.toLocaleLowerCase() || s.id === stateName);
      if (found.length !== 1) throw new UsageError(`${stateName} matches ${found.length} live Linear stages; choose an unambiguous name or id`);
      selected.set(slot, found[0]!.id);
    }
  } else {
    for (const slot of SLOTS) {
      const names = NAMES[slot] ?? [];
      const match = names.flatMap((name) => stages.filter((stage) => stage.name.toLocaleLowerCase() === name));
      const unique = [...new Map(match.map((stage) => [stage.id, stage])).values()];
      if (unique.length === 1) selected.set(slot, unique[0]!.id);
      else unresolved.push(slot);
    }
  }
  const previous = new Map((view.rows ?? []).map((r) => [r.slot, r.linearStateId]));
  const diff = SLOTS.map((slot) => {
    const before = previous.get(slot) ?? null;
    const after = selected.get(slot) ?? null;
    return { slot, before, after, change: before === after ? "unchanged" : before === null ? "added" : after === null ? "removed" : "changed" };
  });
  return { rows: SLOTS.filter((slot) => selected.has(slot)).map((slot) => ({ slot, linearStateId: selected.get(slot)!, source: "chosen" as const })), diff, unresolved };
}

function hashPlan(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function planLines(title: string, rows: unknown[], hash: string): string[] {
  return [title, ...rows.map((row) => `  ${JSON.stringify(row)}`), `Plan hash: ${hash}`, `Review this plan with the person, then rerun with --yes --plan-hash ${hash} to apply exactly it.`];
}

export async function cmdTeam(args: ParsedArgs, ctx: Ctx, deps: TeamDeps = {}): Promise<number> {
  const [sub] = positionals(args);
  if (!sub || !["list", "check", "map", "adopt", "migrate", "checklist"].includes(sub)) throw new UsageError("team needs list | check | map | adopt | migrate | checklist");
  const team = key(args);
  if (sub !== "check" && flagBool(args, "all")) throw new UsageError("--all belongs to team check");
  if (sub !== "adopt" && flagBool(args, "undo")) throw new UsageError("--undo belongs to team adopt");
  if (sub !== "migrate" && (flagBool(args, "retire") || flagList(args, "choice").length)) throw new UsageError("--retire and --choice belong to team migrate");
  if (sub !== "map" && flagList(args, "stage").length) throw new UsageError("--stage belongs to team map");
  if (!["map", "adopt", "migrate"].includes(sub) && flagString(args, "plan-hash") !== undefined) throw new UsageError("--plan-hash belongs to team map, adopt, or migrate");
  if ((sub === "check" || sub === "checklist") && flagBool(args, "yes")) throw new UsageError(`team ${sub} takes no --yes`);
  const cfg = requireConfig(ctx);
  let { doc } = await loadContract(ctx, cfg);
  try {
    routes(doc);
  } catch (error) {
    if (!(error instanceof UsageError) || !error.message.includes("team-workflow")) throw error;
    // A fresh cached contract can predate the team routes. Revalidate once before telling the
    // person the cloud is too old; the conditional GET is cheap when the server has not changed.
    doc = (await loadContract(ctx, cfg, { refresh: true })).doc;
    routes(doc);
  }
  // API hashes detect stale server state. CLI approval additionally binds the reviewed scope,
  // operation and signed-in tenant so consent cannot transfer to a different command or account.
  const approvalHash = (operation: string, plan: unknown) => hashPlan({ baseUrl: cfg.baseUrl, account: cfg.account, actor: cfg.user?.id ?? null, team, operation, plan });
  const createClient = deps.createClient ?? (async (options: TenantClientOptions) => (await loadHttpSdk()).createTenantClient(options));
  const client = async () => (await createClient({ key: await bearerFor(ctx, cfg), baseUrl: cfg.baseUrl, fetch: ctx.fetch })).teamWorkflow;

  if (sub === "list") {
    const reply = fromSdk(await (await client()).teams());
    if (isRefusal(reply)) return refusal(ctx, args, reply);
    if (!Array.isArray(reply.body.teams)) return refusal(ctx, args, { status: 502, body: { error: "bad-response", reason: "team list was missing" } });
    const teams = reply.body.teams as Body[];
    emit(ctx, args, { teams, liveTeamRead: reply.body.liveTeamRead }, teams.map((t) => `${String(t.teamKey ?? t.teamId ?? t.key ?? "unknown")}: ${String(t.name ?? t.teamName ?? "")}`));
    return 0;
  }

  if (sub === "check") {
    const teamList = flagBool(args, "all") ? fromSdk(await (await client()).teams()) : null;
    if (teamList && isRefusal(teamList)) return refusal(ctx, args, teamList);
    const teamKeys = teamList ? (Array.isArray(teamList.body.teams) ? teamList.body.teams as Body[] : []).map((t) => String(t.teamKey || t.teamId || t.key || "")).filter(Boolean) : [team];
    if (teamList && !Array.isArray(teamList.body.teams)) return refusal(ctx, args, { status: 502, body: { error: "bad-response", reason: "team list was missing" } });
    if (teamList && teamKeys.length === 0) return refusal(ctx, args, { status: 404, body: { error: "no-teams", reason: "No Linear teams are visible to this account; connect the tenant's Linear workspace and retry." } });
    const results: Body[] = [];
    let failed = false;
    for (const teamKey of teamKeys) {
      const reply = fromSdk(await (await client()).check(teamKey));
      if (isRefusal(reply)) { results.push({ team: teamKey, status: reply.status, ...reply.body }); failed = true; break; }
      results.push({ team: teamKey, ...reply.body });
      if ((reply.body.readiness as Body | undefined)?.status !== "ready") failed = true;
    }
    emit(ctx, args, { results }, results.flatMap((result) => [`${String(result.team)}:`, ...(result.error ? [`  refused: ${String(result.error)} — ${String(result.reason ?? result.message ?? "")}`] : readinessLines(result.readiness))]));
    return failed ? 1 : 0;
  }

  if (sub === "checklist") {
    const reply = fromSdk(await (await client()).get(team));
    if (isRefusal(reply)) return refusal(ctx, args, reply);
    const checklist = reply.body.checklist;
    if (!Array.isArray(checklist) || !checklist.every((line) => typeof line === "string")) return refusal(ctx, args, { status: 503, body: { error: "stages-unreadable", reason: "Could not read live Linear stages; retry team checklist." } });
    emit(ctx, args, { team, checklist }, checklist);
    return 0;
  }

  if (sub === "map") {
    const reply = fromSdk(await (await client()).get(team));
    if (isRefusal(reply)) return refusal(ctx, args, reply);
    if (typeof reply.body.mappingHash !== "string") return refusal(ctx, args, { status: 502, body: { error: "bad-response", reason: "team workflow read omitted the mapping hash; update Catalyst Cloud before saving" } });
    let proposal: ReturnType<typeof mapping>;
    try { proposal = mapping(reply.body as ReadView, assignments(flagList(args, "stage"), "stage")); }
    catch (error) { return refusal(ctx, args, { status: 400, body: { error: "mapping-unresolved", reason: error instanceof Error ? error.message : String(error) } }); }
    const config = reply.body.config && typeof reply.body.config === "object" ? reply.body.config as ReadView["config"] : undefined;
    const mode = config?.mode ?? "mapped-existing";
    const gitAutomation = config?.gitAutomation ?? "off";
    const planHash = approvalHash("map", { team, rows: proposal.rows, diff: proposal.diff, unresolved: proposal.unresolved, mappingHash: reply.body.mappingHash, mode, gitAutomation });
    const preview = { team, rows: proposal.rows, diff: proposal.diff, unresolved: proposal.unresolved, mappingHash: reply.body.mappingHash, mode, gitAutomation, planHash, decision: "not-confirmed" };
    if (!flagBool(args, "yes")) { emit(ctx, args, preview, planLines(`Mapping plan for ${team}:`, proposal.diff, planHash)); return 3; }
    if (flagString(args, "plan-hash") !== planHash) return refusal(ctx, args, { status: 409, body: { error: "plan-hash-mismatch", reason: `Preview again and review the updated plan hash ${planHash}.` } });
    if (!args.json) for (const line of planLines(`Mapping plan for ${team}:`, proposal.diff, planHash).slice(0, -1)) ctx.stdout(line);
    const saved = fromSdk(await (await client()).save({ team, mode, gitAutomation, rows: proposal.rows, expectedMappingHash: reply.body.mappingHash }));
    if (isRefusal(saved)) return refusal(ctx, args, saved);
    emit(ctx, args, { ...preview, decision: "applied", result: saved.body }, readinessLines(saved.body.readiness));
    return 0;
  }

  if (sub === "adopt") {
    const undo = flagBool(args, "undo");
    const previewReply = fromSdk(undo ? await (await client()).undoPreview(team) : await (await client()).adoptPreview(team));
    if (isRefusal(previewReply)) return refusal(ctx, args, previewReply);
    const hashName = undo ? "undoHash" : "planHash";
    const hash = previewReply.body[hashName];
    if (typeof hash !== "string" || !Array.isArray(previewReply.body[undo ? "candidates" : "stages"])) return refusal(ctx, args, { status: 502, body: { error: "bad-response", reason: `adopt preview omitted ${hashName} or scope` } });
    const planHash = approvalHash(undo ? "adopt-undo" : "adopt", {
      serverHash: hash, teamId: previewReply.body.teamId,
      stages: previewReply.body.stages, labels: previewReply.body.labels,
      candidates: previewReply.body.candidates, unfilledLoadBearing: previewReply.body.unfilledLoadBearing,
    });
    const plan = { team, decision: "not-confirmed", preview: previewReply.body, planHash };
    const scope = [
      ...(previewReply.body[undo ? "candidates" : "stages"] as unknown[]),
      ...(undo ? [] : Array.isArray(previewReply.body.labels) ? previewReply.body.labels : []),
    ];
    if (!flagBool(args, "yes")) { emit(ctx, args, plan, planLines(`${undo ? "Undo" : "Adopt"} plan for ${team}:`, scope, planHash)); return 3; }
    if (flagString(args, "plan-hash") !== planHash) return refusal(ctx, args, { status: 409, body: { error: "plan-hash-mismatch", reason: `Preview again and review the updated plan hash ${planHash}.` } });
    if (!args.json) for (const line of planLines(`${undo ? "Undo" : "Adopt"} plan for ${team}:`, scope, planHash).slice(0, -1)) ctx.stdout(line);
    const applied = fromSdk(undo ? await (await client()).undoApply(team, hash) : await (await client()).adoptApply(team, hash));
    if (isRefusal(applied)) return refusal(ctx, args, applied);
    const outcomes = (undo ? [applied.body.archived, applied.body.kept, applied.body.failed] : [applied.body.stages, applied.body.labels, applied.body.labelsNotCreated, applied.body.provenanceGaps, applied.body.labelProvenanceGaps]).flatMap((v) => Array.isArray(v) ? v : []);
    emit(ctx, args, { team, decision: "applied", preview: previewReply.body, result: applied.body }, [...outcomes.map((o) => `  ${JSON.stringify(o)}`), ...readinessLines(applied.body.readiness)]);
    return 0;
  }

  const choices = assignments(flagList(args, "choice"), "choice").map(([sourceStateId, destinationStateId]) => ({ sourceStateId, destinationStateId }));
  const previewReply = fromSdk(await (await client()).migratePreview(team, choices));
  if (isRefusal(previewReply)) return refusal(ctx, args, previewReply);
  const preview = previewReply.body.preview as Preview | undefined;
  if (!preview || typeof preview.migrationHash !== "string" || !Array.isArray(preview.sources)) return refusal(ctx, args, { status: 502, body: { error: "bad-response", reason: "migration preview omitted hash or source rows" } });
  if (preview.actionsAvailable === false) return refusal(ctx, args, { status: 409, body: { error: "migration-approval-unavailable", reason: "Catalyst cannot verify the exact tickets in this migration preview, so moves and retirement are paused. Use Linear's bulk editor to move tickets, or retry when approved migration snapshots are available." } });
  const step = flagBool(args, "retire") ? "retire" : "migrate";
  const planHash = approvalHash(step, { preview, choices });
  const plan = { team, step, decision: "not-confirmed", preview, planHash };
  const blocked = preview.overLimit || preview.sources.some((source) => source.outcome === "needs-a-choice");
  if (!flagBool(args, "yes")) { emit(ctx, args, plan, planLines(`Migration ${plan.step} plan for ${team}:`, preview.sources, planHash)); return 3; }
  if (flagString(args, "plan-hash") !== planHash) return refusal(ctx, args, { status: 409, body: { error: "plan-hash-mismatch", reason: `Preview again and review the updated plan hash ${planHash}.` } });
  if (blocked) return refusal(ctx, args, { status: 400, body: { error: "migration-plan-blocked", reason: "Resolve the preview's blocked sources or issue limit before applying." } });
  if (!args.json) for (const line of planLines(`Migration ${plan.step} plan for ${team}:`, preview.sources, planHash).slice(0, -1)) ctx.stdout(line);
  const results: Body[] = [];
  const deadline = Date.now() + MAX_RUN_MS;
  let hash = preview.migrationHash;
  for (let n = 0; n < (step === "retire" ? 1 : MAX_CHUNKS); n++) {
    if (Date.now() >= deadline) return refusal(ctx, args, { status: 503, body: { error: "migration-time-budget", reason: "The bounded run ended; preview again before continuing." } });
    const result = fromSdk(step === "retire" ? await (await client()).migrateRetire(team, hash, choices) : await (await client()).migrateChunk(team, hash, choices));
    if (isRefusal(result)) return refusal(ctx, args, result);
    results.push(result.body);
    const partial = Array.isArray(result.body.sources) && (result.body.sources as Body[]).some((source) => source.outcome === "partially-moved");
    if (!args.json) {
      ctx.stdout(`${step} chunk ${n + 1}: moved ${String(result.body.moved ?? 0)}, remaining ${String(result.body.remaining ?? 0)}`);
      for (const source of Array.isArray(result.body.sources) ? result.body.sources : []) ctx.stdout(`  ${JSON.stringify(source)}`);
      for (const [name, value] of Object.entries(result.body)) if (name === "failed" || name === "blockers" || name === "logGaps") ctx.stdout(`  ${name}: ${JSON.stringify(value)}`);
    }
    if (partial) {
      emit(ctx, args, { ...plan, decision: "partial", results }, [`Migration partially completed; at least one source reported a refused or incomplete move.`, ...readinessLines(result.body.readiness)]);
      return 1;
    }
    if (step === "retire" && Array.isArray(result.body.failed) && result.body.failed.length > 0) {
      emit(ctx, args, { ...plan, decision: "partial", results }, [`Source retirement partially completed: ${JSON.stringify(result.body.failed)}`]);
      return 1;
    }
    if (step === "retire" || result.body.remaining === 0) {
      emit(ctx, args, { ...plan, decision: "applied", results }, [...readinessLines(result.body.readiness), ...(step === "migrate" ? ["Tickets moved. Retiring source stages requires a separate team migrate --retire confirmation."] : [])]);
      return 0;
    }
    if (typeof result.body.migrationHash !== "string") return refusal(ctx, args, { status: 502, body: { error: "bad-response", reason: "migration chunk omitted the next hash" } });
    hash = result.body.migrationHash;
  }
  return refusal(ctx, args, { status: 503, body: { error: "migration-chunk-limit", reason: "The bounded run ended; preview again before continuing." } });
}
