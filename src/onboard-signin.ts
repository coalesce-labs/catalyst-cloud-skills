import type { Ctx } from "./config.js";
import { CliError, UsageError } from "./errors.js";
import type { OnboardStepResult } from "./onboard.js";

const TIMED_OUT = Symbol("signin_timeout");
const cancelled = () => new CliError("Sign-in paused. Run the same command to resume.", "login-cancelled", 11);

/** One onboarding budget includes every device-code round and final member verification. */
export async function boundedOnboardSignin(
  ctx: Ctx,
  login: (ctx: Ctx, signal?: AbortSignal) => Promise<number>,
  external?: AbortSignal,
  timeoutMs = 600_000,
): Promise<OnboardStepResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000)
    throw new UsageError("onboarding sign-in timeout must be 1 to 600000 milliseconds");
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = external ? AbortSignal.any([external, deadline.signal]) : deadline.signal;
  let removeAbort = () => {};
  try {
    const exit = await new Promise<number | typeof TIMED_OUT>((resolve, reject) => {
      const stopped = () => external?.aborted ? reject(cancelled()) : resolve(TIMED_OUT);
      if (signal.aborted) { stopped(); return; }
      signal.addEventListener("abort", stopped, { once: true });
      removeAbort = () => signal.removeEventListener("abort", stopped);
      const stepCtx = { ...ctx, fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (signal.aborted) throw cancelled();
        const response = await ctx.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
        if (signal.aborted) throw cancelled();
        return response;
      }) as typeof fetch };
      // Attach both handlers even when a custom callback ignores abort and settles after the budget.
      Promise.resolve().then(() => {
        if (signal.aborted) throw cancelled();
        return login(stepCtx, signal);
      }).then(
        code => signal.aborted ? stopped() : resolve(code),
        error => signal.aborted ? stopped() : reject(error),
      );
    });
    return exit === TIMED_OUT ? { state: "waiting", reason: "signin_timeout" }
      : exit === 0 ? { state: "done" } : { state: "failed", reason: "signin_failed" };
  } finally { clearTimeout(timer); removeAbort(); }
}
