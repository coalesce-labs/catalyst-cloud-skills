// terminal-background.ts — CTC-4680: is the terminal's background light or dark, so setup's mark
// takes the brand's light or dark colours. The order: CATALYST_THEME, then COLORFGBG, then asking
// the terminal (OSC 11), then dark. Asking is the only part that touches the terminal, and it must
// leave nothing behind: the input's mode is restored, the reply never reaches the first prompt, and
// a key the person pressed meanwhile is handed back to the input rather than eaten.

export type Theme = "light" | "dark";

/** CATALYST_THEME=light|dark, then COLORFGBG ("fg;bg", where 7 and 15 are light). Null when
 *  neither says. */
export function envTheme(env: NodeJS.ProcessEnv): Theme | null {
  const chosen = (env.CATALYST_THEME ?? "").trim().toLowerCase();
  if (chosen === "light" || chosen === "dark") return chosen;
  const bg = (env.COLORFGBG ?? "").split(";").at(-1) ?? "";
  if (!/^[0-9]+$/.test(bg)) return null;
  return bg === "7" || bg === "15" ? "light" : "dark";
}

/**
 * The colour in an OSC 11 reply, `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` ended by BEL or ST. Each part is
 * 1 to 4 hex digits, scaled to 0..1.
 */
export function parseOsc11(
  reply: string,
): readonly [number, number, number] | null {
  const m =
    /\u001b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(
      reply,
    );
  if (!m) return null;
  const scale = (hex: string) =>
    Number.parseInt(hex, 16) / (16 ** hex.length - 1);
  return [scale(m[1]!), scale(m[2]!), scale(m[3]!)];
}

/** Light above 0.5 luma (Rec. 709 weights on the colour as sent). */
export function themeOf(rgb: readonly [number, number, number]): Theme {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.5
    ? "light"
    : "dark";
}

/** The part of a TTY input stream the query needs; a node:tty ReadStream fits. */
export interface QueryInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "newListener", listener: (event: string | symbol) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "newListener", listener: (event: string | symbol) => void): unknown;
  emit(event: string | symbol, ...args: unknown[]): boolean;
  unshift?(chunk: Buffer): void;
  readonly readableFlowing?: boolean | null;
  pause?(): unknown;
}

const OSC11_REPLY = /\u001b\]11;[^\u0007\u001b]*(?:\u0007|\u001b\\)/;
/** Primary device attributes (DA1). Terminals answer in order and nearly all answer DA1, so once
 *  its reply is in, no OSC 11 reply can follow: the query ends there, not at the timeout. */
const DA1_REPLY = /\u001b\[\?[0-9;]*c/;
/** Bytes that may be the start of a reply still arriving. */
const REPLY_START = /^\u001b(?:$|\](?:1(?:1(?:;[^\u0007\u001b]*(?:\u001b)?)?)?)?$|\[(?:\?[0-9;]*)?$)/;

export const QUERY_TIMEOUT_MS = 150;
/**
 * After the timeout the answer is dark, but a slow terminal may still reply. For this long the
 * replies are still taken out of the input, so a late one never reaches the shell or the first
 * prompt. It ends sooner when the DA1 reply arrives.
 */
export const LATE_MS = 350;

/** Splits terminal replies out of the input as it arrives; what is left is what the person typed. */
function replyFilter() {
  let pending = "";
  return {
    /** What is held back as a possible reply start, emptied. */
    release(): string {
      const held = pending;
      pending = "";
      return held;
    },
    /** Adds `text`; returns the keys in it and whether DA1 (the last reply) is in. */
    take(text: string): { keys: string; osc: Theme | null; answered: boolean } {
      pending += text;
      let osc: Theme | null = null;
      let answered = false;
      for (;;) {
        const reply = OSC11_REPLY.exec(pending);
        if (reply) {
          const rgb = parseOsc11(reply[0]);
          if (rgb) osc = themeOf(rgb);
          pending = pending.slice(0, reply.index) + pending.slice(reply.index + reply[0].length);
          continue;
        }
        const da1 = DA1_REPLY.exec(pending);
        if (!da1) break;
        pending = pending.slice(0, da1.index) + pending.slice(da1.index + da1[0].length);
        answered = true;
      }
      // Whatever cannot be the start of a reply is a key; after DA1 nothing is a reply.
      let keep = pending.length;
      if (!answered)
        for (let i = pending.indexOf("\u001b"); i !== -1; i = pending.indexOf("\u001b", i + 1))
          if (REPLY_START.test(pending.slice(i))) {
            keep = i;
            break;
          }
      const keys = pending.slice(0, keep);
      pending = pending.slice(keep);
      return { keys, osc, answered };
    },
  };
}

const text = (chunk: unknown) =>
  typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("latin1");

/**
 * Ask the terminal for its background (OSC 11, then DA1 as the end marker). Resolves to the theme,
 * or null when the terminal said nothing usable within the timeout.
 *
 * Raw mode is on only while this function is the input's reader; the input's own mode and flow are
 * restored after. Keys typed meanwhile go back to the input for its next reader, except Ctrl-C,
 * which raw mode would otherwise swallow: it ends the query and is raised as an interrupt. After
 * the timeout, a late reply is still taken out for LATE_MS. When something else starts reading in
 * that time (the first prompt), the replies are taken out of the data it receives instead.
 */
export function queryBackground(
  input: QueryInput,
  output: { write(chunk: string): unknown },
  timeoutMs = QUERY_TIMEOUT_MS,
  interrupt: () => void = () => process.kill(process.pid, "SIGINT"),
): Promise<Theme | null> {
  if (input.isTTY !== true || typeof input.setRawMode !== "function")
    return Promise.resolve(null);
  const wasRaw = input.isRaw === true;
  // A stream nobody reads yet (readableFlowing null) must not be left flowing: with no listener,
  // a late byte or a handed-back key would be emitted to nobody. Readers resume it themselves.
  const wasFlowing = input.readableFlowing === true;
  const filter = replyFilter();
  const ownEmit = input.emit;
  return new Promise((resolve) => {
    let typed = "";
    let theme: Theme | null = null;
    let settled = false;
    let reading = true; // this function is the input's only reader
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve(theme);
      }
    };
    /** Stop being the reader: listener off, mode and flow back, typed keys back, followed by any
     *  held bytes in the order they came (the filter on the prompt's data holds them again). */
    const stopReading = () => {
      if (!reading) return;
      reading = false;
      input.off("data", onData);
      input.off("newListener", onReader);
      try {
        input.setRawMode!(wasRaw);
      } finally {
        if (!wasFlowing) input.pause?.();
        const back = typed + filter.release();
        if (back && input.unshift) input.unshift(Buffer.from(back, "latin1"));
        typed = "";
      }
    };
    const end = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      // A lone Esc still held at the end was a key, not the start of a reply that never came.
      const esc = filter.release() === "\u001b";
      const wasReading = reading;
      if (esc && wasReading) typed += "\u001b";
      stopReading();
      input.emit = ownEmit;
      if (esc && !wasReading) input.unshift?.(Buffer.from("\u001b"));
      settle();
    };
    const onData = (chunk: Buffer | string) => {
      const { keys, osc, answered } = filter.take(text(chunk));
      if (osc && !settled) theme = osc;
      typed += keys;
      if (typed.includes("\u0003")) {
        typed = typed.replaceAll("\u0003", "");
        end();
        interrupt();
      } else if (answered) end();
    };
    // A prompt starting to read during the late wait: hand it the input, and take the replies out
    // of the data it is given until the wait ends.
    const onReader = (event: string | symbol) => {
      if (event !== "data" && event !== "keypress" && event !== "readable") return;
      input.emit = function (event: string | symbol, ...args: unknown[]) {
        if (event !== "data") return ownEmit.call(input, event, ...args);
        const { keys, answered } = filter.take(text(args[0]));
        if (answered) end();
        if (!keys) return true;
        return ownEmit.call(
          input,
          "data",
          typeof args[0] === "string" ? keys : Buffer.from(keys, "latin1"),
        );
      };
      stopReading();
    };
    input.on("data", onData);
    try {
      input.setRawMode!(true);
      output.write("\u001b]11;?\u0007\u001b[c");
    } catch {
      end();
      return;
    }
    if (done) return;
    input.on("newListener", onReader);
    timer = setTimeout(() => {
      settle();
      timer = setTimeout(end, LATE_MS);
    }, timeoutMs);
  });
}

/**
 * The background, in order: CATALYST_THEME, COLORFGBG, the terminal's own answer (only when
 * `ask` holds), then dark.
 */
export async function detectTheme(
  env: NodeJS.ProcessEnv,
  ask?: { input: QueryInput; output: { write(chunk: string): unknown } },
  timeoutMs = QUERY_TIMEOUT_MS,
): Promise<Theme> {
  const known = envTheme(env);
  if (known) return known;
  if (!ask) return "dark";
  return (await queryBackground(ask.input, ask.output, timeoutMs)) ?? "dark";
}
