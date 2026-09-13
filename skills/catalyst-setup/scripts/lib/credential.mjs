#!/usr/bin/env node
// lib/credential.mjs — is this machine connected? The ONE place a skill script decides it, vendored
// byte-identical into every skill's scripts/lib/ from skill-lib/credential.mjs at the package root
// (`npm run skill-lib:sync`; a test fails on any drift). Skills install one directory at a time, so
// each carries its own copy. This file is a library — run a sibling script with --help for usage.
//
// customer.json carries exactly one credential: a personal key (`key`), or the keyless login's
// session (`auth`, the recommended rail). A script never reads either for its value: it spawns the
// catalyst-skills CLI, which authenticates with whichever is present and refreshes a login's token
// itself. A new credential kind lands here, once.

/** The command that connects this machine, as every not-connected line names it. */
export const CONNECT_COMMAND =
  "npx @catalyst-cloud/catalyst-skills login (or, with a personal key: CATALYST_CLOUD_TOKEN=<your personal key> npx @catalyst-cloud/catalyst-skills login)";

/** True when `cfg` (parsed customer.json) holds a usable credential of either kind. Never throws. */
export function hasCredential(cfg) {
  if (cfg === null || typeof cfg !== "object") return false;
  const key = cfg["key"];
  if (typeof key === "string" && key !== "") return true;
  const login = cfg["auth"];
  return (
    login !== null &&
    typeof login === "object" &&
    login["kind"] === "oauth" &&
    typeof login["refreshToken"] === "string" &&
    login["refreshToken"] !== ""
  );
}
