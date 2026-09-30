import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { envFileInventory, filterEnvFileNames } from "./parse-env.js";

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SNAPSHOT_KEY = randomBytes(32);

/** Selection plans and receipts intentionally carry identifiers only. Values stay inside the
 * executor's callback and are never returned to Q4 orchestration. */
export interface SelectedNameImportPlan {
  readonly state: "ready" | "rejected";
  readonly requestedNames: readonly string[];
  readonly selectedNames: readonly string[];
  readonly missingNames: readonly string[];
  readonly unknownNames: readonly string[];
  readonly duplicateNames: readonly string[];
  readonly invalidNameCount: number;
  /** Process-local keyed snapshot binding the reviewed selection to the exact source bytes. */
  readonly snapshotId: string;
}

export interface SelectedNameImportResult {
  state: "written" | "rejected";
  requestedNames: string[];
  selectedNames: string[];
  writtenNames: string[];
  failedNames: string[];
  missingNames: string[];
  unknownNames: string[];
  duplicateNames: string[];
  invalidNameCount: number;
  count: { selected: number; written: number; failed: number };
}

export interface SelectedNameImportWriteResult {
  writtenNames?: readonly string[];
  failedNames?: readonly string[];
}

export type SelectedNameImportWriter = (
  selectedText: string,
  selectedNames: readonly string[],
) => Promise<SelectedNameImportWriteResult>;

function normalizeNames(names: readonly string[]): {
  names: string[];
  invalidNameCount: number;
} {
  const valid = new Set<string>();
  let invalidNameCount = 0;
  for (const entry of names) {
    for (const raw of entry.split(",")) {
      const name = raw.trim();
      if (name === "") continue;
      if (!NAME_RE.test(name)) invalidNameCount += 1;
      else valid.add(name);
    }
  }
  return {
    names: [...valid].sort((a, b) => a.localeCompare(b, "en")),
    invalidNameCount,
  };
}

function snapshotId(text: string, requestedNames: readonly string[]): string {
  return createHmac("sha256", SNAPSHOT_KEY)
    .update(JSON.stringify([text, requestedNames]))
    .digest("hex");
}

function matchesSnapshot(
  text: string,
  names: readonly string[],
  expected: string,
): boolean {
  const actual = Buffer.from(snapshotId(text, names), "hex");
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** Plan one explicit Q4 selection against a file and declaration allowlist. Invalid input is
 * reduced to a count before it can enter the plan. `allowedNames` is deliberately not retained. */
function planSelectedNameImport(input: {
  requestedNames: readonly string[];
  availableNames: readonly string[];
  duplicateNames?: readonly string[];
  allowedNames: readonly string[];
}): SelectedNameImportPlan {
  const requested = normalizeNames(input.requestedNames);
  const available = normalizeNames(input.availableNames);
  const allowlist = normalizeNames(input.allowedNames);
  const duplicates = normalizeNames(input.duplicateNames ?? []);
  const allowed = new Set(allowlist.names);
  const availableSet = new Set(available.names);
  const requestedNames = requested.names;
  const selectedNames = requestedNames.filter(
    (name) => allowed.has(name) && availableSet.has(name),
  );
  const unknownNames = requestedNames.filter((name) => !allowed.has(name));
  const missingNames = requestedNames.filter(
    (name) => allowed.has(name) && !availableSet.has(name),
  );
  const selectedDuplicates = duplicates.names.filter((name) =>
    selectedNames.includes(name),
  );
  const invalidNameCount =
    requested.invalidNameCount +
    available.invalidNameCount +
    allowlist.invalidNameCount +
    duplicates.invalidNameCount;
  const state =
    invalidNameCount === 0 &&
    unknownNames.length === 0 &&
    missingNames.length === 0 &&
    selectedDuplicates.length === 0
      ? "ready"
      : "rejected";
  const plan = {
    state,
    requestedNames,
    selectedNames,
    missingNames,
    unknownNames,
    duplicateNames: selectedDuplicates,
    invalidNameCount,
    snapshotId: "",
  } as const;
  return Object.freeze({
    ...plan,
    requestedNames: Object.freeze([...requestedNames]),
    selectedNames: Object.freeze([...selectedNames]),
    missingNames: Object.freeze([...missingNames]),
    unknownNames: Object.freeze([...unknownNames]),
    duplicateNames: Object.freeze([...selectedDuplicates]),
    snapshotId: "",
  });
}

function planWithSnapshot(input: {
  text: string;
  requestedNames: readonly string[];
  allowedNames: readonly string[];
}): SelectedNameImportPlan {
  const inventory = envFileInventory(input.text);
  const plan = planSelectedNameImport({
    requestedNames: input.requestedNames,
    availableNames: inventory.names,
    duplicateNames: inventory.duplicateNames,
    allowedNames: input.allowedNames,
  });
  return Object.freeze({
    ...plan,
    snapshotId: snapshotId(input.text, plan.requestedNames),
  });
}

/** Convenience for Q4: inventory and build the value-free plan in one call. */
export function planSelectedNameImportFromText(input: {
  text: string;
  requestedNames: readonly string[];
  allowedNames: readonly string[];
}): SelectedNameImportPlan {
  return planWithSnapshot(input);
}

/** Execute only the selection reviewed against this exact source snapshot. The authoritative
 * declaration allowlist is supplied separately from the plan so mutating/forging a plan cannot
 * widen write capability. */
export async function executeSelectedNameImport(
  text: string,
  plan: SelectedNameImportPlan,
  allowedNames: readonly string[],
  writer: SelectedNameImportWriter,
): Promise<SelectedNameImportResult> {
  const currentPlan = planWithSnapshot({
    text,
    requestedNames: plan.requestedNames,
    allowedNames,
  });
  const matchesReviewedPlan = matchesSnapshot(
    text,
    plan.requestedNames,
    plan.snapshotId,
  );
  const base = {
    requestedNames: [...currentPlan.requestedNames],
    selectedNames: [...currentPlan.selectedNames],
    missingNames: [...currentPlan.missingNames],
    unknownNames: [...currentPlan.unknownNames],
    duplicateNames: [...currentPlan.duplicateNames],
    invalidNameCount: plan.invalidNameCount,
  };
  if (
    plan.state !== "ready" ||
    currentPlan.state !== "ready" ||
    !matchesReviewedPlan ||
    currentPlan.snapshotId !== plan.snapshotId
  ) {
    return {
      ...base,
      state: "rejected",
      writtenNames: [],
      failedNames: [],
      count: {
        selected: currentPlan.selectedNames.length,
        written: 0,
        failed: 0,
      },
    };
  }
  if (currentPlan.selectedNames.length === 0) {
    return {
      ...base,
      state: "written",
      writtenNames: [],
      failedNames: [],
      count: { selected: 0, written: 0, failed: 0 },
    };
  }

  const filtered = filterEnvFileNames(text, new Set(currentPlan.selectedNames));
  let outcome: SelectedNameImportWriteResult;
  try {
    outcome = await writer(filtered.text, [...currentPlan.selectedNames]);
  } catch {
    return {
      ...base,
      state: "written",
      writtenNames: [],
      failedNames: [...currentPlan.selectedNames],
      count: {
        selected: currentPlan.selectedNames.length,
        written: 0,
        failed: currentPlan.selectedNames.length,
      },
    };
  }

  const selected = new Set(currentPlan.selectedNames);
  const reportedWritten = normalizeNames(
    outcome.writtenNames ?? [],
  ).names.filter((name) => selected.has(name));
  const reportedFailed = normalizeNames(outcome.failedNames ?? []).names.filter(
    (name) => selected.has(name),
  );
  const conflicting = new Set(
    reportedWritten.filter((name) => reportedFailed.includes(name)),
  );
  const writtenNames = reportedWritten.filter((name) => !conflicting.has(name));
  const failed = new Set(reportedFailed);
  for (const name of currentPlan.selectedNames)
    if (!writtenNames.includes(name)) failed.add(name);
  const failedNames = currentPlan.selectedNames.filter((name) =>
    failed.has(name),
  );
  return {
    ...base,
    state: "written",
    writtenNames,
    failedNames,
    count: {
      selected: currentPlan.selectedNames.length,
      written: writtenNames.length,
      failed: failedNames.length,
    },
  };
}
