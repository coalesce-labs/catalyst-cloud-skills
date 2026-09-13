// release.test.ts — `catalyst-skills release`: a person's release of a parked or held ticket (or one
// failure class on one team) through the contract's route, against the fixture cloud. The route path
// comes from the contract (the fixture serves it under an unusual prefix, so a hard-coded path fails
// here); a refusal exits 1 and prints every refusal's human action; nothing releases without a
// `--because` unless it is a dry run.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { FIXTURE_ROUTE_PREFIX, buildFixtureContract } from "./fixture-contract";
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
  server.writes.length = 0;
  server.budgetExhausted = false;
  server.contract = buildFixtureContract();
  server.release = undefined;
  server.releaseClass = undefined;
  await seedJoined(home, server);
});

const releaseWrites = (name: string) =>
  server.writes.filter((w) => w.path === `${FIXTURE_ROUTE_PREFIX}/${name}`);

describe("release <ticket>", () => {
  test("posts to the contract's ticket-release route with the ticket, the because and the flags, and prints what it released", async () => {
    server.release = {
      status: 200,
      body: {
        ticket: "ENG-2",
        outcome: "released",
        dryRun: false,
        released: [
          { governor: "phase_park", phase: "implement", op: "unpark" },
          { governor: "validate_hold", phase: null, op: "clear_validate_hold" },
        ],
        refused: [],
        warnings: [],
        auditId: 7,
      },
    };
    expect(await main(["release", "ENG-2", "--because", "rotated the deploy secret", "--retry-unchanged"], ctx)).toBe(0);
    const [w] = releaseWrites("ticket-release");
    expect(w?.body).toEqual({ ticket: "ENG-2", because: "rotated the deploy secret", retryUnchanged: true, dryRun: false });
    const text = ctx.out.join("\n");
    expect(text).toContain("ENG-2: released");
    expect(text).toContain("unparked implement");
    expect(text).toContain("cleared the validate hold");
  });

  test("a refusal exits 1, says nothing was released, and prints every refusal's human action", async () => {
    server.release = {
      status: 409,
      body: {
        ticket: "ENG-2",
        outcome: "refused",
        dryRun: false,
        released: [],
        releasable: [{ governor: "phase_park", phase: "implement", op: "unpark" }],
        refused: [
          { governor: "human_owned_pr", phase: "remediate", code: "human_owned_pr", humanAction: "PR #41 by ana is a person's; close or merge it" },
        ],
        warnings: [],
        auditId: 8,
      },
    };
    expect(await main(["release", "ENG-2", "--because", "retry"], ctx)).toBe(1);
    const text = ctx.out.join("\n");
    expect(text).toContain("ENG-2: refused — nothing was released");
    expect(text).toContain("human_owned_pr: PR #41 by ana is a person's; close or merge it");
  });

  test("a dry run needs no because, sends dryRun, and prints what would happen", async () => {
    server.release = {
      status: 200,
      body: {
        ticket: "ENG-2",
        outcome: "refused",
        dryRun: true,
        released: [],
        releasable: [{ governor: "phase_park", phase: "implement", op: "unpark" }],
        refused: [{ governor: "phase_park", phase: "implement", code: "cause_unchanged", humanAction: "nothing the mirror can see changed" }],
        warnings: [],
        auditId: null,
      },
    };
    expect(await main(["release", "ENG-2", "--dry-run"], ctx)).toBe(0);
    expect(releaseWrites("ticket-release")[0]?.body).toEqual({ ticket: "ENG-2", retryUnchanged: false, dryRun: true });
    const text = ctx.out.join("\n");
    expect(text).toContain("ENG-2 (dry run): would be refused");
    expect(text).toContain("cause_unchanged: nothing the mirror can see changed");
  });

  test("nothing held is exit 0 and points at explain", async () => {
    server.release = { status: 200, body: { ticket: "ENG-1", outcome: "nothing-held", dryRun: false, released: [], refused: [], warnings: [], auditId: null } };
    expect(await main(["release", "ENG-1", "--because", "x"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("ENG-1: nothing holds this ticket — run `catalyst-skills explain ENG-1` for why it is not running");
  });

  test("warnings are printed", async () => {
    server.release = {
      status: 200,
      body: { ticket: "ENG-2", outcome: "released", dryRun: false, released: [{ governor: "phase_park", phase: "remediate", op: "unpark" }], refused: [], warnings: ["remediate: runs again at the escalated tier"], auditId: 9 },
    };
    expect(await main(["release", "ENG-2", "--because", "x"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("warning: remediate: runs again at the escalated tier");
  });

  test("--json prints the cloud's body and keeps the exit code", async () => {
    const body = { ticket: "ENG-2", outcome: "refused", dryRun: false, released: [], refused: [{ governor: "live_lease", phase: "validate", code: "lease_held", humanAction: "wait" }], warnings: [], auditId: 1 };
    server.release = { status: 409, body };
    expect(await main(["release", "ENG-2", "--because", "x", "--json"], ctx)).toBe(1);
    expect(JSON.parse(ctx.out.join("\n"))).toEqual(body);
  });

  test("without --because and without --dry-run it is a usage error and nothing is sent", async () => {
    expect(await main(["release", "ENG-2"], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toMatch(/--because/);
    expect(releaseWrites("ticket-release")).toEqual([]);
  });

  test("a ticket that moved teams after the seat check says so", async () => {
    server.release = { status: 409, body: { error: "team_changed", ticket: "ENG-2", expectedTeamKey: "ENG", teamKey: "OPS" } };
    expect(await main(["release", "ENG-2", "--because", "x"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toContain("ENG-2 moved from team ENG to OPS while the release was being checked — run it again");
  });

  test("a contract with no ticket-release route says the cloud is older than this bundle", async () => {
    server.contract = buildFixtureContract();
    server.contract.routes = server.contract.routes.filter((r) => !r.path.includes("ticket-release"));
    const fresh = tempHome();
    const freshCtx = makeCtx(fresh);
    await seedJoined(fresh, server);
    expect(await main(["release", "ENG-2", "--because", "x"], freshCtx)).toBe(3);
    expect(freshCtx.err.join("\n")).toMatch(/needs a newer Catalyst Cloud/);
  });
});

describe("release --class <class> --team <key>", () => {
  test("posts the class release and prints the released and refused tickets", async () => {
    server.releaseClass = {
      status: 200,
      body: {
        team: "ENG",
        class: "phase-timeout",
        dryRun: false,
        limit: 25,
        truncated: true,
        released: [{ ticket: "ENG-2", outcome: "released", released: [{ governor: "phase_park", phase: "implement", op: "unpark" }], refused: [] }],
        refused: [{ ticket: "ENG-3", outcome: "refused", released: [], refused: [{ governor: "validate_hold", phase: null, code: "held_beyond_class", humanAction: "release it on its own" }] }],
        nothingHeld: ["ENG-4"],
      },
    };
    expect(await main(["release", "--class", "phase-timeout", "--team", "ENG", "--because", "outage over", "--retry-unchanged", "--limit", "10"], ctx)).toBe(0);
    expect(releaseWrites("ticket-release-class")[0]?.body).toEqual({ team: "ENG", class: "phase-timeout", because: "outage over", retryUnchanged: true, dryRun: false, limit: 10 });
    const text = ctx.out.join("\n");
    expect(text).toContain("ENG phase-timeout: released 1, refused 1, nothing held 1 (more remain — run it again)");
    expect(text).toContain("released ENG-2: unparked implement");
    expect(text).toContain("refused ENG-3 — held_beyond_class: release it on its own");
  });

  test("--class needs --team, and a ticket beside --class is a usage error", async () => {
    expect(await main(["release", "--class", "phase-timeout", "--because", "x"], ctx)).toBe(1);
    expect(await main(["release", "ENG-2", "--class", "phase-timeout", "--team", "ENG", "--because", "x"], ctx)).toBe(1);
    expect(releaseWrites("ticket-release-class")).toEqual([]);
  });
});
