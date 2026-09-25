import { type Environment, type MachinePaths, type MachineRole, type Profile } from "./index.js";
export interface MachineFileOptions {
    readonly env: Environment;
    readonly profile?: Profile;
    readonly file?: string;
}
export declare function machinePathsFile(options: MachineFileOptions): string | undefined;
export declare function loadMachinePaths(options: MachineFileOptions): Promise<MachinePaths | undefined>;
/** Atomic replacement. Existing parent permissions are never modified. */
export declare function writeMachinePaths(file: string, record: MachinePaths): Promise<void>;
export interface LegacyDiscoveryOptions {
    readonly env: Environment;
    readonly replicaDb?: string;
    /** Known file candidates supplied by setup; directories and empty files are never adopted. */
    readonly replicaCandidates?: readonly string[];
}
/** Discover legacy CLI locations using metadata only; never touch DB/cursor/lock contents. */
export declare function discoverLegacyPaths(options: LegacyDiscoveryOptions): Promise<Partial<Record<MachineRole, string>>>;
