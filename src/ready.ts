// ready.ts — `ready`: the machine checks plus the tenant's own readiness vector from the contract,
// one verdict, and per failure the fix and who can apply it. The replica is optional, so its absence
// is a note, never a failure; the SDK loading IS a check, because the replica and watch need it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ParsedArgs } from "./args.js";
import { defaultSkillsDirFor, loadConfig, readManifest, type Ctx, type CustomerConfig } from "./config.js";
import { contractVersionInRange, readContractCache } from "./contract.js";
import type { TenantContract } from "./contract-types.js";
import { CliError } from "./errors.js";
import { replicaStatus, statusLine } from "./replica.js";
import { loadSdk } from "./sdk.js";

export interface ReadyCheck {
  id: string;
  ok: boolean;
  /** true when the check is informational and never flips the verdict. */
  note?: boolean;
  line: string;
  fix?: string;
  who?: string;
}

export interface ReadyReport {
  ready: boolean;
  checks: ReadyCheck[];
}

export interface ReadyDeps {
  nodeMajor?: number;
  skillNames: readonly string[];
  /** Test seam for the SDK-loads check. */
  loadSdk?: () => Promise<unknown>;
}

function whoCanAnswer(doc: TenantContract): string {
  const roles = doc.humans.map((h) => `${h.role} ${h.linearUserId}`);
  return roles.length ? roles.join(", ") : "a tenant owner or admin (none resolved on the contract)";
}

export async function readyReport(ctx: Ctx, deps: ReadyDeps): Promise<ReadyReport> {
  const checks: ReadyCheck[] = [];
  const nodeMajor = deps.nodeMajor ?? Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= 22
      ? { id: "node", ok: true, line: `node: ${nodeMajor} (22 or newer required)` }
      : { id: "node", ok: false, line: `node: ${nodeMajor} is too old`, fix: "install Node 22 or newer (the SDK's built-in SQLite engine needs it)", who: "you" },
  );

  let cfg: CustomerConfig | null = null;
  try {
    cfg = loadConfig(ctx.home);
    checks.push(
      cfg
        ? { id: "config", ok: true, line: `config: joined ${cfg.name} (${cfg.slug}) as ${cfg.principal}` }
        : { id: "config", ok: false, line: "config: not connected", fix: "CATALYST_CLOUD_TOKEN=<your personal key> npx @catalyst-cloud/catalyst-skills login", who: "you (mint the key at Settings → API keys)" },
    );
  } catch (err) {
    checks.push({ id: "config", ok: false, line: `config: ${err instanceof CliError ? err.message : String(err)}`, fix: "re-run login to rewrite it", who: "you" });
  }

  const cache = readContractCache(ctx.home);
  const range = readManifest().tenantContractRange;
  if (!cache) {
    checks.push({ id: "contract", ok: false, line: "contract: not cached", fix: "catalyst-skills contract --refresh", who: "you" });
  } else if (contractVersionInRange(cache.contractVersion, range) !== true) {
    checks.push({ id: "contract", ok: false, line: `contract: version ${cache.contractVersion} is outside this bundle's range ${range}`, fix: "npm update -g @catalyst-cloud/catalyst-skills", who: "you" });
  } else {
    checks.push({ id: "contract", ok: true, line: `contract: ${cache.contractVersion} cached ${cache.fetchedAt} (range ${range})` });
  }

  if (cfg) {
    checks.push(
      cfg.cliPath && existsSync(cfg.cliPath)
        ? { id: "cliPath", ok: true, line: `cliPath: ${cfg.cliPath}` }
        : { id: "cliPath", ok: false, line: `cliPath: ${cfg.cliPath ? `${cfg.cliPath} does not exist` : "not recorded"}`, fix: "re-run login so the skill scripts can find this CLI", who: "you" },
    );
  }

  // The skills are installed by the customer's own agent (a plugin, or `npx skills add`), so an
  // empty copy directory is the normal case and must not read as NOT READY. A PARTIAL copy is the
  // one broken state this check can see: half a set this package put there and never finished.
  const skillsDir = cfg?.skillsDir ?? defaultSkillsDirFor(ctx.home);
  const present = deps.skillNames.filter((n) => existsSync(join(skillsDir, n, "SKILL.md")));
  const missing = deps.skillNames.filter((n) => !present.includes(n));
  if (present.length === 0) {
    checks.push({ id: "skills", ok: true, note: true, line: `skills: none copied to ${skillsDir} — you are reading one, so your agent installed them its own way` });
  } else if (missing.length === 0) {
    checks.push({ id: "skills", ok: true, line: `skills: all ${deps.skillNames.length} present in ${skillsDir}` });
  } else {
    checks.push({ id: "skills", ok: false, line: `skills: ${present.length} of ${deps.skillNames.length} in ${skillsDir}, missing ${missing.join(", ")}`, fix: "catalyst-skills install", who: "you" });
  }

  try {
    await (deps.loadSdk ?? loadSdk)();
    checks.push({ id: "sdk", ok: true, line: "sdk: loads (replica and watch are available)" });
  } catch (err) {
    checks.push({ id: "sdk", ok: false, line: `sdk: ${err instanceof Error ? err.message : String(err)}`, fix: "run under Node 22.15 or newer (or bun); every read still works through the API meanwhile", who: "you" });
  }

  const replica = replicaStatus(ctx, cfg);
  checks.push({ id: "replica", ok: replica.verdict === "fresh", note: true, line: statusLine(replica) });

  if (cache) {
    const doc = cache.doc;
    const who = whoCanAnswer(doc);
    for (const team of doc.teams) {
      const label = team.key ?? team.id;
      if (team.readiness.status === "unchecked") {
        checks.push({ id: `team:${label}`, ok: true, note: true, line: `team ${label}: readiness not checked yet` });
        continue;
      }
      const bad = team.readiness.checks.filter((c) => c.state !== "pass");
      if (bad.length === 0 && team.readiness.status === "ready") {
        checks.push({ id: `team:${label}`, ok: true, line: `team ${label}: ready` });
        continue;
      }
      for (const c of bad) {
        const meta = doc.readinessChecks.find((r) => r.id === c.id);
        const needsAnswer = meta?.needsAnswer ?? true;
        checks.push({
          id: `team:${label}:${c.id}`,
          ok: !needsAnswer && c.state !== "fail",
          note: !needsAnswer,
          line: `team ${label}: ${c.id} is ${c.state}${c.reason ? ` (${c.reason}${c.count !== undefined ? ` ×${c.count}` : ""})` : ""}${meta ? `, ${meta.severity}` : ""}`,
          fix: `open settings for team ${label} and resolve ${c.id}`,
          who: needsAnswer ? who : "nobody yet; it is informational",
        });
      }
      if (bad.length === 0 && team.readiness.status !== "ready") {
        checks.push({ id: `team:${label}`, ok: team.readiness.status !== "blocked", note: team.readiness.status === "degraded", line: `team ${label}: ${team.readiness.status}`, fix: `open settings for team ${label}`, who });
      }
    }
  }

  const ready = checks.every((c) => c.ok || c.note);
  return { ready, checks };
}

export async function cmdReady(args: ParsedArgs, ctx: Ctx, deps: ReadyDeps): Promise<number> {
  const report = await readyReport(ctx, deps);
  if (args.json) {
    ctx.stdout(JSON.stringify(report));
  } else {
    for (const c of report.checks) {
      ctx.stdout(`${c.note ? "note" : c.ok ? "ok " : "FAIL"}  ${c.line}`);
      if (!c.ok && !c.note) {
        if (c.fix) ctx.stdout(`      fix: ${c.fix}`);
        if (c.who) ctx.stdout(`      who: ${c.who}`);
      }
    }
    ctx.stdout(report.ready ? "READY" : "NOT READY");
  }
  return report.ready ? 0 : 1;
}
