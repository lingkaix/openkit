# Protocol Contract Consolidation

Status: Accepted
Implementation: Implemented

## Summary

This spec consolidates the stable conclusions from earlier protocol package, lifecycle enum, naming, output delta, and core hardening specs.

The active contract is that `packages/protocol`, NanoCore App API schemas, and MCP-facing read/write tools stay structurally aligned around OpenKit-owned concepts. Runtime-native payloads, backend logs, and external protocol shapes may be projected into OpenKit records only through explicit adapters.

Historical protocol hardening specs have been moved under `docs/specs/retired/protocol-hardening/` and are retained as supporting detail.

## Owns

- The active consolidation point for protocol package, lifecycle enum, naming, output delta, and hardening decisions.
- The boundary between OpenKit-owned protocol records and runtime-native payloads.
- The current implementation projection of `packages/protocol` strict schema behavior.
- The replacement path for historical protocol hardening specs.

## Does Not Own

- Canonical core protocol doctrine already owned by `docs/core/protocol.md`.
- Transport topology, communication planes, bridge sidecars, or worker-control wire semantics.
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
- Keep public App API and MCP contracts aligned with stable NanoCore behavior.
- Promote stable protocol decisions into `docs/core/protocol.md`, `docs/core/communication.md`, and `docs/core/contract-evolution.md`.

## Non-goals

- Do not revive historical package organization plans as active implementation guides.
- Do not expose Codex app-server JSON-RPC, ACP, A2A, MCP internals, provider SDK payloads, shell logs, or OpenShell internals as core protocol objects.
- Do not preserve historical internal-development protocol shapes as supported current behavior.

## Current Contract

`packages/protocol` owns stable protocol concepts that multiple surfaces can depend on.

NanoCore owns app-local records and App API schemas while their shape is still being validated through dogfooding.

`@openkit/mcp` is a user-facing channel facade over public NanoCore behavior. It is not the canonical protocol and should not bypass NanoCore records.

Worker runtimes and backends may produce native events, logs, checkpoints, and transcripts. NanoCore decides what becomes a canonical turn item, artifact, review row, workspace sync record, audit event, or diagnostic.

## Current Implementation Projection

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

The historical protocol specs have been moved under `docs/specs/retired/protocol-hardening/`.

They are useful for why older names changed, but current work should start from this spec and the core protocol docs.

## Links

- [Core Protocol](../core/protocol.md)
- [Communication Model](../core/communication.md)
- [Contract Evolution Model](../core/contract-evolution.md)
- [OpenKit AI Interface](./20260617-openkit_ai_interface.md)
- [Human Attention And Intervention Model](./20260531-human_attention_intervention_model.md)
