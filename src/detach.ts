// detach.ts — re-spawn this CLI detached (replica start --detach). Isolated so a test can stub it.
import { spawn } from "node:child_process";

export interface DetachResult {
  pid: number;
}

/** Spawn `process.execPath <argv>` detached from this process, stdio ignored, and let it go. */
export function detachSelf(argv: string[], env: NodeJS.ProcessEnv = process.env): DetachResult {
  const child = spawn(process.execPath, argv, { detached: true, stdio: "ignore", env });
  child.unref();
  if (typeof child.pid !== "number") throw new Error("detached spawn returned no pid");
  return { pid: child.pid };
}
