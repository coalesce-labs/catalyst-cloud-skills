import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import { verifyOnboardRoutes } from "./onboard-capabilities.js";
import { pollConsent } from "./onboard-consent.js";
import { readExistingOnboardJson } from "./onboard-existing.js";
import type {
  OnboardAdapter,
  OnboardJournal,
  OnboardStepId,
  OnboardStepResult,
} from "./onboard.js";

/** The one read behind the web app's Connect accounts page. Each read runs live provider probes. */
export const CHECKLIST_PATH = "/api/v1/me/connections/checklist";
export const CONNECT_PAGE_PATH = "/connect-accounts";
/** Never poll the checklist faster than this: every read probes Linear and GitHub. */
export const CHECKLIST_POLL_MS = 10_000;

export type ChecklistItemId =
  | "linear-workspace"
  | "linear-personal"
  | "github-personal"
  | "github-app"
  | "ai-account";
type ItemState = "done" | "needed" | "outdated" | "waiting" | "unknown";
export interface ChecklistItem {
  id: ChecklistItemId;
  state: ItemState;
  reason: string | null;
  who: "admin" | "you";
  canAct: boolean;
}
export interface Checklist {
  page: string;
  checkedAt: number;
  items: ChecklistItem[];
  /** The AI accounts this workspace may add, as "subscription,api-key" or "api-key". Subscriptions
   *  only when the cloud says so: a missing or unknown answer is API keys alone. */
  aiAccountKinds: string;
}

/** Exactly the page's own labels, so the terminal and the browser name each row the same way. */
export const CHECKLIST_LABELS: Record<ChecklistItemId, string> = {
  "linear-workspace": "Linear workspace",
  "linear-personal": "Your Linear account",
  "github-app": "Catalyst on GitHub",
  "github-personal": "Your GitHub account",
  "ai-account": "AI account",
};
/** The checklist's reason codes in words. Codes stay in receipts; only these reach the screen. */
const REASON_WORDS: Record<string, string> = {
  not_connected: "not connected yet",
  not_installed: "not installed yet",
  lapsed: "the connection lapsed and needs connecting again",
  expired: "the connection expired and needs connecting again",
  workspace_first: "the Linear workspace needs connecting first",
  missing_permissions: "needs updated permissions",
  approval_pending:
    "waiting for an owner of your GitHub organization to approve it",
  repository_not_covered: "does not reach every project repository yet",
  none_usable: "no AI account can take work yet",
  check_unavailable: "could not be checked just now. Setup keeps checking",
};
const ITEM_IDS = new Set<string>(Object.keys(CHECKLIST_LABELS));
const STATES = new Set<string>([
  "done",
  "needed",
  "outdated",
  "waiting",
  "unknown",
]);
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** "Catalyst on GitHub: waiting for an owner of your GitHub organization to approve it." */
export function checklistItemText(item: ChecklistItem): string {
  return `${CHECKLIST_LABELS[item.id]}: ${(item.reason && REASON_WORDS[item.reason]) || "not done yet"}.`;
}

function parse(body: unknown, origin: string): Checklist | null {
  const row = object(body);
  if (
    !row ||
    row.schema !== 1 ||
    typeof row.page !== "string" ||
    typeof row.checkedAt !== "number" ||
    !Number.isFinite(row.checkedAt) ||
    !Array.isArray(row.items) ||
    row.items.length > 20
  )
    return null;
  // The page is opened in a browser: it must be this cloud's own Connect page and nothing else.
  let page: URL;
  try {
    page = new URL(row.page);
  } catch {
    return null;
  }
  if (
    page.origin !== origin ||
    page.pathname !== CONNECT_PAGE_PATH ||
    page.search ||
    page.hash ||
    page.username ||
    page.password
  )
    return null;
  const items: ChecklistItem[] = [];
  for (const value of row.items) {
    const item = object(value);
    if (!item || typeof item.id !== "string") return null;
    // A row, state or audience a newer cloud adds is not this CLI's to judge. Skipping it leaves the
    // rows this CLI knows, so the checklist stays on.
    if (
      !ITEM_IDS.has(item.id) ||
      typeof item.state !== "string" ||
      !STATES.has(item.state) ||
      (item.who !== "admin" && item.who !== "you")
    )
      continue;
    if (
      typeof item.canAct !== "boolean" ||
      !(
        (item.state === "done" && item.reason === null) ||
        (item.state !== "done" &&
          typeof item.reason === "string" &&
          /^[a-z][a-z0-9_]{1,63}$/.test(item.reason))
      ) ||
      items.some((seen) => seen.id === item.id)
    )
      return null;
    items.push({
      id: item.id as ChecklistItemId,
      state: item.state as ItemState,
      reason: item.reason as string | null,
      who: item.who,
      canAct: item.canAct,
    });
  }
  const kinds = Array.isArray(row.aiAccountKinds) ? row.aiAccountKinds : [];
  return {
    page: page.toString(),
    checkedAt: row.checkedAt,
    items,
    aiAccountKinds: kinds.includes("subscription")
      ? "subscription,api-key"
      : "api-key",
  };
}

export type ChecklistRead =
  | { checklist: Checklist }
  | { unsupported: true }
  /** `fatal`: waiting longer cannot help (the login expired or changed, or the cloud refused). */
  | { reason: string; fatal: boolean };
const LOGIN_EXPIRED: ChecklistRead = {
  reason: "onboard_login_refresh_required",
  fatal: true,
};
const IDENTITY_CHANGED: ChecklistRead = {
  reason: "connect_checklist_identity_unverified",
  fatal: true,
};

/** `unsupported` when the cloud does not advertise the checklist: the caller keeps its own routes.
 * `verified`: the origin whose contract already advertised the route this wait, so a poll reads the
 * checklist alone. A revoked login then answers 401 on the checklist itself. */
export async function readChecklist(
  ctx: Ctx,
  journal: OnboardJournal,
  signal?: AbortSignal,
  verified?: string,
): Promise<ChecklistRead> {
  if (verified !== undefined) {
    const cfg = loadConfig(ctx.home);
    if (
      !cfg?.user ||
      cfg.account !== (journal.account ?? journal.tenant) ||
      cfg.user.id !== journal.membershipId ||
      !journal.baseUrl ||
      normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(journal.baseUrl) ||
      new URL(normalizeBaseUrl(cfg.baseUrl)).origin !== verified
    )
      return IDENTITY_CHANGED;
  }
  const support =
    verified !== undefined
      ? { origin: verified }
      : await verifyOnboardRoutes(
          ctx,
          journal,
          [{ method: "GET", path: CHECKLIST_PATH }],
          signal,
        );
  if ("reason" in support) {
    if (support.reason === "cloud_capability_unavailable")
      return { unsupported: true };
    if (support.reason.endsWith("_login_refresh_required")) return LOGIN_EXPIRED;
    if (
      support.reason.endsWith("_identity_unverified") ||
      support.reason === "personal_login_required"
    )
      return IDENTITY_CHANGED;
    return {
      reason: support.reason,
      fatal: support.reason === "interrupted",
    };
  }
  const read = await readExistingOnboardJson(ctx, CHECKLIST_PATH, signal);
  if ("reason" in read) {
    if (read.reason.endsWith("_login_refresh_required")) return LOGIN_EXPIRED;
    if (
      read.reason.endsWith("_identity_unverified") ||
      read.reason === "personal_login_required"
    )
      return IDENTITY_CHANGED;
    if (read.status === 401 || read.status === 403)
      return { reason: "connect_checklist_refused", fatal: true };
    return { reason: "connect_checklist_unavailable", fatal: false };
  }
  const checklist = parse(read.body, support.origin);
  return checklist
    ? { checklist }
    : { reason: "connect_checklist_unverified", fatal: false };
}

/** What the wait shows for the Connect page: the instruction line, then the page on its own line. */
export interface ConnectPageWait {
  url: string;
  instruction: string;
}
export interface ConnectChecklistOptions {
  step: OnboardStepId;
  item: ChecklistItemId;
  /** The step's own adapter: used whole when the cloud has no checklist, and for detail it lacks. */
  fallback: OnboardAdapter;
  /** False keeps the step on its own routes even when the checklist exists (a named AI account). */
  enabled?: boolean;
  openBrowser: (url: string, signal?: AbortSignal) => void | Promise<void>;
  wait?: <T>(
    message: string,
    work: () => Promise<T>,
    page: ConnectPageWait,
  ) => Promise<T>;
  /** A line shown while the wait runs, for a row that is waiting on something or cannot be checked. */
  note?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Shared by every step in one run, so the page opens once. */
  page: { openedBy: OnboardStepId | null };
  /** Shared by every step in one run: the last read and when it was taken (ctx.now). Each read
   *  probes Linear and GitHub, so none is taken sooner than CHECKLIST_POLL_MS after the last. */
  cache: { last: { at: number; read?: ChecklistRead } | null };
  timeoutMs?: number;
}

const done = (item: ChecklistItem, checklist: Checklist): OnboardStepResult => ({
  state: "done",
  evidence: {
    provider: item.id === "github-app" ? "github" : "ai-account",
    scope: "checklist",
    checkedAt: checklist.checkedAt,
  },
});

/** CTC-4680: a step the Connect accounts page also lists. When the cloud advertises the checklist,
 * its row is the step's answer and the wait sends the person to that page. Without it, the step's
 * own status routes and links run unchanged. */
export function connectChecklistAdapter(
  options: ConnectChecklistOptions,
): OnboardAdapter {
  const { fallback } = options;
  const enabled = options.enabled !== false;
  type Row =
    | { checklist: Checklist; item: ChecklistItem }
    | { reason: string; fatal: boolean }
    | null;
  /** The row for this step; null when the cloud has none (the step keeps its own routes). */
  const read = async (
    ctx: Ctx,
    journal: OnboardJournal,
    signal?: AbortSignal,
    verified?: string,
  ): Promise<Row> => {
    if (!enabled) return null;
    const cached = options.cache.last;
    const age = cached ? ctx.now().getTime() - cached.at : Infinity;
    let result = cached && age >= 0 && age < CHECKLIST_POLL_MS ? cached.read : undefined;
    if (!result) {
      // A recent read that never answered (cut off at a deadline) still spaces the next one.
      if (age >= 0 && age < CHECKLIST_POLL_MS)
        await (options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(
          CHECKLIST_POLL_MS - age,
        );
      const at = ctx.now().getTime();
      // Recorded before the read starts, so one that is aborted still counts.
      options.cache.last = { at };
      result = await readChecklist(ctx, journal, signal, verified);
      options.cache.last = { at, read: result };
    }
    if ("unsupported" in result) return null;
    if ("reason" in result) return result;
    kinds = result.checklist.aiAccountKinds;
    const item = result.checklist.items.find((row) => row.id === options.item);
    return item ? { checklist: result.checklist, item } : null;
  };
  // The AI account step's text follows what the workspace may add, so its results carry the kinds
  // from the read that answered them. No read, no kinds: the text falls back to API keys.
  let kinds: string | undefined;
  const tagged =
    (run: NonNullable<OnboardAdapter["act"]>): NonNullable<OnboardAdapter["act"]> =>
    async (ctx, journal, signal) => {
      kinds = undefined;
      const result = await run(ctx, journal, signal);
      return options.item === "ai-account" && kinds
        ? { ...result, evidence: { ...result.evidence, aiAccountKinds: kinds } }
        : result;
    };
  const actionable = (item: ChecklistItem) =>
    item.state === "needed" && item.canAct && options.wait !== undefined;
  const adapter: Required<OnboardAdapter> = {
    check: async (ctx, journal, signal) => {
      const current = await read(ctx, journal, signal);
      if (current && "item" in current) {
        if (current.item.state === "done")
          return done(current.item, current.checklist);
        if (actionable(current.item)) return { state: "pending" };
      }
      return fallback.check(ctx, journal, signal);
    },
    act: async (ctx, journal, signal) => {
      const current = await read(ctx, journal, signal);
      if (current && "item" in current && current.item.state === "done")
        return done(current.item, current.checklist);
      // Anything the page cannot finish here (no browser wait, an admin's row, a row waiting on
      // someone else, a checklist that could not be read) keeps the step's own action and reasons.
      if (!current || !("item" in current) || !actionable(current.item) || !options.wait)
        return fallback.act
          ? fallback.act(ctx, journal, signal)
          : fallback.check(ctx, journal, signal);
      const label = CHECKLIST_LABELS[options.item];
      const url = current.checklist.page;
      // The contract advertised the route for this read; the wait's polls read the checklist alone.
      const origin = new URL(url).origin;
      let instruction: string;
      if (
        options.page.openedBy === null ||
        options.page.openedBy === options.step
      ) {
        try {
          await options.openBrowser(url, signal);
          options.page.openedBy = options.step;
          instruction = `Opened your browser. Finish "${label}" on the page.`;
        } catch {
          if (signal?.aborted) return { state: "waiting", reason: "interrupted" };
          instruction = `Open this link and finish "${label}":`;
          // The page is not a credential, so it is printed on its own line for any browser.
          ctx.stderr(
            `No browser opened on this computer. In a browser signed in to Catalyst, open this page and finish "${label}". Setup keeps waiting here.`,
          );
          ctx.stderr(url);
        }
      } else
        instruction = `Finish "${label}" on the page already open in your browser.`;
      let last: ChecklistItem = current.item;
      let finished: Checklist = current.checklist;
      let said = "";
      let failures = 0;
      const run = () =>
        pollConsent({
          timeoutMs: options.timeoutMs,
          intervalMs: CHECKLIST_POLL_MS,
          signal,
          sleep: options.sleep,
          readStatus: async (pollSignal) => {
            const next = await read(ctx, journal, pollSignal, origin);
            if (!next) return { outcome: "unavailable" };
            if (!("item" in next)) {
              // A login that expired or changed, or a refusal, will not fix itself: stop and say so.
              if (next.fatal) return { outcome: "waiting", reason: next.reason };
              if (++failures === 3)
                options.note?.(
                  "Setup could not check the Connect accounts page just now. It keeps checking.",
                );
              return { outcome: "unavailable" };
            }
            failures = 0;
            last = next.item;
            finished = next.checklist;
            if (last.state === "done") return { outcome: "connected" };
            const text =
              last.state === "needed" ? "" : checklistItemText(last);
            if (text && text !== said) options.note?.(text);
            said = text;
            return { outcome: "absent" };
          },
        });
      const result = await options.wait(`Waiting for "${label}"`, run, {
        url,
        instruction,
      });
      if (result.state === "done") return done(last, finished);
      // A row that ended waiting on someone else, or needing a change elsewhere, gets the step's
      // own detailed reason; a row still simply needed timed out and can be offered again.
      const ended = {
        state: result.state,
        reason: result.reason ?? "consent_timeout",
      };
      if (result.reason === "consent_timeout" && last.state !== "needed") {
        const detail = await fallback.check(ctx, journal, signal);
        return detail.state === "pending" ? ended : detail;
      }
      return ended;
    },
  };
  return { check: tagged(adapter.check), act: tagged(adapter.act) };
}
