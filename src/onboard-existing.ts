import type { ParsedArgs } from "./args.js";
import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import { CliError } from "./errors.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";

export interface ExistingOnboardTeam {
  id: string;
  key: string;
  name: string;
}
export type ChooseExistingTeam = (
  teams: readonly ExistingOnboardTeam[],
) => Promise<string | null>;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const waiting = (reason: string): OnboardStepResult => ({
  state: "waiting",
  reason,
});
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const label = (value: string) =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 120);

/** A receipt keeps an explicit selection, never the team used to inspect the tenant grant. */
export function selectedOnboardTeam(
  journal?: OnboardJournal,
): string | undefined {
  const step = journal?.steps.find((row) => row.id === "linear.team");
  const id = step?.state === "done" ? step.evidence?.team : undefined;
  return typeof id === "string" && idPattern.test(id) ? id : undefined;
}

export type ExistingOnboardReadResult = { body: unknown } | { reason: string };
/** Read-only requests bound headers and body together; raw provider errors never reach receipts. */
export async function readExistingOnboardJson(
  ctx: Ctx,
  path: string,
  external?: AbortSignal,
): Promise<ExistingOnboardReadResult> {
  const cfg = loadConfig(ctx.home);
  if (!cfg?.user) return { reason: "personal_login_required" };
  const personId = cfg.user.id;
  // Identity verification refreshes before adapters run. These bounded reads never rotate a grant
  // that could finish after the engine has released its lock.
  const expiry = cfg.auth
    ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime()
    : 0;
  const bearer =
    cfg.key ||
    (cfg.auth && Number.isFinite(expiry) && expiry > 30_000
      ? cfg.auth.accessToken
      : undefined);
  if (!bearer) return { reason: "team_read_login_refresh_required" };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 30_000);
  const signal = external
    ? AbortSignal.any([external, deadline.signal])
    : deadline.signal;
  let remove = () => {};
  try {
    return await new Promise<ExistingOnboardReadResult>((resolve, reject) => {
      const stopped = () =>
        external?.aborted
          ? reject(
              new CliError(
                "Setup paused. Run the same command to resume.",
                "interrupted",
                11,
              ),
            )
          : resolve({ reason: "team_read_unavailable" });
      if (signal.aborted) {
        stopped();
        return;
      }
      signal.addEventListener("abort", stopped, { once: true });
      remove = () => signal.removeEventListener("abort", stopped);
      Promise.resolve()
        .then(async (): Promise<ExistingOnboardReadResult> => {
          if (signal.aborted) return { reason: "team_read_unavailable" };
          const response = await ctx.fetch(
            `${normalizeBaseUrl(cfg.baseUrl)}${path}`,
            {
              redirect: "error",
              headers: {
                authorization: `Bearer ${bearer}`,
                accept: "application/json",
              },
              signal,
            },
          );
          if (response.status !== 200)
            return { reason: "team_read_unavailable" };
          const body: unknown = await response.json();
          const current = loadConfig(ctx.home);
          if (
            !current?.user ||
            current.account !== cfg.account ||
            current.user.id !== personId ||
            normalizeBaseUrl(current.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)
          )
            return { reason: "team_read_identity_unverified" };
          return { body };
        })
        .then(
          (value) => (signal.aborted ? stopped() : resolve(value)),
          () =>
            signal.aborted
              ? stopped()
              : resolve({ reason: "team_read_unavailable" }),
        );
    });
  } finally {
    clearTimeout(timer);
    remove();
  }
}

export async function readOnboardTeamInventory(
  ctx: Ctx,
  signal?: AbortSignal,
): Promise<{ teams: ExistingOnboardTeam[] } | { reason: string }> {
  const read = await readExistingOnboardJson(
    ctx,
    "/api/v1/agent/teams",
    signal,
  );
  if ("reason" in read) return read;
  const body = object(read.body);
  if (!body || !Array.isArray(body.teams) || body.teams.length > 1_000)
    return { reason: "team_inventory_shape" };
  const live = object(body.liveTeamRead);
  if (live?.error !== undefined && live.error !== null)
    return { reason: "team_read_unavailable" };
  const teams: ExistingOnboardTeam[] = [];
  const seen = new Set<string>();
  for (const value of body.teams) {
    const row = object(value);
    if (
      !row ||
      typeof row.teamId !== "string" ||
      !idPattern.test(row.teamId) ||
      seen.has(row.teamId) ||
      typeof row.teamKey !== "string" ||
      typeof row.teamName !== "string"
    )
      return { reason: "team_inventory_shape" };
    seen.add(row.teamId);
    teams.push({
      id: row.teamId,
      key: label(row.teamKey),
      name: label(row.teamName),
    });
  }
  return { teams };
}

interface TeamObservation {
  checkedAt: number;
  revision: number;
  checks: Map<string, string>;
}
async function observe(
  ctx: Ctx,
  id: string,
  signal?: AbortSignal,
): Promise<TeamObservation | null> {
  const read = await readExistingOnboardJson(
    ctx,
    `/api/v1/agent/tenant/readiness?team=${encodeURIComponent(id)}`,
    signal,
  );
  if ("reason" in read) return null;
  const row = object(object(read.body)?.readiness);
  // The GET owns expiry/revision freshness. Do not invent an expiresAt absent from its wire shape.
  if (
    !row ||
    row.teamId !== id ||
    typeof row.status !== "string" ||
    !["ready", "degraded", "blocked"].includes(row.status) ||
    typeof row.checkedAt !== "number" ||
    !Number.isFinite(row.checkedAt) ||
    row.checkedAt < 0 ||
    row.checkedAt > ctx.now().getTime() ||
    typeof row.workflowRev !== "number" ||
    !Number.isSafeInteger(row.workflowRev) ||
    row.workflowRev < 0 ||
    !Array.isArray(row.checks)
  )
    return null;
  const checks = new Map<string, string>();
  for (const value of row.checks) {
    const check = object(value);
    if (
      !check ||
      typeof check.id !== "string" ||
      checks.has(check.id) ||
      typeof check.state !== "string" ||
      !["pass", "fail", "unknown"].includes(check.state)
    )
      return null;
    checks.set(check.id, check.state);
  }
  return { checkedAt: row.checkedAt, revision: row.workflowRev, checks };
}

export function existingLinearAdapters(
  args: ParsedArgs,
  choose?: ChooseExistingTeam,
): Record<"linear.workspace" | "linear.team", OnboardAdapter> {
  let chosen: string | undefined;
  const requested = (teams: ExistingOnboardTeam[], journal: OnboardJournal) => {
    const explicit = args.flags.team;
    if (typeof explicit === "string") {
      const ids = teams.filter((team) => team.id === explicit);
      if (ids.length === 1) return ids[0];
      const keys = teams.filter((team) => team.key === explicit);
      return keys.length === 1 ? keys[0] : undefined;
    }
    const saved = chosen ?? selectedOnboardTeam(journal);
    return saved ? teams.find((team) => team.id === saved) : undefined;
  };
  const teamCheck: OnboardAdapter["check"] = async (ctx, journal, signal) => {
    const list = await readOnboardTeamInventory(ctx, signal);
    if ("reason" in list) return waiting(list.reason);
    if (!list.teams.length) return waiting("team_inventory_empty");
    const team = requested(list.teams, journal);
    if (!team) {
      if (typeof args.flags.team === "string")
        return waiting("team_selection_unverified");
      return choose ? { state: "pending" } : waiting("team_choice_required");
    }
    const result = await observe(ctx, team.id, signal);
    if (!result || result.checks.get("team_visible") !== "pass")
      return waiting("team_selection_unverified");
    return {
      state: "done",
      evidence: {
        team: team.id,
        teamKey: team.key,
        checkedAt: result.checkedAt,
        revision: result.revision,
      },
    };
  };
  return {
    "linear.workspace": {
      check: async (ctx, journal, signal) => {
        const list = await readOnboardTeamInventory(ctx, signal);
        if ("reason" in list) return waiting(list.reason);
        const candidate = requested(list.teams, journal) ?? list.teams[0];
        if (!candidate) return waiting("linear_workspace_unverified");
        const result = await observe(ctx, candidate.id, signal);
        return result?.checks.get("oauth_scope") === "pass" &&
          result.checks.get("token_live") === "pass"
          ? {
              state: "done",
              evidence: {
                checkedAt: result.checkedAt,
                revision: result.revision,
              },
            }
          : waiting("linear_workspace_unverified");
      },
      act: async () => waiting("cloud_capability_unavailable"),
    },
    "linear.team": {
      check: teamCheck,
      act: async (ctx, journal, signal) => {
        const list = await readOnboardTeamInventory(ctx, signal);
        if ("reason" in list) return waiting(list.reason);
        if (!list.teams.length) return waiting("team_inventory_empty");
        if (!choose) return waiting("team_choice_required");
        let remove = () => {};
        const answer = await new Promise<string | null>((resolve, reject) => {
          const stopped = () => resolve(null);
          if (signal?.aborted) {
            stopped();
            return;
          }
          signal?.addEventListener("abort", stopped, { once: true });
          remove = () => signal?.removeEventListener("abort", stopped);
          Promise.resolve()
            .then(() =>
              signal?.aborted
                ? null
                : choose(list.teams.map((team) => ({ ...team }))),
            )
            .then(resolve, reject);
        }).finally(() => remove());
        if (!answer || signal?.aborted) return waiting("interrupted");
        if (!list.teams.some((team) => team.id === answer))
          return waiting("team_selection_unverified");
        chosen = answer;
        return teamCheck(ctx, journal, signal);
      },
    },
  };
}
