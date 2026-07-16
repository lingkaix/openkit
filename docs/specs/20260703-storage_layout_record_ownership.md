# Storage Layout And Record Ownership

Status: Accepted
Implementation: Diverged

## Summary

This spec closes the storage design gap beneath the file-system-first principle.

The clean target is scope-owned storage: server records live under server ownership, user records live under user ownership, and workspace records live under workspace ownership. SQLite exists for indexes, ledgers, query, and transactional coordination, but it must not become a hidden product model that competes with file-backed workspace history.

The important call is to stop organizing persistence by feature module. Storage should be organized by ownership, recovery boundary, backup boundary, and export boundary.

## Owns

- Target physical `DATA_ROOT` ownership layout for server, user, and owner-independent workspace scopes.
- Source-of-truth decisions for file-backed records, SQLite source-of-truth ledgers, and derived SQLite records.
- Storage ownership for worker runtime outputs, OpenShell evidence, staged reviews, apply results, audit, usage, capability calls, permission decisions, vault metadata, and recovery checkpoints.
- Migration posture from the current single-database implementation to ownership-scoped storage.
- Record lineage requirements for importing runtime-produced evidence into canonical product history.
- Storage structure extension rules for future record families and derived directories.

## Does Not Own

- Core semantic definitions for workspace, thread, turn, item, artifact, knowledge, vault, audit, usage, or agent session.
- Table DDL, migration scripts, ORM details, or read-model query design.
- Workspace synchronization protocol semantics.
- Vault secret backend implementation or secret material storage.
- Web UI read models beyond naming their storage source.

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
- `docs/specs/20260703-schema_evolution_record_envelope.md`

## Goals

- Define the target `DATA_ROOT` tree for server, user, and workspace scopes.
- Decide which record families are file-backed source of truth and which may use SQLite as source of truth.
- Bring OpenShell, worker-shim, audit, log, transcript, and evidence outputs back into NanoCore-owned storage.
- Keep records inspectable, portable, backup-friendly, and easy to rebuild into query indexes.
- Preserve lineage from workspace, thread, turn, agent session, package snapshot, backend session, capability call, policy decision, and evidence bundle.

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
- knowledge pages, sources, derived representations, proposals, and reviews
- context package manifests and traces
- agent environment package snapshots
- workspace materialization records
- staged workspace reviews and apply result manifests
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
- vault reference metadata and grants, excluding secret material
- scheduler leases, capacity records, worker-control ledgers, and the small recovery fields and cleanup fences on their existing owning rows
- migration metadata
- operational recovery checkpoints that require transactions

Audit-family rows home in the database of their `ownerScope` per the Storage Scope Homing decision in `docs/specs/20260703-audit_usage_evidence_records.md`: workspace-lineage rows in `workspace.sqlite`, server control-plane rows in `core.sqlite`, user-identity rows in `user.sqlite`. Workspace deletion produces a sealed server-owned audit closure export under `server/exports/` before removal.

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

Most scoped record-family ownership is implemented, but the accepted owner-independent Workspace root is not. The current implementation still materializes each Workspace beneath one user and therefore diverges from this target:

- `apps/nanocore/src/storage/fs-layout.ts` creates `config/`, `config/providers/`, `config/agents/`, `server/`, `server/db/`, `server/files/`, `server/evidence/`, `server/exports/`, `server/logs/`, `server/runtime/`, `server/runtime/config/`, `server/runtime/agents/`, `server/runtime/sessions/`, `server/migrations/`, `server/vendor/`, `users/<userId>/`, and `users/<userId>/workspaces/`.
- `ensureUserLayout` creates user-owned `files/`, `data/`, `db/`, `logs/`, `config/`, and `workspaces/`.
- `ensureWorkspaceLayout` creates workspace-owned `files/`, `data/`, `db/`, `logs/`, `logs/nanocore/`, `logs/worker/`, `config/`, `artifacts/`, `knowledge/`, `sources/`, `threads/`, `runtime/`, `runtime/agent-sessions/`, `reviews/`, `reviews/workspace/`, `reviews/artifacts/`, `evidence/`, `evidence/bundles/`, `evidence/backend/`, and `indexes/`.
- `openCoreDb` opens the server-scope database at `server/db/core.sqlite`.
- `openCoreDbWithIntegrityRecovery` is the boot-only opener for `server/db/core.sqlite`: it runs SQLite `PRAGMA quick_check`, quarantines a corrupt source-of-truth file under `server/quarantine/`, records the original path, quarantine path, SHA-256 digest, and failure detail, then opens a fresh server database for migration.
- `recoverExistingScopedDatabases` scans existing `users/<userId>/db/user.sqlite` and `users/<userId>/workspaces/<workspaceId>/db/workspace.sqlite` files at boot, quarantines corrupt scoped databases under the owning user or workspace `quarantine/` directory, opens fresh scoped databases, and applies their scoped migrations.
- `server/layout.json` records the accepted data-root layout version, and `ensureLayout` fails closed when it finds an unsupported marker.
- `ensureLayout` also fails closed when known legacy ownership paths are present: root-level `core.sqlite` and workspace `memory/` directories.
- `ensureLayout` verifies canonical SQLite database filename ownership and fails closed when `core.sqlite`, `user.sqlite`, or `workspace.sqlite` appears outside its owning scope.
- `ensureLayout` scans JSON records that carry the common canonical record envelope, accepts only currently implemented canonical record families (`workspace-export` and `data-root-backup`), and fails closed when an envelope names an unknown family or non-empty `requiredFeatures` that the reader does not support.
- `openUserDb` opens `users/<userId>/db/user.sqlite`, and `applyScopedMigrations` initializes only the user scoped `schema_migrations` ledger.
- `openWorkspaceDb` opens `users/<userId>/workspaces/<workspaceId>/db/workspace.sqlite`, and `applyScopedMigrations` initializes only the workspace scoped `schema_migrations` ledger.
- `createStorageLayoutReport` produces a read-only baseline report for the current data root, including server/user/workspace database presence, applied migration ledgers, workspace `indexes/` status, and quarantined storage file inventory.
- `GET /api/app/storage/layout-report` exposes the same report through the public App API with `@openkit/app-api-schemas` validation, `@openkit/core-client` exposes `client.app.getStorageLayoutReport()` for first-party consumers, and `@openkit/mcp` exposes `openkit.read_storage_layout_report` plus `openkit://storage/layout-report` for AI-native operator inspection. Because the report covers deployment-wide storage topology and quarantine inventory, this is a deployment-wide administration route governed by `docs/specs/20260704-remote_auth_credential_bootstrap.md`, not a workspace diagnostic.
- `rebuildWorkspaceDerivedIndexes` rebuilds the first workspace-derived index file at `indexes/search.json` from file-backed workspace projections and authoritative workspace snapshot records, deleting stale derived index files before writing the rebuilt index.
- `rebuildExistingWorkspaceDerivedIndexes` runs the same derived-index rebuild at boot for existing workspace directories that have a canonical `workspace.json` projection, skipping half-built workspace directories without that projection.
- The server-scope database currently holds Better Auth or auth implementation rows, server settings, users, scheduler coordination, worker-control ledgers, and durable backend-session lifecycle rows. Restart closeout reuses those owners and adds no settlement table.
- Workspace repository resources, worker-turn checkpoints, pending user turns, Goal Mode goal records, Goal Mode task records, Goal Mode review records, Goal Mode verification records, workspace apply results, workspace input snapshots, workspace materialization records, workspace change sets, staged workspace reviews, workspace filesystem staging roots, and workspace-scoped permission decisions now live in workspace-owned `workspace.sqlite` files with workspace-scoped migration ledgers.
- Worker checkpoint rows carry workspace/thread/turn lineage, context package digest, stage, stop reason, and redacted diagnostics.

`users/<userId>/db/user.sqlite` has a concrete open path and migration ledger. The current Workspace database path is `users/<userId>/workspaces/<workspaceId>/db/workspace.sqlite`; the accepted replacement is `workspaces/<workspaceId>/db/workspace.sqlite`. Repository, worker checkpoint, pending user turn, Goal Mode goal/task/review/verification, apply-result, workspace synchronization review, filesystem staging, and workspace permission-decision rows are the first workspace-owned domain rows moved out of the server database.

The workspace physical `memory/` directory has been replaced by `knowledge/`. OpenKit-owned protocol, App API, MCP, NanoCore, core-client, and Web surfaces now use `knowledge`; remaining `memory` mentions in active implementation are ordinary in-memory wording, resource-limit options, or fail-closed unsupported layout guards.

The current file projection materializes turn items as file-backed JSONL under per-thread and per-turn storage paths, knowledge page Markdown under `knowledge/pages/<knowledgeEntryId>.md`, app-local knowledge proposal Markdown under `knowledge/proposals/<proposalId>.md`, app-local knowledge proposal review decisions under `knowledge/reviews/<proposalId>.json`, source identity records under `sources/registry/<sourceId>.json`, registered text source material under `sources/materials/<sourceId>/content.txt`, artifact metadata under `artifacts/<artifactId>/artifact.json` with content files under `artifacts/<artifactId>/files/content.{md,txt,json}`, and agent session records under `runtime/agent-sessions/<agentSessionId>/session.json`. The target layout keeps item logs, knowledge pages, proposal summaries and review decisions, source identity records, source material evidence, artifact metadata and content files, and agent-session runtime records file-backed, but moves ownership and recovery rules into the workspace tree defined in this spec.

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
  artifacts/
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

Runtime-internal sub-agent streams and their native origin indexes follow the restricted evidence and product-safe normalization contract in `docs/specs/20260711-worker_runtime_subagent_provenance.md`; they do not create additional OpenKit thread, turn, or agent-session storage trees.

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
- agent session id when applicable
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

Migration from the current partial implementation should be explicit and one-way:

1. Create the target tree.
2. Move server-owned runtime files under `server/`.
3. Preflight every registered Workspace against its current `users/<ownerUserId>/workspaces/<workspaceId>` source and fail on missing, duplicate, linked, or ambiguous roots.
4. Copy each verified Workspace into a same-filesystem staging root, verify its complete inventory and authoritative databases, then atomically publish it at `workspaces/<workspaceId>`.
5. Repoint all Workspace openers and recovery scans to the owner-independent root, rebuild derived indexes, and write the new layout marker only after every Workspace has been verified.
6. Retain the old user-nested source as bounded rollback evidence until the migration is accepted; do not add a dual reader, alias, or filesystem link.
7. Keep a migration report that records source, target, digests, and outcome without exposing credentials or user content.

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
- Schema evolution tests should prove unknown optional storage metadata is tolerated and unsupported required features fail closed.

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
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
