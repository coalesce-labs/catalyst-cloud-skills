/** Where a role's directory lives when no explicit environment variable overrides it. */
export type DirectoryBase = "catalyst-home" | "xdg-state" | "xdg-config" | "xdg-cache" | "xdg-data" | "none";
export interface CatalystDirectoryRole {
    /** CTC-2548's role id, verbatim. */
    readonly role: string;
    /** CTC-2548's canonical environment variable for this role, verbatim. */
    readonly variable: string;
    /** "none" ⇒ this role has no default and always refuses without the explicit variable. */
    readonly base: DirectoryBase;
    /** Path segments appended to the resolved base, in order. */
    readonly segments: readonly string[];
    /** false ⇒ setup never creates this directory (artifacts is minted per run, not provisioned). */
    readonly creatable: boolean;
    /** 0700 for anything holding a credential or machine state; 0755 otherwise. */
    readonly mode: "0700" | "0755";
}
/**
 * The ten roles, in CTC-2548's own order. `artifacts` is last-but-one and is the one role with
 * `base: "none"` — it is minted per run by the caller (`CATALYST_ARTIFACT_DIR`) and this script
 * must never invent a default for it.
 */
export declare const CATALYST_DIRECTORY_ROLES: readonly CatalystDirectoryRole[];
/** The roles setup actually creates, in table order. Never hand-counted (CTC-2552 was exactly that bug). */
export declare const CREATABLE_DIRECTORY_ROLES: readonly CatalystDirectoryRole[];
type Env = Record<string, string | undefined>;
/** The shell expression for a base's default (mirrors {@link baseDefault}, rendered instead of resolved). */
export declare const LEGACY_BASE_SHELL: Record<DirectoryBase, string | null>;
/**
 * Resolve one role's directory from `env`, the same precedence a shell caller gets from the
 * rendered block: explicit variable → base default → a NAMED refusal, never a relative guess
 * (the house shape: apps/host-sync/src/cli.ts:801-812).
 */
export declare function resolveWorkstationDir(role: string, env: Env): string | {
    readonly refused: string;
};
export {};
