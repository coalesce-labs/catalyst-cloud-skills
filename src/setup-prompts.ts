// setup-prompts.ts — CTC-4625: the questions and the spinner `catalyst setup` shows on a terminal,
// drawn by @clack/prompts. Questions read the terminal itself (/dev/tty): under `curl | sh` the
// standard input is the download, never the person.
import { closeSync, openSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { ReadStream, WriteStream } from "node:tty";
import type { SetupAsk, SetupSpinner } from "./setup.js";
import type { SetupRenderer } from "./setup-render.js";

type Clack = typeof import("@clack/prompts");

export interface SetupTerminal {
  input: ReadStream;
  output: WriteStream;
  close(): void;
}

/** What a prompt assumes when the terminal reports no width (a pty opened without a size). clack
 *  wraps each frame at the width it reads, and at 0 it printed one character per line. */
const FALLBACK_COLUMNS = 80;
/** Likewise for height: with 0 rows a select shows one option and "...". */
const FALLBACK_ROWS = 24;

/** The controlling terminal, or null when there is none (CI, a container with no TTY, a pipe). */
export function openSetupTerminal(
  stdout: NodeJS.WriteStream,
): SetupTerminal | null {
  // @clack/core sizes each prompt frame from process.stdout.columns, whatever output it was given.
  if (stdout.isTTY && !stdout.columns) stdout.columns = FALLBACK_COLUMNS;
  if (stdout.isTTY && !stdout.rows) stdout.rows = FALLBACK_ROWS;
  let readFd: number | undefined;
  let writeFd: number | undefined;
  try {
    readFd = openSync("/dev/tty", "r");
    writeFd = openSync("/dev/tty", "w");
    const input = new ReadStream(readFd);
    const output = new WriteStream(writeFd);
    if (!output.columns) output.columns = FALLBACK_COLUMNS;
    if (!output.rows) output.rows = FALLBACK_ROWS;
    return {
      input,
      output,
      close() {
        input.destroy();
        output.destroy();
      },
    };
  } catch {
    if (readFd !== undefined) closeSync(readFd);
    if (writeFd !== undefined) closeSync(writeFd);
    return null;
  }
}

export const CONTINUE_CHOICES = [
  { value: "y", label: "Yes, start" },
  { value: "e", label: "Change options (folders, daily update, local sync)" },
  { value: "n", label: "Not now" },
];

/** Each question as a clack prompt on the terminal. A cancelled prompt (Ctrl-C, or the engine
 *  gone) answers null; the caller decides what that means. */
export function clackSetupAsk(clack: Clack, terminal: SetupTerminal) {
  return async (
    event: SetupAsk,
    r: SetupRenderer,
    gone: AbortSignal,
  ): Promise<string | null> => {
    const io = { input: terminal.input, output: terminal.output, signal: gone };
    r.blank();
    const question = event.question.replace(/\s*\[[^\]]*\]:?\s*$/, "");
    if (event.id === "continue") {
      const choice = await clack.select({
        ...io,
        message: "Start setup?",
        options: CONTINUE_CHOICES,
        initialValue: event.fallback || "y",
      });
      return clack.isCancel(choice) ? null : String(choice);
    }
    if (/^[yn]$/i.test(event.fallback)) {
      const yes = await clack.confirm({
        ...io,
        message: question,
        initialValue: /^y$/i.test(event.fallback),
      });
      return clack.isCancel(yes) ? null : yes ? "y" : "n";
    }
    const text = await clack.text({
      ...io,
      message: question,
      placeholder: event.fallback,
      defaultValue: event.fallback,
    });
    return clack.isCancel(text) ? null : String(text);
  };
}

/**
 * clack's spinner reads process.stdin for Ctrl-C and, on a terminal, puts it in raw mode, which
 * would take Ctrl-C away from the engine. install.sh starts this command with stdin from
 * /dev/null, so the spinner is used only then; a person running `catalyst setup` from a shell
 * gets the plain waiting lines instead.
 */
export function clackSetupSpinner(clack: Clack, stdinIsTty: boolean) {
  return (
    r: SetupRenderer,
    stream: "stdout" | "stderr",
  ): SetupSpinner | null => {
    if (!r.traits.color || stdinIsTty) return null;
    const spin = clack.spinner({ output: process[stream], withGuide: false });
    return {
      start: (msg: string) => spin.start(msg),
      message: (msg: string) => spin.message(msg),
      stop: () => spin.clear(),
    };
  };
}

/** Prompt input/output always share the controlling terminal, even when progress is redirected. */
export function setupOnboardStreams(
  terminal: { input: Readable; output: Writable } | null,
) {
  return {
    input: terminal?.input ?? process.stdin,
    output: terminal?.output ?? process.stdout,
  };
}
