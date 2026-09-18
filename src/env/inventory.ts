// inventory.ts — walks a repository once and dispatches each file to the scanner that understands it.
// D-5: `.env` and `.dev.vars` are never opened — not filtered out after reading, never asked for at
// all. Nothing in the dispatch table below names them, so the structural guarantee holds without a
// separate exclusion list that could itself drift.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { groupSightings } from "./group.js";
import { ENV_EXAMPLE_FILES, scanEnvExample } from "./scan-env-example.js";
import { MAX_SOURCE_FILE_BYTES, SOURCE_EXTENSIONS, scanSource } from "./scan-source.js";
import { scanWorkflow } from "./scan-workflow.js";
import { scanWrangler } from "./scan-wrangler.js";
import type { Inventory, RawSighting, ScanDeps, WorkflowJob } from "./types.js";
import { walkRepo } from "./walk.js";

function defaultReadFile(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_SOURCE_FILE_BYTES * 4) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
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
    const base = rel.split("/").pop() ?? rel;
    const abs = join(root, rel);

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
      if (text === undefined) continue;
      if (text.length > MAX_SOURCE_FILE_BYTES) {
        notes.push(`${rel} is over 512 KB and was skipped`);
        continue;
      }
      sightings.push(...scanSource(rel, text));
    }
  }

  const { entries, groups } = groupSightings(sightings);
  return { root, entries, groups, jobs, notes };
}
