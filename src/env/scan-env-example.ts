// scan-env-example.ts — documented names from a .env.example-shaped file. The regex's capture group
// stops at the "=": there is no group for the value half, so a value can never reach this scanner's
// output even if the file carries one (a real .env.example sometimes does, as a placeholder).
import type { RawSighting } from "./types.js";

export const ENV_EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template", ".env.defaults", ".dev.vars.example"];

const LINE_RE = /^\s*(#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export function scanEnvExample(file: string, text: string): RawSighting[] {
  const out: RawSighting[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i]!);
    if (!m) continue;
    out.push({
      name: m[2]!,
      finding: { file, line: i + 1, consumer: `a documented name in ${file}`, consumerKind: "env-example" },
      localSource: ".env file or your shell",
    });
  }
  return out;
}
