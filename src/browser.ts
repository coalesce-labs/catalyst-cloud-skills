// browser.ts — open the device-flow verification page in the person's default browser. Best-effort:
// a machine with no browser (a headless mini, a container) simply shows the code and URL instead, so
// this never throws into the login flow — the caller wraps it, and a spawn failure is swallowed here.
import { spawn } from "node:child_process";

/** The platform's "open this URL" command. `open` on macOS, `start` via cmd on Windows, else xdg-open. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? (["open", [url]] as const)
      : process.platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : (["xdg-open", [url]] as const);
  try {
    const child = spawn(cmd, [...args], { stdio: "ignore", detached: true });
    child.on("error", () => {}); // no opener installed — the printed URL is the fallback
    child.unref();
  } catch {
    // spawn itself threw (unusual) — the code and URL on screen are the fallback
  }
}
