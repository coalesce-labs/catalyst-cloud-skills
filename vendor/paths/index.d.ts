/** Pure POSIX path contract. No process globals or filesystem imports. */
export declare const PATH_ROLES: {
    readonly repoRoot: {
        readonly variable: "CATALYST_REPO_ROOT";
        readonly mode: "0755";
    };
    readonly worktrees: {
        readonly variable: "CATALYST_WORKTREES_DIR";
        readonly mode: "0755";
    };
    readonly logs: {
        readonly variable: "CATALYST_LOGS_DIR";
        readonly mode: "0755";
    };
    readonly events: {
        readonly variable: "CATALYST_EVENTS_DIR";
        readonly mode: "0755";
    };
    readonly config: {
        readonly variable: "CATALYST_CONFIG_DIR";
        readonly mode: "0700";
    };
    readonly cache: {
        readonly variable: "CATALYST_CACHE_DIR";
        readonly mode: "0755";
    };
    readonly state: {
        readonly variable: "CATALYST_STATE_DIR";
        readonly mode: "0755";
    };
    readonly skills: {
        readonly variable: "CATALYST_SKILLS_DIR";
        readonly mode: "0755";
    };
    readonly thoughtsRepo: {
        readonly variable: "CATALYST_THOUGHTS_REPO";
        readonly mode: "0755";
    };
    readonly replicaDb: {
        readonly variable: "CATALYST_REPLICA_DB";
        readonly mode: "0600";
    };
    readonly artifacts: {
        readonly variable: "CATALYST_ARTIFACT_DIR";
        readonly mode: "0700";
    };
};
export type PathRole = keyof typeof PATH_ROLES;
export type MachineRole = Exclude<PathRole, "artifacts">;
export type Environment = Readonly<Record<string, string | undefined>>;
export type PathOverrides = Readonly<Partial<Record<PathRole, string>>>;
/** Mandatory v1 fields for setup/installer composers; optional roles have no setup default. */
export declare const REQUIRED_MACHINE_PATH_ROLES: readonly ["repoRoot", "worktrees", "logs", "events", "config", "cache", "state", "skills"];
export type MachinePathValues = Record<(typeof REQUIRED_MACHINE_PATH_ROLES)[number], string> & {
    replicaDb?: string;
    thoughtsRepo?: string;
};
export type PathProvenance = "explicit" | "environment" | "imported" | "default";
export interface MachinePaths {
    readonly version: 1;
    readonly paths: MachinePathValues;
    readonly provenance: Partial<Record<MachineRole, PathProvenance>>;
}
export type Profile = "workstation" | "container";
export interface ResolveOptions {
    readonly profile?: Profile;
    readonly overrides?: PathOverrides;
    readonly env?: Environment;
    /** Explicitly selected record; the Node adapter owns implicit discovery. */
    readonly machine?: MachinePaths;
}
export declare function absolutePath(value: unknown, name: string): string;
/** Reject extra fields, including credentials and per-run artifacts. */
export declare function parseMachinePaths(value: unknown): MachinePaths;
export declare function resolveCatalystPath(role: string, options?: ResolveOptions): string;
export interface ProposalOptions {
    readonly env: Environment;
    readonly overrides?: PathOverrides;
    readonly existing?: MachinePaths;
    /** Existing locations, never relocated contents. */
    readonly discovered?: Partial<Record<MachineRole, string>>;
}
/** Setup only. Runtime never calls this and this function never writes. */
export declare function proposeMachinePaths(options: ProposalOptions): MachinePaths;
export { CATALYST_DIRECTORY_ROLES as LEGACY_DIRECTORY_ROLES, CREATABLE_DIRECTORY_ROLES as LEGACY_CREATABLE_DIRECTORY_ROLES, LEGACY_BASE_SHELL, resolveWorkstationDir, type CatalystDirectoryRole, type DirectoryBase, } from "./legacy-installer.js";
