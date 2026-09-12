// oauth.ts — CTC-2112: the keyless rail. A person logs in with WorkOS's device-authorization grant
// (no key to mint or paste), and every request afterwards refreshes the short-lived access token
// silently. The bundle only ever DECODES the access token (for its `exp`/`sid`); the cloud verifies
// it. Public-client throughout: the refresh carries `client_id` and NEVER a `client_secret`.
import type { AuthStrategy } from "@catalyst-cloud/sdk/node";
import { discoveryCachePathFor, loadConfig, normalizeBaseUrl, writeConfig, type Ctx, type CustomerConfig, type OauthAuth } from "./config.js";
import { CliError } from "./errors.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type { OauthAuth };

/** The public discovery document `GET /api/v1/auth/cli` serves — constant per deploy, cached 1h. */
export interface CliDiscovery {
  clientId: string;
  issuer: string;
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

export interface DeviceFlowDeps {
  /** Whether a terminal is attached — a TTY gets its browser opened at the completion URL. */
  isTty?: () => boolean;
  openBrowser?: (url: string) => void;
  /** Injected so tests never wait on the wall clock. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RefreshDeps {
  sleep?: (ms: number) => Promise<void>;
}

const DISCOVERY_TTL_MS = 60 * 60_000;
const REFRESH_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SLOW_DOWN_BUMP_MS = 5_000;
const MAX_POLL_BACKOFF_MS = 30_000;
const REFRESH_MAX_ATTEMPTS = 4;
const REFRESH_BASE_BACKOFF_MS = 500;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── discovery ──────────────────────────────────────────────────────────────────────────────────

interface DiscoveryCacheEntry {
  baseUrl: string;
  fetchedAt: number;
  doc: CliDiscovery;
}

let memo: DiscoveryCacheEntry | null = null;

/** Test seam: forget the cached discovery document. */
export function resetDiscoveryCache(): void {
  memo = null;
}

function readDiscoveryDisk(home: string): DiscoveryCacheEntry | null {
  const path = discoveryCachePathFor(home);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DiscoveryCacheEntry;
    if (isDiscovery(parsed.doc) && typeof parsed.fetchedAt === "number" && typeof parsed.baseUrl === "string") return parsed;
  } catch {
    // a corrupt cache is just a cache miss
  }
  return null;
}

function isDiscovery(v: unknown): v is CliDiscovery {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return ["clientId", "issuer", "deviceAuthorizationUrl", "tokenUrl", "jwksUrl"].every((k) => typeof d[k] === "string");
}

export async function fetchDiscovery(ctx: Ctx, baseUrl: string, opts: { refresh?: boolean } = {}): Promise<CliDiscovery> {
  const base = normalizeBaseUrl(baseUrl);
  const nowMs = ctx.now().getTime();
  const fresh = (e: DiscoveryCacheEntry | null): e is DiscoveryCacheEntry => e !== null && e.baseUrl === base && nowMs - e.fetchedAt < DISCOVERY_TTL_MS;
  if (!opts.refresh) {
    if (fresh(memo)) return memo.doc;
    const disk = readDiscoveryDisk(ctx.home);
    if (fresh(disk)) {
      memo = disk;
      return disk.doc;
    }
  }
  const url = `${base}/api/v1/auth/cli`;
  const res = await safeFetch(ctx, url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new CliError(`could not read the login discovery document (${res.status}) at ${url} — is this a Catalyst Cloud origin?`, "discovery-failed");
  }
  const doc = (await parseJson(res, url)) as unknown;
  if (!isDiscovery(doc)) throw new CliError(`the login discovery document at ${url} is not the expected shape`, "discovery-shape");
  const entry: DiscoveryCacheEntry = { baseUrl: base, fetchedAt: nowMs, doc };
  memo = entry;
  try {
    writeFileSync(discoveryCachePathFor(ctx.home), JSON.stringify(entry, null, 2) + "\n");
  } catch {
    // the disk cache is an optimisation; the in-memory memo is enough
  }
  return doc;
}

// ── the device flow ────────────────────────────────────────────────────────────────────────────

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenPair {
  access_token: string;
  refresh_token: string;
}

/**
 * Run the device-authorization grant to completion and return the stored session block. Prints the
 * user code and where to enter it; on a TTY it also opens the completion URL. Polls at the server's
 * `interval`, honours `slow_down`, and is bounded by `AbortSignal.timeout(expires_in)` so it can
 * never poll past the device code's own lifetime.
 */
export async function deviceFlowLogin(ctx: Ctx, baseUrl: string, deps: DeviceFlowDeps = {}): Promise<OauthAuth> {
  const sleep = deps.sleep ?? defaultSleep;
  const discovery = await fetchDiscovery(ctx, baseUrl);
  const auth = await deviceAuthorize(ctx, discovery);

  ctx.stdout("");
  ctx.stdout(`To connect this machine, visit:  ${auth.verification_uri}`);
  ctx.stdout(`and enter the code:              ${auth.user_code}`);
  if ((deps.isTty ?? (() => false))()) {
    try {
      (deps.openBrowser ?? (() => {}))(auth.verification_uri_complete);
      ctx.stdout("Opened your browser to that page — approve there, or use the code above.");
    } catch {
      // a browser that will not open is not a failure; the code and URL still work
    }
  }
  ctx.stdout("Waiting for you to approve… (Ctrl-C to cancel)");

  // Terminal states print ONE clear, actionable line and exit 2 (CliError's default). The duration
  // comes from the device code's own `expires_in`, so it is right whatever the server set.
  const mins = Math.round(auth.expires_in / 60);
  const expired = () =>
    new CliError(
      `the login code expired${mins >= 1 ? ` after ${mins} minute${mins === 1 ? "" : "s"}` : ""} — run: catalyst-skills login again`,
      "login-expired",
    );
  const deadline = AbortSignal.timeout(auth.expires_in * 1_000);
  let intervalMs = Math.max(1, auth.interval) * 1_000;
  for (;;) {
    await sleep(intervalMs);
    // The device code's own lifetime bounds the loop: once it lapses, say so plainly rather than
    // letting the next fetch's aborted signal surface as a generic network error (Codex P2).
    if (deadline.aborted) throw expired();
    let res: Response;
    try {
      res = await safeFetch(
        ctx,
        discovery.tokenUrl,
        { method: "POST", headers: formHeaders(), body: form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: auth.device_code, client_id: discovery.clientId }) },
        deadline,
      );
    } catch (err) {
      // The deadline firing mid-fetch is an expiry, not a failure; anything else is a transient
      // network blip — retry with backoff until the deadline, never abandon the login (CTC-2112 P1).
      if (deadline.aborted) throw expired();
      intervalMs = backoff(intervalMs);
      continue;
    }
    if (res.ok) {
      const pair = (await parseJson(res, discovery.tokenUrl)) as Partial<TokenPair>;
      if (typeof pair.access_token !== "string" || typeof pair.refresh_token !== "string") {
        throw new CliError("the login token response was missing a token", "login-shape");
      }
      return tokensToAuth(ctx, pair.access_token, pair.refresh_token);
    }
    const err = await oauthError(res, discovery.tokenUrl);
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      intervalMs += SLOW_DOWN_BUMP_MS;
      continue;
    }
    if (err === "access_denied") throw new CliError("login was denied — run: catalyst-skills login to try again", "login-denied");
    if (err === "expired_token") throw expired();
    // A transient HTTP failure (request timeout, rate limit, server error) is retried, honouring
    // Retry-After for a 429; only a genuine, non-transient refusal ends the loop.
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      intervalMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : backoff(intervalMs);
      continue;
    }
    throw new CliError(`login failed (${res.status}): ${err}`, "login-failed");
  }
}

/** Grow the poll interval on a transient failure, capped, so retries never hammer the endpoint. */
function backoff(intervalMs: number): number {
  return Math.min(intervalMs * 2, MAX_POLL_BACKOFF_MS);
}

/**
 * Persist a rotated token pair WITHOUT clobbering a newer login (Codex P1). A long-running watch or
 * detached replica holds the `cfg` it started with; if the person meanwhile re-ran `login` (a new
 * session, a different tenant, or the key rail), that config is already on disk and must survive. So
 * we reload disk and only write when it is still the same session we just refreshed — or when there
 * is nothing on disk yet. The reloaded doc is written (not our in-memory `cfg`), so its tenant, user
 * and CLI-path fields are preserved and only the auth block advances.
 */
function persistRotation(ctx: Ctx, cfg: CustomerConfig, sessionId: string, rotated: OauthAuth): void {
  let disk: CustomerConfig | null;
  try {
    disk = loadConfig(ctx.home);
  } catch {
    return; // a corrupt/unreadable disk config: don't overwrite what we can't understand
  }
  if (disk && disk.auth?.sessionId !== sessionId) return; // a newer login (or a switch to a key) — leave it
  const target = disk ?? cfg;
  target.auth = rotated;
  writeConfig(ctx.home, target); // atomic; the rotated pair survives a crash
}

async function deviceAuthorize(ctx: Ctx, discovery: CliDiscovery): Promise<DeviceAuthorization> {
  const res = await safeFetch(ctx, discovery.deviceAuthorizationUrl, { method: "POST", headers: formHeaders(), body: form({ client_id: discovery.clientId }) });
  if (!res.ok) throw new CliError(`could not start login (${res.status}) at ${discovery.deviceAuthorizationUrl}`, "login-failed");
  const d = (await parseJson(res, discovery.deviceAuthorizationUrl)) as Partial<DeviceAuthorization>;
  if (typeof d.device_code !== "string" || typeof d.user_code !== "string" || typeof d.verification_uri !== "string") {
    throw new CliError("the login authorization response was not the expected shape", "login-shape");
  }
  return {
    device_code: d.device_code,
    user_code: d.user_code,
    verification_uri: d.verification_uri,
    verification_uri_complete: d.verification_uri_complete ?? d.verification_uri,
    expires_in: typeof d.expires_in === "number" ? d.expires_in : 300,
    interval: typeof d.interval === "number" ? d.interval : 5,
  };
}

// ── the silent refresh ─────────────────────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<OauthAuth>>();

/**
 * The current bearer for `cfg`: the personal key verbatim, or (for an OAuth session) the access
 * token, refreshed in place when it is within 60s of expiry. Concurrent callers that both hit the
 * refresh window share one refresh (single-flight, keyed by the config's home) so the rotating
 * refresh token is spent exactly once.
 */
export async function bearerFor(ctx: Ctx, cfg: CustomerConfig, deps: RefreshDeps = {}): Promise<string> {
  if (typeof cfg.key === "string" && cfg.key !== "") return cfg.key;
  if (!cfg.auth) throw new CliError("this machine is not connected — run: catalyst-skills login", "not-configured");
  const msToExpiry = Date.parse(cfg.auth.expiresAt) - ctx.now().getTime();
  if (Number.isFinite(msToExpiry) && msToExpiry > REFRESH_SKEW_MS) return cfg.auth.accessToken;

  const pending = inFlight.get(ctx.home);
  if (pending) {
    const rotated = await pending;
    return rotated.accessToken;
  }
  const promise = refreshAndPersist(ctx, cfg, deps).finally(() => inFlight.delete(ctx.home));
  inFlight.set(ctx.home, promise);
  const rotated = await promise;
  return rotated.accessToken;
}

async function refreshAndPersist(ctx: Ctx, cfg: CustomerConfig, deps: RefreshDeps): Promise<OauthAuth> {
  const sleep = deps.sleep ?? defaultSleep;
  const discovery = await fetchDiscovery(ctx, cfg.baseUrl);
  const current = cfg.auth!;
  let lastStatus = 0;
  for (let attempt = 0; attempt < REFRESH_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(REFRESH_BASE_BACKOFF_MS * 2 ** (attempt - 1));
    const res = await safeFetch(ctx, discovery.tokenUrl, { method: "POST", headers: formHeaders(), body: form({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: discovery.clientId }) });
    if (res.ok) {
      const pair = (await parseJson(res, discovery.tokenUrl)) as Partial<TokenPair>;
      if (typeof pair.access_token !== "string" || typeof pair.refresh_token !== "string") throw new CliError("the refresh response was missing a token", "session-refresh-shape");
      const rotated = tokensToAuth(ctx, pair.access_token, pair.refresh_token, current.sessionId);
      cfg.auth = rotated; // this process keeps using its own refreshed token
      persistRotation(ctx, cfg, current.sessionId, rotated);
      return rotated;
    }
    lastStatus = res.status;
    const err = await oauthError(res, discovery.tokenUrl);
    if (err === "invalid_grant") {
      // revocation or > inactivity window — the ONLY session-expired case; NOT routine expiry.
      throw new CliError("your login expired or was revoked — run: catalyst-skills login", "session-expired");
    }
    const transient = res.status === 429 || res.status >= 500;
    if (!transient) throw new CliError(`could not refresh your login (${res.status}): ${err}`, "session-refresh-failed");
    // transient: fall through to backoff + retry, keeping the stored tokens untouched
  }
  throw new CliError(`could not refresh your login after ${REFRESH_MAX_ATTEMPTS} attempts (last status ${lastStatus}) — your tokens are unchanged; try again`, "session-refresh-failed");
}

/** The SDK auth strategy for `cfg`: a static token for the key rail, a fresh-per-connect bearer for
 *  the OAuth rail (its `getToken` runs the same refresh path as every HTTP request). */
export function authStrategyFor(ctx: Ctx, cfg: CustomerConfig): AuthStrategy {
  if (typeof cfg.key === "string" && cfg.key !== "") return { kind: "token", token: cfg.key };
  return { kind: "bearer", getToken: () => bearerFor(ctx, cfg) };
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

function tokensToAuth(ctx: Ctx, accessToken: string, refreshToken: string, fallbackSid?: string): OauthAuth {
  const claims = decodeJwtClaims(accessToken);
  const exp = typeof claims.exp === "number" ? claims.exp * 1_000 : ctx.now().getTime() + 15 * 60_000;
  const sid = typeof claims.sid === "string" ? claims.sid : (fallbackSid ?? "");
  return { kind: "oauth", accessToken, refreshToken, expiresAt: new Date(exp).toISOString(), sessionId: sid };
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function formHeaders(): Record<string, string> {
  return { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function safeFetch(ctx: Ctx, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    return await ctx.fetch(url, { ...init, signal: sig });
  } catch (err) {
    throw new CliError(`could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`, "network");
  }
}

async function parseJson(res: Response, url: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new CliError(`${url} returned a non-JSON body`, "shape");
  }
}

/** The OAuth `error` code from a 4xx body, or a short reason when there is none. */
async function oauthError(res: Response, url: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; error_description?: string };
    return body.error ?? body.error_description ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
