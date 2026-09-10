// prompt.ts — the one interactive read in the CLI: asking for the account key on a terminal without
// echoing it. Excluded from coverage (it needs a real TTY); everything that calls it takes it as an
// injectable dependency so the tests never touch this file.
import { createInterface } from "node:readline";

/** True when there is a terminal to prompt on. */
export function stdinIsTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Read one line from the terminal without echoing it. The muted output stream swallows everything
 * readline would write after the question itself, so the key never reaches the screen or a scrollback
 * buffer; the caller still gets it back.
 */
export async function promptSecret(question: string): Promise<string> {
  let muted = false;
  const output = Object.create(process.stdout) as NodeJS.WritableStream & { write: (chunk: string) => boolean };
  output.write = (chunk: string): boolean => {
    if (!muted) process.stdout.write(chunk);
    return true;
  };
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, (value) => resolve(value));
      muted = true;
    });
    process.stdout.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}
