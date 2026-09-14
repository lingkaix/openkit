---
type: change-plan
status: active
---
# Thread Visibility Cutover Migration

## Intent Epoch 1

Source: engineer request to unblock A2 deploy after PR #55. Add a stopped-process operator migrator and ops runbook so predecessor Threads missing `openkit.thread-visibility.v1` can be explicitly classified without changing fail-closed startup cutover. Prefer workspace as the only supported ambiguous default for reviewed dogfood history. Do not destroy Thread payloads. Deploy remains blocked until A2 classification succeeds.

## Owners

- `docs/specs/20260909-thread_visibility_and_sharing.md`
- `skills/openkit-ops/references/nanocore-operations.en.md`
- `apps/nanocore/src/storage/workspace-file-records.ts`

## Checkpoint

Implement `thread-visibility:migrate`, tests, and the ops section. Keep NanoCore restart cutover fail-closed for unclassified ambiguous history.
