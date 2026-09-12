// execution.test.ts — explain renders the offered row, the excluded row's reason phrase and failure
// block, and the raw string for an unknown reason; --history and accounts print the not-visible line
// with the settings URL and exit 0; running and queue print the fixture rows.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { EXCLUSION_REASONS, UNKNOWN_REASONS, describeReason, renderExplain } from "../src/execution";
import { fixtureIssues, startMeFixture, type FixtureServer } from "./fixture";
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
  test("a Backlog ticket with no dispatch row is named as known, not unknown", async () => {
    // ENG-7 is in the mirror but not in the eligibility rows (ENG-1/2/3): a null dispatch row is not
    // proof of non-existence, so `explain` probes /api/v1/issues/:id and names the non-dispatch state.
    server.issues = fixtureIssues().map((i) => (i.identifier === "ENG-7" ? { ...i, state: "Backlog" } : i));
    expect(await main(["explain", "ENG-7"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toBe("ENG-7: known to the mirror; state Backlog is not a dispatch state.");
  });
  test("a ticket the mirror 404s on keeps the unknown wording", async () => {
    expect(await main(["explain", "ENG-404"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toBe("ENG-404: not in the ENG eligibility explainer — the ticket is unknown to the mirror, terminal, or on another team.");
  });
  // ⛔ 0.2.0 printed a "not visible to an account key yet" placeholder here and called nothing.
  // CTC-1954's route is the real answer; --history is an alias of the `history` verb.
  test("--history reads the execution route, not a placeholder, and skips the eligibility call", async () => {
    expect(await main(["explain", "ENG-2", "--history"], ctx)).toBe(0);
    expect(server.requests.map((r) => r.path.split("?")[0])).toContain("/api/v1/issues/ENG-2/execution");
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/work-eligibility"))).toHaveLength(0);
    expect(ctx.out.join("\n")).not.toContain("not visible to an account key yet");
    expect(ctx.out.join("\n")).toContain("implement: cooling (attempt 2)");
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
  // ⛔ `/api/v1/lease/attributions` is per (ticket, phase) and 400s `invalid_field` without both.
  // 0.2.0 called it unconditionally, so `running` — the headline "what is happening?" verb, and the
  // first thing a customer types — 400'd for every tenant. The fleet-wide question is answered by
  // /fleet-activity/current and /agent-roster/current, which take no coordinates.
  test("running asks only the two fleet-wide routes, never a bare lease/attributions", async () => {
    expect(await main(["running"], ctx)).toBe(0);
    expect(server.requests.map((r) => r.path.split("?")[0])).toContain("/api/v1/fleet-activity/current");
    expect(server.requests.map((r) => r.path.split("?")[0])).toContain("/api/v1/agent-roster/current");
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/lease/attributions"))).toHaveLength(0);
    const text = ctx.out.join("\n");
    expect(text).toContain("runner-7");
    expect(text).toContain("concierge");
    const c2 = makeCtx(home);
    expect(await main(["running", "--json"], c2)).toBe(0);
    expect(Object.keys(JSON.parse(c2.out.join("\n")))).toEqual(["fleetActivity", "agentRoster"]);
  });
  test("running --ticket/--phase adds the lease attributions for that pair", async () => {
    expect(await main(["running", "--ticket", "ENG-2", "--phase", "implement", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(j)).toEqual(["fleetActivity", "agentRoster", "leaseAttributions"]);
    const req = server.requests.find((r) => r.path.startsWith("/api/v1/lease/attributions"));
    expect(req?.path).toContain("ticket=ENG-2");
    expect(req?.path).toContain("phase=implement");
  });
  test("running --ticket without --phase is a usage error, not a 400 from the cloud", async () => {
    expect(await main(["running", "--ticket", "ENG-2"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain("--ticket and --phase go together");
    expect(server.requests.filter((r) => r.path.startsWith("/api/v1/lease/attributions"))).toHaveLength(0);
  });
  test("queue prints the fixture rows and passes --team", async () => {
    expect(await main(["queue", "--team", "ENG", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toMatchObject({ team: "ENG", source: "self-derived" });
    expect(server.requests.find((r) => r.path.startsWith("/api/v1/dispatch-queue"))?.path).toContain("team=ENG");
  });
  // ⛔ The route REQUIRES a team ("bad team", 400). `queue`'s usage line calls --team optional, so
  // the omitted case has to be answered by the CLI: the contract already names this tenant's teams.
  test("queue with no --team reads every team the contract names", async () => {
    expect(await main(["queue"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("ENG-1");
    const asked = server.requests
      .filter((r) => r.path.startsWith("/api/v1/dispatch-queue"))
      .map((r) => new URL(r.path, "http://x").searchParams.get("team"));
    expect(asked).toEqual(["ENG", "OPS"]);
    const c2 = makeCtx(home);
    expect(await main(["queue", "--json"], c2)).toBe(0);
    expect(Object.keys(JSON.parse(c2.out.join("\n")))).toEqual(["ENG", "OPS"]);
  });
  // ⛔ 0.2.0 printed a placeholder unconditionally and never called the route, so it could not have
  // started working when CTC-1953 deployed. These assert the CALL, not just the rendering.
  test("accounts calls /api/v1/coding-accounts and renders the slots", async () => {
    expect(await main(["accounts"], ctx)).toBe(0);
    expect(server.requests.map((r) => r.path.split("?")[0])).toContain("/api/v1/coding-accounts");
    const text = ctx.out.join("\n");
    expect(text).not.toContain("not visible to an account key yet");
    expect(text).toContain("slot-a (primary)  claude/claude-code  active — observed working");
    expect(text).toContain("holding ENG-2/implement");
    expect(text).toContain("walled — the provider's usage limit is spent for now");
    const c2 = makeCtx(home);
    expect(await main(["accounts", "--json"], c2)).toBe(0);
    expect((JSON.parse(c2.out.join("\n")) as { accounts: unknown[] }).accounts).toHaveLength(2);
    expect(await main(["accounts"], makeCtx(tempHome()))).toBe(2);
  });
  test("history renders the ticket's phases, failure, rounds and lease", async () => {
    expect(await main(["history", "ENG-2"], ctx)).toBe(0);
    const text = ctx.out.join("\n");
    expect(text).toContain("research: completed (attempt 1)");
    expect(text).toContain("implement: cooling (attempt 2), last failure vendor_5xx ×1");
    expect(text).toContain("Last failure: implement — vendor_5xx (upstream 503)");
    expect(text).toContain("Remediate rounds dispatched: 1 (cap 3)");
    expect(text).toContain("Live lease: implement held by runner-7");
    expect(await main(["history"], makeCtx(home))).toBe(1);
  });
  // ⛔ A route this tenant's cloud does not serve is SAID, never rendered as an empty success.
  test("a 404 from either new route says the cloud is older than the bundle, and exits non-zero", async () => {
    server.routesDeployed = false;
    try {
      expect(await main(["accounts"], ctx)).toBe(3);
      expect(ctx.err.join("\n")).toContain("needs a newer Catalyst Cloud");
      const c2 = makeCtx(home);
      expect(await main(["history", "ENG-2"], c2)).toBe(3);
      expect(c2.err.join("\n")).toContain("needs a newer Catalyst Cloud");
      // Never an empty-but-successful answer, which is what a placeholder or a swallowed 404 gives.
      expect(ctx.out.join("\n")).toBe("");
      expect(c2.out.join("\n")).toBe("");
    } finally {
      server.routesDeployed = true;
    }
  });
  test("me prints the identity", async () => {
    expect(await main(["me"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("Hagale Technologies");
    const c2 = makeCtx(home);
    expect(await main(["me", "--json"], c2)).toBe(0);
    expect(JSON.parse(c2.out.join("\n"))).toMatchObject({ account: "tenant-3" });
  });
});
