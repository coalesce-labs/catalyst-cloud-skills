import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseArgs } from "../src/args.js";
import { defaultCtx } from "../src/config.js";
import { cmdOnboard, ONBOARD_STEPS, type OnboardDeps } from "../src/onboard.js";
import { SETUP_NUMBERS } from "../src/setup-onboard-copy.js";

test("actual onboarding checks finish this computer first and keep Work in plan order", async () => {
  const home = mkdtempSync(join(tmpdir(), "onboard-order-"));
  const checked: string[] = [];
  const adapters: OnboardDeps["adapters"] = Object.fromEntries(
    ONBOARD_STEPS.map((id) => [
      id,
      {
        check: async () => {
          checked.push(id);
          return { state: "done" as const };
        },
      },
    ]),
  );
  try {
    expect(
      await cmdOnboard(
        parseArgs(["onboard", "--yes"]),
        { ...defaultCtx(), home, env: {}, stdout: () => {}, stderr: () => {} },
        { adapters, bindSignals: false },
      ),
    ).toBe(0);
    expect(checked.indexOf("daemon")).toBeGreaterThan(
      checked.indexOf("signin"),
    );
    expect(checked.indexOf("housekeeping")).toBeGreaterThan(
      checked.indexOf("daemon"),
    );
    expect(checked.indexOf("housekeeping")).toBeLessThan(
      checked.indexOf("linear.workspace"),
    );
    expect(checked.indexOf("capacity")).toBeGreaterThan(
      checked.indexOf("accounts"),
    );
    expect(checked.indexOf("runner")).toBeLessThan(checked.indexOf("settings"));
    expect(checked.indexOf("settings")).toBeLessThan(
      checked.indexOf("first-ticket"),
    );
    const numbered = checked
      .map((id) => SETUP_NUMBERS[id as keyof typeof SETUP_NUMBERS])
      .filter((n): n is number => n !== undefined);
    expect(numbered).toEqual(expect.arrayContaining([4, 5, 6, 14, 15, 16, 17]));
    expect(numbered).toEqual([...numbered].sort((a, b) => a - b));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
