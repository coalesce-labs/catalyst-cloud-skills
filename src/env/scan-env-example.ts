// scan-env-example.ts — documented names from a .env.example-shaped file. The regex's NAME group
// stops at the "="; the value half is captured for ONE purpose only — deciding whether the value
// opens a quote that later lines continue — and is never read, stored or emitted beyond that. A
// multi-line quoted value (a PEM key is the common real case) has continuation lines shaped exactly
// like an assignment, so before CTC-2496's remediation of validate attempt 7 the pre-"=" run of such
// a line was emitted as a variable NAME. The open-quote tracker below is the same idiom
// `scan-wrangler.ts` already uses for a triple-quoted TOML string.
import type { RawSighting } from "./types.js";

export const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template", ".env.defaults", ".dev.vars.example"];

const LINE_RE = /^\s*(#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function scanEnvExample(file: string, text: string): RawSighting[] {
  const out: RawSighting[] = [];
  const lines = text.split("\n");
  // Non-null while a quoted value is still open. Lines inside one are skipped entirely: the name
  // that opened the value was already recorded, and everything after it is value material.
  let openQuote: '"' | "'" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (openQuote) {
      if (line.includes(openQuote)) openQuote = null;
      continue;
    }
    const m = LINE_RE.exec(line);
    if (!m) continue;
    openQuote = unclosedQuote(m[3]!);
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
