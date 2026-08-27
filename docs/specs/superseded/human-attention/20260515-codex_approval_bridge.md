---
status: Superseded
implementation: N/A
status-changed: 2026-07-03
current-guidance: "`docs/specs/20260531-human_attention_intervention_model.md`, `docs/core/protocol.md`, `docs/core/communication.md`, `docs/specs/20260703-worker_control_protocol.md`"
decision-evidence: "`docs/specs/20260531-human_attention_intervention_model.md`, `docs/core/protocol.md`, `docs/core/communication.md`, `docs/specs/20260703-worker_control_protocol.md`"
---
# Codex Approval Bridge

## Lifecycle Reason

Human Attention, Protocol Consolidation, and Worker Control absorbed approval semantics, item contracts, and runtime command translation into cross-runtime owners. The Codex bridge slice lost authority because approval behavior can no longer be defined by one adapter's pending JSON-RPC request path.

## Retention Reason

This document preserves the original Codex approval mapping, pending-request lifecycle, and adapter error cases so runtime integrations can audit historical behavior without treating the bridge as the current approval contract.

## Summary

US-008 bridges Codex app-server approval requests into nanocore approval records and sends UI decisions back to the agent runtime.

## Goals / Non-goals

- Advertise `core.approvals` when `CodexHostAdapter` is active.
- Convert Codex exec, apply-patch, and item-scoped command approval requests into pending `ApprovalRequest` records.
- Emit `approval.requested`, `turn.updated awaiting_human` with an approval human gate, and agent-session waiting events.
- Forward granted or denied UI decisions back to Codex and resume the local turn.
- Add protocol item records for approval requests and decisions so turn item history carries the human decision path.

## Design

`CodexAppServerClient` now distinguishes inbound JSON-RPC requests from notifications and responds through a registered request handler.

`CodexAgentSession` maps `execCommandApproval`, `applyPatchApproval`, and `item/commandExecution/requestApproval` into normalized agent approval events.

`CodexHostAdapter` owns the local approval lifecycle: it creates the approval record, pauses the turn, sends the UI decision back to the session, marks the approval resolved, and resumes the turn.

`ApprovalRequestItemSchema` and `ApprovalDecisionItemSchema` extend the protocol item union with durable approval timeline entries.

## Testing Strategy

`apps/nanocore/src/runtime/host-adapter.approval.test.ts` covers grant and denial flows through an approval-capable agent-session mock.

`apps/nanocore/src/runtime/codex/client.test.ts` covers inbound JSON-RPC server request handling and transport response emission.

## Rollout Notes

The host Codex thread is now started with `approvalPolicy: "on-request"` so approval requests can reach nanocore.
