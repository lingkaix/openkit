---
type: change-plan
status: implemented
branch: fix/71-approval-respond-leases
---
# Approval Respond With Scheduler Leases

## Intent Epoch 1

Source: GitHub issue #71. `approval.respond` for policy `repo.push` Gates on Turns that still hold `scheduler_session_leases` returned `recovery_required`, forcing operators to delete leases by hand. Fix so CLI and Web can grant or deny without lease deletion, while keeping fail-closed behavior for true worker Gate recovery cases such as `tool.use` without a worker checkpoint.

## Owners

`docs/specs/20260531-human_attention_intervention_model.md` owns Action Center approval respond. `docs/specs/20260704-git_write_workflow.md` owns policy `repo.push` Gates. Scheduler lease ownership remains with the worker runtime owners; policy-local closeout may fence a Turn-bound lease when formal placement completion is unavailable because no worker Gate checkpoint exists.

## Checkpoint

Implementation complete on `fix/71-approval-respond-leases`. Policy-local `repo.push` respond finishes the Approval projection when a lease is present without a worker checkpoint, then releases or fences that exact lease. `tool.use` without an exact worker Gate checkpoint remains `recovery_required`.

## Summary

Allow policy `repo.push` `approval.respond` on leased Turns without requiring operators to delete `scheduler_session_leases`.

## Verification

- `pnpm --filter @openkit/nanocore exec vitest run src/approval-routes.test.ts`: 11 passed, including leased `repo.push` success and leased `tool.use` fail-closed regressions.
