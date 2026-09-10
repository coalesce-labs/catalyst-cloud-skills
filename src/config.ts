// config.ts — ~/.config/catalyst-cloud/customer.json and its siblings. The ONLY place the base URL
// and the `/api/v1` prefix are joined: the SDK wants the base with the prefix, GET /me without.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";

export const PACKAGE_NAME = "@catalyst-cloud/catalyst-skills";
export const DEFAULT_BASE_URL = "https://staging.catalystcloud.dev";
export const CONFIG_MODE = 0o600;

export interface MeIdentity {
  account: string;
  slug: string;
  name: string;
  permissions: string[] | null;
  principal: "service" | "session";
}

export interface CustomerConfig {
  baseUrl: string;
  key: string;
  account: string;
  slug: string;
  name: string;
  permissions: string[] | null;
  principal: "service" | "session";
  joinedAt: string;
  lastSkillBundleVersion: string;
  /** Where join copied the skills, so an update can refresh the same copies. */
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
export function defaultReplicaDbFor(home: string): string {
  return join(configDirFor(home), "replica.db");
}
export function defaultSkillsDirFor(home: string): string {
  return join(home, ".claude", "skills");
}

/** The CLI launcher this very package ships — recorded by join so skill scripts can spawn it. */
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
    throw new CliError(`config at ${path} is not valid JSON — re-run join to rewrite it`, "config-corrupt");
  }
  const cfg = parsed as Partial<CustomerConfig>;
  if (typeof cfg.account !== "string" || typeof cfg.key !== "string" || typeof cfg.baseUrl !== "string") {
    throw new CliError(`config at ${path} is missing required fields — re-run join to rewrite it`, "config-corrupt");
  }
  return cfg as CustomerConfig;
}

/** Load the config or refuse with the one line every verb prints when the machine is not connected. */
export function requireConfig(ctx: Ctx): CustomerConfig {
  const cfg = loadConfig(ctx.home);
  if (!cfg) {
    throw new CliError(
      `not connected yet — run: CATALYST_CLOUD_TOKEN=<account key> npx ${PACKAGE_NAME} login`,
      "not-configured",
    );
  }
  return cfg;
}

export function saveConfig(home: string, cfg: CustomerConfig): string {
  return writeConfig(home, cfg).path;
}

/** Write the config and return the mode the file ACTUALLY carries afterwards (chmod runs on every
 *  write: Node honours `mode` only when it creates the file). */
export function writeConfig(home: string, cfg: CustomerConfig): { path: string; mode: number } {
  const path = configPathFor(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: CONFIG_MODE });
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
