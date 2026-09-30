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
  signal?: AbortSignal;
  /** Render the live approval wait only after the browser instructions have been written. */
  waitForApproval?: <T>(run: () => Promise<T>) => Promise<T>;
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
  /** Only when the server sent one: the link that carries the code, so nothing is typed. */
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface TokenPair {
  access_token: string;
  refresh_token: string;
}

/**
 * CTC-2136: how many device codes one login mints before it gives up. A code lives `expires_in`
 * (300 s at WorkOS), which a first sign-in from a phone can outlast, so an expired code is replaced
 * in the same process rather than ending the login. Ryan's call (2026-09-28): up to 3 codes.
 */
export const MAX_DEVICE_CODES = 3;

/**
 * Run the device-authorization grant to completion and return the stored session block. Prints the
 * user code, where to enter it, and the one-click link when the server sends one; on a TTY it also
 * opens the browser. Each code is polled at the server's `interval`, honouring `slow_down`, and is
 * bounded by `AbortSignal.timeout(expires_in)` so it can never poll past its own lifetime. When a code
 * expires, a fresh one is minted and printed, up to MAX_DEVICE_CODES in all.
 */
export async function deviceFlowLogin(ctx: Ctx, baseUrl: string, deps: DeviceFlowDeps = {}): Promise<OauthAuth> {
  const cancelled = () => { if (deps.signal?.aborted) throw new CliError("Sign-in paused. Run the same command to resume.", "login-cancelled", 11); };
  cancelled();
  if (deps.signal) {
    const fetchImpl = ctx.fetch;
    const signal = deps.signal;
    ctx = { ...ctx, fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetchImpl(input, {
      ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    })) as typeof fetch };
  }
  const discovery = await fetchDiscovery(ctx, baseUrl);
  // The browser rule is decided on the first code; a later code re-opens it only when the first did.
  let browserOpened = false;
  for (let round = 1; round <= MAX_DEVICE_CODES; round++) {
    cancelled();
    const auth = await deviceAuthorize(ctx, discovery);
    if (round > 1) ctx.stdout(`That code expired. Here is a new one (${round} of ${MAX_DEVICE_CODES}):`);
    ctx.stdout("");
    ctx.stdout(`To connect this machine, visit:  ${auth.verification_uri}`);
    ctx.stdout(`and enter the code:              ${auth.user_code}`);
    if (auth.verification_uri_complete) ctx.stdout(`Or open this link, which fills the code in: ${auth.verification_uri_complete}`);
    if (round === 1 ? (deps.isTty ?? (() => false))() : browserOpened) {
      try {
        (deps.openBrowser ?? (() => {}))(auth.verification_uri_complete ?? auth.verification_uri);
        browserOpened = true;
        ctx.stdout("Opened your browser to that page — approve there, or use the code above.");
      } catch {
        // a browser that will not open is not a failure; the code and URL still work
      }
    }
    ctx.stdout("Waiting for you to approve… (Ctrl-C to cancel)");
    const poll = () => pollDeviceCode(ctx, discovery, auth, deps.sleep, deps.signal);
    const tokens = deps.waitForApproval ? await deps.waitForApproval(poll) : await poll();
    cancelled();
    if (tokens !== "expired") return tokensToAuth(ctx, tokens.access_token, tokens.refresh_token);
  }
  // Every code lapsed unapproved. The exit code (2, CliError's default) and the `login-expired` code are
  // unchanged from before CTC-2136; only the line is new, and its wording is Ryan's.
  throw new CliError(
    `The sign-in code expired ${MAX_DEVICE_CODES} times. Run the same command again when you are ready to approve.`,
    "login-expired",
  );
}

/**
 * Poll one device code until it yields a token pair or expires. Terminal refusals (`access_denied`,
 * a non-transient error) throw; expiry, by the server's `expired_token` or the code's own
 * `expires_in` lapsing, returns "expired" so the caller can mint the next code.
 */
async function pollDeviceCode(ctx: Ctx, discovery: CliDiscovery, auth: DeviceAuthorization, sleep?: (ms: number) => Promise<void>, external?: AbortSignal): Promise<TokenPair | "expired"> {
  const deadline = AbortSignal.timeout(auth.expires_in * 1_000);
  const signal = external ? AbortSignal.any([external, deadline]) : deadline;
  const cancelled = () => { if (external?.aborted) throw new CliError("Sign-in paused. Run the same command to resume.", "login-cancelled", 11); };
  let intervalMs = Math.max(1, auth.interval) * 1_000;
  for (;;) {
    cancelled();
    try { await devicePollDelay(intervalMs, signal, sleep); }
    catch (error) { cancelled(); if (deadline.aborted) return "expired"; throw error; }
    cancelled();
    // The device code's own lifetime bounds the loop: once it lapses, treat it as expired rather than
    // letting the next fetch's aborted signal surface as a generic network error (Codex P2).
    if (deadline.aborted) return "expired";
    let res: Response;
    try {
      res = await safeFetch(
        ctx,
        discovery.tokenUrl,
        { method: "POST", headers: formHeaders(), body: form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: auth.device_code, client_id: discovery.clientId }) },
        signal,
      );
      cancelled();
    } catch (err) {
      cancelled();
      // The deadline firing mid-fetch is an expiry, not a failure; anything else is a transient
      // network blip — retry with backoff until the deadline, never abandon the login (CTC-2112 P1).
      if (deadline.aborted) return "expired";
      intervalMs = backoff(intervalMs);
      continue;
    }
    if (res.ok) {
      const pair = (await parseJson(res, discovery.tokenUrl)) as Partial<TokenPair>;
      if (typeof pair.access_token !== "string" || typeof pair.refresh_token !== "string") {
        throw new CliError("the login token response was missing a token", "login-shape");
      }
      return { access_token: pair.access_token, refresh_token: pair.refresh_token };
    }
    const err = await oauthError(res, discovery.tokenUrl);
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      intervalMs += SLOW_DOWN_BUMP_MS;
      continue;
    }
    if (err === "access_denied") throw new CliError("login was denied — run: catalyst login to try again", "login-denied");
    if (err === "expired_token") return "expired";
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

/** Clear the real timer on cancellation; an injected slow callback is bounded by the same signal. */
function devicePollDelay(ms: number, signal: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clean = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { clean(); reject(new Error("device_poll_stopped")); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    if (sleep) {
      Promise.resolve().then(() => sleep(ms)).then(
        () => { clean(); resolve(); },
        error => { clean(); reject(error); },
      );
    } else timer = setTimeout(() => { clean(); resolve(); }, ms);
  });
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
    ...(typeof d.verification_uri_complete === "string" && d.verification_uri_complete !== "" ? { verification_uri_complete: d.verification_uri_complete } : {}),
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
  if (!cfg.auth) throw new CliError("this machine is not connected — run: catalyst login", "not-configured");
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
      throw new CliError("your login expired or was revoked — run: catalyst login", "session-expired");
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
