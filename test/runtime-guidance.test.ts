// runtime-guidance.test.ts — CTC-2158 Tier 1, second clause, as an executable rule: bun below 1.4
// cannot run this CLI at all (measured: `bun -e 'import "node:sqlite"'` on 1.3.14 -> "Could not
// resolve"). Any place that offers bun as a way out of a runtime problem and does NOT name the
// floor sends a stuck customer to a runtime that cannot start. This gate is repo-wide because the
// old wording lived in three files and no test protected any of them (research, CTC-2158, §C).
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSdk, resetSdkCache } from "../src/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

function read(rel: string): string {
  return readFileSync(join(pkgRoot, rel), "utf8");
}

const SCANNED = [
  "src/sdk.ts",
  "src/ready.ts",
  "src/runtime.ts",
  "src/replica.ts",
  "README.md",
  ".agents/install-block.md",
  "skills/catalyst-setup/references/what-each-check-means.md",
];

// Only prose files are checked for a LITERAL "1.4" next to "bun": source files build their bun
// messages from the BUN_MIN constant (src/runtime.ts), so the source text reads `${BUN_MIN}`, not
// "1.4" — the single-sourced design this ticket exists to build. The actual RENDERED text of every
// source-built message is asserted against BUN_MIN directly in test/runtime.test.ts and
// test/replica.test.ts, which is the check that cannot drift if BUN_MIN's value ever changes.
const PROSE = ["README.md", ".agents/install-block.md", "skills/catalyst-setup/references/what-each-check-means.md"];

/** Group consecutive non-blank lines into one paragraph, so a sentence (or a wrapped prose comment
 *  block) that names bun on one line and the floor on the next still counts as naming it together. */
function paragraphs(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      if (current.length) out.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) out.push(current.join("\n"));
  return out;
}

describe("no scanned file uses the old unqualified bun phrasing", () => {
  for (const rel of SCANNED) {
    test(rel, () => {
      const text = read(rel);
      expect(text).not.toMatch(/or under bun\b/);
      expect(text).not.toMatch(/\(or bun\)/);
    });
  }
});

describe("every prose mention of bun carries the 1.4 floor nearby", () => {
  for (const rel of PROSE) {
    test(rel, () => {
      for (const para of paragraphs(read(rel))) {
        if (!/\bbun\b/i.test(para)) continue;
        expect(para, `${rel}: bun named without the 1.4 floor nearby — ${para.trim()}`).toMatch(/1\.4/);
      }
    });
  }
});

test("the served reference's machine-checks table documents the `runtime` row, not a `node` row", () => {
  const page = read("skills/catalyst-setup/references/what-each-check-means.md");
  const start = page.indexOf("## The machine checks the CLI adds");
  const end = page.indexOf("\n## ", start + 1);
  const table = page.slice(start, end === -1 ? undefined : end);
  expect(table).toMatch(/\|\s*`runtime`\s*\|/);
  expect(table).not.toMatch(/\|\s*`node`\s*\|/);
  expect(table).toContain("22.15");
  expect(table).toContain("runtime install");
});

test("no scanned file claims a bare `Node 22 or newer` floor any more", () => {
  for (const rel of SCANNED) {
    expect(read(rel), rel).not.toMatch(/Node 22 or newer/);
  }
});

test("the SDK-unavailable error names the range and the one command, and never suggests bun without the floor", async () => {
  resetSdkCache();
  const err = (await loadSdk(async () => {
    throw new Error("ERR_SOMETHING: nope");
  }).catch((e: unknown) => e)) as Error;
  expect(err.message).toContain("22.15");
  expect(err.message).toContain("npx -y @catalyst-cloud/catalyst-skills runtime install");
  expect(err.message).not.toMatch(/or under bun/);
  resetSdkCache();
});
