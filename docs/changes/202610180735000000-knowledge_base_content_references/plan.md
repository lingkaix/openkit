---
type: change-plan
status: in-progress
---
# Knowledge Base And Content Reference Cutover

## Intent Revisions

2026-10-18, coordinator-approved rc.11 work: add Knowledge Base identity to page references, raw-content scopes, optional SHA-256 pins, one textual URI codec, URI-only retention and additive retrieval-trace hit content references. [Core Protocol](../../core/protocol.md#scope-qualified-object-references) owns the shared grammar; [File Storage](../../specs/20261018-file_storage_and_knowledge_packages.md) owns the default base and content descriptor. The engineer's decision and the coordinator's default-path ablation are recorded in [Knowledge Base And Content References](../../decisions/20261018-knowledge_base_and_content_references.md).

## Entry Gate

The read-only inventory covers literal page scopes and indirect schemas, Notebook Source references, retrieval traces, Worker packages/cursors, retained Tool answers, Web, CLI and generated projections. Main starts at 47fec0e3. L-AW's file-storage design has landed. Join L-AK's overview, User Memory and Server Thread paths only after the corresponding landings reach main. L-AK retains Source/raw and Claim migrations and its KM-owned documents. L-AW retains Storage/contentRef and Context Package digest-reference contracts. Agree one writer per overlapping path. All new Web edits belong to the coordinator-dispatched frontend writer.

## Working Checkpoint

Implementation has started with shared Protocol and configuration/API schemas on separate bounded helper branches. Default Worker-delivered paths stay unchanged; retained identity carries the base ID. Creation records one independent ID in existing scope configuration; parsing and reads never allocate it. No converter, legacy reader, dual write, new registry, broader source access or host action is included. Detailed working state and exact evidence remain in the external L-ID checkpoint.

## Acceptance And Closeout

Regressions first cover canonical kind/scope/URI admission, exact codec round trips and pins, unchanged default paths, allocation once across retry/restart, current-access refusal and import reference closure. Retrieval trace content references preserve original versus representation identity and unavailable-content semantics. Run complete affected module/package suites, Web e2e when composed Web changes require it, and one regeneration of OpenAPI/CLI from the actual composed definitions. Obtain independent Sol review and record exact committed-head gate evidence.

Prepare, review and gate before the rc.10 cut. Reset-dependent changes MUST NOT land before the coordinator announces that cut. Then merge current main, regate the actual overlap, run required full branch CI for this large landing and use express landing on green main. The coordinator alone performs the single coordinated rc.11 reset. This plan does not authorize a reset, deployment, account action, release or tag.
