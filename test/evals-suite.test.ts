// evals-suite.test.ts — the deterministic half of the CTC-2012 gate. No model, no credential: it
// binds each `evals/<skill>-routing/` case to the live `description:` field it claims to exercise,
// so a description edit that drops a trigger phrase fails CI by naming the skill and the phrase
// (Tier 2), and it pins every quoted phrase a description makes — not just the one phrase a scored
// case sends — so the roster's promise surface is covered at zero cost (Tier 1a's authoring half).
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { CUSTOMER_SKILLS } from "../src/cli";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const skillsRoot = join(pkgRoot, "skills");
const evalsRoot = join(pkgRoot, "evals");

interface Coverage {
  skill: string;
  invocation: "implicit" | "explicit";
  exercised_phrase: string;
  promised_phrases: string[];
}

/** The frontmatter block a leading `---\n ... \n---` fence wraps, parsed as YAML. */
function frontmatterOf(raw: string): { fields: Record<string, unknown>; bodyStart: number } {
  const closeIndex = raw.indexOf("\n---", 4);
  const bodyStart = closeIndex + "\n---".length;
  return { fields: parseYaml(raw.slice(4, closeIndex)) as Record<string, unknown>, bodyStart };
}

/** The description field exactly as an agent reads it: parsed YAML, folded to one line. */
function descriptionOf(skill: string): string {
  const md = readFileSync(join(skillsRoot, skill, "SKILL.md"), "utf8");
  const fm = frontmatterOf(md).fields as { description: string };
  return fm.description.replace(/\s+/g, " ").trim();
}

/** Every phrase a description quotes, in order — the widened, zero-cost half of the Tier 2 gate. */
const quotedPhrases = (d: string) => [...d.matchAll(/"([^"]{3,80})"/g)].map((m) => m[1]!);

function isMutating(skill: string): boolean {
  const md = readFileSync(join(skillsRoot, skill, "SKILL.md"), "utf8");
  return /^disable-model-invocation:\s*true\s*$/m.test(md);
}

function promptBodyOf(dir: string): string {
  const raw = readFileSync(join(evalsRoot, dir, "prompt.md"), "utf8");
  return raw.slice(frontmatterOf(raw).bodyStart).trim();
}

// Discovered from disk, not from CUSTOMER_SKILLS — a deleted case directory must disappear from
// this list rather than fail to load, so the roster test below is the one place that notices. A
// case directory is anything under evals/ carrying a coverage.json — this excludes evals/results/,
// the gitignored run output `claude plugin eval` writes on every local invocation.
const caseDirs = readdirSync(evalsRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(evalsRoot, e.name, "coverage.json")))
  .map((e) => e.name)
  .sort();

const cases = caseDirs.map((dir) => ({
  dir,
  coverage: JSON.parse(readFileSync(join(evalsRoot, dir, "coverage.json"), "utf8")) as Coverage,
}));

describe("eval case roster", () => {
  test("the case set covers the roster exactly, one case per skill", () => {
    expect(cases.map((c) => c.coverage.skill).sort()).toEqual([...CUSTOMER_SKILLS].sort());
  });
});

describe("each case is bound to the description it claims to exercise", () => {
  for (const { dir, coverage } of cases) {
    const { skill, exercised_phrase, promised_phrases, invocation } = coverage;

    test(`${skill}'s description still promises "${exercised_phrase}"`, () => {
      const description = descriptionOf(skill);
      expect(
        description.includes(exercised_phrase),
        `evals/${dir} sends "${exercised_phrase}" but skills/${skill}/SKILL.md's description no longer contains it: expected false to be true`,
      ).toBe(true);
    });

    test(`records every phrase ${skill}'s description quotes`, () => {
      expect(promised_phrases).toEqual(quotedPhrases(descriptionOf(skill)));
    });

    test(`${dir} case file shape is well-formed`, () => {
      const raw = readFileSync(join(evalsRoot, dir, "prompt.md"), "utf8");
      const fm = frontmatterOf(raw).fields as {
        schema_version: string;
        name: string;
        plugins: string[];
        tags: string[];
      };
      expect(fm.schema_version).toBe("1.0");
      expect(fm.name).toBe(dir);
      expect(fm.plugins).toEqual(["../.."]);
      expect(fm.tags).toContain(invocation);

      const body = promptBodyOf(dir);
      expect(
        body.includes(exercised_phrase),
        `${dir}/prompt.md's body does not contain "${exercised_phrase}" verbatim`,
      ).toBe(true);

      const graderRaw = readFileSync(join(evalsRoot, dir, "graders", `routes-to-${skill}.md`), "utf8");
      const grader = frontmatterOf(graderRaw).fields as {
        type: string;
        tool: string;
        min: number;
        arm: string;
        input_match: string;
      };
      expect(grader.type).toBe("tool_used");
      expect(grader.tool).toBe("Skill");
      expect(grader.min).toBe(1);
      // Load-bearing and non-obvious: a `tool_used` grader on `Skill` with no explicit `arm` is
      // dropped from the without-arm and excluded from the score in both arms — UNLESS every
      // grader in the case is with-only, in which case they are scored normally. Relying on that
      // "unless" branch means the day a second grader lands, the baseline arm silently stops being
      // scored and Tier 1a's "at least one baseline case fails without it" evaporates. `arm: both`
      // opts the grader back in explicitly and survives into the result document verbatim.
      expect(grader.arm).toBe("both");
      expect(grader.input_match).toContain(skill);
    });

    test(`invocation class matches skills/${skill}/SKILL.md`, () => {
      const mutating = isMutating(skill);
      const hasSlashInvocation = promptBodyOf(dir).includes(`/${skill}`);
      if (mutating) {
        expect(invocation, `${skill} carries disable-model-invocation: true but its case is not marked explicit`).toBe("explicit");
        expect(hasSlashInvocation, `${dir}/prompt.md must invoke /${skill} directly — ${skill} cannot be model-invoked`).toBe(true);
      } else {
        expect(invocation, `${skill} allows model invocation but its case is marked explicit`).toBe("implicit");
        expect(hasSlashInvocation, `${dir}/prompt.md must not invoke /${skill} directly — ${skill} is model-invocable and the case should send a natural sentence`).toBe(false);
      }
    });
  }
});
