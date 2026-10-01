import { existsSync } from "node:fs";
import { join } from "node:path";
import { draftEnvironment } from "./draft.js";
import type { ScanDeps } from "./types.js";

const TEAM_KEY_RE = /^[A-Z][A-Z0-9]{0,15}$/;
const DESTINATION = ".catalyst/catalyst.toml";

export type OnboardSettingsDraft =
  | { state: "existing"; destination: typeof DESTINATION }
  | { state: "invalid"; errors: string[] }
  | {
      state: "draft";
      teamKey: string;
      names: string[];
      secretNames: string[];
      setup: string[];
      verify: string[];
      sources: string[];
      toml: string;
    };

export interface OnboardDraftDeps extends Partial<ScanDeps> {
  fileExists?: (path: string) => boolean;
}

/** Compose a value-free first settings draft. This does not validate the full settings schema or write files. */
export function draftOnboardSettings(
  root: string,
  teamKey: string,
  deps: OnboardDraftDeps = {},
): OnboardSettingsDraft {
  if (typeof teamKey !== "string" || !TEAM_KEY_RE.test(teamKey)) {
    return {
      state: "invalid",
      errors: [
        "team key must use uppercase letters and digits and start with a letter",
      ],
    };
  }

  const destinationPath = join(root, DESTINATION);
  if ((deps.fileExists ?? existsSync)(destinationPath)) {
    return { state: "existing", destination: DESTINATION };
  }

  const environment = draftEnvironment(root, deps);
  if (environment.state === "invalid") return environment;

  return {
    state: "draft",
    teamKey,
    names: environment.names,
    secretNames: environment.secretNames,
    setup: environment.setup,
    verify: environment.verify,
    sources: environment.sources,
    toml: `[project]\nlinear_team = ${JSON.stringify(teamKey)}\n\n${environment.toml}`,
  };
}
