// watch.test.ts — an injected wsFactory feeds frames: an in-scope frame prints one JSON line and the
// cursor file advances after the reaction; a failing --exec leaves the cursor and forces a reconnect;
// a cross-account cursor file is refused loudly; team, ticket and project filters admit and reject
// the right frames; a resync moves the cursor to head.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChangeFrame, WebSocketLike } from "@catalyst-cloud/sdk/node";
import { main } from "../src/cli";
import { watchCursorPathFor } from "../src/config";
import { CursorFileError, readCursorFile, writeCursorFile } from "../src/watch/cursor-file";
import { inScope, runWatch, type IssueResolver } from "../src/watch";
import { FIXTURE_ACCOUNT } from "./fixture-contract";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, waitFor, type TestCtx } from "./helpers";

class FakeWs implements WebSocketLike {
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.({}));
  }
  open() {
    this.onopen?.({});
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let server: FixtureServer;
let home: string;
let ctx: TestCtx;
let sockets: FakeWs[];

const wsFactory = (): WebSocketLike => {
  const ws = new FakeWs();
  sockets.push(ws);
  return ws;
};

function frame(seq: number, entity: ChangeFrame["entity"], row: Record<string, unknown>, account = FIXTURE_ACCOUNT): ChangeFrame {
  return { type: "change", accountId: account, seq, entity, entityId: String(row.id ?? seq), op: "upsert", row };
}

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  home = tempHome();
  ctx = makeCtx(home);
  sockets = [];
  server.headCursor = 10;
  await seedJoined(home, server);
});

interface Session {
  done: Promise<number>;
  stop: () => void;
}

function start(opts: Parameters<typeof runWatch>[2], extra: Partial<Parameters<typeof runWatch>[3]> = {}): Session {
  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  const cfg = JSON.parse(readFileSync(`${home}/.config/catalyst-cloud/customer.json`, "utf8"));
  const done = runWatch(ctx, cfg, opts, { wsFactory, waitForStop: () => stopped, backoffMs: 5, maxBackoffMs: 10, ...extra });
  return { done, stop };
}

function cursorOf(): number | null {
  return readCursorFile(watchCursorPathFor(home))?.cursor ?? null;
}

describe("watch", () => {
  test("a frame in scope prints one JSON line and the cursor file advances after the reaction", async () => {
    const s = start({ scope: {} });
    await waitFor(() => sockets.length === 1);
    expect(cursorOf()).toBe(10); // cold start: head-only reseed
    sockets[0]!.open();
    await waitFor(() => sockets[0]!.sent.length === 1);
    expect(sockets[0]!.sent[0]).toEqual({ type: "sync", after: 10 });
    sockets[0]!.push(frame(11, "issues", { id: "lin-eng-1", identifier: "ENG-1", team_id: "team-eng" }));
    await waitFor(() => cursorOf() === 11);
    expect(ctx.out).toHaveLength(1);
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ seq: 11, entity: "issues" });
    s.stop();
    expect(await s.done).toBe(0);
  });

  test("a failing --exec leaves the cursor at the previous seq and a reconnect is requested", async () => {
    const s = start({ scope: {}, exec: "exit 1" });
    await waitFor(() => sockets.length === 1);
    sockets[0]!.open();
    sockets[0]!.push(frame(11, "issues", { id: "lin-eng-1", identifier: "ENG-1" }));
    await waitFor(() => sockets.length === 2, 5000);
    expect(cursorOf()).toBe(10);
    expect(ctx.out).toHaveLength(1);
    expect(ctx.err.join("\n")).toMatch(/reaction failed for issues seq=11; cursor left at 10/);
    s.stop();
    await s.done;
  });

  test("a succeeding --exec receives the frame on stdin and advances the cursor", async () => {
    const s = start({ scope: {}, exec: `cat > ${home}/frame.json` });
    await waitFor(() => sockets.length === 1);
    sockets[0]!.open();
    sockets[0]!.push(frame(11, "comments", { id: "c-1", issue_id: "lin-eng-1" }));
    await waitFor(() => cursorOf() === 11, 5000);
    expect(JSON.parse(readFileSync(`${home}/frame.json`, "utf8"))).toMatchObject({ seq: 11, entity: "comments" });
    s.stop();
    await s.done;
  });

  test("a cursor file stamped with another account is refused loudly (exit 2 through main)", async () => {
    const path = watchCursorPathFor(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ account: "tenant-9", cursor: 5 }));
    const code = await main(["watch"], ctx, { watch: { wsFactory, waitForStop: () => Promise.resolve() } });
    expect(code).toBe(2);
    expect(ctx.err.join("\n")).toMatch(/"tenant-9".*"tenant-3"/);
    expect(() => readCursorFile(path, FIXTURE_ACCOUNT)).toThrow(CursorFileError);
  });

  test("a frame for another account never advances the cursor", async () => {
    const s = start({ scope: {} });
    await waitFor(() => sockets.length === 1);
    sockets[0]!.open();
    sockets[0]!.push(frame(11, "issues", { id: "x" }, "tenant-9"));
    await new Promise((r) => setTimeout(r, 30));
    expect(cursorOf()).toBe(10);
    expect(ctx.err.join("\n")).toMatch(/refusing frame for account "tenant-9"/);
    s.stop();
    await s.done;
  });

  test("resync moves the cursor to head and prints one line", async () => {
    writeCursorFile(watchCursorPathFor(home), { account: FIXTURE_ACCOUNT, cursor: 4 });
    const s = start({ scope: {} });
    await waitFor(() => sockets.length === 1);
    expect(cursorOf()).toBe(4);
    sockets[0]!.open();
    server.headCursor = 50;
    sockets[0]!.push({ type: "resync", accountId: FIXTURE_ACCOUNT });
    await waitFor(() => cursorOf() === 50, 5000);
    expect(ctx.err.filter((l) => l.includes("resync: cursor moved to head 50"))).toHaveLength(1);
    await waitFor(() => sockets.length === 2, 5000);
    s.stop();
    await s.done;
  });

  test("--from head ignores the cursor file", async () => {
    writeCursorFile(watchCursorPathFor(home), { account: FIXTURE_ACCOUNT, cursor: 4 });
    server.headCursor = 33;
    const s = start({ scope: {}, fromHead: true });
    await waitFor(() => sockets.length === 1);
    expect(cursorOf()).toBe(33);
    s.stop();
    await s.done;
  });

  test("cmdWatch resolves a team key through the contract and rejects a bad --from", async () => {
    const code = await main(["watch", "--from", "sideways"], ctx, { watch: { wsFactory, waitForStop: () => Promise.resolve() } });
    expect(code).toBe(1);
    const c2 = makeCtx(home);
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const run = main(["watch", "--team", "ENG"], c2, { watch: { wsFactory, waitForStop: () => stopped, backoffMs: 5 } });
    await waitFor(() => sockets.length === 1);
    sockets[0]!.open();
    sockets[0]!.push(frame(11, "issues", { id: "lin-ops-1", identifier: "OPS-1", team_id: "team-ops" }));
    sockets[0]!.push(frame(12, "issues", { id: "lin-eng-1", identifier: "ENG-1", team_id: "team-eng" }));
    await waitFor(() => cursorOf() === 12, 5000);
    expect(c2.out).toHaveLength(1);
    expect(JSON.parse(c2.out[0]!).seq).toBe(12);
    stop();
    expect(await run).toBe(0);
  });
});

describe("inScope", () => {
  const resolver: IssueResolver = async (ref) => {
    const table: Record<string, { id: string; identifier: string; projectId: string | null; teamId: string }> = {
      "ENG-1": { id: "lin-eng-1", identifier: "ENG-1", projectId: "proj-a", teamId: "team-eng" },
      "lin-eng-1": { id: "lin-eng-1", identifier: "ENG-1", projectId: "proj-a", teamId: "team-eng" },
      "OPS-1": { id: "lin-ops-1", identifier: "OPS-1", projectId: "proj-b", teamId: "team-ops" },
      "lin-ops-1": { id: "lin-ops-1", identifier: "OPS-1", projectId: "proj-b", teamId: "team-ops" },
    };
    return table[ref] ?? null;
  };
  test("empty scope admits everything", async () => {
    expect(await inScope(frame(1, "issues", {}), {}, resolver)).toBe(true);
  });
  test("ticket scope admits by identifier and by resolved issue id, rejects others", async () => {
    const scope = { tickets: ["eng-1"] };
    expect(await inScope(frame(1, "issues", { identifier: "ENG-1" }), scope, resolver)).toBe(true);
    expect(await inScope(frame(2, "comments", { issue_id: "lin-eng-1" }), scope, resolver)).toBe(true);
    expect(await inScope(frame(3, "comments", { issue_id: "lin-ops-1" }), scope, resolver)).toBe(false);
    expect(await inScope(frame(4, "pull_requests", { linear_issue_identifier: "OPS-1" }), scope, resolver)).toBe(false);
  });
  test("project scope admits by project_id and through the issue detail", async () => {
    const scope = { projectId: "proj-a" };
    expect(await inScope(frame(1, "issues", { identifier: "ENG-1", project_id: "proj-a" }), scope, resolver)).toBe(true);
    expect(await inScope(frame(2, "projects", { id: "proj-a" }), scope, resolver)).toBe(true);
    expect(await inScope(frame(3, "comments", { issue_id: "lin-eng-1" }), scope, resolver)).toBe(true);
    expect(await inScope(frame(4, "comments", { issue_id: "lin-ops-1" }), scope, resolver)).toBe(false);
    expect(await inScope(frame(5, "fleet_anomalies", { id: "a" }), scope, resolver)).toBe(false);
  });
  test("team scope admits by team_id, by identifier prefix, and through resolution", async () => {
    const scope = { teamId: "team-eng", teamKey: "ENG" };
    expect(await inScope(frame(1, "issues", { team_id: "team-eng" }), scope, resolver)).toBe(true);
    expect(await inScope(frame(2, "pull_requests", { linear_issue_identifier: "ENG-9" }), scope, resolver)).toBe(true);
    expect(await inScope(frame(3, "comments", { issue_id: "lin-eng-1" }), scope, resolver)).toBe(true);
    expect(await inScope(frame(4, "comments", { issue_id: "lin-ops-1" }), scope, resolver)).toBe(false);
  });
  test("the API resolver caches and tolerates a 404", async () => {
    const { apiIssueResolver } = await import("../src/watch");
    const cfg = JSON.parse(readFileSync(`${home}/.config/catalyst-cloud/customer.json`, "utf8"));
    const r = apiIssueResolver(cfg, ctx);
    server.requests.length = 0;
    expect((await r("ENG-1"))?.projectId).toBe("proj-a");
    expect((await r("lin-eng-1"))?.identifier).toBe("ENG-1");
    expect(await r("ENG-404")).toBeNull();
    await r("ENG-1");
    expect(server.requests.filter((q) => q.path.startsWith("/api/v1/issues/"))).toHaveLength(3);
  });
});

describe("cursor file", () => {
  test("corrupt and malformed files throw named errors; absent is null", () => {
    const p = `${home}/cursor.json`;
    expect(readCursorFile(p)).toBeNull();
    writeFileSync(p, "{oops");
    expect(() => readCursorFile(p)).toThrow(/not valid JSON/);
    writeFileSync(p, JSON.stringify({ account: "", cursor: 1 }));
    expect(() => readCursorFile(p)).toThrow(/malformed/);
    writeFileSync(p, JSON.stringify({ account: "t", cursor: -1 }));
    expect(() => readCursorFile(p)).toThrow(/malformed/);
    writeFileSync(p, "5");
    expect(() => readCursorFile(p)).toThrow(/not a JSON object/);
  });
});
