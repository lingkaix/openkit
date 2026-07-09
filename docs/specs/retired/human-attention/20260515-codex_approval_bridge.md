# Codex Approval Bridge

Status: Superseded

Superseded by `docs/specs/20260531-human_attention_intervention_model.md`, `docs/specs/20260628-protocol_contract_consolidation.md`, and `docs/specs/20260703-worker_control_protocol.md`.

This document is retained as supporting detail for the original Codex approval bridge implementation slice.

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
