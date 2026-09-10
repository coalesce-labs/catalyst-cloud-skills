// replica.test.ts — `replica status` exit codes (2 no config, 3 no file, 1 stale, 0 fresh) and its
// --json shape; engineFor's fallback to node:sqlite with exactly one stderr line; sql refuses a
// non-SELECT; schema lists every mirrorSchema table; start --detach spawns and writes the pidfile.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { main } from "../src/cli";
import { defaultReplicaDbFor } from "../src/config";
import { assertSingleSelect, engineFor, pidfilePath, replicaStatus } from "../src/replica";
import { loadSdk } from "../src/sdk";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, seedReplica, tempHome, type TestCtx } from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  home = tempHome();
  ctx = makeCtx(home);
});

describe("replica status", () => {
  test("exit 2 with no config", async () => {
    expect(await main(["replica", "status"], ctx)).toBe(2);
    expect(ctx.out.join("\n")).toMatch(/not configured/);
  });
  test("exit 3 with no db file", async () => {
    await seedJoined(home, server);
    expect(await main(["replica", "status"], ctx)).toBe(3);
    expect(ctx.out.join("\n")).toMatch(/absent/);
    expect(ctx.out.join("\n")).toContain("replica start --detach");
  });
  test("exit 1 with a lock heartbeat older than staleMs", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 60_000 });
    expect(await main(["replica", "status"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toMatch(/stale/);
    expect(ctx.out.join("\n")).toMatch(/heartbeat 6\d{4}ms old/);
  });
  test("exit 1 with a fresh heartbeat but no cursor", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: null, heartbeatAgeMs: 0 });
    expect(await main(["replica", "status"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toMatch(/no cursor/);
  });
  test("exit 0 with a live pid and fresh heartbeat; --json carries verdict, cursor, heartbeatAgeMs", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 100 });
    expect(await main(["replica", "status", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as { verdict: string; cursor: number; heartbeatAgeMs: number; writerAlive: boolean };
    expect(j.verdict).toBe("fresh");
    expect(j.cursor).toBe(41);
    expect(j.heartbeatAgeMs).toBeGreaterThanOrEqual(100);
    expect(j.heartbeatAgeMs).toBeLessThan(15_000);
    expect(j.writerAlive).toBe(true);
  });
  test("a dead lock pid without a pidfile is stale even with a fresh heartbeat", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0, lockPid: 2_147_483_000 });
    expect(await main(["replica", "status"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toMatch(/no live writer process/);
  });
  test("--probe adds the cloud head and the lag", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 7, heartbeatAgeMs: 0 });
    server.headCursor = 12;
    expect(await main(["replica", "status", "--probe", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as { head: number; lag: number };
    expect(j.head).toBe(12);
    expect(j.lag).toBe(5);
    const c2 = makeCtx(home);
    await main(["replica", "status", "--probe"], c2);
    expect(c2.out.join("\n")).toContain("5 behind head 12");
  });
  test("replicaStatus in-process reads the same config", async () => {
    const cfg = await seedJoined(home, server);
    await seedReplica(home, { cursor: 3, heartbeatAgeMs: 0 });
    expect(replicaStatus(ctx, cfg).verdict).toBe("fresh");
    expect(replicaStatus(ctx, null).verdict).toBe("not-configured");
  });
});

describe("engineFor", () => {
  test("falls back to node:sqlite when better-sqlite3 is absent, with exactly one stderr line", async () => {
    const sdk = await loadSdk();
    const dbPath = `${home}/x.db`;
    const engine = await engineFor(sdk, dbPath, ctx, {
      requireDriver: () => {
        throw new Error("Cannot find module 'better-sqlite3'");
      },
    });
    expect(ctx.err).toHaveLength(1);
    expect(ctx.err[0]).toMatch(/better-sqlite3 unavailable .*using node:sqlite/);
    engine.exec("CREATE TABLE t (x)");
    engine.close();
    expect(existsSync(dbPath)).toBe(true);
  });
  test("falls back when the driver constructor throws (an ABI mismatch), with exactly one stderr line", async () => {
    const sdk = await loadSdk();
    const engine = await engineFor(sdk, `${home}/y.db`, ctx, {
      requireDriver: () =>
        function Broken() {
          throw new Error("NODE_MODULE_VERSION 115 mismatch");
        },
    });
    expect(ctx.err).toHaveLength(1);
    expect(ctx.err[0]).toContain("NODE_MODULE_VERSION 115 mismatch");
    engine.close();
  });
});

describe("replica sql / schema", () => {
  test("sql refuses a non-SELECT and a second statement", async () => {
    expect(() => assertSingleSelect("delete from issues")).toThrow(/exactly one SELECT/);
    expect(() => assertSingleSelect("select 1; drop table issues")).toThrow(/exactly one SELECT/);
    expect(assertSingleSelect("  select 1;  ")).toBe("select 1");
    await seedJoined(home, server);
    expect(await main(["replica", "sql", "update issues set title = 'x'"], ctx)).toBe(1);
  });
  test("sql runs a SELECT through the read-only replica", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 1, issues: [{ id: "lin-1", identifier: "ENG-1", title: "one", state: "Todo", team_id: "team-eng" }] });
    expect(await main(["replica", "sql", "select identifier, title from issues", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toEqual([{ identifier: "ENG-1", title: "one" }]);
  });
  test("schema lists every mirrorSchema table with its columns", async () => {
    await seedJoined(home, server);
    await seedReplica(home, { cursor: 1 });
    const sdk = await loadSdk();
    const expected = Object.values(sdk.mirrorSchema).map((t) => (t as unknown as Record<symbol, string>)[Symbol.for("drizzle:Name")]);
    expect(expected.length).toBeGreaterThan(30);
    expect(await main(["replica", "schema", "--json"], ctx)).toBe(0);
    const out = JSON.parse(ctx.out.join("\n")) as Record<string, { name: string }[]>;
    for (const name of expected) expect(Object.keys(out), `schema must list ${name}`).toContain(name);
    expect(out.issues!.map((c) => c.name)).toContain("identifier");
    const c2 = makeCtx(home);
    expect(await main(["replica", "schema", "issues"], c2)).toBe(0);
    expect(c2.out).toHaveLength(1);
    expect(c2.out[0]).toMatch(/^issues: id TEXT PK/);
    const c3 = makeCtx(home);
    expect(await main(["replica", "schema", "nope"], c3)).toBe(2);
  });
  test("schema and sql exit 3 when the replica file is absent", async () => {
    await seedJoined(home, server);
    expect(await main(["replica", "schema"], ctx)).toBe(3);
    expect(await main(["replica", "sql", "select 1"], makeCtx(home))).toBe(3);
  });
});

describe("replica start --detach / stop", () => {
  test("start --detach spawns the writer without --detach and writes the pidfile; stop signals it", async () => {
    await seedJoined(home, server);
    const spawned: string[][] = [];
    const code = await main(["replica", "start", "--detach"], ctx, {
      replica: {
        detach: (argv) => {
          spawned.push(argv);
          return { pid: process.pid };
        },
        argv: ["/x/bin/catalyst-skills.js", "replica", "start", "--detach"],
      },
    });
    expect(code).toBe(0);
    expect(spawned).toEqual([["/x/bin/catalyst-skills.js", "replica", "start"]]);
    const dbPath = defaultReplicaDbFor(home);
    expect(readFileSync(pidfilePath(dbPath), "utf8").trim()).toBe(String(process.pid));
    expect(ctx.out.join("\n")).toContain(`pid ${process.pid}`);
    // stop on a pid that is not running removes the stale pidfile and exits 1
    writeFileSync(pidfilePath(dbPath), "2147483000\n");
    const c2 = makeCtx(home);
    expect(await main(["replica", "stop"], c2)).toBe(1);
    expect(existsSync(pidfilePath(dbPath))).toBe(false);
    const c3 = makeCtx(home);
    expect(await main(["replica", "stop"], c3)).toBe(1);
    expect(c3.out.join("\n")).toContain("nothing to stop");
  });
  test("a missing subcommand is a usage error", async () => {
    expect(await main(["replica"], ctx)).toBe(1);
  });
});

describe("replica start (foreground, in-process against the fixture)", () => {
  test("seeds from the fixture snapshot, opens the socket, reports live, and stops on request", async () => {
    await seedJoined(home, server);
    server.headCursor = 21;
    const sockets: { onopen: ((ev: unknown) => void) | null; onclose: ((ev: unknown) => void) | null }[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const run = main(["replica", "start"], ctx, {
      replica: {
        waitForStop: () => stopped,
        wsFactory: () => {
          const ws = {
            sent: [] as string[],
            onopen: null as ((ev: unknown) => void) | null,
            onmessage: null as ((ev: { data: unknown }) => void) | null,
            onclose: null as ((ev: unknown) => void) | null,
            onerror: null as ((ev: unknown) => void) | null,
            send(d: string) {
              ws.sent.push(d);
            },
            close() {
              queueMicrotask(() => ws.onclose?.({}));
            },
          };
          sockets.push(ws);
          return ws;
        },
      },
    });
    const { waitFor } = await import("./helpers");
    await waitFor(() => sockets.length === 1, 10_000);
    sockets[0]!.onopen?.({});
    await waitFor(() => ctx.out.some((l) => l.startsWith("replica live at")), 10_000);
    expect(ctx.out.find((l) => l.startsWith("replica live at"))).toContain("(cursor 21)");
    const status = makeCtx(home);
    expect(await main(["replica", "status"], status)).toBe(0);
    expect(status.out[0]).toContain("cursor 21");
    stop();
    expect(await run).toBe(0);
    expect(ctx.out.at(-1)).toBe("replica stopped");
    const after = makeCtx(home);
    expect(await main(["replica", "sql", "select identifier from issues order by identifier", "--json"], after)).toBe(0);
    expect(JSON.parse(after.out.join("\n"))).toEqual([{ identifier: "ENG-1" }, { identifier: "ENG-2" }]);
  }, 30_000);

  test("stop signals a live pid and removes the pidfile", async () => {
    await seedJoined(home, server);
    const { spawn } = await import("node:child_process");
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      writeFileSync(pidfilePath(defaultReplicaDbFor(home)), `${child.pid}\n`);
      expect(await main(["replica", "stop"], ctx)).toBe(0);
      expect(ctx.out.join("\n")).toContain(`sent SIGTERM to replica writer pid ${child.pid}`);
      expect(existsSync(pidfilePath(defaultReplicaDbFor(home)))).toBe(false);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  test("engineFor's default resolver falls back when better-sqlite3 is not installed; status tolerates a corrupt config and honours --db", async () => {
    const sdk = await loadSdk();
    const engine = await engineFor(sdk, `${home}/z.db`, ctx);
    engine.close();
    expect(ctx.err).toHaveLength(1);
    writeFileSync(`${home}/../nothing`, "");
    const c2 = makeCtx(home);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(`${home}/.config/catalyst-cloud`, { recursive: true });
    writeFileSync(`${home}/.config/catalyst-cloud/customer.json`, "{corrupt");
    expect(await main(["replica", "status"], c2)).toBe(2);
    await seedJoined(home, server);
    const other = await seedReplica(home, { dbPath: `${home}/other.db`, cursor: 9, heartbeatAgeMs: 0 });
    const c3 = makeCtx(home);
    expect(await main(["replica", "status", "--db", other, "--json"], c3)).toBe(0);
    expect(JSON.parse(c3.out.join("\n")).cursor).toBe(9);
    writeFileSync(pidfilePath(other), "not-a-pid\n");
    writeFileSync(`${other}.writer.lock`, "{garbage");
    const c4 = makeCtx(home);
    expect(await main(["replica", "status", "--db", other], c4)).toBe(1);
    expect(c4.out[0]).toContain("no writer lock");
    const c5 = makeCtx(home);
    expect(await main(["replica", "sql", "", "--db", other], c5)).toBe(1);
    const c6 = makeCtx(home);
    expect(await main(["replica", "wat"], c6)).toBe(1);
  });
});
