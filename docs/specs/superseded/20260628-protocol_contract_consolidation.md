# Protocol Contract Consolidation

Status: Superseded
Implementation: N/A
Status Changed: 2026-07-18
Current Guidance: `docs/core/protocol.md`, `docs/core/communication.md`, `docs/core/contract-evolution.md`, `packages/protocol/README.md`, `docs/specs/20260528-core_client_boundary.md`, `docs/specs/20260704-app_api_openapi_projection.md`, `docs/specs/20260713-openkit_agent_skill_interface.md`, `docs/app-api.md`, `apps/nanocore/README.md`
Decision Evidence: `docs/changes/202607111941330001-core_spec_implementation_alignment_audit.md`, `docs/changes/202607131935040001-openkit_agent_skill_interface.md`

## Lifecycle Reason

The G02 ownership review found no continuing contract unique to this consolidation spec. C07 owns stable protocol semantics, C08 owns transport and replay, C18 owns evolution policy, `@openkit/protocol` owns machine-readable shared schemas and conformance fixtures, S02 owns the typed client boundary, S03 and `docs/app-api.md` own the App API and OpenAPI projection, S04 owns the end-user Skill and CLI projection, and NanoCore remains the implementation owner of its routes and events. The stale cursor description retained below is historical evidence, not current guidance.

## Retention Reason

This document preserves the 2026-06-28 consolidation rationale and the path by which earlier protocol-hardening documents lost authority. It remains useful for historical review, but current design and implementation decisions must follow the owners named above.

## Summary

This spec consolidates the stable conclusions from earlier protocol package, lifecycle enum, naming, output delta, and core hardening specs.

The active contract is that `packages/protocol`, NanoCore App API schemas, and end-user Agent Skill Interface operations stay structurally aligned around OpenKit-owned concepts. Runtime-native payloads, backend logs, and external protocol shapes may be projected into OpenKit records only through explicit adapters.

Historical protocol hardening specs have been moved under `docs/specs/superseded/protocol-hardening/` and are retained as supporting detail.

## Owns

- The active consolidation point for protocol package, lifecycle enum, naming, output delta, and hardening decisions.
- The boundary between OpenKit-owned protocol records and runtime-native payloads.
- The current implementation projection of `packages/protocol` strict schema behavior.
- The replacement path for historical protocol hardening specs.

## Does Not Own

- Canonical core protocol doctrine already owned by `docs/core/protocol.md`.
- Transport topology, communication planes, runtime mediation, or worker-control wire semantics.
- App API route shape, Web UI read models, database tables, filesystem layout, or runtime adapter private APIs.
- Provider-native payloads, OpenShell internals, Codex app-server JSON-RPC, ACP, A2A, or MCP-native protocol internals.
- Knowledge Store governance, agent capability routing, audit storage, or usage metering.

## Core References

- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/contract-evolution.md`
- `docs/core/work-model.md`

## Goals

- Keep the current protocol model small, stable, and OpenKit-owned.
- Preserve `Workspace -> Thread -> Turn -> Item[]` as the user-visible backbone.
- Keep human gates represented through `awaiting_human` and item-backed approval or elicitation records.
- Keep artifacts, workspace reviews, goal reviews, knowledge proposals, and evidence exposed through product records instead of runtime-private logs.
- Keep public App API and Agent Skill Interface operation contracts aligned with stable NanoCore behavior.
- Promote stable protocol decisions into `docs/core/protocol.md`, `docs/core/communication.md`, and `docs/core/contract-evolution.md`.

## Non-goals

- Do not revive historical package organization plans as active implementation guides.
- Do not expose Codex app-server JSON-RPC, ACP, A2A, MCP internals, provider SDK payloads, shell logs, or OpenShell internals as core protocol objects.
- Do not preserve historical internal-development protocol shapes as supported current behavior.

## Current Contract

`packages/protocol` owns stable protocol concepts that multiple surfaces can depend on.

NanoCore owns app-local records and App API schemas while their shape is still being validated through dogfooding.

The unified end-user Skill's bundled CLI is a channel facade over public NanoCore behavior. It is not the canonical protocol and must not bypass NanoCore records.

Worker runtimes and backends may produce native events, logs, checkpoints, and transcripts. NanoCore decides what becomes a canonical turn item, artifact, review row, workspace sync record, audit event, or diagnostic.

## Current Implementation Projection

The stable protocol package and NanoCore App API alignment described here are implemented. The accepted end-user Agent Skill Interface projection is not implemented yet, so channel alignment remains partial until the bundled CLI and operation coverage guard replace the legacy MCP projection.

`packages/protocol` is the current machine-readable protocol package for stable shared schemas.

The current implemented wire protocol constant is `0.3.0`. Current strict schemas require explicit `Turn.configVersion`, command-execution `output`, SSE envelope `protocolVersion`, API error `protocolVersion`, and item-delta `itemType`.

NanoCore currently retains command idempotency records for seven days and prunes expired records on load, lookup, record, and persistence paths.

The only live transport projection today is the thread-scoped SSE stream with cursor shape `(workspaceId, threadId, sequence)`. Workspace-scoped, turn-scoped, and agent-session-scoped cursors remain conceptual until a follow-up spec or implementation promotes them.

Current protocol and item event surfaces use `knowledge` and `knowledge-injection` naming for the minimal existing Knowledge Store slice. The older `memory` projection was removed directly, without long-lived compatibility aliases.

The protocol package test suite now guards the strict schema requirements above, validates conformance fixtures, and scans public protocol source, conformance fixtures, and generated schema outputs to keep the old knowledge-store vocabulary out of tracked public protocol contracts.

Concrete package paths, generated schemas, enum source locations, and pruning mechanics belong in specs and implementation notes, not in core protocol doctrine.

## Naming Rules

Use OpenKit product vocabulary for public records:

- workspace
- thread
- turn
- item
- artifact
- goal
- action center row
- agent session
- workspace materialization record
- workspace change set
- staged workspace review
- workspace apply result

Use backend vocabulary only inside backend-private evidence, adapter code, diagnostics, or references that are explicitly marked as implementation details.

## Reference Specs

The historical protocol specs have been moved under `docs/specs/superseded/protocol-hardening/`.

They remain useful for why older names changed, but current work must start from the owners named in `Current Guidance` above.

## Links

- [Core Protocol](../../core/protocol.md)
- [Communication Model](../../core/communication.md)
- [Contract Evolution Model](../../core/contract-evolution.md)
- [Protocol Package](../../../packages/protocol/README.md)
- [Core Client Boundary](../20260528-core_client_boundary.md)
- [App API OpenAPI Projection](../20260704-app_api_openapi_projection.md)
- [OpenKit Agent Skill Interface](../20260713-openkit_agent_skill_interface.md)
- [Human Attention And Intervention Model](../20260531-human_attention_intervention_model.md)
