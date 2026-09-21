---
status: Draft
implementation: Not Started
date: "2026-09-21"
updated: "2026-09-21"
---
# Delayed User Input

## Owns

This Draft owns the problem statement, the gathered 2026-09-21 evidence, the constraints inherited from the work-data retention line, the confirmed blocking-gate-expiry terminal direction and its bound, and the remaining open questions for delayed user input. It does not yet own a runtime contract.

## Does Not Own

This Draft does not own Turn lifecycle, human-gate semantics, approval status, Item identity, retention format, Action Center projection, Goal Plan or Goal Review, Artifact Review, Workspace Sync Review, steering pending-input, vault grants, invitations, worker-gate closeout, or any write path, queue, or aggregation mechanism. Action Center projection remains with `docs/specs/20260531-human_attention_intervention_model.md`. Worker-gate closeout for protocol-level `expired`, `withdrawn`, and `superseded` remains with `docs/specs/20260531-worker_turn_reliability_envelope.md`. Those owners keep their contracts until an engineer admits a later delayed-input producer under [AUTH-001].

## Core References

- `docs/core/protocol.md`
- `docs/core/work-model.md`
- `docs/core/core-concepts.md`

## Related Docs

- `docs/specs/20260921-work_data_retention_format.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260704-goal_mode_coordination.md`
- `docs/specs/20260703-workspace_synchronization.md`

## Summary

User input can arrive after a long delay. A Turn can wait on approval while the user continues other work and returns after several Turns, or after months; by then a stale approval or other pending message is already stale product information, and a late reply may have little remaining value. This Draft records that problem, the engineer's recorded direction, evidence that must not be gathered again, and constraints this line must not overturn. A future blocking-gate expiry producer maps the Turn to `cancelled`, with the owning workflow able to withdraw authorization and with the reason recorded on an expiry Item; that mapping is not a universal cancellation rule and does not change current worker-gate closeout. Owner admission, the exact producer, request lifecycle, and structured expiry representation remain open. This document authorizes no Core, specification, or production change.

## Goals

- Preserve the delayed-user-input problem, recorded direction, and already-gathered evidence so the line survives after uncommitted working files are deleted.
- Record the confirmed blocking-gate-expiry terminal `cancelled`, with its producer deferred and its mapping bounded to that future producer.
- Record that a pending-input list is a real product need and that the existing Action Center projection, under its present owner, should be extended rather than replaced.

## Non-goals

- Do not accept a runtime contract, protocol change, or implementation plan in this Draft.
- Do not invent a ninth pending-request owner, a durable queue table, a fifth Turn terminal, or a new human-gate kind.
- Do not implement an expiry timer, bypass current worker-gate closeout proof, or ask the engineer again which terminal a blocking-gate expiry writes.
- Do not reopen work-data retention format, Item `seq` semantics, or in-package reference reminting, which belong to the accepted `docs/specs/20260921-work_data_retention_format.md`.
- Do not repeat the 2026-09-21 pending-request forensic sweep.

## Background

The engineer opened this line on 2026-09-21 from the work-data retention discussion. The triggering observation was not an isolated create-or-bind guard. User input may carry a long delay: a Turn waits on approval, the user does not respond and continues other interactions, and they return after several Turns or even months. On the product, an outdated approval or other message is already outdated information, and late feedback may have little value.

## Recorded Direction

The following is the engineer's recorded direction from that working session, including later confirmations that overturned part of the first write-up.

Approvals should distinguish blocking from non-blocking forms: a blocking approval stops and waits; a non-blocking approval continues. When the user responds, the response is written in place on the Turn and timeline where the user gave it, and it is not backfilled onto the Turn where the approval was opened. The record must be complete enough that a later reader can tell what happened, and it must link back to the Item that initiated the request. Some requests expire or become invalid, including when the task was completed another way or the Goal was abandoned. In that case the system produces an Item that records the handling and the reason, after which the request is no longer needed and the user is no longer allowed to act on it.

When a blocking gate expires, the Turn reaches `cancelled`. No fifth Turn terminal is added. The authorized actor includes the owning workflow when that workflow determines the work is superseded, and the specific reason — task completed another way, Goal abandoned, or timeout — is recorded on the expiry Item rather than encoded as another status value. That confirmed meaning does not install a producer: admission and closeout of an expiry request stay with this design line; current worker-gate behaviour is unchanged; Core states `cancelled` as a legal terminal whose path-to-terminal is decided by the owning accepted specification.

A product list of what still waits for the user is a real need. Request identity already exists; what stays coupled to the Turn is admission and lifecycle. The existing Action Center projection already aggregates waiting work, and this line extends that projection under its owner rather than adding a second aggregation authority.

## Gathered Evidence (Do Not Repeat)

The following three results were gathered on 2026-09-21 and are stated here in their corrected form, after a later review round overturned part of the original reading. They must not be re-derived.

This model already exists inside roughly half of the relevant owners. Eight pending-request owners were identified. Goal Plan, Goal Review, Artifact Review, and Workspace Sync Review already accept a response after the source Turn is terminal: Goal Plan through `approveThreadGoalPlan` (`apps/nanocore/src/goal-routes.ts:3288`, command `goal.plan.approve` at `:3318`; OpenAPI `approveThreadGoalPlan` at `apps/nanocore/src/openapi.ts:2611-2613`); Goal Review through `submitGoalReviewDecision` (`apps/nanocore/src/review-decision-routes.ts:491`, command `goal.review.decide` at `:526`; OpenAPI `submitGoalReviewDecision` at `apps/nanocore/src/openapi.ts:4377-4380`); Artifact Review through `submitArtifactReviewDecision` (`apps/nanocore/src/artifact-routes.ts:161`; OpenAPI `submitArtifactReviewDecision` at `apps/nanocore/src/openapi.ts:3711-3714`); Workspace Sync Review through `submitWorkspaceSyncReviewDecision` (`apps/nanocore/src/runtime/workspace-sync-routes.ts:133`; OpenAPI `submitWorkspaceSyncReviewDecision` at `apps/nanocore/src/openapi.ts:4490-4492`). Those four keep independent durable identity in `goalPlanRecords` (`apps/nanocore/src/storage/schema/goal-records.ts:78-79`), `goalReviewRecords` (`apps/nanocore/src/storage/schema/goal-review-records.ts:7-8`), `artifactReviews` (`apps/nanocore/src/storage/schema/artifact-reviews.ts:20-21`), and `stagedWorkspaceReviews` (`apps/nanocore/src/storage/schema/workspace-sync-records.ts:196-208`). Non-blocking response after Turn terminal is therefore an existing product shape, not a concept this line would invent.

The two owners that do not support that shape are the only two whose admission and lifecycle stay coupled to Turn status. Request identity already exists: `ApprovalRequestSchema` carries `id` (`packages/protocol/src/models/approval.ts:31-41`); `ApprovalHumanGateSchema` carries `approvalRequestId` and `itemId` (`packages/protocol/src/models/turn.ts:56-60`); `UserInputHumanGateSchema` carries `userInputRequestId` and `itemId` (`packages/protocol/src/models/turn.ts:65-69`). Approval pending admission is `Turn.status: 'awaiting_human'` plus `humanGate` on `TurnUnionSchema` (`packages/protocol/src/models/turn.ts:144-147`). The product response entry is `registerApprovalRoutes` `POST /api/approvals/:approvalRequestId/respond` (`apps/nanocore/src/approval-routes.ts:75`). User-input pending admission is the same Turn status with `isAwaitingUserInputGate` (`apps/nanocore/src/turn-routes.ts:76-77`); `turn.input.submit` accepts answers only while that gate is active (`apps/nanocore/src/turn-routes.ts:281-287`). `apps/nanocore/src/storage/schema/` has no Approval pending-request table. `ApprovalRequest` is an `FsStore` memory projection created by `createApproval` (`apps/nanocore/src/lib/store.ts:2620-2626`) and rebuilt from Items by `deriveApprovalStateFromItems` (`:4111-4189`). Because admission and lifecycle stay on the Turn, those two gates block the Turn, stay single-flight per Thread, and cannot expire on their own.

A new answer to an expired or unresolved approval gate today can surface as a looks-broken error rather than as a legitimate late arrival. Those demonstrated cases, verified by reading the current source rather than by an HTTP reproduction, include a leftover worker checkpoint that yields `The worker approval does not own the active Gate.` (`closeWorkerApprovalGate` at `apps/nanocore/src/approval-routes.ts:777-782`); a policy source with no durable winner and no exact active gate, including a terminal Turn whose `humanGate` is null, that yields `The policy approval Gate is not exact and active.` (`claimPolicyApprovalOutcome` at `:435-444`); and an MCP proposed-effect approval whose `expiresAt` is in the past, which fails `isExactMcpApprovalSourceDecision` (`apps/nanocore/src/policy/approval-gates.ts:237-240`, `MCP_APPROVAL_TTL_MS` at `:13`) and throws `The policy approval source tuple is not exact.` (`claimPolicyApprovalOutcome` at `apps/nanocore/src/approval-routes.ts:418`). Those `recovery_required` outcomes mean something broke and needs recovery. The user only answered late.

An exact replay of an already accepted answer is a different operation, and the current source already handles it. The `runIdempotentCommand` replay callback at `apps/nanocore/src/approval-routes.ts:216-244` reconstructs the policy approval projection. `claimPolicyApprovalOutcome` checks active-gate admission only when there is no durable winner (`:435-483`) and returns that winner when there is one (`:506`). `finishPolicyApprovalProjection` recognises an already-terminal Turn whose status, null `humanGate`, and `completedAt` match the winner (`:607-610`) and does not reopen it. A second request against the winner is a typed 409 `stale` (`:495-500`); a decision that disagrees with the winner is `IdempotencyKeyConflictError` (`:502-504`). These branches were verified by reading source, not by an HTTP reproduction.

`expired`, `superseded`, and `withdrawn` were declared long ago in the approval model and nothing in production writes them. `ApprovalStatusSchema` is `pending | granted | denied | expired | superseded | withdrawn` (`packages/protocol/src/models/approval.ts:14-21`). Core Approval Semantics lists the same six values (`docs/core/protocol.md:408-415`) and currently allows an implementation to support only a subset (`:433`). `RespondToApprovalRequestSchema` accepts only `granted | denied` (`packages/protocol/src/requests/approval.ts:14-19`). Production `createPolicyApprovalGate` writes `pending` or `granted` (`apps/nanocore/src/policy/approval-gates.ts:117-123`). The two production `updateApproval` sites write `input.decision`, which is that same `granted | denied` pair (`apps/nanocore/src/approval-routes.ts:592-594` and `:902-904`). `deriveApprovalStateFromItems` sets status to `decision?.decision ?? 'pending'`, and a terminal Turn with no decision Item is repaired as `denied` (`apps/nanocore/src/lib/store.ts:4153-4164` and `:4189`). Present expiry is a read-time check: MCP TTL is evaluated at respond time while the Approval row remains `pending` and the gate can remain on the Turn. The one durable write that records expiry as a stored reason is `markExpiredSchedulerLeasesStale`, which writes `status = 'stale'` and `release_reason` `'lease-expired'` or `'heartbeat-timeout'` (`apps/nanocore/src/scheduler-records.ts:1767-1798`).

## Inherited Constraints

This line must not overturn the following constraints already recorded on the work-data retention line.

Link-back uses the Item `id`. `seq` is a per-file counter from 1 used only for truncation detection; segmentation and export make it unusable as a cross-record pointer.

Link-back is an in-package reference. Import remints it through exact identity mapping. The reference may fail to resolve; it must never point at the wrong record.

A non-blocking gate must not change Turn status. The Turn terminalizes through its ordinary owner, and the request survives independently. Existing Turn waiter-settled predicates therefore do not need to change. Only a blocking gate uses `awaiting_human`.

This line must not add a ninth pending-request owner. The need for a pending-input list is real because the eight owners use eight primary keys and eight response entries. `buildHumanAttentionRows` already aggregates seven families of waiting work — approval, question, runtime, agent readiness, artifact review, workspace review, and knowledge review (`apps/nanocore/src/action-center.ts:115-155`). A new queue table would become a second source of truth for that question. What is missing is decoupling of admission and lifecycle for the two Turn-coupled gates, plus an extension of that existing Action Center projection under `docs/specs/20260531-human_attention_intervention_model.md`.

Configuration apply belongs on this line. It is a late response to an earlier proposal. Its marker Item belongs on the Turn that executes the apply, with link-back to the proposing Item, and must not be written back onto an already-terminal propose Turn.

Expiry evidence must carry request identity, failure reason, deciding actor, decision time, and a link back to the initiating Item. `StatusItemSchema` adds only `level`, `title`, and `summary` beyond `BaseItemSchema` (`packages/protocol/src/models/item.ts:52-62` and `:239-244`). A structured encoding of those expiry fields on a status Item is not proved available. Representation stays open on this line; that gap does not authorize a new retention container.

## Scope

In this line, once an owner admits a later specification: the blocking versus non-blocking split and who decides it; decoupling of admission and lifecycle for the two Turn-coupled gates so request identity can outlive Turn; write paths and judges for `expired`, `superseded`, and `withdrawn`; the expiry Item's required facts and unresolved representation; and an extension of the existing Action Center projection under its present owner.

This line is not the work-data retention format. Format, observation envelope, and in-package reference reminting belong to the accepted `docs/specs/20260921-work_data_retention_format.md`. This line does not block that sibling specification. Link-back as an ordinary in-package Item `id` reference and non-blocking gates that leave Turn predicates unchanged are applications of rules already recorded on the work-data line; they are not new format elements. An expiry Item is required evidence, not an optional ledger row, and it is not settled as an ordinary `status` Item.

This line does not create a pending-input queue as authority. The requirement for a pending-input list is real and is served by extending the existing Action Center projection.

## Decision

This Draft records the problem, the gathered evidence, the inherited constraints, and the confirmed blocking-expiry terminal. When a future expiry producer is admitted, a blocking gate that expires terminalizes the Turn as `cancelled`; the owning workflow may withdraw authorization when it determines the work is superseded; the reason is recorded on the expiry Item; no fifth terminal is added. That mapping is not a universal cancellation rule. Current worker-gate closeout keeps protocol-level `expired`, `withdrawn`, and `superseded` without an accepted producer and returns `recovery_required` rather than starting a timer (`docs/specs/20260531-worker_turn_reliability_envelope.md:269`). This Draft does not install that producer, does not change reload denial (`docs/core/protocol.md:404`), and does not choose the admitting owner. Owner admission, the exact producer, request lifecycle, and structured expiry representation remain open.

## Current Implementation Projection

Turn terminals in Core Turn Semantics are `completed`, `interrupted`, `cancelled`, and `failed` (`docs/core/protocol.md:191-196`). Non-terminal states include `pending`, `running`, and `awaiting_human` (`:198-202`). A terminal Turn is never reopened (`:214`). A Turn whose authorization is withdrawn before completion MAY terminate as `cancelled`; the withdrawing actor is the holder of that Turn's authorization, which includes the owning workflow when it determines the work is superseded, and the specific reason is recorded in an Item rather than encoded as another terminal status; which path produces which terminal is decided by the owning accepted specification, and multiple existing owners map authorized stops to `interrupted` with `stopReason=aborted` (`:206`). This Draft is not that owning accepted specification.

`awaiting_human` is the only Core Turn state for human-gated pauses (`docs/core/protocol.md:429`). Approval Semantics require `Turn.humanGate = { kind: "approval", approvalRequestId, itemId }` (`:400`). User Input Semantics require `{ kind: "user-input", userInputRequestId, itemId }` (`:427`). Action Center rows in the human-attention specification are projections over existing records (`docs/specs/20260531-human_attention_intervention_model.md:35-37`), and `buildHumanAttentionRows` already projects seven waiting families (`apps/nanocore/src/action-center.ts:115-155`).

## Open Questions

- `[Blocking]` Which owner admits the delayed-input expiry producer and the decoupling of Turn-coupled gate admission and lifecycle? Candidate owners named by the working session are `docs/core/protocol.md` for Turn lifecycle and human gate, and `docs/specs/20260531-human_attention_intervention_model.md` for approval and elicitation gates. This Draft does not choose between them.
- `[Blocking]` What is the exact expiry closeout producer, including who may judge expiry and how it joins current worker-gate proof? The working session deferred the admission and closeout producers and protected current worker-gate behaviour. This Draft does not invent that producer.
- `[Non-blocking]` How should expiry evidence be structured, given that `StatusItemSchema` (`packages/protocol/src/models/item.ts:239-244`) has no structured slots for request identity, deciding actor, or expiry reason beyond `level`, `title`, and `summary`? Text or a join to an existing owner may suffice; a new retention container is not authorized.

## Deferred / Future Work

Blocking versus non-blocking classification, decoupling of admission and lifecycle for `humanGate` plus Approval and for the user-input gate, write paths for `expired` / `superseded` / `withdrawn`, and the Action Center extension remain future work of this line after an engineer admits an owner and accepts a contract. They are out of this Draft's authority. They do not reopen the confirmed `cancelled` meaning for a future expiry producer.
