import { afterEach, describe, expect, test } from "vitest";
import { ownedFetch, type OwnedFetch } from "../src/owned-fetch.js";

const owners: OwnedFetch[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const owner of owners) owner.abort(new Error("boundary teardown"));
  await Promise.allSettled(owners.splice(0).map((owner) => owner.settle()));
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function own(
  fetchImpl: typeof fetch,
  maxBodyBytes?: number,
  parent = new AbortController(),
) {
  const owner = ownedFetch(fetchImpl, parent.signal, { maxBodyBytes });
  owners.push(owner);
  return owner;
}

describe("owned fetch separate transport and bounded consumers", () => {
  test.each(["parent", "request", "init"] as const)(
    "%s cancellation enters the actual reader before aborting transport and waits for its first acknowledgement",
    async (rail) => {
      const parent = new AbortController(),
        request = new AbortController(),
        init = new AbortController();
      const entered = deferred(),
        cancelEntered = deferred(),
        ack = deferred();
      releases.push(ack.resolve);
      const network: { signal?: AbortSignal | null } = {};
      const observations: boolean[] = [];
      const reason = new Error(`ordered-${rail}`);
      const source = new ReadableStream<Uint8Array>(
        {
          pull() {
            entered.resolve();
            return new Promise<void>(() => {});
          },
          cancel(received) {
            expect(received).toBe(reason);
            observations.push(network.signal?.aborted === true);
            cancelEntered.resolve();
            return ack.promise;
          },
        },
        { highWaterMark: 0 },
      );
      const owner = own(
        async (_input, options) => {
          network.signal = options?.signal;
          return new Response(source);
        },
        undefined,
        parent,
      );
      const response = await owner.fetch(
        new Request("https://cloud.example.test/page", {
          signal: request.signal,
        }),
        { signal: init.signal },
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing actual body reader");
      const read = reader.read().catch((error: unknown) => error);
      await entered.promise;
      ({ parent, request, init })[rail].abort(reason);
      await cancelEntered.promise;
      expect(observations).toEqual([false]);
      expect(network.signal?.aborted).toBe(true);
      expect(network.signal?.reason).toBe(reason);
      expect(await read).toBe(reason);
      let settled = false;
      const settlement = owner.settle().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      ack.resolve();
      await settlement;
      expect(settled).toBe(true);
      reader.releaseLock();
    },
  );

  test.each([0, -1, 1.5, Infinity])(
    "invalid body limit %s refuses without fetch entry",
    (value) => {
      let entered = 0;
      const fetchImpl: typeof fetch = async () => {
        entered++;
        return new Response(null);
      };
      expect(() =>
        ownedFetch(fetchImpl, new AbortController().signal, {
          maxBodyBytes: value,
        }),
      ).toThrow("owned_fetch_body_limit_invalid");
      expect(entered).toBe(0);
    },
  );

  test("the byte limit includes its exact boundary and resets for each actual response", async () => {
    const bytes = new Uint8Array([0, 1, 255, 2]);
    const owner = own(async () => new Response(bytes), bytes.byteLength);
    for (let index = 0; index < 2; index++) {
      const response = await owner.fetch(
        `https://cloud.example.test/page/${index}`,
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    }
    await owner.settle();
  });

  test("the over-limit chunk is never delivered and cleanup joins the actual cancellation", async () => {
    const ack = deferred(),
      canceled = deferred(),
      firstChunk = deferred();
    releases.push(ack.resolve);
    let pulls = 0;
    const reasons: unknown[] = [];
    const source = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const first = pulls++ === 0;
          if (first) await firstChunk.promise;
          controller.enqueue(new Uint8Array(first ? [1, 2] : [3, 4, 5]));
        },
        cancel(reason) {
          reasons.push(reason);
          canceled.resolve();
          return ack.promise;
        },
      },
      { highWaterMark: 0 },
    );
    const owner = own(async () => new Response(source), 4);
    const response = await owner.fetch("https://cloud.example.test/page");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing actual body reader");
    const firstRead = reader.read();
    firstChunk.resolve();
    expect(await firstRead).toEqual({
      done: false,
      value: new Uint8Array([1, 2]),
    });
    await expect(reader.read()).rejects.toThrow("owned_fetch_body_limit");
    await canceled.promise;
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBeInstanceOf(Error);
    let settled = false;
    const settlement = owner.settle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    ack.resolve();
    await settlement;
    reader.releaseLock();
  });

  test("an unspecified limit does not impose the authority cap on generic event/feed consumers", async () => {
    const bytes = new Uint8Array(1024 * 1024 + 1).fill(7);
    const owner = own(async () => new Response(bytes));
    const response = await owner.fetch("https://cloud.example.test/page");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    await owner.settle();
  });

  test("a genuine cancellation rejection after a body-limit failure is retained", async () => {
    const failure = new Error("real cancel failure");
    failure.name = "AbortError";
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
        },
        cancel() {
          return Promise.reject(failure);
        },
      },
      { highWaterMark: 0 },
    );
    const owner = own(async () => new Response(source), 1);
    const response = await owner.fetch("https://cloud.example.test/page");
    await expect(response.arrayBuffer()).rejects.toThrow(
      "owned_fetch_body_limit",
    );
    const error = await owner.settle().catch((error: unknown) => error);
    if (!(error instanceof AggregateError))
      throw new Error("actual cleanup rejection was lost");
    expect(error.message).toBe("owned_fetch_cleanup_failed");
    expect(error.errors).toContain(failure);
  });
});
