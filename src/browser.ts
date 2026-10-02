// browser.ts — open the device-flow verification page in the person's default browser. Best-effort:
// a machine with no browser (a headless mini, a container) simply shows the code and URL instead, so
// this never throws into the login flow — the caller wraps it, and a spawn failure is swallowed here.
import { spawn, type ChildProcess } from "node:child_process";

/** The platform's "open this URL" command. `open` on macOS, `start` via cmd on Windows, else xdg-open. */
function opener(url: string, platform: string = process.platform) {
  return platform === "darwin"
    ? (["open", [url]] as const)
    : platform === "win32"
      ? (["cmd", ["/c", "start", "", url]] as const)
      : (["xdg-open", [url]] as const);
}

export function openBrowser(url: string): void {
  const [cmd, args] = opener(url);
  try {
    const child = spawn(cmd, [...args], { stdio: "ignore", detached: true });
    child.on("error", () => {}); // no opener installed — the printed URL is the fallback
    child.unref();
  } catch {
    // spawn itself threw (unusual) — the code and URL on screen are the fallback
  }
}

/** Login's opener: rejects when no opener ran (none installed, or it exited non-zero, as xdg-open does
 *  with no browser), so login claims an opened browser only when one did. An opener still running
 *  after `waitMs` launched something and counts as opened. */
export function openBrowserChecked(
  url: string,
  options: {
    platform?: string;
    waitMs?: number;
    launch?: (command: string, args: readonly string[]) => ChildProcess;
  } = {},
): Promise<void> {
  const [cmd, args] = opener(url, options.platform);
  const launch =
    options.launch ??
    ((command: string, list: readonly string[]) =>
      spawn(command, [...list], { stdio: "ignore", detached: true }));
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("browser-unavailable"));
    let child: ChildProcess;
    try {
      child = launch(cmd, args);
    } catch {
      return fail();
    }
    child.unref();
    const timer = setTimeout(resolve, options.waitMs ?? 3_000);
    child.once("error", () => {
      clearTimeout(timer);
      fail();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else fail();
    });
  });
}
