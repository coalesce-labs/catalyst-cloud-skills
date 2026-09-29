// public-prose.test.ts — the skills, README and install block name only what a reader outside this
// project can use. Each rule gets a planted line as its positive control, so a clean tree means the
// rules ran and found nothing, not that they never matched anything.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { RULES, checkTree, publicFiles, scanText, specProblems } from "../scripts/check-public-prose.mjs";

const root = join(import.meta.dirname, "..");

const PLANTED: Record<string, string> = {
  "plugin-prefix": "run the `catalyst-dev:linear` skill",
  "named-person": "ask Ryan which project",
  "ticket-id": "this changed in CTC-3481",
  "adr-id": "decided in ADR-0008",
  "dated-history": "since 2026-09-27 the file is ignored",
  "retired-cli": "run `catalyst-skills login`",
  "private-reference": "see coalesce-labs/catalyst-cloud/docs",
  "tenant-word": "Move the card on the tenant's board.",
};

describe("public prose", () => {
  test("every rule has a planted positive control, and each control fires its own rule", () => {
    expect(Object.keys(PLANTED).sort()).toEqual(RULES.map((r) => r.id).sort());
    for (const [id, line] of Object.entries(PLANTED)) {
      expect(scanText(line).map((f) => f.rule), line).toContain(id);
    }
  });

  test("clean text passes: bare skill names, the catalyst command, a placeholder ticket id, the Cloud pack", () => {
    const clean = [
      "Run the `linear` skill (`/linear` in Claude Code, `$linear` in Codex).",
      "Run `catalyst login`, or `npx -p @catalyst-cloud/cli catalyst login` without a global install.",
      "A ticket id looks like ENG-123.",
      "Install the Cloud pack (`coalesce-labs/catalyst-cloud-skills`).",
    ].join("\n");
    expect(scanText(clean)).toEqual([]);
  });

  test("the tenant word fires in prose and spares identifiers: inline code, link targets and fenced examples", () => {
    expect(scanText("Every tenant gets one.").map((f) => f.rule)).toEqual(["tenant-word"]);
    expect(scanText("Two Tenants share nothing.").map((f) => f.rule)).toEqual(["tenant-word"]);
    const clean = [
      "Move the card on your cloud account's board; the route is `/v1/tenant/:id` and the field `tenantId`.",
      "See [the contract](https://example.com/tenant-contract).",
      "```\ncatalyst query issue ENG-1 --tenant tenant-0\n```",
      "The contract range is `tenantContractRange`.",
    ].join("\n");
    expect(scanText(clean)).toEqual([]);
  });

  test("a date inside a fenced example passes; the same date in prose fires", () => {
    expect(scanText("```\nupdated_at: 2026-09-27\n```")).toEqual([]);
    expect(scanText("updated_at: 2026-09-27").map((f) => f.rule)).toEqual(["dated-history"]);
  });

  test("the provenance stamp and the README deprecation note are the only old-name lines allowed", () => {
    expect(scanText("<!-- vendored-from: @catalyst-cloud/catalyst-skills@0.9.5 — written here -->")).toEqual([]);
    expect(scanText("The command is `catalyst`. `catalyst-skills` still works as a deprecated alias.")).toEqual([]);
    expect(scanText("npx @catalyst-cloud/catalyst-skills login").map((f) => f.rule)).toEqual(["retired-cli"]);
  });

  test("the spec check catches a name that differs from its folder and a description over 1024 characters", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-prose-spec-"));
    mkdirSync(join(dir, "skills", "long"), { recursive: true });
    mkdirSync(join(dir, "skills", "folder"), { recursive: true });
    writeFileSync(join(dir, "skills", "long", "SKILL.md"), `---\nname: long\ndescription: >-\n  ${"a".repeat(1100)}\nallowed-tools: x\n---\n`);
    writeFileSync(join(dir, "skills", "folder", "SKILL.md"), "---\nname: other\ndescription: short\n---\n");
    expect(specProblems(dir).sort()).toEqual([
      'skills/folder: name "other" does not match its folder',
      "skills/long: description is 1100 characters (1-1024)",
    ]);
  });

  test("the tree is clean", () => {
    expect(publicFiles(root).length).toBeGreaterThan(20);
    expect(checkTree(root)).toEqual([]);
  });
});
