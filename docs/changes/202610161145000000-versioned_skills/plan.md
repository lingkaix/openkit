---
type: change-plan
status: in-progress
---
# Versioned Skills

## Intent Revision 1

The engineer assigned P20 catalog and Skill lifecycle work to lane L-AK. The primary dispatched this helper to implement immutable provenance, then expanded the task to the accepted catalog lifecycle and operation projections. Preserve exact immutable versions, independent candidates, explicit selection, pins and rollback. Retain original PluginVersion membership. Do not create another catalog, runtime, evaluation runner or retention authority. Real Worker and BWM acceptance remain with the primary and require authorized real inputs.

## Accepted Owners

[Skill Catalog Versioning And Pinning](../../specs/20260711-skill_catalog_versioning_pinning.md) owns the lifecycle. [Agent Plugin Packaging And Worker Supply](../../specs/20260907-agent_plugin_packaging_and_worker_supply.md) owns exact package membership. Storage Core owns canonical retained snapshots; Operation Definition owns the public projections. Root execution and [Change Execution](../../change-execution.md) govern this record.

## Checkpoint

The three independently authored provenance regressions reached their expected failures before implementation. Commit `2ba95be1` corrects original package provenance, exact candidate base lineage and retained immutable facts on identical-byte admission. Subsequent local implementation covers valid root metadata, physical-tree normalization, immutable package source capture, one-revision candidate publication, typed submitter and decision evidence, exact inspection, comparison, default and pin conflict checks, removal and reference-protected purge. Payload availability is an additive field on the existing version, separate from immutable identity. Portable export preserves purged metadata and refuses unavailable retained bytes. Identical-byte admission restores purged bytes without replacing provenance.

## Seams And Evidence

Catalog tests use real disposable trees, canonical JSON and native import/read functions. Source-capture tests change the mutable source after its actual read and compare both trees. Operation tests use actual HTTP admission and strict schemas. The primary owns durable command receipts and Audit integration, Artifact-origin submission, Worker delivery and authoritative retention-reference enumeration. Native hook inputs expose those owners without substitute authority. Candidate decisions fail closed before mutation without real Audit context; the complete operation scenario retains its expected success oracle and is red until that integration is supplied. Catalog handlers currently have no request replay wrapper, so repeated request replay and changed-input refusal also require the primary's existing receipt integration. Raw named logs stay in the external L-AK evidence directory.

## Verification And Handoff

The previous focused run collected 72 native/API cases: 71 passed and the missing Audit integration failed. API operation schemas passed 2 tests, retained schema passed 2 tests, dependency builds passed 6 tasks and NanoCore typecheck passed. These results precede the final payload-availability and portability closure. Run the final focused bundle, record actual counts and remaining limits, inspect the diff and commit the coherent helper-owned change. The primary must review the merge, wire shared admission and delivery, generate public projections and prove authorized Worker consumption before P20 acceptance.
