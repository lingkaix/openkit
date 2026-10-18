---
status: Accepted
implementation: Not Started
kind: mechanism
date: "2026-10-18"
---
# File Storage And Knowledge Packages

## Scope And Owners

Ablation: shared file contracts must not create competing product authorities.

This specification owns shared content references, the Storage boundary, Knowledge mounts, derivative interchange and Knowledge packages. The [approved decision](../decisions/20261018-layered_file_storage_and_knowledge_packages.md) records the reason. Existing Artifact, Source, Notebook, Material, Policy and evidence owners retain their identities and lifecycles. No second version, attachment, grant, receipt or Knowledge Base catalog is introduced.

Version 0.1.0 freezes these formats. Storage's initial implementation covers its contract, local backend and Knowledge Sources/raw namespace first. Artifacts, Turn inputs and Context packages adopt it later through their owners. This documentation change implements none of those capabilities.

## Core References

Ablation: existing owners supply scope, permission, communication and retained-data constraints.

- [Storage](../core/storage.md), [Knowledge](../core/knowledge.md), and [Communication](../core/communication.md).
- [Permissions](../core/permissions.md), [Contract Evolution](../core/contract-evolution.md), and [Vault](../core/vault.md).

## Layers And Shared References

Ablation: content identity, location and interpretation must remain distinct when bytes move or disappear.

| Layer | Meaning | Exclusion |
| --- | --- | --- |
| Content, or Blob | Exact raw-byte SHA-256, size and sniffed media type. | Neither owner identity nor permission. |
| Location | Where bytes live; plural and changeable. | Neither content identity nor guaranteed availability. |
| Attachment | Existing owner/object/version binds content and captured location. | No new attachment ID or permission graph. |
| Derivative | Output with exact source and recipe lineage. | Neither original evidence nor curated Knowledge. |
| Index | Rebuildable discovery and retrieval. | No canonical content or access authority. |
| Knowledge entry | An OKF page with its own scope-qualified ID and Notebook revision. | Its ID is not a file digest. |

Existing owner records carry content descriptors: `contentDigest` is raw-byte SHA-256, `byteLength` is a nonnegative integer, and `mediaType` is the sniffed result. Declared media is separate. Unknown media uses `application/octet-stream`; classification never replaces parser validation. An object-store ETag or Git object ID is not a raw-byte SHA-256.

The shared citable `contentRef` carries `contentDigest`, `locator`, nullable `range` and `availability`. Existing owner records remain canonical; this shared projection does not create another independently mutable digest authority. SHA-256 uses the existing `sha256:` plus64 lowercase hexadecimal form.

| Reference member | Serialized shape |
| --- | --- |
| `locator` | `{ownerScope, mount, path}`; reuse existing scope projection, string mount name and confined mount-relative path. |
| `range: null` | Whole source. |
| Byte range | `{kind: bytes, start, end}`; nonnegative integer half-open raw-byte offsets, end not before start. |
| Page | `{kind: page, page}`; positive integer page number. |
| Time range | `{kind: time, startSeconds, endSeconds}`; finite nonnegative seconds, end not before start. |
| Frame | `{kind: frame, frame, numbering, coordinateSpace}`; integer frame, explicit zero/one-based numbering and source space. |
| `availability` | `available` or `unavailable`, observed rather than guaranteed. |

Tagged values and coordinate-space names are strings; frame values respect their declared numbering. Ranges cannot silently change coordinate systems. Storage range reads accept byte coordinates, not an implicit media conversion.

Reuse existing qualified Source ID/digest and versioned Artifact references as attachment identities. Store alternate verified locations in the owner's `locations` array; do not allocate another content or attachment ID. Reuse the owner's capture/publication timestamp. Digests and locators are citable facts, not authority.

References use `availability: available | unavailable` without removing descriptive metadata, digest or captured locator. Availability is an observation, not a permission or future guarantee. Missing, changed, inaccessible and unsupported sources have bounded explicit outcomes. Public errors do not expose denied metadata.

## Reference Lifecycle

Ablation: references may miss without silently substituting different content or forcing retention copies.

Verify resolved bytes against the captured digest and size before claiming exact content. A changed file at the same locator is unavailable for that reference. Another location is usable only when currently authorized and verified against the same identity. A new capture uses the existing owner's publication lifecycle. Never guess a replacement from a name or title.

For reference-only sources, reading or processing creates no retention promise. Do not copy originals or derivative excerpts solely for later replay. Explicitly imported managed files are originals, not additional retention copies. Rebuildable derivatives may support current processing/indexing without guaranteeing future retrieval.

Deletion follows existing owner/hold rules. Metadata can survive deliberate deletion of bulky source bytes; no new tombstone family is required. Restart resolves current availability, never reconstructs from today's changed source. Retry repeats current admission. Existing independently governed work records retain their lifecycles. Complete retention remains a later user-enabled option under the [reference decision](../decisions/20260921-references_may_miss_never_mislead.md).

## Storage Package And Policy Leases

Ablation: one location service supports different backends without owning meaning, access decisions, retrieval or processing.

The Storage Service is a separate TypeScript package, `packages/storage` / `@openkit/storage`. Its contract is asynchronous, streaming and process-agnostic. Requests and results contain serializable values and opaque handles, never shared mutable objects, callbacks or native file handles. A local client may run in process without making object identity part of the contract.

| Storage operation | Boundary |
| --- | --- |
| Content reference/stat | Return observed identity, size, metadata and availability under an admitted mount. |
| List/metadata find | Bounded metadata discovery with continuation; no semantic ranking or media extraction. |
| Range read | Bounded byte stream for a citable reference and range. |
| Access lease | Enforce the current Policy grant's mount, prefix, mode and expiry; do not decide Policy. |
| Staged write | Write new bytes to a staged location and return a handle/identity for NanoCore admission. |
| Commit handoff | NanoCore commits through the owning Source or Artifact/version, Review and Audit boundaries; Storage grants no publication authority. |
| Change feed/scan cursor | Return a bounded incremental view for ingestion; a stale cursor reports rescan required rather than false completeness. |

Local storage is the initial backend. Later backends can serve S3-compatible roots, cloud drives, NAS or NanoHost folders and read-only references. Existing schema-only kinds and the private scan store are reuse candidates, not implemented adapters. Vault owns credentials; locators and handles contain no secret values.

An access lease is a kind of existing Policy grant, not a Storage-owned record family. Its payload binds the existing issuer/subject/audience lineage, mount, normalized path prefix, `read-only | staged-write` mode and expiry. Supervising agents can request/set leases only within their current delegation. Policy evaluates access; Storage and runtime enforce the admitted grant. Audit lease issue/change/revocation/expiry through existing owners, not every byte.

Expired or revoked leases block new operations and require removal or fencing of continued mounted exposure through existing runtime enforcement. Already disclosed bytes cannot be retracted. A lease grants neither an in-place overwrite nor a commit. Writes stage by default; an explicit in-place change passes NanoCore interception under Policy. Capacity or failed publication returns an error without overwriting existing originals.

## Knowledge Mounts And Canonical Layout

Ablation: the raw namespace must support several locations while preserving one Knowledge and Source authority.

`raw/<mount>/<path>` is a Knowledge namespace over a Storage mount table, not a requirement for nested physical folders. A mount declaration has `name`, `backend`, backend-specific `root`, and `default` boolean. Mount names are unique within the existing owner scope; exactly one default mount resolves to the physical `raw/` directory inside the Knowledge Base. Backend roots are locators, not credentials or permission grants. Unsupported backend activation returns unavailable, never falls back to another root.

| Canonical path or family | Meaning |
| --- | --- |
| `raw/` | Default mount's immutable managed originals. Logical `raw/<default-mount>/a.pdf` resolves to physical `raw/a.pdf`. |
| `pages/` | One published OKF bundle, including reserved `index.md` and `log.md` when present. |
| `schema/` | Existing authored scope schema; content edits cannot grant authority. |
| Mount declarations | Existing scope-owned Knowledge configuration, with the shared declaration shape. |
| Source registry/derived metadata | Existing sibling Source family; one authority reused by Knowledge, Context, evidence and Artifacts. |
| `derived/`, `indexes/` | Optional rebuildable outputs and search generations, distinct from authored navigation. |
| `notebook.git/` | Existing sole Notebook publication/history authority, outside the OKF bundle. |

Existing User/Workspace/Server owners identify the Knowledge Base. The Knowledge Manager reads originals but never modifies them. It maintains pages, navigation and log through the Notebook owner. The physical `pages/` materialization remains optional and rebuildable; product reads pin the published Git revision. Schema and raw originals stay outside that Git page tree.

Several additional mounts can contribute sources without copying them to the default mount. Source metadata remains useful when their bytes disappear. Moving captured Source text into managed raw storage changes its location binding, not its Source ID or original digest. Keep the shared sibling registry; do not duplicate it inside the Knowledge directory.

## Worker Access

Ablation: existing Workspace and Artifact planes expose leased storage without introducing a sandbox storage service.

Workers use NanoCore-mediated MCP tools for list, metadata find, stat, range read, staged write and commit. The existing [Workspace and Artifact planes](../core/communication.md#workspace-plane) also permit filesystem projection: NanoHost mounts the backend on the host side and bind-mounts the leased read-only subpath at a stable sandbox path. No FUSE runs inside the sandbox. Writes enter a staged output directory; NanoCore performs the owning commit.

Worker access requires a current lease and source/destination admission. Stable paths do not preserve revoked authority across Turns. Host-side mounts are host configuration and require explicit engineer approval when implemented. This design authorizes no mount or host change now.

## Knowledge Package Format

Ablation: one versioned manifest makes Knowledge files independently verifiable without treating interchange as backup.

A Knowledge package contains one admitted Knowledge Base. Export packs its canonical files at the same relative paths and adds `manifest.json`. It does not convert raw formats, rewrite OKF bytes or invent another page/raw layout. Default-mount originals use physical `raw/<path>`, not an extra mount-name folder. Workspace export V3 remains separate.

| Manifest field | Required meaning |
| --- | --- |
| `format`, `formatVersion` | `openkit.knowledge-package`, integer `1`; unsupported major versions fail. |
| `ownerScope` | Existing source scope/identity for provenance and remapping, never imported authority. |
| `requiredFeatures` | Required semantics for the manifest and included owned records. |
| `notebookRevision` | Exact source published revision, not target publication authority. |
| `contentInventory` | Entries `{path, contentDigest, byteLength}` for every included regular file; digest is raw SHA-256 and length a nonnegative integer. Excludes the manifest itself. |
| `mounts` | Shared declarations, with the default mount bound to packaged `raw/`; external roots retain their declarations. No live credential binding or access lease travels. |
| `sources`, `representations` | Admitted records projected from the existing Source registry and derivative metadata, with their existing identifiers and shared references/lineage. |

The package carries the default mount's available managed bytes. Additional mounts, including external local folders and remote roots, travel as declarations and digest-bound references without bytes. Export does not fetch them to complete a package. An explicitly unavailable managed original retains metadata without a raw inventory entry. Failure to verify a supposedly available managed file refuses export; it does not silently reclassify the source.

Indexes and rebuildable derivative bytes are optional. Omitted bytes remain unavailable for replay; retained lineage does not claim that output exists. Included outputs must match their declared identity and lineage. A derivative never makes an unavailable original available.

### Necessary Differences

Ablation: each departure from the canonical layout needs a concrete reason.

| Difference | Reason |
| --- | --- |
| Add the transport manifest. | Interchange needs a format marker, declared closure and byte inventory; the live system already owns scope/publication metadata. |
| Materialize exact `pages/`; exclude local `notebook.git/`. | Import publishes through the destination owner, not source Git hooks, proposal refs or live publication state. |
| Project shared Source/representation records into the manifest. | Their canonical sibling registry also serves non-Knowledge consumers; packaging it does not create another live registry or relocate its authority. |
| Rebind the default mount; remove live credential bindings and leases. | A package cannot carry host access or deployment authority. External locations remain references. |
| Omit runtime/permission/command and local proposal/review stores. | They are deployment/work history, not standalone current Knowledge content; ordinary backup retains its declared coverage. |
| Optionally omit rebuildable indexes/derivatives. | They are accelerators, not required Knowledge authority. |

Raw files, OKF paths, schema, navigation and log otherwise coincide. The logical raw namespace's mount segment maps through declarations; neither canonical storage nor the package needs an extra physical folder. Compression can wrap the package without changing its logical inventory.

### Export And Import

Ablation: exact validation and identity remapping separate interchange from copying deployment files.

Export pins one published Notebook revision and captures admitted Source/schema/mount metadata under existing mutation boundaries. Verify files against that captured inventory. Concurrent change refuses export rather than mixing revisions. Current source/destination checks cover file names, metadata and bytes.

Import validates version/features, existing record schemas, confined regular-file paths, quotas and every inventory digest/length. Reject duplicate paths, traversal, links and undeclared files. Never execute package content or contact declared external roots during validation.

Remint owned record identities and internal references through the existing import map. Scope-qualified page identities rebind to the destination; preserve valid bundle-relative paths where possible. Verify source bytes before remapping. Recompute affected metadata/page digests and target inventory afterward; raw original digests stay unchanged. Verify declared mount/path bindings instead of treating a path collision as the same source.

Publish through destination Notebook/Source owners under current authorization. Reject collisions rather than overwrite Knowledge. Imported schema, actor, review and revision metadata grants no Policy, maintenance or protected-page authority. Existing suppression and masking remain binding. Failed validation/staging leaves the destination unchanged. Retry uses existing admission; no distributed transaction, new receipt family or automatic remote repair is added.

## Derivative Lineage

Ablation: indexable media outputs need source coordinates and production identity without becoming another version family.

Extend existing representation metadata. `sourceContentDigest` identifies exact original bytes; `sourceReference` is its existing qualified owner/version reference. `recipe` carries string `id`, string `version` and JSON-object `parameters` for output-changing settings. `provider` and `model` identify model use, or are null for deterministic local tools. Vectors also record exact `embeddingSpace` identity.

`sourceLocator` declares page, time, frame, byte or whole-source coordinates using the shared coordinate rules. Output `contentRef`, size and media facts identify derived bytes separately from the original. Explicit output unavailability preserves lineage without claiming byte retention. `coverage: complete | incomplete` preserves truncation and existing processing-failure evidence. Output offsets never claim original coordinates.

Text layers, transcripts, keyframes, thumbnails, vectors and short summaries are derived data. Recipe selection comes from a media-handling Skill used by the Knowledge Manager, not a hard-coded file-extension pipeline. A derived summary is not accepted Knowledge. Equal vector dimensions do not establish model/space compatibility.

## Context And Retention

Ablation: digest references remove required historical copies while preserving truthful delivered-content evidence.

Context packages adopt exact owner/digest/location references rather than retaining another original solely for history. Keep original, representation and delivered digests distinct, with ranges, lineage and availability. Missing bytes remain unavailable; current sources cannot reconstruct historical delivery. Do not retain extra derivative fragments solely to guarantee replay. Existing Items and independently governed evidence keep their owners.

A disposable read-only input snapshot may serve a running Turn under its current delivery contract. That execution requirement creates no post-settlement source-retention promise. Artifacts, Turn inputs and Context adopt Storage later; their owners coordinate retained format/readers and source admission before activation. Current copied-original inventories remain the implementation baseline until that transition.

## Backup And Workspace Export

Ablation: recovery integrity must not inherit interchange conversion or identity remapping.

Backup copies the same canonical Knowledge files unchanged within its declared consistent snapshot, including Notebook history, shared Source metadata and existing authority stores. It performs no format conversion. Existing backup owners retain integrity, restore-speed/security and execution-host coverage rules. External mount bytes remain outside backup unless explicitly covered.

Restore re-establishes captured deployment data, not reminted package identities or guaranteed external files. Workspace export serves external use without a lossless OpenKit round-trip promise. Knowledge package interchange separately supports standalone import and export.

## Freeze, Ownership And Acceptance

Ablation: classify retained transitions without implementing every future capability before v0.1.0.

| Class | Work and owner |
| --- | --- |
| MIGRATION | Knowledge Source text-only location/material bindings become managed raw/mount references. Context's required-original-copy closure changes when its owner later adopts references; settle that contract now without forcing immediate adoption. L-AK Knowledge; L-AW file/Context contracts. |
| ADDITIVE | Content refs, mount declarations, representation lineage, Knowledge package v1, content refs on retrieval trace hits, and a storage-lease kind in existing Policy grants. L-AW storage; L-AK Knowledge; existing Policy owner; L-RT Derivation/Gateway; retrieval owner. |
| Implementation-only | Initial local Storage backend/Knowledge integration and later adapter adoption; move existing PDF, ZIP and vision processors into Derivation without changing their output authority. Remote stores, ASR, vectors and video capabilities remain later work. |

Register required semantics through existing format/envelope owners before writers or imports activate them. Unknown descriptive additions are ignored; unknown core values, major versions and required semantics fail closed. Do not add pre-v0.1.0 conversion migrations, legacy readers or dual writes. Resets need existing explicit operator authorization; stable continuity follows Core Contract Evolution.

Acceptance observes matching canonical/package paths and justified differences; exact default-mount bytes; current source admission; explicit unavailable/external references; mismatch refusal without rebinding; valid remapping; optional index rebuild; unchanged backup files; scoped leases; and trace hits containing citable content refs. Each implementation supplies its lowest-sufficient regression.

## Current Implementation Projection

Ablation: accepted architecture must not be reported as completed code or an already writable format.

Storage package/local integration and these format extensions are not implemented by this documentation landing. Sources currently capture sibling text materials. Context packages copy originals and require retained paths. Existing Source/Artifact records, Notebook commits, Policy decisions, media evidence and retrieval representations remain the starting owners. No backend, host mount or media/model capability is activated here.

## Derivation And Retrieval Interface

Ablation: extraction, indexing and byte location need distinct owners with one indexable-unit handoff.

A separate Derivation module owns extraction/conversion: FFmpeg segmentation/keyframes/transcoding, ASR, PDF.js, OCR, ZIP extraction and thumbnails. It is neither Storage nor NanoCore processing. Input is an opaque content handle plus recipe/parameters; output derivatives are written through Storage with the lineage above. Each job runs in a bounded process or sandbox without secrets. Model calls use the Gateway under Policy. Derivation may be co-deployed with retrieval; PDF text, ZIP cache and vision view are its first processors.

The indexable unit is a derivative with source locator and lineage. Retrieval owns indexing and embeddings, including multimodal embeddings, their model/space identity, Gateway vector calls at index/query time, index construction, fusion, scoped filtering and citable hits. Derivation does not become a second semantic retrieval engine.

Storage change feeds drive Derivation and indexing. Queries use indexes, never live Storage scans. Large unprocessed mounts first get a cheap metadata index; content indexing follows demand or Policy/budget. Every hit and retained hit trace carries its original `contentRef`, derivative identity/range and source locator where applicable. Resolve content through Storage under current caller grants, not by substituting index text for an original.

All access is NanoCore-mediated: Worker MCP or Knowledge Manager tools call NanoCore, which calls the engine. No sandbox directly accesses the engine. Results are filtered before disclosure by served Knowledge scopes, agent audience or Worker lease. Knowledge questions go to the Knowledge Manager; Workers may directly search work files on their leased mounts through their mediated tool.

## Related Owners

Ablation: each participant retains one record/publication authority instead of another shared family.

- [Storage Layout](20260703-storage_layout_record_ownership.md), [Schema Evolution](20260703-schema_evolution_record_envelope.md), [Policy Enforcement](20260703-policy_enforcement_mapping.md).
- [Knowledge Store](20260703-knowledge_store_implementation.md), [Notebook](20260909-knowledge_notebook_editing.md), [Context](20260703-worker_context_package.md), [Session Materialization](20260704-session_static_workspace_materialization.md).
- [Retrieval Kernel](20261014-retrieval_kernel.md), [Backup/Export](20260704-workspace_backup_export_import.md), [Work Data Retention](20260921-work_data_retention_format.md).
