/** One foreground lifetime owns both feeds. Shutdown retains locks until every IO task settles. */
export interface DaemonBinding {
  account: string;
  origin: string;
  replicaDb: string;
  eventDirectory: string;
}
export type DaemonComponentState = "starting" | "live" | "backoff" | "stopped";
export type DaemonStopReason =
  | "authentication_required"
  | "event_history_gap"
  | "writer_conflict"
  | "identity_mismatch"
  | "replica_failure_cap"
  | "event_failure_cap";
export interface DaemonRecord {
  schema: 1;
  binding: DaemonBinding;
  runId: string;
  pid: number;
  updatedAt: number;
  state: "starting" | "live" | "backoff" | "stopped";
  replica: { state: DaemonComponentState; failures: number };
  events: {
    state: DaemonComponentState;
    failures: number;
    cursor: number | null;
    head: number | null;
  };
  stopped: {
    at: number;
    reason: DaemonStopReason;
    restartWith: "catalyst daemon restart";
  } | null;
}
export interface DaemonLease {
  read(): Promise<DaemonRecord | null>;
  write(record: DaemonRecord): Promise<void>;
  release(): Promise<void>;
}
export interface DaemonReplicaAttempt {
  /** Resolves after first usable connection; a later reconnect clears the live barrier. */
  start(
    onState: (state: "live" | "reconnecting" | "auth-required") => void,
  ): Promise<void>;
  close(): Promise<void>;
}
export interface DaemonEventClient {
  syncOnce(
    signal: AbortSignal,
  ): Promise<{ appended: number; cursor: number; head: number }>;
  stop(): Promise<void>;
}
export interface DaemonAuthorityTask {
  assertCurrent(): void;
  run(
    signal: AbortSignal,
    onFailure: (
      reason: "authentication_required" | "identity_mismatch",
    ) => Promise<void>,
  ): Promise<void>;
  stop(): Promise<void>;
}
export interface DaemonSupervisorPorts {
  authority?: DaemonAuthorityTask;
  binding: DaemonBinding;
  runId: string;
  pid: number;
  signal: AbortSignal;
  claim(): Promise<DaemonLease>;
  replica(): Promise<DaemonReplicaAttempt>;
  events(): Promise<DaemonEventClient>;
  classify(
    error: unknown,
  ):
    | "authentication"
    | "history-gap"
    | "writer-conflict"
    | "identity"
    | "transient"
    | "unexpected";
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
  maxFailures?: number;
  liveStableMs?: number;
  restart?: boolean;
}
const sameBinding = (a: DaemonBinding, b: DaemonBinding) =>
  a.account === b.account &&
  a.origin === b.origin &&
  a.replicaDb === b.replicaDb &&
  a.eventDirectory === b.eventDirectory;
const copy = (state: DaemonRecord): DaemonRecord => ({
  ...state,
  binding: { ...state.binding },
  replica: { ...state.replica },
  events: { ...state.events },
  stopped: state.stopped ? { ...state.stopped } : null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Exit 0 means requested or deliberate stop. Unexpected failures reject for OS crash restart.
 * “live” describes both running clients, not an independent current cloud-head freshness proof. */
export async function runDaemonSupervisor(
  ports: DaemonSupervisorPorts,
): Promise<DaemonRecord | null> {
  let claimed = false;
  let failed = false;
  let primary: unknown;
  let result: DaemonRecord | null = null;
  try {
    result = await runOwnedDaemonSupervisor({
      ...ports,
      claim: async () => {
        const lease = await ports.claim();
        claimed = true;
        return lease;
      },
    });
  } catch (error) {
    failed = true;
    primary = error;
  } finally {
    // Before claim succeeds the inner lease lifetime has not begun, but this call still owns
    // the injected authority task, including its refused preflight and any entered reader IO.
    if (!claimed && ports.authority) {
      try {
        await ports.authority.stop();
      } catch (cleanup) {
        throw new AggregateError(
          failed ? [primary, cleanup] : [cleanup],
          "daemon_authority_cleanup_failed",
        );
      }
    }
  }
  if (failed) throw primary;
  return result;
}
async function runOwnedDaemonSupervisor(
  ports: DaemonSupervisorPorts,
): Promise<DaemonRecord | null> {
  const maxFailures = ports.maxFailures ?? 5;
  const liveStableMs = ports.liveStableMs ?? 60_000;
  if (
    !Number.isSafeInteger(liveStableMs) ||
    liveStableMs < 1 ||
    liveStableMs > 900_000
  )
    throw new Error("daemon_stability_budget_invalid");
  if (
    !Number.isSafeInteger(maxFailures) ||
    maxFailures < 1 ||
    maxFailures > 100
  )
    throw new Error("daemon_failure_cap_invalid");
  if (ports.signal.aborted) return null;
  ports.authority?.assertCurrent();
  const lease = await ports.claim();
  const owned = new AbortController();
  const signal = AbortSignal.any([owned.signal, ports.signal]);
  const stop = deferred<void>();
  const stopped = () => stop.resolve(undefined);
  signal.addEventListener("abort", stopped, { once: true });
  if (signal.aborted) stopped();
  let record: DaemonRecord | null = null;
  // A rejected cleanup has not acknowledged ownership release, even if start has settled.
  let cleanupAcknowledged = true;
  let queue = Promise.resolve();
  const eventClient: { current: DaemonEventClient | null } = { current: null };
  const backgroundFailure: { present: boolean; error?: unknown } = {
    present: false,
  };
  const write = async () => {
    if (!record) return;
    record.updatedAt = ports.now();
    record.state =
      record.stopped || signal.aborted
        ? "stopped"
        : record.replica.state === "live" && record.events.state === "live"
          ? "live"
          : record.replica.state === "backoff" ||
              record.events.state === "backoff"
            ? "backoff"
            : "starting";
    const snapshot = copy(record);
    const pending = queue.then(() => lease.write(snapshot));
    queue = pending.catch(() => {});
    await pending;
  };
  const terminal = async (reason: DaemonStopReason) => {
    if (!record || record.stopped) return;
    record.stopped = {
      at: ports.now(),
      reason,
      restartWith: "catalyst daemon restart",
    };
    // Stop the other client immediately; the latch is saved before this lifetime releases its lease.
    owned.abort();
    await write();
  };
  const checkAuthority = (): Promise<void> | null => {
    try {
      ports.authority?.assertCurrent();
      return null;
    } catch (error) {
      const kind = ports.classify(error);
      if (kind === "authentication" || kind === "identity")
        return terminal(
          kind === "identity" ? "identity_mismatch" : "authentication_required",
        );
      throw error;
    }
  };
  const failure = async (component: "replica" | "events", error: unknown) => {
    if (!record || signal.aborted) return;
    const kind = ports.classify(error);
    if (kind === "unexpected") throw error;
    if (kind !== "transient") {
      const reasons = {
        authentication: "authentication_required",
        "history-gap": "event_history_gap",
        "writer-conflict": "writer_conflict",
        identity: "identity_mismatch",
      } as const;
      await terminal(reasons[kind]);
      return;
    }
    const state = record[component];
    state.state = "backoff";
    state.failures++;
    if (state.failures >= maxFailures) {
      await terminal(
        component === "replica" ? "replica_failure_cap" : "event_failure_cap",
      );
      return;
    }
    await write();
    const jitter = ports.random();
    if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1)
      throw new Error("daemon_jitter_invalid");
    try {
      await ports.sleep(
        Math.floor(
          Math.min(30_000 * 2 ** (state.failures - 1), 900_000) * jitter,
        ),
        signal,
      );
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  };
  const replicaLoop = async () => {
    while (!signal.aborted) {
      let attempt: DaemonReplicaAttempt | null = null;
      let started: Promise<void> | null = null;
      let problem: unknown;
      const failed = deferred<unknown>();
      try {
        const denied = checkAuthority();
        if (denied) {
          await denied;
          break;
        }
        attempt = await ports.replica();
        if (signal.aborted) break;
        const factoryDenied = checkAuthority();
        if (factoryDenied) {
          await factoryDenied;
          break;
        }
        record!.replica.state = "starting";
        await write();
        const startDenied = checkAuthority();
        if (startDenied) {
          await startDenied;
          break;
        }
        started = attempt.start((state) => {
          if (signal.aborted) return;
          if (state === "auth-required") {
            // A known auth refusal stops both feeds and records its latch immediately, even
            // while this attempt is still draining IO in close().
            void terminal("authentication_required").catch((error) => {
              backgroundFailure.present = true;
              backgroundFailure.error = error;
              owned.abort();
            });
            failed.resolve({ daemonFailure: "authentication" });
          } else if (state === "reconnecting") {
            record!.replica.state = "backoff";
            record!.state = "backoff";
            // Queue the cleared barrier before draining this attempt. Store failures are crashes,
            // even when a transient reconnect has already won the attempt's failure race.
            void write().catch((error) => {
              backgroundFailure.present = true;
              backgroundFailure.error = error;
              owned.abort();
            });
            failed.resolve({ daemonFailure: "transient" });
          }
        });
        // Both branches have rejection handlers; cleanup below awaits the losing start promise too.
        const first = await Promise.race([
          started.then(
            () => ({ ready: true as const }),
            (error) => ({ error }),
          ),
          failed.promise.then((error) => ({ error })),
          stop.promise.then(() => ({ stopped: true as const })),
        ]);
        if ("error" in first) problem = first.error;
        else if ("ready" in first && !signal.aborted) {
          const liveDenied = checkAuthority();
          if (liveDenied) {
            await liveDenied;
            break;
          }
          record!.replica.state = "live";
          await write();
          // A warm connection can precede a failed resync. Reset persisted failures only after a
          // stable lifetime, so crash/reconnect loops cannot repeatedly erase their failure cap.
          if (record!.replica.failures > 0) {
            const stable = new AbortController();
            try {
              const outcome = await Promise.race([
                failed.promise.then((error) => ({ error })),
                stop.promise.then(() => ({ stopped: true as const })),
                ports
                  .sleep(liveStableMs, AbortSignal.any([signal, stable.signal]))
                  .then(() => ({ stable: true as const })),
              ]);
              if ("stable" in outcome && !signal.aborted) {
                const stableDenied = checkAuthority();
                if (stableDenied) {
                  await stableDenied;
                  break;
                }
                record!.replica.failures = 0;
                await write();
                problem = await Promise.race([failed.promise, stop.promise]);
              } else if ("error" in outcome) problem = outcome.error;
            } finally {
              stable.abort();
            }
          } else problem = await Promise.race([failed.promise, stop.promise]);
        }
      } catch (error) {
        problem = error;
      } finally {
        // SDK close resolves/cancels start and releases only this attempt's writer lock.
        try {
          if (attempt) await attempt.close();
        } catch (error) {
          cleanupAcknowledged = false;
          // A failed close cannot keep its peer running while the entered start task drains.
          owned.abort();
          throw error;
        } finally {
          if (started) await started.catch(() => {});
        }
      }
      if (!signal.aborted) await failure("replica", problem);
    }
  };
  const eventLoop = async () => {
    if (signal.aborted) return;
    const denied = checkAuthority();
    if (denied) {
      await denied;
      return;
    }
    eventClient.current = await ports.events();
    let idle = 1_000;
    while (!signal.aborted) {
      const denied = checkAuthority();
      if (denied) {
        await denied;
        break;
      }
      const request = new AbortController();
      const requestSignal = AbortSignal.any([signal, request.signal]);
      const timer = setTimeout(() => request.abort(), 30_000);
      let problem: unknown;
      let failed = false;
      try {
        // Direct syncOnce is not tracked by SDK stop(). Await it here even after cancellation:
        // releasing its lock early would permit a second writer while old filesystem IO continues.
        const result = await eventClient.current.syncOnce(requestSignal);
        if (signal.aborted) break;
        if (request.signal.aborted) throw { daemonFailure: "transient" };
        const resultDenied = checkAuthority();
        if (resultDenied) {
          await resultDenied;
          break;
        }
        if (
          ![result.appended, result.cursor, result.head].every(
            (value) => Number.isSafeInteger(value) && value >= 0,
          ) ||
          result.cursor > result.head
        )
          throw new Error("daemon_event_result_invalid");
        record!.events = {
          state: result.cursor === result.head ? "live" : "starting",
          failures: 0,
          cursor: result.cursor,
          head: result.head,
        };
        await write();
        idle = result.appended > 0 ? 1_000 : Math.min(idle * 2, 30_000);
      } catch (error) {
        problem = error;
        failed = true;
      } finally {
        clearTimeout(timer);
      }
      if (signal.aborted) break;
      if (failed) await failure("events", problem);
      else {
        try {
          await ports.sleep(idle, signal);
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    }
  };
  try {
    const previous = await lease.read();
    if (previous && !sameBinding(previous.binding, ports.binding))
      throw new Error("daemon_record_identity_mismatch");
    if (previous?.stopped && !ports.restart) return previous;
    if (
      previous &&
      ![previous.replica.failures, previous.events.failures].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new Error("daemon_record_invalid");
    if (signal.aborted) return null;
    record = {
      schema: 1,
      binding: { ...ports.binding },
      runId: ports.runId,
      pid: ports.pid,
      updatedAt: ports.now(),
      state: "starting",
      replica: {
        state: "starting",
        failures: ports.restart ? 0 : (previous?.replica.failures ?? 0),
      },
      events: {
        state: "starting",
        failures: ports.restart ? 0 : (previous?.events.failures ?? 0),
        cursor: previous?.events.cursor ?? null,
        head: previous?.events.head ?? null,
      },
      stopped: null,
    };
    await write();
    if (
      record.replica.failures >= maxFailures ||
      record.events.failures >= maxFailures
    ) {
      await terminal(
        record.replica.failures >= maxFailures
          ? "replica_failure_cap"
          : "event_failure_cap",
      );
      return record;
    }
    const denied = checkAuthority();
    if (denied) {
      await denied;
      return record;
    }
    const tasks = [
      ...(ports.authority ? [ports.authority.run(signal, terminal)] : []),
      replicaLoop(),
      eventLoop(),
    ].map((task) =>
      task.catch((error) => {
        owned.abort();
        throw error;
      }),
    );
    const results = await Promise.allSettled(tasks);
    if (backgroundFailure.present) throw backgroundFailure.error;
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return record;
  } finally {
    owned.abort();
    // Event loop has fully acknowledged direct syncOnce settlement before stop releases its lock.
    try {
      // Join every entered cleanup even if its peer rejects. A failed authority reader ACK
      // retains the same lease as a failed SDK close/stop.
      const cleanups = await Promise.allSettled([
        ...(eventClient.current
          ? [Promise.resolve().then(() => eventClient.current!.stop())]
          : []),
        ...(ports.authority
          ? [Promise.resolve().then(() => ports.authority!.stop())]
          : []),
      ]);
      const failures = cleanups.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "daemon_cleanup_failed");
    } catch (error) {
      cleanupAcknowledged = false;
      throw error;
    } finally {
      try {
        if (record && cleanupAcknowledged) {
          record.replica.state = "stopped";
          record.events.state = "stopped";
          await write();
        }
        await queue;
        if (backgroundFailure.present) throw backgroundFailure.error;
      } finally {
        signal.removeEventListener("abort", stopped);
        // Retain the live PID-bound lease on cleanup failure. Only positive process death
        // permits a later claimant to recover it; SDK writer locks remain owned as well.
        if (cleanupAcknowledged) await lease.release();
      }
    }
  }
}
