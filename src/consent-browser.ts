import { spawn, type ChildProcess } from "node:child_process";

export interface ConsentBrowserOptions {
  platform?: string;
  timeoutMs?: number;
  killGraceMs?: number;
  launch?: (command: string, args: readonly string[]) => ChildProcess;
}

/** Consent links are credentials. Keep them out of errors and join the opener before continuing. */
export function createConsentBrowserOpener(options: ConsentBrowserOptions = {}) {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const killGraceMs = options.killGraceMs ?? 500;
  const launch = options.launch ?? ((command: string, args: readonly string[]) =>
    spawn(command, [...args], { stdio: "ignore", detached: false }));

  return async (url: string, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw new DOMException("Browser opening interrupted", "AbortError");
    const [command, args] = platform === "darwin"
      ? ["open", [url]] as const
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]] as const
        : ["xdg-open", [url]] as const;
    let child: ChildProcess;
    try {
      child = launch(command, args);
    } catch {
      throw new Error("Browser could not open");
    }
    await new Promise<void>((resolve, reject) => {
      let interrupted = false;
      let expired = false;
      let failed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => { child.kill("SIGKILL"); }, killGraceMs);
      };
      const abort = () => { interrupted = true; stop(); };
      const timer = setTimeout(() => { expired = true; stop(); }, timeoutMs);
      child.once("error", () => { failed = true; });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        if (interrupted) reject(new DOMException("Browser opening interrupted", "AbortError"));
        else if (failed || expired || code !== 0) reject(new Error("Browser could not open"));
        else resolve();
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  };
}

export const openConsentBrowser = createConsentBrowserOpener();

/** The web page that finishes a consent step when no browser opens here. The signed link stays private. */
export function finishOnTheWeb(baseUrl: string, page: "connections" | "connected-accounts", action: string): string {
  const origin = baseUrl.replace(/\/+$/, "");
  return `No browser opened on this computer. In a browser signed in to Catalyst, open ${origin}/settings/${page} and ${action}. Setup keeps waiting here.`;
}
