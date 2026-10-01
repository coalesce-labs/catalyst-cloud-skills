import {
  loadConfig,
  normalizeBaseUrl,
  readManifest,
  type Ctx,
} from "./config.js";
import { contractVersionInRange } from "./contract.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";

export interface OnboardRouteRequirement {
  method: "GET" | "POST";
  path: string;
}
export interface OnboardCapabilityOptions {
  check: readonly OnboardRouteRequirement[];
  act?: readonly OnboardRouteRequirement[];
  fallback: "connections" | "personalConnections";
  message?: (text: string) => void;
  requestTimeoutMs?: number;
}
type Capabilities = {
  routes: Set<string>;
  web: { connections: string; personalConnections: string };
};
type CapabilityRead =
  | { capabilities: Capabilities; origin: string }
  | { reason: string; origin?: string };
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const safePages = {
  connections: "/a/account/connections",
  personalConnections: "/settings/connected-accounts",
} as const;
const routeKey = (route: OnboardRouteRequirement) =>
  `${route.method} ${route.path}`;
const waiting = (reason: string, path?: string): OnboardStepResult => ({
  state: "waiting",
  reason,
  ...(path ? { evidence: { path } } : {}),
});

/** Fresh contract advertisement proves route availability, never consent or resource readiness.
 * No cache, token refresh or local write may create a stale positive capability. */
async function read(
  ctx: Ctx,
  journal: OnboardJournal,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<CapabilityRead> {
  if (external?.aborted) return { reason: "interrupted" };
  const cfg = loadConfig(ctx.home);
  if (!cfg?.user) return { reason: "personal_login_required" };
  const personId = cfg.user.id;
  if (
    (journal.account ?? journal.tenant) !== cfg.account ||
    journal.membershipId !== cfg.user.id ||
    !journal.baseUrl ||
    normalizeBaseUrl(journal.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)
  )
    return { reason: "onboarding_capability_identity_unverified" };
  let origin: string;
  try {
    const url = new URL(cfg.baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error();
    origin = url.origin;
  } catch {
    return { reason: "onboarding_capability_identity_unverified" };
  }
  const expiry = cfg.auth
    ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime()
    : 0;
  const bearer =
    cfg.key ||
    (cfg.auth && Number.isFinite(expiry) && expiry > 30_000
      ? cfg.auth.accessToken
      : undefined);
  if (!bearer)
    return { reason: "onboarding_capability_login_refresh_required", origin };
  const owned = new AbortController();
  const signal = external
    ? AbortSignal.any([external, owned.signal])
    : owned.signal;
  const timer = setTimeout(() => owned.abort(), timeoutMs);
  let remove = () => {};
  try {
    return await new Promise<CapabilityRead>((resolve) => {
      const stopped = () =>
        resolve({
          reason: external?.aborted
            ? "interrupted"
            : "onboarding_capability_unavailable",
          origin,
        });
      if (signal.aborted) {
        stopped();
        return;
      }
      signal.addEventListener("abort", stopped, { once: true });
      remove = () => signal.removeEventListener("abort", stopped);
      Promise.resolve()
        .then(async (): Promise<CapabilityRead> => {
          if (signal.aborted) return { reason: "interrupted", origin };
          const response = await ctx.fetch(`${origin}/api/v1/agent/contract`, {
            method: "GET",
            redirect: "error",
            signal,
            headers: {
              authorization: `Bearer ${bearer}`,
              accept: "application/json",
              "cache-control": "no-cache",
            },
          });
          if (response.status !== 200)
            return { reason: "onboarding_capability_unavailable", origin };
          const body = object(await response.json());
          const current = loadConfig(ctx.home);
          if (
            !current?.user ||
            current.account !== cfg.account ||
            current.user.id !== personId ||
            normalizeBaseUrl(current.baseUrl) !== origin ||
            object(body?.account)?.id !== cfg.account
          )
            return {
              reason: "onboarding_capability_identity_unverified",
              origin,
            };
          if (
            !body ||
            typeof body.contractVersion !== "string" ||
            contractVersionInRange(
              body.contractVersion,
              readManifest().tenantContractRange,
            ) !== true
          )
            return { reason: "onboarding_capability_unavailable", origin };
          const advertised = object(body.onboarding),
            web = object(advertised?.web);
          if (!advertised)
            return { reason: "cloud_capability_unavailable", origin };
          if (
            advertised.schema !== 1 ||
            !Array.isArray(advertised.routes) ||
            advertised.routes.length > 100 ||
            !web ||
            web.connections !== safePages.connections ||
            web.personalConnections !== safePages.personalConnections
          )
            return { reason: "onboarding_capability_unavailable", origin };
          const routes = new Set<string>();
          for (const value of advertised.routes) {
            const row = object(value);
            if (
              !row ||
              !["GET", "POST"].includes(row.method as string) ||
              typeof row.path !== "string" ||
              row.path.length > 240 ||
              !/^\/(?:api\/v1\/|connect\/|me\/)[A-Za-z0-9_/-]+$/.test(
                row.path,
              ) ||
              row.personalBearer !== true
            )
              return { reason: "onboarding_capability_unavailable", origin };
            const key = `${row.method} ${row.path}`;
            if (routes.has(key))
              return { reason: "onboarding_capability_unavailable", origin };
            routes.add(key);
          }
          return { capabilities: { routes, web: { ...safePages } }, origin };
        })
        .then(
          (result) => (signal.aborted ? stopped() : resolve(result)),
          () =>
            signal.aborted
              ? stopped()
              : resolve({
                  reason: "onboarding_capability_unavailable",
                  origin,
                }),
        );
    });
  } finally {
    clearTimeout(timer);
    remove();
  }
}

/** Guard both the observation and action before their first endpoint request. A route's real
 * refusal is preserved only after the same-account cloud advertised personal bearer support. */
export function guardOnboardCapabilities(
  adapter: OnboardAdapter,
  options: OnboardCapabilityOptions,
): OnboardAdapter {
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error("onboarding_capability_timeout_invalid");
  const run = async (
    ctx: Ctx,
    journal: OnboardJournal,
    signal: AbortSignal | undefined,
    requirements: readonly OnboardRouteRequirement[],
    work: () => Promise<OnboardStepResult>,
  ) => {
    const advertised = await read(ctx, journal, timeoutMs, signal);
    if (
      "reason" in advertised ||
      requirements.some(
        (route) => !advertised.capabilities.routes.has(routeKey(route)),
      )
    ) {
      const reason =
        "reason" in advertised
          ? advertised.reason
          : "cloud_capability_unavailable";
      const url = advertised.origin
        ? `${advertised.origin}${safePages[options.fallback]}`
        : undefined;
      if (reason === "cloud_capability_unavailable" && url)
        options.message?.(
          `This setup step is not available on this server yet. Continue in the web app: ${url}`,
        );
      return waiting(
        reason,
        reason === "cloud_capability_unavailable" ? url : undefined,
      );
    }
    if (signal?.aborted) return waiting("interrupted");
    return work();
  };
  return {
    check: (ctx, journal, signal) =>
      run(ctx, journal, signal, options.check, () =>
        adapter.check(ctx, journal, signal),
      ),
    ...(adapter.act
      ? {
          act: (ctx: Ctx, journal: OnboardJournal, signal?: AbortSignal) =>
            run(ctx, journal, signal, options.act ?? options.check, () =>
              adapter.act!(ctx, journal, signal),
            ),
        }
      : {}),
  };
}
