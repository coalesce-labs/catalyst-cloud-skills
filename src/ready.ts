// ready.ts — `ready`: the machine checks plus the tenant's own readiness vector from the contract,
// one verdict, and per failure the fix and who can apply it. The replica is optional, so its absence
// is a note, never a failure; the SDK loading IS a check, because the replica and watch need it.
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import type { ParsedArgs } from "./args.js";
import { LEGACY_PACKAGE_NAME, PACKAGE_NAME, defaultSkillsDirFor, loadConfig, readManifest, upgradeCommand, type Ctx, type CustomerConfig } from "./config.js";
import { contractVersionInRange, readContractCache } from "./contract.js";
import type { ContractReadinessCheck, TenantContract } from "./contract-types.js";
import { CliError } from "./errors.js";
import { latestPublishedVersion, type PublishedLookup } from "./published.js";
import { readUserNames, replicaStatus, writerIsRunning, type ReplicaStatus } from "./replica.js";
import { LINEAR_AUTOMATION_RULES, checkFix, checkSentence } from "./readiness-copy.js";
import { loadSdk } from "./sdk.js";
import { FIX_COMMAND, detectRuntime, runtimeVerdict, supportedRangeText, type RuntimeFacts } from "./runtime.js";
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
  /** CTC-4398: the Linear user ids `who` names, for a reader that needs the identity, not the words. */
  whoIds?: string[];
}

export interface ReadyReport {
  ready: boolean;
  /** CTC-4398: every check that is not a team check passes (or is a note). With `ready` false this
   *  means only team steps remain, which the human verdict says; `ready` and the exit code keep
   *  their meaning. */
  machineReady: boolean;
  /** Failing team checks: the steps left for the account's owners and admins. */
  teamStepsLeft: number;
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
      return `replica: absent at ${s.dbPath}. It is optional, and off by default for large accounts while the snapshot path is being made safe; every read works through the API`;
    case "fresh":
      return `replica: fresh at ${s.dbPath} (cursor ${s.cursor}, heartbeat ${s.heartbeatAgeMs}ms ago${s.lag !== undefined ? `, ${s.lag} behind head ${s.head}` : ""})`;
    case "stale":
      return `replica: stale at ${s.dbPath} (${s.reasons.join("; ")}${s.cursor !== null ? `; cursor ${s.cursor}` : ""}) — reads fall back to the API`;
  }
}

/** The first executable file called `name` on `env.PATH`, or null. */
export function firstOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here, or not executable: keep looking, as a shell would
    }
  }
  return null;
}

/** True when `path` resolves to the `catalyst` launcher of this CLI or of its forwarder package. */
export function isThisCliLauncher(path: string): boolean {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  if (basename(real) !== "catalyst.js" || basename(dirname(real)) !== "bin") return false;
  try {
    const raw = JSON.parse(readFileSync(join(dirname(dirname(real)), "package.json"), "utf8")) as { name?: unknown };
    return raw.name === PACKAGE_NAME || raw.name === LEGACY_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * CTC-3479 — the name `catalyst` is also the catalyst-dev router, which install-cli.sh links into
 * ~/.catalyst/bin and puts at the front of PATH. Where it wins, `catalyst ready` runs the router, not
 * this CLI. `ready` cannot fix that, but it can say so: a note (never a failure, because
 * `catalyst-skills` still reaches this CLI) naming the program that answers to `catalyst`. Nothing
 * on PATH is normal while the old name is still the one installed, so that emits nothing. POSIX
 * only: on Windows npm installs `.cmd` shims, and PATHEXT lookup is not worth guessing at here.
 */
export function catalystCommandCheck(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): ReadyCheck | null {
  if (platform === "win32") return null;
  const found = firstOnPath("catalyst", env);
  if (found === null) return null;
  if (isThisCliLauncher(found)) return { id: "command", ok: true, line: `command: catalyst on PATH is this CLI (${found})` };
  return {
    id: "command",
    ok: false,
    note: true,
    line:
      `command: catalyst on PATH is ${found}, a different program with the same name, so \`catalyst <verb>\` does not reach this CLI. ` +
      "Keep using catalyst-skills on this machine, or put the npm global bin directory ahead of that one on PATH.",
  };
}

export interface ReadyDeps {
  /** CTC-2158: replaces `nodeMajor`. A check called `node` cannot honestly describe bun, and under
   *  bun it used to print bun's Node-*compat* major as if it were Node. Test seam; defaults to the
   *  real process's runtime. */
  runtime?: RuntimeFacts;
  skillNames: readonly string[];
  /** Test seam for the SDK-loads check. */
  loadSdk?: () => Promise<unknown>;
  /** Test seam for the published-release lookup (CTC-2160). NO test may reach the real registry. */
  fetchLatestRelease?: () => Promise<PublishedLookup>;
  /** Skip the published-release lookup entirely (--offline / CATALYST_SKILLS_OFFLINE=1). */
  offline?: boolean;
  /** Test seam: Linear user id to name. Defaults to the replica's `users` table when one exists. */
  userNames?: (ids: readonly string[]) => ReadonlyMap<string, string>;
}

function nameList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((n): n is string => typeof n === "string" && n.length > 0) : [];
}

/** Entries whose name and references are both present; anything malformed is dropped, not guessed. */
function unresolvedList(v: unknown): { name: string; references: string[] }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((u) => {
    if (typeof u !== "object" || u === null) return [];
    const { name, references } = u as { name?: unknown; references?: unknown };
    const refs = nameList(references);
    return typeof name === "string" && name.length > 0 && refs.length > 0 ? [{ name, references: refs }] : [];
  });
}

function unresolvedLine(u: { name: string; references: string[] }): string {
  const which = u.references.length === 1 ? "which has" : "which have";
  return `${u.name} references ${u.references.join(", ")}, ${which} no value; the checkout refuses it before work starts`;
}

/** A team check's fix line. A check that carries `names` (CTC-3561: `required_values`, contract
 *  1.24.0) names them and where to set them. CTC-3606: it also names each `unresolved` variable and
 *  the reference with no value, and each other repository's missing names from `repos[]`. `unresolved`
 *  is a subset of `names` (the variable exists; its reference does not), so those are not told to be
 *  "set". Every field is optional so an older cloud still works. Everything printed is a declared
 *  identifier or a repository name, never a value, and nothing here reads a value. Any other check
 *  gets its plain fix from readiness-copy.ts plus the contract's settings page, when it names one. */
function teamCheckFix(label: string, c: ContractReadinessCheck, settingsUrl: string | null): string {
  const unresolved = unresolvedList(c.unresolved);
  const unresolvedNames = new Set(unresolved.map((u) => u.name));
  const names = nameList(c.names).filter((n) => !unresolvedNames.has(n));
  const parts: string[] = [];
  if (names.length > 0) {
    parts.push(
      `set ${names.join(", ")} on the repository's Environment page under Settings → Repositories ` +
        `(team ${label}; ${names.length === 1 ? "it has" : "they have"} no value at repository or account scope)`,
    );
  }
  for (const u of unresolved) parts.push(unresolvedLine(u));
  for (const note of Array.isArray(c.repos) ? c.repos : []) {
    if (typeof note !== "object" || note === null || typeof note.repo !== "string" || note.repo.length === 0) continue;
    const repoUnresolved = unresolvedList(note.unresolved);
    const skip = new Set(repoUnresolved.map((u) => u.name));
    const missing = nameList(note.names).filter((n) => !skip.has(n));
    if (missing.length > 0) parts.push(`${note.repo} is missing ${missing.join(", ")}`);
    for (const u of repoUnresolved) parts.push(`in ${note.repo}, ${unresolvedLine(u)}`);
  }
  if (parts.length > 0) return parts.join(". ");
  const plain = checkFix(c, label) ?? `Open Catalyst settings for team ${label}.`;
  if (settingsUrl === null) return plain;
  return c.id in LINEAR_AUTOMATION_RULES ? `${plain} Then re-check the team at ${settingsUrl}.` : `${plain} Page: ${settingsUrl}.`;
}

/** The account's display name without the cloud's internal numbering ("Acme (tenant #0)" → "Acme"). */
export function accountLabel(name: string): string {
  return name.replace(/\s*\((?:tenant|account)\s*#\d+\)\s*$/i, "").trim() || name;
}

export interface WhoCanAnswer {
  who: string;
  whoIds: string[];
}

function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/**
 * CTC-4398: the contract's owners and admins, in words. The contract carries only a Linear user id
 * and a role, so a person is "you" when the id is the signed-in person's, their name when the
 * replica knows it, and otherwise their role alone. A bare id is never printed.
 */
export function whoCanAnswer(
  humans: TenantContract["humans"],
  me: { linearUserId: string | null } | undefined,
  names: ReadonlyMap<string, string>,
): WhoCanAnswer {
  const words: string[] = [];
  for (const h of humans) {
    const role = h.role === "owner" ? "an owner" : "an admin";
    const w = me?.linearUserId && h.linearUserId === me.linearUserId ? "you" : names.has(h.linearUserId) ? `${names.get(h.linearUserId)} (${h.role})` : role;
    if (!words.includes(w)) words.push(w);
  }
  words.sort((a, b) => (a === "you" ? -1 : b === "you" ? 1 : 0));
  return {
    who: words.length > 0 ? joinOr(words) : "an owner or admin of your Catalyst account (the contract names none)",
    whoIds: humans.map((h) => h.linearUserId),
  };
}

export async function readyReport(ctx: Ctx, deps: ReadyDeps): Promise<ReadyReport> {
  const checks: ReadyCheck[] = [];
  const facts = deps.runtime ?? detectRuntime();
  const verdict = runtimeVerdict(facts, readManifest().enginesNode);
  checks.push({
    id: "runtime",
    ok: verdict.supported,
    line: verdict.line,
    ...(verdict.supported ? {} : { fix: verdict.fix, who: "you" }),
  });

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
            // CTC-4398: the account's name as a person knows it, without the cloud's "(tenant #0)".
            line: cfg.user
              ? `config: joined ${accountLabel(cfg.name)} as ${cfg.user.label} (${cfg.user.role})`
              : `config: joined ${accountLabel(cfg.name)} (${cfg.slug}) as ${cfg.principal}`,
          }
        : { id: "config", ok: false, line: "config: not connected", fix: "npx -p @catalyst-cloud/cli catalyst login (keyless; or pass --key / set CATALYST_CLOUD_TOKEN)", who: "you (approve the login in your browser)" },
    );
  } catch (err) {
    checks.push({ id: "config", ok: false, line: `config: ${err instanceof CliError ? err.message : String(err)}`, fix: "re-run login to rewrite it", who: "you" });
  }

  const cache = readContractCache(ctx.home);
  const range = readManifest().tenantContractRange;
  if (!cache) {
    checks.push({ id: "contract", ok: false, line: "contract: not cached", fix: "catalyst contract --refresh", who: "you" });
  } else if (contractVersionInRange(cache.contractVersion, range) !== true) {
    checks.push({ id: "contract", ok: false, line: `contract: version ${cache.contractVersion} is outside this bundle's range ${range}`, fix: upgradeCommand(), who: "you" });
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
        line: `bundle: ${installed} installed is older than the minimum ${minVersion} your Catalyst account expects; upgrade: ${upgradeCommand()}`,
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
          line: `cliRelease: ${installedCli} installed is older than the latest published ${pub.latest} — upgrade: ${upgradeCommand()}`,
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

  const command = catalystCommandCheck(ctx.env);
  if (command) checks.push(command);

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
    checks.push({ id: "skills", ok: false, line: `skills: ${present.length} of ${deps.skillNames.length} in ${skillsDir}, missing ${missing.join(", ")}`, fix: "catalyst install", who: "you" });
  }

  try {
    await (deps.loadSdk ?? loadSdk)();
    checks.push({ id: "sdk", ok: true, line: "sdk: loads (replica and watch are available)" });
  } catch (err) {
    checks.push({
      id: "sdk",
      ok: false,
      line: `sdk: ${err instanceof Error ? err.message : String(err)}`,
      fix: `${verdict.fix ?? FIX_COMMAND} — supported: ${supportedRangeText(readManifest().enginesNode)}; every read still works through the API meanwhile`,
      who: "you",
    });
  }

  const replica = replicaStatus(ctx, cfg);
  checks.push({ id: "replica", ok: replica.verdict === "fresh", note: true, line: readyReplicaLine(replica) });

  if (cache) {
    const doc = cache.doc;
    const ids = doc.humans.map((h) => h.linearUserId);
    const names = deps.userNames ? deps.userNames(ids) : replica.dbPath !== null ? readUserNames(replica.dbPath, ids) : new Map<string, string>();
    const { who, whoIds } = whoCanAnswer(doc.humans, cfg?.user, names);
    const origin = cfg?.baseUrl ? cfg.baseUrl.replace(/\/+$/, "") : null;
    for (const team of doc.teams) {
      const label = team.key ?? team.id;
      // CTC-4398: a mirror that keeps an archived team on the contract marks it; nobody works there.
      if (team.archived === true) {
        checks.push({ id: `team:${label}`, ok: true, note: true, line: `team ${label} is archived; skipped` });
        continue;
      }
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
                whoIds,
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
        const settingsUrl = origin !== null && typeof meta?.settingsPath === "string" && meta.settingsPath.startsWith("/") ? `${origin}${meta.settingsPath}` : null;
        // CTC-4398: one plain sentence per check. A proposed declaration is a note, and a note prints
        // no fix line, so the sentence itself says who approves it and where.
        let line = `team ${label}: ${checkSentence(c)}`;
        if (c.id === "environment_declared" && c.reason === "declaration_awaiting_approval" && c.state === "fail") {
          const repo = typeof team.repositories?.default === "string" && team.repositories.default !== "" ? team.repositories.default : "the repository";
          line =
            `team ${label}: the environment declaration for ${repo} waits for approval by ${who}. ` +
            `Open Settings → Repositories → ${repo} → Environment, go to the Setup declaration tab, and press Approve this revision.`;
        }
        checks.push({
          id: `team:${label}:${c.id}`,
          ok: !needsAnswer && c.state !== "fail",
          note: !needsAnswer,
          line,
          fix: teamCheckFix(label, c, settingsUrl),
          who: needsAnswer ? who : "nobody yet; it is informational",
          ...(needsAnswer ? { whoIds } : {}),
        });
      }
      if (bad.length === 0 && team.readiness.status !== "ready") {
        checks.push({
          id: `team:${label}`,
          ok: team.readiness.status !== "blocked",
          note: team.readiness.status === "degraded",
          line: `team ${label}: ${team.readiness.status}`,
          fix: `Open Catalyst settings for team ${label} and press Re-check.`,
          who,
          whoIds,
        });
      }
    }
  }

  const ready = checks.every((c) => c.ok || c.note);
  const isTeam = (c: ReadyCheck): boolean => c.id.startsWith("team:");
  const machineReady = checks.filter((c) => !isTeam(c)).every((c) => c.ok || c.note);
  const teamStepsLeft = checks.filter((c) => isTeam(c) && !c.ok && !c.note).length;
  return { ready, machineReady, teamStepsLeft, checks, replica };
}

/** The human verdict line. `ready` false with a ready machine means only team steps remain, and
 *  saying NOT READY there sent people hunting for a machine fault that was not there (CTC-4398). */
export function verdictLine(report: Pick<ReadyReport, "ready" | "machineReady" | "teamStepsLeft">): string {
  if (report.ready) return "READY";
  if (!report.machineReady) return "NOT READY";
  const n = report.teamStepsLeft;
  return `READY: this machine is set up. ${n} team ${n === 1 ? "step" : "steps"} left.`;
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
    ctx.stdout(verdictLine(report));
  }
  return report.ready ? 0 : 1;
}
