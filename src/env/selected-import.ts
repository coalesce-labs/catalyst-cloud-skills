import { envFileNames, filterEnvFileNames } from "./parse-env.js";

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Selection plans and receipts intentionally carry identifiers only. Values remain inside the
 * executor's callback and are never returned to Q4 orchestration. */
export interface SelectedNameImportPlan {
  state: "ready" | "rejected";
  requestedNames: string[];
  allowedNames: string[];
  selectedNames: string[];
  missingNames: string[];
  unknownNames: string[];
  invalidNames: string[];
}

export interface SelectedNameImportResult {
  state: "written" | "rejected";
  requestedNames: string[];
  selectedNames: string[];
  writtenNames: string[];
  failedNames: string[];
  missingNames: string[];
  unknownNames: string[];
  invalidNames: string[];
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

function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names.flatMap((entry) => entry.split(",").map((name) => name.trim())).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "en"));
}

/** Plan a single Q4 selection against a local file and a declaration allowlist. No values or
 * command/prompt state enter the returned object. `unknownNames` are outside the caller's allowlist;
 * `missingNames` were allowed but not present in the selected file. */
export function planSelectedNameImport(input: {
  requestedNames: readonly string[];
  availableNames: readonly string[];
  allowedNames: readonly string[];
}): SelectedNameImportPlan {
  const requestedNames = sortedUnique(input.requestedNames);
  const allowedNames = sortedUnique(input.allowedNames);
  const available = new Set(input.availableNames);
  const allowed = new Set(allowedNames);
  const invalidNames = requestedNames.filter((name) => !NAME_RE.test(name));
  const unknownNames = requestedNames.filter((name) => !allowed.has(name));
  const missingNames = requestedNames.filter((name) => allowed.has(name) && !available.has(name));
  const selectedNames = requestedNames.filter(
    (name) => NAME_RE.test(name) && allowed.has(name) && available.has(name),
  );
  const state = requestedNames.length > 0 && invalidNames.length === 0 && unknownNames.length === 0 && missingNames.length === 0
    ? "ready"
    : "rejected";
  return { state, requestedNames, allowedNames, selectedNames, missingNames, unknownNames, invalidNames };
}

/** Convenience for Q4: inventory the local file and build its value-free allowlisted plan in one
 * call. The output is identical to `planSelectedNameImport` and contains no file values. */
export function planSelectedNameImportFromText(input: {
  text: string;
  requestedNames: readonly string[];
  allowedNames: readonly string[];
}): SelectedNameImportPlan {
  return planSelectedNameImport({
    requestedNames: input.requestedNames,
    availableNames: envFileNames(input.text),
    allowedNames: input.allowedNames,
  });
}

/** Execute only a ready plan. The writer receives the selected dotenv lines as its narrow
 * value-bearing boundary. The returned receipt is rebuilt from selected identifiers and counts,
 * never passed through from a route response that might echo values. No prompt or commit occurs. */
export async function executeSelectedNameImport(
  text: string,
  plan: SelectedNameImportPlan,
  writer: SelectedNameImportWriter,
): Promise<SelectedNameImportResult> {
  const currentPlan = planSelectedNameImportFromText({
    text,
    requestedNames: plan.requestedNames,
    allowedNames: plan.allowedNames,
  });
  const base = {
    requestedNames: [...currentPlan.requestedNames],
    selectedNames: [...currentPlan.selectedNames],
    missingNames: [...currentPlan.missingNames],
    unknownNames: [...currentPlan.unknownNames],
    invalidNames: [...currentPlan.invalidNames],
  };
  if (plan.state !== "ready" || currentPlan.state !== "ready") {
    return {
      ...base,
      state: "rejected",
      writtenNames: [],
      failedNames: [],
      count: { selected: currentPlan.selectedNames.length, written: 0, failed: 0 },
    };
  }

  const filtered = filterEnvFileNames(text, new Set(currentPlan.selectedNames));

  const outcome = await writer(filtered.text, [...currentPlan.selectedNames]);
  const selected = new Set(currentPlan.selectedNames);
  const writtenNames = sortedUnique(outcome.writtenNames ?? []).filter((name) => selected.has(name));
  const failedNames = sortedUnique(outcome.failedNames ?? []).filter(
    (name) => selected.has(name) && !writtenNames.includes(name),
  );
  return {
    ...base,
    state: "written",
    writtenNames,
    failedNames,
    count: { selected: currentPlan.selectedNames.length, written: writtenNames.length, failed: failedNames.length },
  };
}
