// unstick-script.test.ts — the unstick skill's script as a customer's agent runs it: a real `node`
// process, a home holding a customer.json, and a stand-in CLI at the recorded cliPath that answers
// each verb with JSON. Proves the launcher treats a keyless login (an `auth` block, no `key`) as
// connected, and that the preview-then-release sequence and exit codes hold.
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "skills", "unstick", "scripts", "unstick.mjs");

/** A stand-in CLI: logs its argv, answers explain/history/release with JSON, exits 1 on a real refused release. */
function fakeCli(dir: string, releaseOutcome: "released" | "refused"): string {
  const path = join(dir, "fake-cli.mjs");
  writeFileSync(
    path,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      "const a = process.argv.slice(2);",
      'if (a[0] === "explain" && a.includes("--history")) { console.log(JSON.stringify({ governors: [] })); process.exit(0); }',
      'if (a[0] === "explain") { console.log(JSON.stringify({ explanation: "parked" })); process.exit(0); }',
      'if (a[0] === "release" && a.includes("--dry-run")) { console.log(JSON.stringify({ outcome: "released", dryRun: true })); process.exit(0); }',
      `if (a[0] === "release") { console.log(JSON.stringify({ outcome: ${JSON.stringify(releaseOutcome)} })); process.exit(${releaseOutcome === "refused" ? 1 : 0}); }`,
      "process.exit(9);",
    ].join("\n"),
  );
  return path;
}

function homeWith(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "unstick-script-"));
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(join(home, ".config", "catalyst-cloud", "customer.json"), JSON.stringify(config));
  return home;
}

function run(home: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, CATALYST_SKILLS_HOME: home },
  });
}

const OAUTH = { kind: "oauth", accessToken: "a", refreshToken: "r", expiresAt: "2099-01-01T00:00:00Z", sessionId: "s" };

describe("unstick.mjs", () => {
  test("a keyless login (auth block, no key) is connected: explain, history, then a dry run, and the release only with --because", () => {
    const home = homeWith({ baseUrl: "https://x", account: "tenant-3", auth: OAUTH });
    const cli = fakeCli(home, "released");
    const cfgPath = join(home, ".config", "catalyst-cloud", "customer.json");
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), cliPath: cli }));

    const preview = run(home, ["ENG-2"]);
    expect(preview.stderr).not.toMatch(/not connected/);
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ explain: { explanation: "parked" }, preview: { dryRun: true } });

    const released = run(home, ["ENG-2", "--because", "secret rotated"]);
    expect(released.status).toBe(0);
    const calls = readFileSync(join(home, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(calls.map((c) => c.join(" "))).toEqual([
      "explain ENG-2 --json",
      "explain ENG-2 --history --json",
      "release ENG-2 --dry-run --json",
      "explain ENG-2 --json",
      "explain ENG-2 --history --json",
      "release ENG-2 --dry-run --json",
      "release ENG-2 --because secret rotated --json",
    ]);
  });

  test("a refused release exits 1 with the refusal in the document; a config with neither key nor login is not connected", () => {
    const home = homeWith({ baseUrl: "https://x", account: "tenant-3", key: "ctc_user_x" });
    const cli = fakeCli(home, "refused");
    const cfgPath = join(home, ".config", "catalyst-cloud", "customer.json");
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), cliPath: cli }));
    const refused = run(home, ["ENG-2", "--because", "x"]);
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ release: { outcome: "refused" } });

    const bare = homeWith({ baseUrl: "https://x", account: "tenant-3" });
    const none = run(bare, ["ENG-2"]);
    expect(none.status).toBe(2);
    expect(none.stderr).toMatch(/not connected/);
  });
});
