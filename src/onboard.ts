import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, join } from "node:path";
import { parseMachinePaths, resolveCatalystPath } from "../vendor/paths/index.js";
import { machinePathsFile } from "../vendor/paths/node.js";
import type { ParsedArgs } from "./args.js";
import type { Ctx } from "./config.js";
import { CliError, UsageError } from "./errors.js";

export const ONBOARD_STEPS = [
  "machine",
  "cli",
  "skills",
  "legacy",
  "signin",
  "linear.workspace",
  "linear.personal",
  "linear.team",
  "linear.adopt",
  "linear.automations",
  "github.install",
  "github.personal",
  "github.repos",
  "projects",
  "accounts",
  "settings",
  "values",
  "capacity",
  "daemon",
  "housekeeping",
  "first-ticket",
  "ready",
] as const;

export type OnboardStepId = (typeof ONBOARD_STEPS)[number];
export type OnboardStepState =
  "pending" | "running" | "done" | "skipped" | "failed" | "waiting";

export interface OnboardStep {
  id: OnboardStepId;
  state: OnboardStepState;
  at?: string;
  evidence?: Record<string, string | number | boolean | null>;
  reason?: string;
}

export interface OnboardJournal {
  schema: 1;
  runId: string;
  installer: string | null;
  cli: string;
  tenant: string | null;
  exit: number | null;
  scope?: "step" | "onboarding";
  mode?: "plan" | "run";
  complete?: boolean;
  localSync?: boolean;
  account?: string;
  membershipId?: string;
  baseUrl?: string;
  operations?: Partial<Record<OnboardStepId, string>>;
  steps: OnboardStep[];
  changes: Array<{ kind: string; label: string; undo: string }>;
}

export interface OnboardIdentity {
  account: string;
  membershipId: string;
  baseUrl: string;
  role: "owner" | "admin" | "member";
}

export interface OnboardStepResult {
  state: "done" | "skipped" | "pending" | "waiting" | "failed" | "refused";
  reason?: string;
  evidence?: OnboardStep["evidence"];
}

export interface OnboardAdapter {
  check: (ctx: Ctx, journal: OnboardJournal) => Promise<OnboardStepResult>;
  act?: (ctx: Ctx, journal: OnboardJournal) => Promise<OnboardStepResult>;
}

export interface OnboardDeps {
  adapters?: Partial<Record<OnboardStepId, OnboardAdapter>>;
  identity?: (journal?: OnboardJournal) => Promise<OnboardIdentity | null>;
  signal?: AbortSignal;
  bindSignals?: boolean;
  processId?: number;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => Date;
  token?: () => string;
  isTty?: () => boolean;
  confirm?: (question: string) => Promise<boolean>;
  /** Runs one implemented onboarding step. M1 registers the local legacy step; later slices add
   *  provider and project steps without changing the journal or resume contract. */
  runStep?: (
    id: OnboardStepId,
    ctx: Ctx,
  ) => Promise<{
    state: "done" | "skipped";
    evidence?: OnboardStep["evidence"];
  }>;
}

const EXIT_FAILED = 10;
const EXIT_WAITING = 11;
const EXIT_REFUSED = 12;
/** The bootstrap exports its actual state role so handoff cannot take a second lock. */
export function onboardStateRoot(home: string, env: NodeJS.ProcessEnv = {}): string {
  const bootstrap = env.CATALYST_INSTALL_STATE_DIR;
  if (bootstrap !== undefined) {
    if (!isAbsolute(bootstrap)) throw new CliError("bootstrap state directory must be absolute", "onboard-state-path", EXIT_REFUSED);
    return bootstrap;
  }
  try {
    const pathsFile = machinePathsFile({ env: { ...env, HOME: home } });
    const machine = pathsFile && existsSync(pathsFile)
      ? parseMachinePaths(JSON.parse(readFileSync(pathsFile, "utf8"))) : undefined;
    if (env.CATALYST_PATHS_FILE && !machine)
      throw new CliError("the selected machine paths file is missing", "onboard-state-path", EXIT_REFUSED);
    if (env.CATALYST_STATE_DIR !== undefined || machine)
      return resolveCatalystPath("state", { env, machine });
    return join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "catalyst");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("the selected setup paths are invalid; keep the file and correct it before resuming", "onboard-state-path", EXIT_REFUSED);
  }
}

export function onboardStatePath(home: string, env: NodeJS.ProcessEnv = {}): string {
  return join(onboardStateRoot(home, env), "install", "last-run.json");
}

export function onboardLockPath(home: string, env: NodeJS.ProcessEnv = {}): string {
  return join(onboardStateRoot(home, env), "install.lock");
}

export const ONBOARD_DEPENDENCIES: Partial<Record<OnboardStepId, readonly OnboardStepId[]>> = {
  "linear.workspace": ["signin"], "linear.personal": ["signin", "linear.workspace"],
  "linear.team": ["signin", "linear.workspace", "linear.personal"],
  "linear.adopt": ["linear.team"], "linear.automations": ["linear.team", "linear.personal"],
  "github.install": ["signin"], "github.personal": ["signin"], "github.repos": ["github.install"],
  projects: ["linear.team", "github.repos"], accounts: ["signin"], settings: ["projects"],
  values: ["settings"], capacity: ["projects"], daemon: ["signin"],
  "first-ticket": ["projects", "linear.adopt", "linear.automations", "accounts", "settings", "values", "capacity", "daemon"],
};

const ADMIN_STEPS = new Set<OnboardStepId>([
  "linear.workspace", "linear.team", "linear.adopt", "linear.automations", "github.install",
  "github.repos", "projects", "settings", "values", "capacity", "first-ticket",
]);

export const ONBOARD_TITLES: Record<OnboardStepId, string> = {
  machine: "Check this computer", cli: "Check the catalyst command", skills: "Check the Catalyst skills",
  legacy: "Remove earlier Catalyst installs", signin: "Sign in to Catalyst",
  "linear.workspace": "Connect your Linear workspace", "linear.personal": "Connect your Linear account",
  "linear.team": "Choose a Linear team", "linear.adopt": "Apply the Catalyst workflow",
  "linear.automations": "Check Linear's pull request automations", "github.install": "Install Catalyst on GitHub",
  "github.personal": "Connect your GitHub account",
  "github.repos": "Choose repositories", projects: "Register your projects", accounts: "Check coding accounts",
  settings: "Review repository settings", values: "Import selected local values", capacity: "Check runner capacity",
  daemon: "Check optional local sync", housekeeping: "Schedule the daily update",
  "first-ticket": "Start a first ticket", ready: "Check onboarding readiness",
};

function isoNow(ctx: Ctx, deps: OnboardDeps): string {
  return (deps.now ?? ctx.now)().toISOString();
}

function safeRead(path: string): unknown | null {
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new CliError(
        `the saved setup record at ${path} cannot be a symbolic link`,
        "onboard-state-symlink",
        EXIT_REFUSED,
      );
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value === null)
      throw new CliError("the saved setup record has an unknown shape; keep it and move it aside before trying again", "onboard-state-shape", EXIT_REFUSED);
    return value;
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (object(err)?.code === "ENOENT") return null;
    throw new CliError(
      `the saved setup record at ${path} is not valid JSON; keep it and move it aside before trying again`,
      "onboard-state-corrupt",
      EXIT_REFUSED,
    );
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapLegacyStep(id: unknown): OnboardStepId | null {
  if (typeof id !== "string") return null;
  const aliases: Record<string, OnboardStepId> = {
    folders: "machine",
    sign_in: "signin",
    login: "signin",
    housekeeping: "housekeeping",
    ready: "ready",
    daily_updates: "housekeeping",
    final_check: "ready",
  };
  const mapped = aliases[id] ?? id;
  return (ONBOARD_STEPS as readonly string[]).includes(mapped)
    ? (mapped as OnboardStepId)
    : null;
}

function normalizeStep(value: unknown, fallbackAt: string): OnboardStep | null {
  const row = object(value);
  if (!row) return null;
  const id = mapLegacyStep(row.id);
  if (!id) return null;
  const rawState = typeof row.state === "string" ? row.state : row.result;
  const states: Record<string, OnboardStepState> = {
    pending: "pending",
    running: "running",
    done: "done",
    already_done: "done",
    skipped: "skipped",
    failed: "failed",
    interrupted: "failed",
    not_approved: "waiting",
    needs_you: "waiting",
    waiting: "waiting",
  };
  const state = typeof rawState === "string" ? states[rawState] : undefined;
  if (!state) return null;
  const step: OnboardStep = { id, state };
  if (typeof row.at === "string") step.at = row.at;
  else if (typeof row.updatedAt === "string") step.at = row.updatedAt;
  else step.at = fallbackAt;
  if (
    typeof row.reason === "string" &&
    /^[a-z][a-z0-9_]{1,63}$/.test(row.reason)
  )
    step.reason = row.reason;
  const evidence = object(row.evidence);
  const safeEvidence: NonNullable<OnboardStep["evidence"]> = {};
  for (const key of [
    "principal",
    "role",
    "workspace",
    "found",
    "remaining",
    "count",
    "version", "account", "membershipId", "checkedAt", "project", "repository", "ticket",
    "cursor", "lag", "heartbeatAgeMs", "supervised", "streaming", "scheduled", "validated",
    "available", "phaseStarted", "linearComment", "fleetActivity", "requiredValues", "paused",
    "revision", "hash", "path", "provider", "scope", "checks", "passed",
  ] as const) {
    const item = evidence?.[key];
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    )
      safeEvidence[key] = item;
  }
  if (Object.keys(safeEvidence).length > 0) step.evidence = safeEvidence;
  return step;
}

/** Reads both the M1 journal and the 0.13.4 install-script receipt without discarding completed steps. */
export function readOnboardJournal(
  path: string,
  cliVersion = "0.13.1",
  now = new Date(),
): OnboardJournal | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  const value = object(raw);
  if (!value || !Array.isArray(value.steps))
    throw new CliError(
      `the saved setup record at ${path} has an unknown shape; keep it and move it aside before trying again`,
      "onboard-state-shape",
      EXIT_REFUSED,
    );
  if (value.schema !== 1 && value.schema !== "catalyst-install-last-run/1")
    throw new CliError("the saved setup record uses an unsupported version; keep it before trying again", "onboard-state-version", EXIT_REFUSED);
  const startedAt =
    typeof value.startedAt === "string" ? value.startedAt : now.toISOString();
  const steps = value.steps
    .map((row) => normalizeStep(row, startedAt))
    .filter((row): row is OnboardStep => row !== null);
  const deduped = new Map<OnboardStepId, OnboardStep>();
  for (const step of steps) deduped.set(step.id, step);
  const state = typeof value.state === "string" ? value.state : null;
  const exit =
    typeof value.exit === "number"
      ? value.exit
      : typeof value.exitCode === "number"
        ? value.exitCode
        : null;
  return {
    schema: 1,
    runId: typeof value.runId === "string" ? value.runId : randomUUID(),
    installer:
      typeof value.installer === "string"
        ? value.installer
        : typeof value.revision === "string"
          ? value.revision
          : null,
    cli: typeof value.cli === "string" ? value.cli : cliVersion,
    tenant: typeof value.tenant === "string" ? value.tenant : null,
    exit:
      state === "running" || state === "interrupted" || state === "stopped"
        ? null
        : exit,
    steps: [...deduped.values()],
    ...(typeof value.account === "string" ? { account: value.account } : {}),
    ...(typeof value.membershipId === "string" ? { membershipId: value.membershipId } : {}),
    ...(typeof value.baseUrl === "string" ? { baseUrl: value.baseUrl } : {}),
    ...(value.scope === "step" || value.scope === "onboarding" ? { scope: value.scope } : {}),
    ...(value.mode === "plan" || value.mode === "run" ? { mode: value.mode } : {}),
    ...(typeof value.complete === "boolean" ? { complete: value.complete } : {}),
    ...(typeof value.localSync === "boolean" ? { localSync: value.localSync } : {}),
    operations: Object.fromEntries(Object.entries(object(value.operations) ?? {}).filter(([key, v]) =>
      (ONBOARD_STEPS as readonly string[]).includes(key) && typeof v === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(v))),
    changes: Array.isArray(value.changes)
      ? value.changes.flatMap((change) => {
          const row = object(change);
          return row &&
            typeof row.kind === "string" &&
            typeof row.label === "string" &&
            typeof row.undo === "string"
            ? [{ kind: row.kind, label: row.label, undo: row.undo }]
            : [];
        })
      : [],
  };
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new CliError(
      `setup state path ${path} must be a real directory`,
      "onboard-state-path",
      EXIT_REFUSED,
    );
  chmodSync(path, 0o700);
  try {
    writeFileSync(join(path, ".mode-check"), "", { mode: 0o600, flag: "wx" });
    rmSync(join(path, ".mode-check"));
  } catch {
    /* existing state permissions are checked by the actual atomic write */
  }
}

export function writeOnboardJournal(
  path: string,
  journal: OnboardJournal,
): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(journal, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function defaultAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return object(error)?.code !== "ESRCH"; }
}

interface LockOwner {
  pid: number;
  token: string;
}

function readLockOwner(path: string): LockOwner | null {
  try {
    const raw = readFileSync(join(path, "owner.json"), "utf8");
    const row = object(JSON.parse(raw));
    if (row && Number.isSafeInteger(row.pid) && typeof row.token === "string")
      return { pid: row.pid as number, token: row.token };
  } catch {
    try {
      const pid = Number(readFileSync(join(path, "pid"), "utf8").trim());
      if (Number.isSafeInteger(pid) && pid > 0) return { pid, token: "" };
    } catch {
      /* incomplete stale lock */
    }
  }
  return null;
}

function removeStaleLock(lockPath: string, owner: LockOwner | null): boolean {
  try {
    const before = lstatSync(lockPath);
    if (!before.isDirectory() || before.isSymbolicLink()) return false;
    const current = readLockOwner(lockPath);
    if (
      (current?.pid ?? null) !== (owner?.pid ?? null) ||
      (current?.token ?? "") !== (owner?.token ?? "")
    )
      return false;
    const stalePath = `${lockPath}.stale-${owner?.pid ?? "unknown"}-${randomBytes(4).toString("hex")}`;
    renameSync(lockPath, stalePath);
    const moved = readLockOwner(stalePath);
    if (
      (moved?.pid ?? null) !== (owner?.pid ?? null) ||
      (moved?.token ?? "") !== (owner?.token ?? "")
    ) {
      try {
        renameSync(stalePath, lockPath);
      } catch {
        /* another installer acquired the canonical path */
      }
      return false;
    }
    rmSync(stalePath, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function releaseOwnedLock(lockPath: string, owner: LockOwner): void {
  try {
    const before = lstatSync(lockPath);
    if (!before.isDirectory() || before.isSymbolicLink()) return;
    const current = readLockOwner(lockPath);
    if (current?.pid !== owner.pid || current.token !== owner.token) return;
    const releasePath = `${lockPath}.release-${owner.pid}-${randomBytes(4).toString("hex")}`;
    renameSync(lockPath, releasePath);
    const moved = readLockOwner(releasePath);
    if (moved?.pid !== owner.pid || moved.token !== owner.token) {
      try {
        renameSync(releasePath, lockPath);
      } catch {
        /* another installer acquired the canonical path */
      }
      return;
    }
    rmSync(releasePath, { recursive: true, force: false });
  } catch {
    /* leave an uncertain lock in place so a later run can verify its owner */
  }
}

function acquireLock(
  ctx: Ctx,
  deps: OnboardDeps,
): { path: string; owner: LockOwner } {
  const pid = deps.processId ?? process.pid;
  const token = (deps.token ?? randomUUID)();
  const path = onboardLockPath(ctx.home, ctx.env);
  ensurePrivateDirectory(join(path, ".."));
  try {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "pid"), `${pid}\n`, { mode: 0o600, flag: "wx" });
    const owner = { pid, token };
    writeFileSync(join(path, "owner.json"), `${JSON.stringify(owner)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return { path, owner };
  } catch (err) {
    if (object(err)?.code !== "EEXIST") throw err;
  }
  const lockStat = lstatSync(path);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink())
    throw new CliError(
      `setup lock at ${path} is not a real directory; inspect it before trying again`,
      "onboard-lock-path",
      EXIT_REFUSED,
    );
  const current = readLockOwner(path);
  const handoff = ctx.env.CATALYST_INSTALL_LOCK_TOKEN;
  if (current?.pid === pid && current.token !== "" && current.token === handoff)
    return { path, owner: current };
  const ownerIsAlive = current ? (deps.isProcessAlive ?? defaultAlive)(current.pid) : false;
  if (current && ownerIsAlive)
    throw new CliError(
      `setup is already running (pid ${current.pid}); wait for it to finish, then run the same command`,
      "onboard-locked",
      EXIT_FAILED,
    );
  if (!current)
    throw new CliError("setup lock has no complete owner record; keep it until no setup process is running", "onboard-lock-incomplete", EXIT_REFUSED);
  if (!removeStaleLock(path, current))
    throw new CliError(
      `setup lock at ${path} could not be safely reclaimed; inspect it and remove it only if no setup process is running`,
      "onboard-lock-stale",
      EXIT_REFUSED,
    );
  return acquireLock(ctx, deps);
}

function releaseLock(lock: { path: string; owner: LockOwner }): void {
  releaseOwnedLock(lock.path, lock.owner);
}

function journalStep(
  journal: OnboardJournal,
  id: OnboardStepId,
): OnboardStep | undefined {
  return journal.steps.find((step) => step.id === id);
}

function setStep(journal: OnboardJournal, step: OnboardStep): void {
  const index = journal.steps.findIndex((existing) => existing.id === step.id);
  if (index === -1) journal.steps.push(step);
  else journal.steps[index] = step;
}

function freshJournal(
  ctx: Ctx,
  cliVersion: string,
  deps: OnboardDeps,
): OnboardJournal {
  const now = isoNow(ctx, deps);
  return {
    schema: 1,
    runId: `${now.replace(/[-:.]/g, "").replace(/Z$/, "Z")}-${randomBytes(2).toString("hex")}`,
    installer: null,
    cli: cliVersion,
    tenant: null,
    exit: null,
    steps: [],
    changes: [],
  };
}

/** A refusal before loading state must not reuse or copy an unreadable receipt. */
export function onboardErrorJournal(ctx: Ctx, cliVersion: string, exit: number): OnboardJournal {
  return { ...freshJournal(ctx, cliVersion, {}), scope: "onboarding", mode: "run", exit, complete: false };
}

function planJournal(journal: OnboardJournal): OnboardJournal {
  return {
    ...journal,
    exit: null,
    mode: "plan",
    complete: false,
    steps: ONBOARD_STEPS.map(
      (id) =>
        journal.steps.find((step) => step.id === id) ?? {
          id,
          state: "pending",
        },
    ),
  };
}

function printPlan(ctx: Ctx, journal: OnboardJournal): void {
  const value = planJournal(journal);
  ctx.stdout("Catalyst setup plan");
  for (const step of value.steps)
    ctx.stdout(`  ${step.state === "done" ? "✓" : "·"} ${ONBOARD_TITLES[step.id]}`);
  ctx.stdout(
    `Next: ${value.steps.find((step) => step.state === "pending")?.id ?? "ready"}`,
  );
}

async function confirmContinue(
  ctx: Ctx,
  args: ParsedArgs,
  deps: OnboardDeps,
): Promise<boolean> {
  if (args.flags.yes === true) return true;
  if (
    !(
      deps.isTty ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY))
    )()
  ) {
    ctx.stderr(
      "No terminal is attached; using the default answer Yes. Pass --dry-run to inspect without changes.",
    );
    return true;
  }
  if (deps.confirm) return deps.confirm("Continue? [Y/n] ");
  try {
    const input = createReadStream("/dev/tty");
    const output = createWriteStream("/dev/tty");
    const readline = createInterface({ input, output, terminal: true });
    try {
      const answer = (await readline.question("Continue? [Y/n] "))
        .trim()
        .toLowerCase();
      return answer === "" || answer === "y" || answer === "yes";
    } finally {
      readline.close();
      input.destroy();
      output.end();
    }
  } catch {
    return false;
  }
}

function sanitizedResult(id: OnboardStepId, result: OnboardStepResult, at: string): OnboardStep {
  const row = normalizeStep({ id, ...result, state: result.state === "refused" ? "failed" : result.state }, at)!;
  row.at = at;
  return row;
}

function stepSatisfied(step: OnboardStep | undefined): boolean {
  return step?.state === "done" || (step?.state === "skipped" &&
    (step.id === "legacy" || step.reason === "member_scope" ||
      (step.id === "daemon" && step.reason === "local_sync_not_selected")));
}

function requireMatchingIdentity(journal: OnboardJournal, identity: OnboardIdentity | null): void {
  const account = journal.account ?? journal.tenant;
  if ((account && (!identity || account !== identity.account)) ||
      (journal.membershipId && journal.membershipId !== identity?.membershipId) ||
      (journal.baseUrl && journal.baseUrl !== identity?.baseUrl))
    throw new CliError("this setup belongs to another workspace or member; sign in with the original account to resume", "onboard-identity-mismatch", EXIT_REFUSED);
  if (identity) {
    journal.account = identity.account;
    journal.tenant = identity.account;
    journal.membershipId = identity.membershipId;
    journal.baseUrl = identity.baseUrl;
  }
}

/** The receipt records progress; adapters verify the current state before any resumed action. */
export async function cmdOnboard(args: ParsedArgs, ctx: Ctx, deps: OnboardDeps = {}, cliVersion = "0.13.1"): Promise<number> {
  if (args.subcommand !== null || args.rest.length > 0) throw new UsageError("onboard takes no positional arguments");
  const only = typeof args.flags.only === "string" ? args.flags.only as OnboardStepId : undefined;
  const resume = typeof args.flags["resume-from"] === "string" ? args.flags["resume-from"] : undefined;
  const resumeFrom = resume === "install" ? "signin" : resume as OnboardStepId | undefined;
  for (const id of [only, resumeFrom]) if (id && !(ONBOARD_STEPS as readonly string[]).includes(id))
    throw new UsageError(`unknown onboarding step: ${id}`);
  const statePath = onboardStatePath(ctx.home, ctx.env);
  let journal = readOnboardJournal(statePath, cliVersion, (deps.now ?? ctx.now)()) ?? freshJournal(ctx, cliVersion, deps);
  if (args.flags["dry-run"] === true) {
    if (args.json) ctx.stdout(JSON.stringify(planJournal(journal))); else printPlan(ctx, journal);
    return 0;
  }
  // Check tenant binding before even a local cleanup mutation. Never overwrite a mismatched receipt.
  let identity: OnboardIdentity | null = null;
  try {
    if (deps.identity) { identity = await deps.identity(journal); requireMatchingIdentity(journal, identity); }
  } catch (error) {
    const code = error instanceof CliError ? error.exitCode : EXIT_FAILED;
    ctx.stderr("Could not verify your Catalyst membership. Setup was not changed. Sign in with the original account to resume.");
    if (args.json) ctx.stdout(JSON.stringify({ ...journal, mode: "run", exit: code, complete: false }));
    return code;
  }
  if (!args.json) printPlan(ctx, journal);
  const inheritedConsent = resume === "install" && Boolean(ctx.env.CATALYST_INSTALL_LOCK_TOKEN);
  if (!inheritedConsent && !(await confirmContinue(ctx, args, deps))) {
    ctx.stderr("Nothing was changed. Run the same command when ready.");
    if (args.json) ctx.stdout(JSON.stringify({ ...journal, complete: false }));
    return 0;
  }
  let lock: { path: string; owner: LockOwner };
  try { lock = acquireLock(ctx, deps); }
  catch (error) {
    if (!(error instanceof CliError)) throw error;
    ctx.stderr(error.message);
    if (args.json) ctx.stdout(JSON.stringify({ ...planJournal(journal), exit: error.exitCode }));
    return error.exitCode;
  }
  const stop = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, stop.signal]) : stop.signal;
  const stepCtx = { ...ctx, stdout: args.json ? ctx.stderr : ctx.stdout,
    fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => ctx.fetch(input, {
      ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    })) as typeof fetch };
  let current: OnboardStepId | null = null;
  const interrupted = () => {
    stop.abort();
    if (current) setStep(journal, { id: current, state: "failed", reason: "interrupted", at: isoNow(ctx, deps) });
    journal.exit = EXIT_WAITING; journal.complete = false;
    try { writeOnboardJournal(statePath, journal); } catch { /* keep the last atomic receipt */ }
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  if (deps.bindSignals !== false) for (const name of signals) process.on(name, interrupted);
  const finish = (code: number) => {
    journal.exit = code;
    journal.complete = !only && code === 0;
    writeOnboardJournal(statePath, journal);
    if (args.json) ctx.stdout(JSON.stringify(journal));
    else {
      if (journal.complete) ctx.stdout("Onboarding complete.");
      else if (only && code === 0) ctx.stdout(`${ONBOARD_TITLES[only]} finished. Onboarding still has other steps.`);
      else ctx.stdout(`Setup still needs ${journal.steps.filter(step => !stepSatisfied(step)).length} checks.`);
      ctx.stdout("resume: catalyst onboard");
    }
    return code;
  };
  try {
    journal = readOnboardJournal(statePath, cliVersion, (deps.now ?? ctx.now)()) ?? journal;
    if (deps.identity) requireMatchingIdentity(journal, identity);
    journal.cli = cliVersion; journal.scope = only ? "step" : "onboarding"; journal.mode = "run";
    if (args.flags["local-sync"] === true) journal.localSync = true;
    journal.localSync ??= false;
    for (const id of ONBOARD_STEPS) if (!journalStep(journal, id)) setStep(journal, { id, state: "pending" });
    journal.steps.sort((a, b) => ONBOARD_STEPS.indexOf(a.id) - ONBOARD_STEPS.indexOf(b.id));
    journal.operations ??= {};
    let refused = false;
    const needed = new Set<OnboardStepId>();
    const include = (id: OnboardStepId): void => {
      if (needed.has(id)) return; needed.add(id);
      for (const parent of ONBOARD_DEPENDENCIES[id] ?? []) include(parent);
    };
    if (only) include(only); else for (const id of ONBOARD_STEPS) needed.add(id);
    const fromIndex = resumeFrom ? ONBOARD_STEPS.indexOf(resumeFrom) : 0;
    for (const id of ONBOARD_STEPS.filter(id => needed.has(id))) {
      if (signal.aborted) return finish(EXIT_WAITING);
      current = id;
      // Member onboarding keeps administration outside its scope, with an explicit recorded reason.
      if (identity?.role === "member" && ADMIN_STEPS.has(id)) {
        setStep(journal, { id, state: "skipped", reason: "member_scope", at: isoNow(ctx, deps) }); continue;
      }
      const missing = (ONBOARD_DEPENDENCIES[id] ?? []).find(parent => !stepSatisfied(journalStep(journal, parent)));
      if (missing) {
        setStep(journal, { id, state: "waiting", reason: "prerequisite_not_ready", at: isoNow(ctx, deps) });
        writeOnboardJournal(statePath, journal); continue;
      }
      let adapter = deps.adapters?.[id];
      // Compatibility for the initial legacy adapter, which performs its own before/after checks.
      if (!adapter && id === "legacy") {
        let result: OnboardStepResult = deps.runStep ? { state: "pending" } : { state: "skipped", reason: "legacy_not_selected" };
        adapter = { check: async () => result, act: deps.runStep ? async () => result = await deps.runStep!(id, stepCtx) : undefined };
      }
      if (!adapter) {
        setStep(journal, { id, state: "waiting", reason: "step_not_available_in_this_release", at: isoNow(ctx, deps) });
        writeOnboardJournal(statePath, journal); continue;
      }
      try {
        let result = await adapter.check(stepCtx, journal);
        if (result.state === "pending" && adapter.act && (!only || id === only) && ONBOARD_STEPS.indexOf(id) >= fromIndex) {
          if (deps.identity) {
            identity = await deps.identity(journal); requireMatchingIdentity(journal, identity);
            if (identity?.role === "member" && ADMIN_STEPS.has(id)) {
              setStep(journal, { id, state: "skipped", reason: "member_scope", at: isoNow(ctx, deps) });
              writeOnboardJournal(statePath, journal); continue;
            }
          }
          journal.operations[id] ??= `${journal.runId}:${id}`;
          setStep(journal, { id, state: "running", at: isoNow(ctx, deps) });
          journal.exit = null; writeOnboardJournal(statePath, journal);
          const action = await adapter.act(stepCtx, journal);
          if (action.state === "done") {
            result = await adapter.check(stepCtx, journal);
            if (result.state === "pending") result = { state: "waiting", reason: "verification_pending" };
          } else result = action;
          if (id === "signin" && result.state === "done" && deps.identity) {
            identity = await deps.identity(journal); requireMatchingIdentity(journal, identity);
            if (identity?.role === "member" && ADMIN_STEPS.has(id)) {
              setStep(journal, { id, state: "skipped", reason: "member_scope", at: isoNow(ctx, deps) });
              writeOnboardJournal(statePath, journal); continue;
            }
          }
        }
        if (id === "signin" && result.state === "done" && deps.identity) {
          identity = await deps.identity(journal); requireMatchingIdentity(journal, identity);
          if (!identity) result = { state: "failed", reason: "membership_not_verified" };
        }
        if (result.state === "refused") refused = true;
        if (result.state === "pending") result = { ...result, state: "waiting", reason: result.reason ?? "action_required" };
        setStep(journal, sanitizedResult(id, result, isoNow(ctx, deps)));
      } catch (error) {
        if (error instanceof CliError && error.exitCode === EXIT_REFUSED) refused = true;
        const reason = signal.aborted ? "interrupted" : error instanceof CliError && /^[a-z][a-z0-9_-]{1,63}$/.test(error.code) ? error.code.replaceAll("-", "_") : "step_failed";
        setStep(journal, { id, state: "failed", reason, at: isoNow(ctx, deps) });
        stepCtx.stderr(`✗ ${ONBOARD_TITLES[id]}: ${reason}. The safe reason is saved; run the same command to resume.`);
      }
      if (signal.aborted) {
        setStep(journal, { id, state: "failed", reason: "interrupted", at: isoNow(ctx, deps) });
        return finish(EXIT_WAITING);
      }
      writeOnboardJournal(statePath, journal);
      if (refused) break;
    }
    current = null;
    const scope = only ? [only] : [...ONBOARD_STEPS];
    const code = refused ? EXIT_REFUSED : scope.some(id => journalStep(journal, id)?.state === "failed") ? EXIT_FAILED
      : scope.every(id => stepSatisfied(journalStep(journal, id))) ? 0 : EXIT_WAITING;
    return finish(code);
  } catch (error) {
    // Identity can change while the lock is held; stop before the next action.
    if (error instanceof CliError) { ctx.stderr(error.message); return error.exitCode; }
    throw error;
  } finally {
    if (deps.bindSignals !== false) for (const name of signals) process.off(name, interrupted);
    releaseLock(lock);
  }
}
