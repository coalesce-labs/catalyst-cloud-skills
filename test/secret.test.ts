// secret.test.ts — `catalyst-skills secret set|import` (CTC-3549), against the fixture cloud's repo
// secret store. The fixture keeps each stored value only so a test can assert what landed; every
// test also asserts that no value reached stdout or stderr.
//
// ⛔ Every value here is a placeholder ("placeholder-…"). The `op` in the command scenario is a
// shell script this file writes to a temp dir and puts first on PATH, so the test runs a REAL local
// command through the person's shell, the way the verb does, without a 1Password account.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { FIXTURE_USER_KEY, startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  home = tempHome();
  ctx = makeCtx(home);
  server.writes.length = 0;
  server.secrets = { stored: new Map(), repos: ["acme/app"], declared: null, role: "admin", deployed: true };
  await seedJoined(home, server, { config: { key: FIXTURE_USER_KEY } });
});

const printed = () => [...ctx.out, ...ctx.err].join("\n");
const secretWrites = () => server.writes.filter((w) => w.path.startsWith("/me/secrets"));
const placeholder = (i: number) => `placeholder-value-${String(i).padStart(2, "0")}`;

function envFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "catalyst-secret-"));
  const path = join(dir, ".env");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("Scenario: import a .env file from the CLI", () => {
  test("11 of 13 declared names are stored at repo scope, the 2 missing are listed, and no value is printed", async () => {
    const declared = Array.from({ length: 13 }, (_, i) => `SERVICE_${String(i + 1).padStart(2, "0")}_TOKEN`);
    server.secrets.declared = declared;
    const supplied = declared.slice(0, 11);
    const file = envFile(supplied.map((n, i) => `${n}=${placeholder(i)}`));

    const code = await main(["secret", "import", file, "--repo", "acme/app"], ctx);

    expect(code).toBe(0);
    for (const n of supplied) expect(server.secrets.stored.get(`acme/app:${n}`)?.value).toBe(placeholder(supplied.indexOf(n)));
    expect(server.secrets.stored.size).toBe(11);
    expect(ctx.out[0]).toBe(`stored 11 for acme/app: ${supplied.join(", ")}`);
    expect(ctx.out).toContain(`declared but still without a value (2): ${declared.slice(11).join(", ")}`);
    for (let i = 0; i < supplied.length; i++) expect(printed()).not.toContain(placeholder(i));

    const [write] = secretWrites();
    expect(write?.path).toBe("/me/secrets/import");
    expect(write?.headers.authorization).toBe(`Bearer ${FIXTURE_USER_KEY}`);
    expect(write?.body).toMatchObject({ repo: "acme/app", source: "import: .env", rotateExisting: [] });
  });

  test("a name already set is reported, not replaced, until --rotate names it", async () => {
    server.secrets.stored.set("acme/app:A_TOKEN", { value: placeholder(1), version: 1, source: null });
    const file = envFile([`A_TOKEN=${placeholder(2)}`]);

    expect(await main(["secret", "import", file, "--repo", "acme/app"], ctx)).toBe(1);
    expect(ctx.out).toContain("not stored: A_TOKEN (already set for this repository; pass --rotate <NAME> to replace it)");
    expect(server.secrets.stored.get("acme/app:A_TOKEN")?.value).toBe(placeholder(1));

    ctx.out.length = 0;
    expect(await main(["secret", "import", file, "--repo", "acme/app", "--rotate", "A_TOKEN"], ctx)).toBe(0);
    expect(server.secrets.stored.get("acme/app:A_TOKEN")?.value).toBe(placeholder(2));
    expect(ctx.out).toContain("  replaced: A_TOKEN");
    expect(printed()).not.toContain(placeholder(2));
  });

  test("a repo with no approved declaration says so instead of claiming nothing is missing", async () => {
    const file = envFile([`A_TOKEN=${placeholder(1)}`]);
    expect(await main(["secret", "import", file, "--repo", "acme/app"], ctx)).toBe(0);
    expect(ctx.out).toContain("acme/app has no approved environment declaration, so there is no declared list to check against");
  });
});

describe("Scenario: a secret resolves from a host command", () => {
  test("the stored value is the command's output, and the command text is sent as the audit source", async () => {
    const bin = mkdtempSync(join(tmpdir(), "catalyst-op-"));
    const op = join(bin, "op");
    writeFileSync(
      op,
      '#!/bin/sh\nif [ "$1" = read ] && [ "$2" = "op://Prod/db/url" ]; then printf "placeholder-db-url\\n"; else echo "op: unexpected $*" >&2; exit 3; fi\n',
    );
    chmodSync(op, 0o755);
    ctx = makeCtx(home, { env: { CATALYST_SKILLS_OFFLINE: "1", SHELL: "/bin/sh", PATH: `${bin}:${process.env.PATH ?? ""}` } });

    const code = await main(["secret", "set", "DATABASE_URL", "--repo", "acme/app", "--command", "op read op://Prod/db/url"], ctx);

    expect(code).toBe(0);
    expect(server.secrets.stored.get("acme/app:DATABASE_URL")).toEqual({
      value: "placeholder-db-url",
      version: 1,
      source: "command: op read op://Prod/db/url",
    });
    expect(ctx.out[0]).toBe("stored DATABASE_URL for acme/app (version 1, new; from the command)");
    expect(printed()).not.toContain("placeholder-db-url");
    expect(secretWrites()[0]?.body).toMatchObject({ name: "DATABASE_URL", scope: "repo", repo: "acme/app" });
  });

  test("a command that fails stores nothing and prints none of its output", async () => {
    ctx = makeCtx(home, { env: { CATALYST_SKILLS_OFFLINE: "1", SHELL: "/bin/sh", PATH: process.env.PATH ?? "" } });
    const code = await main(["secret", "set", "DATABASE_URL", "--repo", "acme/app", "--command", "printf placeholder-partial; exit 7"], ctx);
    expect(code).toBe(1);
    expect(ctx.err.join("\n")).toContain("the command exited 7; nothing was stored");
    expect(secretWrites()).toHaveLength(0);
    expect(printed()).not.toContain("placeholder-partial");
  });
});

describe("secret set's other value sources", () => {
  test("a piped value is read from stdin with its trailing newline dropped", async () => {
    const code = await main(["secret", "set", "A_TOKEN", "--repo", "acme/app"], ctx, {
      secret: { isTty: () => false, readStdin: async () => `${placeholder(3)}\n` },
    });
    expect(code).toBe(0);
    expect(server.secrets.stored.get("acme/app:A_TOKEN")).toMatchObject({ value: placeholder(3), source: "stdin" });
    expect(printed()).not.toContain(placeholder(3));
  });

  test("on a terminal the value is asked for with a hidden prompt", async () => {
    const asked: string[] = [];
    const code = await main(["secret", "set", "A_TOKEN", "--repo", "acme/app"], ctx, {
      secret: { isTty: () => true, prompt: async (q) => (asked.push(q), placeholder(4)) },
    });
    expect(code).toBe(0);
    expect(asked).toEqual(["Value for A_TOKEN (input hidden): "]);
    expect(server.secrets.stored.get("acme/app:A_TOKEN")).toMatchObject({ value: placeholder(4), source: "prompt" });
  });

  test("an empty value is refused before anything is sent", async () => {
    const code = await main(["secret", "set", "A_TOKEN", "--repo", "acme/app"], ctx, {
      secret: { isTty: () => false, readStdin: async () => "\n" },
    });
    expect(code).toBe(1);
    expect(secretWrites()).toHaveLength(0);
  });
});

describe("refusals are the cloud's, in words a person can act on", () => {
  test("a non-admin seat is refused with the cloud's message", async () => {
    server.secrets.role = "member";
    const code = await main(["secret", "set", "A_TOKEN", "--repo", "acme/app"], ctx, {
      secret: { isTty: () => false, readStdin: async () => placeholder(5) },
    });
    expect(code).toBe(1);
    expect(ctx.out).toEqual(["refused (403): managing the organization's secrets requires an admin or owner role"]);
    expect(printed()).not.toContain(placeholder(5));
  });

  test("an account key is refused: this is a person's verb", async () => {
    await seedJoined(home, server);
    const code = await main(["secret", "import", envFile(["A_TOKEN=x"]), "--repo", "acme/app"], ctx);
    expect(code).toBe(1);
    expect(ctx.out[0]).toContain("use your personal key");
  });

  test("a cloud that predates CLI secret writes answers 401, and the verb says it needs a newer cloud", async () => {
    server.secrets.deployed = false;
    const code = await main(["secret", "import", envFile(["A_TOKEN=x"]), "--repo", "acme/app"], ctx);
    expect(code).toBe(1);
    expect(ctx.out[0]).toContain("this cloud predates secret writes from the CLI");
  });

  test("a repository outside the tenant is named", async () => {
    const code = await main(["secret", "import", envFile(["A_TOKEN=x"]), "--repo", "someone/else"], ctx);
    expect(code).toBe(1);
    expect(ctx.out[0]).toBe("refused (404): someone/else is not a repository of this tenant (register it in the app first)");
  });

  test("usage: --repo is required and must be owner/name; NAME must be env-shaped", async () => {
    expect(await main(["secret", "import", envFile(["A=x"])], ctx)).toBe(1);
    expect(ctx.err[0]).toBe("secret import needs --repo <owner/name>");
    expect(await main(["secret", "set", "A_TOKEN", "--repo", "acme"], ctx)).toBe(1);
    expect(await main(["secret", "set", "lower", "--repo", "acme/app"], ctx)).toBe(1);
    expect(secretWrites()).toHaveLength(0);
  });
});
