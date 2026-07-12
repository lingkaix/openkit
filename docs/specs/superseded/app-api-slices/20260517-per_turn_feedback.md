# Per-Turn Feedback

Status: Superseded
Implementation: N/A
Status Changed: 2026-07-03
Current Guidance: `docs/specs/20260703-audit_usage_evidence_records.md`, `docs/specs/20260628-web_product_surface_projection.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

Audit/Usage/Evidence and Web Product Surface guidance absorbed feedback evidence, product projection, and current App API ownership. This per-turn file/API slice lost authority because feedback is now governed through broader evidence and product read-model contracts rather than a standalone record family.

## Retention Reason

This document preserves the original feedback-file shape, endpoint behavior, and dogfooding motivation so maintainers can audit how feedback evolved into broader evidence and review projections without restoring the old API owner.

## Summary

NanoCore now persists one feedback file per completed turn and exposes a small API to update the rating and note.

The feature supports dogfooding by keeping feedback close to the turn artifact on disk.

## Goals / Non-goals

Goals:

- Create `feedback.json` when a turn completes.
- Store `turnId`, `agentId`, `rating`, `note`, and `createdAt`.
- Update `rating` and `note` through a protected API.
- Preserve server-mode user isolation through existing request-scoped stores.
- Use atomic temp-file and rename writes.

Non-goals:

- Add web UI affordances.
- Add analytics aggregation.
- Add protocol-level feedback models.

## Background

US-021 added diagnostics for dogfooding setup state.

US-022 adds the first per-turn feedback persistence so later UI work can record dogfooding quality signals.

## Proposed Design

`apps/nanocore/src/runtime/feedback.ts` owns feedback file paths, schemas, reads, initial creation, and atomic updates.

Feedback files live at:

```text
data/users/<userId>/workspaces/<workspaceId>/threads/<threadId>/turns/<turnId>/feedback.json
```

`FsStore.updateTurn` calls `ensureTurnFeedback` when a turn first reaches `completed` with a `completedAt` value.

`POST /api/turns/:turnId/feedback` accepts:

```json
{
  "rating": "good",
  "note": "Worked well."
}
```

`rating` may be `"good"`, `"bad"`, or `null`.

`note` may be a string or `null`.

Invalid bodies return HTTP 400 with `code: "invalid_feedback"`.

## Ownership and Auth

The route is under `/api/*`, so server mode uses the existing auth middleware.

The route resolves the store through `requestStore(c)`, which is already scoped to the authenticated user id.

Cross-user updates therefore cannot find the turn and return 404.

## Atomicity

Feedback updates write JSON to a sibling `.tmp` file and then call `renameSync` to replace `feedback.json`.

## Rollout / Migration Plan

No migration is required.

Feedback files are created for turns completed after this change.

## Testing Strategy

- Feedback file is created on completion.
- POST updates rating and note.
- Invalid bodies return typed 400 errors.
- Temp-file and rename behavior is guarded.
- Server-mode cross-user update attempts return 404.

## Risks & Mitigations

Risk: feedback could be written under the wrong user.

Mitigation: feedback uses the store owner user id, and server-mode route tests exercise cross-user rejection.

## Open Questions

- Whether failed or interrupted turns should also receive feedback files.
- Whether future UI should display existing feedback by reading this file directly or through a dedicated GET route.
