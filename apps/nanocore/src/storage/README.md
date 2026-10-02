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
- `db.ts` and `migrate.ts` own database opening, integrity validation, and native per-scope Drizzle journals under `drizzle/{core,user,workspace,app}`.
- Authoritative SQLite integrity failure stops boot and leaves the original database file unchanged; only derived indexes may rebuild automatically.
- `workspace-file-records.ts` owns canonical workspace record serialization and boot loading.
- `workspace-file-records.ts` also ensures the OKF v0.2 bundle-root `knowledge/pages/index.md` once, preserves valid authored index bytes, and writes the same final Knowledge Page candidate bytes that direct-edit validation accepted.
- `command-request-records.ts` owns scope-homed SQLite command idempotency; process-local duplicate collapse remains in `../runtime/idempotent-command.ts`.
- `../workspace-materials.ts` owns exactly the three app-local Material tables and their same-transaction command mutations; worker delivery, Artifact Review, and portable graph rewriting remain with their later S16 stages.
- `workspace-export.ts` owns the V2 export tree, manifest, exact-byte inventory, and offline verification.
- `workspace-archive.ts` owns strict USTAR path representability shared by export creation, offline verification, and archive production, plus bounded one-shot extraction into private request-local staging.
- `workspace-import.ts` parses only verified bytes, validates and remints the import graph, and reconstructs importable records. It remints `env.bound.payload.workspaceId` to the imported Workspace identity while `importedFrom` preserves source provenance. Package version, prompt and Tool digests, and `turn.reap` correlation remain unchanged. When a runtime row lacks header correlation, import preserves its source call reference in `corr` before reminting the fact identity, keeping recovery joins inside the reminted group.
- Native Knowledge Page import remints string-only `source_refs` through the parsed YAML document so block sequences and unknown nested metadata survive.
- `workspace-portable-file-state.ts` owns portable Knowledge ledgers, workspace config and schema, native OKF pages, S61 retrieval traces, and retained S39 worker Context Package files.
- Standalone Knowledge context traces and materializations are unsupported; worker delivery belongs only to the S39 Context Package owner.
- `workspace-transfer-routes.ts` coordinates public requests, staged workspace publication, the Core database transaction, and synchronous compensation when Core replay fails.
- `index-rebuild.ts` consumes canonical records and authoritative ledgers but must never become their source of truth.
- Knowledge Page enumeration excludes `index.md` and `log.md` at every bundle depth while native portability keeps every Markdown file byte-for-byte.
- Secret material belongs to `../vault/` backends and credential consumers; storage may retain only explicitly allowed non-secret metadata and redacted evidence.
- The scheduler lease is the narrow exception for worker route authentication: it retains exactly three nullable lowercase SHA-256 projections for the control, inference, and capability families, never a raw token or a derived sandbox-binding credential.

`work-observations.ts` is the entry point for Turn observation append, validated reads and safe timeline projection using the shared App API presentation bounds. It validates immutable capture admission and separates expected facts from successful evidence publication. `../evidence-bundles.ts` owns restricted body staging, retention and expiry; callers never construct content paths or store bodies in control receipts. Portable consumers reuse the observation parser and existing exact reference maps.

Timeline coverage remains partial when a collection gap follows observed runtime activity; unsupported or unavailable collection without observed activity remains unavailable.

`work-observation-recovery.ts` appends `turn.reap` after restart recovery terminalizes a Turn it owns. It uses the historical capture binding and durable completion timestamp, pairs gateway attempts through their request parentage and runtime tool phases through observed opaque call references, and preserves the first committed snapshot on retry. Never-recorded Turns are skipped; ledger read or append failures propagate through the existing scheduler recovery retry loop. The observation records the Core recovery decision without concluding that an unresolved external effect did not happen.

## File Record Rules

- Replace JSON records through a same-directory temporary file and rename.
- Append item and event revisions to JSONL; readers select the latest item revision by id and preserve event sequence.
- Fail closed on malformed canonical records, invalid lineage, unsupported required features, path escapes, and legacy authority files.
- `ensureLayout` rejects absolute DATA_ROOT paths only in canonical product-record locations. Verbatim exceptions are anchored to `server/` or `workspaces/<workspaceId>/`: backend streams under `evidence/backend/<bundleId>/raw/`, and Skill or Plugin snapshot trees under `catalog/skill-snapshots/` and `catalog/plugin-snapshots/`. Backend bundle manifest and native-index siblings remain scanned; nested misleading names, unsafe links, ownership, envelope, and canonical-path checks still apply.
- Export V2 preserves complete canonical history and exact portable file bytes; V1 exports are intentionally rejected.
- Portable evidence keeps admitted restricted originals as verified binary bytes under their EvidenceBundle, separate from canonical UTF-8 records. Import remints owner references, preserves body digests and retention, and stages bytes before publishing the Workspace. Unpublished observation chunks and expired body bytes stay excluded.
- Current Goal portability retains intent history, card revisions, exact immutable Plan bytes and pointers, Task admission citations and Task terminal facts in `records/goal-state.json`. Import remints Workspace, Thread and Turn owners, keeps immutable Plan identities and bytes, binds responsibility to the importing actor and imports no grants. Retired Goal-owned rows are absent; shared historical Goal ids remain opaque lineage.
- Import writes the complete workspace tree and workspace database under `.staging`, publishes with one same-filesystem rename inside the Core transaction, and removes the published workspace when synchronous Core replay fails; this is coordinated rollback, not crash-atomic filesystem and SQLite commit.
- Deletion removes the canonical file or directory so restart cannot resurrect stale state.

## Verification

Run focused layout, migration, database, canonical reload, index rebuild, export, import, integrity failure, and backup tests for the changed owner, followed by the package gates in the [NanoCore source guide](../README.md).

## Related Design

- [Storage](../../../../docs/core/storage.md)
- [Storage Layout And Record Ownership](../../../../docs/specs/20260703-storage_layout_record_ownership.md)
- [Schema Evolution Record Envelope](../../../../docs/specs/20260703-schema_evolution_record_envelope.md)

Data-root initialization seeds an empty editable `config/model-catalog.jsonc` alongside the other root config templates when absent and preserves administrator-authored contents.

Pending requests live in the Workspace SQLite `pending_requests` family. Canonical load, command replay, publication recovery, and attention reads share the validator in `../runtime/pending-requests.ts`; contradictory rows remain inspect-only while valid siblings stay usable. `command-request-records.ts` exposes a read-only receipt scan on the caller's existing scoped connection so validation inside a request transaction never opens a second migration or pruning writer.

Snapshot cursors and exact collection receipts (including private candidate bytes) are operational state bound to the source storage attachment and NanoHost scan store. Complete same-deployment backup retains them; portable Workspace export carries the existing output manifests, change sets, reviews, and apply history without importing live scan or replay authority.

Scheduler admission rows carry optional canonical `reasoning_effort` through delayed Worker dispatch. The pre-release Core baseline includes this nullable column; absent values project as an omitted preference. Work observation sampling uses the shared Protocol effort validator rather than a second enum.

CapabilityCall archives use the ledger’s canonical extension validation to preserve safe stored namespaces across scope remapping and import. Live protocol and App audit projections retain their stricter unknown-namespace omission; this does not add an archive format or a second persistence path.
