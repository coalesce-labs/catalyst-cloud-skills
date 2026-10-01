import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "./args.js";
import { openBrowser } from "./browser.js";
import {
  defaultSkillsDirFor,
  loadConfig,
  normalizeBaseUrl,
  readManifest,
  type Ctx,
} from "./config.js";
import { CliError } from "./errors.js";
import { cmdLegacy, findLegacy, type LegacyDeps } from "./legacy.js";
import { personalConsentAdapter } from "./onboard-personal.js";
import { boundedOnboardSignin } from "./onboard-signin.js";
import { existingLinearAdapters } from "./onboard-existing.js";
import { linearWorkspaceAdapter } from "./onboard-workspace.js";
import { firstProjectAdapters } from "./onboard-projects.js";
import { onboardCapacityAdapter } from "./onboard-capacity.js";
import { onboardAutomationManagementAdapter } from "./onboard-automation-management.js";
import { onboardWorkflowVerificationAdapter } from "./onboard-workflow.js";
import { onboardAccountsAdapter } from "./onboard-accounts.js";
import { githubInstallationAdapter } from "./onboard-github.js";
import {
  guardOnboardCapabilities,
  type OnboardCapabilityOptions,
} from "./onboard-capabilities.js";
import {
  onboardSettingsAdapter,
  type OnboardSettingsHooks,
} from "./onboard-settings.js";
import type {
  OnboardDeps,
  OnboardIdentity,
  OnboardJournal,
  OnboardStepResult,
  OnboardStepId,
} from "./onboard.js";
import type { OnboardUi } from "./onboard-ui.js";
import { fetchMe } from "./transport.js";

export interface OnboardRuntimeHooks {
  settings?: OnboardSettingsHooks;
  ui?: OnboardUi;
  login: (ctx: Ctx, signal?: AbortSignal) => Promise<number>;
  stageSignin?: (
    signal?: AbortSignal,
  ) => Promise<import("./onboard-login-candidate.js").OnboardLoginCandidate>;
  signinTimeoutMs?: number;
  ready: (ctx: Ctx, journal?: OnboardJournal) => Promise<OnboardStepResult>;
  legacy?: LegacyDeps;
  openBrowser?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  realHome?: () => string;
  skillNames?: readonly string[];
}

const waiting = (reason: string): OnboardStepResult => ({
  state: "waiting",
  reason,
});
function sameHome(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Only existing bearer routes are registered here. Missing server capabilities stay unfinished. */
export function createOnboardRuntime(
  args: ParsedArgs,
  ctx: Ctx,
  hooks: OnboardRuntimeHooks,
): OnboardDeps {
  const identity = async (
    stepCtx = ctx,
    journal?: OnboardJournal,
  ): Promise<OnboardIdentity | null> => {
    const cfg = loadConfig(stepCtx.home);
    if (!cfg) return null;
    const requested = args.baseUrl ?? stepCtx.env.CATALYST_CLOUD_BASE_URL;
    if (
      requested &&
      normalizeBaseUrl(requested) !== normalizeBaseUrl(cfg.baseUrl)
    )
      throw new CliError(
        "the saved login uses another cloud; resume against that cloud",
        "onboard-base-url-mismatch",
        12,
      );
    if (!cfg.user)
      throw new CliError(
        "sign in as yourself to set up Catalyst",
        "onboard-person-required",
        12,
      );
    if (
      journal &&
      (((journal.account ?? journal.tenant) &&
        (journal.account ?? journal.tenant) !== cfg.account) ||
        (journal.membershipId && journal.membershipId !== cfg.user.id) ||
        (journal.baseUrl &&
          normalizeBaseUrl(journal.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)))
    )
      throw new CliError(
        "the saved setup belongs to another workspace or member",
        "onboard-identity-mismatch",
        12,
      );
    // The Q1 preview reads the current token directly; stopping setup must not rotate saved credentials.
    const expiry = cfg.auth
      ? Date.parse(cfg.auth.expiresAt) - stepCtx.now().getTime()
      : 0;
    const bearer =
      cfg.key ||
      (cfg.auth && Number.isFinite(expiry) && expiry > 30_000
        ? cfg.auth.accessToken
        : undefined);
    if (!bearer)
      throw new CliError(
        "Renew your login with catalyst login, then run catalyst onboard.",
        "onboard-login-refresh-required",
        11,
      );
    const owned = new AbortController();
    const signal = hooks.ui
      ? AbortSignal.any([owned.signal, hooks.ui.signal])
      : owned.signal;
    const timer = setTimeout(() => owned.abort(), 30_000);
    let remove = () => {};
    let me: Awaited<ReturnType<typeof fetchMe>>;
    try {
      me = await new Promise<Awaited<ReturnType<typeof fetchMe>>>(
        (resolve, reject) => {
          const stopped = () =>
            reject(
              new CliError(
                "Your membership could not be checked. Run catalyst onboard to retry.",
                "onboard-membership-unavailable",
                11,
              ),
            );
          if (signal.aborted) {
            stopped();
            return;
          }
          signal.addEventListener("abort", stopped, { once: true });
          remove = () => signal.removeEventListener("abort", stopped);
          const boundedFetch = ((
            url: Parameters<typeof fetch>[0],
            init?: RequestInit,
          ) => {
            if (signal.aborted)
              return Promise.reject(new Error("membership_read_stopped"));
            return stepCtx.fetch(url, {
              ...init,
              redirect: "error",
              signal: init?.signal
                ? AbortSignal.any([signal, init.signal])
                : signal,
            });
          }) as typeof fetch;
          fetchMe(cfg.baseUrl, bearer, boundedFetch).then(
            (value) => (signal.aborted ? stopped() : resolve(value)),
            reject,
          );
        },
      );
    } finally {
      clearTimeout(timer);
      remove();
    }
    const current = loadConfig(stepCtx.home);
    if (
      !current?.user ||
      current.account !== cfg.account ||
      current.user.id !== cfg.user.id ||
      normalizeBaseUrl(current.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)
    )
      throw new CliError(
        "Your saved login changed while membership was checked. Run catalyst onboard again.",
        "onboard-identity-mismatch",
        12,
      );
    if (!me.user || me.account !== cfg.account || me.user.id !== cfg.user.id)
      throw new CliError(
        "the saved login and live member do not match",
        "onboard-identity-mismatch",
        12,
      );
    // /me names a person within the account, not an independently exposed membership-row ID.
    return {
      account: me.account,
      membershipId: me.user.id,
      baseUrl: normalizeBaseUrl(cfg.baseUrl),
      role: me.user.role,
      display: {
        personLabel: me.user.label,
        email: me.user.email,
        workspaceName: me.name,
        workspaceSlug: me.slug,
      },
    };
  };
  const legacyCheck = async (stepCtx: Ctx): Promise<OnboardStepResult> => {
    const found = findLegacy(
      stepCtx.home,
      hooks.legacy?.platform ?? process.platform,
    ).filter((item) => !item.data).length;
    if (
      !sameHome(stepCtx.home, (hooks.realHome ?? (() => userInfo().homedir))())
    )
      return {
        state: "skipped",
        reason: "fake_home_report_only",
        evidence: { found, remaining: found },
      };
    return {
      state: found ? "pending" : "done",
      evidence: { found, remaining: found },
    };
  };
  const personalAdapter = (provider: "linear" | "github") =>
    personalConsentAdapter({
      provider,
      openBrowser: hooks.openBrowser ?? openBrowser,
      sleep: hooks.sleep,
      wait: hooks.ui
        ? (message, run) => hooks.ui!.wait(message, run)
        : undefined,
    });
  const linear = existingLinearAdapters(
    args,
    hooks.ui?.chooseTeam
      ? (teams) => hooks.ui!.chooseTeam!(teams.map((team) => ({ ...team })))
      : undefined,
  );
  const adapters: NonNullable<OnboardDeps["adapters"]> = {
    machine: {
      check: async () =>
        process.platform === "darwin" || process.platform === "linux"
          ? { state: "done", evidence: { provider: process.platform } }
          : waiting("machine_platform_unsupported"),
    },
    cli: {
      check: async () => ({
        state: "done",
        evidence: { version: readManifest().version },
      }),
    },
    skills: {
      check: async (stepCtx) => {
        const cfg = loadConfig(stepCtx.home);
        const dir =
          stepCtx.env.CATALYST_SKILLS_DIR ??
          cfg?.skillsDir ??
          defaultSkillsDirFor(stepCtx.home);
        const names = hooks.skillNames ?? [];
        const count = names.filter((name) =>
          existsSync(join(dir, name, "SKILL.md")),
        ).length;
        return names.length > 0 && count === names.length
          ? { state: "done", evidence: { count, path: dir } }
          : waiting("skills_install_unverified");
      },
    },
    legacy: {
      check: legacyCheck,
      act: async (stepCtx) => {
        const before = await legacyCheck(stepCtx);
        if (before.state !== "pending") return before;
        // Provider/process output is not trusted to be secret-free; keep it out of the receipt/log.
        const quiet = { ...stepCtx, stdout: () => {}, stderr: () => {} };
        const code = await cmdLegacy(
          {
            ...args,
            command: "legacy",
            subcommand: null,
            rest: [],
            flags: { remove: true, yes: true },
            json: false,
          },
          quiet,
          hooks.legacy,
        );
        return code === 0
          ? legacyCheck(stepCtx)
          : { state: "failed", reason: "legacy_cleanup_failed" };
      },
    },
    signin: {
      check: async (stepCtx, journal) => {
        const who = await identity(stepCtx, journal);
        return who
          ? {
              state: "done",
              evidence: {
                account: who.account,
                membershipId: who.membershipId,
                role: who.role,
              },
            }
          : { state: "pending" };
      },
      act: async (stepCtx, _journal, signal) => {
        return boundedOnboardSignin(
          { ...stepCtx, stdout: stepCtx.stderr },
          hooks.login,
          signal,
          hooks.signinTimeoutMs,
        );
      },
    },
    ...linear,
    "linear.workspace": linearWorkspaceAdapter({
      fallback: linear["linear.workspace"],
      openBrowser: hooks.openBrowser ?? openBrowser,
      wait: hooks.ui
        ? (message, work) => hooks.ui!.wait(message, work)
        : undefined,
      sleep: hooks.sleep,
    }),
    "github.install": githubInstallationAdapter({
      openBrowser: hooks.openBrowser ?? openBrowser,
      wait: hooks.ui
        ? (message, work) => hooks.ui!.wait(message, work)
        : undefined,
      sleep: hooks.sleep,
    }),
    settings: onboardSettingsAdapter({
      ...hooks.settings,
      review: hooks.ui?.reviewSettings
        ? (summaries) => hooks.ui!.reviewSettings!(summaries)
        : hooks.settings?.review,
      message: hooks.ui
        ? (text) => hooks.ui!.message(text)
        : (text) => ctx.stderr(text),
    }),
    ...firstProjectAdapters(args, {
      chooseExisting: hooks.ui?.chooseRepositories
        ? (rows) =>
            hooks.ui!.chooseRepositories!(rows.map((row) => ({ ...row })))
        : undefined,
      chooseFirst: hooks.ui?.chooseFirstRepository
        ? (rows) =>
            hooks.ui!.chooseFirstRepository!(rows.map((row) => ({ ...row })))
        : undefined,
      message: (text) => (hooks.ui ? hooks.ui.message(text) : ctx.stderr(text)),
    }),
    accounts: onboardAccountsAdapter({
      message: (text) => (hooks.ui ? hooks.ui.message(text) : ctx.stderr(text)),
    }),
    capacity: onboardCapacityAdapter({
      message: (text) => (hooks.ui ? hooks.ui.message(text) : ctx.stderr(text)),
    }),
    "linear.adopt": onboardWorkflowVerificationAdapter({
      message: (text) => (hooks.ui ? hooks.ui.message(text) : ctx.stderr(text)),
    }),
    "linear.automations": onboardAutomationManagementAdapter({
      message: (text) => (hooks.ui ? hooks.ui.message(text) : ctx.stderr(text)),
    }),
    "linear.personal": personalAdapter("linear"),
    "github.personal": personalAdapter("github"),
    daemon: {
      check: async (_stepCtx, journal) =>
        (journal.localSync ?? args.flags["local-sync"] === true)
          ? waiting("local_sync_capability_unavailable")
          : {
              state: "skipped",
              reason: "local_sync_not_selected",
              evidence: { provider: "cloud" },
            },
    },
    housekeeping: {
      check: async () => waiting("housekeeping_service_unverified"),
    },
    ready: { check: hooks.ready },
  };
  const get = (path: string) => ({ method: "GET" as const, path });
  const capabilities: Partial<Record<OnboardStepId, OnboardCapabilityOptions>> =
    {
      "linear.workspace": {
        check: [get("/api/v1/me/connections/linear/workspace")],
        act: [
          get("/api/v1/me/connections/linear/workspace"),
          get("/api/v1/me/connections/linear/workspace/start"),
        ],
        fallback: "connections",
      },
      "linear.personal": {
        check: [get("/api/v1/me/connections/linear/personal")],
        act: [
          get("/api/v1/me/connections/linear/personal"),
          get("/connect/linear/personal/start"),
        ],
        fallback: "personalConnections",
      },
      "github.install": {
        check: [get("/api/v1/me/connections/github/workspace")],
        act: [
          get("/api/v1/me/connections/github/workspace"),
          get("/api/v1/me/connections/github/workspace/start"),
        ],
        fallback: "connections",
      },
      "github.personal": {
        check: [get("/api/v1/me/connections/github/personal")],
        act: [
          get("/api/v1/me/connections/github/personal"),
          get("/connect/github/personal/start"),
        ],
        fallback: "personalConnections",
      },
      "linear.team": {
        check: [
          get("/api/v1/agent/teams"),
          get("/api/v1/agent/tenant/readiness"),
        ],
        fallback: "connections",
      },
      "github.repos": {
        check: [get("/api/v1/repos"), get("/api/v1/agent/contract")],
        fallback: "connections",
      },
      settings: {
        check: [
          get("/api/v1/agent/teams"),
          get("/api/v1/repos"),
          get("/api/v1/agent/contract"),
        ],
        fallback: "connections",
      },
      projects: {
        check: [get("/api/v1/repos"), get("/api/v1/agent/contract")],
        fallback: "connections",
      },
      ready: {
        check: [get("/api/v1/agent/contract")],
        fallback: "connections",
      },
    };
  for (const [id, options] of Object.entries(capabilities)) {
    const step = id as OnboardStepId;
    const adapter = adapters[step];
    if (adapter)
      adapters[step] = guardOnboardCapabilities(adapter, {
        ...options,
        message: (text) =>
          hooks.ui ? hooks.ui.message(text) : ctx.stderr(text),
      });
  }
  // Public auth discovery and the existing /me sign-in bootstrap establish identity before the
  // tenant-bound step guards can run. Unsupported/local-only steps make no endpoint requests.
  return {
    identity: (journal) => identity(ctx, journal),
    ...(hooks.stageSignin ? { stageSignin: hooks.stageSignin } : {}),
    bindSignals: true,
    ui: hooks.ui,
    adapters,
  };
}
