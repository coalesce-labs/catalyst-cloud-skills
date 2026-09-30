import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { defaultCtx, writeConfig } from "../src/config.js";
import { observeCloudOnboarding } from "../src/onboard-ready.js";
import { buildFixtureContract } from "./fixture-contract.js";

const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "onboard-selection-")); homes.push(home);
  const doc = buildFixtureContract();
  const now = Date.now();
  for (const team of doc.teams) { team.readiness.checkedAt = now - 1000; team.readiness.expiresAt = now + 60000; team.readiness.checks = [{ id: "token_live", state: "fail", reason: "grant_revoked" }]; }
  writeConfig(home, { baseUrl: "https://staging.catalystcloud.dev", key: "ctc_user_fixture", account: doc.account.id, slug: doc.account.slug, name: doc.account.name, principal: "session", permissions: null, user: { id: "person-a", label: "Test Person", email: null, role: "owner", linearUserId: null }, joinedAt: new Date(now).toISOString(), lastSkillBundleVersion: "0.14.0" });
  const ctx = { ...defaultCtx(), home, env: {} as NodeJS.ProcessEnv, now: () => new Date(now), fetch: (async () => Response.json(doc)) as typeof fetch };
  return { ctx, doc };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

test("missing verified selection does not make every workspace team's failures onboarding blockers", async () => {
  const f = fixture();
  const result = await observeCloudOnboarding(f.ctx);
  expect(result.checks).toEqual([{ id: "projects", state: "unknown", required: true, reason: "project_selection_unverified" }]);
});

test("selected team readiness excludes unrelated workspace failures and labels team evidence accurately", async () => {
  const f = fixture();
  const selected = f.doc.teams[0]!;
  selected.readiness.checks = [{ id: "token_live", state: "pass" }];
  const result = await observeCloudOnboarding(f.ctx, { teamIds: [selected.id] });
  expect(result.checks).toHaveLength(1);
  expect(result.checks[0]).toMatchObject({ state: "pass", evidence: { team: selected.id } });
  expect(result.checks[0]!.evidence).not.toHaveProperty("project");
  expect(JSON.stringify(result.checks)).not.toContain(f.doc.teams[1]!.id);
});

test("a selected team absent from the current cloud cannot be silently dropped", async () => {
  const f = fixture();
  const result = await observeCloudOnboarding(f.ctx, { teamIds: ["missing-team"] });
  expect(result.checks).toContainEqual(expect.objectContaining({ state: "unknown", required: true, reason: "team_selection_unverified", evidence: { team: "missing-team" } }));
});
