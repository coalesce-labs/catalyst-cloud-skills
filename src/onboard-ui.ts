import type { Readable, Writable } from "node:stream";
import type { ParsedArgs } from "./args.js";
import {
  createOnboardProgress,
  type OnboardProgress,
} from "./onboard-progress.js";
import type { ExistingOnboardTeam } from "./onboard-existing.js";
import type { ExistingOnboardRepository } from "./onboard-repositories.js";
import type { OnboardSettingsSummary } from "./onboard-settings.js";
import {
  ONBOARD_STEPS,
  ONBOARD_TITLES,
  onboardIdentityLines,
  onboardNextActions,
  onboardReadyForWork,
  onboardStepAction,
  type OnboardIdentity,
  type OnboardJournal,
  type OnboardStep,
  type OnboardStepId,
} from "./onboard.js";

/** Rendering cannot approve a step: the receipt engine owns execution and evidence. */
export interface OnboardUi {
  readonly signal: AbortSignal;
  plan(journal: OnboardJournal, identity?: OnboardIdentity | null): void;
  confirmPlan(
    localSync: boolean,
    signin?: "saved" | "required" | "unavailable",
  ): Promise<{ proceed: boolean; localSync: boolean; signin?: boolean }>;
  chooseTeam?(teams: ExistingOnboardTeam[]): Promise<string | null>;
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
  stepStart(id: OnboardStepId): void;
  stepEnd(step: OnboardStep, journal?: OnboardJournal): void;
  message(text: string): void;
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
      options: Array<{ value: string; label: string; hint?: string }>;
      initialValue: string;
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
    signals?: OnboardSignalSource;
    progress?: OnboardProgress;
    /** Read when a line needs it: the saved login can change during setup. */
    baseUrl?: () => string | undefined;
  } = {},
): OnboardUi {
  const abort = new AbortController();
  const options = { ...streams, signal: abort.signal };
  // Clack 1.8.1's spinner calls process.exit(0) on raw Ctrl-C, bypassing receipt/lock cleanup.
  const spin =
    deps.progress ??
    createOnboardProgress(streams.output, abort.signal, () => abort.abort());
  const signals = deps.signals ?? process;
  const interrupt = () => abort.abort();
  for (const event of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    signals.on(event, interrupt);
  let active = false;
  let introduced = false;
  let group: string | undefined;
  const stop = () => {
    if (active) {
      spin.stop();
      active = false;
    }
  };
  const message = (text: string) => {
    stop();
    prompts.log.message(text, { output: streams.output });
  };
  const start = (text: string) => {
    stop();
    if (!abort.signal.aborted) {
      spin.start(text);
      active = true;
    }
  };
  return {
    signal: abort.signal,
    plan(journal, identity) {
      stop();
      if (!introduced) {
        prompts.intro("Catalyst setup", { output: streams.output });
        introduced = true;
      }
      if (identity !== undefined)
        for (const line of onboardIdentityLines(identity)) message(line);
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
      stop();
      const answer = await prompts.select({
        ...options,
        message: "Continue with this plan?",
        initialValue:
          signin === "required" ? "signin" : localSync ? "local" : "cloud",
        options: [
          ...(signin === "required"
            ? []
            : [
                {
                  value: "cloud",
                  label: "Continue using cloud reads",
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
    async chooseTeam(teams) {
      stop();
      if (!teams.length || abort.signal.aborted) return null;
      const answer = await prompts.select({
        ...options,
        message: "Which Linear team should this project use?",
        initialValue: teams[0]!.id,
        options: teams.map((team) => ({
          value: team.id,
          label: `${team.name || team.key || team.id}${team.key && team.name ? ` (${team.key})` : ""}`,
        })),
      });
      if (prompts.isCancel(answer)) {
        abort.abort();
        return null;
      }
      return typeof answer === "string" ? answer : null;
    },
    ...(prompts.multiselect
      ? {
          async chooseRepositories(repositories: ExistingOnboardRepository[]) {
            stop();
            if (!repositories.length || abort.signal.aborted) return null;
            const answer = await prompts.multiselect!({
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
      const answer = await prompts.select({
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
      const answer = await prompts.select({
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
      const answer = await prompts.select({
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
    stepStart(id) {
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
      stop();
      const text = `${ONBOARD_TITLES[step.id]}${step.reason ? `: ${onboardStepAction(journal, step, deps.baseUrl?.())}` : ""}`;
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
    },
    message,
    finish(journal, only) {
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
      start(text);
      try {
        return await run();
      } finally {
        stop();
      }
    },
    dispose() {
      try {
        stop();
      } finally {
        abort.abort();
        try {
          spin.dispose();
        } finally {
          for (const event of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
            signals.off(event, interrupt);
        }
      }
    },
  };
}
