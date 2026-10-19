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
- Exact operation-table type annotations permit declaration emission after the owner and Policy joins without changing validators or runtime composition.
- Removing the pre-envelope Thread audience classifier and its obsolete migration command makes the required reset boundary use one reader without conversion or startup rewriting.
- Task terminal facts retain their existing Workspace address through an explicit projection from the canonical Turn owner; completion evidence joins read the owner only for Item and CapabilityCall.
- Owner documents and the retained-format register state the accepted reset-cohort shape and unchanged placement.

## Checkpoint (Rewritable)

The independent author produced Protocol RED (14 failed, 13 passed) and real Store/SQLite/export RED (7 failed, 1 passed). The shared record family, retained readers, Store, capture, Context and portability joins are implemented. Complete pre-integration suites passed Protocol 461, App API 462, Core Client 121, Context 71, capability ledger 25, capture/observation/Knowledge Manager 128 and offline corpus/CLI 22 cases. Corrected terminal/cleanup, shared-fixture, export and lineage suites pass 50, 77, 31 and 47 cases. Two offline public-record owner regressions showed RED, then the complete qualification suite passed all 71 cases. Native runs before the required F3 join are diagnostic only: real owner defects and a missing pinned Retrieval Kernel build prerequisite are corrected; the third run was interrupted for integration and supplies no complete-suite result. The exact approved leading headers lost during mechanical editing are restored, and governance passes. Current main18737e425 is merged normally with F3 Policy semantics preserved. Its dependency and Native builds plus canonical Protocol/OpenAPI/CLI generation pass after exact operation-table type annotations resolve declaration-emission size limits; no validators or frozen owner shapes changed. The coordinator replaced GO → CH → TH with first-ready landing at 03:47 UTC. The Composer Web child uses frozen WIP74a28d171 and the full 29-path chore plus three Server-owner boundary regressions. Integrated complete affected suites, Web review/merge/browser gate, fresh Sol review, Server owner review and exact-head full branch CI remain open. Exact evidence and path holds remain in the external backlog under evidence/L-TH; no landing is claimed.

## Acceptance

Require exact owner agreement, unchanged Workspace/Server admission and storage separation, retained reopen refusal without mutation for invalid owners, and Workspace export exclusion of Server work. Run complete affected suites, Native TypeScript, lint, canonical generated outputs and documentation checks. Obtain fresh independent Sol review and bounded Server owner review. Run full branch CI on the exact final head before direct-main landing. No host, deployment, reset or release action is authorized.
