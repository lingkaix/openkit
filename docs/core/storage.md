---
status: Accepted
updated: 2026-08-22
---
# Storage Model

This document records the storage principles and key concepts for OpenKit.

This document owns OpenKit's file-system-first storage principles, logical storage hierarchy, SQLite companion-store boundary, source-of-truth rules, item-log persistence invariants, and the boundary between bounded NanoCore product storage and external source storage.

This document does not own the complete physical schema, table layout, file layout, migration plan, backup format, app read models, protocol record semantics, vault backend design, or implementation-specific data-root paths.

## Principles

OpenKit is file-system first.

Most durable data should be stored as files or directories so workspace data remains inspectable, portable, easy to back up, easy to archive, and easy to migrate.

SQLite is a companion store, not the default source of truth for every object.

Use SQLite where the system needs structured query, indexes, full-text search, vector or embedding metadata, pagination, constraints, transactions, materialized read models, or operational summaries.

The source of truth MUST be explicit per data class.

Storage decisions must not create a competing product model. They project core records into files, directories, SQLite tables, indexes, and materialized read models.

NanoCore is not a general repository, object, or bulk-file storage service. It may retain bounded product records, Workspace files, Artifacts, uploads, evidence, and runtime handoff data only through their existing owners and limits. Versioned text and code sources belong in a network-addressable Git service. Static source data that exceeds an accepted bounded NanoCore record, upload, Artifact, or evidence contract belongs in external object storage such as S3-compatible storage. NanoCore stores the non-secret locator, policy, immutable revision or digest lineage, and bounded coordination metadata needed to use those sources; it does not host or silently absorb the external storage service.

Secret values belong to the vault boundary, not normal workspace files or protocol records.

Storage format evolution follows the unknown-field preservation and fail-closed rules in `docs/core/contract-evolution.md`.

## Storage Hierarchy

The logical storage hierarchy is:

```text
CoreServer
  User
  Workspace
```

User and Workspace are independent storage scopes. Identity membership links users to workspaces, while workspace ownership and access relationships must not be encoded by nesting the workspace under the current owner's storage scope.

Storage ownership is divided into three conceptual areas:

- server-owned config, provider instances, agent setup sources, runtime snapshots, scheduler diagnostics, process logs, global indexes, and migration metadata
- user-owned files, preferences, user-local data, user logs, user-scoped config, and user-specific workspace ordering or recent-workspace indexes
- workspace-owned repository references and lineage, bounded workspace files, task artifacts, turn and item materialization, workspace knowledge, agent runtime outputs, and workspace-specific logs

The concrete path tree is defined in the server config and data layout spec, not duplicated here.

## SQLite Layers

One Core server may use multiple SQLite databases.

A server-level database belongs to one Core server installation and may hold global indexes, known users, workspace registry data, server metadata, and migration metadata.

A user-level database belongs to one user and may hold user-level metadata, preferences, workspace list or order, and user-level indexes.

A workspace-level database belongs to one workspace and may hold workspace-local indexes, search tables, vector or embedding metadata, materialized read models, and operational summaries.

Per-workspace SQLite files are preferred for workspace-local structured data because they make backup, export, deletion, migration, and debugging easier.

## Source Of Truth

Non-authoritative defaults:

- Files are the source of truth for workspace records, thread records, turn records, item logs, artifacts, knowledge sources, server config, provider instance inputs, agent setup config, runtime snapshots, and logs.
- SQLite indexes those records for query, search, pagination, constraints, and UI read models.
- SQLite may be the source of truth for operational records that do not have a natural durable file form and require structured query.
- Secret values are not stored in normal workspace files or protocol records. Workspace storage may keep secret references, grants, injection rules, and audit metadata, while secret material belongs behind the vault boundary.

If SQLite stores a derived copy of a file-backed record, the default expectation is that the SQLite data can be rebuilt from file-system records.

SQLite source-of-truth record classes may include:

- permission decisions
- audit events
- usage records
- capability calls
- vault grants and non-secret vault metadata
- idempotency records for command request IDs
- stream cursor retention metadata
- operational health and diagnostics summaries

These records still belong to the core model. SQLite being their source of truth is a storage decision, not a separate product model.

## Retention Classes

The closed Core retention-class vocabulary is:

```text
ephemeral-diagnostic
turn-evidence
workspace-audit
restricted-raw
legal-hold
```

Owning record specifications assign these classes and their ordinary retention windows. Material under `legal-hold` MUST NOT be compacted or deleted until the hold is released.

## Agent Data Retention And Deletion

Agent features introduce no retention class, retention engine, or global deletion workflow. They use the closed vocabulary above through the existing Thread, Turn, Item, Artifact, Knowledge, audit, usage, evidence, Workspace, user, and Vault owners.

The explicit mappings are:

| Agent data | Existing class mapping | Boundary |
| --- | --- | --- |
| Raw audio, microphone frames, partial transcripts, interrupted audio, speculative tokens, incomplete Tool calls, runtime-private chain-of-thought, and hidden provider reasoning | Not persisted by default. A demonstrated diagnostic or verification capture of raw material is `restricted-raw`; a bounded redacted health, retry, or feature-negotiation summary is `ephemeral-diagnostic`. | Neither class turns raw material into product history, completion proof, authority, or required recovery state. A future retained audio product requires its own accepted consent, access, visibility, export, deletion, and retention contract. |
| Raw provider payloads, native Worker transcripts, unrestricted logs, sensitive traces, and quarantined output retained for a demonstrated bounded need | `restricted-raw` | Product-safe records reference the restricted material by id and digest and never duplicate it into ordinary Items, audit rows, or diagnostics. |
| Normalized proof needed to explain one worker Turn, Artifact, Workspace review, or verification result | `turn-evidence` | The evidence owner decides promotion and retention; the Agent or runtime cannot extend its window or use raw content as a substitute. |
| Audit, usage, permission, capability, Vault-use, deletion, revocation, and authority-change facts needed for Workspace governance | `workspace-audit` | These facts follow the responsibility owner's home and deletion rules and remain non-authorizing historical lineage. |
| Any retained class above under an explicit deletion block | `legal-hold` | The hold blocks deletion until its owner releases it; it does not create ordinary retention policy or authorize access. |

Search indexes, embeddings, summaries, prompt caches, provider sessions, runtime materializations, materialized views, and other derived state are reconstructible projections, not a new durable agent-data class. They are invalidated or made ineligible after source deletion, authorization loss, incompatible revision, or policy change, and their invalidation changes no product truth. A persisted invalidation diagnostic uses `ephemeral-diagnostic`; normalized proof that the invalidation affected one governed Turn or review uses `turn-evidence`; the derived bytes themselves do not become durable merely to receive a class.

Deletion follows the owning resource. Acceptance of authorization removal, source revocation, or deletion immediately prevents future reads and promotions through current admission even when physical cleanup or derived-index rebuild completes later. Derived projections are then invalidated and rebuilt from remaining current sources. Historical commands, Reviews, Goal outcomes, audit facts, and minimal unavailable-source lineage are not rewritten, and separately accepted Artifacts, Knowledge Pages, Materials, and evidence follow their own owners and retention classes rather than a guessed cascade.

Workspace and user deletion reuse their existing closure-export, backup, legal-hold, Vault, and fail-closed cleanup owners. If complete deletion or revocation cannot be proved, future access fails closed and the applicable owner reports degraded, restricted, or recovery-required state; it does not serve a stale cache, infer physical erasure, or create an Agent-specific repair workflow. Retry is a fresh owner-authorized deletion, rebuild, or access request from current truth and never a blind replay across Core storage and an external runtime effect domain.

The durable lifecycle of raw audio and private reasoning is explicitly not applicable because current policy creates no durable record for them. Creation, update, termination, retry, and recovery remain applicable to every retained diagnostic, evidence, audit, or owner-specific resource through its existing owner. Observable acceptance requires default execution to persist no raw audio or private reasoning, every demonstrated raw diagnostic to be `restricted-raw`, every bounded diagnostic summary to use only its existing applicable class, source deletion or revocation to prevent future derived reads before cleanup finishes, independent accepted resources to remain under their own owners, and `legal-hold` to block deletion without granting access.

## Invariants

- Workspace data MUST remain separable enough for backup, export, deletion, migration, and debugging.
- Workspace-owned storage MUST remain independent from any current human owner's user-owned storage so sharing or owner transfer never requires copying, linking, or moving canonical workspace data.
- User-visible workspace collections MUST be derived from identity and permission relationships rather than filesystem discovery or user-owned links.
- File-backed records SHOULD be inspectable and portable unless a data class has a clear reason to use SQLite as source of truth.
- Derived SQLite indexes SHOULD be rebuildable from file-backed records when SQLite is not the source of truth.
- An integrity failure in authority-bearing storage MUST fail closed and preserve the original store in place; automatic recovery MUST NOT replace lost authority with a fresh empty store.
- Storage layout MUST NOT redefine workspace, thread, turn, item, artifact, knowledge, vault, audit, usage, or AgentSession semantics.
- Secret values MUST NOT be stored in normal workspace files, item payloads, protocol records, or derived indexes.
- Authority-bearing storage fields MUST NOT be silently ignored by readers that do not understand them.
- A remote Agent Runtime MUST NOT consume a host-local Git repository path from the NanoCore server. Required code or versioned text MUST first exist through an authorized network-addressable Git source, and the Sandbox performs Git operations under its current network and Vault policy.
- Large static source data MUST remain in an external object store once it exceeds the applicable bounded NanoCore-owned record or handoff contract. NanoCore retains only the external reference and required bounded lineage; neither NanoCore nor NanoHost becomes the object-storage service.

## Item Log Invariants

Item logs MUST be append-only.

Item writes MUST preserve the same ordering that clients observe through protocol event streams.

Replay MUST reproduce item order according to the stored stream sequence.

Item writes SHOULD persist the `protocolVersion` that was active when the item event was recorded.

Implementations SHOULD use a single-writer or equivalent atomic append discipline per item log scope so replay cannot observe partial item events.

Compaction MAY materialize completed item snapshots, but it MUST NOT change item IDs, causation links, or the final meaning of completed items.

## Storage Scope Direction

User-level and workspace-level databases should be introduced only when their independent ownership scopes need them.

SQLite full-text search is the default search index family. Vector search remains an optional future index family until promoted by stable core requirements.

The current local and server realization uses the encrypted-file Vault through the vault boundary, not normal storage records. Concrete ciphertext, metadata, and key-file layout remain implementation-facing Vault concerns.
