import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { ParsedArgs } from "./args.js";
import { openBrowser } from "./browser.js";
import { defaultSkillsDirFor, loadConfig, normalizeBaseUrl, readManifest, type Ctx } from "./config.js";
import { CliError } from "./errors.js";
import { cmdLegacy, findLegacy, type LegacyDeps } from "./legacy.js";
import { bearerFor } from "./oauth.js";
import { pollConsent, type ConsentStatus } from "./onboard-consent.js";
import { boundedOnboardSignin } from "./onboard-signin.js";
import { existingLinearAdapters } from "./onboard-existing.js";
import { existingRepositoryAdapter } from "./onboard-repositories.js";
import type { OnboardAdapter, OnboardDeps, OnboardIdentity, OnboardJournal, OnboardStepResult } from "./onboard.js";
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

const waiting = (reason: string): OnboardStepResult => ({ state: "waiting", reason });
function sameHome(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/** Only existing bearer routes are registered here. Missing server capabilities stay unfinished. */
export function createOnboardRuntime(args: ParsedArgs, ctx: Ctx, hooks: OnboardRuntimeHooks): OnboardDeps {
  const identity = async (stepCtx = ctx, journal?: OnboardJournal): Promise<OnboardIdentity | null> => {
    const cfg = loadConfig(stepCtx.home);
    if (!cfg) return null;
    const requested = args.baseUrl ?? stepCtx.env.CATALYST_CLOUD_BASE_URL;
    if (requested && normalizeBaseUrl(requested) !== normalizeBaseUrl(cfg.baseUrl))
      throw new CliError("the saved login uses another cloud; resume against that cloud", "onboard-base-url-mismatch", 12);
    if (!cfg.user) throw new CliError("sign in as yourself to set up Catalyst", "onboard-person-required", 12);
    if (journal && (((journal.account ?? journal.tenant) && (journal.account ?? journal.tenant) !== cfg.account) ||
        (journal.membershipId && journal.membershipId !== cfg.user.id) ||
        (journal.baseUrl && normalizeBaseUrl(journal.baseUrl) !== normalizeBaseUrl(cfg.baseUrl))))
      throw new CliError("the saved setup belongs to another workspace or member", "onboard-identity-mismatch", 12);
    const me = await fetchMe(cfg.baseUrl, await bearerFor(stepCtx, cfg), stepCtx.fetch);
    if (!me.user || me.account !== cfg.account || me.user.id !== cfg.user.id)
      throw new CliError("the saved login and live member do not match", "onboard-identity-mismatch", 12);
    // /me names a person within the account, not an independently exposed membership-row ID.
    return { account: me.account, membershipId: me.user.id, baseUrl: normalizeBaseUrl(cfg.baseUrl), role: me.user.role };
  };
  const legacyCheck = async (stepCtx: Ctx): Promise<OnboardStepResult> => {
    const found = findLegacy(stepCtx.home, hooks.legacy?.platform ?? process.platform).filter(item => !item.data).length;
    if (!sameHome(stepCtx.home, (hooks.realHome ?? (() => userInfo().homedir))()))
      return { state: "skipped", reason: "fake_home_report_only", evidence: { found, remaining: found } };
    return { state: found ? "pending" : "done", evidence: { found, remaining: found } };
  };
  const unsupported: OnboardAdapter = { check: async () => waiting("cloud_capability_unavailable"), act: async () => waiting("cloud_capability_unavailable") };
  const personalStatus = async (provider: "linear" | "github", stepCtx: Ctx, signal?: AbortSignal): Promise<ConsentStatus> => {
    const cfg = loadConfig(stepCtx.home);
    if (!cfg || !cfg.user) return { outcome: "refused", reason: "personal_login_required" };
    const response = await stepCtx.fetch(`${normalizeBaseUrl(cfg.baseUrl)}/api/v1/me/connections/${provider}/personal`, {
      headers: { authorization: `Bearer ${await bearerFor(stepCtx, cfg)}`, accept: "application/json" },
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) return { outcome: "refused", reason: "personal_consent_refused" };
    if (response.status === 503) return { outcome: "unavailable" };
    if (!response.ok) return { outcome: "failed", reason: "personal_status_failed" };
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("connected" in body)) return { outcome: "failed", reason: "personal_status_shape" };
    if (body.connected === true) return { outcome: "connected" };
    if (body.connected !== false) return { outcome: "failed", reason: "personal_status_shape" };
    return { outcome: "reason" in body && body.reason === "lapsed" ? "lapsed" : "absent" };
  };
  const personalAdapter = (provider: "linear" | "github"): OnboardAdapter => ({
    check: async stepCtx => {
        const result = await personalStatus(provider, stepCtx);
        if (result.outcome === "connected") return { state: "done" };
        if (result.outcome === "refused" || result.outcome === "failed") return { state: result.outcome, reason: result.reason };
        return result.outcome === "unavailable" ? waiting("personal_status_unavailable") : { state: "pending" };
      }, act: async (stepCtx, _journal, signal) => {
        const cfg = loadConfig(stepCtx.home);
        if (!cfg || !cfg.user) return { state: "refused", reason: "personal_login_required" };
        const response = await stepCtx.fetch(`${normalizeBaseUrl(cfg.baseUrl)}/connect/${provider}/personal/start`, {
          headers: { authorization: `Bearer ${await bearerFor(stepCtx, cfg)}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 409) return waiting(provider === "linear" ? "linear_workspace_required" : "github_workspace_required");
        if (response.status === 401 || response.status === 403) return { state: "refused", reason: "personal_consent_refused" };
        if (!response.ok) return { state: "failed", reason: "personal_consent_start_failed" };
        const body = await response.json() as { authorizationUrl?: unknown; expiresAt?: unknown };
        if (typeof body.authorizationUrl !== "string" || typeof body.expiresAt !== "number") return { state: "failed", reason: "personal_consent_shape" };
        let url: URL;
        try { url = new URL(body.authorizationUrl); } catch { return { state: "failed", reason: "personal_consent_shape" }; }
        if (url.protocol !== "https:" || url.origin !== new URL(cfg.baseUrl).origin || url.username || url.password)
          return { state: "refused", reason: "personal_consent_origin" };
        stepCtx.stderr(`Approve your personal ${provider === "linear" ? "Linear" : "GitHub"} connection in the browser.`);
        stepCtx.stderr(url.toString());
        (hooks.openBrowser ?? openBrowser)(url.toString());
        const poll = () => pollConsent({ readStatus: pollSignal => personalStatus(provider, stepCtx, pollSignal), sleep: hooks.sleep, signal });
        return hooks.ui ? hooks.ui.wait(`Waiting for your ${provider === "linear" ? "Linear" : "GitHub"} approval`, poll) : poll();
    }
  });
  return {
    identity: journal => identity(ctx, journal), bindSignals: true, ui: hooks.ui,
    adapters: {
      machine: { check: async () => process.platform === "darwin" || process.platform === "linux"
        ? { state: "done", evidence: { provider: process.platform } } : waiting("machine_platform_unsupported") },
      cli: { check: async () => ({ state: "done", evidence: { version: readManifest().version } }) },
      skills: { check: async stepCtx => {
        const cfg = loadConfig(stepCtx.home);
        const dir = stepCtx.env.CATALYST_SKILLS_DIR ?? cfg?.skillsDir ?? defaultSkillsDirFor(stepCtx.home);
        const names = hooks.skillNames ?? [];
        const count = names.filter(name => existsSync(join(dir, name, "SKILL.md"))).length;
        return names.length > 0 && count === names.length ? { state: "done", evidence: { count, path: dir } } : waiting("skills_install_unverified");
      } },
      legacy: { check: legacyCheck, act: async stepCtx => {
        const before = await legacyCheck(stepCtx);
        if (before.state !== "pending") return before;
        // Provider/process output is not trusted to be secret-free; keep it out of the receipt/log.
        const quiet = { ...stepCtx, stdout: () => {}, stderr: () => {} };
        const code = await cmdLegacy({ ...args, command: "legacy", subcommand: null, rest: [], flags: { remove: true, yes: true }, json: false }, quiet, hooks.legacy);
        return code === 0 ? legacyCheck(stepCtx) : { state: "failed", reason: "legacy_cleanup_failed" };
      } },
      signin: { check: async (stepCtx, journal) => {
        const who = await identity(stepCtx, journal);
        return who ? { state: "done", evidence: { account: who.account, membershipId: who.membershipId, role: who.role } } : { state: "pending" };
      }, act: async (stepCtx, _journal, signal) => {
        return boundedOnboardSignin({ ...stepCtx, stdout: stepCtx.stderr }, hooks.login, signal, hooks.signinTimeoutMs);
      } },
      ...existingLinearAdapters(args, hooks.ui?.chooseTeam ? teams => hooks.ui!.chooseTeam!(teams.map(team => ({ ...team }))) : undefined),
      "github.install": unsupported,
      "github.repos": existingRepositoryAdapter(args, hooks.ui?.chooseRepositories ? repositories => hooks.ui!.chooseRepositories!(repositories.map(row => ({ ...row }))) : undefined),
      "linear.personal": personalAdapter("linear"),
      "github.personal": personalAdapter("github"),
      daemon: { check: async (_stepCtx, journal) => (journal.localSync ?? args.flags["local-sync"] === true) ? waiting("local_sync_capability_unavailable")
        : { state: "skipped", reason: "local_sync_not_selected", evidence: { provider: "cloud" } } },
      housekeeping: { check: async () => waiting("housekeeping_service_unverified") },
      ready: { check: hooks.ready },
    },
  };
}
