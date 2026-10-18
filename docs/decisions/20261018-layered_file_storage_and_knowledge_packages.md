---
status: Accepted
date: "2026-10-18"
decider: Engineer
---
# Layered File Storage And Knowledge Packages

## Decision

The engineer approved this direction on 2026-10-18. Version 0.1.0 freezes retained formats and implements minimal local Knowledge package export/import with a round-trip test. Later releases add history selection, remote mounts and further storage/media capabilities.

Separate content identity, byte locations, owner attachments, derivatives, indexes and Knowledge entries. SHA-256 identifies content, not its owner or access authority. Locations can change without changing content identity. Knowledge entries retain their own identities. References carry a Knowledge Base ID; each scope retains a fixed default ID, with one Knowledge Base per scope in v0.1.0.

Use one separate TypeScript Storage package with an asynchronous, streaming, process-agnostic contract. It owns location and byte operations, not meaning, Policy, retrieval or processing. Local storage and Knowledge Source integration come first; Artifact, Turn and Context adoption follows later. Vault retains backend credentials.

A Knowledge Base uses OKF pages, schema, navigation, log and a `raw/<mount>/<path>` namespace. Its default mount is the physical local `raw/` folder. Other roots can remain references. Admitted Sources become Notebook-owned OKF SourceSummary pointer pages; the external Source registry is retired. A rebuildable Storage mount index covers unadmitted files. The Knowledge Manager maintains interpretation and chooses media recipes through a Skill. Pointers contain logical mount paths, never backend locations; raw bytes remain outside Git.

The canonical Knowledge Base layout and Knowledge package layout coincide wherever possible. Export packs the admitted files and adds a manifest. Import targets a new or empty Workspace Knowledge Base, commits into a fresh bare Notebook, remints owned identities and verifies digests. Raw bytes never enter Git; published-tree paths match package paths. Backup copies the same canonical files unchanged. The specification identifies each necessary difference, including local Git publication state and remote references.

Keep backup/restore, Workspace export and Knowledge package interchange separate. A Knowledge package supports import and export. Workspace export serves external use without a lossless round-trip promise.

References record the observed digest and locator. Changed, deleted or inaccessible content can remain unavailable while its metadata survives. Do not make extra copies of originals or derivatives solely to guarantee later resolution. Complete retention remains a later user-enabled option.

Owners define file URIs; Storage delivers URLs; NanoCore authorizes and audits issuance. Knowledge pages retain relative raw paths and commit-pinned embedded digests. Derivatives carry source, recipe, version, provider/model, parameter and source-coordinate lineage. Separate Derivation owns bounded extraction/conversion; retrieval owns indexing and embeddings. Both use Gateway interception for model calls. NanoCore mediates Worker tools; leased filesystem views use host-side mounts, never sandbox FUSE. Leases reuse Policy grants and audit per lease, not per byte.

## Reason

Large recordings and other non-text sources can cost more to retain than their later value. Separate metadata and references preserve useful understanding without promising that every source remains available.

One file layout reduces conversion and divergence between local use, interchange and backup. Existing Source, Artifact, Notebook and Context owners avoid competing version or storage families.

The engineer selected the LLM Wiki pattern and supplied omni-knowledge and Rails Active Storage as concept references. Vendors and example tools are not requirements.

## Rejected Alternatives

- Retain every original and excerpt for replay: conflicts with the accepted cost and reference policy.
- Treat Workspace export as backup: confuses external use with operational recovery.
- Use a second Knowledge package content layout: adds unnecessary conversion and drift.
- Implement remote stores, transcription or vector engines before freezing formats: exceeds the approved v0.1.0 scope.

## Revisit When

Revisit complete retention when users request and fund it. Revisit backend and media implementations when a concrete capability is authorized; preserve content identity and source lineage.

## Affected Owners

- [Storage](../core/storage.md) and [Knowledge](../core/knowledge.md).
- [File Storage And Knowledge Packages](../specs/20261018-file_storage_and_knowledge_packages.md).
- [Storage Layout](../specs/20260703-storage_layout_record_ownership.md), [Context Package](../specs/20260703-worker_context_package.md), and [Session Materialization](../specs/20260704-session_static_workspace_materialization.md).
- [Backup And Export](../specs/20260704-workspace_backup_export_import.md), [Policy Enforcement](../specs/20260703-policy_enforcement_mapping.md), and [Retrieval Kernel](../specs/20261014-retrieval_kernel.md).

This decision preserves [reference accuracy](20260921-references_may_miss_never_mislead.md), [export/backup separation](20260928-goal_freeze_and_export_backup_boundary.md), and [simple complete export](20260921-export_simple_and_complete.md).
