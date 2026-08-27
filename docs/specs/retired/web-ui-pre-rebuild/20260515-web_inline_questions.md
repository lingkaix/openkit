---
status: Retired
implementation: N/A
status-changed: 2026-06-28
current-guidance: None
decision-evidence: "https://github.com/lingkaix/openkit/commit/fffc107f9b73a8855045435598dcf97ebf2786da"
---
# Web Inline Questions

## Lifecycle Reason

The pre-rebuild Web UI module and its inline question interaction were deliberately removed during the full product-surface reset. This slice is retired because no current contract continues its timeline rendering, response form, or submission behavior.

## Retention Reason

This document preserves the former human-input UX and protocol mapping so maintainers can interpret deleted question handling and historical tests without constraining the rebuilt Web surface to the abandoned interaction model.

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
