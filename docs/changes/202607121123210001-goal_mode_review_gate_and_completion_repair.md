# Goal Mode Review Gate and Completion Repair

Type: change-plan
Status: completed
Date: 2026-07-12

## Intent

Restore the accepted Goal Mode invariant that one completed worker turn advances exactly one goal task, stops at an actionable human gate when review is required, and completes the goal only after every required task is accepted or skipped.

Remove the unused verification runner and closeout implementations without deleting the durable verification evidence model used by goal summaries, audit, and workspace portability.

## Scope

- Correct post-worker state transitions in the live `/goal/step` route.
- Make the default human review gate durable and executable through Goal Review and Action Center.
- Make `reviewPolicyOverride: "none"` skip only the step review gate rather than the remaining goal tasks.
- Make Goal Review resolution unlock dependent tasks or complete the goal from persisted task state.
- Remove the unused Goal task verification runner and unused closeout implementation.
- Keep verification evidence storage, projection, audit, export, import, and task verification-check metadata.
- Align App API schemas, MCP validation, generated OpenAPI, accepted design documents, and NanoCore documentation.

## Non-Goals

- Do not implement Task Evaluator, automatic review, review loops, dynamic planning, or multi-worker graphs.
- Do not add a host-side command execution path for verification.
- Do not redesign Goal Review into a new multi-verdict human-decision model.
- Do not make approved-plan review policies durable in this slice.
- Do not redesign `/goal/step` command idempotency in this slice.
- Do not extract or otherwise restructure `goal-routes.ts` while repairing its state transitions.
- Do not change artifact review, workspace synchronization review, Git approval, permission, or user-input gates.
- Do not add a replacement closeout, verifier, state-machine class, policy interface, or result wrapper.

## Related Context

- [Parent NanoCore Maintainability Recovery](202607111531450001-nanocore_maintainability_recovery.md)
- [Architecture](../core/architecture.md)
- [Work Model](../core/work-model.md)
- [Storage](../core/storage.md)
- [Agent Workflow](../core/agent-workflow.md)
- [Product Vision](../product-vision.md)
- [Goal Mode Coordination](../specs/20260704-goal_mode_coordination.md)
- [OpenKit AI Interface](../specs/superseded/20260617-openkit_ai_interface.md)
- [Human Attention and Intervention Model](../specs/20260531-human_attention_intervention_model.md)
- [Worker Turn Reliability Envelope](../specs/20260531-worker_turn_reliability_envelope.md)
- [Storage Layout and Record Ownership](../specs/20260703-storage_layout_record_ownership.md)
- [App API Boundary](../app-api.md)
- [NanoCore Guide](../../apps/nanocore/README.md)

## Impacted Surfaces

- `packages/app-api-schemas` Goal step request contract.
- `packages/core-client` and `@openkit/mcp` Goal step validation and examples where the narrowed contract is projected.
- NanoCore Goal step execution, Goal Review records, Action Center projection, Goal Review decisions, terminal summaries, and generated OpenAPI.
- Workspace Goal Review schema, migration, export, and import projection for the immutable resolution snapshot.
- Accepted Goal Mode, AI Interface, Human Attention, App API, and NanoCore documentation.

## Accepted Decisions

1. A completed worker turn is not sufficient evidence that the whole goal is complete. Goal completion is derived from the persisted task graph after the current task is accepted and eligible dependent tasks are unlocked.
2. An omitted `reviewPolicyOverride` and the explicit `human` value require human review. A completed step creates exactly one unresolved Goal Review record keyed by the worker turn and containing its item and artifact evidence before returning the goal and task in `reviewing`.
3. An unresolved default-accept Goal Review is projected into Action Center only while its goal and task are still reviewing. It exposes the existing executable `accept_review` action and does not leave a historical or already-applied attention row.
4. Resolving the accept review reuses `advanceGoalAfterReview(..., verdict: "accept")` to unlock dependencies, select the next task, or complete the goal when every task is completed or skipped.
5. `reviewPolicyOverride: "none"` creates no Goal Review record and immediately uses the same accept-and-advance path. The step response reports `continue` when another task remains and `complete` only when the persisted task graph is finished.
6. Goal Review decision responses and idempotent replays describe persisted reality as `complete_next_task`, `complete_goal`, or the applicable non-accept outcome rather than guessing that every accepted review means `continue`.
7. The unimplemented `auto` override is removed. The supported values are `human` and `none`, omission defaults to `human`, and automatic evaluation remains deferred.
8. Terminal summaries project stored verification evidence exactly. The absence of a taskless passing record is not treated as a missing final gate and does not create a fabricated final-verification risk.
9. Delete only `runtime/goal-task-verification.ts`, `runtime/goal-task-verification.test.ts`, `runtime/goal-closeout.ts`, and `runtime/goal-closeout.test.ts` in the dead-code slice.
10. Preserve `runtime/goal-verification-records.ts`, its tests, the verification table and schema, audit events, terminal-summary evidence projection, workspace export and import support, and task `verificationChecks` used as delegation input.
11. Goal Review creation and the task and goal transition to `reviewing` commit in one workspace SQLite transaction, and review advancement plus `resolvedAt` and `resolutionRequestId` commit in one workspace SQLite transaction. Any failure rolls the corresponding transition back completely.
12. The immutable `advance` result returned by the first successful Goal Review resolution is stored on the existing review record in the same workspace SQLite transaction. One nullable JSON column and its workspace migration are accepted because the cross-store command ledger can be absent after a crash and current goal and task state cannot reconstruct the original response after later progress; no new table, service, or general idempotency extension is introduced.

## Execution Plan

### Slice 1: App API Contract

- Add tests that accept omitted, `human`, and `none` review policy values and reject `auto` and arbitrary strings.
- Narrow the App API schema without a compatibility alias.
- Align Core client examples, MCP validation, and generated OpenAPI projections.

Exit criteria: every public projection exposes only the implemented review behaviors.

### Slice 2: No-Review Task-Graph Advancement

- Add a failing live-route test with two tasks where the second depends on the first.
- Prove that the first `none` step keeps the goal running, completes the first task, unlocks the dependent task, returns `continue`, and creates no Goal Review row.
- Prove that the second `none` step completes the goal only after the full task graph is terminal.
- Reuse the existing accept-and-advance path without adding a no-review helper.

Exit criteria: `none` skips one review checkpoint and cannot skip remaining tasks or other gate kinds.

### Slice 3: Actionable Human Review

- Add failing live-route tests for omitted and explicit `human` behavior.
- Persist exactly one unresolved default-accept Goal Review with the worker turn and evidence references.
- Commit review creation and the task and goal `reviewing` transition in one workspace SQLite transaction.
- Project an executable Action Center row only while the goal and task are reviewing.
- Reject another goal step while the unresolved review gate remains.

Exit criteria: no live path can write `reviewing` without an actionable durable review record.

### Slice 4: Review Resolution and Replay

- Add failing tests that accepting a review unlocks the next dependent task or completes the final goal.
- Commit task-graph advancement and review resolution metadata in one workspace SQLite transaction and prove injected write failures roll the full transition back.
- Persist the first `advance` response snapshot with the resolved review and replay that immutable snapshot after later tasks change current goal state.
- Remove the resolved Action Center row.
- Make the response outcome match persisted state and make an identical request replay the same response without another transition.

Exit criteria: resolution and replay report the same durable task-graph outcome.

### Slice 5: Verification Semantics and Dead Code

- Add route/read-model tests proving that task-scoped evidence projects normally and that completion does not invent a special final-verification gate.
- Reconfirm that the runner and closeout modules have no non-test caller.
- Delete the four dead implementation and isolated-test files while retaining evidence storage, audit, export, import, and projection coverage.

Exit criteria: no unused host command runner or impossible closeout gate remains, and all durable evidence behavior remains covered.

### Slice 6: Documentation and Closeout

- Update the Goal Mode implementation projection, AI Interface review-policy values, Human Attention implementation notes, App API boundary, NanoCore README, generated OpenAPI, and the parent maintainability checkpoint.
- Record commits, verification results, retained evidence coverage, and explicit follow-ups in this record.

Exit criteria: documents describe the implemented boundary without claiming an evaluator, automatic reviewer, or final verification gate.

## Verification Plan

- Run focused App API schema, Goal Mode route, Action Center, Goal Review decision, task advancement, verification-record, workspace export/import, MCP registry, Core client, and OpenAPI tests.
- Add or update one L3 black-box flow covering step, actionable review, resolution, next task, and final completion.
- Run the complete NanoCore, App API schema, Core client, and MCP package test suites.
- Run NanoCore typecheck, lint, build, and `openapi:check`.
- Run `CI=true pnpm run check:repo` from the repository root.
- Run `git diff --check` before every commit and final handoff.

## Expected Handoffs

1. Commit this change plan before behavior work.
2. Commit App API schema tests before narrowing the contract.
3. Commit failing NanoCore behavior tests before repairing state transitions.
4. Commit the NanoCore state-machine repair and Action Center projection.
5. Commit MCP, Core client, OpenAPI, and documentation alignment in package order.
6. Commit the dead runtime deletion after reachability and retained-evidence verification.
7. Close this record after focused, full, and repository verification.

## Cut List

- No `advanceGoalWithoutReview` helper.
- No new state-machine class, policy interface, review service, result wrapper, or database table.
- No storage expansion beyond one nullable Goal Review resolution-snapshot column and its required workspace migration.
- No automatic reviewer, fake verification result, or arbitrary host command execution.
- No Web-specific implementation unless the existing generic `accept_review` rendering proves insufficient.
- No compatibility alias for the removed `auto` value.

## Stop Rules

- Stop if any path can mark a goal completed while a required task remains pending, ready, running, reviewing, needs-revision, blocked, or failed.
- Stop if code can write `reviewing` without an unresolved actionable Goal Review record.
- Stop if a failure can persist a Goal Review without matching `reviewing` state, persist `reviewing` state without its review, advance a reviewed task while leaving the review unresolved, or resolve a review without its task-graph transition.
- Stop if Action Center exposes a review with no executable resolution action or exposes an already-applied stale review.
- Stop if `none` bypasses plan approval, permission, workspace review, Git approval, user-input, or any gate other than the current task review checkpoint.
- Stop deletion if either dead module gains a non-test caller.
- Stop if implementation requires deleting or weakening verification evidence storage, audit, export, import, or terminal projections.
- Stop and update the owning specification first if human review requires a new multi-verdict decision contract.
- Do not resurrect the deferred verification runner or Task Evaluator to finish this change.

## Known Risks and Follow-Ups

- Enabling accept-review projection can surface stale historical records unless projection is constrained by unresolved review and current reviewing state.
- Review identifiers based only on goal and task can collide after retry, so live review identity must include the worker turn.
- Reconstructed idempotent responses drift after later goal progress unless they use the immutable stored resolution snapshot.
- Approved plan review policy is not persisted with `GoalTask`; durable per-task policy ownership remains a separate follow-up.
- `/goal/step` request ids do not currently provide command-level idempotency; retry safety remains a separate follow-up.
- `remainingWorkerIterations` counts only currently ready tasks and must not be used as a goal-completion predicate.

## Closeout Requirements

Record final commits, focused and full verification results, generated OpenAPI status, deleted files, retained evidence-store coverage, and the remaining follow-ups for per-task review-policy persistence and `/goal/step` command idempotency.

## Checkpoints

### 2026-07-12: Immutable Goal Review Replay Boundary

- A delayed-replay regression proved that rebuilding an old Goal Review response from mutable goal and task state changes `complete_next_task` into `complete_goal` after later work completes and can misattribute a later current task to the old review.
- The existing FsStore command ledger stores only the review resource id and is intentionally outside the workspace SQLite transaction, so it cannot guarantee crash-safe immutable replay without a domain-owned snapshot.
- The accepted minimum is one nullable JSON snapshot on the existing Goal Review record, written with advance and resolution in the same transaction and included in existing export and import ownership. This replaces the original no-migration cut while preserving the no-new-table and no-general-framework constraints.

### 2026-07-12: Goal Review Progression and Verification Semantics Repaired

- Failing shared-contract coverage preceded removal of the unimplemented `auto` policy, so the App API exposes only `human | none`.
- Failing NanoCore coverage preceded the task-graph repair: human-reviewed steps now create one actionable review with matching reviewing state, `none` advances through the same accept path, and Goal Review acceptance unlocks dependencies or completes only a terminal task graph.
- Delayed-replay regressions preceded the accepted single-column immutable resolution snapshot with workspace migration, transaction ownership, public-response stripping, and export/import remapping.
- The repair removed the fabricated final-verification risk while preserving stored task evidence, then deleted the unused verification runner and closeout implementation with their isolated tests.
- The generated OpenAPI projection, canonical MCP Goal review schema and type, and full-suite storage migration inventory assertions were aligned before closeout.
- Full verification passed with 188 NanoCore test files and 1,384 tests, 7 skipped tests, all 54 App API schema tests, all 22 Core Client tests, and all 140 MCP tests. NanoCore, App API schemas, Core Client, and MCP typecheck, lint, and build gates passed; the committed OpenAPI generation, official-schema validation, and drift check passed; and the repository lifecycle, formatting, and models-catalog checks passed across 742 files.
- The Goal repair adds no evaluator, state-machine class, policy abstraction, service, wrapper, or table. Durable approved-plan review-policy ownership and command-level `/goal/step` idempotency remain explicit follow-ups.

## Implementation Summary

Goal Mode now stops completed human-reviewed steps at one durable actionable default-accept review, advances the persisted task graph atomically when that review is accepted, and uses the same advance path when the current review is explicitly skipped. First review resolution responses remain immutable across later progress, while terminal summaries project stored task evidence without inventing an evaluator or final-verifier gate.

## Final Verification

- NanoCore: 188 test files passed, 1 skipped; 1,384 tests passed, 7 skipped; typecheck, lint, build, and OpenAPI drift validation passed.
- App API schemas: 54 tests plus typecheck, lint, and build passed.
- Core Client: 22 tests plus typecheck, lint, and build passed.
- MCP: 140 tests plus typecheck, lint, and build passed.
- Repository: spec lifecycle, Biome across 742 files, and models-catalog validation passed.

## Remaining Follow-Ups

- Persist approved-plan review policy with the owning Goal task when that policy becomes an implemented planning contract.
- Add command-level `/goal/step` idempotency through the shared durability design rather than a route-local ledger.
