// inventory.ts — walks a repository once and dispatches each file to the scanner that understands it.
// D-5: `.env` and `.dev.vars` are never opened — not filtered out after reading, never asked for at
// all. Nothing in the dispatch table below names them, so the structural guarantee holds without a
// separate exclusion list that could itself drift.
//
// ⛔ D-5 IS KEYED ON THE REAL PATH, NOT ON THE WALKED ONE (validate attempt 29, M-2). A basename is
// exactly what a symlink controls: a committed `.env.example -> .env` used to route the REAL `.env`
// into scanEnvExample, because the dispatch read the link's name rather than the file it opens.
// Chained with the unquoted-PEM defect in scan-env-example.ts, that printed verbatim bytes of an
// uncommitted private key as a variable NAME. So each file is resolved with `realpathSync` first,
// the dispatch keys on the resolved basename, and NEVER_READ_BASENAMES refuses the two names D-5
// promises are never opened — under either name, the link's or the target's.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { groupSightings } from "./group.js";
import { ENV_EXAMPLE_FILES, scanEnvExample } from "./scan-env-example.js";
import { MAX_SOURCE_FILE_BYTES, SOURCE_EXTENSIONS, scanSource } from "./scan-source.js";
import { scanWorkflow } from "./scan-workflow.js";
import { scanWrangler } from "./scan-wrangler.js";
import type { Inventory, RawSighting, ScanDeps, WorkflowJob } from "./types.js";
import { walkRepo } from "./walk.js";

/** D-5's promise, as a list: neither name is ever opened, by either route. */
const NEVER_READ_BASENAMES = new Set([".env", ".dev.vars"]);

/** Above this a file is not read at all, whatever it is. CR-7: a drop here is always noted. */
export const HARD_READ_CAP_BYTES = MAX_SOURCE_FILE_BYTES * 4;

function defaultReadFile(path: string): string | undefined {
  try {
    if (statSync(path).size > HARD_READ_CAP_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The basename of the file `abs` really opens, or the walked basename when it cannot be resolved. */
function resolvedBasename(abs: string, walked: string): string {
  try {
    return basename(realpathSync(abs));
  } catch {
    return walked;
  }
}

export function inventoryRepo(root: string, deps: Partial<ScanDeps> = {}): Inventory {
  const readFile = deps.readFile ?? defaultReadFile;
  const listFiles = deps.listFiles ?? walkRepo;
  const files = listFiles(root);

  const sightings: RawSighting[] = [];
  const jobs: WorkflowJob[] = [];
  const notes: string[] = [];

  for (const rel of files) {
    const walkedBase = rel.split("/").pop() ?? rel;
    const abs = join(root, rel);
    const base = resolvedBasename(abs, walkedBase);
    // M-2: refused under either name — the link's or the one it really opens.
    if (NEVER_READ_BASENAMES.has(base) || NEVER_READ_BASENAMES.has(walkedBase)) continue;

    if (ENV_EXAMPLE_FILES.includes(base)) {
      const text = readFile(abs);
      if (text !== undefined) sightings.push(...scanEnvExample(rel, text));
      continue;
    }
    if (rel.startsWith(".github/workflows/") && (rel.endsWith(".yml") || rel.endsWith(".yaml"))) {
      const text = readFile(abs);
      if (text !== undefined) {
        const res = scanWorkflow(rel, text);
        sightings.push(...res.sightings);
        jobs.push(...res.jobs);
      }
      continue;
    }
    if (base === "wrangler.toml") {
      const text = readFile(abs);
      if (text !== undefined) sightings.push(...scanWrangler(rel, text));
      continue;
    }
    if (base === "wrangler.json" || base === "wrangler.jsonc") {
      notes.push(`${rel} is a Cloudflare config this scan does not read yet (JSON/JSONC) — its vars and bindings are not reflected below.`);
      continue;
    }
    if (SOURCE_EXTENSIONS.some((ext) => rel.endsWith(ext))) {
      const text = readFile(abs);
      // CR-7: the 512 KB band below emitted a note while the hard cap above it emitted NOTHING, so a
      // file over 2 MB vanished from the inventory with no trace at all. Every drop is now named.
      if (text === undefined) {
        notes.push(`${rel} could not be read (unreadable, or over the ${HARD_READ_CAP_BYTES} byte hard cap) and was skipped`);
        continue;
      }
      // CR-7: measured in BYTES. `text.length` counts UTF-16 code units, so a file of multi-byte
      // characters was compared against the wrong number.
      if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_FILE_BYTES) {
        notes.push(`${rel} is over 512 KB and was skipped`);
        continue;
      }
      sightings.push(...scanSource(rel, text));
    }
  }

  const { entries, groups } = groupSightings(sightings);
  return { root, entries, groups, jobs, notes };
}
