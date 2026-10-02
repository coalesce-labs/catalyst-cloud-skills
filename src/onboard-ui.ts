import type { Readable, Writable } from "node:stream";
import type { ParsedArgs } from "./args.js";
import { firstTicketIntent, type FirstTicketIntent } from "./onboard-first-ticket.js";
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
  approveFirstTicket?(intent: Readonly<FirstTicketIntent>, signal: AbortSignal): Promise<boolean>;
  stepStart(id: OnboardStepId): void;
  stepEnd(step: OnboardStep): void;
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
  deps: { signals?: OnboardSignalSource; progress?: OnboardProgress } = {},
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
    async approveFirstTicket(intent, parent) {
      stop();
      const canonical = firstTicketIntent({ account: intent.account, person: intent.person, origin: intent.origin,
        teamId: intent.teamId, teamKey: intent.teamKey, repoId: intent.repoId, repoName: intent.repoName,
        dispatchStateId: intent.dispatchStateId, starter: intent.starter }, intent.operationKey);
      if (!canonical || Object.keys(intent).length !== Object.keys(canonical).length ||
          canonical.hash !== intent.hash || canonical.schema !== intent.schema || canonical.phase !== intent.phase ||
          canonical.title !== intent.title || canonical.description !== intent.description ||
          parent.aborted || abort.signal.aborted) return false;
      const signal = AbortSignal.any([abort.signal, parent]);
      message(`First ticket for ${canonical.teamKey} in ${canonical.repoName}`);
      message(canonical.title);
      message(canonical.description);
      const answer = await prompts.select({
        ...options, signal,
        message: "Start this proposed ticket?",
        initialValue: "later",
        options: [
          { value: "start", label: "Create the ticket and request intake" },
          { value: "later", label: "Keep setup and start work later", hint: "default" },
        ],
      });
      if (prompts.isCancel(answer)) { abort.abort(); return false; }
      return !signal.aborted && answer === "start";
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
              : ["capacity", "daemon", "housekeeping"].includes(id)
                ? "Runner and services"
                : "Work and readiness";
      if (next !== group) {
        message(next);
        group = next;
      }
      start(ONBOARD_TITLES[id]);
    },
    stepEnd(step) {
      stop();
      const reasons: Record<string, string> = {
        account_enrollment_required:
          "No coding account is enrolled. An administrator can add one in the workspace's coding-account settings, then run catalyst onboard again.",
        account_identity_unverified:
          "Your login changed while coding accounts were checked. Run catalyst onboard again to verify your person and workspace.",
        account_inventory_unavailable:
          "Coding accounts could not be read. Run catalyst onboard again to retry.",
        account_inventory_unverified:
          "The server did not return a fresh supported coding-account list. Run catalyst onboard after the server update.",
        account_validation_admin_required:
          "An administrator must check the workspace's coding-account access.",
        account_login_refresh_required:
          "Renew your login with catalyst login, then run catalyst onboard.",
        account_validation_unavailable:
          "The provider check could not finish. Run catalyst onboard again to retry.",
        account_validation_unverified:
          "The server did not return a fresh provider check. Run catalyst onboard after the server update.",
        account_provider_access_unverified:
          "Coding-account provider access is not freshly verified. Check the account in the workspace's coding-account settings, then resume setup.",
        codex_provider_access_unverified:
          "Codex credentials are stored, but provider access is not freshly verified. Setup did not refresh or rotate the Codex login.",
        account_provider_walled:
          "Claude's usage limit is spent for now. Check the account's reset time, then run catalyst onboard again.",
        account_provider_rejected:
          "Claude refused the stored login. Replace it in the workspace's coding-account settings, then resume setup.",
        personal_consent_handoff:
          "The browser approval link could not be verified. Run catalyst onboard to try again.",
        personal_identity_refused:
          "Your current login no longer matches this setup. Resume with the original workspace and person.",
        personal_login_refresh_required:
          "Renew your login with catalyst login, then run catalyst onboard to resume.",
        onboard_login_refresh_required:
          "Renew your login with catalyst login, then run catalyst onboard to resume.",
        personal_status_unavailable:
          "Your personal connection could not be checked. Run catalyst onboard to try again.",
        personal_browser_unavailable:
          "The browser could not open. Run catalyst onboard to try again.",
        cloud_capability_unavailable:
          "This setup step is not available on this server yet. Use the web app link shown above, then resume after the server update.",
        onboarding_capability_unavailable:
          "The server's setup capabilities could not be checked. Run catalyst onboard to try again.",
        onboarding_capability_identity_unverified:
          "The server's setup capabilities belong to another login or workspace. Sign in to the original workspace to resume.",
        onboarding_capability_login_refresh_required:
          "Your login needs a refresh before setup capabilities can be checked. Run catalyst login, then catalyst onboard.",
        workspace_consent_refused:
          "The server did not accept this login for Linear workspace setup. Sign in again or ask your workspace administrator.",
        github_installation_status_unavailable:
          "Your GitHub App installation could not be checked. Run catalyst onboard to try again.",
        github_installation_status_shape:
          "The server returned a GitHub installation result that could not be verified.",
        github_installation_consent_handoff:
          "The GitHub installation approval link could not be verified. Run catalyst onboard to try again.",
        github_installation_consent_refused:
          "The server did not accept this login for GitHub App setup. Sign in again or ask your workspace administrator.",
        github_installation_identity_refused:
          "GitHub setup belongs to another login or workspace. Sign in to the original workspace to resume.",
        github_installation_admin_required:
          "A workspace owner or administrator approves the GitHub App installation.",
        github_installation_login_refresh_required:
          "Your login needs a refresh. Run catalyst onboard to resume.",
        github_installation_browser_unavailable:
          "The GitHub App approval page could not be opened. Use your workspace's Connections page, then resume.",
        step_not_available_in_this_release:
          "This setup step is not available yet.",
        prerequisite_not_ready: "Waiting for an earlier setup step.",
        local_sync_not_selected:
          "Using cloud reads. Local sync was not selected.",
        local_sync_capability_unavailable:
          "Local sync was selected but could not be verified.",
        member_scope: "Your workspace administrator handles this step.",
        first_ticket_not_selected: "Setup kept. Start a ticket when you are ready.",
        first_ticket_context_unverified: "The selected team and registered repository could not be verified.",
        first_ticket_login_refresh_required: "Renew your login with catalyst login, then resume setup.",
        first_ticket_readiness_unverified: "Team readiness, its default repository or runner capacity could not be verified.",
        first_ticket_readiness_changed: "The team's setup changed. Resume to check it again before starting work.",
        first_ticket_saved_intent_changed: "The saved ticket belongs to an earlier selection. Resume with its original team and repository.",
        first_ticket_receipt_unavailable: "The saved first-ticket receipt could not be read. Setup did not request another ticket.",
        first_ticket_launch_unconfirmed: "The ticket has not been confirmed started. Check its activity, then resume setup.",
        first_ticket_unavailable: "The first-ticket result could not be verified. Resume to check the saved ticket.",
        onboarding_checks_pending: "Some required checks are still unverified.",
        interrupted: "Setup paused. Run the same command to resume.",
        signin_timeout: "Sign-in timed out. Run catalyst onboard to try again.",
        linear_workspace_unverified:
          "Your Linear workspace connection could not be verified.",
        team_inventory_empty: "No existing Linear teams could be verified.",
        team_inventory_shape:
          "The cloud returned a team list that could not be verified.",
        team_read_unavailable:
          "Your existing Linear teams could not be read. Run catalyst onboard to try again.",
        team_read_identity_unverified:
          "Your login changed while setup was reading this workspace. Resume with the original workspace and person.",
        project_identity_unverified:
          "Your login changed while setup was checking this project. Resume with the original workspace and person.",
        project_options_unavailable:
          "Available teams and repositories could not be checked. Run catalyst onboard to try again.",
        project_provider_inventory_unavailable:
          "Linear or GitHub access could not be verified. Check this workspace's connections, then resume.",
        project_options_unverified:
          "The server returned a team or repository list that could not be verified.",
        project_registration_visibility_pending:
          "Your project exists, but its repository binding is not visible yet. Run catalyst onboard to check again.",
        project_binding_conflict:
          "This team or repository is already bound to a project. Ask your workspace administrator to check its binding, then resume.",
        project_login_refresh_required:
          "Renew your login with catalyst onboard, then review the plan before creating this project.",
        project_create_unverified:
          "Project creation could not be confirmed. Run catalyst onboard to check for the project before trying again.",
        team_read_login_refresh_required:
          "Your login needs a refresh. Run catalyst onboard to resume.",
        team_choice_required:
          "Choose an existing team with catalyst onboard --team <team ID or key>.",
        team_selection_unverified:
          "Your selected Linear team could not be verified. Run catalyst onboard --team <team ID or key> to choose again.",
        repository_choice_required:
          "Choose repositories with catalyst onboard --repo <owner/name>. Repeat --repo to choose more than one.",
        repository_inventory_empty:
          "No accessible repositories are registered to this Linear team yet.",
        repository_read_unavailable:
          "Your repository list could not be read. Run catalyst onboard to try again.",
        repository_inventory_shape:
          "The cloud returned a repository list that could not be verified.",
        repository_contract_unavailable:
          "Current repository IDs could not be checked. Run catalyst onboard to try again.",
        repository_contract_unverified:
          "The cloud returned repository IDs that could not be verified for this workspace.",
        repository_id_unverified:
          "A repository's current ID could not be verified. Keep your selection and try again.",
        repository_binding_ambiguous:
          "A repository's Linear team binding is ambiguous. Your administrator needs to check it.",
        repository_identity_unverified:
          "Sign in to the original workspace to choose repositories.",
        settings_review_timeout:
          "The settings review timed out. Run catalyst onboard to resume.",
        settings_checkout_unverified:
          "A selected repository's local checkout or full settings file could not be verified. Resume from its checkout.",
        settings_draft_storage_unavailable:
          "A private settings draft could not be kept. Run catalyst onboard to retry.",
        settings_draft_storage_timeout:
          "Keeping your settings draft took too long. Run catalyst onboard to retry.",
        settings_approval_unverified:
          "Settings still need review and approval. Kept drafts and local validation do not approve them.",
        repository_selection_unverified:
          "Your selected repositories could not be verified. Run catalyst onboard --repo <owner/name> to choose again.",
      };
      const text = `${ONBOARD_TITLES[step.id]}${step.reason ? `: ${reasons[step.reason] ?? step.reason.replaceAll("_", " ")}` : ""}`;
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
      let text = "Setup still needs checks. Run catalyst onboard to resume.";
      if (abort.signal.aborted)
        text =
          "Setup paused. Your progress is saved.\nresume: catalyst onboard";
      else if (journal.complete && journal.exit === 0 && !only)
        text = "Onboarding complete.";
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
