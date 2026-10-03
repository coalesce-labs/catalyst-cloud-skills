import type { Readable, Writable } from "node:stream";
import {
  COMPUTER_CHECKS,
  standalonePlan,
  standalonePlanNotes,
  pendingContinuation,
} from "./onboard-standalone-copy.js";
import type { SetupRenderer } from "./setup-render.js";
import { trackedPrompt } from "./setup-prompt-frame.js";
import { createOnboardInterrupts } from "./onboard-interrupts.js";
import {
  setupStepView,
  CONNECTION_REPAIR_REASONS,
  setupFinalScreen,
  setupBrowserInstruction,
  setupCommandWords as say,
  setupPartHeading,
  setupPartProgress,
  setupTrackerRows,
  SETUP_PART_NUMBERS,
  SETUP_PART_OF,
  SETUP_PARTS,
  type SetupPart,
} from "./setup-onboard-copy.js";
import type { ParsedArgs } from "./args.js";
import {
  createOnboardProgress,
  type OnboardProgress,
} from "./onboard-progress.js";
import type { ExistingOnboardTeam } from "./onboard-existing.js";
import {
  CREATE_TEAM_CHOICE,
  suggestTeamKey,
  teamKeyProblem,
  teamNameProblem,
  type NewTeamAnswer,
  type NewTeamQuestion,
  type TeamCreateOffer,
} from "./onboard-team-create.js";
import type { ExistingOnboardRepository } from "./onboard-repositories.js";
import type { OnboardSettingsSummary } from "./onboard-settings.js";
import {
  ONBOARD_STEPS,
  ONBOARD_TITLES,
  stepSatisfied,
  onboardIdentityLines,
  onboardNextActions,
  onboardReadyForWork,
  onboardStepAction,
  type OnboardIdentity,
  type OnboardJournal,
  type OnboardStep,
  type OnboardStepId,
} from "./onboard.js";
import { onboardStepDetail, onboardReasonText } from "./onboard-next.js";

/** Rendering cannot approve a step: the receipt engine owns execution and evidence. */
export interface OnboardUi {
  readonly signal: AbortSignal;
  readonly interactive?: boolean;
  /** True only when this UI installs and disposes its own process signal controller. */
  readonly handlesSignals?: boolean;
  readonly stepSignal?: AbortSignal;
  plan(
    journal: OnboardJournal,
    identity?: OnboardIdentity | null,
    options?: {
      localSync: boolean;
      scope: readonly OnboardStepId[];
      runner?: boolean;
    },
  ): void;
  confirmPlan(
    localSync: boolean,
    signin?: "saved" | "required" | "unavailable",
  ): Promise<{ proceed: boolean; localSync: boolean; signin?: boolean }>;
  /** A team ID, or `CREATE_TEAM_CHOICE` when `create` was offered and chosen. */
  chooseTeam?(
    teams: ExistingOnboardTeam[],
    create?: TeamCreateOffer,
  ): Promise<string | null>;
  /** The new team's name and key, confirmed; null to go back to the picker (or when cancelled). */
  nameNewTeam?(question: NewTeamQuestion): Promise<NewTeamAnswer | null>;
  confirmWorkflowAdoption?(
    team: string,
    lines: readonly string[],
  ): Promise<boolean>;
  chooseRepositories?(
    repositories: ExistingOnboardRepository[],
  ): Promise<string[] | null>;
  reviewSettings?(
    summaries: readonly OnboardSettingsSummary[],
  ): Promise<"keep" | "cancel">;
  chooseFirstRepository?(
    repositories: Array<{ owner: string; name: string }>,
  ): Promise<string | null>;
  /** "Run Catalyst's work on this machine?", default no. Null when cancelled. */
  chooseRunner?(): Promise<boolean | null>;
  /** CTC-4680 round 5: a browser link ran out of time. True gets a fresh link and another wait;
   *  false (stop, or Ctrl-C at the question) pauses setup so no later step runs without it. */
  retryTimedOut?(id: OnboardStepId): Promise<boolean>;
  /** Close a sign-in preview without recording an executed engine step. */
  stagedSigninEnd?(
    state: "done" | "waiting" | "failed",
    cause?: string,
  ): boolean;
  stepStart(id: OnboardStepId): void;
  stepEnd(step: OnboardStep, journal?: OnboardJournal): void;
  message(text: string): void;
  checkAgain?(journal: OnboardJournal): Promise<boolean>;
  finish(journal: OnboardJournal, only?: OnboardStepId): void;
  wait<T>(message: string, run: () => Promise<T>): Promise<T>;
  dispose(): void;
}

export function shouldUseOnboardUi(
  args: ParsedArgs,
  stdoutTty: boolean,
): boolean {
  return (
    stdoutTty &&
    !args.json &&
    args.flags.yes !== true &&
    args.flags["dry-run"] !== true
  );
}

interface Streams {
  input: Readable;
  output: Writable;
}
interface PromptOptions extends Streams {
  signal: AbortSignal;
}
export interface ClackOnboardPort {
  intro(message: string, options: { output: Writable }): void;
  outro(message: string, options: { output: Writable }): void;
  log: Record<
    "message" | "info" | "warn" | "error",
    (message: string, options: { output: Writable }) => void
  >;
  select(
    options: PromptOptions & {
      message: string;
      options: Array<{
        value: string;
        label: string;
        hint?: string;
        disabled?: boolean;
      }>;
      initialValue: string;
    },
  ): Promise<string | symbol>;
  text?(
    options: PromptOptions & {
      message: string;
      initialValue?: string;
      placeholder?: string;
      validate?: (value: string | undefined) => string | undefined;
    },
  ): Promise<string | symbol>;
  multiselect?(
    options: PromptOptions & {
      message: string;
      options: Array<{ value: string; label: string }>;
      required: boolean;
    },
  ): Promise<string[] | symbol>;
  isCancel(value: unknown): boolean;
}

type Interrupt = "SIGINT" | "SIGTERM" | "SIGHUP";
export interface OnboardSignalSource {
  on(event: Interrupt, listener: () => void): unknown;
  off(event: Interrupt, listener: () => void): unknown;
}

export function createClackOnboardUi(
  prompts: ClackOnboardPort,
  streams: Streams,
  deps: {
    verbose?: boolean;
    renderer?: SetupRenderer;
    disposeRenderer?: boolean;
    introduced?: boolean;
    consentGiven?: boolean;
    interactive?: boolean;
    signinTimeoutMs?: number;
    signals?: OnboardSignalSource;
    progress?: OnboardProgress;
    /** Read when a line needs it: the saved login can change during setup. */
    baseUrl?: () => string | undefined;
    logPath?: () => string | undefined;
    /** The CLI version the header names. */
    version?: string;
  } = {},
): OnboardUi {
  const abort = new AbortController();
  const options = { ...streams, signal: abort.signal };
  // Clack 1.8.1's spinner calls process.exit(0) on raw Ctrl-C, bypassing receipt/lock cleanup.
  const spin =
    deps.progress ??
    createOnboardProgress(streams.output, abort.signal, () => abort.abort());
  const signals = deps.signals ?? process;
  const interrupts = createOnboardInterrupts(abort);
  const handlers = {
    SIGINT: () => interrupts.interrupt("SIGINT"),
    SIGTERM: () => interrupts.interrupt("SIGTERM"),
    SIGHUP: () => interrupts.interrupt("SIGHUP"),
  };
  for (const event of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    signals.on(event, handlers[event]);
  let active = false;
  let introduced = deps.introduced === true;
  let currentStep: OnboardStepId | undefined;
  const renderer = deps.renderer;
  const interactive = deps.interactive !== false;
  let group: string | undefined;
  // CTC-4680: the part whose steps are on screen, the journal and plan the tracker reads, and
  // whether boundaries draw the tracker (not on a check-again pass).
  let part: SetupPart | undefined;
  // The part of the last step that ended in this run, shown or not: a boundary is a move past it.
  let ranPart: SetupPart | undefined;
  let journalSeen: OnboardJournal | undefined;
  let planned: { scope?: readonly OnboardStepId[]; runner?: boolean } = {};
  let rechecking = false;
  let browserOpened = true;
  let questionOpen = false;
  let signinShown = false;
  let stagedSigninApproved = false;
  let signinStarted = 0;
  const machineChecks = new Map<OnboardStepId, OnboardStep>();
  let machineScope: readonly OnboardStepId[] = COMPUTER_CHECKS;
  let machineBlocked = false;
  const standaloneComputer = (id: OnboardStepId | undefined) =>
    !!renderer &&
    !deps.consentGiven &&
    !!id &&
    COMPUTER_CHECKS.some((check) => check === id);
  const hidden = (id: OnboardStepId | undefined) =>
    (!!renderer && id === "ready") ||
    (!!renderer &&
      !!id &&
      ((id === "signin" && stagedSigninApproved) ||
        (deps.consentGiven === true &&
          [
            "machine",
            "cli",
            "skills",
            "legacy",
            "signin",
            "daemon",
            "housekeeping",
            "ready",
          ].includes(id))) &&
      !(id === "signin" && signinShown));
  const title = (id: OnboardStepId) =>
    setupStepView({ id, state: "running" }).title;
  const number = (id: OnboardStepId) => SETUP_PART_NUMBERS[id] ?? 0;
  /** A part's heading, then its plan rows, numbered from 1. */
  const planPart = (r: SetupRenderer, p: SetupPart, journal: OnboardJournal) => {
    r.heading(setupPartHeading(p, r.traits.unicode));
    for (const row of standalonePlan(journal, planned.scope, planned.runner))
      if (row.part === p) r.plan(row.number, row.title, row.detail);
  };
  /** Starting a step in another part: its heading, and when this run has moved past a part, the
   *  tracker again with the new part's plan. After the install engine, part 1's checks run unshown,
   *  so setup opens on the part 1 boundary. */
  const enterPart = (id: OnboardStepId) => {
    if (!renderer) return;
    const next = SETUP_PART_OF[id];
    if (next === part) return;
    const previous = ranPart;
    part = next;
    if (
      previous === undefined ||
      next <= previous ||
      rechecking ||
      !journalSeen
    ) {
      renderer.heading(setupPartHeading(next, renderer.traits.unicode));
      return;
    }
    const progress = setupPartProgress(journalSeen, planned.scope);
    const left = progress[previous].total - progress[previous].done;
    renderer.heading(
      left
        ? `Part ${previous} has ${left === 1 ? "1 step" : `${left} steps`} left. Setup carries on with part ${next}.`
        : `Part ${previous} done. ${SETUP_PARTS[previous].done}`,
    );
    renderer.tracker(setupTrackerRows(progress, { next }));
    planPart(renderer, next, journalSeen);
    renderer.blank();
  };
  const stop = () => {
    if (active) {
      if (renderer) renderer.suspendLive();
      else spin.stop();
      active = false;
    }
  };
  const message = (text: string) => {
    if (
      renderer &&
      (currentStep === "signin" || currentStep === undefined) &&
      !signinShown &&
      /(?:visit:\s*https?:|enter.*(?:code|[A-Z0-9]{4}-[A-Z0-9]{4})|https?:\/\/.*device)/i.test(
        text,
      )
    ) {
      const reveal = currentStep === undefined || hidden(currentStep);
      if (currentStep === undefined) {
        currentStep = "signin";
        signinStarted = Date.now();
        interrupts.begin("signin");
      }
      signinShown = true;
      if (reveal) {
        enterPart("signin");
        renderer.begin(number("signin"), title("signin"), "signing in…");
        active = true;
      }
    }
    if (hidden(currentStep)) return;
    if (
      renderer &&
      currentStep === "linear.adopt" &&
      text.endsWith("already has every state and label")
    )
      return;
    if (renderer) {
      if (
        currentStep &&
        setupBrowserInstruction(currentStep, deps.baseUrl?.())
      ) {
        if (/no browser opened|could not open a browser/i.test(text))
          browserOpened = false;
        return;
      }
      if (currentStep === "capacity") return;
      renderer.detail(say(text));
      return;
    }
    stop();
    prompts.log.message(text, { output: streams.output });
  };
  const start = (text: string) => {
    stop();
    if (!abort.signal.aborted) {
      if (hidden(currentStep)) return;
      if (renderer && currentStep)
        renderer.begin(
          number(currentStep),
          title(currentStep),
          text === ONBOARD_TITLES[currentStep] ? "checking…" : text,
        );
      else if (renderer) renderer.line(say(text));
      else spin.start(text);
      active = true;
    }
  };
  const question = () => {
    if (renderer && currentStep && !questionOpen) {
      stop();
      renderer.begin(number(currentStep), title(currentStep), "", "ask");
      active = true;
      questionOpen = true;
    }
  };
  const select = async (
    opts: Parameters<ClackOnboardPort["select"]>[0],
    ownFrame = false,
  ) => {
    if (!renderer) return prompts.select(opts);
    const detached = ownFrame || !currentStep;
    if (detached) {
      stop();
      renderer.begin(0, "Your choice", "", "ask");
      active = true;
    } else question();
    const result = await trackedPrompt(streams.output, (output) =>
      prompts.select({ ...opts, output }),
    );
    renderer.promptRows(result.rows);
    questionOpen = false;
    if (detached) stop();
    return result.answer;
  };
  const text = async (
    opts: Parameters<NonNullable<ClackOnboardPort["text"]>>[0],
  ) => {
    if (!prompts.text) return null;
    if (!renderer) return prompts.text(opts);
    question();
    const result = await trackedPrompt(streams.output, (output) =>
      prompts.text!({ ...opts, output }),
    );
    renderer.promptRows(result.rows);
    questionOpen = false;
    return result.answer;
  };
  const multiselect = async (
    opts: Parameters<NonNullable<ClackOnboardPort["multiselect"]>>[0],
  ) => {
    if (!prompts.multiselect) return null;
    if (!renderer) return prompts.multiselect(opts);
    question();
    const result = await trackedPrompt(streams.output, (output) =>
      prompts.multiselect!({ ...opts, output }),
    );
    renderer.promptRows(result.rows);
    questionOpen = false;
    return result.answer;
  };
  let summaryShown = false;
  const summary = (journal: OnboardJournal) => {
    const screen = setupFinalScreen(
      journal,
      deps.baseUrl?.(),
      abort.signal.aborted,
    );
    if (!renderer) return screen;
    renderer.suspendLive();
    active = false;
    renderer.heading(screen.heading);
    if (screen.paused) renderer.line("Your progress is saved.");
    renderer.tracker(
      setupTrackerRows(setupPartProgress(journal, planned.scope), "end"),
    );
    if (screen.readinessCause) renderer.line(say(screen.readinessCause));
    if (screen.actions.length) {
      renderer.line(
        `${screen.actions.length} ${screen.actions.length === 1 ? "thing needs" : "things need"} you:`,
      );
      screen.actions.forEach((action, i) =>
        renderer.line(`${i + 1}. ${say(action.text)}`),
      );
      if (screen.more) renderer.line(`and ${screen.more} more after these`);
      const continuation = pendingContinuation(journal);
      if (continuation) renderer.line(continuation);
    } else if (screen.heading === "Setup complete")
      renderer.line("Catalyst is ready to work on your team's tickets.");
    if (deps.logPath?.()) renderer.line(`Full log: ${deps.logPath()}`);
    return screen;
  };
  const ui: OnboardUi = {
    signal: abort.signal,
    get stepSignal() {
      return interrupts.signal;
    },
    interactive,
    handlesSignals: true,
    plan(journal, identity, planOptions) {
      planned = { scope: planOptions?.scope, runner: planOptions?.runner };
      journalSeen = journal;
      if (deps.consentGiven) return;
      machineScope = (planOptions?.scope ?? ONBOARD_STEPS).filter((id) =>
        COMPUTER_CHECKS.some((check) => check === id),
      );
      machineChecks.clear();
      machineBlocked = false;
      stop();
      if (!introduced) {
        if (renderer) renderer.brand("setup", deps.version);
        else prompts.intro("Catalyst setup", { output: streams.output });
        introduced = true;
      }
      if (identity !== undefined)
        for (const line of onboardIdentityLines(identity))
          if (renderer) renderer.line(line);
          else message(line);
      if (renderer) {
        // CTC-4680: what setup does and the three parts first, then only the first part's steps.
        // Each later part lists its own steps when it starts.
        const first =
          standalonePlan(journal, planned.scope, planned.runner)[0]?.part ?? 1;
        renderer.blank();
        renderer.line(
          "Setup gets Catalyst working on your team's Linear tickets. It has three parts.",
        );
        renderer.tracker(
          setupTrackerRows(setupPartProgress(journal, planned.scope), {
            plan: first,
          }),
        );
        planPart(renderer, first, journal);
        // Its steps follow under this heading; the first one does not print it again.
        part = first;
        renderer.line(
          standalonePlanNotes(
            planOptions?.localSync ?? journal.localSync === true,
          ),
        );
        return;
      }
      const steps = new Map(journal.steps.map((step) => [step.id, step]));
      message(
        ONBOARD_STEPS.map(
          (id) =>
            `· ${ONBOARD_TITLES[id]}${steps.get(id)?.state === "done" ? " (recheck)" : ""}`,
        ).join("\n"),
      );
      message(
        "Use cloud reads by default. Local sync is optional for SQL or sustained local reads.",
      );
      message(
        "Setup may check one stored Claude account using a one-token provider request. This may use Claude quota. It does not refresh Codex credentials.",
      );
    },
    async confirmPlan(localSync, signin = "unavailable") {
      if (deps.consentGiven || !interactive)
        return { proceed: true, localSync };
      stop();
      const answer = await select({
        ...options,
        message: "Continue setup?",
        initialValue:
          signin === "required" ? "signin" : localSync ? "local" : "cloud",
        options: [
          ...(signin === "required"
            ? []
            : [
                {
                  value: "cloud",
                  label: "Yes, continue",
                  hint: "default",
                },
                { value: "local", label: "Continue and set up local sync" },
              ]),
          ...(signin === "unavailable"
            ? []
            : [
                {
                  value: "signin",
                  label:
                    signin === "saved"
                      ? "Sign in again before continuing"
                      : "Sign in and review this plan",
                },
              ]),
          { value: "stop", label: "Stop without changes" },
        ],
      });
      if (prompts.isCancel(answer)) {
        abort.abort();
        return { proceed: false, localSync };
      }
      return {
        proceed: answer === "cloud" || answer === "local",
        localSync: answer === "local",
        ...(answer === "signin" ? { signin: true } : {}),
      };
    },
    async chooseTeam(teams, create) {
      stop();
      // Creating needs a name prompt; a port without one offers only the existing teams.
      const offer = prompts.text ? create : undefined;
      if ((!teams.length && !offer?.available) || abort.signal.aborted)
        return null;
      const answer = await select({
        ...options,
        message: renderer
          ? "Which Linear team should Catalyst work in?"
          : "Which Linear team should this project use?",
        initialValue: teams[0]?.id ?? CREATE_TEAM_CHOICE,
        options: [
          ...teams.map((team) => ({
            value: team.id,
            label: `${team.name || team.key || team.id}${team.key && team.name ? ` (${team.key})` : ""}`,
          })),
          ...(offer
            ? [
                {
                  value: CREATE_TEAM_CHOICE,
                  label: "Create a new Linear team…",
                  ...(offer.available
                    ? {}
                    : { hint: offer.reason, disabled: true }),
                },
              ]
            : []),
        ],
      });
      if (prompts.isCancel(answer)) {
        abort.abort();
        return null;
      }
      return typeof answer === "string" ? answer : null;
    },
    async confirmWorkflowAdoption(team, lines) {
      stop();
      if (abort.signal.aborted) return false;
      if (renderer) question();
      message([`Catalyst workflow plan for ${team}:`, ...lines].join("\n"));
      const answer = await select({
        ...options,
        message: renderer
          ? `Apply these changes to ${team}?`
          : `Apply this to ${team}?`,
        initialValue: "apply",
        options: [
          { value: "apply", label: "Yes, apply it" },
          { value: "skip", label: "No, not now" },
        ],
      });
      if (prompts.isCancel(answer)) {
        abort.abort();
        return false;
      }
      return answer === "apply";
    },
    ...(prompts.text
      ? {
          async nameNewTeam(question: NewTeamQuestion) {
            stop();
            if (abort.signal.aborted) return null;
            const name = await text({
              ...options,
              message: question.problem
                ? `${question.problem}\nName for the new Linear team`
                : "Name for the new Linear team",
              ...(question.name ? { initialValue: question.name } : {}),
              placeholder: "Mobile app",
              validate: teamNameProblem,
            });
            if (prompts.isCancel(name) || typeof name !== "string") {
              abort.abort();
              return null;
            }
            const key = await text({
              ...options,
              message: "Team key (the prefix on its tickets, like MOB-12)",
              initialValue:
                question.key &&
                (!question.name || question.name === name.trim())
                  ? question.key
                  : suggestTeamKey(name),
              validate: teamKeyProblem,
            });
            if (prompts.isCancel(key) || typeof key !== "string") {
              abort.abort();
              return null;
            }
            const answer = {
              name: name.trim(),
              key: key.trim().toUpperCase(),
            };
            const confirm = await select({
              ...options,
              message: `Create the Linear team ${answer.name} (${answer.key}) and set up Catalyst's workflow on it?`,
              initialValue: "create",
              options: [
                { value: "create", label: "Create the team" },
                { value: "back", label: "Go back to the team list" },
              ],
            });
            if (prompts.isCancel(confirm)) {
              abort.abort();
              return null;
            }
            return confirm === "create" ? answer : null;
          },
        }
      : {}),
    ...(prompts.multiselect
      ? {
          async chooseRepositories(repositories: ExistingOnboardRepository[]) {
            stop();
            if (!repositories.length || abort.signal.aborted) return null;
            const answer = await multiselect({
              ...options,
              message: "Which repositories should use this Linear team?",
              required: true,
              options: repositories.map((row) => ({
                value: `${row.owner}/${row.name}`,
                label: `${row.owner}/${row.name}`,
              })),
            });
            if (prompts.isCancel(answer)) {
              abort.abort();
              return null;
            }
            return Array.isArray(answer) ? answer : null;
          },
        }
      : {}),
    async reviewSettings(summaries) {
      stop();
      if (!summaries.length || abort.signal.aborted) return "cancel";
      const answer = await select({
        ...options,
        message:
          "Review settings for all selected repositories. Keep private copies of new drafts for review?",
        initialValue: "keep",
        options: [
          {
            value: "keep",
            label: "Keep private draft copies",
            hint: "default; repository files stay unchanged; approval and value import stay pending",
          },
          { value: "stop", label: "Stop without keeping new copies" },
        ],
      });
      if (prompts.isCancel(answer) || answer === "stop") {
        abort.abort();
        return "cancel";
      }
      return answer === "keep" ? "keep" : "cancel";
    },
    async chooseFirstRepository(repositories) {
      stop();
      if (!repositories.length || abort.signal.aborted) return null;
      const answer = await select({
        ...options,
        message: "Which repository should start this project?",
        initialValue: `${repositories[0]!.owner}/${repositories[0]!.name}`,
        options: repositories.map((row) => ({
          value: `${row.owner}/${row.name}`,
          label: `${row.owner}/${row.name}`,
        })),
      });
      if (prompts.isCancel(answer)) {
        abort.abort();
        return null;
      }
      return typeof answer === "string" ? answer : null;
    },
    async chooseRunner() {
      stop();
      if (abort.signal.aborted) return null;
      const answer = await select({
        ...options,
        message: "Run Catalyst's work on this machine?",
        initialValue: "no",
        options: [
          {
            value: "no",
            label: "No",
            hint: "default; work runs on the workspace's runner hosts",
          },
          {
            value: "yes",
            label: "Yes, start a Catalyst runner here with Docker",
          },
        ],
      });
      if (prompts.isCancel(answer)) {
        abort.abort();
        return null;
      }
      return answer === "yes";
    },
    async retryTimedOut(id) {
      if (abort.signal.aborted) return false;
      if (renderer && active) {
        // The wait frame is still live: its status and a last line say why it ended.
        renderer.update("the link timed out");
        renderer.detail("The link timed out.");
      } else if (renderer) {
        renderer.begin(number(id), title(id), "the link timed out");
        renderer.detail("The link timed out.");
        active = true;
      } else {
        stop();
        prompts.log.message(`${title(id)}: the link timed out.`, {
          output: streams.output,
        });
      }
      const answer = await select({
        ...options,
        message: "Ready to try again?",
        initialValue: "again",
        options: [
          { value: "again", label: "Yes, give me a new link" },
          { value: "stop", label: "Stop here. Run catalyst setup later to carry on." },
        ],
      });
      if (prompts.isCancel(answer) || answer !== "again") {
        abort.abort();
        return false;
      }
      return true;
    },
    stagedSigninEnd(state, cause) {
      if (!renderer) return false;
      if (state === "done") stagedSigninApproved = true;
      if (currentStep === "signin" && signinShown)
        renderer.step(
          state === "done" ? "done" : state === "failed" ? "fail" : "act",
          number("signin"),
          title("signin"),
          state === "done"
            ? "approved"
            : state === "failed"
              ? "could not verify this account"
              : "not finished",
        );
      else renderer.suspendLive();
      active = false;
      currentStep = undefined;
      signinShown = false;
      if (state !== "done") {
        if (cause)
          renderer.line(say(cause.charAt(0).toUpperCase() + cause.slice(1)));
        renderer.heading(
          abort.signal.aborted ? "Setup paused" : "Setup is not ready yet",
        );
        if (!cause?.includes("Your saved connection was not changed."))
          renderer.line("Your saved connection was not changed.");
        renderer.outro("Next: run catalyst setup to sign in again.");
      }
      return true;
    },
    stepStart(id) {
      interrupts.begin(id);
      browserOpened = true;
      questionOpen = false;
      currentStep = id;
      if (id === "signin") {
        signinShown = false;
        signinStarted = Date.now();
      }
      if (renderer) {
        if (standaloneComputer(id)) {
          if (!machineScope.length) return;
          if (machineChecks.size === 0 && !machineBlocked) {
            enterPart(id);
            renderer.begin(number(id), "This computer", "checking…");
            active = true;
          }
          return;
        }
        if (hidden(id)) return;
        if (id === "projects" || id === "values") return;
        enterPart(id);
        start(ONBOARD_TITLES[id]);
        return;
      }
      const next = ["machine", "cli", "skills", "legacy"].includes(id)
        ? "This computer"
        : id === "signin"
          ? "Catalyst sign-in"
          : id.startsWith("linear.") || id.startsWith("github.")
            ? "Connections"
            : ["projects", "accounts", "settings", "values"].includes(id)
              ? "Project setup"
              : ["capacity", "runner", "daemon", "housekeeping"].includes(id)
                ? "Runner and services"
                : "Work and readiness";
      if (next !== group) {
        message(next);
        group = next;
      }
      start(ONBOARD_TITLES[id]);
    },
    stepEnd(step, journal) {
      if (journal) journalSeen = journal;
      ranPart = SETUP_PART_OF[step.id];
      if (renderer) {
        if (standaloneComputer(step.id)) {
          machineChecks.set(step.id, step);
          if (step.state === "failed" || step.state === "waiting") {
            stop();
            machineBlocked = true;
            const view = setupStepView(step, journal);
            renderer.step(view.mark, view.number, view.title, view.outcome);
            renderer.detail(
              deps.logPath?.()
                ? "Check the full log for the cause, then try this step again."
                : "Finish the action below, then check again.",
            );
            active = false;
          } else if (
            !machineBlocked &&
            machineScope.length > 0 &&
            machineScope.every((id) => stepSatisfied(machineChecks.get(id)))
          ) {
            renderer.step(
              "done",
              1,
              "This computer",
              machineScope.length === COMPUTER_CHECKS.length
                ? machineChecks.get("legacy")?.state === "done"
                  ? "the command and skills are ready; no earlier install remains, data folders kept"
                  : "the command and skills are ready"
                : "the selected checks passed",
            );
            active = false;
          }
          return;
        }
        if (step.id === "ready" || (hidden(step.id) && step.state !== "failed"))
          return;
        if (
          (step.id === "github.repos" || step.id === "settings") &&
          step.state === "done"
        )
          return;
        if (
          (step.id === "projects" || step.id === "values") &&
          journal?.steps.find(
            (s) =>
              s.id === (step.id === "projects" ? "github.repos" : "settings"),
          )?.state !== "done"
        )
          return;
        const view = setupStepView(step, journal);
        if (hidden(step.id)) enterPart(step.id);
        renderer.step(view.mark, view.number, view.title, view.outcome);
        const granted = deps.verbose ? onboardStepDetail(step) : undefined;
        if (granted) renderer.detail(granted);
        if (deps.verbose && CONNECTION_REPAIR_REASONS.has(step.reason ?? ""))
          renderer.detail(
            say(onboardReasonText(step, { baseUrl: deps.baseUrl?.(), journal })),
          );
        if (view.mark === "fail")
          renderer.detail(
            deps.logPath?.()
              ? "Check the full log for the cause, then try this step again."
              : "Finish the action below, then check again.",
          );
        active = false;
        return;
      }
      stop();
      const detail = step.reason
        ? onboardStepAction(journal, step, deps.baseUrl?.())
        : undefined;
      const text = `${ONBOARD_TITLES[step.id]}${detail ? `: ${detail}` : ""}`;
      const kind =
        step.state === "done"
          ? "info"
          : step.state === "failed"
            ? "error"
            : step.state === "waiting" || step.state === "pending"
              ? "warn"
              : "message";
      prompts.log[kind](`${step.state === "done" ? "✓ " : ""}${text}`, {
        output: streams.output,
      });
      const granted = deps.verbose ? onboardStepDetail(step) : undefined;
      if (granted) prompts.log.message(granted, { output: streams.output });
    },
    message,
    async checkAgain(journal) {
      if (
        !renderer ||
        !interactive ||
        abort.signal.aborted ||
        !setupFinalScreen(journal, deps.baseUrl?.()).actions.length
      )
        return false;
      active = false;
      summary(journal);
      summaryShown = true;
      const answer = await select(
        {
          ...options,
          message: "Done with these?",
          initialValue: "again",
          options: [
            { value: "again", label: "Check again now" },
            { value: "stop", label: "Stop here" },
          ],
        },
        true,
      );
      if (prompts.isCancel(answer)) {
        abort.abort();
        return false;
      }
      if (answer !== "again") return false;
      summaryShown = false;
      machineScope = COMPUTER_CHECKS.filter(
        (id) => !stepSatisfied(journal.steps.find((step) => step.id === id)),
      );
      machineChecks.clear();
      machineBlocked = false;
      part = undefined;
      rechecking = true;
      renderer.heading("Checking again");
      return true;
    },
    finish(journal, only) {
      if (renderer && only) {
        stop();
        renderer.heading(
          abort.signal.aborted
            ? "Setup paused"
            : journal.exit === 0
              ? "Step complete"
              : "Step needs you",
        );
        if (journal.exit === 0)
          renderer.line(
            `${ONBOARD_TITLES[only]} finished. Onboarding still has other steps.`,
          );
        else
          for (const action of onboardNextActions(
            journal,
            deps.baseUrl?.(),
            only,
          ))
            renderer.line(say(action));
        renderer.outro("Next: run catalyst setup");
        return;
      }
      if (renderer) {
        active = false;
        const screen = summaryShown
          ? setupFinalScreen(journal, deps.baseUrl?.(), abort.signal.aborted)
          : summary(journal);
        if (summaryShown && screen.paused) {
          renderer.heading(screen.heading);
          renderer.line("Your progress is saved.");
        }
        summaryShown = false;
        renderer.outro(say(screen.next));
        return;
      }
      stop();
      let text = [
        "Setup still needs these steps:",
        ...onboardNextActions(journal, deps.baseUrl?.(), only),
        "resume: catalyst onboard",
      ].join("\n");
      if (abort.signal.aborted)
        text =
          "Setup paused. Your progress is saved.\nresume: catalyst onboard";
      else if (journal.complete && journal.exit === 0 && !only)
        text = "Onboarding complete.";
      else if (onboardReadyForWork(journal, only))
        text = [
          "Ready for work.",
          "Next, when you want:",
          ...onboardNextActions(journal, deps.baseUrl?.()),
        ].join("\n");
      else if (only && journal.exit === 0)
        text = `${ONBOARD_TITLES[only]} finished. Onboarding still has other steps.\nresume: catalyst onboard`;
      prompts.outro(text, { output: streams.output });
    },
    async wait(text, run) {
      const browser =
        currentStep &&
        renderer &&
        setupBrowserInstruction(
          currentStep,
          deps.baseUrl?.(),
          currentStep !== "accounts" && browserOpened,
        );
      const signinWait = Boolean(
        renderer && currentStep === "signin" && signinShown,
      );
      const seconds = signinWait
        ? Math.ceil((deps.signinTimeoutMs ?? 600000) / 1000)
        : 600;
      const started = signinWait ? signinStarted : Date.now();
      const status = () => {
        const remaining = Math.max(
          0,
          seconds - Math.floor((Date.now() - started) / 1000),
        );
        return `waiting for you · ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} left`;
      };
      if (renderer && browser && currentStep) {
        stop();
        renderer.begin(
          number(currentStep),
          title(currentStep),
          renderer.traits.unicode
            ? status()
            : "waiting for you, up to 10 minutes",
        );
        if (browser.preparation) renderer.detail(browser.preparation);
        renderer.action(browser.instruction);
        if (browser.url) renderer.detail(renderer.link(browser.url));
        renderer.detail(
          renderer.dim(
            interactive ? "Ctrl-C skips this step." : "Ctrl-C stops setup.",
          ),
        );
        active = true;
      } else if (renderer && signinWait) {
        if (renderer.traits.unicode) {
          renderer.update(status());
          renderer.detail("Ctrl-C stops setup.");
        } else {
          const minutes = Math.max(
            0,
            Math.ceil((started + seconds * 1000 - Date.now()) / 60000),
          );
          renderer.detail(
            `waiting for you${minutes ? `, up to ${minutes} minute${minutes === 1 ? "" : "s"}` : ""}. Ctrl-C stops setup.`,
          );
        }
      } else start(text);
      const timer =
        renderer && (browser || signinWait)
          ? renderer.traits.unicode
            ? setInterval(() => renderer.update(status()), 1000)
            : setInterval(() => {
                const minutes = Math.max(
                  0,
                  Math.ceil((seconds * 1000 - (Date.now() - started)) / 60000),
                );
                if (minutes > 0)
                  renderer.detail(
                    `Still waiting, ${minutes} minute${minutes === 1 ? "" : "s"} left.`,
                  );
              }, 60000)
          : undefined;
      timer?.unref();
      interrupts.waiting(interactive);
      try {
        return await run();
      } finally {
        if (timer) clearInterval(timer);
        interrupts.waiting(false);
        if (
          renderer &&
          browser &&
          interrupts.signal.aborted &&
          !abort.signal.aborted
        ) {
          renderer.replaceLastDetail(
            renderer.dim("Press Ctrl-C again to stop setup."),
          );
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timeout);
              abort.signal.removeEventListener("abort", done);
              resolve();
            };
            const timeout = setTimeout(done, 2000);
            abort.signal.addEventListener("abort", done, { once: true });
            if (abort.signal.aborted) done();
          });
        }
        if (!renderer) stop();
      }
    },
    dispose() {
      try {
        stop();
      } finally {
        abort.abort();
        try {
          spin.dispose();
          if (deps.disposeRenderer) renderer?.dispose();
        } finally {
          for (const event of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
            signals.off(event, handlers[event]);
        }
      }
    },
  };
  if (!interactive) {
    delete ui.chooseTeam;
    delete ui.nameNewTeam;
    delete ui.chooseRepositories;
    delete ui.chooseFirstRepository;
    delete ui.reviewSettings;
    delete ui.chooseRunner;
    delete ui.retryTimedOut;
    delete ui.confirmWorkflowAdoption;
  }
  return ui;
}
