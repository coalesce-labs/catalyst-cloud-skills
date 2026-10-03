import { expect, test } from "vitest";
import { promptCursor } from "../src/setup-prompt-frame.js";
test("Clack redraws leave the submitted form height, not the largest option list", () => {
  const c = promptCursor(80);
  c.feed("│\n◆  Choose\n│  option1\n│  option2\n└\n");
  c.feed("\x1b[5A\x1b[999D\x1b[J");
  c.feed("│\n◇  Choose\n│  option1");
  c.feed("\n\x1b[?25h");
  expect(c.rows()).toBe(3);
});
test("wrapped option labels add physical rows", () => {
  const c = promptCursor(40);
  c.feed("│\n◇  Choose\n│  " + "x".repeat(60) + "\n");
  expect(c.rows()).toBe(4);
});
test("unrecognized absolute positioning makes erasure inconclusive", () => {
  const c = promptCursor(80);
  c.feed("\x1b[3;2Htext\n");
  expect(c.rows()).toBeNull();
});

test("two OSC hyperlinks preserve the newline between them", () => {
  const c = promptCursor(80);
  c.feed(
    "\x1b]8;;https://one.test\x1b\\one\x1b]8;;\x1b\\\n\x1b]8;;https://two.test\x1b\\two\x1b]8;;\x1b\\\n",
  );
  expect(c.rows()).toBe(2);
});
