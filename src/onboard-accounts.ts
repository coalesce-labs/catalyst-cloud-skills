import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import { readExistingOnboardJson } from "./onboard-existing.js";
import { pollConsent } from "./onboard-consent.js";
import { verifyOnboardRoutes } from "./onboard-capabilities.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";

const listPath = "/api/v1/coding-accounts";
const validatePath = "/api/v1/coding-accounts/:slot/validate";
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const waiting = (reason: string): OnboardStepResult => ({
  state: "waiting",
  reason,
});
const slotPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
interface Slot {
  accountSlot: string;
  provider: string;
  declaredState: string;
  ownedByMe: boolean;
  needsCredential: boolean;
  walled: boolean;
  quarantined: boolean;
  renewalStatus: "renews" | "canceled" | null;
  revokedAtMs: number | null;
  accessEndsAtMs: number | null;
}
interface Binding {
  account: string;
  person: string;
  origin: string;
  role: string;
}
interface Proof extends Binding {
  slot: string;
  checkedAtMs: number;
  provider: string;
}
function binding(ctx: Ctx, journal: OnboardJournal): Binding | null {
  const cfg = loadConfig(ctx.home);
  if (
    !cfg?.user ||
    cfg.account !== (journal.account ?? journal.tenant) ||
    cfg.user.id !== journal.membershipId ||
    !journal.baseUrl ||
    normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(journal.baseUrl)
  )
    return null;
  return {
    account: cfg.account,
    person: cfg.user.id,
    origin: normalizeBaseUrl(cfg.baseUrl),
    role: cfg.user.role,
  };
}
const equal = (a: Binding | null, b: Binding) =>
  a?.account === b.account &&
  a.person === b.person &&
  a.origin === b.origin &&
  a.role === b.role;
async function inventory(
  ctx: Ctx,
  journal: OnboardJournal,
  signal?: AbortSignal,
): Promise<
  | {
      slots: Slot[];
      identity: Binding;
    }
  | { reason: string }
> {
  const identity = binding(ctx, journal);
  if (!identity) return { reason: "account_identity_unverified" };
  const support = await verifyOnboardRoutes(
    ctx,
    journal,
    [{ method: "GET", path: listPath }],
    signal,
  );
  if ("reason" in support) return support;
  if (!equal(binding(ctx, journal), identity))
    return { reason: "account_identity_unverified" };
  const read = await readExistingOnboardJson(ctx, listPath, signal);
  if (!equal(binding(ctx, journal), identity))
    return { reason: "account_identity_unverified" };
  if ("reason" in read) return { reason: "account_inventory_unavailable" };
  const body = object(read.body);
  const now = ctx.now().getTime();
  if (
    !Array.isArray(body?.accounts) ||
    body.accounts.length > 1000 ||
    typeof body.observedAtMs !== "number" ||
    !Number.isSafeInteger(body.observedAtMs) ||
    body.observedAtMs > now + 5000 ||
    body.observedAtMs < now - 30000
  )
    return { reason: "account_inventory_unverified" };
  const slots: Slot[] = [],
    seen = new Set<string>();
  for (const value of body.accounts) {
    const row = object(value);
    if (
      !row ||
      typeof row.accountSlot !== "string" ||
      !slotPattern.test(row.accountSlot) ||
      seen.has(row.accountSlot) ||
      typeof row.provider !== "string" ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(row.provider) ||
      typeof row.declaredState !== "string" ||
      !["active", "inactive"].includes(row.declaredState) ||
      typeof row.ownedByMe !== "boolean" ||
      typeof row.needsCredential !== "boolean" ||
      typeof row.walled !== "boolean" ||
      typeof row.quarantined !== "boolean" ||
      ![null, "renews", "canceled"].includes(
        row.renewalStatus as null | string,
      ) ||
      !(
        row.revokedAtMs === null ||
        (typeof row.revokedAtMs === "number" &&
          Number.isSafeInteger(row.revokedAtMs))
      ) ||
      !(
        row.accessEndsAtMs === null ||
        (typeof row.accessEndsAtMs === "number" &&
          Number.isSafeInteger(row.accessEndsAtMs))
      )
    )
      return { reason: "account_inventory_unverified" };
    seen.add(row.accountSlot);
    // Project only metadata we need. Unknown server fields never enter output or receipts.
    slots.push({
      accountSlot: row.accountSlot,
      provider: row.provider,
      declaredState: row.declaredState,
      ownedByMe: row.ownedByMe,
      needsCredential: row.needsCredential,
      walled: row.walled,
      quarantined: row.quarantined,
      renewalStatus: row.renewalStatus as "renews" | "canceled" | null,
      revokedAtMs: row.revokedAtMs as number | null,
      accessEndsAtMs: row.accessEndsAtMs as number | null,
    });
  }
  return { slots, identity };
}

/** Verify one existing Claude slot per run. A stored login, cached poll or Codex shape is not
 * fresh provider access. Enrollment and a phase's actual lease eligibility remain separate. */
export function onboardAccountsAdapter(
  input: {
    message?: (text: string) => void;
    waitForAccount?: <T>(work: () => Promise<T>) => Promise<T>;
    accountWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): OnboardAdapter {
  let proof: Proof | null = null;
  let attempted = false;
  const candidate = (slots: Slot[], now: number) =>
    slots
      .filter(
        (row) =>
          row.provider === "claude" &&
          row.declaredState === "active" &&
          row.ownedByMe &&
          !row.needsCredential &&
          !row.walled &&
          !row.quarantined &&
          row.renewalStatus !== "canceled" &&
          row.revokedAtMs === null &&
          (row.accessEndsAtMs === null || row.accessEndsAtMs > now),
      )
      .sort((a, b) => a.accountSlot.localeCompare(b.accountSlot))[0];
  const check: OnboardAdapter["check"] = async (ctx, journal, signal) => {
    const live = await inventory(ctx, journal, signal);
    if ("reason" in live) return waiting(live.reason);
    const selected = candidate(live.slots, ctx.now().getTime());
    if (
      proof &&
      equal(live.identity, proof) &&
      live.slots.some(
        (row) =>
          row.accountSlot === proof!.slot &&
          row.provider === proof!.provider &&
          row.declaredState === "active" &&
          row.ownedByMe &&
          !row.needsCredential &&
          !row.walled &&
          !row.quarantined &&
          row.renewalStatus !== "canceled" &&
          row.revokedAtMs === null &&
          (row.accessEndsAtMs === null ||
            row.accessEndsAtMs > ctx.now().getTime()),
      ) &&
      proof.checkedAtMs <= ctx.now().getTime() + 5000 &&
      proof.checkedAtMs >= ctx.now().getTime() - 30000
    )
      return {
        state: "done",
        evidence: {
          accountSlot: proof.slot,
          provider: proof.provider,
          checkedAt: new Date(proof.checkedAtMs).toISOString(),
        },
      };
    proof = null;
    if (!live.slots.length)
      return input.waitForAccount &&
        ["owner", "admin"].includes(live.identity.role)
        ? { state: "pending" }
        : waiting("account_enrollment_required");
    if (!selected)
      return waiting(
        live.slots.some((row) => row.provider === "codex")
          ? "codex_provider_access_unverified"
          : "account_provider_access_unverified",
      );
    if (attempted) return waiting("account_provider_access_unverified");
    const cfg = loadConfig(ctx.home);
    if (!cfg?.user || !["owner", "admin"].includes(cfg.user.role))
      return waiting("account_validation_admin_required");
    return { state: "pending" };
  };
  return {
    check,
    act: async (ctx, journal, external) => {
      if (attempted) return waiting("account_provider_access_unverified");
      const initial = await inventory(ctx, journal, external);
      if ("reason" in initial) return waiting(initial.reason);
      let live = initial;
      if (
        !live.slots.length &&
        input.waitForAccount &&
        ["owner", "admin"].includes(live.identity.role)
      ) {
        const result = await input.waitForAccount(() =>
          pollConsent({
            timeoutMs: input.accountWaitMs,
            signal: external,
            sleep: input.sleep,
            readStatus: async (signal) => {
              const current = await inventory(ctx, journal, signal);
              if ("reason" in current)
                return { outcome: "waiting", reason: current.reason };
              live = current;
              return { outcome: current.slots.length ? "connected" : "absent" };
            },
          }),
        );
        if (result.state !== "done")
          return waiting(
            result.reason === "consent_timeout"
              ? "account_enrollment_required"
              : (result.reason ?? "account_enrollment_required"),
          );
      }
      const selected = candidate(live.slots, ctx.now().getTime());
      if (!selected) return waiting("account_provider_access_unverified");
      const support = await verifyOnboardRoutes(
        ctx,
        journal,
        [{ method: "POST", path: validatePath }],
        external,
      );
      if ("reason" in support) return waiting(support.reason);
      const cfg = loadConfig(ctx.home);
      if (
        !equal(binding(ctx, journal), live.identity) ||
        !cfg?.user ||
        !["owner", "admin"].includes(cfg.user.role)
      )
        return waiting("account_identity_unverified");
      const expiry = cfg.auth
        ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime()
        : 0;
      const bearer =
        cfg.key ||
        (cfg.auth && Number.isFinite(expiry) && expiry > 30000
          ? cfg.auth.accessToken
          : undefined);
      if (!bearer) return waiting("account_login_refresh_required");
      input.message?.(
        "Checking one stored Claude account with a one-token provider request. This may use Claude quota. Codex credentials are not refreshed. Phase eligibility is checked separately.",
      );
      // A display callback must not be able to switch the identity used for this request.
      if (!equal(binding(ctx, journal), live.identity))
        return waiting("account_identity_unverified");
      const deadline = new AbortController();
      const signal = external
        ? AbortSignal.any([external, deadline.signal])
        : deadline.signal;
      const timer = setTimeout(() => deadline.abort(), 15000);
      let remove = () => {};
      try {
        return await new Promise<OnboardStepResult>((resolve) => {
          const stopped = () =>
            resolve(
              waiting(
                external?.aborted
                  ? "interrupted"
                  : "account_validation_unavailable",
              ),
            );
          if (signal.aborted) {
            stopped();
            return;
          }
          signal.addEventListener("abort", stopped, { once: true });
          remove = () => signal.removeEventListener("abort", stopped);
          Promise.resolve()
            .then(async (): Promise<OnboardStepResult> => {
              if (signal.aborted) return waiting("interrupted");
              // UI callbacks can queue a config change before this deferred send executes.
              if (!equal(binding(ctx, journal), live.identity))
                return waiting("account_identity_unverified");
              attempted = true;
              const response = await ctx.fetch(
                `${support.origin}/api/v1/coding-accounts/${encodeURIComponent(selected.accountSlot)}/validate`,
                {
                  method: "POST",
                  redirect: "error",
                  signal,
                  headers: {
                    authorization: `Bearer ${bearer}`,
                    accept: "application/json",
                  },
                },
              );
              if (response.status !== 200)
                return waiting("account_validation_unavailable");
              const body = object(await response.json());
              if (
                signal.aborted ||
                !equal(binding(ctx, journal), live.identity)
              )
                return waiting("account_identity_unverified");
              const now = ctx.now().getTime();
              if (
                !body ||
                body.provider !== selected.provider ||
                typeof body.checkedAtMs !== "number" ||
                !Number.isSafeInteger(body.checkedAtMs) ||
                body.checkedAtMs > now + 5000 ||
                body.checkedAtMs < now - 30000 ||
                !["working", "walled", "rejected", "inconclusive"].includes(
                  String(body.result),
                )
              )
                return waiting("account_validation_unverified");
              if (body.result !== "working")
                return waiting(
                  body.result === "walled"
                    ? "account_provider_walled"
                    : body.result === "rejected"
                      ? "account_provider_rejected"
                      : "account_provider_access_unverified",
                );
              proof = {
                ...live.identity,
                slot: selected.accountSlot,
                provider: selected.provider,
                checkedAtMs: body.checkedAtMs,
              };
              input.message?.(
                "Claude provider access was verified. This does not reserve a runner or prove that a phase can start.",
              );
              return check(ctx, journal, signal);
            })
            .then(
              (result) => (signal.aborted ? stopped() : resolve(result)),
              () => stopped(),
            );
        });
      } finally {
        clearTimeout(timer);
        remove();
      }
    },
  };
}
