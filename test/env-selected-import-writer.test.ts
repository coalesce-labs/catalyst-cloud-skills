import { describe, expect, test, vi } from "vitest";
import { createSelectedImportWriter } from "../src/env/selected-import-writer.js";

const safeUncertain = "selected import outcome uncertain";

function variableReply(name: string, created = true) {
  return {
    status: created ? 201 : 200,
    body: { envVar: { name }, created, unresolvedReferences: [] },
  };
}

describe("selected import writer adapter", () => {
  test("writes selected variables sequentially and confirms matching route replies", async () => {
    const calls: Array<[string, string]> = [];
    const writer = createSelectedImportWriter({
      kind: "variable",
      writeVariable: async (name, value) => {
        calls.push([name, value]);
        return variableReply(name);
      },
    });

    await expect(
      writer("SECOND=two\nFIRST=one\n", ["FIRST", "SECOND"]),
    ).resolves.toEqual({
      written: ["FIRST", "SECOND"],
      failed: [],
    });
    expect(calls).toEqual([
      ["FIRST", "one"],
      ["SECOND", "two"],
    ]);
  });

  test.each([400, 401, 403, 409, 422])(
    "maps variable refusal %i to a value-free failed-name result",
    async (status) => {
      const writer = createSelectedImportWriter({
        kind: "variable",
        writeVariable: async () => ({
          status,
          body: { message: "raw secret provider detail" },
        }),
      });

      const result = await writer("FIRST=a\n", ["FIRST"]);
      expect(result).toEqual({ written: [], failed: ["FIRST"] });
      expect(JSON.stringify(result)).not.toContain(
        "raw secret provider detail",
      );
    },
  );

  test("continues sequential variable writes after a deterministic refusal", async () => {
    const calls: string[] = [];
    const writer = createSelectedImportWriter({
      kind: "variable",
      writeVariable: async (name) => {
        calls.push(name);
        return name === "FIRST"
          ? { status: 409, body: { message: "raw secret provider detail" } }
          : variableReply(name);
      },
    });

    await expect(
      writer("FIRST=a\nSECOND=b\n", ["FIRST", "SECOND"]),
    ).resolves.toEqual({
      written: ["SECOND"],
      failed: ["FIRST"],
    });
    expect(calls).toEqual(["FIRST", "SECOND"]);
  });

  test("snapshots selected variable names before the first awaited write", async () => {
    const selectedNames = ["FIRST", "SECOND"];
    const calls: string[] = [];
    const writer = createSelectedImportWriter({
      kind: "variable",
      writeVariable: async (name) => {
        calls.push(name);
        if (name === "FIRST") selectedNames.splice(1, 1, "ADDED");
        return variableReply(name);
      },
    });

    await expect(writer("FIRST=a\nSECOND=b\n", selectedNames)).resolves.toEqual(
      {
        written: ["FIRST", "SECOND"],
        failed: [],
      },
    );
    expect(calls).toEqual(["FIRST", "SECOND"]);
  });

  test.each([
    ["missing requested assignment", "FIRST=a\n", ["FIRST", "SECOND"]],
    ["duplicate source assignment", "FIRST=a\nexport FIRST=b\n", ["FIRST"]],
    ["extra source assignment", "FIRST=a\nEXTRA=b\n", ["FIRST"]],
    ["duplicate selected name", "FIRST=a\n", ["FIRST", "FIRST"]],
  ])("rejects %s before any variable write", async (_case, text, names) => {
    const writeVariable = vi.fn(async (name: string) => variableReply(name));
    const writer = createSelectedImportWriter({
      kind: "variable",
      writeVariable,
    });

    await expect(writer(text, names)).rejects.toThrow(
      "selected import input is invalid",
    );
    expect(writeVariable).not.toHaveBeenCalled();
  });

  test("turns variable transport and unknown status failures into fixed safe errors", async () => {
    for (const writeVariable of [
      async () => {
        throw new Error("raw provider secret detail");
      },
      async () => ({
        status: 503,
        body: { message: "raw provider secret detail" },
      }),
    ]) {
      const writer = createSelectedImportWriter({
        kind: "variable",
        writeVariable,
      });
      await expect(writer("FIRST=a\n", ["FIRST"])).rejects.toThrow(
        safeUncertain,
      );
      try {
        await writer("FIRST=a\n", ["FIRST"]);
      } catch (error) {
        expect((error as Error).message).not.toContain(
          "raw provider secret detail",
        );
      }
    }
  });

  test("treats malformed variable success replies as uncertain without exposing response text", async () => {
    const writer = createSelectedImportWriter({
      kind: "variable",
      writeVariable: async () => ({
        status: 201,
        body: {
          envVar: { name: "OTHER" },
          created: true,
          unresolvedReferences: [],
          value: "raw-value",
        },
      }),
    });
    await expect(writer("FIRST=a\n", ["FIRST"])).rejects.toThrow(safeUncertain);
  });

  test("posts selected secret text once and maps complete partial outcomes", async () => {
    const selectedText = "FIRST=one\nSECOND=two\nTHIRD=three\n";
    const importSecrets = vi.fn(
      async (text: string, names: readonly string[]) => {
        expect(text).toBe(selectedText);
        expect(names).toEqual(["FIRST", "SECOND", "THIRD"]);
        return {
          status: 200,
          body: {
            created: ["FIRST"],
            rotated: ["SECOND"],
            errors: [
              {
                name: "THIRD",
                reason: "probe_refused",
                message: "raw secret detail",
              },
            ],
          },
        };
      },
    );
    const writer = createSelectedImportWriter({
      kind: "secret",
      importSecrets,
    });

    await expect(
      writer(selectedText, ["FIRST", "SECOND", "THIRD"]),
    ).resolves.toEqual({
      written: ["FIRST", "SECOND"],
      failed: ["THIRD"],
    });
    expect(importSecrets).toHaveBeenCalledTimes(1);
  });

  test("does not send assignments outside the selected secret names", async () => {
    const text = "FIRST=selected-value\n";
    const importSecrets = vi.fn(async () => ({
      status: 200,
      body: { created: ["FIRST"], rotated: [], errors: [] },
    }));
    const writer = createSelectedImportWriter({
      kind: "secret",
      importSecrets,
    });

    await expect(writer(text, ["FIRST"])).resolves.toEqual({
      written: ["FIRST"],
      failed: [],
    });
    expect(importSecrets).toHaveBeenCalledWith(text, ["FIRST"]);
  });

  test("filters comments and opaque lines before sending selected secret text", async () => {
    const importSecrets = vi.fn(async () => ({
      status: 200,
      body: { created: ["FIRST"], rotated: [], errors: [] },
    }));
    const writer = createSelectedImportWriter({
      kind: "secret",
      importSecrets,
    });

    await expect(
      writer(
        "# EXCLUDED=comment-secret\nFIRST=selected\nopaque excluded-secret\n",
        ["FIRST"],
      ),
    ).resolves.toEqual({ written: ["FIRST"], failed: [] });
    expect(importSecrets).toHaveBeenCalledWith("FIRST=selected\n", ["FIRST"]);
    expect(JSON.stringify(importSecrets.mock.calls)).not.toContain("excluded");
  });

  test.each([
    [
      "non-200 status",
      { status: 503, body: { created: ["FIRST"], rotated: [], errors: [] } },
    ],
    [
      "missing outcome",
      { status: 200, body: { created: ["FIRST"], rotated: [], errors: [] } },
    ],
    [
      "unexpected name",
      {
        status: 200,
        body: { created: ["OTHER"], rotated: [], errors: [{ name: "SECOND" }] },
      },
    ],
    [
      "duplicate outcome",
      {
        status: 200,
        body: {
          created: ["FIRST"],
          rotated: ["FIRST"],
          errors: [{ name: "SECOND" }],
        },
      },
    ],
    [
      "conflicting outcome",
      {
        status: 200,
        body: {
          created: ["FIRST"],
          rotated: [],
          errors: [{ name: "FIRST" }, { name: "SECOND" }],
        },
      },
    ],
    [
      "omitted selected name",
      { status: 200, body: { created: ["FIRST"], rotated: [], errors: [] } },
    ],
    [
      "malformed error entry",
      {
        status: 200,
        body: { created: ["FIRST"], rotated: [], errors: ["SECOND"] },
      },
    ],
  ])("marks a secret import uncertain for %s", async (_case, reply) => {
    const writer = createSelectedImportWriter({
      kind: "secret",
      importSecrets: async () => reply,
    });
    await expect(
      writer("FIRST=a\nSECOND=b\n", ["FIRST", "SECOND"]),
    ).rejects.toThrow(safeUncertain);
  });

  test("turns secret transport errors into a fixed safe error", async () => {
    const writer = createSelectedImportWriter({
      kind: "secret",
      importSecrets: async () => {
        throw new Error("raw secret provider detail");
      },
    });
    await expect(writer("FIRST=a\n", ["FIRST"])).rejects.toThrow(safeUncertain);
  });

  test("makes zero port calls for an empty selection", async () => {
    const writeVariable = vi.fn(async () => variableReply("FIRST"));
    const importSecrets = vi.fn(async () => ({
      status: 200,
      body: { created: [], rotated: [], errors: [] },
    }));
    const variableWriter = createSelectedImportWriter({
      kind: "variable",
      writeVariable,
    });
    const secretWriter = createSelectedImportWriter({
      kind: "secret",
      importSecrets,
    });

    await expect(variableWriter("", [])).resolves.toEqual({
      written: [],
      failed: [],
    });
    await expect(secretWriter("", [])).resolves.toEqual({
      written: [],
      failed: [],
    });
    expect(writeVariable).not.toHaveBeenCalled();
    expect(importSecrets).not.toHaveBeenCalled();
  });
});
