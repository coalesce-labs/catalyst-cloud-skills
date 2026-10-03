// terminal-background.test.ts — CTC-4680: light or dark, in order: CATALYST_THEME, COLORFGBG, the
// terminal's own answer to OSC 11, then dark. The query must restore the input's mode on every
// path, consume the replies, hand back keys typed meanwhile, and end quickly when nobody answers.
import { EventEmitter } from "node:events";
import { emitKeypressEvents } from "node:readline";
import { describe, expect, test } from "vitest";
import {
  detectTheme,
  envTheme,
  LATE_MS,
  parseOsc11,
  queryBackground,
  themeOf,
} from "../src/terminal-background.js";

const LIGHT_REPLY = "\u001b]11;rgb:fdfd/f6f6/e3e3\u0007";
const DARK_REPLY = "\u001b]11;rgb:1111/1010/0e0e\u001b\\";
const DA1 = "\u001b[?62;22c";

/** A fake TTY input and the terminal behind it: `answer` runs when the query is written. */
class FakeTerminal extends EventEmitter {
  isTTY = true;
  isRaw = false;
  readableFlowing: boolean | null = null;
  modes: boolean[] = [];
  handedBack: string[] = [];
  queries: string[] = [];
  constructor(private readonly answer: (t: FakeTerminal) => void = () => {}) {
    super();
  }
  setRawMode(mode: boolean) {
    this.isRaw = mode;
    this.modes.push(mode);
    return this;
  }
  pause() {
    this.readableFlowing = false;
    return this;
  }
  /** Records what is handed back and, like a real stream, gives it to the next read. */
  unshift(chunk: Buffer) {
    this.handedBack.push(chunk.toString("latin1"));
    setImmediate(() => this.emit("data", chunk));
  }
  send(text: string) {
    this.emit("data", Buffer.from(text, "latin1"));
  }
  readonly output = {
    write: (chunk: string) => {
      this.queries.push(chunk);
      this.answer(this);
      return true;
    },
  };
}

describe("parsing an OSC 11 reply", () => {
  test.each([
    ["rgb:ffff/ffff/ffff\u0007", [1, 1, 1]],
    ["rgb:0000/0000/0000\u001b\\", [0, 0, 0]],
    ["rgb:ff/80/00\u0007", [1, 128 / 255, 0]],
    ["rgba:f/f/f/f\u0007", [1, 1, 1]],
  ] as const)("%s", (body, rgb) => {
    expect(parseOsc11(`\u001b]11;${body}`)).toEqual(rgb);
  });

  test("anything else is not a colour", () => {
    expect(parseOsc11("\u001b]11;?\u0007")).toBeNull();
    expect(parseOsc11("\u001b]10;rgb:ffff/ffff/ffff\u0007")).toBeNull();
    expect(parseOsc11("rgb:ffff/ffff/ffff")).toBeNull();
  });

  test("light above 0.5 luma", () => {
    expect(themeOf([1, 1, 1])).toBe("light");
    expect(themeOf(parseOsc11(LIGHT_REPLY)!)).toBe("light"); // Solarized light
    expect(themeOf(parseOsc11(DARK_REPLY)!)).toBe("dark");
    expect(themeOf([0.5, 0.5, 0.5])).toBe("dark");
    expect(themeOf([0.51, 0.51, 0.51])).toBe("light");
  });
});

describe("the order: CATALYST_THEME, COLORFGBG, the terminal, dark", () => {
  test("CATALYST_THEME wins over everything", async () => {
    const t = new FakeTerminal((f) => f.send(DARK_REPLY + DA1));
    expect(await detectTheme({ CATALYST_THEME: "light", COLORFGBG: "15;0" }, { input: t, output: t.output })).toBe("light");
    expect(t.queries).toEqual([]);
    expect(envTheme({ CATALYST_THEME: "Dark" })).toBe("dark");
  });

  test("then COLORFGBG: 7 and 15 are light backgrounds, any other number dark", async () => {
    const t = new FakeTerminal((f) => f.send(LIGHT_REPLY + DA1));
    expect(await detectTheme({ COLORFGBG: "0;15" }, { input: t, output: t.output })).toBe("light");
    expect(await detectTheme({ COLORFGBG: "0;7" })).toBe("light");
    expect(await detectTheme({ COLORFGBG: "15;0" }, { input: t, output: t.output })).toBe("dark");
    expect(await detectTheme({ COLORFGBG: "15;default;0" })).toBe("dark");
    expect(t.queries).toEqual([]);
    expect(envTheme({ CATALYST_THEME: "sepia", COLORFGBG: "default" })).toBeNull();
  });

  test("then the terminal's answer", async () => {
    const t = new FakeTerminal((f) => f.send(LIGHT_REPLY + DA1));
    expect(await detectTheme({}, { input: t, output: t.output })).toBe("light");
    expect(t.queries).toEqual(["\u001b]11;?\u0007\u001b[c"]);
  });

  test("then dark, with nothing to ask", async () => {
    expect(await detectTheme({})).toBe("dark");
  });
});

describe("asking the terminal", () => {
  test("raw mode only while asking, then the mode it had", async () => {
    const t = new FakeTerminal((f) => f.send(LIGHT_REPLY + DA1));
    expect(await queryBackground(t, t.output)).toBe("light");
    expect(t.modes).toEqual([true, false]);
    expect(t.listenerCount("data")).toBe(0);
    const raw = new FakeTerminal((f) => f.send(DARK_REPLY + DA1));
    raw.isRaw = true;
    expect(await queryBackground(raw, raw.output)).toBe("dark");
    expect(raw.modes).toEqual([true, true]);
  });

  test("a reply split across reads still counts", async () => {
    const t = new FakeTerminal((f) =>
      setImmediate(() => {
        f.send("\u001b]1");
        f.send("1;rgb:ffff/ff");
        f.send("ff/ffff\u001b");
        f.send("\\\u001b[?6");
        f.send("2c");
      }),
    );
    expect(await queryBackground(t, t.output)).toBe("light");
    expect(t.handedBack).toEqual([]);
  });

  test("a terminal that answers DA1 but not OSC 11 ends at once, as dark", async () => {
    const t = new FakeTerminal((f) => f.send(DA1));
    const started = Date.now();
    expect(await detectTheme({}, { input: t, output: t.output }, 1000)).toBe("dark");
    expect(Date.now() - started).toBeLessThan(100);
    expect(t.modes).toEqual([true, false]);
  });

  test("keys typed while asking are handed back to the input, not eaten", async () => {
    const t = new FakeTerminal((f) =>
      setImmediate(() => {
        f.send("y");
        f.send(LIGHT_REPLY);
        f.send("\u001b[A"); // an arrow key, not a reply
        f.send("n" + DA1 + "q");
      }),
    );
    expect(await queryBackground(t, t.output)).toBe("light");
    expect(t.handedBack).toEqual(["y\u001b[Anq"]);
  });

  test("a terminal that never answers is dark at the timeout; the late wait ends when a prompt reads", async () => {
    const t = new FakeTerminal();
    const started = Date.now();
    expect(await detectTheme({}, { input: t, output: t.output }, 60)).toBe("dark");
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(55);
    expect(took).toBeLessThan(150);
    expect(t.modes).toEqual([true]); // still reading, for a late reply
    t.on("keypress", () => {}); // the first prompt starts reading
    expect(t.modes).toEqual([true, false]);
    expect(t.listenerCount("data")).toBe(0);
    expect(t.listenerCount("newListener")).toBe(0);
  });

  test("a late reply after the prompt has started reading is taken out of what the prompt gets", async () => {
    const t = new FakeTerminal();
    expect(await queryBackground(t, t.output, 20)).toBeNull();
    const got: string[] = [];
    t.on("data", (c: Buffer) => got.push(c.toString("latin1")));
    t.send("\u001b]11;rgb:ff");
    t.send("ff/ffff/ffff\u0007k");
    t.send(DA1);
    t.send("\u001b]11;rgb:0/0/0\u0007"); // after DA1 the wait is over: passed through as is
    expect(got).toEqual(["k", "\u001b]11;rgb:0/0/0\u0007"]);
    expect(t.emit).toBe(EventEmitter.prototype.emit);
  });

  test("with no reader, the late wait ends by itself after LATE_MS", async () => {
    const t = new FakeTerminal();
    await queryBackground(t, t.output, 20);
    await new Promise((r) => setTimeout(r, LATE_MS + 50));
    expect(t.modes).toEqual([true, false]);
    expect(t.listenerCount("data")).toBe(0);
  });

  test("a late reply is consumed, never handed to the prompt; a key typed meanwhile is", async () => {
    const t = new FakeTerminal((f) => {
      setTimeout(() => f.send("\u001b]11;rgb:ffff/"), 10);
      setTimeout(() => f.send("ffff/ffff\u0007k" + DA1), 80);
    });
    expect(await queryBackground(t, t.output, 40)).toBeNull(); // dark: the answer came too late
    await new Promise((r) => setTimeout(r, 100));
    expect(t.handedBack).toEqual(["k"]);
    expect(t.modes).toEqual([true, false]); // DA1 ended the late wait
  });

  test("keys typed with no answer are handed back when the wait ends", async () => {
    const t = new FakeTerminal((f) => setImmediate(() => f.send("abc")));
    expect(await queryBackground(t, t.output, 30)).toBeNull();
    t.on("data", () => {});
    expect(t.handedBack).toEqual(["abc"]);
  });

  test("a lone Esc typed during a query nobody answers is handed back when the wait ends", async () => {
    // Held while it could still start a late reply, then handed back.
    const alone = new FakeTerminal((f) => setImmediate(() => f.send("\u001b")));
    expect(await queryBackground(alone, alone.output, 30)).toBeNull();
    await new Promise((r) => setTimeout(r, LATE_MS + 50));
    expect(alone.handedBack).toEqual(["\u001b"]);
    // With a prompt already reading, it reaches the prompt.
    const read = new FakeTerminal((f) => setImmediate(() => f.send("\u001b")));
    expect(await queryBackground(read, read.output, 30)).toBeNull();
    const got: string[] = [];
    read.on("data", (c: Buffer) => got.push(c.toString("latin1")));
    await new Promise((r) => setTimeout(r, LATE_MS + 50));
    expect(got).toEqual(["\u001b"]);
  });

  test("a then Esc typed before the first prompt reads arrive as two keys, a then escape", async () => {
    const t = new FakeTerminal((f) =>
      setImmediate(() => {
        f.send("a");
        f.send("\u001b");
      }),
    );
    expect(await queryBackground(t, t.output, 30)).toBeNull();
    emitKeypressEvents(t as unknown as NodeJS.ReadableStream);
    const keys: string[] = [];
    // Readline names a lone Esc "escape" (and marks it meta); joined to "a" it would be meta+a.
    t.on("keypress", (_s: string | undefined, key: { name?: string; sequence: string }) =>
      keys.push(key.sequence === "\u001b" ? "escape" : key.sequence),
    );
    // Past the late wait and readline's own wait to tell a lone Esc from an escape sequence.
    await new Promise((r) => setTimeout(r, LATE_MS + 700));
    expect(keys).toEqual(["a", "escape"]);
  });

  test("Ctrl-C ends the query and is raised as an interrupt, not handed back", async () => {
    let interrupted = 0;
    const t = new FakeTerminal((f) => setImmediate(() => f.send("\u0003")));
    expect(await queryBackground(t, t.output, 1000, () => interrupted++)).toBeNull();
    expect(interrupted).toBe(1);
    expect(t.handedBack).toEqual([]);
    expect(t.modes).toEqual([true, false]);
  });

  test("an input that is not a terminal is never asked", async () => {
    const t = new FakeTerminal();
    t.isTTY = false;
    expect(await queryBackground(t, t.output)).toBeNull();
    expect(t.queries).toEqual([]);
    expect(t.modes).toEqual([]);
  });

  test("a write that throws still restores the mode", async () => {
    const t = new FakeTerminal();
    const output = {
      write: () => {
        throw new Error("EIO");
      },
    };
    expect(await queryBackground(t, output)).toBeNull();
    expect(t.modes).toEqual([true, false]);
    expect(t.listenerCount("data")).toBe(0);
  });

  test("an input nobody reads yet is left paused, so handed-back keys wait for the next reader", async () => {
    const t = new FakeTerminal((f) => f.send("k" + DA1));
    expect(await queryBackground(t, t.output)).toBeNull();
    expect(t.readableFlowing).toBe(false);
    expect(t.handedBack).toEqual(["k"]);
  });

  test("a flowing input is left flowing", async () => {
    const t = new FakeTerminal((f) => f.send(DA1));
    t.readableFlowing = true;
    let paused = false;
    t.pause = () => {
      paused = true;
      return t;
    };
    await queryBackground(t, t.output);
    expect(paused).toBe(false);
  });
});
