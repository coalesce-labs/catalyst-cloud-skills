// walk.ts — the one definition of "the files this repository is made of", shared by every scanner
// that needs to enumerate a tree. Skips the directories no scan should ever descend into.
//
// ⛔ A SYMLINK IS REPOSITORY CONTENT, AND REPOSITORY CONTENT IS UNTRUSTED (validate attempt 29,
// M-2 / CR-5). `statSync` FOLLOWS a link, so the previous walk had no way to tell a real directory
// from a link out of the tree, and no visited set to stop a cycle. Measured: a single `pkg/up -> ..`
// link reported one name 41 times with absurd file:line pairs, and a committed `elsewhere -> /tmp/x`
// walked a directory outside the repository entirely. So every entry is classified with a DIRENT
// (never a followed stat), and a link is followed only when its real path is inside the repository
// root and has not been walked before.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);

/** Every file under `root`, relative paths, POSIX-separated, skipping SKIP_DIRS. */
export function walkRepo(root: string): string[] {
  const out: string[] = [];
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return out;
  }
  // Real paths already descended into. Seeded with the root so a link back to it is a cycle.
  const walked = new Set<string>([realRoot]);
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      const full = join(dir, name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          continue;
        }
        if (!contains(realRoot, real)) continue; // points out of the repository
        try {
          isDirectory = statSync(full).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDirectory) {
        if (SKIP_DIRS.has(name)) continue;
        // Every directory is keyed by its REAL path, link or not: `pkg/up -> pkg` is a cycle only
        // because the link and the directory resolve to the same place, and checking the link alone
        // would still walk the tree one extra time under its second name.
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          continue;
        }
        if (walked.has(real)) continue; // a cycle, or a second route to the same tree
        walked.add(real);
        stack.push(full);
      } else {
        out.push(relative(root, full).split("\\").join("/"));
      }
    }
  }
  return out.sort();
}

/** True when `child` is `root` itself or lies beneath it. Both must already be real paths. */
export function contains(root: string, child: string): boolean {
  const a = resolve(root);
  const b = resolve(child);
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}
