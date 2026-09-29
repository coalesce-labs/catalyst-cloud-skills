# Temporary paths runtime

`paths/` contains the generated JavaScript and declarations from `@catalyst-cloud/paths`, catalyst-cloud commit `c391358d06720985126c15b7fa9d9d6ad1878211`, PR 6059. This avoids a separate implementation of the version 1 machine path contract while that package is private. Replace the imports with the published package when publication is approved.

Run `CATALYST_PATHS_SOURCE=/path/to/catalyst-cloud node scripts/vendor-paths.mjs` to regenerate from that exact Git object. Add `--check` to compare a fresh compilation with the checked-in files. Without a source checkout, `npm run paths:check` validates each generated file against the recorded hashes. The generator uses this repository's locked TypeScript compiler.

Replica selection is `--db` where accepted, `CATALYST_REPLICA_DB`, then the machine manifest's `replicaDb`. Before a machine manifest exists, the CLI retains its saved customer.json path or legacy default. A manifest without replicaDb leaves replication optional and unconfigured. A malformed or missing explicit manifest fails instead of selecting another database.

The reader derives the lock from the selected database on each status check. No existing database is copied, moved, opened for writing, or reseeded by path resolution. Setup must import a discovered populated replica into the manifest before activating it. This PR does not install a manifest or start a writer.
