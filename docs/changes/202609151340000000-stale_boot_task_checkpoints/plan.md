---
type: change-plan
status: implemented
branch: fix/89-stale-boot-task-checkpoints
---
# Stale Boot Task Checkpoints Without Scheduler Leases

## Intent Epoch 1

Source: GitHub issue #89. After deploying main `f009026`, A2 boot logs many `Checkpoint recovery_required` lines of the form `The boot Task checkpoint has no exact scheduler lease`. Those leftovers are failed Task checkpoints with a null worker session, usually a cancelled admission or `turn-start-failed` lease, and they keep scheduler boot degraded. New ws_7 Task Mode work then returns `scheduler_admission_deferred`.

Expected: boot classifies those terminal leftovers as complete and clears them without operators deleting rows. True recovery stays fail-closed: a preparing or running checkpoint, an interrupted Turn, or a live lease must still require inspection.

## Owners

`docs/specs/20260703-durable_scheduler_design.md` owns scheduler admission and restart fencing. Boot Task checkpoint classification in `apps/nanocore/src/mode-entry-routes.ts` implements that existing owner and is recorded in `apps/nanocore/README.md`. No new governing decision.

## Checkpoint

Implementation complete on `fix/89-stale-boot-task-checkpoints`.

## Summary

Clear terminal Task checkpoints that lack an exact scheduler lease when the product Turn is already closed and no live lease remains.

## Verification

- `vitest` nanocore `server.test.ts` classification cases passed (no-lease failed leftover, failed-lease session mismatch, preparing fail-closed, interrupted fail-closed, plus existing conversation-owned and direct Task receipt recovery).
- Biome check on the touched TypeScript files passed after format.
- NanoCore `tsc --noEmit` passed.
