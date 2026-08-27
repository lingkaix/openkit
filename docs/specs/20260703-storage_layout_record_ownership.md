---
status: Accepted
implementation: Partial
---
# Storage Layout And Record Ownership

## Summary

This spec closes the storage design gap beneath the file-system-first principle.

The clean target is scope-owned storage: server records live under server ownership, user records live under user ownership, and workspace records live under workspace ownership. File-backed records remain the default for inspectable history; SQLite may own an explicitly named transactional record graph when its owning specification requires atomic compare-and-set and command-receipt publication. It must not become an unnamed product model that competes with another authority.

The important call is to stop organizing persistence by feature module. Storage should be organized by ownership, recovery boundary, backup boundary, and export boundary.

## Owns

- Target physical `DATA_ROOT` ownership layout for server, user, and owner-independent workspace scopes.
- Source-of-truth decisions for file-backed records, SQLite source-of-truth ledgers, and derived SQLite records.
- Storage ownership for worker runtime outputs, OpenShell evidence, staged reviews, apply results, audit, usage, capability calls, permission decisions, vault metadata, and recovery checkpoints.
- The Workspace SQLite transaction boundary for Workspace Material identity, immutable inline revisions, Thread bindings, their command receipts, and version-keyed Artifact Review history.
- Migration posture from the current single-database implementation to ownership-scoped storage.
- Record lineage requirements for importing runtime-produced evidence into canonical product history.
- Storage structure extension rules for future record families and derived directories.

## Does Not Own

- Core semantic definitions for workspace, thread, turn, item, artifact, knowledge, vault, audit, usage, or AgentSession.
- Table DDL, migration scripts, ORM details, or read-model query design.
- Workspace synchronization protocol semantics.
- Vault secret backend implementation or secret material storage.
- Web UI read models beyond naming their storage source.
- Material, binding, worker-delivery, or Artifact Review product semantics, which remain owned by `docs/specs/20260713-work_resource_interaction_model.md`.

## Core References

- `docs/core/storage.md`
- `docs/core/identity.md`
- `docs/core/architecture.md`
- `docs/core/protocol.md`
- `docs/core/knowledge.md`
- `docs/core/audit.md`
- `docs/core/metering.md`
- `docs/core/vault.md`
- `docs/core/agent-session.md`
- `docs/core/contract-evolution.md`

## Related Docs

- `docs/specs/20260703-schema_evolution_record_envelope.md`

## Goals

- Define the target `DATA_ROOT` tree for server, user, and workspace scopes.
- Decide which record families are file-backed source of truth and which may use SQLite as source of truth.
- Bring OpenShell, worker-shim, audit, log, transcript, and evidence outputs back into NanoCore-owned storage.
- Keep records inspectable, portable, backup-friendly, and easy to rebuild into query indexes.
- Preserve lineage from workspace, thread, turn, AgentSession, package snapshot, backend session, capability call, policy decision, and evidence bundle.

## Non-goals

- Do not preserve the current single-`core.sqlite` implementation as the target model.
- Do not define table DDL in this spec.
- Do not make OpenShell-native files product records.
- Do not store secret values in normal storage.
- Do not design Web UI read models beyond naming the records they should project.

## Background

`docs/core/storage.md` already establishes that OpenKit is file-system first and that SQLite is a companion store. `docs/product-vision.md` states that SQLite files should be split by ownership scope: `core.sqlite`, `user.sqlite`, and `workspace.sqlite`.

The missing decision is the concrete target layout and record ownership rule, especially for runtime records produced by governed worker containers and OpenShell backends.

## Decision

Use sibling ownership trees and one database per ownership scope. A Workspace is a first-class server resource; its owner is an identity relationship, not its physical parent.

Local and server deployments use the same `DATA_ROOT` hierarchy. Core mode changes authentication and configuration posture, not physical record ownership or storage shape; local mode is not a separate storage tree.

The target tree is:

```text
DATA_ROOT/
  config/
    server.jsonc
    providers/
    agents/
  server/
    db/core.sqlite
    files/
      oauth/
      provider-accounts/
    logs/
    evidence/
    exports/
    migrations/
  users/
    <userId>/
      db/user.sqlite
      config/user.jsonc
      files/
      logs/
  workspaces/
    <workspaceId>/
      workspace.json
      db/workspace.sqlite
      config/workspace.jsonc
      config/data-sources.jsonc
      threads/
      artifacts/
      knowledge/
      sources/
      runtime/
      reviews/
      evidence/
      logs/
      indexes/
```

`DATA_ROOT/config` remains the operator-authored server config surface. Other mutable server-owned runtime state belongs under `DATA_ROOT/server`.

`DATA_ROOT/users/<userId>` contains only user-owned state. `DATA_ROOT/workspaces/<workspaceId>` is the one canonical home for a Workspace regardless of creator, current owner, or member set. Workspace listings are derived from the Core registry, membership state, and policy decisions; sharing does not create copies, reference files, `share/` directories, symlinks, or hard links.

`knowledge/` and `sources/` are deliberately sibling record families even though the Knowledge Store conceptually governs both: physical layout follows record family, lifecycle, and backup boundary rather than module nesting, and the `sources/` evidence layer is referenced by context packages, evidence bundles, audit traces, and artifacts as well as by knowledge pages. `sources/` and `artifacts/` are symmetric: durable governed inputs and durable governed outputs.

## Source Of Truth Rules

File-backed source-of-truth records:

- workspace metadata in `workspace.json`
- workspace config in `config/workspace.jsonc`
- thread records
- turn records
- append-only item logs
- turn input attachments under `turns/<turnId>/inputs/`, which are work-history records whose lifecycle follows thread retention; they become Knowledge Sources only through the explicit registration contract in `docs/specs/20260703-knowledge_store_implementation.md`
- artifacts and artifact metadata
- knowledge pages, sources, derived representations, proposals, and Knowledge reviews
- context package manifests, traces, and their exact worker-visible package files
- agent environment package snapshots
- normalized runtime transcript files
- redacted evidence bundle manifests
- generated files that must be inspectable or replayable

SQLite source-of-truth records:

- auth session records delegated to the auth implementation
- idempotency ledger rows
- audit events
- usage records
- capability calls
- permission decisions
- vault reference metadata and grants, excluding secret material; a portable imported VaultGrant row remains historical evidence in S51's reserved namespace and is never target authority
- scheduler leases, capacity records, worker-control ledgers, and the small recovery fields and cleanup fences on their existing owning rows
- migration metadata
- operational recovery checkpoints that require transactions
- the S49 Workspace synchronization owner graph in `workspace.sqlite`: input snapshots, materialization records, backend handles, output manifests, change sets, staged Workspace Reviews, apply plans and results, reconciliation records, and quarantine records; exported files are non-authoritative portable projections or manifests
- `WorkspaceMaterial`, immutable `WorkspaceMaterialRevision`, and `ThreadMaterialBinding` rows plus their command receipts in `workspace.sqlite`
- version-keyed `ArtifactReview` rows in `workspace.sqlite`
- one Thread-unique `PendingUserTurnRecord` and immutable `SteeringTerminalOutcome` rows for the exact S16 Goal-steering boundary in `workspace.sqlite`

Audit-family rows home in the database of their `ownerScope` per the Storage Scope Homing decision in `docs/specs/20260703-audit_usage_evidence_records.md`: workspace-lineage rows in `workspace.sqlite`, server control-plane rows in `core.sqlite`, user-identity rows in `user.sqlite`. Workspace deletion produces a sealed server-owned audit closure export under `server/exports/` before removal.

### Turn Event Replay Retention

The current Turn-event transport replay window retains exactly the latest 100 events per Turn in the active store. Live append drops the oldest retained event when the window exceeds 100, and Workspace reload reads the canonical event log but restores only its final 100 events into the replay store. If the first retained sequence is `F`, a non-initial reconnect cursor `since=N` expires only when `N < F - 1`; `since=F-1` is valid and replays `F` onward. The initial `since=0` request asks for the current retained window and is not expired by that reconnect comparison. An expired cursor fails with `core.stream.cursor_expired`; storage must not imply that the complete file-backed event log is still transport-replayable. Protocol owns the abstract cursor, expiry, and terminal-proof semantics, while Communication owns their HTTP/SSE projection.

SQLite-derived records:

- dashboard read models
- search tables
- full-text search indexes
- vector or embedding metadata
- pagination indexes
- readiness summaries
- health summaries
- cached diagnostics

Derived records must be rebuildable from file-backed records or authoritative SQLite ledgers.

## Authoritative SQLite Integrity Failure

Core, User, and Workspace SQLite databases contain authoritative record families. If an existing authoritative database fails `PRAGMA quick_check` or cannot be opened for the integrity check, NanoCore MUST fail process boot during the critical storage phase and MUST leave the original database file at its canonical path with its bytes unchanged.

Boot MUST NOT move the file to quarantine, delete it, repair it in place, create a fresh replacement, run migrations against a replacement, admit product work, initialize product identity, issue a server bootstrap credential, or bind the product listener. Recovery is an explicit stopped-process operator action such as restoring a verified backup or copying the original for offline inspection; boot does not invent recovery authority.

This fail-closed rule does not apply to derived SQLite indexes and read models. A corrupt derived store MUST be deleted and rebuilt from its file-backed source of truth or authoritative ledgers, and the owning subsystem remains explicitly degraded until rebuild completes.

## Material And Artifact Review Transaction Boundary

The Phase 1 Material graph is an explicit exception to the ordinary file-backed workspace-history default. Its three authoritative families and the command ledger that acknowledges their mutations live in the same `workspace.sqlite`; no Material authority exists under `files/`, `sources/`, `knowledge/`, `artifacts/`, or a private Material directory.

The exact logical keys and storage payloads are:

| Record | Key and required storage contract |
| --- | --- |
| `WorkspaceMaterial` | Primary key `(workspaceId, materialId)`; stores `title`, `kind`, nullable `currentRevisionId`, `sensitivity`, `lastMutationRequestId`, `createdAt`, and `updatedAt`. |
| `WorkspaceMaterialRevision` | Primary key `(workspaceId, materialId, revisionId)`; immutable; stores nullable `parentRevisionId`, `mediaType`, `contentDigest`, exact canonical UTF-8 `content`, `authorId`, `createdByRequestId`, and `createdAt`. The revision id is unique within its Material and its parent, when present, belongs to that same Material. |
| `ThreadMaterialBinding` | Primary key `(workspaceId, threadId, materialId)`; stores `bindingState`, nullable `latestQueuedRevisionId`, `inclusionState`, `lastMutationRequestId`, `createdAt`, and `updatedAt`. The queued revision, when present, belongs to the bound Material. The owning transaction permits at most one `bindingState=bound` row per `(workspaceId, threadId)`. |
| `ArtifactReview` | Primary key `(workspaceId, artifactId, artifactVersion)` with a unique deterministic `reviewId`; stores the exact reviewed `contentDigest`, nullable `sourceThreadId`, `sourceTurnId`, and `sourceAgentId`, nullable immutable `materialProposal` as exactly `{ materialId, baseRevisionId, baseContentDigest }`, nullable first-writer `decision`, `decisionActorId`, `decisionRequestId`, `feedback`, `decidedAt`, nullable deterministic `followUpTurnId`, nullable `appliedMaterialRevisionId`, and `createdAt`. Later Artifact versions insert new rows and never update or replace prior-version history. |

`WorkspaceMaterialRevision.content` is the canonical content. `mediaType` is derived from Material kind and `contentDigest` verifies the exact stored bytes. Revisions form one complete linear parent chain from the unique null-parent root to `WorkspaceMaterial.currentRevisionId`; a null current pointer means no revisions, no revision has multiple children, and timestamps do not order the chain. A `contentRef`, filesystem path, blob locator, delta-only revision, or Material content file is not an alternative authority and is not authorized for Phase 1.

Material creation commits the new `WorkspaceMaterial` and its completed command receipt in one Workspace transaction. Material save commits the immutable revision, compare-and-set current pointer, coalesced queue update for every bound binding, request lineage, and completed receipt in one Workspace transaction. Bind, unbind, exclude, and restore transitions likewise commit the binding mutation and receipt together. A failed precondition rolls back every named row and publishes no success receipt. Exact replay reads the completed receipt and returns the same result; it does not add a pending mutation, receipt-reconstruction path, settlement row, or second Material owner.

`ArtifactReview` stores one unresolved-or-decided owner for one exact Artifact version rather than one mutable record keyed only by Artifact id. Creation eligibility, explicit proposal intent, unique same-Turn S39 tuple verification, Workspace Sync exclusion, first-writer decision, refinement or redo Turn reservation, cross-file receipt-gap handling, and recovery remain exactly those defined by S16; this storage decision adds no Review lifecycle, queue, workflow, or alias to staged Workspace Review. An `accepted` decision with null `materialProposal`, or any `rejected` or `deferred` decision, commits its Review row and completed receipt together in `workspace.sqlite`. An `accepted` non-null Material proposal uses one Workspace transaction for the Review compare-and-set, exact expected-base check, fully bound immutable Material revision, current pointer with the decision request as mutation proof, affected binding queues with the same request proof and preserved inclusion state, `appliedMaterialRevisionId`, and completed receipt; a different current revision rolls back every named row as `conflict`, while any contradictory immutable tuple or digest rolls back as `recovery_required`. A `needs_refinement` or `redo` claim commits its reserved follow-up identity before cross-store Turn and admission effects and publishes the receipt only after their exact terminal proof; a complete follow-up tuple without that receipt fails closed and is not reconstructed.

S51 exports these four authoritative row families as strict line-oriented records, then imports them through one target Workspace transaction after validating and rewriting their complete identity graph. Deployment-local command receipts do not travel. S51 rewrites every Material and Artifact Review request-proof field to its reserved non-command `import-lineage:` token, which remains historical lineage and is never receipt-reconstruction or access authority; the complete import transaction is not a command-receipt half-state. A database file or Material content directory is never the portable representation.

## Goal Steering Transaction Boundary

S16 permits exactly one mutable `PendingUserTurnRecord` per `(workspaceId, threadId)`. It stores the original Goal, active Turn, send request, content Item, input kind, nullable exact Material tuple, queue mode, receipt time, and nullable `terminalClaimKind`, `terminalClaimId`, and `terminalClaimedAt`. The claim timestamp equals `acceptedAt` for follow-up or cancellation; an applied claimant captures it at its claim transaction without redefining Turn acceptance time. It is a bounded delivery owner, not a general queue: a second row cannot coexist, no priority or ordering field exists, and the row is deleted only by its exact applied, follow-up, or cancelled winner.

Follow-up and cancellation use one immutable `SteeringTerminalOutcome` keyed by `(workspaceId, threadId, pendingTurnId)` with a deterministic unique `outcomeId`. It stores exactly `workspaceId`, `threadId`, `outcomeId`, terminal `state`, `pendingTurnId`, `sendRequestId`, `terminalRequestId`, `contentItemId`, `goalId`, `activeTurnId`, `inputKind`, nullable `materialId`, `revisionId`, and `contentDigest`, nullable deterministic `followUpTurnId` and `followUpItemId`, and `acceptedAt` defined by S16. The record has no status, retry counter, cleanup state, or mutable lifecycle. Applied delivery uses the accepted S39 Context Package trace and creates no outcome row.

For cancellation, the terminal claim, outcome, command receipt, and pending-row deletion commit in one Workspace transaction. For follow-up, the pending claim is durable before the deterministic Core-local Turn and Item are written; after that exact pair verifies, the outcome, receipt, and pending-row deletion commit in one Workspace transaction. A complete receipt stores only the outcome resource kind and id under C07, never the outcome body. An identical still-pending follow-up claim may finish only that reserved pair and final transaction. After the pending row is absent, an outcome without its same-transaction receipt, a receipt without its outcome, or a mismatched Turn, Item, claim, or Material tuple is `recovery_required`; no receipt or outcome is reconstructed from projection or audit data.

Pending and terminal steering rows are deployment-local execution proof and are not part of portable Workspace transfer. Import does not resume an active Goal or retain pre-export command replay; exported immutable Thread, Turn, and Item history remains portable under its existing owners. This exclusion does not authorize deleting an active source row or weakening restart proof before export.

## Structure Evolution Rules

The target storage tree is the baseline for future additive evolution.

OpenKit does not need permanent compatibility with pre-baseline internal storage layouts.

Future storage changes should add sibling directories, record families, indexes, or metadata fields without changing the meaning of existing canonical records.

Older readers may ignore unknown sibling directories when those directories contain derived indexes, cached read models, diagnostics, generated runtime-native files, or backend-private evidence payloads.

Older readers must not treat unknown canonical record families as processed.

Unknown canonical record families selected by a manifest, context package, AEP snapshot, evidence bundle, or required feature must fail closed until the reader understands them.

Authority-bearing storage semantics must follow `docs/specs/20260703-schema_evolution_record_envelope.md`.

Fields or directories that change workspace ownership, workspace export, workspace deletion, vault handling, permission handling, audit retention, evidence promotion, mount access, or write scope must be gated by `requiredFeatures` or an equivalent required capability.

Canonical file-backed records should use the common record envelope from the schema evolution spec unless this spec or another owning spec defines a narrower line-oriented format.

Line-oriented families under this spec apply the split-envelope minimum from the schema evolution spec as follows: `items.jsonl` lines are protocol item event records whose per-line version and type discriminators come from the protocol item schemas, with thread and turn lineage carried by the owning `thread.json` and `turn.json` records acting as the file-level manifest; observation ledgers and other workspace JSONL ledgers carry a per-line `v`, `type`, `id`, and `ts` header, with `ownerScope`, lineage defaults, and `requiredFeatures` in a directory-level manifest file. Rotation and compaction preserve manifest linkage.

## Current Implementation Projection

The owner-independent V2 Workspace root and most scoped record-family ownership are implemented. This specification remains partial because some named record-family homing, export-schema, retention, and conformance work remains incomplete; the active implementation no longer diverges on physical Workspace ownership:

- `apps/nanocore/src/storage/fs-layout.ts` creates the server and user ownership roots plus one top-level `workspaces/` root; a User subtree contains only user-owned `files/`, `data/`, `db/`, `logs/`, and `config/` state.
- `ensureWorkspaceLayout` creates workspace-owned `files/`, `data/`, `db/`, `logs/`, `logs/nanocore/`, `logs/worker/`, `config/`, `artifacts/`, `knowledge/`, `sources/`, `threads/`, `runtime/`, `runtime/agent-sessions/`, `reviews/`, `reviews/workspace/`, `evidence/`, `evidence/bundles/`, `evidence/backend/`, and `indexes/`.
- `openCoreDb` opens the server-scope database at `server/db/core.sqlite`.
- `openCoreDbWithIntegrityCheck` is the boot-only opener for `server/db/core.sqlite`: it runs SQLite `PRAGMA quick_check` and throws before opening for write or migration when the existing authoritative file fails integrity validation.
- `verifyAndMigrateExistingScopedDatabases` scans existing `users/<userId>/db/user.sqlite` and `workspaces/<workspaceId>/db/workspace.sqlite` files at boot, verifies each existing authoritative file before opening it for write, and applies scoped migrations only after validation succeeds.
- `server/layout.json` records the accepted data-root layout version, and `ensureLayout` fails closed when it finds an unsupported marker.
- V2 normal boot has no owner-nested compatibility reader: `ensureLayout` fails closed on a predecessor marker, root-level `core.sqlite`, owner-nested Workspace trees, and legacy workspace `memory/` directories. The dedicated stopped-process migration CLI is the only implemented V1-to-V2 cutover path; it verifies an external full-data-root backup, publishes one staged top-level Workspace root, removes predecessor trees, records evidence, and leaves subsequent boot to validate V2 normally.
- `ensureLayout` verifies canonical SQLite database filename ownership and fails closed when `core.sqlite`, `user.sqlite`, or `workspace.sqlite` appears outside its owning scope.
- `ensureLayout` scans JSON records that carry the common canonical record envelope, accepts only currently implemented canonical record families (`workspace-export` and `data-root-backup`), and fails closed when an envelope names an unknown family or non-empty `requiredFeatures` that the reader does not support.
- `openUserDb` opens `users/<userId>/db/user.sqlite`, and `applyScopedMigrations` initializes only the user scoped `schema_migrations` ledger.
- `openWorkspaceDb` opens `workspaces/<workspaceId>/db/workspace.sqlite`, and `applyScopedMigrations` initializes the workspace-scoped `schema_migrations` ledger.
- `createStorageLayoutReport` produces a read-only baseline report for the current data root, including server/user/workspace database presence, applied migration ledgers, workspace `indexes/` status, and quarantined storage file inventory.
- `GET /api/app/storage/layout-report` exposes the same report through the public App API with `@openkit/app-api-schemas` validation, `@openkit/core-client` exposes `client.app.getStorageLayoutReport()` for first-party consumers, and the unified `openkit` Skill exposes the `storage.layout-report` bundled-CLI operation for AI-native operator inspection. Because the report covers deployment-wide storage topology and quarantine inventory, this is a deployment-wide administration route governed by `docs/specs/20260704-remote_auth_credential_bootstrap.md`, not a workspace diagnostic.
- A verified full-data-root backup preserves same-deployment Core identity, membership, invitation, session, token, and Workspace authority for restore. Portable Workspace export/import deliberately excludes those deployment-local authorities; target import creates one target registry owner and membership for the importing user, while source users and access relationships do not authorize the imported Workspace.
- `rebuildWorkspaceDerivedIndexes` rebuilds the first workspace-derived index file at `indexes/search.json` from file-backed workspace projections and authoritative workspace snapshot records, deleting stale derived index files before writing the rebuilt index.
- `rebuildExistingWorkspaceDerivedIndexes` runs the same derived-index rebuild at boot for existing workspace directories that have a canonical `workspace.json` projection, skipping half-built workspace directories without that projection.
- The server-scope database currently holds Better Auth or auth implementation rows, server settings, users, scheduler coordination, worker-control ledgers, and durable backend-session lifecycle rows. Restart closeout reuses those owners and adds no settlement table.
- Workspace repository resources, worker-turn checkpoints, Goal Mode records, workspace synchronization owners, workspace filesystem staging roots, workspace-scoped permission decisions, `PendingUserTurnRecord`, and `SteeringTerminalOutcome` now live in workspace-owned `workspace.sqlite` files with workspace-scoped migration ledgers. The two steering families are deployment-local command proof and are intentionally excluded from portable Workspace export.
- `TURN_STREAM_EVENT_WINDOW_SIZE` in `apps/nanocore/src/storage/workspace-file-records.ts` is 100. `FsStore` applies that same limit on live append and reload, `turn-event-routes.ts` returns `core.stream.cursor_expired` for an older cursor, and focused reload and route tests prove the retained-window behavior.
- Worker checkpoint rows carry workspace/thread/turn lineage, context package digest, stage, stop reason, and redacted diagnostics.
- `WorkspaceMaterial`, immutable `WorkspaceMaterialRevision`, singular `ThreadMaterialBinding`, and version-keyed `ArtifactReview` are implemented in `workspace.sqlite`; their public routes, Action Center projection, and portable export/import use those existing owners rather than a second workflow or filesystem authority.
- The obsolete Artifact-id-keyed JSON owner and `reviews/artifacts/` layout have been deleted without a compatibility reader, migration, or dual write. Only the accepted version-keyed `artifact_reviews` Workspace SQLite family may own generic Artifact Review decisions.

`users/<userId>/db/user.sqlite` has a concrete open path and migration ledger. The current Workspace database path is `workspaces/<workspaceId>/db/workspace.sqlite`; owner transfer and membership changes therefore do not move, alias, or duplicate the Workspace tree.

The workspace physical `memory/` directory has been replaced by `knowledge/`. OpenKit-owned protocol, App API, NanoCore, core-client, unified Skill, bundled CLI, and Web surfaces now use `knowledge`; remaining `memory` mentions in active implementation are ordinary in-memory wording, resource-limit options, or fail-closed unsupported layout guards.

The current file projection materializes turn items as file-backed JSONL under per-thread and per-turn storage paths, knowledge page Markdown under `knowledge/pages/<knowledgeEntryId>.md`, app-local knowledge proposal Markdown under `knowledge/proposals/<proposalId>.md`, app-local knowledge proposal review decisions under `knowledge/reviews/<proposalId>.json`, source identity records under `sources/registry/<sourceId>.json`, registered text source material under `sources/materials/<sourceId>/content.txt`, artifact metadata under `artifacts/<artifactId>/artifact.json` with content files under `artifacts/<artifactId>/files/content.{md,txt,json}`, and AgentSession records under `runtime/agent-sessions/<agentSessionId>/session.json`. The target layout keeps item logs, knowledge pages, proposal summaries and review decisions, source identity records, source material evidence, artifact metadata and content files, and AgentSession runtime records file-backed, but moves ownership and recovery rules into the workspace tree defined in this spec.

## Workspace Storage Layout

Each workspace owns:

```text
threads/
  <threadId>/
    thread.json
    turns/
      <turnId>/
        turn.json
        items.jsonl
        context-package.json
        context-package/  # exact worker-visible package files indexed by context-package.json
        inputs/
        runtime/
artifacts/
  <artifactId>/
    artifact.json
    files/
knowledge/
  pages/
  proposals/
  reviews/
  observations/
sources/
  registry/
  derived/
runtime/
  agent-sessions/
    <agentSessionId>/
      session.json
      aep-snapshots/
      shim/
      transcripts/
      workspace-changes/
reviews/
  workspace/
evidence/
  bundles/
  backend/
logs/
  nanocore/
  worker/
indexes/
```

The workspace may keep raw source material or references depending on source type and policy. External systems remain systems of record for their own domain data.

## Source Copy Versus Reference Policy

Workspace `sources/` should preserve enough evidence for replay, citation, and review without turning OpenKit into every external system's storage backend.

Copy source material into workspace-owned `sources/` when:

- the user uploads the file into OpenKit as workspace material
- the material is a task input that must remain replayable after external access changes
- the source is a web capture, meeting artifact, message export, ticket export, or integration snapshot where the captured state is evidence
- derived representations need stable lineage to a captured source version
- policy requires local retention for audit, review, or reproducibility

Store a reference plus metadata instead of copying raw material when:

- an external system is the authoritative system of record
- the material is too large, regulated, licensed, or frequently changing to duplicate safely
- the source is a repository file already owned by workspace materialization or source control
- the source is a credentialed API record whose raw payload should not be retained
- policy allows citation by stable external id, URI, version, digest, or query locator

Reference-only sources should still store non-secret metadata: source id, source kind, owner scope, external locator or redacted locator, captured timestamp, access policy, freshness metadata, digest or version when available, and derived representation links when any are retained.

## OpenShell And Worker Output Ingestion

OpenShell and worker-shim output has three layers:

- backend-native raw evidence
- normalized OpenKit evidence
- canonical product records

Backend-native raw evidence is retained only as evidence material. It may include OpenShell OCSF exports, sandbox lifecycle payloads, gateway diagnostics, upload or download manifests, stdout/stderr logs, policy apply records, and teardown logs.

Normalized OpenKit evidence is a redacted manifest that links raw evidence to OpenKit ids and digests.

Canonical product records are created only when NanoCore imports and verifies the output. Examples include items, artifacts, workspace changes, audit events, usage records, permission decisions, and apply results.

OpenShell ids, gateway ids, provider handles, supervisor logs, process ids, and native file-transfer handles must not become the public product identity.

Runtime-internal sub-agent streams and their native origin indexes follow the restricted evidence and product-safe normalization contract in `docs/specs/20260711-worker_runtime_subagent_provenance.md`; they do not create additional OpenKit thread, turn, or AgentSession storage trees.

## Server Storage Layout

`server/db/core.sqlite` owns:

- known user registry and workspace registry summaries
- Better Auth or auth implementation tables where applicable
- server idempotency rows
- server-level audit and usage rows when no workspace scope exists
- server migrations
- server scheduler and background task rows
- provider readiness indexes

`server/files` owns:

- sanitized OAuth account slot metadata
- isolated provider account homes where an external tool owns its own credential storage
- server-owned exported bundles

`server/evidence` owns backend evidence that is not workspace-owned, such as server startup diagnostics or gateway lifecycle evidence.

## User Storage Layout

`user.sqlite` owns:

- user preferences
- workspace ordering and recent workspace indexes
- user-scoped provider or vault metadata when policy allows it
- user-level notifications and attention state

User files remain under `users/<userId>/files`. Workspace ownership and visibility do not create any Workspace storage below the user tree; all canonical Workspace data lives under `workspaces/<workspaceId>` and is resolved through Core identity and policy state.

## Record Identity

Every runtime-produced record must carry enough lineage to be verified after import:

- workspace id
- thread id when applicable
- turn id when applicable
- agent id when applicable
- AgentSession id when applicable
- package snapshot id when applicable
- backend session summary when applicable
- capability call id when applicable
- policy decision id when applicable
- request id when applicable
- monotonic worker sequence when applicable
- content digest for files or large payloads

Records without sufficient lineage may be stored as quarantined evidence but must not be promoted into canonical product history.

## Migration Posture

Because OpenKit is in active internal development, the clean target should win over legacy preservation.

The current migration does not need old-version compatibility.

Migration from the current partial implementation should be explicit and one-way. One thin dedicated stopped-process operator CLI owns invocation; it calls the migration directly and is not a boot phase, restore mode, reusable runner, or test harness:

1. Preflight every registered Workspace against its current `users/<ownerUserId>/workspaces/<workspaceId>` source and fail on missing, duplicate, linked, or ambiguous roots.
2. Before changing `DATA_ROOT`, create and verify one complete predecessor `DATA_ROOT` cold backup outside `DATA_ROOT`, including the Core database, layout marker, every owner-nested Workspace tree, and their exact inventory and digests.
3. Create the migration-owned target staging tree and move any remaining server-owned runtime files under `server/`.
4. Copy every verified Workspace into one same-filesystem staging root shaped as the complete future `workspaces/` tree, then verify its complete inventory and authoritative databases.
5. Publish the complete staged `workspaces/` root through one same-filesystem rename, apply the Core transaction, verify every target and constraint, and remove the owner-nested Workspace trees from `DATA_ROOT` while retaining the verified external backup.
6. Repoint all Workspace openers and recovery scans to the owner-independent root and write the new layout marker only after no owner-nested Workspace tree remains inside `DATA_ROOT`. While the CLI still owns the stopped process, call the same integrity and derived-index rebuild functions used by normal boot directly; do not run the boot phase runner or create a verification-boot mode.
7. Keep a migration report that records relative source and target identities, predecessor-to-successor digests, stage, and outcome without exposing credentials or user content. The report is evidence only and never a retry, resume, or recovery authority.
8. Retain the external cold backup until the published layout passes its required verification and reviewed cleanup explicitly removes it; do not add a dual reader, alias, or filesystem link.

After this baseline is established, future storage additions must follow the additive schema evolution rules in `docs/specs/20260703-schema_evolution_record_envelope.md`.

Post-baseline import is an explicit contract with three verifiable rules:

1. A newer system MUST accept any post-baseline record whose `schemaVersion` major matches a supported family version and whose `requiredFeatures` are all supported, regardless of how old the writer was.
2. When a major-version migration rewrites records, it MUST be explicit and one-way, MUST produce a migration report, and MUST preserve digest continuity by mapping each predecessor `contentDigest` to its successor digest per the schema evolution spec.
3. Records from unknown canonical families and records with unsupported required features MUST be quarantined, not dropped: they are preserved untouched and excluded from processing until a reader that understands them arrives.

## Resolved Decisions

- The target layout uses one database per ownership scope under a `db/` directory: `server/db/core.sqlite`, `users/<userId>/db/user.sqlite`, and `workspaces/<workspaceId>/db/workspace.sqlite`.
- Workspace ownership is a Core identity relationship and never determines the canonical Workspace path.
- The legacy root-level `core.sqlite` path is implementation debt, not the target location.
- The legacy workspace `memory/` directory name is implementation debt; the target directory is `knowledge/`.
- Workspace domain rows are workspace-scoped even if the gateway, scheduler, or runtime lives in the server process. Deployment-wide scheduler rows remain server-scoped when they fence scheduler epoch, lease, capacity, or physical cleanup atomically; direct restart closeout follows product-safe lineage into the existing workspace owners and never copies workspace-domain payload into a server settlement row. Rows with no workspace context are server-scoped.
- Quarantined worker output should be retained by default as restricted redacted evidence for a bounded retention window, not silently deleted at rejection time.
- Derived indexes and read models must be rebuildable from file-backed records or authoritative SQLite ledgers.
- An authoritative Core, User, or Workspace SQLite integrity failure is a critical boot failure. The original file remains unchanged at its canonical path, and boot creates no empty replacement or automatic recovery record.
- Phase 1 Material identity, canonical inline revision content, Thread binding, and their command receipts are one `workspace.sqlite` transaction graph. No Material filesystem authority, `contentRef`, pending mutation, receipt reconstruction, or settlement state is permitted.
- Artifact Review history is keyed by exact Artifact version in `workspace.sqlite`; a later version never overwrites an earlier decision, and the row does not alias staged Workspace Review or create a second Review workflow.
- A temporary migration report is allowed; permanent legacy readers for old layout paths are not part of the target.
- A read-only storage baseline report exists for the current internal migration; it reports current database ledgers and quarantined storage files, but it does not repair legacy state or preserve compatibility readers.
- The first derived index rebuild path exists for workspace search and treats `indexes/` as disposable derived state. Boot invokes it for existing workspaces with canonical projections, but the index file itself is not a source of truth.
- The server-owned `server/vault/` directory exists as the opaque home for the encrypted-file vault backend; secret material handling remains owned by the vault backend spec.
- Workspace runtime, review, evidence, and log subdirectories are materialized by the layout helper, so later worker-session, review, evidence-import, and log writers do not invent private directory roots.
- Workspace `sources/` should copy material when replay, audit, review, or user upload semantics require local evidence. It should store references when an external system remains the source of truth or copying would be unsafe, excessive, or policy-forbidden.
- Future storage additions are additive by default. Unknown optional fields and derived directories may be ignored, but unsupported required features and unknown authority-bearing canonical record families must fail closed.
- Current internal migration does not require compatibility with old internal storage layouts.

## Deferred / Future Work

- Move future user- and workspace-owned row families out of the server-scope database as those families are implemented.
- Add exportable schemas for SQLite source-of-truth ledgers.
- Add retention and access-control policy for quarantined evidence.
- Add conformance tests for unknown optional fields, unsupported required features, and unknown canonical record families.

## Testing Strategy

- Storage fixture tests should create a full target tree and validate path ownership.
- Startup storage tests should prove NanoCore boots on the ownership-scoped target tree.
- Multi-user storage tests should prove owner transfer and membership changes do not move or alias the Workspace root.
- Replay tests should rebuild workspace read models from files and ledgers.
- Import tests should reject worker records with missing lineage or mismatched digests.
- Backup tests should prove a workspace can be copied with its `workspace.sqlite`, files, and evidence manifests.
- Recovery tests should rebuild derived indexes after deleting `indexes/`.
- Integrity tests should prove table-wise that corrupt Core, User, and Workspace authority fails boot validation, preserves the original bytes at the canonical path, and creates neither a migrated replacement nor a quarantine copy.
- Schema evolution tests should prove unknown optional storage metadata is tolerated and unsupported required features fail closed.
- Material transaction tests should prove create, save, bind, unbind, exclude, and restore commit their authoritative rows and completed command receipt together; conflict and injected failure should leave neither a partial mutation nor a receipt.
- Material storage tests should prove revision content is inline, immutable, digest-verified, parent-scoped, and unresolvable through any `contentRef` or Material file path.
- Artifact Review tests should prove `(workspaceId, artifactId, artifactVersion)` uniqueness, deterministic `reviewId`, immutable prior-version history, exact digest and source lineage, and rejection of Artifact-id-only overwrite or staged-review aliasing.

## Risks & Mitigations

- Risk: The tree becomes too verbose for local development. Mitigation: provide templates and helpers, not a flatter model.
- Risk: SQLite source-of-truth ledgers become hidden product state. Mitigation: require exportable schemas and link every row to product ids.
- Risk: Raw backend logs leak secrets. Mitigation: store raw evidence under restricted evidence paths and expose only redacted manifests.
- Risk: Workspace export misses server-owned provider account context. Mitigation: workspace export records provider references and account slot ids, not credential material.

## Links

- `docs/core/storage.md`
- `docs/core/audit.md`
- `docs/core/metering.md`
- `docs/core/agent-capability.md`
- `docs/core/knowledge.md`
- `docs/core/vault.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260715-multi_user_workspace_system.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260704-workspace_backup_export_import.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
- `docs/specs/20260713-work_resource_interaction_model.md`
