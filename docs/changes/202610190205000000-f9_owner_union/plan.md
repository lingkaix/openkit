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

The independent author produced Protocol RED (14 failed, 13 passed) and real Store/SQLite/export RED (7 failed, 1 passed). The owner-qualified family, Store, retained readers, capture, Context, App API and portability joins are implemented. Main547589564 is merged normally, including F3 Policy fixture corrections and F5's canonical Notebook page contract. Dependency and Native builds, canonical Protocol/OpenAPI/CLI generation and validation, and Native TypeScript pass. Complete integrated wire suites pass Protocol 460, App API 467 and Core Client 121 cases. The original 119-file Native diagnostic reported 3,259 passes and 79 failures and remains failed evidence, not final qualification. Work-record fixture reads, Thread metadata behavior, completion evidence and Task terminal-fact projections are corrected; seven complete repaired files pass all 129 cases. A new pre-envelope refusal regression showed actual RED, then passed with the complete envelope suite after removing the obsolete audience converter and migration command. Two tests specific to the removed migrator are retired under the required reset boundary; current envelope, digest, audience, identity, no-rewrite and durable atomic publication checks remain. The full Native suite is next. The Web child remains frozen at its owner-review correction request; no GPT Web edits were made. Prior bounded Server owner review approved4ade206b8; review of the reset-only delta, the browser gate, fresh independent whole-change Sol review and exact-head full branch CI remain open. No landing is claimed. Named logs, review artifacts and path holds remain in the external backlog under evidence/L-TH.

## Acceptance

Require exact owner agreement, unchanged Workspace/Server admission and storage separation, retained reopen refusal without mutation for invalid owners, and Workspace export exclusion of Server work. Run complete affected suites, Native TypeScript, lint, canonical generated outputs and documentation checks. Obtain fresh independent Sol review and bounded Server owner review. Run full branch CI on the exact final head before direct-main landing. No host, deployment, reset or release action is authorized.
