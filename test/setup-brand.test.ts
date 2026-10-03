// setup-brand.test.ts — CTC-4680: the Pixel Nucleus header at the top of `catalyst setup`. The
// mark comes from the brand grid at one size constant, is square with equal gaps both ways, takes
// the brand's dark or light colours at the terminal's colour level, and stands beside "Catalyst
// Cloud", the version and, once signed in, who and where. Anywhere the mark cannot be seen, or on
// any other verb, the same words print alone and plainly.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import stringWidth from "fast-string-width";
import { describe, expect, test } from "vitest";
import { drawsMark } from "../src/cli.js";
import type { OnboardIdentity, OnboardJournal } from "../src/onboard.js";
import { createClackOnboardUi } from "../src/onboard-ui.js";
import {
  colourLevel,
  CORE,
  inCi,
  MARK_SIZE,
  markColour,
  markLines,
  markSkipped,
  markSpan,
  markUnits,
  nearest16,
  nearest256,
  pixelNucleusLines,
  RING,
  type MarkSize,
  unitLines,
} from "../src/setup-brand.js";
import {
  createSetupRenderer,
  setupBanner,
  type BannerOptions,
  type SetupStream,
} from "../src/setup-render.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (text: string) => text.replace(ANSI, "");

function sink(tty: boolean, columns = 80): SetupStream & { text(): string } {
  const chunks: string[] = [];
  return {
    isTTY: tty,
    columns,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(""),
  };
}

const term = { TERM: "xterm-256color", LANG: "en_US.UTF-8" };
const truecolor = { ...term, COLORTERM: "truecolor" };
const who = { user: "ryan+onb-1@rozich.com", workspace: "Onboarding Test 1 [E2E]" };
const SIZES: [string, MarkSize, number, number][] = [
  ["C", { dot: 4, gap: 2 }, 22, 11],
  ["D", { dot: 3, gap: 1 }, 15, 8],
];

/** The expected mark, built from the brand rows rather than the code under test. */
function expected(size: MarkSize): string[] {
  const rows = [".XXX", "XCC.", "XCC.", ".XXX"];
  const span = 4 * size.dot + 3 * size.gap;
  const units: boolean[][] = [];
  rows.forEach((row, r) => {
    for (let y = 0; y < size.dot; y++)
      units.push(
        [...row].flatMap((ch, c) => [
          ...Array<boolean>(size.dot).fill(ch !== "."),
          ...Array<boolean>(c < 3 ? size.gap : 0).fill(false),
        ]),
      );
    if (r < 3) for (let g = 0; g < size.gap; g++) units.push(Array<boolean>(span).fill(false));
  });
  const lines: string[] = [];
  for (let y = 0; y < span; y += 2)
    lines.push(
      units[y]!
        .map((top, x) => {
          const bottom = units[y + 1]?.[x] ?? false;
          return top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
        })
        .join(""),
    );
  return lines;
}

describe("the mark's geometry", () => {
  test("the ring and core are the brand grid, with the back corners and the opening empty", () => {
    expect(RING).toEqual([
      [3, 0],
      [2, 0],
      [1, 0],
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(CORE).toEqual([
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
    ]);
  });

  test("the size is one constant, D by default: 15 columns by 8 lines", () => {
    expect(MARK_SIZE).toEqual({ dot: 3, gap: 1 });
    expect(markSpan()).toBe(15);
    expect(markLines()).toBe(8);
    expect(pixelNucleusLines("dark", "truecolor")).toEqual(
      pixelNucleusLines("dark", "truecolor", { dot: 3, gap: 1 }),
    );
  });

  describe.each(SIZES)("size %s", (_name, size, columns, lines) => {
    test(`is ${columns} columns by ${lines} lines: square, as a cell is about twice as tall as wide`, () => {
      expect(markSpan(size)).toBe(columns);
      expect(markLines(size)).toBe(lines);
      const units = markUnits(size);
      expect(units).toHaveLength(columns);
      for (const row of units) expect(row).toHaveLength(columns);
      const drawn = pixelNucleusLines("dark", "truecolor", size).map(plain);
      expect(drawn).toHaveLength(lines);
      for (const line of drawn) expect(line).toHaveLength(columns);
    });

    test("each grid cell is a dot-by-dot block at a pitch of dot + gap, ring or core", () => {
      const units = markUnits(size);
      const pitch = size.dot + size.gap;
      units.forEach((row, y) =>
        row.forEach((paint, x) => {
          const [col, r] = [Math.floor(x / pitch), Math.floor(y / pitch)];
          const want =
            x % pitch >= size.dot || y % pitch >= size.dot
              ? null
              : RING.some(([c, rr]) => c === col && rr === r)
                ? "ring"
                : CORE.some(([c, rr]) => c === col && rr === r)
                  ? "core"
                  : null;
          expect(paint, `${x},${y}`).toBe(want);
        }),
      );
    });

    test("the gap is the same number of units across and down", () => {
      const units = markUnits(size);
      const runs = (cells: boolean[]) =>
        cells.map((c) => (c ? "#" : ".")).join("").split(/#+/).filter(Boolean);
      // Down the left ring column and across the top row, every inner gap is `gap` units.
      const down = runs(units.map((row) => row[0] !== null));
      const across = runs(units[0]!.map((p) => p !== null));
      expect(down.slice(1, -1).every((g) => g.length === size.gap)).toBe(true);
      expect(across.slice(1).every((g) => g.length === size.gap)).toBe(true);
    });

    test("draws half blocks exactly as the brand rows say, square corners", () => {
      expect(pixelNucleusLines("dark", "truecolor", size).map(plain)).toEqual(expected(size));
    });
  });

  test("size D's odd height ends on a line of upper halves", () => {
    const last = pixelNucleusLines("dark", "truecolor", { dot: 3, gap: 1 }).map(plain).at(-1);
    expect(last).toBe("    ▀▀▀ ▀▀▀ ▀▀▀");
  });
});

describe("the mark's colours", () => {
  test("dark: a cream ring and a copper core in 24-bit colour, each run reset", () => {
    const lines = pixelNucleusLines("dark", "truecolor", { dot: 3, gap: 1 });
    expect(lines[0]).toBe(
      "    \u001b[38;2;241;235;226m███\u001b[0m \u001b[38;2;241;235;226m███\u001b[0m \u001b[38;2;241;235;226m███\u001b[0m",
    );
    expect(lines[2]).toBe(
      "\u001b[38;2;241;235;226m███\u001b[0m \u001b[38;2;210;142;99m███\u001b[0m \u001b[38;2;210;142;99m███\u001b[0m    ",
    );
    expect(lines.join("")).not.toMatch(/\u001b\[48/);
  });

  test("light: an ink ring and a rust core", () => {
    const text = pixelNucleusLines("light", "truecolor").join("");
    expect(text).toContain("38;2;17;16;14m");
    expect(text).toContain("38;2;169;81;47m");
    expect(text).not.toContain("241;235;226");
  });

  test("256 colours: the nearest of the cube or grey ramp", () => {
    expect(nearest256("#f1ebe2")).toBe(255);
    expect(nearest256("#d28e63")).toBe(173);
    expect(nearest256("#11100e")).toBe(233);
    expect(nearest256("#a9512f")).toBe(130);
    expect(nearest256("#ff0000")).toBe(196);
    expect(nearest256("#000000")).toBe(16);
    expect(markColour("ring", "dark", "256")).toBe("38;5;255");
    expect(markColour("core", "dark", "256")).toBe("38;5;173");
    expect(markColour("ring", "light", "256")).toBe("38;5;233");
    expect(markColour("core", "light", "256")).toBe("38;5;130");
  });

  test("16 colours: the nearest of xterm's, the core from the coloured ones and bold", () => {
    expect(nearest16("#f1ebe2")).toBe(37);
    expect(nearest16("#d28e63")).toBe(90); // plain distance: grey, which loses the accent
    expect(nearest16("#d28e63", true)).toBe(33);
    expect(nearest16("#11100e")).toBe(30);
    expect(nearest16("#a9512f", true)).toBe(31);
    expect(markColour("ring", "dark", "16")).toBe("37");
    expect(markColour("core", "dark", "16")).toBe("1;33");
    expect(markColour("ring", "light", "16")).toBe("30");
    expect(markColour("core", "light", "16")).toBe("1;31");
    expect(markColour("core", "dark", "16", "bg")).toBe("43");
  });

  test("two colours in one cell draw an upper half block on the lower colour's background", () => {
    const [line] = unitLines(
      [
        ["ring", null, "core"],
        ["core", "core", "core"],
      ],
      "dark",
      "truecolor",
    );
    expect(line).toBe(
      "\u001b[38;2;241;235;226;48;2;210;142;99m▀\u001b[0m\u001b[38;2;210;142;99m▄█\u001b[0m",
    );
  });
});

describe("the colour level", () => {
  const tty = { tty: true };
  test.each([
    ["--no-color", { ...truecolor, FORCE_COLOR: "3" }, { tty: true, noColor: true }, "none"],
    ["FORCE_COLOR=0", { ...truecolor, FORCE_COLOR: "0" }, tty, "none"],
    ["FORCE_COLOR=1", { ...truecolor, FORCE_COLOR: "1" }, tty, "16"],
    ["FORCE_COLOR=2", { FORCE_COLOR: "2" }, { tty: false }, "256"],
    ["FORCE_COLOR=3 over NO_COLOR", { NO_COLOR: "1", FORCE_COLOR: "3" }, tty, "truecolor"],
    ["NO_COLOR", { ...truecolor, NO_COLOR: "" }, tty, "none"],
    ["no terminal", truecolor, { tty: false }, "none"],
    ["TERM=dumb", { TERM: "dumb" }, tty, "none"],
    ["TERM unset", {}, tty, "none"],
    ["COLORTERM=truecolor", truecolor, tty, "truecolor"],
    ["COLORTERM=24bit", { TERM: "xterm", COLORTERM: "24bit" }, tty, "truecolor"],
    ["TERM=xterm-256color", term, tty, "256"],
    ["TERM=xterm", { TERM: "xterm" }, tty, "16"],
  ] as const)("%s", (_why, env, terminal, want) => {
    expect(colourLevel({ ...env }, terminal)).toBe(want);
  });
});

describe("when the mark is left off", () => {
  const base = { setup: true, tty: true, columns: 80, env: truecolor };
  test.each([
    ["any verb but setup", { ...base, setup: false }, "not catalyst setup"],
    ["no terminal", { ...base, tty: false }, "not a terminal"],
    ["CI", { ...base, env: { ...truecolor, CI: "true" } }, "CI"],
    ["--no-color", { ...base, noColor: true }, "--no-color"],
    ["NO_COLOR", { ...base, env: { ...truecolor, NO_COLOR: "1" } }, "NO_COLOR"],
    ["FORCE_COLOR=0", { ...base, env: { ...truecolor, FORCE_COLOR: "0" } }, "no colour"],
    ["TERM=dumb", { ...base, env: { TERM: "dumb", LANG: "en_US.UTF-8" } }, "no colour"],
    ["a non-UTF-8 locale", { ...base, env: { ...truecolor, LANG: "C" } }, "not UTF-8"],
    ["fewer than 60 columns", { ...base, columns: 59 }, "narrow"],
  ])("%s", (_why, options, reason) => {
    expect(markSkipped(options)).toBe(reason);
  });

  test("and drawn on setup in a 60-column colour terminal", () => {
    expect(markSkipped({ ...base, columns: 60 })).toBeNull();
    expect(markSkipped({ ...base, env: { ...truecolor, CI: "false" } })).toBeNull();
  });

  test("CI counts when set to anything but empty, 0 or false", () => {
    expect(inCi({ CI: "1" })).toBe(true);
    expect(inCi({ CI: "0" })).toBe(false);
    expect(inCi({})).toBe(false);
  });

  test("only `catalyst setup` draws it: onboard and every other verb do not", () => {
    expect(drawsMark(["setup"])).toBe(true);
    expect(drawsMark(["setup", "--yes"])).toBe(true);
    for (const verb of ["onboard", "login", "ready", "install", "status"])
      expect(drawsMark([verb]), verb).toBe(false);
    expect(drawsMark([])).toBe(false);
  });
});

/** Where the words start: the 2-column gutter, the mark, then 4 columns. */
const TEXT_AT = 2 + markSpan() + 4;

const mark = (columns = 80, tty = true) => {
  const out = sink(tty, columns);
  const banner: BannerOptions = { mark: true };
  return { out, banner };
};

describe("the header", () => {
  describe.each(SIZES)("size %s", (_name, size, _columns, lines) => {
    test("text lines are centred on the mark's lines, with and without the identity", () => {
      for (const words of [2, 4]) {
        const first = Math.floor((lines - words) / 2);
        const last = lines - first - words;
        expect(Math.abs(first - last)).toBeLessThanOrEqual(1);
      }
      expect(markLines(size)).toBe(lines);
    });
  });

  test("before sign-in: Catalyst Cloud and the version, beside the middle of the mark", () => {
    const { out, banner } = mark();
    const shown = createSetupRenderer(out, truecolor, banner).brand("setup", "0.15.4");
    expect(shown).toBe(false);
    const lines = plain(out.text()).split("\n");
    expect(lines).toHaveLength(markLines() + 1);
    const first = Math.floor((markLines() - 2) / 2);
    expect(lines.map((l) => l.slice(TEXT_AT))).toEqual(
      Array.from({ length: markLines() + 1 }, (_, i) =>
        i === first ? "Catalyst Cloud" : i === first + 1 ? "setup · 0.15.4" : "",
      ),
    );
    expect(lines[first]!.slice(0, TEXT_AT)).toBe(`  ${expected(MARK_SIZE)[first]}    `);
    expect(out.text()).toContain("\u001b[1mCatalyst Cloud\u001b[22m");
  });

  test("signed in: four lines, labels padded so the values line up", () => {
    const { out, banner } = mark();
    const shown = createSetupRenderer(out, truecolor, banner).brand("setup", "0.15.4", who);
    expect(shown).toBe(true);
    const lines = plain(out.text()).split("\n");
    const words = [
      "Catalyst Cloud",
      "setup · 0.15.4",
      "user:      ryan+onb-1@rozich.com",
      "workspace: Onboarding Test 1 [E2E]",
    ];
    const first = Math.floor((markLines() - 4) / 2);
    expect(lines.map((l) => l.slice(TEXT_AT)).slice(0, markLines())).toEqual(
      Array.from({ length: markLines() }, (_, i) => words[i - first] ?? ""),
    );
    expect(lines.map((l) => l.slice(0, TEXT_AT).trimEnd())).toEqual(
      [...expected(MARK_SIZE).map((l) => `  ${l}`.trimEnd()), ""],
    );
  });

  test("the light theme takes ink and rust", () => {
    const out = sink(true);
    createSetupRenderer(out, truecolor, { mark: true, theme: "light" }).brand("setup", "0.15.4");
    expect(out.text()).toContain("38;2;17;16;14m");
    expect(out.text()).toContain("38;2;169;81;47m");
  });

  test("without a detected theme, COLORFGBG and then CATALYST_THEME decide", () => {
    const out = sink(true);
    createSetupRenderer(out, { ...truecolor, COLORFGBG: "0;15" }, { mark: true }).brand("setup", "1");
    expect(out.text()).toContain("38;2;17;16;14m");
    const over = sink(true);
    createSetupRenderer(over, { ...truecolor, COLORFGBG: "0;15", CATALYST_THEME: "dark" }, { mark: true }).brand("setup", "1");
    expect(over.text()).toContain("38;2;241;235;226m");
  });

  test("16 colours: the core is bold", () => {
    const out = sink(true);
    createSetupRenderer(out, { TERM: "xterm", LANG: "en_US.UTF-8" }, { mark: true }).brand("setup", "1");
    expect(out.text()).toContain("\u001b[1;33m███\u001b[0m");
    expect(out.text()).toContain("\u001b[37m███\u001b[0m");
  });

  test("goes to the banner stream, not the renderer's", () => {
    const main = sink(true);
    const err = sink(true);
    createSetupRenderer(main, truecolor, { mark: true, stream: err }).brand("setup", "0.15.4", who);
    expect(main.text()).toBe("");
    expect(plain(err.text())).toContain("user:      ryan+onb-1@rozich.com");
  });

  test("a narrow terminal cuts the words short instead of wrapping them under the mark", () => {
    const { out, banner } = mark(60);
    const long = { ...who, workspace: "Onboarding Test 1 [E2E] for the platform team" };
    createSetupRenderer(out, truecolor, banner).brand("setup", "0.15.4", long);
    for (const line of plain(out.text()).split("\n")) expect(line.length).toBeLessThan(60);
    expect(plain(out.text())).toContain(`${"workspace: Onboarding Test 1 [E2E] for the platform team".slice(0, 60 - TEXT_AT - 2)}…`);
  });

  test.each([
    ["CJK", "東京本社プラットフォーム開発チーム第一部門東京本社"],
    ["emoji", `${"🚀".repeat(30)} launch`],
    ["family emoji", "👨‍👩‍👧‍👦".repeat(30)],
  ])("a %s workspace name is cut by what the terminal draws, whole characters only", (_why, workspace) => {
    const { out, banner } = mark(60);
    createSetupRenderer(out, truecolor, banner).brand("setup", "0.15.4", { ...who, workspace });
    const text = plain(out.text());
    for (const line of text.split("\n")) expect(stringWidth(line)).toBeLessThan(60);
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(text).toContain("workspace: ");
    expect(text).toMatch(/…$/m);
  });

  test("prints once per program start", () => {
    const { out, banner } = mark();
    const r = createSetupRenderer(out, term, banner);
    r.brand("setup", "0.15.4");
    expect(r.brand("setup", "0.15.4", who)).toBe(false);
    expect(plain(out.text()).match(/Catalyst Cloud/g)).toHaveLength(1);
  });

  test.each([
    ["any verb but setup", sink(true), truecolor, {}],
    ["NO_COLOR", sink(true), { ...term, NO_COLOR: "1" }, { mark: true }],
    ["--no-color", sink(true), truecolor, { mark: true, noColor: true }],
    ["no terminal", sink(false), truecolor, { mark: true }],
    ["CI", sink(true), { ...truecolor, CI: "1" }, { mark: true }],
    ["fewer than 60 columns", sink(true, 59), truecolor, { mark: true }],
  ] as const)("with %s: the words alone, plainly, no blocks", (_why, out, env, banner) => {
    const r = createSetupRenderer(out, env, banner);
    expect(r.brand("setup", "0.15.4", who)).toBe(true);
    expect(out.text()).toBe(
      "  Catalyst Cloud\n  setup · 0.15.4\n  user:      ryan+onb-1@rozich.com\n  workspace: Onboarding Test 1 [E2E]\n",
    );
  });

  test("without UTF-8 the words drop the middle dot; before sign-in only two lines", () => {
    const out = sink(true);
    expect(createSetupRenderer(out, { ...term, LANG: "C" }, { mark: true }).brand("setup", "0.15.4")).toBe(false);
    expect(out.text()).toBe("  Catalyst Cloud\n  setup 0.15.4\n");
  });
});

describe("setupBanner: the options the onboard flow draws with", () => {
  class FakeTty extends EventEmitter {
    isTTY = true;
    isRaw = false;
    writes: string[] = [];
    setRawMode(mode: boolean) {
      this.isRaw = mode;
      return this;
    }
    readableFlowing: boolean | null = null;
    pause() {
      return this;
    }
  }
  const stderr = (columns = 80): SetupStream & { writes: string[] } => {
    const writes: string[] = [];
    return { isTTY: true, columns, writes, write: (c: string) => (writes.push(c), true) };
  };

  test("setup on a capable terminal asks it for its background", async () => {
    const input = new FakeTty();
    const stream = stderr();
    stream.write = (c: string) => {
      stream.writes.push(c);
      if (c.includes("\u001b]11;?")) setImmediate(() => input.emit("data", Buffer.from("\u001b]11;rgb:ffff/ffff/ffff\u0007\u001b[?62c")));
      return true;
    };
    const banner = await setupBanner({ setup: true, env: truecolor, input, stdout: { isTTY: true }, stream });
    expect(banner).toMatchObject({ mark: true, theme: "light", stream });
    expect(input.isRaw).toBe(false);
  });

  test.each([
    ["onboard", { setup: false }],
    ["NO_COLOR", { env: { ...truecolor, NO_COLOR: "1" } }],
    ["CI", { env: { ...truecolor, CI: "1" } }],
    ["stdout piped", { stdout: { isTTY: false } }],
    ["a narrow terminal", { stream: stderr(50) }],
  ] as const)("never asks for %s, and defaults to dark", async (_why, change) => {
    const input = new FakeTty();
    const options = { setup: true, env: truecolor, input, stdout: { isTTY: true }, stream: stderr(), ...change };
    const banner = await setupBanner(options);
    expect(banner.theme).toBe("dark");
    expect((options.stream as { writes: string[] }).writes.join("")).not.toContain("]11;?");
    expect(input.listenerCount("data")).toBe(0);
  });

  test("never asks when CATALYST_THEME or COLORFGBG already says", async () => {
    const input = new FakeTty();
    const stream = stderr();
    const banner = await setupBanner({ setup: true, env: { ...truecolor, CATALYST_THEME: "light" }, input, stdout: { isTTY: true }, stream });
    expect(banner.theme).toBe("light");
    expect(stream.writes).toEqual([]);
  });
});

describe("the first screen says who and where once", () => {
  const identity = {
    account: "acme",
    membershipId: "m",
    role: "admin",
    display: { personLabel: "Ryan", email: "ryan@example.com", workspaceName: "Acme", workspaceSlug: "acme" },
  } as unknown as OnboardIdentity;

  function screen(env: NodeJS.ProcessEnv, banner: BannerOptions = { mark: true }) {
    const output = new PassThrough();
    Object.assign(output, { isTTY: env.TERM !== undefined, columns: 80 });
    let text = "";
    output.on("data", (chunk) => {
      text += chunk;
    });
    const quiet = () => {};
    const ui = createClackOnboardUi(
      {
        intro: quiet,
        outro: quiet,
        log: { message: quiet, info: quiet, warn: quiet, error: quiet },
        select: async () => "stop",
        isCancel: () => false,
      },
      { input: new PassThrough(), output },
      {
        renderer: createSetupRenderer(output as unknown as SetupStream, env, banner),
        interactive: false,
        signals: new EventEmitter(),
        version: "0.15.4",
      },
    );
    const journal = { steps: [] } as unknown as OnboardJournal;
    return { ui, journal, text: () => plain(text) };
  }

  test("signed in before setup starts: the header carries it and the lines below do not repeat it", () => {
    const f = screen(truecolor);
    f.ui.plan(f.journal, identity);
    const text = f.text();
    expect(text).toContain("user:      ryan@example.com");
    expect(text).toContain("workspace: Acme");
    expect(text).not.toContain("Signed in to Catalyst as");
    expect(text).not.toContain("Catalyst workspace:");
    f.ui.dispose();
  });

  test("signing in after the header: the identity lines follow, the header is not drawn again", () => {
    const f = screen(truecolor);
    f.ui.plan(f.journal, null);
    f.ui.plan(f.journal, identity);
    const text = f.text();
    expect(text).not.toContain("user:      ryan@example.com");
    expect(text).toContain("Signed in to Catalyst as Ryan (ryan@example.com)");
    expect(text.match(/Catalyst Cloud/g)).toHaveLength(1);
    f.ui.dispose();
  });

  test("catalyst onboard: the words, no mark", () => {
    const f = screen(truecolor, {});
    f.ui.plan(f.journal, identity);
    const text = f.text();
    expect(text).not.toMatch(/[█▀▄]/);
    expect(text).toContain("  Catalyst Cloud\n  setup · 0.15.4\n  user:      ryan@example.com\n");
    f.ui.dispose();
  });
});
