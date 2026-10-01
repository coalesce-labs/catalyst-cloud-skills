import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { CliError } from "./errors.js";

/** Bounded, regular-file snapshot for the review precheck. This is not a CAS primitive. */
export function onboardFileSnapshot(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw new CliError(
      "The saved setup files could not be verified. Keep them and try again.",
      "onboard-file-unverified",
      12,
    );
  }
  try {
    const before = fstatSync(fd);
    const limit = 1024 * 1024;
    if (!before.isFile() || before.size > limit)
      throw new Error("invalid file");
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    for (;;) {
      const read = readSync(fd, bytes, used, bytes.length - used, null);
      used += read;
      if (used > limit) throw new Error("oversized file");
      if (read === 0) break;
    }
    const after = fstatSync(fd);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      used !== after.size
    )
      throw new Error("changed file");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, used),
    );
  } catch {
    throw new CliError(
      "The saved setup files could not be verified. Keep them and try again.",
      "onboard-file-unverified",
      12,
    );
  } finally {
    closeSync(fd);
  }
}
