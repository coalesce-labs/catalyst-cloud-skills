import type { OnboardAdapter } from "./onboard.js";

/** Rule management is unbuilt. This disposition does not assess the customer's actual rules.
 * Cloud readiness and first-ticket eligibility must still reject conflicting or unreadable rules.
 */
export function onboardAutomationManagementAdapter(
  input: { message?: (text: string) => void } = {},
): OnboardAdapter {
  return {
    check: async (_ctx, _journal, signal) => {
      if (signal?.aborted) return { state: "waiting", reason: "interrupted" };
      input.message?.(
        "Linear automation management is unavailable. Setup made no automation change. Cloud readiness still checks your existing rules.",
      );
      if (signal?.aborted) return { state: "waiting", reason: "interrupted" };
      return { state: "skipped", reason: "automation_management_unavailable" };
    },
  };
}
