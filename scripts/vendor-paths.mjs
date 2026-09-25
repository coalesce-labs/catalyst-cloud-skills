#!/usr/bin/env node
// Temporary until @catalyst-cloud/paths is published. Never edit the generated runtime.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commit = "c391358d06720985126c15b7fa9d9d6ad1878211";
const sourceRepo = process.env.CATALYST_PATHS_SOURCE;
if (!sourceRepo && process.argv.includes("--check")) {
  const target = join(root, "vendor/paths");
  const manifest = JSON.parse(readFileSync(join(target, "provenance.json"), "utf8"));
  if (manifest.commit !== commit) throw new Error("Unexpected paths source commit");
  for (const [file, hash] of Object.entries(manifest.runtimeSha256)) {
    if (createHash("sha256").update(readFileSync(join(target, file))).digest("hex") !== hash) throw new Error(`Generated runtime drift: ${file}`);
  }
  process.exit(0);
}
if (!sourceRepo) throw new Error("Set CATALYST_PATHS_SOURCE to a catalyst-cloud checkout containing the pinned commit");
const temporary = mkdtempSync(join(root, "node_modules/.paths-vendor-"));
const files = ["index.ts", "node.ts", "legacy-installer.ts"];
const provenance = { repository: "coalesce-labs/catalyst-cloud", commit, sourceSha256: {}, runtimeSha256: {} };
try {
  for (const file of files) {
    const source = execFileSync("git", ["-C", sourceRepo, "show", `${commit}:packages/paths/src/${file}`]);
    writeFileSync(join(temporary, file), source);
    provenance.sourceSha256[file] = createHash("sha256").update(source).digest("hex");
  }
  const output = join(temporary, "dist");
  execFileSync(join(root, "node_modules/.bin/tsc"), ["--ignoreConfig", "--target", "ES2022", "--module", "ES2022", "--moduleResolution", "Bundler", "--types", "node", "--skipLibCheck", "--strict", "--declaration", "--outDir", output, ...files.map(file => join(temporary, file))], { cwd: root, stdio: "inherit" });
  for (const file of readdirSync(output)) provenance.runtimeSha256[file] = createHash("sha256").update(readFileSync(join(output, file))).digest("hex");
  writeFileSync(join(output, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  const target = join(root, "vendor/paths");
  mkdirSync(target, { recursive: true });
  for (const file of readdirSync(output)) {
    const bytes = readFileSync(join(output, file));
    if (process.argv.includes("--check")) {
      if (!bytes.equals(readFileSync(join(target, file)))) throw new Error(`Generated paths drift: ${file}`);
    } else writeFileSync(join(target, file), bytes);
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
