# Nano-Core Turn SSE Replay

Status: Superseded
Implementation: N/A
Status Changed: 2026-06-29
Current Guidance: `docs/specs/20260628-protocol_contract_consolidation.md`, `docs/specs/20260629-worker_runtime_communication_model.md`, `docs/specs/20260528-core_client_boundary.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

Protocol Consolidation, Worker Runtime Communication, and Core Client Boundary absorbed replay cursor semantics, event ownership, and reconnect behavior. The SSE-only slice lost authority because replay correctness now spans protocol records, runtime projection, and client consumption.

## Retention Reason

This document preserves the first `since` cursor algorithm, duplicate-avoidance cases, and reconnect tests so maintainers can diagnose historical SSE behavior without treating the endpoint slice as the complete replay contract.

## Summary

US-007 adds `since` cursor replay semantics to the turn-scoped SSE endpoint so clients can reconnect without duplicating already processed events.

## Goals / Non-goals

- Support `GET /api/workspaces/:wid/threads/:tid/events?turnId=:turnId&since=:seq`.
- Replay only events with `sequence > since`.
- Return `core.stream.cursor_expired` with HTTP 410 when the cursor is older than the retained event window.
- Close replay responses when the retained replay includes a terminal `turn.completed` event.
- Do not add durable stream pagination or a database-backed event log in this story.

## Design

`FsStore` keeps the last 100 events per turn stream as the in-memory replay window.

The SSE route parses `since`, checks it against the first retained sequence, writes retained events after the cursor, and then either closes for terminal replay or subscribes for live events.

## Testing Strategy

`apps/nanocore/src/sse-replay.test.ts` verifies a cold subscribe, a replay subscribe from the last seen cursor, no duplicate sequences, and the expired-cursor error path.

## Rollout Notes

Clients should store the highest received `sequence` and reconnect with `since=<lastSeen>`.
