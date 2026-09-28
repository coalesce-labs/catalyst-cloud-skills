// A member starts personal provider consent here, then approves it in their own browser.
// The Cloud SDK owns the routes and response parsing. A tenant account key cannot identify a person.
import type { TenantClient, TenantClientOptions, PersonalConnectionProvider, PersonalConnectionStatusResult } from "@catalyst-cloud/sdk";
import { flagInt, positionals, type ParsedArgs } from "./args.js";
import { openBrowser as defaultOpenBrowser } from "./browser.js";
import { requireConfig, type Ctx } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { bearerFor } from "./oauth.js";
import { loadHttpSdk } from "./sdk.js";

type ConnectionClient = Pick<TenantClient, "personalConnections">;

export interface ConnectionsDeps {
  createClient?: (options: TenantClientOptions) => Promise<ConnectionClient> | ConnectionClient;
  openBrowser?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const waitIntervalSeconds = 10;

function parseCommand(args: ParsedArgs): { provider: PersonalConnectionProvider; action: "start" | "status"; waitSeconds: number } {
  const parts = positionals(args);
  if (parts.length !== 3 || parts[0] !== "personal" || (parts[1] !== "linear" && parts[1] !== "github") ||
      (parts[2] !== "start" && parts[2] !== "status")) {
    throw new UsageError("connections takes: personal <linear|github> <start|status>");
  }
  const waitSeconds = flagInt(args, "wait", 0);
  if (waitSeconds < 0 || waitSeconds > 600) throw new UsageError("--wait must be between 0 and 600 seconds");
  if (parts[2] !== "start" && args.flags.wait !== undefined) throw new UsageError("--wait is only valid with connections personal <provider> start");
  return { provider: parts[1], action: parts[2], waitSeconds };
}

function statusLine(provider: PersonalConnectionProvider, result: PersonalConnectionStatusResult): string {
  const name = provider === "linear" ? "Linear" : "GitHub";
  switch (result.outcome) {
    case "connected":
      return `Personal ${name}: connected as ${result.provider === "linear" ? result.linearUserId : result.githubLogin}`;
    case "absent":
      return `Personal ${name}: not connected — run catalyst-skills connections personal ${provider} start`;
    case "lapsed":
      return `Personal ${name}: connection expired — run catalyst-skills connections personal ${provider} start`;
    case "unavailable":
      return `Personal ${name}: temporarily unavailable — the grant state is unknown; retry status later`;
    default:
      return `Personal ${name}: ${result.outcome}${"reason" in result ? ` (${result.reason})` : ""}`;
  }
}

function statusExit(result: PersonalConnectionStatusResult): number {
  return result.outcome === "connected" || result.outcome === "absent" || result.outcome === "lapsed" ? 0 : 1;
}

export async function cmdConnections(args: ParsedArgs, ctx: Ctx, deps: ConnectionsDeps = {}): Promise<number> {
  const { provider, action, waitSeconds } = parseCommand(args);
  const cfg = requireConfig(ctx);
  if (!cfg.user) throw new CliError("this machine uses a tenant account key, not a member credential — run catalyst-skills login as yourself", "member-required");
  const createClient = deps.createClient ?? (async (options: TenantClientOptions) => (await loadHttpSdk()).createTenantClient(options));
  const client = await createClient({ key: await bearerFor(ctx, cfg), baseUrl: cfg.baseUrl, fetch: ctx.fetch });

  if (action === "status") {
    const result = await client.personalConnections.status(provider);
    ctx.stdout(args.json ? JSON.stringify(result) : statusLine(provider, result));
    return statusExit(result);
  }

  const started = await client.personalConnections.start(provider);
  if (started.outcome !== "ok") {
    ctx.stdout(args.json ? JSON.stringify(started) : `Personal ${provider} connection could not start: ${started.outcome}${"reason" in started ? ` (${started.reason})` : ""}`);
    return 1;
  }
  if (!args.json) {
    ctx.stdout(`Open this URL in your browser to approve your personal ${provider} connection:`);
    ctx.stdout(started.authorizationUrl);
    (deps.openBrowser ?? defaultOpenBrowser)(started.authorizationUrl);
  }
  if (waitSeconds === 0) {
    if (args.json) ctx.stdout(JSON.stringify(started));
    else ctx.stdout(`After approval, run: catalyst-skills connections personal ${provider} status`);
    return 0;
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let waitedSeconds = 0;
  let status = await client.personalConnections.status(provider);
  while ((status.outcome === "absent" || status.outcome === "lapsed") && waitedSeconds < waitSeconds) {
    const seconds = Math.min(waitIntervalSeconds, waitSeconds - waitedSeconds);
    await sleep(seconds * 1000);
    waitedSeconds += seconds;
    status = await client.personalConnections.status(provider);
  }
  if (args.json) ctx.stdout(JSON.stringify({ start: started, status, waitedSeconds }));
  else {
    ctx.stdout(statusLine(provider, status));
    if (status.outcome === "absent" || status.outcome === "lapsed") ctx.stdout(`Approval has not appeared yet; run catalyst-skills connections personal ${provider} status later.`);
  }
  return status.outcome === "connected" ? 0 : status.outcome === "absent" || status.outcome === "lapsed" ? 2 : 1;
}
