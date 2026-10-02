// setup-events.ts — CTC-4625: the line protocol the install engine speaks to `catalyst setup`.
//
// The engine (the served install script's step bodies, run with CATALYST_INSTALL_UI=events) writes
// one event per line on fd 4, fields separated by a tab. It never draws anything itself: the plan,
// each step's outcome, the questions and the sign-in all reach the person through the renderer here.
// A line this parser does not know is shown as text, so an engine newer than the CLI still reads.
import type { StepMark } from "./setup-render.js";

export type SetupEvent =
  | { kind: "line"; text: string }
  | { kind: "row"; label: string; value: string }
  | { kind: "heading"; text: string }
  | { kind: "plan"; number: number; title: string; text: string }
  | { kind: "more"; text: string }
  | { kind: "begin"; number: number; title: string }
  | {
      kind: "step";
      mark: StepMark;
      number: number;
      title: string;
      outcome: string;
    }
  | { kind: "detail"; text: string }
  | { kind: "change"; text: string }
  | { kind: "changes-end" }
  | { kind: "verdict"; ok: boolean; text: string }
  | {
      kind: "stop";
      header: string;
      what: string;
      done: string;
      fix: string;
      log: string;
      resume: string;
    }
  | { kind: "ask"; id: string; question: string; fallback: string }
  | { kind: "signin"; timeoutSeconds: number }
  | { kind: "note"; text: string };

const MARKS: readonly StepMark[] = [
  "done",
  "act",
  "fail",
  "skip",
  "later",
  "run",
  "ask",
];
const isStepMark = (value: string | undefined): value is StepMark =>
  MARKS.some((mark) => mark === value);
const WHOLE = /^(0|[1-9][0-9]{0,8})$/;

function parse(kind: string, f: string[]): SetupEvent | null {
  const text = (n: number) => (f.length === n ? f : null);
  switch (kind) {
    case "line":
    case "heading":
    case "more":
    case "detail":
    case "change":
    case "note":
      return text(1) && { kind, text: f[0] ?? "" };
    case "row":
      return text(2) && { kind, label: f[0] ?? "", value: f[1] ?? "" };
    case "plan":
      return text(3) && WHOLE.test(f[0] ?? "")
        ? { kind, number: Number(f[0]), title: f[1] ?? "", text: f[2] ?? "" }
        : null;
    case "begin":
      return text(2) && WHOLE.test(f[0] ?? "")
        ? { kind, number: Number(f[0]), title: f[1] ?? "" }
        : null;
    case "step": {
      const mark = f[0] === "ok" ? "done" : f[0] === "warn" ? "act" : f[0];
      return text(4) && isStepMark(mark) && WHOLE.test(f[1] ?? "")
        ? {
            kind,
            mark,
            number: Number(f[1]),
            title: f[2] ?? "",
            outcome: f[3] ?? "",
          }
        : null;
    }
    case "changes-end":
      return text(0) && { kind };
    case "verdict":
      return text(2) && (f[0] === "ok" || f[0] === "fail")
        ? { kind, ok: f[0] === "ok", text: f[1] ?? "" }
        : null;
    case "stop": {
      if (!text(6)) return null;
      const [
        header = "",
        what = "",
        done = "",
        fix = "",
        log = "",
        resume = "",
      ] = f;
      return { kind, header, what, done, fix, log, resume };
    }
    case "ask":
      return text(3) && /^[a-z][a-z0-9-]{0,40}$/.test(f[0] ?? "")
        ? { kind, id: f[0] ?? "", question: f[1] ?? "", fallback: f[2] ?? "" }
        : null;
    case "signin":
      return text(1) && WHOLE.test(f[0] ?? "")
        ? { kind, timeoutSeconds: Number(f[0]) }
        : null;
    default:
      return null;
  }
}

export function parseSetupEvent(raw: string): SetupEvent {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  const [kind = "", ...fields] = line.split("\t");
  return (
    parse(kind, fields) ?? { kind: "line", text: line.replaceAll("\t", " ") }
  );
}

/** Turns a stream's chunks into events, one per completed line, the moment each line completes. */
export class SetupEventStream {
  #pending = "";
  constructor(
    private readonly onEvent: (event: SetupEvent) => void,
    private readonly parse: (line: string) => SetupEvent = parseSetupEvent,
  ) {}

  push(chunk: string): void {
    const lines = (this.#pending + chunk).split("\n");
    this.#pending = lines.pop() ?? "";
    for (const line of lines) this.onEvent(this.parse(line));
  }

  end(): void {
    if (this.#pending !== "") this.onEvent(this.parse(this.#pending));
    this.#pending = "";
  }
}

/** A line outside the protocol (the engine's own stdout or stderr), shown as it is. */
export function plainSetupLine(line: string): SetupEvent {
  return {
    kind: "line",
    text: (line.endsWith("\r") ? line.slice(0, -1) : line).replaceAll(
      "\t",
      " ",
    ),
  };
}
