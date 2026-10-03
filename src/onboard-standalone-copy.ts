import { setupStepView, SETUP_NUMBERS } from "./setup-onboard-copy.js";
import type { OnboardJournal, OnboardStepId } from "./onboard.js";

export const COMPUTER_CHECKS = ["machine", "cli", "skills", "legacy"] as const;
const PLAN = [
  ["On this computer", "signin", "you approve once in your browser"],
  [
    "On this computer",
    "housekeeping",
    "schedule the daily update, where supported",
  ],
  [
    "In Linear and GitHub",
    "linear.workspace",
    "an admin connects the workspace",
  ],
  [
    "In Linear and GitHub",
    "linear.personal",
    "you connect your own Linear account",
  ],
  ["In Linear and GitHub", "linear.team", "you choose the team"],
  [
    "In Linear and GitHub",
    "linear.adopt",
    "review any states and labels to add",
  ],
  [
    "In Linear and GitHub",
    "linear.automations",
    "check how pull requests change issue states",
  ],
  [
    "In Linear and GitHub",
    "github.install",
    "an admin chooses access on GitHub",
  ],
  [
    "In Linear and GitHub",
    "github.personal",
    "you connect your own GitHub account",
  ],
  [
    "In Linear and GitHub",
    "github.repos",
    "you choose where Catalyst can work",
  ],
  ["Work", "accounts", "check a coding account"],
  ["Work", "capacity", "check which runners can take work"],
  ["Work", "settings", "you review settings before saving them"],
  ["Work", "first-ticket", "you choose a ticket to start"],
] as const;
export function standalonePlan(
  journal: OnboardJournal,
  scope?: readonly OnboardStepId[],
  runnerSelected = false,
) {
  const includes = (id: OnboardStepId) => !scope || scope.includes(id);
  const steps = new Map(journal.steps.map((step) => [step.id, step]));
  const rows: Array<{
    group: string;
    number: number;
    title: string;
    detail: string;
  }> = [];
  if (COMPUTER_CHECKS.some((id) => includes(id)))
    rows.push({
      group: "On this computer",
      number: 1,
      title: "Check this computer",
      detail: includes("legacy")
        ? "check the command and skills; remove any earlier Catalyst install and keep its data folders"
        : "check the selected machine requirements",
    });
  for (const [group, id, detail] of PLAN) {
    if (
      !includes(id) &&
      !(id === "capacity" && includes("runner")) &&
      !(id === "settings" && includes("values"))
    )
      continue;
    const reviewedDetail =
      id === "capacity" && includes("runner") && runnerSelected
        ? "start a Catalyst runner here with Docker"
        : id === "capacity" && !includes("capacity")
          ? "review the optional runner on this machine; start only if selected"
          : detail;
    rows.push({
      group,
      number: SETUP_NUMBERS[id]!,
      title: setupStepView({ id, state: "pending" }).title,
      detail:
        steps.get(id)?.state === "done"
          ? `check again; ${reviewedDetail}`
          : reviewedDetail,
    });
  }
  return rows;
}
export function pendingContinuation(journal: OnboardJournal): string | null {
  const unfinished = (...ids: OnboardStepId[]) =>
    ids.some((id) => {
      const step = journal.steps.find((step) => step.id === id);
      return (
        step &&
        step.state !== "done" &&
        setupStepView(step, journal).mark !== "skip"
      );
    });
  const next: string[] = [];
  if (unfinished("github.repos", "projects")) next.push("chooses repositories");
  if (unfinished("accounts")) next.push("checks a coding account");
  if (unfinished("capacity", "runner")) next.push("checks runners");
  if (unfinished("settings", "values"))
    next.push("reviews repository settings");
  if (unfinished("first-ticket")) next.push("starts a first ticket");
  if (!next.length) return null;
  const last = next.pop()!;
  return `Then setup ${next.length ? `${next.join(", ")} and ` : ""}${last}.`;
}

export function standalonePlanNotes(localSync: boolean): string {
  return `${localSync ? "Local sync is selected." : "Local sync stays off, so Catalyst reads from the cloud."} Checking a coding account sends Claude one short request, which counts toward its usage. Completed steps are checked again before work starts. Codex credentials are not refreshed. Your code, git settings and other skills stay as they are.`;
}
