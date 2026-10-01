import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type {
  DaemonBinding,
  DaemonLease,
  DaemonRecord,
} from "./daemon-supervisor.js";

const fail = () => new Error("daemon_state_unverified");
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const states = new Set(["starting", "live", "backoff", "stopped"]);
const reasons = new Set([
  "authentication_required",
  "event_history_gap",
  "writer_conflict",
  "identity_mismatch",
  "replica_failure_cap",
  "event_failure_cap",
]);
const own = (stat: Stats) =>
  process.getuid === undefined || stat.uid === process.getuid();
const identity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const sameBinding = (a: DaemonBinding, b: DaemonBinding) =>
  a.account === b.account &&
  a.origin === b.origin &&
  a.replicaDb === b.replicaDb &&
  a.eventDirectory === b.eventDirectory;

/** Parse persisted state as untrusted input. A malformed stop record never clears a latch. */
export function parseDaemonRecord(value: unknown): DaemonRecord {
  const record = object(value);
  const binding = object(record?.binding);
  const replica = object(record?.replica);
  const events = object(record?.events);
  const stopped = object(record?.stopped);
  if (
    !record ||
    record.schema !== 1 ||
    !binding ||
    !replica ||
    !events ||
    typeof binding.account !== "string" ||
    !binding.account ||
    binding.account.length > 256 ||
    typeof binding.origin !== "string" ||
    typeof binding.replicaDb !== "string" ||
    typeof binding.eventDirectory !== "string" ||
    !isAbsolute(binding.replicaDb) ||
    !isAbsolute(binding.eventDirectory) ||
    typeof record.runId !== "string" ||
    !record.runId ||
    record.runId.length > 256 ||
    !integer(record.pid) ||
    record.pid === 0 ||
    !integer(record.updatedAt) ||
    typeof record.state !== "string" ||
    !states.has(record.state) ||
    typeof replica.state !== "string" ||
    !states.has(replica.state) ||
    !integer(replica.failures) ||
    typeof events.state !== "string" ||
    !states.has(events.state) ||
    !integer(events.failures) ||
    !(events.cursor === null || integer(events.cursor)) ||
    !(events.head === null || integer(events.head)) ||
    (typeof events.cursor === "number" &&
      typeof events.head === "number" &&
      events.cursor > events.head) ||
    !(
      record.stopped === null ||
      (stopped &&
        integer(stopped.at) &&
        typeof stopped.reason === "string" &&
        reasons.has(stopped.reason) &&
        stopped.restartWith === "catalyst daemon restart")
    )
  )
    throw fail();
  try {
    const origin = new URL(binding.origin);
    if (origin.origin !== binding.origin || origin.protocol !== "https:")
      throw fail();
  } catch {
    throw fail();
  }
  // Validation above establishes shape; copy only the public state fields, never arbitrary extras.
  return {
    schema: 1,
    binding: {
      account: binding.account,
      origin: binding.origin,
      replicaDb: binding.replicaDb,
      eventDirectory: binding.eventDirectory,
    },
    runId: record.runId,
    pid: record.pid,
    updatedAt: record.updatedAt,
    state: record.state as DaemonRecord["state"],
    replica: {
      state: replica.state as DaemonRecord["replica"]["state"],
      failures: replica.failures,
    },
    events: {
      state: events.state as DaemonRecord["events"]["state"],
      failures: events.failures,
      cursor: events.cursor as number | null,
      head: events.head as number | null,
    },
    stopped: stopped
      ? {
          at: Number(stopped.at),
          reason: stopped.reason as NonNullable<
            DaemonRecord["stopped"]
          >["reason"],
          restartWith: "catalyst daemon restart",
        }
      : null,
  };
}

function absent(error: unknown): boolean {
  return object(error)?.code === "ENOENT";
}
function stat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}
function privateDirectory(path: string, home: string): void {
  const root = resolve(home);
  const target = resolve(path);
  if (target !== root && !target.startsWith(root + sep)) throw fail();
  const parts: string[] = [];
  for (
    let current = target;
    current !== dirname(current);
    current = dirname(current)
  )
    parts.unshift(current);
  for (const current of parts) {
    let info = stat(current);
    if (!info) {
      mkdirSync(current, { mode: 0o700 });
      info = lstatSync(current);
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ((current === root || current.startsWith(root + sep)) &&
        (!own(info) || (info.mode & 0o022) !== 0))
    )
      throw fail();
  }
  const info = lstatSync(target);
  if ((info.mode & 0o077) !== 0) throw fail();
}

function readPrivate(path: string): { bytes: string; stat: Stats } | null {
  const before = stat(path);
  if (!before) return null;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !own(before) ||
    before.nlink !== 1 ||
    (before.mode & 0o077) !== 0 ||
    before.size > 64 * 1024
  )
    throw fail();
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(fd);
    if (
      !identity(before, opened) ||
      !opened.isFile() ||
      !own(opened) ||
      opened.nlink !== 1 ||
      (opened.mode & 0o077) !== 0
    )
      throw fail();
    const bytes = readFileSync(fd, "utf8");
    const after = lstatSync(path);
    const finished = fstatSync(fd);
    if (
      !identity(opened, after) ||
      opened.size !== Buffer.byteLength(bytes) ||
      opened.mtimeMs !== after.mtimeMs ||
      !identity(opened, finished) ||
      finished.mtimeMs !== opened.mtimeMs
    )
      throw fail();
    return { bytes, stat: before };
  } finally {
    closeSync(fd);
  }
}

/** Cooperative same-host lease. Only a positively dead, verified holder may be reclaimed;
 * neither heartbeat age nor an owner-key match permits stealing a live process's lease. */
export function claimDaemonLease(input: {
  home: string;
  directory: string;
  binding: DaemonBinding;
  runId: string;
  pid: number;
}): DaemonLease {
  const captured = {
    ...input,
    binding: { ...input.binding },
    directory: resolve(input.directory),
  };
  if (
    !Number.isSafeInteger(captured.pid) ||
    captured.pid <= 0 ||
    !captured.runId
  )
    throw fail();
  privateDirectory(captured.directory, captured.home);
  const lock = join(captured.directory, "writer.lock");
  const statePath = join(captured.directory, "state.json");
  const token = randomUUID();
  const lockBytes = JSON.stringify({
    schema: 1,
    pid: captured.pid,
    host: hostname(),
    token,
    binding: captured.binding,
  });
  // Serialize the check/unlink/create sequence across cooperating processes. A crash in this
  // short critical section leaves a guard that requires deliberate recovery; never guess stale
  // ownership and recreate the same conditional-unlink race on the guard itself.
  const claimGuard = join(captured.directory, "claim.lock");
  const claimBytes = JSON.stringify({ pid: captured.pid, token });
  let claimFd: number;
  try {
    claimFd = openSync(
      claimGuard,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (object(error)?.code === "EEXIST")
      throw new Error("daemon_claim_requires_recovery");
    throw error;
  }
  const claimStat = fstatSync(claimFd);
  let lockStat: Stats;
  try {
    try {
      writeFileSync(claimFd, claimBytes);
      fsyncSync(claimFd);
    } finally {
      closeSync(claimFd);
    }
    const existing = readPrivate(lock);
    if (existing) {
      let previous: Record<string, unknown> | null;
      try {
        previous = object(JSON.parse(existing.bytes));
      } catch {
        throw fail();
      }
      const binding = object(previous?.binding);
      if (
        !previous ||
        previous.schema !== 1 ||
        !integer(previous.pid) ||
        previous.pid === 0 ||
        previous.host !== hostname() ||
        typeof previous.token !== "string" ||
        !binding ||
        binding.account !== captured.binding.account ||
        binding.origin !== captured.binding.origin ||
        binding.replicaDb !== captured.binding.replicaDb ||
        binding.eventDirectory !== captured.binding.eventDirectory
      )
        throw fail();
      try {
        process.kill(previous.pid, 0);
        throw new Error("daemon_writer_already_running");
      } catch (error) {
        if (object(error)?.code !== "ESRCH") throw error;
      }
      const current = readPrivate(lock);
      if (
        !current ||
        !identity(existing.stat, current.stat) ||
        current.bytes !== existing.bytes
      )
        throw fail();
      unlinkSync(lock);
    }
    const fd = openSync(
      lock,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, lockBytes);
      fsyncSync(fd);
      lockStat = lstatSync(lock);
    } finally {
      closeSync(fd);
    }
  } finally {
    const current = readPrivate(claimGuard);
    if (
      current &&
      identity(claimStat, current.stat) &&
      current.bytes === claimBytes
    )
      unlinkSync(claimGuard);
  }
  let released = false;
  const assertOwned = () => {
    privateDirectory(captured.directory, captured.home);
    const current = readPrivate(lock);
    if (
      released ||
      !current ||
      !identity(lockStat, current.stat) ||
      current.bytes !== lockBytes
    )
      throw fail();
  };
  return {
    async read() {
      assertOwned();
      const value = readPrivate(statePath);
      if (!value) return null;
      let record: DaemonRecord;
      try {
        record = parseDaemonRecord(JSON.parse(value.bytes));
      } catch {
        throw fail();
      }
      if (!sameBinding(record.binding, captured.binding))
        throw new Error("daemon_record_identity_mismatch");
      return record;
    },
    async write(record) {
      assertOwned();
      const candidate = parseDaemonRecord(record);
      if (
        !sameBinding(candidate.binding, captured.binding) ||
        candidate.pid !== captured.pid ||
        candidate.runId !== captured.runId
      )
        throw fail();
      const before = readPrivate(statePath);
      const tmp = join(
        captured.directory,
        `.state-${token}-${randomUUID()}.tmp`,
      );
      const fd = openSync(
        tmp,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      const tmpStat = lstatSync(tmp);
      try {
        try {
          writeFileSync(fd, JSON.stringify(candidate) + "\n");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        assertOwned();
        const current = readPrivate(statePath);
        if (
          before
            ? !current ||
              !identity(before.stat, current.stat) ||
              current.bytes !== before.bytes
            : current !== null
        )
          throw fail();
        renameSync(tmp, statePath);
        const directoryFd = openSync(
          captured.directory,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
      } finally {
        const remaining = stat(tmp);
        if (remaining && identity(tmpStat, remaining)) unlinkSync(tmp);
      }
    },
    async release() {
      if (released) return;
      assertOwned();
      unlinkSync(lock);
      released = true;
    },
  };
}
