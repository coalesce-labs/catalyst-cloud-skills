// sdk.ts — the ONE place the Catalyst Cloud SDK is imported. Every verb that needs the replica calls
// `loadSdk()`; the live stream (`watch`) calls `loadLiveSdk()`, which never touches the replica-bearing
// node entry. Nothing imports the SDK statically, so the verbs that only need HTTP (me, contract,
// explain, write, ask, ...) run on any Node 22 even when the SDK cannot load.
import type * as SdkNode from "@catalyst-cloud/sdk/node";
import type * as SdkHttp from "@catalyst-cloud/sdk";
import { CliError } from "./errors.js";
import { installTsDepsLoader } from "./ts-deps-loader.js";
import { readManifest } from "./config.js";
import { FIX_COMMAND, supportedRangeText } from "./runtime.js";

export type Sdk = typeof SdkNode;
export type HttpSdk = typeof SdkHttp;
/** The live push client alone: a cloud stream with no replica behind it. */
export type LiveSdk = Pick<HttpSdk, "LiveSyncClient">;

let cached: Promise<Sdk> | null = null;
let cachedHttp: Promise<HttpSdk> | null = null;
let cachedLive: Promise<LiveSdk> | null = null;
let cachedEvents: Promise<unknown> | null = null;

const realImport = (): Promise<Sdk> =>
  import("@catalyst-cloud/sdk/node") as Promise<Sdk>;
const realHttpImport = (): Promise<HttpSdk> =>
  import("@catalyst-cloud/sdk") as Promise<HttpSdk>;
// SDK 0.13 has no `./live` entry; its root entry carries LiveSyncClient and no replica code. Point
// this at `@catalyst-cloud/sdk/live` once the pin reaches 0.14.
const realLiveImport = (): Promise<LiveSdk> => import("@catalyst-cloud/sdk");

/** The isomorphic typed HTTP client; keeps the SDK import in this module. */
export function loadHttpSdk(
  importer: () => Promise<HttpSdk> = realHttpImport,
): Promise<HttpSdk> {
  if (!cachedHttp) {
    cachedHttp = importer().catch((err: unknown) => {
      cachedHttp = null;
      throw new CliError(
        `the Catalyst Cloud SDK HTTP client could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
        "sdk-unavailable",
      );
    });
  }
  return cachedHttp;
}

/** The live push client for `watch`, loaded without the replica-bearing node entry (CTC-4508). */
export function loadLiveSdk(importer: () => Promise<LiveSdk> = realLiveImport): Promise<LiveSdk> {
  if (!cachedLive) {
    cachedLive = importer().catch((err: unknown) => {
      cachedLive = null;
      throw new CliError(`the Catalyst Cloud SDK live client could not be loaded: ${err instanceof Error ? err.message : String(err)}`, "sdk-unavailable");
    });
  }
  return cachedLive;
}

/** Import the SDK's node entry, installing the type-stripping loader first. Cached per process. */
export function loadSdk(
  importer: () => Promise<Sdk> = realImport,
): Promise<Sdk> {
  if (!cached) {
    cached = (async () => {
      const verdict = installTsDepsLoader();
      try {
        return await importer();
      } catch (err) {
        cached = null;
        const detail =
          err instanceof Error ? err.message.split("\n")[0] : String(err);
        const why = verdict.installed ? "" : ` (${verdict.reason})`;
        throw new CliError(
          `the Catalyst Cloud SDK could not be loaded on Node ${process.version}${why}: ${detail} — this verb needs the SDK. ` +
            `Supported: ${supportedRangeText(readManifest().enginesNode)}. One command fixes it without changing your default Node: ${FIX_COMMAND}`,
          "sdk-unavailable",
        );
      }
    })();
  }
  return cached;
}

/** Events use the same supported dependency loader; capability markers are checked by the caller. */
export function loadEventsSdk(
  importer: () => Promise<unknown> = () => import("@catalyst-cloud/sdk/events"),
): Promise<unknown> {
  if (!cachedEvents) {
    cachedEvents = (async () => {
      installTsDepsLoader();
      try {
        return await importer();
      } catch {
        cachedEvents = null;
        throw new CliError(
          "the Catalyst Cloud event SDK could not be loaded; reinstall the skills bundle",
          "sdk-unavailable",
        );
      }
    })();
  }
  return cachedEvents;
}

/** Test seam: forget the cached import. */
export function resetSdkCache(): void {
  cached = null;
  cachedHttp = null;
  cachedLive = null;
  cachedEvents = null;
}

/** HTTP tenant methods live on the SDK's root entry, separate from replica/node exports. */
export async function loadTenantSdk(): Promise<
  typeof import("@catalyst-cloud/sdk")
> {
  installTsDepsLoader();
  try {
    return await import("@catalyst-cloud/sdk");
  } catch {
    throw new CliError(
      "the Catalyst Cloud SDK could not be loaded; reinstall the skills bundle",
      "sdk-unavailable",
    );
  }
}
