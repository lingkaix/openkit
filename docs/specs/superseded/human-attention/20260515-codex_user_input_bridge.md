---
status: Superseded
implementation: N/A
status-changed: 2026-07-03
current-guidance: "`docs/specs/20260531-human_attention_intervention_model.md`, `docs/core/protocol.md`, `docs/core/communication.md`, `docs/specs/20260703-worker_control_protocol.md`"
decision-evidence: "`docs/specs/20260531-human_attention_intervention_model.md`, `docs/core/protocol.md`, `docs/core/communication.md`, `docs/specs/20260703-worker_control_protocol.md`"
---
# Codex User Input Bridge

## Lifecycle Reason

Human Attention, Protocol Consolidation, and Worker Control absorbed elicitation, user-input items, and runtime response translation into shared authorities. The Codex bridge slice lost authority because questions and answers must follow product-wide gate semantics rather than one adapter's JSON-RPC lifecycle.

## Retention Reason

This document preserves the first Codex question/answer mapping, pending request behavior, and response tests so adapter maintainers can diagnose historical integrations without using the bridge as the current elicitation contract.

## Summary

US-009 bridges Codex app-server user-input questions into nanocore turn items and sends UI answers back to the pending Codex JSON-RPC request.

## Goals / Non-goals

- Add explicit `user-input-request` and `user-input-response` protocol item types.
- Use `awaiting_human` with `humanGate.kind: "user-input"` as the human-gated pause state.
- Treat `POST /api/turns` with `turnId` as a response to a paused question instead of a new turn.
- Keep question support scoped to plain text answers for v0.0.1.

## Proposed Design

`UserInputRequestItemSchema` and `UserInputResponseItemSchema` extend the protocol item union with durable question and answer timeline entries.

The adapter maps Codex `item/tool/requestUserInput` requests into normalized agent question events.

`CodexHostAdapter` creates a `user-input-request` item, pauses the turn by setting `awaiting_human` with a user-input human gate, and marks the agent session as waiting.

When the UI posts `{ workspaceId, threadId, turnId, input }` to `/api/turns`, nanocore detects that the referenced turn is paused, creates a `user-input-response` item, forwards the answer to the pending Codex request, and resumes the turn.

## Alternatives Considered

Approval item reuse was rejected because questions and permissions need different UI affordances and durable audit fields.

Separate approval and question turn statuses were rejected because `awaiting_human` plus `humanGate.kind` keeps the lifecycle small while preserving explicit UI routing.

## Testing Strategy

- Protocol schema tests parse `user-input-request` and `user-input-response` items.
- Host adapter tests drive a Codex JSON-RPC user-input request through a transport mock and answer through `/api/turns`.
- Package typecheck, lint, tests, build, and repository checks cover integration drift.

## Risks & Mitigations

- Risk: clients may treat every human pause as an approval.
- Mitigation: require clients to branch on `humanGate.kind` and the referenced item type.
