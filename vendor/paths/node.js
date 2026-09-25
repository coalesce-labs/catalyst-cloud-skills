/** Node-only machine-file adapter. No replica database is opened or moved here. */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { absolutePath, parseMachinePaths, } from "./index.js";
export function machinePathsFile(options) {
    const explicit = options.file ?? options.env.CATALYST_PATHS_FILE;
    if (explicit !== undefined)
        return absolutePath(explicit, "CATALYST_PATHS_FILE");
    if (options.profile === "container")
        return undefined;
    const config = options.env.XDG_CONFIG_HOME ?? `${absolutePath(options.env.HOME, "HOME")}/.config`;
    return join(absolutePath(config, "XDG_CONFIG_HOME"), "catalyst/paths.json");
}
function hasCode(error, code) {
    return error instanceof Error && "code" in error && error.code === code;
}
async function present(path) {
    try {
        await fs.lstat(path);
        return true;
    }
    catch (error) {
        if (hasCode(error, "ENOENT"))
            return false;
        throw error;
    }
}
export async function loadMachinePaths(options) {
    const file = machinePathsFile(options);
    if (file === undefined)
        return undefined;
    try {
        // Only an absent implicit file is unconfigured. Broken links and explicit missing files fail.
        if (options.file === undefined &&
            options.env.CATALYST_PATHS_FILE === undefined &&
            !(await present(file)))
            return undefined;
        return parseMachinePaths(JSON.parse(await fs.readFile(file, "utf8")));
    }
    catch (cause) {
        throw new Error(`paths: cannot read machine file ${file}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
}
/** Atomic replacement. Existing parent permissions are never modified. */
export async function writeMachinePaths(file, record) {
    absolutePath(file, "CATALYST_PATHS_FILE");
    const content = `${JSON.stringify(parseMachinePaths(record), null, 2)}\n`;
    await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
        await handle.close();
        await fs.rename(temporary, file);
    }
    finally {
        await handle.close();
        await fs.rm(temporary, { force: true });
    }
}
/** Discover legacy CLI locations using metadata only; never touch DB/cursor/lock contents. */
export async function discoverLegacyPaths(options) {
    const config = absolutePath(options.env.CATALYST_CONFIG_DIR ??
        join(absolutePath(options.env.CATALYST_SKILLS_HOME ?? options.env.HOME, "HOME or deprecated CATALYST_SKILLS_HOME"), ".config/catalyst-cloud"), "CATALYST_CONFIG_DIR");
    const customerFile = join(config, "customer.json");
    const found = {};
    if (await present(config)) {
        if (!(await fs.stat(config)).isDirectory())
            throw new Error(`paths: legacy config is not a directory: ${config}`);
        found.config = config;
    }
    let configured;
    if (await present(customerFile)) {
        const customer = JSON.parse(await fs.readFile(customerFile, "utf8"));
        if (typeof customer !== "object" || customer === null || Array.isArray(customer))
            throw new Error(`paths: invalid legacy config ${customerFile}`);
        if ("replicaDb" in customer && customer.replicaDb !== undefined)
            configured = absolutePath(customer.replicaDb, "legacy replicaDb");
        found.config = config;
    }
    const explicit = options.replicaDb ?? options.env.CATALYST_REPLICA_DB ?? configured;
    if (explicit !== undefined) {
        found.replicaDb = absolutePath(explicit, "CATALYST_REPLICA_DB");
        return found;
    }
    const fallback = join(config, "replica.db");
    const populated = [];
    for (const candidate of new Set([fallback, ...(options.replicaCandidates ?? [])])) {
        absolutePath(candidate, "replica candidate");
        if (!(await present(candidate)))
            continue;
        const stat = await fs.stat(candidate);
        if (stat.isFile() && stat.size > 0)
            populated.push(candidate);
    }
    if (populated.length > 1)
        throw new Error(`paths: ambiguous populated replicas: ${populated.join(", ")}; set CATALYST_REPLICA_DB explicitly`);
    found.replicaDb = populated[0] ?? fallback;
    return found;
}
