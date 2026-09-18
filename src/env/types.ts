// types.ts — the shapes every env/* scanner and the CLI's env verb share. Every one of these is a
// NAME, never a value: nothing in this module, or anything that imports it, may carry the right-hand
// side of an assignment.
export type EnvGroup = "build/test" | "deploy-only" | "bindings";

export interface Finding {
  /** Path relative to the scanned root. */
  file: string;
  line: number;
  /** What uses the name: a script, a workflow job, a config table. */
  consumer: string;
  /** A stable tag for the kind of consumer, e.g. "workflow-env", "kv_namespaces". */
  consumerKind: string;
}

export interface EnvEntry {
  name: string;
  group: EnvGroup;
  /** Where a person's local value for this name would come from. Never the value itself. */
  localSource: string;
  /** False for a wrangler.toml [vars] entry: its value is already committed, nothing to declare. */
  needsDeclaration: boolean;
  /** Set when the name came from a `[env.<name>.*]` wrangler table. */
  wranglerEnvironment?: string;
  found: Finding[];
}

export interface WorkflowJob {
  id: string;
  file: string;
  line: number;
  deploy: boolean;
  why: string;
}

export interface InventoryGroupView {
  id: EnvGroup;
  names: string[];
}

export interface Inventory {
  root: string;
  entries: EnvEntry[];
  groups: InventoryGroupView[];
  jobs: WorkflowJob[];
  notes: string[];
}

export interface ScanDeps {
  readFile: (path: string) => string | undefined;
  listFiles: (root: string) => string[];
}

/** One raw sighting a scanner reports, before grouping merges same-named sightings together. */
export interface RawSighting {
  name: string;
  finding: Finding;
  /** Present only for a name found via a workflow job; used to classify deploy-only vs build/test. */
  jobId?: string;
  jobDeploy?: boolean;
  /** Present only for a wrangler.toml [vars] table entry. */
  isWranglerVar?: boolean;
  /** Present only for a wrangler.toml binding table entry. */
  isBinding?: boolean;
  wranglerEnvironment?: string;
  /** Where THIS sighting's local value would come from, before group-level resolution. */
  localSource: string;
}

export interface ScanResult {
  sightings: RawSighting[];
  jobs: WorkflowJob[];
  notes: string[];
}
