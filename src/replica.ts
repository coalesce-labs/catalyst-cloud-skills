// replica.ts — the optional local replica: `replica start|stop|status|sql|schema`.
//
// `status` is the check every skill runs first and it needs no network and no SDK: the pidfile, the
// writer-lock heartbeat, and the `sync_meta.cursor` row (read through node:sqlite read-only). Exit
// 0 fresh, 1 present but stale, 2 not configured, 3 absent. `--probe` adds the one network call.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { flagBool, flagInt, flagString, positionals, type ParsedArgs } from "./args.js";
import { apiBase, loadConfig, replicaDbPath, type Ctx, type CustomerConfig } from "./config.js";
import { detachSelf } from "./detach.js";
import { CliError, UsageError } from "./errors.js";
import { apiClient } from "./transport.js";
import { authStrategyFor } from "./oauth.js";
import { loadSdk, type Sdk } from "./sdk.js";
import { createEventSync, type EventsSdk, type EventSyncHandle } from "./events.js";
import type { WebSocketFactory } from "@catalyst-cloud/sdk/node";

export const DEFAULT_STALE_MS = 15_000;

export type ReplicaVerdict = "fresh" | "stale" | "not-configured" | "absent";

/** The writer's own bookkeeping, beside the pidfile and the lock. A sidecar rather than a row in the
 *  replica's sync_meta: `replicaStatus` answers "absent" before it ever opens the database, and a
 *  seed that fails mid-stream has already truncated that database (CTC-2499). */
export interface ReplicaWriterState {
  /** epoch ms of the last write */
  updatedAt: number;
  /** the writer process that wrote it */
  pid: number;
  /** consecutive failed snapshot pulls; zeroed by a snapshot that completes */
  consecutiveFailures: number;
  lastError: string | null;
  lastFailureAt: number | null;
  /** set only once the writer gave up; null while it is still retrying */
  stopped: { at: number; reason: string; restartWith: string } | null;
}

export interface ReplicaStatus {
  verdict: ReplicaVerdict;
  exitCode: 0 | 1 | 2 | 3;
  dbPath: string | null;
  cursor: number | null;
  heartbeatAgeMs: number | null;
  lockPid: number | null;
  pidfilePid: number | null;
  writerAlive: boolean;
  reasons: string[];
  head?: number;
  lag?: number;
  writer: ReplicaWriterState | null;
}

export function pidfilePath(dbPath: string): string {
  return `${dbPath}.pid`;
}
export function lockPath(dbPath: string): string {
  return `${dbPath}.writer.lock`;
}
export function writerStatePath(dbPath: string): string {
  return `${dbPath}.writer.state`;
}

/** Read the writer's state sidecar. A missing file, unparseable JSON, or a record with the wrong
 *  shape (a hand-edited or truncated file) all read as "no record", never a throw — readLock's
 *  contract, followed here. */
export function readWriterState(dbPath: string): ReplicaWriterState | null {
  try {
    const rec = JSON.parse(readFileSync(writerStatePath(dbPath), "utf8")) as Partial<ReplicaWriterState>;
    const stoppedOk =
      rec.stopped === null ||
      (typeof rec.stopped === "object" &&
        rec.stopped !== null &&
        typeof rec.stopped.at === "number" &&
        typeof rec.stopped.reason === "string" &&
        typeof rec.stopped.restartWith === "string");
    if (
      typeof rec.updatedAt !== "number" ||
      typeof rec.pid !== "number" ||
      typeof rec.consecutiveFailures !== "number" ||
      !(rec.lastError === null || typeof rec.lastError === "string") ||
      !(rec.lastFailureAt === null || typeof rec.lastFailureAt === "number") ||
      !stoppedOk
    ) {
      return null;
    }
    return rec as ReplicaWriterState;
  } catch {
    return null;
  }
}

export function writeWriterState(dbPath: string, s: Omit<ReplicaWriterState, "updatedAt">, nowMs: number): void {
  writeFileSync(writerStatePath(dbPath), JSON.stringify({ ...s, updatedAt: nowMs }));
}

/** Remove the writer state sidecar; a no-op (never throws) when it is already gone. */
export function clearWriterState(dbPath: string): void {
  try {
    unlinkSync(writerStatePath(dbPath));
  } catch {
    // already gone
  }
}

export function pidAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

export function readPidfile(dbPath: string): number | null {
  const p = pidfilePath(dbPath);
  if (!existsSync(p)) return null;
  const n = Number(readFileSync(p, "utf8").trim());
  return Number.isInteger(n) ? n : null;
}

function readLock(dbPath: string): { pid: number; heartbeat: number } | null {
  try {
    const rec = JSON.parse(readFileSync(lockPath(dbPath), "utf8")) as { pid?: unknown; heartbeat?: unknown };
    if (typeof rec.pid === "number" && typeof rec.heartbeat === "number") return { pid: rec.pid, heartbeat: rec.heartbeat };
    return null;
  } catch {
    return null;
  }
}

/** Read `sync_meta.cursor` read-only through node:sqlite; null when the table or row is absent. */
export function readCursor(dbPath: string): number | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_meta'").get();
    if (!table) return null;
    const row = db.prepare("SELECT value FROM sync_meta WHERE key = 'cursor'").get() as { value?: unknown } | undefined;
    if (!row || row.value === null || row.value === undefined || row.value === "") return null;
    const n = Number(row.value);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export interface StatusOptions {
  staleMs?: number;
  nowMs?: number;
  dbPath?: string;
}

/** The in-process status logic `query` and `ready` reuse. */
export function replicaStatus(ctx: Ctx, cfg: CustomerConfig | null, opts: StatusOptions = {}): ReplicaStatus {
  const base: ReplicaStatus = {
    verdict: "not-configured",
    exitCode: 2,
    dbPath: null,
    cursor: null,
    heartbeatAgeMs: null,
    lockPid: null,
    pidfilePid: null,
    writerAlive: false,
    reasons: [],
    writer: null,
  };
  if (!cfg) return { ...base, reasons: ["not connected"] };
  const dbPath = opts.dbPath ?? replicaDbPath(cfg, ctx.home);
  const writer = readWriterState(dbPath);
  if (!existsSync(dbPath)) return { ...base, verdict: "absent", exitCode: 3, dbPath, reasons: ["no replica file"], writer };
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const nowMs = opts.nowMs ?? ctx.now().getTime();
  const lock = readLock(dbPath);
  const pidfilePid = readPidfile(dbPath);
  const heartbeatAgeMs = lock ? Math.max(0, nowMs - lock.heartbeat) : null;
  const writerAlive = pidAlive(lock?.pid ?? null) || pidAlive(pidfilePid);
  const cursor = readCursor(dbPath);
  const reasons: string[] = [];
  if (!lock) reasons.push("no writer lock");
  else if (heartbeatAgeMs !== null && heartbeatAgeMs >= staleMs) reasons.push(`heartbeat ${heartbeatAgeMs}ms old (stale after ${staleMs}ms)`);
  if (cursor === null) reasons.push("no cursor");
  if (!writerAlive) reasons.push("no live writer process");
  const fresh = reasons.length === 0;
  return {
    verdict: fresh ? "fresh" : "stale",
    exitCode: fresh ? 0 : 1,
    dbPath,
    cursor,
    heartbeatAgeMs,
    lockPid: lock?.pid ?? null,
    pidfilePid,
    writerAlive,
    reasons,
    writer,
  };
}

function baseStatusLine(s: ReplicaStatus): string {
  switch (s.verdict) {
    case "not-configured":
      return "replica: not configured — run login first";
    case "absent":
      return `replica: absent at ${s.dbPath} — start it with: catalyst-skills replica start --detach`;
    case "fresh":
      return `replica: fresh at ${s.dbPath} (cursor ${s.cursor}, heartbeat ${s.heartbeatAgeMs}ms ago${s.lag !== undefined ? `, ${s.lag} behind head ${s.head}` : ""})`;
    case "stale":
      return `replica: stale at ${s.dbPath} (${s.reasons.join("; ")}${s.cursor !== null ? `; cursor ${s.cursor}` : ""}) — reads fall back to the API`;
  }
}

export function statusLine(s: ReplicaStatus): string {
  const base = baseStatusLine(s);
  const w = s.writer;
  if (w?.stopped) {
    return (
      `${base} — the writer stopped ${new Date(w.stopped.at).toISOString()} after ${w.consecutiveFailures} ` +
      `consecutive snapshot failures (last error: ${w.lastError}); restart it with: ${w.stopped.restartWith}`
    );
  }
  if (w && w.consecutiveFailures > 0) {
    return `${base} — the writer has failed ${w.consecutiveFailures} snapshot pulls in a row and is backing off (last error: ${w.lastError})`;
  }
  return base;
}

// ── engines ──────────────────────────────────────────────────────────────────────────────────────

export interface EngineDeps {
  /** Resolve the better-sqlite3 driver; the default is a real require. Injectable for tests. */
  requireDriver?: () => unknown;
  readonly?: boolean;
}

/** better-sqlite3 when it resolves and constructs, else node:sqlite — with exactly one stderr line
 *  on the fallback so the choice is visible. */
export async function engineFor(sdk: Sdk, dbPath: string, ctx: Pick<Ctx, "stderr">, deps: EngineDeps = {}) {
  const requireDriver = deps.requireDriver ?? (() => createRequire(import.meta.url)("better-sqlite3"));
  try {
    const mod = requireDriver() as { default?: unknown } | undefined;
    const driver = (mod && typeof mod === "object" && "default" in mod ? mod.default : mod) as Parameters<Sdk["betterSqlite3Engine"]>[0];
    if (typeof driver !== "function") throw new Error("better-sqlite3 resolved to a non-constructor");
    return deps.readonly ? sdk.betterSqlite3ReadonlyEngine(driver, dbPath) : sdk.betterSqlite3Engine(driver, dbPath);
  } catch (err) {
    const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
    ctx.stderr(`[catalyst-skills] better-sqlite3 unavailable (${why}); using node:sqlite`);
    return deps.readonly ? sdk.nodeSqliteReadonlyEngine(dbPath) : sdk.nodeSqliteEngine(dbPath);
  }
}

// ── the verb ─────────────────────────────────────────────────────────────────────────────────────

export interface ReplicaDeps {
  detach?: typeof detachSelf;
  /** Injectable socket factory for `start` (tests); defaults to the runtime WebSocket. */
  wsFactory?: WebSocketFactory;
  /** For `start`: resolve when the process should shut down (tests); default waits for SIGINT/SIGTERM. */
  waitForStop?: () => Promise<void>;
  argv?: string[];
  engineDeps?: EngineDeps;
  loadEventsSdk?: () => Promise<EventsSdk>;
  /** Injected so tests never wait on the wall clock (the same seam as oauth.ts's RefreshDeps). */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so a test can pin the jitter exactly. Defaults to Math.random. */
  random?: () => number;
  /** Test-only tuning of the supervisor; production uses the module constants below. */
  snapshotRetry?: { baseBackoffMs?: number; maxBackoffMs?: number; maxFailures?: number };
}

export const SNAPSHOT_BASE_BACKOFF_MS = 30_000;
export const SNAPSHOT_MAX_BACKOFF_MS = 900_000; // 15 minutes
export const SNAPSHOT_MAX_FAILURES = 5;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function defaultWaitForStop(): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

/** Full jitter (AWS "Exponential Backoff and Jitter"): a uniform draw from [0, bound), where the
 *  bound doubles per consecutive failure and is clamped at the cap. */
export function backoffDelayMs(consecutiveFailures: number, opts: { baseMs: number; maxMs: number; random: () => number }): number {
  const bound = Math.min(opts.baseMs * 2 ** Math.max(0, consecutiveFailures - 1), opts.maxMs);
  return Math.floor(opts.random() * bound);
}

function releaseOwnPidfile(dbPath: string): void {
  try {
    if (readPidfile(dbPath) === process.pid) unlinkSync(pidfilePath(dbPath));
  } catch {
    // pidfile already gone
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function cmdReplica(args: ParsedArgs, ctx: Ctx, deps: ReplicaDeps = {}): Promise<number> {
  const [sub, ...rest] = positionals(args);
  if (!sub) throw new UsageError("replica needs a subcommand: start | stop | status | sql | schema");
  if (sub === "status") return cmdStatus(args, ctx);
  const cfg = loadConfig(ctx.home);
  if (!cfg) throw new CliError("not connected yet — run login first", "not-configured");
  const dbPath = flagString(args, "db") ?? replicaDbPath(cfg, ctx.home);
  switch (sub) {
    case "start":
      return cmdStart(args, ctx, cfg, dbPath, deps);
    case "stop":
      return cmdStop(ctx, dbPath);
    case "sql":
      return cmdSql(args, ctx, dbPath, rest.join(" "), deps);
    case "schema":
      return cmdSchema(args, ctx, dbPath, rest[0]);
    default:
      throw new UsageError(`unknown replica subcommand: ${sub}`);
  }
}

async function cmdStatus(args: ParsedArgs, ctx: Ctx): Promise<number> {
  let cfg: CustomerConfig | null;
  try {
    cfg = loadConfig(ctx.home);
  } catch {
    cfg = null;
  }
  const status = replicaStatus(ctx, cfg, {
    staleMs: flagInt(args, "stale-ms", DEFAULT_STALE_MS),
    dbPath: flagString(args, "db"),
  });
  if (flagBool(args, "probe") && cfg && status.verdict !== "not-configured") {
    const head = await apiClient(cfg, ctx).getJson<{ cursor?: number }>("/api/v1/snapshot", { query: { head: 1 } });
    if (typeof head.body.cursor === "number") {
      status.head = head.body.cursor;
      status.lag = status.cursor === null ? head.body.cursor : head.body.cursor - status.cursor;
    }
  }
  ctx.stdout(args.json ? JSON.stringify(status) : statusLine(status));
  return status.exitCode;
}

async function cmdStart(args: ParsedArgs, ctx: Ctx, cfg: CustomerConfig, dbPath: string, deps: ReplicaDeps): Promise<number> {
  if (flagBool(args, "detach")) {
    const argv = (deps.argv ?? process.argv.slice(1)).filter((a) => a !== "--detach");
    const { pid } = (deps.detach ?? detachSelf)(argv, ctx.env);
    writeFileSync(pidfilePath(dbPath), `${pid}\n`);
    ctx.stdout(`replica writer started in the background (pid ${pid}, db ${dbPath}); check with: catalyst-skills replica status`);
    return 0;
  }
  const sdk = await loadSdk();
  clearWriterState(dbPath); // a new run never inherits an old run's verdict

  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const baseMs = deps.snapshotRetry?.baseBackoffMs ?? SNAPSHOT_BASE_BACKOFF_MS;
  const maxMs = deps.snapshotRetry?.maxBackoffMs ?? SNAPSHOT_MAX_BACKOFF_MS;
  const maxFailures = deps.snapshotRetry?.maxFailures ?? SNAPSHOT_MAX_FAILURES;

  // Registered ONCE, not per attempt, so a supervised run does not pile up signal handlers.
  let stopRequested = false;
  const stopSignal = (deps.waitForStop ?? defaultWaitForStop)().then(() => {
    stopRequested = true;
  });

  let eventSync: EventSyncHandle | null = null;
  let failures = 0;

  for (;;) {
    const engine = await engineFor(sdk, dbPath, ctx, deps.engineDeps);
    let seedInFlight = false;
    let attemptError: string | null = null;
    let signalFailure!: () => void;
    const failed = new Promise<void>((res) => (signalFailure = res));

    const replica = new sdk.CatalystReplica({
      baseUrl: apiBase(cfg),
      account: cfg.account,
      accountSource: "declared",
      auth: authStrategyFor(ctx, cfg),
      dbPath,
      engine,
      fetchImpl: ctx.fetch,
      wsFactory: deps.wsFactory,
      log: (level, msg, extra) => ctx.stderr(`[replica ${level}] ${msg}${extra ? ` ${safeJson(extra)}` : ""}`),
      onStatus: (s) => {
        ctx.stderr(`[replica] status=${s}`);
        // A "live" that does NOT follow a re-seed is just the socket coming up — the failing loop
        // passes through it every cycle, so it must not reset the count (CTC-2499).
        if (s === "resyncing") {
          seedInFlight = true;
          return;
        }
        if (s === "live" && seedInFlight) {
          seedInFlight = false;
          if (failures !== 0) {
            failures = 0;
            writeWriterState(dbPath, { pid: process.pid, consecutiveFailures: 0, lastError: null, lastFailureAt: null, stopped: null }, ctx.now().getTime());
          }
          return;
        }
        if ((s === "reconnecting" || s === "error") && seedInFlight && attemptError === null) {
          seedInFlight = false;
          attemptError = "the snapshot pull failed or ended early";
          // SYNCHRONOUS inside onStatus: LiveSyncClient.stop() sets `stopped = true` as its first
          // statement, and scheduleReconnect() — the very next statement in runResync() — returns
          // early on it. This is what keeps the SDK from re-entering its own loop.
          void replica.close().catch(() => {});
          signalFailure();
          return;
        }
        if (s === "auth-required" && attemptError === null) {
          // A refused credential is not something to retry against the tenant at all.
          attemptError = "the tenant refused this machine's credential on /snapshot";
          void replica.close().catch(() => {});
          signalFailure();
        }
      },
    });

    // Always give start() a handler, so a rejection that loses the race is never unhandled.
    const started = replica.start().then(
      () => "started" as const,
      (err) => {
        attemptError ??= messageOf(err);
        return "failed" as const;
      },
    );

    const outcome = await Promise.race([started, failed.then(() => "failed" as const), stopSignal.then(() => "stop" as const)]);

    if (outcome === "started") {
      // The event cache is started once for the whole supervised run, not per attempt.
      if (eventSync === null) {
        eventSync = await createEventSync(ctx, { loadSdk: deps.loadEventsSdk });
        void eventSync.start().catch((error) => ctx.stderr(`[events] sync failed: ${messageOf(error)}; replica remains live`));
      }
      ctx.stdout(`replica live at ${dbPath} (cursor ${replica.cursor ?? "none"}); event cache active — Ctrl-C to stop`);
      // start() resolves at the FIRST "live", which is the socket, not the seed — keep watching.
      await Promise.race([failed, stopSignal]);
    }

    await replica.close().catch(() => {});
    if (stopRequested) break;

    failures += 1;
    const lastError = attemptError ?? "the snapshot pull failed";
    const nowMs = ctx.now().getTime();
    const stopped =
      failures >= maxFailures
        ? { at: nowMs, reason: `${failures} consecutive snapshot failures`, restartWith: "catalyst-skills replica start --detach" }
        : null;
    writeWriterState(dbPath, { pid: process.pid, consecutiveFailures: failures, lastError, lastFailureAt: nowMs, stopped }, nowMs);

    if (stopped) {
      await eventSync?.stop();
      releaseOwnPidfile(dbPath);
      ctx.stderr(`[replica] stopping: ${stopped.reason}; last error: ${lastError}`);
      ctx.stdout(
        `replica writer stopped after ${failures} consecutive snapshot failures (last error: ${lastError}). ` +
          `The replica is optional — every read still works through the API. ` +
          `Restart it with: ${stopped.restartWith}`,
      );
      return 1;
    }

    const delay = backoffDelayMs(failures, { baseMs, maxMs, random });
    ctx.stderr(`[replica] snapshot failure ${failures} of ${maxFailures}: ${lastError}; retrying in ${delay}ms`);
    await Promise.race([sleep(delay), stopSignal]);
    if (stopRequested) break;
  }

  await eventSync?.stop();
  releaseOwnPidfile(dbPath);
  clearWriterState(dbPath);
  ctx.stdout("replica stopped");
  return 0;
}

function cmdStop(ctx: Ctx, dbPath: string): number {
  const pid = readPidfile(dbPath);
  if (pid === null) {
    ctx.stdout(`no pidfile at ${pidfilePath(dbPath)} — nothing to stop (a foreground writer is stopped with Ctrl-C)`);
    return 1;
  }
  if (!pidAlive(pid)) {
    unlinkSync(pidfilePath(dbPath));
    ctx.stdout(`pid ${pid} is not running; removed the stale pidfile`);
    return 1;
  }
  process.kill(pid, "SIGTERM");
  try {
    unlinkSync(pidfilePath(dbPath));
  } catch {
    // already removed by the writer
  }
  ctx.stdout(`sent SIGTERM to replica writer pid ${pid}`);
  return 0;
}

const SELECT_ONLY = /^\s*(select|with)\b/i;

export function assertSingleSelect(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) throw new UsageError('replica sql needs a query: replica sql "select ..."');
  if (!SELECT_ONLY.test(trimmed) || trimmed.includes(";")) {
    throw new UsageError("replica sql runs exactly one SELECT (or WITH ... SELECT); nothing else is accepted on a read-only handle");
  }
  return trimmed;
}

async function cmdSql(args: ParsedArgs, ctx: Ctx, dbPath: string, sql: string, deps: ReplicaDeps): Promise<number> {
  const query = assertSingleSelect(sql);
  if (!existsSync(dbPath)) throw new CliError(`no replica at ${dbPath} — start it with: catalyst-skills replica start --detach`, "replica-absent", 3);
  const sdk = await loadSdk();
  const engine = await engineFor(sdk, dbPath, ctx, { ...deps.engineDeps, readonly: true });
  const replica = await sdk.CatalystReplica.openReadOnly({ dbPath, engine, log: () => {} });
  try {
    const rows = replica.sql.exec(query).toArray();
    ctx.stdout(JSON.stringify(rows, null, args.json ? 0 : 2));
    return 0;
  } finally {
    await replica.close();
  }
}

async function cmdSchema(args: ParsedArgs, ctx: Ctx, dbPath: string, table: string | undefined): Promise<number> {
  if (!existsSync(dbPath)) throw new CliError(`no replica at ${dbPath} — the schema is what the file holds; start it with: catalyst-skills replica start --detach`, "replica-absent", 3);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    const wanted = table ? tables.filter((t) => t === table) : tables;
    if (table && wanted.length === 0) throw new CliError(`no table "${table}" in the replica (tables: ${tables.join(", ")})`, "table-unknown");
    const out: Record<string, { name: string; type: string; notnull: number; pk: number }[]> = {};
    for (const t of wanted) {
      out[t] = (db.prepare(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).all() as { name: string; type: string; notnull: number; pk: number }[]).map((c) => ({
        name: c.name,
        type: c.type,
        notnull: c.notnull,
        pk: c.pk,
      }));
    }
    if (args.json) ctx.stdout(JSON.stringify(out));
    else for (const [t, cols] of Object.entries(out)) ctx.stdout(`${t}: ${cols.map((c) => `${c.name} ${c.type || "ANY"}${c.pk ? " PK" : ""}`).join(", ")}`);
    return 0;
  } finally {
    db.close();
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
