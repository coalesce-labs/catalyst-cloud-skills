// CTC-2483 — the loader must survive Node 26, whose `stripTypeScriptTypes` accepts ONLY
// `{ mode: "strip" }`. `makeHooks` hardcoded `mode: "transform"`, so every SDK-loading verb threw
// ERR_INVALID_ARG_VALUE there. `strip` is not a weaker `transform`: it refuses TypeScript syntax
// with runtime semantics, so `transform` has to stay reachable as a fallback on Node 22-25.
import { describe, expect, it } from "vitest";
import { makeHooks } from "../src/ts-deps-loader.js";

const DEP_URL = "file:///app/node_modules/@catalyst-cloud/sdk/src/index.ts";
const next = () => ({ format: "module" as const, source: "unused" });

/** Node 26: anything but "strip" is refused outright, before the source is even considered. */
function node26Strip(source: string, options?: { mode?: string; sourceUrl?: string }): string {
  if (options?.mode !== "strip") {
    const err = new Error(
      "The property 'options.mode' must be one of: 'strip'. Received 'transform'",
    ) as Error & { code?: string };
    err.code = "ERR_INVALID_ARG_VALUE";
    throw err;
  }
  return `stripped:${source}`;
}

describe("makeHooks strip mode (CTC-2483)", () => {
  it("loads a dependency .ts on Node 26, which accepts only mode:strip", () => {
    const hooks = makeHooks(node26Strip, () => true, () => "export const a: number = 1;");
    const out = hooks.load(DEP_URL, {}, next);
    expect(out.source).toBe("stripped:export const a: number = 1;");
  });

  it("prefers strip, so transform is never reached when strip succeeds", () => {
    const modes: string[] = [];
    const strip = (source: string, options?: { mode?: string }) => {
      modes.push(String(options?.mode));
      return source;
    };
    makeHooks(strip, () => true, () => "const a = 1;").load(DEP_URL, {}, next);
    expect(modes).toEqual(["strip"]);
  });

  it("falls back to transform when strip refuses the SOURCE and the runtime offers transform", () => {
    const modes: string[] = [];
    // Node 22-25 shape: strip refuses non-erasable syntax, transform accepts it.
    const strip = (source: string, options?: { mode?: string }) => {
      modes.push(String(options?.mode));
      if (options?.mode === "strip") throw new Error("enum is not supported with mode 'strip'");
      return `transformed:${source}`;
    };
    const out = makeHooks(strip, () => true, () => "enum E { A }").load(DEP_URL, {}, next);
    expect(modes).toEqual(["strip", "transform"]);
    expect(out.source).toBe("transformed:enum E { A }");
  });

  it("reports the file and both refusals when neither mode can strip the source", () => {
    const strip = (_s: string, options?: { mode?: string }) => {
      throw new Error(options?.mode === "strip" ? "strip refused" : "transform refused");
    };
    const load = () => makeHooks(strip, () => true, () => "enum E { A }").load(DEP_URL, {}, next);
    expect(load).toThrow(/index\.ts/);
    expect(load).toThrow(/strip refused/);
    expect(load).toThrow(/transform refused/);
  });
});
