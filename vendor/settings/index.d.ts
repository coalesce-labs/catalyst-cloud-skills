export type FullSettingsValidation =
  | { ok: false; errors: string[] }
  | { ok: true; errors: []; linearTeam: string; variableNames: string[]; secretNames: string[] };
export declare function validateFullSettings(text: string): FullSettingsValidation;
