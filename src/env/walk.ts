// walk.ts — the one definition of "the files this repository is made of", shared by every scanner
// that needs to enumerate a tree. Skips the directories no scan should ever descend into.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);

/** Every file under `root`, relative paths, POSIX-separated, skipping SKIP_DIRS. */
export function walkRepo(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        stack.push(full);
      } else {
        out.push(relative(root, full).split("\\").join("/"));
      }
    }
  }
  return out.sort();
}
