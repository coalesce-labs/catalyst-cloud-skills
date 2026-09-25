// Self-service recovery only. Personal OAuth normally binds the Linear viewer automatically.
import type { TenantClient, TenantClientOptions, LinearIdentityResult } from "@catalyst-cloud/sdk";
import { positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { bearerFor } from "./oauth.js";
import { loadHttpSdk } from "./sdk.js";
export interface IdentityDeps {
  createClient?: (options: TenantClientOptions) => Promise<Pick<TenantClient, "linearIdentity">> | Pick<TenantClient, "linearIdentity">;
}
function render(result: LinearIdentityResult, choices: boolean): string {
  if (result.outcome !== "ok") return `Linear identity: ${result.outcome}${"reason" in result ? ` (${result.reason})` : ""}`;
  const { identity } = result;
  const summary = `Linear identity: ${identity.resolution}${"linearUserId" in identity ? ` (${identity.linearUserId})` : ""}`;
  if (!choices) return summary;
  if (result.options === undefined) return `${summary}\nNo choices were offered. An automatic match cannot be replaced; an unmatched roster may need a retry.`;
  if (result.options.length === 0) return `${summary}\nThe workspace roster has no eligible people.`;
  return [summary, ...result.options.map((o) => `${o.id}\t${o.displayName ?? o.name ?? "(unnamed)"}`), "Select your own identity explicitly: catalyst-skills identity linear set <linearUserId>"].join("\n");
}
export async function cmdIdentity(args: ParsedArgs, ctx: Ctx, deps: IdentityDeps = {}): Promise<number> {
  const parts = positionals(args);
  const [provider, action, selected] = parts;
  if (provider !== "linear" || !["status", "options", "set"].includes(action ?? "") ||
      (action === "set" ? parts.length !== 3 || !selected?.trim() : parts.length !== 2)) {
    throw new UsageError("identity takes: linear <status|options> or linear set <linearUserId>");
  }
  const cfg = requireConfig(ctx);
  if (!cfg.user) throw new CliError("this machine uses a tenant account key; run catalyst-skills login as yourself", "member-required");
  const createClient = deps.createClient ?? (async (options: TenantClientOptions) => (await loadHttpSdk()).createTenantClient(options));
  const client = await createClient({ key: await bearerFor(ctx, cfg), baseUrl: cfg.baseUrl, fetch: ctx.fetch });
  if (!client.linearIdentity) throw new CliError("the installed SDK lacks identity recovery; upgrade catalyst-skills after the SDK release", "sdk-upgrade-required");
  if (action === "set") {
    // The arity check above requires a selection; never choose the first roster entry for a person.
    if (selected === undefined) throw new UsageError("linearUserId is required");
    const written = await client.linearIdentity.set(selected);
    if (written.outcome !== "ok") {
      ctx.stdout(args.json ? JSON.stringify(written) : render(written, false));
      return 1;
    }
    const verified = await client.linearIdentity.get();
    if (verified.outcome !== "ok" || !("linearUserId" in verified.identity) || verified.identity.linearUserId !== selected) {
      ctx.stdout(args.json ? JSON.stringify({ outcome: "not-confirmed", identity: verified }) : `Linear identity selection was not confirmed. Read the current status before retrying.\n${render(verified, false)}`);
      return 1;
    }
    ctx.stdout(args.json ? JSON.stringify(verified) : render(verified, false));
    return 0;
  }
  const result = await client.linearIdentity.get();
  ctx.stdout(args.json ? JSON.stringify(result) : render(result, action === "options"));
  return result.outcome === "ok" ? 0 : 1;
}
