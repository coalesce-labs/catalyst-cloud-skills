import { performance } from "node:perf_hooks";
import { CliError, UsageError } from "./errors.js";

export interface ConsentStatus {
  outcome: "connected" | "absent" | "lapsed" | "unavailable" | "refused" | "failed";
  reason?: string;
}
export interface ConsentPollOptions {
  readStatus: (signal: AbortSignal) => Promise<ConsentStatus>;
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export interface ConsentPollResult {
  state: "done" | "waiting" | "failed" | "refused";
  reason?: string;
  elapsedMs: number;
}

/** Bound callbacks too: a transport that forgets to honor abort cannot hold setup forever. */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("consent_deadline"));
    if (signal.aborted) { reject(new Error("consent_deadline")); return; }
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function safeReason(reason: string | undefined, fallback: string): string {
  return reason && /^[a-z][a-z0-9_]{1,63}$/.test(reason) ? reason : fallback;
}

/** Poll live consent every two seconds for at most ten minutes, using actual elapsed time. */
export async function pollConsent(options: ConsentPollOptions): Promise<ConsentPollResult> {
  const timeoutMs = options.timeoutMs ?? 600_000;
  const intervalMs = options.intervalMs ?? 2_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000 ||
      !Number.isSafeInteger(intervalMs) || intervalMs <= 0)
    throw new UsageError("consent timeout must be 1 to 600000 milliseconds, with a positive poll interval");
  const now = options.now ?? (() => performance.now());
  const started = now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const elapsedMs = () => Math.max(0, Math.round(now() - started));
  const waiting = (): ConsentPollResult => ({ state: "waiting", reason: options.signal?.aborted ? "interrupted" : "consent_timeout", elapsedMs: elapsedMs() });
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  try {
    while (!signal.aborted && elapsedMs() < timeoutMs) {
      let status: ConsentStatus;
      try { status = await bounded(options.readStatus(signal), signal); }
      catch (error) {
        if (signal.aborted) return waiting();
        if (error instanceof CliError && (error.status === 401 || error.status === 403))
          return { state: "refused", reason: "consent_identity_refused", elapsedMs: elapsedMs() };
        return { state: "failed", reason: "consent_status_failed", elapsedMs: elapsedMs() };
      }
      if (elapsedMs() >= timeoutMs || signal.aborted) return waiting();
      if (status.outcome === "connected") return { state: "done", elapsedMs: elapsedMs() };
      if (status.outcome === "refused" || status.outcome === "failed")
        return { state: status.outcome, reason: safeReason(status.reason, `consent_${status.outcome}`), elapsedMs: elapsedMs() };
      const remaining = timeoutMs - elapsedMs();
      try { await bounded(sleep(Math.min(intervalMs, remaining)), signal); }
      catch { return waiting(); }
    }
    return waiting();
  } finally { clearTimeout(timer); }
}
