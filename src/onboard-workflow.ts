import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { configPathFor, loadConfig, normalizeBaseUrl } from "./config.js";
import { verifyOnboardRoutes } from "./onboard-capabilities.js";
import { selectedOnboardTeam } from "./onboard-existing.js";
import type { OnboardAdapter, OnboardStepResult } from "./onboard.js";
import { ownedFetch } from "./owned-fetch.js";
import { loadHttpSdk } from "./sdk.js";
import { fetchMe } from "./transport.js";

const path = "/api/v1/agent/team-workflow";
const slots = [
  "dispatch",
  "intake",
  "research",
  "plan",
  "implement",
  "remediate",
  "verify",
  "review",
  "pr",
  "done",
  "canceled",
] as const;
const requiredTypes = {
  dispatch: ["unstarted", "backlog"],
  intake: ["unstarted", "backlog"],
  pr: ["started"],
  done: ["completed"],
  canceled: ["canceled"],
} as const;
const waiting = (reason: string): OnboardStepResult => ({
  state: "waiting",
  reason,
});
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
interface WorkflowObservation {
  mappingHash: string;
  mappingRevision: number;
  readinessRevision: number;
  checkedAt: number;
  mappedSlots: number;
}

/** Existing mappings can satisfy this step by observation. This never means a preview was applied. */
export function observeOnboardWorkflow(
  value: unknown,
  team: string,
  now: number,
): WorkflowObservation | null {
  const row = object(value),
    config = object(row?.config),
    readiness = object(row?.readiness);
  if (
    !row ||
    !config ||
    !readiness ||
    config.teamId !== team ||
    readiness.teamId !== team ||
    typeof config.mode !== "string" ||
    !["mapped-existing", "adopted-recommended", "mixed"].includes(
      config.mode,
    ) ||
    (config.gitAutomation !== "off" && config.gitAutomation !== "managed") ||
    !integer(config.workflowRev) ||
    !integer(readiness.workflowRev) ||
    typeof readiness.status !== "string" ||
    !["ready", "degraded", "blocked"].includes(readiness.status) ||
    !integer(readiness.checkedAt) ||
    readiness.checkedAt > now ||
    now - readiness.checkedAt >= 300_000 ||
    (row.stageSource !== "linear" && row.stageSource !== "mirror") ||
    typeof row.mappingHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.mappingHash) ||
    !Array.isArray(row.rows) ||
    row.rows.length > slots.length ||
    !Array.isArray(row.stages) ||
    row.stages.length > 1_000 ||
    !Array.isArray(readiness.checks) ||
    readiness.checks.length > 100
  )
    return null;
  const stages = new Map<string, string>();
  for (const candidate of row.stages) {
    const stage = object(candidate);
    if (
      !stage ||
      !id(stage.id) ||
      stages.has(stage.id) ||
      typeof stage.type !== "string" ||
      ![
        "triage",
        "backlog",
        "unstarted",
        "started",
        "completed",
        "canceled",
      ].includes(stage.type)
    )
      return null;
    stages.set(stage.id, stage.type);
  }
  const mapping = new Map<string, string | null>();
  for (const candidate of row.rows) {
    const item = object(candidate);
    if (
      !item ||
      typeof item.slot !== "string" ||
      !(slots as readonly string[]).includes(item.slot) ||
      mapping.has(item.slot) ||
      (item.linearStateId !== null && !id(item.linearStateId)) ||
      (item.source !== undefined &&
        item.source !== "created" &&
        item.source !== "matched" &&
        item.source !== "chosen") ||
      (item.linearStateId !== null &&
        (item.stateStillExists !== true || !stages.has(item.linearStateId)))
    )
      return null;
    mapping.set(item.slot, item.linearStateId);
  }
  for (const [slot, types] of Object.entries(requiredTypes)) {
    const target = mapping.get(slot);
    if (
      !target ||
      !(types as readonly string[]).includes(stages.get(target) ?? "")
    )
      return null;
  }
  const checks = new Map<string, string>();
  for (const candidate of readiness.checks) {
    const check = object(candidate);
    if (
      !check ||
      typeof check.id !== "string" ||
      checks.has(check.id) ||
      (check.state !== "pass" &&
        check.state !== "fail" &&
        check.state !== "unknown")
    )
      return null;
    checks.set(check.id, check.state);
  }
  // Adoption does not establish coding accounts, automation rule safety or first-ticket readiness.
  if (
    [
      "team_visible",
      "mapped_states_exist",
      "mapping_total",
      "types_compatible",
      "labels_present",
    ].some((check) => checks.get(check) !== "pass")
  )
    return null;
  return {
    mappingHash: row.mappingHash,
    mappingRevision: config.workflowRev,
    readinessRevision: readiness.workflowRev,
    checkedAt: readiness.checkedAt,
    mappedSlots: [...mapping.values()].filter((value) => value !== null).length,
  };
}

/** HTTP only, without rotating credentials or calling adopt/apply. Every entered fetch/body joins. */
export function onboardWorkflowVerificationAdapter(
  input: { message?: (text: string) => void } = {},
): OnboardAdapter {
  return {
    check: async (ctx, journal, external) => {
      let cfg: ReturnType<typeof loadConfig>;
      try {
        cfg = loadConfig(ctx.home);
      } catch {
        return waiting("workflow_identity_unverified");
      }
      const team = selectedOnboardTeam(journal);
      if (
        !team ||
        !cfg?.user ||
        (cfg.user.role !== "owner" && cfg.user.role !== "admin") ||
        cfg.account !== (journal.account ?? journal.tenant) ||
        cfg.user.id !== journal.membershipId ||
        !journal.baseUrl ||
        normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(journal.baseUrl)
      )
        return waiting("workflow_identity_unverified");
      const origin = normalizeBaseUrl(cfg.baseUrl),
        person = cfg.user.id,
        role = cfg.user.role;
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        return waiting("workflow_identity_unverified");
      }
      if (
        url.protocol !== "https:" ||
        url.origin !== origin ||
        url.username ||
        url.password
      )
        return waiting("workflow_identity_unverified");
      const credential =
        cfg.key ||
        (cfg.auth &&
        Date.parse(cfg.auth.expiresAt) - ctx.now().getTime() > 30_000
          ? cfg.auth.accessToken
          : undefined);
      if (!credential) return waiting("workflow_login_refresh_required");
      const configWitness = () =>
        createHash("sha256")
          .update(readFileSync(configPathFor(ctx.home)))
          .digest("hex");
      let before: string;
      try {
        before = configWitness();
      } catch {
        return waiting("workflow_identity_unverified");
      }
      const current = () => {
        try {
          const now = loadConfig(ctx.home);
          return (
            now?.user?.id === person &&
            now.user.role === role &&
            now.account === cfg.account &&
            normalizeBaseUrl(now.baseUrl) === origin &&
            configWitness() === before &&
            selectedOnboardTeam(journal) === team &&
            (!!cfg.key ||
              (!!cfg.auth &&
                Date.parse(cfg.auth.expiresAt) > ctx.now().getTime()))
          );
        } catch {
          return false;
        }
      };
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 30_000);
      const signal = external
        ? AbortSignal.any([external, deadline.signal])
        : deadline.signal;
      const owned = ownedFetch(ctx.fetch, signal, { maxBodyBytes: 524_288 });
      const read: typeof fetch = (request, init) => {
        if (!current() || signal.aborted)
          return Promise.reject(new Error("workflow_read_stopped"));
        const requested = new URL(
          request instanceof Request ? request.url : String(request),
        );
        const method =
          init?.method ?? (request instanceof Request ? request.method : "GET");
        if (
          method !== "GET" ||
          requested.origin !== origin ||
          requested.username ||
          requested.password ||
          requested.hash ||
          !["/api/v1/me", "/api/v1/agent/contract", path].includes(
            requested.pathname,
          ) ||
          (requested.pathname === path
            ? requested.search !== `?team=${encodeURIComponent(team)}`
            : requested.search !== "")
        )
          return Promise.reject(new Error("workflow_read_scope"));
        return owned.fetch(request, { ...init, signal, redirect: "error" });
      };
      const live = async () => {
        const me = await fetchMe(origin, credential, read);
        return (
          current() &&
          !signal.aborted &&
          me.account === cfg.account &&
          me.user?.id === person &&
          me.user.role === role
        );
      };
      const result = await (async (): Promise<OnboardStepResult> => {
        try {
          if (!(await live())) return waiting("workflow_identity_unverified");
          const support = await verifyOnboardRoutes(
            { ...ctx, fetch: read },
            journal,
            [{ method: "GET", path }],
            signal,
          );
          if ("reason" in support) return waiting(support.reason);
          if (!current() || signal.aborted)
            return waiting("workflow_identity_unverified");
          const sdk = await loadHttpSdk();
          if (!current() || signal.aborted)
            return waiting("workflow_identity_unverified");
          const client = sdk.createTenantClient({
            baseUrl: origin,
            key: credential,
            fetch: read,
            timeoutMs: 30_000,
            now: () => ctx.now().getTime(),
          });
          const first = await client.teamWorkflow.get(team);
          const observed =
            first.outcome === "ok"
              ? observeOnboardWorkflow(first, team, ctx.now().getTime())
              : null;
          if (!observed || !current() || signal.aborted) {
            input.message?.(
              "Workflow adoption is waiting for a verified mapping or full-plan server support. Setup made no workflow change.",
            );
            return waiting("workflow_mapping_unverified");
          }
          if (!(await live())) return waiting("workflow_identity_unverified");
          const last = await client.teamWorkflow.get(team);
          const verified =
            last.outcome === "ok"
              ? observeOnboardWorkflow(last, team, ctx.now().getTime())
              : null;
          if (
            !verified ||
            verified.mappingHash !== observed.mappingHash ||
            verified.mappingRevision !== observed.mappingRevision ||
            verified.readinessRevision !== observed.readinessRevision ||
            !current() ||
            signal.aborted
          )
            return waiting("workflow_mapping_changed");
          if (!(await live())) return waiting("workflow_identity_unverified");
          if (!current() || signal.aborted)
            return waiting("workflow_identity_unverified");
          return {
            state: "done",
            evidence: {
              team,
              revision: verified.readinessRevision,
              mappingRevision: verified.mappingRevision,
              checkedAt: verified.checkedAt,
              mappingHash: verified.mappingHash,
              count: verified.mappedSlots,
            },
          };
        } catch {
          return waiting(
            external?.aborted ? "interrupted" : "workflow_unavailable",
          );
        } finally {
          try {
            owned.abort(new Error("workflow_read_complete"));
            await owned.settle();
          } finally {
            clearTimeout(timer);
          }
        }
      })();
      if (!current()) return waiting("workflow_identity_unverified");
      if (signal.aborted)
        return waiting(
          external?.aborted ? "interrupted" : "workflow_unavailable",
        );
      if (result.state === "done") {
        input.message?.(
          "The selected team's existing workflow mapping and labels are verified. Setup made no workflow change.",
        );
        if (!current() || signal.aborted)
          return waiting("workflow_identity_unverified");
      }
      return result;
    },
  };
}
