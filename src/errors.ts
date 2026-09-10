// errors.ts — the three error classes the exit contract is built on: usage → 1, MeError/CliError → 2.
export class UsageError extends Error {}

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Exit code the dispatcher returns for this error. Defaults to 2 (the CliError contract). */
    readonly exitCode: number = 2,
    /** The HTTP status that produced it, when one did. */
    readonly status?: number,
  ) {
    super(message);
  }
}

export class MeError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "network" | "shape",
    readonly status?: number,
  ) {
    super(message);
  }
}
