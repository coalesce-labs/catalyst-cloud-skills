import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseArgs } from "../src/args.js";
import { cmdLegacy, OLD_DATA_DIRS, type LegacyDeps } from "../src/legacy.js";
import { makeCtx } from "./helpers.js";

const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "legacy-data-safety-")); homes.push(home);
  const ctx = makeCtx(home);
  const calls: string[] = [];
  const deps: LegacyDeps = { platform: "darwin", uid: 501, isTty: () => true, run: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { status: 0, stdout: "", stderr: "" }; } };
  const write = (rel: string, bytes = "sentinel") => { const path = join(home, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return path; };
  return { home, ctx, deps, calls, write };
}
const removal = (flags: string[] = []) => parseArgs(["legacy", "--remove", ...flags]);
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("CTC-4496 legacy cleanup always keeps shared data", () => {
  test("even explicit data cleanup preserves all five shared roots and modern state byte-for-byte", async () => {
    const f = fixture();
    const paths = [...OLD_DATA_DIRS.map(rel => `${rel}/unclassified-sentinel`), ".catalyst/logs/install.log", ".catalyst/hosts/host.json", ".catalyst/seats/seat.json", ".local/state/catalyst/skills-install/receipt.json", ".local/state/catalyst/install/last-run.json"];
    for (const rel of paths) f.write(rel, `modern:${rel}`);
    await cmdLegacy(removal(["--data", "--yes"]), f.ctx, f.deps);
    for (const rel of paths) expect(existsSync(join(f.home, rel)) && readFileSync(join(f.home, rel), "utf8")).toBe(`modern:${rel}`);
    for (const rel of OLD_DATA_DIRS) expect(statSync(join(f.home, rel)).isDirectory()).toBe(true);
  });

  test("the old bin directory and unclassified children survive removal", async () => {
    const f = fixture(); const path = f.write(".catalyst/bin/customer-tool", "unclassified customer executable");
    await cmdLegacy(removal(["--data", "--yes"]), f.ctx, f.deps);
    expect(existsSync(path) && readFileSync(path, "utf8")).toBe("unclassified customer executable");
  });

  test("data-only explicit cleanup succeeds while reporting kept roots and no false removals", async () => {
    const f = fixture(); f.write(".local/state/catalyst/logs/current.log", "current log");
    expect(await cmdLegacy(removal(["--data", "--yes", "--json"]), f.ctx, f.deps)).toBe(0);
    const report = JSON.parse(f.ctx.out.at(-1)!);
    expect(report.removed).toEqual([]);
    expect(report.kept.some((item: { path: string }) => item.path === join(f.home, ".local/state/catalyst"))).toBe(true);
    expect(readFileSync(join(f.home, ".local/state/catalyst/logs/current.log"), "utf8")).toBe("current log");
  });


  test("a directory at an exact legacy command name is kept with its unknown children", async () => {
    const f = fixture();
    const path = f.write(".local/bin/catalyst-hud/customer-file", "current command directory");
    expect(await cmdLegacy(removal(["--data", "--yes", "--json"]), f.ctx, f.deps)).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("current command directory");
    expect(f.calls).toEqual([]);
    const result = JSON.parse(f.ctx.out.at(-1)!);
    expect(result.removed).toEqual([]);
    expect(result.failed.some((row: { item: { path: string } }) => row.item.path === join(f.home, ".local/bin/catalyst-hud"))).toBe(true);
  });

});
