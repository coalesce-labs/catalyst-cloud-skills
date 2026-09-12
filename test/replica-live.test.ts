// replica-live.test.ts — `replica start` end to end against a real tenant. Skipped unless
// CATALYST_SKILLS_LIVE_TEST=1 with CATALYST_CLOUD_TOKEN (and optionally CATALYST_CLOUD_BASE_URL) set.
import { describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { configPathFor, cliPath, DEFAULT_BASE_URL } from "../src/config";
import { fetchMe } from "../src/transport";
import { makeCtx, tempHome } from "./helpers";

const live = process.env.CATALYST_SKILLS_LIVE_TEST === "1" && Boolean(process.env.CATALYST_CLOUD_TOKEN);

describe.skipIf(!live)("replica start (live)", () => {
  test("seeds, reports fresh, and stops on request", { timeout: 180_000 }, async () => {
    const home = tempHome();
    const baseUrl = process.env.CATALYST_CLOUD_BASE_URL ?? DEFAULT_BASE_URL;
    const key = process.env.CATALYST_CLOUD_TOKEN!;
    const me = await fetchMe(baseUrl, key, fetch);
    mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
    writeFileSync(
      configPathFor(home),
      JSON.stringify({ baseUrl, key, ...me, joinedAt: new Date().toISOString(), lastSkillBundleVersion: "0.2.0", cliPath: cliPath() }),
      { mode: 0o600 },
    );
    const ctx = makeCtx(home);
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const run = main(["replica", "start"], ctx, { replica: { waitForStop: () => stopped } });
    const started = Date.now();
    while (!ctx.out.some((l) => l.startsWith("replica live at")) && Date.now() - started < 150_000) {
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(ctx.out.some((l) => l.startsWith("replica live at"))).toBe(true);
    const status = makeCtx(home);
    expect(await main(["replica", "status"], status)).toBe(0);
    stop();
    expect(await run).toBe(0);
  });
});
