// ready.test.ts — READY on a complete fixture; NOT READY names Node, config, contract, skills dir and
// SDK failures separately, each with its fix line; a contract readiness check that failed surfaces
// with who can answer; the replica is a note, never a failure.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { CUSTOMER_SKILLS, main } from "../src/cli";
import { contractPathFor, defaultSkillsDirFor } from "../src/config";
import { installSkills } from "../src/skills";
import { readyReport } from "../src/ready";
import { FIXTURE_ME_USER, startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, seedReplica, seedWriterState, tempHome, type TestCtx } from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  home = tempHome();
  ctx = makeCtx(home);
});

describe("ready", () => {
  test("READY on a complete fixture, with the replica as a note", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    expect(await main(["ready"], ctx)).toBe(0);
    const text = ctx.out.join("\n");
    expect(text.split("\n").at(-1)).toBe("READY");
    expect(text).toMatch(/^ok {3}node: /m);
    expect(text).toMatch(/^ok {3}config: joined Hagale Technologies/m);
    expect(text).toMatch(/^ok {3}contract: 1\.0\.0 cached/m);
    expect(text).toMatch(/^ok {3}cliPath: /m);
    expect(text).toMatch(/^ok {3}skills: all \d+ present/m);
    expect(text).toMatch(/^ok {3}sdk: loads/m);
    expect(text).toMatch(/^note {2}replica: absent/m);
    expect(text).toMatch(/^note {2}team ENG: webhook_covers_team is unknown \(no_delivery_observed\), degrading/m);
    expect(text).toMatch(/^note {2}team OPS: readiness not checked yet/m);
  });
  test("a fresh replica reads ok", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    await seedReplica(home, { cursor: 5, heartbeatAgeMs: 0 });
    expect(await main(["ready", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as { ready: boolean; checks: { id: string; ok: boolean }[] };
    expect(j.ready).toBe(true);
    expect(j.checks.find((c) => c.id === "replica")?.ok).toBe(true);
  });
  test("NOT READY names Node, config, contract, skills dir and sdk failures separately, each with its fix", async () => {
    const report = await readyReport(ctx, {
      nodeMajor: 20,
      skillNames: CUSTOMER_SKILLS,
      loadSdk: async () => {
        throw new Error("no registerHooks");
      },
    });
    expect(report.ready).toBe(false);
    const failed = report.checks.filter((c) => !c.ok && !c.note).map((c) => c.id);
    // "skills" is a note, not a failure: the customer's own agent installs them, so a copy
    // directory with none of ours in it is the normal plugin case.
    expect(failed).toEqual(["node", "config", "contract", "sdk"]);
    expect(report.checks.find((c) => c.id === "skills")).toMatchObject({ ok: true, note: true });
    for (const c of report.checks.filter((c) => !c.ok && !c.note)) {
      expect(c.fix, `${c.id} must name a fix`).toBeTruthy();
      expect(c.who, `${c.id} must name who`).toBeTruthy();
    }
    expect(report.checks.find((c) => c.id === "config")?.fix).toContain("npx @catalyst-cloud/catalyst-skills login");
    expect(report.checks.find((c) => c.id === "sdk")?.line).toContain("no registerHooks");
    expect(await main(["ready"], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toMatch(/NOT READY$/);
    expect(ctx.out.join("\n")).toMatch(/fix: npx @catalyst-cloud\/catalyst-skills login/);
  });
  test("a missing cliPath, an out-of-range contract, and a corrupt config each fail by name", async () => {
    await seedJoined(home, server, { config: { cliPath: `${home}/nope.js` } });
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as { contractVersion: string };
    writeFileSync(contractPathFor(home), JSON.stringify({ ...cache, contractVersion: "3.0.0" }));
    expect(await main(["ready"], ctx)).toBe(1);
    const text = ctx.out.join("\n");
    expect(text).toMatch(/^FAIL {2}cliPath: .*does not exist/m);
    expect(text).toMatch(/^FAIL {2}contract: version 3\.0\.0 is outside/m);
    // The out-of-range fix must pin @latest (`npm update -g` never crosses a caret below 1.0.0) AND
    // re-login so the new global bin rewrites customer.json.cliPath.
    expect(text).toContain("fix: npm install -g @catalyst-cloud/catalyst-skills@latest && catalyst-skills login");
    expect(text).not.toContain("npm update");
    writeFileSync(`${home}/.config/catalyst-cloud/customer.json`, "{corrupt");
    const c2 = makeCtx(home);
    expect(await main(["ready"], c2)).toBe(1);
    expect(c2.out.join("\n")).toMatch(/^FAIL {2}config: .*not valid JSON/m);
  });
  test("a contract readiness check that failed surfaces with who can answer; a blocked team fails", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as { doc: { teams: { readiness: { status: string; checks: { id: string; state: string; reason?: string }[] } }[] } };
    const eng = cache.doc.teams[0]!;
    eng.readiness.status = "blocked";
    eng.readiness.checks[0] = { id: "oauth_scope", state: "fail", reason: "missing_scope" };
    cache.doc.teams[1]!.readiness = { status: "blocked", checks: [] };
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    expect(await main(["ready"], ctx)).toBe(1);
    const text = ctx.out.join("\n");
    expect(text).toMatch(/^FAIL {2}team ENG: oauth_scope is fail \(missing_scope\), blocking/m);
    expect(text).toMatch(/who: owner u-fixture-owner, admin u-fixture-admin/);
    expect(text).toMatch(/^FAIL {2}team OPS: blocked/m);
  });
});

describe("more ready branches", () => {
  test("a degraded team with all checks passing is a note; an unknown check id needs an answer; no humans resolved", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as { doc: { humans: unknown[]; teams: { readiness: { status: string; checks: { id: string; state: string }[] } }[] } };
    cache.doc.humans = [];
    cache.doc.teams[0]!.readiness.status = "degraded";
    cache.doc.teams[0]!.readiness.checks = cache.doc.teams[0]!.readiness.checks.map((c) => ({ ...c, state: "pass" }));
    cache.doc.teams[1]!.readiness = { status: "ready", checks: [{ id: "mystery_check", state: "fail" }] };
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    expect(await main(["ready"], ctx)).toBe(1);
    const text = ctx.out.join("\n");
    expect(text).toMatch(/^note {2}team ENG: degraded/m);
    expect(text).toMatch(/^FAIL {2}team OPS: mystery_check is fail$/m);
    expect(text).toMatch(/who: a tenant owner or admin \(none resolved on the contract\)/);
  });
  test("config names the connected person when the /me user block is present", async () => {
    await seedJoined(home, server, { config: { user: FIXTURE_ME_USER } });
    installSkills(defaultSkillsDirFor(home), {});
    expect(await main(["ready"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toMatch(/^ok {3}config: joined Hagale Technologies as Tony \(admin\)$/m);
  });
  test("config falls back to the account line when there is no user block", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    expect(await main(["ready"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toMatch(/^ok {3}config: joined Hagale Technologies \(hagale-technologies\) as service$/m);
  });
  test("warns (never refuses) when the installed bundle is older than the contract's minimum", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as { doc: { skillsBundle?: unknown } };
    cache.doc.skillsBundle = { package: "@catalyst-cloud/catalyst-skills", minVersion: "9.9.9" };
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    expect(await main(["ready", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as { ready: boolean; checks: { id: string; note?: boolean; line: string }[] };
    expect(j.ready).toBe(true);
    const note = j.checks.find((c) => c.id === "bundle");
    expect(note).toMatchObject({ note: true });
    expect(note!.line).toContain("9.9.9");
    expect(note!.line).toContain("npm install -g @catalyst-cloud/catalyst-skills@latest && catalyst-skills login");
    expect(note!.line).not.toContain("npm update");
  });
  test("no bundle note when the installed bundle meets the contract's minimum", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as { doc: { skillsBundle?: unknown } };
    cache.doc.skillsBundle = { package: "@catalyst-cloud/catalyst-skills", minVersion: "0.0.1" };
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    expect(await main(["ready", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as { checks: { id: string }[] };
    expect(j.checks.find((c) => c.id === "bundle")).toBeUndefined();
  });
  test("no bundle note and no crash when the contract omits skillsBundle (older cloud)", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    expect(await main(["ready", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as { ready: boolean; checks: { id: string }[] };
    expect(j.ready).toBe(true);
    expect(j.checks.find((c) => c.id === "bundle")).toBeUndefined();
  });
  test("a failed check the contract marks needsAnswer: false stays informational (a note with the count), and the verdict stays READY", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as { doc: { teams: { readiness: { checks: { id: string; state: string; reason?: string; count?: number }[] } }[] } };
    cache.doc.teams[0]!.readiness.checks[6] = { id: "labels_present", state: "fail", reason: "labels_missing", count: 2 };
    writeFileSync(contractPathFor(home), JSON.stringify(cache));
    expect(await main(["ready", "--json"], ctx)).toBe(0);
    const j = JSON.parse(ctx.out.join("\n")) as { ready: boolean; checks: { id: string; ok: boolean; note?: boolean; line: string; who?: string }[] };
    const c = j.checks.find((x) => x.id === "team:ENG:labels_present")!;
    expect(c).toMatchObject({ ok: false, note: true, who: "nobody yet; it is informational" });
    expect(c.line).toBe("team ENG: labels_present is fail (labels_missing ×2), degrading");
    expect(j.ready).toBe(true);
  });
});

describe("ready never recommends starting the replica (CTC-2499)", () => {
  test("not-configured, absent, stale and fresh replica states never mention replica start", async () => {
    const bare = makeCtx(tempHome());
    await main(["ready"], bare);
    expect(bare.out.join("\n")).not.toContain("replica start");

    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    const c1 = makeCtx(home);
    await main(["ready"], c1);
    expect(c1.out.join("\n")).not.toContain("replica start");

    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 60_000 });
    const c2 = makeCtx(home);
    await main(["ready"], c2);
    expect(c2.out.join("\n")).not.toContain("replica start");
  });
  test("a fresh replica also never mentions replica start", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    await seedReplica(home, { cursor: 5, heartbeatAgeMs: 0 });
    await main(["ready"], ctx);
    expect(ctx.out.join("\n")).not.toContain("replica start");
  });
  test("the absent note says the replica is optional and off by default for large tenants, with no ticket key", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    await main(["ready"], ctx);
    const text = ctx.out.join("\n");
    expect(text).toMatch(/^note {2}replica: absent/m); // the existing pin, unchanged
    expect(text).toContain("optional");
    expect(text).toContain("off by default for large tenants");
    expect(text).not.toMatch(/\bC[TL]C-\d+\b/);
  });
  test("ready --json exposes the writer's stopped state and failure count", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0 });
    seedWriterState(home, {
      consecutiveFailures: 5,
      lastError: "/snapshot 503",
      stopped: { at: 1_700_000_000_000, reason: "5 consecutive snapshot failures", restartWith: "catalyst-skills replica start --detach" },
    });
    expect(await main(["ready", "--json"], ctx)).toBe(0); // still a note, never a failure
    const j = JSON.parse(ctx.out.join("\n")) as {
      replica: { writer: { consecutiveFailures: number; lastError: string; stopped: { reason: string } } };
      checks: { id: string; note?: boolean }[];
    };
    expect(j.replica.writer.stopped.reason).toContain("5 consecutive snapshot failures");
    expect(j.replica.writer.consecutiveFailures).toBe(5);
    expect(j.replica.writer.lastError).toBe("/snapshot 503");
    expect(j.checks.find((c) => c.id === "replica")).toMatchObject({ note: true });
  });
  test("a writer whose process is gone is described in the past tense, not as backing off (CTC-2499)", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0 });
    // The sidecar outlives the process that wrote it: a SIGKILL mid-backoff leaves exactly this.
    seedWriterState(home, { pid: 2_147_483_632, consecutiveFailures: 2, lastError: "/snapshot 503" });
    expect(await main(["ready"], ctx)).toBe(0); // still a note, never a failure
    const text = ctx.out.join("\n");
    expect(text).toContain("is no longer running");
    expect(text).not.toContain("is backing off");
  });

  test("the stopped case — and only the stopped case — names the restart command", async () => {
    await seedJoined(home, server);
    installSkills(defaultSkillsDirFor(home), {});
    await seedReplica(home, { cursor: 41, heartbeatAgeMs: 0 });
    seedWriterState(home, {
      consecutiveFailures: 5,
      lastError: "/snapshot 503",
      stopped: { at: 1_700_000_000_000, reason: "5 consecutive snapshot failures", restartWith: "catalyst-skills replica start --detach" },
    });
    await main(["ready"], ctx);
    const text = ctx.out.join("\n");
    expect(text).toContain("5 consecutive snapshot failures");
    expect(text).toContain("/snapshot 503");
    expect(text).toContain("catalyst-skills replica start --detach");
    expect(text.split("\n").filter((l) => l.startsWith("note  replica:"))).toHaveLength(1);
  });
});
