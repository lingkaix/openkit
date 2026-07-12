# Workspace Backup, Export, Import, And Data-Root Migration

Status: Accepted
Implementation: Implemented
Workspace export format: V2

## Owns

- The workspace export format: export tree layout, root manifest shape, content inventory, and offline verifiability rules.
- Content inclusion, exclusion, and redaction rules for workspace exports.
- Import validation, exact-byte verification, required-feature enforcement, coordinated publication, and rollback behavior.
- Workspace id collision handling, subordinate identity reminting, and `importedFrom` lineage rules on import.
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

The primary export unit is one workspace. Workspace export format V2 is a self-describing, offline-verifiable directory tree whose manifest commits to the exact portable file set and bytes consumed by import. Imports consume only those verified bytes, enforce required features fail-closed, preserve or remint the workspace id with recorded lineage, remint collision-prone target identities and references, and coordinate staged files with transactional Core replay and synchronous compensation on failure. Backup is data-root-level: a cold copy is the baseline, and a hot backup captures the file tree first and individual SQLite snapshots second. Data-root migration is a config repoint validated at boot. System-managed Vault, provider, and runtime secrets never enter workspace exports; exports carry only non-secret vault reference metadata that lands `unbound`. User-authored portable content is not a sanitized or DLP-scanned channel.

## Goals

- Make a workspace portable across deployments without a binary database dependency.
- Make every export verifiable offline against its own manifest.
- Preserve complete authoritative workspace history and file-backed knowledge state.
- Keep imports safe: fail closed on unknown semantics or incomplete lineage, leave no partial state after a caught synchronous failure, and document the remaining process-crash window explicitly.
- Keep system-managed Vault, provider, and runtime secret material, backend-native handles, derived indexes, and server operational state out of workspace exports.
- Define backup and restore procedures that lean on rebuildable derived state instead of exporting it.
- Keep lineage truthful across export, import, and data-root moves.

## Non-goals

- Do not design incremental, differential, or continuous backup.
- Do not design live replication or multi-deployment sync.
- Do not define a deep compaction model beyond the item-log snapshot allowance in `docs/core/storage.md`.
- Do not redefine ownership scopes, envelope fields, retention classes, or vault semantics owned by sibling specs.

## Background

`docs/core/storage.md` establishes file-system-first storage with rebuildable SQLite indexes and lists the backup, export, import, and compaction model as an open point. `docs/specs/20260703-storage_layout_record_ownership.md` fixes the ownership tree, and `docs/specs/20260703-audit_usage_evidence_records.md` places workspace-lineage audit rows in workspace scope so exports are self-contained. This spec defines the portable format and the validation, backup, restore, and migration contract.

## Decision

The export unit is one workspace, serialized as a plain V2 directory tree with an envelope-wrapped manifest and per-file digests. SQLite never travels inside an export: portable source-of-truth rows are dumped as line-oriented records, and derived indexes are omitted so their existing owner can rebuild them at boot or on demand. Import is manifest-verified, fail-closed on unknown required features or incomplete lineage, and coordinated through same-filesystem staging, one Core transaction, and synchronous compensating rollback. This does not create a transaction spanning the filesystem and SQLite across a process crash. V1 is intentionally incompatible and rejected rather than migrated. Backup operates on the whole data root, cold by default, hot with an ordered file-tree-then-SQLite-snapshot procedure. Data-root migration is supported by repointing server config and letting boot verification validate the moved tree.

## Contract / Expected Behavior

### Export Unit And V2 Manifest

- The primary export unit MUST be one workspace. Exports of other scopes are not defined by this spec.
- An export MUST be a directory tree. Implementations MAY additionally package that tree as a single tar archive; the archived form MUST contain the identical tree.
- The export root MUST contain `openkit-workspace-export.json`, carrying the common record envelope with `recordType: workspace-export`, workspace ownership and lineage, source deployment id, workspace id, export timestamp, `requiredFeatures`, and the content inventory.
- The manifest MUST declare `exportFormatVersion: 2`. Importers MUST reject V1 and every other version; no compatibility adapter or in-place upgrade is defined.
- The content inventory MUST list every non-manifest file exactly once with its relative path, byte length, and SHA-256 digest. The manifest `contentDigest` MUST be the SHA-256 digest of the exact JSON serialization of that inventory.
- The verifier MUST reject duplicate inventory paths, links, unsafe paths, unsupported file types, digest or byte-length mismatches, absent listed files, and non-manifest files absent from the inventory.
- Export creation MUST own a previously absent export root, write the manifest last, verify the completed tree before returning it, and remove that owned root if any step fails.

### Required Portable Contents

V2 MUST include the complete canonical workspace history, not only current projections:

- the workspace record, thread records, turn records, every item revision, and the complete turn-event history
- artifacts with their canonical bodies and metadata, artifact review history, and agent-session records
- knowledge entries, knowledge proposals, proposal decisions, knowledge sources, and registered source material

V2 MUST include all existing records from these five authoritative file-backed ledger families:

- knowledge observations
- knowledge claims
- complete knowledge conflict append history, not only the latest conflict projection
- knowledge context-package traces
- knowledge retrieval traces

V2 MUST also include the exact portable workspace file state:

- workspace configuration and the custom workspace knowledge schema
- native OKF knowledge pages
- context materializations, including their package manifests and policy snapshots

Portable workspace-scope database rows MUST be emitted as strict line-oriented records rather than as a database file. This includes the implemented audit, capability and usage, repository and Git, Goal Mode, permission and checkpoint, resolved setup and redacted Agent Environment Package, workspace synchronization and apply, MCP schema, vault-reference and grant, injection, and vault-use families. The workspace SQLite coverage guard MUST classify every table in `workspace.sqlite` as portable or explicitly non-portable. Core-owned vault and injection families remain explicit exporter, importer, and focused-test responsibilities; the workspace SQLite guard does not claim to inventory Core tables.

The workspace evaluation area and workspace-scope Skill Catalog state join export scope when their owning specs create those records. Their implementation change MUST add exporter, importer, and coverage-guard support; server-scope catalog entries remain deployment configuration.

### Non-Portable And Redacted State

- System-managed Vault material, provider credentials, session cookies, access tokens, runtime credentials, and backend secrets MUST NOT appear in an export.
- User-authored artifacts, knowledge, source material, and workspace configuration are portable content and are not generically secret-scanned. Operators and product surfaces MUST NOT describe an export as sanitized user content.
- Vault references MUST export only non-secret reference metadata. On import they MUST enter the `unbound` state and require explicit re-binding before use.
- Backend-native handles, host paths, active sandbox details, runtime compatibility keys, agent-session policy-snapshot bindings, and similar source-host state MUST be excluded or reduced to an explicitly redacted portable summary. Context-materialization policy snapshots are portable content instead: the importer rewrites their target-owned references and recomputes dependent digests.
- Derived indexes, SQLite database files, host-local filesystem staging roots, caches, scheduler queues, leases, capacity records, and target health MUST NOT export. They are rebuilt or re-established on the target deployment.
- Restricted raw evidence follows its retention class; export MUST NOT widen its visibility.

### Verification And Import

- Verification MUST validate the manifest envelope and `requiredFeatures` before creating any target state.
- The verifier MUST read each inventoried file once and return those verified bytes. Dry-run and mutating import MUST parse only that verified byte set and MUST NOT reopen export content after verification.
- A server-managed export whose `sourceDeploymentId` matches the current deployment or its recorded predecessor MUST remain private to an actor who can currently read the source workspace and has active membership. An export from an unrelated deployment is portable input and does not require a local source membership edge.
- The importer MUST reject unsupported `requiredFeatures` declared by the manifest or any imported record, and the diagnostic MUST name the unsupported identifier.
- The importer MUST validate both the source canonical history graph and the reminted graph before creating target state. Duplicate identities, stale turn projections, non-contiguous events, invalid event targets, dangling lineage, and inconsistent proposal or review state MUST fail import.
- When the workspace id does not collide anywhere in the target deployment, the importer MUST preserve it. The deployment-wide workspace registry, every owner-scoped live store, and final workspace paths participate in collision detection; when any owner already claims the id, the importer MUST mint a new workspace id. Owner membership recording MUST reject a second canonical owner instead of attaching another user's files to the same global workspace id. Every successful import MUST record `importedFrom` with source deployment id, source workspace id, export timestamp, and manifest digest. A durable Core-backed import MUST also emit a workspace import audit event.
- Identities that would collide in the live store or belong to a target-runtime namespace MUST be reminted. The implemented set includes thread, turn, item, artifact, approval and user-input request, agent-session, Agent Environment Package snapshot and package, knowledge proposal and source, Goal Mode, and Vault reference, grant, plan, and receipt identities. Stable workspace-scoped knowledge entry, observation, claim, conflict, context-package trace, retrieval trace, evidence, and other ledger identities MAY be preserved because the imported workspace remains their ownership boundary. Every affected direct or nested reference MUST be rewritten, and a missing or ambiguous required source reference MUST fail import.
- Context-package traces and materializations MUST remain one canonical graph after import. The importer MUST rewrite every affected selected record id, path, policy snapshot, package manifest, and source reference, then recompute context-package, file, entry, and manifest digests from the rewritten content. A stable context-package identity does not itself require reminting.
- Imported agent sessions MUST drop source-host sandbox, workspace-root, config-version, policy-snapshot, and compatibility-key state and MUST be marked stale for target-side re-establishment.
- Imported repository resources MUST drop source-host local paths and require target-side re-binding. Imported vault references MUST be reminted as `unbound` records without backend locators or secret material.
- Derived indexes MUST NOT be trusted or imported. The current owner rebuilds them from imported authoritative state on the next NanoCore boot and when the derived Knowledge Store index surface is read; live import does not synchronously rebuild them.
- Import MUST provide coordinated all-or-clean behavior for synchronous request failures: it stages workspace files and the workspace database on the target filesystem, wraps publication and Core-row replay in one Core transaction, rolls back Core rows on error, and removes staged or already published imported files and live-store state when an error is caught. Filesystem publication and SQLite commit are not one crash-atomic transaction; a process crash between them remains an explicit recovery window.
- Import request failures MUST return stable product-safe messages and MUST NOT expose the data-root path, export storage path, database error, or other deployment internals.

### Public Portability Surfaces

- NanoCore exposes server-managed export, dry-run import, and mutating import handles through the App API; `@openkit/core-client` and MCP expose the corresponding operations without revealing server filesystem paths.
- Workspace vault-reference discovery and re-binding accept secret material only as input, store it in the active target vault backend, and return only redacted reference metadata.
- The Web portability surface supports repository and vault-reference re-binding after import or migration without retaining secret material in rendered state.

### Backup And Restore

- Cold backup is the baseline: with NanoCore stopped, a byte copy of the entire data root is a complete, clean backup.
- Hot backup MUST copy the file tree first and then snapshot every SQLite database through the SQLite backup API. The manifest marks the result crash-consistent at the copied-file and individual-database level; it does not claim one transaction or automatic reconciliation across a newer database snapshot and older copied files.
- A backup MUST carry a manifest with capture timestamps, source deployment id, mode, consistency, exact file inventory, and per-file digests. The implemented offline verifier rejects links, extra or absent files, unsafe paths, digest mismatches, and unsupported required features. Its implemented integrity boundary is the parsed manifest plus the verified per-file inventory; unlike workspace V2 verification, it does not separately recompute the manifest `contentDigest` from that inventory or independently authenticate the manifest.
- Restore MUST verify before mutation, replace the target data root through same-filesystem staging and rename, then reuse boot-time SQLite integrity recovery, migrations, derived-index rebuild, and runtime restart recovery. Restore remains a stopped-server operator operation rather than a live App API or MCP mutation.

### Data-Root Migration

- Every newly initialized data root MUST mint and persist a unique deployment id before producing deployment-scoped records. A marker that predates deployment identity MUST receive one unique id exactly once during layout normalization; subsequent boots MUST preserve it.
- Moving a data root to a new path or host MUST be supported by pointing server config at the moved tree. Product records MUST NOT embed absolute data-root paths.
- Boot layout verification validates the moved tree before the server serves traffic.
- When a move changes the deployment id, the new deployment MUST preserve the predecessor id so future exports carry truthful lineage.

### Retention And Deletion Interaction

- Workspace deletion MUST produce the sealed audit closure export defined in `docs/specs/20260703-audit_usage_evidence_records.md` before removal.
- Records under `legal-hold` retention block deletion until the hold is released. This spec adds no retention semantics.

### Compaction

The only permitted compaction is the item-log snapshot compaction already allowed by `docs/core/storage.md`: completed-item snapshots that change no item ids, causation links, or final meaning.

A compacted export MAY omit item-log segments superseded by such snapshots only when replay equivalence is preserved and the manifest records the compaction and elided segments. Deep compaction remains deferred.

## Accepted Design

The exporter reads canonical source records, validates the complete workspace graph, writes the portable V2 tree into a newly owned root, computes the exact content inventory, writes the manifest last, and immediately verifies the result. The importer verifies once, parses the verified bytes, validates the source and target graphs, remints only identities that require target ownership, writes target files and the workspace database through same-filesystem staging, and coordinates publication with transactional Core replay and synchronous compensation. Derived indexes stay absent until their boot or on-demand owner rebuilds them. Backup and migration tooling remain thin procedures over the data root and reuse existing boot integrity and rebuild behavior without claiming cross-authority reconciliation.

## Current Implementation

V2 is the implemented and only accepted workspace export format. NanoCore exports and imports complete canonical history, all five authoritative knowledge ledgers, workspace configuration and schema, native OKF pages, context materializations, portable file and database row families, and source materials. The verifier owns the exact byte set consumed by dry-run and import, and the importer performs fail-closed source and target graph validation, required target-namespace reminting, stable knowledge-ledger identity preservation, context digest and policy reconstruction, same-filesystem staging, transactional Core replay, and compensating rollback for caught synchronous failures.

The public portability, vault re-binding, data-root backup and verification, stopped-server restore, deployment lineage, and data-root migration validation surfaces described above are implemented. The workspace SQLite table coverage guard and app-local portable-state tests protect the implemented V2 boundary when storage ownership changes. Cross-resource crash recovery, concurrent-write hot-backup restore validation, browser-level portability acceptance, and true cross-machine continuation remain explicit hardening gaps rather than implied guarantees.

## Alternatives Considered

- SQLite-native single-file export. Rejected because it inverts the file-system-first model, makes exports opaque, and creates a binary format dependency.
- A V1 compatibility reader or V1-to-V2 upgrader. Rejected because the project is internal, V1 omitted authoritative state, and accepting it would falsely imply a complete portable workspace.
- Incremental or differential backup. Deferred because full cold and hot backups cover the current deployment posture without another change-tracking model.
- Live replication between deployments. Deferred because continuous synchronization needs a separate consistency model.

## Consequences

- A workspace export is inspectable with standard tools and verifiable without the source deployment, at the cost of serializing portable database rows instead of copying a database file.
- V1 exports are intentionally unusable and must be recreated as V2 from the source workspace.
- A caught synchronous import failure does not leave a partial workspace, at the cost of same-filesystem staging, one Core transaction, and compensating cleanup; a process crash can still land inside the filesystem-to-Core publication window.
- Derived state stays disposable, so restore boot and on-demand index reads rebuild it; live import does not rebuild it immediately.
- Vault and repository re-binding after import is explicit; imported workspaces do not silently inherit source-host credentials or paths.
- User-authored portable content remains user content rather than becoming secret-scanned or sanitized merely because it passed through export.

## Rollout / Migration Plan

V2 replaces V1 without compatibility obligations. Existing V1 exports MUST be rejected and regenerated from their source workspaces. Future workspace-owned authoritative families MUST join export and import coverage in the same change that introduces their storage ownership; derived or server-local families MUST be explicitly classified non-portable.

## Testing Strategy / Acceptance Criteria

The required acceptance path maps to the L0-L6 model in `docs/specs/20260529-test_strategy.md`:

- L0 requires static repository, documentation lifecycle, type, lint, and boundary checks.
- L1 requires package and NanoCore unit coverage for manifest versions, exact inventory verification, graph validation, path and link rejection, remint and stable-id behavior, context reconstruction, workspace SQLite coverage, and staged cleanup.
- L2 requires contract and conformance coverage for V2 export-to-import-to-re-export equivalence, all portable file and row families, exact-set tamper detection, V1 and unsupported-feature rejection, coordinated rollback, and unbound Vault enforcement.
- L3 requires NanoCore process-level coverage for collision reminting, cross-data-root import, fault-injected synchronous rollback, boot or on-demand index rebuild, concurrent-write hot-backup restore, and deployment-lineage validation.
- L4 requires browser-level repository and Vault re-binding coverage without retaining rendered secret material.
- L5 requires a packaged build to export, verify, and import into a fresh data root.
- L6 requires cross-machine continuation with representative full history and authoritative knowledge state after target-side resource re-binding.

Current implemented evidence is narrower than that full acceptance path:

- L1 and L2 tests cover the V2 format, exact verified bytes, canonical and portable state, target-reference reconstruction, synchronous rollback, and package/client/MCP contracts.
- L3 black-box tests currently cover collision reminting, unsupported-feature rejection, and tamper rejection without partial workspace creation. They do not yet cover every fault stage, concurrent-write hot-backup restore, or deployment moves.
- Web component tests cover repository and Vault re-binding, but browser-level L4 acceptance remains open.
- The L5 built-artifact smoke covers export, verification, and import into a fresh target data root.
- The deterministic L6 runner currently uses two same-host temporary deployments and covers accepted knowledge plus repository re-binding. It does not prove cross-machine continuation, full-history equivalence, or Vault-seeded continuation.

Implemented V2 acceptance requires deterministic round-trip equivalence, exact-byte tamper detection, exact manifest file-set enforcement, required remint and stable-id integrity, fail-closed V1 and feature handling, synchronous coordinated rollback, and unbound Vault enforcement. No export may contain a SQLite file or system-managed Vault, provider, or runtime secret material. Concurrent-write hot-backup restore, browser L4, and cross-machine L6 remain release-hardening acceptance work.

## Risks & Mitigations

- Risk: portable dumps drift from live storage ownership. Mitigation: shared record schemas, the workspace SQLite table coverage guard, explicit Core-family tests, app-local state coverage, and round-trip tests.
- Risk: a new source-of-truth file family is omitted. Mitigation: storage ownership changes must classify it as portable or non-portable and add coverage in the same change.
- Risk: reminting changes a stable identity or leaves a target-owned source identity or stale digest. Mitigation: validate source and target graphs, preserve explicitly stable workspace-scoped identities, and recompute identity-dependent context and manifest digests.
- Risk: import fails after writing one storage surface. Mitigation: same-filesystem staging, one Core transaction, and synchronous rollback tests across staged, published, live-store, and Core state. A process crash inside the cross-resource publication window remains a separate recovery gap.
- Risk: users treat an export as a secret-complete or secret-sanitized clone. Mitigation: exclude system-managed secrets and host bindings, import Vault references as `unbound`, expose explicit re-binding, and state that user-authored portable content is not DLP-scanned.
- Risk: hot backup captures a torn append or a newer database snapshot than its copied files. Mitigation: mark the result crash-consistent, verify the captured file inventory, and use stopped-server restore plus existing boot integrity checks. Canonical item and turn-event JSONL readers can discard a syntactically incomplete final fragment; other authoritative ledgers fail closed, and no general cross-authority reconciliation is currently claimed.

## Resolved Decisions

The accepted workspace export version is V2. The canonical archived extension remains `.openkit-workspace.tar.zst` with a product-registered OpenKit workspace export media type. Dry-run performs the same exact-byte verification and collision preview as mutating import without staging or mutation.

## Deferred / Future Work

- Incremental and differential backup.
- Live replication and multi-deployment synchronization.
- Deep compaction beyond item-log snapshot elision.
- User- and server-scope export units, including whole-deployment archival export.
- Web UI surfaces for export and import progress.
- Durable recovery for a process crash inside the workspace-filesystem-to-Core publication window.
- Concurrent-write hot-backup restore validation and any cross-authority reconciliation it proves necessary.
- Browser-level portability acceptance and true cross-machine full-history continuation.

## Links

- `docs/core/storage.md` — this spec answers its backup, export, import, and compaction open point.
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260711-skill_catalog_versioning_pinning.md`
- `docs/nanocore-data-root-config.en.md`
