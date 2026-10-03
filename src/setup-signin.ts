// setup-signin.ts — CTC-4625: step 4 of `catalyst setup`, the browser sign-in, drawn in this process.
//
// ⛔ THE CODE IS WRITTEN THE MOMENT THE SERVER SENDS IT. The device flow hands each code to
// `present`, which writes straight to the output stream before the wait for approval begins; no
// filter, wrap buffer or relay process sits between them (the 0.13.9 installer piped the login
// through fold, which held the code until the deadline discarded it).
import { realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { loadConfig, saveConfig, type Ctx } from "./config.js";
import { CliError } from "./errors.js";
import type { DeviceCodePresentation } from "./oauth.js";
import type { SetupRenderer } from "./setup-render.js";

export type SigninOutcome = "done" | "timeout" | "cancelled" | "failed";

export interface SetupLoginDeps {
  signal: AbortSignal;
  present: (code: DeviceCodePresentation) => void;
  presentBrowser: (opened: boolean) => void;
  waitForApproval: <T>(run: () => Promise<T>) => Promise<T>;
}

export interface SetupSigninDeps {
  /** `catalyst login` with these seams; resolves to its exit code. */
  login: (ctx: Ctx, deps: SetupLoginDeps) => Promise<number>;
  /** Ctrl-C: stops the wait as cancelled rather than timed out. */
  interrupted?: AbortSignal;
  /** A spinner on a capable terminal; null or absent means plain lines. */
  spinner?: () => {
    start(msg: string): void;
    message(msg: string): void;
    stop(): void;
  } | null;
  /** Where the login's own lines go (the log); they would repeat what the step already says. */
  log?: (line: string) => void;
  now?: () => number;
}

const PLAIN_REMINDER_MS = 60_000;

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

function limitWords(seconds: number): string {
  if (seconds <= 0) return "";
  if (seconds < 60) return ` (up to ${seconds} seconds)`;
  const minutes = Math.ceil(seconds / 60);
  return ` (up to ${minutes} minute${minutes === 1 ? "" : "s"})`;
}

/** The host a link opens, named when it is not Catalyst Cloud's own, so the page is not a surprise. */
function vendorNote(code: DeviceCodePresentation): string | null {
  let host: string;
  try {
    host = new URL(code.completeUri ?? code.verificationUri).host;
  } catch {
    return null;
  }
  if (host === "catalystcloud.dev" || host.endsWith(".catalystcloud.dev"))
    return null;
  return `That page is Catalyst's sign-in page, hosted by WorkOS.`;
}

export async function runSetupSignin(
  ctx: Ctx,
  r: SetupRenderer,
  seconds: number,
  deps: SetupSigninDeps,
): Promise<SigninOutcome> {
  const now = deps.now ?? Date.now;
  const reason =
    "This connects this computer to your Catalyst account, so catalyst and your coding agent can act for you.";
  r.detail(reason);
  const deadline = new AbortController();
  const timer =
    seconds > 0
      ? setTimeout(() => deadline.abort(), seconds * 1000)
      : undefined;
  const signal = deps.interrupted
    ? AbortSignal.any([deadline.signal, deps.interrupted])
    : deadline.signal;
  const started = now();
  const progress = () =>
    seconds > 0
      ? `${clock(started + seconds * 1000 - now())} left`
      : `${clock(now() - started)} so far`;
  let hintInFrame = false;
  let round = 1,
    rounds = 1;
  const waitingWords = () =>
    `${round > 1 ? `new code ${round} of ${rounds}` : "waiting for you"} · ${progress()}`;

  const present = (code: DeviceCodePresentation) => {
    round = code.round;
    rounds = code.rounds;
    if (code.round > 1) {
      r.begin(
        4,
        "Sign in to Catalyst",
        `new code ${code.round} of ${code.rounds} · ${progress()}`,
      );
      r.detail(reason);
      hintInFrame = false;
    }
    r.action("Open this link and approve this computer:");
    if (code.completeUri) r.detail(r.link(code.completeUri));
    r.detail(
      `Or open ${r.link(code.verificationUri)} and enter ${code.userCode}.`,
    );
    const note = vendorNote(code);
    if (note) r.detail(note);
    if (code.round > 1) {
      r.detail("Ctrl-C stops setup.");
      hintInFrame = true;
    }
  };

  const presentBrowser = (opened: boolean) => {
    if (opened) r.detail("Your browser opened that page.");
  };

  const waitForApproval = async <T>(run: () => Promise<T>): Promise<T> => {
    let tick: ReturnType<typeof setInterval>;
    if (r.traits.unicode) {
      r.update(waitingWords());
      if (!hintInFrame) r.detail("Ctrl-C stops setup.");
      hintInFrame = true;
      tick = setInterval(() => r.update(waitingWords()), 1000);
    } else {
      r.detail(
        `waiting for you${limitWords(seconds > 0 ? Math.max(0, Math.ceil((started + seconds * 1000 - now()) / 1000)) : seconds)}.${hintInFrame ? "" : " Ctrl-C stops setup."}`,
      );
      hintInFrame = true;
      tick = setInterval(() => {
        const minutes = Math.max(
          0,
          Math.ceil((started + seconds * 1000 - now()) / 60000),
        );
        if (minutes > 0)
          r.detail(
            `Still waiting, ${minutes} minute${minutes === 1 ? "" : "s"} left.`,
          );
      }, PLAIN_REMINDER_MS);
    }
    try {
      return await run();
    } finally {
      clearInterval(tick);
    }
  };

  // The login's own lines repeat what this step already shows, so they are kept, not printed; the
  // last one is the reason when the login ends without signing in.
  const logged: string[] = [];
  const log = (line: string) => {
    if (line.trim()) logged.push(line.trim());
    deps.log?.(line);
  };
  const quiet: Ctx = { ...ctx, stdout: log, stderr: log };
  try {
    const code = await deps.login(quiet, {
      signal,
      present,
      presentBrowser,
      waitForApproval,
    });
    if (code === 0) return "done";
    r.detail(
      `The sign-in did not finish: ${logged.at(-1) ?? `catalyst login exited ${code}`}`,
    );
    return "failed";
  } catch (error) {
    if (deps.interrupted?.aborted) return "cancelled";
    if (deadline.signal.aborted) return "timeout";
    if (error instanceof CliError && error.code === "login-expired")
      return "timeout";
    deps.log?.(error instanceof Error ? error.message : String(error));
    r.detail(
      `The sign-in did not finish: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * install.sh may run `catalyst setup` from a temporary install (CATALYST_INSTALL_TEMP_CLI) that is
 * removed when setup ends. The sign-in records the running command's path for skill scripts to
 * spawn, so once it is saved, point it at the installed `catalyst` on PATH (step 1 installed it).
 * An installed command running setup keeps its own path.
 */
export function keepInstalledCliPath(ctx: Ctx, running: string): void {
  const given = ctx.env.CATALYST_INSTALL_TEMP_CLI;
  if (!given) return;
  let temporary: string;
  try {
    temporary = realpathSync(given);
    running = realpathSync(running);
  } catch {
    return;
  }
  if (relative(temporary, running).startsWith("..")) return;
  const cfg = loadConfig(ctx.home);
  if (!cfg?.cliPath) return;
  try {
    if (realpathSync(cfg.cliPath) !== running) return;
  } catch {
    return;
  }
  for (const dir of (ctx.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    let installed: string;
    try {
      installed = realpathSync(join(dir, "catalyst"));
    } catch {
      continue;
    }
    if (!relative(temporary, installed).startsWith("..")) continue;
    cfg.cliPath = installed;
    saveConfig(ctx.home, cfg);
    return;
  }
}
