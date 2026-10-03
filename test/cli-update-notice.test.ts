import { describe, expect, test } from "vitest";
import { makeCtx, tempHome } from "./helpers.js";
import { maybePrintPublishedUpdateNotice } from "../src/cli-update-notice.js";
import { REGISTRY_DIST_TAGS_URL } from "../src/published.js";

describe("once-a-day published update notice", () => {
  test("checks anonymously once a day and only prints a newer release", async () => {
    let now = Date.UTC(2026, 9, 2),
      calls = 0;
    const stderr: string[] = [];
    const ctx = makeCtx(tempHome(), {
      now: () => new Date(now),
      stderr: (line) => stderr.push(line),
      fetch: (async (url, options) => {
        calls++;
        expect(String(url)).toBe(REGISTRY_DIST_TAGS_URL);
        expect(new Headers(options?.headers).get("authorization")).toBeNull();
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        return new Response(JSON.stringify({ latest: "0.14.11" }));
      }) as typeof fetch,
    });
    const opts = {
      interactive: true,
      json: false,
      command: "status",
      version: "0.14.10",
    };
    await maybePrintPublishedUpdateNotice(ctx, opts);
    expect(stderr).toEqual([
      "Catalyst 0.14.11 is out. Update with: npm install -g @catalyst-cloud/cli@latest",
    ]);
    await maybePrintPublishedUpdateNotice(ctx, opts);
    expect(calls).toBe(1);
    expect(stderr).toHaveLength(1);
    now += 24 * 60 * 60 * 1000;
    await maybePrintPublishedUpdateNotice(ctx, opts);
    expect(calls).toBe(2);
    expect(stderr).toHaveLength(2);
  });

  test.each([
    { interactive: false, json: false, command: "status" },
    { interactive: true, json: true, command: "status" },
    { interactive: true, json: false, command: "onboard" },
    { interactive: true, json: false, command: "setup" },
  ])(
    "machine output and setup frames do not make a notice request %j",
    async (opts) => {
      let calls = 0;
      const stderr: string[] = [];
      const ctx = makeCtx(tempHome(), {
        fetch: (async () => {
          calls++;
          return new Response(JSON.stringify({ latest: "0.14.11" }));
        }) as typeof fetch,
        stderr: (line) => stderr.push(line),
      });
      await maybePrintPublishedUpdateNotice(ctx, {
        ...opts,
        version: "0.14.10",
      });
      expect(calls).toBe(0);
      expect(stderr).toEqual([]);
    },
  );

  test.each(["0.14.10", "0.14.9", "0.14.11\nrun bad-command", "nonsense"])(
    "does not print current, old or unsafe version %s",
    async (latest) => {
      const stderr: string[] = [];
      const ctx = makeCtx(tempHome(), {
        stderr: (line) => stderr.push(line),
        fetch: (async () =>
          new Response(JSON.stringify({ latest }))) as typeof fetch,
      });
      await maybePrintPublishedUpdateNotice(ctx, {
        interactive: true,
        json: false,
        command: "status",
        version: "0.14.10",
      });
      expect(stderr).toEqual([]);
    },
  );

  test("a failed check is silent and not retried on every command", async () => {
    let calls = 0;
    const stderr: string[] = [];
    const ctx = makeCtx(tempHome(), {
      fetch: (async () => {
        calls++;
        throw new Error("offline");
      }) as typeof fetch,
      stderr: (line) => stderr.push(line),
    });
    const opts = {
      interactive: true,
      json: false,
      command: "status",
      version: "0.14.10",
    };
    await maybePrintPublishedUpdateNotice(ctx, opts);
    await maybePrintPublishedUpdateNotice(ctx, opts);
    expect(calls).toBe(1);
    expect(stderr).toEqual([]);
  });
});
