// ts-deps-loader.ts — lets plain Node load the Catalyst Cloud SDK.
//
// `@catalyst-cloud/sdk` depends on `@catalyst-cloud/schema` and `@catalyst-cloud/replicate`, both of
// which are published as TypeScript source (`exports: "./src/index.ts"`). Node refuses to strip types
// for files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a bare
// `import("@catalyst-cloud/sdk/node")` fails on every Node version. Bun and vitest transpile anywhere,
// which is why the SDK's other consumers never see this.
//
// This module installs two synchronous module hooks (Node 22.15+): a `load` hook that strips types
// from any `.ts` file under node_modules with Node's own `stripTypeScriptTypes`, and a `resolve` hook
// that maps a failed `./x.js` relative import onto `./x.ts` (the TS-ESM suffix convention those
// packages use). Nothing outside node_modules is touched, and the hooks are installed once.
import * as nodeModule from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface ResolveContext {
  parentURL?: string;
  conditions?: readonly string[];
}
export type ResolveResult = { url: string; format?: string | null; shortCircuit?: boolean };
export type ResolveNext = (specifier: string, context: ResolveContext) => ResolveResult;
export interface LoadContext {
  format?: string | null;
}
export type LoadResult = { format: string; source: string | ArrayBuffer | Uint8Array; shortCircuit?: boolean };
export type LoadNext = (url: string, context: LoadContext) => LoadResult;

export interface Hooks {
  resolve(specifier: string, context: ResolveContext, next: ResolveNext): ResolveResult;
  load(url: string, context: LoadContext, next: LoadNext): LoadResult;
}

type StripFn = (source: string, options?: { mode?: "strip" | "transform"; sourceUrl?: string }) => string;

/** The subset of `node:module` this loader needs; injectable so the two missing-API branches are testable. */
export interface ModuleApi {
  registerHooks?: (hooks: Hooks) => unknown;
  stripTypeScriptTypes?: StripFn;
}

let installed = false;

function inDeps(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("file:") && url.includes("/node_modules/");
}

/** Both modes this runtime offers refused the source. Naming the file and both refusals beats
 *  surfacing Node's raw `options.mode` message, which names the mode Node rejected rather than the
 *  syntax in the SOURCE that made both modes fail. */
export class StripModeError extends Error {
  readonly sourceUrl: string;
  readonly refusals: { strip: string; transform: string };
  constructor(sourceUrl: string, refusals: { strip: string; transform: string }) {
    super(
      `${sourceUrl}: could not be type-stripped by any mode this runtime offers. This usually means ` +
        `the source uses TypeScript syntax with runtime semantics (an enum, a runtime namespace, a ` +
        `parameter property, or \`export =\`) that Node's type-stripping can never erase, on a ` +
        `runtime that also refuses \`transform\`. ` +
        `strip refused: ${refusals.strip} | transform refused: ${refusals.transform}`,
    );
    this.name = "StripModeError";
    this.sourceUrl = sourceUrl;
    this.refusals = refusals;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** CTC-2483 — strip types preferring the one mode EVERY supported Node accepts.
 *
 *  ⭐ `strip` is always tried first, and that ordering is the whole fix. Node 26's
 *  `stripTypeScriptTypes` accepts only `{ mode: "strip" }` and throws ERR_INVALID_ARG_VALUE for
 *  `"transform"`, so a loader that reaches for `transform` first dies there before it ever learns
 *  whether `strip` would have worked. But `strip` is not a weaker `transform`: it REFUSES
 *  TypeScript syntax with runtime semantics (enums, runtime namespaces, parameter properties,
 *  `export =`) that `transform` erases, so `transform` stays reachable as a fallback on Node 22-25
 *  for sources that need it. */
export function stripPreferringStrip(strip: StripFn, source: string, sourceUrl: string): string {
  try {
    return strip(source, { mode: "strip", sourceUrl });
  } catch (stripError) {
    try {
      return strip(source, { mode: "transform", sourceUrl });
    } catch (transformError) {
      throw new StripModeError(sourceUrl, {
        strip: messageOf(stripError),
        transform: messageOf(transformError),
      });
    }
  }
}

/** Build the hook pair over a strip function. Pure, so a test can drive it with fake `next`s. */
export function makeHooks(strip: StripFn, fileExists: (p: string) => boolean = existsSync, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): Hooks {
  return {
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && inDeps(context.parentURL)) {
          const base = specifier.endsWith(".js") ? specifier.slice(0, -3) : specifier;
          const alt = new URL(`${base}.ts`, context.parentURL);
          if (fileExists(fileURLToPath(alt))) return { url: alt.href, format: "module", shortCircuit: true };
        }
        throw err;
      }
    },
    load(url, context, next) {
      if (inDeps(url) && url.endsWith(".ts")) {
        return { format: "module", shortCircuit: true, source: stripPreferringStrip(strip, readFile(fileURLToPath(url)), url) };
      }
      return next(url, context);
    },
  };
}

export interface LoaderVerdict {
  installed: boolean;
  /** Why the loader could not be installed, when it could not. */
  reason?: string;
}

/** Install the hooks once. Returns whether they are installed and, if not, why. */
export function installTsDepsLoader(mod: ModuleApi = nodeModule as unknown as ModuleApi): LoaderVerdict {
  if (installed) return { installed: true };
  if (typeof mod.registerHooks !== "function") {
    return { installed: false, reason: `node:module has no registerHooks on Node ${process.version}; Node 22.15 or newer is required` };
  }
  if (typeof mod.stripTypeScriptTypes !== "function") {
    return { installed: false, reason: `node:module has no stripTypeScriptTypes on Node ${process.version}; Node 22.13 or newer is required` };
  }
  // Node prints "stripTypeScriptTypes is an experimental feature" once on first use; that line would
  // land on stderr of every SDK-loading verb, so the one warning this loader provokes is dropped.
  const emit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
    if (text.includes("stripTypeScriptTypes")) return;
    (emit as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  mod.registerHooks(makeHooks(mod.stripTypeScriptTypes));
  installed = true;
  return { installed: true };
}
