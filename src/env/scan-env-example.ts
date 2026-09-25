// scan-env-example.ts — documented names from a .env.example-shaped file. The regex's NAME group
// stops at the "="; the value half is captured for ONE purpose only — deciding whether the value
// opens something that later lines continue — and is never read, stored or emitted beyond that. A
// multi-line value (a PEM key is the common real case) has continuation lines shaped exactly
// like an assignment, so before CTC-2496's remediation of validate attempt 7 the pre-"=" run of such
// a line was emitted as a variable NAME. The open-value trackers below are the same idiom
// `scan-wrangler.ts` already uses for a triple-quoted TOML string.
//
// ⛔ TWO SHAPES THE QUOTE TRACKER ALONE DOES NOT COVER (validate attempt 29, M-1/CR-2 and CR-3):
//   1. An UNQUOTED PEM block. `KEY=-----BEGIN RSA PRIVATE KEY-----` opens no quote, so nothing was
//      tracked and the base64 body's own pre-"=" run — base64 padding ends a line with "=" — was
//      emitted as a NAME. Measured on real keys: 18 of 60 freshly generated RSA-2048 PKCS#8 keys
//      have a final base64 line that matches LINE_RE. PEM armour is a literal, standardised
//      delimiter pair, so it is tracked structurally rather than guessed at from the name's shape.
//   2. A COMMENTED assignment whose value opens a quote. LINE_RE matches commented assignments on
//      purpose (group 1), so `#FOO="open` used to turn the tracker on and swallow every following
//      line — real names silently lost, with no note. A value opened on a comment line can only
//      continue through further comment lines; the first uncommented line ends it and is read.
import type { RawSighting } from "./types.js";

export const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template", ".env.defaults", ".dev.vars.example"];

const LINE_RE = /^\s*(#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const PEM_BEGIN = "-----BEGIN";
const PEM_END = "-----END";

export function scanEnvExample(file: string, text: string): RawSighting[] {
  const out: RawSighting[] = [];
  const lines = text.split("\n");
  // Non-null while a quoted value is still open. Lines inside one are skipped entirely: the name
  // that opened the value was already recorded, and everything after it is value material.
  let openQuote: '"' | "'" | null = null;
  // True when the open quote was opened by a COMMENTED assignment — see shape 2 above.
  let openQuoteCommented = false;
  // True while a PEM armour block opened by a value half is still unterminated — see shape 1 above.
  let openPem = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (openPem) {
      if (line.includes(PEM_END)) openPem = false;
      continue;
    }
    if (openQuote) {
      if (openQuoteCommented && !line.trimStart().startsWith("#")) {
        // The comment block ended, so the "value" ended with it. Fall through and read this line.
        openQuote = null;
        openQuoteCommented = false;
      } else {
        if (line.includes(openQuote)) {
          openQuote = null;
          openQuoteCommented = false;
        }
        continue;
      }
    }
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const value = m[3]!;
    if (value.includes(PEM_BEGIN) && !value.includes(PEM_END)) {
      openPem = true;
    } else {
      openQuote = unclosedQuote(value);
      openQuoteCommented = openQuote !== null && m[1] !== undefined;
    }
    out.push({
      name: m[2]!,
      finding: { file, line: i + 1, consumer: `a documented name in ${file}`, consumerKind: "env-example" },
      localSource: ".env file or your shell",
    });
  }
  return out;
}

/** The quote character this value half opens and does not close on its own line, or null. */
function unclosedQuote(value: string): '"' | "'" | null {
  const v = value.trim();
  const q = v[0];
  if (q !== '"' && q !== "'") return null;
  return v.slice(1).includes(q) ? null : q;
}
