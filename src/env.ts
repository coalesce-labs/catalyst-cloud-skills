// env.ts — `catalyst-skills env inventory` / `env check`: a LOCAL, OFFLINE, repo-scoped reporter and
// validator. Unlike every other verb in this file's siblings, `cmdEnv` never calls `requireConfig` or
// `apiClient` — it needs neither a login nor a network call, which is the whole point of the feature:
// a person reviews what a repository declares without connecting anything first.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { positionals, type ParsedArgs } from "./args.js";
import type { Ctx } from "./config.js";
import { validateDeclaration } from "./env/declaration-rules.js";
import { inventoryRepo } from "./env/inventory.js";
import { inventoryToJson, renderCheck, renderInventory } from "./env/render.js";
import type { ScanDeps } from "./env/types.js";
import { UsageError } from "./errors.js";

export type EnvDeps = Partial<ScanDeps>;

export async function cmdEnv(args: ParsedArgs, ctx: Ctx, deps: EnvDeps = {}): Promise<number> {
  const [sub, ...rest] = positionals(args);
  if (sub === undefined) throw new UsageError("env needs a subcommand: inventory | check");

  if (sub === "inventory") {
    if (rest.length > 1) throw new UsageError(`env inventory takes at most one path (got an extra "${rest[1]}")`);
    const root = resolve(rest[0] ?? ".");
    const inv = inventoryRepo(root, deps);
    if (args.json) ctx.stdout(JSON.stringify(inventoryToJson(inv)));
    else for (const line of renderInventory(inv)) ctx.stdout(line);
    return 0;
  }

  if (sub === "check") {
    const file = rest[0];
    if (!file) throw new UsageError("env check needs a file: catalyst-skills env check <path to catalyst.env.json>");
    if (rest.length > 1) throw new UsageError(`env check takes exactly one file (got an extra "${rest[1]}")`);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      ctx.stderr(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      ctx.stderr(`${file} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    const errors = validateDeclaration(doc);
    const state = errors.length === 0 ? "valid" : "invalid";
    if (args.json) ctx.stdout(JSON.stringify({ state, errors }));
    else for (const line of renderCheck({ state, errors }, file)) ctx.stdout(line);
    return state === "valid" ? 0 : 1;
  }

  throw new UsageError(`unknown env subcommand "${sub}": inventory | check`);
}
