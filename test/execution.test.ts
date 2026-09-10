// execution.test.ts — explain renders the offered row, the excluded row's reason phrase and failure
// block, and the raw string for an unknown reason; --history and accounts print the not-visible line
// with the settings URL and exit 0; running and queue print the fixture rows.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { EXCLUSION_REASONS, UNKNOWN_REASONS, describeReason, renderExplain } from "../src/execution";
import { startMeFixture, type FixtureServer } from "./fixture";
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
  await seedJoined(home, server);
});

describe("explain", () => {
  test("passes the team and the contract's ladder as capabilities", async () => {
    expect(await main(["explain", "ENG-1"], ctx)).toBe(0);
    const req = server.requests.find((r) => r.path.startsWith("/api/v1/work-eligibility"));
    expect(req?.path).toContain("team=ENG");
    expect(decodeURIComponent(req!.path)).toContain("capabilities=intake,research,plan,implement,validate,pr,remediate,merge");
  });
  test("renders the offered row", async () => {
    expect(await main(["explain", "ENG-1"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toBe("ENG-1 is offered (position 1) for phase research.");
  });
  test("renders the excluded row's reason phrase, failure block and advisory", async () => {
    expect(await main(["explain", "eng-2"], ctx)).toBe(0);
    const text = ctx.out.join("\n");
    expect(text).toContain("eng-2 is excluded (position 2): the failed phase is retrying in place and waiting out its backoff.");
    expect(text).toContain("Last failure: phase=implement, class=vendor_5xx, attempts=2, lastFailedAt=1756099000000.");
    expect(text).toContain("Advisories: assigned to a human with no delegate: this may be an unlabelled ask.");
  });
  test("prints the raw string for an unknown reason, never nothing", async () => {
    expect(await main(["explain", "ENG-3", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as { explanation: string; row: { reason: string } };
    expect(j.row.reason).toBe("frobnicate_pending");
    expect(j.explanation).toContain('reason "frobnicate_pending" (not in this bundle\'s table');
  });
  test("a ticket absent from the explainer says so", async () => {
    expect(await main(["explain", "ENG-99"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toMatch(/ENG-99: not in the ENG eligibility explainer/);
  });
  test("--history prints the not-visible line and the settings URL, exit 0, no eligibility call", async () => {
    expect(await main(["explain", "ENG-1", "--history"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toBe(`ENG-1: per-ticket execution history is not visible to an account key yet — read it at ${server.url}/settings`);
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/work-eligibility"))).toHaveLength(0);
  });
  test("usage errors and not joined", async () => {
    expect(await main(["explain"], ctx)).toBe(1);
    expect(await main(["explain", "nodash"], makeCtx(home))).toBe(1);
    expect(await main(["explain", "ENG-1"], makeCtx(tempHome()))).toBe(2);
  });
  test("the reason table covers the thirty exclusions and eleven unknowns", () => {
    expect(Object.keys(EXCLUSION_REASONS)).toHaveLength(30);
    expect(Object.keys(UNKNOWN_REASONS)).toHaveLength(11);
    expect(describeReason("blocked")).toMatch(/blocking relation/);
    expect(describeReason("ticket_unknown")).toMatch(/not in the mirror/);
    expect(describeReason(undefined)).toBe("no reason was given");
    expect(renderExplain("X-1", { status: "unknown", unknown: "ordering_stale" }, "X")).toContain("cannot be judged (no queue position): the dispatch order is stale.");
    expect(renderExplain("X-1", { status: "excluded", reason: "runner_image_breaker", detail: "sha abc", failure: { weird: true } }, "X")).toContain('Last failure: {"weird":true}.');
    expect(renderExplain("X-1", { status: "excluded", reason: "ask_shape_suspected", marker: "ask_template_body", release: "catalyst-not-an-ask", nextPhase: "research" }, "X")).toMatch(/Marker: ask_template_body\. Next phase would be research\. Release: catalyst-not-an-ask\./);
  });
});

describe("running / queue / accounts", () => {
  test("running prints the three fixture documents", async () => {
    expect(await main(["running"], ctx)).toBe(0);
    expect(ctx.out).toHaveLength(3);
    expect(ctx.out[0]).toContain("runner-7");
    expect(ctx.out[1]).toContain("concierge");
    expect(ctx.out[2]).toContain("attributions");
    const c2 = makeCtx(home);
    expect(await main(["running", "--json"], c2)).toBe(0);
    expect(Object.keys(JSON.parse(c2.out.join("\n")))).toEqual(["fleetActivity", "agentRoster", "leaseAttributions"]);
  });
  test("queue prints the fixture rows and passes --team", async () => {
    expect(await main(["queue", "--team", "ENG", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ team: "ENG", source: "self-derived" });
    expect(server.requests.find((r) => r.path.startsWith("/api/v1/dispatch-queue"))?.path).toContain("team=ENG");
    const c2 = makeCtx(home);
    expect(await main(["queue"], c2)).toBe(0);
    expect(c2.out.join("\n")).toContain("ENG-1");
  });
  test("accounts prints the not-visible line with the settings URL, exit 0", async () => {
    expect(await main(["accounts"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toBe(`coding-account status is not visible to an account key yet — read it at ${server.url}/settings/coding-accounts`);
    expect(await main(["accounts"], makeCtx(tempHome()))).toBe(2);
  });
  test("me prints the identity", async () => {
    expect(await main(["me"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("Hagale Technologies");
    const c2 = makeCtx(home);
    expect(await main(["me", "--json"], c2)).toBe(0);
    expect(JSON.parse(c2.out.join("\n"))).toMatchObject({ account: "tenant-3" });
  });
});
