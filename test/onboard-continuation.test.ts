import { expect, test } from "vitest";
import { pendingContinuation } from "../src/onboard-standalone-copy.js";
import { ONBOARD_STEPS, type OnboardJournal } from "../src/onboard.js";

test("continuation excludes optional waits but keeps required pending work", () => {
  const journal: OnboardJournal = {
    schema: 1,
    runId: "test",
    installer: null,
    cli: "0.15.0",
    tenant: null,
    exit: 11,
    complete: false,
    changes: [],
    steps: ONBOARD_STEPS.map((id) => ({ id, state: "done" })),
  };
  Object.assign(
    journal.steps.find((s) => s.id === "settings")!,
    { state: "waiting", reason: "settings_checkout_unverified" },
  );
  Object.assign(
    journal.steps.find((s) => s.id === "values")!,
    { state: "waiting", reason: "settings_approval_unverified" },
  );
  expect(pendingContinuation(journal)).toBeNull();
  Object.assign(
    journal.steps.find((s) => s.id === "first-ticket")!,
    { state: "pending", reason: "prerequisite_not_ready" },
  );
  expect(pendingContinuation(journal)).toBe(
    "Then setup starts a first ticket.",
  );
});
