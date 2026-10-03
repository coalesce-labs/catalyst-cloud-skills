import { expect } from "vitest";
/** The wire document adds three public facts; every pre-existing journal field stays identical. */
export function expectJsonJournalMatches(
  value: unknown,
  saved: unknown,
  verdict: string,
) {
  if (
    !value ||
    typeof value !== "object" ||
    !("verdict" in value) ||
    !("actions" in value) ||
    !("next" in value)
  )
    throw new Error("JSON journal lacks final facts");
  const { verdict: actual, actions, next, ...journal } = value;
  expect(actual).toBe(verdict);
  expect(Array.isArray(actions)).toBe(true);
  if (Array.isArray(actions)) expect(actions.length).toBeLessThanOrEqual(5);
  expect(typeof next).toBe("string");
  expect(journal).toEqual(saved);
}
