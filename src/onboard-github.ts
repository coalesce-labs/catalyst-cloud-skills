import { finishOnTheWeb } from "./consent-browser.js";
import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";
import { pollConsent, type ConsentStatus } from "./onboard-consent.js";

const STATUS = "/api/v1/me/connections/github/workspace";
const HANDOFF = "/connect/github/workspace/handoff";
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const states = new Set([
  "connected",
  "missing-scope",
  "expired-or-revoked",
  "unreachable",
  "not-connected",
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

type Read = { status: number; body?: unknown } | { reason: string };
interface WorkspaceObservation {
  result: OnboardStepResult;
  unsupported?: boolean;
}
export interface GithubInstallationOptions {
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
  const personId = cfg.user.id;
  if (
    (journal.account ?? journal.tenant) !== cfg.account ||
    journal.membershipId !== cfg.user.id ||
    !journal.baseUrl ||
    normalizeBaseUrl(journal.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)
  )
    return { reason: "github_installation_identity_refused" };
  const expiry = cfg.auth
    ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime()
    : 0;
  const bearer =
    cfg.key ||
    (cfg.auth && Number.isFinite(expiry) && expiry > 30_000
      ? cfg.auth.accessToken
      : undefined);
  if (!bearer) return { reason: "github_installation_login_refresh_required" };
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
            : "github_installation_status_unavailable",
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
          const body: unknown = await response.json();
          const current = loadConfig(ctx.home);
          if (
            !current?.user ||
            current.account !== cfg.account ||
            current.user.id !== personId ||
            normalizeBaseUrl(current.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)
          )
            return { reason: "github_installation_identity_refused" };
          return { status: 200, body };
        })
        .then(
          (value) => (signal.aborted ? stopped() : resolve(value)),
          () =>
            signal.aborted
              ? stopped()
              : resolve({ reason: "github_installation_status_unavailable" }),
        );
    });
  } finally {
    clearTimeout(timer);
    remove();
  }
}

function readFailure(value: Read): OnboardStepResult | null {
  if ("reason" in value)
    return value.reason === "github_installation_identity_refused" ||
      value.reason === "personal_login_required"
      ? { state: "refused", reason: value.reason }
      : waiting(value.reason);
  if (value.status === 401 || value.status === 403)
    return { state: "refused", reason: "github_installation_consent_refused" };
  return value.status === 200
    ? null
    : waiting("github_installation_status_unavailable");
}

/** Every reported installation must have a fresh live installation/App-permission probe.
 * This proves installation connectivity, not access to repositories selected later in Q3. */
function observation(body: unknown, now: number): OnboardStepResult {
  const row = object(body);
  if (
    !row ||
    typeof row.connected !== "boolean" ||
    !Array.isArray(row.installations) ||
    !Array.isArray(row.pending) ||
    row.installations.length + row.pending.length > 100
  )
    return waiting("github_installation_status_shape");
  const ids: string[] = [];
  let unknown = false;
  let allConnected = row.installations.length > 0;
  let checkedAt = now + 30_000;
  for (const value of row.installations) {
    const item = object(value);
    const verification = object(item?.verification);
    if (
      !item ||
      typeof item.installationId !== "string" ||
      !idPattern.test(item.installationId) ||
      ids.includes(item.installationId) ||
      !nullableText(item.githubOrg) ||
      (typeof item.githubOrg === "string" &&
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(item.githubOrg)) ||
      !verification
    )
      return waiting("github_installation_status_shape");
    ids.push(item.installationId);
    if (
      verification.source === "none" &&
      verification.state === "not-run" &&
      verification.checkedAt === null
    ) {
      unknown = true;
      allConnected = false;
      continue;
    }
    if (
      verification.source !== "live-probe" ||
      typeof verification.state !== "string" ||
      !states.has(verification.state) ||
      typeof verification.checkedAt !== "number" ||
      !Number.isFinite(verification.checkedAt) ||
      verification.checkedAt < now - 120_000 ||
      verification.checkedAt > now + 30_000
    )
      return waiting("github_installation_status_shape");
    if (
      verification.missing !== undefined &&
      (!Array.isArray(verification.missing) ||
        verification.missing.length > 128 ||
        !verification.missing.every(
          (name) =>
            typeof name === "string" &&
            (/^[A-Za-z0-9_-]{1,128}$/.test(name) ||
              /^[A-Za-z0-9_-]{1,80} \((?:read|write|admin)\)$/.test(name)),
        ))
    )
      return waiting("github_installation_status_shape");
    checkedAt = Math.min(checkedAt, verification.checkedAt);
    if (verification.state === "unreachable") unknown = true;
    if (verification.state !== "connected") allConnected = false;
  }
  for (const value of row.pending) {
    const pending = object(value);
    if (
      !pending ||
      !nullableText(pending.githubOrg) ||
      (typeof pending.githubOrg === "string" &&
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(pending.githubOrg)) ||
      typeof pending.requestedAt !== "number" ||
      !Number.isFinite(pending.requestedAt) ||
      pending.requestedAt < 0
    )
      return waiting("github_installation_status_shape");
  }
  if (row.connected !== allConnected)
    return waiting("github_installation_status_shape");
  if (unknown) return waiting("github_installation_status_unavailable");
  if (!allConnected) return { state: "pending" };
  return {
    state: "done",
    evidence: {
      provider: "github",
      installation: JSON.stringify(ids),
      checkedAt,
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

/** Uses personal bearer App-install routes. Older clouds wait without a browser/session fallback. */
export function githubInstallationAdapter(
  options: GithubInstallationOptions,
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
    throw new Error("github_installation_timeout_invalid");
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
        return {
          state: "refused",
          reason: "github_installation_admin_required",
        };
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
        return {
          state: "refused",
          reason: "github_installation_consent_handoff",
        };
      if (signal?.aborted) return waiting("interrupted");
      const current = loadConfig(ctx.home);
      if (
        !current?.user ||
        current.account !== cfg.account ||
        current.user.id !== cfg.user.id ||
        normalizeBaseUrl(current.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)
      )
        return {
          state: "refused",
          reason: "github_installation_identity_refused",
        };
      if (!["owner", "admin"].includes(current.user.role))
        return {
          state: "refused",
          reason: "github_installation_admin_required",
        };
      ctx.stderr(
        "Approve the GitHub App installation in your browser. Your personal GitHub connection is checked separately.",
      );
      // The signed URL is transient credential material: only the browser receives it.
      let browserUnavailable = false;
      try {
        await options.openBrowser(url, signal);
      } catch {
        if (signal?.aborted) return waiting("interrupted");
        browserUnavailable = true;
        ctx.stderr(finishOnTheWeb(current.baseUrl, "connections", "install the GitHub App"));
      }
      let latest: OnboardStepResult = waiting(
        "github_installation_status_unavailable",
      );
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
        ? await options.wait("Waiting for GitHub App approval", run)
        : await run();
      if (result.state === "done") return latest;
      return browserUnavailable && result.reason === "consent_timeout"
        ? waiting("github_installation_browser_unavailable")
        : result;
    },
  };
}
