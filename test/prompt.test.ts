// prompt.test.ts — the hidden key prompt. The property that matters is that the answer comes back
// while the typed characters never reach the output stream, so this drives it with a pair of
// in-memory streams rather than a terminal.
import { describe, expect, test } from "vitest";
import { PassThrough } from "node:stream";

import { promptSecret, stdinIsTty } from "../src/prompt";

function io(): { input: PassThrough; output: PassThrough; written: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let seen = "";
  output.on("data", (d: Buffer) => (seen += d.toString()));
  return { input, output, written: () => seen };
}

describe("promptSecret", () => {
  test("returns the typed line, trimmed, and echoes none of it", async () => {
    const { input, output, written } = io();
    const answer = promptSecret("Account key (not echoed): ", { input, output });
    input.write("  ctc_acct_secret  \n");
    expect(await answer).toBe("ctc_acct_secret");
    const seen = written();
    expect(seen, "the question is printed").toContain("Account key (not echoed): ");
    expect(seen, "the key must never reach the output stream").not.toContain("ctc_acct_secret");
  });

  test("an empty line comes back empty, so the caller can refuse it as a usage error", async () => {
    const { input, output } = io();
    const answer = promptSecret("key: ", { input, output });
    input.write("\n");
    expect(await answer).toBe("");
  });
});

describe("stdinIsTty", () => {
  test("needs both ends: a pipe on either side means there is nowhere to prompt", () => {
    const saved = { in: process.stdin.isTTY, out: process.stdout.isTTY };
    try {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      expect(stdinIsTty()).toBe(true);
      Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
      expect(stdinIsTty()).toBe(false);
      Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
      expect(stdinIsTty()).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: saved.in, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: saved.out, configurable: true });
    }
  });
});
