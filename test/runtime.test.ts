// runtime.test.ts — CTC-2158. The runtime contract: what this process is running on, whether that
// runtime can run the CLI, and (when not) the one command that fixes it. Every fixture below is a
// measurement recorded in the CTC-2158 research/plan, not a guess: Node 22.14.0 has no
// node:module.registerHooks; bun 1.3.14 has no node:sqlite and reports process.versions.node as its
// own Node-compat major (24.3.0), never its own bun version.
import { describe, expect, test } from "vitest";
import { BUN_MIN, FIX_COMMAND, detectRuntime, parseNodeFloor, runtimeVerdict, supportedRangeText, versionAtLeast } from "../src/runtime";

describe("parseNodeFloor", () => {
  test("parses the one range form this package declares", () => {
    expect(parseNodeFloor(">=22.15")).toEqual({ major: 22, minor: 15, patch: 0 });
    expect(parseNodeFloor(">= 24.0.1")).toEqual({ major: 24, minor: 0, patch: 1 });
  });
  test("throws a named error naming engines.node, rather than guessing", () => {
    expect(() => parseNodeFloor("^22 || >=24")).toThrow(/engines\.node/);
  });
});

describe("versionAtLeast", () => {
  test("compares major, then minor, then patch", () => {
    expect(versionAtLeast("22.15.0", { major: 22, minor: 15, patch: 0 })).toBe(true);
    expect(versionAtLeast("22.14.9", { major: 22, minor: 15, patch: 0 })).toBe(false);
    expect(versionAtLeast("23.0.0", { major: 22, minor: 15, patch: 0 })).toBe(true);
  });
});

describe("detectRuntime", () => {
  test("names bun when bun is running, with bun's own version — never its node compat major", () => {
    // Measured in this container: bun 1.3.14 reports process.versions.node === "24.3.0".
    expect(detectRuntime({ node: "24.3.0", bun: "1.3.14" })).toEqual({
      kind: "bun",
      version: "1.3.14",
      nodeCompat: "24.3.0",
    });
  });
  test("names node when no bun version is present", () => {
    expect(detectRuntime({ node: "26.8.1" })).toEqual({ kind: "node", version: "26.8.1", nodeCompat: "26.8.1" });
  });
  test("names unknown when neither is present", () => {
    expect(detectRuntime({})).toEqual({ kind: "unknown", version: "0", nodeCompat: "0" });
  });
});

describe("runtimeVerdict", () => {
  const range = ">=22.15";

  test("a supported node is supported and the line names the version and the range", () => {
    const v = runtimeVerdict({ kind: "node", version: "26.8.1", nodeCompat: "26.8.1" }, range);
    expect(v.supported).toBe(true);
    expect(v.line).toContain("Node 26.8.1");
    expect(v.line).toContain("22.15");
    expect(v.fix).toBeUndefined();
  });

  // The measured floor: 22.14.0 has no node:module registerHooks, so the SDK cannot load there.
  test("Node 22.14.0 is NOT supported, and the reason names registerHooks and the floor", () => {
    const v = runtimeVerdict({ kind: "node", version: "22.14.0", nodeCompat: "22.14.0" }, range);
    expect(v.supported).toBe(false);
    expect(v.reason).toMatch(/registerHooks/);
    expect(v.reason).toMatch(/22\.15/);
    expect(v.fix).toBe(FIX_COMMAND);
  });

  test("bun below the measured floor is NOT supported and the reason names node:sqlite and the floor", () => {
    const v = runtimeVerdict({ kind: "bun", version: "1.3.14", nodeCompat: "24.3.0" }, range);
    expect(v.supported).toBe(false);
    expect(v.reason).toMatch(/node:sqlite/);
    expect(v.reason).toContain(BUN_MIN);
    expect(v.fix).toBe(FIX_COMMAND);
  });

  test("bun at or above the floor is supported, and the line names bun's own version, not its node compat major", () => {
    const v = runtimeVerdict({ kind: "bun", version: "1.4.2", nodeCompat: "26.3.0" }, range);
    expect(v.supported).toBe(true);
    expect(v.line).toContain("bun 1.4.2");
    expect(v.line).not.toContain("26.3.0");
  });

  test("an unknown runtime is unsupported and says which runtimes are supported", () => {
    const v = runtimeVerdict({ kind: "unknown", version: "0", nodeCompat: "0" }, range);
    expect(v.supported).toBe(false);
    expect(v.line).toMatch(/Node/);
    expect(v.line).toMatch(/bun/);
    expect(v.fix).toBe(FIX_COMMAND);
  });
});

describe("the whole package speaks with one voice", () => {
  // Tier 1, second clause: no string may offer bun as a fallback without naming the floor.
  test("every bun mention in the verdict text carries the version floor", () => {
    const cases: { kind: "node" | "bun" | "unknown"; version: string; nodeCompat: string }[] = [
      { kind: "node", version: "22.14.0", nodeCompat: "22.14.0" },
      { kind: "bun", version: "1.3.14", nodeCompat: "24.3.0" },
      { kind: "unknown", version: "0", nodeCompat: "0" },
    ];
    for (const facts of cases) {
      const v = runtimeVerdict(facts, ">=22.15");
      const text = `${v.line} ${v.reason ?? ""} ${v.fix ?? ""}`;
      if (/bun/i.test(text)) expect(text).toContain(BUN_MIN);
    }
  });

  test("the range text is derived from the manifest range, not written twice", () => {
    expect(supportedRangeText(">=22.15")).toContain("22.15");
    expect(supportedRangeText(">=24.0.0")).toContain("24.0");
    expect(supportedRangeText(">=22.15")).toContain(BUN_MIN);
  });
});
