import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { onboardReasonText } from "../src/onboard-next.js";
import { readOnboardJournal, type OnboardStep } from "../src/onboard.js";
import { setupBrowserInstruction } from "../src/setup-onboard-copy.js";

const base = "https://staging.catalystcloud.dev";
const SUBSCRIPTION_WORDS = /subscription|setup-token|monthly plan|paid access|Pro or Max/i;
const ACCOUNT_REASONS = [
  "account_enrollment_required",
  "ai_account_not_usable",
  "coding_account_not_found",
  "coding_account_inactive",
  "coding_account_ended",
  "coding_account_needs_login",
  "coding_account_quarantined",
  "coding_account_walled",
  "account_inventory_unavailable",
  "account_inventory_unverified",
];
const step = (reason: string, kinds?: string): OnboardStep => ({
  id: "accounts",
  state: "waiting",
  reason,
  ...(kinds ? { evidence: { aiAccountKinds: kinds } } : {}),
});
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("a workspace without subscription AI accounts only hears about API keys", () => {
  test.each([undefined, "api-key"])("kinds %s: no account text mentions a subscription", (kinds) => {
    for (const reason of ACCOUNT_REASONS)
      expect(onboardReasonText(step(reason, kinds), { baseUrl: base }), reason).not.toMatch(
        SUBSCRIPTION_WORDS,
      );
  });
  test("adding an AI account names an API key and the AI accounts page", () => {
    const text = onboardReasonText(step("account_enrollment_required"), { baseUrl: base });
    expect(text).toContain("API key");
    expect(text).toContain(`${base}/settings/coding-accounts`);
  });
  test("the setup screen's AI account wait asks for an API key, with no terminal step", () => {
    const wait = setupBrowserInstruction("accounts", base)!;
    expect(wait.instruction).toContain("API key");
    // The wait is its instruction and the page, nothing to run in another terminal.
    expect(wait).toEqual({ instruction: "Open this link and add an API key:", url: `${base}/settings/coding-accounts` });
    expect(wait.instruction).not.toMatch(SUBSCRIPTION_WORDS);
  });
});

test("a workspace enabled for subscriptions is told it can connect one or add an API key", () => {
  const text = onboardReasonText(step("account_enrollment_required", "subscription,api-key"), {
    baseUrl: base,
  });
  expect(text).toContain("subscription");
  expect(text).toContain("API key");
  expect(text).not.toContain("setup-token");
});

test("the record keeps which AI accounts the workspace may add", () => {
  const home = mkdtempSync(join(tmpdir(), "ai-kinds-"));
  homes.push(home);
  const path = join(home, "last-run.json");
  writeFileSync(path, JSON.stringify({ schema: 1, steps: [step("account_enrollment_required", "api-key")] }));
  expect(readOnboardJournal(path)?.steps[0]?.evidence).toEqual({ aiAccountKinds: "api-key" });
});
