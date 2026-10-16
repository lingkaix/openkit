---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/ch
---
# Discord And Shared Notifications

## Intent Revision 1

Source: engineer assignment to lane L-CH on 2026-10-16, P23, the shared lane brief, and the Discord-first ruling. Deliver shared notification lifecycle and the Discord adapter, with owner criteria, regression tests, generated OpenAPI and CLI, configuration, Web settings, and manuals in the same coherent landings. Use fake external transports. A real bot account is a later real-send proof and does not block implementation. No vendor account operation, host operation, contact with other lanes, release publication, or credential disclosure is authorized. Commit and push the lane branch at least hourly and land completed features through landing protocol v2.

## Owners And Decisions

[Communication](../../core/communication.md) owns the channel boundary. [Pending Requests](../../specs/20260930-pending_requests.md) owns exact responses and request attention. [Permissions](../../core/permissions.md) owns current authority and audience admission. Existing storage, operation definitions, configuration, and Web design owners remain binding. Use the recommended D07 scope with Discord. Direct decisions admit exact approval denials and non-secret question answers, in private direct messages only. Approval grants return to the App for the existing decision-strength confirmation. Email sends links only. Unknown sends and unknown response dispatch stay separate from Core outcomes.

## Checkpoint

Baseline: a1f2c6b8. Read the predecessor L-GA checkpoint; P23 implementation had not started. The primary owns all owner documents, shared schemas, storage integration, configuration, Web, manuals, operation composition, and Pending Request call sites. Builder notifications owns only the new notifications directory in its separate worktree. Builder discord owns only the new channels directory in its separate worktree. Both use gpt-6.1-sol and may not dispatch further agents. Merge helper branches, never cherry-pick. The final independent review must inspect the merged origin/main..HEAD diff and name its head.

## Next Action

Implement the two independent domain modules while the primary adds owner criteria and integration. Expected observation: fake-backed delivery and signed Discord input preserve current authority, exact request identity, deduplication, and truthful unknown results. Evidence that defeats the route includes a new lifecycle owner, a transport retry that duplicates effects, or an authority decision based on cached credentials. Reframe these locally before further investment. Merge the P14 identifier cutover when it reaches main; use only current identifier APIs.

## Verification

Use lowest-sufficient module regressions plus a real producer/consumer integration check across the channel-to-Pending Request seam. Fix expected behavior from the owners before implementation. External transports are fakes and prove no real Discord or Email sending. Run focused tests, repository checks, lint, typecheck, generated contract checks, independent review, and exact-head full CI before landing. Keep temporary evidence outside committed documentation. Closeout remains pending.
