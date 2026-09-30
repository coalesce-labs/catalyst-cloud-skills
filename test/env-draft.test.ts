import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftEnvironment } from "../src/env/draft.js";
import { main } from "../src/cli.js";
import { makeCtx, tempHome } from "./helpers.js";

function fixture(files: Record<string, string>) {
  const opened: string[] = [];
  const root = "/repo";
  const result = draftEnvironment(root, {
    listFiles: () => Object.keys(files).sort(),
    readFile: (path) => {
      opened.push(path);
      return files[path.replace(`${root}/`, "")];
    },
  });
  return { result, opened };
}

describe("draftEnvironment", () => {
  it("merges standard-file and legacy names deterministically without values", () => {
    const source = {
      ".env.example": "ZEBRA=example-value\n# OPTIONAL=\nSTRIPE_SECRET_KEY=sample-token\n",
      "src/server.ts": "process.env.DATABASE_URL; process.env.API_TOKEN;",
      "catalyst.env.json": JSON.stringify({ environment: [
        { name: "DATABASE_URL", value: "legacy-secret-value" },
        { name: "OLD_PASSWORD", secret: false, value: "legacy-password" },
      ] }),
    };
    const first = fixture(source).result;
    const second = fixture(source).result;

    expect(first).toEqual(second);
    expect(first.state).toBe("valid");
    if (first.state !== "valid") throw new Error("expected a valid draft");
    expect(first.names).toEqual(["API_TOKEN", "DATABASE_URL", "OLD_PASSWORD", "OPTIONAL", "STRIPE_SECRET_KEY", "ZEBRA"]);
    expect(first.secretNames).toEqual(["API_TOKEN", "OLD_PASSWORD", "STRIPE_SECRET_KEY"]);
    expect(first.toml.match(/required = false/g)).toHaveLength(6);
    expect(first.toml).toContain('name = "OLD_PASSWORD"\nsecret = true\nrequired = false');
    expect(first.toml).not.toContain("example-value");
    expect(first.toml).not.toContain("sample-token");
    expect(first.toml).not.toContain("legacy-secret-value");
    expect(first.toml).not.toContain("legacy-password");
    expect(first.sources).toEqual([".env.example", "catalyst.env.json", "src/server.ts"]);
  });

  it("never opens .env, while the .env.example positive control is scanned", () => {
    const { result, opened } = fixture({
      ".env": "LIVE_SECRET=must-not-be-read\n",
      ".env.example": "DOCUMENTED_VALUE=placeholder\n",
    });
    expect(result.state).toBe("valid");
    if (result.state !== "valid") throw new Error("expected a valid draft");
    expect(result.names).toEqual(["DOCUMENTED_VALUE"]);
    expect(opened).toContain("/repo/.env.example");
    expect(opened).not.toContain("/repo/.env");
  });

  it("fails closed on an invalid legacy declaration instead of silently dropping its names", () => {
    const { result } = fixture({ "catalyst.env.json": "{broken" });
    expect(result).toEqual({ state: "invalid", errors: ["legacy declaration is not valid JSON"] });
  });

  it("infers only lockfile installs and named package scripts without executing repository code", () => {
    const { result } = fixture({
      "package.json": JSON.stringify({ name: "sample", scripts: { check: "arbitrary command" } }),
      "bun.lock": "lock contents",
      ".github/workflows/ci.yml": "name: ci\njobs: {}\n",
    });
    expect(result.state).toBe("valid");
    if (result.state !== "valid") throw new Error("expected a valid draft");
    expect(result.setup).toHaveLength(1);
    expect(result.verify).toHaveLength(1);
    expect(result.toml).toContain('["bun", "install", "--frozen-lockfile"]');
    expect(result.toml).toContain('[[environment.verify]]\nname = "check"\nrun = ["bun", "run", "check"]');
    expect(result.toml).not.toContain("arbitrary command");
    expect(result.sources).toContain(".github/workflows/ci.yml");
  });

  it("keeps committed wrangler vars and bindings out of the environment draft", () => {
    const { result } = fixture({
      "wrangler.toml": '[vars]\nCOMMITTED_NAME = "value"\n\n[[kv_namespaces]]\nbinding = "CACHE"\nid = "abc"\n',
    });
    expect(result.state).toBe("valid");
    if (result.state !== "valid") throw new Error("expected a valid draft");
    expect(result.names).toEqual([]);
  });

  it("reviews as a diff by default without writing, then writes only with --write", async () => {
    const root = mkdtempSync(join(tmpdir(), "catalyst-env-draft-"));
    writeFileSync(join(root, ".env.example"), "DATABASE_URL=placeholder\nAPI_TOKEN=example\n");
    const ctx = makeCtx(tempHome());
    expect(await main(["env", "draft", "--root", root, "--diff"], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("+++ b/.catalyst/catalyst.toml (draft)");
    expect(ctx.out.join("\n")).toContain('+name = "DATABASE_URL"');
    expect(ctx.out.join("\n")).not.toContain("placeholder");
    expect(() => readFileSync(join(root, ".catalyst/catalyst.toml"))).toThrow();

    const writeCtx = makeCtx(tempHome());
    expect(await main(["env", "draft", "--root", root, "--write"], writeCtx)).toBe(0);
    const written = readFileSync(join(root, ".catalyst/catalyst.toml"), "utf8");
    expect(written).toContain('name = "API_TOKEN"\nsecret = true\nrequired = false');
    expect(written).not.toContain("example");

    const jsonRoot = mkdtempSync(join(tmpdir(), "catalyst-env-draft-json-"));
    writeFileSync(join(jsonRoot, "package.json"), JSON.stringify({ scripts: { check: "echo ok" } }));
    writeFileSync(join(jsonRoot, ".env.example"), "PUBLIC_URL=https://example.invalid\n");
    const jsonCtx = makeCtx(tempHome());
    expect(await main(["env", "draft", "--root", jsonRoot, "--write", "--json"], jsonCtx)).toBe(0);
    expect(jsonCtx.out).toHaveLength(1);
    expect(JSON.parse(jsonCtx.out[0]!).written).toBe(true);
  });

  it("refuses to overwrite an existing settings file", async () => {
    const root = mkdtempSync(join(tmpdir(), "catalyst-env-draft-existing-"));
    const target = join(root, ".catalyst/catalyst.toml");
    const original = '[project]\nname = "kept"\n';
    await import("node:fs").then(({ mkdirSync }) => mkdirSync(join(root, ".catalyst")));
    writeFileSync(target, original);
    const ctx = makeCtx(tempHome());
    expect(await main(["env", "draft", "--root", root, "--write"], ctx)).toBe(1);
    expect(readFileSync(target, "utf8")).toBe(original);
    expect(ctx.err.join("\n")).toContain("already exists");
  });
});
