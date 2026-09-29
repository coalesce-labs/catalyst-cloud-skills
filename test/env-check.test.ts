// env-check.test.ts — CTC-2496 acceptance criterion 3: `env check` accepts and rejects the same
// fixtures as `validateRepoEnvironmentDeclaration`, pinned by a shared fixture set (`cases.json`) that
// both the vendored validator (`src/env/declaration-rules.ts`) and a future live cross-repo diff could
// be run against. That file is not reachable from this checkout (a private repository, no sibling
// checkout, no network) — see declaration-rules.ts's provenance comment for what that costs.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { validateDeclaration } from "../src/env/declaration-rules";
import { makeCtx, tempHome } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const fxDir = join(here, "fixtures", "env-declaration");
const fx = (name: string) => join(fxDir, name);
interface Case {
  file: string;
  valid: boolean;
  reason?: string;
  why?: string;
}
const CASES: Case[] = JSON.parse(readFileSync(fx("cases.json"), "utf8"));

test("positive control: every fixture named in cases.json exists and parses as JSON", () => {
  expect(CASES.length).toBeGreaterThanOrEqual(12);
  for (const c of CASES) expect(() => JSON.parse(readFileSync(fx(c.file), "utf8"))).not.toThrow();
  expect(CASES.filter((c) => c.valid).length).toBeGreaterThan(0);
  expect(CASES.filter((c) => !c.valid).length).toBeGreaterThan(0);
});

describe.each(CASES)("env check $file -> valid=$valid", (c) => {
  test("matches the pinned verdict", async () => {
    const ctx = makeCtx(tempHome());
    const code = await main(["env", "check", fx(c.file), "--json"], ctx);
    const doc = JSON.parse(ctx.out.join("\n")) as { state: string; errors: string[] };
    expect(doc.state).toBe(c.valid ? "valid" : "invalid");
    expect(code).toBe(c.valid ? 0 : 1);
    if (c.reason) expect(doc.errors.join(" ").toLowerCase()).toContain(c.reason.toLowerCase());
  });
});

test("an empty provenance array is VALID — the one case pinned by a real upstream transcript", async () => {
  const ctx = makeCtx(tempHome());
  expect(await main(["env", "check", fx("valid-empty-provenance.json"), "--json"], ctx)).toBe(0);
});

test("env check never prints a value out of the file it validates — it names the FIELD, not the match", async () => {
  const ctx = makeCtx(tempHome());
  await main(["env", "check", fx("secret-prefix-in-explanation.json")], ctx);
  const printed = [...ctx.out, ...ctx.err].join("\n");
  expect(printed).not.toContain("ghp_SENTINELSENTINEL");
  // positive control: the sentinel really is in the fixture, so an empty scan cannot pass vacuously
  expect(readFileSync(fx("secret-prefix-in-explanation.json"), "utf8")).toContain("ghp_SENTINELSENTINEL");
});

test("the vendored rules carry a provenance comment naming the upstream source, a read date and their own limitation", () => {
  const src = readFileSync(join(here, "..", "src", "env", "declaration-rules.ts"), "utf8");
  expect(src).toMatch(/packages\/environment\/src\/contract\.ts/);
  expect(src).toMatch(/validateRepoEnvironmentDeclaration/);
  expect(src).toMatch(/2026-09-1\d/);
  expect(src).toMatch(/cannot notice|does not notice/i);
});

test("a missing file and a non-JSON file are refusals, not crashes", async () => {
  expect(await main(["env", "check", "/nope/does-not-exist.json"], makeCtx(tempHome()))).toBe(1);
});

// C-2 (validate attempt 7): `collectFreeText` dereferenced array elements with no type check, so a
// `null` element in setup / verify / services / provenance / agentAssets threw a TypeError out of
// `main()` — a stack trace instead of `invalid`, on the one verb whose whole job is validating
// untrusted JSON. `services`, `provenance` and `agentAssets` had no element diagnostic at all.
describe("C-2: a non-object array element is a refusal, not a crash", () => {
  const base = {
    version: 1,
    toolchains: [],
    systemPackages: [],
    setup: [],
    verify: [],
    services: [],
    environment: [],
    agentAssets: [],
    provenance: [],
  };

  for (const field of ["setup", "verify", "services", "provenance", "agentAssets"] as const) {
    for (const [label, bad] of [
      ["null", null],
      ["a string", "nope"],
      ["a number", 7],
    ] as const) {
      test(`${field}[0] = ${label} is reported as an error, and nothing throws`, () => {
        let errors: string[] = [];
        expect(() => {
          errors = validateDeclaration({ ...base, [field]: [bad] });
        }).not.toThrow();
        expect(errors.some((e) => e.startsWith(`${field}[0]`))).toBe(true);
      });
    }
  }

  test("the CLI prints `invalid` and exits 1 rather than throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catalyst-env-check-"));
    const file = join(dir, "catalyst.env.json");
    writeFileSync(file, JSON.stringify({ ...base, services: [null], provenance: [null], agentAssets: [null] }));
    const ctx = makeCtx(tempHome());
    expect(await main(["env", "check", file], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toContain("invalid");
  });
});

// C-4 / S-2 (validate attempt 7): Node embeds the first ten characters of the input in JSON.parse's
// "Unexpected token" message, and `env check` forwarded that message verbatim — file content on
// stderr, from a verb documented as never printing a value.
test("a non-JSON file is refused without echoing any of its content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalyst-env-check-"));
  const file = join(dir, "catalyst.env.json");
  writeFileSync(file, "ghp_SUPERSECRETVALUE not json at all");
  const ctx = makeCtx(tempHome());
  expect(await main(["env", "check", file], ctx)).toBe(1);
  const printed = [...ctx.out, ...ctx.err].join("\n");
  expect(printed).toMatch(/not valid JSON/);
  expect(printed).not.toContain("ghp_SUPERS");
  expect(printed).not.toContain("Unexpected token");
  // positive control: the sentinel really is in the file, so an empty refusal cannot pass vacuously
  expect(readFileSync(file, "utf8")).toContain("ghp_SUPERSECRETVALUE");
});
