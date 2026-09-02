---
status: Accepted
implementation: Partial
updated: 2026-09-02
---
# Workspace Backup, Export, Import, And Data-Root Migration
Workspace export format: V2

## Owns

- The workspace export format: export tree layout, root manifest shape, content inventory, and offline verifiability rules.
- Content inclusion, exclusion, and redaction rules for workspace exports.
- Import validation, exact-byte verification, required-feature enforcement, coordinated publication, and rollback behavior.
- The canonical `.openkit-workspace.tar.zst` archive transport, binary App API boundary, request staging, and local-mode bundled CLI projection.
- Workspace id collision handling, subordinate identity reminting, and `importedFrom` lineage rules on import.
- Portable row and reference rewriting for Workspace Material identity, immutable inline revisions, Thread bindings, and version-keyed Artifact Review history.
- Portable-export exclusion and import reconstruction rules for Workspace ownership, membership, invitations, and actor lineage.
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
- Workspace membership, invitation, owner-transfer, role, and user-lifecycle semantics. `docs/specs/20260715-multi_user_workspace_system.md` owns those.
- Canonical-user terminal authentication for server mode. Better Auth owns the current session surface; this specification does not grant a `server-admin` bearer credential Workspace content authority or create another user credential.
- Multi-deployment live synchronization or replication, which are deferred.

## Core References

- `docs/core/storage.md`
- `docs/core/identity.md`
- `docs/core/architecture.md`
- `docs/core/audit.md`
- `docs/core/vault.md`

## Related Docs

- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`

## Summary

The primary export unit is one workspace. Workspace export format V2 is a self-describing, offline-verifiable directory tree whose manifest commits to the exact portable file set and bytes consumed by import. Imports consume only those verified bytes, enforce required features fail-closed, preserve or remint the workspace id with recorded lineage, remint collision-prone target identities and references, and coordinate staged files with transactional Core replay and synchronous compensation on failure. A portable Workspace export carries product truth and actor lineage but no deployment-local access grants; the importing user becomes the new owner and only active member. Backup is data-root-level: a cold copy is the baseline, and a hot backup captures the file tree first and individual SQLite snapshots second. Data-root migration is a config repoint validated at boot. System-managed Vault, provider, and runtime secrets never enter workspace exports; exports carry only non-secret vault reference metadata that lands `unbound`. User-authored portable content is not a sanitized or DLP-scanned channel.

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

The export unit is one workspace, serialized as a plain V2 directory tree with an envelope-wrapped manifest and per-file digests. The canonical transported form is that exact tree streamed as `.openkit-workspace.tar.zst`; transport introduces no second manifest or server archive registry. SQLite never travels inside an export: portable source-of-truth rows are dumped as line-oriented records, and derived indexes are omitted so their existing owner can rebuild them at boot or on demand. Import is manifest-verified, fail-closed on unknown required features or incomplete lineage, and coordinated through same-filesystem staging, one Core transaction, and synchronous compensating rollback. This does not create a transaction spanning the filesystem and SQLite across a process crash. V1 is intentionally incompatible and rejected rather than migrated. Backup operates on the whole data root, cold by default, hot with an ordered file-tree-then-SQLite-snapshot procedure. Data-root migration is supported by repointing server config and letting boot verification validate the moved tree.

## Contract / Expected Behavior

### Export Unit And V2 Manifest

- The primary export unit MUST be one workspace. Exports of other scopes are not defined by this spec.
- An export MUST be a directory tree. Its canonical transported form MUST be one Zstandard-compressed POSIX tar archive with extension `.openkit-workspace.tar.zst` and media type `application/vnd.openkit.workspace-export+tar.zstd`; the archived form contains the identical tree and no wrapping directory, second manifest, or transport record.
- The export root MUST contain `openkit-workspace-export.json`, carrying the common record envelope with `recordType: workspace-export`, workspace ownership and lineage, source deployment id, workspace id, export timestamp, `requiredFeatures`, and the content inventory.
- The manifest MUST declare `exportFormatVersion: 2`. Importers MUST reject V1 and every other version; no compatibility adapter or in-place upgrade is defined.
- The content inventory MUST list every non-manifest file exactly once with its relative path, byte length, and SHA-256 digest. The manifest `contentDigest` MUST be the SHA-256 digest of the exact JSON serialization of that inventory.
- The verifier MUST reject duplicate inventory paths, links, unsafe paths, unsupported file types, digest or byte-length mismatches, absent listed files, and non-manifest files absent from the inventory.
- Export creation MUST own a previously absent export root, write the manifest last, verify the completed tree before returning it, and remove that owned root if any step fails.
- Export preflight MUST reject a Workspace containing any unresolved `user-input-request` before creating the export root. The V2 verifier and importer MUST independently reject any input containing one, including input produced by another implementation or deployment. Product-safe diagnostics MUST identify the blocking Item ids. Completed historical request and response Items remain portable lineage, but no portable import may reactivate a source responsible-user identifier as target authority.

### Required Portable Contents

V2 MUST include the complete canonical workspace history, not only current projections:

- the workspace record, thread records, turn records, every item revision, and the complete turn-event history
- artifacts with their canonical bodies and metadata, version-keyed Artifact Review history, and AgentSession records
- knowledge entries, knowledge sources, and registered source material

Generated Knowledge Proposal and Knowledge Review owners are actionable source-Workspace authority and MUST NOT enter the clone/remint export. Accepted Knowledge Pages remain portable as ordinary authoritative page bytes. Complete data-root backup and restore preserve Proposal and Review files without changing their Workspace identity; that operational backup path is not portable Workspace import. Export MUST omit, and import MUST reject, the legacy `records/knowledge-proposals.jsonl` and `records/knowledge-proposal-reviews.jsonl` paths rather than reminting, weakening, or silently ignoring them.

V2 MUST include the complete Phase 1 Material and Artifact Review row graph under these exact record paths:

- `records/workspace-materials.jsonl` for every `WorkspaceMaterial`
- `records/workspace-material-revisions.jsonl` for every immutable `WorkspaceMaterialRevision`, including its exact inline canonical UTF-8 `content`
- `records/thread-material-bindings.jsonl` for every `ThreadMaterialBinding`, including unbound history retained by the source Workspace
- `records/artifact-reviews.jsonl` for every version-keyed `ArtifactReview`

All four paths are present even when their family is empty. The three Material paths are the only portable Material content representation: V2 MUST NOT invent a Material content directory, export a `contentRef`, or duplicate revision bytes as files. `artifact-reviews.jsonl` carries one row per `(workspaceId, artifactId, artifactVersion)` rather than the current Artifact-id-only file projection.

V2 MUST include all existing records from these four authoritative file-backed ledger families:

- knowledge observations
- knowledge claims
- complete knowledge conflict append history, not only the latest conflict projection
- knowledge retrieval traces

V2 MUST also include the exact portable workspace file state:

- the system-owned `workspace-record.json`, Workspace `config/workspace.jsonc`, and the custom workspace knowledge schema
- native OKF knowledge pages

The exported `workspace-record.json` carries no editable `name` or execution defaults. `config/workspace.jsonc` carries the Workspace name, shared `defaultAgentId`, and the other accepted portable Workspace composition. Export and import MUST reject the removed `workspace.json` path, a record containing `name` or `defaults`, a config missing its required name, or duplicate ownership of one moved field; they never translate the old shape.

Portable workspace-scope database rows MUST be emitted as strict line-oriented records rather than as a database file. This includes the accepted Material and Artifact Review families plus the implemented audit, capability and usage, repository and Git, Goal Mode, permission and checkpoint, resolved setup and redacted Agent Environment Package, workspace synchronization and apply, worker-side MCP schema, vault-reference and grant, injection, and vault-use families. The workspace SQLite coverage guard MUST classify every table in `workspace.sqlite` as portable or explicitly non-portable. Core-owned vault and injection families remain explicit exporter, importer, and focused-test responsibilities; the workspace SQLite guard does not claim to inventory Core tables.

Workspace Export V2 MUST serialize the complete non-secret plan and receipt families at exactly `records/vault-injection-plans.jsonl` and `records/vault-injection-receipts.jsonl`. Both paths are present even when empty. The verifier and importer MUST reject `records/injection-plans.jsonl` and `records/injection-receipts.jsonl` as unsupported old paths; they MUST NOT translate, merge, ignore, or dual-read them.

Future evaluation or worker-Skill mechanisms do not enter export scope merely because a Draft mentions them. Any later accepted design that creates Workspace-owned durable records MUST update this specification and its coverage guard in the same change; no current evaluation-area or Skill Catalog record family is authorized.

### Non-Portable And Redacted State

- System-managed Vault material, provider credentials, session cookies, access tokens, runtime credentials, and backend secrets MUST NOT appear in an export.
- Portable resolved-agent-setup rows MUST contain only the S22 redacted whitelist projection. Export and import both apply that projection rather than trusting stored or supplied `setup` JSON, so open manifest extensions, workspace environment payloads, provider secret references, and other unowned pass-through fields cannot cross the portability boundary.
- Active memberships, removed membership tombstones, invitations, auth sessions, personal preferences, and user-local notification state MUST NOT appear in a portable Workspace export.
- Stable actor references in product history and audit MUST remain as non-authority lineage. Import MUST NOT interpret a source owner, member, approver, reviewer, or actor id as a target-deployment access grant.
- Imported Approval, `PermissionDecision`, and `VaultGrant` rows are readable historical evidence only. `apr_imported_` and `grant_imported_` are reserved non-authorizing import namespaces: target-side Approval and VaultGrant creation MUST reject those prefixes, while the importer MUST retain the existing target-owned `apr_imported_<targetWorkspaceId>_*` and `grant_imported_<targetWorkspaceId>_*` identities on every rewritten reference. An effect consumer MUST reject an authority tuple carrying either imported identity even after the repository path or Vault reference has been rebound. An imported allow decision without a linked target-issuance identity is also non-authorizing and fails closed; consumers MUST NOT infer its origin. A target effect requires a fresh target-issued Approval and permission decision, or a fresh target-issued Vault grant, as applicable; re-binding restores a resource location or secret reference, never source-deployment authority.
- Material and Review request fields travel only as historical mutation lineage. Deployment-local idempotency or command-receipt rows remain non-portable unless their owning specification explicitly classifies them otherwise, and import MUST NOT make a source actor or receipt an authorization edge on the target. Cross-deployment replay of a pre-export Material or Artifact Review command is intentionally unsupported.
- User-authored artifacts, knowledge, source material, and workspace configuration are portable content and are not generically secret-scanned. Operators and product surfaces MUST NOT describe an export as sanitized user content.
- Vault references MUST export only non-secret reference metadata. On import they MUST enter the `unbound` state and require explicit re-binding before use.
- Backend-native handles, host paths, active Sandbox details, runtime compatibility keys, AgentSession policy-snapshot bindings, and similar source-host state MUST be excluded or reduced to an explicitly redacted portable summary.
- Derived indexes, SQLite database files, host-local filesystem staging roots, caches, scheduler queues, leases, capacity records, and target health MUST NOT export. They are rebuilt or re-established on the target deployment.
- An unresolved or not-yet-cleaned S16 `PendingUserTurnRecord` is active delivery state rather than portable history. Workspace export MUST return typed `409 conflict` while one exists; it MUST NOT omit the user's pending input, export the row without its live Goal and claim owner, or invent an import-time steering replay contract. After winner-owned cleanup, the original Items and any completed Core-local follow-up history Turn remain portable, but deployment-local steering command records and their proof snapshots remain non-portable; import therefore reconstructs no `activeDelivery`, terminal steering command replay, or cancelled-delivery projection from that history. This is the accepted bounded portability compromise rather than a portable delivery ledger.
- Restricted raw evidence follows its retention class; export MUST NOT widen its visibility.

### Verification And Import

- Verification MUST validate the manifest envelope and `requiredFeatures` before creating any target state.
- The verifier MUST read each inventoried file once and return those verified bytes. Dry-run and mutating import MUST parse only that verified byte set and MUST NOT reopen export content after verification.
- Every server-managed export handle, regardless of its recorded deployment lineage, MUST remain private to the current source Workspace owner with `workspace.export` authority. An unrelated-deployment handle is rejected rather than treated as portable input; foreign portable input enters only as the one-shot streamed archive body defined below and never becomes a readable server handle.
- The importer MUST reject unsupported `requiredFeatures` declared by the manifest or any imported record, and the diagnostic MUST name the unsupported identifier.
- The importer MUST validate both the source canonical history graph and the reminted graph before creating target state. Duplicate identities, stale turn projections, non-contiguous events, invalid event targets, and dangling lineage MUST fail import.
- When the workspace id does not collide anywhere in the target deployment, the importer MUST preserve it. The deployment-wide Workspace registry, final owner-independent Workspace path, and any staged import participate in collision detection; when any target state already claims the id, the importer MUST mint a new Workspace id.
- A successful portable import MUST transactionally record the authenticated importing user as the new canonical owner and only active member. Source-deployment ownership, membership, invitation, and token records MUST NOT be reconstructed. Every successful import MUST record `importedFrom` with source deployment id, source workspace id, export timestamp, and manifest digest and MUST emit a Workspace import audit event.
- Identities that would collide in the live store or belong to a target-runtime namespace MUST be reminted. The implemented set includes Thread, Turn, Item, Artifact, Approval and user-input request, AgentSession, Agent Environment Package snapshot and package, knowledge source, Goal Mode, and Vault reference, grant, `VaultInjectionPlan`, and `VaultInjectionReceipt` identities. The accepted portability target additionally rewrites Goal Task `latestGateContextItemId` through the same Item map and requires its matching request Item after import. The accepted target also adds Material and Material Revision identities to collision detection. Stable Workspace-scoped knowledge entry, observation, claim, conflict, retrieval trace, evidence, and other ledger identities MAY be preserved because the imported Workspace remains their ownership boundary. Every affected direct or nested reference MUST be rewritten, and a missing or ambiguous required source reference MUST fail import.
- The Material importer MUST first validate each Material as one complete linear parent graph. A Material with `currentRevisionId=null` has no revisions. A non-null Material has exactly one revision with `parentRevisionId=null`; every other revision names one revision of the same Material as its parent; no revision has more than one child; and following parents from `currentRevisionId` visits every retained revision exactly once and ends at that null-parent root. `createdAt` is not ordering authority. Every binding queue names a revision of its Material, every revision's `mediaType` matches its Material kind, and `contentDigest` verifies the exact inline content bytes. The importer then applies the Workspace, Material, and Revision id maps to `WorkspaceMaterial.currentRevisionId`, every revision owner and parent, every binding owner and `latestQueuedRevisionId`, and all mutation-lineage references before validating the same graph again. Inline content, media type, and content digest remain byte-identical; import does not synthesize a newer current revision.
- The Artifact Review importer MUST validate one row per exact Artifact version before mutation. An unresolved Review requires the current ready Artifact to retain that exact version, digest, canonical bytes, and origin. A decided historical Review retains its version and digest without requiring a historical Artifact body; import validates its existing result owners instead, including the exact applied Material revision for an accepted proposal or the exact follow-up Turn for refinement or redo, and MUST NOT synthesize Artifact version history. It preserves decision history, rewrites Workspace, Artifact, source Thread, source Turn, and follow-up Turn references through the existing maps, and recomputes deterministic `reviewId` from the target `(workspaceId, artifactId, artifactVersion)`. `sourceAgentId` is not independently reminted: it MUST equal the imported source Turn's preserved non-authorizing historical `agentId`, and import neither requires nor creates a target Agent with that id. On a later refinement or redo, the historical id is only an exact selector; the target Workspace's current Agent catalog must independently contain that enabled Agent, otherwise the command returns `409 stale` with the Review unresolved and zero writes. Import, decision, and execution MUST NOT remap the id or substitute a default Agent; accepted apply, rejection, and deferral remain available without that Agent because they create no worker attempt. For a non-null `materialProposal`, source validation and the reminted target graph MUST each prove that the tuple exactly matches the source Turn's unique accepted S39 `materialSelections` entry; the importer also rewrites `materialId` and `baseRevisionId`, requires that base revision to belong to the target Material with the unchanged verified `baseContentDigest`, and rewrites nullable `appliedMaterialRevisionId`. A non-null applied revision is valid only for `decision=accepted`, must belong to the same target Material, have the rewritten base as parent, carry the Review's exact digest and the Material-compatible content and media type, and share the rewritten decision request lineage; an accepted non-null proposal requires that applied reference, while every null proposal or non-accepted decision requires it to remain null. The applied revision may be historical rather than the current pointer after later saves. A duplicate pair, unresolved-version mismatch, digest disagreement, dangling source, proposal, S39, base, applied-revision, or follow-up lineage, invalid decision/result combination, or contradictory Workspace Sync exclusion MUST fail import. Portable Workspace import preserves the Artifact's original product origin; it is not the workspace-only Artifact import command that creates an `origin=imported` Artifact without Review authority.
- Every non-null `WorkspaceMaterial.lastMutationRequestId`, `WorkspaceMaterialRevision.createdByRequestId`, `ThreadMaterialBinding.lastMutationRequestId`, and `ArtifactReview.decisionRequestId` is rewritten with every matching portable lineage reference to `import-lineage:sha256:<digest>`, where `<digest>` is 64 lowercase hexadecimal characters from SHA-256 over the exact UTF-8 sequence `sourceDeploymentId`, one zero byte, `sourceWorkspaceId`, one zero byte, and the original request id. This reserved token is historical lineage only: Material and Artifact Review command handlers reject a caller `requestId` beginning with `import-lineage:` as `400 invalid_request`, never consult such a token for receipt reconstruction, and never publish a command receipt from it. The atomic target import owns the complete imported row graph, so absent source command receipts are not a recovery half-state; the first post-import mutation writes its ordinary caller request proof and receipt under S16.
- The S39 worker Context Package trace and materialization MUST remain one canonical graph after import. The importer MUST rewrite every affected selected record id, path, policy snapshot, package manifest, and source reference, then recompute non-index file digests, write the worker-visible `package.json` inventory without a self-entry or `contextPackageDigest`, compute that completed file's digest, populate the Turn trace `fileInventory`, and compute `contextPackageDigest` last. A worker-Turn trace identity is exactly `ctxpkg_${turnId}` and its canonical path contains the Turn id, so reminting that Turn MUST recompute both identity and path and rewrite every reference. No standalone Knowledge context-package trace or materialization is portable.
- When a canonical Knowledge entry or native accepted Page cites `context-package:<turnId>@<contextPackageDigest>`, import MUST wait until the target trace digest is recomputed, record the exact source-reference to target-reference replacement, and apply that same replacement to both representations before their one-to-one equality check. Rewriting only the Turn id while retaining the source digest is contradictory and fails import.
- A worker-Turn trace rewrite covers `workspaceId`, `threadId`, `turnId`, `requestId`, nullable `goalId` and `taskId`, `agentSessionId`, `packageSnapshotId`, `workerRequestItemId`, `workspaceInputSnapshotId`, `workspaceMaterializationRecordId`, `includedItemIds`, every excluded Item id, `knowledgeSelectionInput`, every Knowledge selection or package-budget exclusion id, digest, source reference and package path, every Material selection or exclusion id and package path, and every file-inventory path. Reminted Knowledge Source or Page identities MUST rewrite the S61 retrieval row, the selected canonical page bytes, every `sourceRefs` value, and the corresponding selected or excluded content digest before dependent package and inventory digests are recomputed. The importer then recomputes `workerRequestDigest` only from the rewritten Item's exact compact bytes and recomputes the Context Package and dependent manifest digests; it MUST reject any lineage or byte mismatch rather than preserve a stale source digest.
- When a Material or Revision id changes, the Context Package rewrite MUST also update every `materialSelections` and `materialExclusions` tuple, `workspace/materials/<materialId>/<revisionId>.*` package path, file inventory entry, Workspace Input Snapshot, and Workspace Materialization Record that names it before recomputing the trace, package, file, entry, and export-manifest digests. Import MUST reject a trace that selects a missing revision, a different digest, or restricted Material.
- Each set of imported worker-Turn AEP, Turn, worker-request Item, Material, and Review references that shared one original request id MUST use the reserved `import-lineage:sha256:<digest>` derived from that request; references from different original requests use their own independently derived tokens. The importer rewrites the Context Package Workspace Materialization Record's `workerSessionId` to exactly `import-history-worker_${packageSnapshotId}` and rewrites any sandbox readiness-evidence `ref` that equalled the source worker-session id to that same redacted value; it preserves only product-safe backend kind and readiness labels and recomputes the policy digest from the reminted package snapshot and unchanged required-capability order. No scheduler admission, lease, Worker Backend Session, target-ready handoff, credential, or runtime handle is synthesized.
- After the complete reminted graph is staged, the importer MUST use S39's separate imported-history verifier while the target Workspace's staged `importedFrom` lineage is present. The verifier requires every portable owner and exact package byte but intentionally omits the non-portable runtime authorities above. Its result may validate historical projection and an imported version-keyed Artifact Review's same-Turn Material tuple; it MUST NOT authorize worker launch, replay, reconnect, steering delivery, capability use, credential use, or an external effect. Ordinary source traces use strict S39 verification; a source Workspace that already contains a reserved imported-history trace uses the same bounded history predicate and retains that classification through re-export. Missing `importedFrom`, a request lineage outside the reserved namespace, or any contradictory portable owner fails import rather than selecting the historical branch, and no source or target path may promote history into accepted delivery.
- Imported AgentSessions are historical attribution only. Import MUST preserve their reminted Thread and Turn lineage, drop source-host Sandbox, Workspace-root, config-version, policy-snapshot, compatibility-key, native-handle, and runtime-binding state, and set every imported AgentSession to terminal `closed` plus `stale=true`. Import never creates a current AgentSession or runtime authority; a later authorized target Turn creates one through ordinary continuity admission.
- The importer rewrites `workspace-record.json` to the preserved or reminted target Workspace identity and target owner relationship while preserving eligible source lifecycle lineage. It preserves the verified `workspace.jsonc` name and shared configuration as portable Workspace content, except that target authorization, Server supply availability, credential bindings, repository paths, and runtime readiness are revalidated by their owners and are never imported as authority.
- Imported repository resources MUST drop source-host local paths and require target-side re-binding. Imported vault references MUST be reminted as `unbound` records without backend locators or secret material.
- Repository and Vault re-binding MUST NOT activate imported authority. Git push and secret-injection effect owners use one stateless target-issuance check over the existing reminted Approval or VaultGrant identity before remote mutation or secret resolution; failure is a typed policy refusal or fail-closed authorization error with zero external effect. No import-specific permission lifecycle, compatibility adapter, or recovery record is created.
- Derived indexes MUST NOT be trusted or imported. The current owner rebuilds them from imported authoritative state on the next NanoCore boot and when the derived Knowledge Store index surface is read; live import does not synchronously rebuild them.
- Import MUST provide coordinated all-or-clean behavior for synchronous request failures: it stages workspace files and the workspace database on the target filesystem, wraps publication and Core-row replay in one Core transaction, rolls back Core rows on error, and removes staged or already published imported files and live-store state when an error is caught. Filesystem publication and SQLite commit are not one crash-atomic transaction; a process crash between them remains an explicit recovery window.
- Import request failures MUST return stable product-safe messages and MUST NOT expose the data-root path, export storage path, database error, or other deployment internals.

### Portable Archive Transport

- Archive download MUST reverify the existing server-managed export tree before sending a response, traverse the verified inventory in canonical path order, and stream tar then Zstandard output without buffering the complete archive or creating a second server-side archive. Tar directories use mode `0755`; regular files use mode `0644`; uid, gid, uname, gname, and mtime are zero or empty canonical values. Import treats tar metadata as non-authorizing and always creates private target staging with the fixed modes below.
- Every archive file and derived directory path MUST be representable without an extension entry by the POSIX USTAR `name` and `prefix` fields: the exact UTF-8 name is at most 100 bytes, an optional prefix is at most 155 bytes, and their split occurs only at an existing slash. Export creation and offline verification MUST reject a noncanonical or unrepresentable path before accepting the export tree; archive production MUST NOT emit PAX, GNU long-name, or another extension entry.
- Archive download requires the current source owner and the `workspace.export` product operation. `workspace.read` alone is insufficient. A foreign-deployment export handle is never a readable or enumerable public server object, and a `server-admin` credential never bypasses source Workspace authority.
- Archive dry-run and mutating import MUST accept one streamed request body and MUST NOT publish it as a durable export handle, archive registry row, reusable upload, or server content address. The authenticated importer is target authority; foreign deployment and source actor identifiers remain lineage only.
- The current archive ceilings are exactly 8,589,934,592 compressed request bytes, 34,359,738,368 expanded tar bytes, 200,000 total tar entries including directories, and 2,147,483,648 bytes for one regular-file entry. A declared content length above the compressed ceiling fails before body consumption; missing or legal chunked length remains allowed, but observed bytes enforce every ceiling during streaming. These are fixed Phase 1 trust-boundary constants, not operator configuration.
- Request staging lives only under the dedicated server archive-request staging namespace. Each request owns one newly created `0700` directory and `0600` regular files created with exclusive no-link semantics. Extraction rejects absolute, empty, non-UTF-8, backslash, dot, dot-dot, noncanonical, duplicate, case-colliding, or NUL/control paths and every symlink, hard link, device, FIFO, socket, sparse entry, unsupported extension entry, extra file, missing file, size mismatch, and verifier failure.
- Dry-run parses only the verified staged bytes, returns the existing collision and verification report, and removes its staging in request `finally`. Mutating import consumes the same verified bytes through the existing coordinated import owner and removes its staging after success or caught failure. A running request removes only its own directory; listener-preflight boot cleanup may remove the complete dedicated request-staging namespace because no request can then be active. No ordinary operation scans or removes another request's staging.
- A same-deployment archive still requires the current source owner and `workspace.export` authority before dry-run or import. A foreign archive has no target source membership to check. Both preserve the source Workspace ID when the accepted collision predicate reports it available and use the existing deterministic remint rule otherwise.
- A process crash may leave non-authorizing request staging, and a process crash inside the existing filesystem-to-Core import publication window retains that owner's explicit recovery gap. Staging presence never authorizes import, repair, replay, or Workspace publication.

### Public Portability Surfaces

- NanoCore retains the server-managed JSON export, dry-run import, and mutating import handles and adds `GET /api/app/workspaces/:workspaceId/exports/:exportId/archive`, `POST /api/app/workspace-archives/import-dry-run`, and `POST /api/app/workspace-archives/import`. The two POST routes require the exact archive media type; mutating import additionally requires one non-empty `x-openkit-request-id` header and returns the existing JSON import result only after the body is fully verified and consumed.
- `@openkit/core-client` exposes stream-oriented archive download, dry-run, and import methods. The transport-neutral operation catalog, bundled CLI, and unified Skill project `workspace.archive-download`, `workspace.archive-import-dry-run`, and `workspace.archive-import`; they never base64-encode archive bytes or expose a server filesystem path.
- The supported bundled CLI archive path is local mode with its implicit canonical user. Download creates the caller's exact destination as a non-link regular file with `O_CREAT|O_EXCL` and mode `0600`; it refuses overwrite and leaves an exclusively created partial destination in place after transfer failure rather than using a pathname cleanup race. Dry-run and import open the caller's exact source as one regular non-link file and verify that identity remains stable through stream acquisition. Server-mode users retain Better Auth session surfaces; this change adds no cookie jar, user-login command, canonical-user bearer token, or `server-admin` content bypass.
- Workspace vault-reference discovery and re-binding accept secret material only as input, store it in the active target vault backend, and return only redacted reference metadata.
- The Web portability surface supports repository and vault-reference re-binding after import or migration without retaining secret material in rendered state.

### Backup And Restore

- Cold backup is the baseline: with NanoCore stopped, a byte copy of the entire data root is a complete, clean backup.
- A full data-root backup includes the Core database and therefore preserves canonical users, Workspace owners, memberships, invitations, and token metadata for restoration as the same deployment. This is intentionally different from a portable Workspace export.
- Hot backup MUST copy the file tree first and then snapshot every SQLite database through the SQLite backup API. The manifest marks the result crash-consistent at the copied-file and individual-database level; it does not claim one transaction or automatic reconciliation across a newer database snapshot and older copied files.
- A backup MUST carry a manifest with capture timestamps, source deployment id, mode, consistency, exact file inventory, and per-file digests. The implemented offline verifier rejects links, extra or absent files, unsafe paths, digest mismatches, and unsupported required features. Its implemented integrity boundary is the parsed manifest plus the verified per-file inventory; unlike workspace V2 verification, it does not separately recompute the manifest `contentDigest` from that inventory or independently authenticate the manifest.
- Restore MUST verify before mutation, replace the target data root through same-filesystem staging and rename, then reuse boot-time SQLite integrity recovery, migrations, derived-index rebuild, and runtime restart recovery. Restore remains a stopped-server operator operation rather than a live App API or operation-catalog mutation.

### Data-Root Migration

- Every newly initialized data root MUST mint and persist a unique deployment id before producing deployment-scoped records. A marker that predates deployment identity MUST receive one unique id exactly once during layout normalization; subsequent boots MUST preserve it.
- Moving a data root to a new path or host MUST be supported by pointing server config at the moved tree. Product records MUST NOT embed absolute data-root paths.
- A linked host-local repository `localPath` is invalid when its normalized absolute path equals or is a path-segment descendant of the normalized absolute data root, or when the existing repository directory's real path equals or is a path-segment descendant of the data root's real path. A sibling whose name merely shares the data-root string prefix is not a descendant, and a lexically normalized external repository remains eligible. Missing or inaccessible paths, a non-directory candidate, or failure to resolve either required real path fails closed with no raw host path in the diagnostic.
- This containment rule protects the existing legacy repository resource while it is removed. It does not authorize a NanoCore host path as a remote Agent Runtime source; that boundary belongs to `docs/core/storage.md` and `docs/specs/20260704-workspace_data_source_catalog.md`.
- Repository configuration MUST complete that containment check before changing the repository row or data-source catalog. Turn admission MUST repeat it before Turn-time catalog synchronization or creation of any scheduler admission entry, capture the one validated canonical repository real path, and use only that captured path for the Turn's `workspaceCwd` and repository `workspaceRoots`; it MUST NOT re-read the authored or symlink spelling for that Turn. A failed check preserves the previous repository resource and catalog and creates no admission, lease, AgentSession, or backend effect. Retry is a new request against the then-current path and grants no automatic rewrite, quarantine, migration, repair, or cleanup authority.
- This specification owns only the exclusion that prevents a linked repository from entering the data root. The Workspace repository row and data-source catalog, scheduler admission, AgentSession, and Workspace materialization owners retain their existing lifecycles and consume this exclusion without transferring authority here.
- Boot layout verification validates the moved tree before the server serves traffic.
- When a move changes the deployment id, the new deployment MUST preserve the predecessor id so future exports carry truthful lineage.

### Retention And Deletion Interaction

- Workspace deletion MUST produce the sealed audit closure export defined in `docs/specs/20260703-audit_usage_evidence_records.md` before removal.
- Records under `legal-hold` retention block deletion until the hold is released. This spec adds no retention semantics.

### Compaction

The only permitted compaction is the item-log snapshot compaction already allowed by `docs/core/storage.md`: completed-item snapshots that change no item ids, causation links, or final meaning.

A compacted export MAY omit item-log segments superseded by such snapshots only when replay equivalence is preserved and the manifest records the compaction and elided segments. Deep compaction remains deferred.

## Accepted Design

The exporter reads canonical source records, validates the complete workspace graph, writes the portable V2 tree into a newly owned root, computes the exact content inventory, writes the manifest last, and immediately verifies the result. Material canonical content remains inline in its revision rows, and Artifact Review remains keyed to the exact exported Artifact version. The importer verifies once, parses the verified bytes, validates the source and target graphs, remints only identities that require target ownership, rewrites every Material, Review, and Context Package reference, writes target files and the workspace database through same-filesystem staging, and coordinates publication with transactional Core replay and synchronous compensation. Derived indexes stay absent until their boot or on-demand owner rebuilds them. Backup and migration tooling remain thin procedures over the data root and reuse existing boot integrity and rebuild behavior without claiming cross-authority reconciliation.

## Current Implementation

V2 is the implemented and only accepted workspace export format. NanoCore exports and imports complete canonical history, all four authoritative knowledge ledgers, workspace configuration and schema, native OKF pages, S39 worker Context Package materializations, portable file and database row families, and source materials. The verifier owns the exact byte set consumed by dry-run and import, and the importer performs fail-closed source and target graph validation, required target-namespace reminting, stable knowledge-ledger identity preservation, context digest and policy reconstruction, same-filesystem staging, transactional Core replay, and compensating rollback for caught synchronous failures.

The current implementation exports and imports `records/workspace-record.json` as system-owned identity and lifecycle data and `config/workspace.jsonc` as editable Workspace composition. It rejects the removed `workspace.json` path, record-owned `name` or defaults, and a config missing its required name; prior internal exports are regenerated rather than upgraded.

The three Material row families, version-keyed `artifact_reviews` rows, and S39 Context Package traces now participate in one implemented portable owner graph. Export validates exact worker-trace coverage and emits the complete related rows; import validates the source graph, remints Material, Revision, Binding, Review, request, Item, Thread, Turn, and trace references, recomputes dependent package identities and digests, validates the target graph again, and preserves imported-history traces as non-authorizing history. Inline Material content remains byte-identical, the obsolete Artifact-id-keyed file owner is deleted, and a focused export-import-re-export-re-import fixture proves this related Material, Review, and S39 subgraph without claiming that every other portable family has the same second-cycle proof.

The public App API, Core Client, transport-neutral operation catalog, bundled CLI, and unified Skill surfaces for `backup.create`, `backup.verify`, `workspace.export`, `workspace.archive-download`, `workspace.archive-import-dry-run`, `workspace.archive-import`, `workspace.import-dry-run`, and `workspace.import`, plus vault re-binding, data-root backup and verification, stopped-server restore, deployment lineage, and the pre-existing data-root migration validation are implemented. Archive production, export creation, and offline verification share one strict USTAR path owner, while archive imports use bounded private request staging. A two-fresh-runner GitHub Actions proof uses the bundled local-mode CLI to transfer one archive artifact, verifies the same archive SHA-256 on both runners, imports the complete history and semantic graph, rebinds repository and Vault references under target authority, mutates target knowledge, and completes re-export and dry-run without claiming re-export byte identity or L6 evidence. The linked-repository containment guard is also implemented: one shared inspection distinguishes a clear path from DATA_ROOT containment and unresolved canonical proof, repository configuration rejects contained or unresolved candidates before row or catalog mutation, Turn admission captures one canonical repository real path before catalog or scheduler mutation, and repository Workspace Root projection discards conflicting authored roots rather than the captured canonical root. Owner-independent Workspace publication, explicit exclusion of multi-user access records, new-owner-only import reconstruction, cross-resource crash recovery, concurrent-write hot-backup restore validation, and browser-level portability acceptance remain incomplete. The workspace SQLite table coverage guard and app-local portable-state tests protect the implemented V2 boundary when storage ownership changes.

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

V2 replaces V1 without compatibility obligations. Existing V1 exports and internal V2 exports carrying the removed `workspace.json` path MUST be rejected and regenerated from their source workspaces. Future workspace-owned authoritative families MUST join export and import coverage in the same change that introduces their storage ownership; derived or server-local families MUST be explicitly classified non-portable.

The completed Material and Artifact Review portability implementation adds the three Material JSONL families, replaces the Artifact-id-only Review portable schema with the version-keyed row, extends the Workspace SQLite coverage guard, and validates both the source graph and reminted target graph in the same change. Context Package and workspace-handoff references are rewritten in that implementation; no later repair pass or compatibility reader exists.

The multi-user implementation change MUST update V2 coverage and import tests in the same slice that moves Workspaces to the owner-independent root. It MUST prove that access records never travel in a portable export and that import grants access only to the importing user. No second export version is required unless the portable byte contract itself changes.

## Testing Strategy / Acceptance Criteria

The required acceptance path maps to the L0-L6 model in `docs/specs/20260529-test_strategy.md`:

- L0 requires static repository, documentation lifecycle, type, lint, and boundary checks.
- L1 requires package and NanoCore unit coverage for manifest versions, exact inventory verification, graph validation, path and link rejection, remint and stable-id behavior, context reconstruction, workspace SQLite coverage, and staged cleanup.
- L1 linked-repository containment fixtures require normalized exact and descendant DATA_ROOT paths plus a symlink alias into DATA_ROOT to fail closed; a sibling-prefix path and a normalized external repository must remain accepted. Configuration rejection must leave the prior repository row and data-source catalog byte-for-byte unchanged. Turn-time rejection of a stale, retargeted, missing, inaccessible, or unresolvable repository must occur before catalog synchronization and leave zero new scheduler admission entries, leases, AgentSessions, and backend effects, while a successful Turn must use one captured canonical repository path for both `workspaceCwd` and its repository Workspace Root.
- L2 requires contract and conformance coverage for V2 export-to-import-to-re-export equivalence, all portable file and row families, exact-set tamper detection, V1 and unsupported-feature rejection, coordinated rollback, and unbound Vault enforcement.
- L2 Material fixtures require byte-identical inline-content round trip, stable or collision-reminted identity with complete pointer and parent rewriting, binding queue preservation, and rejection of missing, cyclic, cross-Material, media-type-mismatched, or digest-invalid revisions. No export fixture may contain a Material content file or `contentRef`.
- L2 Artifact Review fixtures require one history row per exact Artifact version, deterministic target `reviewId`, preserved version and decision, rewritten source and follow-up lineage, and rejection of duplicate pairs, missing versions, digest mismatch, dangling lineage, or Workspace Sync ownership conflict.
- L2 Context Package fixtures require every reminted Material and Revision reference and package path to change coherently and every dependent digest to be recomputed; restricted Material selection, stale or missing revisions, and any portable-byte or owner tamper fail closed. One valid imported-history fixture contains zero target scheduler admissions, leases, and Worker Backend Sessions; the strict verifier rejects its reserved trace even when matching runtime lookalikes are injected, the history verifier accepts only the complete portable graph, and re-export plus re-import preserves the historical classification.
- L2 imported unresolved Artifact Review fixtures prove that a current target actor may accept or apply from the exact current Artifact bytes, verified historical same-Turn tuple, current target Material base, and fresh target request proof regardless of historical Agent availability. Refinement or redo additionally requires a currently enabled target Agent whose id exactly equals historical `sourceAgentId`; absence returns `stale` with zero writes and no substitution, while presence may reserve a new target Turn only when later execution obtains fresh target-local admission, AgentSession, lease, backend handoff, and strict S39 trace. Every imported AgentSession is terminal `closed`, carries no target runtime binding, and imported runtime history never authorizes execution.
- L2 also requires fixtures proving memberships, invitations, credentials, and personal state are absent; historical actor references remain lineage only; and import creates exactly one target owner membership.
- L2 archive fixtures require exact media type, rejection of unrelated-deployment server-managed handles, fixed streaming ceilings, private exclusive staging for archive dry-run and import, malicious tar metadata and path rejection, request-local cleanup, concurrent request isolation, CLI no-overwrite behavior, and the same preserve-or-remint collision result as server-managed import.
- L3 requires NanoCore process-level coverage for owner-only archive download, local-mode CLI cross-data-root import, collision reminting, fault-injected synchronous rollback, boot or on-demand index rebuild, concurrent-write hot-backup restore, and deployment-lineage validation.
- L4 requires browser-level repository and Vault re-binding coverage without retaining rendered secret material.
- L5 requires the packaged NanoCore server to boot with a disposable data root, serve successful JSON from the health and API-readiness endpoints, and exit cleanly after `SIGTERM`.
- L6 remains the agent-first story acceptance layer for cross-machine continuation with representative full history and authoritative knowledge state after target-side resource re-binding; a fixed mechanical transfer is not classified as L6.
- A fixed two-job GitHub Actions proof runs the real local-mode bundled CLI against one fresh source data root and one fresh target data root. The jobs transfer the original archive through the workflow artifact owner and compare its SHA-256 before and after transport, then compare the specification-defined semantic graph, complete history, authoritative knowledge, explicit repository and Vault re-binding, and target behavior after import and re-export. Re-export archive and manifest digests are not equality oracles because deployment, export, and lineage metadata truthfully change. This proof is L3 public-process coverage plus L5 artifact-transport smoke.

Current implemented evidence is narrower than that full acceptance path:

- L1 and L2 tests cover the V2 format, exact verified bytes, the currently implemented canonical and portable families, target-reference reconstruction, synchronous rollback, and package, client, and operation-catalog contracts. The Material, version-keyed Artifact Review, and S39 subgraph coverage includes exact source and target validation, identity and request-lineage reminting, inline-content preservation, imported-history verification, and one focused second import cycle.
- L3 black-box tests currently cover collision reminting during export, dry-run, and import into a second fresh data root and process with preserved knowledge and `importedFrom` lineage, plus unsupported-feature and tamper rejection without partial workspace creation. They do not yet cover every fault stage, concurrent-write hot-backup restore, or deployment moves.
- Web component tests cover repository and Vault re-binding, but browser-level L4 acceptance remains open.
- The L5 built-artifact smoke covers packaged NanoCore boot, successful JSON health and API-readiness responses, and orderly shutdown.
- The fixed source and target runner and its two-job GitHub workflow are implemented through the real bundled local-mode CLI. Same-host execution passes, and separate fresh GitHub runners pass source production and target import with the same original archive SHA-256, complete seeded Turn history and semantic graph comparison, authoritative knowledge, repository and Vault re-binding, target mutation, and re-export dry-run. The proof does not compare re-export archive or manifest digests and remains L3 public-process coverage plus L5 artifact-transport smoke rather than cross-machine L6 continuation.

Current V2 acceptance requires deterministic round-trip equivalence, exact-byte tamper detection, exact manifest file-set enforcement, required remint and stable-id integrity, fail-closed V1 and feature handling, synchronous coordinated rollback, unbound Vault enforcement for the implemented families, and the Material, version-keyed Artifact Review, and S39 criteria above. No export may contain a SQLite file or system-managed Vault, provider, or runtime secret material. Concurrent-write hot-backup restore, browser L4, and cross-machine L6 remain release-hardening acceptance work.

## Risks & Mitigations

- Risk: portable dumps drift from live storage ownership. Mitigation: shared record schemas, the workspace SQLite table coverage guard, explicit Core-family tests, app-local state coverage, and round-trip tests.
- Risk: a new source-of-truth file family is omitted. Mitigation: storage ownership changes must classify it as portable or non-portable and add coverage in the same change.
- Risk: reminting changes a stable identity or leaves a target-owned source identity or stale digest. Mitigation: validate source and target graphs, preserve explicitly stable workspace-scoped identities, and recompute identity-dependent context and manifest digests.
- Risk: import fails after writing one storage surface. Mitigation: same-filesystem staging, one Core transaction, and synchronous rollback tests across staged, published, live-store, and Core state. A process crash inside the cross-resource publication window remains a separate recovery gap.
- Risk: users treat an export as a secret-complete or secret-sanitized clone. Mitigation: exclude system-managed secrets and host bindings, import Vault references as `unbound`, expose explicit re-binding, and state that user-authored portable content is not DLP-scanned.
- Risk: hot backup captures a torn append or a newer database snapshot than its copied files. Mitigation: mark the result crash-consistent, verify the captured file inventory, and use stopped-server restore plus existing boot integrity checks. Canonical item and turn-event JSONL readers can discard a syntactically incomplete final fragment; other authoritative ledgers fail closed, and no general cross-authority reconciliation is currently claimed.

## Resolved Decisions

The accepted workspace export version is V2. The canonical archived extension remains `.openkit-workspace.tar.zst` with a product-registered OpenKit workspace export media type. Existing server-managed-tree dry-run performs exact-byte verification and collision preview without additional staging or target mutation; archive dry-run performs the same preview from non-authoritative request-local staging and removes that staging without target mutation.

## Deferred / Future Work

- Incremental and differential backup.
- Live replication and multi-deployment synchronization.
- Deep compaction beyond item-log snapshot elision.
- User- and server-scope export units, including whole-deployment archival export.
- Web UI surfaces for export and import progress.
- Durable recovery for a process crash inside the workspace-filesystem-to-Core publication window.
- Concurrent-write hot-backup restore validation and any cross-authority reconciliation it proves necessary.
- Browser-level portability acceptance and optional agent-first L6 continuation beyond the fixed two-runner mechanical proof.

## Links

- `docs/core/storage.md` — this spec answers its backup, export, import, and compaction open point.
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260715-multi_user_workspace_system.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260713-work_resource_interaction_model.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/manual/nanocore-data-root-config.en.md`
