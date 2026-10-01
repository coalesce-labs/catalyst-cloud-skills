import { constants, closeSync, fsyncSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_BASE_URL,
  cliPath,
  configPathFor,
  contractPathFor,
  defaultReplicaDbFor,
  loadConfig,
  normalizeBaseUrl,
  readManifest,
  writeConfig,
  type Ctx,
  type CustomerConfig,
} from "./config.js";
import { contractVersionInRange } from "./contract.js";
import { CliError, UsageError } from "./errors.js";
import { deviceFlowLogin, type DeviceFlowDeps } from "./oauth.js";
import { fetchMe } from "./transport.js";
import type { OnboardIdentity } from "./onboard.js";
import { onboardFileSnapshot } from "./onboard-file-snapshot.js";

export interface OnboardLoginCandidate {
  readonly identity: OnboardIdentity;
  readonly accepted: boolean;
  /** Called only after Q1 accepts the preview, with the receipt lock held. No rollback claim. */
  accept(signal?: AbortSignal, beforePublish?: () => void): Promise<void>;
}
const stopped = () =>
  new CliError(
    "Sign-in paused. Your saved connection was not changed.",
    "onboard-signin-paused",
    11,
  );
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
async function bounded<T>(
  external: AbortSignal | undefined,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const owned = new AbortController();
  const signal = external
    ? AbortSignal.any([owned.signal, external])
    : owned.signal;
  const timer = setTimeout(() => owned.abort(), ms);
  let remove = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      const abort = () => reject(stopped());
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      remove = () => signal.removeEventListener("abort", abort);
      Promise.resolve()
        .then(() => {
          if (signal.aborted) throw stopped();
          return run(signal);
        })
        .then((value) => (signal.aborted ? abort() : resolve(value)), reject);
    });
  } finally {
    clearTimeout(timer);
    remove();
    owned.abort();
  }
}

function boundedResponse(response: Response, signal: AbortSignal): Response {
  if (!response.body) return response;
  let bytes = 0;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (signal.aborted) throw stopped();
      bytes += chunk.byteLength;
      if (bytes > 1024 * 1024)
        throw new CliError(
          "The sign-in response could not be verified.",
          "onboard-response-unverified",
          11,
        );
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(limit), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Staging keeps tokens in this closure. Neither config nor receipt nor auth caches is changed. */
export async function stageOnboardLogin(
  ctx: Ctx,
  input: {
    baseUrl?: string;
    signal?: AbortSignal;
    device?: DeviceFlowDeps;
    timeoutMs?: number;
  },
): Promise<OnboardLoginCandidate> {
  const timeoutMs = input.timeoutMs ?? 600_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000)
    throw new UsageError(
      "onboarding sign-in timeout must be 1 to 600000 milliseconds",
    );
  const reviewDeadline = Date.now() + timeoutMs;
  const original = onboardFileSnapshot(configPathFor(ctx.home));
  const saved = loadConfig(ctx.home);
  const originalContract = onboardFileSnapshot(contractPathFor(ctx.home));
  const baseUrl = normalizeBaseUrl(
    saved?.baseUrl ??
      input.baseUrl ??
      ctx.env.CATALYST_CLOUD_BASE_URL ??
      DEFAULT_BASE_URL,
  );
  if (input.baseUrl && normalizeBaseUrl(input.baseUrl) !== baseUrl)
    throw new CliError(
      "Resume against the original cloud to change this login.",
      "onboard-base-url-mismatch",
      12,
    );
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.origin !== baseUrl)
    throw new CliError(
      "The saved cloud origin could not be verified.",
      "onboard-base-url-mismatch",
      12,
    );
  const manifest = readManifest();
  const validate = async (
    auth: NonNullable<CustomerConfig["auth"]>,
    signal: AbortSignal,
  ) => {
    if (signal.aborted) throw stopped();
    if (
      !Number.isFinite(Date.parse(auth.expiresAt)) ||
      Date.parse(auth.expiresAt) - ctx.now().getTime() <= 30_000
    )
      throw new CliError(
        "Sign in again before accepting this plan.",
        "onboard-login-refresh-required",
        11,
      );
    const fetchImpl: typeof fetch = async (request, init) =>
      boundedResponse(
        await ctx.fetch(request, {
          ...init,
          redirect: "error",
          signal: init?.signal
            ? AbortSignal.any([signal, init.signal])
            : signal,
        }),
        signal,
      );
    const me = await fetchMe(baseUrl, auth.accessToken, fetchImpl);
    if (signal.aborted) throw stopped();
    if (!me.user)
      throw new CliError(
        "Onboarding needs your personal login.",
        "onboard-person-required",
        12,
      );
    // Cached contracts and loadContract's stale fallback cannot approve a staged identity.
    const response = await fetchImpl(`${baseUrl}/api/v1/agent/contract`, {
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        accept: "application/json",
      },
    });
    if (!response.ok)
      throw new CliError(
        "The workspace could not be verified. Your saved connection was not changed.",
        "onboard-candidate-unverified",
        11,
      );
    const text = await response.text();
    if (signal.aborted) throw stopped();
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new CliError(
        "The workspace response could not be verified.",
        "onboard-candidate-unverified",
        11,
      );
    let contract: Record<string, unknown> | null;
    try {
      contract = object(JSON.parse(text));
    } catch {
      contract = null;
    }
    if (
      object(contract?.account)?.id !== me.account ||
      typeof contract?.contractVersion !== "string" ||
      contractVersionInRange(
        contract.contractVersion,
        manifest.tenantContractRange,
      ) !== true
    )
      throw new CliError(
        "The workspace response did not match this login.",
        "onboard-candidate-unverified",
        11,
      );
    return me;
  };
  const staged = await bounded(input.signal, timeoutMs, async (signal) => {
    const stageCtx: Ctx = {
      ...ctx,
      env: { ...ctx.env, CATALYST_CLOUD_TOKEN: undefined },
      fetch: async (request, init) =>
        boundedResponse(
          await ctx.fetch(request, {
            ...init,
            redirect: "error",
            signal: init?.signal
              ? AbortSignal.any([signal, init.signal])
              : signal,
          }),
          signal,
        ),
    };
    let auth: NonNullable<CustomerConfig["auth"]>;
    try {
      auth = await deviceFlowLogin(stageCtx, baseUrl, {
        ...input.device,
        discoveryCache: false,
        signal,
      });
    } catch {
      if (signal.aborted) throw stopped();
      throw new CliError(
        "Sign-in could not be verified. Your saved connection was not changed.",
        "onboard-signin-unverified",
        11,
      );
    }
    const me = await bounded(signal, 30_000, (readSignal) =>
      validate(auth, readSignal),
    );
    if (onboardFileSnapshot(configPathFor(ctx.home)) !== original)
      throw new CliError(
        "Your saved login changed. Run setup again.",
        "onboard-login-changed",
        11,
      );
    return { auth, me };
  });
  const user = staged.me.user;
  if (!user)
    throw new CliError(
      "Onboarding needs your personal login.",
      "onboard-person-required",
      12,
    );
  const identity: OnboardIdentity = {
    account: staged.me.account,
    membershipId: user.id,
    baseUrl,
    role: user.role,
    display: Object.freeze({
      personLabel: user.label,
      email: user.email,
      workspaceName: staged.me.name,
      workspaceSlug: staged.me.slug,
    }),
  };
  let accepted = false;
  return {
    identity: Object.freeze(identity),
    get accepted() {
      return accepted;
    },
    async accept(signal, beforePublish) {
      if (accepted)
        throw new CliError(
          "This sign-in preview was already accepted.",
          "onboard-candidate-used",
          11,
        );
      const remaining = reviewDeadline - Date.now();
      if (remaining <= 0) throw stopped();
      const me = await bounded(
        signal,
        Math.min(30_000, remaining),
        (readSignal) => validate(staged.auth, readSignal),
      );
      if (
        me.account !== identity.account ||
        me.user?.id !== identity.membershipId ||
        me.user.role !== identity.role
      )
        throw new CliError(
          "This login changed during review. Run setup again.",
          "onboard-login-changed",
          11,
        );
      if (signal?.aborted) throw stopped();
      if (onboardFileSnapshot(configPathFor(ctx.home)) !== original)
        throw new CliError(
          "Your saved login changed. Run setup again.",
          "onboard-login-changed",
          11,
        );
      if (onboardFileSnapshot(contractPathFor(ctx.home)) !== originalContract)
        throw new CliError(
          "Your setup files changed during review. Run setup again.",
          "onboard-login-changed",
          11,
        );
      beforePublish?.();
      const config: CustomerConfig = {
        baseUrl,
        account: me.account,
        slug: me.slug,
        name: me.name,
        principal: me.principal,
        permissions: me.permissions,
        user: me.user,
        auth: staged.auth,
        joinedAt: ctx.now().toISOString(),
        lastSkillBundleVersion: manifest.version,
        cliPath: cliPath(),
        ...(saved?.skillsDir ? { skillsDir: saved.skillsDir } : {}),
        // A new workspace never inherits the old workspace's database path.
        replicaDb:
          saved?.account === me.account
            ? (saved.replicaDb ?? defaultReplicaDbFor(ctx.home))
            : undefined,
      };
      // This is an accepted connection, not a two-file transaction. Existing config writers do
      // not share the receipt lock; the precheck refuses visible changes but is not a CAS claim.
      try {
        writeConfig(ctx.home, config);
      } catch (error) {
        const current = loadConfig(ctx.home);
        accepted =
          current?.account === config.account &&
          current.user?.id === config.user?.id &&
          current.auth?.accessToken === config.auth?.accessToken;
        if (accepted)
          throw new CliError(
            "Your connection was accepted, but setup could not be recorded. Run catalyst onboard to resume.",
            "onboard-connection-accepted",
            11,
          );
        throw error;
      }
      accepted = true;
      const fd = openSync(
        configPathFor(ctx.home),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const directory = openSync(
        dirname(configPathFor(ctx.home)),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      // The old cache has no identity scope. Invalidate it only after this reviewed connection
      // is accepted, and only while its observed bytes still match. A failure remains partial.
      if (onboardFileSnapshot(contractPathFor(ctx.home)) !== originalContract)
        throw new CliError(
          "Your connection was accepted, but setup could not be recorded. Run catalyst onboard to resume.",
          "onboard-connection-accepted",
          11,
        );
      if (originalContract !== null) {
        unlinkSync(contractPathFor(ctx.home));
        const cacheDirectory = openSync(
          dirname(contractPathFor(ctx.home)),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          fsyncSync(cacheDirectory);
        } finally {
          closeSync(cacheDirectory);
        }
      }
    },
  };
}
