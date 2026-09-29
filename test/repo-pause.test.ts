// repo-pause.test.ts — `catalyst repo status|pause|resume` against the agent twins the cloud pins:
// GET /api/v1/agent/repos → { repositories: [...], canManage }, POST …/pause {repoId, reason} and
// …/resume {repoId} → { repository }, with the cloud's error codes. A person names owner/name; the
// CLI finds the id in the list, so no id is ever typed, and a missing reason never leaves the machine.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { REPOS_PAUSE_ROUTE, REPOS_RESUME_ROUTE, REPOS_ROUTE, ago, repoLine } from "../src/repo-pause";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

type Body = Record<string, unknown>;
type Recorded = { method: string; path: string; body: Body | null };
const NOW = new Date("2026-09-29T15:00:00Z");
const T0 = NOW.getTime() - 3 * 3600_000;
const app = { id: "tenant-1:app", owner: "acme", name: "app", fullName: "acme/app", status: "paused", pausedAt: T0, pausedBy: { actor: "Sam Example", email: "sam@example.com" }, pauseReason: "flaky deploy", projects: [{ key: "ENG" }] };
const web = { id: "tenant-1:web", owner: "acme", name: "web", fullName: "acme/web", status: "active", pausedAt: null, pausedBy: null, pauseReason: null, projects: [] };
const old = { id: "tenant-1:old", owner: "acme", name: "old", fullName: "acme/old", status: "archived", pausedAt: null, pausedBy: null, pauseReason: null, projects: [] };

let fixture: FixtureServer;
let ctx: TestCtx;
let requests: Recorded[];
let response: (method: string, path: string, body: Body | null) => [number, unknown];

beforeAll(async () => { fixture = await startMeFixture(); });
afterAll(async () => { await fixture.close(); });
beforeEach(async () => {
  const home = tempHome();
  await seedJoined(home, fixture);
  requests = [];
  response = (method, path, body) => {
    if (method === "GET" && path === REPOS_ROUTE) return [200, { repositories: [app, web, old], canManage: true }];
    if (method === "POST" && path === REPOS_PAUSE_ROUTE) return [200, { repository: { ...web, status: "paused", pausedAt: NOW.getTime(), pausedBy: { actor: "Pat Example" }, pauseReason: body?.reason } }];
    if (method === "POST" && path === REPOS_RESUME_ROUTE) return [200, { repository: { ...app, status: "active", pausedAt: null, pausedBy: null, pauseReason: null } }];
    return [404, { error: "missing" }];
  };
  ctx = makeCtx(home, {
    now: () => NOW,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.startsWith(REPOS_ROUTE)) return fetch(input, init);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Body) : null;
      requests.push({ method, path: url.pathname, body });
      const [status, payload] = response(method, url.pathname, body);
      return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    },
  });
});

describe("status", () => {
  test("lists every repository with its state; a paused one says who, when and why", async () => {
    expect(await main(["repo", "status"], ctx)).toBe(0);
    expect(ctx.out).toEqual([
      "3 repositories, 1 paused",
      "  acme/app: paused by Sam Example 3 hours ago: flaky deploy (ENG)",
      "  acme/web: active",
      "  acme/old: archived",
      "change one: catalyst repo pause <owner/name> --reason <why>, catalyst repo resume <owner/name>",
    ]);
  });
  test("a member who cannot manage is told the role; --json passes the list through; an empty list says so", async () => {
    response = () => [200, { repositories: [web], canManage: false }];
    expect(await main(["repo", "status"], ctx)).toBe(0);
    expect(ctx.out.at(-1)).toBe("pausing or resuming one needs a workspace owner or admin");
    ctx.out.length = 0;
    expect(await main(["repo", "status", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ canManage: false, repositories: [{ fullName: "acme/web" }] });
    ctx.out.length = 0;
    response = () => [200, { repositories: [], canManage: true }];
    expect(await main(["repo", "status"], ctx)).toBe(0);
    expect(ctx.out[0]).toBe("no repository is registered to this workspace yet");
  });
  test("an older cloud without the routes says so", async () => {
    response = () => [404, { error: "route_missing" }];
    expect(await main(["repo", "status"], ctx)).toBe(1);
    expect(ctx.out[0]).toBe("refused (404): this Catalyst Cloud does not serve the repository routes yet (needs a newer cloud)");
  });
});

describe("pause", () => {
  test("finds the id from the list, POSTs {repoId, reason}, and prints the new row", async () => {
    expect(await main(["repo", "pause", "acme/web", "--reason", "flaky deploy"], ctx)).toBe(0);
    expect(requests.map((r) => r.method + " " + r.path)).toEqual([`GET ${REPOS_ROUTE}`, `POST ${REPOS_PAUSE_ROUTE}`]);
    expect(requests[1]!.body).toEqual({ repoId: "tenant-1:web", reason: "flaky deploy" });
    expect(ctx.out[0]).toBe("acme/web: paused; new work in it stops dispatching now, work in progress finishes");
    expect(ctx.out[1]).toBe("  acme/web: paused by Pat Example just now: flaky deploy");
  });
  test("owner/name is matched case-insensitively; an unknown one names the registered repositories and sends no write", async () => {
    expect(await main(["repo", "pause", "ACME/Web", "--reason", "x"], ctx)).toBe(0);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    requests.length = 0;
    ctx.err.length = 0;
    expect(await main(["repo", "pause", "acme/nope", "--reason", "x"], ctx)).not.toBe(0);
    expect(ctx.err.join("\n")).toMatch(/no repository acme\/nope is registered to this workspace \(registered: acme\/app, acme\/web, acme\/old\)/);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });
  test("no --reason, a blank one, or one over 500 characters never reaches the cloud", async () => {
    for (const argv of [["repo", "pause", "acme/web"], ["repo", "pause", "acme/web", "--reason", "   "], ["repo", "pause", "acme/web", "--reason", "x".repeat(501)]]) {
      ctx.err.length = 0;
      expect(await main(argv, ctx), argv.join(" ")).not.toBe(0);
      expect(ctx.err.join("\n")).toMatch(/needs --reason|at most 500/);
    }
    expect(requests).toHaveLength(0);
  });
  test("the cloud's refusals are said with the role, the archive, or the code", async () => {
    response = (m, p) => (m === "GET" ? [200, { repositories: [app, web, old], canManage: false }] : [403, { error: "forbidden", message: "pausing a repository requires an admin or owner role" }]);
    expect(await main(["repo", "pause", "acme/web", "--reason", "x"], ctx)).toBe(1);
    expect(ctx.out[0]).toBe("refused (403): pausing needs a workspace owner or admin (pausing a repository requires an admin or owner role)");
    ctx.out.length = 0;
    response = (m) => (m === "GET" ? [200, { repositories: [app, web, old], canManage: true }] : [409, { error: "not_pausable" }]);
    expect(await main(["repo", "pause", "acme/old", "--reason", "x"], ctx)).toBe(1);
    expect(ctx.out[0]).toBe("refused (409): the repository is archived and cannot be paused");
    ctx.out.length = 0;
    response = (m) => (m === "GET" ? [200, { repositories: [app, web, old], canManage: true }] : [400, { error: "reason_too_long", message: "max 500" }]);
    expect(await main(["repo", "pause", "acme/web", "--reason", "x"], ctx)).toBe(1);
    expect(ctx.out[0]).toBe("refused (400): reason_too_long (max 500)");
  });
});

describe("resume", () => {
  test("POSTs {repoId} (the reason only when given) and prints the row as active; --json carries the previous state", async () => {
    expect(await main(["repo", "resume", "acme/app"], ctx)).toBe(0);
    expect(requests[1]!).toMatchObject({ method: "POST", path: REPOS_RESUME_ROUTE, body: { repoId: "tenant-1:app" } });
    expect(requests[1]!.body).not.toHaveProperty("reason");
    expect(ctx.out).toEqual(["acme/app: resumed; dispatch continues at its configured cap", "  acme/app: active (ENG)"]);
    requests.length = 0;
    ctx.out.length = 0;
    expect(await main(["repo", "resume", "acme/app", "--reason", "deploy fixed", "--json"], ctx)).toBe(0);
    expect(requests[1]!.body).toEqual({ repoId: "tenant-1:app", reason: "deploy fixed" });
    expect(JSON.parse(ctx.out[0]!)).toMatchObject({ repository: { status: "active" }, previous: { status: "paused", pauseReason: "flaky deploy" } });
  });
});

describe("the pure parts", () => {
  test("ago and repoLine", () => {
    expect(ago(NOW.getTime() - 20_000, NOW)).toBe("just now");
    expect(ago(NOW.getTime() - 5 * 60_000, NOW)).toBe("5 minutes ago");
    expect(ago(NOW.getTime() - 3 * 3600_000, NOW)).toBe("3 hours ago");
    expect(ago(NOW.getTime() - 5 * 86400_000, NOW)).toBe("5 days ago");
    expect(repoLine({ fullName: "a/b", status: "paused", pausedAt: null, pausedBy: null, pauseReason: null }, NOW)).toBe("a/b: paused by an operator");
    expect(repoLine({ owner: "a", name: "c", status: "active", projects: ["ENG", "OPS"] }, NOW)).toBe("a/c: active (ENG, OPS)");
  });
  test("repo status takes no repository; pause and resume need one", async () => {
    expect(await main(["repo", "status", "acme/app"], ctx)).not.toBe(0);
    expect(await main(["repo", "resume"], ctx)).not.toBe(0);
    expect(requests).toHaveLength(0);
  });
});
