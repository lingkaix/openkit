# Workspace Backup, Export, Import, And Data-Root Migration

Status: Accepted
Implementation: Implemented

## Owns

- The workspace export format: export tree layout, root manifest shape, content inventory, and offline verifiability rules.
- Content inclusion, exclusion, and redaction rules for workspace exports.
- Import validation, digest verification, required-feature enforcement, atomicity, and rollback-free failure behavior.
- Workspace id collision handling and `importedFrom` lineage rules on import.
- The cold and hot backup procedures for a NanoCore data root and the restore procedure.
- Data-root migration rules for moving a data root to a new path or host, including deployment id lineage.
- The interaction contract between workspace deletion, retention classes, and the sealed audit closure export.
- The export-time compaction allowance for item-log segments.

## Does Not Own

- The physical storage layout and record ownership tree. `docs/specs/20260703-storage_layout_record_ownership.md` owns those.
- General schema evolution rules, the record envelope, or required-feature registry mechanics. `docs/specs/20260703-schema_evolution_record_envelope.md` owns those.
- Vault backend mechanics, secret material storage, or re-binding UX. `docs/specs/20260704-vault_backend_implementation.md` owns those.
- Audit, usage, and evidence record schemas or retention class definitions. `docs/specs/20260703-audit_usage_evidence_records.md` owns those.
- Boot-time layout verification, index rebuild, and recovery sequencing. `docs/specs/20260704-nanocore_bootstrap_readiness.md` owns those.
- Multi-deployment live synchronization or replication, which are deferred.

## Core References

- `docs/core/storage.md`
- `docs/core/architecture.md`
- `docs/core/audit.md`
- `docs/core/vault.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`

## Summary

This spec answers the "Backup, export, import, and compaction model" open point in `docs/core/storage.md`.

The primary export unit is one workspace. An export is a self-describing, offline-verifiable directory tree with a manifest that carries the common record envelope, a per-file digest inventory, and required features. Imports verify digests, enforce required features fail-closed, preserve or remint the workspace id with recorded lineage, rebuild derived indexes, and are atomic. Backup is data-root-level: a cold copy is the baseline, a hot backup captures the file tree first and SQLite snapshots second. Data-root migration is a config repoint validated at boot. Secret material never leaves the vault boundary: exports carry only vault reference records that land `unbound`.

## Goals

- Make a workspace portable across deployments without a binary database dependency.
- Make every export verifiable offline against its own manifest.
- Keep imports safe: fail closed on unknown required semantics, never leave a partial workspace.
- Keep secret material, backend-native handles, and server operational state out of workspace exports.
- Define backup and restore procedures that lean on rebuildable derived state instead of fighting it.
- Keep lineage truthful across export, import, and data-root moves.

## Non-goals

- Do not design incremental, differential, or continuous backup.
- Do not design live replication or multi-deployment sync.
- Do not define a deep compaction model beyond the item-log snapshot allowance in `docs/core/storage.md`.
- Do not redefine ownership scopes, envelope fields, retention classes, or vault semantics owned by sibling specs.

## Background

`docs/core/storage.md` establishes file-system-first storage with rebuildable SQLite indexes and lists the backup/export/import/compaction model as an open point. `docs/specs/20260703-storage_layout_record_ownership.md` fixes the ownership tree so that a workspace directory plus its `workspace.sqlite` is a self-contained recovery, backup, and export boundary, and its risk list already anticipates exports carrying provider references instead of credentials. `docs/specs/20260703-audit_usage_evidence_records.md` homes workspace-lineage audit rows in workspace scope precisely so exports are self-contained, and defines the sealed audit closure export on deletion. This spec supplies the missing format, procedure, and validation contract.

## Decision

The export unit is one workspace, serialized as a plain directory tree with an envelope-wrapped manifest and per-file digests. SQLite never travels inside an export: source-of-truth workspace rows are dumped as line-oriented records, derived indexes are dropped and rebuilt. Import is manifest-verified, fail-closed on unknown required features, and atomic via stage-then-rename. Backup operates on the whole data root, cold by default, hot with an ordered file-tree-then-SQLite-snapshot procedure. Data-root migration is supported by repointing server config and letting boot verification validate the moved tree.

## Contract / Expected Behavior

### Export Unit And Format

- The primary export unit MUST be one workspace. Exports of other scopes are not defined by this spec.
- An export MUST be a directory tree. Implementations MAY additionally package that tree as a single tar archive; the archived form MUST contain the identical tree.
- The export root MUST contain a manifest record carrying the common record envelope from `docs/specs/20260703-schema_evolution_record_envelope.md` with `recordType: workspace-export` and the workspace `ownerScope` and lineage.
- Beyond the envelope, the manifest MUST carry: the source deployment id, the workspace id, the export created-at timestamp, the export format version, a content inventory listing every file in the export with its content digest, and the union of `requiredFeatures` needed to process the exported records.
- An export MUST be self-describing and verifiable offline: a verifier with only the export tree MUST be able to check every inventory digest and validate the manifest envelope without contacting the source deployment.
- A file present in the tree but missing from the inventory, or listed but absent, MUST make verification fail.

### Contents

An export MUST include all workspace-owned file-backed source-of-truth records per the storage layout spec:

- thread records, turn records, and append-only item logs
- artifacts and artifact metadata
- the knowledge store tree
- workspace metadata and workspace config
- workspace synchronization records that are file-backed

Two additional workspace-owned record families join export scope the moment their owning specs are implemented; each MUST be added to the exporter and to the export coverage guard in the same change that creates its records:

- the workspace evaluation area — `EvalTask` records, suite snapshots, and their context/fixture material — per `docs/specs/20260710-self_improvement_evaluation_loop.md`
- workspace-scope Skill Catalog entries, version records, pin records, and referenced version content per `docs/specs/20260711-skill_catalog_versioning_pinning.md` (server-scope catalog entries are deployment configuration and MUST NOT export with a workspace)

Derived SQLite indexes MUST be excluded by default; they are rebuildable from the exported records per `docs/core/storage.md`.

SQLite source-of-truth rows with workspace scope (per the storage layout spec's source-of-truth rules, e.g. workspace-homed audit events, usage records, capability calls, permission decisions, vault reference metadata) MUST be exported as line-oriented record dumps inside the export tree, following the split-envelope rules for line-oriented families. An export MUST NOT contain a SQLite database file, so consuming an export never requires a binary DB dependency.

### Exclusions And Redaction

- Secret material MUST NOT appear in an export under any circumstances.
- Vault references MUST export as reference records only. On import they MUST enter the `unbound` state and MUST require explicit re-binding before any use, per `docs/specs/20260704-vault_backend_implementation.md`.
- Backend-native handles (OpenShell session ids, gateway ids, provider account handles, native transfer handles) MUST export only in redacted summary form.
- Server-scope operational records — scheduler queue entries, leases, capacity records, target health — MUST NOT export with a workspace.
- Restricted raw evidence follows its retention class rules from the audit spec; exports MUST NOT widen the visibility of restricted material.

### Import

- The importer MUST verify every content-inventory digest and MUST validate the manifest record envelope before creating any workspace state.
- The importer MUST reject the export if the manifest or any imported record carries unsupported `requiredFeatures`, per the fail-closed rule in `docs/specs/20260703-schema_evolution_record_envelope.md`. Rejection diagnostics MUST name the unsupported identifier.
- When the exported workspace id does not collide with an existing workspace in the target deployment, the importer MUST preserve it.
- When the id collides, the importer MUST mint a new workspace id and MUST record `importedFrom` lineage — source deployment id, source workspace id, export created-at, manifest digest — in the imported workspace record, and MUST emit an audit event recording the remint.
- Derived indexes MUST be rebuilt from the imported files; the importer MUST NOT trust or require index state from the source.
- Imported vault references MUST land in `unbound` state regardless of their state at export time.
- Import MUST be atomic: a failed import MUST leave no partial workspace. The importer MUST stage the workspace into a temporary directory inside the target data root (same filesystem) and publish it with a single rename into place; failure at any earlier point discards the staging directory.

### Backup And Restore

- Cold backup is the documented baseline: with NanoCore stopped, a byte copy of the entire data root is a complete, clean backup.
- Hot backup, taken while NanoCore runs, MUST copy the file tree first and then snapshot SQLite databases via the SQLite backup API, in that order. Rationale: derived databases are rebuildable and source-of-truth databases are small operational stores, so a DB snapshot taken after the file copy can only be newer than the files, which boot-time recovery reconciles.
- A backup MUST include a backup manifest recording what was captured, capture timestamps, and whether the backup is clean (cold) or crash-consistent (hot).
- Restore is: replace the data root with the backup, point server config at it, and boot. Boot-time recovery per `docs/specs/20260704-nanocore_bootstrap_readiness.md` handles derived index rebuilds and scheduler recovery; restore tooling MUST NOT duplicate that logic.

### Data-Root Migration

- Moving a data root to a new path or host MUST be supported by pointing server config at the moved tree. No path rewriting inside records is required; records MUST NOT embed absolute data-root paths.
- Boot layout verification (owned by the bootstrap readiness spec) validates the moved tree before the server serves traffic.
- When a move changes the deployment id, the new deployment MUST record the deployment id change so that lineage in future exports remains truthful: exports created after the move carry the new deployment id, and the deployment record preserves the predecessor id.

### Retention And Deletion Interaction

- Workspace deletion MUST produce the sealed audit closure export defined in `docs/specs/20260703-audit_usage_evidence_records.md` before removal.
- Records under `legal-hold` retention block deletion until the hold is released, per the same spec. This spec adds no retention semantics of its own.

### Compaction

The only compaction this spec permits is the item-log snapshot compaction already allowed by the invariants in `docs/core/storage.md`: snapshots of completed items that change no item ids, causation links, or final meaning.

A compacted export MAY exclude item-log segments superseded by such snapshots, provided replay equivalence is preserved and the manifest records that the export is compacted and which segments were elided. Deep compaction design is deferred.

## Accepted Design

The exporter walks the workspace tree per the storage layout spec, copies file-backed records verbatim, dumps workspace-scope source-of-truth rows from `workspace.sqlite` into line-oriented files with directory-level manifests, computes the digest inventory, and writes the manifest last so a truncated export always fails verification. The importer is the mirror: verify, stage under `<data-root>/users/<userId>/workspaces/.staging/<importId>/`, materialize records, mint or preserve the id, rename into place, then trigger index rebuild through the normal boot-time rebuild path. Backup and migration tooling are thin procedures over the data root plus manifest writing; they deliberately reuse boot-time recovery rather than owning reconciliation.

## Current Implementation Projection

The first manifest and offline verification slice is implemented. `@openkit/config-schema` now exports `WorkspaceExportManifestSchema`, `WorkspaceExportInventoryEntrySchema`, `parseWorkspaceExportManifest`, and `WORKSPACE_EXPORT_FORMAT_VERSION`. The manifest schema fixes the accepted first-slice `workspace-export` record envelope, workspace lineage, source deployment id, format version, and SHA-256 content inventory, and it reuses the shared required-feature fail-closed reader.

NanoCore now has a storage-local offline verifier and first exporter in `apps/nanocore/src/storage/workspace-export.ts`. `verifyWorkspaceExportTree` reads `openkit-workspace-export.json`, validates the manifest and supported required features, verifies listed file sizes and SHA-256 digests, rejects symlinks and unsupported file types, rejects extra files missing from the inventory, and reports the checked content paths. `writeWorkspaceExportTree` writes `records/workspace.json`, `records/threads.jsonl`, `records/knowledge.jsonl`, `records/knowledge-proposals.jsonl`, `records/knowledge-proposal-reviews.jsonl`, `records/knowledge-sources.jsonl`, registered text source material files under `sources/materials/<sourceId>/content.txt`, `records/thread-items.jsonl`, `records/data-sources.json` when the workspace has a data source catalog, `records/audit-events.jsonl` when workspace audit events exist, `records/capability-calls.jsonl` and `records/usage-records.jsonl` when workspace capability usage ledger rows exist, `records/workspace-repositories.jsonl` when workspace repository resources exist, `records/git-push-records.jsonl` when workspace Git push records exist, `records/goal-records.jsonl`, `records/goal-tasks.jsonl`, `records/goal-review-records.jsonl`, and `records/goal-verification-records.jsonl` when Goal Mode rows exist, `records/mcp-tool-schema-snapshots.jsonl` when MCP schema snapshots exist, `records/permission-decisions.jsonl` when workspace permission decisions exist, `records/pending-user-turns.jsonl` when pending user turns exist, `records/worker-turn-checkpoints.jsonl` when worker checkpoints exist, `records/workspace-input-snapshots.jsonl`, `records/workspace-materialization-records.jsonl`, `records/workspace-change-sets.jsonl`, and `records/staged-workspace-reviews.jsonl` when workspace synchronization rows exist, `records/workspace-apply-results.jsonl` when workspace apply results exist, `records/vault-references.jsonl` when workspace-scoped vault reference metadata exists, `records/vault-grants.jsonl` when workspace-scoped vault grant metadata exists, and `records/vault-use-records.jsonl` when workspace-scoped vault use records exist, computes the SHA-256 content inventory, writes the manifest last, and immediately verifies the written tree before returning it. The manifest file itself is not self-inventoried in this first slice.

The current exporter also writes `records/injection-plans.jsonl` for injection plans linked to exported workspace vault grants and `records/injection-receipts.jsonl` for injection receipts linked to exported injection plans.

The first public export surface is implemented through `POST /api/app/workspaces/:workspaceId/export`, `@openkit/core-client` `client.app.exportWorkspace(workspaceId)`, and the MCP `openkit.export_workspace` tool. The response exposes the verified manifest, checked files, file count, and total bytes without exposing the server export directory path.

The first import-side dry-run surface is also implemented. NanoCore verifies a server-managed export handle through `POST /api/app/workspace-imports/dry-run`, `@openkit/core-client` `client.app.dryRunWorkspaceImport(input)`, and the MCP `openkit.dry_run_workspace_import` tool. The dry-run response verifies the export tree, returns file count, total bytes, checked files, and previews whether the exported workspace id is available or would collide and need reminting. It does not stage, rename, create, or mutate workspace state.

The first mutating importer slice is now implemented for the current export record families. NanoCore exposes `POST /api/app/workspace-imports`, `@openkit/core-client` exposes `client.app.importWorkspace(input)`, and MCP exposes the mutating `openkit.import_workspace` tool. The importer accepts the same server-managed export handle, verifies the export tree, remints the workspace id on collision, rejects the manifest and imported raw records that declare unsupported export-format `requiredFeatures` before schema projection can strip unknown fields, parses `records/workspace.json`, `records/threads.jsonl`, `records/knowledge.jsonl`, optional `records/knowledge-proposals.jsonl`, optional `records/knowledge-proposal-reviews.jsonl`, optional `records/knowledge-sources.jsonl`, optional `sources/materials/<sourceId>/content.txt`, `records/thread-items.jsonl`, optional `records/data-sources.json`, optional `records/audit-events.jsonl`, optional `records/capability-calls.jsonl`, optional `records/usage-records.jsonl`, optional `records/workspace-repositories.jsonl`, optional `records/git-push-records.jsonl`, optional `records/resolved-agent-setups.jsonl`, optional `records/agent-environment-package-snapshots.jsonl`, optional `records/goal-records.jsonl`, optional `records/goal-tasks.jsonl`, optional `records/goal-review-records.jsonl`, optional `records/goal-verification-records.jsonl`, optional `records/mcp-tool-schema-snapshots.jsonl`, optional `records/permission-decisions.jsonl`, optional `records/pending-user-turns.jsonl`, optional `records/worker-turn-checkpoints.jsonl`, optional `records/workspace-input-snapshots.jsonl`, optional `records/workspace-materialization-records.jsonl`, optional `records/workspace-change-sets.jsonl`, optional `records/staged-workspace-reviews.jsonl`, optional `records/workspace-apply-results.jsonl`, optional `records/vault-references.jsonl`, optional `records/vault-grants.jsonl`, and optional `records/vault-use-records.jsonl`, rewrites imported workspace/thread/item ownership ids, replays app-local knowledge proposal/review/source records and their registered text material files, workspace audit events, capability usage ledger rows, workspace repository resources, Goal Mode goal/task/review/verification rows, MCP tool schema snapshots, permission decisions, pending user turns, worker checkpoints, workspace synchronization rows, workspace apply results, Git push records, resolved setup records, redacted Agent Environment Package snapshots, and workspace vault use records into the target staged workspace database, writes imported workspace data source catalogs back to `config/data-sources.jsonc` inside the staged workspace root, imports workspace vault references as new `unbound` metadata with no backend locator and version `0`, imports workspace vault grants as non-secret `core.sqlite` metadata linked to the imported unbound references, records `importedFrom` lineage on the imported workspace with source deployment id, source workspace id, export timestamp, and manifest digest, records a workspace-scoped `workspace.import` audit event when durable workspace audit storage is configured, persists the imported workspace through `FsStore`, and returns the imported workspace plus the verification and collision report without exposing the export root path. Knowledge proposal replay rewrites workspace ownership, remints proposal/source ids when the workspace id is reminted so the source workspace's app-local maps are not overwritten, remaps proposal review decisions to the imported proposal id, and writes registered source material under the reminted source id. Repository resource replay preserves resource id, display name, type, Git write policy, and timestamps, but intentionally drops the source host `localPath` and imports the resource with `diagnosticsStatus: missing` so the target deployment must rebind a local repository before use. Goal Mode replay preserves goal status, title, objective, item links, current task, terminal stop reason, task ordering, dependencies, acceptance criteria, budgets, verification checks, review verdicts, review evidence, verification command metadata, verification status, output pointers, resolution metadata, and timestamps while rewriting workspace ownership; it does not emit new goal, task, review, or verification audit events for imported history. MCP schema snapshot replay preserves catalog entry id, source ref, server version, content digest, tool schemas, source, and capture timestamp while rewriting workspace ownership; it does not export launch commands, URLs, vault refs, credentials, tool arguments, or tool results. Permission-decision replay preserves policy snapshot, product result, reason code, summaries, enforcement point, approval/audit links, and created timestamp while rewriting workspace ownership and top-level summary `workspaceId` fields; it does not emit new permission-decision audit events for imported history. Pending-user-turn replay preserves thread, request, content item or digest, queue mode, received timestamp, and created timestamp while reminting the workspace-scoped pending-turn id; it does not emit new enqueue audit events for imported history. Worker checkpoint replay preserves thread, turn, goal/task linkage, stage, iteration, worker session, context digest, stop reason, diagnostics summary, and timestamps while reminting the workspace-scoped checkpoint id; it does not emit terminal checkpoint audit events for imported history. Workspace synchronization replay preserves input snapshots, materialization records, change sets, staged reviews, and review patch payloads while rewriting workspace ownership and direct `workspace://<workspaceId>/...` references to the imported workspace; it does not emit new stage-review audit events for imported history. Workspace apply-result replay preserves applied path, status, verification, commit id, review id, change-set id, and the storage-only request id while rewriting workspace ownership; it does not emit new apply-finish audit events for imported history. Git push record replay preserves the storage-only request id from the export but does not emit a new push-finish audit event for imported history. Resolved setup replay preserves the redacted setup payload, runtime/provider summary fields, request and turn lineage, and agent runtime capability requirements through the export-specific `setupRequiredFeatures` field so it does not collide with export-format `requiredFeatures` guards. Agent Environment Package snapshot replay preserves the redacted package snapshot, package, backend, runtime, turn, thread, and agent-session lineage while rewriting both row ownership and direct snapshot `scope.workspaceId` to the imported workspace; because that rewrite changes the stored snapshot JSON, the imported row recomputes `contentDigest` from the rewritten redacted snapshot. Vault grant replay preserves non-secret grant metadata, remaps source vault reference ids to imported unbound references, and remints imported grant ids because grant ids are global inside `core.sqlite`. Vault use replay preserves non-secret use evidence, remaps source vault reference ids to the imported unbound references when those references were exported, remaps grant ids when the linked grant was exported, and does not emit new vault-use audit events for imported history. `FsStore` now publishes imported workspace files through a same-filesystem `.staging` directory and a final `rename`, lets import callers write workspace-owned SQLite side effects, source material files, and catalog config files inside that staging root before publish, reads the newest data-root snapshot on restart so staged imports remain visible, removes orphaned import staging roots during data-root startup, and rolls back the imported workspace, workspace resources, threads, items, knowledge proposals, knowledge proposal reviews, and knowledge sources from the live store before surfacing a persistence error.

The Git push record import reader strips unknown optional fields before storing the strict current row shape, matching the additive-metadata behavior already used for evidence, runtime evidence, capability-call, and usage record imports.

The current importer also parses optional `records/injection-plans.jsonl` and optional `records/injection-receipts.jsonl`, imports both as non-secret `core.sqlite` metadata after remapping workspace-owned vault grants, and remaps linked vault-use `planId` and `receiptId` values when the linked rows were exported.

The injection plan row-family slice is also implemented. Exports write `records/injection-plans.jsonl` for non-secret injection plans linked to exported workspace vault grants. Imports remap each plan to the imported grant id, remint the plan id because plan ids are global in `core.sqlite`, preserve package snapshot, capability, injection visibility, runtime target class, redaction, backend requirement, status, and creation time, and remap linked vault-use `planId` values when the linked plan was exported.

The injection receipt row-family slice is also implemented. Exports write `records/injection-receipts.jsonl` for non-secret injection receipts linked to exported injection plans. Imports remap each receipt to the imported plan and grant ids, remint the receipt id because receipt ids are global in `core.sqlite`, preserve actor linkage, capability call linkage, redacted backend summary, injection and expiration timestamps, revocation status, and audit link, and remap linked vault-use `receiptId` values when the linked receipt was exported.

The first vault re-binding surface is implemented for imported workspace-owned references. NanoCore exposes `GET /api/app/workspaces/:workspaceId/vault/references` for redacted discovery and `POST /api/app/workspaces/:workspaceId/vault/references/:referenceId/rebind` for mutation, `@openkit/core-client` exposes `client.app.listWorkspaceVaultReferences(workspaceId)` and `client.app.rebindWorkspaceVaultReference(workspaceId, referenceId, input)`, and MCP exposes the mutating `openkit.rebind_workspace_vault_reference` tool. The rebind surface accepts base64 local secret material only in the request, stores it in the active vault backend, transitions the imported `unbound` reference to `active`, and returns only redacted reference metadata. Secret material is not echoed in the App API response, MCP response, or audit summary.

The first Web re-binding surface is implemented in Settings > Portability. The Web app reads the selected workspace repository resources, repository diagnostics, and redacted workspace vault references through `@openkit/core-client`, shows whether the default repository and imported vault references are currently linked, calls `client.repositories.setDefault(workspaceId, { displayName, localPath })` to bind a local Git repository path after import or data-root move, and calls `client.app.rebindWorkspaceVaultReference` with base64-encoded local secret material for imported unbound vault references. Secret material remains input-only and is not rendered back into Web state.

The accepted V1 portability contract is implemented. The current workspace-owned SQLite portable row families are covered by export/import, and `apps/nanocore/src/storage/workspace-export.test.ts` checks that every migrated workspace SQLite table is either covered by `WORKSPACE_EXPORT_PORTABLE_WORKSPACE_SQLITE_TABLES` or explicitly listed in `WORKSPACE_EXPORT_NON_PORTABLE_WORKSPACE_SQLITE_TABLES`. The current explicit non-exported workspace table is `workspace_filesystem_staging_roots`, because it stores host-local apply staging and target paths. The exporter and importer cover the currently available `FsStore` workspace, thread, knowledge, knowledge proposal/review/source, thread-item, workspace data source catalog, workspace audit-event, capability usage ledger, workspace repository resource, Goal Mode goal/task/review/verification, MCP tool schema snapshot, permission-decision, pending-user-turn, worker-checkpoint, resolved setup, redacted Agent Environment Package snapshot, workspace synchronization, workspace apply-result, Git push record, workspace-scoped vault reference metadata, workspace-scoped vault grant metadata, injection plan metadata, injection receipt metadata, and workspace-scoped vault use records, and both manifest-level and imported-record-level required-feature guards are implemented for those families. The L2 round-trip route contract exports a representative workspace, imports it with collision reminting, re-exports the imported workspace, and verifies that thread, knowledge, Knowledge Manager review/source, workspace audit records, workspace repository metadata, and workspace vault reference metadata survive with legal ownership rewrites and redaction. The L3 NanoCore black-box tests start a built NanoCore process, create or export workspace state through public HTTP, verify same-deployment collision reminting with preserved knowledge, verify unsupported export `requiredFeatures` fail closed without creating an imported partial workspace, and verify tampered inventoried export content fails closed without creating an imported partial workspace. The built-artifact L5 NanoCore smoke exports a workspace from one running built NanoCore process, copies the server-managed export handle into a fresh data root, imports it through a second built NanoCore process, and verifies preserved knowledge through public HTTP. The deterministic L6 MCP runner for `tests/stories/workspace-portability-release.story.md` covers cross-data-root export/import, dry-run non-mutation, imported lineage, preserved knowledge, repository re-binding, and redaction checks. Broader representative fixtures, broader L3 recovery scenarios, and a full vault-seeded agentic portability run remain future hardening rather than blockers for the accepted V1 boundary.

The first backup, restore, and hot-backup storage slice is implemented. `@openkit/config-schema` now exports `DataRootBackupManifestSchema`, `parseDataRootBackupManifest`, and `DATA_ROOT_BACKUP_FORMAT_VERSION` for the accepted `data-root-backup` record envelope. NanoCore storage exposes `writeColdDataRootBackupManifest`, `writeHotDataRootBackup`, `restoreDataRootBackup`, and `verifyDataRootBackupManifest`. Cold manifest writing inventories an already copied data-root backup, records cold/clean backup timestamps and source deployment id, writes `openkit-data-root-backup.json`, and verifies file presence, bytes, SHA-256 digests, unsafe paths, symlinks, extra files, and unsupported manifest `requiredFeatures` offline. Hot backup copies the data-root file tree first, then snapshots each `.sqlite` file through SQLite's backup API into the copied tree before writing a hot/crash-consistent manifest. Restore verifies the backup before replacing the target data root through a same-parent staging copy and rename sequence, leaving boot-time recovery as the owner of reconciliation. Hot backup creation and backup verification are now exposed through server-managed public handles: NanoCore exposes `POST /api/app/data-root/backups` and `POST /api/app/data-root/backups/:backupId/verify`, `@openkit/core-client` exposes `client.app.createDataRootBackup()` and `client.app.verifyDataRootBackup(backupId)`, and MCP exposes `openkit.create_data_root_backup` and `openkit.verify_data_root_backup`. Public backup responses return the backup id, manifest, checked files, file count, and byte count without exposing filesystem paths. Restore is intentionally exposed only as the stopped-server operator command `pnpm --filter @openkit/nanocore run data-root:restore -- --backup-root <backupRoot> --data-root <dataRoot>`. The command refuses to run when `server/runtime/nanocore.lock` exists, verifies the backup before mutation, calls the same storage restore helper, and prints a path-free JSON summary. Restore is not exposed as a live App API or MCP operation while NanoCore is running.

The first deployment-id lineage slice is implemented. NanoCore records the current data-root deployment id in `server/layout.json`, normalizes older internal layout markers to the default `dep_local`, and exposes `recordDataRootDeploymentMove` for data-root moves that change deployment id. The marker preserves `predecessorDeploymentId` when the deployment id changes, and workspace exports now read `sourceDeploymentId` from the data-root marker instead of a hardcoded value.

The first data-root migration validation slice is implemented in NanoCore boot layout verification. `ensureLayout` now rejects file-backed text records that embed the current absolute `DATA_ROOT` path, while deliberately skipping SQLite and other binary files. This enforces the accepted migration rule that moved data roots are config repoints rather than record rewrites and that product records must not depend on the old data-root path.

`docs/nanocore-data-root-config.en.md` documents the current `DATA_ROOT` selection via `OPENKIT_DATA_ROOT` and `config/server.jsonc`; that mechanism is the config surface the data-root migration contract repoints. Boot layout verification now validates the target ownership tree, deployment marker, canonical database placement, and file-backed text record path independence. Boot-time index rebuild is specified in `docs/specs/20260704-nanocore_bootstrap_readiness.md` and is implemented separately.

## Alternatives Considered

- SQLite-native single-file export (serialize the workspace into one database file). Rejected: it inverts the file-system-first principle in `docs/core/storage.md`, makes exports opaque to inspection, and creates a binary format dependency for every consumer.
- Incremental or differential backup. Deferred: the cold/hot full-copy model is sufficient for the current deployment posture; incremental capture needs change tracking this spec should not invent.
- Live replication between deployments. Deferred: continuous sync is a multi-deployment concern with its own consistency model; exports and backups deliberately stay point-in-time.

## Consequences

- A workspace export is inspectable with standard tools and verifiable with nothing but a digest utility, at the cost of an export step that dumps SQLite rows instead of copying a database file.
- Import can never half-create a workspace, at the cost of requiring staging space inside the target data root.
- Backups stay simple because derived state is disposable; the price is that restore time includes index rebuild.
- Vault re-binding after import is explicit manual work through the public App API, core-client, or MCP surface; a restored or imported workspace is not silently able to use secrets.

## Rollout / Migration Plan

This is new tooling over the target storage layout; it has no legacy compatibility obligations per the internal development compatibility rule. Rollout order: (1) export format, manifest, offline verifier, workspace exporter, App API surface, core-client surface, and MCP surface, now implemented; (2) import dry-run with digest verification and collision preview, now implemented; (3) mutating importer for current `FsStore` and workspace SQLite portable row families with collision reminting, persisted `importedFrom`, workspace import audit event, live-store rollback on persistence failure, same-filesystem staged publish, orphaned staging cleanup, unbound workspace vault reference metadata, staged import-created audit storage, workspace audit-event dump/replay, capability usage ledger dump/replay, workspace repository resource dump/replay as unbound metadata, Goal Mode goal/task/review/verification dump/replay, MCP tool schema snapshot dump/replay, permission-decision dump/replay, pending-user-turn dump/replay, worker-checkpoint dump/replay, workspace synchronization row-family dump/replay, workspace apply-result dump/replay, Git push record dump/replay, workspace vault grant dump/replay, injection plan dump/replay, injection receipt dump/replay, workspace vault use dump/replay, app-local Knowledge Manager review state dump/replay, and fail-closed imported record required-feature checks, now implemented for all current portable row families; (4) cold backup manifest schema and offline verifier, now implemented; (5) hot backup via the SQLite backup API, now implemented with App API, core-client, and MCP create/verify surfaces; (6) verified restore replacement and stopped-server restore operator command, now implemented; (7) deployment id lineage, now implemented as layout-level tooling; (8) data-root migration validation, now implemented as boot layout verification for marker and text-record path independence; (9) imported workspace vault reference re-binding through App API, core-client, and MCP, now implemented as the first public surface. Full export completeness MUST NOT be claimed for future row families unless the table coverage guard and app-local state audit are kept current.

## Testing Strategy / Acceptance Criteria

Mapped to the L0–L6 model in `docs/specs/20260529-test_strategy.md`:

- L0: schema-drift checks for the `workspace-export` manifest and backup manifest shapes against exported schemas, plus workspace SQLite table-family coverage that fails when a new workspace table is neither exported/imported nor explicitly marked non-portable.
- L1: unit tests for inventory digest computation and verification, manifest envelope validation, collision-detection and id-mint logic, and staging-path rename semantics.
- L2: contract tests: round-trip export→import equivalence (re-exporting the imported workspace yields canonical records that preserve portable source facts while allowing legal `importedFrom`, audit, id-remint, and workspace ownership rewrites); tampering with any exported file or the manifest is detected offline; an export carrying an unregistered or unsupported required feature fails import closed with a named diagnostic; imported vault references are `unbound` and unusable until re-bound.
- L3: NanoCore black-box tests: import into a deployment with a colliding workspace id mints a new id, records `importedFrom`, and emits the audit event; a fault-injected import failure at each stage leaves no partial workspace and no orphaned staging state after cleanup; indexes rebuild correctly after import; hot backup taken under concurrent writes restores to a bootable data root whose recovery reconciles files and DB snapshots; data-root move to a new path boots through layout verification with truthful deployment lineage. The first collision/reminting and unsupported-feature fail-closed black-box coverage is implemented in `apps/nanocore/e2e/workspace-portability.spec.ts`.
- L4: not applicable until Web UI export/import surfaces exist.
- L5: smoke test that a packaged build exports a workspace, verifies it offline, and imports it into a fresh data root. The first built-artifact smoke is implemented in `tests/smoke/nanocore-health-smoke.mjs`.
- L6: story acceptance: a user exports a workspace from one machine, imports it on another, re-binds local resources, and continues work with full thread history. The deterministic MCP runner covers the current public V1 slice; vault-seeded agentic continuation remains future hardening until public setup can seed workspace vault references without private hooks.

Acceptance criteria: round-trip equivalence, tamper detection, fail-closed features, collision lineage, unbound vault enforcement, and hot-backup restore all pass deterministically; no export ever contains secret material or a SQLite file.

## Risks & Mitigations

- Risk: export dumps drift from the live SQLite row schemas. Mitigation: dumps use the same exported record schemas as storage, covered by L0 drift checks.
- Risk: hot backup captures a torn file mid-append. Mitigation: item logs are append-only single-writer; boot recovery treats a truncated trailing line as unwritten, and the backup manifest marks the backup crash-consistent.
- Risk: users treat an export as a secret-complete clone and lose access after import. Mitigation: import surfaces the unbound vault references explicitly and the manifest lists them.
- Risk: staging directories accumulate after failed imports. Mitigation: staging lives under a dedicated directory that boot cleanup sweeps.
- Risk: compacted exports silently lose replay fidelity. Mitigation: compaction is only permitted when replay equivalence holds, the manifest records elision, and L2 tests replay compacted exports.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: the canonical tar-archived export extension is `.openkit-workspace.tar.zst` with a product-registered OpenKit workspace export media type; import includes a first-slice dry-run report that performs verification and collision preview without staging or mutating workspace data.

## Deferred / Future Work

- Incremental and differential backup.
- Live replication and multi-deployment synchronization.
- Deep compaction design beyond item-log snapshot elision.
- User- and server-scope export units, including a whole-deployment archival export.
- Broader representative workspace fixtures beyond the current repository, vault metadata, and worker setup evidence.
- Broader L3 recovery coverage beyond required-feature and digest-tamper fail-closed behavior.
- A full vault-seeded agentic portability run once public setup can seed workspace vault references without private test hooks.
- Web UI surfaces for export and import progress.

## Links

- `docs/core/storage.md` — this spec answers its "Backup, export, import, and compaction model" open point.
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260711-skill_catalog_versioning_pinning.md`
- `docs/nanocore-data-root-config.en.md`
