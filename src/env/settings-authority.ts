import { isRepositoryId } from "../repository-id.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { validateFullSettings } from "../../vendor/settings/index.js";
import {
  executeSelectedNameImport,
  planSelectedNameImportFromText,
  type SelectedNameImportPlan,
  type SelectedNameImportResult,
  type SelectedNameImportWriter,
} from "./selected-import.js";

/** A caller must obtain this from current login, team selection and a fresh repo ACL read.
 * Journal or cached contract entries cannot establish this context. */
export interface SettingsAuthorityContext {
  accountId: string;
  personId: string;
  baseUrl: string;
  role: "owner" | "admin" | "member";
  teamId: string;
  teamKey: string;
  repoId: string;
  repoName: string;
  repoRoot: string;
}

export interface SettingsAuthorityPorts {
  readContext(signal?: AbortSignal): Promise<SettingsAuthorityContext | null>;
  readSettings(repoRoot: string, signal?: AbortSignal): Promise<string | null>;
}

export type SettingsImportReview =
  | { state: "rejected"; message: string }
  | {
      state: "ready";
      kind: "variables" | "secrets";
      selectedNames: readonly string[];
    };

interface Proof {
  kind: "variables" | "secrets";
  sourceBinding: string;
  plan: SelectedNameImportPlan;
}
const proofs = new WeakMap<object, Proof>();
const refused = (): SettingsImportReview => ({
  state: "rejected",
  message: "Review the current repository settings before importing values",
});
const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function snapshotContext(
  raw: SettingsAuthorityContext | null,
): SettingsAuthorityContext | null {
  if (
    !raw ||
    !isRepositoryId(raw.repoId) ||
    ![raw.accountId, raw.personId, raw.teamId].every(
      (id) => typeof id === "string" && opaque.test(id),
    )
  )
    return null;
  if (
    !["owner", "admin", "member"].includes(raw.role) ||
    !/^[A-Z][A-Z0-9]{0,15}$/.test(raw.teamKey)
  )
    return null;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(
      raw.repoName,
    ) ||
    !isAbsolute(raw.repoRoot)
  )
    return null;
  try {
    const url = new URL(raw.baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return {
      accountId: raw.accountId,
      personId: raw.personId,
      baseUrl: url.origin,
      role: raw.role,
      teamId: raw.teamId,
      teamKey: raw.teamKey,
      repoId: raw.repoId,
      repoName: raw.repoName.toLowerCase(),
      repoRoot: resolve(raw.repoRoot),
    };
  } catch {
    return null;
  }
}

/** Bounded exact local source: refuse redirected roots/directories/files and read a regular file.
 * The descriptor belongs to this call and is closed even when reading or cancellation fails. */
export async function readLocalSettings(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (signal?.aborted || !isAbsolute(repoRoot)) return null;
    const root = resolve(repoRoot);
    const directory = join(root, ".catalyst");
    if (
      (await realpath(root)) !== root ||
      (await realpath(directory)) !== directory ||
      signal?.aborted
    )
      return null;
    const path = join(directory, "catalyst.toml");
    const expected = await lstat(path);
    if (!expected.isFile() || expected.size > 1_048_576) return null;
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      stat.size > 1_048_576 ||
      signal?.aborted
    )
      return null;
    const bytes = await handle.readFile();
    if (bytes.length > 1_048_576 || signal?.aborted) return null;
    const current = await lstat(path);
    if (
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      (await realpath(root)) !== root ||
      (await realpath(directory)) !== directory ||
      signal?.aborted
    )
      return null;
    // Invalid UTF-8 must not be normalized into a different reviewed source.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readCurrentSource(
  ports: SettingsAuthorityPorts,
  kind: Proof["kind"],
  signal?: AbortSignal,
) {
  if (signal?.aborted) return null;
  const before = snapshotContext(await ports.readContext(signal));
  // Both current variable and secret write rails require an administrator or owner.
  if (!before || !["owner", "admin"].includes(before.role) || signal?.aborted)
    return null;
  const text = await ports.readSettings(before.repoRoot, signal);
  const after = snapshotContext(await ports.readContext(signal));
  if (
    text === null ||
    !after ||
    signal?.aborted ||
    JSON.stringify(before) !== JSON.stringify(after)
  )
    return null;
  const checked = validateFullSettings(text);
  if (!checked.ok || checked.linearTeam !== before.teamKey) return null;
  const sourceBinding = createHash("sha256")
    .update(
      JSON.stringify([
        before,
        createHash("sha256").update(text).digest("hex"),
        "90d646c7d2f1e52348625e76aeb504d56042e54e",
        kind,
      ]),
    )
    .digest("hex");
  return {
    sourceBinding,
    names: kind === "secrets" ? checked.secretNames : checked.variableNames,
  };
}

/** Authority reads are read-only. A stalled injected port cannot hold the CLI indefinitely;
 * late completion observes the owned abort signal and cannot produce an accepted source. */
async function currentSource(
  ports: SettingsAuthorityPorts,
  kind: Proof["kind"],
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof readCurrentSource>>> {
  if (signal?.aborted) return null;
  const owned = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, owned.signal])
    : owned.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remove = () => {};
  try {
    return await new Promise((resolve) => {
      const stopped = () => resolve(null);
      combined.addEventListener("abort", stopped, { once: true });
      remove = () => combined.removeEventListener("abort", stopped);
      timer = setTimeout(() => owned.abort(), 30_000);
      timer.unref();
      Promise.resolve()
        .then(() => readCurrentSource(ports, kind, combined))
        .then(
          (source) => resolve(combined.aborted ? null : source),
          () => resolve(null),
        );
    });
  } finally {
    if (timer) clearTimeout(timer);
    remove();
  }
}

export async function reviewSettingsImport(input: {
  kind: "variables" | "secrets";
  text: string;
  requestedNames: readonly string[];
  ports: SettingsAuthorityPorts;
  signal?: AbortSignal;
}): Promise<SettingsImportReview> {
  try {
    if (input.kind !== "variables" && input.kind !== "secrets")
      return refused();
    const source = await currentSource(input.ports, input.kind, input.signal);
    if (!source) return refused();
    const plan = planSelectedNameImportFromText({
      text: input.text,
      requestedNames: [...input.requestedNames],
      allowedNames: source.names,
    });
    if (plan.state !== "ready") return refused();
    const review = Object.freeze({
      state: "ready" as const,
      kind: input.kind,
      selectedNames: Object.freeze([...plan.selectedNames]),
    });
    proofs.set(review, {
      kind: input.kind,
      sourceBinding: source.sourceBinding,
      plan,
    });
    return review;
  } catch {
    return refused();
  }
}

/** Review objects are process-local capabilities. A serialized receipt, reconstructed object or
 * changed settings/context cannot authorize a write; values remain inside the selected writer. */
export async function executeReviewedSettingsImport(input: {
  review: SettingsImportReview;
  text: string;
  ports: SettingsAuthorityPorts;
  writer: SelectedNameImportWriter;
  signal?: AbortSignal;
}): Promise<SelectedNameImportResult | SettingsImportReview> {
  try {
    const proof = proofs.get(input.review);
    if (!proof) return refused();
    // Claim synchronously, before the first await: concurrent attempts cannot share capability.
    // A rejected or cancelled execution also requires a new review.
    proofs.delete(input.review);
    const source = await currentSource(input.ports, proof.kind, input.signal);
    if (
      !source ||
      source.sourceBinding !== proof.sourceBinding ||
      input.signal?.aborted
    )
      return refused();
    return await executeSelectedNameImport(
      input.text,
      proof.plan,
      source.names,
      input.writer,
    );
  } catch {
    return refused();
  }
}
