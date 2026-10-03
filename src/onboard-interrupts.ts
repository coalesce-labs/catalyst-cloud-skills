import type { OnboardStepId } from "./onboard.js";
const OPTIONAL_WAITS = new Set<OnboardStepId>([
  "linear.workspace",
  "linear.personal",
  "github.install",
  "github.personal",
  "accounts",
]);
/** A browser wait can stop without cancelling the rest of setup. Sign-in cannot. */
export function createOnboardInterrupts(
  stop: AbortController,
  now = () => Date.now(),
) {
  let step = new AbortController();
  let current: OnboardStepId | undefined;
  let waiting = false;
  let skippedAt: number | undefined;
  return {
    get signal() {
      return step.signal;
    },
    begin(id: OnboardStepId | undefined) {
      current = id;
      waiting = false;
      step = new AbortController();
      return step.signal;
    },
    waiting(value: boolean) {
      waiting = value;
    },
    interrupt(event: "SIGINT" | "SIGTERM" | "SIGHUP") {
      const withinStopWindow =
        skippedAt !== undefined && now() - skippedAt < 2000;
      if (
        event === "SIGINT" &&
        !withinStopWindow &&
        waiting &&
        current &&
        OPTIONAL_WAITS.has(current)
      ) {
        skippedAt = now();
        step.abort();
        return;
      }
      stop.abort();
    },
  };
}
