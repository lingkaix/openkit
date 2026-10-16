---
type: change-plan
status: in-progress
---
# Versioned Skills

## Intent Revision 1

The engineer assigned P20 catalog and Skill lifecycle work to lane L-AK. The primary dispatched this helper to implement immutable provenance, then expanded the task to the accepted catalog lifecycle and operation projections. Preserve exact immutable versions, independent candidates, explicit selection, pins and rollback. Retain original PluginVersion membership. Do not create another catalog, runtime, evaluation runner or retention authority. Real Worker delivery remains required. BWM is a separate increment; synthetic and fake-backed implementation proceeds without B01, and real-use acceptance remains deferred to the engineer.

## Accepted Owners

[Skill Catalog Versioning And Pinning](../../specs/20260711-skill_catalog_versioning_pinning.md) owns the lifecycle. [Agent Plugin Packaging And Worker Supply](../../specs/20260907-agent_plugin_packaging_and_worker_supply.md) owns exact package membership. Storage Core owns canonical retained snapshots; Operation Definition owns the public projections. Root execution and [Change Execution](../../change-execution.md) govern this record.

## Checkpoint

The three independently authored provenance regressions reached their expected failures before implementation. Commit `2ba95be1` corrects original package provenance, exact candidate base lineage and retained immutable facts on identical-byte admission. Subsequent local implementation covers valid root metadata, physical-tree normalization, immutable package source capture, one-revision candidate publication, typed submitter and decision evidence, exact inspection, comparison, default and pin conflict checks, removal and reference-protected purge. Payload availability is an additive field on the existing version, separate from immutable identity. Portable export preserves purged metadata and refuses unavailable retained bytes. Identical-byte admission restores purged bytes without replacing provenance.

## Seams And Evidence

Catalog tests use real disposable trees, canonical JSON and native import/read functions. Source-capture tests change the mutable source after its actual read and compare both trees. Operation tests use actual HTTP admission and strict schemas. The primary owns durable command receipts and Audit integration, Artifact-origin submission, Worker delivery and authoritative retention-reference enumeration. Native hook inputs expose those owners without substitute authority. Candidate decisions fail closed before mutation without real Audit context; the complete operation scenario retains its expected success oracle and is red until that integration is supplied. Catalog handlers currently have no request replay wrapper, so repeated request replay and changed-input refusal also require the primary's existing receipt integration. Raw named logs stay in the external L-AK evidence directory.

## Verification And Handoff

Final4 dependency builds passed 6 tasks. The six native/API files collected 73 cases: 72 passed and the unchanged decision-success oracle failed because the composition layer has no Audit hook yet. API operation schemas passed 2 tests, retained catalog schemas passed 3 tests and NanoCore typecheck passed. The linked-parent admission regression then failed at the exact outside sentinel deletion assertion. Moving existing parent validation before staging cleanup corrected it. The final lifecycle and durable-write run passed all 32 cases, including the pure shared transport validator used by Skill admission and Artifact decoding; NanoCore typecheck passed again. Focused Biome and Git diff checks passed. Exact commands, logs and limits are in the external P20 builder report. The primary must review the merge, wire shared receipts, admission and delivery, generate public projections and prove authorized Worker consumption before P20 acceptance.

## Separate Feature Cut

The coordinator directs independent Skill and BWM increments after P19 and the Source-link fixes. The landing branch merges the component history but removes unfinished Notebook/profile/Audit/schema changes and BWM packages from its shipping diff. Knowledge keeps current behavior; no offline conversion or Notebook activation is included. Ecosystem source parsing, discovery and authorized local acquisition are component preparation; remote acquisition, explicit update checks, complete native receipts/Audit and physical Worker delivery remain unfinished.
