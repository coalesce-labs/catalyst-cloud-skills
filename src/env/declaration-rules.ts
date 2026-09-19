// declaration-rules.ts — a vendored, dated copy of catalyst-cloud's rules for a repo-scope
// `catalyst.env.json`, applied by `validateRepoEnvironmentDeclaration`
// (packages/environment/src/contract.ts:416-493 on catalyst-cloud `main`; the ticket cites line 488,
// which falls inside that range). That file lives in the PRIVATE `coalesce-labs/catalyst-cloud`
// monorepo — no sibling checkout, no npm publication (its one customer, `apps/cli`, is itself
// "private": true) and no network reachability from this session. Everything below is vendored
// secondhand from two independent, dated thoughts-pool research passes (2026-09-10 and 2026-09-17)
// that agreed with each other, following the same idiom this repository's own
// `test/skills-content.test.ts` already uses to vendor catalyst-cloud's `READINESS_CHECK_IDS` (see
// that file's `TEAM_CHECK_IDS` and its provenance comment): dated, cited, paired with a test, never
// hand-copied and trusted on its own.
//
// What a parity test built against THIS copy can, and cannot, catch: it can catch this copy DRIFTING
// FROM ITSELF — a rule dropped, loosened or tightened by a future edit here. It CANNOT notice a new
// rule landing upstream, because nothing in this repository imports the real function — there is no
// publish channel for it. The one fixture pinned by a real, run command transcript rather than by
// prose (`valid-empty-provenance.json`, in `test/fixtures/env-declaration/`) is the strongest anchor
// this vendored copy has; the rest are pinned by the two agreeing research passes.

const MAX_ENV_REFS = 128;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// ⛔ A PREFIX ONLY COUNTS AT A TOKEN BOUNDARY (validate attempt 29, CR-6). These were matched with
// `text.includes(p)`, and "sk-" is a SUBSTRING of "task-", "risk-" and "disk-" — so a declaration
// whose setup step was `["npm","run","task-build"]` was refused as containing secret material. Every
// prefix here is identifier-shaped, so a match is real only at the start of the text or after a
// character that cannot be part of a token; PEM armour, which is not identifier-shaped and carries
// its own unmistakable delimiter, keeps a plain substring match of its own.
const KNOWN_SECRET_PREFIXES = ["ghp_", "github_pat_", "sk-", "AKIA", "xoxb-", "xoxp-"];
const PEM_ARMOUR = "-----BEGIN";
const KNOWN_SECRET_PREFIX_RE = new RegExp(`(?:^|[^A-Za-z0-9_])(?:${KNOWN_SECRET_PREFIXES.map(escapeForRegExp).join("|")})`);

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const SECRET_ASSIGNMENT_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S{4,})/g;
const SECRET_NAME_RE = /(_TOKEN|_SECRET|_KEY|_PASSWORD|_CREDENTIAL)$|^(TOKEN|SECRET|PASSWORD)$/i;

const REQUIRED_ARRAY_FIELDS = ["toolchains", "systemPackages", "setup", "verify", "services", "environment", "agentAssets", "provenance"] as const;
const TOP_LEVEL_FIELDS = new Set<string>(["version", ...REQUIRED_ARRAY_FIELDS]);

/** Empty array = valid. Never reads, and never returns, a value — only field names and paths. */
export function validateDeclaration(doc: unknown): string[] {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return ["the declaration must be a JSON object"];
  }
  const rec = doc as Record<string, unknown>;
  const errors: string[] = [];

  for (const key of Object.keys(rec)) if (!TOP_LEVEL_FIELDS.has(key)) errors.push(`unknown key "${key}"`);
  if (rec.version !== 1) errors.push("version must be 1");
  for (const field of REQUIRED_ARRAY_FIELDS) if (!Array.isArray(rec[field])) errors.push(`${field} must be an array`);
  // The rules below assume the shape above holds; a missing/wrong-typed field is reported on its own.
  if (errors.length > 0) return errors;

  const environment = rec.environment as unknown[];
  if (environment.length > MAX_ENV_REFS) errors.push(`environment has ${environment.length} entries; at most ${MAX_ENV_REFS}`);
  for (const [i, e] of environment.entries()) {
    if (typeof e !== "object" || e === null) {
      errors.push(`environment[${i}] must be an object`);
      continue;
    }
    const rec2 = e as Record<string, unknown>;
    if (typeof rec2.name !== "string" || !ENV_NAME_RE.test(rec2.name)) errors.push(`environment[${i}].name is not a valid name`);
    if (typeof rec2.required !== "boolean") errors.push(`environment[${i}].required must be a boolean`);
    if (!Array.isArray(rec2.provenanceIds)) errors.push(`environment[${i}].provenanceIds must be an array`);
  }

  for (const field of ["setup", "verify"] as const) {
    for (const [i, s] of (rec[field] as unknown[]).entries()) {
      if (typeof s !== "object" || s === null) {
        errors.push(`${field}[${i}] must be an object`);
        continue;
      }
      const rec2 = s as Record<string, unknown>;
      const command = rec2.command;
      if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === "string")) {
        errors.push(`${field}[${i}].command must be an argv array (a bare shell string is refused; ["sh","-lc", …] is the explicit escape)`);
      }
      if (typeof rec2.timeoutSeconds !== "number") errors.push(`${field}[${i}].timeoutSeconds must be a number`);
      if (!Array.isArray(rec2.provenanceIds)) errors.push(`${field}[${i}].provenanceIds must be an array`);
    }
  }

  // C-2: services / provenance / agentAssets had no element check at all, so a non-object element
  // reached the free-text sweep below and threw instead of being reported. The rule is the same one
  // `environment` and `setup`/`verify` already apply: an element that is not an object is an error.
  for (const field of ["services", "provenance", "agentAssets"] as const) {
    for (const [i, e] of (rec[field] as unknown[]).entries()) {
      if (typeof e !== "object" || e === null || Array.isArray(e)) errors.push(`${field}[${i}] must be an object`);
    }
  }

  // assertNoSecretMaterial, LAST — a value-SHAPE refusal over every free-text field (argv strings,
  // service image names, provenance explanations, agent-asset references), never a classifier over
  // environment[].name: there is nothing to classify there. The refusal names the FIELD, never the
  // matched text, so this function never prints what it found.
  for (const { path, text } of collectFreeText(rec)) {
    if (text.includes(PEM_ARMOUR) || KNOWN_SECRET_PREFIX_RE.test(text)) {
      errors.push(`${path} appears to contain secret material (matches a known credential prefix)`);
      continue;
    }
    SECRET_ASSIGNMENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SECRET_ASSIGNMENT_RE.exec(text))) {
      if (SECRET_NAME_RE.test(m[1]!)) {
        errors.push(`${path} appears to contain secret material (an assignment shaped like a secret name)`);
        break;
      }
    }
  }

  return errors;
}

function collectFreeText(rec: Record<string, unknown>): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const field of ["setup", "verify"] as const) {
    for (const [i, s] of (rec[field] as unknown[]).entries()) {
      const rec2 = asRecord(s);
      if (rec2 === null) continue;
      if (Array.isArray(rec2.command)) {
        for (const c of rec2.command) if (typeof c === "string") out.push({ path: `${field}[${i}].command`, text: c });
      }
    }
  }
  for (const [i, s] of (rec.services as unknown[]).entries()) {
    const rec2 = asRecord(s);
    if (rec2 === null) continue;
    if (typeof rec2.image === "string") out.push({ path: `services[${i}].image`, text: rec2.image });
  }
  for (const [i, p] of (rec.provenance as unknown[]).entries()) {
    const rec2 = asRecord(p);
    if (rec2 === null) continue;
    if (typeof rec2.explanation === "string") out.push({ path: `provenance[${i}].explanation`, text: rec2.explanation });
  }
  for (const [i, a] of (rec.agentAssets as unknown[]).entries()) {
    const rec2 = asRecord(a);
    if (rec2 === null) continue;
    if (typeof rec2.reference === "string") out.push({ path: `agentAssets[${i}].reference`, text: rec2.reference });
  }
  return out;
}

/** An element the caller may safely read properties off, or null — a non-object is reported above. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
