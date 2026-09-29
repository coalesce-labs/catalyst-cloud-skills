// readiness-copy.ts: the plain sentences `ready` prints for a team's readiness checks (CTC-4398).
// The contract serves each check's id, state and reason slug, never member-readable words. The
// words are catalyst-cloud's own `CHECK_COPY` / `FAIL_REASON_COPY` (packages/types/src/
// workflow-readiness.ts), shortened to one sentence each; keep the two in step. A check id or
// reason this table lacks falls back to a sentence that still names the id, since that is the only
// thing a reader could search for.
import type { ContractReadinessCheck } from "./contract-types.js";

/** Linear's own Git automation rules, by check id, as Linear's Git automation screen names them. */
export const LINEAR_AUTOMATION_RULES: Readonly<Record<string, string>> = {
  linear_automation_pr_open: "On PR open",
  linear_automation_pr_review: "On PR review request or activity",
  linear_automation_pr_ready: "On PR ready for merge",
  linear_automation_pr_merge: "On PR merge",
};

interface Copy {
  fail: string;
  unknown: string;
  /** What to change. Settings paths are the app's own menu names. */
  fix: string;
  /** Per-reason sentence and fix, where the check's own would say too little. */
  reasons?: Readonly<Record<string, { line: string; fix?: string }>>;
}

const RECHECK_SOON = "re-check shortly";

const COPY: Readonly<Record<string, Copy>> = {
  oauth_scope: {
    fail: "Catalyst is missing a Linear permission it needs.",
    unknown: `Catalyst could not confirm its Linear permissions just now; ${RECHECK_SOON}.`,
    fix: "Reconnect Linear in Catalyst settings to grant the missing permission.",
  },
  token_live: {
    fail: "Linear no longer accepts Catalyst's connection.",
    unknown: `Catalyst could not reach Linear just now; ${RECHECK_SOON}.`,
    fix: "Reconnect Linear in Catalyst settings, then re-check the team.",
  },
  team_visible: {
    fail: "Catalyst cannot see this team in Linear, most often because it was made private.",
    unknown: `Catalyst could not confirm it can see this team; ${RECHECK_SOON}.`,
    fix: "In Linear, give Catalyst access to this team, then re-check it.",
  },
  mapped_states_exist: {
    fail: "Catalyst's stage mapping points at Linear states that no longer exist.",
    unknown: `Catalyst could not read this team's states just now; ${RECHECK_SOON}.`,
    fix: "Map this team's stages again in Catalyst settings.",
  },
  mapping_total: {
    fail: "Catalyst does not know which Linear state to use for every stage it moves issues into.",
    unknown: `Catalyst could not check which stages are mapped; ${RECHECK_SOON}.`,
    fix: "Map the missing stages for this team in Catalyst settings.",
    reasons: {
      mapping_absent: { line: "This team's stages are not mapped to Catalyst's yet. Nothing is missing from your Linear." },
    },
  },
  types_compatible: {
    fail: "A mapped Linear state is the wrong kind for its stage, for example a completed state where work should start.",
    unknown: `Catalyst could not compare this team's state kinds just now; ${RECHECK_SOON}.`,
    fix: "Map that stage to a state of the right kind in Catalyst settings.",
  },
  labels_present: {
    fail: "Labels Catalyst uses are missing from this Linear workspace.",
    unknown: `Catalyst could not read this workspace's labels just now; ${RECHECK_SOON}.`,
    fix: "Adopt this team's workflow in Catalyst settings; Catalyst then creates the labels.",
  },
  writes_land: {
    fail: "Linear refused Catalyst's last write to this team.",
    unknown: "Catalyst confirms this the first time it moves an issue in this team.",
    fix: "Check that Catalyst's Linear connection can still edit this team, then re-check it.",
  },
  webhook_covers_team: {
    fail: "Linear events are not arriving for this team yet.",
    unknown: "Catalyst confirms this once Linear events arrive for this team.",
    fix: "Check the Linear connection in Catalyst settings.",
    reasons: {
      delivery_unattributed: { line: "Linear events are arriving, but none could be tied to this team yet, so Catalyst cannot confirm it hears this team." },
    },
  },
  hosts_current: {
    fail: "A connected Catalyst host still runs an older version of this team's mapping.",
    unknown: "Catalyst confirms this once a host connects and reports the mapping it loaded.",
    fix: "Restart that host so it reconnects and loads the current mapping.",
  },
  environment_declared: {
    fail: "This team's repository has no approved environment declaration (.catalyst/catalyst.toml) in effect.",
    unknown: "Catalyst confirms this once it can read the repository's declaration.",
    fix: "Commit a .catalyst/catalyst.toml to the repository and have an owner or admin approve it.",
    reasons: {
      no_team_repo_default: {
        line: "This team has no default repository yet, so there is no environment declaration to read.",
        fix: "Register a repository for this team under Settings → Repositories and make it the default.",
      },
      no_environment_declaration: {
        line: "This team's repository has no .catalyst/catalyst.toml on its default branch, so work runs with no declared environment.",
        fix: "Commit a .catalyst/catalyst.toml to the repository's default branch; the catalyst-onboard skill writes it with you.",
      },
      declaration_invalid: {
        line: "The .catalyst/catalyst.toml on this team's repository does not validate.",
        fix: "Fix the field the repository's Environment page names, and merge the fix.",
      },
      declaration_read_failed: {
        line: "Catalyst could not read this team's .catalyst/catalyst.toml on the last push to the default branch.",
        fix: "Push to the default branch again; the next push retries the read.",
      },
      declaration_awaiting_approval: {
        line: "This team's environment declaration is proposed and waits for an owner or admin to approve it.",
        fix: "Open Settings → Repositories → the repository → Environment, go to the Setup declaration tab, and press Approve this revision.",
      },
    },
  },
  tools_resolvable: {
    fail: "A declared MCP server names a secret that does not exist, or a declared CLI is not in the runner image.",
    unknown: "Catalyst confirms this once it can read the environment declarations.",
    fix: "Add the missing secret under Settings → Environment, or remove the tool from the declaration.",
  },
  required_values: {
    fail: "A variable this team's repository requires has no value, or references a secret with no value.",
    unknown: "Catalyst confirms this once it can read the repository's declared variables.",
    fix: "Set the missing values on the repository's Environment page under Settings → Repositories.",
  },
  reviewer_required: {
    fail: "This team's repository needs a reviewer's sign-off to merge and has no reviewer, so every pull request waits for a human approval.",
    unknown: "Catalyst confirms this once a repository is mapped to this team.",
    fix: "Configure a reviewer under Settings → Repositories → Code reviews, or change the repository's merge policy.",
  },
  reviewer_configured: {
    fail: "No code reviewer is configured for this team's repository, so pull requests merge on green checks alone.",
    unknown: "Catalyst confirms this once a repository is mapped to this team.",
    fix: "Configure a reviewer under Settings → Repositories → Code reviews.",
  },
  reviewer_answering: {
    fail: "A configured code reviewer has never answered on this team's repository, and a review request to it has timed out.",
    unknown: "Catalyst confirms this once a reviewer has been asked for a review.",
    fix: "Check that the reviewer's GitHub app is installed on the repository, then widen its response window or remove it under Settings → Repositories → Code reviews.",
  },
  merge_queue_configured: {
    fail: "No merge queue is configured for this team's repository, so Catalyst can open pull requests but cannot merge them.",
    unknown: "Catalyst confirms this once it can read the repository's merge settings.",
    fix: "In GitHub, turn on Require merge queue for the default branch, or commit a .mergify.yml that queues pull requests.",
  },
  coding_account_enrolled: {
    fail: "No coding account is enrolled, so no agent can run work.",
    unknown: "Catalyst confirms this once it can read the coding accounts.",
    fix: "Enroll a coding account under Settings → Coding accounts.",
  },
  github_app_installed: {
    fail: "The Catalyst GitHub app is not installed on this team's repository.",
    unknown: "Catalyst confirms this once it can read the repository's installation.",
    fix: "Install the Catalyst GitHub app on the repository.",
  },
};

/** A readiness check as one plain sentence, without the `team X:` label. */
export function checkSentence(c: Pick<ContractReadinessCheck, "id" | "state" | "reason" | "count">): string {
  const rule = LINEAR_AUTOMATION_RULES[c.id];
  if (rule !== undefined) {
    return c.state === "unknown"
      ? `Catalyst could not read Linear's "${rule}" Git automation for this team, so check it yourself in Linear.`
      : `Linear's "${rule}" Git automation moves this team's issues itself, which conflicts with the stage moves Catalyst makes.`;
  }
  const copy = COPY[c.id];
  if (copy === undefined) {
    const why = c.reason ? ` (${c.reason}${c.count !== undefined ? ` ×${c.count}` : ""})` : "";
    return c.state === "unknown" ? `Catalyst could not confirm the ${c.id} check yet${why}.` : `The ${c.id} check failed${why}.`;
  }
  if (c.state === "unknown") return (c.reason && copy.reasons?.[c.reason]?.line) || copy.unknown;
  if (c.id === "labels_present" && c.count !== undefined && c.count > 0) {
    return `${c.count} ${c.count === 1 ? "label" : "labels"} Catalyst uses ${c.count === 1 ? "is" : "are"} missing from this Linear workspace.`;
  }
  return (c.reason && copy.reasons?.[c.reason]?.line) || copy.fail;
}

/** What to change for a check, in plain words, or null when this table has none. */
export function checkFix(c: Pick<ContractReadinessCheck, "id" | "reason">, teamLabel: string): string | null {
  const rule = LINEAR_AUTOMATION_RULES[c.id];
  if (rule !== undefined) {
    return (
      `In Linear, open Settings → Teams → ${teamLabel} → Workflow → Git automations and set "${rule}" to No action, ` +
      "or point it at the state Catalyst maps for that stage. Catalyst moves the issue itself."
    );
  }
  const copy = COPY[c.id];
  if (copy === undefined) return null;
  return (c.reason && copy.reasons?.[c.reason]?.fix) || copy.fix;
}
