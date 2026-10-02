import { selectedOnboardTeam } from "./onboard-existing.js";
import type { OnboardAdapter } from "./onboard.js";

/** Setup cannot change Linear's pull request automations. It reports what cloud readiness saw for
 * the selected team, as the workflow step recorded it, and never reads the network itself. Only a
 * fresh record for the same team proves "nothing to change"; anything else stays the plain skip,
 * which keeps counting as satisfied because readiness and first-ticket eligibility check again. */
export function onboardAutomationManagementAdapter(): OnboardAdapter {
  return {
    check: async (ctx, journal, signal) => {
      if (signal?.aborted) return { state: "waiting", reason: "interrupted" };
      const skip = {
        state: "skipped" as const,
        reason: "automation_management_unavailable",
      };
      const adopt = journal.steps.find((step) => step.id === "linear.adopt");
      const team = selectedOnboardTeam(journal);
      const evidence = adopt?.state === "done" ? adopt.evidence : undefined;
      const checkedAt = evidence?.checkedAt;
      const automations = evidence?.automations;
      if (
        !team ||
        evidence?.team !== team ||
        typeof checkedAt !== "number" ||
        ctx.now().getTime() - checkedAt >= 300_000 ||
        ctx.now().getTime() < checkedAt ||
        typeof automations !== "string" ||
        !/^(?:none|(?:open|review|ready|merge)(?:,(?:open|review|ready|merge))*)$/.test(
          automations,
        )
      )
        return skip;
      return automations === "none"
        ? { state: "done", reason: "automations_compatible" }
        : { ...skip, evidence: { automations } };
    },
  };
}
