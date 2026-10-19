---
type: change-plan
status: in-progress
date: 2026-10-19
branch: lane/th-owner-union
---
# F9 Explicit Work Owner Union

## Intent Revision 1

The engineer confirmed F9 cleanup on 2026-10-19. The coordinator approved the five-line direction check before implementation. Unify Thread, Turn, Item and CapabilityCall into one owner-qualified schema family before the rc.10 reset. Keep operation Workspace selectors, storage placement, owner authority and lifecycle semantics. Support exactly Workspace and Server owners. Remove repeated Server Item variants and retired record shapes without compatibility readers, converters or migrations. Web edits belong to the coordinator.

## Owners

- [Core Concepts](../../core/core-concepts.md#thread) owns immutable narrative ownership.
- [Protocol](../../core/protocol.md#thread-semantics) owns record and transport semantics.
- [Storage Layout](../../specs/20260703-storage_layout_record_ownership.md) owns physical placement.
- [Audit and Usage](../../specs/20260703-audit_usage_evidence_records.md) owns call attribution and persistence.
- [Retained Format Register](../../specs/20261017-retained_format_register.md) inventories the affected retained records.

## Necessary Mechanisms

- The explicit Workspace-or-Server owner union replaces parallel record schemas and prevents absent Workspace selectors from implying authority.
- One Item variant list prevents owner-specific vocabulary drift; retained readers keep their independent fixed v1 vocabulary.
- A fail-closed Workspace-owner accessor lets existing Workspace consumers use the common records without accepting Server authority.
- Server transcript validation keeps its existing Server-only child boundary after the child records share one schema.
- Producer, reader, capture, context, App API and portability changes keep owner facts consistent across existing boundaries.
- Offline public-record attribution reads the explicit Turn owner so Server work cannot qualify a Workspace round.
- Owner documents and the retained-format register state the accepted reset-cohort shape and unchanged placement.

## Checkpoint (Rewritable)

The independent author produced Protocol RED (14 failed, 13 passed) and real Store/SQLite/export RED (7 failed, 1 passed). The canonical owner family, retained readers and shared Store/portability joins are implemented. Complete Protocol 461, App API 462, Core Client 121, capture/observation/Knowledge Manager 128 and offline corpus/CLI 22 tests pass. The independent Store boundary suite passed its original eight cases; an additional audience-owner injection regression showed RED, then passed after the Workspace producer fixed its owner after audience input. Native TypeScript r6, dependency/Native build, canonical Protocol/OpenAPI/CLI generation, all four affected package lint gates and the repository check pass. The mechanical edit dropped leading comments in 21 files; the exact approved headers are restored and test governance passes. Native r2 was stopped after it exposed owner joins and a missing Retrieval Kernel build prerequisite. Those joins are corrected, the pinned kernel is built, and a fresh complete Native r3 is active. Separate terminal/cleanup, shared-fixture, export and lineage suites pass 50, 77, 31 and 47 cases. The offline public-record qualification suite passes all 71 cases after two observed owner-boundary failures. The coordinator permits named concern-region writes and replaced GO → CH → TH with first-ready landing on 2026-10-19 at 03:47 UTC. F9 retains its own required gates. Approved main changes through 71bf450d8 are merged normally; landed F3 main18737e425 is the next integration. The Web child uses the frozen unapproved WIP head 74a28d171 and the consolidated 29-path coordinator chore. Final integrated main/Web joins, fresh Sol review, Server owner review and exact-head full branch CI remain open. Exact evidence and path holds remain in the external backlog under evidence/L-TH; no landing is claimed.

## Acceptance

Require exact owner agreement, unchanged Workspace/Server admission and storage separation, retained reopen refusal without mutation for invalid owners, and Workspace export exclusion of Server work. Run complete affected suites, Native TypeScript, lint, canonical generated outputs and documentation checks. Obtain fresh independent Sol review and bounded Server owner review. Run full branch CI on the exact final head before direct-main landing. No host, deployment, reset or release action is authorized.
