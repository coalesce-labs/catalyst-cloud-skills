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
import { latestPublishedVersion, type PublishedLookup } from "./published.js";
import { replicaStatus, writerIsRunning, type ReplicaStatus } from "./replica.js";
import { loadSdk } from "./sdk.js";
import { semverOlder } from "./semver.js";
import { FIRST_STAMPED_VERSION } from "./skill-shape.js";
import { installedBundleVersion } from "./skills.js";

export { semverOlder };

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
  /** The replica document `replica status --json` prints, so `ready --json` carries the writer's
   *  stopped state, failure count and last error without a second shape to keep in step. */
  replica: ReplicaStatus;
}

/** `ready`'s own wording for the replica. It never recommends adopting the replica — until the
 *  mirror's snapshot path is safe for a large tenant, a customer following that advice is the
 *  failure mode. It DOES name the restart command when the writer gave up, because that is an
 *  instruction about a thing already running, not a nudge to adopt one (CTC-2499). */
function readyReplicaLine(s: ReplicaStatus): string {
  const w = s.writer;
  if (w?.stopped) {
    return (
      `replica: the writer stopped ${new Date(w.stopped.at).toISOString()}: ${w.stopped.reason} ` +
      `(last error: ${w.lastError}) — the replica is optional and every read ` +
      `still works through the API; restart it with: ${w.stopped.restartWith}`
    );
  }
  if (w && w.consecutiveFailures > 0) {
    // Present tense only for a writer that is actually running: the record survives a SIGKILL, and
    // "is backing off" about a dead process promises a retry that will never come (CTC-2499).
    if (!writerIsRunning(s)) {
      return `replica: the writer recorded ${w.consecutiveFailures} failed snapshot pulls and is no longer running (last error: ${w.lastError}) — the replica is optional and every read still works through the API`;
    }
    return `replica: the writer has failed ${w.consecutiveFailures} snapshot pulls in a row and is backing off (last error: ${w.lastError}) — reads fall back to the API`;
  }
  switch (s.verdict) {
    case "not-configured":
      return "replica: not configured — run login first";
    case "absent":
      return `replica: absent at ${s.dbPath} — optional, and off by default for large tenants while the snapshot path is being made safe; every read works through the API`;
    case "fresh":
      return `replica: fresh at ${s.dbPath} (cursor ${s.cursor}, heartbeat ${s.heartbeatAgeMs}ms ago${s.lag !== undefined ? `, ${s.lag} behind head ${s.head}` : ""})`;
    case "stale":
      return `replica: stale at ${s.dbPath} (${s.reasons.join("; ")}${s.cursor !== null ? `; cursor ${s.cursor}` : ""}) — reads fall back to the API`;
  }
}

export interface ReadyDeps {
  nodeMajor?: number;
  skillNames: readonly string[];
  /** Test seam for the SDK-loads check. */
  loadSdk?: () => Promise<unknown>;
  /** Test seam for the published-release lookup (CTC-2160). NO test may reach the real registry. */
  fetchLatestRelease?: () => Promise<PublishedLookup>;
  /** Skip the published-release lookup entirely (--offline / CATALYST_SKILLS_OFFLINE=1). */
  offline?: boolean;
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
        ? {
            id: "config",
            ok: true,
            // `principal` is "service" for every api key (it means "a key, not a browser session"); it
            // never names a person. Since CTC-2076 a personal key's /me carries a `user` block, so name
            // the connected person when there is one, and fall back to the account for a host key.
            line: cfg.user
              ? `config: joined ${cfg.name} as ${cfg.user.label} (${cfg.user.role})`
              : `config: joined ${cfg.name} (${cfg.slug}) as ${cfg.principal}`,
          }
        : { id: "config", ok: false, line: "config: not connected", fix: "npx @catalyst-cloud/catalyst-skills login (keyless; or pass --key / set CATALYST_CLOUD_TOKEN)", who: "you (approve the login in your browser)" },
    );
  } catch (err) {
    checks.push({ id: "config", ok: false, line: `config: ${err instanceof CliError ? err.message : String(err)}`, fix: "re-run login to rewrite it", who: "you" });
  }

  const cache = readContractCache(ctx.home);
  const range = readManifest().tenantContractRange;
  if (!cache) {
    checks.push({ id: "contract", ok: false, line: "contract: not cached", fix: "catalyst-skills contract --refresh", who: "you" });
  } else if (contractVersionInRange(cache.contractVersion, range) !== true) {
    checks.push({ id: "contract", ok: false, line: `contract: version ${cache.contractVersion} is outside this bundle's range ${range}`, fix: "npm install -g @catalyst-cloud/catalyst-skills@latest && catalyst-skills login", who: "you" });
  } else {
    checks.push({ id: "contract", ok: true, line: `contract: ${cache.contractVersion} cached ${cache.fetchedAt} (range ${range})` });
  }

  // The cloud MAY publish the bundle it expects (catalyst-cloud#3746). Read it defensively: warn (never
  // refuse) when this installed bundle is older than the minimum, and emit nothing when the field is
  // absent (an older cloud) — a stale bundle is a degrading note, so `ready` still returns READY.
  const minVersion = cache?.doc.skillsBundle?.minVersion;
  if (minVersion) {
    const installed = readManifest().version;
    if (semverOlder(installed, minVersion)) {
      checks.push({
        id: "bundle",
        ok: false,
        note: true,
        line: `bundle: ${installed} installed is older than the tenant's minimum ${minVersion} — upgrade: npm install -g @catalyst-cloud/catalyst-skills@latest && catalyst-skills login`,
      });
    }
  }

  // CTC-2160 — the two artefacts a customer installs drift apart: the CLI comes from npm, the skill
  // files come from `npx skills add` (GitHub) or the plugin, and only the CLI's own version was ever
  // knowable here. Both are NOTES: being behind a publish is a degrading fact about an install that
  // still works, so `ready` stays READY. This is the one place `ready` touches the network, and it is
  // capped, cached and skippable — see src/published.ts.
  const skillsDir = cfg?.skillsDir ?? defaultSkillsDirFor(ctx.home);
  const offline = deps.offline === true || ctx.env.CATALYST_SKILLS_OFFLINE === "1";
  if (!offline) {
    const pub = await (deps.fetchLatestRelease ?? (() => latestPublishedVersion(ctx)))();
    if (pub.latest === null) {
      checks.push({
        id: "cliRelease",
        ok: false,
        note: true,
        line: `cliRelease: could not check for a newer release (${pub.reason}) — nothing about this install is known to be wrong; re-run when the network is back`,
      });
    } else {
      // clause 2 — the CLI. Suppressed when the tenant-minimum note already named this binary (D9).
      const installedCli = readManifest().version;
      const bundleNoteFired = checks.some((c) => c.id === "bundle");
      if (!bundleNoteFired && semverOlder(installedCli, pub.latest)) {
        checks.push({
          id: "cliRelease",
          ok: false,
          note: true,
          line: `cliRelease: ${installedCli} installed is older than the latest published ${pub.latest} — upgrade: npm install -g @catalyst-cloud/catalyst-skills@latest && catalyst-skills login`,
        });
      }
      // clause 1 — the skill files on disk, read independently of whichever CLI is answering. Both
      // facts can hold at once: a machine that pulled at different hours carries some skills stamped
      // behind AND some old enough to carry no stamp at all — the field report's own mixed install.
      // So they are ADDITIVE, not exclusive: an unstamped file's real version is unknown and may be
      // older than any stamp, which is why the stamped half says "oldest STAMPED" and the unstamped
      // names are always printed rather than hidden behind whichever branch happened to win.
      const found = installedBundleVersion(skillsDir, deps.skillNames);
      const stampBehind = found.version !== null && semverOlder(found.version, pub.latest);
      const unstampedBehind = found.unstamped.length > 0 && !semverOlder(pub.latest, FIRST_STAMPED_VERSION);
      if (stampBehind || unstampedBehind) {
        const facts: string[] = [];
        if (stampBehind) facts.push(`the oldest stamped skill is ${found.version} (${found.skill})`);
        if (unstampedBehind) {
          const one = found.unstamped.length === 1;
          facts.push(
            `${found.unstamped.join(", ")} ${one ? "carries" : "carry"} no version and so ${one ? "predates" : "predate"} ${FIRST_STAMPED_VERSION}`,
          );
        }
        checks.push({
          id: "skillsRelease",
          ok: false,
          note: true,
          line: `skillsRelease: in ${skillsDir} ${facts.join(", and ")}, while the published bundle is ${pub.latest} — update: npx skills update -y`,
        });
      }
    }
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
  checks.push({ id: "replica", ok: replica.verdict === "fresh", note: true, line: readyReplicaLine(replica) });

  if (cache) {
    const doc = cache.doc;
    const who = whoCanAnswer(doc);
    for (const team of doc.teams) {
      const label = team.key ?? team.id;
      // The team's dispatch gate, straight off the cached contract: an older cloud omits it and this
      // emits nothing (the `skillsBundle` precedent above). A shut gate means NOTHING in the team can
      // start, so it is a FAIL carrying the cloud's own remedy as the fix — never an informational
      // note. It is emitted before the `unchecked` branch below so a team whose readiness was never
      // checked still reports its gate, which is exactly the team most likely to be unmapped.
      const dg = team.dispatchGate;
      if (dg && typeof dg.status === "string") {
        const slots = (dg.missingSlots ?? []).join(", ");
        checks.push(
          dg.status === "open"
            ? { id: `team:${label}:dispatchGate`, ok: true, line: `team ${label}: dispatch gate open` }
            : {
                id: `team:${label}:dispatchGate`,
                ok: false,
                line: `team ${label}: dispatch gate ${dg.status}${slots ? ` (${slots})` : ""}, blocking`,
                fix: dg.remedy ?? `open settings for team ${label} and map its stages`,
                who,
              },
        );
      }
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
  return { ready, checks, replica };
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
