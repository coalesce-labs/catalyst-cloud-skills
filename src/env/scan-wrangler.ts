// scan-wrangler.ts — a narrow, hand-written wrangler.toml reader. No TOML dependency: wrangler.toml
// uses a small, enumerable subset of TOML (top-level tables, arrays of tables, string/number/bool
// values, and triple-quoted multi-line strings), and a second runtime dependency for that subset is
// not worth it. wrangler.json / wrangler.jsonc are NOT read here (see inventory.ts's note); modern
// Wrangler defaults to JSONC, and reporting zero bindings for one would be a wrong answer dressed as
// a right one.
//
// A `[vars]` (or `[env.<name>.vars]`) table's KEYS are the names — its values are committed in the
// file, so there is nothing for a customer to declare. Every other binding-shaped table (kv_namespaces,
// d1_databases, r2_buckets, durable_objects.bindings, queues.*) names its binding through one
// attribute's VALUE, not its key — `binding = "NAME"` everywhere except durable_objects.bindings,
// which is keyed `name =` instead.
import type { RawSighting } from "./types.js";

const BINDING_KEY_BY_TABLE: Record<string, string> = {
  kv_namespaces: "binding",
  d1_databases: "binding",
  r2_buckets: "binding",
  "durable_objects.bindings": "name",
  "queues.producers": "binding",
  "queues.consumers": "binding",
};

const QUOTED_RE = /^"(.*)"$|^'(.*)'$/;
const KEY_VALUE_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/;
const TABLE_RE = /^\[\[?([^\]]+)\]\]?$/;
const ENV_TABLE_RE = /^env\.([^.]+)\.(.+)$/;

export function scanWrangler(file: string, text: string): RawSighting[] {
  const sightings: RawSighting[] = [];
  const lines = text.split("\n");
  let currentTable: string | null = null;
  let currentEnvironment: string | undefined;
  // Tracks an open triple-quoted string, so a line INSIDE one (e.g. `a = not_a_name`) is never
  // mined for a key — the key that opened the string (e.g. `MULTI = """`) already was.
  let insideMultiline: '"""' | "'''" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (insideMultiline) {
      if (trimmed.includes(insideMultiline)) insideMultiline = null;
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const tableMatch = TABLE_RE.exec(trimmed);
    if (tableMatch) {
      let name = tableMatch[1]!.trim();
      currentEnvironment = undefined;
      const envMatch = ENV_TABLE_RE.exec(name);
      if (envMatch) {
        currentEnvironment = envMatch[1];
        name = envMatch[2]!;
      }
      currentTable = name;
      continue;
    }

    if (currentTable === null) continue;
    const kv = KEY_VALUE_RE.exec(trimmed);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();

    if (isOpeningMultiline(value, '"""')) insideMultiline = '"""';
    else if (isOpeningMultiline(value, "'''")) insideMultiline = "'''";

    if (currentTable === "vars" || currentTable.endsWith(".vars")) {
      sightings.push({
        name: key,
        finding: { file, line: i + 1, consumer: "wrangler.toml vars", consumerKind: "vars" },
        isWranglerVar: true,
        wranglerEnvironment: currentEnvironment,
        localSource: "value committed in wrangler.toml — nothing to declare",
      });
      continue;
    }

    const bindingKey = BINDING_KEY_BY_TABLE[currentTable];
    if (bindingKey && key === bindingKey) {
      const qm = QUOTED_RE.exec(value);
      const bindingName = qm ? (qm[1] ?? qm[2] ?? "") : value;
      if (bindingName) {
        sightings.push({
          name: bindingName,
          finding: { file, line: i + 1, consumer: `${currentTable} binding`, consumerKind: currentTable },
          isBinding: true,
          wranglerEnvironment: currentEnvironment,
          localSource: "Cloudflare binding",
        });
      }
    }
  }
  return sightings;
}

function isOpeningMultiline(value: string, marker: '"""' | "'''"): boolean {
  if (!value.startsWith(marker)) return false;
  return !(value.length > marker.length && value.endsWith(marker));
}
