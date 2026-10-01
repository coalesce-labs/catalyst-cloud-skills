import {
  envFileInventory,
  filterEnvFileNames,
  parseEnvAssignments,
} from "./parse-env.js";

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SAFE_UNCERTAIN = "selected import outcome uncertain";
const SAFE_INPUT = "selected import input is invalid";

export type SelectedImportKind = "variable" | "secret";

export interface SelectedImportWriteResult {
  written: string[];
  failed: string[];
}

export type SelectedImportWriter = (
  selectedText: string,
  selectedNames: readonly string[],
) => Promise<SelectedImportWriteResult>;

export interface VariableWritePortResult {
  status: number;
  body: unknown;
}

export interface SecretImportPortResult {
  status: number;
  body: unknown;
}

export interface CreateSelectedImportWriterOptions {
  kind: SelectedImportKind;
  writeVariable?: (
    name: string,
    value: string,
  ) => Promise<VariableWritePortResult>;
  importSecrets?: (
    selectedText: string,
    selectedNames: readonly string[],
  ) => Promise<SecretImportPortResult>;
}

function fixedError(message: string): Error {
  return new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSelectedAssignments(
  selectedText: string,
  selectedNames: readonly string[],
): Map<string, string> {
  if (
    typeof selectedText !== "string" ||
    !Array.isArray(selectedNames) ||
    !selectedNames.every(
      (name) => typeof name === "string" && NAME_RE.test(name),
    ) ||
    new Set(selectedNames).size !== selectedNames.length
  ) {
    throw fixedError(SAFE_INPUT);
  }

  const inventory = envFileInventory(selectedText);
  if (
    inventory.duplicateNames.length > 0 ||
    inventory.names.length !== selectedNames.length ||
    inventory.names.some((name) => !selectedNames.includes(name))
  ) {
    throw fixedError(SAFE_INPUT);
  }

  const entries = parseEnvAssignments(selectedText);
  if (entries.length !== selectedNames.length) throw fixedError(SAFE_INPUT);
  const values = new Map<string, string>();
  for (const entry of entries) {
    if (
      !NAME_RE.test(entry.name) ||
      !selectedNames.includes(entry.name) ||
      values.has(entry.name)
    ) {
      throw fixedError(SAFE_INPUT);
    }
    values.set(entry.name, entry.value);
  }
  if (selectedNames.some((name) => !values.has(name)))
    throw fixedError(SAFE_INPUT);
  return values;
}

function validVariableSuccess(
  reply: VariableWritePortResult,
  name: string,
): boolean {
  if (!isRecord(reply.body)) return false;
  const envVar = reply.body.envVar;
  const unresolvedReferences = reply.body.unresolvedReferences;
  return (
    isRecord(envVar) &&
    envVar.name === name &&
    typeof reply.body.created === "boolean" &&
    Array.isArray(unresolvedReferences) &&
    unresolvedReferences.every((entry) => typeof entry === "string")
  );
}

function createVariableWriter(
  writeVariable: NonNullable<
    CreateSelectedImportWriterOptions["writeVariable"]
  >,
): SelectedImportWriter {
  return async (selectedText, selectedNames) => {
    const ownedNames = Array.isArray(selectedNames)
      ? [...selectedNames]
      : selectedNames;
    if (Array.isArray(ownedNames) && ownedNames.length === 0)
      return { written: [], failed: [] };
    const values = validateSelectedAssignments(selectedText, ownedNames);
    const written: string[] = [];
    const failed: string[] = [];
    for (const name of ownedNames) {
      let reply: VariableWritePortResult;
      try {
        reply = await writeVariable(name, values.get(name)!);
      } catch {
        throw fixedError(SAFE_UNCERTAIN);
      }
      try {
        if (!isRecord(reply) || !Number.isInteger(reply.status)) {
          throw fixedError(SAFE_UNCERTAIN);
        }
        if (reply.status === 200 || reply.status === 201) {
          if (!validVariableSuccess(reply, name))
            throw fixedError(SAFE_UNCERTAIN);
          written.push(name);
        } else if ([400, 401, 403, 409, 422].includes(reply.status)) {
          failed.push(name);
        } else {
          throw fixedError(SAFE_UNCERTAIN);
        }
      } catch {
        throw fixedError(SAFE_UNCERTAIN);
      }
    }
    return { written, failed };
  };
}

function secretOutcomes(
  reply: SecretImportPortResult,
  selectedNames: readonly string[],
): SelectedImportWriteResult | null {
  if (reply.status !== 200 || !isRecord(reply.body)) return null;
  const { created, rotated, errors } = reply.body;
  if (
    !Array.isArray(created) ||
    !Array.isArray(rotated) ||
    !Array.isArray(errors)
  ) {
    return null;
  }
  const failed: string[] = [];
  for (const error of errors) {
    if (!isRecord(error) || typeof error.name !== "string") return null;
    failed.push(error.name);
  }
  const written = [...created, ...rotated];
  const outcomes = [...written, ...failed];
  if (
    !outcomes.every((name) => typeof name === "string" && NAME_RE.test(name)) ||
    outcomes.length !== selectedNames.length ||
    new Set(outcomes).size !== outcomes.length ||
    outcomes.some((name) => !selectedNames.includes(name)) ||
    selectedNames.some((name) => !outcomes.includes(name))
  ) {
    return null;
  }
  return { written, failed };
}

function createSecretWriter(
  importSecrets: NonNullable<
    CreateSelectedImportWriterOptions["importSecrets"]
  >,
): SelectedImportWriter {
  return async (selectedText, selectedNames) => {
    const ownedNames = Array.isArray(selectedNames)
      ? [...selectedNames]
      : selectedNames;
    if (Array.isArray(ownedNames) && ownedNames.length === 0)
      return { written: [], failed: [] };
    validateSelectedAssignments(selectedText, ownedNames);
    const filtered = filterEnvFileNames(selectedText, new Set(ownedNames));
    if (filtered.found.length !== ownedNames.length)
      throw fixedError(SAFE_INPUT);
    let reply: SecretImportPortResult;
    try {
      reply = await importSecrets(filtered.text, [...ownedNames]);
    } catch {
      throw fixedError(SAFE_UNCERTAIN);
    }
    try {
      if (!isRecord(reply) || !Number.isInteger(reply.status)) {
        throw fixedError(SAFE_UNCERTAIN);
      }
      const outcome = secretOutcomes(reply, ownedNames);
      if (outcome === null) throw fixedError(SAFE_UNCERTAIN);
      return outcome;
    } catch {
      throw fixedError(SAFE_UNCERTAIN);
    }
  };
}

/** Adapt the CLI's existing single-variable and batch-secret writers for the value-free Q4 helper. */
export function createSelectedImportWriter(
  options: CreateSelectedImportWriterOptions,
): SelectedImportWriter {
  if (options.kind === "variable") {
    if (options.writeVariable === undefined) throw fixedError(SAFE_INPUT);
    return createVariableWriter(options.writeVariable);
  }
  if (options.kind === "secret") {
    if (options.importSecrets === undefined) throw fixedError(SAFE_INPUT);
    return createSecretWriter(options.importSecrets);
  }
  throw fixedError(SAFE_INPUT);
}
