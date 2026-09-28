// render-account.test.ts — CTC-4199: the plain-text `catalyst accounts` line says what --json says.
import { describe, expect, test } from "vitest";
import { accountDisplayName, renderAccount } from "../src/execution";

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

  test("an account leads with its label, else its email, with the slot id second", () => {
    expect(renderAccount({ accountSlot: "claude-1", label: "Ryan main", email: "r@x.com", provider: "claude", status: "active" })).toMatch(/^Ryan main \(claude-1\) /);
    expect(renderAccount({ accountSlot: "claude-2", label: null, email: "ops@x.com", provider: "claude", status: "active" })).toMatch(/^ops@x\.com \(claude-2\) /);
    expect(renderAccount({ accountSlot: "claude-3", label: null, provider: "claude", status: "active" })).toMatch(/^claude-3 {2}claude/);
    expect(accountDisplayName({ accountSlot: "claude-4", label: "  ", email: "" })).toBe("claude-4");
  });
});
