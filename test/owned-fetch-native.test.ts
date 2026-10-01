import type { ReadableStreamReadResult } from "node:stream/web";
import { createServer, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { ownedFetch, type OwnedFetch } from "../src/owned-fetch.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Outcome<T> =
  { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };
function outcome<T>(task: Promise<T>): Promise<Outcome<T>> {
  return task.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}
const disposals: Array<() => Promise<void>> = [];
const owners: OwnedFetch[] = [];
afterEach(async () => {
  for (const owner of owners) owner.abort(new Error("native control teardown"));
  await Promise.allSettled(owners.splice(0).map((owner) => owner.settle()));
  for (const dispose of disposals.splice(0)) await dispose();
});

async function loopback() {
  const entered = deferred<void>(),
    closed = deferred<void>();
  const responses = new Map<string, ServerResponse>();
  const paths: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    paths.push(path);
    responses.set(path, response);
    request.socket.once("close", () => closed.resolve());
    response.setHeader("connection", "close");
    if (path === "/headers") {
      entered.resolve();
      return; // Real HTTP request accepted; no response headers are sent.
    }
    if (path === "/redirect") {
      response.writeHead(302, { location: "/target" });
      response.end();
      entered.resolve();
      return;
    }
    if (path === "/target") {
      response.end("redirect followed unexpectedly");
      return;
    }
    response.writeHead(200, {
      "content-type": "application/x-ndjson",
      "x-native-control": "body",
    });
    response.flushHeaders();
    response.write("first-chunk\n");
    entered.resolve();
    // Keep the actual response/socket open. Tests abort or destroy this exact response.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing private HTTP port");
  const origin = `http://127.0.0.1:${address.port}`;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    // Failure teardown only owns sockets accepted by this private server. Positive closure is
    // asserted before teardown; destroying here cannot supply a passing closure witness.
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  disposals.push(dispose);
  return { origin, entered, closed, responses, paths, dispose };
}

interface NativeCancel {
  reason: unknown;
  actualPromise: Promise<void>;
  completion: Promise<Outcome<void>>;
}
function observeNativeFetch() {
  const nativeFetch: typeof fetch = globalThis.fetch;
  const cancels: NativeCancel[] = [];
  const reads: Array<Promise<Outcome<ReadableStreamReadResult<Uint8Array>>>> =
    [];
  const trace = {
    readCount: 0,
    secondRead: deferred<void>(),
    cancels,
    reads,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    const body = response.body;
    if (!body) return response;
    const getReader: () => ReadableStreamDefaultReader<Uint8Array> =
      body.getReader;
    const getActualReader = getReader.bind(body);
    // Instrument these public instance methods, returning the SAME native reader and promises.
    // No synthetic Response/stream, cancellation delay or invented error changes native semantics.
    Object.defineProperty(body, "getReader", {
      value: () => {
        const reader = getActualReader();
        const actualRead = reader.read.bind(reader),
          actualCancel = reader.cancel.bind(reader);
        Object.defineProperty(reader, "read", {
          value: () => {
            const task = actualRead();
            trace.readCount++;
            trace.reads.push(outcome(task));
            if (trace.readCount === 2) trace.secondRead.resolve();
            return task;
          },
        });
        Object.defineProperty(reader, "cancel", {
          value: (reason?: unknown) => {
            const actualPromise = actualCancel(reason);
            trace.cancels.push({
              reason,
              actualPromise,
              completion: outcome(actualPromise),
            });
            return actualPromise;
          },
        });
        return reader;
      },
    });
    return response;
  };
  return { fetchImpl, trace };
}
function own(fetchImpl: typeof fetch, parent: AbortSignal) {
  const owner = ownedFetch(fetchImpl, parent);
  owners.push(owner);
  return owner;
}
async function firstLine(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.endsWith("\n")) {
    const part = await reader.read();
    if (part.done)
      throw new Error("native fixture ended before its first line");
    text += decoder.decode(part.value, { stream: true });
  }
  return text;
}
async function assertActualCancellation(
  owner: OwnedFetch,
  trace: ReturnType<typeof observeNativeFetch>["trace"],
) {
  const settled = await outcome(owner.settle());
  expect(trace.cancels).toHaveLength(1);
  const actual = await trace.cancels[0]!.completion;
  console.info(
    JSON.stringify({
      nativeCancel: actual.status,
      ownedCleanup: settled.status,
      cleanupErrorName:
        actual.status === "rejected" && actual.reason instanceof Error
          ? actual.reason.name
          : null,
    }),
  );
  // Derive the obligation from the independently observed ACTUAL native cancellation promise.
  // An underlying rejection must never be converted into a successful ownership receipt.
  if (actual.status === "rejected") {
    expect(settled.status).toBe("rejected");
    if (
      settled.status !== "rejected" ||
      !(settled.reason instanceof AggregateError)
    )
      throw new Error("native cancellation rejection lost its cleanup failure");
    expect(settled.reason.errors).toContain(actual.reason);
    const repeated = await outcome(owner.settle());
    expect(repeated.status).toBe("rejected");
    if (
      repeated.status !== "rejected" ||
      !(repeated.reason instanceof AggregateError)
    )
      throw new Error("repeated settle erased native cleanup failure");
    expect(repeated.reason.errors).toContain(actual.reason);
  } else {
    expect(settled.status).toBe("fulfilled");
  }
  return actual;
}

describe("owned fetch native HTTP lifetime", () => {
  test("headers-phase abort preserves the actual reason and closes the accepted upstream socket", async () => {
    const server = await loopback(),
      parent = new AbortController();
    const owner = own(globalThis.fetch, parent.signal);
    const request = outcome(owner.fetch(`${server.origin}/headers`));
    await server.entered.promise;
    const reason = new Error("native headers stop");
    parent.abort(reason);
    const actual = await request;
    expect(actual.status).toBe("rejected");
    if (actual.status !== "rejected")
      throw new Error("native header abort returned a response");
    expect(actual.reason).toBe(reason);
    await owner.settle();
    await server.closed.promise;
    expect(server.paths).toEqual(["/headers"]);
  }, 10_000);

  test.each(["parent", "request", "init"] as const)(
    "normal native %s body abort actually acknowledges cancellation and closes its socket",
    async (rail) => {
      const server = await loopback();
      const parent = new AbortController(),
        request = new AbortController(),
        init = new AbortController();
      const observed = observeNativeFetch(),
        owner = own(observed.fetchImpl, parent.signal);
      const response = await owner.fetch(
        new Request(`${server.origin}/body`, {
          signal: request.signal,
        }),
        { signal: init.signal },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-native-control")).toBe("body");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing native body");
      expect(await firstLine(reader)).toBe("first-chunk\n");
      const next = outcome(reader.read());
      await observed.trace.secondRead.promise;
      const reason = new Error(`native body ${rail} stop`);
      ({ parent, request, init })[rail].abort(reason);
      const downstream = await next;
      expect(downstream.status).toBe("rejected");
      if (downstream.status !== "rejected")
        throw new Error("native abort became successful EOF");
      expect(downstream.reason).toBe(reason);
      const cancelled = await assertActualCancellation(owner, observed.trace);
      expect(observed.trace.cancels[0]?.reason).toBe(reason);
      await server.closed.promise;
      expect(server.paths).toEqual(["/body"]);
      console.info(JSON.stringify({ nativeRequestSocketClosed: true, rail }));
      expect(
        cancelled.status,
        "normal native abort must acknowledge actual cancellation; preserve any red",
      ).toBe("fulfilled");
    },
    10_000,
  );

  test("abrupt actual peer body failure preserves the native reader-cancel error rather than acknowledging cleanup", async () => {
    const server = await loopback(),
      parent = new AbortController();
    const observed = observeNativeFetch(),
      owner = own(observed.fetchImpl, parent.signal);
    const response = await owner.fetch(`${server.origin}/body`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing native body");
    expect(await firstLine(reader)).toBe("first-chunk\n");
    const next = outcome(reader.read());
    await observed.trace.secondRead.promise;
    const upstream = server.responses.get("/body");
    if (!upstream) throw new Error("missing actual private response");
    upstream.destroy();
    const failedRead = await next;
    expect(failedRead.status).toBe("rejected");
    const failedCancel = await assertActualCancellation(owner, observed.trace);
    expect(failedCancel.status).toBe("rejected");
    if (failedRead.status !== "rejected" || failedCancel.status !== "rejected")
      throw new Error("fixture did not produce actual native body failure");
    expect(failedCancel.reason).toBe(failedRead.reason);
    await server.closed.promise;
  }, 10_000);

  test("native redirect refusal never enters the target and closes its actual response socket", async () => {
    const server = await loopback(),
      parent = new AbortController();
    const owner = own(globalThis.fetch, parent.signal);
    await expect(
      owner.fetch(`${server.origin}/redirect`, { redirect: "follow" }),
    ).rejects.toBeInstanceOf(Error);
    await owner.settle();
    await server.closed.promise;
    expect(server.paths).toEqual(["/redirect"]);
    expect(server.responses.has("/target")).toBe(false);
  }, 10_000);

  test("a real Node foreground child exits naturally after native body ownership settles", async () => {
    const server = await loopback();
    const source = new URL("../src/owned-fetch.ts", import.meta.url).href;
    const program = `
      const { ownedFetch } = await import(process.argv[1]);
      const parent = new AbortController();
      const owner = ownedFetch(globalThis.fetch, parent.signal);
      const response = await owner.fetch(process.argv[2]);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let line = '';
      while (!line.endsWith('\\n')) {
        const part = await reader.read();
        if (part.done) throw new Error('native child saw early EOF');
        line += decoder.decode(part.value, { stream: true });
      }
      parent.abort(new Error('native child owned stop'));
      let cleanup = 'acknowledged';
      try { await owner.settle(); }
      catch (error) {
        if (!(error instanceof AggregateError)) throw error;
        cleanup = 'rejected';
        process.exitCode = 2;
      }
      reader.releaseLock();
      console.log(JSON.stringify({ cleanup, firstLine: line }));
      // Deliberately no process.exit(): actual open handles must allow natural process exit.
    `;
    const child = spawn(
      "node",
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        program,
        source,
        `${server.origin}/body`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = deferred<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>();
    let stdout = "",
      stderr = "",
      killedForDeadline = false;
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.once("error", (error) => closed.reject(error));
    child.once("close", (code, signal) => closed.resolve({ code, signal }));
    const watchdog = setTimeout(() => {
      killedForDeadline = true;
      child.kill("SIGKILL");
    }, 5_000);
    try {
      const result = await closed.promise;
      expect(killedForDeadline, stderr).toBe(false);
      expect(result.signal).toBe(null);
      const record: unknown = JSON.parse(stdout.trim());
      expect(record).toEqual(
        expect.objectContaining({ firstLine: "first-chunk\n" }),
      );
      if (
        typeof record !== "object" ||
        record === null ||
        !("cleanup" in record)
      )
        throw new Error("missing actual child cleanup receipt");
      await server.closed.promise;
      expect(server.paths).toEqual(["/body"]);
      console.info(
        JSON.stringify({
          nativeChildNaturalExit: true,
          exitCode: result.code,
          cleanup: record.cleanup,
        }),
      );
      expect(
        record.cleanup,
        "normal shutdown cleanup failure is a real failure, not an accepted stop",
      ).toBe("acknowledged");
      expect(result.code).toBe(0);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed.promise;
      }
    }
  }, 10_000);
});
