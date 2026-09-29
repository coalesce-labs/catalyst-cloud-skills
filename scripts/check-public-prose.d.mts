export interface Rule {
  id: string;
  re: RegExp;
  inFences: boolean;
  identifiersExempt?: boolean;
}
export interface Finding {
  line: number;
  rule: string;
  text: string;
}
export const RULES: Rule[];
export const RETIRED_CLI_ALLOWED: string[];
export function withoutIdentifiers(line: string): string;
export function scanText(text: string): Finding[];
export function publicFiles(root: string): string[];
export function specProblems(root: string): string[];
export function checkTree(root: string): string[];
