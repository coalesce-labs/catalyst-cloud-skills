// scan-source.ts — names a repository's own source reads at runtime: process.env.X,
// process.env["X"], import.meta.env.X, Deno.env.get("X"). Only the name half of the expression is
// ever captured; there is nothing here that could read the value an env var actually holds.
import type { RawSighting } from "./types.js";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
export const MAX_SOURCE_FILE_BYTES = 512 * 1024;

const PATTERNS: RegExp[] = [
  /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\bprocess\.env\[["']([A-Za-z_][A-Za-z0-9_]*)["']\]/g,
  /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\bDeno\.env\.get\(["']([A-Za-z_][A-Za-z0-9_]*)["']\)/g,
];

export function scanSource(file: string, text: string): RawSighting[] {
  const out: RawSighting[] = [];
  const lineStarts = computeLineStarts(text);
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({
        name: m[1]!,
        finding: { file, line: lineOf(lineStarts, m.index), consumer: `read by ${file}`, consumerKind: "source" },
        localSource: ".env file or your shell",
      });
    }
  }
  return out;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
