// runtime-verb.ts — CTC-2158, Tier 2. `catalyst-skills runtime status|install|path|uninstall`: the
// verb every unsupported-runtime message points at. It downloads the pinned Node named by
// package.json's `catalystCloud.pinnedNode`, verifies it, and unpacks it under this CLI's own
// cache — it never touches the machine's default Node and needs no admin rights.
import { positionals, type ParsedArgs } from "./args.js";
import { readManifest, type Ctx } from "./config.js";
import { UsageError } from "./errors.js";
import { FIX_COMMAND, detectRuntime, runtimeVerdict } from "./runtime.js";
import { installPinnedRuntime, readPin, uninstallPinnedRuntime, type InstallOptions } from "./runtime-store.js";

export interface RuntimeVerbDeps {
  home?: string;
  platform?: string;
  arch?: string;
  fetchText?: InstallOptions["fetchText"];
  fetchBytes?: InstallOptions["fetchBytes"];
  extract?: InstallOptions["extract"];
}

export async function cmdRuntime(args: ParsedArgs, ctx: Ctx, deps: RuntimeVerbDeps = {}): Promise<number> {
  const [sub = "status"] = positionals(args);
  const home = deps.home ?? ctx.home;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const manifest = readManifest();

  switch (sub) {
    case "status": {
      const pin = readPin(home);
      const ambient = detectRuntime();
      const ambientVerdict = runtimeVerdict(ambient, manifest.enginesNode);
      const supported = pin ? true : ambientVerdict.supported;
      if (args.json) {
        ctx.stdout(JSON.stringify({ pinned: pin, ambient, supported }));
        return supported ? 0 : 1;
      }
      if (!pin) {
        ctx.stdout(`no pinned runtime installed — ambient: ${ambientVerdict.line}`);
        if (!ambientVerdict.supported) ctx.stdout(`fix: ${FIX_COMMAND}`);
        return ambientVerdict.supported ? 0 : 1;
      }
      ctx.stdout(`pinned: Node ${pin.version} at ${pin.nodePath}`);
      ctx.stdout(`ambient: ${ambientVerdict.line}`);
      return 0;
    }
    case "install": {
      const result = await installPinnedRuntime({
        home,
        version: manifest.pinnedNode,
        platform,
        arch,
        fetchText: deps.fetchText,
        fetchBytes: deps.fetchBytes,
        extract: deps.extract,
      });
      ctx.stdout(
        result.alreadyPresent
          ? `Node ${result.version} is already installed at ${result.nodePath}`
          : `Installed Node ${result.version} at ${result.nodePath} — this CLI now runs on it regardless of your machine's default Node`,
      );
      return 0;
    }
    case "path": {
      const pin = readPin(home);
      if (!pin) return 1;
      ctx.stdout(pin.nodePath);
      return 0;
    }
    case "uninstall": {
      const removed = uninstallPinnedRuntime(home);
      ctx.stdout(removed ? "removed the pinned runtime" : "no pinned runtime to remove");
      return 0;
    }
    default:
      throw new UsageError(`unknown runtime subcommand: ${sub} (expected: status | install | path | uninstall)`);
  }
}
