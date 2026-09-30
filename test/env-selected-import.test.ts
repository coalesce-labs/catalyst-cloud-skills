import { describe, expect, test, vi } from "vitest";
import {
  executeSelectedNameImport,
  planSelectedNameImportFromText,
} from "../src/env/selected-import.js";

describe("Q4 selected-name import interface", () => {
  test("returns a value-free shared selection plan", () => {
    const text =
      "DATABASE_URL=placeholder-db-value\nPRIVATE_TOKEN=placeholder-token-value\n";
    const plan = planSelectedNameImportFromText({
      text,
      requestedNames: ["PRIVATE_TOKEN", "DATABASE_URL", "DATABASE_URL"],
      allowedNames: ["DATABASE_URL", "PRIVATE_TOKEN"],
    });
    expect(plan.state).toBe("ready");
    expect(plan.requestedNames).toEqual(["DATABASE_URL", "PRIVATE_TOKEN"]);
    expect(plan.selectedNames).toEqual(["DATABASE_URL", "PRIVATE_TOKEN"]);
    expect(JSON.stringify(plan)).not.toContain("placeholder-");
    expect(Object.isFrozen(plan)).toBe(true);
  });

  test("rejects missing and unknown names before any writer call", async () => {
    const text =
      "DATABASE_URL=placeholder-db-value\nUNDECLARED=placeholder-other-value\n";
    const plan = planSelectedNameImportFromText({
      text,
      requestedNames: ["DATABASE_URL", "NOT_IN_FILE", "UNDECLARED"],
      allowedNames: ["DATABASE_URL", "NOT_IN_FILE"],
    });
    const writer = vi.fn(async () => ({ writtenNames: ["DATABASE_URL"] }));
    const receipt = await executeSelectedNameImport(
      text,
      plan,
      ["DATABASE_URL", "NOT_IN_FILE"],
      writer,
    );

    expect(plan.state).toBe("rejected");
    expect(receipt.state).toBe("rejected");
    expect(receipt.selectedNames).toEqual(["DATABASE_URL"]);
    expect(receipt.missingNames).toEqual(["NOT_IN_FILE"]);
    expect(receipt.unknownNames).toEqual(["UNDECLARED"]);
    expect(writer).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain("placeholder-");
  });

  test("rejects duplicate assignments including export variants before writing", async () => {
    const text = "DATABASE_URL=first\nexport DATABASE_URL=second\n";
    const plan = planSelectedNameImportFromText({
      text,
      requestedNames: ["DATABASE_URL"],
      allowedNames: ["DATABASE_URL"],
    });
    const writer = vi.fn(async () => ({ writtenNames: ["DATABASE_URL"] }));
    const receipt = await executeSelectedNameImport(
      text,
      plan,
      ["DATABASE_URL"],
      writer,
    );
    expect(plan.duplicateNames).toEqual(["DATABASE_URL"]);
    expect(receipt.state).toBe("rejected");
    expect(writer).not.toHaveBeenCalled();
  });

  test("passes only selected lines to writer and returns a names-only receipt", async () => {
    const text =
      "DATABASE_URL=placeholder-db-value\nPRIVATE_TOKEN=placeholder-token-value\nOTHER=placeholder-other-value\n";
    const allowed = ["DATABASE_URL", "PRIVATE_TOKEN"];
    const plan = planSelectedNameImportFromText({
      text,
      requestedNames: ["PRIVATE_TOKEN", "DATABASE_URL"],
      allowedNames: allowed,
    });
    const writer = vi.fn(
      async (selectedText: string, selectedNames: readonly string[]) => {
        expect(selectedText).toContain("DATABASE_URL=placeholder-db-value");
        expect(selectedText).toContain("PRIVATE_TOKEN=placeholder-token-value");
        expect(selectedText).not.toContain("OTHER");
        expect(selectedNames).toEqual(["DATABASE_URL", "PRIVATE_TOKEN"]);
        return {
          writtenNames: ["DATABASE_URL", "PRIVATE_TOKEN", "NOT_SELECTED"],
        };
      },
    );
    const receipt = await executeSelectedNameImport(
      text,
      plan,
      allowed,
      writer,
    );
    expect(receipt.writtenNames).toEqual(["DATABASE_URL", "PRIVATE_TOKEN"]);
    expect(receipt.failedNames).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain("placeholder-");
  });

  test("does not permit a forged plan to widen the authoritative allowlist", async () => {
    const text = "SECRET=placeholder-secret-value\n";
    const plan = planSelectedNameImportFromText({
      text,
      requestedNames: ["SECRET"],
      allowedNames: ["SECRET"],
    });
    const writer = vi.fn(async () => ({ writtenNames: ["SECRET"] }));
    const receipt = await executeSelectedNameImport(text, plan, [], writer);
    expect(receipt.state).toBe("rejected");
    expect(receipt.unknownNames).toEqual(["SECRET"]);
    expect(writer).not.toHaveBeenCalled();
  });

  test("rejects a changed source snapshot before writing", async () => {
    const plan = planSelectedNameImportFromText({
      text: "DATABASE_URL=old\n",
      requestedNames: ["DATABASE_URL"],
      allowedNames: ["DATABASE_URL"],
    });
    const writer = vi.fn(async () => ({ writtenNames: ["DATABASE_URL"] }));
    const receipt = await executeSelectedNameImport(
      "DATABASE_URL=new\n",
      plan,
      ["DATABASE_URL"],
      writer,
    );
    expect(receipt.state).toBe("rejected");
    expect(writer).not.toHaveBeenCalled();
  });

  test("returns a names-only failure receipt when writer throws", async () => {
    const text = "DATABASE_URL=value\n";
    const plan = planSelectedNameImportFromText({
      text,
      requestedNames: ["DATABASE_URL"],
      allowedNames: ["DATABASE_URL"],
    });
    const receipt = await executeSelectedNameImport(
      text,
      plan,
      ["DATABASE_URL"],
      async () => {
        throw new Error("provider leaked-secret-value");
      },
    );
    expect(receipt.failedNames).toEqual(["DATABASE_URL"]);
    expect(JSON.stringify(receipt)).not.toContain("leaked-secret-value");
  });

  test("conflicting callback reports fail the conflicting selected name safely", async () => {
    const text = "DATABASE_URL=value\n";
    const plan = planSelectedNameImportFromText({
      text,
      requestedNames: ["DATABASE_URL"],
      allowedNames: ["DATABASE_URL"],
    });
    const receipt = await executeSelectedNameImport(
      text,
      plan,
      ["DATABASE_URL"],
      async () => ({
        writtenNames: ["DATABASE_URL"],
        failedNames: ["DATABASE_URL"],
      }),
    );
    expect(receipt.writtenNames).toEqual([]);
    expect(receipt.failedNames).toEqual(["DATABASE_URL"]);
  });

  test("invalid names are counted without retaining credential-like input", async () => {
    const text = "SAFE=value\n";
    const credential = "ghp_secret-credential-value";
    const plan = planSelectedNameImportFromText({
      text,
      requestedNames: [credential],
      allowedNames: ["SAFE"],
    });
    const receipt = await executeSelectedNameImport(
      text,
      plan,
      ["SAFE"],
      vi.fn(),
    );
    expect(plan.requestedNames).toEqual([]);
    expect(plan.invalidNameCount).toBe(1);
    expect(receipt.invalidNameCount).toBe(1);
    expect(JSON.stringify(plan)).not.toContain(credential);
    expect(JSON.stringify(receipt)).not.toContain(credential);
  });

  test("an empty selection makes zero writes", async () => {
    const text = "SAFE=value\n";
    const plan = planSelectedNameImportFromText({
      text,
      requestedNames: [],
      allowedNames: ["SAFE"],
    });
    const writer = vi.fn();
    const receipt = await executeSelectedNameImport(
      text,
      plan,
      ["SAFE"],
      writer,
    );
    expect(receipt.state).toBe("written");
    expect(receipt.count).toEqual({ selected: 0, written: 0, failed: 0 });
    expect(writer).not.toHaveBeenCalled();
  });

  test("counts every selected name not reported as written as failed", async () => {
    const text = "DATABASE_URL=value\nPRIVATE_TOKEN=value\n";
    const allowed = ["DATABASE_URL", "PRIVATE_TOKEN"];
    const plan = planSelectedNameImportFromText({
      text,
      requestedNames: allowed,
      allowedNames: allowed,
    });
    const receipt = await executeSelectedNameImport(
      text,
      plan,
      allowed,
      async () => ({ writtenNames: ["DATABASE_URL"] }),
    );
    expect(receipt.writtenNames).toEqual(["DATABASE_URL"]);
    expect(receipt.failedNames).toEqual(["PRIVATE_TOKEN"]);
    expect(receipt.count).toEqual({ selected: 2, written: 1, failed: 1 });
  });
});
