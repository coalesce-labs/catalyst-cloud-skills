import { realpath } from "node:fs/promises";
import { storeOnboardDraft } from "./env/onboard-draft-store.js";
import { isAbsolute, resolve } from "node:path";
import { validateFullSettings } from "../vendor/settings/index.js";
import {
  draftOnboardSettings,
  type OnboardSettingsDraft,
} from "./env/onboard-draft.js";
import type {
  SettingsAuthorityContext,
  SettingsAuthorityPorts,
} from "./env/settings-authority.js";
import { onboardSettingsAuthorityPorts } from "./onboard-settings-context.js";
import {
  selectedOnboardRepositories,
  type ExistingOnboardRepository,
} from "./onboard-repositories.js";
import { normalizeBaseUrl, type Ctx } from "./config.js";
import { selectedOnboardTeam } from "./onboard-existing.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepResult,
} from "./onboard.js";

export interface OnboardSettingsSummary {
  repository: string;
  state: "draft" | "existing" | "unavailable";
  variableNames: readonly string[];
  secretNames: readonly string[];
  sources: readonly string[];
}
export interface OnboardDraftStoreInput {
  home: string;
  env: NodeJS.ProcessEnv;
  runId: string;
  repoId: string;
  toml: string;
  signal?: AbortSignal;
}
export interface OnboardSettingsHooks {
  repositoryRoot?: (repository: ExistingOnboardRepository) => string | null;
  authorityPorts?: (
    ctx: Ctx,
    journal: OnboardJournal,
    repository: ExistingOnboardRepository,
    root: string,
  ) => SettingsAuthorityPorts;
  draft?: typeof draftOnboardSettings;
  /** Abort the writer at this budget, then wait for its IO and cleanup acknowledgment. */
  storeTimeoutMs?: number;
  storeDraft?: (
    input: OnboardDraftStoreInput,
  ) => Promise<{ state: "stored"; path: string } | { state: "rejected" }>;
  review?: (
    summaries: readonly OnboardSettingsSummary[],
  ) => Promise<"keep" | "cancel">;
  message?: (text: string) => void;
}
interface Candidate {
  repository: ExistingOnboardRepository;
  ports: SettingsAuthorityPorts;
  context: SettingsAuthorityContext;
  draft: Extract<OnboardSettingsDraft, { state: "draft" }>;
}
const waiting = (
  reason: string,
  evidence?: OnboardStepResult["evidence"],
): OnboardStepResult => ({
  state: "waiting",
  reason,
  ...(evidence ? { evidence } : {}),
});
const contextKey = (value: SettingsAuthorityContext) =>
  JSON.stringify([
    value.accountId,
    value.personId,
    value.baseUrl,
    value.role,
    value.teamId,
    value.teamKey,
    value.repoId,
    value.repoName,
    value.repoRoot,
  ]);
const safeLabel = (text: string) =>
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 240);
async function boundedRead<T>(
  work: (signal: AbortSignal) => Promise<T>,
  external?: AbortSignal,
  timeoutMs = 30_000,
): Promise<T | null> {
  const owned = new AbortController();
  const signal = external
    ? AbortSignal.any([external, owned.signal])
    : owned.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remove = () => {};
  try {
    return await new Promise<T | null>((resolve) => {
      const stopped = () => resolve(null);
      if (signal.aborted) {
        stopped();
        return;
      }
      signal.addEventListener("abort", stopped, { once: true });
      remove = () => signal.removeEventListener("abort", stopped);
      timer = setTimeout(() => owned.abort(), timeoutMs);
      Promise.resolve()
        .then(() => work(signal))
        .then(
          (result) => resolve(signal.aborted ? null : result),
          () => resolve(null),
        );
    });
  } finally {
    if (timer) clearTimeout(timer);
    remove();
  }
}

/** Q4 drafts are local review artifacts. A full local validator is not declaration approval;
 * neither a kept draft nor a valid existing file marks this required step complete. */
export function onboardSettingsAdapter(
  hooks: OnboardSettingsHooks = {},
): OnboardAdapter {
  const storeTimeoutMs = hooks.storeTimeoutMs ?? 30_000;
  if (
    !Number.isSafeInteger(storeTimeoutMs) ||
    storeTimeoutMs < 1 ||
    storeTimeoutMs > 30_000
  )
    throw new Error("settings_storage_timeout_invalid");
  const observe = async (
    ctx: Ctx,
    journal: OnboardJournal,
    signal?: AbortSignal,
  ) => {
    const repositories = selectedOnboardRepositories(journal);
    const summaries: OnboardSettingsSummary[] = [];
    const candidates: Candidate[] = [];
    for (const repository of repositories) {
      if (signal?.aborted) return null;
      const summary: OnboardSettingsSummary = {
        repository: `${repository.owner}/${repository.name}`,
        state: "unavailable",
        variableNames: [],
        secretNames: [],
        sources: [],
      };
      summaries.push(summary);
      try {
        const requested = hooks.repositoryRoot
          ? hooks.repositoryRoot({ ...repository })
          : process.cwd();
        if (
          !requested ||
          !isAbsolute(requested) ||
          (await realpath(requested)) !== resolve(requested) ||
          signal?.aborted
        )
          continue;
        const ports = (
          hooks.authorityPorts ??
          ((c, j, r, root) =>
            onboardSettingsAuthorityPorts({
              ctx: c,
              journal: j,
              repository: r,
              repoRoot: root,
            }))
        )(ctx, journal, repository, requested);
        const before = await ports.readContext(signal);
        if (
          !before ||
          before.accountId !== (journal.account ?? journal.tenant) ||
          before.personId !== journal.membershipId ||
          !journal.baseUrl ||
          before.baseUrl !== normalizeBaseUrl(journal.baseUrl) ||
          !["owner", "admin"].includes(before.role) ||
          before.teamId !== selectedOnboardTeam(journal) ||
          before.teamId !== repository.teamId ||
          !/^[A-Z][A-Z0-9]{0,15}$/.test(before.teamKey) ||
          before.repoId !== repository.repoId ||
          before.repoName !== summary.repository.toLowerCase() ||
          before.repoRoot !== resolve(requested) ||
          signal?.aborted
        )
          continue;
        const binding = contextKey(before);
        const existing = await ports.readSettings(requested, signal);
        if (existing !== null) {
          const checked = validateFullSettings(existing);
          const after = await ports.readContext(signal);
          if (
            !checked.ok ||
            checked.linearTeam !== before.teamKey ||
            !after ||
            contextKey(after) !== binding ||
            signal?.aborted
          )
            continue;
          Object.assign(summary, {
            state: "existing",
            variableNames: checked.variableNames,
            secretNames: checked.secretNames,
            sources: [".catalyst/catalyst.toml"],
          });
          continue;
        }
        const draft = (hooks.draft ?? draftOnboardSettings)(
          requested,
          before.teamKey,
        );
        if (draft.state !== "draft") continue;
        const checked = validateFullSettings(draft.toml);
        const after = await ports.readContext(signal);
        if (
          !checked.ok ||
          checked.linearTeam !== before.teamKey ||
          !after ||
          contextKey(after) !== binding ||
          signal?.aborted
        )
          continue;
        Object.assign(summary, {
          state: "draft",
          variableNames: checked.variableNames,
          secretNames: checked.secretNames,
          sources: draft.sources.map(safeLabel),
        });
        candidates.push({
          repository: { ...repository },
          context: { ...before },
          ports,
          draft,
        });
      } catch {
        /* One unavailable checkout cannot approve the other repositories. */
      }
    }
    return { summaries, candidates };
  };
  const bounded = (ctx: Ctx, journal: OnboardJournal, external?: AbortSignal) =>
    boundedRead((signal) => observe(ctx, journal, signal), external);
  return {
    check: async (ctx, journal, signal) => {
      const read = await bounded(ctx, journal, signal);
      if (!read?.summaries.length)
        return waiting("settings_checkout_unverified");
      if (read.summaries.some((summary) => summary.state === "unavailable"))
        return waiting("settings_checkout_unverified");
      return read.candidates.length
        ? { state: "pending" }
        : waiting("settings_approval_unverified");
    },
    act: async (ctx, journal, signal) => {
      const read = await bounded(ctx, journal, signal);
      if (!read?.summaries.length || signal?.aborted)
        return waiting("settings_checkout_unverified");
      for (const summary of read.summaries) {
        hooks.message?.(
          `Settings for ${summary.repository}\n  ${summary.state === "unavailable" ? "Local checkout or settings could not be verified." : `Full settings schema validation passed locally (${summary.state === "draft" ? "new draft; private copy pending" : "existing repository file; kept unchanged"}).\n  Variables: ${summary.variableNames.join(", ") || "none"}\n  Secrets: ${summary.secretNames.join(", ") || "none"}\n  Sources: ${summary.sources.join(", ") || "none"}`}`,
        );
      }
      const choice = hooks.review
        ? await boundedRead(
            async () =>
              hooks.review!(
                read.summaries.map((row) => ({
                  ...row,
                  variableNames: [...row.variableNames],
                  secretNames: [...row.secretNames],
                  sources: [...row.sources],
                })),
              ),
            signal,
            600_000,
          )
        : "keep";
      if (choice === null && !signal?.aborted)
        return waiting("settings_review_timeout");
      if (choice !== "keep" || signal?.aborted) return waiting("interrupted");
      if (read.summaries.some((summary) => summary.state === "unavailable"))
        return waiting("settings_checkout_unverified");

      let stored = 0;
      for (const candidate of read.candidates) {
        const current = await boundedRead(
          (owned) => candidate.ports.readContext(owned),
          signal,
        );
        if (
          !current ||
          contextKey(current) !== contextKey(candidate.context) ||
          signal?.aborted
        )
          return waiting("settings_checkout_unverified", { count: stored });
        const ownedStore = new AbortController();
        const storeSignal = signal
          ? AbortSignal.any([signal, ownedStore.signal])
          : ownedStore.signal;
        const timer = setTimeout(() => ownedStore.abort(), storeTimeoutMs);
        let result: Awaited<ReturnType<typeof storeOnboardDraft>>;
        try {
          // Do not race this promise. The writer settles all IO/owned cleanup before the engine
          // may release its receipt lock, including after cancellation or the cooperative budget.
          result = await (hooks.storeDraft ?? storeOnboardDraft)({
            home: ctx.home,
            env: { ...ctx.env },
            runId: journal.runId,
            repoId: candidate.repository.repoId,
            toml: candidate.draft.toml,
            signal: storeSignal,
          });
        } catch {
          result = { state: "rejected" };
        } finally {
          clearTimeout(timer);
        }
        if (storeSignal.aborted)
          return waiting(
            signal?.aborted ? "interrupted" : "settings_draft_storage_timeout",
            { count: stored },
          );
        if (result.state !== "stored" || signal?.aborted)
          return waiting("settings_draft_storage_unavailable", {
            count: stored,
          });
        stored++;
        hooks.message?.(
          `Kept a private settings draft copy for ${candidate.repository.owner}/${candidate.repository.name}: ${safeLabel(result.path)}`,
        );
      }
      return waiting("settings_approval_unverified", { count: stored });
    },
  };
}
