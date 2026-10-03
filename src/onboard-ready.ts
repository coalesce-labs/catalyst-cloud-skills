import type { Ctx } from "./config.js";
import { loadConfig } from "./config.js";
import { loadContract } from "./contract.js";
import {
  ONBOARD_DEFERRED_STEPS,
  onboardRequiredStepsWaiting,
  type OnboardJournal,
  type OnboardStepId,
  type OnboardStepResult,
} from "./onboard.js";

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

/** Team check outcomes that do not hold setup's readiness, as `check:reason`: the cloud's four
 * WAITING_PAIRS (nothing has happened yet before a first ticket: a webhook delivery, a write, a host
 * attaching, a reviewer's first answer), plus two of setup's own. A missing value is the values
 * step's action; a reference with no value is not here, because the checkout refuses it before any
 * work starts. A team with no reviewer still runs. */
const READY_EXEMPT = new Set([
  "webhook_covers_team:delivery_window_empty",
  "writes_land:no_write_observed",
  "hosts_current:no_host_connected",
  "reviewer_answering:reviewer_not_yet_answered",
  "required_values:required_value_missing",
  "reviewer_configured:no_reviewer_configured",
]);

/** Admin-owned steps a member's run skips, and the team checks that show an admin finished them. A
 * member's skip is not a finished setup: readiness holds until these checks pass. */
const ADMIN_OWNED: ReadonlyArray<readonly [OnboardStepId, readonly string[]]> = [
  ["linear.workspace", ["oauth_scope", "token_live"]],
  ["github.install", ["github_app_installed"]],
  ["linear.adopt", ["mapping_total", "mapped_states_exist"]],
];

/** The setup step's verdict. Every required step must be satisfied, and every required check must
 * pass or be one of the exempt outcomes above. A failing check fails; anything else unread (a stale
 * or unverified team, a check the cloud could not read, the cloud itself) waits. Work nobody can
 * observe yet does not hold it. */
export function onboardReadyStep(
  report: OnboardingReadyReport,
  journal: Pick<OnboardJournal, "steps"> | undefined,
): OnboardStepResult {
  const evidence = {
    checks: report.checks.length,
    passed: report.checks.filter((check) => check.state === "pass").length,
  };
  const failedStep = (journal?.steps ?? []).some(
    (step) =>
      step.id !== "ready" &&
      !ONBOARD_DEFERRED_STEPS.has(step.id) &&
      step.state === "failed",
  );
  if (onboardRequiredStepsWaiting(journal) || failedStep)
    return { state: "waiting", reason: "onboarding_checks_pending", evidence };
  const skipped = (id: OnboardStepId) =>
    journal?.steps.some((step) => step.id === id && step.state === "skipped" && step.reason === "member_scope");
  // A member's plain run has no team, so nothing can show what an admin finished.
  if (skipped("linear.team"))
    return { state: "waiting", reason: "member_team_required", evidence };
  // Only a check read from a fresh team (`team.<id>.<check>`) that fails counts. An absent, stale or
  // unknown one (an outage, a workflow just adopted) says nothing about the admin step, so it falls
  // through to the waits below.
  const read = new Map(
    report.checks
      .filter((check) => /^team\.[^.]+\.[a-z0-9_]+$/.test(check.id))
      .map((check) => [check.id.split(".")[2]!, check.state]),
  );
  const adminLeft = ADMIN_OWNED.filter(
    ([id, checks]) =>
      skipped(id) && checks.some((check) => read.get(check) === "fail"),
  ).map(([id]) => id);
  if (adminLeft.length)
    return { state: "waiting", reason: "admin_setup_pending", evidence: { ...evidence, admin: adminLeft.join(",") } };
  const open = report.checks.filter((check) => {
    if (!check.required || check.state === "pass") return false;
    // `team.<id>.<check>` is one team check; `team.<id>` alone is the team's whole check list.
    const parts = check.id.split(".");
    return !(parts[0] === "team" && parts.length === 3 && READY_EXEMPT.has(`${parts[2]}:${check.reason}`));
  });
  if (open.some((check) => check.state === "fail"))
    return { state: "failed", reason: "onboarding_checks_pending", evidence };
  if (open.length) return { state: "waiting", reason: "onboarding_checks_pending", evidence };
  return { state: "done", evidence };
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
