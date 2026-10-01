import { afterEach, describe, expect, test, vi } from "vitest";
import {
  runDaemonSupervisor,
  type DaemonBinding,
  type DaemonEventClient,
  type DaemonLease,
  type DaemonRecord,
  type DaemonReplicaAttempt,
  type DaemonSupervisorPorts,
} from "../src/daemon-supervisor";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const binding: DaemonBinding = {
  account: "account-one",
  origin: "https://cloud.example.test",
  replicaDb: "/owned/account-one/replica.db",
  eventDirectory: "/owned/account-one/events",
};

function previousRecord(): DaemonRecord {
  return {
    schema: 1,
    binding: { ...binding },
    runId: "previous-lifetime",
    pid: 101,
    updatedAt: 100,
    state: "backoff",
    replica: { state: "backoff", failures: 2 },
    events: { state: "backoff", failures: 1, cursor: 7, head: 10 },
    stopped: null,
  };
}

type ReplicaState = Parameters<DaemonReplicaAttempt["start"]>[0];
class ControlledReplica implements DaemonReplicaAttempt {
  readonly ready = deferred<void>();
  readonly closing = deferred<void>();
  closeGate: ReturnType<typeof deferred<void>> | null = null;
  closeError: Error | null = null;
  onState: ReplicaState | null = null;
  closes = 0;
  constructor(private readonly log: string[]) {
    // Cleanup may cancel an attempt whose factory completed before start was entered.
    void this.ready.promise.catch(() => {});
  }
  start(onState: ReplicaState): Promise<void> {
    this.onState = onState;
    this.log.push("replica:start");
    return this.ready.promise;
  }
  async close(): Promise<void> {
    this.closes++;
    this.log.push("replica:close-enter");
    this.closing.resolve(undefined);
    if (this.closeGate) await this.closeGate.promise;
    if (this.closeError) throw this.closeError;
    // The port promises acknowledged shutdown, a stronger guarantee than SDK 0.13.1 close().
    this.ready.reject(new Error("replica closed before ready"));
    this.log.push("replica:close-complete");
  }
}

type EventResult = Awaited<ReturnType<DaemonEventClient["syncOnce"]>>;
interface SyncCall {
  signal: AbortSignal;
  response: ReturnType<typeof deferred<EventResult>>;
}
class ControlledEvents implements DaemonEventClient {
  readonly calls: SyncCall[] = [];
  stopGate: ReturnType<typeof deferred<void>> | null = null;
  stopError: Error | null = null;
  stops = 0;
  constructor(private readonly log: string[]) {}
  async syncOnce(signal: AbortSignal): Promise<EventResult> {
    const call = { signal, response: deferred<EventResult>() };
    this.calls.push(call);
    this.log.push("events:sync-enter");
    // Abort cancels transport; a held response represents filesystem work still settling.
    try {
      return await call.response.promise;
    } finally {
      this.log.push("events:sync-settled");
    }
  }
  async stop(): Promise<void> {
    this.stops++;
    this.log.push("events:stop-enter");
    if (this.stopGate) await this.stopGate.promise;
    if (this.stopError) throw this.stopError;
    this.log.push("events:stop-complete");
  }
}

interface SleepCall {
  ms: number;
  signal: AbortSignal;
  finished: ReturnType<typeof deferred<void>>;
}
type Outcome =
  { ok: true; value: DaemonRecord | null } | { ok: false; error: unknown };
const fixtures: Fixture[] = [];
class Fixture {
  readonly controller = new AbortController();
  readonly log: string[] = [];
  readonly writes: DaemonRecord[] = [];
  readonly replicas: ControlledReplica[] = [];
  readonly events = new ControlledEvents(this.log);
  readonly sleeps: SleepCall[] = [];
  previous: DaemonRecord | null = null;
  claimError: Error | null = null;
  readError: Error | null = null;
  writeHook: ((record: DaemonRecord) => Promise<void>) | null = null;
  replicaHook: ((replica: ControlledReplica) => void) | null = null;
  claims = 0;
  reads = 0;
  releases = 0;
  eventFactories = 0;
  writing = 0;
  maxConcurrentWrites = 0;
  outcome: Promise<Outcome> | null = null;
  readonly cleanupActions: Array<() => void> = [];
  readonly lease: DaemonLease = {
    read: async () => {
      this.reads++;
      if (this.readError) throw this.readError;
      return this.previous;
    },
    write: async (record) => {
      this.writing++;
      this.maxConcurrentWrites = Math.max(
        this.maxConcurrentWrites,
        this.writing,
      );
      try {
        if (this.writeHook) await this.writeHook(record);
        this.writes.push(record);
        this.log.push(`write:${record.state}`);
      } finally {
        this.writing--;
      }
    },
    release: async () => {
      this.releases++;
      this.log.push("lease:release");
    },
  };
  readonly ports: DaemonSupervisorPorts = {
    binding: { ...binding },
    runId: "new-lifetime",
    pid: 202,
    signal: this.controller.signal,
    claim: async () => {
      this.claims++;
      if (this.claimError) throw this.claimError;
      return this.lease;
    },
    replica: async () => {
      const attempt = new ControlledReplica(this.log);
      this.replicaHook?.(attempt);
      this.replicas.push(attempt);
      return attempt;
    },
    events: async () => {
      this.eventFactories++;
      return this.events;
    },
    classify: (error) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "daemonFailure" in error
      ) {
        const kind = error.daemonFailure;
        if (
          kind === "authentication" ||
          kind === "history-gap" ||
          kind === "writer-conflict" ||
          kind === "identity" ||
          kind === "transient"
        )
          return kind;
      }
      return "unexpected";
    },
    now: () => 1_000,
    random: () => 0.5,
    sleep: (ms, signal) => {
      const finished = deferred<void>();
      const abort = () => finished.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      this.sleeps.push({ ms, signal, finished });
      return finished.promise.finally(() =>
        signal.removeEventListener("abort", abort),
      );
    },
  };
  constructor() {
    fixtures.push(this);
  }
  run(): Promise<DaemonRecord | null> {
    const running = runDaemonSupervisor(this.ports);
    this.outcome = running.then<Outcome, Outcome>(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    return running;
  }
  async replica(index = 0): Promise<ControlledReplica> {
    await vi.waitFor(() =>
      expect(this.replicas[index]?.onState).toBeTypeOf("function"),
    );
    const attempt = this.replicas[index];
    if (!attempt?.onState) throw new Error("replica did not enter start");
    return attempt;
  }
  async sync(index = 0): Promise<SyncCall> {
    await vi.waitFor(() =>
      expect(this.events.calls.length).toBeGreaterThan(index),
    );
    return this.events.calls[index]!;
  }
  async written(
    predicate: (record: DaemonRecord) => boolean,
  ): Promise<DaemonRecord> {
    await vi.waitFor(() => expect(this.writes.some(predicate)).toBe(true));
    const record = this.writes.find(predicate);
    if (!record) throw new Error("record not written");
    return record;
  }
  settleSyncs(): void {
    for (const call of this.events.calls)
      call.response.resolve({ appended: 0, cursor: 10, head: 10 });
  }
  async finish(
    running: Promise<DaemonRecord | null>,
  ): Promise<DaemonRecord | null> {
    this.controller.abort();
    this.settleSyncs();
    return running;
  }
  async cleanup(): Promise<void> {
    this.controller.abort();
    this.writeHook = null;
    for (const action of this.cleanupActions) action();
    for (const attempt of this.replicas) {
      attempt.closeGate?.resolve(undefined);
      attempt.ready.reject(new Error("test cleanup"));
    }
    this.events.stopGate?.resolve(undefined);
    this.settleSyncs();
    if (this.outcome) await this.outcome;
  }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
  vi.useRealTimers();
});

// One event-loop turn exposes premature completion while controlled IO remains pending.
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("daemon supervisor ownership and durable stop latch", () => {
  test("a signal already aborted never claims a lease or constructs clients", async () => {
    const f = new Fixture();
    f.controller.abort();
    expect(await f.run()).toBeNull();
    expect([
      f.claims,
      f.reads,
      f.releases,
      f.replicas.length,
      f.eventFactories,
      f.writes.length,
    ]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("ordinary relaunch returns the existing stop latch without feed IO or writes", async () => {
    const f = new Fixture();
    f.previous = previousRecord();
    f.previous.state = "stopped";
    f.previous.stopped = {
      at: 900,
      reason: "authentication_required",
      restartWith: "catalyst daemon restart",
    };
    const before = structuredClone(f.previous);
    expect(await f.run()).toEqual(before);
    expect(f.previous).toEqual(before);
    expect(f.writes).toEqual([]);
    expect(f.replicas).toEqual([]);
    expect(f.eventFactories).toBe(0);
    expect(f.releases).toBe(1);
  });

  test("explicit restart clears the latch and counters but retains the event checkpoint", async () => {
    const f = new Fixture();
    f.previous = previousRecord();
    f.previous.stopped = {
      at: 900,
      reason: "event_failure_cap",
      restartWith: "catalyst daemon restart",
    };
    f.previous.replica.failures = 5;
    f.previous.events.failures = 5;
    f.ports.restart = true;
    const done = f.run();
    await f.sync();
    expect(f.writes[0]).toMatchObject({
      runId: "new-lifetime",
      pid: 202,
      stopped: null,
      replica: { failures: 0 },
      events: { failures: 0, cursor: 7, head: 10 },
    });
    await f.finish(done);
    expect(f.previous.stopped?.reason).toBe("event_failure_cap");
  });

  test.each(["account", "origin", "replicaDb", "eventDirectory"] as const)(
    "a foreign %s binding refuses without changing its record",
    async (field) => {
      const f = new Fixture();
      f.previous = previousRecord();
      f.previous.binding[field] += "-foreign";
      const before = structuredClone(f.previous);
      await expect(f.run()).rejects.toThrow("daemon_record_identity_mismatch");
      expect(f.previous).toEqual(before);
      expect(f.writes).toEqual([]);
      expect(f.replicas).toEqual([]);
      expect(f.eventFactories).toBe(0);
      expect(f.releases).toBe(1);
    },
  );

  test("a foreign writer's rejected claim does not release an unowned lease", async () => {
    const f = new Fixture();
    f.claimError = new Error("foreign writer owns lease");
    await expect(f.run()).rejects.toBe(f.claimError);
    expect([
      f.reads,
      f.releases,
      f.writes.length,
      f.eventFactories,
      f.replicas.length,
    ]).toEqual([0, 0, 0, 0, 0]);
  });

  test("read failure releases the claimed lease and never begins either feed", async () => {
    const f = new Fixture();
    f.readError = new Error("record unreadable");
    await expect(f.run()).rejects.toBe(f.readError);
    expect(f.releases).toBe(1);
    expect(f.writes).toEqual([]);
    expect(f.eventFactories).toBe(0);
    expect(f.replicas).toEqual([]);
  });

  test.each(["replica", "events"] as const)(
    "persisted %s failure cap stops before client construction",
    async (component) => {
      const f = new Fixture();
      f.previous = previousRecord();
      f.previous[component].failures = 5;
      const result = await f.run();
      expect(result?.stopped?.reason).toBe(
        component === "replica" ? "replica_failure_cap" : "event_failure_cap",
      );
      expect(f.eventFactories).toBe(0);
      expect(f.replicas).toEqual([]);
      expect(f.writes.at(-1)?.state).toBe("stopped");
      expect(f.releases).toBe(1);
    },
  );

  test("a new lifetime continues the replica failure budget instead of granting five new attempts", async () => {
    const f = new Fixture();
    f.previous = previousRecord();
    f.previous.replica.failures = 4;
    const done = f.run();
    const attempt = await f.replica();
    const sync = await f.sync();
    attempt.ready.resolve(undefined);
    await f.written((record) => record.replica.state === "live");
    attempt.onState?.("reconnecting");
    await f.written(
      (record) => record.stopped?.reason === "replica_failure_cap",
    );
    expect(sync.signal.aborted).toBe(true);
    expect(f.releases).toBe(0);
    sync.response.resolve({ appended: 0, cursor: 10, head: 10 });
    const result = await done;
    expect(result?.replica.failures).toBe(5);
    expect(result?.events.failures).toBe(1);
    expect(f.replicas).toHaveLength(1);
  });
});

describe("daemon live barriers and retry budgets", () => {
  test("event deadline aborts transport but does not retry until the timed-out direct IO settles", async () => {
    vi.useFakeTimers();
    const f = new Fixture();
    const done = f.run();
    const sync = await f.sync();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sync.signal.aborted).toBe(true);
    expect(f.events.calls).toHaveLength(1);
    expect(f.events.stops).toBe(0);
    expect(f.releases).toBe(0);
    sync.response.resolve({ appended: 1, cursor: 10, head: 10 });
    await f.written(
      (record) =>
        record.events.failures === 1 && record.events.state === "backoff",
    );
    expect(f.writes.some((record) => record.events.state === "live")).toBe(
      false,
    );
    vi.useRealTimers();
    await f.finish(done);
  });

  test("replica readiness alone and an event page below head cannot publish aggregate live", async () => {
    const f = new Fixture();
    const done = f.run();
    const attempt = await f.replica();
    attempt.ready.resolve(undefined);
    const first = await f.sync();
    first.response.resolve({ appended: 3, cursor: 7, head: 10 });
    await f.written((record) => record.events.cursor === 7);
    expect(f.writes.some((record) => record.state === "live")).toBe(false);
    await vi.waitFor(() =>
      expect(f.sleeps.some((call) => call.ms === 1_000)).toBe(true),
    );
    f.sleeps.find((call) => call.ms === 1_000)!.finished.resolve(undefined);
    const second = await f.sync(1);
    second.response.resolve({ appended: 3, cursor: 10, head: 10 });
    await f.written(
      (record) => record.state === "live" && record.events.cursor === 10,
    );
    await f.finish(done);
    expect(f.writes[0]?.replica.state).toBe("starting");
    expect(
      f.writes.find((record) => record.events.cursor === 7)?.events.state,
    ).toBe("starting");
  });

  test("replica failures reset only after a stable live interval", async () => {
    const f = new Fixture();
    f.previous = previousRecord();
    f.ports.liveStableMs = 5_000;
    const done = f.run();
    const attempt = await f.replica();
    attempt.ready.resolve(undefined);
    await f.written((record) => record.replica.state === "live");
    expect(f.writes.at(-1)?.replica.failures).toBe(2);
    await vi.waitFor(() =>
      expect(f.sleeps.some((call) => call.ms === 5_000)).toBe(true),
    );
    f.sleeps.find((call) => call.ms === 5_000)!.finished.resolve(undefined);
    await f.written(
      (record) =>
        record.replica.state === "live" && record.replica.failures === 0,
    );
    await f.finish(done);
    expect(
      f.writes.find((record) => record.replica.state === "live")?.replica
        .failures,
    ).toBe(2);
  });

  test("a reconnect during stability preserves and increments the previous failure count", async () => {
    const f = new Fixture();
    f.previous = previousRecord();
    f.ports.liveStableMs = 5_000;
    const done = f.run();
    const attempt = await f.replica();
    attempt.ready.resolve(undefined);
    await vi.waitFor(() =>
      expect(f.sleeps.some((call) => call.ms === 5_000)).toBe(true),
    );
    attempt.onState?.("reconnecting");
    await f.written((record) => record.replica.failures === 3);
    expect(f.sleeps.find((call) => call.ms === 5_000)?.signal.aborted).toBe(
      true,
    );
    expect(f.writes.some((record) => record.replica.failures === 0)).toBe(
      false,
    );
    await vi.waitFor(() =>
      expect(f.sleeps.some((call) => call.ms === 60_000)).toBe(true),
    );
    await f.finish(done);
  });

  test("reconnect removes durable live before replica close finishes draining", async () => {
    const f = new Fixture();
    const closeGate = deferred<void>();
    f.replicaHook = (attempt) => {
      attempt.closeGate = closeGate;
    };
    const done = f.run();
    const attempt = await f.replica();
    attempt.ready.resolve(undefined);
    (await f.sync()).response.resolve({ appended: 0, cursor: 10, head: 10 });
    await f.written((record) => record.state === "live");
    attempt.onState?.("reconnecting");
    await attempt.closing.promise;
    await turn();
    expect(f.writes.at(-1)?.state).toBe("backoff");
    expect(f.releases).toBe(0);
    closeGate.resolve(undefined);
    await f.finish(done);
  });

  test("successful event progress resets its retry count while still respecting the head barrier", async () => {
    const f = new Fixture();
    f.previous = previousRecord();
    const done = f.run();
    (await f.sync()).response.resolve({ appended: 1, cursor: 8, head: 10 });
    await f.written((record) => record.events.cursor === 8);
    expect(
      f.writes.find((record) => record.events.cursor === 8)?.events,
    ).toEqual({ state: "starting", failures: 0, cursor: 8, head: 10 });
    await f.finish(done);
  });

  test.each([
    { result: { appended: 0, cursor: 11, head: 10 } },
    { result: { appended: -1, cursor: 10, head: 10 } },
    { result: { appended: 1, cursor: 0.5, head: 10 } },
  ])(
    "invalid event result $result rejects and cannot publish live",
    async ({ result }) => {
      const f = new Fixture();
      const done = f.run();
      (await f.sync()).response.resolve(result);
      await expect(done).rejects.toThrow("daemon_event_result_invalid");
      expect(f.writes.some((record) => record.state === "live")).toBe(false);
      expect(f.releases).toBe(1);
    },
  );
});

describe("daemon terminal classifications and crash propagation", () => {
  test.each([
    { kind: "authentication", reason: "authentication_required" },
    { kind: "history-gap", reason: "event_history_gap" },
    { kind: "writer-conflict", reason: "writer_conflict" },
    { kind: "identity", reason: "identity_mismatch" },
  ])(
    "event $kind saves a stop latch and closes the peer before releasing ownership",
    async ({ kind, reason }) => {
      const f = new Fixture();
      const done = f.run();
      const attempt = await f.replica();
      (await f.sync()).response.reject({ daemonFailure: kind });
      const result = await done;
      expect(result?.stopped).toEqual({
        at: 1_000,
        reason,
        restartWith: "catalyst daemon restart",
      });
      expect(attempt.closes).toBe(1);
      expect(f.sleeps).toEqual([]);
      expect(f.writes.at(-1)?.stopped?.reason).toBe(reason);
      expect(f.log.at(-1)).toBe("lease:release");
    },
  );

  test("replica auth-required cancels event transport but holds ownership until direct sync IO settles", async () => {
    const f = new Fixture();
    const done = f.run();
    const attempt = await f.replica();
    const sync = await f.sync();
    attempt.onState?.("auth-required");
    await f.written(
      (record) => record.stopped?.reason === "authentication_required",
    );
    expect(sync.signal.aborted).toBe(true);
    expect(f.events.stops).toBe(0);
    expect(f.releases).toBe(0);
    sync.response.resolve({ appended: 1, cursor: 10, head: 10 });
    expect((await done)?.stopped?.reason).toBe("authentication_required");
    expect(f.log.indexOf("events:sync-settled")).toBeLessThan(
      f.log.indexOf("events:stop-enter"),
    );
    expect(f.log.indexOf("events:stop-complete")).toBeLessThan(
      f.log.indexOf("lease:release"),
    );
  });

  test("known replica authentication failure latches and aborts its peer before a held close finishes", async () => {
    const f = new Fixture();
    const closeGate = deferred<void>();
    f.replicaHook = (attempt) => {
      attempt.closeGate = closeGate;
    };
    const done = f.run();
    const attempt = await f.replica();
    const sync = await f.sync();
    attempt.onState?.("auth-required");
    await attempt.closing.promise;
    await turn();
    const peerWasAbortedBeforeClose = sync.signal.aborted;
    const latchedBeforeClose = f.writes.some(
      (record) => record.stopped?.reason === "authentication_required",
    );
    expect(f.releases).toBe(0);
    closeGate.resolve(undefined);
    sync.response.resolve({ appended: 0, cursor: 10, head: 10 });
    expect((await done)?.stopped?.reason).toBe("authentication_required");
    expect(peerWasAbortedBeforeClose).toBe(true);
    expect(latchedBeforeClose).toBe(true);
  });

  test("unexpected event failure rejects for the OS supervisor without saving a deliberate latch", async () => {
    const f = new Fixture();
    const crash = new Error("unexpected filesystem failure");
    const done = f.run();
    await f.replica();
    (await f.sync()).response.reject(crash);
    await expect(done).rejects.toBe(crash);
    expect(f.writes.at(-1)).toMatchObject({ state: "stopped", stopped: null });
    expect(f.releases).toBe(1);
  });

  test("an event rejection without a payload is still an unexpected failure, not a successful idle poll", async () => {
    const f = new Fixture();
    const done = f.run();
    (await f.sync()).response.reject(undefined);
    await turn();
    // Also terminates the buggy idle path, so a failing assertion cannot hang this suite.
    f.controller.abort();
    f.settleSyncs();
    await expect(done).rejects.toBeUndefined();
    expect(f.writes.at(-1)?.stopped).toBeNull();
  });

  test("unexpected replica failure aborts its peer but does not release before peer IO settles", async () => {
    const f = new Fixture();
    const crash = new Error("replica invariant broken");
    const done = f.run();
    const attempt = await f.replica();
    const sync = await f.sync();
    attempt.ready.reject(crash);
    await vi.waitFor(() => expect(sync.signal.aborted).toBe(true));
    expect(f.releases).toBe(0);
    expect(f.events.stops).toBe(0);
    sync.response.resolve({ appended: 0, cursor: 10, head: 10 });
    await expect(done).rejects.toBe(crash);
    expect(f.writes.at(-1)?.stopped).toBeNull();
  });

  test("event transient failures use the persisted budget and cap without another request", async () => {
    const f = new Fixture();
    f.previous = previousRecord();
    f.previous.events.failures = 4;
    const done = f.run();
    (await f.sync()).response.reject({ daemonFailure: "transient" });
    const result = await done;
    expect(result?.stopped?.reason).toBe("event_failure_cap");
    expect(result?.events.failures).toBe(5);
    expect(f.events.calls).toHaveLength(1);
    expect(f.sleeps).toEqual([]);
  });
});

describe("daemon acknowledged shutdown and write failures", () => {
  test("a failed callback barrier write aborts the lifetime and cannot be hidden by successful cleanup writes", async () => {
    const f = new Fixture();
    const failure = new Error("durable reconnect barrier failed");
    f.writeHook = async (record) => {
      if (record.state === "backoff") throw failure;
    };
    const done = f.run();
    const attempt = await f.replica();
    const sync = await f.sync();
    attempt.ready.resolve(undefined);
    await f.written((record) => record.replica.state === "live");
    attempt.onState?.("reconnecting");
    await vi.waitFor(() => expect(sync.signal.aborted).toBe(true));
    expect(f.releases).toBe(0);
    sync.response.resolve({ appended: 0, cursor: 10, head: 10 });
    await expect(done).rejects.toBe(failure);
    expect(f.writes.at(-1)?.state).toBe("stopped");
    expect(f.releases).toBe(1);
  });

  test("concurrent client updates serialize immutable record snapshots", async () => {
    const f = new Fixture();
    const gate = deferred<void>();
    let held = false;
    f.cleanupActions.push(() => gate.resolve(undefined));
    f.writeHook = (record) => {
      if (record.replica.state === "live" && record.events.cursor === null) {
        held = true;
        return gate.promise;
      }
      return Promise.resolve();
    };
    const done = f.run();
    const attempt = await f.replica();
    const sync = await f.sync();
    attempt.ready.resolve(undefined);
    await vi.waitFor(() => expect(held).toBe(true));
    sync.response.resolve({ appended: 1, cursor: 10, head: 10 });
    await turn();
    expect(f.maxConcurrentWrites).toBe(1);
    gate.resolve(undefined);
    await f.written((record) => record.state === "live");
    const replicaOnly = f.writes.find(
      (record) =>
        record.replica.state === "live" && record.events.cursor === null,
    );
    expect(replicaOnly?.events.state).toBe("starting");
    await f.finish(done);
    expect(replicaOnly?.replica.state).toBe("live");
    expect(replicaOnly?.state).toBe("starting");
    expect(f.maxConcurrentWrites).toBe(1);
  });

  test("callbacks arriving after requested shutdown cannot publish live or a new auth latch", async () => {
    const f = new Fixture();
    const done = f.run();
    const attempt = await f.replica();
    const sync = await f.sync();
    f.controller.abort();
    attempt.onState?.("live");
    attempt.onState?.("reconnecting");
    attempt.onState?.("auth-required");
    sync.response.resolve({ appended: 1, cursor: 10, head: 10 });
    const result = await done;
    expect(result?.stopped).toBeNull();
    expect(result?.state).toBe("stopped");
    expect(f.writes.some((record) => record.state === "live")).toBe(false);
    expect(f.writes.some((record) => record.stopped !== null)).toBe(false);
  });

  test("requested shutdown awaits direct sync, SDK stop, final write, then lease release", async () => {
    const f = new Fixture();
    const stopGate = deferred<void>();
    const writeGate = deferred<void>();
    f.cleanupActions.push(() => writeGate.resolve(undefined));
    f.events.stopGate = stopGate;
    f.writeHook = (record) =>
      record.state === "stopped" ? writeGate.promise : Promise.resolve();
    const done = f.run();
    await f.replica();
    const sync = await f.sync();
    f.controller.abort();
    await turn();
    expect(sync.signal.aborted).toBe(true);
    expect(f.events.stops).toBe(0);
    expect(f.releases).toBe(0);
    sync.response.resolve({ appended: 1, cursor: 10, head: 10 });
    await vi.waitFor(() => expect(f.events.stops).toBe(1));
    expect(f.releases).toBe(0);
    stopGate.resolve(undefined);
    await vi.waitFor(() => expect(f.writing).toBe(1));
    expect(f.releases).toBe(0);
    writeGate.resolve(undefined);
    expect((await done)?.stopped).toBeNull();
    expect(f.log.slice(-3)).toEqual([
      "events:stop-complete",
      "write:stopped",
      "lease:release",
    ]);
    expect(f.maxConcurrentWrites).toBe(1);
  });

  test("a failed replica close joins the losing start promise and retains ownership", async () => {
    const f = new Fixture();
    const failure = new Error("replica close failed");
    f.replicaHook = (attempt) => {
      attempt.closeError = failure;
    };
    const done = f.run();
    const attempt = await f.replica();
    await f.sync();
    f.controller.abort();
    f.settleSyncs();
    await attempt.closing.promise;
    await turn();
    const releasedBeforeStartSettlement = f.releases;
    // Settle even on regression so this test cannot leave a dangling fake start task.
    attempt.ready.reject(new Error("start IO finally settled"));
    await expect(done).rejects.toBe(failure);
    expect(releasedBeforeStartSettlement).toBe(0);
    expect(f.releases).toBe(0);
    expect(f.writes.at(-1)?.replica.state).not.toBe("stopped");
    expect(f.events.stops).toBe(1);
  });

  test("event stop failure rejects the run and retains ownership without claiming cleanup", async () => {
    const f = new Fixture();
    const failure = new Error("event stop failed");
    f.events.stopError = failure;
    const done = f.run();
    await f.sync();
    f.controller.abort();
    f.settleSyncs();
    await expect(done).rejects.toBe(failure);
    expect(f.writes.at(-1)?.events.state).not.toBe("stopped");
    expect(f.releases).toBe(0);
    expect(f.log).not.toContain("lease:release");
  });

  test("a close rejection after first live cannot start another attempt or release ownership", async () => {
    const f = new Fixture();
    const failure = new Error("live engine close failed");
    f.replicaHook = (attempt) => {
      attempt.closeError = failure;
    };
    const done = f.run();
    const attempt = await f.replica();
    const sync = await f.sync();
    attempt.ready.resolve(undefined);
    sync.response.resolve({ appended: 1, cursor: 10, head: 10 });
    await vi.waitFor(() =>
      expect(f.writes.some((record) => record.state === "live")).toBe(true),
    );
    f.controller.abort();
    f.settleSyncs();
    await expect(done).rejects.toBe(failure);
    expect(f.replicas).toHaveLength(1);
    expect(f.releases).toBe(0);
    expect(f.log).not.toContain("replica:close-complete");
    expect(f.log).not.toContain("lease:release");
  });

  test("reconnect close failure aborts peer immediately while joining the entered start", async () => {
    const f = new Fixture();
    const failure = new Error("reconnecting engine close failed");
    f.replicaHook = (attempt) => {
      attempt.closeError = failure;
    };
    const done = f.run();
    const attempt = await f.replica();
    const sync = await f.sync();
    attempt.onState?.("reconnecting");
    await attempt.closing.promise;
    await turn();
    expect(f.controller.signal.aborted).toBe(false);
    expect(sync.signal.aborted).toBe(true);
    expect(f.releases).toBe(0);
    f.settleSyncs();
    await turn();
    expect(f.events.stops).toBe(0);
    attempt.ready.reject(
      new Error("entered start IO settled after failed close"),
    );
    await expect(done).rejects.toBe(failure);
    expect(f.events.stops).toBe(1);
    expect(f.replicas).toHaveLength(1);
    expect(f.releases).toBe(0);
  });

  test("failure of the final durable write is nonzero and releases ownership only after IO", async () => {
    const f = new Fixture();
    const failure = new Error("disk cannot save stopped record");
    f.writeHook = async (record) => {
      if (record.state === "stopped") throw failure;
    };
    const done = f.run();
    await f.sync();
    f.controller.abort();
    await turn();
    expect(f.releases).toBe(0);
    f.settleSyncs();
    await expect(done).rejects.toBe(failure);
    expect(f.events.stops).toBe(1);
    expect(f.releases).toBe(1);
    expect(f.log.indexOf("events:sync-settled")).toBeLessThan(
      f.log.indexOf("lease:release"),
    );
  });

  test("initial record write failure does not construct feeds and cannot become a successful run", async () => {
    const f = new Fixture();
    const failure = new Error("initial record write failed");
    f.writeHook = async () => {
      throw failure;
    };
    await expect(f.run()).rejects.toBe(failure);
    expect(f.eventFactories).toBe(0);
    expect(f.replicas).toEqual([]);
    expect(f.releases).toBe(1);
  });
});
