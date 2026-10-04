import { loadConfig, type Ctx } from "./config.js";
import type { ContractReadinessCheck, ContractTeam } from "./contract-types.js";
import { selectedOnboardTeam } from "./onboard-existing.js";
import { loadFreshTeamContract } from "./onboard-readiness-fresh.js";
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

/** How long setup waits for the cloud to read a repository's settings, and how often it looks. */
export const VALUES_WAIT_MS = 60_000;
const VALUES_POLL_MS = 10_000;

type Reading =
  | { kind: "pass" }
  | { kind: "fail"; check: ContractReadinessCheck }
  | { kind: "unread"; repositories: string[] }
  | { kind: "unverified" };

/** The repositories a team's verdict covers, by name, for the one waiting line. */
function teamRepositories(team: ContractTeam | undefined, check?: ContractReadinessCheck): string[] {
  const fromCheck = check ? valuesFacts(check).repos.map((row) => row.repo) : [];
  if (fromCheck.length) return fromCheck;
  const registered = (team as { repositories?: { registered?: unknown } } | undefined)?.repositories
    ?.registered;
  return Array.isArray(registered)
    ? registered.filter((name): name is string => typeof name === "string")
    : [];
}

function named(repositories: readonly string[]): string {
  if (!repositories.length) return "this team's repositories";
  if (repositories.length === 1) return repositories[0]!;
  return `${repositories[0]} and ${repositories.length - 1} more`;
}

/** The selected team's `required_values` readiness check decides this step. It passes when the
 * selected repositories declare no required value, or every one has a value. Nothing here reads,
 * imports or prints a value: a missing one is named, with the page where it is set.
 *
 * CTC-4744: the verdict is asked for fresh first (it lasts five minutes and only a readiness read
 * recomputes it). When the cloud has not read the settings yet, setup waits up to a minute on one
 * line, instead of telling the person to run setup again. */
export function onboardValuesAdapter(
  deps: {
    message?: (text: string) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): OnboardAdapter {
  return {
    check: async (ctx: Ctx, journal, signal) => {
      const cfg = loadConfig(ctx.home);
      const teamId = selectedOnboardTeam(journal);
      if (!cfg || !teamId) return waiting("required_values_unverified");
      const read = async (): Promise<Reading> => {
        let loaded: Awaited<ReturnType<typeof loadFreshTeamContract>>;
        try {
          loaded = await loadFreshTeamContract(ctx, cfg, [teamId], signal);
        } catch {
          return { kind: "unverified" };
        }
        if (loaded.source === "cache") return { kind: "unverified" };
        const team = loaded.doc.teams.find((row) => row.id === teamId);
        const readiness = team?.readiness;
        const fresh =
          readiness?.checkedAt != null &&
          readiness.expiresAt != null &&
          readiness.expiresAt > ctx.now().getTime();
        // A verdict the cloud could not bring up to date says nothing either way.
        if (!readiness || !fresh) return { kind: "unverified" };
        const check = readiness.checks.find((row) => row.id === "required_values");
        // An older cloud may not send this check at all: that says nothing, it is not an unread.
        if (!check) return { kind: "unverified" };
        if (check.state === "pass") return { kind: "pass" };
        if (check.state === "fail") return { kind: "fail", check };
        return { kind: "unread", repositories: teamRepositories(team, check) };
      };
      let reading = await read();
      if (reading.kind === "unread" && deps.sleep) {
        deps.message?.(
          `Waiting for Catalyst to read the settings of ${named(reading.repositories)} (up to 1 minute)…`,
        );
        for (
          let waited = 0;
          reading.kind === "unread" && waited < VALUES_WAIT_MS && !signal?.aborted;
          waited += VALUES_POLL_MS
        ) {
          await deps.sleep(VALUES_POLL_MS);
          if (signal?.aborted) break;
          reading = await read();
        }
      }
      if (signal?.aborted) return waiting("interrupted");
      if (reading.kind === "pass") return { state: "done", evidence: { team: teamId } };
      if (reading.kind === "fail")
        return waiting("required_values_missing", {
          team: teamId,
          requiredValues: JSON.stringify(valuesFacts(reading.check)),
        });
      if (reading.kind === "unread")
        return waiting("required_values_unread", {
          team: teamId,
          repositories: named(reading.repositories),
        });
      return waiting("required_values_unverified");
    },
  };
}
