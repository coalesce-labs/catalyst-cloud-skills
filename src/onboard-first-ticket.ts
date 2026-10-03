import { loadConfig, type Ctx } from "./config.js";
import { loadContract, readContractCache } from "./contract.js";
import { CliError } from "./errors.js";
import { selectedOnboardTeam } from "./onboard-existing.js";
import { dispatchStageName } from "./onboard-next.js";
import {
  onboardStatePath,
  writeOnboardJournal,
  type OnboardAdapter,
  type OnboardStep,
  type OnboardStepResult,
} from "./onboard.js";
import { fetchPage } from "./pagination.js";
import { apiClient } from "./transport.js";
import { postAgent } from "./write.js";

export interface FirstTicketOption {
  identifier: string;
  title: string;
  estimate: number | null;
}
/** The person's answer: a ticket identifier from the offered list, or one of these two. */
export const FIRST_TICKET_SAMPLE = "create-sample";
export const FIRST_TICKET_SKIP = "skip";

// A documentation-only starter: it changes one file and no code, so a first run is safe to watch.
const SAMPLE_TITLE = "Document how to run repository tests";
const SAMPLE_DESCRIPTION =
  "Update only CONTRIBUTING.md to document existing test commands from repository configuration. Do not change executable code, configuration, dependencies, or credentials. If the test commands cannot be established from source, stop and report the missing information.";
/** Linear's state types for a ticket nobody has started. */
const OPEN_TYPES = new Set(["triage", "backlog", "unstarted"]);
const IDENTIFIER = /^[A-Z][A-Z0-9]{0,7}-[0-9]{1,9}$/;
const waiting = (reason: string): OnboardStepResult => ({ state: "waiting", reason });

function linearUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "linear.app" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** A recorded outcome is kept: a moved ticket stays moved, and a skip stays the person's choice. */
function recorded(step: OnboardStep | undefined): OnboardStepResult | undefined {
  const ticket = step?.evidence?.ticket;
  if (step?.state === "done" && typeof ticket === "string" && IDENTIFIER.test(ticket))
    return { state: "done", evidence: { ...step.evidence } };
  if (step?.state === "skipped" && step.reason === "first_ticket_skipped")
    return {
      state: "skipped",
      reason: "first_ticket_skipped",
      ...(typeof step.evidence?.stage === "string" ? { evidence: { stage: step.evidence.stage } } : {}),
    };
  return undefined;
}

/** What this setup already chose, saved in the receipt before any write: a ticket identifier or the
 * sample. A run that stopped after the write, or lost its answer, finishes that choice instead of
 * offering the list again, so it can never move a second ticket. */
const CHOSEN = /:first-ticket:([A-Z][A-Z0-9]{0,7}-[0-9]{1,9}|sample)$/;

/** Interactive only. The person picks one of the team's open tickets (smallest estimate first), a
 * documentation-only sample, or skips. The chosen ticket moves to the team's dispatch stage through
 * the same write route `catalyst write state` uses; a sample is created straight into it. Without
 * `choose` (--yes, JSON, headless) the step only waits: it never lists, picks or creates a ticket.
 * Done means the ticket is in the dispatch stage, not that a runner has started it. */
export function onboardFirstTicketAdapter(hooks: {
  choose?: (
    tickets: FirstTicketOption[],
    where: { teamKey: string; stage: string },
  ) => Promise<string | null>;
}): OnboardAdapter {
  // The engine checks again right after an action, before the receipt holds its evidence.
  let acted: OnboardStepResult | undefined;
  return {
    check: async (ctx, journal) => {
      const kept = acted ?? recorded(journal.steps.find((step) => step.id === "first-ticket"));
      if (kept) return kept;
      if (hooks.choose) return { state: "pending" };
      // The contract this computer already has names the stage; no network read and no listing.
      const teamId = selectedOnboardTeam(journal);
      const stage = teamId
        ? readContractCache(ctx.home)?.doc.teams.find((team) => team.id === teamId)?.stages.dispatch?.name
        : undefined;
      return {
        ...waiting("first_ticket_choice_required"),
        ...(typeof stage === "string" ? { evidence: { stage } } : {}),
      };
    },
    act: async (ctx: Ctx, journal, signal) => {
      if (!hooks.choose) return waiting("first_ticket_choice_required");
      const cfg = loadConfig(ctx.home);
      const teamId = selectedOnboardTeam(journal);
      if (!cfg || !teamId) return waiting("first_ticket_team_unverified");
      let stage: string | undefined;
      let writing = false;
      const result = (
        state: OnboardStepResult["state"],
        reason?: string,
        evidence: NonNullable<OnboardStepResult["evidence"]> = {},
      ): OnboardStepResult => ({
        state,
        ...(reason ? { reason } : {}),
        ...(stage || Object.keys(evidence).length
          ? { evidence: { ...evidence, ...(stage ? { stage } : {}) } }
          : {}),
      });
      try {
        const { doc } = await loadContract(ctx, cfg, { refresh: true, signal });
        const team = doc.teams.find((row) => row.id === teamId);
        const dispatch = team?.stages.dispatch;
        if (!team?.key || !dispatch?.stateStillExists)
          return waiting("first_ticket_dispatch_unmapped");
        stage = dispatch.name ?? undefined;
        const api = apiClient(cfg, ctx);
        const catalystStages = new Set(
          Object.values(team.stages).map((row) => row?.stateId),
        );
        const slug = doc.account.linearWorkspaceSlug;
        const done = (identifier: unknown, url?: string) => {
          if (typeof identifier !== "string" || !IDENTIFIER.test(identifier))
            return result("waiting", "first_ticket_unverified");
          url ??=
            slug && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(slug)
              ? `https://linear.app/${slug}/issue/${identifier}`
              : undefined;
          return (acted = result("done", undefined, {
            ticket: identifier,
            teamKey: team.key!,
            ...(url ? { url } : {}),
          }));
        };
        const createSample = async () => {
          writing = true;
          const created = await postAgent<Record<string, unknown>>(api, doc, "issue-create", {
            teamId: team.id,
            title: SAMPLE_TITLE,
            description: SAMPLE_DESCRIPTION,
            stateId: dispatch.stateId,
            // The same key on every run of this setup: a resent create answers with the first ticket.
            idempotencyId: `${journal.runId}:first-ticket`,
          });
          return done(created?.identifier, linearUrl(created?.url));
        };
        const move = async (issueId: string, identifier: string, url?: string) => {
          writing = true;
          await postAgent(api, doc, "issue-state", { issueId, stateId: dispatch.stateId });
          return done(identifier, url);
        };
        const page = await fetchPage(api, "/api/v1/issues", {
          team_key: team.key,
          limit: 200,
        });
        const chosen = CHOSEN.exec(journal.operations?.["first-ticket"] ?? "")?.[1];
        if (chosen === "sample") return await createSample();
        if (chosen) {
          const detail = await api.getJson<Record<string, unknown>>(
            `/api/v1/issues/${encodeURIComponent(chosen)}`,
            { accept: [404] },
          );
          const row = detail.status === 404 ? undefined : detail.body;
          const url = linearUrl(row?.url);
          // Already in a Catalyst stage: the move landed, or Catalyst has taken it further.
          if (row && catalystStages.has(String(row.state_id))) return done(chosen, url);
          // Still open: the move never landed, so it is sent again for the same ticket only.
          if (row && typeof row.id === "string" && !row.completed_at && !row.canceled_at)
            return await move(row.id, chosen, url);
          // Closed some other way: the choice no longer stands, so the person chooses again.
        }
        const open = page.rows
          .filter(
            (row) =>
              row.team_id === team.id &&
              typeof row.id === "string" &&
              typeof row.identifier === "string" &&
              IDENTIFIER.test(row.identifier) &&
              OPEN_TYPES.has(String(row.state_type)) &&
              !catalystStages.has(String(row.state_id)),
          )
          .map((row) => ({
            id: row.id as string,
            identifier: row.identifier as string,
            title: String(row.title ?? "")
              .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
              .slice(0, 120),
            estimate:
              typeof row.estimate === "number" && Number.isFinite(row.estimate)
                ? row.estimate
                : null,
          }))
          .sort(
            (a, b) =>
              (a.estimate ?? Infinity) - (b.estimate ?? Infinity) ||
              Number(a.identifier.split("-")[1]) - Number(b.identifier.split("-")[1]),
          )
          .slice(0, 5);
        const choice = await hooks.choose(
          open.map(({ identifier, title, estimate }) => ({ identifier, title, estimate })),
          { teamKey: team.key, stage: dispatchStageName(stage) },
        );
        if (choice === null || signal?.aborted) return waiting("interrupted");
        if (choice === FIRST_TICKET_SKIP)
          return (acted = result("skipped", "first_ticket_skipped"));
        const ticket = open.find((row) => row.identifier === choice);
        if (choice !== FIRST_TICKET_SAMPLE && !ticket)
          return result("waiting", "first_ticket_choice_required");
        journal.operations = {
          ...journal.operations,
          "first-ticket": `${journal.runId}:first-ticket:${ticket ? ticket.identifier : "sample"}`,
        };
        writeOnboardJournal(onboardStatePath(ctx.home, ctx.env), journal);
        return ticket ? await move(ticket.id, ticket.identifier) : await createSample();
      } catch (error) {
        if (signal?.aborted) return waiting("interrupted");
        const refused = error instanceof CliError && error.status === 403;
        // A refused write changed nothing, so the choice is forgotten and the next run asks again.
        if (refused && writing)
          journal.operations = {
            ...journal.operations,
            "first-ticket": `${journal.runId}:first-ticket`,
          };
        return result("waiting", refused ? "first_ticket_move_refused" : "first_ticket_unavailable");
      }
    },
  };
}
