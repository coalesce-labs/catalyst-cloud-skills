// runtime.ts — CTC-2158. The ONE place that answers "can this runtime run this CLI, and if not,
// what is the one command that fixes it without touching the machine's default Node?"
//
// Two floors, and they come from different places on purpose:
//   • Node: `engines.node` in package.json, read through readManifest(). Declared and publishable.
//     MEASURED: Node 22.14.0 has no node:module.registerHooks, so the type-stripping loader cannot
//     install and the SDK cannot load — `>=22` admitted a runtime this package does not work on.
//   • bun: BUN_MIN below. `engines` has no bun key bun enforces, so it lives here with its own
//     measurement. MEASURED: bun 1.3.14 has no `node:sqlite` at all (`bun -e 'import "node:sqlite"'`
//     -> "Could not resolve"), so the CLI could not even finish loading; bun 1.4.2 has it and runs
//     everything including the SDK. Anything that offers bun as a fallback MUST name this floor —
//     an unqualified bun recommendation sent a customer to a runtime that cannot even start.
export const BUN_MIN = "1.4.0";

/** The ONE copy-pasteable command. Installs a pinned Node under the CLI's own cache and pins it;
 *  it never touches the machine's default Node and needs no admin rights. See src/runtime-store.ts. */
export const FIX_COMMAND = "npx -y @catalyst-cloud/catalyst-skills runtime install";

export type RuntimeKind = "node" | "bun" | "unknown";

export interface RuntimeFacts {
  kind: RuntimeKind;
  version: string;
  /** For bun, this is `process.versions.node` — bun's Node-*compat* major, not bun's own version.
   *  For node, it is the same value as `version`. Never used to decide bun support: bun reports a
   *  Node-compat major regardless of whether it actually has node:sqlite. */
  nodeCompat: string;
}

export interface NodeFloor {
  major: number;
  minor: number;
  patch: number;
}

export interface RuntimeVerdict {
  supported: boolean;
  line: string;
  reason?: string;
  fix?: string;
}

/** Detect the runtime this process is running on. `process.versions.bun` is present only under bun. */
export function detectRuntime(versions: { node?: string; bun?: string } = process.versions as unknown as { node?: string; bun?: string }): RuntimeFacts {
  if (versions.bun) return { kind: "bun", version: versions.bun, nodeCompat: versions.node ?? "0.0.0" };
  if (versions.node) return { kind: "node", version: versions.node, nodeCompat: versions.node };
  return { kind: "unknown", version: "0", nodeCompat: "0" };
}

const RANGE_RE = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/;

/** Parse the one range form this package declares (">=X.Y" or ">=X.Y.Z"). A range this cannot parse
 *  is a loud, named error — a CLI that cannot read its own declared floor must not conclude
 *  "everything is supported". */
export function parseNodeFloor(range: string): NodeFloor {
  const m = RANGE_RE.exec(range.trim());
  if (!m) {
    throw new Error(`engines.node is "${range}", which this package's own range parser does not understand (it only reads ">=X.Y" or ">=X.Y.Z")`);
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

function parseVersionTriple(v: string): [number, number, number] {
  const core = v.split("-")[0]!.split("+")[0]!;
  const [maj, min, pat] = core.split(".");
  return [Number(maj) || 0, Number(min) || 0, Number(pat) || 0];
}

export function versionAtLeast(version: string, floor: NodeFloor): boolean {
  const [a, b, c] = parseVersionTriple(version);
  if (a !== floor.major) return a > floor.major;
  if (b !== floor.minor) return b > floor.minor;
  return c >= floor.patch;
}

/** The one range text every message reads, instead of writing "22.15" or "1.4" a second time. */
export function supportedRangeText(range: string): string {
  const floor = parseNodeFloor(range);
  return `Node ${floor.major}.${floor.minor} or newer, or bun ${BUN_MIN} or newer`;
}

/** Can this runtime run the CLI, and if not, what is the one command? */
export function runtimeVerdict(facts: RuntimeFacts, range: string): RuntimeVerdict {
  const floor = parseNodeFloor(range);
  const rangeText = supportedRangeText(range);

  if (facts.kind === "node") {
    if (versionAtLeast(facts.version, floor)) {
      return { supported: true, line: `runtime: Node ${facts.version} (supported: ${rangeText})` };
    }
    return {
      supported: false,
      line: `runtime: Node ${facts.version} is too old (supported: ${rangeText})`,
      reason: `node:module has no registerHooks on Node ${facts.version}; Node ${floor.major}.${floor.minor} or newer is required`,
      fix: FIX_COMMAND,
    };
  }

  if (facts.kind === "bun") {
    const bunFloor = parseNodeFloor(`>=${BUN_MIN}`);
    if (versionAtLeast(facts.version, bunFloor)) {
      return { supported: true, line: `runtime: bun ${facts.version} (supported: ${rangeText})` };
    }
    return {
      supported: false,
      line: `runtime: bun ${facts.version} is too old (supported: ${rangeText})`,
      reason: `bun ${facts.version} has no node:sqlite, which the replica needs; bun ${BUN_MIN} or newer is required`,
      fix: FIX_COMMAND,
    };
  }

  return {
    supported: false,
    line: `runtime: unrecognised runtime (supported: ${rangeText})`,
    reason: "could not detect a Node or bun version on this process",
    fix: FIX_COMMAND,
  };
}
