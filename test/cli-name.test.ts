// cli-name.test.ts — CTC-4272: the CLI names itself `catalyst`. `catalyst-skills` is a deprecated alias
// (CTC-3479; CTC-3484 removes it), so no usage line, --help, hint or error names it. The only places
// the old name may appear are the identifiers that detect or migrate an old install, listed below.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { VERB_USAGE, verbHelp } from "../src/args";
import { usageText } from "../src/cli";

const root = join(import.meta.dirname, "..");
const OLD = /catalyst-skills/;

// Each entry is a substring of the one source line allowed to name the old package or command.
const ALLOWED_SOURCE_LINES = [
  'LEGACY_PACKAGE_NAME = "@catalyst-cloud/catalyst-skills"', // detects the forwarder install
  'packageNameAt(join(scopeDir, "catalyst-skills"))', // detects the flat npx layout
  'endsWith("catalyst-skills.js")', // migrates a pre-rename cliPath
  'PROVENANCE_MARKER = "vendored-from: @catalyst-cloud/catalyst-skills"', // install detection of copied skills
  '"catalyst-cloud", "catalyst-skills", "runtimes"', // the existing runtime cache directory
  "Keep using catalyst-skills on this machine", // when another program owns `catalyst` on PATH, the alias is the answer
];

describe("the CLI names itself catalyst", () => {
  test("the top-level usage names only `catalyst`", () => {
    const text = usageText();
    expect(text).toMatch(/catalyst login/);
    expect(text).not.toMatch(OLD);
  });

  test("every verb's --help names only `catalyst`", () => {
    const verbs = Object.keys(VERB_USAGE);
    expect(verbs.length).toBeGreaterThan(10);
    for (const verb of verbs) {
      const help = verbHelp(verb);
      expect(help, verb).toMatch(/^Usage: catalyst /);
      expect(help, verb).not.toMatch(OLD);
    }
  });

  test("no printed string in src names catalyst-skills outside the allowed identifiers", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"))) {
      readFileSync(join(root, "src", file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.trimStart();
          if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
          if (OLD.test(line) && !ALLOWED_SOURCE_LINES.some((allowed) => line.includes(allowed))) offenders.push(`src/${file}:${i + 1}: ${code}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  test("the README names catalyst-skills once, in its deprecation note (the positive control is the note itself)", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const mentions = readme.split("\n").filter((l) => OLD.test(l));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toContain("deprecated alias");
  });
});
