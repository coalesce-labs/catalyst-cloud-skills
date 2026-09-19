import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // ⛔ NOT THE DEFAULT 5s, AND THIS IS A STARVATION FIX, NOT A SLOW TEST. Two files in this suite
    // do real package work — `smoke-publish` packs and installs the tarball, `git-install-rail`
    // clones and installs over git — and both already carry their own minutes-long timeouts because
    // they know they are slow. What they do NOT do is stop saturating a 2-core runner while vitest
    // schedules other files beside them. Measured on CI: the same `query.test.ts` and
    // `replica.test.ts` that take 2519ms and 2789ms when they run outside that window take 16087ms
    // and 21236ms when they run inside it, and their SQLite-backed tests blow a 5s per-test budget.
    // Whether they land in that window is decided by file scheduling, so the suite was one ordering
    // away from a red run on any branch — it went green 18 times in a row and then failed on a
    // change that added one small file. No test here relies on the default being tight (none asserts
    // a timeout), and the genuinely slow ones name their own, so raising the floor costs nothing and
    // removes the coin flip. The real fix is to stop doing package installs inside the unit suite.
    //
    // ⛔ THE NUMBER IS SIZED TO THE STARVATION WINDOW, NOT TO ANY TEST'S REAL COST. The starved tests
    // are sub-second when they run alone; what they have to survive is the heavy files' window, and
    // those take up to ~21s EACH and can overlap. A floor just above the longest observed window
    // would leave the coin flip half in place, and the killed test's true duration is unknowable
    // (vitest reports a timeout as the budget, so 5000ms is all the red run recorded). 60s clears the
    // whole window with room, still reports a genuine hang inside a minute, and sits well under the
    // 240s and 300s the two heavy files already choose for themselves.
    testTimeout: 60_000,
    // CTC-2160 — `ready`'s published-release lookup is this package's first network call. The
    // subprocess suites (smoke-publish, git-install-rail, bin-stdout, unstick-script,
    // skill-scripts-credential) spawn the real binary with `{ ...process.env, ... }`, which inherits
    // whatever vitest sets on this process's own env — this is the second belt beside
    // test/helpers.ts's `makeCtx` default, for the tests that never go through it.
    env: { CATALYST_SKILLS_OFFLINE: "1" },
    coverage: {
      provider: "v8",
      // Only measure first-party source — keep stray root/config files out of the denominator.
      include: ["src/**/*.{ts,tsx}"],
      // detach.ts is a real detached spawn; the tests stub it rather than fork the CLI.
      exclude: ["src/detach.ts"],
      reporter: ["text", "json-summary", "lcov"],
      // Still write the report even when a threshold fails.
      reportOnFailure: true,
      thresholds: { statements: 90, branches: 85, functions: 85, lines: 90 },
    },
  },
});
