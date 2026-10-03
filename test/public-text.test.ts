// CTC-4715: the published skills, the README and the eval cases describe AI accounts as token-billed
// (an API key is billed per token by its provider), and never name an AI subscription, a plan tier,
// a setup token, a subscription login or a plan's usage window. Subscription accounts are offered only to workspaces Ryan enables
// (CTC-4716). The guidance is .agents/rules/public-text.md; this is the check.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..");

/** Public files: what an installed skill, the npm page or the GitHub repository shows a customer. */
const PUBLIC_FILES = ["README.md", "CONTRIBUTING.md", "packages/catalyst-skills/README.md"];
const PUBLIC_DIRS = ["skills", "evals", "evals-walkthrough"];
const TEXT = /\.(md|mdx|yaml|yml|json|mjs|js|sh)$/;
const CODE = /\.(mjs|js|sh)$/;

const RULES: ReadonlyArray<{ id: string; pattern: RegExp; instead: string }> = [
  { id: "ai-subscription", pattern: /\bsubscriptions?\b/i, instead: 'an AI account billed per token; for an event stream, "live watch"' },
  { id: "setup-token", pattern: /\bsetup[- ]?tokens?\b/i, instead: "an API key from the provider" },
  {
    id: "plan-tier",
    pattern: /\b(?:claude\s+(?:pro|max|team)|chatgpt\s+(?:plus|pro|team|business|enterprise)|(?:max|pro|coding)\s+plans?|max\s+(?:5|20)x|plan\s+tiers?)\b/i,
    instead: "say nothing about plans; Settings → AI accounts lists what a workspace can connect",
  },
  {
    id: "usage-window",
    pattern: /\b(?:(?:5|five)[- ]?h(?:ou)?r?\s+(?:and\s+(?:a\s+)?)?(?:(?:7|seven)[- ]day\s+)?(?:windows?|limits?|caps?|resets?)|window\s+usage|(?:7|seven)[- ]day\s+(?:windows?|limits?|caps?)|weekly\s+(?:windows?|limits?|caps?)|usage\s+windows?|rate\s+windows?)\b/i,
    instead: '"usage limits", or "when a provider is limiting an account"',
  },
  { id: "subscription-login", pattern: /auth\.json|\.credentials\.json|sign in with (?:chatgpt|claude)|claude\.ai\s+(?:account|login)|claude_code_oauth_token|\bcodex login\b(?!\s+--with-api-key)/i, instead: "the account's own page says what it takes" },
];

/** Files that must name a word, each with its reason. */
const ALLOWED: Readonly<Record<string, string>> = {
  "evals-walkthrough/catalyst-onboard/cancelled-account/graders/does-not-say-the-wrong-thing.md": "a not_contains grader: it fails a reply that says setup-token",
  "evals-walkthrough/catalyst-onboard/claude-only/graders/does-not-say-the-wrong-thing.md": "a not_contains grader: it fails a reply that says setup-token",
};

function walk(abs: string, out: string[]): void {
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(abs, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (TEXT.test(name)) out.push(relative(ROOT, p));
  }
}

function publicFiles(): string[] {
  const out = [...PUBLIC_FILES];
  for (const d of PUBLIC_DIRS) walk(join(ROOT, d), out);
  return out.sort();
}

/** A code line that is only a comment is not shown to anyone. */
const isComment = (line: string) => /^\s*(\/\/|\/\*|\*|#(?!!))/.test(line);

function findings(): string[] {
  const out: string[] = [];
  for (const file of publicFiles()) {
    if (file in ALLOWED) continue;
    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (CODE.test(file) && isComment(line)) return;
        for (const r of RULES) if (r.pattern.test(line)) out.push(`${file}:${i + 1} [${r.id}] ${line.trim().slice(0, 140)}\n    instead: ${r.instead}`);
      });
  }
  return out;
}

describe("the public-text rules catch what they name", () => {
  const caught: Array<[string, string]> = [
    ["ai-subscription", "Subscriptions have 5-hour and 7-day windows."],
    ["setup-token", "what `claude setup-token` prints"],
    ["plan-tier", '"Claude Pro or Max", "I use Claude Code"'],
    ["plan-tier", "Qwen coding plan"],
    ["usage-window", "provider, declared and observed state, window usage, walls"],
    ["subscription-login", "Paste the file into \"Replacement auth.json contents\""],
    ["subscription-login", 'Run `codex login` and choose "Sign in with ChatGPT".'],
    ["subscription-login", "copy ~/.claude/.credentials.json"],
    ["plan-tier", "a Max 20x account"],
    ["usage-window", "the 5h window resets at noon"],
  ];
  for (const [rule, line] of caught) {
    test(`${rule}: ${line}`, () => {
      expect(RULES.filter((r) => r.pattern.test(line)).map((r) => r.id)).toContain(rule);
    });
  }
  test("every rule has a positive control", () => {
    expect(RULES.map((r) => r.id).filter((id) => !caught.some(([c]) => c === id))).toEqual([]);
  });
  test("today's wording passes", () => {
    for (const line of [
      "Settings → AI accounts lists the providers this workspace can connect and what each one asks for; an API key is billed per token by its provider.",
      "Run `codex login --with-api-key` with your key.",
      "A phase that runs past its 5-hour build timeout is stopped.",
      "`node scripts/watch-scope.mjs --project <id>`: the live watch.",
      "provider, declared and observed state, usage limits, walls, quarantine",
      "The plan phase writes a plan.",
    ]) {
      expect(RULES.filter((r) => r.pattern.test(line)), line).toEqual([]);
    }
  });
  test("a code comment is skipped and a string is not", () => {
    expect(isComment("  // A cancelled subscription is not a credential problem")).toBe(true);
    expect(isComment('  "reactivate one only if its subscription is live again."')).toBe(false);
    expect(isComment("#!/usr/bin/env bash")).toBe(false);
  });
});

describe("the published files", () => {
  test("the scan reads the skills, the README and the eval cases", () => {
    const files = publicFiles();
    expect(files).toContain("README.md");
    expect(files).toContain("skills/catalyst-onboard/references/what-a-phase-needs.md");
    expect(files.some((f) => f.startsWith("evals-walkthrough/"))).toBe(true);
    for (const f of Object.keys(ALLOWED)) expect(files, f).toContain(f);
  });

  test("no published file names a subscription, a plan, a setup token or a usage window", () => {
    const found = findings();
    if (found.length > 0) throw new Error(`Published text must describe token-billed AI accounts only (CTC-4715, .agents/rules/public-text.md):\n${found.join("\n")}`);
    expect(found).toEqual([]);
  });
});
