# Storage

This directory owns NanoCore's physical data-root layout, ownership-scoped SQLite databases, canonical workspace file records, migrations, integrity validation, derived indexes, backup, export, and import mechanics.

## Source Of Truth

| Scope or record family | Durable owner |
| --- | --- |
| Server control state, authentication, scheduler records | `server/db/core.sqlite` |
| User-scoped command idempotency | `users/<userId>/db/user.sqlite` |
| Workspace-scoped ledgers and transactional recovery | `workspaces/<workspaceId>/db/workspace.sqlite` |
| Workspace, thread, turn, item, artifact, knowledge, source, session, and runtime transcript history | Canonical files under the owning workspace tree |
| Search, readiness, and dashboard indexes | Rebuildable files under `indexes/` or derived SQLite tables |

One record family must have one durable authority. Do not add aggregate workspace snapshots, dual file-and-SQLite payload ownership, newest-file recovery, or runtime resource serialization.

## Boundaries

- `fs-layout.ts` owns safe paths and accepted directory placement.
- `db.ts` and `migrate.ts` own database opening, integrity validation, and the committed fresh-database setup.
- Authoritative SQLite integrity failure stops boot and leaves the original database file unchanged; only derived indexes may rebuild automatically.
- `workspace-file-records.ts` owns canonical workspace record serialization and boot loading.
- `command-request-records.ts` owns scope-homed SQLite command idempotency; process-local duplicate collapse remains in `../runtime/idempotent-command.ts`.
- `../workspace-materials.ts` owns exactly the three app-local Material tables and their same-transaction command mutations; worker delivery, Artifact Review, and portable graph rewriting remain with their later S16 stages.
- `../goal-steering-authority.ts` owns the Thread-unique pending input and immutable terminal outcome rows; callers own Item, Context Package, follow-up Turn, and body-free receipt effects around its exact transaction fences.
- `workspace-export.ts` owns the V2 export tree, manifest, exact-byte inventory, and offline verification.
- `workspace-archive.ts` owns strict USTAR path representability shared by export creation, offline verification, and archive production, plus bounded one-shot extraction into private request-local staging.
- `workspace-import.ts` parses only verified bytes, validates and remints the import graph, and reconstructs importable records.
- `workspace-portable-file-state.ts` owns portable Knowledge ledgers, workspace config and schema, native OKF pages, S61 retrieval traces, and retained S39 worker Context Package files.
- Standalone Knowledge context traces and materializations are unsupported; worker delivery belongs only to the S39 Context Package owner.
- `workspace-transfer-routes.ts` coordinates public requests, staged workspace publication, the Core database transaction, and synchronous compensation when Core replay fails.
- `index-rebuild.ts` consumes canonical records and authoritative ledgers but must never become their source of truth.
- Secret material belongs to `../vault/` backends and credential consumers; storage may retain only explicitly allowed non-secret metadata and redacted evidence.
- The scheduler lease is the narrow exception for worker route authentication: it retains exactly two nullable lowercase SHA-256 projections for the control and inference families, never either raw token or a derived sandbox-binding credential.

## File Record Rules

- Replace JSON records through a same-directory temporary file and rename.
- Append item and event revisions to JSONL; readers select the latest item revision by id and preserve event sequence.
- Fail closed on malformed canonical records, invalid lineage, unsupported required features, path escapes, and legacy authority files.
- Export V2 preserves complete canonical history and exact portable file bytes; V1 exports are intentionally rejected.
- Import writes the complete workspace tree and workspace database under `.staging`, publishes with one same-filesystem rename inside the Core transaction, and removes the published workspace when synchronous Core replay fails; this is coordinated rollback, not crash-atomic filesystem and SQLite commit.
- Deletion removes the canonical file or directory so restart cannot resurrect stale state.

## Verification

Run focused layout, migration, database, canonical reload, index rebuild, export, import, integrity failure, and backup tests for the changed owner, followed by the package gates in the [NanoCore source guide](../README.md).

## Related Design

- [Storage](../../../../docs/core/storage.md)
- [Storage Layout And Record Ownership](../../../../docs/specs/20260703-storage_layout_record_ownership.md)
- [Schema Evolution Record Envelope](../../../../docs/specs/20260703-schema_evolution_record_envelope.md)
