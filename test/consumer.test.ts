// consumer.test.ts — the events-only consumer's contract in isolation: react then persist, async
// reactions serialised in seq order, a sync throw halts and reconnects, duplicates never move the
// cursor backwards, and the head-only reseed refuses a bad status, a foreign account, or a bad cursor.
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { ChangeFrame, WebSocketLike } from "@catalyst-cloud/sdk/node";
import { loadSdk, type Sdk } from "../src/sdk";
import { createLiveEventsClient, printFrame } from "../src/watch/consumer";
import { readCursorFile } from "../src/watch/cursor-file";
import { tempHome, waitFor } from "./helpers";

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

const ACCOUNT = "tenant-x";
let sdk: Sdk;
let home: string;
let sockets: FakeWs[];
let head: { status: number; body: unknown };

const fetchImpl = (async () => new Response(JSON.stringify(head.body), { status: head.status })) as unknown as typeof fetch;

function frame(seq: number, entity: ChangeFrame["entity"] = "issues"): ChangeFrame {
  return { type: "change", accountId: ACCOUNT, seq, entity, entityId: String(seq), op: "upsert", row: { id: String(seq) } };
}

beforeAll(async () => {
  sdk = await loadSdk();
});
beforeEach(() => {
  home = tempHome();
  sockets = [];
  head = { status: 200, body: { accountId: ACCOUNT, cursor: 10 } };
});

function build(onEvent?: (f: ChangeFrame) => void | Promise<void>, logs: string[] = []) {
  return createLiveEventsClient(sdk, {
    baseUrl: "http://127.0.0.1:1",
    accountId: ACCOUNT,
    token: "t",
    cursorFile: `${home}/cursor.json`,
    fetchImpl,
    wsFactory: () => {
      const ws = new FakeWs();
      sockets.push(ws);
      return ws;
    },
    onEvent,
    log: (level, msg) => logs.push(`${level}: ${msg}`),
    backoffMs: 5,
    maxBackoffMs: 10,
  });
}

describe("createLiveEventsClient", () => {
  test("cold start reseeds from the head; a sync reaction persists in the same turn; duplicates never move the cursor back", async () => {
    const seen: number[] = [];
    const h = build((f) => {
      seen.push(f.seq);
    });
    const run = h.client.start();
    await waitFor(() => sockets.length === 1);
    expect(h.cursor()).toBe(10);
    sockets[0]!.open();
    sockets[0]!.push(frame(11));
    expect(h.cursor()).toBe(11);
    sockets[0]!.push(frame(11));
    expect(h.cursor()).toBe(11);
    expect(seen[0]).toBe(11);
    expect(readCursorFile(`${home}/cursor.json`)).toEqual({ account: ACCOUNT, cursor: 11 });
    h.client.stop();
    await run;
  });

  test("async reactions are awaited and later frames queue behind them in seq order", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = build(async (f) => {
      order.push(`start ${f.seq}`);
      if (f.seq === 11) await gate;
      order.push(`end ${f.seq}`);
    });
    const run = h.client.start();
    await waitFor(() => sockets.length === 1);
    sockets[0]!.open();
    sockets[0]!.push(frame(11));
    sockets[0]!.push(frame(12));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.cursor()).toBe(10);
    expect(order).toEqual(["start 11"]);
    release();
    await waitFor(() => h.cursor() === 12);
    expect(order).toEqual(["start 11", "end 11", "start 12", "end 12"]);
    expect(readCursorFile(`${home}/cursor.json`)).toEqual({ account: ACCOUNT, cursor: 12 });
    h.client.stop();
    await run;
  });

  test("a sync throw halts the stream, leaves the cursor, ignores later frames on that socket, and reconnects", async () => {
    const logs: string[] = [];
    const seen: number[] = [];
    const h = build((f) => {
      seen.push(f.seq);
      if (f.seq === 11) throw new Error("boom");
    }, logs);
    const run = h.client.start();
    await waitFor(() => sockets.length === 1);
    sockets[0]!.open();
    sockets[0]!.push(frame(11));
    sockets[0]!.push(frame(12));
    expect(h.cursor()).toBe(10);
    expect(seen).toEqual([11]);
    expect(logs.some((l) => l.startsWith("error: reaction failed for issues seq=11; cursor left at 10"))).toBe(true);
    await waitFor(() => sockets.length === 2, 5000);
    sockets[1]!.open();
    expect(sockets[1]!.sent[0]).toEqual({ type: "sync", after: 10 });
    h.client.stop();
    await run;
  });

  test("an async rejection is the same failure", async () => {
    const logs: string[] = [];
    const h = build(async (f) => {
      if (f.seq === 11) throw new Error("later");
    }, logs);
    const run = h.client.start();
    await waitFor(() => sockets.length === 1);
    sockets[0]!.open();
    sockets[0]!.push(frame(11));
    await waitFor(() => logs.some((l) => l.includes("reaction failed")), 5000);
    expect(h.cursor()).toBe(10);
    h.client.stop();
    await run;
  });

  test("reseedHead refuses a non-200, a foreign account, and a non-integer cursor", async () => {
    const h = build(() => {});
    head = { status: 500, body: "down" };
    await expect(h.reseedHead()).rejects.toThrow(/head-only snapshot fetch failed: 500/);
    head = { status: 200, body: { accountId: "other", cursor: 3 } };
    await expect(h.reseedHead()).rejects.toThrow(/is for account "other" but this session is for "tenant-x"/);
    head = { status: 200, body: { accountId: ACCOUNT, cursor: 1.5 } };
    await expect(h.reseedHead()).rejects.toThrow(/non-integer cursor/);
    head = { status: 200, body: { accountId: ACCOUNT, cursor: 7 } };
    expect(await h.reseedHead()).toBe(7);
    expect(h.cursor()).toBe(7);
  });

  test("the default reaction prints one prefixed JSON line; the default logger writes to the console", () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    try {
      printFrame(frame(3));
      const h = createLiveEventsClient(sdk, { baseUrl: "http://127.0.0.1:1", accountId: ACCOUNT, token: "t", cursorFile: `${home}/c.json`, fetchImpl, wsFactory: () => new FakeWs() });
      expect(h.cursor()).toBeNull();
    } finally {
      console.log = orig;
    }
    expect(lines[0]).toMatch(/^\[live-events\] frame \{"type":"change"/);
  });
});
