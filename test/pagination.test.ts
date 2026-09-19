// pagination.test.ts — unit level, no CLI: header parsing, the walk's request sequence, both
// refusal guards, and the truncation notice's three shapes.
import { describe, expect, test } from "vitest";
import { fetchAllPages, fetchPage, truncationNotice, type Page } from "../src/pagination";
import type { ApiClient, GetOptions } from "../src/transport";

function fakeApi(pages: { rows: Record<string, unknown>[]; nextCursor?: string; total?: number }[]): {
  api: ApiClient;
  calls: NonNullable<GetOptions["query"]>[];
} {
  const calls: NonNullable<GetOptions["query"]>[] = [];
  let i = 0;
  const api = {
    getJson: async (_path: string, opts: GetOptions = {}) => {
      calls.push(opts.query ?? {});
      const p = pages[Math.min(i, pages.length - 1)]!;
      i += 1;
      const headers = new Headers();
      if (p.nextCursor !== undefined) headers.set("x-mirror-next-cursor", p.nextCursor);
      if (p.total !== undefined) headers.set("x-mirror-total", String(p.total));
      return { status: 200, body: { rows: p.rows }, headers };
    },
  } as unknown as ApiClient;
  return { api, calls };
}

describe("fetchPage", () => {
  test("nextCursor is null when the header is absent, and the raw token otherwise", async () => {
    const { api } = fakeApi([{ rows: [], total: 3 }]);
    expect((await fetchPage(api, "/api/v1/issues", {})).nextCursor).toBeNull();
    const { api: api2 } = fakeApi([{ rows: [], nextCursor: "cur-1", total: 3 }]);
    expect((await fetchPage(api2, "/api/v1/issues", {})).nextCursor).toBe("cur-1");
  });

  test("total is null when x-mirror-total is absent or not a non-negative integer", async () => {
    const { api } = fakeApi([{ rows: [] }]);
    expect((await fetchPage(api, "/api/v1/issues", {})).total).toBeNull();
    const negative = { getJson: async () => ({ status: 200, body: { rows: [] }, headers: new Headers({ "x-mirror-total": "-1" }) }) } as unknown as ApiClient;
    expect((await fetchPage(negative, "/api/v1/issues", {})).total).toBeNull();
    const notANumber = { getJson: async () => ({ status: 200, body: { rows: [] }, headers: new Headers({ "x-mirror-total": "abc" }) }) } as unknown as ApiClient;
    expect((await fetchPage(notANumber, "/api/v1/issues", {})).total).toBeNull();
  });
});

describe("fetchAllPages", () => {
  test("sends no `after` on page one and the previous cursor on every page after", async () => {
    const { api, calls } = fakeApi([
      { rows: [{ id: 1 }], nextCursor: "c1", total: 3 },
      { rows: [{ id: 2 }], nextCursor: "c2", total: 3 },
      { rows: [{ id: 3 }], total: 3 },
    ]);
    await fetchAllPages(api, "/api/v1/issues", { team: "ENG" });
    expect(calls[0]?.after).toBeUndefined();
    expect(calls[1]?.after).toBe("c1");
    expect(calls[2]?.after).toBe("c2");
    expect(calls.every((c) => c.team === "ENG")).toBe(true);
  });

  test("stops when the cursor header disappears and returns every row in order", async () => {
    const { api } = fakeApi([
      { rows: [{ id: 1 }], nextCursor: "c1", total: 3 },
      { rows: [{ id: 2 }, { id: 3 }], total: 3 },
    ]);
    const { rows, total, pages } = await fetchAllPages(api, "/api/v1/issues", {});
    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(total).toBe(3);
    expect(pages).toBe(2);
  });

  test("a repeated cursor throws CliError('pagination-stalled') instead of looping", async () => {
    const { api } = fakeApi([
      { rows: [{ id: 1 }], nextCursor: "stuck", total: 99 },
      { rows: [{ id: 2 }], nextCursor: "stuck", total: 99 },
    ]);
    await expect(fetchAllPages(api, "/api/v1/issues", {})).rejects.toMatchObject({ code: "pagination-stalled", exitCode: 1 });
  });

  test("more than MAX_PAGES pages throws CliError('pagination-overrun') naming the cap", async () => {
    const api = {
      getJson: async (_path: string, opts: GetOptions = {}) => {
        const n = Number(opts.query?.after ?? "0") + 1;
        return {
          status: 200,
          body: { rows: [{ id: n }] },
          headers: new Headers({ "x-mirror-next-cursor": String(n), "x-mirror-total": "999999" }),
        };
      },
    } as unknown as ApiClient;
    await expect(fetchAllPages(api, "/api/v1/issues", {})).rejects.toMatchObject({ code: "pagination-overrun", exitCode: 1 });
  });
});

describe("truncationNotice", () => {
  test("is null when there is no next cursor", () => {
    const page: Page = { rows: [{ id: 1 }], nextCursor: null, total: 1 };
    expect(truncationNotice(page)).toBeNull();
  });

  test("reads `truncated at <rows on the page> of <x-mirror-total>`", () => {
    const page: Page = { rows: new Array(50).fill({}), nextCursor: "c1", total: 120 };
    expect(truncationNotice(page)).toBe("truncated at 50 of 120 — re-run with --all to read the whole scope");
  });

  test("degrades to a named unknown total when x-mirror-total is missing", () => {
    const page: Page = { rows: new Array(50).fill({}), nextCursor: "c1", total: null };
    expect(truncationNotice(page)).toBe(
      "truncated at 50 of an unknown total (the cloud sent no x-mirror-total) — re-run with --all to read the whole scope",
    );
  });
});
