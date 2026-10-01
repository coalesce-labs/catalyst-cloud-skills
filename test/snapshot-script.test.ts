// snapshot-script.test.ts — CTC-2010: a board read is a window on purpose (`--limit` stays 200),
// but a window the cloud cut short must say so rather than reading as the whole team. Modelled on
// unstick-script.test.ts: a real `node` process, a home holding a customer.json, and a stand-in CLI
// at the recorded cliPath that answers each verb with JSON (and, for `query issues`, the two stderr
// lines the real CLI now prints).
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(
  here,
  "..",
  "skills",
  "whats-happening",
  "scripts",
  "snapshot.mjs",
);

function fakeCli(dir: string, replicaUnavailable = false): string {
  const path = join(dir, "fake-cli.mjs");
  writeFileSync(
    path,
    [
      "const a = process.argv.slice(2);",
      `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify(a) + "\\n");`,
      'if (a[0] === "contract") { console.log(JSON.stringify({ contractVersion: "1.0.0", account: {}, slots: [], teams: [] })); process.exit(0); }',
      replicaUnavailable
        ? 'if (a[0] === "replica") { console.error("local replica is unavailable"); process.exit(9); }'
        : 'if (a[0] === "replica" && a[1] === "status") { console.log(JSON.stringify({ verdict: "fresh", cursor: 10, heartbeatAgeMs: 0 })); process.exit(0); }',
      'if (a[0] === "running") { console.log(JSON.stringify({})); process.exit(0); }',
      'if (a[0] === "queue") { console.log(JSON.stringify({})); process.exit(0); }',
      'if (a[0] === "ask" && a[1] === "list") { console.log(JSON.stringify({ asks: [] })); process.exit(0); }',
      'if (a[0] === "query" && a[1] === "issues") { process.stderr.write("source: api (--source api)\\ntruncated at 50 of 120 — re-run with --all to read the whole scope\\n"); console.log(JSON.stringify([])); process.exit(0); }',
      "process.exit(9);",
    ].join("\n"),
  );
  return path;
}

function homeWith(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "snapshot-script-"));
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(
    join(home, ".config", "catalyst-cloud", "customer.json"),
    JSON.stringify(config),
  );
  return home;
}

function run(home: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, CATALYST_SKILLS_HOME: home },
  });
}

describe("snapshot.mjs --board", () => {
  test("cloud status and board succeed without opening an unavailable local replica", () => {
    const home = homeWith({
      baseUrl: "https://x",
      account: "tenant-3",
      key: "ctc_user_x",
    });
    const cli = fakeCli(home, true);
    const cfgPath = join(home, ".config", "catalyst-cloud", "customer.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(cfgPath, "utf8")),
        cliPath: cli,
      }),
    );
    const res = run(home, ["--board"]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.errors).toBeUndefined();
    expect(out.source.replica).toBe("not-selected");
    const calls: string[][] = readFileSync(join(home, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.some((args) => args[0] === "replica")).toBe(false);
    expect(calls.find((args) => args[0] === "query")).toContain("api");
  });
  test("explicit local diagnostics retain an actual replica refusal", () => {
    const home = homeWith({
      baseUrl: "https://x",
      account: "tenant-3",
      key: "ctc_user_x",
    });
    const cli = fakeCli(home, true);
    const cfgPath = join(home, ".config", "catalyst-cloud", "customer.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(cfgPath, "utf8")),
        cliPath: cli,
      }),
    );
    const res = run(home, ["--replica"]);
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout).errors.replica).toBe(
      "local replica is unavailable",
    );
  });
  test("the board snapshot carries the cloud's truncation line instead of swallowing it", () => {
    const home = homeWith({
      baseUrl: "https://x",
      account: "tenant-3",
      key: "ctc_user_x",
    });
    const cli = fakeCli(home);
    const cfgPath = join(home, ".config", "catalyst-cloud", "customer.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(cfgPath, "utf8")),
        cliPath: cli,
      }),
    );

    const res = run(home, ["--board"]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as {
      source: { board?: string; boardTruncated?: string };
    };
    expect(out.source.board).toBe("api (--source api)");
    expect(out.source.boardTruncated).toMatch(/^truncated at \d+ of \d+/);
  });
});
