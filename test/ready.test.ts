// ready.test.ts — READY on a complete fixture; NOT READY names Node, config, contract, skills dir and
// SDK failures separately, each with its fix line; a contract readiness check that failed surfaces
// with who can answer; the replica is a note, never a failure.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { CUSTOMER_SKILLS, main } from "../src/cli";
import { contractPathFor, defaultSkillsDirFor } from "../src/config";
import { installSkills } from "../src/skills";
import { readyReport } from "../src/ready";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, seedReplica, tempHome, type TestCtx } from "./helpers";

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
    expect(ctx.out.join("\n")).toMatch(/fix: CATALYST_CLOUD_TOKEN=<your personal key> npx/);
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
