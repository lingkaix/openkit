# Web Inline Questions

Status: Superseded

Superseded by: [Web Product Surface Projection](../../20260628-web_product_surface_projection.md)

Superseded: 2026-06-28. This file is retained as historical reference for the pre-rebuild Web UI slice and does not define 0.0.1 release readiness.

## Context

US-018 requires agent user-input requests to be actionable inside the streamed conversation timeline.

The protocol already supports answering a paused turn by posting to `/api/turns` with `workspaceId`, `threadId`, `turnId`, `input`, and a UUID `requestId`. The web app now uses that path from inline question cards.

## Behavior

- `QuestionCard` renders user-input-request items with the primary question header, prompt, answer input, and Submit action.
- `ThreadWorkbench` renders user-input-request items through `QuestionCard`.
- Submitting an answer calls `core-client.startTurn` with `workspaceId`, `threadId`, `turnId`, `input`, and a fresh UUID `requestId`.
- The question card disables while an answer is in flight or after a user-input-response item for the same request is visible.
- The conversation timeline renders user-input-response items as the authoritative answer audit record.
- The same active turn subscription remains open while the answer resumes the turn.

## Verification

- `apps/web/src/components/QuestionCard.test.tsx` covers the happy-path answer submit.
- `apps/web/src/App.test.tsx` covers the request body and visible user-input-response rendering.
- Browser verification against the internal self-check executor confirmed the inline answer request posts `turnId`, `input`, and `requestId`, then renders the response item and completed artifact.
