import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { main } from "../src/cli";
import type { ApiClient } from "../src/transport";
import { FIXTURE_USER_KEY, startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome } from "./helpers";

describe("catalyst var", () => {
  let server: FixtureServer;
  beforeAll(async () => { server = await startMeFixture(); });
  afterAll(async () => { await server.close(); });

  test("set sends a plain value at tenant scope without printing it", async () => {
    const home = tempHome();
    const ctx = makeCtx(home);
    await seedJoined(home, server, { contract: false, config: { key: FIXTURE_USER_KEY } });
    const writes: Array<{ path: string; body: unknown }> = [];
    const client = { postJson: async (path: string, body: unknown) => {
      writes.push({ path, body });
      return { status: 201, body: { created: true } };
    } } as unknown as Pick<ApiClient, "postJson">;
    const code = await main(["var", "set", "PUBLIC_ENDPOINT"], ctx, {
      var: { client, isTty: () => false, readStdin: async () => "placeholder-value-01" },
    });
    expect(code).toBe(0);
    expect(writes).toEqual([{ path: "/me/env-vars", body: { scope: "tenant", name: "PUBLIC_ENDPOINT", value: "placeholder-value-01" } }]);
    expect([...ctx.out, ...ctx.err].join("\n")).not.toContain("placeholder-value-01");
  });

  test("import --names sends only selected assignment lines", async () => {
    const home = tempHome();
    const ctx = makeCtx(home);
    await seedJoined(home, server, { contract: false, config: { key: FIXTURE_USER_KEY } });
    const dir = mkdtempSync(join(tmpdir(), "catalyst-var-"));
    const file = join(dir, ".env.local");
    writeFileSync(file, "PUBLIC_ENDPOINT=https://example.invalid\nPRIVATE_TOKEN=placeholder-value-02\n");
    const writes: Array<{ path: string; body: unknown }> = [];
    const client = { postJson: async (path: string, body: unknown) => {
      writes.push({ path, body });
      return { status: 200, body: { created: ["PUBLIC_ENDPOINT"] } };
    } } as unknown as Pick<ApiClient, "postJson">;
    const code = await main(["var", "import", file, "--names", "PUBLIC_ENDPOINT,ABSENT"], ctx, { var: { client } });
    expect(code).toBe(0);
    expect(writes[0]?.path).toBe("/me/env-vars/import");
    expect(writes[0]?.body).toMatchObject({ scope: "tenant", text: "PUBLIC_ENDPOINT=https://example.invalid\n" });
    expect(JSON.stringify(writes[0]?.body)).not.toContain("placeholder-value-02");
    expect([...ctx.out, ...ctx.err].join("\n")).not.toContain("https://example.invalid");
    expect(ctx.out.join("\n")).toContain("ABSENT");
  });
});
