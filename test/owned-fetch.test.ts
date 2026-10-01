import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalystEventSync } from "@catalyst-cloud/sdk/events";
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
const owners: OwnedFetch[] = [];
const releases: Array<() => void> = [];
const directories: string[] = [];
const clients: CatalystEventSync[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const owner of owners) owner.abort(new Error("test teardown"));
  await Promise.allSettled(owners.splice(0).map((owner) => owner.settle()));
  await Promise.allSettled(clients.splice(0).map((client) => client.stop()));
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function own(fetchImpl: typeof fetch, parent = new AbortController()) {
  const owner = ownedFetch(fetchImpl, parent.signal);
  owners.push(owner);
  return { owner, parent };
}
function holdBody(first?: string, cancelFailure?: Error) {
  const readEntered = deferred<void>();
  const cancelEntered = deferred<void>();
  const acknowledgement = deferred<void>();
  releases.push(() => acknowledgement.resolve());
  const reasons: unknown[] = [];
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (first !== undefined)
          controller.enqueue(new TextEncoder().encode(first));
      },
      pull() {
        readEntered.resolve();
        // A real stream read remains pending; cancellation has a separate, held acknowledgement.
        return new Promise<void>(() => {});
      },
      cancel(reason) {
        reasons.push(reason);
        cancelEntered.resolve();
        return acknowledgement.promise.then(() => {
          if (cancelFailure) throw cancelFailure;
        });
      },
    },
    { highWaterMark: 0 },
  );
  return { body, readEntered, cancelEntered, acknowledgement, reasons };
}
function eventDirectory() {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "owned-event-body-"));
  directories.push(path);
  return path;
}
function eventClient(owner: OwnedFetch) {
  const client = new CatalystEventSync({
    baseUrl: "https://cloud.example.test",
    tenantId: "account-one",
    auth: { kind: "token", token: "fixture-personal-token" },
    directory: eventDirectory(),
    fetch: owner.fetch,
  });
  clients.push(client);
  return client;
}
function reply(
  body: ConstructorParameters<typeof Response>[0],
  status: number,
  head: number,
) {
  return new Response(body, {
    status,
    headers: { "x-catalyst-event-backbone-head-seq": String(head) },
  });
}

describe("owned fetch actual Response and stream lifetime", () => {
  test("preserves refusal status, status text, headers and literal body while refusing redirects", async () => {
    const observed: { init?: RequestInit } = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      observed.init = init;
      return new Response('{"error":"cursor_ahead_of_head","resumeFrom":7}', {
        status: 409,
        statusText: "Conflict",
        headers: {
          "content-type": "application/json",
          "x-catalyst-event-backbone-head-seq": "7",
        },
      });
    };
    const { owner } = own(fetchImpl);
    const response = await owner.fetch(
      "https://cloud.example.test/api/v1/events/backbone",
      {
        headers: { authorization: "Bearer fixture-private" },
        redirect: "follow",
      },
    );
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(409);
    expect(response.statusText).toBe("Conflict");
    expect(response.ok).toBe(false);
    expect(response.headers.get("x-catalyst-event-backbone-head-seq")).toBe(
      "7",
    );
    expect(await response.json()).toEqual({
      error: "cursor_ahead_of_head",
      resumeFrom: 7,
    });
    expect(observed.init?.redirect).toBe("error");
    expect(new Headers(observed.init?.headers).get("authorization")).toBe(
      "Bearer fixture-private",
    );
    await owner.settle();
  });

  test("natural EOF remains complete when a downstream reader cancels after EOF", async () => {
    let cancelCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 255, 1]));
        controller.close();
      },
      cancel() {
        cancelCalls++;
      },
    });
    const { owner } = own(async () => new Response(body));
    const response = await owner.fetch("https://cloud.example.test/page");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing actual response body");
    expect(await reader.read()).toEqual({
      done: false,
      value: new Uint8Array([0, 255, 1]),
    });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await reader.cancel(new Error("already finished"));
    await owner.settle();
    expect(cancelCalls).toBe(0);
  });

  test.each(["parent", "request", "init"] as const)(
    "pre-aborted %s refuses before actual fetch entry",
    async (rail) => {
      const parent = new AbortController(),
        request = new AbortController(),
        init = new AbortController();
      const reason = new Error(`pre-aborted ${rail}`);
      ({ parent, request, init })[rail].abort(reason);
      let entered = 0;
      const { owner } = own(async () => {
        entered++;
        return new Response(null);
      }, parent);
      const input = new Request("https://cloud.example.test/page", {
        signal: request.signal,
      });
      await expect(owner.fetch(input, { signal: init.signal })).rejects.toBe(
        reason,
      );
      expect(entered).toBe(0);
      await owner.settle();
    },
  );

  test("pre-aborted parent preserves an explicit null reason without substituting another error", async () => {
    const parent = new AbortController();
    parent.abort(null);
    let entered = 0;
    const { owner } = own(async () => {
      entered++;
      return new Response(null);
    }, parent);
    await expect(owner.fetch("https://cloud.example.test/page")).rejects.toBe(
      null,
    );
    expect(entered).toBe(0);
    await owner.settle();
  });

  test.each(["parent", "request", "init"] as const)(
    "active %s abort errors the body and joins held upstream cancellation",
    async (rail) => {
      const parent = new AbortController(),
        request = new AbortController(),
        init = new AbortController();
      const held = holdBody();
      const observed: { signal?: AbortSignal | null } = {};
      const { owner } = own(async (_input, options) => {
        observed.signal = options?.signal;
        // Deliberately ignore that signal in the upstream source: ownership must be supplied by the wrapper.
        return new Response(held.body);
      }, parent);
      const response = await owner.fetch(
        new Request("https://cloud.example.test/page", {
          signal: request.signal,
        }),
        { signal: init.signal },
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing body");
      const readFailure = reader.read().catch((error: unknown) => error);
      await held.readEntered.promise;
      const reason = new Error(`active ${rail}`);
      ({ parent, request, init })[rail].abort(reason);
      await held.cancelEntered.promise;
      expect(await readFailure).toBe(reason);
      expect(observed.signal?.aborted).toBe(true);
      expect(observed.signal?.reason).toBe(reason);
      expect(held.reasons).toEqual([reason]);
      let settled = false;
      const settlement = owner.settle().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      held.acknowledgement.resolve();
      await settlement;
    },
  );

  test("repeated abort and settle retain the first cancellation acknowledgement", async () => {
    const held = holdBody();
    const { owner } = own(async () => new Response(held.body));
    await owner.fetch("https://cloud.example.test/page");
    await held.readEntered.promise;
    const reason = new Error("first owned stop");
    owner.abort(reason);
    await held.cancelEntered.promise;
    owner.abort(new Error("second stop"));
    let firstDone = false,
      secondDone = false;
    const first = owner.settle().then(() => {
      firstDone = true;
    });
    const second = owner.settle().then(() => {
      secondDone = true;
    });
    await Promise.resolve();
    expect([firstDone, secondDone]).toEqual([false, false]);
    expect(held.reasons).toEqual([reason]);
    held.acknowledgement.resolve();
    await Promise.all([first, second]);
  });

  test("independent upstream cancel failure named AbortError remains a cleanup failure", async () => {
    const failure = new Error("actual upstream cleanup failed");
    failure.name = "AbortError";
    const held = holdBody(undefined, failure);
    const { owner } = own(async () => new Response(held.body));
    await owner.fetch("https://cloud.example.test/page");
    await held.readEntered.promise;
    owner.abort(new Error("intentional owned cancellation"));
    const settling = owner.settle().catch((error: unknown) => error);
    await held.cancelEntered.promise;
    held.acknowledgement.resolve();
    const actual = await settling;
    expect(actual).toBeInstanceOf(AggregateError);
    if (!(actual instanceof AggregateError))
      throw new Error("missing aggregate cleanup failure");
    expect(actual.errors).toContain(failure);
    await expect(owner.settle()).rejects.toThrow("owned_fetch_cleanup_failed");
  });

  test("late non-cooperative fetch headers stay owned through the returned body's cancellation", async () => {
    const headers = deferred<Response>(),
      fetchEntered = deferred<void>();
    releases.push(() => headers.resolve(new Response(null)));
    const held = holdBody();
    const { owner } = own(async () => {
      fetchEntered.resolve();
      return headers.promise;
    });
    const pending = owner
      .fetch("https://cloud.example.test/page")
      .catch((error: unknown) => error);
    await fetchEntered.promise;
    const reason = new Error("stop while headers pending");
    owner.abort(reason);
    let settled = false,
      delivered = false;
    const outcome = pending.then((value) => {
      delivered = true;
      return value;
    });
    const settlement = owner.settle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect([settled, delivered]).toEqual([false, false]);
    headers.resolve(new Response(held.body));
    await held.cancelEntered.promise;
    expect([settled, delivered]).toEqual([false, false]);
    expect(held.reasons).toEqual([reason]);
    held.acknowledgement.resolve();
    expect(await outcome).toBe(reason);
    await settlement;
  });

  test("entered fetch rejection is preserved without fabricating body cleanup failure", async () => {
    const headers = deferred<Response>(),
      entered = deferred<void>();
    releases.push(() => headers.resolve(new Response(null)));
    const failure = new Error("header transport failed");
    const { owner } = own(async () => {
      entered.resolve();
      return headers.promise;
    });
    const result = owner
      .fetch("https://cloud.example.test/page")
      .catch((error: unknown) => error);
    await entered.promise;
    headers.reject(failure);
    expect(await result).toBe(failure);
    await owner.settle();
    await expect(
      owner.fetch("https://cloud.example.test/another-page"),
    ).rejects.toThrow("owned_fetch_settling");
  });
});

describe("owned wrapper with real CatalystEventSync", () => {
  test("preserves real bootstrap and page contracts without a double API prefix", async () => {
    const urls: URL[] = [];
    const { owner, parent } = own(async (input) => {
      urls.push(new URL(input instanceof Request ? input.url : String(input)));
      return urls.length === 1
        ? reply('{"error":"cursor_ahead_of_head","resumeFrom":7}', 409, 7)
        : reply("", 200, 7);
    });
    const client = eventClient(owner);
    try {
      expect(await client.syncOnce(parent.signal)).toEqual({
        appended: 0,
        cursor: 7,
        head: 7,
      });
    } finally {
      await owner.settle();
    }
    expect(urls.map((url) => url.pathname)).toEqual([
      "/api/v1/events/backbone",
      "/api/v1/events/backbone",
    ]);
    expect(urls.map((url) => url.searchParams.get("since"))).toEqual([
      String(Number.MAX_SAFE_INTEGER),
      "7",
    ]);
    expect(existsSync(client.paths.cursor)).toBe(true);
    expect(existsSync(`${client.paths.lock}.writer.lock`)).toBe(true);
    await client.stop();
    expect(existsSync(`${client.paths.lock}.writer.lock`)).toBe(false);
  });

  test("actual SDK NDJSON parse failure joins the still-open upstream body before releasing its lock", async () => {
    const held = holdBody("{malformed-json}\n");
    let calls = 0;
    const { owner, parent } = own(async () =>
      ++calls === 1
        ? reply('{"error":"cursor_ahead_of_head","resumeFrom":0}', 409, 0)
        : reply(held.body, 200, 1),
    );
    const client = eventClient(owner);
    let completed = false;
    const operation = client
      .syncOnce(parent.signal)
      .finally(() => owner.settle())
      .catch((error: unknown) => {
        completed = true;
        return error;
      });
    await held.cancelEntered.promise;
    expect(completed).toBe(false);
    expect(existsSync(client.paths.cursor)).toBe(false);
    expect(existsSync(`${client.paths.lock}.writer.lock`)).toBe(true);
    held.acknowledgement.resolve();
    expect(await operation).toBeInstanceOf(SyntaxError);
    await client.stop();
    expect(existsSync(`${client.paths.lock}.writer.lock`)).toBe(false);
  });

  test("abort cannot turn a partial real event page into successful EOF or a checkpoint", async () => {
    const line =
      JSON.stringify({
        tenantId: "account-one",
        sequence: 1,
        eventId: "event-one",
        type: "phase.outcome.reported",
        schemaVersion: 1,
        recordedAt: "2026-10-01T00:00:00Z",
        payload: { ok: true },
      }) + "\n";
    const held = holdBody(line);
    let calls = 0;
    const { owner, parent } = own(async () =>
      ++calls === 1
        ? reply('{"error":"cursor_ahead_of_head","resumeFrom":0}', 409, 0)
        : reply(held.body, 200, 1),
    );
    const client = eventClient(owner);
    const operation = client
      .syncOnce(parent.signal)
      .finally(() => owner.settle())
      .catch((error: unknown) => error);
    await held.readEntered.promise;
    const reason = new Error("stop during real SDK page read");
    parent.abort(reason);
    await held.cancelEntered.promise;
    expect(existsSync(client.paths.cursor)).toBe(false);
    held.acknowledgement.resolve();
    expect(await operation).toBe(reason);
    expect(client.status().cursor).toBe(null);
    expect(existsSync(client.paths.cursor)).toBe(false);
    await client.stop();
  });

  test("real bootstrap JSON body abort joins cancellation and never publishes a cursor", async () => {
    const held = holdBody('{"error":"cursor_ahead_of_head",');
    const { owner, parent } = own(async () => reply(held.body, 409, 4));
    const client = eventClient(owner);
    const operation = client
      .syncOnce(parent.signal)
      .finally(() => owner.settle())
      .catch((error: unknown) => error);
    await held.readEntered.promise;
    const reason = new Error("stop during bootstrap JSON");
    parent.abort(reason);
    await held.cancelEntered.promise;
    expect(existsSync(client.paths.cursor)).toBe(false);
    held.acknowledgement.resolve();
    expect(await operation).toBe(reason);
    expect(client.status().cursor).toBe(null);
    await client.stop();
  });
});
