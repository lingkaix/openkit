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

One decision record, at most 60 lines; one mechanism specification, at most 250 lines; owner amendments, at most 15 lines each. Each specification section states its ablation. Register the new specification in the generated documentation index.

One Astra Consultant scrutinizes the actual draft. A fresh Sol Reviewer independently checks the final diff against approved intent and surrounding owners. Run repository documentation checks and the required static local gate on the committed head. Express land under the shared window, release it, and watch the containing main CI.

Acceptance: exact canonical/package path alignment and justified differences; clear retained-shape classification; accurate unavailable references; no duplicate record/version authority; no default retention copies; bounded extension contracts; unchanged backup implementation. L-WEB Landing1/retained-version reader integration takes priority when that dependency lands.

## Checkpoint

The first draft separates the shared contract from existing implementation projections. Source inventory and classification remain uncommitted evidence. Product implementation is not started by this documentation work.

## Intent Revision 2

Source: coordinator steering after the first draft. The engineer is refining the separate Storage Service package, media-processing location, raw namespace and Worker mounted-storage boundary. Hold those sections and affected owner amendments. Continue references/unavailability, data-movement distinctions, Context digest references and derivative lineage. Resume the same Astra scrutiny after the boundary arrives; do not run final review or land a partial contract.

## Intent Revision 3

Source: coordinator addenda05:53Z and05:58Z, both engineer-approved. Storage owns location in its own asynchronous/streaming TypeScript package; Knowledge raw is a mount namespace, leases reuse Policy grants, and Worker access stays in existing planes. Separate Derivation owns conversion; retrieval owns indexing/embeddings and indexable-unit consumption. Knowledge/local Storage integration precedes Artifact/Turn/Context adoption. Add mount/lease/content-ref and trace-hit formats; keep this landing documentation-only. Resume the same Astra scrutiny, obtain fresh Sol review, gate and express.

## Intent Revision 4

Source: approved coordinator addendum06:10Z. References carry Knowledge Base IDs; each scope retains one fixed default ID, with one Knowledge Base per scope in v0.1.0. Minimal local package import/export plus a round-trip test is pre-v0.1.0 implementation scope. Import targets a new or empty Workspace Knowledge Base and fresh bare Notebook. Published Git tree paths match package paths; raw bytes never enter Git. Host-side leased mounts are approved for implementation after v0.1.0. Raw-file Git tracking remains a reserved placeholder pending the engineer's decision. The old queued c1c gate was cancelled before slot acquisition; no product failure or gate pass is claimed.

## Intent Revision 5

Source: approved coordinator addendum 06:16Z. One small OKF SourceSummary pointer per admitted Source lives in Notebook Git at `sources/<source-id>.md`; retire the external registry, keep original bytes outside Git, and resolve logical raw paths through mount declarations. Changed originals update one pointer/commit; historical digest pins become unavailable when matching bytes disappear. Storage's rebuildable mount index covers all files; Git pointers cover only admitted Sources. Amend Source governance and Notebook ownership to make this transition explicit. The embedded-file URI/URL contract remains a placeholder pending the engineer's final input. Scrutiny also requires a bootstrap-only empty import target and complete remapped Source graph admission before Notebook publication; no new transaction or receipt is introduced.

## Intent Revision 6

Source: coordinator addendum 06:26Z, engineer basically approved. Owners define URIs; Knowledge Markdown uses relative raw paths, auto-admits embedded Sources and records their digest pins in existing commit sourceReferences. Storage owns streamed/ranged or short-lived presigned byte URLs; authenticated NanoCore admission checks audience/sensitivity and audits issuance. Web resolves paths at render time without rewriting Markdown or auto-loading external images; models use vision bytes. Raw moves repair page references. Freeze the path convention and commit evidence; the route is additive. Leave the S3-compatible facade, Worker/agent/sharing extension paragraph pending its promised decision. No product implementation occurs here.

## Intent Revision 7

Source: coordinator decision resolving the portable-path conflict. Embedded links are ordinary RFC 3986 relative paths from each page's directory; the publisher normalizes them and requires their resolved targets inside the Knowledge Base and raw/. Admitted page moves rewrite embeds; raw moves rewrite referrers. The default local mount is physical raw/ without a default-name segment. Additional mounts occupy raw/<mount>/ subdirectories; manifest-reserved names reject physical-folder collisions at declaration. This supersedes prior unconditional raw/<mount>/<path> examples while preserving unchanged Markdown, identical package paths and existing validation/authority. The final facade/Worker/agent/sharing extension paragraph remains pending.

## Intent Revision 8

Source: final approved coordinator addendum 06:35Z. After v0.1.0 an S3-compatible byte subset maps owner mount/path and existing Policy leases onto object operations, temporary credentials and scoped short URLs. It excludes bucket/ACL/lifecycle management; requires a compatible-library spike, bounded expiry and emergency signing-key rotation. Workers, internal/external agents, Channels and future sharing use the same URI/byte/Policy split; existing file consumers converge on it. Pre-freeze retained records and models contain URIs, never transport URLs or credentials. L-ID owns Core Protocol URI qualification; L-GA owns STS-compatible lease semantics. No product implementation, facade library dependency or host operation is included. All brief inputs are now complete; finish same Astra scrutiny, fresh independent Sol review, exact static gate and express landing.
