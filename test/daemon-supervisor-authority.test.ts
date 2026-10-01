import { afterEach, describe, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimDaemonLease, parseDaemonRecord } from "../src/daemon-store";
import { DaemonAuthorityError } from "../src/daemon-authority";
import {
  runDaemonSupervisor,
  type DaemonAuthorityTask,
  type DaemonBinding,
  type DaemonEventClient,
  type DaemonLease,
  type DaemonRecord,
  type DaemonReplicaAttempt,
  type DaemonSupervisorPorts,
} from "../src/daemon-supervisor";

// Explicit core-policy doubles. These do not prove SDK or native feed IO acknowledgements.
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Notice = Parameters<DaemonAuthorityTask["run"]>[1];
class Authority implements DaemonAuthorityTask {
  error: DaemonAuthorityError | undefined;
  notice: Notice | undefined;
  runHook: (() => void) | undefined;
  holdRun = false;
  readonly runGate = deferred<void>();
  stopGate: ReturnType<typeof deferred<void>> | undefined;
  stopError: Error | undefined;
  asserts = 0;
  runs = 0;
  stops = 0;
  constructor(readonly log: string[]) {
    void this.runGate.promise.catch(() => {});
  }
  assertCurrent() {
    this.asserts++;
    this.log.push("authority:assert");
    if (this.error) throw this.error;
  }
  run(signal: AbortSignal, onFailure: Notice) {
    this.runs++;
    this.notice = onFailure;
    this.log.push("authority:run");
    const abort = () => {
      this.log.push("authority:abort");
      if (!this.holdRun) this.runGate.resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    this.runHook?.();
    return this.runGate.promise.finally(() =>
      signal.removeEventListener("abort", abort),
    );
  }
  async stop() {
    this.stops++;
    this.log.push("authority:stop-enter");
    if (this.stopGate) await this.stopGate.promise;
    if (this.stopError) throw this.stopError;
    this.log.push("authority:stop-ack");
  }
  fail(reason: "authentication_required" | "identity_mismatch") {
    if (!this.notice) throw new Error("authority has no supervisor callback");
    return this.notice(reason);
  }
}
class Replica implements DaemonReplicaAttempt {
  readonly ready = deferred<void>();
  readonly closing = deferred<void>();
  closeGate: ReturnType<typeof deferred<void>> | undefined;
  closeError: Error | undefined;
  starts = 0;
  constructor(readonly log: string[]) {
    void this.ready.promise.catch(() => {});
  }
  start() {
    this.starts++;
    this.log.push("replica:start");
    return this.ready.promise;
  }
  async close() {
    this.log.push("replica:close-enter");
    this.closing.resolve();
    if (this.closeGate) await this.closeGate.promise;
    this.ready.reject(new Error("owned mock replica start stopped"));
    if (this.closeError) throw this.closeError;
    this.log.push("replica:close-ack");
  }
}
type EventResult = Awaited<ReturnType<DaemonEventClient["syncOnce"]>>;
class Events implements DaemonEventClient {
  readonly calls: {
    signal: AbortSignal;
    gate: ReturnType<typeof deferred<EventResult>>;
  }[] = [];
  stopGate: ReturnType<typeof deferred<void>> | undefined;
  stopError: Error | undefined;
  stops = 0;
  constructor(readonly log: string[]) {}
  async syncOnce(signal: AbortSignal) {
    const gate = deferred<EventResult>();
    this.calls.push({ signal, gate });
    this.log.push("events:sync-enter");
    try {
      return await gate.promise;
    } finally {
      this.log.push("events:sync-ack");
    }
  }
  async stop() {
    this.stops++;
    this.log.push("events:stop-enter");
    if (this.stopGate) await this.stopGate.promise;
    if (this.stopError) throw this.stopError;
    this.log.push("events:stop-ack");
  }
}
type Outcome =
  { ok: true; value: DaemonRecord | null } | { ok: false; error: unknown };
const fixtures: Fixture[] = [];
class Fixture {
  readonly home = mkdtempSync(
    join(realpathSync(tmpdir()), "daemon-authority-core-"),
  );
  readonly directory = join(this.home, "daemon");
  readonly lock = join(this.directory, "writer.lock");
  readonly controller = new AbortController();
  readonly log: string[] = [];
  readonly writes: DaemonRecord[] = [];
  readonly authority = new Authority(this.log);
  readonly events = new Events(this.log);
  readonly replicas: Replica[] = [];
  readonly sleeps: { gate: ReturnType<typeof deferred<void>>; ms: number }[] =
    [];
  readonly binding: DaemonBinding = {
    account: "account-one",
    origin: "https://cloud.example.test",
    replicaDb: join(this.home, "replica.db"),
    eventDirectory: join(this.home, "events"),
  };
  claims = 0;
  releases = 0;
  eventFactories = 0;
  claimHook: (() => void) | undefined;
  replicaHook: ((replica: Replica) => void) | undefined;
  lease: DaemonLease | undefined;
  result: Promise<Outcome> | undefined;
  readonly ports: DaemonSupervisorPorts = {
    authority: this.authority,
    binding: this.binding,
    runId: "current-authority-run",
    pid: process.pid,
    signal: this.controller.signal,
    claim: async () => {
      this.claims++;
      this.log.push("lease:claim");
      this.claimHook?.();
      const real = this.rawClaim();
      this.lease = real;
      return {
        read: () => real.read(),
        write: async (record) => {
          await real.write(record);
          this.writes.push(structuredClone(record));
        },
        release: async () => {
          this.releases++;
          this.log.push("lease:release");
          await real.release();
        },
      };
    },
    replica: async () => {
      this.log.push("replica:factory");
      const replica = new Replica(this.log);
      this.replicas.push(replica);
      this.replicaHook?.(replica);
      return replica;
    },
    events: async () => {
      this.log.push("events:factory");
      this.eventFactories++;
      return this.events;
    },
    classify: (error) => {
      if (error instanceof DaemonAuthorityError) return error.kind;
      if (
        typeof error === "object" &&
        error !== null &&
        "daemonFailure" in error &&
        error.daemonFailure === "transient"
      )
        return "transient";
      return "unexpected";
    },
    now: () => 1_000,
    random: () => 0.5,
    sleep: (ms, signal) => {
      const gate = deferred<void>(),
        abort = () => gate.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      this.sleeps.push({ gate, ms });
      return gate.promise.finally(() =>
        signal.removeEventListener("abort", abort),
      );
    },
  };
  constructor() {
    mkdirSync(this.directory, { mode: 0o700 });
    fixtures.push(this);
  }
  rawClaim() {
    return claimDaemonLease({
      home: this.home,
      directory: this.directory,
      binding: this.binding,
      runId: this.ports.runId,
      pid: process.pid,
    });
  }
  state() {
    return parseDaemonRecord(
      JSON.parse(readFileSync(join(this.directory, "state.json"), "utf8")),
    );
  }
  start() {
    const run = runDaemonSupervisor(this.ports);
    this.result = run.then<Outcome, Outcome>(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    return this.result;
  }
  async entered() {
    await vi.waitFor(() => {
      expect(this.replicas[0]?.starts).toBe(1);
      expect(this.events.calls).toHaveLength(1);
    });
  }
  settleSync() {
    for (const call of this.events.calls)
      call.gate.resolve({ appended: 0, cursor: 10, head: 10 });
  }
  async cleanup() {
    this.controller.abort();
    this.authority.runGate.resolve();
    this.authority.stopGate?.resolve();
    this.events.stopGate?.resolve();
    this.settleSync();
    for (const replica of this.replicas) {
      replica.closeGate?.resolve();
      replica.ready.reject(new Error("fixture teardown"));
    }
    for (const sleep of this.sleeps) sleep.gate.resolve();
    await this.result;
    // Only this private test's exact real lease is released after assertions.
    await this.lease?.release().catch(() => {});
    rmSync(this.home, { recursive: true, force: true });
  }
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
function contains(error: unknown, cause: unknown): boolean {
  return (
    error === cause ||
    (error instanceof AggregateError &&
      error.errors.some((item) => contains(item, cause)))
  );
}

describe("supervisor authority integration core policy with real persisted leases", () => {
  test("pre-aborted lifetime claims nothing and starts no authority or feed", async () => {
    const f = new Fixture();
    f.controller.abort();
    expect(await f.start()).toEqual({ ok: true, value: null });
    expect(f.authority.asserts).toBe(0);
    expect(f.claims).toBe(0);
    expect(f.authority.runs).toBe(0);
    expect(f.authority.stops).toBe(1);
    expect(f.replicas).toHaveLength(0);
    expect(f.eventFactories).toBe(0);
    expect(existsSync(f.lock)).toBe(false);
  });

  test("preclaim primary refusal and actual authority cleanup failure are both preserved", async () => {
    const f = new Fixture(),
      primary = new DaemonAuthorityError("identity", "preclaim-changed"),
      cleanup = new Error("preclaim-cleanup-failed");
    f.authority.error = primary;
    f.authority.stopError = cleanup;
    const result = await f.start();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(contains(result.error, primary)).toBe(true);
      expect(contains(result.error, cleanup)).toBe(true);
    }
    expect(f.authority.stops).toBe(1);
    expect(f.claims).toBe(0);
    expect(existsSync(f.lock)).toBe(false);
  });

  test.each(["maxFailures", "liveStableMs"] as const)(
    "invalid %s budget still joins authority stop before any claim",
    async (budget) => {
      const f = new Fixture();
      f.ports[budget] = 0;
      expect((await f.start()).ok).toBe(false);
      expect(f.authority.stops).toBe(1);
      expect(f.claims).toBe(0);
      expect(f.eventFactories).toBe(0);
    },
  );

  test.each(["authentication", "identity"] as const)(
    "preclaim %s refusal joins owned authority stop without feed or lease",
    async (kind) => {
      const f = new Fixture();
      const cause = new DaemonAuthorityError(kind, "refused-before-claim");
      f.authority.error = cause;
      const result = await f.start();
      expect(result).toEqual({ ok: false, error: cause });
      expect(f.claims).toBe(0);
      expect(f.replicas).toHaveLength(0);
      expect(f.eventFactories).toBe(0);
      expect(f.authority.stops).toBe(1);
      expect(existsSync(f.lock)).toBe(false);
    },
  );

  test("real live-PID claim refusal joins authority stop and preserves the existing lock bytes", async () => {
    const f = new Fixture(),
      original = f.rawClaim();
    f.lease = original;
    const bytes = readFileSync(f.lock);
    const result = await f.start();
    expect(result.ok).toBe(false);
    expect(readFileSync(f.lock)).toEqual(bytes);
    expect(f.releases).toBe(0);
    expect(f.authority.stops).toBe(1);
    expect(f.authority.runs).toBe(0);
    expect(f.eventFactories).toBe(0);
  });

  test("authority run begins before either feed factory", async () => {
    const f = new Fixture(),
      result = f.start();
    await f.entered();
    expect(f.log.indexOf("authority:run")).toBeLessThan(
      f.log.indexOf("replica:factory"),
    );
    expect(f.log.indexOf("authority:run")).toBeLessThan(
      f.log.indexOf("events:factory"),
    );
    f.controller.abort();
    f.settleSync();
    expect((await result).ok).toBe(true);
    expect(f.authority.stops).toBe(1);
    expect(existsSync(f.lock)).toBe(false);
  });

  test("synchronous authority terminal notice prevents both feed factories and persists the latch", async () => {
    const f = new Fixture();
    f.authority.runHook = () => {
      void f.authority.fail("authentication_required");
    };
    const result = await f.start();
    expect(result.ok).toBe(true);
    expect(f.replicas).toHaveLength(0);
    expect(f.eventFactories).toBe(0);
    expect(f.state().stopped?.reason).toBe("authentication_required");
    expect(existsSync(f.lock)).toBe(false);
  });

  test.each(["authentication", "identity"] as const)(
    "postclaim %s change persists an explicit restart latch before lease release",
    async (kind) => {
      const f = new Fixture();
      f.claimHook = () => {
        f.authority.error = new DaemonAuthorityError(
          kind,
          "changed-during-claim",
        );
      };
      await f.start();
      expect(f.state().stopped?.reason).toBe(
        kind === "identity" ? "identity_mismatch" : "authentication_required",
      );
      expect(f.authority.stops).toBe(1);
      expect(f.replicas).toHaveLength(0);
      expect(f.eventFactories).toBe(0);
      expect(existsSync(f.lock)).toBe(false);
      f.authority.error = undefined;
      await f.start();
      expect(f.authority.runs).toBe(0);
      expect(f.eventFactories).toBe(0);
    },
  );

  test("authority is rechecked between replica admission and event factory admission", async () => {
    const f = new Fixture();
    f.replicaHook = () => {
      f.authority.error = new DaemonAuthorityError(
        "identity",
        "changed-between-factories",
      );
    };
    f.start();
    await vi.waitFor(() =>
      expect(f.state().stopped?.reason).toBe("identity_mismatch"),
    );
    expect(f.eventFactories).toBe(0);
  });

  test("authority expiry during replica backoff refuses the next factory and persists auth latch", async () => {
    const f = new Fixture();
    f.replicaHook = (replica) => {
      if (f.replicas.length === 1)
        replica.ready.reject({ daemonFailure: "transient" });
    };
    f.start();
    await vi.waitFor(() => expect(f.sleeps).toHaveLength(1));
    expect(f.sleeps[0].ms).toBe(15_000);
    f.authority.error = new DaemonAuthorityError(
      "authentication",
      "daemon_authority_expired",
    );
    f.sleeps[0].gate.resolve();
    await vi.waitFor(() =>
      expect(f.state().stopped?.reason).toBe("authentication_required"),
    );
    expect(f.replicas).toHaveLength(1);
  });

  test("a scope change while the owned replica factory is held refuses start and closes the returned attempt", async () => {
    const f = new Fixture(),
      entered = deferred<void>(),
      release = deferred<void>();
    const factory = f.ports.replica;
    f.ports.replica = async () => {
      const attempt = await factory();
      entered.resolve();
      await release.promise;
      return attempt;
    };
    f.start();
    try {
      await entered.promise;
      expect(f.replicas[0].starts).toBe(0);
      f.authority.error = new DaemonAuthorityError(
        "identity",
        "changed-during-owned-replica-factory",
      );
      release.resolve();
      await vi.waitFor(() =>
        expect(f.state().stopped?.reason).toBe("identity_mismatch"),
      );
      expect(f.replicas[0].starts).toBe(0);
      await f.replicas[0].closing.promise;
      if (f.events.calls[0])
        expect(f.events.calls[0].signal.aborted).toBe(true);
    } finally {
      release.resolve();
    }
  });

  test("authority is rechecked before the next direct event sync after an idle wait", async () => {
    const f = new Fixture();
    f.start();
    await f.entered();
    f.events.calls[0].gate.resolve({ appended: 0, cursor: 10, head: 10 });
    await vi.waitFor(() => expect(f.sleeps).toHaveLength(1));
    f.authority.error = new DaemonAuthorityError(
      "identity",
      "changed-during-event-idle",
    );
    f.sleeps[0].gate.resolve();
    await vi.waitFor(() =>
      expect(f.state().stopped?.reason).toBe("identity_mismatch"),
    );
    expect(f.events.calls).toHaveLength(1);
  });

  test("scope change while direct event sync is held prevents publishing its live result", async () => {
    const f = new Fixture();
    f.start();
    await f.entered();
    f.authority.error = new DaemonAuthorityError(
      "identity",
      "changed-during-event-sync",
    );
    f.events.calls[0].gate.resolve({ appended: 1, cursor: 10, head: 10 });
    await vi.waitFor(() =>
      expect(f.state().stopped?.reason).toBe("identity_mismatch"),
    );
    expect(f.writes.some((record) => record.events.state === "live")).toBe(
      false,
    );
    expect(f.state().events.cursor).toBeNull();
    expect(f.state().events.head).toBeNull();
  });

  test("scope change while replica start is held prevents publishing replica live", async () => {
    const f = new Fixture();
    f.start();
    await f.entered();
    f.authority.error = new DaemonAuthorityError(
      "authentication",
      "daemon_authority_expired",
    );
    f.replicas[0].ready.resolve();
    await vi.waitFor(() =>
      expect(f.state().stopped?.reason).toBe("authentication_required"),
    );
    expect(f.writes.some((record) => record.replica.state === "live")).toBe(
      false,
    );
    expect(f.events.calls[0].signal.aborted).toBe(true);
  });

  test.each(["authentication_required", "identity_mismatch"] as const)(
    "%s aborts both peers while direct sync and authority ownership remain held",
    async (reason) => {
      const f = new Fixture();
      f.authority.holdRun = true;
      const result = f.start();
      await f.entered();
      await f.authority.fail(reason);
      expect(f.events.calls[0].signal.aborted).toBe(true);
      await f.replicas[0].closing.promise;
      expect(f.state().stopped?.reason).toBe(reason);
      expect(existsSync(f.lock)).toBe(true);
      expect(f.authority.stops).toBe(0);
      expect(f.events.stops).toBe(0);
      f.settleSync();
      await Promise.resolve();
      expect(f.authority.stops).toBe(0);
      f.authority.runGate.resolve();
      expect((await result).ok).toBe(true);
      expect(f.log.indexOf("events:sync-ack")).toBeLessThan(
        f.log.indexOf("events:stop-enter"),
      );
      expect(existsSync(f.lock)).toBe(false);
    },
  );

  test("ordinary shutdown joins BOTH authority and event cleanup before real lease release", async () => {
    const f = new Fixture();
    f.authority.stopGate = deferred<void>();
    f.events.stopGate = deferred<void>();
    const result = f.start();
    await f.entered();
    f.controller.abort();
    f.settleSync();
    await vi.waitFor(() => {
      expect(f.authority.stops).toBe(1);
      expect(f.events.stops).toBe(1);
    });
    expect(existsSync(f.lock)).toBe(true);
    f.events.stopGate.resolve();
    await Promise.resolve();
    expect(existsSync(f.lock)).toBe(true);
    f.authority.stopGate.resolve();
    expect((await result).ok).toBe(true);
    expect(existsSync(f.lock)).toBe(false);
    expect(f.log.indexOf("authority:stop-ack")).toBeLessThan(
      f.log.indexOf("lease:release"),
    );
    expect(f.state().stopped).toBeNull();
  });

  test.each(["authority", "events", "both"])(
    "%s cleanup rejection retains exact real live-PID lock and refuses competing claim",
    async (failing) => {
      const f = new Fixture(),
        authorityCause = new Error("authority-real-cleanup-failed"),
        eventCause = new Error("event-real-cleanup-failed");
      if (failing !== "events") f.authority.stopError = authorityCause;
      if (failing !== "authority") f.events.stopError = eventCause;
      const result = f.start();
      await f.entered();
      const bytes = readFileSync(f.lock);
      f.controller.abort();
      f.settleSync();
      const finished = await result;
      expect(finished.ok).toBe(false);
      if (!finished.ok) {
        if (failing !== "events")
          expect(contains(finished.error, authorityCause)).toBe(true);
        if (failing !== "authority")
          expect(contains(finished.error, eventCause)).toBe(true);
      }
      expect(readFileSync(f.lock)).toEqual(bytes);
      expect(f.releases).toBe(0);
      expect(() => f.rawClaim()).toThrow("daemon_writer_already_running");
      expect(f.authority.stops).toBe(1);
      expect(f.events.stops).toBe(1);
    },
  );

  test.each(["authority", "events"])(
    "%s cleanup rejection does not skip held peer cleanup",
    async (failing) => {
      const f = new Fixture(),
        cause = new Error("cleanup-rejected");
      const gate = deferred<void>();
      if (failing === "authority") {
        f.authority.stopError = cause;
        f.events.stopGate = gate;
      } else {
        f.events.stopError = cause;
        f.authority.stopGate = gate;
      }
      let finished = false;
      const result = f.start().finally(() => {
        finished = true;
      });
      await f.entered();
      f.controller.abort();
      f.settleSync();
      await vi.waitFor(() => {
        expect(f.authority.stops).toBe(1);
        expect(f.events.stops).toBe(1);
      });
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(existsSync(f.lock)).toBe(true);
      gate.resolve();
      const done = await result;
      expect(done.ok).toBe(false);
      if (!done.ok) expect(contains(done.error, cause)).toBe(true);
      expect(existsSync(f.lock)).toBe(true);
    },
  );

  test("unexpected authority task crash aborts peers and waits direct sync before rejecting", async () => {
    const f = new Fixture(),
      cause = new Error("authority-task-crashed");
    let finished = false;
    const result = f.start().finally(() => {
      finished = true;
    });
    await f.entered();
    f.authority.runGate.reject(cause);
    await vi.waitFor(() => expect(f.events.calls[0].signal.aborted).toBe(true));
    expect(finished).toBe(false);
    expect(existsSync(f.lock)).toBe(true);
    f.settleSync();
    expect(await result).toEqual({ ok: false, error: cause });
    expect(existsSync(f.lock)).toBe(false);
  });
});
