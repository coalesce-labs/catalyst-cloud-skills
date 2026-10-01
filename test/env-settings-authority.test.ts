import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeReviewedSettingsImport,
  readLocalSettings,
  reviewSettingsImport,
  type SettingsAuthorityContext,
  type SettingsAuthorityPorts,
} from "../src/env/settings-authority.js";

const settings = `[project]\nlinear_team = "CTC"\n
[[environment.variables]]\nname = "PUBLIC_URL"\n
[[environment.variables]]\nname = "API_TOKEN"\nsecret = true\n`;
const env =
  "PUBLIC_URL=https://example.test\nAPI_TOKEN=fixture-only\nOTHER=excluded\n";
const context: SettingsAuthorityContext = {
  accountId: "account-one",
  personId: "person-one",
  baseUrl: "https://cloud.example.test",
  role: "owner",
  teamId: "team-one",
  teamKey: "CTC",
  repoId: "repo-one",
  repoName: "example/one",
  repoRoot: "/selected/repo",
};
function fixture() {
  const state = { context: { ...context }, text: settings };
  const ports: SettingsAuthorityPorts = {
    readContext: async () => state.context,
    readSettings: async () => state.text,
  };
  const writer = vi.fn(async (_text: string, names: readonly string[]) => ({
    writtenNames: [...names],
    failedNames: [],
  }));
  return { state, ports, writer };
}
const scratch: string[] = [];
afterEach(async () => {
  for (const path of scratch.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("reviewed settings import authority", () => {
  it("writes only the reviewed category and consumes its process-local review", async () => {
    const f = fixture();
    const review = await reviewSettingsImport({
      kind: "variables",
      text: env,
      requestedNames: ["PUBLIC_URL"],
      ports: f.ports,
    });
    expect(review).toEqual({
      state: "ready",
      kind: "variables",
      selectedNames: ["PUBLIC_URL"],
    });
    const result = await executeReviewedSettingsImport({
      review,
      text: env,
      ports: f.ports,
      writer: f.writer,
    });
    expect(result.state).toBe("written");
    expect(f.writer).toHaveBeenCalledOnce();
    expect(f.writer.mock.calls[0]?.[0]).not.toContain("API_TOKEN");
    expect(f.writer.mock.calls[0]?.[0]).not.toContain("OTHER");
    expect(JSON.stringify(result)).not.toContain("fixture-only");
    expect(
      (
        await executeReviewedSettingsImport({
          review,
          text: env,
          ports: f.ports,
          writer: f.writer,
        })
      ).state,
    ).toBe("rejected");
    expect(f.writer).toHaveBeenCalledOnce();
  });

  it("separates secrets and refuses cross-category or invalid whole-file authority", async () => {
    const f = fixture();
    for (const [kind, names] of [
      ["variables", ["API_TOKEN"]],
      ["secrets", ["PUBLIC_URL"]],
    ] as const)
      expect(
        (
          await reviewSettingsImport({
            kind,
            text: env,
            requestedNames: names,
            ports: f.ports,
          })
        ).state,
      ).toBe("rejected");
    f.state.text += "\n[review]\nunknown = true\n";
    expect(
      (
        await reviewSettingsImport({
          kind: "variables",
          text: env,
          requestedNames: ["PUBLIC_URL"],
          ports: f.ports,
        })
      ).state,
    ).toBe("rejected");
    expect(f.writer).not.toHaveBeenCalled();
  });

  it("does not authorize a member to submit values to administrator-only write rails", async () => {
    const f = fixture();
    f.state.context.role = "member";
    for (const kind of ["variables", "secrets"] as const) {
      const review = await reviewSettingsImport({
        kind,
        text: env,
        requestedNames: kind === "secrets" ? ["API_TOKEN"] : ["PUBLIC_URL"],
        ports: f.ports,
      });
      expect(review.state).toBe("rejected");
      expect(
        (
          await executeReviewedSettingsImport({
            review,
            text: env,
            ports: f.ports,
            writer: f.writer,
          })
        ).state,
      ).toBe("rejected");
    }
    expect(f.writer).not.toHaveBeenCalled();
  });

  it("claims a single-use review before concurrent authority reads", async () => {
    const f = fixture();
    const review = await reviewSettingsImport({
      kind: "variables",
      text: env,
      requestedNames: ["PUBLIC_URL"],
      ports: f.ports,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.ports.readSettings = async () => {
      await gate;
      return settings;
    };
    const first = executeReviewedSettingsImport({
      review,
      text: env,
      ports: f.ports,
      writer: f.writer,
    });
    const second = executeReviewedSettingsImport({
      review,
      text: env,
      ports: f.ports,
      writer: f.writer,
    });
    expect((await second).state).toBe("rejected");
    expect(f.writer).not.toHaveBeenCalled();
    release();
    expect((await first).state).toBe("written");
    expect(f.writer).toHaveBeenCalledOnce();
  });

  it("bounds stalled authority ports and rejects a late completion after cancellation", async () => {
    const f = fixture();
    vi.useFakeTimers();
    try {
      f.ports.readContext = () => new Promise(() => {});
      const pending = reviewSettingsImport({
        kind: "variables",
        text: env,
        requestedNames: ["PUBLIC_URL"],
        ports: f.ports,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await pending).state).toBe("rejected");
    } finally {
      vi.useRealTimers();
    }
    let complete!: (text: string) => void;
    f.ports.readContext = async () => f.state.context;
    f.ports.readSettings = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const abort = new AbortController();
    const pending = reviewSettingsImport({
      kind: "variables",
      text: env,
      requestedNames: ["PUBLIC_URL"],
      ports: f.ports,
      signal: abort.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    abort.abort();
    expect((await pending).state).toBe("rejected");
    complete(settings);
    await Promise.resolve();
    expect(f.writer).not.toHaveBeenCalled();
  });

  it.each([
    ["accountId", "account-two"],
    ["personId", "person-two"],
    ["baseUrl", "https://other.example.test"],
    ["role", "member"],
    ["teamId", "team-two"],
    ["teamKey", "OTHER"],
    ["repoId", "repo-two"],
    ["repoName", "example/two"],
    ["repoRoot", "/other/repo"],
  ] as const)(
    "rejects a changed %s before calling the writer",
    async (key, value) => {
      const f = fixture();
      const review = await reviewSettingsImport({
        kind: "variables",
        text: env,
        requestedNames: ["PUBLIC_URL"],
        ports: f.ports,
      });
      Object.assign(f.state.context, { [key]: value });
      expect(
        (
          await executeReviewedSettingsImport({
            review,
            text: env,
            ports: f.ports,
            writer: f.writer,
          })
        ).state,
      ).toBe("rejected");
      expect(f.writer).not.toHaveBeenCalled();
    },
  );

  it("requires new review for identical semantics with changed exact settings bytes", async () => {
    const f = fixture();
    const review = await reviewSettingsImport({
      kind: "variables",
      text: env,
      requestedNames: ["PUBLIC_URL"],
      ports: f.ports,
    });
    f.state.text += "\n# same semantics, new source\n";
    expect(
      (
        await executeReviewedSettingsImport({
          review,
          text: env,
          ports: f.ports,
          writer: f.writer,
        })
      ).state,
    ).toBe("rejected");
    expect(f.writer).not.toHaveBeenCalled();
  });

  it("rejects changed env bytes, reconstructed receipts, cancellation and lost authority", async () => {
    const f = fixture();
    const review = await reviewSettingsImport({
      kind: "secrets",
      text: env,
      requestedNames: ["API_TOKEN"],
      ports: f.ports,
    });
    expect(
      (
        await executeReviewedSettingsImport({
          review: JSON.parse(JSON.stringify(review)),
          text: env,
          ports: f.ports,
          writer: f.writer,
        })
      ).state,
    ).toBe("rejected");
    const abort = new AbortController();
    abort.abort();
    expect(
      (
        await executeReviewedSettingsImport({
          review,
          text: env,
          ports: f.ports,
          writer: f.writer,
          signal: abort.signal,
        })
      ).state,
    ).toBe("rejected");
    expect(
      (
        await executeReviewedSettingsImport({
          review,
          text: env.replace("fixture-only", "changed-fixture"),
          ports: f.ports,
          writer: f.writer,
        })
      ).state,
    ).toBe("rejected");
    expect(f.writer).not.toHaveBeenCalled();
    const lost: SettingsAuthorityPorts = {
      ...f.ports,
      readContext: async () => null,
    };
    expect(
      (
        await reviewSettingsImport({
          kind: "variables",
          text: env,
          requestedNames: [],
          ports: lost,
        })
      ).state,
    ).toBe("rejected");
  });

  it("detects a principal change during the settings read and contains port errors", async () => {
    const f = fixture();
    f.ports.readSettings = async () => {
      f.state.context.personId = "other-person";
      return settings;
    };
    expect(
      (
        await reviewSettingsImport({
          kind: "variables",
          text: env,
          requestedNames: ["PUBLIC_URL"],
          ports: f.ports,
        })
      ).state,
    ).toBe("rejected");
    f.ports.readSettings = async () => {
      throw new Error("private source bytes");
    };
    const result = await reviewSettingsImport({
      kind: "variables",
      text: env,
      requestedNames: ["PUBLIC_URL"],
      ports: f.ports,
    });
    expect(result.state).toBe("rejected");
    expect(JSON.stringify(result)).not.toContain("private source bytes");
  });

  it("reads exact UTF-8 regular files and refuses redirects, invalid encoding and oversized files", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalyst-authority-"));
    scratch.push(root);
    // macOS tmpdir may itself be a symlink; canonicalize the fixture as real callers must.
    const { realpath } = await import("node:fs/promises");
    const canonical = await realpath(root);
    await mkdir(join(canonical, ".catalyst"));
    const path = join(canonical, ".catalyst/catalyst.toml");
    await writeFile(path, settings);
    expect(await readLocalSettings(canonical)).toBe(settings);
    await rm(path);
    await symlink(join(canonical, "other.toml"), path);
    await writeFile(join(canonical, "other.toml"), settings);
    expect(await readLocalSettings(canonical)).toBeNull();
    await rm(path);
    await writeFile(path, Buffer.from([0xff, 0xfe]));
    expect(await readLocalSettings(canonical)).toBeNull();
    await writeFile(path, "#".repeat(1_048_577));
    expect(await readLocalSettings(canonical)).toBeNull();
    await rm(path);
    await mkdir(path);
    expect(await readLocalSettings(canonical)).toBeNull();
  });
});
