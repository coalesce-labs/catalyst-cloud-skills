import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import { verifyOnboardRoutes } from "./onboard-capabilities.js";
import {
  onboardStatePath,
  writeOnboardJournal,
  type OnboardJournal,
} from "./onboard.js";

/** The picker's value for "Create a new Linear team…". Never a team ID: those start with a letter or digit. */
export const CREATE_TEAM_CHOICE = ":create";
export const TEAM_CREATE_PATH = "/api/v1/agent/linear/team";

/** Whether the picker offers team creation, and if it cannot be chosen, why. */
export type TeamCreateOffer =
  { available: true } | { available: false; reason: string };

export interface NewTeamAnswer {
  name: string;
  key: string;
}
/** What the naming prompt starts from: the last answer, and why it is being asked again. */
export interface NewTeamQuestion {
  name?: string;
  key?: string;
  problem?: string;
}

export const MEMBER_CANNOT_CREATE =
  "Creating a Linear team needs a Catalyst workspace owner or admin.";

// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const KEY = /^[A-Z][A-Z0-9]{0,6}$/;

/** Why a team name cannot be used, or undefined when it can. */
export function teamNameProblem(value: string | undefined): string | undefined {
  const name = (value ?? "").trim();
  return !name || name.length > 80 || CONTROL.test(name)
    ? "Enter a team name of 1 to 80 characters."
    : undefined;
}

/** Why a team key cannot be used, or undefined when it can. Lower case is accepted and upper-cased. */
export function teamKeyProblem(value: string | undefined): string | undefined {
  return KEY.test((value ?? "").trim().toUpperCase())
    ? undefined
    : "A key starts with a letter and has up to 7 letters or digits, like MOB.";
}

/** A key suggested from the name: the initials of a several-word name, or a one-word name's first three letters. */
export function suggestTeamKey(name: string): string {
  const words = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const raw =
    words.length > 1
      ? words.map((word) => word[0]).join("")
      : (words[0] ?? "").slice(0, 3);
  const key = raw.replace(/^[0-9]+/, "").slice(0, 5);
  return key || "TEAM";
}

/** The picker's create option for this person, or undefined when this cloud does not offer it. */
export async function teamCreateOffer(
  ctx: Ctx,
  journal: OnboardJournal,
  signal?: AbortSignal,
): Promise<TeamCreateOffer | undefined> {
  const support = await verifyOnboardRoutes(
    ctx,
    journal,
    [{ method: "POST", path: TEAM_CREATE_PATH }],
    signal,
  );
  if ("reason" in support) return undefined;
  const role = loadConfig(ctx.home)?.user?.role;
  return role === "owner" || role === "admin"
    ? { available: true }
    : { available: false, reason: MEMBER_CANNOT_CREATE };
}

export type TeamCreateReply =
  | {
      kind: "created";
      team: { id: string; key: string; name: string };
      adoption: { adopted: true } | { adopted: false; reason: string };
    }
  | { kind: "reask"; message: string }
  | { kind: "refused"; message: string; linearMessage?: string }
  | { kind: "failed"; reason: string; message?: string; key?: string };

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
// Server text reaches the terminal only without control characters, and bounded.
const text = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim()
    ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 240)
    : fallback;

/** POST the new team. Every outcome is named; nothing here selects a team. */
export async function postNewTeam(
  ctx: Ctx,
  journal: OnboardJournal,
  answer: NewTeamAnswer,
  external?: AbortSignal,
  uncertainKey?: string,
): Promise<TeamCreateReply> {
  const cfg = loadConfig(ctx.home);
  if (
    !cfg?.user ||
    cfg.account !== (journal.account ?? journal.tenant) ||
    cfg.user.id !== journal.membershipId ||
    !journal.baseUrl ||
    normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(journal.baseUrl)
  )
    return { kind: "failed", reason: "team_create_identity_unverified" };
  const expiry = cfg.auth
    ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime()
    : 0;
  const bearer =
    cfg.key ||
    (cfg.auth && Number.isFinite(expiry) && expiry > 30_000
      ? cfg.auth.accessToken
      : undefined);
  if (!bearer)
    return { kind: "failed", reason: "team_read_login_refresh_required" };
  const key = answer.key.trim().toUpperCase();
  const previous = journal.steps.find((step) => step.id === "linear.team");
  const recoveryKey =
    uncertainKey ??
    (previous?.reason === "team_create_unverified" &&
    typeof previous.evidence?.teamKey === "string"
      ? previous.evidence.teamKey
      : undefined);
  // Resolve the outstanding result before allowing a different key to create a second team.
  if (recoveryKey && recoveryKey !== key)
    return {
      kind: "failed",
      reason: "team_create_unverified",
      key: recoveryKey,
    };
  const owned = new AbortController();
  const signal = external
    ? AbortSignal.any([external, owned.signal])
    : owned.signal;
  // Creating a team and adopting the workflow on it is several Linear writes; allow longer than a read.
  const timer = setTimeout(() => owned.abort(), 60_000);
  let remove = () => {};
  let sent = false;
  try {
    return await new Promise<TeamCreateReply>((resolve) => {
      const stopped = () =>
        resolve({
          kind: "failed",
          reason:
            sent || recoveryKey ? "team_create_unverified" : "interrupted",
          ...(sent || recoveryKey ? { key: recoveryKey ?? key } : {}),
        });
      if (signal.aborted) {
        stopped();
        return;
      }
      signal.addEventListener("abort", stopped, { once: true });
      remove = () => signal.removeEventListener("abort", stopped);
      Promise.resolve()
        .then(async (): Promise<TeamCreateReply> => {
          if (signal.aborted) return { kind: "failed", reason: "interrupted" };
          // Save before sending: SIGINT and a killed process must leave the attempted key on disk.
          const pending = {
            id: "linear.team" as const,
            state: "waiting" as const,
            reason: "team_create_unverified",
            evidence: { teamKey: key },
            at: ctx.now().toISOString(),
          };
          const index = journal.steps.findIndex(
            (step) => step.id === "linear.team",
          );
          if (index === -1) journal.steps.push(pending);
          else journal.steps[index] = pending;
          writeOnboardJournal(onboardStatePath(ctx.home, ctx.env), journal);
          sent = true;
          const response = await ctx.fetch(
            `${normalizeBaseUrl(cfg.baseUrl)}${TEAM_CREATE_PATH}`,
            {
              method: "POST",
              redirect: "error",
              signal,
              headers: {
                authorization: `Bearer ${bearer}`,
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify({
                name: answer.name.trim(),
                key,
              }),
            },
          );
          const body = object(await response.json().catch(() => null)) ?? {};
          const reply =
            recoveryKey &&
            response.status === 409 &&
            (body.error === "key-taken" || body.error === "name-taken")
              ? {
                  kind: "failed" as const,
                  reason: "team_create_unverified",
                  key,
                }
              : readReply(response.status, body, key);
          if (signal.aborted)
            return { kind: "failed", reason: "team_create_unverified", key };
          if (reply.kind === "created") {
            // Preserve a confirmed creation too, in case interruption happens during inventory readback.
            journal.steps[index === -1 ? journal.steps.length - 1 : index] = {
              id: "linear.team",
              state: "waiting",
              reason: "team_created_not_adopted",
              evidence: { team: reply.team.id, teamKey: reply.team.key },
              at: ctx.now().toISOString(),
            };
          } else if (!recoveryKey && !(reply.kind === "failed" && reply.key)) {
            journal.steps[index === -1 ? journal.steps.length - 1 : index] = {
              id: "linear.team",
              state: "running",
              at: ctx.now().toISOString(),
            };
          }
          writeOnboardJournal(onboardStatePath(ctx.home, ctx.env), journal);
          return reply;
        })
        .then(
          (reply) => (signal.aborted ? stopped() : resolve(reply)),
          () =>
            signal.aborted
              ? stopped()
              : resolve({
                  kind: "failed",
                  reason: "team_create_unverified",
                  key,
                }),
        );
    });
  } finally {
    clearTimeout(timer);
    remove();
    owned.abort();
  }
}

function readReply(
  status: number,
  body: Record<string, unknown>,
  key: string,
): TeamCreateReply {
  if (status === 201) {
    const team = object(body.team);
    const adoption = object(body.adoption);
    if (
      !team ||
      typeof team.id !== "string" ||
      !idPattern.test(team.id) ||
      typeof team.key !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(team.key) ||
      typeof team.name !== "string" ||
      (adoption?.outcome !== "adopted" && adoption?.outcome !== "not-adopted")
    )
      // The team exists but this answer cannot be trusted to say which it is or how far Adopt got.
      return { kind: "failed", reason: "team_create_unverified", key };
    return {
      kind: "created",
      team: { id: team.id, key: team.key, name: text(team.name, team.key) },
      adoption:
        adoption.outcome === "adopted"
          ? { adopted: true }
          : {
              adopted: false,
              reason: text(adoption.reason, "the adoption did not complete"),
            },
    };
  }
  // Only an answer about the name or key itself asks for another one. Anything else re-asked here
  // would loop a person through the naming prompt for a problem a new name cannot fix.
  if (
    (status === 409 &&
      (body.error === "key-taken" || body.error === "name-taken")) ||
    (status === 400 &&
      (body.error === "invalid-name" || body.error === "invalid-key")) ||
    (status === 422 && body.error === "linear-rejected")
  )
    return {
      kind: "reask",
      message: text(
        body.linearMessage ?? body.message,
        "Linear did not accept that team. Choose another name or key.",
      ),
    };
  if (status === 403 && body.error === "linear-refused")
    return {
      kind: "refused",
      message: text(
        body.message,
        "Linear did not let you create a team. Ask a workspace admin, or create the team in Linear, then pick it here.",
      ),
      ...(typeof body.linearMessage === "string"
        ? { linearMessage: text(body.linearMessage, "") }
        : {}),
    };
  if (status === 403 && body.error === "not-an-admin")
    return { kind: "refused", message: MEMBER_CANNOT_CREATE };
  // The person's own Linear authorization: missing, unknown or lapsed. Nothing was created.
  if (
    (status === 400 || status === 401) &&
    (body.error === "no-grant" ||
      body.error === "identity-unknown" ||
      body.error === "expired")
  )
    return {
      kind: "failed",
      reason: "team_create_grant_required",
      message: text(body.reason, ""),
    };
  // Linear's answer was lost and the team could not be read back: it may exist.
  if (status === 502 && body.error === "linear-unconfirmed")
    return {
      kind: "failed",
      reason: "team_create_unverified",
      message: text(body.message, ""),
      key,
    };
  // Only the route's explicit no-create outcomes permit a fresh attempt. A proxy, timeout or
  // Worker failure can lose the answer after the mutation, so an unnamed response is uncertain.
  if (
    (status === 503 && body.error === "linear-unavailable") ||
    (status === 404 && body.error === "team-create-unavailable") ||
    (status === 502 && body.error === "linear-schema-error")
  )
    return {
      kind: "failed",
      reason: "team_create_unavailable",
      message: text(body.message ?? body.reason, ""),
    };
  return {
    kind: "failed",
    reason: "team_create_unverified",
    key,
  };
}
