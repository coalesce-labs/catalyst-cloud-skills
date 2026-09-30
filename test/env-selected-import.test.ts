import { describe, expect, test, vi } from "vitest";
import {
  executeSelectedNameImport,
  planSelectedNameImportFromText,
} from "../src/env/selected-import.js";

describe("Q4 selected-name import interface", () => {
  test("returns a value-free shared selection plan", () => {
    const text = "DATABASE_URL=placeholder-db-value\nPRIVATE_TOKEN=placeholder-token-value\n";
    const plan = planSelectedNameImportFromText({
      text,
      requestedNames: ["PRIVATE_TOKEN", "DATABASE_URL", "DATABASE_URL"],
      allowedNames: ["DATABASE_URL", "PRIVATE_TOKEN"],
    });

    expect(plan).toEqual({
      state: "ready",
      requestedNames: ["DATABASE_URL", "PRIVATE_TOKEN"],
      allowedNames: ["DATABASE_URL", "PRIVATE_TOKEN"],
      selectedNames: ["DATABASE_URL", "PRIVATE_TOKEN"],
      missingNames: [],
      unknownNames: [],
      invalidNames: [],
    });
    expect(JSON.stringify(plan)).not.toContain("placeholder-");
  });

  test("rejects missing and unknown names before any writer call", async () => {
    const text = "DATABASE_URL=placeholder-db-value\nUNDECLARED=placeholder-other-value\n";
    const plan = planSelectedNameImportFromText({
      text,
      requestedNames: ["DATABASE_URL", "NOT_IN_FILE", "UNDECLARED"],
      allowedNames: ["DATABASE_URL", "NOT_IN_FILE"],
    });
    const writer = vi.fn(async () => ({ writtenNames: ["DATABASE_URL"] }));

    const receipt = await executeSelectedNameImport(text, plan, writer);

    expect(plan.state).toBe("rejected");
    expect(receipt.state).toBe("rejected");
    expect(receipt.selectedNames).toEqual(["DATABASE_URL"]);
    expect(receipt.missingNames).toEqual(["NOT_IN_FILE"]);
    expect(receipt.unknownNames).toEqual(["UNDECLARED"]);
    expect(writer).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain("placeholder-");
  });

  test("passes only selected lines to the value-bearing adapter and returns a names-only receipt", async () => {
    const text = "DATABASE_URL=placeholder-db-value\nPRIVATE_TOKEN=placeholder-token-value\nOTHER=placeholder-other-value\n";
    const plan = planSelectedNameImportFromText({
      text,
      requestedNames: ["PRIVATE_TOKEN", "DATABASE_URL"],
      allowedNames: ["DATABASE_URL", "PRIVATE_TOKEN"],
    });
    const writer = vi.fn(async (selectedText: string, selectedNames: readonly string[]) => {
      expect(selectedText).toContain("DATABASE_URL=placeholder-db-value");
      expect(selectedText).toContain("PRIVATE_TOKEN=placeholder-token-value");
      expect(selectedText).not.toContain("OTHER");
      expect(selectedText).not.toContain("placeholder-other-value");
      expect(selectedNames).toEqual(["DATABASE_URL", "PRIVATE_TOKEN"]);
      return { writtenNames: ["DATABASE_URL", "PRIVATE_TOKEN", "NOT_SELECTED"] };
    });

    const receipt = await executeSelectedNameImport(text, plan, writer);

    expect(receipt).toEqual({
      state: "written",
      requestedNames: ["DATABASE_URL", "PRIVATE_TOKEN"],
      selectedNames: ["DATABASE_URL", "PRIVATE_TOKEN"],
      writtenNames: ["DATABASE_URL", "PRIVATE_TOKEN"],
      failedNames: [],
      missingNames: [],
      unknownNames: [],
      invalidNames: [],
      count: { selected: 2, written: 2, failed: 0 },
    });
    expect(JSON.stringify(receipt)).not.toContain("placeholder-");
  });

  test("rechecks that plan input still matches the file before writing", async () => {
    const plan = planSelectedNameImportFromText({
      text: "DATABASE_URL=placeholder-db-value\n",
      requestedNames: ["DATABASE_URL"],
      allowedNames: ["DATABASE_URL"],
    });
    const writer = vi.fn(async () => ({ writtenNames: ["DATABASE_URL"] }));

    const receipt = await executeSelectedNameImport("OTHER=placeholder-other-value\n", plan, writer);

    expect(receipt.state).toBe("rejected");
    expect(receipt.missingNames).toEqual(["DATABASE_URL"]);
    expect(writer).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain("placeholder-");
  });
});
