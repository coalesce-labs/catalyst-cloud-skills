// Read-only event cache freshness. The event cursor is separate from the replica snapshot cursor.
import { readFileSync } from "node:fs";
import type { Ctx } from "./config.js";
import { requireConfig } from "./config.js";
import { apiClient } from "./transport.js";

export interface EventCacheStatus {
  verdict: "current" | "stale" | "absent" | "unknown";
  directory: string;
  cursor: number | null;
  head: number | null;
  heartbeatAgeMs: number | null;
  writerAlive: boolean;
  reasons: string[];
}

function jsonFile(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function livePid(value: unknown): boolean {
  if (!Number.isInteger(value) || Number(value) <= 0) return false;
  try { process.kill(Number(value), 0); return true; }
  catch (error) { return (error as { code?: string }).code === "EPERM"; }
}

/** Compare the persisted event cursor with the cloud head without consuming events. */
export async function eventCacheStatus(ctx: Ctx, directory: string, probe: boolean): Promise<EventCacheStatus> {
  const checkpoint = jsonFile(`${directory}/cursor.json`);
  const lock = jsonFile(`${directory}/.sync.writer.lock`);
  const cursor = checkpoint?.version === 1 && Number.isSafeInteger(checkpoint.cursor) && Number(checkpoint.cursor) >= 0 ? Number(checkpoint.cursor) : null;
  const heartbeatAgeMs = typeof lock?.heartbeat === "number" ? Math.max(0, ctx.now().getTime() - lock.heartbeat) : null;
  const writerAlive = livePid(lock?.pid);
  const reasons: string[] = [];
  if (cursor === null) reasons.push("event cache cursor is absent");
  if (heartbeatAgeMs === null || heartbeatAgeMs >= 15_000) reasons.push("event writer heartbeat is absent or stale");
  if (!writerAlive) reasons.push("event writer is not running");
  let head: number | null = null;
  if (probe && cursor !== null) {
    try {
      const cfg = requireConfig(ctx);
      const response = await apiClient(cfg, ctx).getNdjson("/api/v1/events/backbone", { query: { since: cursor }, accept: [409] });
      const rawHead = response.headers.get("x-catalyst-event-backbone-head-seq");
      const value = rawHead === null || rawHead.trim() === "" ? NaN : Number(rawHead);
      if (!Number.isSafeInteger(value) || value < 0) reasons.push("cloud event head could not be verified");
      else {
        head = value;
        if (response.status !== 200) reasons.push(`cloud refused the event cursor (HTTP ${response.status})`);
      }
    } catch (error) {
      reasons.push(`cloud event head is unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (probe && head !== null && cursor !== head) reasons.push(`event cache cursor ${cursor} differs from cloud head ${head}`);
  if (!probe) reasons.push("cloud event head was not probed");
  const unknown = reasons.some((reason) => reason.includes("unknown") || reason.includes("could not be verified") || reason.includes("was not probed"));
  const provenStale = reasons.some((reason) => reason.includes("heartbeat") || reason.includes("not running") || reason.includes("differs from cloud head") || reason.includes("refused the event cursor"));
  const verdict = cursor === null ? "absent" : provenStale ? "stale" : unknown ? "unknown" : reasons.length === 0 ? "current" : "stale";
  return { verdict, directory, cursor, head, heartbeatAgeMs, writerAlive, reasons };
}
