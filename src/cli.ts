// cli.ts — CTC-1926: the `catalyst-skills` customer installer/joiner (npm: @catalyst-cloud/catalyst-skills).
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@catalyst-cloud/catalyst-skills";
export const DEFAULT_BASE_URL = "https://staging.catalystcloud.dev";
export const PROVENANCE_MARKER = "vendored-from: @catalyst-cloud/catalyst-skills";
export const CUSTOMER_SKILLS = [
  "ask",
  "concierge",
  "join",
  "linearis",
  "setup",
  "steward",
] as const;

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
  /** Where join copied the skills, so an update can refresh the same copies (Codex round 1, P2). */
  skillsDir?: string;
}

export interface Ctx {
  env: NodeJS.ProcessEnv;
  home: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetch: typeof fetch;
  now: () => Date;
}

export class UsageError extends Error {}
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}
export class MeError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "network" | "shape",
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ParsedArgs {
  command: string | null;
  key?: string;
  baseUrl?: string;
  skillsDir?: string;
  force: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { command: null, force: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-V" || a === "--version") out.version = true;
    else if (a === "--key") out.key = requireValue(argv, ++i, "--key");
    else if (a === "--base-url") out.baseUrl = requireValue(argv, ++i, "--base-url");
    else if (a === "--skills-dir") out.skillsDir = requireValue(argv, ++i, "--skills-dir");
    else if (a === "--force") out.force = true;
    else if (a.startsWith("--")) throw new UsageError(`unknown option: ${a}`);
    else if (out.command === null) out.command = a;
    else throw new UsageError(`unexpected argument: ${a}`);
  }
  return out;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v === "") throw new UsageError(`${flag} requires a value`);
  return v;
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

export function configPathFor(home: string): string {
  return join(home, ".config", "catalyst-cloud", "customer.json");
}

export function defaultSkillsDirFor(home: string): string {
  return join(home, ".claude", "skills");
}

export function loadConfig(home: string): CustomerConfig | null {
  const path = configPathFor(home);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError(
      `config at ${path} is not valid JSON — re-run join to rewrite it`,
      "config-corrupt",
    );
  }
  const cfg = parsed as Partial<CustomerConfig>;
  if (
    typeof cfg.account !== "string" ||
    typeof cfg.key !== "string" ||
    typeof cfg.baseUrl !== "string"
  ) {
    throw new CliError(
      `config at ${path} is missing required fields — re-run join to rewrite it`,
      "config-corrupt",
    );
  }
  return cfg as CustomerConfig;
}

export const CONFIG_MODE = 0o600;

/**
 * Write the config and return its path plus the mode the file ACTUALLY carries afterwards.
 *
 * Codex round 1 (P1): Node honours `mode` only when it creates the file, so a rewrite of an existing
 * `customer.json` (key rotation, the corrupt-config repair, the update stamp) left a pre-existing
 * 0644 file world-readable while the CLI claimed 0600. The chmod runs on every write, and the
 * reported mode is read back from the file rather than asserted.
 */
export function saveConfig(home: string, cfg: CustomerConfig): string {
  return writeConfig(home, cfg).path;
}

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

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function fetchMe(
  baseUrl: string,
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs = 15_000,
): Promise<MeIdentity> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/v1/me`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new MeError(
      `could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  }
  if (!res.ok) {
    let reason: string;
    try {
      const body = (await res.json()) as { error?: string; reason?: string };
      reason = body.reason ?? body.error ?? "";
    } catch {
      reason = "";
    }
    const detail =
      res.status === 401
        ? "credential not accepted — ask your tenant admin for a valid account key"
        : reason || `HTTP ${res.status}`;
    throw new MeError(`GET /me failed (${res.status}): ${detail}`, "http", res.status);
  }
  let body: Partial<MeIdentity>;
  try {
    body = (await res.json()) as Partial<MeIdentity>;
  } catch {
    throw new MeError("GET /me returned a non-JSON body", "shape");
  }
  if (
    typeof body.account !== "string" ||
    typeof body.slug !== "string" ||
    typeof body.name !== "string" ||
    (body.permissions !== null && !Array.isArray(body.permissions)) ||
    (body.principal !== "service" && body.principal !== "session")
  ) {
    throw new MeError("GET /me returned an unexpected shape", "shape");
  }
  return {
    account: body.account,
    slug: body.slug,
    name: body.name,
    permissions: body.permissions as string[] | null,
    principal: body.principal,
  };
}

export function parseChangelogEntry(changelog: string, version: string): string | null {
  const lines = changelog.split("\n");
  const heading = `## ${version}`;
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  for (const line of lines.slice(start + 1)) {
    const t = line.trim();
    if (t === "") continue;
    if (t.startsWith("#")) break;
    return t;
  }
  return null;
}

export function readChangelog(): string {
  return readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
}

export function updateNoticeLine(previous: string, current: string, entry: string | null): string {
  const summary = entry ?? "see CHANGELOG.md";
  return `[catalyst-skills] updated ${previous} → ${current}: ${summary} · update with: npm update -g ${PACKAGE_NAME} (or: npx ${PACKAGE_NAME}@latest join)`;
}

export interface SkillsInstallResult {
  installed: string[];
  skipped: { name: string; reason: "foreign-skill-dir" }[];
}

export function skillsSourceDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

export function installSkills(
  targetDir: string,
  opts: { force?: boolean },
  sourceDir: string = skillsSourceDir(),
): SkillsInstallResult {
  const result: SkillsInstallResult = { installed: [], skipped: [] };
  const names = readdirSync(sourceDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    const src = join(sourceDir, name);
    if (!existsSync(join(src, "SKILL.md"))) continue;
    const dst = join(targetDir, name);
    const existingMd = join(dst, "SKILL.md");
    if (existsSync(existingMd) && !opts.force) {
      const existing = readFileSync(existingMd, "utf8");
      if (!existing.includes(PROVENANCE_MARKER)) {
        result.skipped.push({ name, reason: "foreign-skill-dir" });
        continue;
      }
    }
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
    result.installed.push(name);
  }
  return result;
}

export function usageText(): string {
  return [
    `${PACKAGE_NAME} — install the customer skill bundle and join your catalyst-cloud tenant`,
    "",
    "Usage:",
    "  catalyst-skills join --key <account-key> [--base-url <url>] [--skills-dir <dir>]",
    "  catalyst-skills install [--skills-dir <dir>] [--force]",
    "  catalyst-skills notice",
    "  catalyst-skills status",
    "",
    "The key may also come from CATALYST_CLOUD_TOKEN; the base URL defaults to",
    `CATALYST_CLOUD_BASE_URL or ${DEFAULT_BASE_URL}.`,
    "",
    "join installs the skills (default ~/.claude/skills), calls GET /api/v1/me to discover",
    "your tenant from the key alone, and writes ~/.config/catalyst-cloud/customer.json (0600).",
  ].join("\n");
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

export function resolveSkillsDir(
  args: Pick<ParsedArgs, "skillsDir">,
  ctx: Ctx,
  cfg: CustomerConfig | null,
): string {
  return (
    args.skillsDir ??
    ctx.env.CATALYST_SKILLS_CLAUDE_DIR ??
    cfg?.skillsDir ??
    defaultSkillsDirFor(ctx.home)
  );
}

/**
 * The Tier-2 update path. When the bundle on disk is newer than the version the config last
 * recorded, the copies under the skills dir are still the OLD bundle's — `npm update -g` and a newer
 * `npx` replace the package, not the copies join made (Codex round 1, P2). So the copies are
 * refreshed FIRST and the new version is recorded only once that succeeded; a failed refresh leaves
 * the old stamp in place so the next command tries again instead of silencing the notice forever.
 */
function maybePrintUpdateNotice(args: ParsedArgs, ctx: Ctx): void {
  let cfg: CustomerConfig | null;
  try {
    cfg = loadConfig(ctx.home);
  } catch {
    return;
  }
  if (!cfg) return;
  const manifest = readManifest();
  if (cfg.lastSkillBundleVersion === manifest.version) return;
  const previous = cfg.lastSkillBundleVersion;
  if (previous) {
    const entry = parseChangelogEntry(readChangelog(), manifest.version);
    ctx.stdout(updateNoticeLine(previous, manifest.version, entry));
  }
  const skillsDir = resolveSkillsDir(args, ctx, cfg);
  let refreshed: SkillsInstallResult;
  try {
    refreshed = installSkills(skillsDir, { force: false });
  } catch (err) {
    ctx.stderr(
      `[catalyst-skills] could not refresh the skills at ${skillsDir} (${err instanceof Error ? err.message : String(err)}) — the ${manifest.version} skills are not installed yet; run: catalyst-skills install`,
    );
    return;
  }
  if (refreshed.installed.length > 0) {
    ctx.stdout(
      `[catalyst-skills] refreshed ${refreshed.installed.join(", ")} at ${skillsDir} to ${manifest.version}`,
    );
  }
  for (const s of refreshed.skipped) {
    ctx.stdout(
      `[catalyst-skills] left "${s.name}" alone: ${skillsDir}/${s.name} was not installed by this package (catalyst-skills install --force to replace)`,
    );
  }
  cfg.lastSkillBundleVersion = manifest.version;
  cfg.skillsDir = skillsDir;
  saveConfig(ctx.home, cfg);
}

export async function main(argv: string[], ctx: Ctx = defaultCtx()): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    ctx.stderr(err instanceof Error ? err.message : String(err));
    ctx.stderr(usageText());
    return 1;
  }
  const manifest = readManifest();
  if (args.version) {
    ctx.stdout(
      `${PACKAGE_NAME} ${manifest.version} (tenant contract range: ${manifest.tenantContractRange})`,
    );
    return 0;
  }
  if (args.help || args.command === null) {
    ctx.stdout(usageText());
    return 0;
  }
  try {
    maybePrintUpdateNotice(args, ctx);
    switch (args.command) {
      case "join":
        return await cmdJoin(args, ctx, manifest);
      case "install":
        return cmdInstall(args, ctx);
      case "notice":
        return 0;
      case "status":
        return cmdStatus(ctx, manifest);
      default:
        ctx.stderr(`unknown command: ${args.command}`);
        ctx.stderr(usageText());
        return 1;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.stderr(err.message);
      ctx.stderr(usageText());
      return 1;
    }
    if (err instanceof MeError || err instanceof CliError) {
      ctx.stderr(`catalyst-skills: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

async function cmdJoin(args: ParsedArgs, ctx: Ctx, manifest: Manifest): Promise<number> {
  const key = (args.key ?? ctx.env.CATALYST_CLOUD_TOKEN ?? "").trim();
  if (!key) {
    throw new UsageError(
      "join needs an account key: pass --key <account-key> or set CATALYST_CLOUD_TOKEN",
    );
  }
  const baseUrl = normalizeBaseUrl(
    args.baseUrl ?? ctx.env.CATALYST_CLOUD_BASE_URL ?? DEFAULT_BASE_URL,
  );
  const me = await fetchMe(baseUrl, key, ctx.fetch);
  let existing: CustomerConfig | null;
  try {
    existing = loadConfig(ctx.home);
  } catch {
    existing = null;
  }
  const previous = existing?.lastSkillBundleVersion ?? null;
  const skillsDir = resolveSkillsDir(args, ctx, existing);
  const result = installSkills(skillsDir, { force: args.force });
  const config: CustomerConfig = {
    baseUrl,
    key,
    account: me.account,
    slug: me.slug,
    name: me.name,
    permissions: me.permissions,
    principal: me.principal,
    joinedAt: ctx.now().toISOString(),
    lastSkillBundleVersion: manifest.version,
    skillsDir,
  };
  const written = writeConfig(ctx.home, config);
  ctx.stdout(`Joined ${me.name} (${me.slug}) — account ${me.account}`);
  ctx.stdout(
    `Config written to ${written.path} (mode ${formatMode(written.mode)}, holds your key)${
      written.mode === CONFIG_MODE ? "" : ` — expected ${formatMode(CONFIG_MODE)}; chmod it by hand`
    }`,
  );
  ctx.stdout(
    result.installed.length > 0
      ? `Skills installed to ${skillsDir}: ${result.installed.join(", ")}`
      : `No skills installed — ${skillsDir} already had them`,
  );
  for (const s of result.skipped) {
    ctx.stdout(
      `Skipped "${s.name}": ${skillsDir}/${s.name} exists and was not installed by this package (use --force to replace)`,
    );
  }
  ctx.stdout(
    `Tenant contract range: ${manifest.tenantContractRange} (placeholder until the tenant contract route lands — CTC-1924)`,
  );
  if (previous && previous !== manifest.version) {
    const entry = parseChangelogEntry(readChangelog(), manifest.version);
    ctx.stdout(updateNoticeLine(previous, manifest.version, entry));
  }
  return 0;
}

function cmdInstall(args: ParsedArgs, ctx: Ctx): number {
  let cfg: CustomerConfig | null;
  try {
    cfg = loadConfig(ctx.home);
  } catch {
    cfg = null;
  }
  const skillsDir = resolveSkillsDir(args, ctx, cfg);
  const result = installSkills(skillsDir, { force: args.force });
  ctx.stdout(
    result.installed.length > 0
      ? `Skills installed to ${skillsDir}: ${result.installed.join(", ")}`
      : `No skills installed — ${skillsDir} already had them`,
  );
  for (const s of result.skipped) {
    ctx.stdout(
      `Skipped "${s.name}": ${skillsDir}/${s.name} exists and was not installed by this package (use --force to replace)`,
    );
  }
  return 0;
}

function cmdStatus(ctx: Ctx, manifest: Manifest): number {
  const cfg = loadConfig(ctx.home);
  if (!cfg) {
    ctx.stdout(`Not joined yet — run: npx ${PACKAGE_NAME} join --key <your account key>`);
    return 0;
  }
  ctx.stdout(`Tenant: ${cfg.name} (${cfg.slug}) — account ${cfg.account}`);
  ctx.stdout(`API: ${cfg.baseUrl} (principal: ${cfg.principal})`);
  ctx.stdout(
    `Bundle: ${PACKAGE_NAME} ${manifest.version} (tenant contract range: ${manifest.tenantContractRange})`,
  );
  return 0;
}
