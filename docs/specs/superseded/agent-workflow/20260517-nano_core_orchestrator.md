# NanoCore Turn Orchestrator

Status: Superseded
Implementation: N/A
Status Changed: 2026-07-03
Current Guidance: `docs/core/agent-workflow.md`, `docs/specs/20260531-worker_turn_reliability_envelope.md`, `docs/specs/20260629-worker_runtime_communication_model.md`, `docs/specs/20260703-runtime_scheduling_scale.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

The Agent Workflow core model plus reliability, runtime communication, and scheduling specs absorbed turn orchestration responsibilities into stable workflow and runtime owners. This route-level slice lost authority because intake, execution, recovery, and placement can no longer be specified as one handler-local path.

## Retention Reason

This document preserves the first orchestrator sequence, route integration, and failure cases so maintainers can compare later coordination behavior with the original slice without treating that implementation path as the current workflow contract.

## Summary

NanoCore now routes new turn starts through `apps/nanocore/src/runtime/orchestrator.ts`.

The orchestrator owns the current happy path: resolve workspace defaults, select an agent, compute readiness, create the turn, start the executor, and return a `TurnHandle`.

## Goals / Non-goals

Goals:

- Put new-turn startup behind one runtime module.
- Make agent selection explicit before turn persistence and execution.
- Preserve existing `/api/turns` behavior.
- Leave the orchestrator small enough for later provider and diagnostics expansion.

Non-goals:

- Move user-input continuation handling out of the route.
- Replace the executor or host adapter.
- Block execution on non-ready agent states in this iteration.

## Background

US-018 added file-backed agent manifests.

US-019 added readiness and agent selection and introduced a minimal orchestrator.

US-020 strengthens that module into the route-level new-turn path and returns a `TurnHandle` with the selected agent and readiness.

## Proposed Design

`startTurn(input)` accepts:

- `store`
- `workspaceId`
- `threadId`
- `input`
- `turnExecutor`
- `agentManifests`
- `providerRegistry`
- optional `agentId`
- optional injected dependencies for tests and later composition

It returns:

- `turn`
- `agent`
- `readiness`

The route keeps request parsing and user-input continuation handling.

New-turn handling delegates to the orchestrator and serializes only `handle.turn` as the existing response shape.

## Alternatives Considered

Keep agent selection in `app.ts`:

- Rejected because agent selection, readiness, persistence, and execution order would remain split across route code.

Make readiness block execution immediately:

- Deferred because the current PRD story only requires selection integration and existing turn-start behavior must keep working.

## Rollout / Migration Plan

No migration is required.

Existing API response shape is unchanged.

## Testing Strategy

- Orchestrator tests assert selected agent and readiness are returned.
- Orchestrator tests assert call order: selector, turn creation, executor start.
- Orchestrator tests assert missing selected agent fails before executor start.
- Existing server route tests assert `/api/turns` behavior still works.

## Risks & Mitigations

Risk: moving turn startup could change route behavior.

Mitigation: the route still returns the same `Turn` payload and existing server tests run against the delegated path.

## Open Questions

- Whether future readiness states should block turn execution.
- Whether provider/model resolution should move into this orchestrator in US-021 or later.
