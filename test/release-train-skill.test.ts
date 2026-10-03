// release-train-skill.test.ts — this repository carries the release-train skill unchanged, and the
// skill's own pieces work: the train-status tests pass, the frontmatter parses as strict YAML, and
// the evals hold the prompts the skill must answer. The skill is authored here and copied, with
// scripts/release-train-skill.mjs, into catalyst-cloud-sdk and catalyst-cloud.
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");
const skill = join(root, ".agents/skills/release-train");
const node = (args: string[], cwd = root) => spawnSync(process.execPath, args, { cwd, encoding: "utf8" });

describe("release-train skill", () => {
  test("every carried file matches .agents/release-train.lock.json", () => {
    const r = node(["scripts/release-train-skill.mjs", "--check"]);
    expect(r.stdout + r.stderr).toContain("0 problem(s)");
    expect(r.status).toBe(0);
  });

  test("control: a hand edit to a carried file fails the check", () => {
    const copy = mkdtempSync(join(tmpdir(), "release-train-lock-"));
    for (const p of [".agents", "scripts"]) cpSync(join(root, p), join(copy, p), { recursive: true });
    appendFileSync(join(copy, ".agents/skills/release-train/SKILL.md"), "\nlocal tweak\n");
    const r = node(["scripts/release-train-skill.mjs", "--check"], copy);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("SKILL.md: differs");
  });

  test("the skill's own tests pass (train-status verdicts, the trigger classifier)", () => {
    // Explicit files: Node 24 reads a directory argument to --test as a module path.
    const dir = join(root, ".agents/skills/release-train");
    const files = ["scripts", "evals"].flatMap((d) => readdirSync(join(dir, d)).filter((f) => f.endsWith(".test.mjs")).map((f) => join(dir, d, f)));
    expect(files.length).toBeGreaterThanOrEqual(2);
    const r = node(["--test", ...files]);
    expect(r.stdout).toMatch(/# fail 0|ℹ fail 0/);
    expect(r.status).toBe(0);
  });

  test("the frontmatter is name and description only, and parses under a strict YAML reader", () => {
    const text = readFileSync(join(skill, "SKILL.md"), "utf8");
    const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
    const fields = Object.fromEntries(block.split("\n").map((l) => /^([a-z-]+):[ \t]+(.*)$/.exec(l)).filter((m) => m !== null).map((m) => [m[1], m[2]]));
    expect(Object.keys(fields).sort()).toEqual(["description", "name"]);
    expect(fields.name).toBe("release-train");
    // A plain scalar holding ": " or " #" parses under a lenient reader and is skipped by `npx skills`.
    expect(fields.description).not.toMatch(/: | #/);
    expect(fields.description.length).toBeLessThanOrEqual(1024);
  });

  test("the trigger evals hold the required prompts and near misses", () => {
    const set = JSON.parse(readFileSync(join(skill, "evals/trigger-eval.json"), "utf8")) as { query: string; should_trigger: boolean }[];
    const yes = set.filter((q) => q.should_trigger).map((q) => q.query.toLowerCase());
    const no = set.filter((q) => !q.should_trigger).map((q) => q.query.toLowerCase());
    for (const p of ["bump the cli to 0.16.0", "publish the sdk", "cut a release of schema", "change install.sh's version", "tag skills-bundle-v"])
      expect(yes.some((q) => q.includes(p)), p).toBe(true);
    for (const p of ["bump a dependency", "update the changelog wording", "release the hold on pr #123"]) expect(no.some((q) => q.includes(p)), p).toBe(true);
  });

  test("the outcome evals include a minor bump to the CLI alone", () => {
    const evals = JSON.parse(readFileSync(join(skill, "evals/evals.json"), "utf8")).evals as { name: string; assertions: string[] }[];
    const cli = evals.find((e) => e.name === "cli-minor-alone");
    expect(cli?.assertions.join(" ")).toMatch(/every train member|stops and asks/);
  });

  test("the outcome evals include a 0.15.x CLI patch that proceeds under the standing exception", () => {
    const evals = JSON.parse(readFileSync(join(skill, "evals/evals.json"), "utf8")).evals as { name: string; check?: { patch_only?: string } }[];
    expect(evals.find((e) => e.name === "cli-patch-0153-proceeds")?.check?.patch_only).toBe("0.15.3");
  });
});
