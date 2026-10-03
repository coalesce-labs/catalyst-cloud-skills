// setup-render.ts — CTC-4625: how `catalyst setup` looks. The terminal's traits come
// from the stream and the environment, and every line goes through here: a pipe, a log or a dumb
// terminal gets the same words in plain ASCII, never an escape sequence.
//
// ⛔ EVERY LINE IS WRITTEN WHEN IT IS PRINTED. Nothing here collects lines to wrap or align them
// later: the sign-in code must reach the screen before the wait for approval starts (the 0.13.9
// installer piped its login through fold, which held the code until the deadline discarded it).
import { styleText } from "node:util";
import { wrapAnsi } from "fast-wrap-ansi";
import stringWidth from "fast-string-width";

/** The part of a writable stream the renderer uses; process.stdout and process.stderr fit. */
export interface SetupStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  write(chunk: string): boolean;
}

export interface TerminalTraits {
  /** Colour and bold. */
  readonly color: boolean;
  /** ✓ ! ✗ – instead of [done] [!] [fail] [skip]. */
  readonly unicode: boolean;
  /** OSC 8 hyperlinks around the visible URL. */
  readonly links: boolean;
  readonly columns: number;
}

export type StepMark =
  "done" | "fail" | "act" | "skip" | "later" | "run" | "ask";

const DEFAULT_COLUMNS = 80;
const MIN_COLUMNS = 40;

function utf8Locale(env: NodeJS.ProcessEnv): boolean {
  return /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "");
}

/**
 * OSC 8 is shown only where a terminal is known to render it: an unknown one may print the escape
 * as text. FORCE_HYPERLINK=1 or 0 overrides the list, as in the supports-hyperlinks convention.
 */
function hyperlinkTerminal(env: NodeJS.ProcessEnv): boolean {
  if (env.FORCE_HYPERLINK === "0") return false;
  if (env.FORCE_HYPERLINK === "1") return true;
  const program = env.TERM_PROGRAM ?? "";
  if (["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper"].includes(program))
    return true;
  if ((env.TERM ?? "").includes("kitty") || env.TERM === "alacritty")
    return true;
  if (env.WT_SESSION) return true;
  const vte = Number.parseInt(env.VTE_VERSION ?? "", 10);
  return Number.isFinite(vte) && vte >= 5000;
}

export function terminalTraits(
  stream: SetupStream,
  env: NodeJS.ProcessEnv,
): TerminalTraits {
  const fancy =
    stream.isTTY === true &&
    env.NO_COLOR === undefined &&
    Boolean(env.TERM) &&
    env.TERM !== "dumb" &&
    utf8Locale(env);
  let columns = DEFAULT_COLUMNS;
  if (
    stream.isTTY === true &&
    typeof stream.columns === "number" &&
    stream.columns > 0
  )
    columns = stream.columns;
  else if (/^[1-9][0-9]{0,3}$/.test(env.COLUMNS ?? ""))
    columns = Number(env.COLUMNS);
  return {
    color: fancy,
    unicode: fancy,
    links: fancy && hyperlinkTerminal(env),
    columns: Math.max(MIN_COLUMNS, columns),
  };
}

const ASCII_MARKS: Record<StepMark, string> = {
  done: "[done]",
  fail: "[fail]",
  act: "[!]",
  skip: "[skip]",
  later: "[later]",
  run: "[..]",
  ask: "[?]",
};
const UNICODE_MARKS: Record<
  StepMark,
  [string, Parameters<typeof styleText>[0]]
> = {
  done: ["✓", "green"],
  fail: ["✗", "red"],
  act: ["▲", "yellow"],
  skip: ["–", "gray"],
  later: ["·", "gray"],
  run: ["◐", "cyan"],
  ask: ["◆", "cyan"],
};

export interface SetupRenderer {
  intro(title: string): void;
  outro(text: string): void;
  plan(number: number, title: string, detail: string): void;
  begin(
    number: number,
    title: string,
    status?: string,
    mark?: "run" | "ask",
  ): void;
  update(status: string): void;
  resolve(mark: StepMark, outcome: string): void;
  suspendLive(): void;
  promptRows(rows: number | null): void;
  dispose(): void;
  readonly traits: TerminalTraits;
  /** One step's outcome: `<mark> <number> <title>  <outcome>`, wrapped under the outcome. */
  step(mark: StepMark, number: number, title: string, outcome: string): void;
  /** An indented line under the current step. */
  detail(text: string): void;
  replaceLastDetail(text: string): void;
  /** The one thing the person must do now: bold on a terminal. */
  action(text: string): void;
  heading(text: string): void;
  /** Prose at column 3 under the rail, or column 0 in plain output. */
  line(text: string): void;
  blank(): void;
  /** A URL, clickable where the terminal renders OSC 8, always visible as text. */
  link(url: string): string;
  bold(text: string): string;
  dim(text: string): string;
  /** The run's one closing verdict: bold green or bold red on a terminal. */
  verdict(ok: boolean, text: string): string;
  mark(mark: StepMark): string;
}

export function createSetupRenderer(
  stream: SetupStream,
  env: NodeJS.ProcessEnv,
): SetupRenderer {
  let traits = terminalTraits(stream, env);
  const style = (format: Parameters<typeof styleText>[0], text: string) =>
    traits.color ? styleText(format, text, { validateStream: false }) : text;
  let width = Math.min(traits.columns, 100);
  const refresh = () => {
    const next = terminalTraits(stream, env);
    if (live && next.columns !== traits.columns) live.resized = true;
    traits = next;
    width = Math.min(traits.columns, 100);
  };
  let frame = 1;
  const visible = (text: string) =>
    text
      .replace(/\u001b\]8;;[^\u001b]*\u001b\\/g, "")
      .replace(/\u001b\[[0-9;]*m/g, "");
  const rail = traits.unicode ? "│" : "";
  // CTC-4680: details sit 4 columns in (under the rail in Unicode), not under the step title at 6 or
  // 11, so the eye doesn't travel across a small screen to read them.
  const titleCol = 4;
  const outcomeCol = traits.unicode ? 38 : 43;
  const prefix = (col: number) => rail + " ".repeat(col - rail.length);
  const mark = (kind: StepMark) => {
    if (!traits.unicode) return ASCII_MARKS[kind];
    const [glyph, colour] = UNICODE_MARKS[kind];
    return style(
      colour,
      kind === "run" ? ["◒", "◐", "◓", "◑"][frame % 4]! : glyph,
    );
  };
  const rows = (text: string, col: number): string[] => {
    refresh();
    const indent = /^ */.exec(text)?.[0].length ?? 0;
    col += indent;
    text = text.slice(indent);
    return wrapAnsi(text, Math.max(1, width - col), {
      hard: false,
      wordWrap: true,
      trim: true,
    })
      .split("\n")
      .map((line) => {
        const plain = visible(line);
        const indent =
          /^https?:\/\/\S+$/.test(plain) && stringWidth(plain) > width - col
            ? traits.unicode
              ? 3
              : 0
            : col;
        return prefix(indent) + line;
      });
  };
  const stepRows = (
    kind: StepMark,
    number: number,
    title: string,
    outcome: string,
    plan = false,
  ): string[] => {
    refresh();
    const lead = plan
      ? traits.unicode
        ? "│"
        : "       "
      : traits.unicode
        ? mark(kind)
        : mark(kind).padEnd(7);
    const titleWidth = stringWidth(visible(title));
    const label = `${lead}${traits.unicode ? "  " : " "}${String(number || "").padStart(2)} ${title}`;
    if (!outcome) return [label];
    if (width < 80 || titleWidth > 30)
      return [label, ...rows(outcome, titleCol)];
    const padding = " ".repeat(Math.max(2, 32 - titleWidth));
    const wrapped = wrapAnsi(outcome, width - outcomeCol, {
      hard: false,
      wordWrap: true,
      trim: true,
    }).split("\n");
    return [
      `${label}${padding}${wrapped[0]}`,
      ...wrapped.slice(1).map((l) => prefix(outcomeCol) + l),
    ];
  };
  const write = (lines: string[]) => stream.write(lines.join("\n") + "\n");
  let live:
    | {
        number: number;
        title: string;
        status: string;
        mark: "run" | "ask";
        details: string[];
        height: number;
        resized: boolean;
      }
    | undefined;
  const clear = () => {
    if (live && traits.unicode && !live.resized && live.height)
      stream.write(`\u001b[${live.height}A\r\u001b[J`);
  };
  let workingTimer: ReturnType<typeof setTimeout> | undefined;
  const flushWorking = () => {
    if (workingTimer) {
      clearTimeout(workingTimer);
      workingTimer = undefined;
      paint();
    }
  };
  let listening = false;
  const releaseListener = () => {
    if (listening) {
      process.off("SIGWINCH", resize);
      listening = false;
    }
  };
  const abandon = () => {
    if (workingTimer) clearTimeout(workingTimer);
    workingTimer = undefined;
    live = undefined;
    releaseListener();
  };
  const paint = () => {
    if (!live || live.resized) return;
    const lines = [
      ...stepRows(
        live.mark,
        live.number,
        style("bold", live.title),
        live.status,
      ),
      ...live.details.flatMap((t) => rows(t, titleCol)),
    ];
    const physicalWidth =
      stream.columns && stream.columns > 0 ? stream.columns : traits.columns;
    const physicalRows = lines.reduce(
      (n, line) =>
        n + Math.max(1, Math.ceil(stringWidth(visible(line)) / physicalWidth)),
      0,
    );
    if (traits.unicode) {
      clear();
      write(lines);
      live.height = physicalRows;
      // A taller block cannot be safely erased in a short terminal. Keep its scrollback instead.
      if (physicalRows > 8) live.resized = true;
    } else if (!live.height) {
      write(lines);
      live.height = physicalRows;
    }
  };
  const resize = () => {
    if (live) live.resized = true;
    refresh();
  };
  const ordinary = (lines: string[]) => {
    if (live && traits.unicode && !live.resized) {
      clear();
      live.height = 0;
      write(lines);
      if (!workingTimer) paint();
    } else write(lines);
  };
  const suspendLive = () => {
    clear();
    abandon();
  };
  const r: SetupRenderer = {
    get traits() {
      refresh();
      return traits;
    },
    intro(title) {
      refresh();
      ordinary([traits.unicode ? `┌  ${style("bold", title)}` : title]);
    },
    outro(text) {
      abandon();
      write(traits.unicode ? [`│`, `└  ${text}`] : ["", text]);
    },
    plan(number, title, text) {
      ordinary(stepRows("run", number, title, text, true));
      if (width < 80) r.blank();
    },
    begin(number, title, status = "checking…", kind = "run") {
      if (live?.number === number) suspendLive();
      else abandon();
      if (traits.unicode && !listening) {
        process.on("SIGWINCH", resize);
        listening = true;
      }
      live = {
        number,
        title,
        status,
        mark: kind,
        details: [],
        height: 0,
        resized: false,
      };
      if (status === "checking…" && kind === "run") {
        workingTimer = setTimeout(() => {
          workingTimer = undefined;
          paint();
        }, 300);
        workingTimer.unref();
      } else paint();
    },
    update(status) {
      if (live) {
        live.status = status;
        frame++;
        if (workingTimer && /waiting|new code/.test(status)) flushWorking();
        else if (!workingTimer) paint();
      }
    },
    resolve(kind, outcome) {
      if (!live) return;
      const { number, title } = live;
      clear();
      abandon();
      write(stepRows(kind, number, title, outcome));
    },
    suspendLive,
    promptRows(rows) {
      if (live) {
        if (rows === null) live.resized = true;
        else live.height += rows;
      }
    },
    dispose() {
      abandon();
    },
    step(kind, number, title, outcome) {
      if (live && live.number === number) r.resolve(kind, outcome);
      else ordinary(stepRows(kind, number, title, outcome));
    },
    detail(text) {
      flushWorking();
      if (live && traits.unicode && !live.resized) {
        live.details.push(text);
        paint();
      } else write(rows(text, titleCol));
    },
    replaceLastDetail(text) {
      if (live && traits.unicode && !live.resized && live.details.length) {
        live.details[live.details.length - 1] = text;
        paint();
      } else r.detail(text);
    },
    action(text) {
      r.detail(style("bold", text));
    },
    heading(text) {
      abandon();
      write(traits.unicode ? ["│", `├─ ${style("bold", text)}`] : ["", text]);
    },
    line(text) {
      ordinary(rows(text, traits.unicode ? 3 : 0));
    },
    blank() {
      refresh();
      ordinary([rail]);
    },
    link(url) {
      return traits.links
        ? `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\`
        : url;
    },
    bold: (text) => style("bold", text),
    dim: (text) => style("dim", text),
    verdict: (ok, text) => style(["bold", ok ? "green" : "red"], text),
    mark,
  };
  return r;
}
