# Storage Model

Status: Accepted

This document records the storage principles and key concepts for OpenKit.

This document owns OpenKit's file-system-first storage principles, logical storage hierarchy, SQLite companion-store boundary, source-of-truth rules, and item-log persistence invariants.

This document does not own the complete physical schema, table layout, file layout, migration plan, backup format, app read models, protocol record semantics, vault backend design, or implementation-specific data-root paths.

## Principles

OpenKit is file-system first.

Most durable data should be stored as files or directories so workspace data remains inspectable, portable, easy to back up, easy to archive, and easy to migrate.

SQLite is a companion store, not the default source of truth for every object.

Use SQLite where the system needs structured query, indexes, full-text search, vector or embedding metadata, pagination, constraints, transactions, materialized read models, or operational summaries.

The source of truth must be explicit per data class.

Storage decisions must not create a competing product model. They project core records into files, directories, SQLite tables, indexes, and materialized read models.

Secret values belong to the vault boundary, not normal workspace files or protocol records.

Storage formats should remain additive after the current baseline. Unknown optional fields may be ignored only when they do not affect authority, safety, retention, billing, or product meaning, and unsupported required features must fail closed.

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
- workspace-owned repositories, workspace files, task artifacts, turn and item materialization, workspace knowledge, agent runtime outputs, and workspace-specific logs

The concrete path tree is defined in the server config and data layout spec, not duplicated here.

## SQLite Layers

One Core server may use multiple SQLite databases.

A server-level database belongs to one Core server installation and may hold global indexes, known users, workspace registry data, server metadata, and migration metadata.

A user-level database belongs to one user and may hold user-level metadata, preferences, workspace list or order, and user-level indexes.

A workspace-level database belongs to one workspace and may hold workspace-local indexes, search tables, vector or embedding metadata, materialized read models, and operational summaries.

Per-workspace SQLite files are preferred for workspace-local structured data because they make backup, export, deletion, migration, and debugging easier.

## Source Of Truth

The source of truth should be explicit per data class.

Suggested default:

- Files are the source of truth for workspace records, thread records, turn records, item logs, artifacts, knowledge sources, server config, provider instance inputs, agent setup config, runtime snapshots, and logs.
- SQLite indexes those records for query, search, pagination, constraints, and UI read models.
- SQLite may be the source of truth for operational records that do not have a natural durable file form and require structured query.
- Secret values are not stored in normal workspace files or protocol records. Workspace storage may keep secret references, grants, injection rules, and audit metadata, while secret material belongs in a vault backend or encrypted local vault.

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

## Invariants

- Workspace data MUST remain separable enough for backup, export, deletion, migration, and debugging.
- Workspace-owned storage MUST remain independent from any current human owner's user-owned storage so sharing or owner transfer never requires copying, linking, or moving canonical workspace data.
- User-visible workspace collections MUST be derived from identity and permission relationships rather than filesystem discovery or user-owned links.
- File-backed records SHOULD be inspectable and portable unless a data class has a clear reason to use SQLite as source of truth.
- Derived SQLite indexes SHOULD be rebuildable from file-backed records when SQLite is not the source of truth.
- An integrity failure in authority-bearing storage MUST fail closed and preserve the original store in place; automatic recovery MUST NOT replace lost authority with a fresh empty store.
- Storage layout MUST NOT redefine workspace, thread, turn, item, artifact, knowledge, vault, audit, usage, or agent-session semantics.
- Secret values MUST NOT be stored in normal workspace files, item payloads, protocol records, or derived indexes.
- Authority-bearing storage fields MUST NOT be silently ignored by readers that do not understand them.

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

Local secret storage supports OS keychains and local encrypted vault files through the vault boundary, not normal storage records.
