import {
  configPathFor,
  type Ctx,
  type CustomerConfig,
  type MeIdentity,
} from "./config.js";
import { personCacheScope, type PersonCacheScope } from "./daemon-cache.js";
import { ownedFetch } from "./owned-fetch.js";
import { fetchMe } from "./transport.js";
import { onboardFileSnapshot } from "./onboard-file-snapshot.js";

export class DaemonAuthorityError extends Error {
  constructor(
    readonly kind: "authentication" | "identity",
    code: string,
  ) {
    super(code);
    this.name = "DaemonAuthorityError";
  }
}
export interface DaemonAuthorityProof {
  readonly scope: PersonCacheScope;
  readonly expiresAt: number;
  assertCurrent(): void;
  getToken(): Promise<string>;
}
const refused = (code: string) =>
  new DaemonAuthorityError("authentication", code);
const changed = () =>
  new DaemonAuthorityError("identity", "daemon_authority_changed");
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
function currentConfig(ctx: Ctx): CustomerConfig {
  let bytes: string | null;
  try {
    bytes = onboardFileSnapshot(configPathFor(ctx.home));
  } catch {
    throw refused("daemon_config_unverified");
  }
  if (bytes === null) throw refused("daemon_login_required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw refused("daemon_config_unverified");
  }
  const config = object(parsed),
    user = object(config?.user);
  if (
    !config ||
    !user ||
    typeof config.account !== "string" ||
    typeof config.baseUrl !== "string" ||
    typeof config.slug !== "string" ||
    typeof config.name !== "string" ||
    typeof config.joinedAt !== "string" ||
    typeof config.lastSkillBundleVersion !== "string" ||
    config.principal !== "service" ||
    typeof user.id !== "string" ||
    typeof user.label !== "string" ||
    !(user.email === null || typeof user.email === "string") ||
    !(user.linearUserId === null || typeof user.linearUserId === "string") ||
    (user.role !== "owner" && user.role !== "admin" && user.role !== "member")
  )
    throw refused("daemon_config_unverified");
  let permissions: string[] | null = null;
  if (config.permissions !== null) {
    if (!Array.isArray(config.permissions) || config.permissions.length > 128)
      throw refused("daemon_config_unverified");
    permissions = [];
    for (const permission of config.permissions) {
      if (typeof permission !== "string")
        throw refused("daemon_config_unverified");
      permissions.push(permission);
    }
  }
  let credential: Pick<CustomerConfig, "key" | "auth">;
  if (
    typeof config.key === "string" &&
    config.key.length > 0 &&
    config.auth === undefined
  )
    credential = { key: config.key };
  else {
    const auth = object(config.auth);
    if (
      config.key !== undefined ||
      !auth ||
      auth.kind !== "oauth" ||
      typeof auth.sessionId !== "string" ||
      typeof auth.accessToken !== "string" ||
      !auth.accessToken.length ||
      auth.accessToken.length > 8192 ||
      typeof auth.refreshToken !== "string" ||
      typeof auth.expiresAt !== "string"
    )
      throw refused("daemon_config_unverified");
    credential = {
      auth: {
        kind: "oauth",
        sessionId: auth.sessionId,
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        expiresAt: auth.expiresAt,
      },
    };
  }
  return {
    ...credential,
    account: config.account,
    baseUrl: config.baseUrl,
    slug: config.slug,
    name: config.name,
    principal: config.principal,
    permissions,
    joinedAt: config.joinedAt,
    lastSkillBundleVersion: config.lastSkillBundleVersion,
    user: {
      id: user.id,
      label: user.label,
      email: user.email,
      linearUserId: user.linearUserId,
      role: user.role,
    },
  };
}
function currentToken(config: CustomerConfig, now: number): string {
  if (config.key && !config.auth) return config.key;
  if (
    !config.key &&
    config.auth &&
    Date.parse(config.auth.expiresAt) - now > 30_000
  )
    return config.auth.accessToken;
  // This reader never refreshes or writes the saved login. Renewal needs separately owned IO.
  throw refused("daemon_login_refresh_required");
}
function scopeOf(config: CustomerConfig, me: MeIdentity): PersonCacheScope {
  let scope: PersonCacheScope;
  try {
    scope = personCacheScope(config, me);
  } catch {
    throw changed();
  }
  if (scope.permissions !== null && !scope.permissions.includes("mirror:feed"))
    throw refused("daemon_feed_permission_required");
  return scope;
}
function sameScope(a: PersonCacheScope, b: PersonCacheScope): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A read-only proof expires 30s after request ENTRY, not after a potentially slow response.
 * The owner must stop peers at expiry and join this promise before releasing any writer lease.
 * Cancellation can remain pending beyond the deadline until actual upstream IO acknowledges it. */
export async function readDaemonAuthority(
  ctx: Ctx,
  parent: AbortSignal,
): Promise<DaemonAuthorityProof> {
  if (parent.aborted) throw parent.reason;
  const enteredAt = ctx.now().getTime();
  if (!Number.isSafeInteger(enteredAt)) throw refused("daemon_clock_invalid");
  const config = currentConfig(ctx);
  // Saved claims only preflight destination/credential shape; they never establish live authority.
  scopeOf(config, config);
  const bearer = currentToken(config, enteredAt);
  const stopped = new AbortController();
  const signal = AbortSignal.any([parent, stopped.signal]);
  const request = ownedFetch(ctx.fetch, signal, { maxBodyBytes: 1024 * 1024 });
  const timer = setTimeout(
    () => stopped.abort(refused("daemon_authority_expired")),
    30_000,
  );
  let primary: unknown;
  let failed = false;
  let proof: DaemonAuthorityProof | undefined;
  try {
    const me = await fetchMe(config.baseUrl, bearer, request.fetch, 30_000);
    if (signal.aborted) throw signal.reason;
    const scope = scopeOf(config, me);
    const expiresAt = enteredAt + 30_000;
    const assertCurrent = () => {
      if (parent.aborted) throw parent.reason;
      const current = currentConfig(ctx);
      if (!sameScope(scope, scopeOf(current, me))) throw changed();
      const now = ctx.now().getTime();
      currentToken(current, now);
      // No saved-file read follows the final clock/parent boundary.
      if (parent.aborted) throw parent.reason;
      if (!Number.isSafeInteger(now) || now < enteredAt || now >= expiresAt)
        throw refused("daemon_authority_expired");
    };
    assertCurrent();
    proof = Object.freeze({
      scope,
      expiresAt,
      assertCurrent,
      async getToken() {
        assertCurrent();
        const current = currentConfig(ctx);
        if (!sameScope(scope, scopeOf(current, me))) throw changed();
        // A saved rotation is not proof about that new bearer. Use only the /me-verified token
        // until a separately owned fresh read replaces this proof.
        assertCurrent();
        return bearer;
      },
    });
  } catch (error) {
    primary = signal.aborted
      ? signal.reason
      : error instanceof DaemonAuthorityError
        ? error
        : refused("daemon_authority_unavailable");
    failed = true;
  } finally {
    clearTimeout(timer);
    // The wrapper joins entered headers, readers and FIRST cancel; a timeout is never an ACK.
    try {
      await request.settle();
    } catch (cleanup) {
      throw new AggregateError(
        failed ? [primary, cleanup] : [cleanup],
        "daemon_authority_cleanup_failed",
      );
    }
  }
  if (failed) throw primary;
  if (!proof) throw refused("daemon_authority_unverified");
  // Even natural-response cleanup can be slow; publication checks the ORIGINAL expiry again.
  proof.assertCurrent();
  return proof;
}
