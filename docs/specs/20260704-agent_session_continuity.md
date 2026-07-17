# Agent Session Continuity

Status: Accepted
Implementation: Partial

## Owns

- The current durable Agent Session identity and its relationship to one worker Turn and scheduler lease.
- Exact same-worker continuity during the bounded NanoCore-restart reconnect window.
- The fresh-session fallback after interruption or incompatible runtime supply.
- The boundary that keeps runtime continuity from becoming hidden product history, knowledge, credential state, or an availability promise.

## Does Not Own

- Canonical Agent Session meaning and lifecycle vocabulary, which belong to `docs/core/agent-session.md`.
- Lease timing, process-key adoption, worker-control sequencing, or disposable-Cell cleanup.
- Workspace change collection, review, apply, or canonical product history.
- Snapshot stores, generic resume precedence, warm-session selection, rollback, fork, clone, automatic replacement, or recovery-option workflows. These are deferred and non-authorizing.

## Core References

- `docs/core/agent-session.md`
- `docs/core/runtime-model.md`
- `docs/core/work-model.md`
- `docs/core/sandbox.md`

## Summary

V1 continuity is intentionally narrow. NanoCore may preserve the exact original worker, Agent Session, Turn, and lease across one bounded Core restart when the worker proves its memory-only process key, durable lineage, exact next sequence, and unexpired reconnect deadline. This is reconnect, not replacement or replay.

If exact continuity cannot be proved, the old Agent Session becomes non-reusable, the prior Turn and evidence remain visible, and the owning workflow exposes interruption or `recovery_required`. A later retry uses a fresh authorized Agent Session and a new Turn or request as required by its owning mode. Automatic replacement, snapshot restore, or transparent continuation is not a V1 requirement.

## Goals / Non-goals

Goals:

- Keep Agent Session continuity distinct from Thread and Item history.
- Preserve the exact same worker after NanoCore restart when proof succeeds.
- Prevent a compatible but different worker from impersonating continuity.
- Preserve prior work and use a fresh authorized session when continuity fails.
- Keep credentials, Knowledge, and unimported sandbox state out of continuity authority.

Non-goals:

- Do not optimize warm-session reuse.
- Do not implement a general snapshot, restore, rollback, fork, or clone system.
- Do not automatically retry interrupted work on a replacement session.
- Do not promise that restart is invisible to the user.
- Do not add a continuity registry, recovery matrix, Action Center workflow, runner, or harness.

## Decision

`AgentSessionRecord` is the durable Core-side identity for runtime continuity. It must preserve the Workspace, Thread when applicable, Turn assignment, Agent, profile or AEP snapshot, runtime backend kind, current status, creation and close timestamps, and replacement or interruption reason needed to explain which runtime executed the work.

The baseline has two permitted continuity outcomes:

1. Exact reconnect: the existing scheduler lease is inside its bounded reconnect window and the original worker proves the exact process key, product and package lineage, next sequence, and lease compare-and-set. The same Agent Session and Turn continue.
2. Fresh fallback: exact reconnect cannot be proved or completes unsuccessfully. The old Session and Turn remain interrupted or terminal; any later work starts from current manifest resolution, current policy and credentials, current Workspace materialization, and Core-owned Thread history.

There is no third outcome that silently substitutes a compatible worker for the original attempt.

## Exact Reconnect Contract

- `awaiting-reconnect` is scheduler lease state, not a new Agent Session lifecycle or selection mode.
- NanoCore restart alone MUST NOT mark a reconnect-eligible worker complete, failed, or replaced.
- Successful adoption MUST preserve the same Agent Session id, Turn id, lease id, package snapshot, worker process, checkpoint, and accepted worker sequence.
- A wrong process key, lineage mismatch, stale or conflicting sequence, expired deadline, missing post-launch proof, or lost lease claim MUST reject adoption.
- Rejected adoption MUST NOT create a replacement Session while the reconnect window remains owned by the original lease.
- After deadline-owned cleanup, the Session becomes non-reusable and the prior Turn preserves interruption or `recovery_required` under its existing owners.

## Fresh-Session Fallback

A fresh Agent Session is always allowed for a separately authorized attempt when current manifest resolution, policy, Vault grants, sandbox requirements, AEP compatibility, Workspace materialization, and scheduler admission succeed.

The fresh Session reads prior context from Core-owned Thread, Item, Artifact, Knowledge, and evidence records. It does not inherit unimported sandbox files, worker-private caches, native provider sessions, raw resume handles, or hidden runtime state.

The fallback preserves the original attempt. It MUST NOT rewrite an interrupted Turn, claim that an uncertain external effect did not happen, or reuse the previous request identity to repeat a side effect.

## Snapshot And Warm-State Boundary

Snapshots, runtime handles, serialized state, live reuse, rollback, fork, and clone remain optional capability directions in `docs/core/agent-session.md`. They are not current V1 implementation or acceptance requirements.

Any future activation requires a present backend and workflow need plus an accepted specification that defines credential invalidation, current-policy reattachment, Workspace truth, lineage, failure, cleanup, and user-visible behavior. A future concept does not justify a current `SessionSnapshotRecord`, generic selector, restore workflow, migration, runner, harness, or test matrix.

Existing inactive snapshot or compatibility helpers are Private implementation projections and may be removed without compatibility obligations if no current backend consumes them.

## Current Implementation Projection

NanoCore persists Agent Session identity, policy and compatibility evidence, scheduler lease lineage, worker checkpoints, and the bounded `awaiting-reconnect` path. The active restart implementation uses the worker's memory-only process key hash plus exact lineage and sequence to continue the same Session and Turn or falls through to existing cleanup and interruption.

The repository also contains broader snapshot, compatibility, and recovery-option helpers that no current backend activates as a supported product path. They do not expand this accepted contract and are candidates for later deletion review. Implementation remains Partial until boot recovery and the exact reconnect-or-interrupt path are verified through existing runners.

## Testing Strategy / Acceptance Criteria

- L1 covers exact reconnect eligibility, wrong-key and lineage rejection, exact-next sequence, deadline ownership, same-Session continuation, and fresh-session isolation from credentials and hidden runtime state.
- L2 covers the scheduler and worker-control boundary that authorizes adoption.
- L3 retains one deterministic NanoCore kill/restart scenario that proves exact adoption of the same worker or the documented interrupted fallback after cleanup, with no replacement or duplicate launch.
- A higher-layer real worker check reuses the existing local or A1 acceptance path only when it proves transport integration unavailable at L1-L3.
- No current tests are required for snapshot creation, restore precedence, rollback, fork, clone, warm reuse, superset compatibility, or an exhaustive recovery matrix.

Acceptance requires exact or rejected reconnect, preserved prior history, no secret or unimported Workspace state inheritance, no automatic duplicate attempt, and a working fresh-session path for a new authorized request.

## Consequences

- NanoCore can preserve valuable remote work across a brief restart without promising transparent availability.
- Failure to reconnect is visible and may require a new request; this is an accepted bounded compromise.
- Session continuity remains small enough that it cannot become a second workflow engine.

## Deferred / Future Work

- Live session reuse after measured launch-cost evidence.
- Snapshot and restore for a backend that can prove credential invalidation and Workspace isolation.
- Rollback, fork, or clone for a concrete workflow that needs them.

Deferred work is non-authorizing and creates no current schema, state, implementation, migration, runner, harness, or test requirement.

## Links

- `docs/core/agent-session.md`
- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
