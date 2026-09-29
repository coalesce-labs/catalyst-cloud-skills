// env-no-values.test.ts — CTC-2496 acceptance criterion 2: no value is ever printed. A sentinel `.env`
// with a positive control (the sentinel really is in the fixture, so an empty scan cannot pass
// vacuously), and a structural guarantee that `.env`/`.dev.vars` are never even opened (D-5).
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { inventoryRepo } from "../src/env/inventory";
import { inventoryToJson, renderInventory } from "../src/env/render";
import { MULTILINE_VALUE_SENTINEL, SENTINELS, UNQUOTED_MULTILINE_SENTINEL, writeFixtureRepo } from "./env-fixture-repo";

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

// ⭐ M-1 / CR-2 (validate attempt 29) — THE UNQUOTED FORM OF THE SAME LEAK. The block above pins the
// QUOTED case, which is why acceptance criterion 2 passed while the guarantee did not hold: an
// unquoted PEM block — the ordinary way one is pasted into a `.env.example`-family file — opened no
// quote, so nothing was tracked and the base64 body's pre-"=" run was emitted as a variable NAME.
describe("M-1: an UNQUOTED multi-line value never becomes a name either", () => {
  test("positive control: the sentinel really is inside the fixture's unquoted value", () => {
    const template = readFileSync(join(root, ".env.template"), "utf8");
    expect(template).toContain(UNQUOTED_MULTILINE_SENTINEL);
    expect(template).toContain("-----BEGIN RSA PRIVATE KEY-----");
    // And it really is unquoted — otherwise this fixture would only re-test the case above.
    expect(template).not.toContain('="-----BEGIN');
  });

  test("no byte of the unquoted value reaches the human output, the --json output, or any name", () => {
    const inv = inventoryRepo(root);
    const human = renderInventory(inv).join("\n");
    const json = JSON.stringify(inventoryToJson(inv));
    expect(human).not.toContain(UNQUOTED_MULTILINE_SENTINEL);
    expect(json).not.toContain(UNQUOTED_MULTILINE_SENTINEL);
    for (const name of inv.entries.map((e) => e.name)) expect(name).not.toContain(UNQUOTED_MULTILINE_SENTINEL);
  });

  test("the name that OPENED the value is still reported, and scanning resumes after -----END", () => {
    const names = inventoryRepo(root).entries.map((e) => e.name);
    expect(names).toContain("UNQUOTED_PRIVATE_KEY");
    expect(names).toContain("PLAIN_AFTER_UNQUOTED_KEY");
  });
});

// CR-3 (validate attempt 29) — the mirror-image defect: the tracker engaging when it must NOT. A
// COMMENTED assignment whose value opens a quote used to swallow every following line, so real
// documented names vanished from the inventory with no note at all.
describe("CR-3: a commented assignment with an open quote does not swallow the lines after it", () => {
  test("positive control: the fixture really does open a quote on a commented line", () => {
    expect(readFileSync(join(root, ".env.sample"), "utf8")).toContain('#COMMENTED_OPEN="still open');
  });

  test("the uncommented names after it are still reported", () => {
    const names = inventoryRepo(root).entries.map((e) => e.name);
    expect(names).toContain("AFTER_COMMENTED_ONE");
    expect(names).toContain("AFTER_COMMENTED_TWO");
  });
});

// ⭐ M-2 / CR-5 (validate attempt 29) — D-5 WAS A NAMING CONVENTION, NOT A STRUCTURAL GUARANTEE. The
// dispatch keyed on the WALKED basename, and a basename is exactly what a symlink controls: a
// committed `.env.example -> .env` routed the real `.env` into the scanner, and a directory link
// walked outside the repository entirely. The probe in the D-5 block above cannot catch it — it only
// ever sees the string `…/.env.example`, which is precisely the path being asked for.
describe("M-2: a symlink cannot smuggle a file past D-5, or the walk out of the repository", () => {
  const evil = mkdtempSync(join(tmpdir(), "catalyst-env-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "catalyst-env-outside-"));
  const repo = join(evil, "repo");
  const SECRET = "SENTINEL-SMUGGLED-VALUE-4d17";
  const OUTSIDE_NAME = "OUTSIDE_SECRET_NAME";

  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, ".env"), `SMUGGLED_NAME=${SECRET}\n`);
  symlinkSync(join(repo, ".env"), join(repo, ".env.example"));
  writeFileSync(join(outside, ".env.example"), `${OUTSIDE_NAME}=\n`);
  symlinkSync(outside, join(repo, "elsewhere"));
  // A cycle: `up -> ..`. Following it re-entered the same tree until the kernel stopped the walk,
  // reporting one name dozens of times with absurd file:line pairs.
  mkdirSync(join(repo, "pkg"), { recursive: true });
  writeFileSync(join(repo, "pkg", "app.ts"), "const a = process.env.CYCLE_NAME;\n");
  symlinkSync(join(repo, "pkg"), join(repo, "pkg", "up"));

  test("positive control: the real .env, the outside file and the cycle are all really there", () => {
    expect(readFileSync(join(repo, ".env"), "utf8")).toContain(SECRET);
    expect(readFileSync(join(repo, ".env.example"), "utf8")).toContain(SECRET); // the link DOES open it
    expect(readFileSync(join(outside, ".env.example"), "utf8")).toContain(OUTSIDE_NAME);
  });

  test("the real .env is never read through the link: no name and no value out of it", () => {
    const inv = inventoryRepo(repo);
    const printed = `${renderInventory(inv).join("\n")}\n${JSON.stringify(inventoryToJson(inv))}`;
    expect(printed).not.toContain(SECRET);
    expect(inv.entries.map((e) => e.name)).not.toContain("SMUGGLED_NAME");
  });

  test("a directory link pointing outside the repository is not walked", () => {
    expect(inventoryRepo(repo).entries.map((e) => e.name)).not.toContain(OUTSIDE_NAME);
  });

  test("CR-5: a symlink cycle is walked once, so the name inside it is reported exactly once", () => {
    const inv = inventoryRepo(repo);
    const cycle = inv.entries.find((e) => e.name === "CYCLE_NAME");
    expect(cycle, "the cycle's real file must still be scanned").toBeDefined();
    expect(cycle!.found.map((f) => f.file)).toEqual(["pkg/app.ts"]);
  });
});
