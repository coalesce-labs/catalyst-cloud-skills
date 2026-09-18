// env-no-values.test.ts — CTC-2496 acceptance criterion 2: no value is ever printed. A sentinel `.env`
// with a positive control (the sentinel really is in the fixture, so an empty scan cannot pass
// vacuously), and a structural guarantee that `.env`/`.dev.vars` are never even opened (D-5).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { inventoryRepo } from "../src/env/inventory";
import { inventoryToJson, renderInventory } from "../src/env/render";
import { SENTINELS, writeFixtureRepo } from "./env-fixture-repo";

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
