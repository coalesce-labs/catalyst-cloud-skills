import { finishOnTheWeb } from "./consent-browser.js";
import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";
import { pollConsent, type ConsentStatus } from "./onboard-consent.js";

const STATUS = "/api/v1/me/connections/linear/workspace";
const HANDOFF = "/connect/linear/workspace/handoff";
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const states = new Set([
  "connected",
  "missing-scope",
  "expired-or-revoked",
  "unreachable",
  "not-connected",
]);
const warmth = new Set([
  "warm",
  "absent",
  "expired",
  "renewal-due",
  "no-expiry",
  "unavailable",
]);
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const waiting = (reason: string): OnboardStepResult => ({
  state: "waiting",
  reason,
});
const nullableText = (v: unknown) => v === null || typeof v === "string";
const nullableTime = (v: unknown) =>
  v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

type Read = { status: number; body?: unknown } | { reason: string };
interface WorkspaceObservation {
  result: OnboardStepResult;
  unsupported?: boolean;
}
export interface WorkspaceAdapterOptions {
  fallback: OnboardAdapter;
  openBrowser: (url: string, signal?: AbortSignal) => void | Promise<void>;
  wait?: <T>(message: string, work: () => Promise<T>) => Promise<T>;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  consentTimeoutMs?: number;
}

/** A bounded read never rotates credentials or writes a token after the receipt lock is released. */
async function read(
  ctx: Ctx,
  journal: OnboardJournal,
  path: string,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<Read> {
  const cfg = loadConfig(ctx.home);
  if (!cfg?.user) return { reason: "personal_login_required" };
  if (
    ((journal.account ?? journal.tenant) &&
      (journal.account ?? journal.tenant) !== cfg.account) ||
    (journal.membershipId && journal.membershipId !== cfg.user.id) ||
    (journal.baseUrl &&
      normalizeBaseUrl(journal.baseUrl) !== normalizeBaseUrl(cfg.baseUrl))
  )
    return { reason: "workspace_identity_refused" };
  const expiry = cfg.auth
    ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime()
    : 0;
  const bearer =
    cfg.key ||
    (cfg.auth && Number.isFinite(expiry) && expiry > 30_000
      ? cfg.auth.accessToken
      : undefined);
  if (!bearer) return { reason: "workspace_login_refresh_required" };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = external
    ? AbortSignal.any([external, deadline.signal])
    : deadline.signal;
  let remove = () => {};
  try {
    return await new Promise<Read>((resolve) => {
      const stopped = () =>
        resolve({
          reason: external?.aborted
            ? "interrupted"
            : "workspace_status_unavailable",
        });
      if (signal.aborted) {
        stopped();
        return;
      }
      signal.addEventListener("abort", stopped, { once: true });
      remove = () => signal.removeEventListener("abort", stopped);
      Promise.resolve()
        .then(async (): Promise<Read> => {
          if (signal.aborted) return { reason: "interrupted" };
          const response = await ctx.fetch(
            `${normalizeBaseUrl(cfg.baseUrl)}${path}`,
            {
              method: "GET",
              redirect: "error",
              headers: {
                authorization: `Bearer ${bearer}`,
                accept: "application/json",
              },
              signal,
            },
          );
          // Refusal bodies and provider diagnostics are never parsed, returned or printed.
          if (response.status !== 200) return { status: response.status };
          return { status: 200, body: (await response.json()) as unknown };
        })
        .then(
          (value) => (signal.aborted ? stopped() : resolve(value)),
          () =>
            signal.aborted
              ? stopped()
              : resolve({ reason: "workspace_status_unavailable" }),
        );
    });
  } finally {
    clearTimeout(timer);
    remove();
  }
}

function readFailure(value: Read): OnboardStepResult | null {
  if ("reason" in value)
    return value.reason === "workspace_identity_refused" ||
      value.reason === "personal_login_required"
      ? { state: "refused", reason: value.reason }
      : waiting(value.reason);
  if (value.status === 401 || value.status === 403)
    return { state: "refused", reason: "workspace_consent_refused" };
  return value.status === 200 ? null : waiting("workspace_status_unavailable");
}

/** Live liveness plus stored grant scopes is a connection verdict, not live workspace identity. */
function observation(body: unknown, now: number): OnboardStepResult {
  const row = object(body);
  const workspace = object(row?.workspace);
  const credential = object(row?.credential);
  const verification = object(row?.verification);
  if (
    !row ||
    typeof row.connected !== "boolean" ||
    !workspace ||
    typeof workspace.bound !== "boolean" ||
    !nullableText(workspace.workspaceId) ||
    !nullableText(workspace.workspaceSlug) ||
    !nullableText(workspace.workspaceName) ||
    !credential ||
    ![true, false, null].includes(credential.stored as boolean | null) ||
    !nullableTime(credential.updatedAt) ||
    !nullableTime(credential.expiresAt) ||
    typeof credential.warmth !== "string" ||
    !warmth.has(credential.warmth) ||
    !verification
  )
    return waiting("workspace_status_shape");
  if (
    verification.source === "none" &&
    verification.state === "not-run" &&
    verification.checkedAt === null &&
    row.connected === false
  )
    return waiting("workspace_status_unavailable");
  if (
    verification.source !== "live-probe" ||
    typeof verification.state !== "string" ||
    !states.has(verification.state) ||
    typeof verification.checkedAt !== "number" ||
    !Number.isFinite(verification.checkedAt) ||
    verification.checkedAt < now - 120_000 ||
    verification.checkedAt > now + 30_000 ||
    row.connected !== (verification.state === "connected")
  )
    return waiting("workspace_status_shape");
  if (verification.state === "unreachable")
    return waiting("workspace_status_unavailable");
  if (!row.connected) return { state: "pending" };
  // A working credential alone cannot prove this account has a bound Linear workspace.
  if (
    !workspace.bound ||
    typeof workspace.workspaceId !== "string" ||
    !idPattern.test(workspace.workspaceId)
  )
    return waiting("linear_workspace_unverified");
  return {
    state: "done",
    evidence: {
      provider: "linear",
      workspace: workspace.workspaceId,
      checkedAt: verification.checkedAt,
    },
  };
}

function safeHandoff(body: unknown, ctx: Ctx): string | null {
  const row = object(body);
  const cfg = loadConfig(ctx.home);
  if (
    !cfg ||
    !row ||
    typeof row.authorizationUrl !== "string" ||
    row.authorizationUrl.length > 8192 ||
    /[\u0000-\u0020\u007f]/.test(row.authorizationUrl) ||
    typeof row.expiresAt !== "number" ||
    !Number.isFinite(row.expiresAt)
  )
    return null;
  const remaining = row.expiresAt - ctx.now().getTime();
  // Thirty seconds accommodates clock skew; an expired link is never launched.
  if (remaining <= 0 || remaining > 630_000) return null;
  try {
    const url = new URL(row.authorizationUrl);
    const keys = [...url.searchParams.keys()];
    const handoff = url.searchParams.get("handoff");
    if (
      url.protocol !== "https:" ||
      url.origin !== new URL(normalizeBaseUrl(cfg.baseUrl)).origin ||
      url.username ||
      url.password ||
      url.pathname !== HANDOFF ||
      url.hash ||
      keys.length !== 1 ||
      keys[0] !== "handoff" ||
      !handoff ||
      handoff.length > 4096 ||
      /[\s\u0000-\u001f\u007f]/.test(handoff)
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Uses personal bearer twins; missing routes wait without an ungated readiness fallback. */
export function linearWorkspaceAdapter(
  options: WorkspaceAdapterOptions,
): OnboardAdapter {
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const consentTimeoutMs = options.consentTimeoutMs ?? 600_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isSafeInteger(consentTimeoutMs) ||
    consentTimeoutMs < 1 ||
    consentTimeoutMs > 600_000
  )
    throw new Error("workspace_timeout_invalid");
  const inspect = async (
    ctx: Ctx,
    journal: OnboardJournal,
    signal?: AbortSignal,
  ): Promise<WorkspaceObservation> => {
    const result = await read(ctx, journal, STATUS, timeoutMs, signal);
    if ("status" in result && [404, 405].includes(result.status))
      return {
        result: waiting("cloud_capability_unavailable"),
        unsupported: true,
      };
    const failure = readFailure(result);
    return {
      result:
        failure ??
        observation(
          "body" in result ? result.body : undefined,
          ctx.now().getTime(),
        ),
    };
  };
  return {
    check: async (ctx, journal, signal) =>
      (await inspect(ctx, journal, signal)).result,
    act: async (ctx, journal, signal) => {
      const cfg = loadConfig(ctx.home);
      if (!cfg?.user || !["owner", "admin"].includes(cfg.user.role))
        return { state: "refused", reason: "workspace_admin_required" };
      if (signal?.aborted) return waiting("interrupted");
      const before = await inspect(ctx, journal, signal);
      if (before.result.state !== "pending") return before.result;
      if (before.unsupported) return waiting("cloud_capability_unavailable");
      const start = await read(
        ctx,
        journal,
        `${STATUS}/start`,
        timeoutMs,
        signal,
      );
      if ("status" in start && [404, 405].includes(start.status))
        return waiting("cloud_capability_unavailable");
      const failure = readFailure(start);
      if (failure) return failure;
      const url = safeHandoff("body" in start ? start.body : undefined, ctx);
      if (!url)
        return { state: "refused", reason: "workspace_consent_handoff" };
      if (signal?.aborted) return waiting("interrupted");
      const current = loadConfig(ctx.home);
      if (
        !current?.user ||
        current.account !== cfg.account ||
        current.user.id !== cfg.user.id ||
        normalizeBaseUrl(current.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)
      )
        return { state: "refused", reason: "workspace_identity_refused" };
      if (!["owner", "admin"].includes(current.user.role))
        return { state: "refused", reason: "workspace_admin_required" };
      ctx.stderr(
        "Approve the organization's Linear connection in your browser. Your personal approval follows.",
      );
      // The signed URL is transient credential material: only the browser receives it.
      let browserUnavailable = false;
      try {
        await options.openBrowser(url, signal);
      } catch {
        if (signal?.aborted) return waiting("interrupted");
        browserUnavailable = true;
        ctx.stderr(finishOnTheWeb(current.baseUrl, "connections", "connect Linear"));
      }
      let latest: OnboardStepResult = waiting("workspace_status_unavailable");
      const run = () =>
        pollConsent({
          timeoutMs: consentTimeoutMs,
          signal,
          sleep: options.sleep,
          readStatus: async (pollSignal) => {
            const value = await inspect(ctx, journal, pollSignal);
            latest = value.result;
            if (value.unsupported)
              return {
                outcome: "waiting",
                reason: "cloud_capability_unavailable",
              };
            if (latest.state === "done") return { outcome: "connected" };
            if (latest.state === "refused" || latest.state === "failed")
              return { outcome: latest.state, reason: latest.reason };
            return {
              outcome: latest.state === "pending" ? "absent" : "unavailable",
            } satisfies ConsentStatus;
          },
        });
      const result = options.wait
        ? await options.wait("Waiting for workspace approval", run)
        : await run();
      if (result.state === "done") return latest;
      return browserUnavailable && result.reason === "consent_timeout"
        ? waiting("workspace_browser_unavailable")
        : result;
    },
  };
}
