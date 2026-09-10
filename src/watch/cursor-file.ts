// watch/cursor-file.ts — the durable cursor store for the events-only `watch` consumer, ported whole
// from the cloud's tested host-sync implementation. The file is the whole state:
//
//   { "account": "<tenant id>", "cursor": 41 }
//
// The account field is load-bearing: a cursor is a position in ONE tenant's change log, so the file
// refuses to be read for a different account than the one stamped in it (a named throw naming both
// accounts). A torn or corrupt file also fails loudly; the only "no state yet" is the file's absence.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CursorFileState {
  account: string;
  cursor: number;
}

export class CursorFileError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = "CursorFileError";
  }
}

function validateShape(parsed: unknown): { ok: true; state: CursorFileState } | { ok: false; error: string } {
  if (typeof parsed !== "object" || parsed === null) return { ok: false, error: "content is not a JSON object" };
  const { account, cursor } = parsed as Record<string, unknown>;
  if (typeof account !== "string" || account.trim() === "") return { ok: false, error: "account is missing or not a non-empty string" };
  if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) return { ok: false, error: "cursor is missing or not a non-negative integer" };
  return { ok: true, state: { account, cursor } };
}

/** Returns null ONLY when the file is absent. Throws CursorFileError on an unreadable, corrupt, or
 *  wrongly shaped file, and on a cross-account file when `expectAccount` is given. */
export function readCursorFile(path: string, expectAccount?: string): CursorFileState | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new CursorFileError(`cannot read cursor file: ${err instanceof Error ? err.message : String(err)}`, path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CursorFileError(
      "cursor file is not valid JSON (torn write?) — delete it to re-seed from the tenant head, at the cost of replaying nothing in between",
      path,
    );
  }
  const shape = validateShape(parsed);
  if (!shape.ok) throw new CursorFileError(`cursor file is malformed: ${shape.error}`, path);
  if (expectAccount !== undefined && shape.state.account !== expectAccount) {
    throw new CursorFileError(
      `cursor file belongs to account ${JSON.stringify(shape.state.account)} but this session is for ${JSON.stringify(expectAccount)} — a cursor is a position in ONE tenant's feed; move or delete the file rather than replaying one tenant's position against another`,
      path,
    );
  }
  return shape.state;
}

/** Atomic: a sibling temp file, then rename over the target. */
export function writeCursorFile(path: string, state: CursorFileState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(tmp, path);
}
