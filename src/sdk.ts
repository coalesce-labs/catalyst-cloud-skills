// sdk.ts — the ONE place the Catalyst Cloud SDK is imported. Every verb that needs the replica or the
// live stream calls `loadSdk()`; nothing imports the SDK statically, so the verbs that only need HTTP
// (me, contract, explain, write, ask, ...) run on any Node 22 even when the SDK cannot load.
import type * as SdkNode from "@catalyst-cloud/sdk/node";
import { CliError } from "./errors.js";
import { installTsDepsLoader } from "./ts-deps-loader.js";

export type Sdk = typeof SdkNode;

let cached: Promise<Sdk> | null = null;

const realImport = (): Promise<Sdk> => import("@catalyst-cloud/sdk/node") as Promise<Sdk>;

/** Import the SDK's node entry, installing the type-stripping loader first. Cached per process. */
export function loadSdk(importer: () => Promise<Sdk> = realImport): Promise<Sdk> {
  if (!cached) {
    cached = (async () => {
      const verdict = installTsDepsLoader();
      try {
        return await importer();
      } catch (err) {
        cached = null;
        const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
        const why = verdict.installed ? "" : ` (${verdict.reason})`;
        throw new CliError(
          `the Catalyst Cloud SDK could not be loaded on Node ${process.version}${why}: ${detail} — this verb needs the SDK; run under Node 22.15 or newer, or under bun`,
          "sdk-unavailable",
        );
      }
    })();
  }
  return cached;
}

/** Test seam: forget the cached import. */
export function resetSdkCache(): void {
  cached = null;
}
