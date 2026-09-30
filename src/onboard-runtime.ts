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
import { bearerFor } from "./oauth.js";
import { personalConsentAdapter } from "./onboard-personal.js";
import { boundedOnboardSignin } from "./onboard-signin.js";
import { existingLinearAdapters } from "./onboard-existing.js";
import { linearWorkspaceAdapter } from "./onboard-workspace.js";
import { existingRepositoryAdapter } from "./onboard-repositories.js";
import type {
  OnboardAdapter,
  OnboardDeps,
  OnboardIdentity,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";
import type { OnboardUi } from "./onboard-ui.js";
import { fetchMe } from "./transport.js";

export interface OnboardRuntimeHooks {
  ui?: OnboardUi;
  login: (ctx: Ctx, signal?: AbortSignal) => Promise<number>;
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
    const me = await fetchMe(
      cfg.baseUrl,
      await bearerFor(stepCtx, cfg),
      stepCtx.fetch,
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
  const unsupported: OnboardAdapter = {
    check: async () => waiting("cloud_capability_unavailable"),
    act: async () => waiting("cloud_capability_unavailable"),
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
  return {
    identity: (journal) => identity(ctx, journal),
    bindSignals: true,
    ui: hooks.ui,
    adapters: {
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
      "github.install": unsupported,
      "github.repos": existingRepositoryAdapter(
        args,
        hooks.ui?.chooseRepositories
          ? (repositories) =>
              hooks.ui!.chooseRepositories!(
                repositories.map((row) => ({ ...row })),
              )
          : undefined,
      ),
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
    },
  };
}
