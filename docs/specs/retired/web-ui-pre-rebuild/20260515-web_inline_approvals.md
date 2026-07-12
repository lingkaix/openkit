# Web Inline Approvals

Status: Retired
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: None
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

The pre-rebuild Web UI module and its inline approval interaction were deliberately removed during the full product-surface reset. This slice is retired because no current contract continues its timeline placement, action controls, or reconciliation behavior.

## Retention Reason

This document preserves the former inline approval UX, protocol assumptions, and acceptance boundaries so maintainers can understand the removed implementation without carrying its interaction design into the clean-slate Web rebuild.

## Context

US-017 requires approval requests to be actionable inside the streamed conversation timeline instead of only in the side approval list.

The protocol accepts an optional UUID request correlation id on approval responses. The web app sends that id with inline grant or deny actions and waits for the streamed approval-decision item plus lifecycle events to show the authoritative result.

## Behavior

- `ApprovalCard` renders approval-request items with action kind, title, description, Approve, and Deny controls.
- `ThreadWorkbench` renders approval-request items through `ApprovalCard`.
- Approval controls call `POST /api/approvals/:approvalRequestId/respond` through `client.core.respondApproval`.
- Each response includes a fresh UUID `requestId`.
- ApprovalCard buttons are disabled while a response is in flight or after an approval-decision item for the same request is visible.
- The approval side panel remains a read-only queue and status summary.
- The conversation timeline renders approval-decision items as the authoritative decision audit record.

## Verification

- `apps/web/src/components/ApprovalCard.test.tsx` covers grant and deny decisions.
- `apps/web/src/App.test.tsx` covers UUID requestId submission and visible granted decision rendering.
- Browser verification against the internal self-check executor confirmed inline Approve posts requestId, renders approval-decision `granted`, and resumes to the user-input request.
