import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import type { OnboardIdentity } from "./onboard.js";
import { CliError } from "./errors.js";

export interface BootstrapArtifact {
  readonly kind: "runtime" | "cli" | "skills" | "installer";
  readonly version: string;
  readonly sha256: string;
}
/** Value-free machine plan: credentials and provider URLs are never continuation inputs. */
export interface BootstrapPlan {
  readonly schema: 1;
  readonly home: string;
  readonly origin: string;
  readonly platform: "darwin" | "linux";
  readonly arch: "arm64" | "x64";
  readonly cliPath: string;
  readonly skillsPath: string;
  readonly statePath: string;
  readonly dailyUpdate: boolean;
  readonly artifacts: readonly BootstrapArtifact[];
}
export interface ApprovedBootstrap {
  readonly plan: BootstrapPlan;
  readonly planHash: string;
  readonly account: string;
  readonly person: string;
  readonly origin: string;
  readonly role: OnboardIdentity["role"];
  readonly localSync: boolean;
  readonly runId: string;
  readonly lockPath: string;
  readonly ownerPid: number;
  readonly ownerToken: string;
}
/** Internal runtime seam. Completion must join actual children/streams before resolving or rejecting.
 * A timeout or signal is never permission to release the caller's canonical lock.
 */
export interface OnboardBootstrapPreview {
  readonly plan: BootstrapPlan;
  /** Revalidate staged artifacts and machine/config snapshots; this check makes no writes. */
  recheck(): Promise<void>;
  /** Synchronously check captured artifact/path snapshots after the last awaited identity proof. */
  assertCurrent(): void;
  /** Runs once in the same native process after Q1, with its canonical lock still held. */
  continue(approved: ApprovedBootstrap, signal: AbortSignal): Promise<void>;
}
function refused(): never {
  throw new CliError(
    "The staged installation plan could not be verified. Run setup again.",
    "onboard-bootstrap-plan",
    12,
  );
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return refused();
  return value as Record<string, unknown>;
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    refused();
}
function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
  )
    refused();
  return value;
}
function path(value: unknown): string {
  const result = text(value);
  if (!isAbsolute(result) || normalize(result) !== result || result === "/")
    refused();
  return result;
}
function origin(value: unknown): string {
  const result = text(value);
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    return refused();
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== result ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    refused();
  return result;
}
/** Copies a closed DTO before freezing it; a mutable caller object cannot alter the displayed plan. */
export function parseBootstrapPlan(input: unknown): BootstrapPlan {
  const value = record(input);
  exactKeys(value, [
    "schema",
    "home",
    "origin",
    "platform",
    "arch",
    "cliPath",
    "skillsPath",
    "statePath",
    "dailyUpdate",
    "artifacts",
  ]);
  if (
    value.schema !== 1 ||
    (value.platform !== "darwin" && value.platform !== "linux") ||
    (value.arch !== "arm64" && value.arch !== "x64") ||
    typeof value.dailyUpdate !== "boolean" ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length !== 4
  )
    refused();
  const kinds = new Set<string>();
  const artifacts = value.artifacts
    .map((input) => {
      const item = record(input);
      exactKeys(item, ["kind", "version", "sha256"]);
      if (
        item.kind !== "runtime" &&
        item.kind !== "cli" &&
        item.kind !== "skills" &&
        item.kind !== "installer"
      )
        refused();
      if (kinds.has(item.kind)) refused();
      kinds.add(item.kind);
      const version = text(item.version);
      if (
        !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/.test(version) ||
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(item.sha256)
      )
        refused();
      return Object.freeze({ kind: item.kind, version, sha256: item.sha256 });
    })
    .sort((a, b) => a.kind.localeCompare(b.kind));
  const home = path(value.home),
    cliPath = path(value.cliPath),
    skillsPath = path(value.skillsPath),
    statePath = path(value.statePath);
  if (new Set([home, cliPath, skillsPath, statePath]).size !== 4) refused();
  return Object.freeze({
    schema: 1,
    home,
    origin: origin(value.origin),
    platform: value.platform,
    arch: value.arch,
    cliPath,
    skillsPath,
    statePath,
    dailyUpdate: value.dailyUpdate,
    artifacts: Object.freeze(artifacts),
  });
}
export function bootstrapPlanHash(plan: BootstrapPlan): string {
  return createHash("sha256")
    .update(JSON.stringify(parseBootstrapPlan(plan)))
    .digest("hex");
}
export function bootstrapPlanLines(plan: BootstrapPlan): string[] {
  return [
    `Install on ${plan.platform}/${plan.arch} for ${plan.home}`,
    `Catalyst cloud: ${plan.origin}`,
    `Command: ${plan.cliPath}`,
    `Skills: ${plan.skillsPath}`,
    `Setup record: ${plan.statePath}`,
    `Daily update: ${plan.dailyUpdate ? "schedule after installation" : "not selected"}`,
    ...plan.artifacts.map(
      (artifact) =>
        `${artifact.kind} ${artifact.version} (SHA-256 ${artifact.sha256})`,
    ),
  ];
}

/** A prepared native continuation is consumed before entering the first persistent machine stage.
 * Retry after a partial install constructs a new preview from the actual machine and journal.
 */
export function createBootstrapPreview(
  input: unknown,
  ports: {
    recheck(): Promise<void>;
    assertCurrent(): void;
    continue(approved: ApprovedBootstrap, signal: AbortSignal): Promise<void>;
  },
): OnboardBootstrapPreview {
  const plan = parseBootstrapPlan(input);
  const planHash = bootstrapPlanHash(plan);
  let consumed = false;
  return Object.freeze({
    plan,
    async recheck() {
      if (consumed) refused();
      await ports.recheck();
    },
    assertCurrent() {
      if (consumed) refused();
      ports.assertCurrent();
    },
    async continue(approved: ApprovedBootstrap, signal: AbortSignal) {
      if (
        consumed ||
        signal.aborted ||
        approved.planHash !== planHash ||
        bootstrapPlanHash(approved.plan) !== planHash ||
        approved.origin !== plan.origin ||
        !approved.account ||
        !approved.person ||
        !approved.runId ||
        !Number.isSafeInteger(approved.ownerPid) ||
        approved.ownerPid < 1 ||
        !approved.ownerToken ||
        !isAbsolute(approved.lockPath)
      )
        refused();
      consumed = true;
      ports.assertCurrent();
      await ports.continue(approved, signal);
    },
  });
}
