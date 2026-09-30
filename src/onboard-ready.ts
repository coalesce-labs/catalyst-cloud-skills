import type { Ctx } from "./config.js";
import { loadConfig } from "./config.js";
import { loadContract } from "./contract.js";

export interface OnboardingReadyCheck {
  id: string;
  state: "pass" | "fail" | "unknown";
  required: boolean;
  reason?: string;
  evidence?: Record<string, string | number | boolean | null>;
}
export interface OnboardingWork {
  state: "observed" | "not_observed" | "unknown";
  ticket?: string;
  phaseStartedAt?: string;
}
export interface OnboardingObservation { checks: OnboardingReadyCheck[]; work: OnboardingWork }
export interface OnboardingReadyDeps {
  localSync?: boolean;
  teamIds?: readonly string[];
  observe?: (ctx: Ctx, scope?: { teamIds?: readonly string[] }) => Promise<OnboardingObservation>;
}
export interface OnboardingReadyReport extends OnboardingObservation {
  schema: 1;
  readMode: "cloud" | "local";
  state: "complete" | "incomplete" | "unknown";
}
const evidenceNames = new Set(["account", "membershipId", "project", "team", "repository", "count", "checkedAt", "expiresAt", "revision", "lag", "cursor", "heartbeatAgeMs", "supervised", "available", "validated", "phaseStarted", "linearComment", "fleetActivity"]);
const slug = (value: string | undefined) => value && /^[a-z][a-z0-9_]{1,63}$/.test(value) ? value : undefined;
function cleanCheck(check: OnboardingReadyCheck): OnboardingReadyCheck {
  const evidence = Object.fromEntries(Object.entries(check.evidence ?? {}).filter(([key, value]) => evidenceNames.has(key) &&
    (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))));
  return { id: check.id, state: check.state, required: check.required, ...(slug(check.reason) ? { reason: slug(check.reason) } : {}),
    ...(Object.keys(evidence).length ? { evidence } : {}) };
}

/** Receipts describe previous changes. Completion requires current observations. */
export async function onboardingReadyReport(ctx: Ctx, deps: OnboardingReadyDeps): Promise<OnboardingReadyReport> {
  const unavailable: OnboardingObservation = {
    checks: [{ id: "cloud.setup", state: "unknown" as const, required: true, reason: "cloud_checks_unavailable" }],
    work: { state: "unknown" as const },
  };
  let observation: OnboardingObservation;
  try { observation = deps.observe ? await deps.observe(ctx, { teamIds: deps.teamIds }) : unavailable; }
  catch { observation = unavailable; }
  const checks = observation.checks.map(cleanCheck);
  if (deps.localSync && !checks.some(check => check.required && check.id.startsWith("local.")))
    checks.push({ id: "local.sync", state: "unknown", required: true, reason: "local_sync_unverified" });
  const work: OnboardingWork = { state: observation.work.state,
    ...(observation.work.ticket && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(observation.work.ticket) ? { ticket: observation.work.ticket } : {}),
    ...(observation.work.phaseStartedAt && Number.isFinite(Date.parse(observation.work.phaseStartedAt)) ? { phaseStartedAt: observation.work.phaseStartedAt } : {}) };
  const required = checks.filter(check => check.required);
  const state = required.some(check => check.state === "fail") || work.state === "not_observed" ? "incomplete"
    : required.length === 0 || required.some(check => check.state === "unknown") || work.state === "unknown" ? "unknown" : "complete";
  return { schema: 1, readMode: deps.localSync ? "local" : "cloud", state, checks, work };
}

/** The current contract exposes checked project setup, but not fresh starter-ticket proof. */
export async function observeCloudOnboarding(ctx: Ctx, scope: { teamIds?: readonly string[] } = {}): Promise<OnboardingObservation> {
  const cfg = loadConfig(ctx.home);
  if (!cfg?.user) return { checks: [{ id: "signin", state: "fail", required: true, reason: "personal_login_required" }], work: { state: "unknown" } };
  const { doc, source } = await loadContract(ctx, cfg, { refresh: true });
  if (source === "cache") return { checks: [{ id: "cloud.setup", state: "unknown", required: true, reason: "cloud_observation_unavailable" }], work: { state: "unknown" } };
  const checks: OnboardingReadyCheck[] = [];
  if (doc.account.id !== cfg.account) return { checks: [{ id: "workspace", state: "fail", required: true, reason: "workspace_mismatch" }], work: { state: "unknown" } };
  if (!scope.teamIds?.length) return { checks: [{ id: "projects", state: "unknown", required: true, reason: "project_selection_unverified" }], work: { state: "unknown" } };
  for (const id of new Set(scope.teamIds)) {
    const team = doc.teams.find(row => row.id === id);
    if (!team) {
      checks.push({ id: `team.${id}`, state: "unknown", required: true, reason: "team_selection_unverified", evidence: { team: id } }); continue;
    }
    const fresh = team.readiness.checkedAt !== null && team.readiness.expiresAt !== null && team.readiness.expiresAt > ctx.now().getTime();
    if (!fresh || team.readiness.checks.length === 0) {
      checks.push({ id: `team.${team.id}`, state: "unknown", required: true, reason: "team_check_pending", evidence: { team: team.id } }); continue;
    }
    for (const check of team.readiness.checks) checks.push({ id: `team.${team.id}.${check.id}`, state: check.state, required: true,
      reason: slug(check.reason), evidence: { team: team.id, checkedAt: team.readiness.checkedAt, ...(check.count !== undefined ? { count: check.count } : {}) } });
  }
  if (!checks.length) checks.push({ id: "projects", state: "unknown", required: true, reason: "project_selection_unverified" });
  // A project may already be working even with an unknown setup check. This endpoint cannot prove either work state.
  return { checks, work: { state: "unknown" } };
}
