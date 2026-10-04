import {
  setupPartHeading,
  setupStepView,
  SETUP_NUMBERS,
  SETUP_PART_NUMBERS,
  SETUP_PART_OF,
  type SetupPart,
} from "./setup-onboard-copy.js";
import type { OnboardJournal, OnboardStepId } from "./onboard.js";

export const COMPUTER_CHECKS = ["machine", "cli", "skills", "legacy"] as const;
/** The runner row when no runner was chosen up front, naming where that choice came from, so the
 *  plan says why no question comes (CTC-4739). */
const runnerDeclined = (by: string) => `this computer will not take work, because ${by}`;
const PLAN = [
  ["On this computer", "signin", "you approve once in your browser"],
  ["On this computer", "housekeeping", "schedule the daily update"],
  ["In Linear and GitHub", "linear.workspace", "an admin connects the workspace"],
  ["In Linear and GitHub", "linear.personal", "you connect your own Linear account"],
  ["In Linear and GitHub", "linear.team", "you choose the team"],
  ["In Linear and GitHub", "linear.adopt", "review any states and labels to add"],
  ["In Linear and GitHub", "linear.automations", "check how pull requests change issue states"],
  ["In Linear and GitHub", "github.install", "an admin chooses access on GitHub"],
  ["In Linear and GitHub", "github.personal", "you connect your own GitHub account"],
  ["In Linear and GitHub", "github.repos", "you choose where Catalyst can work"],
  ["Work", "accounts", "check an AI account"],
  ["Work", "capacity", "check which runners can take work"],
  ["Work", "settings", "you review settings before saving them"],
  ["Work", "values", "check every value the repositories need has one"],
  ["Work", "first-ticket", "you choose a ticket to start"],
] as const;
/**
 * The plan's rows. `parts` is what the terminal draws: part headings, numbers restarting in each
 * part. `json` is the plain-text plan an agent reads beside `--json` (dry run, --json on stderr,
 * headless): the older groups and the numbers JSON `actions[].number` reports (CTC-4680).
 */
export function standalonePlan(
  journal: OnboardJournal,
  scope?: readonly OnboardStepId[],
  /** `true` for --runner, `false` for --no-runner, absent when setup will ask (CTC-4739). */
  runner?: boolean,
  numbering: "parts" | "json" = "parts",
  /** Why `runner` is false: the flag on an interactive run, the headless input otherwise. */
  declinedBy = "--no-runner was passed",
) {
  const runnerSelected = runner === true;
  const RUNNER_DECLINED = runnerDeclined(declinedBy);
  const declined = runner === false;
  const json = numbering === "json";
  const includes = (id: OnboardStepId) => !scope || scope.includes(id);
  const steps = new Map(journal.steps.map((step) => [step.id, step]));
  const rows: Array<{
    /** The heading `json` numbering prints; a terminal draws its heading from `part`. */
    group: string;
    part: SetupPart;
    number: number;
    title: string;
    detail: string;
  }> = [];
  if (COMPUTER_CHECKS.some((id) => includes(id)))
    rows.push({
      group: json ? "On this computer" : setupPartHeading(1, false),
      part: 1,
      number: 1,
      title: "Check this computer",
      detail: includes("legacy")
        ? "check the command and skills; remove any earlier Catalyst install and keep its data folders"
        : "check the selected machine requirements",
    });
  for (const [group, id, detail] of PLAN) {
    // The terminal gives this computer's runner its own row after "Check runners". The plain-text
    // plan keeps it folded into that row, under the number JSON reports for both.
    if (!json && id === "capacity") {
      const row = (step: OnboardStepId, text: string) =>
        rows.push({
          group: setupPartHeading(3, false),
          part: 3,
          number: SETUP_PART_NUMBERS[step]!,
          title: setupStepView({ id: step, state: "pending" }).title,
          detail:
            steps.get(step)?.state === "done" ? `check again; ${text}` : text,
        });
      if (includes("capacity")) row("capacity", detail);
      if (includes("runner"))
        row(
          "runner",
          runnerSelected
            ? "start a Catalyst runner here with Docker"
            : declined
              ? RUNNER_DECLINED
              : "optional; this computer takes work only if you choose it",
        );
      continue;
    }
    // The terminal gives repository values their own row; the plain-text plan keeps them folded
    // into the settings row, under the number JSON reports for both.
    if (json && id === "values") continue;
    if (
      !includes(id) &&
      !(id === "capacity" && includes("runner")) &&
      !(json && id === "settings" && includes("values"))
    )
      continue;
    const reviewedDetail =
      id === "capacity" && includes("runner") && runnerSelected
        ? "start a Catalyst runner here with Docker"
        : id === "capacity" && includes("runner") && declined
          ? includes("capacity")
            ? `${detail}; ${RUNNER_DECLINED}`
            : RUNNER_DECLINED
          : id === "capacity" && !includes("capacity")
            ? "review the optional runner on this machine; start only if selected"
            : detail;
    rows.push({
      group: json ? group : setupPartHeading(SETUP_PART_OF[id], false),
      part: SETUP_PART_OF[id],
      number: (json ? SETUP_NUMBERS : SETUP_PART_NUMBERS)[id]!,
      title: setupStepView({ id, state: "pending" }).title,
      detail:
        steps.get(id)?.state === "done"
          ? `check again; ${reviewedDetail}`
          : reviewedDetail,
    });
  }
  return rows;
}
/** What setup does next on its own, in the order it runs: steps not finished and not already listed
 *  as something a person must do (`listed`). A step setup never reached because it paused is here. */
const CONTINUES: ReadonlyArray<readonly [readonly OnboardStepId[], string]> = [
  [["linear.workspace"], "connects your Linear workspace"],
  [["linear.personal"], "connects your Linear account"],
  [["linear.team"], "chooses a Linear team"],
  [["linear.adopt"], "sets up the team's workflow"],
  [["linear.automations"], "checks Linear's pull request automations"],
  [["github.install"], "installs Catalyst on GitHub"],
  [["github.personal"], "connects your GitHub account"],
  [["github.repos", "projects"], "chooses repositories"],
  [["accounts"], "checks an AI account"],
  [["capacity", "runner"], "checks runners"],
  [["settings"], "reviews repository settings"],
  [["values"], "checks repository values"],
  [["first-ticket"], "starts a first ticket"],
];
export function pendingContinuation(
  journal: OnboardJournal,
  listed: ReadonlySet<OnboardStepId> = new Set(),
): string | null {
  const unfinished = (ids: readonly OnboardStepId[]) =>
    !ids.some((id) => listed.has(id)) &&
    ids.some((id) => {
      const step = journal.steps.find((step) => step.id === id);
      return (
        step &&
        step.state !== "done" &&
        setupStepView(step, journal).mark !== "skip"
      );
    });
  const next = CONTINUES.filter(([ids]) => unfinished(ids)).map(
    ([, words]) => words,
  );
  if (!next.length) return null;
  const last = next.pop()!;
  return `Then setup ${next.length ? `${next.join(", ")} and ` : ""}${last}.`;
}

export function standalonePlanNotes(localSync: boolean): string {
  return `${localSync ? "Local sync is selected." : "Local sync stays off, so Catalyst reads from the cloud."} Setup reads your AI accounts without sending them a request. Completed steps are checked again before work starts. Your code, git settings and other skills stay as they are.`;
}
