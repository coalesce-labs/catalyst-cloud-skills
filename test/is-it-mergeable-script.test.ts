// CTC-4508: exercise the installed script in real Node processes with an owned synthetic HOME.
// The recorded CLI answers cloud and optional local reads independently and logs every invocation.
import { afterEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "catalyst-github",
  "scripts",
  "is-it-mergeable.mjs",
);
const homes: string[] = [];

interface Reply {
  code: number;
  stdout: string;
  stderr?: string;
}

interface Scenario {
  detail: Record<string, unknown>;
  status: Reply;
  sql: Reply;
}

interface Verdict {
  pr: { repo_id: string; number: number };
  legs: { leg: string; state: string; line: string }[];
  verdict: string;
}

const jsonReply = (value: unknown, code = 0): Reply => ({
  code,
  stdout: JSON.stringify(value),
});
const fresh = () =>
  jsonReply({ verdict: "fresh", cursor: 41, head: 41, lag: 0 });

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    detail: {
      node_id: "PR_fixture",
      repo_id: "fixture/repository",
      number: 7,
      head_sha: "0123456789abcdef",
      state: "open",
      draft: false,
      mergeable_state: "clean",
      checks: [{ name: "test", status: "completed", conclusion: "success" }],
    },
    status: fresh(),
    // A red local answer ensures that the default really ignores local evidence.
    sql: jsonReply([{ resolved: 0, n: 2 }]),
    ...overrides,
  };
}

function run(
  input: Scenario,
  options: { local?: boolean; target?: string } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "mergeability-cloud-first-"));
  homes.push(home);
  const cli = join(home, "fake-cli.mjs");
  const callsPath = join(home, "calls.jsonl");
  const fixturePath = join(home, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify(input));
  writeFileSync(
    cli,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      `const fixture = JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, "utf8"));`,
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
      "function reply(value) { process.stdout.write(value.stdout); if (value.stderr) process.stderr.write(value.stderr); process.exit(value.code); }",
      'if (args[0] === "query" && args[1] === "issue") reply({ code: 0, stdout: JSON.stringify({ linked_pulls: [fixture.detail] }), stderr: "source: api (cloud reads by default)\\n" });',
      'if (args[0] === "query" && args[1] === "pull") reply({ code: 0, stdout: JSON.stringify(fixture.detail), stderr: "source: api (pull is api-only)\\n" });',
      'if (args[0] === "contract") reply({ code: 0, stdout: JSON.stringify({ policies: ["checks-and-threads"], defaultPolicy: "checks-and-threads", repositories: [], cloudRemediateRequiredChecks: ["test"] }) });',
      'if (args[0] === "replica" && args[1] === "status") reply(fixture.status);',
      'if (args[0] === "replica" && args[1] === "sql") reply(fixture.sql);',
      'process.stderr.write("unexpected fake CLI invocation"); process.exit(9);',
    ].join("\n"),
  );
  mkdirSync(join(home, ".config", "catalyst-cloud"), { recursive: true });
  writeFileSync(
    join(home, ".config", "catalyst-cloud", "customer.json"),
    JSON.stringify({
      baseUrl: "https://fixture.invalid",
      account: "fixture-account",
      key: "synthetic-test-key",
      cliPath: cli,
    }),
  );
  // Explicit node avoids running the script under a test runner's alternative runtime.
  // No ambient tokens or real customer home are forwarded to either child process.
  const result = spawnSync(
    "node",
    [
      script,
      options.target ?? "PR_fixture",
      "--json",
      ...(options.local ? ["--local-threads"] : []),
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        CATALYST_SKILLS_HOME: home,
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  const calls: string[][] = readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const output: Verdict = JSON.parse(result.stdout);
  return { result, calls, output };
}

function threads(output: Verdict) {
  const leg = output.legs.find((item) => item.leg === "threads");
  expect(leg).toBeDefined();
  return leg!;
}

function inconclusive(runResult: ReturnType<typeof run>) {
  expect(runResult.result.status).toBe(0);
  expect(threads(runResult.output).state).toBe("inconclusive");
  expect(runResult.output.verdict).toContain("NOT PROVEN MERGEABLE");
}

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("mergeability defaults to cloud evidence", () => {
  test.each(["PR_fixture", "FIX-7"])(
    "%s leaves threads inconclusive without calling local status or SQL",
    (target) => {
      const answer = run(scenario(), { target });
      inconclusive(answer);
      expect(answer.calls.some((args) => args[0] === "replica")).toBe(false);
      expect(answer.calls).toContainEqual([
        "query",
        "pull",
        "PR_fixture",
        "--json",
      ]);
      expect(answer.result.stderr).toContain("source: api");
      expect(
        answer.output.legs.find((leg) => leg.leg === "checks")?.state,
      ).toBe("pass");
    },
  );

  test("an actual failed cloud check is red even while optional local reads are unavailable", () => {
    const input = scenario({
      status: { code: 9, stdout: "", stderr: "local unavailable" },
    });
    input.detail.checks = [
      { name: "test", status: "completed", conclusion: "failure" },
    ];
    const answer = run(input);
    expect(answer.result.status).toBe(1);
    expect(answer.output.legs.find((leg) => leg.leg === "checks")?.state).toBe(
      "fail",
    );
    expect(threads(answer.output).state).toBe("inconclusive");
    expect(answer.output.verdict).toContain("NOT MERGEABLE: checks");
    expect(answer.calls.some((args) => args[0] === "replica")).toBe(false);
  });
});

describe("local threads require successful fresh cloud-head evidence", () => {
  test.each([
    {
      name: "unavailable",
      status: { code: 3, stdout: "", stderr: "replica absent" },
    },
    {
      name: "stale",
      status: jsonReply({ verdict: "stale", cursor: 41, head: 41 }, 1),
    },
    { name: "malformed", status: { code: 0, stdout: "not JSON" } },
    { name: "unprobed", status: jsonReply({ verdict: "fresh", cursor: 41 }) },
    {
      name: "behind head",
      status: jsonReply({ verdict: "fresh", cursor: 40, head: 41 }),
    },
    {
      name: "ahead of head",
      status: jsonReply({ verdict: "fresh", cursor: 42, head: 41 }),
    },
    {
      name: "refused despite valid JSON",
      status: { ...fresh(), code: 2, stderr: "cloud probe refused" },
    },
    {
      name: "invalid negative cursor",
      status: jsonReply({ verdict: "fresh", cursor: -1, head: -1 }),
    },
  ])("$name cannot authorize a local SQL read", ({ status }) => {
    const answer = run(scenario({ status }), { local: true });
    inconclusive(answer);
    expect(answer.calls).toContainEqual([
      "replica",
      "status",
      "--probe",
      "--json",
    ]);
    expect(
      answer.calls.some((args) => args[0] === "replica" && args[1] === "sql"),
    ).toBe(false);
  });

  test.each(
    [0, -1, 1.5, null, true, [7], "not-a-number"].map((number) => ({ number })),
  )("invalid PR number $number cannot authorize SQL", ({ number }) => {
    const input = scenario();
    input.detail.number = number;
    const answer = run(input, { local: true });
    inconclusive(answer);
    expect(
      answer.calls.some((args) => args[0] === "replica" && args[1] === "sql"),
    ).toBe(false);
  });

  test("missing repository identity cannot authorize SQL", () => {
    const input = scenario();
    delete input.detail.repo_id;
    const answer = run(input, { local: true });
    inconclusive(answer);
    expect(
      answer.calls.some((args) => args[0] === "replica" && args[1] === "sql"),
    ).toBe(false);
  });

  test.each([
    { name: "object", repoId: { owner: "fixture", name: "repository" } },
    { name: "array", repoId: ["fixture/repository"] },
    { name: "true", repoId: true },
    { name: "false", repoId: false },
    { name: "empty string", repoId: "" },
    { name: "whitespace", repoId: " \t " },
  ])("$name repository identity cannot prove local threads", ({ repoId }) => {
    // Empty successful SQL would otherwise turn a nonexistent coerced identity green.
    const input = scenario({ sql: jsonReply([]) });
    input.detail.repo_id = repoId;
    const answer = run(input, { local: true });
    inconclusive(answer);
    expect(
      answer.calls.some((args) => args[0] === "replica" && args[1] === "sql"),
    ).toBe(false);
  });
});

describe("local SQL evidence never turns a refusal or malformed count green", () => {
  test.each([
    { name: "SQL refusal with empty rows", sql: jsonReply([], 2) },
    { name: "malformed JSON", sql: { code: 0, stdout: "not JSON" } },
    { name: "non-array result", sql: jsonReply({ rows: [] }) },
    { name: "missing count", sql: jsonReply([{ resolved: 0 }]) },
    { name: "null count", sql: jsonReply([{ resolved: 0, n: null }]) },
    { name: "blank count", sql: jsonReply([{ resolved: 0, n: "" }]) },
    { name: "boolean count", sql: jsonReply([{ resolved: 0, n: false }]) },
    { name: "fractional count", sql: jsonReply([{ resolved: 0, n: 0.5 }]) },
    { name: "negative count", sql: jsonReply([{ resolved: 0, n: -1 }]) },
    {
      name: "unsafe count",
      sql: jsonReply([{ resolved: 0, n: Number.MAX_SAFE_INTEGER + 1 }]),
    },
    {
      name: "invalid resolved flag",
      sql: jsonReply([{ resolved: "1", n: 2 }]),
    },
  ])("$name leaves thread evidence inconclusive", ({ sql }) => {
    const answer = run(scenario({ sql }), { local: true });
    inconclusive(answer);
    expect(
      answer.calls.filter((args) => args[0] === "replica" && args[1] === "sql"),
    ).toHaveLength(1);
  });

  test("actual unresolved threads make the verdict red", () => {
    const answer = run(
      scenario({
        sql: jsonReply([
          { resolved: 1, n: 5 },
          { resolved: 0, n: 2 },
        ]),
      }),
      { local: true },
    );
    expect(answer.result.status).toBe(1);
    expect(threads(answer.output)).toMatchObject({
      state: "fail",
      line: "2 unresolved review thread(s)",
    });
    expect(answer.output.verdict).toContain("NOT MERGEABLE: threads");
  });

  test("unknown resolution remains inconclusive", () => {
    const answer = run(
      scenario({
        sql: jsonReply([
          { resolved: null, n: 2 },
          { resolved: 1, n: 5 },
        ]),
      }),
      { local: true },
    );
    inconclusive(answer);
    expect(threads(answer.output).line).toContain(
      "2 thread(s) with no resolved flag",
    );
  });

  test("successful valid resolved rows prove the optional local leg and the SQL scope", () => {
    const answer = run(scenario({ sql: jsonReply([{ resolved: 1, n: 5 }]) }), {
      local: true,
    });
    expect(answer.result.status).toBe(0);
    expect(threads(answer.output).state).toBe("pass");
    expect(threads(answer.output).line).toContain("5 thread(s), all resolved");
    expect(answer.output.verdict).toBe("MERGEABLE as far as this read can see");
    expect(answer.calls).toContainEqual([
      "replica",
      "sql",
      "select resolved, count(*) as n from pr_review_threads where repo_id = 'fixture/repository' and pr_number = 7 group by resolved",
      "--json",
    ]);
  });
});
