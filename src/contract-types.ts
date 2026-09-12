// contract-types.ts — the SHAPE of GET /api/v1/agent/contract as this bundle reads it. Typed here
// (the cloud's own declaration lives in another repository) and filled only from the wire. No field
// below carries a default: a tenant value the contract does not serve is refused, never guessed.

export type WorkflowSlot =
  | "dispatch"
  | "intake"
  | "research"
  | "plan"
  | "implement"
  | "remediate"
  | "verify"
  | "review"
  | "pr"
  | "done"
  | "canceled";

export interface ContractLabel {
  name: string;
  unscopedId: string | null;
  teamScopedId: string | null;
  scope: "unscoped" | "team" | "absent";
  preferredId: string | null;
}

export interface ContractStage {
  stateId: string;
  name: string | null;
  type: string | null;
  stateStillExists: boolean;
  source: string;
}

export interface ContractReadinessCheck {
  id: string;
  state: "pass" | "fail" | "unknown";
  reason?: string;
  count?: number;
}

export interface ContractTeam {
  id: string;
  key: string | null;
  name: string | null;
  workflowMode: string;
  gitAutomation: string;
  stages: Partial<Record<WorkflowSlot, ContractStage>>;
  labels: { ask: ContractLabel[]; hold: ContractLabel[]; release: ContractLabel[] };
  readiness: {
    status: "ready" | "degraded" | "blocked" | "unchecked";
    checks: ContractReadinessCheck[];
    checkedAt: number | null;
    expiresAt: number | null;
    workflowRev: number | null;
  };
}

export interface ContractRoute {
  method: "GET" | "POST";
  path: string;
  takesWriteBudgetUnit: boolean;
  since: string;
}

export interface TenantContract {
  contractVersion: string;
  protocolVersion: number;
  cache: { maxAgeSeconds: number; staleRefusalSeconds: number };
  account: {
    id: string;
    slug: string;
    name: string;
    linearWorkspaceId: string | null;
    linearWorkspaceSlug: string | null;
  };
  apiPrefix: string;
  slots: readonly WorkflowSlot[];
  routes: readonly ContractRoute[];
  teams: ContractTeam[];
  vocabulary: {
    askLabelPrefix: string;
    askPhaseLabelPrefix: string;
    askMarkerLabel: string;
    releaseLabel: string;
    bookkeeping: {
      marker: string;
      prefixOnly: boolean;
      asciiCaseInsensitive: boolean;
      leadingWhitespaceTrimmed: boolean;
    };
  };
  askTemplate: {
    headings: { ask: string; options: string; defaultIfSilent: string; howToAnswer: string };
    howToAnswer: { withOptions: string; withoutOptions: string };
    optionBulletFormat: string;
    maxLetteredOptions: number;
    maxAskGenerations: number;
    example: string;
  };
  ladder: {
    phases: readonly string[];
    keying: string;
    keyingScope: string;
    intakeEnabled: boolean;
    advance: readonly {
      phase: string;
      result: "ok" | "failed";
      fromSlots: readonly WorkflowSlot[] | null;
      toSlot: WorkflowSlot | null;
      because: string;
    }[];
  };
  thresholds: {
    scope: string;
    parkAfterConsecutiveFailures: number;
    remediateRoundCap: number;
    remediateEscalatedRoundBudget: number;
    remediateRewindBudget: number;
    retryBackoffMs: readonly number[];
    hostDailyWriteBudget: number;
  };
  merge: {
    policies: readonly string[];
    defaultPolicy: string;
    repositories: readonly {
      repoId: string;
      owner: string;
      name: string;
      policy: string;
      policySource: "repo" | "tenant" | "default";
    }[];
    reviewerLogin: string;
    cleanPassShapes: readonly { kind: string; description: string; honoured: boolean; ticket: string | null }[];
    cloudRemediateRequiredChecks: readonly string[];
    prLabels: { queueReady: string; handStepsHold: string; hold: string; preview: string };
  };
  /** The customer skill bundle the cloud expects, when it publishes one (catalyst-cloud#3746). OPTIONAL:
   *  an older cloud omits it, and `ready` reads it defensively — an absent field emits nothing. */
  skillsBundle?: { package: string; minVersion: string };
  readinessChecks: readonly { id: string; severity: string; needsAnswer: boolean }[];
  humans: readonly { linearUserId: string; role: "owner" | "admin" }[];
  asks: { approvalsTeamId: string | null };
}
