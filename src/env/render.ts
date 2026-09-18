// render.ts — the ONE place that decides what reaches stdout for `env inventory` and `env check`.
// Kept free of Ctx so a test can assert on it directly without a CLI round-trip, and so the
// never-a-value guarantee has exactly one function to point at.
import type { EnvGroup, Inventory } from "./types.js";

const GROUP_BLURB: Record<EnvGroup, string> = {
  "build/test": "needed to install, build and run the tests in a container",
  "deploy-only": "a CI secret used only by a deploy job",
  bindings: "a Cloudflare (or other platform) binding — not an environment value",
};

export function renderInventory(inv: Inventory): string[] {
  const lines: string[] = [];
  for (const group of inv.groups) {
    lines.push(`${group.id} — ${GROUP_BLURB[group.id]}`);
    if (group.names.length === 0) {
      lines.push("  (none found)");
    } else {
      for (const name of group.names) {
        const entry = inv.entries.find((e) => e.name === name);
        if (!entry) continue;
        const where = entry.found.map((f) => `${f.file}:${f.line}`).join(", ");
        const consumers = [...new Set(entry.found.map((f) => f.consumer))].join(", ");
        lines.push(`  ${name} — found ${where} · used by ${consumers} · value comes from ${entry.localSource}`);
      }
    }
    lines.push("");
  }
  if (inv.notes.length > 0) {
    lines.push("Notes:");
    for (const n of inv.notes) lines.push(`  ${n}`);
  }
  return lines;
}

export function inventoryToJson(inv: Inventory): unknown {
  return { root: inv.root, groups: inv.groups, entries: inv.entries, jobs: inv.jobs, notes: inv.notes };
}

export interface CheckResult {
  state: "valid" | "invalid";
  errors: string[];
}

export function renderCheck(result: CheckResult, file: string): string[] {
  if (result.state === "valid") return [`valid — ${file} passes this bundle's offline check`];
  return [`invalid — ${file} failed this bundle's offline check:`, ...result.errors.map((e) => `  - ${e}`)];
}
