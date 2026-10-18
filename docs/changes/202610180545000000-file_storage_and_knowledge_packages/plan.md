---
type: change-plan
status: in-progress
date: "2026-10-18"
---
# File Storage And Knowledge Packages

## Intent Revision 1

Source: the engineer's 2026-10-18 05:34Z ruling and the coordinator's approved documentation brief and implementation GO.

Document the approved six-layer file design, one local-first Storage Service, binary Knowledge Sources, shared canonical/package layout, separate data movements and accurate references. Freeze formats for v0.1.0 without implementing remote storage or media capabilities. Reuse existing record and publication owners.

The coordinator explicitly requires canonical and interchange layouts to coincide wherever possible. Export packs files plus a manifest; import validates, remints and verifies; backup copies canonical files unchanged. State every necessary difference and its reason.

Preserve the accepted [reference policy](../../decisions/20260921-references_may_miss_never_mislead.md), [backup/export separation](../../decisions/20260928-goal_freeze_and_export_backup_boundary.md), and [complete export decision](../../decisions/20260921-export_simple_and_complete.md). Do not promise retention or resolution of external originals, or retain extra derivative excerpts solely for history.

## Boundaries And Owners

Governing owners: [Core Storage](../../core/storage.md), [Core Knowledge](../../core/knowledge.md), [Context Package](../../specs/20260703-worker_context_package.md), [Storage Layout](../../specs/20260703-storage_layout_record_ownership.md), [Session Materialization](../../specs/20260704-session_static_workspace_materialization.md), and [Backup And Export](../../specs/20260704-workspace_backup_export_import.md).

Only documentation and its generated index change. L-AW owns this documentation landing; L-AK retains Knowledge implementation, L-RT retains Gateway/media and backup execution, and L-WEB retains Artifact version records and UI. No product code, host, credential, release, AGENTS.md or Product Vision change.

## Method And Acceptance

One decision record, at most60 lines; one mechanism specification, at most250 lines; owner amendments, at most15 lines each. Each specification section states its ablation. Register the new specification in the generated documentation index.

One Astra Consultant scrutinizes the actual draft. A fresh Sol Reviewer independently checks the final diff against approved intent and surrounding owners. Run repository documentation checks and the required static local gate on the committed head. Express land under the shared window, release it, and watch the containing main CI.

Acceptance: exact canonical/package path alignment and justified differences; clear retained-shape classification; accurate unavailable references; no duplicate record/version authority; no default retention copies; bounded extension contracts; unchanged backup implementation. L-WEB Landing1/retained-version reader integration takes priority when that dependency lands.

## Checkpoint

The first draft separates the shared contract from existing implementation projections. Source inventory and classification remain uncommitted evidence. Product implementation is not started by this documentation work.

## Intent Revision 2

Source: coordinator steering after the first draft. The engineer is refining the separate Storage Service package, media-processing location, raw namespace and Worker mounted-storage boundary. Hold those sections and affected owner amendments. Continue references/unavailability, data-movement distinctions, Context digest references and derivative lineage. Resume the same Astra scrutiny after the boundary arrives; do not run final review or land a partial contract.

## Intent Revision 3

Source: coordinator addenda05:53Z and05:58Z, both engineer-approved. Storage owns location in its own asynchronous/streaming TypeScript package; Knowledge raw is a mount namespace, leases reuse Policy grants, and Worker access stays in existing planes. Separate Derivation owns conversion; retrieval owns indexing/embeddings and indexable-unit consumption. Knowledge/local Storage integration precedes Artifact/Turn/Context adoption. Add mount/lease/content-ref and trace-hit formats; keep this landing documentation-only. Resume the same Astra scrutiny, obtain fresh Sol review, gate and express.
