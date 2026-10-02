#!/usr/bin/env node
// The self-hosted runner's Compose file, copied byte for byte from catalyst-cloud's deploy/self-host
// at a pinned commit. That repository is private, so a customer's `catalyst onboard` cannot fetch it.
// Never edit vendor/self-host/compose.yaml by hand: move `commit` and regenerate.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commit = "8861fa0c6d9063be62d003c95f71c8a5ccaf4d0d";
const file = "deploy/self-host/compose.yaml";
const target = join(root, "vendor/self-host");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceRepo = process.env.CATALYST_SELF_HOST_SOURCE;
if (!sourceRepo && process.argv.includes("--check")) {
  const manifest = JSON.parse(readFileSync(join(target, "provenance.json"), "utf8"));
  if (manifest.commit !== commit) throw new Error("Unexpected self-host source commit");
  if (sha(readFileSync(join(target, "compose.yaml"))) !== manifest.sha256[file])
    throw new Error("Vendored compose.yaml drifted from its recorded hash");
  process.exit(0);
}
if (!sourceRepo) throw new Error("Set CATALYST_SELF_HOST_SOURCE to a catalyst-cloud checkout containing the pinned commit");
const bytes = execFileSync("git", ["-C", sourceRepo, "show", `${commit}:${file}`]);
const provenance = `${JSON.stringify({ repository: "coalesce-labs/catalyst-cloud", commit, sha256: { [file]: sha(bytes) } }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!bytes.equals(readFileSync(join(target, "compose.yaml")))) throw new Error("Vendored compose.yaml drift");
  if (provenance !== readFileSync(join(target, "provenance.json"), "utf8")) throw new Error("Vendored provenance drift");
} else {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "compose.yaml"), bytes);
  writeFileSync(join(target, "provenance.json"), provenance);
}
