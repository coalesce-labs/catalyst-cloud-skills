// cli.ts — the `catalyst-skills` dispatcher (npm: @catalyst-cloud/catalyst-skills). Verbs live in
// their own modules; this file keeps every export the 0.1 tests and the bin import.
import { existsSync } from "node:fs";
import { parseArgs, positionals, verbHelp, type ParsedArgs } from "./args.js";
import {
  CONFIG_MODE,
  DEFAULT_BASE_URL,
  PACKAGE_NAME,
  cliPath,
  configPathFor,
  contractPathFor,
  defaultCtx,
  defaultReplicaDbFor,
  defaultSkillsDirFor,
  formatMode,
  loadConfig,
  normalizeBaseUrl,
  readManifest,
  requireConfig,
  saveConfig,
  writeConfig,
  type Ctx,
  type CustomerConfig,
  type MeIdentity,
} from "./config.js";
import { loadContract, pickPath } from "./contract.js";
import { CliError, MeError, UsageError } from "./errors.js";
import { fetchMe } from "./http.js";
import { cmdAccounts, cmdExplain, cmdQueue, cmdRunning } from "./execution.js";
import { cmdQuery } from "./query.js";
import { cmdReady } from "./ready.js";
import { cmdReplica, type ReplicaDeps } from "./replica.js";
import { PROVENANCE_MARKER } from "./skill-shape.js";
import { installSkills, parseChangelogEntry, readChangelog, resolveSkillsDir, skillsSourceDir, updateNoticeLine, type SkillsInstallResult } from "./skills.js";
import { cmdWatch, type WatchDeps } from "./watch.js";
import { cmdWrite, type WriteDeps } from "./write.js";
import { cmdAsk } from "./ask.js";

export {
  CONFIG_MODE,
  DEFAULT_BASE_URL,
  PACKAGE_NAME,
  PROVENANCE_MARKER,
  CliError,
  MeError,
  UsageError,
  configPathFor,
  contractPathFor,
  defaultCtx,
  defaultReplicaDbFor,
  defaultSkillsDirFor,
  fetchMe,
  formatMode,
  installSkills,
  loadConfig,
  normalizeBaseUrl,
  parseArgs,
  parseChangelogEntry,
  readChangelog,
  readManifest,
  resolveSkillsDir,
  saveConfig,
  skillsSourceDir,
  updateNoticeLine,
  writeConfig,
};
export type { Ctx, CustomerConfig, MeIdentity, ParsedArgs, SkillsInstallResult };

export const CUSTOMER_SKILLS = [
  "am-i-set-up",
  "catalyst-github",
  "catalyst-linear",
  "how-catalyst-works",
  "join",
  "run-this-project",
  "what-needs-me",
  "whats-happening",
] as const;

/** `login` is the name the skills print for the connect step; it is the same verb as `join`. */
const VERB_ALIASES: Record<string, string> = { login: "join" };

/** Verbs whose stdout is for a human, so the update notice may share it. Every other verb's stdout
 *  is machine-read by a skill script and the notice goes to stderr. */
const HUMAN_VERBS = new Set(["join", "install", "status", "notice"]);

export function usageText(): string {
  return [
    `${PACKAGE_NAME} — the Catalyst Cloud customer CLI: join your tenant, read through the SDK, write through the agent proxy`,
    "",
    "Usage:",
    "  catalyst-skills join [--key <account-key>] [--base-url <url>] [--skills-dir <dir>] [--start-replica]   (alias: login)",
    "  catalyst-skills install [--skills-dir <dir>] [--force]",
    "  catalyst-skills status | notice | me | ready | accounts",
    "  catalyst-skills contract [--refresh] [--path <a.b.c>]",
    "  catalyst-skills query <issues|issue <id>|pulls|pull <id>|projects|cycles|search <terms>|changes --since <n>>",
    "  catalyst-skills replica <start [--detach]|stop|status [--probe]|sql \"<select>\"|schema [table]>",
    "  catalyst-skills explain <ticket> | running | queue [--team K]",
    "  catalyst-skills watch [--team K] [--ticket T]... [--project P] [--exec CMD]",
    "  catalyst-skills write <comment|state|label|create|reaction|attachment|session> ...",
    "  catalyst-skills ask <raise|accept|list> ...",
    "",
    "Every verb takes --help. --json makes the output machine-readable.",
    "",
    "The key may also come from CATALYST_CLOUD_TOKEN; the base URL defaults to",
    `CATALYST_CLOUD_BASE_URL or ${DEFAULT_BASE_URL}.`,
    "",
    "join calls GET /api/v1/me to discover your tenant from the key alone, installs the skills",
    "(default ~/.claude/skills), writes ~/.config/catalyst-cloud/customer.json (0600) with the key",
    "and this CLI's path, and caches the tenant contract beside it.",
  ].join("\n");
}

export interface MainDeps {
  replica?: ReplicaDeps;
  watch?: WatchDeps;
  write?: WriteDeps;
  loadSdk?: () => Promise<unknown>;
}

/**
 * The Tier-2 update path: when the bundle on disk is newer than the version the config last
 * recorded, refresh the copied skills FIRST and record the new version only once that succeeded.
 */
function maybePrintUpdateNotice(args: ParsedArgs, ctx: Ctx): void {
  const say = HUMAN_VERBS.has(args.command ?? "") ? ctx.stdout : ctx.stderr;
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
    say(updateNoticeLine(previous, manifest.version, entry));
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
  if (refreshed.installed.length > 0) say(`[catalyst-skills] refreshed ${refreshed.installed.join(", ")} at ${skillsDir} to ${manifest.version}`);
  for (const s of refreshed.skipped) {
    say(`[catalyst-skills] left "${s.name}" alone: ${skillsDir}/${s.name} was not installed by this package (catalyst-skills install --force to replace)`);
  }
  cfg.lastSkillBundleVersion = manifest.version;
  cfg.skillsDir = skillsDir;
  saveConfig(ctx.home, cfg);
}

export async function main(argv: string[], ctx: Ctx = defaultCtx(), deps: MainDeps = {}): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv.map((a, i) => (i === 0 && VERB_ALIASES[a] ? VERB_ALIASES[a] : a)));
    if (args.command && VERB_ALIASES[args.command]) args.command = VERB_ALIASES[args.command];
  } catch (err) {
    ctx.stderr(err instanceof Error ? err.message : String(err));
    ctx.stderr(usageText());
    return 1;
  }
  const manifest = readManifest();
  if (args.version) {
    ctx.stdout(`${PACKAGE_NAME} ${manifest.version} (tenant contract range: ${manifest.tenantContractRange})`);
    return 0;
  }
  if (args.command === null) {
    ctx.stdout(usageText());
    return 0;
  }
  if (args.help) {
    ctx.stdout(verbHelp(args.command));
    return 0;
  }
  try {
    maybePrintUpdateNotice(args, ctx);
    switch (args.command) {
      case "join":
        return await cmdJoin(args, ctx, deps);
      case "install":
        return cmdInstall(args, ctx);
      case "notice":
        return 0;
      case "status":
        return cmdStatus(ctx);
      case "me":
        return await cmdMe(args, ctx);
      case "contract":
        return await cmdContract(args, ctx);
      case "query":
        return await cmdQuery(args, ctx, { engineDeps: deps.replica?.engineDeps });
      case "replica":
        return await cmdReplica(args, ctx, deps.replica);
      case "explain":
        return await cmdExplain(args, ctx);
      case "running":
        return await cmdRunning(args, ctx);
      case "queue":
        return await cmdQueue(args, ctx);
      case "watch":
        return await cmdWatch(args, ctx, deps.watch);
      case "write":
        return await cmdWrite(args, ctx, deps.write);
      case "ask":
        return await cmdAsk(args, ctx);
      case "ready":
        return await cmdReady(args, ctx, { skillNames: CUSTOMER_SKILLS, loadSdk: deps.loadSdk });
      case "accounts":
        return cmdAccounts(ctx);
      default:
        ctx.stderr(`unknown command: ${args.command}`);
        ctx.stderr(usageText());
        return 1;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.stderr(err.message);
      ctx.stderr(args.command && args.command in VERB_HELP_KNOWN ? verbHelp(args.command) : usageText());
      return 1;
    }
    if (err instanceof CliError) {
      ctx.stderr(`catalyst-skills: ${err.message}`);
      return err.exitCode;
    }
    if (err instanceof MeError) {
      ctx.stderr(`catalyst-skills: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

const VERB_HELP_KNOWN: Record<string, true> = Object.fromEntries(
  ["join", "install", "status", "notice", "me", "contract", "query", "replica", "explain", "running", "queue", "watch", "write", "ask", "ready", "accounts"].map((v) => [v, true]),
);

async function cmdJoin(args: ParsedArgs, ctx: Ctx, deps: MainDeps): Promise<number> {
  const manifest = readManifest();
  const key = (args.key ?? ctx.env.CATALYST_CLOUD_TOKEN ?? "").trim();
  if (!key) throw new UsageError("join needs an account key: pass --key <account-key> or set CATALYST_CLOUD_TOKEN");
  const baseUrl = normalizeBaseUrl(args.baseUrl ?? ctx.env.CATALYST_CLOUD_BASE_URL ?? DEFAULT_BASE_URL);
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
    cliPath: cliPath(),
    replicaDb: existing?.replicaDb ?? defaultReplicaDbFor(ctx.home),
  };
  const written = writeConfig(ctx.home, config);
  ctx.stdout(`Joined ${me.name} (${me.slug}) — account ${me.account}`);
  ctx.stdout(
    `Config written to ${written.path} (mode ${formatMode(written.mode)}, holds your key and the CLI path)${
      written.mode === CONFIG_MODE ? "" : ` — expected ${formatMode(CONFIG_MODE)}; chmod it by hand`
    }`,
  );
  ctx.stdout(
    result.installed.length > 0
      ? `Skills installed to ${skillsDir}: ${result.installed.join(", ")}`
      : `No skills installed — ${skillsDir} already had them`,
  );
  for (const s of result.skipped) {
    ctx.stdout(`Skipped "${s.name}": ${skillsDir}/${s.name} exists and was not installed by this package (use --force to replace)`);
  }
  ctx.stdout(`Tenant contract range: ${manifest.tenantContractRange}`);
  try {
    const loaded = await loadContract(ctx, config, { refresh: true });
    ctx.stdout(`Tenant contract ${loaded.doc.contractVersion} cached at ${loaded.path}`);
  } catch (err) {
    if (err instanceof CliError && (err.code === "contract-forbidden" || err.code === "contract-version")) {
      ctx.stderr(`[catalyst-skills] ${err.message}`);
    } else {
      throw err;
    }
  }
  if (previous && previous !== manifest.version) {
    const entry = parseChangelogEntry(readChangelog(), manifest.version);
    ctx.stdout(updateNoticeLine(previous, manifest.version, entry));
  }
  if (args.flags["start-replica"] === true) {
    const code = await cmdReplica(parseArgs(["replica", "start", "--detach"]), ctx, {
      ...deps.replica,
      argv: deps.replica?.argv ?? [cliPath(), "replica", "start"],
    });
    if (code !== 0) return code;
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
    ctx.stdout(`Skipped "${s.name}": ${skillsDir}/${s.name} exists and was not installed by this package (use --force to replace)`);
  }
  return 0;
}

function cmdStatus(ctx: Ctx): number {
  const manifest = readManifest();
  const cfg = loadConfig(ctx.home);
  if (!cfg) {
    ctx.stdout(`Not joined yet — run: npx ${PACKAGE_NAME} join --key <your account key>`);
    return 0;
  }
  ctx.stdout(`Tenant: ${cfg.name} (${cfg.slug}) — account ${cfg.account}`);
  ctx.stdout(`API: ${cfg.baseUrl} (principal: ${cfg.principal})`);
  ctx.stdout(`Bundle: ${PACKAGE_NAME} ${manifest.version} (tenant contract range: ${manifest.tenantContractRange})`);
  if (cfg.cliPath) ctx.stdout(`CLI: ${cfg.cliPath}${existsSync(cfg.cliPath) ? "" : " (missing — re-run join)"}`);
  ctx.stdout(`Contract: ${existsSync(contractPathFor(ctx.home)) ? contractPathFor(ctx.home) : "not cached (run: catalyst-skills contract --refresh)"}`);
  return 0;
}

async function cmdMe(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const cfg = requireConfig(ctx);
  const me = await fetchMe(cfg.baseUrl, cfg.key, ctx.fetch);
  if (args.json) ctx.stdout(JSON.stringify(me));
  else {
    ctx.stdout(`${me.name} (${me.slug}) — account ${me.account}`);
    ctx.stdout(`principal: ${me.principal}; permissions: ${me.permissions ? me.permissions.join(", ") : "unrestricted"}`);
  }
  return 0;
}

async function cmdContract(args: ParsedArgs, ctx: Ctx): Promise<number> {
  const cfg = requireConfig(ctx);
  const [sub] = positionals(args);
  if (sub) throw new UsageError(`contract takes no positional argument (got "${sub}"); use --path <a.b.c>`);
  const refresh = args.flags.refresh === true;
  const loaded = await loadContract(ctx, cfg, { refresh });
  ctx.stderr(`contract: ${loaded.doc.contractVersion} from ${loaded.source}${loaded.source === "cache" ? ` (${loaded.ageSeconds}s old)` : ""}`);
  const path = typeof args.flags.path === "string" ? args.flags.path : undefined;
  const value = path ? pickPath(loaded.doc, path) : loaded.doc;
  if (path && value === undefined) throw new CliError(`the contract has nothing at "${path}"`, "contract-path");
  ctx.stdout(typeof value === "string" ? value : JSON.stringify(value, null, args.json ? 0 : 2));
  return 0;
}
