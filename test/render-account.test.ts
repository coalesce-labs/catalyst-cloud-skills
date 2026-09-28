// render-account.test.ts — CTC-4199: the plain-text `catalyst accounts` line says what --json says.
import { describe, expect, test } from "vitest";
import { renderAccount } from "../src/execution";

describe("renderAccount", () => {
  test("a cancelled subscription says to retire the account, beside its status and quarantine", () => {
    const line = renderAccount({ accountSlot: "claude-465ad266", provider: "claude", status: "ended", renewalStatus: "canceled", quarantined: true, quarantineReason: "auth failures" });
    expect(line).toContain("subscription canceled — retire on the AI accounts page");
    expect(line).toContain("quarantined: auth failures");
  });

  test("an account with an active renewal carries no retire line (the positive control)", () => {
    const line = renderAccount({ accountSlot: "claude-c054a693", provider: "claude", status: "active", renewalStatus: "active", quarantined: false });
    expect(line).not.toContain("retire");
  });
});
