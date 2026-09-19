// published.test.ts — latestPublishedVersion (CTC-2160): the ONLY network call `ready` makes, so
// every case here injects a fake `ctx.fetch`. No test in this file may touch the real registry.
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDirFor, publishedCachePathFor } from "../src/config";
import {
  PUBLISHED_TIMEOUT_MS,
  PUBLISHED_TTL_SECONDS,
  REGISTRY_DIST_TAGS_URL,
  latestPublishedVersion,
} from "../src/published";
import { makeCtx, tempHome } from "./helpers";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clock(startMs: number) {
  let ms = startMs;
  return { now: () => new Date(ms), advance: (deltaMs: number) => (ms += deltaMs) };
}

describe("latestPublishedVersion", () => {
  test("returns dist-tags.latest and writes the cache at mode 0600", async () => {
    const home = tempHome();
    let calls = 0;
    const fetchFn = (async (url: string | URL) => {
      calls += 1;
      expect(String(url)).toBe(REGISTRY_DIST_TAGS_URL);
      return jsonResponse({ latest: "0.5.0" });
    }) as typeof fetch;
    const ctx = makeCtx(home, { fetch: fetchFn });
    const result = await latestPublishedVersion(ctx);
    expect(result).toEqual({ latest: "0.5.0", reason: null, source: "network" });
    expect(calls).toBe(1);
    const path = publishedCachePathFor(home);
    const cache = JSON.parse(readFileSync(path, "utf8")) as { latest: string; fetchedAt: string };
    expect(cache.latest).toBe("0.5.0");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a cache younger than the TTL is used and no request is made", async () => {
    const home = tempHome();
    const c = clock(1_000_000);
    let calls = 0;
    const fetching = (async () => {
      calls += 1;
      return jsonResponse({ latest: "0.5.0" });
    }) as typeof fetch;
    const ctx = makeCtx(home, { fetch: fetching, now: c.now });
    await latestPublishedVersion(ctx);
    expect(calls).toBe(1);
    c.advance(1000);
    const second = await latestPublishedVersion(ctx);
    expect(calls).toBe(1);
    expect(second).toEqual({ latest: "0.5.0", reason: null, source: "cache" });
  });

  test("a cache older than the TTL is revalidated", async () => {
    const home = tempHome();
    const c = clock(1_000_000);
    let calls = 0;
    const fetching = (async () => {
      calls += 1;
      return jsonResponse({ latest: calls === 1 ? "0.5.0" : "0.6.0" });
    }) as typeof fetch;
    const ctx = makeCtx(home, { fetch: fetching, now: c.now });
    await latestPublishedVersion(ctx);
    expect(calls).toBe(1);
    c.advance((PUBLISHED_TTL_SECONDS + 60) * 1000);
    const second = await latestPublishedVersion(ctx);
    expect(calls).toBe(2);
    expect(second).toEqual({ latest: "0.6.0", reason: null, source: "network" });
  });

  test("a non-200 falls back to the stale cache", async () => {
    const home = tempHome();
    const c = clock(1_000_000);
    let mode = 200;
    const fetching = (async () => jsonResponse({ latest: "0.5.0" }, mode === 200 ? 200 : mode)) as typeof fetch;
    const ctx = makeCtx(home, { fetch: fetching, now: c.now });
    await latestPublishedVersion(ctx);
    c.advance((PUBLISHED_TTL_SECONDS + 60) * 1000);
    mode = 401;
    const result = await latestPublishedVersion(ctx);
    expect(result).toEqual({ latest: "0.5.0", reason: null, source: "stale-cache" });
    mode = 503;
    c.advance((PUBLISHED_TTL_SECONDS + 60) * 1000);
    const result2 = await latestPublishedVersion(ctx);
    expect(result2).toEqual({ latest: "0.5.0", reason: null, source: "stale-cache" });
  });

  test("a non-200 with no cache returns null and a reason", async () => {
    const home = tempHome();
    const fetching = (async () => jsonResponse({}, 401)) as typeof fetch;
    const ctx = makeCtx(home, { fetch: fetching });
    const result = await latestPublishedVersion(ctx);
    expect(result).toEqual({ latest: null, reason: "registry answered 401", source: "none" });
  });

  test("a timeout returns null and a reason, and never throws", async () => {
    const home = tempHome();
    const fetching = (async () => {
      const err = new Error("The operation was aborted");
      err.name = "TimeoutError";
      throw err;
    }) as typeof fetch;
    const ctx = makeCtx(home, { fetch: fetching });
    const result = await latestPublishedVersion(ctx);
    expect(result).toEqual({ latest: null, reason: "timed out", source: "none" });
  });

  test("an unroutable network failure returns null and the error's message", async () => {
    const home = tempHome();
    const fetching = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    const ctx = makeCtx(home, { fetch: fetching });
    const result = await latestPublishedVersion(ctx);
    expect(result).toEqual({ latest: null, reason: "fetch failed", source: "none" });
  });

  test("a malformed body (no latest / latest not a string) returns null", async () => {
    const home = tempHome();
    const fetching = (async () => jsonResponse({ latest: 5 })) as typeof fetch;
    const ctx = makeCtx(home, { fetch: fetching });
    const result = await latestPublishedVersion(ctx);
    expect(result).toEqual({ latest: null, reason: "the registry sent no dist-tags.latest", source: "none" });
  });

  test("a corrupt cache file is ignored, not fatal", async () => {
    const home = tempHome();
    const fs = await import("node:fs");
    fs.mkdirSync(configDirFor(home), { recursive: true });
    fs.writeFileSync(publishedCachePathFor(home), "{corrupt");
    let calls = 0;
    const fetching = (async () => {
      calls += 1;
      return jsonResponse({ latest: "0.5.0" });
    }) as typeof fetch;
    const ctx = makeCtx(home, { fetch: fetching });
    const result = await latestPublishedVersion(ctx);
    expect(calls).toBe(1);
    expect(result).toEqual({ latest: "0.5.0", reason: null, source: "network" });
  });

  test("offline: true never calls fetch and returns the cache when there is one, else null", async () => {
    const home = tempHome();
    let calls = 0;
    const fetching = (async () => {
      calls += 1;
      return jsonResponse({ latest: "0.5.0" });
    }) as typeof fetch;
    const ctx = makeCtx(home, { fetch: fetching });
    const bare = await latestPublishedVersion(ctx, { offline: true });
    expect(bare).toEqual({ latest: null, reason: "offline", source: "none" });
    expect(calls).toBe(0);
    await latestPublishedVersion(ctx); // populate the cache
    const withCache = await latestPublishedVersion(ctx, { offline: true });
    expect(withCache).toEqual({ latest: "0.5.0", reason: null, source: "cache" });
    expect(calls).toBe(1);
  });

  test("the request is capped with an AbortSignal timeout", async () => {
    const home = tempHome();
    let sawSignal = false;
    const fetching = (async (_url: string | URL, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return jsonResponse({ latest: "0.5.0" });
    }) as typeof fetch;
    const ctx = makeCtx(home, { fetch: fetching });
    await latestPublishedVersion(ctx);
    expect(sawSignal).toBe(true);
    expect(PUBLISHED_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});

describe("the registry is named in exactly one file", () => {
  test("only src/published.ts names a non-tenant host", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const offenders = readdirSync(srcDir)
      .filter((f) => f.endsWith(".ts") && f !== "published.ts")
      .filter((f) => /registry\.npmjs|api\.github\.com/.test(readFileSync(join(srcDir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
