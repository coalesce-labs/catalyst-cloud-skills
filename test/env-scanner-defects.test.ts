// env-scanner-defects.test.ts — the correctness findings CTC-2496's validate attempt 29 raised
// against the scanners, each pinned by the shape that reproduced it. Every one of these is a SILENT
// failure: the customer is shown a list and told nothing is wrong, which is the worst thing a tool
// whose whole value is completeness can do.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { HARD_READ_CAP_BYTES, inventoryRepo } from "../src/env/inventory";
import { MAX_SOURCE_FILE_BYTES } from "../src/env/scan-source";
import { scanWrangler } from "../src/env/scan-wrangler";

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "catalyst-env-defect-"));
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

// ⭐ CR-1 — THE WORST OF THE SEVEN. `TABLE_RE` is `$`-anchored, so a table header carrying an inline
// comment never matched: `currentTable` stayed null and the scanner returned NOTHING for the entire
// file — no bindings, no vars — while the customer was shown an empty `bindings` group.
describe("CR-1: a table header with an inline comment is still a table header", () => {
  const TOML = [
    'name = "w"',
    "",
    "[vars] # public settings",
    'PUBLIC_MODE = "on"',
    "",
    "[[kv_namespaces]] # sessions",
    'binding = "SESSIONS"',
    "",
  ].join("\n");

  test("positive control: the same file WITHOUT the comments reports both names", () => {
    const names = scanWrangler("wrangler.toml", TOML.replace(/ #[^\n]*/g, "")).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["PUBLIC_MODE", "SESSIONS"]));
  });

  test("the commented headers report the same names, rather than an empty file", () => {
    const sightings = scanWrangler("wrangler.toml", TOML);
    expect(sightings.map((s) => s.name)).toEqual(expect.arrayContaining(["PUBLIC_MODE", "SESSIONS"]));
    expect(sightings.find((s) => s.name === "SESSIONS")?.isBinding).toBe(true);
  });

  test("end to end, the binding reaches the inventory's bindings group", () => {
    const inv = inventoryRepo(repoWith({ "wrangler.toml": TOML }));
    expect(inv.entries.find((e) => e.name === "SESSIONS")?.group).toBe("bindings");
  });
});

// CR-4 — `QUOTED_RE` is end-anchored too, so a commented binding line failed to unquote and the
// `: value` fallback made the raw remainder the binding NAME: the name a person is asked to keep,
// drop or move was not the binding's name, and file text past it was echoed into the output.
describe("CR-4: a binding value with an inline comment unquotes to the binding name", () => {
  test("the name is SESSIONS, with no quotes and no comment text", () => {
    const sightings = scanWrangler("wrangler.toml", ["[[kv_namespaces]]", 'binding = "SESSIONS"  # the session store', ""].join("\n"));
    expect(sightings.map((s) => s.name)).toEqual(["SESSIONS"]);
  });

  test("a `#` INSIDE the quoted value is value material, not a comment", () => {
    const sightings = scanWrangler("wrangler.toml", ["[[kv_namespaces]]", 'binding = "SESS#IONS"', ""].join("\n"));
    expect(sightings.map((s) => s.name)).toEqual(["SESS#IONS"]);
  });

  test("a triple-quoted var is still tracked, so a line inside it is never mined for a key", () => {
    const names = scanWrangler("wrangler.toml", ["[vars]", 'MULTI = """', "a = not_a_name", '"""', 'AFTER = "x"', ""].join("\n")).map((s) => s.name);
    expect(names).toEqual(["MULTI", "AFTER"]);
  });
});

// CR-7 — `defaultReadFile` returns undefined above a hard cap, and the caller `continue`d with NO
// note, while the 512 KB band below it DID get one. A 3.17 MB fixture's name vanished with no trace.
describe("CR-7: a file dropped above the hard read cap is named in the notes", () => {
  test("a file the reader refuses is noted, not silently dropped", () => {
    const root = repoWith({ "huge.ts": "const a = process.env.NAME_IN_HUGE_FILE;\n" });
    const inv = inventoryRepo(root, { readFile: () => undefined });
    expect(inv.entries.map((e) => e.name)).not.toContain("NAME_IN_HUGE_FILE");
    expect(inv.notes.join("\n")).toContain("huge.ts");
  });

  test("positive control: the same file READ is reported and adds no note", () => {
    const root = repoWith({ "huge.ts": "const a = process.env.NAME_IN_HUGE_FILE;\n" });
    const inv = inventoryRepo(root);
    expect(inv.entries.map((e) => e.name)).toContain("NAME_IN_HUGE_FILE");
    expect(inv.notes.join("\n")).not.toContain("huge.ts");
  });

  test("the 512 KB threshold is measured in BYTES, not UTF-16 code units", () => {
    // Just under the cap by code units, comfortably over it by bytes: a 3-byte character per unit.
    const text = "€".repeat(MAX_SOURCE_FILE_BYTES - 10);
    expect(text.length).toBeLessThan(MAX_SOURCE_FILE_BYTES);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(MAX_SOURCE_FILE_BYTES);
    const inv = inventoryRepo(repoWith({ "wide.ts": "" }), { readFile: () => text });
    expect(inv.notes.join("\n")).toContain("over 512 KB");
  });

  test("the hard cap is a real number above the soft one, so the two bands are distinct", () => {
    expect(HARD_READ_CAP_BYTES).toBeGreaterThan(MAX_SOURCE_FILE_BYTES);
  });
});
