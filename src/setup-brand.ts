// setup-brand.ts — CTC-4680: the Pixel Nucleus mark at the top of `catalyst setup`, drawn in
// terminal half blocks from the brand geometry (catalyst-cloud docs/brand-mark.md,
// scripts/generate-pixel-nucleus.ts) in the brand colours at the terminal's colour level. Only
// setup draws it, and only where it can be seen: anywhere else the text lines say it all.
import type { Theme } from "./terminal-background.js";

type Cell = readonly [col: number, row: number];
type Paint = "ring" | "core";

/** Ring order runs from the top tip, round the back, to the bottom tip, as in the brand script. */
export const RING: readonly Cell[] = [
  [3, 0],
  [2, 0],
  [1, 0],
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 3],
  [3, 3],
];
export const CORE: readonly Cell[] = [
  [1, 1],
  [2, 1],
  [1, 2],
  [2, 2],
];

/**
 * The mark's size, in units one column wide and half a line tall. A terminal cell is about 1:2, so
 * a unit is square, and the mark spans 4 × dot + 3 × gap units each way, two unit rows to a line.
 * D, Ryan's pick: { dot: 3, gap: 1 } is 15 units, 15 columns by 8 lines, the last line holding only
 * upper halves. C, the larger option, is { dot: 4, gap: 2 }: 22 columns by 11 lines.
 */
export interface MarkSize {
  readonly dot: number;
  readonly gap: number;
}
export const MARK_SIZE: MarkSize = { dot: 3, gap: 1 };

export const markSpan = (size: MarkSize = MARK_SIZE) => 4 * size.dot + 3 * size.gap;
export const markLines = (size: MarkSize = MARK_SIZE) => Math.ceil(markSpan(size) / 2);

const paintOf = (col: number, row: number): Paint | null =>
  RING.some(([c, r]) => c === col && r === row)
    ? "ring"
    : CORE.some(([c, r]) => c === col && r === row)
      ? "core"
      : null;

/** The mark as a grid of square units, `markSpan` rows of half lines by `markSpan` columns. */
export function markUnits(size: MarkSize = MARK_SIZE): (Paint | null)[][] {
  const span = markSpan(size);
  const pitch = size.dot + size.gap;
  return Array.from({ length: span }, (_, y) =>
    Array.from({ length: span }, (_, x) =>
      x % pitch >= size.dot || y % pitch >= size.dot
        ? null
        : paintOf(Math.floor(x / pitch), Math.floor(y / pitch)),
    ),
  );
}

const BRAND = {
  ink: "#11100e",
  cream: "#f1ebe2",
  copper: "#d28e63",
  rust: "#a9512f",
} as const;

/** The brand rules: a cream C and copper core on dark, an ink C and rust core on light. */
const PALETTES = {
  dark: { ring: BRAND.cream, core: BRAND.copper },
  light: { ring: BRAND.ink, core: BRAND.rust },
} as const;

/**
 * How much colour the terminal shows. --no-color first; then FORCE_COLOR (0 none, 1 16, 2 256,
 * 3 24-bit); then none for NO_COLOR, no terminal, or TERM unset or dumb; 24-bit for COLORTERM
 * truecolor or 24bit; 256 for a TERM naming 256 colours; otherwise 16.
 */
export type ColourLevel = "none" | "16" | "256" | "truecolor";

export function colourLevel(
  env: NodeJS.ProcessEnv,
  terminal: { readonly tty: boolean; readonly noColor?: boolean },
): ColourLevel {
  if (terminal.noColor) return "none";
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return "none";
    if (force === "" || force === "1" || force === "true") return "16";
    if (force === "2") return "256";
    if (force === "3") return "truecolor";
  }
  if (env.NO_COLOR !== undefined || !terminal.tty) return "none";
  if (!env.TERM || env.TERM === "dumb") return "none";
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return "truecolor";
  return /256/.test(env.TERM) ? "256" : "16";
}

/** CI as most tools read it: set, and not "", "0" or "false". */
export function inCi(env: NodeJS.ProcessEnv): boolean {
  return ![undefined, "", "0", "false"].includes(env.CI);
}

export const MARK_MIN_COLUMNS = 60;

/**
 * Why the mark is left off, or null to draw it. Off for every verb but setup, without a terminal,
 * in CI, with --no-color or NO_COLOR or no colour at all, without UTF-8 (the blocks are UTF-8), and
 * below 60 columns. The text lines are printed either way.
 */
export function markSkipped(options: {
  readonly setup: boolean;
  readonly tty: boolean;
  readonly columns: number;
  readonly env: NodeJS.ProcessEnv;
  readonly noColor?: boolean;
}): string | null {
  const { env } = options;
  if (!options.setup) return "not catalyst setup";
  if (!options.tty) return "not a terminal";
  if (inCi(env)) return "CI";
  if (options.noColor) return "--no-color";
  if (env.NO_COLOR !== undefined) return "NO_COLOR";
  if (colourLevel(env, options) === "none") return "no colour";
  if (!/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || ""))
    return "not UTF-8";
  if (options.columns < MARK_MIN_COLUMNS) return "narrow";
  return null;
}

type Rgb = readonly [number, number, number];
const rgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];
const distance = (a: Rgb, b: Rgb) =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** The nearest xterm-256 colour: the 6×6×6 cube or the 24-step grey ramp, whichever is closer. */
export function nearest256(hex: string): number {
  const colour = rgb(hex);
  const levels = [0, 95, 135, 175, 215, 255];
  const step = (v: number) =>
    levels.reduce(
      (best, l, i) => (Math.abs(l - v) < Math.abs(levels[best]! - v) ? i : best),
      0,
    );
  const [ri, gi, bi] = colour.map(step) as [number, number, number];
  const avg = (colour[0] + colour[1] + colour[2]) / 3;
  const greyIndex = Math.min(23, Math.max(0, Math.round((avg - 8) / 10)));
  const grey = 8 + 10 * greyIndex;
  return distance([levels[ri]!, levels[gi]!, levels[bi]!], colour) <=
    distance([grey, grey, grey], colour)
    ? 16 + 36 * ri + 6 * gi + bi
    : 232 + greyIndex;
}

/** xterm's default 16 colours, as SGR foreground codes. */
const XTERM16: readonly (readonly [number, Rgb])[] = [
  [30, [0, 0, 0]],
  [31, [205, 0, 0]],
  [32, [0, 205, 0]],
  [33, [205, 205, 0]],
  [34, [0, 0, 238]],
  [35, [205, 0, 205]],
  [36, [0, 205, 205]],
  [37, [229, 229, 229]],
  [90, [127, 127, 127]],
  [91, [255, 0, 0]],
  [92, [0, 255, 0]],
  [93, [255, 255, 0]],
  [94, [92, 92, 255]],
  [95, [255, 0, 255]],
  [96, [0, 255, 255]],
  [97, [255, 255, 255]],
];

/**
 * The nearest of xterm's 16 default colours. Plain distance puts copper nearest grey (90), and the
 * core is the mark's one accent, so the core picks from the coloured entries only: copper is then
 * yellow (33) and rust red (31). The ring takes plain distance: cream is white (37), ink black (30).
 */
export function nearest16(hex: string, accent = false): number {
  const colour = rgb(hex);
  const greys = [30, 37, 90, 97];
  return XTERM16.filter(([code]) => !accent || !greys.includes(code)).reduce(
    (best, entry) =>
      distance(entry[1], colour) < distance(best[1], colour) ? entry : best,
  )[0];
}

/**
 * The SGR parameters for one of the mark's colours on a `theme` background, as a foreground or a
 * background. With 16 colours the core is also bold, which most terminals draw brighter.
 */
export function markColour(
  paint: Paint,
  theme: Theme,
  level: Exclude<ColourLevel, "none">,
  layer: "fg" | "bg" = "fg",
): string {
  const hex = PALETTES[theme][paint];
  const lead = layer === "fg" ? 38 : 48;
  if (level === "truecolor") return `${lead};2;${rgb(hex).join(";")}`;
  if (level === "256") return `${lead};5;${nearest256(hex)}`;
  const code = nearest16(hex, paint === "core") + (layer === "fg" ? 0 : 10);
  return paint === "core" && layer === "fg" ? `1;${code}` : String(code);
}

/**
 * Units to terminal lines, two unit rows per line: both halves set is a full block (or an upper
 * half block on the lower colour's background when they differ), one half is a half block, neither
 * is a space. Each run of one glyph colour is closed with a reset.
 */
export function unitLines(
  units: readonly (readonly (Paint | null)[])[],
  theme: Theme,
  level: Exclude<ColourLevel, "none">,
): string[] {
  const lines: string[] = [];
  for (let y = 0; y < units.length; y += 2) {
    const upper = units[y]!;
    const lower = units[y + 1] ?? [];
    let out = "";
    let open = "";
    for (let x = 0; x < upper.length; x++) {
      const [top, bottom] = [upper[x] ?? null, lower[x] ?? null];
      const sgr =
        top && bottom && top !== bottom
          ? `${markColour(top, theme, level)};${markColour(bottom, theme, level, "bg")}`
          : top || bottom
            ? markColour((top ?? bottom)!, theme, level)
            : "";
      if (sgr !== open) {
        if (open) out += "\u001b[0m";
        if (sgr) out += `\u001b[${sgr}m`;
        open = sgr;
      }
      out +=
        !top && !bottom
          ? " "
          : top && bottom && top === bottom
            ? "█"
            : top
              ? "▀"
              : "▄";
    }
    lines.push(open ? `${out}\u001b[0m` : out);
  }
  return lines;
}

/** The mark, one string per terminal line: `markLines` lines of `markSpan` columns. */
export function pixelNucleusLines(
  theme: Theme,
  level: Exclude<ColourLevel, "none">,
  size: MarkSize = MARK_SIZE,
): string[] {
  return unitLines(markUnits(size), theme, level);
}
