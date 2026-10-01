import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configPathFor,
  saveConfig,
  type Ctx,
  type CustomerConfig,
  type MeIdentity,
} from "../src/config";
import { createDaemonAuthorityLifetime } from "../src/daemon-authority-lifetime";

const homes: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const home = mkdtempSync(
    join(realpathSync(tmpdir()), "daemon-authority-lifetime-"),
  );
  homes.push(home);
  const me: MeIdentity = {
    account: "account-one",
    slug: "private-slug",
    name: "Private Account",
    permissions: ["mirror:read", "mirror:feed"],
    principal: "service",
    user: {
      id: "person-one",
      role: "owner",
      label: "Private Person",
      email: "private@example.test",
      linearUserId: null,
    },
  };
  const config: CustomerConfig = {
    ...me,
    user: { ...me.user! },
    baseUrl: "https://cloud.example.test",
    joinedAt: "2026-10-01T00:00:00Z",
    lastSkillBundleVersion: "fixture",
    auth: {
      kind: "oauth",
      sessionId: "private-session",
      accessToken: "private-access-one",
      refreshToken: "private-refresh",
      expiresAt: "2099-01-01T00:00:00Z",
    },
  };
  saveConfig(home, config);
  const calls: { url: string; bearer: string | null }[] = [];
  let reply: (call: number) => Promise<Response> = async () =>
    Response.json(me);
  const ctx: Ctx = {
    home,
    env: {},
    stdout: vi.fn(),
    stderr: vi.fn(),
    now: () => new Date(),
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        bearer: new Headers(init?.headers).get("authorization"),
      });
      return reply(calls.length);
    },
  };
  return {
    home,
    me,
    config,
    ctx,
    calls,
    respond: (next: typeof reply) => {
      reply = next;
    },
  };
}
function fakeClock() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T06:00:00Z"));
}
function heldBody() {
  const reading = deferred<void>(),
    cancelling = deferred<unknown>(),
    acknowledgement = deferred<void>();
  let cancelCount = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull() {
        reading.resolve();
        return new Promise<void>(() => {});
      },
      cancel(reason) {
        cancelCount++;
        cancelling.resolve(reason);
        return acknowledgement.promise;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    reading,
    cancelling,
    acknowledgement,
    response: new Response(stream, {
      headers: { "content-type": "application/json" },
    }),
    count: () => cancelCount,
  };
}
function contains(error: unknown, target: unknown): boolean {
  return (
    error === target ||
    (error instanceof AggregateError &&
      error.errors.some((item) => contains(item, target)))
  );
}
async function outcome(task: Promise<void>): Promise<unknown> {
  return task.then(
    () => undefined,
    (error) => error,
  );
}

describe("joined fresh daemon authority lifetime", () => {
  test("initial authority comes from actual /me and emits no token, identity or config writes", async () => {
    const f = fixture(),
      parent = new AbortController();
    const before = readFileSync(configPathFor(f.home));
    const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal);
    expect(f.calls).toEqual([
      {
        url: "https://cloud.example.test/api/v1/me",
        bearer: "Bearer private-access-one",
      },
    ]);
    expect(life.scope.person).toBe("person-one");
    expect(await life.getToken()).toBe("private-access-one");
    expect(JSON.stringify(life)).not.toMatch(
      /private-access|private-refresh|private@example|Private Person/,
    );
    await life.stop();
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
  });

  test("same-session bearer rotation stays old until the actual fresh /me body completes", async () => {
    fakeClock();
    const f = fixture(),
      parent = new AbortController();
    const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal);
    f.config.auth!.accessToken = "private-access-two";
    saveConfig(f.home, f.config);
    const before = readFileSync(configPathFor(f.home));
    const reading = deferred<void>(),
      release = deferred<void>();
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reading.resolve();
          await release.promise;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(f.me)));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    f.respond(async () => new Response(stream));
    const failure = vi.fn(async () => {});
    const run = life.run(parent.signal, failure);
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await reading.promise;
      expect(f.calls.map((call) => call.bearer)).toEqual([
        "Bearer private-access-one",
        "Bearer private-access-two",
      ]);
      expect(await life.getToken()).toBe("private-access-one");
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(await life.getToken()).toBe("private-access-two");
      expect(failure).not.toHaveBeenCalled();
      expect(readFileSync(configPathFor(f.home))).toEqual(before);
    } finally {
      release.resolve();
      parent.abort(new Error("fixture-stop"));
      await run;
      await life.stop();
    }
  });

  test.each(["account", "person", "role", "origin", "session"])(
    "saved %s mutation refuses authority and notices only once",
    async (kind) => {
      fakeClock();
      const f = fixture(),
        parent = new AbortController();
      const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal);
      const failure = vi.fn(async () => {});
      const run = life.run(parent.signal, failure);
      if (kind === "account") f.config.account = "other-account";
      if (kind === "person") f.config.user!.id = "other-person";
      if (kind === "role") f.config.user!.role = "admin";
      if (kind === "origin") f.config.baseUrl = "https://other.example.test";
      if (kind === "session") f.config.auth!.sessionId = "other-session";
      saveConfig(f.home, f.config);
      const bytes = readFileSync(configPathFor(f.home));
      expect(() => life.assertCurrent()).toThrow("daemon_authority_changed");
      expect(() => life.assertCurrent()).toThrow("daemon_authority_changed");
      await expect(life.getToken()).rejects.toThrow("daemon_authority_changed");
      await run;
      expect(failure.mock.calls).toEqual([["identity_mismatch"]]);
      expect(() => life.run(parent.signal, failure)).toThrow(
        "daemon_authority_already_running",
      );
      await life.stop();
      expect(f.calls).toHaveLength(1);
      expect(readFileSync(configPathFor(f.home))).toEqual(bytes);
    },
  );

  test("fresh live demotion latches identity without automatic recovery", async () => {
    fakeClock();
    const f = fixture(),
      parent = new AbortController();
    const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal);
    f.me.user!.role = "member";
    const failure = vi.fn(async () => {});
    const run = life.run(parent.signal, failure);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(failure.mock.calls).toEqual([["identity_mismatch"]]);
    f.me.user!.role = "owner";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.calls).toHaveLength(2);
    await expect(life.getToken()).rejects.toThrow("daemon_authority_changed");
    await life.stop();
  });

  test("fresh 401 notifies authentication once and never refreshes saved credentials", async () => {
    fakeClock();
    const f = fixture(),
      parent = new AbortController();
    const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal);
    f.config.auth!.accessToken = "private-access-two";
    saveConfig(f.home, f.config);
    const before = readFileSync(configPathFor(f.home));
    f.respond(async () =>
      Response.json({ error: "invalid_token" }, { status: 401 }),
    );
    const failure = vi.fn(async () => {});
    const run = life.run(parent.signal, failure);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(failure.mock.calls).toEqual([["authentication_required"]]);
    expect(f.calls.map((call) => call.bearer)).toEqual([
      "Bearer private-access-one",
      "Bearer private-access-two",
    ]);
    await expect(life.getToken()).rejects.toThrow(
      "daemon_authority_unavailable",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.calls).toHaveLength(2);
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
    await life.stop();
  });

  test("old original expiry aborts peers while actual reader cancellation remains pending", async () => {
    fakeClock();
    const f = fixture(),
      parent = new AbortController();
    const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal);
    const held = heldBody();
    f.respond(async () => held.response);
    const peer = new AbortController();
    const failure = vi.fn(
      async (reason: "authentication_required" | "identity_mismatch") => {
        peer.abort(reason);
      },
    );
    let runFinished = false,
      stopFinished = false;
    const run = life.run(parent.signal, failure).finally(() => {
      runFinished = true;
    });
    let stop: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await held.reading.promise;
      await vi.advanceTimersByTimeAsync(19_999);
      expect(peer.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await held.cancelling.promise;
      expect(peer.signal.reason).toBe("authentication_required");
      expect(failure.mock.calls).toEqual([["authentication_required"]]);
      expect(runFinished).toBe(false);
      stop = life.stop().finally(() => {
        stopFinished = true;
      });
      await Promise.resolve();
      expect(stopFinished).toBe(false);
      expect(held.count()).toBe(1);
    } finally {
      held.acknowledgement.resolve();
      await run;
      await (stop ?? life.stop());
    }
    expect(runFinished).toBe(true);
    expect(stopFinished).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  test.each(["parent", "run"])(
    "ordinary %s stop joins held cancellation without an auth or identity notice",
    async (source) => {
      fakeClock();
      const f = fixture(),
        parent = new AbortController();
      const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal),
        held = heldBody();
      const runSignal = new AbortController();
      f.respond(async () => held.response);
      const failure = vi.fn(async () => {});
      let settled = false;
      const run = life.run(runSignal.signal, failure).finally(() => {
        settled = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(10_000);
        await held.reading.promise;
        (source === "parent" ? parent : runSignal).abort(
          new Error("requested-stop"),
        );
        await held.cancelling.promise;
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(failure).not.toHaveBeenCalled();
      } finally {
        held.acknowledgement.resolve();
        await run;
        await life.stop();
      }
    },
  );

  test("near-expiry credential at renewal refuses without refresh or a second network request", async () => {
    fakeClock();
    const f = fixture(),
      parent = new AbortController();
    f.config.auth!.expiresAt = new Date(Date.now() + 40_000).toISOString();
    saveConfig(f.home, f.config);
    const before = readFileSync(configPathFor(f.home));
    const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal);
    const failure = vi.fn(async () => {});
    const run = life.run(parent.signal, failure);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(failure.mock.calls).toEqual([["authentication_required"]]);
    expect(f.calls).toHaveLength(1);
    await expect(life.getToken()).rejects.toThrow(
      "daemon_login_refresh_required",
    );
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
    await life.stop();
  });

  test("failure notice durability itself stays joined by run and stop", async () => {
    fakeClock();
    const f = fixture(),
      parent = new AbortController();
    const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal);
    const persisted = deferred<void>(),
      entered = deferred<void>();
    let finished = false;
    const run = life
      .run(parent.signal, async () => {
        entered.resolve();
        await persisted.promise;
      })
      .finally(() => {
        finished = true;
      });
    f.config.auth!.sessionId = "other-session";
    saveConfig(f.home, f.config);
    expect(() => life.assertCurrent()).toThrow();
    await entered.promise;
    let stopped = false;
    const stop = life.stop().finally(() => {
      stopped = true;
    });
    try {
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(stopped).toBe(false);
    } finally {
      persisted.resolve();
      await run;
      await stop;
    }
  });

  test("failure callback rejection stays an error on every stop", async () => {
    fakeClock();
    const f = fixture(),
      parent = new AbortController();
    const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal);
    const cause = new Error("durable-notice-write-failed");
    const run = life.run(parent.signal, async () => {
      throw cause;
    });
    const result = outcome(run);
    f.config.auth!.sessionId = "other-session";
    saveConfig(f.home, f.config);
    expect(() => life.assertCurrent()).toThrow();
    expect(await result).toBe(cause);
    expect(contains(await outcome(life.stop()), cause)).toBe(true);
    expect(contains(await outcome(life.stop()), cause)).toBe(true);
  });

  test("a fault found before run is reported when the supervisor callback is attached", async () => {
    fakeClock();
    const f = fixture(),
      parent = new AbortController();
    const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal);
    f.config.auth!.sessionId = "other-session";
    saveConfig(f.home, f.config);
    expect(() => life.assertCurrent()).toThrow("daemon_authority_changed");
    const failure = vi.fn(async () => {});
    await life.run(parent.signal, failure);
    expect(failure.mock.calls).toEqual([["identity_mismatch"]]);
    await life.stop();
  });

  test("actual upstream cleanup rejection aborts peers and remains a stop failure", async () => {
    fakeClock();
    const f = fixture(),
      parent = new AbortController();
    const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal);
    const cause = new Error("real-upstream-read-failed");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(cause);
      },
    });
    f.respond(async () => new Response(stream));
    const peer = new AbortController(),
      failure = vi.fn(
        async (reason: "authentication_required" | "identity_mismatch") => {
          peer.abort(reason);
        },
      );
    const result = outcome(life.run(parent.signal, failure));
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await result;
    expect(error).toBeInstanceOf(AggregateError);
    expect(contains(error, cause)).toBe(true);
    expect(contains(await outcome(life.stop()), cause)).toBe(true);
    expect(contains(await outcome(life.stop()), cause)).toBe(true);
    expect(peer.signal.reason).toBe("authentication_required");
    expect(failure.mock.calls).toEqual([["authentication_required"]]);
  });

  test("ordinary stop cancellation rejection named AbortError stays a cleanup error without an auth notice", async () => {
    fakeClock();
    const f = fixture(),
      parent = new AbortController();
    const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal);
    const reading = deferred<void>();
    const cause = new Error("actual-cancellation-cleanup-failed");
    cause.name = "AbortError";
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve();
          return new Promise<void>(() => {});
        },
        cancel() {
          return Promise.reject(cause);
        },
      },
      { highWaterMark: 0 },
    );
    f.respond(async () => new Response(stream));
    const failure = vi.fn(async () => {});
    const result = outcome(life.run(parent.signal, failure));
    await vi.advanceTimersByTimeAsync(10_000);
    await reading.promise;
    parent.abort(new Error("requested-stop"));
    expect(contains(await result, cause)).toBe(true);
    expect(contains(await outcome(life.stop()), cause)).toBe(true);
    expect(contains(await outcome(life.stop()), cause)).toBe(true);
    expect(failure).not.toHaveBeenCalled();
  });

  test("a real config race during verified token publication immediately notices identity", async () => {
    fakeClock();
    const f = fixture(),
      parent = new AbortController();
    const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal);
    const failure = vi.fn(async () => {});
    const run = life.run(parent.signal, failure);
    const now = Date.now();
    let checks = 0;
    // Trigger an actual saved-file replacement between the outer assertion and the
    // proof's own final publication check. No resolver or proof is mocked.
    f.ctx.now = () => {
      if (++checks === 3) {
        f.config.auth!.sessionId = "other-session";
        saveConfig(f.home, f.config);
      }
      return new Date(now);
    };
    try {
      await expect(life.getToken()).rejects.toThrow("daemon_authority_changed");
      expect(failure.mock.calls).toEqual([["identity_mismatch"]]);
      expect(f.calls).toHaveLength(1);
    } finally {
      parent.abort(new Error("fixture-stop"));
      await run;
      await life.stop();
    }
  });

  test("native original 30-second expiry notices within 27–35 seconds before held cleanup ACK", async () => {
    vi.useRealTimers();
    const f = fixture(),
      parent = new AbortController();
    const start = performance.now();
    const life = await createDaemonAuthorityLifetime(f.ctx, parent.signal),
      held = heldBody();
    f.respond(async () => held.response);
    const peer = new AbortController(),
      notice = deferred<{ elapsed: number; reason: string }>();
    let joined = false;
    const run = life
      .run(parent.signal, async (reason) => {
        peer.abort(reason);
        notice.resolve({ elapsed: performance.now() - start, reason });
      })
      .finally(() => {
        joined = true;
      });
    const before = readFileSync(configPathFor(f.home));
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const observed = await Promise.race([
        notice.promise,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () =>
              reject(
                new Error("native-original-expiry-not-noticed-within-35s"),
              ),
            35_000,
          );
        }),
      ]);
      expect(observed.reason).toBe("authentication_required");
      expect(observed.elapsed).toBeGreaterThanOrEqual(27_000);
      expect(observed.elapsed).toBeLessThanOrEqual(35_000);
      await held.reading.promise;
      await held.cancelling.promise;
      expect(peer.signal.aborted).toBe(true);
      expect(joined).toBe(false);
      expect(held.count()).toBe(1);
      expect(readFileSync(configPathFor(f.home))).toEqual(before);
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      parent.abort(new Error("native-fixture-stop"));
      held.acknowledgement.resolve();
      await run;
      await life.stop();
    }
    expect(joined).toBe(true);
    expect(f.calls).toHaveLength(2);
  }, 50_000);
});
