import { flagInt, flagString, positionals, type ParsedArgs } from "./args.js";
import { apiBase, requireConfig, type Ctx } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { authStrategyFor } from "./oauth.js";

export interface CachedEvent {
  tenantId: string;
  sequence: number;
  eventId: string;
  type: string;
  recordedAt: string;
  payload: unknown;
}

export interface EventSyncHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface EventsSdk {
  CatalystEventSync: new (options: {
    baseUrl: string;
    auth:
      | { kind: "token"; token: string }
      | { kind: "bearer"; getToken: () => Promise<string> };
    tenantId: string;
    fetch?: typeof fetch;
  }) => EventSyncHandle;
  defaultEventCacheDirectory(tenantId: string): string;
  readCachedEvents(options: {
    tenantId: string;
    directory?: string;
    after?: number;
  }): Promise<CachedEvent[]>;
  tailCachedEvents(options: {
    tenantId: string;
    directory?: string;
    after?: number;
    signal: AbortSignal;
  }): AsyncGenerator<CachedEvent>;
}

const eventsModule = "@catalyst-cloud/sdk/events";
export const loadEventsSdk = (): Promise<EventsSdk> =>
  import(eventsModule) as Promise<EventsSdk>;

export interface EventDeps {
  loadSdk?: () => Promise<EventsSdk>;
  signal?: AbortSignal;
}

export async function createEventSync(
  ctx: Ctx,
  deps: EventDeps = {},
): Promise<EventSyncHandle> {
  const cfg = requireConfig(ctx);
  const sdk = await (deps.loadSdk ?? loadEventsSdk)();
  const auth = authStrategyFor(ctx, cfg);
  if (auth.kind === "cookie")
    throw new CliError(
      "event sync requires a token or OAuth session",
      "events-auth",
    );
  return new sdk.CatalystEventSync({
    baseUrl: apiBase(cfg),
    auth,
    tenantId: cfg.account,
    fetch: ctx.fetch,
  });
}

export async function cmdEvents(
  args: ParsedArgs,
  ctx: Ctx,
  deps: EventDeps = {},
): Promise<number> {
  const [sub] = positionals(args);
  if (!sub)
    throw new UsageError("events needs a subcommand: tail | wait-for | query");
  if (!(["tail", "wait-for", "query"] as string[]).includes(sub))
    throw new UsageError(`unknown events subcommand: ${sub}`);
  const cfg = requireConfig(ctx);
  const sdk = await (deps.loadSdk ?? loadEventsSdk)();
  const directory =
    flagString(args, "directory") ??
    sdk.defaultEventCacheDirectory(cfg.account);
  const after = startingCursor(args, sub === "query");
  const matches = matcher(args);

  if (sub === "query") {
    const events = (
      await sdk.readCachedEvents({ tenantId: cfg.account, directory, after })
    )
      .filter(matches)
      .slice(-flagInt(args, "limit", 50));
    for (const event of events) ctx.stdout(JSON.stringify(event));
    return 0;
  }

  const controller = new AbortController();
  const abort = () => controller.abort(deps.signal?.reason);
  if (deps.signal?.aborted) abort();
  else deps.signal?.addEventListener("abort", abort, { once: true });
  const timer =
    sub === "wait-for"
      ? setTimeout(
          () => controller.abort(new Error("event wait timed out")),
          flagInt(args, "timeout", 300) * 1_000,
        )
      : undefined;
  try {
    for await (const event of sdk.tailCachedEvents({
      tenantId: cfg.account,
      directory,
      after,
      signal: controller.signal,
    })) {
      if (!matches(event)) continue;
      ctx.stdout(JSON.stringify(event));
      if (sub === "wait-for") return 0;
    }
    return sub === "wait-for" ? 1 : 0;
  } catch (error) {
    if (controller.signal.aborted) return sub === "wait-for" ? 1 : 0;
    if ((error as { code?: string }).code === "ENOENT")
      throw new CliError(
        `event cache is absent at ${directory} — start it with: catalyst-skills replica start --detach`,
        "events-absent",
        3,
      );
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abort);
  }
}

function startingCursor(
  args: ParsedArgs,
  history: boolean,
): number | undefined {
  const requested = flagString(args, "after");
  if (requested !== undefined) {
    const parsed = Number(requested);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new UsageError("--after must be a non-negative event sequence");
    return parsed;
  }
  if (history) return undefined;
  return undefined;
}

function matcher(args: ParsedArgs): (event: CachedEvent) => boolean {
  const type = flagString(args, "type");
  const ticket = flagString(args, "ticket")?.toUpperCase();
  return (event) =>
    (!type || event.type === type) &&
    (!ticket || payloadReferences(event.payload, ticket));
}

function payloadReferences(value: unknown, ticket: string): boolean {
  if (typeof value === "string") return value.toUpperCase() === ticket;
  if (Array.isArray(value))
    return value.some((item) => payloadReferences(item, ticket));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) =>
    ["ticket", "identifier", "workItemKey", "issueIdentifier"].includes(key) &&
    typeof item === "string"
      ? item.toUpperCase() === ticket
      : payloadReferences(item, ticket),
  );
}
