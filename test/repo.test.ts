// repo.test.ts — `catalyst repo agents-block` and `catalyst repo agent-setup` against real temp
// checkouts: the block is written once and replaced in place on a rerun; the setup report reads what
// is there; --apply performs only a convertible plan and refuses a hand merge; nothing touches git.
import { describe, expect, test, beforeEach } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { AGENTS_MD_CHECK_SCRIPT, BLOCK_DECISION_SKILL, BLOCK_END, BLOCK_PROCESS_SKILL, BLOCK_START, CATALYST_AGENTS_BLOCK, blockState, inspectRepo, withBlock } from "../src/repo";
import { FORBIDDEN_CONTENT } from "../src/skill-shape";
import { makeCtx, tempHome, type TestCtx } from "./helpers";
import { spawnSync } from "node:child_process";

let repo: string;
let ctx: TestCtx;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "catalyst-repo-"));
  ctx = makeCtx(tempHome());
});
const read = (rel: string) => readFileSync(join(repo, rel), "utf8");

describe("the block", () => {
  test("is marker-delimited, names the skills, and carries no process, name, date or ticket id", () => {
    expect(CATALYST_AGENTS_BLOCK.startsWith(BLOCK_START)).toBe(true);
    expect(CATALYST_AGENTS_BLOCK.endsWith(BLOCK_END)).toBe(true);
    expect(CATALYST_AGENTS_BLOCK).toContain(`\`${BLOCK_PROCESS_SKILL}\``);
    expect(CATALYST_AGENTS_BLOCK).toContain(`\`${BLOCK_DECISION_SKILL}\``);
    expect([BLOCK_PROCESS_SKILL, BLOCK_DECISION_SKILL]).toEqual(["how-catalyst-works", "catalyst-sop"]);
    for (const f of FORBIDDEN_CONTENT) expect(CATALYST_AGENTS_BLOCK, f.name).not.toMatch(f.re);
    expect(CATALYST_AGENTS_BLOCK).not.toMatch(/\b20\d\d\b/);
    expect(CATALYST_AGENTS_BLOCK.split("\n").length).toBeLessThanOrEqual(6);
  });
  test("withBlock is idempotent in every starting state", () => {
    for (const start of [null, "", "# App\n\nBuild with make.\n", `# App\n\n${BLOCK_START}\nold words\n${BLOCK_END}\n\n## After\n`, `${BLOCK_START}\nold\n${BLOCK_END}`]) {
      const once = withBlock(start);
      expect(blockState(once)).toBe("current");
      expect(withBlock(once)).toBe(once);
      expect(once.split(BLOCK_START).length, "one block").toBe(2);
    }
    expect(withBlock("# App\n\nBuild with make.\n")).toBe(`# App\n\nBuild with make.\n\n${CATALYST_AGENTS_BLOCK}\n`);
    expect(withBlock(`# App\n\n${BLOCK_START}\nold words\n${BLOCK_END}\n\n## After\n`)).toBe(`# App\n\n${CATALYST_AGENTS_BLOCK}\n\n## After\n`);
  });
  test("blockState", () => {
    expect(blockState(null)).toBe("absent");
    expect(blockState("# App\n")).toBe("missing");
    expect(blockState(`${BLOCK_START}\nx\n${BLOCK_END}`)).toBe("stale");
    expect(blockState(CATALYST_AGENTS_BLOCK)).toBe("current");
  });
});

describe("repo agents-block", () => {
  test("check reports missing and exits 1 without writing; --write appends once; a rerun changes nothing", async () => {
    writeFileSync(join(repo, "AGENTS.md"), "# App\n\nBuild with make.\n");
    expect(await main(["repo", "agents-block", repo], ctx)).toBe(1);
    expect(ctx.out[0]).toMatch(/^AGENTS\.md: Catalyst block missing — run with --write to append it/);
    expect(read("AGENTS.md")).toBe("# App\n\nBuild with make.\n");
    expect(await main(["repo", "agents-block", repo, "--write"], ctx)).toBe(0);
    expect(ctx.out[1]).toMatch(/appended; commit it on a branch and open a pull request/);
    expect(read("AGENTS.md")).toBe(`# App\n\nBuild with make.\n\n${CATALYST_AGENTS_BLOCK}\n`);
    expect(await main(["repo", "agents-block", repo, "--write", "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out[2]!)).toMatchObject({ block: "current", changed: false, was: "current" });
    expect(read("AGENTS.md").split(BLOCK_START).length).toBe(2);
  });
  test("no AGENTS.md: --write creates one holding only the block; a stale block is replaced in place", async () => {
    expect(await main(["repo", "agents-block", repo, "--write"], ctx)).toBe(0);
    expect(read("AGENTS.md")).toBe(`${CATALYST_AGENTS_BLOCK}\n`);
    writeFileSync(join(repo, "AGENTS.md"), `# Top\n\n${BLOCK_START}\nold\n${BLOCK_END}\n\n## Tail\n`);
    expect(await main(["repo", "agents-block", repo], ctx)).toBe(1);
    expect(ctx.out.at(-1)).toMatch(/block stale/);
    expect(await main(["repo", "agents-block", repo, "--write"], ctx)).toBe(0);
    expect(read("AGENTS.md")).toBe(`# Top\n\n${CATALYST_AGENTS_BLOCK}\n\n## Tail\n`);
  });
  test("a path that is not a directory, or a missing path, is a usage error", async () => {
    expect(await main(["repo", "agents-block", join(repo, "nope")], ctx)).not.toBe(0);
    expect(await main(["repo", "agents-block"], ctx)).not.toBe(0);
    expect(await main(["repo", "agents-block", repo, "--apply"], ctx)).not.toBe(0);
  });
});

describe("repo agent-setup", () => {
  test("a CLAUDE.md-only checkout with a real .claude/skills is convertible, and the report says what is there", async () => {
    writeFileSync(join(repo, "CLAUDE.md"), "# Notes\n\nRun `make test` before a PR.\n");
    mkdirSync(join(repo, ".claude", "skills", "deploy"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\n");
    mkdirSync(join(repo, ".codex"));
    expect(await main(["repo", "agent-setup", repo], ctx)).toBe(1);
    const text = ctx.out.join("\n");
    expect(text).toContain("AGENTS.md: absent");
    expect(text).toContain("CLAUDE.md: 2 lines of its own guidance, no @AGENTS.md import");
    expect(text).toContain(".agents/skills: absent; .claude/skills: real directory");
    expect(text).toContain("also present: .codex");
    expect(text).toContain("verdict: convertible");
    expect(text).toContain("- create AGENTS.md from CLAUDE.md's content and leave CLAUDE.md as the thin importer");
    expect(text).toContain("- move .claude/skills to .agents/skills and leave .claude/skills as a relative symlink to it");
    expect(text).toContain("the Catalyst block is absent: catalyst repo agents-block");
    // nothing was written by a read
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
  });

  test("--apply converts in the working tree: AGENTS.md from CLAUDE.md, thin CLAUDE.md, .agents/skills canonical with a relative symlink; then portable", async () => {
    writeFileSync(join(repo, "CLAUDE.md"), "# Notes\n\nRun `make test` before a PR.\n");
    mkdirSync(join(repo, ".claude", "skills", "deploy"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "deploy", "SKILL.md"), "x\n");
    expect(await main(["repo", "agent-setup", repo, "--apply", "--json"], ctx)).toBe(1); // the block is still missing
    const doc = JSON.parse(ctx.out[0]!) as { applied: string[]; verdict: string; agentsMd: { block: string } };
    expect(doc.applied).toEqual(["created AGENTS.md from CLAUDE.md; CLAUDE.md now imports it", "moved .claude/skills to .agents/skills and left a relative symlink"]);
    expect(doc.verdict).toBe("portable");
    expect(doc.agentsMd.block).toBe("missing");
    expect(read("AGENTS.md")).toBe("# Notes\n\nRun `make test` before a PR.\n");
    expect(read("CLAUDE.md").split("\n").filter((l) => l.trim() === "@AGENTS.md")).toHaveLength(1);
    expect(lstatSync(join(repo, ".claude", "skills")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(repo, ".claude", "skills"))).toBe(join("..", ".agents", "skills"));
    expect(read(".agents/skills/deploy/SKILL.md")).toBe("x\n");
    // the block on top, then everything is green
    expect(await main(["repo", "agents-block", repo, "--write"], ctx)).toBe(0);
    ctx.out.length = 0;
    expect(await main(["repo", "agent-setup", repo], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("verdict: portable");
    expect(ctx.out.join("\n")).toContain("CLAUDE.md: imports AGENTS.md plus 2 lines of Claude-only notes");
  });

  test("an existing AGENTS.md gets CLAUDE.md's guidance appended, and a missing .claude link to an existing .agents dir is added", async () => {
    writeFileSync(join(repo, "AGENTS.md"), "# App\n");
    writeFileSync(join(repo, "CLAUDE.md"), "Claude notes\n");
    mkdirSync(join(repo, ".agents", "rules"), { recursive: true });
    expect(await main(["repo", "agent-setup", repo, "--apply"], ctx)).toBe(1);
    expect(read("AGENTS.md")).toBe("# App\n\nClaude notes\n");
    expect(readlinkSync(join(repo, ".claude", "rules"))).toBe(join("..", ".agents", "rules"));
    expect(inspectRepo(repo).verdict).toBe("portable");
  });

  test("both .claude/skills and .agents/skills real: reported as a hand merge, and --apply refuses without touching anything", async () => {
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
    mkdirSync(join(repo, ".agents", "skills"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), withBlock(null));
    expect(await main(["repo", "agent-setup", repo], ctx)).toBe(1);
    expect(ctx.out.join("\n")).toContain("⛔ .claude/skills and .agents/skills are both real directories: merge them by hand");
    expect(await main(["repo", "agent-setup", repo, "--apply"], ctx)).not.toBe(0);
    expect(ctx.err.join("\n")).toContain("nothing applied");
    expect(lstatSync(join(repo, ".claude", "skills")).isDirectory()).toBe(true);
  });

  test("a symlink to the wrong place is a blocker; an already-portable checkout with the block exits 0", async () => {
    mkdirSync(join(repo, ".agents", "skills"), { recursive: true });
    mkdirSync(join(repo, ".claude"));
    symlinkSync("../elsewhere", join(repo, ".claude", "skills"), "dir");
    writeFileSync(join(repo, "AGENTS.md"), withBlock("# App\n"));
    writeFileSync(join(repo, "CLAUDE.md"), "@AGENTS.md\n");
    expect(inspectRepo(repo).blockers[0]).toContain(".claude/skills is a symlink to ../elsewhere, not to .agents/skills");
    const good = mkdtempSync(join(tmpdir(), "catalyst-repo-good-"));
    mkdirSync(join(good, ".agents", "skills"), { recursive: true });
    mkdirSync(join(good, ".claude"));
    symlinkSync(join("..", ".agents", "skills"), join(good, ".claude", "skills"), "dir");
    writeFileSync(join(good, "AGENTS.md"), withBlock("# App\n"));
    writeFileSync(join(good, "CLAUDE.md"), "# CLAUDE.md\n\n@AGENTS.md\n");
    expect(await main(["repo", "agent-setup", good], ctx)).toBe(0);
  });

  test("--with-check writes the CI check, which passes on a portable checkout and fails on a broken one", async () => {
    mkdirSync(join(repo, ".agents", "skills"), { recursive: true });
    mkdirSync(join(repo, ".claude"));
    symlinkSync(join("..", ".agents", "skills"), join(repo, ".claude", "skills"), "dir");
    writeFileSync(join(repo, "AGENTS.md"), withBlock("# App\n\nSee `scripts/agents-md-check.mjs`.\n"));
    writeFileSync(join(repo, "CLAUDE.md"), "@AGENTS.md\n");
    expect(await main(["repo", "agent-setup", repo, "--with-check"], ctx)).toBe(0);
    expect(read("scripts/agents-md-check.mjs")).toBe(AGENTS_MD_CHECK_SCRIPT);
    const ok = spawnSync(process.execPath, ["scripts/agents-md-check.mjs"], { cwd: repo, encoding: "utf8" });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("portable");
    writeFileSync(join(repo, "CLAUDE.md"), "no import here\n");
    writeFileSync(join(repo, "AGENTS.md"), withBlock("# App\n\nSee `docs/missing/file.md`.\n"));
    const bad = spawnSync(process.execPath, ["scripts/agents-md-check.mjs"], { cwd: repo, encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("CLAUDE.md must import AGENTS.md");
    expect(bad.stderr).toContain("cites docs/missing/file.md");
    // a rerun of --with-check leaves an identical file alone
    ctx.out.length = 0;
    await main(["repo", "agent-setup", repo, "--with-check"], ctx);
    expect(ctx.out.join("\n")).toContain("scripts/agents-md-check.mjs already current");
  });
});
