import { expect, test } from "vitest";
import { parseArgs } from "../src/args.js";
import { defaultCtx } from "../src/config.js";
import { cmdReady } from "../src/ready.js";
import type { OnboardingObservation } from "../src/onboard-ready.js";

function fixture() {
  const output: string[] = [];
  const ctx = { ...defaultCtx(), env: {} as NodeJS.ProcessEnv, stdout: (line: string) => output.push(line), stderr: (_line: string) => {},
    fetch: (async () => { throw new Error("injected readiness must not use the network"); }) as typeof fetch };
  return { ctx, output };
}
const setup = { id: "cloud.setup", state: "pass" as const, required: true };
const observed = { state: "observed" as const, ticket: "ENG-1", phaseStartedAt: "2026-09-30T14:00:00Z" };

test.each([
  ["complete", { checks: [setup], work: observed }, 0],
  ["incomplete", { checks: [{ ...setup, state: "fail", reason: "grant_revoked" }], work: observed }, 10],
  ["unknown", { checks: [{ ...setup, state: "unknown", reason: "not_checked" }], work: { state: "unknown" } }, 11],
] satisfies Array<[string, OnboardingObservation, number]>)("JSON onboarding readiness %s prints one report and the correct exit", async (state, observation, expected) => {
  const f = fixture();
  const code = await cmdReady(parseArgs(["ready", "--onboarding", "--json", "--offline"]), f.ctx, { skillNames: [], onboarding: { observe: async () => observation } });
  expect(code).toBe(expected);
  expect(f.output).toHaveLength(1);
  expect(JSON.parse(f.output[0]!)).toMatchObject({ schema: 1, state, readMode: "cloud", work: observation.work });
});

test("human unknown setup names missing evidence while preserving separately observed work", async () => {
  const f = fixture();
  expect(await cmdReady(parseArgs(["ready", "--onboarding"]), f.ctx, { skillNames: [], onboarding: { observe: async () => ({ checks: [{ ...setup, state: "unknown", reason: "not_checked" }], work: observed }) } })).toBe(11);
  const text = f.output.join("\n");
  expect(text).toContain("waiting for evidence");
  expect(text).toContain("Work observed on ENG-1.");
  expect(text).toContain("Resume: catalyst onboard");
  expect(text).not.toMatch(/FAIL|NOT READY|Onboarding complete/);
});

test("human explicit setup failure needs attention without erasing observed work", async () => {
  const f = fixture();
  expect(await cmdReady(parseArgs(["ready", "--onboarding"]), f.ctx, { skillNames: [], onboarding: { observe: async () => ({ checks: [{ ...setup, state: "fail", reason: "grant_revoked" }], work: observed }) } })).toBe(10);
  expect(f.output.join("\n")).toContain("needs attention  cloud.setup: grant_revoked");
  expect(f.output.join("\n")).toContain("Work observed on ENG-1.");
});

test("human complete reports the passing check and verified completion", async () => {
  const f = fixture();
  expect(await cmdReady(parseArgs(["ready", "--onboarding"]), f.ctx, { skillNames: [], onboarding: { observe: async () => ({ checks: [setup], work: observed }) } })).toBe(0);
  expect(f.output.join("\n")).toContain("ok  cloud.setup");
  expect(f.output.join("\n")).toContain("Onboarding complete.");
});

test.each(["unknown", "not_observed"] as const)("unverified %s work never prints an observed-work claim", async state => {
  const f = fixture();
  expect(await cmdReady(parseArgs(["ready", "--onboarding"]), f.ctx, { skillNames: [], onboarding: { observe: async () => ({ checks: [setup], work: { state } }) } })).toBe(11);
  const text = f.output.join("\n");
  expect(text).toContain("Fresh project work has not been verified");
  expect(text).not.toContain("Work observed");
  expect(text).not.toContain("Onboarding complete");
});

test("ordinary cloud mode permits optional failed local sync", async () => {
  const f = fixture();
  expect(await cmdReady(parseArgs(["ready", "--onboarding", "--json"]), f.ctx, { skillNames: [], onboarding: { observe: async () => ({ checks: [setup, { id: "local.replica", state: "fail", required: false }], work: observed }) } })).toBe(0);
  expect(JSON.parse(f.output[0]!)).toMatchObject({ readMode: "cloud", state: "complete" });
});

test("selected local sync requires its own evidence before completion", async () => {
  const f = fixture();
  expect(await cmdReady(parseArgs(["ready", "--onboarding", "--local-sync", "--json"]), f.ctx, { skillNames: [], onboarding: { localSync: true, observe: async () => ({ checks: [setup], work: observed }) } })).toBe(11);
  const report = JSON.parse(f.output[0]!);
  expect(report).toMatchObject({ readMode: "local", state: "unknown" });
  expect(report.checks).toContainEqual(expect.objectContaining({ id: "local.sync", state: "unknown", required: true }));
});

test("observed work without a ticket identifier remains a qualified work observation", async () => {
  const f = fixture();
  expect(await cmdReady(parseArgs(["ready", "--onboarding"]), f.ctx, { skillNames: [], onboarding: { observe: async () => ({ checks: [{ ...setup, state: "unknown" }], work: { state: "observed" } }) } })).toBe(11);
  expect(f.output).toContain("Work observed.");
  expect(f.output.join("\n")).not.toContain("undefined");
  expect(f.output.join("\n")).not.toContain("Onboarding complete");
});
