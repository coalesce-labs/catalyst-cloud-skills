// ask-list.test.ts — CTC-2010 Tier 1, criterion 3: `ask list` reads the whole tenant scope, so an
// ask past the server's page cap still shows up in the inbox and is still scored against the whole
// tenant, not a partial view of what it blocks.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { fixtureIssues, manyIssues, startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  home = tempHome();
  ctx = makeCtx(home);
  server.requests.length = 0;
});

describe("ask list reads the whole scope", () => {
  afterAll(() => {
    server.pageCap = undefined;
    server.issues = fixtureIssues();
  });

  test("the inbox is complete on a tenant past the server's page cap", async () => {
    await seedJoined(home, server);
    server.pageCap = 500;
    server.issues = [...manyIssues(600), ...fixtureIssues()];
    expect(await main(["ask", "list", "--anyone", "--json"], ctx)).toBe(0);
    const { asks } = JSON.parse(ctx.out.join("\n")) as { asks: { identifier: string }[] };
    expect(asks.map((a) => a.identifier).sort()).toEqual(["ENG-7", "ENG-8"]);
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/issues?"))).toHaveLength(2);
  });

  test("a ticket an ask blocks is still scored using the whole tenant, even though the ask sits on a later page than the ticket it blocks", async () => {
    await seedJoined(home, server);
    server.pageCap = 500;
    server.issues = [...manyIssues(600), ...fixtureIssues()];
    expect(await main(["ask", "list", "--anyone", "--json"], ctx)).toBe(0);
    const { asks } = JSON.parse(ctx.out.join("\n")) as { asks: { identifier: string; score: number; blocks: string[] }[] };
    const eng7 = asks.find((a) => a.identifier === "ENG-7");
    // fixtureIssues: ENG-7 blocks ENG-1 (priority 2 -> weight 3) and ENG-2 (priority 1 -> weight 4).
    expect(eng7?.blocks.sort()).toEqual(["ENG-1", "ENG-2"]);
    expect(eng7?.score).toBe(7);
  });

  test("a tenant that fits in one page still makes exactly one request", async () => {
    await seedJoined(home, server);
    server.pageCap = 500;
    server.issues = fixtureIssues();
    expect(await main(["ask", "list", "--anyone", "--json"], ctx)).toBe(0);
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/issues?"))).toHaveLength(1);
  });
});
