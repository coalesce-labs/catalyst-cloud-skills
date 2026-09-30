import type { Readable, Writable } from "node:stream";
import type { ParsedArgs } from "./args.js";
import { createOnboardProgress, type OnboardProgress } from "./onboard-progress.js";
import { ONBOARD_STEPS, ONBOARD_TITLES, type OnboardJournal, type OnboardStep, type OnboardStepId } from "./onboard.js";

/** Rendering cannot approve a step: the receipt engine owns execution and evidence. */
export interface OnboardUi {
  readonly signal: AbortSignal;
  plan(journal: OnboardJournal): void;
  confirmPlan(localSync: boolean): Promise<{ proceed: boolean; localSync: boolean }>;
  stepStart(id: OnboardStepId): void;
  stepEnd(step: OnboardStep): void;
  message(text: string): void;
  finish(journal: OnboardJournal, only?: OnboardStepId): void;
  wait<T>(message: string, run: () => Promise<T>): Promise<T>;
  dispose(): void;
}

export function shouldUseOnboardUi(args: ParsedArgs, stdoutTty: boolean): boolean {
  return stdoutTty && !args.json && args.flags.yes !== true && args.flags["dry-run"] !== true;
}

interface Streams { input: Readable; output: Writable }
interface PromptOptions extends Streams { signal: AbortSignal }
export interface ClackOnboardPort {
  intro(message: string, options: { output: Writable }): void;
  outro(message: string, options: { output: Writable }): void;
  log: Record<"message" | "info" | "warn" | "error", (message: string, options: { output: Writable }) => void>;
  select(options: PromptOptions & { message: string; options: Array<{ value: string; label: string; hint?: string }>; initialValue: string }): Promise<string | symbol>;
  isCancel(value: unknown): boolean;
}

type Interrupt = "SIGINT" | "SIGTERM" | "SIGHUP";
export interface OnboardSignalSource {
  on(event: Interrupt, listener: () => void): unknown;
  off(event: Interrupt, listener: () => void): unknown;
}

export function createClackOnboardUi(prompts: ClackOnboardPort, streams: Streams, deps: { signals?: OnboardSignalSource; progress?: OnboardProgress } = {}): OnboardUi {
  const abort = new AbortController();
  const options = { ...streams, signal: abort.signal };
  // Clack 1.8.1's spinner calls process.exit(0) on raw Ctrl-C, bypassing receipt/lock cleanup.
  const spin = deps.progress ?? createOnboardProgress(streams.output, abort.signal, () => abort.abort());
  const signals = deps.signals ?? process;
  const interrupt = () => abort.abort();
  for (const event of ["SIGINT", "SIGTERM", "SIGHUP"] as const) signals.on(event, interrupt);
  let active = false;
  let introduced = false;
  let group: string | undefined;
  const stop = () => { if (active) { spin.stop(); active = false; } };
  const message = (text: string) => { stop(); prompts.log.message(text, { output: streams.output }); };
  const start = (text: string) => { stop(); if (!abort.signal.aborted) { spin.start(text); active = true; } };
  return {
    signal: abort.signal,
    plan(journal) {
      stop();
      if (!introduced) { prompts.intro("Catalyst setup", { output: streams.output }); introduced = true; }
      const steps = new Map(journal.steps.map(step => [step.id, step]));
      message(ONBOARD_STEPS.map(id => `· ${ONBOARD_TITLES[id]}${steps.get(id)?.state === "done" ? " (recheck)" : ""}`).join("\n"));
      message("Use cloud reads by default. Local sync is optional for SQL, offline work or sustained reads.");
    },
    async confirmPlan(localSync) {
      stop();
      const answer = await prompts.select({ ...options, message: "Continue with this plan?", initialValue: localSync ? "local" : "cloud", options: [
        { value: "cloud", label: "Continue using cloud reads", hint: "default" },
        { value: "local", label: "Continue and set up local sync" },
        { value: "stop", label: "Stop without changes" },
      ] });
      if (prompts.isCancel(answer)) { abort.abort(); return { proceed: false, localSync }; }
      return { proceed: answer === "cloud" || answer === "local", localSync: answer === "local" };
    },
    stepStart(id) {
      const next = ["machine", "cli", "skills", "legacy"].includes(id) ? "This computer"
        : id === "signin" ? "Catalyst sign-in" : id.startsWith("linear.") || id.startsWith("github.") ? "Connections"
        : ["projects", "accounts", "settings", "values"].includes(id) ? "Project setup"
        : ["capacity", "daemon", "housekeeping"].includes(id) ? "Runner and services" : "Work and readiness";
      if (next !== group) { message(next); group = next; }
      start(ONBOARD_TITLES[id]);
    },
    stepEnd(step) {
      stop();
      const reasons: Record<string, string> = {
        cloud_capability_unavailable: "Your cloud does not support this setup step yet.",
        step_not_available_in_this_release: "This setup step is not available yet.",
        prerequisite_not_ready: "Waiting for an earlier setup step.",
        local_sync_not_selected: "Using cloud reads. Local sync was not selected.",
        local_sync_capability_unavailable: "Local sync was selected but could not be verified.",
        member_scope: "Your workspace administrator handles this step.",
        onboarding_checks_pending: "Some required checks are still unverified.",
        interrupted: "Setup paused. Run the same command to resume.",
      };
      const text = `${ONBOARD_TITLES[step.id]}${step.reason ? `: ${reasons[step.reason] ?? step.reason.replaceAll("_", " ")}` : ""}`;
      const kind = step.state === "done" ? "info" : step.state === "failed" ? "error" : step.state === "waiting" || step.state === "pending" ? "warn" : "message";
      prompts.log[kind](`${step.state === "done" ? "✓ " : ""}${text}`, { output: streams.output });
    },
    message,
    finish(journal, only) {
      stop();
      let text = "Setup still needs checks. Run catalyst onboard to resume.";
      if (abort.signal.aborted) text = "Setup paused. Your progress is saved.\nresume: catalyst onboard";
      else if (journal.complete && journal.exit === 0 && !only) text = "Onboarding complete.";
      else if (only && journal.exit === 0) text = `${ONBOARD_TITLES[only]} finished. Onboarding still has other steps.\nresume: catalyst onboard`;
      prompts.outro(text, { output: streams.output });
    },
    async wait(text, run) { start(text); try { return await run(); } finally { stop(); } },
    dispose() {
      try { stop(); } finally {
        abort.abort();
        try { spin.dispose(); } finally {
          for (const event of ["SIGINT", "SIGTERM", "SIGHUP"] as const) signals.off(event, interrupt);
        }
      }
    },
  };
}
