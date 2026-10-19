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
- Agent Policy prompt-cache and capability-call addressing use the admitted Turn owner, so a retired record selector cannot choose its Workspace scope.
- Exact operation-table type annotations permit declaration emission after the owner and Policy joins without changing validators or runtime composition.
- Removing the pre-envelope Thread audience classifier and its obsolete migration command makes the required reset boundary use one reader without conversion or startup rewriting.
- Task terminal facts retain their existing Workspace address through an explicit projection from the canonical Turn owner; completion evidence joins read the owner only for Item and CapabilityCall.
- Owner documents and the retained-format register state the accepted reset-cohort shape and unchanged placement.

## Checkpoint (Rewritable)

The independent author produced Protocol RED (14 failed, 13 passed) and real Store/SQLite/export RED (7 failed, 1 passed). The canonical owner family and its producers, readers, context, capture, App API and portability joins are implemented. Main6c02252e1 is merged normally, including Source, Policy agent gates, Knowledge packages and Goal administration. Workspace operation selectors and Task terminal-fact projections retain their existing address fields. The obsolete predecessor Thread audience converter and migration command are removed; current envelope, digest, audience, identity, refusal without rewrite and durable publication coverage remain.

The original complete Native run reported 8,836 passes and 22 failures, with a separate fork teardown timeout. Its raw failure evidence remains. Complete corrected files and later Source, Policy and context overlap suites qualify those corrections; no single complete Native green result is claimed. Current wire suites pass Protocol 460, App API 463 and Core Client 121 cases. Config 404, Storage 34, root affected 101 and the three affected Native black-box files (6 cases) pass. Dependency builds, Native TypeScript and canonical generation pass. The standard repository local gate passed on exact273d30192075ffa54fa6b4baf3fa480a40641f75 before the latest main join.

The approved Web child8ed0c3ea1 is merged normally. Its independent Server boundary oracle has actual mutant RED and restored GREEN evidence. Integrated Web lint, TypeScript, build and 1,538 unit cases pass; the complete browser run reports 32 passes and two stale Turn record assertions. Their exact correction is assigned to the coordinator; GPT has made no Web edits. L-AK approved the bounded Server/Source owner follow-up on273d30192. The latest main overlap reports 53 passes and 11 failures at one new Goal fixture's retired Item field; the complete corrected file is being requalified. Current main archive portability repair is owned by L-AW. Fresh whole-change Sol review, browser completion, final current-head checks and exact-head full branch CI remain open. Named raw logs, path holds and review artifacts are in external backlog evidence/L-TH and reviews. No landing is claimed.

## Acceptance

Require exact owner agreement, unchanged Workspace/Server admission and storage separation, retained reopen refusal without mutation for invalid owners, and Workspace export exclusion of Server work. Run complete affected suites, Native TypeScript, lint, canonical generated outputs and documentation checks. Obtain fresh independent Sol review and bounded Server owner review. Run full branch CI on the exact final head before direct-main landing. No host, deployment, reset or release action is authorized.
