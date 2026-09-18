// env-no-values.test.ts — CTC-2496 acceptance criterion 2: no value is ever printed. A sentinel `.env`
// with a positive control (the sentinel really is in the fixture, so an empty scan cannot pass
// vacuously), and a structural guarantee that `.env`/`.dev.vars` are never even opened (D-5).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { inventoryRepo } from "../src/env/inventory";
import { inventoryToJson, renderInventory } from "../src/env/render";
import { MULTILINE_VALUE_SENTINEL, SENTINELS, writeFixtureRepo } from "./env-fixture-repo";

const root = writeFixtureRepo();

test("positive control: the sentinels really are in the fixture's .env", () => {
  const dotenv = readFileSync(join(root, ".env"), "utf8");
  for (const s of SENTINELS) expect(dotenv).toContain(s);
  expect(SENTINELS).toHaveLength(2);
});

test("no sentinel reaches the human output or the --json output", () => {
  const inv = inventoryRepo(root);
  const human = renderInventory(inv).join("\n");
  const json = JSON.stringify(inventoryToJson(inv));
  for (const s of SENTINELS) {
    expect(human).not.toContain(s);
    expect(json).not.toContain(s);
  }
});

describe("D-5: the scanner never opens .env or .dev.vars at all", () => {
  test("the read probe never sees .env or .dev.vars, and DID see .env.example (control)", () => {
    const realRead = (p: string): string | undefined => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    };
    const asked: string[] = [];
    inventoryRepo(root, {
      readFile: (p) => {
        asked.push(p);
        return realRead(p);
      },
    });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.some((p) => /(^|\/)\.env$/.test(p))).toBe(false);
    expect(asked.some((p) => /(^|\/)\.dev\.vars$/.test(p))).toBe(false);
    expect(asked.some((p) => p.endsWith(".env.example"))).toBe(true);
  });
});

// C-1 / S-1 (validate attempt 7): a multi-line quoted value in a `.env.example`-family file. Its
// continuation lines are shaped like assignments, so a line-oriented scan emitted 38 bytes of the
// value as a variable NAME — in the human output and in `--json`. The single-line `.env` sentinels
// above cannot catch that, which is why this fixture and this test exist.
describe("C-1: a multi-line quoted value never becomes a name", () => {
  test("positive control: the sentinel really is inside the fixture's multi-line value", () => {
    const defaults = readFileSync(join(root, ".env.defaults"), "utf8");
    expect(defaults).toContain(MULTILINE_VALUE_SENTINEL);
    expect(defaults).toContain("-----BEGIN PRIVATE KEY-----");
  });

  test("no byte of the multi-line value reaches the human output, the --json output, or any name", () => {
    const inv = inventoryRepo(root);
    const human = renderInventory(inv).join("\n");
    const json = JSON.stringify(inventoryToJson(inv));
    expect(human).not.toContain(MULTILINE_VALUE_SENTINEL);
    expect(json).not.toContain(MULTILINE_VALUE_SENTINEL);
    expect(inv.entries.map((e) => e.name)).not.toContain(`j6bFlvQ6${MULTILINE_VALUE_SENTINEL}CqOH0RhKQ`);
  });

  test("the name that OPENED the value is still reported, and scanning resumes after it closes", () => {
    const names = inventoryRepo(root).entries.map((e) => e.name);
    expect(names).toContain("GOOGLE_PRIVATE_KEY");
    expect(names).toContain("PLAIN_AFTER_KEY");
  });
});
