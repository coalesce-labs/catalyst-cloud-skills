// contract.test.ts — the contract cache: first fetch writes the ETag, the second sends If-None-Match
// and a 304 refreshes only fetchedAt, a stale cache plus a dead server refuses, a major outside the
// range refuses naming both versions, --path prints a sub-document, and a workstation key gets the
// account-key line.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { contractPathFor } from "../src/config";
import { contractVersionInRange, loadContract, routePath, stageIdForSlot, teamByKey, labelId, teamForTicket } from "../src/contract";
import { CliError, main } from "../src/cli";
import { FIXTURE_ETAG, FIXTURE_USER_KEY, startMeFixture, type FixtureServer } from "./fixture";
import { joinedConfig, makeCtx, seedJoined, tempHome, type TestCtx } from "./helpers";

let server: FixtureServer;
let home: string;
let ctx: TestCtx;

beforeAll(async () => {
  server = await startMeFixture();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  home = tempHome();
  ctx = makeCtx(home);
  server.contractVersion = "1.0.0";
  server.requests.length = 0;
});

describe("loadContract", () => {
  test("first call writes the cache with the etag; second call revalidates with If-None-Match and a 304 refreshes fetchedAt only", async () => {
    const cfg = await seedJoined(home, server, { contract: false });
    const first = await loadContract(ctx, cfg);
    expect(first.source).toBe("network");
    const cache1 = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as { etag: string; fetchedAt: string; doc: { contractVersion: string } };
    expect(cache1.etag).toBe(FIXTURE_ETAG);
    expect(cache1.doc.contractVersion).toBe("1.0.0");

    const later = makeCtx(home, { now: () => new Date(Date.parse(cache1.fetchedAt) + 1000 * 1000) });
    const second = await loadContract(later, cfg);
    expect(second.source).toBe("revalidated");
    const sent = server.requests.filter((r) => r.path === "/api/v1/agent/contract");
    expect(sent.at(-1)?.headers["if-none-match"]).toBe(FIXTURE_ETAG);
    const cache2 = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as { etag: string; fetchedAt: string };
    expect(cache2.etag).toBe(FIXTURE_ETAG);
    expect(cache2.fetchedAt).not.toBe(cache1.fetchedAt);
  });

  test("a cache younger than maxAgeSeconds is used without any request", async () => {
    const cfg = await seedJoined(home, server);
    server.requests.length = 0;
    const loaded = await loadContract(ctx, cfg);
    expect(loaded.source).toBe("cache");
    expect(server.requests.filter((r) => r.path === "/api/v1/agent/contract")).toHaveLength(0);
  });

  test("a cache older than staleRefusalSeconds plus a dead server exits 2 with one line naming the age", async () => {
    const cfg = await seedJoined(home, server);
    const dead = await startMeFixture();
    const deadUrl = dead.url;
    await dead.close();
    writeFileSync(contractPathFor(home), JSON.stringify({ ...JSON.parse(readFileSync(contractPathFor(home), "utf8")), fetchedAt: "2020-01-01T00:00:00Z" }));
    writeFileSync(`${home}/.config/catalyst-cloud/customer.json`, JSON.stringify({ ...cfg, baseUrl: deadUrl }));
    expect(await main(["contract"], ctx)).toBe(2);
    const lines = ctx.err.filter((l) => l.startsWith("catalyst-skills:"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/old \(refusal after 3600s\)/);
    expect(lines[0]).toContain("could not reach");
  });

  test("a cache past maxAge but inside the refusal window survives a dead server as a cache read", async () => {
    const cfg = await seedJoined(home, server);
    const dead = await startMeFixture();
    const deadUrl = dead.url;
    await dead.close();
    const cache = JSON.parse(readFileSync(contractPathFor(home), "utf8")) as { fetchedAt: string };
    const later = makeCtx(home, { now: () => new Date(Date.parse(cache.fetchedAt) + 1000 * 1000) });
    const loaded = await loadContract(later, { ...cfg, baseUrl: deadUrl });
    expect(loaded.source).toBe("cache");
    expect(loaded.ageSeconds).toBe(1000);
  });

  test("contractVersion 2.0.0 against range 1.x exits 2 naming both", async () => {
    await seedJoined(home, server, { contract: false });
    server.contractVersion = "2.0.0";
    const code = await main(["contract"], ctx);
    expect(code).toBe(2);
    expect(ctx.err.join("\n")).toMatch(/2\.0\.0.*1\.x/);
  });

  test("--path teams.0.stages prints the sub-document; an absent path is exit 2", async () => {
    await seedJoined(home, server);
    expect(await main(["contract", "--path", "teams.0.stages", "--json"], ctx)).toBe(0);
    const stages = JSON.parse(ctx.out.join("\n")) as Record<string, { stateId: string }>;
    expect(stages.pr?.stateId).toBe("state-pr-x7");
    expect(ctx.err.join("\n")).toMatch(/^contract: 1\.0\.0 from cache/);
    const c2 = makeCtx(home);
    expect(await main(["contract", "--path", "nope.nothing"], c2)).toBe(2);
  });

  test("⭐ a personal key reads and caches the contract (CTC-2076)", async () => {
    await seedJoined(home, server, { contract: false, config: { key: FIXTURE_USER_KEY } });
    const code = await main(["contract"], ctx);
    expect(code).toBe(0);
    expect(existsSync(contractPathFor(home))).toBe(true);
    expect(ctx.err.join("\n")).not.toMatch(/account key/);
  });

  test("a 403 from an OLDER cloud on the contract is one named line (update the cloud), never a crash", async () => {
    await seedJoined(home, server, { contract: false, config: { key: FIXTURE_USER_KEY } });
    server.contractRefusesPersonalKey = true;
    try {
      const code = await main(["contract"], ctx);
      expect(code).toBe(2);
      expect(ctx.err.join("\n")).toMatch(/older than the bundle/);
      expect(existsSync(contractPathFor(home))).toBe(false);
    } finally {
      server.contractRefusesPersonalKey = false;
    }
  });

  test("join records cliPath and caches the contract", async () => {
    const code = await main(["join", "--key", "fixture-key", "--base-url", server.url], ctx);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(`${home}/.config/catalyst-cloud/customer.json`, "utf8")) as { cliPath: string; replicaDb: string };
    expect(cfg.cliPath.endsWith("bin/catalyst-skills.js")).toBe(true);
    expect(cfg.replicaDb).toBe(`${home}/.config/catalyst-cloud/replica.db`);
    expect(existsSync(contractPathFor(home))).toBe(true);
    expect(ctx.out.join("\n")).toContain("Tenant contract 1.0.0 cached at");
  });
});

describe("helpers", () => {
  test("version ranges", () => {
    expect(contractVersionInRange("1.4.2", "1.x")).toBe(true);
    expect(contractVersionInRange("2.0.0", "1.x")).toBe(false);
    expect(contractVersionInRange("1.0.0", "1.0.0")).toBe(true);
    expect(contractVersionInRange("1.0.0", "unpinned")).toBe(true);
    expect(contractVersionInRange("1.0.0", "banana")).toBeNull();
  });
  test("teamByKey, stageIdForSlot, labelId, routePath refuse rather than guess", () => {
    const doc = server.contract;
    const eng = teamByKey(doc, "eng");
    expect(eng.id).toBe("team-eng");
    expect(() => teamByKey(doc, "NOPE")).toThrow(CliError);
    expect(stageIdForSlot(eng, "pr")).toBe("state-pr-x7");
    expect(() => stageIdForSlot(eng, "review")).toThrow(/no longer exists/);
    expect(() => stageIdForSlot(teamByKey(doc, "OPS"), "pr")).toThrow(/not mapped/);
    expect(labelId(eng, "catalyst-ask")).toBe("label-ask-unscoped");
    expect(labelId(eng, "some-raw-id")).toBe("some-raw-id");
    expect(() => labelId(eng, "catalyst-not-an-ask")).toThrow(/absent/);
    expect(routePath(doc, "issue-comment")).toBe("/api/v1/agent-fixture/issue-comment");
    expect(() => routePath(doc, "delegate-all")).toThrow(/serves no/);
    expect(teamForTicket(doc, "ENG-4").key).toBe("ENG");
    expect(() => teamForTicket(doc, "nodash")).toThrow(CliError);
    expect(joinedConfig(server).account).toBe("tenant-3");
  });
});

describe("more contract branches", () => {
  test("offline reads use the cache or refuse; an unparseable range refuses; a corrupt cache reads as absent", async () => {
    const cfg = await seedJoined(home, server);
    const { readContractCache, assertContractRange, pickPath, teamById } = await import("../src/contract");
    expect((await loadContract(ctx, cfg, { offline: true })).source).toBe("cache");
    writeFileSync(contractPathFor(home), "{corrupt");
    expect(readContractCache(home)).toBeNull();
    await expect(loadContract(ctx, cfg, { offline: true })).rejects.toThrow(/no cached contract/);
    writeFileSync(contractPathFor(home), JSON.stringify({ fetchedAt: "x" }));
    expect(readContractCache(home)).toBeNull();
    expect(() => assertContractRange("1.0.0", "banana")).toThrow(/not a range/);
    expect(pickPath({ a: [{ b: 1 }] }, "a.0.b")).toBe(1);
    expect(pickPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(pickPath(null, "a")).toBeUndefined();
    expect(teamById(server.contract, "team-ops")?.key).toBe("OPS");
    expect(teamById(server.contract, "nope")).toBeNull();
  });
  test("a 304 with no cache and an unexpected document shape both refuse", async () => {
    const { createServer } = await import("node:http");
    let body = "{}";
    let status = 200;
    const odd = createServer((req, res) => {
      res.writeHead(status, { "content-type": "application/json", etag: '"e"' });
      res.end(status === 304 ? "" : body);
    });
    await new Promise<void>((r) => odd.listen(0, "127.0.0.1", r));
    const port = (odd.address() as { port: number }).port;
    const cfg = joinedConfig(server, { baseUrl: `http://127.0.0.1:${port}` });
    try {
      await expect(loadContract(ctx, cfg)).rejects.toThrow(/unexpected shape/);
      status = 304;
      await expect(loadContract(ctx, cfg)).rejects.toThrow(/304 with no cache/);
      status = 200;
      body = JSON.stringify({ ...server.contract, contractVersion: "1.2.0" });
      const loaded = await loadContract(ctx, cfg);
      expect(loaded.doc.contractVersion).toBe("1.2.0");
      expect(loaded.source).toBe("network");
    } finally {
      await new Promise<void>((r) => odd.close(() => r()));
    }
  });
});
