import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { validateSettingsToml } from "../src/env/settings-toml";
import { makeCtx, tempHome } from "./helpers";

const valid = `[project]\nlinear_team = "CTC"\n\n[environment]\n[[environment.variables]]\nname = "BUILD_TOKEN"\nsecret = true\nrequired = false\n`;

describe("repo settings TOML check", () => {
  test("validates TOML and reports only environment variable names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catalyst-settings-check-"));
    const file = join(dir, ".catalyst", "catalyst.toml");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".catalyst"), { recursive: true });
    writeFileSync(file, valid);
    const ctx = makeCtx(tempHome());

    expect(await main(["env", "check", file, "--json"], ctx)).toBe(0);
    expect(JSON.parse(ctx.out.join("\n"))).toEqual({
      state: "valid",
      errors: [],
      variableNames: ["BUILD_TOKEN"],
    });
  });

  test("reports no environment section without treating a repository as invalid", () => {
    expect(validateSettingsToml('[project]\nlinear_team = "CTC"\n')).toEqual({
      state: "no-source",
      errors: [],
    });
  });

  test("rejects malformed TOML without echoing source content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catalyst-settings-check-"));
    const file = join(dir, "catalyst.toml");
    writeFileSync(
      file,
      'PRIVATE_TOKEN = "ghp_SUPERSECRETVALUE"\n[environment\n',
    );
    const ctx = makeCtx(tempHome());

    expect(await main(["env", "check", file], ctx)).toBe(1);
    const printed = [...ctx.out, ...ctx.err].join("\n");
    expect(printed).toContain("TOML could not be parsed");
    expect(printed).not.toContain("ghp_SUPERSECRETVALUE");
    expect(readFileSync(file, "utf8")).toContain("ghp_SUPERSECRETVALUE");
  });

  test("reports invalid variable fields by path and never prints an inline value", () => {
    const report = validateSettingsToml(
      `[environment]\n[[environment.variables]]\nname = "BAD-NAME"\nrequired = "yes"\nvalue = "never-print-this"\n`,
    );
    expect(report.state).toBe("invalid");
    expect(report.errors.join(" ")).toContain("environment.variables[0].name");
    expect(report.errors.join(" ")).toContain(
      "environment.variables[0].required",
    );
    expect(report.errors.join(" ")).toContain("environment.variables[0].value");
    expect(report.errors.join(" ")).not.toContain("never-print-this");
  });

  test("refuses the legacy root JSON filename with a conversion hint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catalyst-settings-check-"));
    const file = join(dir, "catalyst.env.json");
    writeFileSync(file, '{"value":"do-not-print"}');
    const ctx = makeCtx(tempHome());

    expect(await main(["env", "check", file], ctx)).toBe(1);
    const printed = [...ctx.out, ...ctx.err].join("\n");
    expect(printed).toContain("legacy declaration");
    expect(printed).toContain(".catalyst/catalyst.toml");
    expect(printed).not.toContain("do-not-print");
  });
});
