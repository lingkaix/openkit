---
status: Superseded
implementation: N/A
status-changed: 2026-05-29
current-guidance: "`docs/specs/20260529-test_strategy.md`, `docs/specs/20260529-l6_story_acceptance.md`"
decision-evidence: "`docs/specs/20260529-test_strategy.md`, `docs/specs/20260529-l6_story_acceptance.md`"
---
# Deterministic Simulator Executor

## Lifecycle Reason

Test Strategy and L6 Story Acceptance absorbed deterministic adapters into the L0-L6 verification model and defined where simulation is useful versus insufficient. This simulator slice lost authority because one test executor cannot define repository-wide acceptance strategy.

## Retention Reason

This document preserves the original deterministic executor behavior, fixture design, and limitations discovered during early testing so future test reviews can reuse evidence without elevating simulation into current product truth.

## Summary

US-010 replaces the timer helper with a deterministic `SimulatedTurnExecutor` that implements the same `TurnExecutor` contract as the real Codex host adapter.

## Goals / Non-goals

- Exercise assistant deltas, reasoning deltas, command output deltas, approvals, user-input questions, artifacts, and terminal turn completion without Codex installed.
- Select the simulator only through internal self-check/test wiring, currently `OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR=1` in the e2e harness.
- Keep the simulator deterministic so tests and browser e2e flows can assert stable item and event sequences.
- Avoid adding runtime adapter negotiation in v0.0.1.

## Proposed Design

`SimulatedTurnExecutor.startTurn` emits a fixed sequence through the existing store and SSE event surface.

The sequence is `user-message`, `assistant-message`, `reasoning`, `command-execution`, and `approval-request`, then the turn pauses in `awaiting_human` with an approval human gate.

`respondApproval` writes an approval decision and emits a `user-input-request`, then the turn pauses again in `awaiting_human` with a user-input human gate.

`respondUserInput` writes a user-input response, emits a synthetic artifact create/update pair plus an `artifact-reference` item, and completes the turn.

`createApp()` still defaults to `CodexHostAdapter`, except when the internal self-check executor flag is set by tests, where it constructs `SimulatedTurnExecutor`.

## Alternatives Considered

The previous timer helper was not retained as the primary API because it could not implement approval and question continuations through the same HTTP routes as the real adapter.

Automatic approval and question resolution were rejected because browser tests need to exercise real user actions.

## Testing Strategy

- `apps/nanocore/src/lib/simulator.test.ts` drives the full lifecycle across three turns.
- The simulator test asserts deterministic item order, item delta kinds, approval pause, question pause, artifact update, and terminal completion.
- The simulator test also verifies the internal self-check executor app default.

## Risks & Mitigations

- Risk: The simulator can drift from the real adapter item metadata.
- Mitigation: Keep simulator capabilities, item types, and delta kinds explicit and covered by metadata tests.

## Open Questions

- Should simulator scenarios become table-driven once the web e2e suite needs multiple fixture paths?
