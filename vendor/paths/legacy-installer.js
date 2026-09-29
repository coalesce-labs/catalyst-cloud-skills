/**
 * The ten roles, in CTC-2548's own order. `artifacts` is last-but-one and is the one role with
 * `base: "none"` — it is minted per run by the caller (`CATALYST_ARTIFACT_DIR`) and this script
 * must never invent a default for it.
 */
export const CATALYST_DIRECTORY_ROLES = [
    {
        role: "repoRoot",
        variable: "CATALYST_REPO_ROOT",
        base: "catalyst-home",
        segments: ["repos"],
        creatable: true,
        mode: "0755",
    },
    {
        role: "worktrees",
        variable: "CATALYST_WORKTREES_DIR",
        base: "catalyst-home",
        segments: ["wt"],
        creatable: true,
        mode: "0755",
    },
    {
        role: "logs",
        variable: "CATALYST_LOGS_DIR",
        base: "xdg-state",
        segments: ["catalyst", "logs"],
        creatable: true,
        mode: "0755",
    },
    {
        role: "events",
        variable: "CATALYST_EVENTS_DIR",
        base: "xdg-state",
        segments: ["catalyst", "events"],
        creatable: true,
        mode: "0755",
    },
    {
        role: "replica",
        variable: "CATALYST_REPLICA_DIR",
        base: "xdg-state",
        segments: ["catalyst", "replica"],
        creatable: true,
        mode: "0700",
    },
    {
        role: "config",
        variable: "CATALYST_CONFIG_DIR",
        base: "xdg-config",
        segments: ["catalyst"],
        creatable: true,
        mode: "0700",
    },
    {
        role: "cache",
        variable: "CATALYST_CACHE_DIR",
        base: "xdg-cache",
        segments: ["catalyst"],
        creatable: true,
        mode: "0755",
    },
    {
        role: "state",
        variable: "CATALYST_STATE_DIR",
        base: "xdg-state",
        segments: ["catalyst"],
        creatable: true,
        mode: "0755",
    },
    {
        role: "artifacts",
        variable: "CATALYST_ARTIFACT_DIR",
        base: "none",
        segments: [],
        creatable: false,
        mode: "0700",
    },
    {
        role: "skills",
        variable: "CATALYST_SKILLS_HOME",
        base: "xdg-data",
        segments: ["catalyst"],
        creatable: true,
        mode: "0755",
    },
];
/** The roles setup actually creates, in table order. Never hand-counted (CTC-2552 was exactly that bug). */
export const CREATABLE_DIRECTORY_ROLES = CATALYST_DIRECTORY_ROLES.filter((r) => r.creatable);
/** The shell (and TypeScript) expression for a base's default, before segments are appended. */
function baseDefault(base, env) {
    switch (base) {
        case "catalyst-home":
            if (env.CATALYST_HOME)
                return env.CATALYST_HOME;
            return env.HOME ? `${env.HOME}/catalyst` : undefined;
        case "xdg-state":
            if (env.XDG_STATE_HOME)
                return env.XDG_STATE_HOME;
            return env.HOME ? `${env.HOME}/.local/state` : undefined;
        case "xdg-config":
            if (env.XDG_CONFIG_HOME)
                return env.XDG_CONFIG_HOME;
            return env.HOME ? `${env.HOME}/.config` : undefined;
        case "xdg-cache":
            if (env.XDG_CACHE_HOME)
                return env.XDG_CACHE_HOME;
            return env.HOME ? `${env.HOME}/.cache` : undefined;
        case "xdg-data":
            if (env.XDG_DATA_HOME)
                return env.XDG_DATA_HOME;
            return env.HOME ? `${env.HOME}/.local/share` : undefined;
        case "none":
            return undefined;
    }
}
/** The shell expression for a base's default (mirrors {@link baseDefault}, rendered instead of resolved). */
export const LEGACY_BASE_SHELL = {
    "catalyst-home": "${CATALYST_HOME:-$HOME/catalyst}",
    "xdg-state": "${XDG_STATE_HOME:-$HOME/.local/state}",
    "xdg-config": "${XDG_CONFIG_HOME:-$HOME/.config}",
    "xdg-cache": "${XDG_CACHE_HOME:-$HOME/.cache}",
    "xdg-data": "${XDG_DATA_HOME:-$HOME/.local/share}",
    none: null,
};
function findRole(role) {
    const found = CATALYST_DIRECTORY_ROLES.find((r) => r.role === role);
    if (!found)
        throw new Error(`catalyst-directories: unknown role "${role}"`);
    return found;
}
/**
 * Resolve one role's directory from `env`, the same precedence a shell caller gets from the
 * rendered block: explicit variable → base default → a NAMED refusal, never a relative guess
 * (the house shape: apps/host-sync/src/cli.ts:801-812).
 */
export function resolveWorkstationDir(role, env) {
    const def = findRole(role);
    const explicit = env[def.variable];
    if (explicit)
        return explicit;
    if (def.base === "none") {
        return {
            refused: `${def.variable} is not set — this directory is minted per run, it has no default`,
        };
    }
    const base = baseDefault(def.base, env);
    if (base === undefined) {
        return {
            refused: `HOME is not set and ${def.variable} is not set — cannot resolve a default for "${role}"`,
        };
    }
    return def.segments.length > 0 ? `${base}/${def.segments.join("/")}` : base;
}
