import type { Writable } from "node:stream";

export interface OnboardProgress {
  start(message: string): void;
  stop(): void;
  dispose(): void;
}

/** Progress never owns stdin, raw mode or process exit; cancellation belongs to onboarding. */
export function createOnboardProgress(output: Writable, signal: AbortSignal, onError?: () => void): OnboardProgress {
  let timer: ReturnType<typeof setInterval> | undefined;
  let active = false;
  let disposed = false;
  const clearTimer = () => { if (timer) { clearInterval(timer); timer = undefined; } };
  const failed = () => {
    if (disposed) return;
    clearTimer(); active = false; disposed = true;
    signal.removeEventListener("abort", stop);
    try { output.write("\x1b[?25h"); } catch { /* terminal is no longer writable */ }
    onError?.();
  };
  const write = (text: string) => {
    try { output.write(text); return true; } catch { failed(); return false; }
  };
  const stop = () => {
    clearTimer();
    if (active) { active = false; write("\r\x1b[2K\x1b[?25h"); }
  };
  signal.addEventListener("abort", stop);
  output.on("error", failed);
  return {
    start(message) {
      stop();
      if (disposed || signal.aborted) return;
      const frames = ["◒", "◐", "◓", "◑"];
      let frame = 0;
      const render = () => {
        const columns = (output as Writable & { columns?: number }).columns ?? 80;
        const text = Array.from(message.replace(/[\r\n\x1b]/g, " ")).slice(0, Math.max(0, columns - 5)).join("");
        return write(`\r\x1b[2K${frames[frame++ % frames.length]}  ${text}`);
      };
      active = true;
      if (!write("\x1b[?25l") || !render()) return;
      timer = setInterval(render, 80);
      timer.unref();
    },
    stop,
    dispose() { try { stop(); } finally { disposed = true; signal.removeEventListener("abort", stop); output.off("error", failed); } },
  };
}
