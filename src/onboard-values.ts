import { loadConfig, type Ctx } from "./config.js";
import { loadContract } from "./contract.js";
import { selectedOnboardTeam } from "./onboard-existing.js";
import type { OnboardAdapter, OnboardStepResult } from "./onboard.js";
import { valuesFacts } from "./ready-copy.js";

const waiting = (
  reason: string,
  evidence?: OnboardStepResult["evidence"],
): OnboardStepResult => ({
  state: "waiting",
  reason,
  ...(evidence ? { evidence } : {}),
});
/** The selected team's `required_values` readiness check decides this step. It passes when the
 * selected repositories declare no required value, or every one has a value. Nothing here reads,
 * imports or prints a value: a missing one is named, with the page where it is set. A stale, absent
 * or unknown check waits, so the step never claims values it could not see. */
export function onboardValuesAdapter(): OnboardAdapter {
  return {
    check: async (ctx: Ctx, journal, signal) => {
      const cfg = loadConfig(ctx.home);
      const teamId = selectedOnboardTeam(journal);
      if (!cfg || !teamId) return waiting("required_values_unverified");
      let loaded: Awaited<ReturnType<typeof loadContract>>;
      try {
        loaded = await loadContract(ctx, cfg, { refresh: true, signal });
      } catch {
        return waiting(signal?.aborted ? "interrupted" : "required_values_unverified");
      }
      if (loaded.source === "cache") return waiting("required_values_unverified");
      const readiness = loaded.doc.teams.find((team) => team.id === teamId)?.readiness;
      const fresh =
        readiness?.checkedAt != null &&
        readiness.expiresAt != null &&
        readiness.expiresAt > ctx.now().getTime();
      const check = fresh
        ? readiness.checks.find((row) => row.id === "required_values")
        : undefined;
      if (check?.state === "pass") return { state: "done", evidence: { team: teamId } };
      if (check?.state !== "fail") return waiting("required_values_unverified");
      return waiting("required_values_missing", {
        team: teamId,
        requiredValues: JSON.stringify(valuesFacts(check)),
      });
    },
  };
}
