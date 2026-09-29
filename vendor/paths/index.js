/** Pure POSIX path contract. No process globals or filesystem imports. */
export const PATH_ROLES = {
    repoRoot: { variable: "CATALYST_REPO_ROOT", mode: "0755" },
    worktrees: { variable: "CATALYST_WORKTREES_DIR", mode: "0755" },
    logs: { variable: "CATALYST_LOGS_DIR", mode: "0755" },
    events: { variable: "CATALYST_EVENTS_DIR", mode: "0755" },
    config: { variable: "CATALYST_CONFIG_DIR", mode: "0700" },
    cache: { variable: "CATALYST_CACHE_DIR", mode: "0755" },
    state: { variable: "CATALYST_STATE_DIR", mode: "0755" },
    skills: { variable: "CATALYST_SKILLS_DIR", mode: "0755" },
    thoughtsRepo: { variable: "CATALYST_THOUGHTS_REPO", mode: "0755" },
    replicaDb: { variable: "CATALYST_REPLICA_DB", mode: "0600" },
    artifacts: { variable: "CATALYST_ARTIFACT_DIR", mode: "0700" },
};
/** Mandatory v1 fields for setup/installer composers; optional roles have no setup default. */
export const REQUIRED_MACHINE_PATH_ROLES = [
    "repoRoot",
    "worktrees",
    "logs",
    "events",
    "config",
    "cache",
    "state",
    "skills",
];
export function absolutePath(value, name) {
    if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) {
        throw new Error(`paths: ${name} must be an absolute POSIX path`);
    }
    return value;
}
function isRole(role) {
    return Object.hasOwn(PATH_ROLES, role);
}
function object(value, name) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`paths: ${name} must be an object`);
    return Object.fromEntries(Object.entries(value));
}
function keys(value, allowed, name) {
    for (const key of Object.keys(value))
        if (!allowed.includes(key))
            throw new Error(`paths: unknown ${name} field ${key}`);
}
/** Reject extra fields, including credentials and per-run artifacts. */
export function parseMachinePaths(value) {
    const record = object(value, "machine record");
    keys(record, ["version", "paths", "provenance"], "machine record");
    if (record.version !== 1)
        throw new Error(`paths: unsupported machine record version ${String(record.version)}`);
    const paths = object(record.paths, "paths");
    const provenance = object(record.provenance, "provenance");
    const roles = Object.keys(PATH_ROLES).filter((role) => role !== "artifacts");
    keys(paths, roles, "paths");
    keys(provenance, roles, "provenance");
    const validated = {
        repoRoot: absolutePath(paths.repoRoot, "repoRoot"),
        worktrees: absolutePath(paths.worktrees, "worktrees"),
        logs: absolutePath(paths.logs, "logs"),
        events: absolutePath(paths.events, "events"),
        config: absolutePath(paths.config, "config"),
        cache: absolutePath(paths.cache, "cache"),
        state: absolutePath(paths.state, "state"),
        skills: absolutePath(paths.skills, "skills"),
    };
    if (Object.hasOwn(paths, "replicaDb"))
        validated.replicaDb = absolutePath(paths.replicaDb, "replicaDb");
    if (Object.hasOwn(paths, "thoughtsRepo"))
        validated.thoughtsRepo = absolutePath(paths.thoughtsRepo, "thoughtsRepo");
    const sources = {};
    for (const [role, source] of Object.entries(provenance)) {
        if (!isRole(role) || role === "artifacts" || !Object.hasOwn(validated, role))
            throw new Error(`paths: provenance has no path for ${role}`);
        if (source !== "explicit" &&
            source !== "environment" &&
            source !== "imported" &&
            source !== "default")
            throw new Error(`paths: invalid provenance for ${role}`);
        sources[role] = source;
    }
    return { version: 1, paths: validated, provenance: sources };
}
export function resolveCatalystPath(role, options = {}) {
    if (!isRole(role))
        throw new Error(`paths: unknown role ${role}`);
    const variable = PATH_ROLES[role].variable;
    const explicit = options.overrides?.[role];
    if (explicit !== undefined)
        return absolutePath(explicit, role);
    const environment = options.env?.[variable];
    if (environment !== undefined)
        return absolutePath(environment, variable);
    if (options.machine && role !== "artifacts") {
        const path = parseMachinePaths(options.machine).paths[role];
        if (path !== undefined)
            return path;
    }
    throw new Error(`paths: ${variable} is not set; declare ${role} explicitly or run paths configure`);
}
/** Setup only. Runtime never calls this and this function never writes. */
export function proposeMachinePaths(options) {
    const existing = options.existing && parseMachinePaths(options.existing);
    const paths = {};
    const provenance = {};
    const env = options.env;
    const home = () => absolutePath(env.HOME, "HOME");
    const base = (variable, fallback) => absolutePath(env[variable] ?? fallback(), variable);
    const defaults = {
        repoRoot: () => `${base("CATALYST_HOME", () => `${home()}/catalyst`)}/repos`,
        worktrees: () => `${base("CATALYST_HOME", () => `${home()}/catalyst`)}/wt`,
        logs: () => `${base("XDG_STATE_HOME", () => `${home()}/.local/state`)}/catalyst/logs`,
        events: () => `${base("XDG_STATE_HOME", () => `${home()}/.local/state`)}/catalyst/events`,
        config: () => `${base("XDG_CONFIG_HOME", () => `${home()}/.config`)}/catalyst`,
        cache: () => `${base("XDG_CACHE_HOME", () => `${home()}/.cache`)}/catalyst`,
        state: () => `${base("XDG_STATE_HOME", () => `${home()}/.local/state`)}/catalyst`,
        skills: () => `${home()}/.agents/skills`,
    };
    for (const role of Object.keys(PATH_ROLES)) {
        if (!isRole(role) || role === "artifacts")
            continue;
        const explicit = options.overrides?.[role];
        const environment = env[PATH_ROLES[role].variable];
        const accepted = existing?.paths[role];
        const imported = options.discovered?.[role];
        const value = explicit ??
            environment ??
            accepted ??
            imported ??
            (role === "replicaDb" || role === "thoughtsRepo" ? undefined : defaults[role]());
        if (value === undefined)
            continue;
        paths[role] = absolutePath(value, role);
        const source = explicit !== undefined
            ? "explicit"
            : environment !== undefined
                ? "environment"
                : accepted !== undefined
                    ? existing?.provenance[role]
                    : imported !== undefined
                        ? "imported"
                        : "default";
        if (source !== undefined)
            provenance[role] = source;
    }
    return parseMachinePaths({ version: 1, paths, provenance });
}
// Transitional installer adapter only. Runtime callers must use resolveCatalystPath.
export { CATALYST_DIRECTORY_ROLES as LEGACY_DIRECTORY_ROLES, CREATABLE_DIRECTORY_ROLES as LEGACY_CREATABLE_DIRECTORY_ROLES, LEGACY_BASE_SHELL, resolveWorkstationDir, } from "./legacy-installer.js";
