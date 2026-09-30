// env.ts — `catalyst env inventory` / `env check`: a LOCAL, OFFLINE, repo-scoped reporter and
// validator. Unlike every other verb in this file's siblings, `cmdEnv` never calls `requireConfig` or
// `apiClient` — it needs neither a login nor a network call, which is the whole point of the feature:
// a person reviews what a repository declares without connecting anything first.
import { existsSync, readFileSync, statSync, type Stats } from "node:fs";
import { resolve } from "node:path";
import { positionals, type ParsedArgs } from "./args.js";
import type { Ctx } from "./config.js";
import { validateSettingsToml } from "./env/settings-toml.js";
import { convertLegacyEnvironmentJson } from "./env/legacy.js";
import { inventoryRepo } from "./env/inventory.js";
import { inventoryToJson, renderInventory } from "./env/render.js";
import type { ScanDeps } from "./env/types.js";
import { UsageError } from "./errors.js";

export type EnvDeps = Partial<ScanDeps>;

export async function cmdEnv(
  args: ParsedArgs,
  ctx: Ctx,
  deps: EnvDeps = {},
): Promise<number> {
  const [sub, ...rest] = positionals(args);
  if (sub === undefined)
    throw new UsageError("env needs a subcommand: inventory | check | migrate");

  if (sub === "migrate") {
    if (rest.length > 1)
      throw new UsageError(
        `env migrate takes at most one file (got an extra "${rest[1]}")`,
      );
    const file = rest[0] ?? "catalyst.env.json";
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      ctx.stderr(`could not read legacy declaration ${file}`);
      return 1;
    }
    const result = convertLegacyEnvironmentJson(text);
    if (result.state === "invalid") {
      if (args.json) ctx.stdout(JSON.stringify(result));
      else for (const error of result.errors) ctx.stderr(error);
      return 1;
    }
    if (args.json) ctx.stdout(JSON.stringify(result));
    else ctx.stdout(result.toml);
    return 0;
  }

  if (sub === "inventory") {
    if (rest.length > 1)
      throw new UsageError(
        `env inventory takes at most one path (got an extra "${rest[1]}")`,
      );
    const root = resolve(rest[0] ?? ".");
    // C-3: walkRepo swallows a readdir failure and returns [], so without this an unreadable or
    // mistyped path printed three empty groups and exited 0 — a typo that reads as "declares nothing".
    let stat: Stats;
    try {
      stat = statSync(root);
    } catch {
      ctx.stderr(
        `${root} does not exist — env inventory takes a path to a repository`,
      );
      return 1;
    }
    if (!stat.isDirectory()) {
      ctx.stderr(
        `${root} is not a directory — env inventory takes a path to a repository`,
      );
      return 1;
    }
    const inv = inventoryRepo(root, deps);
    if (args.json) ctx.stdout(JSON.stringify(inventoryToJson(inv)));
    else for (const line of renderInventory(inv)) ctx.stdout(line);
    return 0;
  }

  if (sub === "check") {
    const file = rest[0] ?? ".catalyst/catalyst.toml";
    if (rest.length > 1)
      throw new UsageError(
        `env check takes exactly one file (got an extra "${rest[1]}")`,
      );
    if (file.endsWith("catalyst.env.json")) {
      const message =
        "catalyst.env.json is a legacy declaration and is no longer read; validate .catalyst/catalyst.toml instead";
      if (args.json)
        ctx.stdout(JSON.stringify({ state: "invalid", errors: [message] }));
      else ctx.stderr(message);
      return 1;
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if (rest[0] === undefined && !existsSync("catalyst.env.json")) {
        if (args.json)
          ctx.stdout(JSON.stringify({ state: "no-source", errors: [] }));
        else ctx.stdout("no .catalyst/catalyst.toml found in this repository");
        return 0;
      }
      if (rest[0] === undefined && existsSync("catalyst.env.json")) {
        const message =
          "No .catalyst/catalyst.toml found; this repository has a legacy catalyst.env.json, which is no longer read. Convert it to the [environment] table in .catalyst/catalyst.toml.";
        if (args.json)
          ctx.stdout(JSON.stringify({ state: "invalid", errors: [message] }));
        else ctx.stderr(message);
        return 1;
      }
      ctx.stderr(
        `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
    const result = validateSettingsToml(text);
    if (args.json) ctx.stdout(JSON.stringify(result));
    else if (result.state === "valid")
      ctx.stdout(
        `valid — ${file} contains ${result.variableNames.length} environment variable names`,
      );
    else if (result.state === "no-source")
      ctx.stdout(`no [environment] table in ${file}`);
    else for (const error of result.errors) ctx.stderr(`${file}: ${error}`);
    return result.state === "invalid" ? 1 : 0;
  }

  throw new UsageError(`unknown env subcommand "${sub}": inventory | check | migrate`);
}
