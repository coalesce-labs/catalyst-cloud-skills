import {
  ONBOARD_DEPENDENCIES,
  ONBOARD_STEPS,
  ONBOARD_TITLES,
  type OnboardJournal,
  type OnboardStep,
  type OnboardStepId,
} from "./onboard.js";
import { onboardReasonText } from "./onboard-next.js";
import type { StepMark, TrackerRow } from "./setup-render.js";
/** The step numbers `--json` reports. People read SETUP_PART_NUMBERS instead (CTC-4680). */
export const SETUP_NUMBERS: Partial<Record<OnboardStepId, number>> = {
  machine: 1,
  cli: 1,
  skills: 1,
  legacy: 1,
  signin: 4,
  housekeeping: 5,
  "linear.workspace": 6,
  "linear.personal": 7,
  "linear.team": 8,
  "linear.adopt": 9,
  "linear.automations": 10,
  "github.install": 11,
  "github.personal": 12,
  "github.repos": 13,
  projects: 13,
  accounts: 14,
  capacity: 15,
  runner: 15,
  settings: 16,
  values: 16,
  "first-ticket": 17,
};
export type SetupPart = 1 | 2 | 3;
/** CTC-4680: setup runs in three parts. The times are estimates until setup logs give medians. */
export const SETUP_PARTS: Record<
  SetupPart,
  { title: string; estimate: string; summary: string; done: string }
> = {
  1: {
    title: "This computer",
    estimate: "about 2 min",
    summary: "skills and sign-in",
    done: "This computer is set up.",
  },
  2: {
    title: "Linear and GitHub",
    estimate: "about 10 min",
    summary: "approvals in your browser",
    done: "Linear and GitHub are connected.",
  },
  3: {
    title: "Ready for work",
    estimate: "about 5 min",
    summary: "a first ticket",
    done: "Catalyst is ready for work.",
  },
};
export const SETUP_PART_OF: Record<OnboardStepId, SetupPart> = {
  machine: 1,
  cli: 1,
  skills: 1,
  legacy: 1,
  signin: 1,
  daemon: 1,
  housekeeping: 1,
  "linear.workspace": 2,
  "linear.personal": 2,
  "linear.team": 2,
  "linear.adopt": 2,
  "linear.automations": 2,
  "github.install": 2,
  "github.personal": 2,
  "github.repos": 3,
  projects: 3,
  accounts: 3,
  capacity: 3,
  runner: 3,
  settings: 3,
  values: 3,
  "first-ticket": 3,
  ready: 3,
};
/** What a person reads: each part restarts at 1, in the order setup runs the steps. Steps that
 *  share a row (the computer checks, repositories and projects, runners, settings) share a number. */
export const SETUP_PART_NUMBERS: Partial<Record<OnboardStepId, number>> = {
  machine: 1,
  cli: 1,
  skills: 1,
  legacy: 1,
  signin: 2,
  housekeeping: 3,
  "linear.workspace": 1,
  "linear.personal": 2,
  "linear.team": 3,
  "linear.adopt": 4,
  "linear.automations": 5,
  "github.install": 6,
  "github.personal": 7,
  "github.repos": 1,
  projects: 1,
  accounts: 2,
  capacity: 3,
  runner: 3,
  settings: 4,
  values: 4,
  "first-ticket": 5,
};
/** CTC-4680: people type `catalyst setup`; `catalyst onboard` stays its alias. What setup draws
 *  names setup. `--json` and headless output keep their own words. */
export function setupCommandWords(text: string): string {
  return text.replace(/\bcatalyst onboard\b/g, "catalyst setup");
}
/** "Part 1 of 3 · This computer", with a colon where the output is plain. */
export function setupPartHeading(part: SetupPart, unicode: boolean): string {
  return `Part ${part} of 3${unicode ? " ·" : ":"} ${SETUP_PARTS[part].title}`;
}
const TITLES: Partial<Record<OnboardStepId, string>> = {
  "linear.adopt": "Set up the team's workflow",
  "linear.automations": "Check Linear's PR automations",
  projects: "Choose repositories",
  accounts: "Add a coding account",
  capacity: "Check runners",
  values: "Review repository settings",
};
const OPTIONAL = new Set([
  "local_sync_not_selected",
  "housekeeping_service_unverified",
  "member_scope",
  "automation_management_unavailable",
  "runner_not_selected",
  "legacy_not_selected",
  "settings_checkout_unverified",
  "settings_approval_unverified",
]);
export const CONNECTION_REPAIR_REASONS: ReadonlySet<string> = new Set([
  "github_app_permissions_outdated", "github_app_repository_missing", "github_app_repository_not_installed",
  "linear_workspace_scope_outdated", "linear_personal_scope_outdated",
  "github_app_permissions_unverified", "github_app_repository_access_unverified",
  "linear_workspace_permissions_unverified", "personal_permissions_unverified",
]);
/** CTC-4680: the signed-in browser route that goes straight to GitHub's install page. The settings
 *  page it replaces opened Integrations and started nothing. */
export const GITHUB_INSTALL_START = "/connect/github/start";
/** CTC-4680 round 5: a browser wait that ran its whole window without the person finishing. */
export const TIMED_OUT_REASONS: ReadonlySet<string> = new Set([
  "consent_timeout",
  "workspace_browser_unavailable",
  "personal_browser_unavailable",
  "github_installation_browser_unavailable",
]);
const clean = (s: string) =>
  s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 300);
function value(step: OnboardStep, key: string): string | undefined {
  const v = step.evidence?.[key];
  return typeof v === "string" && v.length ? clean(v) : undefined;
}
function succeeded(step: OnboardStep): string {
  switch (step.id) {
    case "linear.workspace":
    case "linear.personal":
    case "github.personal":
      return value(step, "username")
        ? `connected as ${value(step, "username")}`
        : "connected";
    case "github.install":
      return "installed";
    case "linear.team":
      return value(step, "teamKey") ?? "team chosen";
    case "linear.adopt":
      return "workflow ready";
    case "linear.automations":
      return "nothing to change";
    case "github.repos":
      return `${typeof step.evidence?.count === "number" ? step.evidence.count : "selected"} repositories chosen`;
    case "projects":
      return "repositories are now Catalyst projects";
    case "accounts":
      return `${value(step, "provider") === "claude" ? "Claude" : value(step, "provider") === "codex" ? "Codex" : "a coding account"} can take work`;
    case "capacity":
      return typeof step.evidence?.remainingUnits === "number"
        ? `${step.evidence.remainingUnits} runner slots available`
        : "runners can take work";
    case "settings":
    case "values":
      return "settings reviewed";
    case "first-ticket":
      return value(step, "ticketKey")
        ? `${value(step, "ticketKey")} started`
        : "first ticket started";
    case "daemon":
      return "local sync is running";
    case "runner":
      return "runner is running on this computer";
    default:
      return "ready";
  }
}
function unfinished(step: OnboardStep): string {
  if (step.reason?.endsWith("_scope_outdated") || step.reason === "github_app_permissions_outdated")
    return "needs updated permissions";
  if (step.reason === "github_app_repository_missing")
    return "cannot reach a project repository";
  if (step.reason === "github_app_repository_not_installed")
    return "no installation reaches the project repository";
  if (CONNECTION_REPAIR_REASONS.has(step.reason ?? ""))
    return "could not verify the connection's permissions";
  if (step.reason === "housekeeping_service_unverified")
    return "no scheduler here. catalyst says when an update is out";
  if (step.reason === "local_sync_not_selected")
    return "off, reads come from the cloud";
  if (step.reason === "runner_docker_missing") return "Docker is not running";
  if (step.reason === "member_scope") return "an admin handles this step";
  if (step.reason === "automation_management_unavailable")
    return "could not read them; checked again before work starts";
  if (step.reason === "interrupted") return "skipped for now";
  if (TIMED_OUT_REASONS.has(step.reason ?? "")) return "the link timed out";
  if (step.reason === "github_installation_approval_pending")
    return "waiting for an owner of your GitHub organization";
  if (step.state === "failed") return "could not finish this step";
  switch (step.id) {
    case "github.install":
      return "not installed yet";
    case "accounts":
      return "no coding account ready yet";
    case "linear.workspace":
    case "linear.personal":
    case "github.personal":
      return "not connected yet";
    case "linear.adopt":
      return "can't be set up from here yet";
    case "capacity":
      return "no runner can take work yet";
    case "settings":
    case "values":
      return "optional; not reviewed yet";
    default:
      return step.state === "skipped" ? "not chosen" : "not done yet";
  }
}
export function setupStepView(
  step: OnboardStep,
  journal?: OnboardJournal,
  required = false,
): { number: number; title: string; mark: StepMark; outcome: string } {
  required ||= step.id === "runner" && step.evidence?.selected === true;
  let mark: StepMark =
    step.state === "done"
      ? "done"
      : step.state === "failed"
        ? "fail"
        : step.reason === "prerequisite_not_ready" ||
            step.reason === "github_install_pending" ||
            (step.state === "pending" && !step.reason)
          ? "later"
          : !required &&
              (step.state === "skipped" || OPTIONAL.has(step.reason ?? ""))
            ? "skip"
            : "act";
  let outcome = step.state === "done" ? succeeded(step) : unfinished(step);
  if (mark === "later") {
    const waitsOn =
      step.reason === "github_install_pending"
        ? (["github.install"] as const)
        : (ONBOARD_DEPENDENCIES[step.id] ?? []).filter((id) => {
            const s = journal?.steps.find((s) => s.id === id);
            return s?.state !== "done" && s?.state !== "skipped";
          });
    // Numbers restart in each part: this part's steps come bare, then each other part once.
    const byPart = new Map<SetupPart, number[]>();
    for (const id of waitsOn) {
      const n = SETUP_PART_NUMBERS[id];
      if (n === undefined) continue;
      const p = SETUP_PART_OF[id];
      const list = byPart.get(p) ?? [];
      if (!list.includes(n)) byPart.set(p, [...list, n]);
    }
    const own = SETUP_PART_OF[step.id];
    const steps = (ns: number[]) => {
      const sorted = [...ns].sort((x, y) => x - y);
      const last = sorted.pop()!;
      return sorted.length
        ? `steps ${sorted.join(", ")} and ${last}`
        : `step ${last}`;
    };
    const groups = [...byPart]
      .sort(([x], [y]) => (x === own ? -1 : y === own ? 1 : x - y))
      .map(([p, ns]) => (p === own ? steps(ns) : `${steps(ns)} of part ${p}`));
    outcome =
      step.state === "pending" && !step.reason
        ? "not checked yet"
        : groups.length
          ? `after ${groups.length > 1 ? `${groups.slice(0, -1).join(", ")}, and ${groups.at(-1)}` : groups[0]}`
          : "after an earlier step";
  }
  return {
    number: SETUP_PART_NUMBERS[step.id] ?? 0,
    title: TITLES[step.id] ?? ONBOARD_TITLES[step.id],
    mark,
    outcome,
  };
}
export interface SetupPartProgress {
  /** Numbered rows in the part, counting rows that share a number once. */
  total: number;
  done: number;
  /** Rows a person must act on, failed ones included. */
  needs: number;
  failed: number;
}
/** How far each part has got, by its numbered rows. A row is done when every step in it is done
 *  or skipped, and needs someone when any of its steps does. */
export function setupPartProgress(
  journal: OnboardJournal,
  scope?: readonly OnboardStepId[],
): Record<SetupPart, SetupPartProgress> {
  const progress = {
    1: { total: 0, done: 0, needs: 0, failed: 0 },
    2: { total: 0, done: 0, needs: 0, failed: 0 },
    3: { total: 0, done: 0, needs: 0, failed: 0 },
  };
  const rows = new Map<string, StepMark[]>();
  for (const id of ONBOARD_STEPS) {
    const number = SETUP_PART_NUMBERS[id];
    if (number === undefined || (scope && !scope.includes(id))) continue;
    const step = journal.steps.find((s) => s.id === id) ?? {
      id,
      state: "pending" as const,
    };
    const key = `${SETUP_PART_OF[id]}:${number}`;
    rows.set(key, [...(rows.get(key) ?? []), setupStepView(step, journal).mark]);
  }
  for (const [key, marks] of rows) {
    const part = progress[Number(key.split(":")[0]) as SetupPart];
    part.total++;
    if (marks.every((m) => m === "done" || m === "skip")) part.done++;
    else if (marks.some((m) => m === "act" || m === "fail")) {
      part.needs++;
      if (marks.includes("fail")) part.failed++;
    }
  }
  return progress;
}
/**
 * The tracker's rows: on the first screen (`plan`, the part about to start), at a boundary
 * (`next`, the part about to start), or at the end. A part with no rows in this run is left out.
 */
export function setupTrackerRows(
  progress: Record<SetupPart, SetupPartProgress>,
  moment: { plan: SetupPart } | { next: SetupPart } | "end",
): TrackerRow[] {
  const steps = (n: number) => `${n} ${n === 1 ? "step" : "steps"}`;
  return ([1, 2, 3] as const)
    .filter((p) => progress[p].total > 0)
    .map((p): TrackerRow => {
      const { title, estimate, summary } = SETUP_PARTS[p];
      const got = progress[p];
      const row = (mark: StepMark, note: string) => ({
        mark,
        number: p,
        title,
        note,
      });
      if (typeof moment === "object" && "plan" in moment)
        return row(
          p === moment.plan ? "now" : "later",
          `${estimate} · ${summary}`,
        );
      const finished = got.done === got.total;
      const needsMark = got.failed ? "fail" : "act";
      if (typeof moment === "object") {
        if (p === moment.next) return row("now", `next · ${estimate}`);
        if (p > moment.next) return row("later", estimate);
        return finished
          ? row("done", "done")
          : row(needsMark, `${steps(got.total - got.done)} not finished`);
      }
      if (finished) return row("done", "");
      if (got.needs)
        return row(
          needsMark,
          `${steps(got.needs)} ${got.needs === 1 ? "needs" : "need"} someone`,
        );
      return row("later", `${got.done} of ${steps(got.total)} done`);
    });
}
function page(base: string | undefined, path: string): string | undefined {
  try {
    const url = new URL(path, base);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function action(
  step: OnboardStep,
  base?: string,
  journal?: OnboardJournal,
): string {
  if (
    CONNECTION_REPAIR_REASONS.has(step.reason ?? "") ||
    step.reason === "github_installation_approval_pending"
  )
    return onboardReasonText(step, { baseUrl: base, journal });
  const link = (path: string, verb: string) => {
    const url = page(base, path);
    return url
      ? `Open ${url} and ${verb}.`
      : `Open Catalyst settings and ${verb}.`;
  };
  switch (step.id) {
    case "linear.workspace":
      return link("/settings/connections?connect=linear", "connect Linear");
    case "linear.personal":
      return link(
        "/settings/connected-accounts?connect=linear",
        "connect your Linear account",
      );
    case "github.install":
      // The start route answers 403 to anyone but an owner or admin, so a member gets the
      // Integrations page and who to ask instead.
      if (
        step.reason === "github_installation_admin_required" ||
        step.reason === "member_scope"
      )
        return onboardReasonText(step, { baseUrl: base, journal });
      return link(
        GITHUB_INSTALL_START,
        "install Catalyst on your GitHub organization",
      );
    case "github.personal":
      return link(
        "/settings/connected-accounts?connect=github",
        "connect your GitHub account",
      );
    case "accounts":
      return link("/settings/coding-accounts", "add a coding account");
    case "linear.adopt": {
      const team = journal?.steps.find(
        (row) => row.id === "linear.team" && row.state === "done",
      );
      const key = team && value(team, "teamKey");
      return link(
        key
          ? `/settings/linear-teams/${encodeURIComponent(key)}/adopt`
          : "/settings/linear-teams",
        "set up the team's Catalyst workflow",
      );
    }
    case "linear.automations":
      return "Open your Linear team settings and set each pull request automation to No action.";
    case "capacity":
    case "runner":
      return step.reason
        ? onboardReasonText(step, { baseUrl: base, journal })
        : "Run catalyst onboard --runner to check whether this computer can take work.";
    case "settings":
    case "values":
      return "Open your repository checkout and review its settings.";
    case "linear.team":
      return "Choose a Linear team when setup checks again.";
    case "github.repos":
    case "projects":
      return "Choose repositories when setup checks again.";
    case "first-ticket":
      return "Choose a first ticket when setup checks again.";
    default:
      return "Try this step again when setup checks again.";
  }
}
export function setupFinalScreen(
  journal: OnboardJournal,
  base?: string,
  paused = false,
  required: ReadonlySet<OnboardStepId> = new Set(),
) {
  const roots = journal.steps
    .filter((step) => {
      const m = setupStepView(step, journal, required.has(step.id)).mark;
      return (
        (m === "act" || m === "fail") &&
        (ONBOARD_DEPENDENCIES[step.id] ?? []).every((id) => {
          const parent = journal.steps.find((s) => s.id === id);
          return parent?.state === "done" || parent?.state === "skipped";
        })
      );
    })
    .filter((step) => step.id !== "ready")
    .sort((a, b) => ONBOARD_STEPS.indexOf(a.id) - ONBOARD_STEPS.indexOf(b.id));
  const folded = (id: OnboardStepId) =>
    id === "projects" ? "github.repos" : id === "values" ? "settings" : id;
  const unique = roots.filter(
    (step, i) => roots.findIndex((s) => folded(s.id) === folded(step.id)) === i,
  );
  const actions = unique
    .slice(0, 5)
    .map((step) => ({ id: step.id, text: action(step, base, journal) }));
  const readiness = journal.steps.find((step) => step.id === "ready");
  const readinessCause =
    !paused &&
    !actions.length &&
    readiness &&
    (readiness.state === "failed" || readiness.state === "waiting")
      ? readiness.reason === "onboarding_checks_pending"
        ? readiness.state === "failed"
          ? "A required check failed. Run catalyst onboard again to retry."
          : undefined
        : clean(onboardReasonText(readiness, { baseUrl: base, journal }))
      : undefined;
  const heading = paused
    ? "Setup paused"
    : journal.steps.some(
          (step) =>
            step.id === "runner" &&
            (step.evidence?.selected === true || required.has(step.id)) &&
            step.state !== "done",
        )
      ? "Not ready for work yet"
      : journal.exit === 0 && journal.complete
        ? "Setup complete"
        : journal.exit === 0
          ? "Ready for work"
          : "Not ready for work yet";
  const ticket = journal.steps.find(
    (s) => s.id === "first-ticket" && s.state === "done",
  );
  const key = ticket && value(ticket, "ticketKey");
  const savedTicketUrl =
    ticket && (value(ticket, "url") ?? value(ticket, "ticketUrl"));
  const ticketUrl = savedTicketUrl && page(base, savedTicketUrl);
  const next = paused
    ? "Next: run catalyst onboard to continue."
    : key && ticketUrl
      ? `Next: open ${ticketUrl} and follow ${key}.`
      : heading === "Setup complete"
        ? "Next: move a ticket to Todo in Linear."
        : journal.exit === 0 && actions[0]
          ? `Next: ${actions[0].text[0]!.toLowerCase() + actions[0].text.slice(1)}`
          : actions.length === 1
            ? "Next: run catalyst onboard after you finish 1."
            : actions.length === 2
              ? "Next: run catalyst onboard after you finish 1 and 2."
              : actions.length
                ? "Next: run catalyst onboard after you finish 1 to " +
                  actions.length +
                  "."
                : "Next: run catalyst onboard to check again.";
  return {
    heading,
    readinessCause,
    actions,
    more: unique.length - actions.length,
    next,
    paused,
  };
}

export function setupBrowserInstruction(
  id: OnboardStepId,
  base?: string,
  opened = false,
) {
  const copy: Partial<Record<OnboardStepId, [string, string, string]>> = {
    "linear.workspace": [
      "/settings/connections?connect=linear",
      "connect Linear",
      "Connect Linear",
    ],
    "linear.personal": [
      "/settings/connected-accounts?connect=linear",
      "connect your Linear account",
      "Connect your Linear account",
    ],
    "github.install": [
      GITHUB_INSTALL_START,
      "install Catalyst on your GitHub organization",
      "Install Catalyst on your GitHub organization",
    ],
    "github.personal": [
      "/settings/connected-accounts?connect=github",
      "connect your GitHub account",
      "Connect your GitHub account",
    ],
    accounts: [
      "/settings/coding-accounts",
      "add the token with your Claude email",
      "Add a coding account",
    ],
  };
  const words = copy[id];
  if (!words) return undefined;
  return {
    instruction: opened
      ? `Opened your browser. ${words[2]} there.`
      : `Open this link and ${words[1]}:`,
    url: page(base, words[0]),
    preparation:
      id === "accounts"
        ? "In another terminal, run claude setup-token."
        : undefined,
  };
}

/** JSON facts use the same reachable actions as the terminal, while retaining the existing journal. */
export function onboardJsonView(
  journal: OnboardJournal,
  base?: string,
  paused = false,
  options: {
    only?: OnboardStepId;
    requiredSteps?: readonly OnboardStepId[];
  } = {},
) {
  const needed = new Set<OnboardStepId>();
  const include = (id: OnboardStepId) => {
    if (needed.has(id)) return;
    needed.add(id);
    for (const parent of ONBOARD_DEPENDENCIES[id] ?? []) include(parent);
  };
  if (options.only) include(options.only);
  const explicitRequired = new Set(options.requiredSteps ?? []);
  const required = new Set([
    ...explicitRequired,
    ...journal.steps
      .filter((step) => needed.has(step.id) && step.state === "waiting")
      .map((step) => step.id),
  ]);
  const view = {
    ...journal,
    steps: journal.steps
      .filter((step) => !options.only || needed.has(step.id))
      .map((step) =>
        explicitRequired.has(step.id) && step.state === "skipped"
          ? { ...step, state: "waiting" as const }
          : step,
      ),
  };
  const screen = setupFinalScreen(view, base, paused, required);
  const verdict = paused
    ? "paused"
    : journal.exit === 10
      ? "failed"
      : screen.heading === "Setup complete"
        ? "complete"
        : screen.heading === "Ready for work"
          ? "ready"
          : "not-ready";
  const actions = screen.actions.map((action) => {
    const step = view.steps.find((step) => step.id === action.id)!;
    const role = view.steps.find(
      (step) => step.id === "signin" && step.state === "done",
    )?.evidence?.role;
    const admin =
      step.reason === "member_scope" ||
      // CTC-4680: refused by the person's Catalyst role, not by GitHub, so a workspace admin acts.
      step.reason === "github_installation_admin_required" ||
      step.reason?.endsWith("_identity_unverified") ||
      (action.id === "accounts" && role !== "owner" && role !== "admin");
    const url = action.text
      .match(/https?:\/\/[^\s<>]+/)?.[0]
      ?.replace(/[.,;:!?]+$/, "");
    const text = url
      ? action.text.replace(`Open ${url} and `, "")
      : action.text;
    return {
      step: action.id,
      number: SETUP_NUMBERS[action.id] ?? 0,
      text: text.charAt(0).toUpperCase() + text.slice(1),
      ...(url ? { url } : {}),
      who: admin
        ? "admin"
        : action.id === "github.install"
          ? "github-org-admin"
          : [
                "linear.personal",
                "github.personal",
                "signin",
                "linear.team",
                "github.repos",
                "projects",
                "first-ticket",
                "settings",
                "values",
                "accounts",
                "runner",
                "machine",
                "cli",
                "skills",
                "legacy",
                "daemon",
                "housekeeping",
              ].includes(action.id)
            ? "you"
            : "admin",
    };
  });
  return {
    ...journal,
    verdict,
    actions,
    next:
      journal.exit === 0 &&
      !screen.next.startsWith("Next: run catalyst onboard")
        ? screen.next.replace(/^Next: /, "")
        : "catalyst onboard",
  };
}
