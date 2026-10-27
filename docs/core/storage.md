---
status: Accepted
updated: 2026-10-27
---
# Storage Model

This document records the storage principles and key concepts for OpenKit across two explicit layers of one persistence module: Layer 1 (System State And Work Data) and Layer 2 (User Data And The Storage Service) ([layered storage decision](../decisions/20261018-layered_file_storage_and_knowledge_packages.md), [durable execution decision](../decisions/20261019-durable_execution_and_control_store.md)).

This document owns OpenKit's scope-owned transactional control authority, immutable-content boundary, logical storage hierarchy, source-of-truth rules, item-log persistence invariants, the shared file-storage, content-reference, lease, and package-byte boundary, and the boundary between bounded NanoCore product storage and external source storage.

This document does not own the complete physical schema, table layout, file layout, migration plan, backup format, app read models, protocol record semantics, vault backend design, or implementation-specific data-root paths.

Cross-release continuity follows [Contract Evolution](contract-evolution.md#retained-data-continuity), including its `v0.1.0` start and explicit pre-stable reset conditions. Ordinary storage lifecycle, access, holds, and cleanup rules remain binding for retained data. The reset permission alone authorizes no AgentSession cleanup, purge, or runtime-effect replay. The pre-`v0.1.0` scope follows the engineer's interpretation of NONNEG-001 and COMPAT-001 in [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md).

## Principles

Each mutable control-state transition MUST commit in exactly one transaction in its owning scope store. Related local product records, execution facts and request receipts share that commit. Files hold immutable content made durable before its digest reference is committed. Bounded retained work-entry bodies may instead reside as exact bytes in the owning control database under the Item log rule below. Readable record files are projections, not a second authority. Publish observable state only after commit. The [durable execution decision](../decisions/20261019-durable_execution_and_control_store.md) replaces file-first control authority to remove split-publication recovery, not to add a journal beside it.

Each Workspace MUST retain independently backupable and movable control data and locally retained content inside its own directory. Server-owned physical state and global capacity remain separate. An operation across those scopes is an effect with intent and outcome, not one transaction across stores. External references, retained Worker volumes and Vault material require explicit coverage; local content identity does not make them portable bytes.

[The Workspace snapshot decision](../decisions/20261027-online_workspace_snapshots_and_recovery.md) selects online local capture, target-scoped restore and identity-preserving MOVE. Running work blocks their freeze without waiting or interruption. Outward export is separate; ordinary portable import supplies no recovery path. Whole-server recovery remains a separate offline operation.

Full-text retrieval MUST use the rebuildable Retrieval Kernel projection. Its per-scope generations and derived sidecars retain their canonical source ownership and audience. Query indexes remain separate from canonical control authority. Arbitrary-byte originals remain canonical under their existing Artifact/upload owners. Versioned media derivatives remain rebuildable projections; file storage and transfer capacity is separate from raw model output and model-context budgets. [Large Files And Model Context](../decisions/20261015-large_files_and_model_context.md) records this separation.

The source of truth MUST be explicit per data class.

Storage decisions must not create a competing product model. They project core records into files, directories, SQLite tables, indexes, and materialized read models.

NanoCore is not a general repository, object, or bulk-file storage service. It may retain bounded product records, Workspace files, Artifacts, uploads, evidence, installed agent resources, and runtime handoff data only through their existing owners and limits. Workspace source repositories, editable development sources, and their Git history belong in a network-addressable Git service; this boundary primarily keeps large repositories and source-development storage outside NanoCore. Static source data that exceeds an accepted bounded NanoCore record, upload, Artifact, or evidence contract belongs in external object storage such as S3-compatible storage. NanoCore stores the non-secret locator, policy, immutable revision or digest lineage, and bounded coordination metadata needed to use those sources; it does not host or silently absorb the external storage service.

Bounded installed Skill and Agent Plugin snapshots are ordinary catalog-owned product resources. Their retained bytes are immutable and digest-verified, with exact source-version or uploaded-source lineage, size and entry-count limits, and owner-defined retention and purge. They contain no editable repository or Git history. Retained content is canonical for installation, so authorized worker loading and exact rollback do not require another network or Git lookup; integrity verification and current access checks still apply. Refresh admits a new immutable version rather than rewriting a snapshot. Missing or corrupt content fails explicitly, and physical purge respects live references and holds without claiming that unavailable bytes remain loadable. Disposable runtime copies and indexes remain projections of this authority.

Secret values belong to the vault boundary, not normal workspace files or protocol records.

Storage format evolution follows the unknown-field preservation and fail-closed rules in `docs/core/contract-evolution.md`.

## Layer 1: System State And Work Data

Layer 1 governs system state and work data: scope stores and control authority, immutable content, source of truth per data class, the item log, retention and deletion classes (including retained agent work data and Worker working volumes), format markers, and portability.

### Storage Hierarchy

The logical storage hierarchy is:

```text
CoreServer
  User
  Workspace
```

User Memory and Workspace/Server Knowledge reuse the same notebook machinery under distinct trusted scope roots. One published versioned content tree owns notebook content and retained history; its mutable publication head follows the owning scope's control transaction. Materialized pages, content-store refs and indexes are projections. Sources retain original evidence independently. No separate Memory database or content-history owner is implied. Private project Thread bytes remain in the Workspace tree and carry private access through their owning Thread, not through directory concealment.

User and Workspace are independent storage scopes. Identity membership links users to workspaces, while workspace ownership and access relationships must not be encoded by nesting the workspace under the current owner's storage scope.

Storage ownership is divided into three conceptual areas:

- server-owned config, provider instances, agent setup sources, deployment Knowledge, runtime snapshots, scheduler diagnostics, process logs, global indexes, and migration metadata
- user-owned Memory, files, preferences, user-local data, user logs, user-scoped config, and user-specific workspace ordering or recent-workspace indexes
- workspace-owned repository references and lineage, bounded workspace files, task artifacts, turn and item materialization, workspace knowledge, agent runtime outputs, and workspace-specific logs

The concrete path tree is defined in the server config and data layout spec, not duplicated here.

### SQLite Layers

One Core server may use multiple SQLite databases.

A server-level database belongs to one Core server installation and may hold global indexes, known users, workspace registry data, server metadata, and migration metadata.

A user-level database belongs to one user and may hold user-level metadata, preferences, workspace list or order, and user-level indexes.

A Workspace control database belongs to one Workspace and owns its mutable control and product-record state. Derived indexes, vector or embedding metadata and read models retain their distinct projection role.

Workspace-local control authority MUST NOT depend on a server-global database to reconstruct local history. Cross-scope physical ownership remains an explicit dependency, not duplicated Workspace authority. Per-Workspace databases support independent backup, movement, deletion and failure isolation.

### Source Of Truth

The scope control store owns mutable Workspace, Thread, Turn, AgentSession, Item revision, catalog, configuration-head and execution records. Existing domain owners keep their meanings and retention rules. Immutable content and authored revision bytes retain their original identities and content owners; database heads select the admitted revision. Authored server configuration stays server-scoped, and Workspace executions retain its admitted revision/digest as provenance rather than server authority.

Required user work data produced or used on any placement MUST return to OpenKit storage under its existing owners before work counts as complete or its only copy is removed. This includes files, results, retrievable conversations and Items, usage needed for accounting, and Knowledge candidates.

OpenKit storage MAY use admitted remote backends; residence in a user's cloud account alone does not satisfy this obligation. The [neutrality decision](../decisions/20261020-compute_and_harness_neutrality.md) permits unavailable provider-internal execution details, but required user data MUST NOT be relabelled as internal.

Reuse the shared Storage Service for byte locations and immutable handoff; it does not decide publication or access. Knowledge keeps its content/history semantics while its mutable heads obey the same commit rule. Application-owned business stores and opaque process data are not additional control stores: their writers and snapshot boundaries must be explicit, and cross-store operations are effects. No unclassified mutable authority may be silently omitted from a Workspace backup.

Secret values are not stored in normal Workspace files or protocol records. Workspace storage may keep secret references, grants, injection rules, and audit metadata, while secret material belongs behind Vault. Derived projections rebuild only from intact canonical control records and content, never the reverse.

Existing transaction-owned record classes also include:

- permission decisions
- audit events
- usage records
- capability calls
- vault grants and non-secret vault metadata
- idempotency records for command request IDs
- stream cursor retention metadata
- operational health and diagnostics summaries

These records still belong to the core model. SQLite being their source of truth is a storage decision, not a separate product model.

Each Light App data kernel, defined in [Generative Apps](generative-apps.md), requires an explicit bounded canonical record contract, including schema evolution, constraints, and complete portability from its first implementation. Generative UI declarations, saved view definitions, source results, and business records remain distinct data classes with explicit owners; a rendered or cached view cannot repair or replace missing business authority. Each Light App has an independent schema/data recovery unit; a per-app SQLite realization remains under the Workspace storage owner, not a separate database service. Independent app stores remain under existing storage ownership; neither concept authorizes a second storage plane, implicit generalization of an existing text record, or omission from backup and export coverage.

### Item Log Invariants

Item logs MUST be append-only.

Item writes MUST preserve the same ordering that clients observe through protocol event streams.

Replay MUST reproduce item order according to the stored stream sequence.

Item writes SHOULD persist the `protocolVersion` that was active when the item event was recorded.

Implementations SHOULD use a single-writer or equivalent atomic append discipline per item log scope so replay cannot observe partial item events.

Compaction MAY materialize completed item snapshots, but it MUST NOT change item IDs, causation links, or the final meaning of completed items.

Native retained Item and Item-event entry bodies with an exact UTF-8 byte length of at most 65,536 bytes MUST use the control database's inline representation for new revisions; larger bodies MUST keep their immutable-file representation. The writer MUST verify exact bytes, length, digest, retained format and lineage before the owning FULL transaction acknowledges them. It MUST NOT parse and re-encode a body to manufacture its byte proof. The existing file descriptor remains a current representation without conversion or reinterpretation; prior file references retain their exact bytes and ordinary holds and retention. Unknown required representation semantics MUST fail closed. This choice changes no Item identity, sequence, revision, current-authority check, Turn CAS, ordered acknowledgement or completed meaning. It adds no second writer, byte store or public wire class. The [inline retained work-body decision](../decisions/20261027-inline_retained_work_bodies.md) records this narrow addition to the file-content boundary.

### Persistent Worker Working Storage

OpenKit SHOULD treat a healthy Worker environment as a long-lived, lightweight VM-like working resource. Durable working storage MUST outlive the replaceable process, Sandbox, image and execution-substrate epoch that use it. This is backend-independent storage doctrine, not a requirement to implement a VM backend or to preserve a container root filesystem.

Retention applies to entire admitted writable volumes or directory roots, without an inventory of supported file types. Uncommitted and ignored files, project `temp/`, unfinished work, runtime-local conversations, memory, configuration and installed user tools are examples, not an allowlist. Git inclusion, Artifact registration, filename, extension, task completion and AgentSession termination MUST NOT decide whether bytes inside a retained root survive. Additional software may store previously unknown formats there without an OpenKit feature or schema change. Only an explicitly separate disposable mount or scratch area may carry automatic cleanup semantics.

NanoCore owns each retained storage association's Workspace, access audience, execution attachment and deletion authority. The execution host owns the working bytes at that association; it is not a second owner of product records. Persisted working bytes MUST NOT be silently treated as an accepted Git commit, Artifact, Knowledge Page, completed Turn or independent verification result. Native runtime memory and history do not automatically become Core User Memory or Workspace Knowledge. A retained Worker environment may be named and created before execution; its existing Core association owns its Workspace, selected admitted environment supply, retained targets and attachment/deletion authority. The retained Worker environment belongs to its Workspace and is shared with its current membership from creation. Creator and contributor identities are attribution and provenance, not personal ownership or ordinary reuse vetoes. Retained working and native data admitted to that shared audience remain available after a contributor leaves. Narrower source data requires explicit destination-audience authorization before shared attachment; missing or revoked required proof preserves bytes and fences exposure. A shared work slot supplies no confidentiality guarantee. Existing private associations preserve their restricted audience and exact authorized continuation; migration cannot expose them to other members. The decision is recorded in [User-Selected Workspace-Shared Sandboxes](../decisions/20261008-user_selected_workspace_shared_sandboxes.md).

Workspaces MUST have separate retained execution storage. Within one Workspace, an authorized Operator/Coordinator Agent SHOULD prefer reusing suitable idle Workers and volumes for related work, including a new Task or Goal. The Agent judges usefulness from authorized work context; deterministic admission enforces current audience, compatibility, writer fencing and independent-adjudication separation. [Policy](policy.md#shared-sandbox-resource-eligibility) owns the shared-Sandbox audience and source-to-destination disclosure requirements. Storage MUST preserve those admitted audiences across retention and reattachment. Matching image alone grants no access; current membership, credential scope, policy and protected-source admission remain required. The accepted disclosure boundary is recorded in [User-Selected Workspace-Shared Sandboxes](../decisions/20261008-user_selected_workspace_shared_sandboxes.md). An explicit fresh environment remains available when reuse is unsuitable.

Image ancestry and an inherited storage-layout contract SHOULD make ordinary derived-image replacement reuse the same volumes. The mechanism MUST operate on volume identity, mount layout, ownership and current authorization, not by understanding each stored application's file formats. Compatible attachment does not prove software-format compatibility, native conversation continuity or data rollback. A changed image may add software without changing the working bytes; incompatible software or storage layout must preserve those bytes for a corrected environment or explicitly authorized migration.

Normal Turn/AgentSession cleanup, Sandbox replacement, Runtime Epoch invalidation, NanoCore/Web updates and image-cache cleanup MUST NOT delete retained working storage. Runtime cleanup fences processes and authority; it does not erase working data to prove that execution stopped. Missing or inconsistent retained storage MUST be reported rather than replaced with an empty store under the same identity. Unproved writer absence blocks attachment by a successor. Security-suspect stored content remains retained for authorized inspection and MUST NOT be automatically reattached for execution.

OpenKit-injected credentials, control state, route bindings and temporary grants MUST remain outside generic retained volumes and be recreated through their current owners. Preserved user files are data, never an authorization source. Retained native configuration cannot override current admission, provider, capability, network or credential policy. Preservation does not authorize new collection of private reasoning or raw data beyond the existing runtime and evidence owners.

Purge requires a currently usable administrator credential, explicit resource-deletion authority, current audience and hold checks, and proved writer fencing. Ordinary members may stop an eligible idle shared realization and request administrator deletion; neither action grants purge authority. [User-Selected Workspace-Shared Sandboxes](../decisions/20261008-user_selected_workspace_shared_sandboxes.md) records this boundary. Pressure or quota exhaustion refuses new writes/admission or requests authorized cleanup; it MUST NOT silently evict retained work. Backup/export coverage MUST name execution-host volumes separately from NanoCore storage and report an unavailable or omitted volume truthfully. A persistent local volume is not an off-host backup or a guarantee against physical disk loss. Observable conformance requires unknown, untracked and ignored bytes to survive compatible replacement without promotion to product truth, and missing, conflicted, unsafe or unavailable storage to preserve data and block false recovery.

### Local Execution Image Supply

An execution host SHOULD retain verified immutable image content independently of its replaceable execution runtime. Public and private registries are acquisition sources for Worker images, not prerequisites imposed by OpenKit for starting NanoCore, connecting an execution host or reusing Worker image content already held locally. This does not replace a selected external runtime's own supported bootstrap behavior or dependencies. Startup establishes the execution substrate and its authenticated control connection; each workload separately proves availability and integrity of its exact image before execution. Missing content blocks the dependent preparation or workload without invalidating unrelated healthy execution.

NanoCore owns desired image declarations, authorization, preparation lineage and accepted results. The execution host owns locally acquired or built image bytes and their verified import into its runtime. This does not make NanoCore a registry or duplicate large image blobs in Core storage. An explicitly supplied local archive may establish image availability without a registry; a new remote acquisition or build can still require its declared external sources. Local availability is neither publication nor authority to execute, and a local image copy is not an off-host backup.

Verified retained images MUST NOT be automatically evicted. Capacity exhaustion refuses new image admission and requires an explicit administrator capacity change or cleanup, without interrupting running Workers. Removal is an explicit exact-image decision: it may make future environment creation unavailable and must not claim that a registry can always reproduce the bytes. Image replacement and deletion do not delete retained working volumes. A removed or corrupt image cannot be silently replaced by a different image under the same digest. Recovery uses verified identical content or a newly authorized image selection; it does not claim that preserved volume bytes alone can reproduce unavailable software.

### Retention Classes

The closed Core retention-class vocabulary is:

```text
ephemeral-diagnostic
turn-evidence
workspace-audit
restricted-raw
legal-hold
```

Owning record specifications assign these existing tokens and their retention windows. `restricted-raw` is an access class, not a demonstrated-need retention gate or a duration. Valuable observed work data is retained by default without a demonstrated future use, as recorded in the [completeness decision](../decisions/20261019-work_data_retention_completeness.md). Owning records keep their capture coverage and ordinary retention policy. Raw reads require current owner authorization and an audit record. No class grants access. Material under `legal-hold` MUST NOT be compacted or deleted until the hold is released.

### Agent Data Retention And Deletion

Agent features introduce no retention class, retention engine, or global deletion workflow. They use the closed vocabulary above through the existing Thread, Turn, Item, Artifact, Knowledge, audit, usage, evidence, Workspace, user, and Vault owners.

The mappings below govern OpenKit collection, capture, import and publication. They do not require classification or selective deletion of opaque runtime-owned bytes already written inside an admitted retained working volume. Whole-volume retention may preserve native rollout files containing private runtime material without OpenKit capturing, inspecting or promoting it. Such bytes retain their source audience and the working-storage lifecycle above; any subsequent OpenKit capture, export into evidence or product publication must satisfy the applicable restricted-raw owner. This adds no probe for unexposed runtime-private state. Provider payloads and native material actually observed by admitted collectors follow the work-data completeness contract; they are not filtered merely because their future use is unknown.

The explicit mappings are:

| Agent data | Existing class mapping | Boundary |
| --- | --- | --- |
| Raw audio, microphone frames, or runtime-private state not already exposed in an admitted provider exchange or native capture | Completeness adds no device/private-state capture feature. A new capture path needs its existing authorization and owning contract; captured raw material remains `restricted-raw`. A bounded product-safe health/retry summary is `ephemeral-diagnostic`. | This exclusion does not discard fields or partial content already observed in retained provider payloads, tool exchanges or native transcripts. Raw material is not completion proof, authority, or required recovery state. |
| Observed raw provider payloads, native Worker transcripts/logs, sensitive traces, and quarantined output | Default retention under the work-data owner; `restricted-raw` constrains who may read, with audit, not whether a future purpose is demonstrated. | Product-safe records reference raw material by id/digest, never duplicate it into ordinary Items, audit rows, or telemetry. OpenKit-held/injected credentials and secret material are never captured. Existing deletion, legal-hold and operator retention rules apply. |
| Normalized proof needed to explain one worker Turn, Artifact, Workspace review, or verification result | `turn-evidence` | The evidence owner decides promotion and retention; the Agent or runtime cannot extend its window or use raw content as a substitute. |
| Audit, usage, permission, capability, Vault-use, deletion, revocation, and authority-change facts needed for Workspace governance | `workspace-audit` | These facts follow the responsibility owner's home and deletion rules and remain non-authorizing historical lineage. |
| Any retained class above under an explicit deletion block | `legal-hold` | The hold blocks deletion until its owner releases it; it does not create ordinary retention policy or authorize access. |

Search indexes, embeddings, summaries, prompt caches, provider sessions, runtime materializations, materialized views, and other derived state are reconstructible projections, not a new durable agent-data class. They are invalidated or made ineligible after source deletion, authorization loss, incompatible revision, or policy change, and their invalidation changes no product truth. A persisted invalidation diagnostic uses `ephemeral-diagnostic`; normalized proof that the invalidation affected one governed Turn or review uses `turn-evidence`; the derived bytes themselves do not become durable merely to receive a class.

Deletion follows the owning resource. Acceptance of authorization removal, source revocation, or deletion immediately prevents future reads and promotions through current admission even when physical cleanup or derived-index rebuild completes later. Derived projections are then invalidated and rebuilt from remaining current sources. Historical commands, Reviews, Goal outcomes, audit facts, and minimal unavailable-source lineage are not rewritten, and separately accepted Artifacts, Knowledge Pages, Materials, and evidence follow their own owners and retention classes rather than a guessed cascade.

Retained Workspace retirement ends ordinary authority without deleting, compacting or moving content. It preserves legal holds and unresolved cleanup fences and reclaims no storage. Its registry status is not evidence of physical absence or recoverability. The [retained-retirement decision](../decisions/20261020-quarantined_workspace_retirement.md) records why it is separate from deletion.

Workspace and user deletion reuse their existing closure-export, backup, legal-hold, Vault, and fail-closed cleanup owners. If complete deletion or revocation cannot be proved, future access fails closed and the applicable owner reports degraded, restricted, or recovery-required state; it does not serve a stale cache, infer physical erasure, or create an Agent-specific repair workflow. Retry is a fresh owner-authorized deletion, rebuild, or access request from current truth and never a blind replay across Core storage and an external runtime effect domain.

A separate product-record lifecycle for an unadmitted raw-audio/private-state capture feature is not applicable here. Observed provider/native work content and opaque runtime-owned volumes retain their existing owners. Creation, update, termination, retry, and recovery remain with those owners. Acceptance requires default complete capture within admitted boundaries, audited and authorized restricted-raw reads, no captured OpenKit-held/injected secrets, and explicit collection gaps or lawful disposal. Bounded safe diagnostics keep their existing class; source deletion/revocation prevents future derived reads before cleanup finishes; independently accepted resources keep their owners; legal hold blocks deletion without granting access.

### Independent Retained Format Markers

Each OpenKit-owned retained family has an explicit format marker in its record header or its existing owning inventory. New record formats start at version 1. Writers and readers use the shared marker helper: writers emit the marker, and readers check it before decoding the family's payload. A missing or unknown version fails closed. Family-owned retained schemas are independent of release-coupled wire schemas; a wire-only change cannot change the meaning of a stored version. The shared v1 marker remains 1; a future family format selects its own decoder and does not change the shared version constant. Existing native database journals govern scalar-only SQL storage; independently decoded JSON-bearing rows carry their own version. Original content and opaque native bytes are not rewritten to add an OpenKit header. Their versioned owning descriptors retain their exact digest and interpretation.

This rc.10 cutover uses the accepted pre-stable reset boundary. It adds no converter, legacy reader or dual write. The coordinator performs the single deployment reset; this rule authorizes no host or account action.

### Storage Scope Direction

Workspace control authority uses its own scope database. Additional databases require an existing independent ownership or data-recovery need; they MUST NOT duplicate control authority.

The rebuildable Retrieval Kernel projection is the default full-text search index family. Vector search remains an optional future index family until promoted by stable core requirements.

The current local and server realization uses the encrypted-file Vault through the vault boundary, not normal storage records. Concrete ciphertext, metadata, and key-file layout remain implementation-facing Vault concerns.

## Layer 2: User Data And The Storage Service

Layer 2 governs user data and the Storage Service: locations and byte operations, storage backends, digest and locator references, leases under Policy grants, Knowledge package bytes, and the external Git and object-storage boundary ([layered storage decision](../decisions/20261018-layered_file_storage_and_knowledge_packages.md)).

### Shared File Storage

Content identity, locations, attachments, derivatives, indexes and Knowledge entries have separate responsibilities. The Storage Service owns locations and byte operations, not content meaning, Policy decisions, semantic retrieval or processing. Its separate process-agnostic package starts with a local backend and Knowledge Sources; other owners adopt it later. S3-compatible roots, NAS, and cloud drives are later backend candidates and are not current active backends. Vault owns backend credentials.

A reference binds its observed digest and locator (`contentRef`, with raw-byte SHA-256 content identity, logical mount and confined relative path, optional byte or page range, and observed availability); unavailable bytes never bind another object, and references may miss without silently substituting different content or forcing extra retention copies ([references decision](../decisions/20260921-references_may_miss_never_mislead.md)). Storage leases reuse Policy grants and current runtime enforcement, with host-side mounts and never sandbox FUSE, and audit recorded per lease lifecycle rather than per byte. Knowledge Bases and Knowledge packages share one canonical layout (`pages/`, `sources/`, `schema/`, `raw/`, and optional `indexes/`), with `manifest.json` added at the package root and raw bytes kept in Storage outside Git. Derivation owns conversion; retrieval owns indexes and embeddings. Do not retain extra originals or derivative excerpts solely for historical resolution. Existing canonical data and retained work keep their owners. The [layered storage decision](../decisions/20261018-layered_file_storage_and_knowledge_packages.md) records these boundaries.

## Invariants

- Workspace data MUST remain separable enough for backup, export, deletion, migration, and debugging.
- Workspace-owned storage MUST remain independent from any current human owner's user-owned storage so sharing or owner transfer never requires copying, linking, or moving canonical workspace data.
- User-visible workspace collections MUST be derived from identity and permission relationships rather than filesystem discovery or user-owned links.
- Canonical records MUST remain inspectable and portable through their owners; readable files MUST NOT become a second mutable authority.
- Derived indexes MUST be rebuildable from intact canonical records and content, independently of their physical format.
- A consistent Workspace snapshot MUST cover every admitted mutable authority and protect its referenced immutable content against garbage collection until copying finishes or is explicitly abandoned.
- Each canonical store MUST have one acknowledgement point, as defined in [Fault Tolerance](fault-tolerance.md). An owner MUST NOT report acceptance before content reaches it, and content MUST be durable before a durable reference to it is published.
- An integrity failure in authority-bearing storage, or the absence of authority-bearing storage that a durable record expects, MUST fail closed within its owning scope under [Fault Tolerance](fault-tolerance.md) and preserve what remains in place; automatic recovery MUST NOT replace lost authority with a fresh empty store.
- Storage layout MUST NOT redefine workspace, thread, turn, item, artifact, knowledge, vault, audit, usage, or AgentSession semantics.
- Secret values MUST NOT be stored in normal workspace files, item payloads, protocol records, or derived indexes.
- Authority-bearing storage fields MUST NOT be silently ignored by readers that do not understand them.
- A remote Agent Runtime MUST NOT consume a host-local Git repository path from the NanoCore server. Repository-sourced code and development text MUST first exist through an authorized network-addressable Git source. Workers use installed Git freely for local work inside the admitted Sandbox. Platform-managed external hosting calls use an explicitly selected vendor MCP server through NanoCore's Gateway, with gateway-held credentials and the MCP owner's authentication, current authorization, configured per-tool approval, and audit. Native Git push is optional user-space configuration requiring a user-injected credential and admitted git-receive-pack egress; OpenKit supplies no additional native-push mechanism. NanoCore reads no host repository to verify a Sandbox Git work slot. Bounded installed resources use their catalog-owned immutable snapshots and governed delivery rather than requiring a Git repository for each load. The decision and its reason are recorded in [a decision record](../decisions/20261002-hosting_through_gateway_mcp.md).
- Large static source data MUST remain in an external object store once it exceeds the applicable bounded NanoCore-owned record or handoff contract. NanoCore retains only the external reference and required bounded lineage; neither NanoCore nor NanoHost becomes the object-storage service.
