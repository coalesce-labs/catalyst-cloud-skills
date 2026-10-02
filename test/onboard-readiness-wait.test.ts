import { describe, expect, test } from "vitest";
import { onboardRequiredStepsWaiting } from "../src/onboard.js";
import type { OnboardJournal } from "../src/onboard.js";

const steps = (rows: Array<[string, string, string?]>) =>
  ({
    steps: rows.map(([id, state, reason]) => ({ id, state, reason, at: "2026-10-02T04:00:00Z" })),
  }) as unknown as Pick<OnboardJournal, "steps">;

describe("readiness while earlier setup steps wait", () => {
  test("a waiting coding-account step means readiness waits rather than fails", () => {
    expect(
      onboardRequiredStepsWaiting(
        steps([["signin", "done"], ["accounts", "waiting", "account_enrollment_required"], ["ready", "failed"]]),
      ),
    ).toBe(true);
  });
  test("deferred steps and satisfied skips do not hold readiness back", () => {
    expect(
      onboardRequiredStepsWaiting(
        steps([
          ["signin", "done"],
          ["settings", "waiting", "settings_checkout_unverified"],
          ["housekeeping", "waiting", "housekeeping_service_unverified"],
          ["linear.automations", "skipped", "automation_management_unavailable"],
          ["daemon", "skipped", "local_sync_not_selected"],
          ["ready", "waiting"],
        ]),
      ),
    ).toBe(false);
  });
  test("a failed required step is its own failure, not a reason for readiness to wait", () => {
    expect(onboardRequiredStepsWaiting(steps([["projects", "failed"], ["ready", "failed"]]))).toBe(false);
  });
});
