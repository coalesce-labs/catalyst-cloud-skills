import { finishOnTheWeb } from "./consent-browser.js";
import {
  loadConfig,
  normalizeBaseUrl,
  type Ctx,
  type CustomerConfig,
} from "./config.js";
import { pollConsent, type ConsentStatus } from "./onboard-consent.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";

type Provider = "linear" | "github";
type Read = { status: number; body?: unknown } | { reason: string };
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const waiting = (reason: string): OnboardStepResult => ({
  state: "waiting",
  reason,
});
const same = (a: CustomerConfig, b?: CustomerConfig | null) =>
  !!b?.user &&
  !!a.user &&
  a.account === b.account &&
  a.user.id === b.user.id &&
  normalizeBaseUrl(a.baseUrl) === normalizeBaseUrl(b.baseUrl);

export interface PersonalConsentOptions {
  provider: Provider;
  openBrowser: (url: string, signal?: AbortSignal) => void | Promise<void>;
  wait?: <T>(message: string, work: () => Promise<T>) => Promise<T>;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  consentTimeoutMs?: number;
}

/** Headers and body share an owned deadline; abandoned reads cannot rotate local credentials. */
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
    return { reason: "personal_identity_refused" };
  const expiry = cfg.auth
    ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime()
    : 0;
  const bearer =
    cfg.key ||
    (cfg.auth && Number.isFinite(expiry) && expiry > 30_000
      ? cfg.auth.accessToken
      : undefined);
  if (!bearer) return { reason: "personal_login_refresh_required" };
  const owned = new AbortController();
  const timer = setTimeout(() => owned.abort(), timeoutMs);
  const signal = external
    ? AbortSignal.any([external, owned.signal])
    : owned.signal;
  let remove = () => {};
  try {
    return await new Promise<Read>((resolve) => {
      const stopped = () =>
        resolve({
          reason: external?.aborted
            ? "interrupted"
            : "personal_status_unavailable",
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
          if (response.status !== 200) return { status: response.status };
          const body: unknown = await response.json();
          if (!same(cfg, loadConfig(ctx.home)))
            return { reason: "personal_identity_refused" };
          return { status: 200, body };
        })
        .then(
          (value) => (signal.aborted ? stopped() : resolve(value)),
          () =>
            signal.aborted
              ? stopped()
              : resolve({ reason: "personal_status_unavailable" }),
        );
    });
  } finally {
    clearTimeout(timer);
    remove();
  }
}

function failure(value: Read, start = false): OnboardStepResult | null {
  if ("reason" in value)
    return ["personal_login_required", "personal_identity_refused"].includes(
      value.reason,
    )
      ? { state: "refused", reason: value.reason }
      : waiting(value.reason);
  if (value.status === 401 || value.status === 403)
    return { state: "refused", reason: "personal_consent_refused" };
  if (value.status === 503) return waiting("personal_status_unavailable");
  if ([404, 405].includes(value.status))
    return waiting("cloud_capability_unavailable");
  return value.status === 200
    ? null
    : {
        state: "failed",
        reason: start
          ? "personal_consent_start_failed"
          : "personal_status_failed",
      };
}

function handoff(
  body: unknown,
  provider: Provider,
  cfg: CustomerConfig,
  now: number,
): string | null {
  const row = object(body);
  if (
    !row ||
    typeof row.authorizationUrl !== "string" ||
    row.authorizationUrl.length > 8192 ||
    /[\u0000-\u0020\u007f]/.test(row.authorizationUrl) ||
    typeof row.expiresAt !== "number" ||
    !Number.isFinite(row.expiresAt) ||
    row.expiresAt <= now ||
    row.expiresAt > now + 630_000
  )
    return null;
  try {
    const url = new URL(row.authorizationUrl);
    const keys = [...url.searchParams.keys()];
    const token = url.searchParams.get("handoff");
    if (
      url.protocol !== "https:" ||
      url.origin !== new URL(normalizeBaseUrl(cfg.baseUrl)).origin ||
      url.username ||
      url.password ||
      url.pathname !== `/connect/${provider}/personal/start` ||
      url.hash ||
      keys.length !== 1 ||
      keys[0] !== "handoff" ||
      !token ||
      token.length > 4096 ||
      /[\s\u0000-\u001f\u007f]/.test(token)
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The supported personal status reports server-resolved grant availability. A warm grant is
 * not a new provider viewer probe, repository authorization, or workspace installation verdict. */
export function personalConsentAdapter(
  options: PersonalConsentOptions,
): OnboardAdapter {
  const timeout = options.requestTimeoutMs ?? 30_000;
  const consentTimeout = options.consentTimeoutMs ?? 600_000;
  if (
    !["linear", "github"].includes(options.provider) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 30_000 ||
    !Number.isSafeInteger(consentTimeout) ||
    consentTimeout < 1 ||
    consentTimeout > 600_000
  )
    throw new Error("personal_timeout_invalid");
  const statusPath = `/api/v1/me/connections/${options.provider}/personal`;
  const inspect = async (
    ctx: Ctx,
    journal: OnboardJournal,
    signal?: AbortSignal,
  ): Promise<OnboardStepResult> => {
    const response = await read(ctx, journal, statusPath, timeout, signal);
    const failed = failure(response);
    if (failed) return failed;
    const body = object("body" in response ? response.body : undefined);
    if (
      !body ||
      typeof body.connected !== "boolean" ||
      (body.reason !== undefined &&
        (body.connected || body.reason !== "lapsed"))
    )
      return { state: "failed", reason: "personal_status_shape" };
    return body.connected
      ? {
          state: "done",
          evidence: {
            provider: options.provider,
            checkedAt: ctx.now().getTime(),
          },
        }
      : { state: "pending" };
  };
  return {
    check: inspect,
    act: async (ctx, journal, signal) => {
      if (signal?.aborted) return waiting("interrupted");
      const cfg = loadConfig(ctx.home);
      if (!cfg?.user)
        return { state: "refused", reason: "personal_login_required" };
      const before = await inspect(ctx, journal, signal);
      if (before.state !== "pending") return before;
      const start = await read(
        ctx,
        journal,
        `/connect/${options.provider}/personal/start`,
        timeout,
        signal,
      );
      if (
        "status" in start &&
        start.status === 409 &&
        options.provider === "linear"
      )
        return waiting("linear_workspace_required");
      const failed = failure(start, true);
      if (failed) return failed;
      const url = handoff(
        "body" in start ? start.body : undefined,
        options.provider,
        cfg,
        ctx.now().getTime(),
      );
      if (!url) return { state: "refused", reason: "personal_consent_handoff" };
      if (signal?.aborted) return waiting("interrupted");
      if (!same(cfg, loadConfig(ctx.home)))
        return { state: "refused", reason: "personal_identity_refused" };
      const name = options.provider === "linear" ? "Linear" : "GitHub";
      ctx.stderr(`Approve your personal ${name} connection in the browser.`);
      // Signed continuation credentials belong only to the browser, never transcript or journal.
      let browserUnavailable = false;
      try {
        await options.openBrowser(url, signal);
      } catch {
        if (signal?.aborted) return waiting("interrupted");
        browserUnavailable = true;
        ctx.stderr(finishOnTheWeb(cfg.baseUrl, "connected-accounts", `connect your ${name} account`));
      }
      let latest: OnboardStepResult = waiting("personal_status_unavailable");
      const run = () =>
        pollConsent({
          timeoutMs: consentTimeout,
          signal,
          sleep: options.sleep,
          readStatus: async (pollSignal) => {
            latest = await inspect(ctx, journal, pollSignal);
            if (latest.reason === "cloud_capability_unavailable")
              return { outcome: "waiting", reason: latest.reason };
            if (latest.reason === "personal_login_refresh_required")
              return { outcome: "waiting", reason: latest.reason };
            if (latest.state === "done") return { outcome: "connected" };
            if (latest.state === "refused" || latest.state === "failed")
              return { outcome: latest.state, reason: latest.reason };
            return {
              outcome: latest.state === "pending" ? "absent" : "unavailable",
            } satisfies ConsentStatus;
          },
        });
      const result = options.wait
        ? await options.wait(`Waiting for your ${name} approval`, run)
        : await run();
      if (result.state === "done") return latest;
      return browserUnavailable && result.reason === "consent_timeout"
        ? waiting("personal_browser_unavailable")
        : result;
    },
  };
}
