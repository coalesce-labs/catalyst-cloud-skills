import { flagInt, flagString, positionals, type ParsedArgs } from "./args.js";
import { normalizeBaseUrl, requireConfig, type Ctx } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import { authStrategyFor } from "./oauth.js";
import { eventCacheStatus } from "./event-status.js";
import { cloudEventHead, queryCloudEvents } from "./events-cloud.js";
import { eventMatches, tailCloudEvents, waitForCloudEvent, type CloudTailDeps, type NdjsonSink } from "./events-cloud-tail.js";

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
  /** Where cloud `tail` and `wait-for` write NDJSON; defaults to the process stdout stream. */
  out?: NdjsonSink;
  /** Test seam for the cloud reader. */
  cloud?: CloudTailDeps;
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
    // Events SDK adds /api/v1/events/backbone itself; unlike the replica it takes an origin.
    baseUrl: normalizeBaseUrl(cfg.baseUrl),
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
    throw new UsageError(
      "events needs a subcommand: tail | wait-for | query | status",
    );
  if (!(["tail", "wait-for", "query", "status"] as string[]).includes(sub))
    throw new UsageError(`unknown events subcommand: ${sub}`);
  // CTC-4554 — the cloud is the default source; the local event file is the opt-in.
  if (args.flags["from-cache"] !== true) {
    if (flagString(args, "directory") !== undefined)
      throw new UsageError("--directory names the local event cache; add --from-cache to read it");
    return cmdCloudEvents(sub, args, ctx, deps);
  }
  const cfg = requireConfig(ctx);
  const sdk = await (deps.loadSdk ?? loadEventsSdk)();
  const directory =
    flagString(args, "directory") ??
    sdk.defaultEventCacheDirectory(cfg.account);
  if (sub === "status") {
    const status = await eventCacheStatus(
      ctx,
      directory,
      args.flags.probe === true,
    );
    ctx.stdout(
      args.json
        ? JSON.stringify({ source: "cache", ...status })
        : `events: local cache ${status.verdict} at ${directory}${status.reasons.length ? ` (${status.reasons.join("; ")})` : ` (cursor ${status.cursor}, cloud head ${status.head})`}`,
    );
    return status.verdict === "current"
      ? 0
      : status.verdict === "stale"
        ? 1
        : status.verdict === "absent"
          ? 3
          : 2;
  }
  const after = startingCursor(args);
  const matches = eventMatches(eventFilter(args));

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
        `event cache is absent at ${directory}: it is written only where local sync runs. Start the local writer with: catalyst replica start --detach, or drop --from-cache to read from the cloud`,
        "events-absent",
        3,
      );
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abort);
  }
}

function startingCursor(args: ParsedArgs, name = "after"): number | undefined {
  const requested = flagString(args, name);
  if (requested === undefined) return undefined;
  const parsed = Number(requested);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new UsageError(`--${name} must be a non-negative event sequence`);
  return parsed;
}

function eventFilter(args: ParsedArgs): { type?: string; ticket?: string } {
  const type = flagString(args, "type");
  const ticket = flagString(args, "ticket")?.toUpperCase();
  return { ...(type ? { type } : {}), ...(ticket ? { ticket } : {}) };
}

/** A sink over `ctx.stdout` for contexts without a stream (tests): one call per line. */
function lineSink(ctx: Ctx): NdjsonSink {
  return {
    write(chunk, callback) {
      try {
        ctx.stdout(chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk);
        callback();
      } catch (error) {
        callback(error as Error);
      }
      return true;
    },
    on: () => undefined,
    off: () => undefined,
  };
}

const QUERY_MAX_LIMIT = 200;
const LOCAL_SYNC_HINT =
  "several agents on one machine are cheaper sharing one local cache: opt in to local sync (catalyst onboard --local-sync), then read it with --from-cache";

/** CTC-4554 — `events tail | wait-for | query | status` against the cloud, with no local file. */
async function cmdCloudEvents(
  sub: string,
  args: ParsedArgs,
  ctx: Ctx,
  deps: EventDeps,
): Promise<number> {
  requireConfig(ctx);
  const filter = eventFilter(args);
  if (sub === "status") {
    const head = await cloudEventHead(ctx);
    const status = { source: "cloud", head, behind: 0, note: LOCAL_SYNC_HINT };
    ctx.stdout(
      args.json
        ? JSON.stringify(status)
        : `events: cloud stream at head ${head}, 0 behind (every read goes to the cloud; ${LOCAL_SYNC_HINT})`,
    );
    return 0;
  }
  if (sub === "query") {
    const limit = flagInt(args, "limit", 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_MAX_LIMIT)
      throw new UsageError(`--limit must be between 1 and ${QUERY_MAX_LIMIT} for a cloud query`);
    const order = flagString(args, "order") ?? "desc";
    if (order !== "asc" && order !== "desc") throw new UsageError("--order must be asc or desc");
    const page = await queryCloudEvents(ctx, {
      ...filter,
      limit,
      order,
      afterSeq: startingCursor(args, "after"),
      beforeSeq: startingCursor(args, "before"),
    });
    for (const event of page.events) ctx.stdout(JSON.stringify(event));
    if (page.next)
      ctx.stderr(`more: re-run with --${page.next.param === "beforeSeq" ? "before" : "after"} ${page.next.value}`);
    if (page.events.length === 0) {
      const { indexedFromSeq: from, indexedToSeq: to } = page.coverage;
      ctx.stderr(
        from === null || to === null
          ? "no match; the cloud index holds no events yet"
          : `no match; the cloud index holds sequences ${from} to ${to}, so an earlier event may exist unindexed`,
      );
    }
    return 0;
  }

  const out = deps.out ?? ctx.stdoutStream ?? lineSink(ctx);
  const controller = new AbortController();
  const abort = () => controller.abort(deps.signal?.reason);
  if (deps.signal?.aborted) abort();
  else deps.signal?.addEventListener("abort", abort, { once: true });
  const stopOnSignal = () => controller.abort(new Error("interrupted"));
  process.once("SIGINT", stopOnSignal);
  process.once("SIGTERM", stopOnSignal);
  try {
    const after = startingCursor(args);
    if (sub === "wait-for") {
      const seconds = flagInt(args, "timeout", 300);
      const result = await waitForCloudEvent(
        ctx,
        { after, filter, timeoutMs: seconds * 1_000, out, signal: controller.signal },
        deps.cloud,
      );
      if (result.outcome === "matched" || result.outcome === "closed") return 0;
      if (result.outcome === "timeout") ctx.stderr(`events: no matching event within ${seconds} s`);
      return 1;
    }
    const result = await tailCloudEvents(ctx, { after, filter, out, signal: controller.signal }, deps.cloud);
    if (result.outcome !== "closed" && result.cursor !== undefined)
      ctx.stderr(`events: stopped at sequence ${result.cursor}; resume with --after ${result.cursor}`);
    return 0;
  } finally {
    process.off("SIGINT", stopOnSignal);
    process.off("SIGTERM", stopOnSignal);
    deps.signal?.removeEventListener("abort", abort);
  }
}
