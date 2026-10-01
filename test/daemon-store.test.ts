import { afterEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { claimDaemonLease, parseDaemonRecord } from "../src/daemon-store";
import type {
  DaemonBinding,
  DaemonLease,
  DaemonRecord,
} from "../src/daemon-supervisor";

const homes: string[] = [];
const leases: DaemonLease[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
  for (const lease of leases.splice(0)) await lease.release().catch(() => {});
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "daemon-store-"));
  homes.push(home);
  const directory = join(home, "state", "daemon");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const binding: DaemonBinding = {
    account: "account-one",
    origin: "https://cloud.example.test",
    replicaDb: join(home, "replica.db"),
    eventDirectory: join(home, "events"),
  };
  return { home, directory, binding, runId: "owned-run", pid: process.pid };
}
function record(input: ReturnType<typeof setup>): DaemonRecord {
  return {
    schema: 1,
    binding: { ...input.binding },
    runId: input.runId,
    pid: input.pid,
    updatedAt: 1_000,
    state: "backoff",
    replica: { state: "backoff", failures: 3 },
    events: { state: "starting", failures: 2, cursor: 8, head: 10 },
    stopped: null,
  };
}
function claim(input: ReturnType<typeof setup>) {
  const lease = claimDaemonLease(input);
  leases.push(lease);
  return lease;
}
function writeLock(
  input: ReturnType<typeof setup>,
  changes: Record<string, unknown> = {},
) {
  const value = {
    schema: 1,
    pid: input.pid,
    host: hostname(),
    token: "foreign-owner",
    binding: input.binding,
    ...changes,
  };
  const bytes = JSON.stringify(value);
  writeFileSync(join(input.directory, "writer.lock"), bytes, { mode: 0o600 });
  return bytes;
}
async function deadPid(home: string): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    env: { HOME: home, PATH: process.env.PATH },
    stdio: "ignore",
  });
  children.push(child);
  const pid = child.pid;
  await once(child, "exit");
  if (!pid) throw new Error("child did not start");
  let probeError: unknown;
  try {
    process.kill(pid, 0);
  } catch (error) {
    probeError = error;
  }
  expect(probeError).toMatchObject({ code: "ESRCH" });
  return pid;
}

describe("strict daemon state parsing", () => {
  test("valid terminal latch and counters survive parsing, and secret extras are discarded", () => {
    const input = setup();
    const value = record(input);
    value.state = "stopped";
    value.stopped = {
      at: 900,
      reason: "authentication_required",
      restartWith: "catalyst daemon restart",
    };
    const parsed = parseDaemonRecord({
      ...value,
      accessToken: "fixture-secret",
      binding: { ...value.binding, refreshToken: "fixture-secret" },
      replica: { ...value.replica, secret: "fixture-secret" },
    });
    expect(parsed).toEqual(value);
    expect(JSON.stringify(parsed)).not.toContain("fixture-secret");
    parsed.replica.failures = 0;
    expect(value.replica.failures).toBe(3);
  });

  test.each([
    { name: "missing latch", replacement: undefined },
    { name: "string latch", replacement: "stopped" },
    {
      name: "unknown reason",
      replacement: {
        at: 900,
        reason: "continue_anyway",
        restartWith: "catalyst daemon restart",
      },
    },
    {
      name: "wrong recovery instruction",
      replacement: {
        at: 900,
        reason: "event_history_gap",
        restartWith: "automatic",
      },
    },
    {
      name: "negative time",
      replacement: {
        at: -1,
        reason: "authentication_required",
        restartWith: "catalyst daemon restart",
      },
    },
  ])(
    "a malformed $name cannot silently clear a stopped latch",
    ({ replacement }) => {
      const input = setup();
      expect(() =>
        parseDaemonRecord({
          ...record(input),
          state: "stopped",
          stopped: replacement,
        }),
      ).toThrow("daemon_state_unverified");
    },
  );

  test.each([
    { changed: { schema: 2 } },
    { changed: { pid: 0 } },
    { changed: { updatedAt: NaN } },
    { changed: { replica: { state: "live", failures: -1 } } },
    {
      changed: { events: { state: "live", failures: 0, cursor: 11, head: 10 } },
    },
  ])("invalid persisted shape is refused: $changed", ({ changed }) => {
    const input = setup();
    expect(() => parseDaemonRecord({ ...record(input), ...changed })).toThrow(
      "daemon_state_unverified",
    );
  });

  test.each([
    "http://cloud.example.test",
    "https://cloud.example.test/api/v1",
    "https://user:pass@cloud.example.test",
  ])("non-origin or insecure origin %s is rejected", (origin) => {
    const input = setup();
    const value = record(input);
    value.binding.origin = origin;
    expect(() => parseDaemonRecord(value)).toThrow("daemon_state_unverified");
  });
});

describe("private files and binding fences", () => {
  test("writes private state, retains counters/latch across a new lease, and releases idempotently", async () => {
    const input = setup();
    const lease = claim(input);
    const value = record(input);
    value.state = "stopped";
    value.stopped = {
      at: 900,
      reason: "event_failure_cap",
      restartWith: "catalyst daemon restart",
    };
    await lease.write(value);
    expect(lstatSync(input.directory).mode & 0o777).toBe(0o700);
    for (const file of ["writer.lock", "state.json"])
      expect(lstatSync(join(input.directory, file)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(input.directory, "claim.lock"))).toBe(false);
    await lease.release();
    await lease.release();
    expect(existsSync(join(input.directory, "writer.lock"))).toBe(false);
    const next = claim({ ...input, runId: "next-run" });
    expect(await next.read()).toEqual(value);
  });

  test("persisted JSON includes only the public record fields", async () => {
    const input = setup();
    const lease = claim(input);
    const enriched = { ...record(input), accessToken: "fixture-secret" };
    await lease.write(enriched);
    const bytes = readFileSync(join(input.directory, "state.json"), "utf8");
    expect(bytes).not.toContain("fixture-secret");
    expect(JSON.parse(bytes)).toEqual(record(input));
  });

  test.each(["account", "origin", "replicaDb", "eventDirectory"] as const)(
    "a foreign %s state cannot be read or replaced",
    async (field) => {
      const input = setup();
      const lease = claim(input);
      const foreign = record(input);
      foreign.binding[field] += "-foreign";
      const file = join(input.directory, "state.json");
      const bytes = JSON.stringify(foreign);
      writeFileSync(file, bytes, { mode: 0o600 });
      await expect(lease.read()).rejects.toThrow();
      await expect(lease.write(foreign)).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toBe(bytes);
    },
  );

  test("malformed stored latch refuses read and preserves its bytes", async () => {
    const input = setup();
    const lease = claim(input);
    const file = join(input.directory, "state.json");
    const bytes = JSON.stringify({
      ...record(input),
      state: "stopped",
      stopped: { reason: "authentication_required" },
    });
    writeFileSync(file, bytes, { mode: 0o600 });
    await expect(lease.read()).rejects.toThrow("daemon_state_unverified");
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  test.each([0o644, 0o666])(
    "state mode %s is refused without modifying data",
    async (mode) => {
      const input = setup();
      const lease = claim(input);
      const file = join(input.directory, "state.json");
      const bytes = JSON.stringify(record(input));
      writeFileSync(file, bytes, { mode });
      chmodSync(file, mode);
      await expect(lease.read()).rejects.toThrow();
      await expect(lease.write(record(input))).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toBe(bytes);
    },
  );

  test.each(["symlink", "hardlink"])(
    "a %s state target is preserved and refused",
    async (kind) => {
      const input = setup();
      const lease = claim(input);
      const target = join(input.home, "customer.json");
      const bytes = "customer-owned data";
      writeFileSync(target, bytes, { mode: 0o600 });
      const state = join(input.directory, "state.json");
      if (kind === "symlink") symlinkSync(target, state);
      else linkSync(target, state);
      await expect(lease.read()).rejects.toThrow();
      await expect(lease.write(record(input))).rejects.toThrow();
      expect(readFileSync(target, "utf8")).toBe(bytes);
    },
  );

  test("symlinked directory and permissive directory are refused before writer acquisition", () => {
    const input = setup();
    const alias = join(input.home, "alias");
    symlinkSync(input.directory, alias);
    expect(() => claimDaemonLease({ ...input, directory: alias })).toThrow();
    chmodSync(input.directory, 0o755);
    expect(() => claimDaemonLease(input)).toThrow();
    expect(existsSync(join(input.directory, "writer.lock"))).toBe(false);
  });
});

describe("positive ownership and exclusive reclamation", () => {
  test("live PID is never reclaimed despite an old-looking lock", () => {
    const input = setup();
    const bytes = writeLock(input, { heartbeat: 0 });
    expect(() => claimDaemonLease(input)).toThrow(
      "daemon_writer_already_running",
    );
    expect(readFileSync(join(input.directory, "writer.lock"), "utf8")).toBe(
      bytes,
    );
  });

  test("foreign binding is never reclaimed even when its PID is positively dead", async () => {
    const input = setup();
    const pid = await deadPid(input.home);
    const bytes = writeLock(input, {
      pid,
      binding: { ...input.binding, account: "foreign" },
    });
    expect(() => claimDaemonLease(input)).toThrow("daemon_state_unverified");
    expect(readFileSync(join(input.directory, "writer.lock"), "utf8")).toBe(
      bytes,
    );
  });

  test("existing claim guard requires deliberate recovery and is neither overwritten nor removed", () => {
    const input = setup();
    const guard = join(input.directory, "claim.lock");
    const bytes = "foreign critical section";
    writeFileSync(guard, bytes, { mode: 0o600 });
    expect(() => claimDaemonLease(input)).toThrow(
      "daemon_claim_requires_recovery",
    );
    expect(readFileSync(guard, "utf8")).toBe(bytes);
    expect(existsSync(join(input.directory, "writer.lock"))).toBe(false);
  });

  test("positively dead same-binding PID can be reclaimed and the second live claimant is refused", async () => {
    const input = setup();
    const pid = await deadPid(input.home);
    writeLock(input, { pid });
    const lease = claim(input);
    expect(await lease.read()).toBeNull();
    const acquired = readFileSync(join(input.directory, "writer.lock"), "utf8");
    expect(JSON.parse(acquired)).toMatchObject({
      pid: process.pid,
      binding: input.binding,
    });
    expect(() => claimDaemonLease({ ...input, runId: "second-run" })).toThrow(
      "daemon_writer_already_running",
    );
    expect(readFileSync(join(input.directory, "writer.lock"), "utf8")).toBe(
      acquired,
    );
  });

  test("concurrent processes reclaiming one dead holder produce at most one live owner", async () => {
    const input = setup();
    writeLock(input, { pid: await deadPid(input.home) });
    const moduleUrl = new URL("../src/daemon-store.ts", import.meta.url).href;
    const script = `import {claimDaemonLease} from ${JSON.stringify(moduleUrl)};
      const input = JSON.parse(process.argv[1]); input.pid = process.pid;
      let lease; try { lease = claimDaemonLease(input); process.send({kind:'acquired',pid:process.pid}); }
      catch(error) { process.send({kind:'refused',message:error.message}); process.exit(0); }
      process.on('message', async () => { await lease.release(); process.exit(0); });`;
    const start = () => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script, JSON.stringify(input)],
        {
          env: { HOME: input.home, PATH: process.env.PATH },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      children.push(child);
      return child;
    };
    const pair = [start(), start()];
    const results = await Promise.all(
      pair.map((child) =>
        Promise.race([
          once(child, "message"),
          once(child, "exit").then(() => {
            throw new Error("claim worker exited before reporting ownership");
          }),
        ]),
      ),
    );
    const messages: unknown[] = results.map((result) => result[0]);
    const isAcquired = (
      value: unknown,
    ): value is { kind: "acquired"; pid: number } =>
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      value.kind === "acquired" &&
      "pid" in value &&
      typeof value.pid === "number";
    const winners = messages.filter(isAcquired);
    expect(winners).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(input.directory, "writer.lock"), "utf8"))
        .pid,
    ).toBe(winners[0]?.pid);
    for (const [index, child] of pair.entries())
      if (isAcquired(messages[index])) {
        const exited = once(child, "exit");
        child.send("release");
        await exited;
      }
    expect(existsSync(join(input.directory, "writer.lock"))).toBe(false);
  });

  test("release and further writes refuse a replacement owner's lock without deleting it", async () => {
    const input = setup();
    const lease = claim(input);
    const lock = join(input.directory, "writer.lock");
    unlinkSync(lock);
    const bytes = writeLock(input, { token: "new-owner" });
    await expect(lease.release()).rejects.toThrow("daemon_state_unverified");
    await expect(lease.write(record(input))).rejects.toThrow(
      "daemon_state_unverified",
    );
    expect(readFileSync(lock, "utf8")).toBe(bytes);
  });
});
