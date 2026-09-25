import { describe, expect, test } from "vitest";
import {
  assessLocalSync,
  runLocalSync,
} from "../skills/catalyst-onboard/scripts/local-sync.mjs";

const replica = {
  verdict: "fresh",
  dbPath: "/tmp/replica.db",
  cursor: 8,
  head: 8,
  lag: 0,
  heartbeatAgeMs: 100,
  writerAlive: true,
  reasons: [],
};
const events = {
  verdict: "current",
  cursor: 14,
  head: 14,
  heartbeatAgeMs: 100,
  writerAlive: true,
  reasons: [],
};
const response = (status, code = 0) => ({
  code,
  stdout: JSON.stringify(status),
  stderr: "",
});

describe("optional onboarding local sync", () => {
  test("requires both cursors to match their own cloud head and both heartbeats to be live", () => {
    expect(assessLocalSync(replica, events).current).toBe(true);
    expect(
      assessLocalSync({ ...replica, head: 9, lag: 1 }, events).current,
    ).toBe(false);
    expect(
      assessLocalSync({ ...replica, heartbeatAgeMs: 16_000 }, events).current,
    ).toBe(false);
    expect(assessLocalSync(replica, { ...events, head: 15 }).current).toBe(
      false,
    );
    expect(
      assessLocalSync(replica, { ...events, writerAlive: false }).current,
    ).toBe(false);
  });

  test("keeps missing or unverified evidence unknown and reports proven lag as stale", () => {
    expect(assessLocalSync({}, events).verdict).toBe("unknown");
    expect(assessLocalSync({ ...replica, cursor: null }, events).verdict).toBe("unknown");
    expect(assessLocalSync(replica, { ...events, verdict: "unknown" }).verdict).toBe("unknown");
    expect(assessLocalSync(replica, { ...events, verdict: "stale", reasons: ["cloud event head could not be verified"] }).verdict).toBe("stale");
    expect(assessLocalSync({ ...replica, verdict: "absent" }, events).verdict).toBe("absent");
  });

  test("status check alone never starts a writer", async () => {
    const calls = [];
    const result = await runLocalSync({
      run: (args) => {
        calls.push(args);
        return response(
          args[0] === "events"
            ? events
            : { ...replica, verdict: "absent", writerAlive: false },
          3,
        );
      },
    });
    expect(result.assessment.current).toBe(false);
    expect(calls).toEqual([
      ["replica", "status", "--probe", "--json"],
      ["events", "status", "--probe", "--json"],
    ]);
  });

  test("explicit opt-in starts once and waits for both caches", async () => {
    const calls = [];
    const replicas = [
      response({ ...replica, verdict: "absent", writerAlive: false }, 3),
      response({ ...replica, cursor: 7, lag: 1 }),
      response(replica),
    ];
    const eventStatuses = [
      response({ ...events, verdict: "absent", writerAlive: false }),
      response({ ...events, verdict: "stale", cursor: 13 }),
      response(events),
    ];
    let time = 0;
    const result = await runLocalSync({
      start: true,
      waitSeconds: 10,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      run: (args) => {
        calls.push(args);
        return args[1] === "start"
          ? { code: 0, stdout: "started", stderr: "" }
          : args[0] === "events"
            ? eventStatuses.shift()
            : replicas.shift();
      },
    });
    expect(result.assessment.current).toBe(true);
    expect(result.started).toBe(true);
    expect(calls.filter((args) => args[1] === "start")).toHaveLength(1);
  });

  test("does not spawn a duplicate writer when an existing writer is behind", async () => {
    const calls = [];
    let time = 0;
    const behind = { ...replica, cursor: 7, lag: 1 };
    const result = await runLocalSync({
      start: true,
      waitSeconds: 3,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      run: (args) => {
        calls.push(args);
        return response(args[0] === "events" ? events : behind);
      },
    });
    expect(result.assessment.current).toBe(false);
    expect(result.started).toBe(false);
    expect(calls.every((args) => args[1] === "status")).toBe(true);
  });

  test("unconfigured machine and unavailable probe never claim current", async () => {
    const unconfigured = await runLocalSync({
      start: true,
      run: (args) =>
        response(
          args[0] === "events"
            ? events
            : { verdict: "not-configured", dbPath: null },
          2,
        ),
    });
    expect(unconfigured.recovery).toBe("catalyst-skills login");
    const unavailable = await runLocalSync({
      run: () => ({ code: 1, stdout: "", stderr: "cloud unavailable" }),
    });
    expect(unavailable.assessment.current).toBe(false);
  });
});
