---
status: Accepted
implementation: Partial
kind: mechanism
aspect: storage
---
# File Storage And Knowledge Packages

This specification is the single owner of shared citable content references (`contentRef`), the `@openkit/storage` package boundary and Storage access-lease record, Knowledge Base mounts and canonical `raw/` layout, Notebook Git `SourceSummary` pointers and page-relative raw embeds, derivative representation lineage, and the Knowledge package v1 interchange format and transport.

## Scope

Owns shared content references (`ContentReferenceSchema` in `@openkit/protocol`), the Storage Service boundary (`@openkit/storage`) and Storage access-lease record (`basis: 'lease'`), Knowledge mounts (`knowledgeMounts`) and `defaultKnowledgeBaseId` binding, `SourceSummary` pointers (`sources/<source-id>.md`), page-relative raw embeds, derivative representation lineage, and the Knowledge package v1 format (`openkit.knowledge-package`) and streaming export/import transport.

Does not own:
- Core SQLite control stores, execution journals, or physical storage layout ([Durable Execution And Control Store](20261019-durable_execution_and_control_store.md), [Storage Layout And Record Ownership](20260703-storage_layout_record_ownership.md)).
- Record envelope and required-feature registry mechanics ([Schema Evolution And Record Envelope](20260703-schema_evolution_record_envelope.md)) or Policy statement evaluation ([Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md)).
- Knowledge Store governance, Notebook editing, or Retrieval Kernel query execution ([Knowledge Store Implementation](20260703-knowledge_store_implementation.md), [Knowledge Notebook Editing](20260909-knowledge_notebook_editing.md), [Retrieval Kernel](20261014-retrieval_kernel.md)).
- Worker Context Package assembly ([Worker Context Package](20260703-worker_context_package.md)) or Workspace operational backup, restore, MOVE, and V3 export ([Workspace Backup, Export, Import, And Data-Root Migration](20260704-workspace_backup_export_import.md)).

Core: [Storage](../core/storage.md), [Knowledge](../core/knowledge.md), [Communication](../core/communication.md), [Policy](../core/policy.md), [Contract Evolution](../core/contract-evolution.md), [Vault](../core/vault.md).

## Control-Store Integration

Core `DatabaseOwner` and the Storage Service share L0 durable atomic writes, verified copy and publication, hold-aware deletion, digests, path safety, temporary-root hygiene, and scope-local immutable blobs with no cross-scope deduplication. `DatabaseOwner` owns Core SQLite; the Storage Service owns user-data locations, backends, and access leases. Neither depends on the other's transaction or backend abstraction.

Immutable execution and work content reuses this Storage Service, local backend, and `contentRef` format without introducing a second blob service, attachment identity, or access authority. Workspace Notebook publication selection uses its scope SQLite database head (`knowledge_notebook_heads`), while Git retains content and history authority; authored configuration uses its file-revision service. Knowledge package import and export remain domain operations that follow the scope's publication boundary rather than creating a competing head. Snapshot consistency of app databases and opaque process data belongs to their declared writer boundaries rather than Storage guessing a file format.

Required user work data returns through storage handoff and domain publication under [Storage](../core/storage.md#source-of-truth). Required bytes MUST be verified and admitted by their existing owners before work counts as complete or their only copy is removed; a locator alone is insufficient. Reference-only external sources and omitted-volume backup rules MUST NOT excuse leaving required produced user data only with an executor or provider. Core MUST refuse admission for a placement that cannot return a required volume or data size within storage limits; it MUST NOT substitute a reference-only result.

## Layers And Shared References

| Layer | Meaning | Exclusion |
| --- | --- | --- |
| Content, or Blob | Exact raw-byte SHA-256, size, and sniffed media type. | Neither owner identity nor permission. |
| Location | Where bytes live; plural and changeable. | Neither content identity nor guaranteed availability. |
| Attachment | Existing owner/object/version binds content and captured location. | No new attachment ID or permission graph. |
| Derivative | Output with exact source and recipe lineage. | Neither original evidence nor curated Knowledge. |
| Index | Rebuildable discovery and retrieval. | No canonical content or access authority. |
| Knowledge entry | An OKF page with its own scope-qualified ID and Notebook revision. | Its ID is not a file digest. |

Existing owner records carry content descriptors: `contentDigest` is raw-byte SHA-256 (`sha256:` plus 64 lowercase hexadecimal characters), `byteLength` is a nonnegative integer, and `mediaType` is the sniffed result (declared media is separate; unknown media uses `application/octet-stream`, and classification never replaces parser validation). An object-store ETag or Git object ID is not a raw-byte SHA-256.

The shared citable `contentRef` is defined by `ContentReferenceSchema` in `packages/protocol/src/common/content-reference.ts`. Existing owner records remain canonical; this shared projection creates no independently mutable digest authority. Its scope-qualified identity and textual URI follow [Protocol](../core/protocol.md#scope-qualified-object-references); implementations MUST NOT introduce a second URI codec or interpret a pointer-page digest as its original's digest.

For Knowledge Source pointers, `knowledgeBaseId` is the exact Knowledge Base identity, validated against its owner scope rather than inferred from a locator. For native work-content references, `knowledgeBaseId` is explicit `null`, admitted only in a Server or Workspace `backend-evidence` mount with a `sha256/<digest>` path, and allocates no Knowledge Base. Native work-content references use whole-source (`null`) or byte coordinates, never page coordinates; their locator's digest suffix MUST equal the captured `contentDigest`, and Storage refuses a different observed digest before stat or sealed-stage handoff succeeds. `availability` records observed state rather than permission or a future guarantee, preserving descriptive metadata, digest, and captured locator. Unknown core cases fail closed, while descriptive additions remain ignorable. Storage range reads accept byte coordinates without implicit media conversion.

Qualified Source ID/digest and versioned Artifact references serve as attachment identities with no parallel attachment ID. Source pointers bind logical mount paths only; backend locations belong to mount declarations.

## Reference Lifecycle

Consumers MUST verify resolved bytes against the captured digest and size before claiming exact content. A changed file at the same locator is `unavailable` for that reference. Another location is usable only when currently authorized and verified against the same identity. A new capture uses the owner's publication lifecycle; implementations MUST NOT guess a replacement from a name or title. Public errors MUST NOT expose denied metadata.

For reference-only sources, reading or processing creates no retention promise, and implementations MUST NOT copy originals or derivative excerpts solely for later replay. Explicitly imported managed files are originals, not additional retention copies. Rebuildable derivatives may support current processing or indexing without guaranteeing future retrieval. Deletion follows existing owner and hold rules; metadata can survive deliberate deletion of bulky source bytes without a new tombstone family. Restart resolves current availability rather than reconstructing from a changed source, and retry repeats current admission.

## Storage Package And Access

The Storage Service (`packages/storage/src/contract.ts`, `@openkit/storage`) is an asynchronous, streaming, process-agnostic package. Requests and results carry serializable values, bounded base64 byte chunks, and opaque handles, never shared mutable objects, callbacks, or native file handles. Current default contract bounds are `1,000,000,000` content bytes, `1,048,576`-byte chunks (`1 MiB`), `256` scan entries per page, and `16` open stages (`STORAGE_CONTRACT_LIMITS` in `packages/storage/src/contract.ts`). Closed failure statuses and unavailability reasons are defined by `StorageFailure` and `StorageResult` in `packages/storage/src/contract.ts`.

| Storage operation | Boundary |
| --- | --- |
| Content reference / stat | Return observed identity, size, metadata, and availability under an admitted mount. |
| List / metadata find | Bounded metadata discovery (`path`, `kind`, `byteLength`) with continuation; no semantic ranking or media extraction. |
| Range read | Bounded byte chunks for a citable reference and byte range. |
| Admitted access | Enforce the supplied access scope, mount, prefix, mode, and lease expiry/revocation when present; do not decide Policy. |
| Staged write | Write new bytes to a staged location and return a handle and verified identity for NanoCore admission. |
| Commit handoff | NanoCore commits through the owning Source, Artifact/version, Review, and Audit boundaries; Storage grants no publication authority. |
| Change feed / scan cursor | Return a bounded incremental view for ingestion; a stale cursor reports `rescan-required` rather than false completeness. |

Local filesystem storage (`LocalStorage`) is the active backend. Vault owns credentials; locators and handles contain no secret values.

Storage enforces the supplied `StorageAccess` boundary: exact `ownerScope`, `knowledgeBaseId`, `mount`, normalized relative `pathPrefix` (an empty prefix addresses the mount root; absolute paths, traversal, duplicate separators, backslashes, and NUL are invalid), and `mode`. Trusted callers MUST establish current credential, Policy Kernel, and resource authority before each request; historical `PermissionDecision` or Audit records supply no continuing access.

Storage leases use ordinary Policy grants (authored Policy does not define a separate `storage-lease` grant kind), and this specification owns the Storage access-lease record (`basis: 'lease'`, carrying `grantId`, `expiresAt`, `revoked`, `ownerScope`, exact `knowledgeBaseId`, `mount`, `pathPrefix`, and `mode`). Storage enforces expiry and revocation on lease inputs; expired or revoked leases block new operations and require removal or fencing of continued mounted exposure. A lease grants neither an in-place overwrite nor a commit; writes stage by default, and an explicit in-place change passes NanoCore interception under Policy. Capacity or publication failures return an error without overwriting existing originals.

Managed Source originals belong to their exact Knowledge Base. Native capture and reads within that base use the caller's current Knowledge authority (`basis: 'knowledge'`), derived per request and bounded to the current owner, exact `knowledgeBaseId`, a mount marked `managed`, and exact `pathPrefix: 'sources'`; they do not require or create a lease, carry no statement ID or invented expiry, and are never persisted as a grant. Native writes use the Notebook publisher path, and revocation denies the next request. Worker exposure and external or host mounts cross the Knowledge Base boundary and require an explicit current lease; Knowledge authority alone cannot obtain those bytes, and a missing, expired, or revoked lease cannot be substituted into `basis: 'knowledge'`.

The `work-capture` `StorageAccess` basis (`basis: 'work-capture'`) is current trusted native admission for retained work bytes, requiring `knowledgeBaseId: null`, the exact Server or Workspace owner, the configured `backend-evidence` mount (`evidence/backend/` with digest objects at `sha256/<digest>`), and a confined prefix. It carries no grant ID, expiry, or revocation field, is never retained as a grant, and cannot select a Knowledge mount, User scope, external mount, or host mount. Native staging uses the same bounded operations and exact basis/owner/mount/prefix handle binding as other staging; restart invalidates temporary handles.

## Knowledge Mounts And Canonical Layout

The default local mount is the Knowledge Base's physical `raw/` directory (`raw/image.png` has no default-mount name segment). Additional mounts occupy declared namespace subdirectories `raw/<mount>/`. A declaration carries `name`, `backend`, backend-specific `root`, `default` boolean, and `knowledgeBaseId`; names are unique within that Knowledge Base, and exactly one mount is `default: true`. Additional mount names are reserved in the manifest, and any declaration that collides with a physical folder under `raw/` is rejected. Unsupported backend activation returns `unavailable`, never another root.

The shared mount array is `knowledgeMounts` beside `defaultKnowledgeBaseId` in the Server and User configurations and in the Workspace configuration `workspace` object. Fresh native Knowledge Base creation records one local default mount named `managed` with `root: 'raw'` relative to that scope's Knowledge root. Additional local roots resolve relative to that same root or use an explicit administrator-authored absolute path. Every declaration binds the scope's exact fixed `knowledgeBaseId`; missing or contradictory established declarations fail explicitly.

| Canonical path or family | Meaning |
| --- | --- |
| `raw/` | Default local mount's immutable managed originals (`raw/a.pdf`). Additional declared mounts occupy `raw/<mount>/`. |
| `pages/` | One published OKF bundle, including reserved `index.md` and `log.md` when present. |
| `schema/` | Authored scope schema (`scope-schema.yaml`); content edits grant no authority. |
| Mount declarations | Scope-owned Knowledge configuration (`knowledgeMounts` and `defaultKnowledgeBaseId`). |
| `sources/<source-id>.md` | Admitted `SourceSummary` pointer pages in Notebook Git; replace the retired external Source registry. |
| `derived/`, `indexes/` | Optional rebuildable outputs and search generations, distinct from authored navigation. |
| `notebook.git/` | Notebook content and history store outside the OKF bundle; Workspace publication selection is SQL-owned. |

Each User, Workspace, or Server scope allocates its default Knowledge Base once with the shared independent `kb_<UUIDv7>` generator ([Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#ids)) and retains `defaultKnowledgeBaseId` in its scope configuration (`Version 0.1.0` supports one Knowledge Base per scope). Before a scope has a Knowledge Base the field may be absent; configuration parsing and reference lookup never allocate it. Once created, the binding is immutable; retry, restart, and backup preserve the same ID, and missing or contradictory established authority returns `recovery_required`. Import into a new or empty Workspace binds to its target-owned base and remaps source Knowledge Base references through the import map without granting source authority. The Knowledge Manager reads originals without modifying them and maintains pages, navigation, and log through the Notebook owner. Published Git tree paths map one-to-one to package paths; raw bytes never enter Git, and `schema/` stays outside the page tree.

## Raw File Tracking In Git

Each admitted Source has one OKF `SourceSummary` pointer at `sources/<source-id>.md` in Notebook Git. Its identity is the Source ID in `sources/<source-id>.md`. Only the native Source publisher can create, remove, or change captured facts; ordinary notebook edits (including Workspace virtual descriptive editing at `@sources/<source-id>.md`) may update the summary body and descriptive fields (`title`, `description`, `tags`) while preserving captured facts, governance, Source identity, and original bytes. Capture requires a Protocol request UUID before original Storage writes and records the actual producer and authority in Notebook commit metadata and Source Audit/receipts.

| `SourceSummary` field | Meaning |
| --- | --- |
| `contentRef` | Shared descriptor binding the exact `knowledgeBaseId`, original digest, logical mount/path (`raw/<path>` for the default mount, `raw/<mount>/<path>` for additional mounts), `range: null`, and `availability`. |
| `byteLength`, `mediaType` | Shared content facts verifying exact bytes and sniffed format. |
| `sourceKind`, `uri` | Source category and nullable external origin; confers no capture channel or network access. |
| `capturedAt`, `captureChannel` | Actual capture timestamp and native operation ID. |
| `originatingThreadId`, `originatingTurnId`, `originatingFileId` | Nullable Source lineage used by audience admission; grants no access. |
| `title`, optional `description` and `tags` | Authored OKF descriptive fields for inspection and discovery. |

Profile `created_at` and `updated_at` carry Source creation and pointer-change timestamps. Captured fields are read from the published Git revision, never a sidecar. Text tools decode a verified original as exact UTF-8 or report it unavailable for that text tool, while binary bytes remain readable through Storage. Source byte reads are asynchronous and recheck current scope and Source admission at delivery. A changed original updates its pointer through a Notebook commit; historical `source:<id>@<old digest>` references resolve only while Storage retains authorized matching bytes, and deletion keeps the pointer marked `unavailable`. Only admitted Sources receive Git pointer pages; small local libraries may auto-admit under capture Policy, while large mounts admit on demand over Storage's on-demand mount index.

## Embedded File References

Knowledge embeds use RFC 3986 relative paths from the page's own directory (for example `pages/topic/x.md` uses `![](../../raw/image.png)` for `raw/image.png`). At publication, the publisher MUST normalize each embedded path, require its resolved target to stay inside the Knowledge Base and `raw/`, validate its mount, auto-admit any missing `SourceSummary` pointer in the same commit under current Source admission, and record each embedded file's exact digest in commit `sourceReferences` as `source:<id>@<digest>`. Body embeds follow the current version, while historical page revisions use their recorded digest or show `unavailable`; evidence citations stay pinned in `source_refs` as `source:<id>@<digest>`. Raw-file renames or moves and page moves MUST rewrite referencing relative embeds under existing validation and review without changing historical bytes.

An authenticated NanoCore byte-delivery route checks the reader's audience and sensitivity under Policy, audits issuance, and streams local bytes (or issues a short-lived redirect for remote backends) with HTTP `Range`, sniffed `mediaType` as `Content-Type`, and `contentDigest` as `ETag`. Web rendering resolves stored relative paths through that route without rewriting stored Markdown, models receive bytes through vision paths rather than URLs, and neither the server nor Web automatically fetches external `http(s)` images.

## Byte Facade And Consumer Extensions

File references shown to models or stored in retained records MUST be canonical scope-qualified URIs ([Protocol](../core/protocol.md#scope-qualified-object-references)) or Knowledge-local page-relative raw paths, never transport URLs or credentials. A URI grants no access; every fetch MUST be authorized at fetch time. Notification and chat channels MUST carry App links only, never presigned byte URLs, so link unfurling cannot copy bytes outside access checks.

## Worker Access

Workers access leased storage through NanoCore-mediated MCP tools (list, metadata find, stat, range read, staged write, and commit) or host-side leased read-only bind mounts under the [Workspace and Artifact planes](../core/communication.md#workspace-plane) at a stable sandbox path, with no FUSE inside the sandbox and staged writes committed through NanoCore. Worker access requires a current lease and source/destination admission; stable sandbox paths do not preserve revoked authority across Turns.

## Knowledge Package Format

A Knowledge package (`apps/nanocore/src/storage/knowledge-package/`) is a logical directory containing one admitted Knowledge Base: its published Git tree materialized at canonical relative paths below `pages/`, `sources/` (`.md` filenames), `schema/`, `raw/`, and optional `indexes/`, plus root `manifest.json`. Default-mount originals use `raw/<path>` with no mount-name segment.

| Manifest field | Required meaning |
| --- | --- |
| `schemaVersion` | Integer `1`, checked through `@openkit/protocol` retained-v1 helpers before decoding; unsupported versions fail closed. |
| `format` | Literal `'openkit.knowledge-package'`. |
| `ownerScope`, `knowledgeBaseId` | Source scope and exact Knowledge Base ID for provenance and remapping, never imported authority. |
| `requiredFeatures` | Required semantics (`openkit.knowledge-git-notebook.v1` and `openkit.knowledge-owner-scope.v1`). |
| `notebookRevision` | Exact source published revision (at most `256` characters), not target publication authority. |
| `contentInventory` | `{path, contentDigest, byteLength}` for every included regular file (excluding `manifest.json`). |
| `mounts` | Transport declarations `{name, backend, root, default}` (`name` at most `255` characters, `backend` at most `128` characters, `root` at most `4096` characters; remote roots MUST NOT carry embedded authority, query, or fragment components). |

Format and reader rules:
- The package carries the default mount's available managed bytes. Exactly one mount entry MUST have `default: true`, `backend: 'local'`, and exact `root: 'raw/'` (with a trailing slash, distinct from live configuration `root: 'raw'`). Additional declared mounts reserve their `raw/<mount>/` subtree (including empty directories) and travel as declarations and digest-bound references without bytes; an explicitly unavailable managed original retains metadata without a `raw/` inventory entry, while a missing supposedly available managed file fails export.
- Manifest `contentInventory` paths, `mounts` names, and `requiredFeatures` MUST be unique by exact string comparison. Tar archive ingress (`archive.ts`) additionally rejects case-insensitive duplicate entry paths (`toLowerCase()`).
- Inventory paths MUST be confined regular files free of file/directory collisions; symbolic links, hard links, special files, and undeclared files are rejected. Format validation never follows or activates an external root. Unknown descriptive manifest fields are ignored; unknown versions, required features, or invalid core bindings fail closed. Required semantics MUST be registered with the record-envelope and format owners before writers or imports activate them; pre-`v0.1.0` conversion migrations, legacy readers, and dual writes are excluded, while explicit reset authorization and post-`v0.1.0` continuity follow [Contract Evolution](../core/contract-evolution.md#retained-data-continuity).
- The initial format admits no `derived/` directory or derivative manifest entries until a derivative exporter registers a `requiredFeatures` gate. When registered, each derivative entry projects representation `id`, lineage (`sourceReference`, `recipe`, `provider`, `model`, optional `embeddingSpace`, `sourceLocator`, `coverage`), `byteLength`, `mediaType`, and nullable `derived/` package `path` (`null` requires `unavailable` output; non-null requires `available` output matching inventory digest and length).
- The native manifest writer emits UTF-16 code-unit-sorted object keys, inventory paths, mount names, and required features in two-space JSON with a final newline, leaving authored file bytes unchanged. `manifest.json` is bounded to `1 MiB` (`1,048,576` bytes); caller admission supplies positive safe-integer entry and byte limits that count the manifest and directories and exclude only the package root. Raw file copying and hashing use bounded chunks. The format writer exclusively creates fresh private staging, removes only its own staging on failure, and never replaces existing output or publishes a Knowledge Base. Format validation requires private immutable staging and proves container integrity only; record admission, scope authority, remapping and publication belong to Export And Import.

### Necessary Differences

| Difference from live canonical layout | Reason |
| --- | --- |
| Add root `manifest.json`. | Interchange requires a format marker, declared closure, and byte inventory. |
| Materialize published `pages/` and `sources/` and exclude `notebook.git/`. | Import publishes through the destination Notebook owner rather than source Git hooks, proposal refs, or live publication state. |
| Omit `derived/` entries until gated by `requiredFeatures`. | Derivative export requires registered lineage semantics. |
| Bind default mount `root: 'raw/'` and strip live credentials and leases. | A package carries no host access or deployment authority; external locations remain references. |
| Omit runtime, permission, command, and local proposal/review stores, and optionally omit rebuildable `indexes/`. | Runtime and review history belong to deployment backup, and indexes are rebuildable accelerators. |

### Export And Import

Export pins one published Notebook revision and captures admitted Source, schema, and mount metadata under existing mutation boundaries, verifying files against the captured inventory and refusing concurrent changes.

Version `0.1.0` import targets a new or bootstrap-only empty Workspace Knowledge Base (no authored content, admitted Sources, retained authored history, proposals, reviews, masks, or suppression). Import validates the manifest version and features, record schemas, confined regular-file paths, quotas, and every inventory digest and length without executing package content or contacting external roots. It binds or allocates the target scope's fixed `defaultKnowledgeBaseId`, remints imported Knowledge Base and owned record references, rewrites internal references through the import map, recomputes affected metadata/page digests and target inventory while keeping raw original digests unchanged, stages the complete Source/page/schema/raw graph together, and publishes through the destination Notebook owner. Collisions refuse. Failed validation or staging leaves the destination unchanged; publication failures preserve published or unknown outcomes and follow the existing Notebook inspection/recovery contract. No distributed transaction, new receipt family, or automatic remote repair is added. Imported metadata grants no Policy, maintenance, or protected-page authority, and suppression and masking remain binding.

Workspace-to-Workspace transport uses two streaming App API operations (`routes.ts`): `knowledge.package.export` takes `workspaceId` in the query and returns `application/x-tar`; `knowledge.package.import` requires `workspaceId`, `X-OpenKit-Request-Id`, and a non-empty request body whose `Content-Type` media token before `;` is `application/x-tar`, returning `{workspaceId, knowledgeBaseId, notebookRevision}` under `knowledge.read` or `knowledge.write` admission. Current transport bounds are `8 GiB` (`8,589,934,592` bytes) of content (plus `16 MiB` / `16,777,216` bytes of tar framing overhead), `10,000` entries, `1,000,000,000` bytes per tar member, and `2 MiB` (`2,097,152` bytes) per entry / `32 MiB` (`33,554,432` bytes) total for in-memory non-raw authored metadata.

## Derivative Lineage

Derivative representations extend representation metadata with `sourceReference` (scope-qualified owner/version URI with a mandatory `@<digest>` pin, from which `sourceContentDigest` projects), `recipe` (`{id, version, parameters}`), `provider` and `model` (both strings for model-backed derivation or both `null` for deterministic local tools), optional `embeddingSpace` (required for vectors, omitted otherwise), `sourceLocator` (page, byte, or whole-source coordinates), output `contentRef` / `byteLength` / `mediaType`, and `coverage` (`complete` or `incomplete`). Explicit output unavailability preserves lineage without claiming byte retention, output offsets never claim original coordinates, recipe selection comes from a media-handling Skill used by the Knowledge Manager rather than a hard-coded file-extension pipeline, a derived summary is not curated Knowledge, and equal vector dimensions do not establish embedding-space compatibility.

## Context And Retention

Worker Context Package traces retain delivered projections and owner-qualified original/representation references and digests (`contentRef`, ranges, lineage, and availability) while disposable live Turn materialization receives originals separately; missing historical bytes remain `unavailable` and are never reconstructed from current sources, while delivered Context Package bytes remain retained under [Worker Context Package](20260703-worker_context_package.md).

## Backup And Workspace Export

Operational backup and whole-data-root backup copy canonical Knowledge files (`notebook.git/`, `SourceSummary` pointers, `raw/` originals, and authority stores) unchanged within their snapshot boundary, performing no package conversion or identity remapping ([Workspace Backup, Export, Import, And Data-Root Migration](20260704-workspace_backup_export_import.md)). Restore re-establishes captured deployment data rather than reminted package identities, while Knowledge package export and import separately provide standalone Knowledge Base interchange.

## Derivation And Retrieval Interface

A separate Derivation module owns media extraction and conversion (FFmpeg segmentation/keyframes/transcoding, ASR, PDF.js, OCR, ZIP extraction, and thumbnails), taking an opaque content handle and recipe parameters, running in a bounded process or sandbox without secrets, routing model calls through the Gateway under Policy, and writing output derivatives through Storage with the lineage above.

The indexable unit for retrieval is a derivative with `sourceLocator` and lineage. Retrieval ([Retrieval Kernel](20261014-retrieval_kernel.md)) owns indexing, multimodal and text embeddings, `embeddingSpace` identity, Gateway vector calls, fusion, scoped filtering, and citable hits carrying original `contentRef`, derivative identity/range, and `sourceLocator` resolved through Storage under current caller grants. Storage change feeds drive Derivation and indexing; queries use indexes rather than live Storage scans, and all Worker MCP and Knowledge Manager retrieval access is mediated by NanoCore and filtered by served Knowledge scopes, agent audience, or Worker lease.

## Acceptance

One minimal local Knowledge package round-trip fixture verifies default-mount raw bytes, published OKF pages, and remapped target Knowledge Base and Source references end to end.

## Implementation

- `packages/storage/src/`
- `packages/protocol/src/common/`
- `packages/config-schema/src/`
- `apps/nanocore/src/knowledge/`
- `apps/nanocore/src/storage/knowledge-package/`

## Implementation Gaps

- Storage access-lease producer - Storage enforces transient `basis: 'lease'` inputs and this specification owns the lease record under ordinary Policy grants, but no production service issues or persists storage leases - #765
- Embedded-file auto-admission, commit digest evidence, and raw rename referrer rewriting - Notebook validation and publication exclude embedded image tokens and do not auto-admit missing `SourceSummary` pointers or rewrite referencing pages on raw-file or page moves - #507
- Authenticated Knowledge raw-byte delivery route - NanoCore does not expose the per-object authenticated raw-byte proxy route with HTTP `Range` and digest `ETag` caching - #765
- Non-local Storage backend adapters and host-side leased Worker bind mounts - Only the local filesystem Storage backend is implemented; S3-compatible, cloud-drive, NAS, and NanoHost adapters and host-side leased Worker bind mounts are not implemented - #268, #269, #270, #272
- On-demand mount metadata/digest index and User/Server `SourceSummary` virtual editing - Storage scan returns `path`, `kind`, and `byteLength` without a retained mount media/digest index, and `@sources/<id>.md` virtual descriptive editing is implemented only for Workspace scope - #765
- Knowledge package derivative interchange, historical revision selection, and User/Server package routes - Package transport supports only current-revision Workspace packages without derivative entries or `derived/` files - #386, #266, #385
- Separate Derivation module and citable derivative retrieval trace handoff - Media processors remain with their existing owners rather than a separate Derivation module driven by Storage change feeds, and retrieval hits/traces do not uniformly emit the shared derivative `contentRef` and `sourceLocator` tuple - #289, #291, #292, #296

## Decisions

- [References May Miss, Never Mislead](../decisions/20260921-references_may_miss_never_mislead.md)
- [Layered File Storage And Knowledge Packages](../decisions/20261018-layered_file_storage_and_knowledge_packages.md)
- [Durable Execution And Control Store](../decisions/20261019-durable_execution_and_control_store.md)
