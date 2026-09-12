// config.ts — ~/.config/catalyst-cloud/customer.json and its siblings. The ONLY place the base URL
// and the `/api/v1` prefix are joined: the SDK wants the base with the prefix, GET /me without.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";

export const PACKAGE_NAME = "@catalyst-cloud/catalyst-skills";
export const DEFAULT_BASE_URL = "https://staging.catalystcloud.dev";
export const CONFIG_MODE = 0o600;

/** The person behind a personal key (`ctc_user_`), as `GET /api/v1/me` names them. Absent for an
 *  account (host) key. `linearUserId` is the resolved Linear identity or `null` when the tenant has
 *  not matched it yet — it is what "what needs me" filters on, so it is never guessed. */
export interface MeUser {
  id: string;
  label: string;
  email: string | null;
  role: "owner" | "admin" | "member";
  linearUserId: string | null;
}

export interface MeIdentity {
  account: string;
  slug: string;
  name: string;
  permissions: string[] | null;
  principal: "service" | "session";
  user?: MeUser;
}

/** CTC-2112 — a person's WorkOS device-flow session, stored in place of a personal key. The access
 *  token is short-lived and rotated silently; `sessionId` is the JWT's `sid`, `expiresAt` its `exp`. */
export interface OauthAuth {
  kind: "oauth";
  accessToken: string;
  refreshToken: string;
  /** ISO 8601; the access token's `exp`. Refreshed within 60s of it. */
  expiresAt: string;
  sessionId: string;
}

export interface CustomerConfig {
  baseUrl: string;
  /** A personal (or account) key. Present for the key rail; absent when `auth` (OAuth) is present —
   *  a config carries EXACTLY ONE of {key, auth}. */
  key?: string;
  /** CTC-2112 — the keyless (device-flow OAuth) session. Mutually exclusive with `key`. */
  auth?: OauthAuth;
  account: string;
  slug: string;
  name: string;
  permissions: string[] | null;
  principal: "service" | "session";
  /** Who this machine is connected AS. Present when the key is a personal key; a config written by
   *  an older bundle, or with an account (host) key, has none. */
  user?: MeUser;
  joinedAt: string;
  lastSkillBundleVersion: string;
  /** Where a copy this package made lives. Kept for back-compat: 0.2 no longer copies skills on
   *  login (your agent's own install command does), and the update notice only refreshes what is
   *  already there. Still read, still written, so an older config keeps working. */
  skillsDir?: string;
  /** Absolute path of bin/catalyst-skills.js, so a skill script can spawn this exact CLI. */
  cliPath?: string;
  /** The replica file (default ~/.config/catalyst-cloud/replica.db). */
  replicaDb?: string;
}

export interface Ctx {
  env: NodeJS.ProcessEnv;
  home: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetch: typeof fetch;
  now: () => Date;
}

export function defaultCtx(): Ctx {
  return {
    env: process.env,
    home: process.env.CATALYST_SKILLS_HOME ?? process.env.HOME ?? "/",
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    fetch: fetch,
    now: () => new Date(),
  };
}

export function configDirFor(home: string): string {
  return join(home, ".config", "catalyst-cloud");
}
export function configPathFor(home: string): string {
  return join(configDirFor(home), "customer.json");
}
export function contractPathFor(home: string): string {
  return join(configDirFor(home), "contract.json");
}
export function watchCursorPathFor(home: string): string {
  return join(configDirFor(home), "watch-cursor.json");
}
/** CTC-2112 — where the cached CLI-auth discovery document lives (the `/api/v1/auth/cli` answer). */
export function discoveryCachePathFor(home: string): string {
  return join(configDirFor(home), "auth-discovery.json");
}
export function defaultReplicaDbFor(home: string): string {
  return join(configDirFor(home), "replica.db");
}
export function defaultSkillsDirFor(home: string): string {
  return join(home, ".claude", "skills");
}

/** The CLI launcher this very package ships — recorded by login so skill scripts can spawn it. */
export function cliPath(): string {
  return fileURLToPath(new URL("../bin/catalyst-skills.js", import.meta.url));
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The origin WITH the versioned prefix — what the SDK and every API read/write take. */
export function apiBase(cfg: Pick<CustomerConfig, "baseUrl">): string {
  return `${normalizeBaseUrl(cfg.baseUrl)}/api/v1`;
}

export function replicaDbPath(cfg: Pick<CustomerConfig, "replicaDb">, home: string): string {
  return cfg.replicaDb ?? defaultReplicaDbFor(home);
}

export function loadConfig(home: string): CustomerConfig | null {
  const path = configPathFor(home);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(`config at ${path} is not valid JSON — re-run login to rewrite it`, "config-corrupt");
  }
  const cfg = parsed as Partial<CustomerConfig>;
  if (typeof cfg.account !== "string" || typeof cfg.baseUrl !== "string") {
    throw new CliError(`config at ${path} is missing required fields — re-run login to rewrite it`, "config-corrupt");
  }
  const hasKey = typeof cfg.key === "string" && cfg.key !== "";
  const hasOauth = isOauthAuth(cfg.auth);
  if (hasKey === hasOauth) {
    throw new CliError(
      `config at ${path} must hold exactly one of a personal key or an OAuth session — re-run login to rewrite it`,
      "config-corrupt",
    );
  }
  return cfg as CustomerConfig;
}

/** Load the config or refuse with the one line every verb prints when the machine is not connected. */
export function requireConfig(ctx: Ctx): CustomerConfig {
  const cfg = loadConfig(ctx.home);
  if (!cfg) {
    throw new CliError(
      `not connected yet — run: npx ${PACKAGE_NAME} login (keyless; or pass --key / set CATALYST_CLOUD_TOKEN for a key)`,
      "not-configured",
    );
  }
  return cfg;
}

export function saveConfig(home: string, cfg: CustomerConfig): string {
  return writeConfig(home, cfg).path;
}

/** True when `v` is a well-formed OAuth session block. */
export function isOauthAuth(v: unknown): v is OauthAuth {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    a.kind === "oauth" &&
    typeof a.accessToken === "string" &&
    typeof a.refreshToken === "string" &&
    typeof a.expiresAt === "string" &&
    typeof a.sessionId === "string"
  );
}

/**
 * Write the config atomically (a rotated token must never be half-written under a crash) and return
 * the mode the file ACTUALLY carries afterwards. Write to a sibling `.tmp` at 0600, then rename over
 * the target — rename is atomic within a directory — and chmod once more (a pre-existing target keeps
 * its own mode through the rename on some platforms).
 */
export function writeConfig(home: string, cfg: CustomerConfig): { path: string; mode: number } {
  const path = configPathFor(home);
  mkdirSync(dirname(path), { recursive: true });
  // A UNIQUE sibling temp per write (pid + randomness): two concurrent CLI processes reaching the
  // OAuth refresh window must not share `customer.json.tmp`, or one renames/removes it out from under
  // the other and the second write fails with ENOENT or lands the wrong contents (Codex P2).
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: CONFIG_MODE });
    chmodSync(tmp, CONFIG_MODE);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup of the temp file
    }
    throw err;
  }
  chmodSync(path, CONFIG_MODE);
  return { path, mode: statSync(path).mode & 0o777 };
}

export function formatMode(mode: number): string {
  return "0" + mode.toString(8);
}

interface Manifest {
  version: string;
  tenantContractRange: string;
}

let manifestCache: Manifest | null = null;

export function readManifest(): Manifest {
  if (manifestCache) return manifestCache;
  const raw = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
    catalystCloud?: { tenantContractRange?: string };
  };
  manifestCache = {
    version: raw.version,
    tenantContractRange: raw.catalystCloud?.tenantContractRange ?? "unpinned",
  };
  return manifestCache;
}

/** Test seam: forget the cached manifest. */
export function resetManifestCache(): void {
  manifestCache = null;
}
