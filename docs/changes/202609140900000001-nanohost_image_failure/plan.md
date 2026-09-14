---
type: change-plan
status: verified
date: "2026-09-14"
completed: "2026-09-14"
---
# NanoHost Image Failure Isolation

## Intent Epoch 1

On 2026-09-14 the engineer requests issue #29 only: root-cause `AcquireImage` rejection followed by an `image.build` HTTP 409 and NanoHost exit after #28, add a failing regression where feasible, fix image acquisition or make failure soft, run focused checks, and open one PR to main with `Fixes #29` without merging. Deployment issues #21–#23 and wiping A2 data are excluded.

## Owners And Scope

The accepted attempt-local image failure boundary is owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`, especially Image Store acquisition and physical Epoch recovery. `docs/specs/20260616-agent_environment_package.md` owns immutable image selection. The primary owns the NanoCore backend cleanup correction, its regression, affected guides and this record. No design, durable schema, registry authority, deployment or transport rejection policy changes are planned.

## Checkpoint

The real backend/dispatcher regression reproduced `NanoHost accepted effect outcome is unknown; successor connection fenced.` with status 409 on the idle `image.build` poll after a typed acquisition failure and live cleanup. The regression was committed first as `19bff9a`. NanoHost correctly treats a rejected effect as attempt-local, but NanoCore incorrectly registered restart-only bridge/delete result expectations because no completed backend session existed. Those expectations caused the next poll to fence the healthy connection, whose rejection is terminal in NanoHost. No OpenShell build request is needed to reproduce this chain.

The correction retains only process-local evidence of completed image-preparation failures before storage or Sandbox effects. Live cleanup consumes it without creating physical cleanup expectations. A new materialization clears it; restart cannot reconstruct it. Existing unknown-effect, accepted-Sandbox, storage and restart fences remain unchanged. The repository Codex template uses tag-only `openkit/worker-codex:dev`, which the current immutable-reference validator rejects; A2's exact selected reference remains unconfirmed. No image substitution or deployment change is authorized by this correction.

## Closeout

Implementation and focused verification are complete. The primary inspected the actual final diff, including the restriction to completed image-preparation failures and clearing of that evidence before a new materialization. Publication is the engineer-authorized single PR to main; merge remains excluded. No live A2 execution or Docker/NanoHost process-level claim is made by these deterministic tests.

## Verification Evidence

- Red regression: `pnpm --filter @openkit/nanocore exec vitest run src/runtime/turn-executor-factory.test.ts -t 'keeps the ready connection usable'` failed at the post-cleanup `image.build` poll with status 409 before production changes.
- Focused suites: `pnpm --filter @openkit/nanocore exec vitest run src/runtime/turn-executor-factory.test.ts src/runtime/nanohost-session-dispatch.test.ts src/runtime/scheduler-restart-recovery.test.ts` passed all 100 tests across 3 files. After adding the stale-proof guard assertion, the factory suite passed all 50 tests again.
- `pnpm --filter @openkit/nanocore lint` passed: 639 files checked, no fixes. `pnpm --filter @openkit/nanocore typecheck` and `pnpm --filter @openkit/nanocore build` both exited 0.
- `node scripts/validate-doc-model.mjs` passed: 257 documents. `node scripts/generate-doc-index.mjs --check` reported the index current. `git diff --check` passed.
- Verification used existing pinned Node 24.18.0 and pnpm 10.33.3, frozen offline dependency installation and the six required dependency builds. Initial missing-dependency and missing-build collection failures were setup-only; an intermediate image-result scope error and incomplete build test lineage were corrected before all focused suites and TypeScript checks passed.
- The regression exercises the production NanoCore backend and dispatcher with a native HTTP/2 connection identity and a supplied NanoHost failure result. It proves the erroneous 409 fence is removed, not registry download, NanoHost process survival on A2, or successful live Task completion. A2 must be checked with its actual immutable worker image selection; mutable references remain rejected. No deployment, image publication, data deletion or merge was performed.
