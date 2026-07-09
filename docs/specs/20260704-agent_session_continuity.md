# Agent Session Continuity

Status: Accepted
Implementation: Implemented

## Owns

- The durable record contracts for agent session continuity: `AgentSessionRecord` and `SessionSnapshotRecord`.
- The turn-assignment resume precedence: live session, resume handle, snapshot restore, fresh session.
- The v1 session compatibility matching rule: strict equality of the `SessionCompatibilityKey`.
- Snapshot content exclusion rules: no credentials, no provider instances, no knowledge.
- Rollback and fork lineage semantics: restore-into-new-session, never in-place mutation.
- The crash-recovery decision matrix binding scheduler lease terminal states to session outcomes.
- Snapshot expiry and garbage collection.

## Does Not Own

- Canonical `AgentSession` semantics, lifecycle states, warm-state rules, and invariants. `docs/core/agent-session.md` owns those; this spec realizes them as record contracts.
- Session lease mechanics, heartbeat deadlines, epoch fencing, and takeover. `docs/specs/20260703-durable_scheduler_design.md` owns those.
- The session-static workspace skeleton: `SessionWorkspaceLayout`, `WorkspaceSlot`, and the `SessionCompatibilityKey` definition. `docs/specs/20260704-session_static_workspace_materialization.md` owns those; this spec only fixes how the key is matched and persisted.
- Workspace change collection, staging, review, and apply. `docs/specs/20260703-workspace_synchronization.md` owns those; unimported sandbox state is never workspace truth.
- Backend-native snapshot mechanics (container commit, VM snapshot, provider session serialization), which stay behind runtime adapters.
- AEP resolution and manifest semantics (`docs/specs/20260703-agent_manifest_aep_resolution.md`).

## Core References

- `docs/core/agent-session.md`
- `docs/core/runtime-model.md`
- `docs/core/sandbox.md`
- `docs/core/audit.md`

## Summary

`docs/core/agent-session.md` defines snapshot, resume, fork, rollback, and crash recovery as canonical concepts, but no spec implements them: session records are partial, snapshot records do not exist, and the recovery relationship between lease loss and session outcome is undefined. This spec supplies the durable record contracts, a strict resume precedence with capability gating, the v1 compatibility decision (strict key equality), the exclusion rules that keep credentials and knowledge out of snapshots, restore-into-new-session rollback semantics with stable lineage, and a crash-recovery decision matrix bound to the durable scheduler's lease states.

The universal fallback — a fresh session from manifest resolution plus workspace materialization plus Core-owned thread history — MUST always work. Nothing in this spec may make that path second-class.

## Goals / Non-goals

### Goals

- Make session continuity recoverable and explainable from durable records alone.
- Fix one resume precedence so turn assignment is deterministic and testable.
- Decide the v1 compatibility matching rule so session reuse is deterministic.
- Guarantee snapshots never smuggle credentials, provider attachments, or knowledge across policy or time boundaries.
- Reserve fork/clone lineage now so records stay stable when the operations activate later.
- Bind crash recovery to lease terminal states so scheduler and session semantics compose without gaps.

### Non-goals

- Do not implement fork and clone operations in v1; only their record lineage is reserved.
- Do not define backend snapshot formats or transport.
- Do not add superset or partial compatibility matching in v1.
- Do not let snapshots become an alternative workspace-truth path around workspace synchronization.

## Background

The agent-session core doc fixes the model: sessions are runtime continuity, reuse requires a stable compatibility envelope, and snapshot/resume/fork/rollback must not copy secrets or knowledge implicitly. The session-static materialization spec defines the `SessionCompatibilityKey` and defers snapshot/fork/rollback explicitly. The durable scheduler spec defines leases that prevent untracked execution and takeover paths for worker loss and restart, but stops at the lease boundary: what happens to the session and the turn afterward is left to "workflow decision" without a defined option set. This spec closes those three gaps in one place because they are the same gap: continuity records, reuse decisions, and recovery decisions all read and write the same session state.

## Decision

- Agent session continuity is realized by two durable records, `AgentSessionRecord` and `SessionSnapshotRecord`, stored as SQLite source-of-truth operational records in the server scope, consistent with scheduler records.
- Snapshot and resume exist only for backends that declare a `session-snapshot` capability. The fresh-session fallback is universal and mandatory.
- Turn assignment follows a fixed resume precedence; every path passes a compatibility check; v1 compatibility is strict equality of the `SessionCompatibilityKey`.
- Snapshots exclude credentials, provider instances, and knowledge by contract. Restore re-derives attachments from current grants and policy.
- Rollback restores a snapshot into a new agent session; sessions are never mutated in place. Fork/clone records are reserved but the operations are deferred.
- Crash recovery is a decision matrix over lease terminal states with a closed option set; the item log stays coherent in every branch.

## Contract / Expected Behavior

### Durable records

Both records are SQLite source-of-truth operational coordination records in the server-scope database, keyed to product lineage ids, with no secret material and no raw backend-native identifiers. Product surfaces read them through derived read models only.

`AgentSessionRecord` MUST carry:

- agent session id (UUIDv7)
- workspace id; thread id when thread-affine
- agent id, agent profile reference, AEP snapshot id
- runtime backend kind and redacted target summary
- projected `AgentSessionStatus` (the 10-state set owned by `docs/core/agent-session.md`)
- `SessionCompatibilityKey` (as defined by the session-static spec)
- backend capability summary, including whether `session-snapshot` is declared
- created-at, last-activity-at, closed-at timestamps and close reason
- reusability flag (false once the session is stale, replaced, or closed)
- replacement lineage: `replaces` and `replacedBy` session ids when applicable
- restore lineage: `restoredFrom` snapshot id when the session was created by restore
- reserved fork lineage: `forkOf` session id (unset until fork activates)

`SessionSnapshotRecord` MUST carry:

- snapshot id (UUIDv7)
- agent session id and full lineage (workspace, thread when applicable, turn that triggered the snapshot, AEP snapshot id)
- snapshot kind: `runtime-handle` | `backend-snapshot` | `serialized-state`
- redacted backend handle reference (a reference for the adapter, never a raw backend id exposed to product surfaces)
- `SessionCompatibilityKey` at snapshot time
- content digest when the backend provides one
- created-at and expiry timestamps
- status: `available`, `expired`, `invalidated`, `consumed-by-restore` history marker (restore does not consume exclusively; a snapshot MAY be restored more than once until expiry)

Records are immutable in their identity and lineage fields; status and timestamps advance forward only.

### Capability gating and the universal fallback

- Snapshot creation and snapshot restore MUST be offered only for agent sessions whose backend declares the `session-snapshot` capability. Resume-from-runtime-handle requires the backend's resume capability declaration.
- The universal fallback MUST always work: create a fresh agent session from manifest resolution (AEP), workspace materialization (session-static + sync specs), and Core-owned thread history. No feature of this spec may become a prerequisite for executing a turn.
- A backend without `session-snapshot` simply never produces `SessionSnapshotRecord` rows; nothing else changes.

### Resume precedence at turn assignment

When a turn needs an executor, selection proceeds in this order, taking the first path whose conditions hold:

1. Live compatible session: an existing session in a reusable live state (`ready`, `idle`) in the same workspace whose compatibility check passes and whose thread-affinity rules allow the turn.
2. Resume from runtime handle: a suspended or serialized session with a valid resume handle, compatibility check passing.
3. Restore from snapshot: an `available`, unexpired `SessionSnapshotRecord` whose compatibility check passes, restored into a new session.
4. Fresh session: the universal fallback.

Rules:

- Every path MUST pass the compatibility check; there is no bypass for "the session looks close enough".
- V1 compatibility is STRICT EQUALITY of the `SessionCompatibilityKey`. Superset-compatible reuse (an existing session whose envelope is a superset of the turn's needs) is explicitly deferred; this is the resolution of the compatibility-matching question raised in `docs/specs/20260704-session_static_workspace_materialization.md`, decided here because determinism and least-surprise win for v1 while reuse economics are still unmeasured.
- Reuse MUST also honor every invariant in `docs/core/agent-session.md`: no bypass of manifest resolution, AEP compatibility, workspace synchronization, vault, permission, sandbox, audit, or required-feature checks.
- The selected path and the rejected candidates (with typed reasons) MUST be recorded on the turn's execution metadata so session selection is explainable in audit.

### Snapshot exclusion rules

- A snapshot MUST NOT capture injected credentials, provider instances, placeholder environment values, vault material, or delegated refresh material as restorable state. Backend snapshot mechanisms that inherently capture process environment MUST be paired with restore-time invalidation: restored sessions get their provider attachments re-derived from CURRENT `VaultGrant` rows and `PermissionDecision` rows through the derivation flow in `docs/specs/20260703-openshell_mechanism_internalization.md`. Stale attachments captured inside a backend image MUST be detached or invalidated before the restored session accepts a turn; if the backend cannot guarantee that, it MUST NOT declare `session-snapshot`.
- A snapshot restored under changed policy receives current-policy attachments or fails closed with a typed diagnostic. Restore MUST NOT resurrect access that current policy denies.
- Snapshots MUST NOT capture knowledge or count as knowledge (`docs/core/agent-session.md` invariant). A restored session re-requests context through governed knowledge and context-package paths.
- Unimported sandbox workspace contents inside a snapshot remain non-truth: workspace state advances only through the workspace synchronization contract, and a restored session's slot contents are warm state, not canonical workspace state.

### Rollback, fork, and clone

- Rollback MUST be implemented as: restore a chosen snapshot into a NEW agent session (`restoredFrom` set), close the old session with reason `rolled-back` and `replacedBy` pointing at the new session. In-place mutation of a live session to an earlier state is prohibited.
- The item log is never rewritten by rollback; rollback is runtime-state selection, and product history keeps recording forward per the core doc's coherence invariant.
- Fork and clone are deferred operations in v1. The record contract reserves `forkOf` lineage and forks would use the same restore mechanics into new sessions; activation requires a future workflow need plus backend capability, recorded under Deferred / Future Work. Reserving lineage now keeps future forks from needing a record migration.

### Crash-recovery decision matrix

This matrix binds the durable scheduler's lease outcomes to session and turn handling. The scheduler owns lease semantics; this spec owns what happens to the session and the closed option set offered to the workflow layer.

| Lease outcome | Session transition | Options (workflow- or human-decided) |
| --- | --- | --- |
| `failed` with reason `startup-timeout` | session `failed`, not reusable | retry on fresh session (default); mark turn failed |
| `stale` then `lost` (no evidence path) | session `failed`, not reusable | retry on fresh session; restore from snapshot when eligible; mark turn failed; ask human |
| `stale` then `released` (evidence collected) | session `interrupted`, not reusable | retry on replacement session (default for infrastructure failure); restore from snapshot when eligible; mark turn failed; ask human |
| `released` normal at step end | session `idle` or `closed` per reuse policy | n/a |
| scheduler-restart pre-launch `failed` | session record closed `never-started` | automatic requeue per scheduler spec |

Rules:

- Snapshot-restore is eligible as a recovery option only when an `available` snapshot exists that is NEWER than the last completed bounded step's evidence and whose compatibility check passes; recovery MUST NOT restore a snapshot that would silently discard evidence-backed progress.
- Default selection: infrastructure failures (backend died, target quarantined) default to retry-on-replacement-session; content failures (worker error outcome) default to workflow/human decision through the existing Action Center paths. The default is a policy-visible choice, not hardcoded behavior.
- Every branch MUST leave the item log coherent: partial items and artifacts collected as evidence remain history, and the replacement session reads thread history through Core records, never through inherited hidden runtime state.
- Session replacement records `replaces`/`replacedBy` lineage in both records.

### Expiry and garbage collection

- Every snapshot carries an expiry (default: 7 days, configurable per workspace policy). Expired snapshots move to `expired`, their backend handles are released through the adapter, and an audit event records the deletion.
- Snapshots are invalidated (status `invalidated`, backend handle released) when: their AEP snapshot is superseded and safe refresh is unsupported, their compatibility key can no longer be produced by any current manifest, or the owning workspace is deleted (closure export rules belong to the audit spec).
- Closed sessions are retained as records (they are lineage, cheap rows) but their warm state and backend resources MUST be released at close.

## Accepted Design

Session records extend the existing agent-session storage foundations in `apps/nanocore`; snapshot records are a new table beside them. The resume-precedence selector lives in the scheduler's dispatch path: when a placement plan is created, the selector evaluates paths 1–3 against durable records before falling through to fresh-session launch, and stamps the chosen path on the plan. Restore and resume are runtime-adapter operations invoked under an acquired lease, mirroring launch. The recovery matrix is implemented where the scheduler's lease-watch loop hands terminal leases to the workflow layer: the handoff carries the closed option set and the computed defaults.

## Current Implementation Projection

Agent session storage foundations exist (session rows and checkpoint rows referenced by `docs/specs/20260531-worker_turn_reliability_envelope.md` and the worker governance executor). `apps/nanocore/src/lib/store.ts` now persists app-local `policySnapshotId` and `sessionCompatibilityKey` extensions on agent sessions, deriving the compatibility key from the resolved Agent Environment Package session workspace projection when available. `apps/nanocore/src/runtime/worker-governance-turn-executor.ts` binds governed worker sessions to the first worker-launch policy snapshot id used by the matching durable `runtime.launch` permission decision, and both the host-adapter and governed-worker paths now leave the strict session workspace digest on the stored session record for selector and diagnostics work. `scheduler_session_leases` also persists the same nullable `session_compatibility_key` evidence on newly acquired leases, so lease/session/package lineage can be compared from durable scheduler records instead of reconstructing the key from transient runtime state. `apps/nanocore/drizzle/0051_session_snapshots.sql`, `apps/nanocore/src/storage/schema/session-snapshots.ts`, and `apps/nanocore/src/agent-session-continuity.ts` now implement the V1 `SessionSnapshotRecord` storage contract, compatible snapshot listing, strict resume-precedence selector over live session, resume handle, snapshot restore, and fresh session candidates, and the lease-outcome recovery option matrix. `apps/nanocore/src/runtime/scheduler-dispatch-loop.ts` uses the strict V1 selector when dispatch callers provide continuity candidates and falls back to fresh-session launch when no candidate is valid. Runtime adapter snapshot creation/restore is still capability-gated and inactive until a backend declares `session-snapshot`; fork/clone activation, superset-compatible reuse, snapshot cadence policy, and richer recovery automation remain deferred future work.

## Alternatives Considered

- In-place rollback (mutate the live session to an earlier state). Rejected: it destroys lineage, breaks audit explainability, and violates the core doc's replacement-preserves-history posture.
- Snapshots as workspace-truth shortcuts (restore instead of re-materializing workspace state). Rejected: workspace truth advances only through workspace synchronization; snapshots are runtime warm state.
- Superset compatibility matching in v1. Rejected for now: it improves reuse rates but makes reuse decisions harder to explain and test before any reuse economics are measured; strict equality is deterministic and can be relaxed later without record changes.
- Workspace-scope storage for session records. Rejected: sessions are scheduler-adjacent operational coordination state spanning the same transactional domain as leases; workspace-visible session history is served by derived read models, mirroring the admission-queue decision in the scheduler spec.

## Consequences

- Session reuse, resume, and recovery become explainable from durable records; restart stops erasing continuity knowledge.
- Strict-equality matching will under-reuse sessions in v1; that is an accepted cost, and measurement of rejected-candidate reasons (recorded at selection) provides the data for a future superset design.
- Backends face a real bar for declaring `session-snapshot`: credential-exclusion or restore-time invalidation must be guaranteed.
- The scheduler's lease handoff gains a defined consumer, closing the "workflow decides, somehow" gap.

## Rollout / Migration Plan

New machinery, no compatibility path. Order: (1) `AgentSessionRecord` extensions and compatibility-key persistence, replacing per-turn implicit sessions in the same change; (2) resume precedence path 1 (live reuse) wired into dispatch; (3) recovery matrix at the lease-terminal handoff; (4) `SessionSnapshotRecord`, snapshot creation/restore for the first backend that declares the capability; (5) expiry/GC loops. Fork/clone stay reserved.

## Testing Strategy / Acceptance Criteria

Mapped to `docs/specs/20260529-test_strategy.md`:

- L1: unit tests for the resume-precedence selector (each path's conditions, strict-equality rejection cases, recorded rejection reasons), recovery matrix option computation per lease outcome, snapshot eligibility (newer-than-evidence rule), expiry math, lineage integrity (replaces/replacedBy symmetry).
- L2: contract tests binding to the scheduler spec: selection happens only inside plan creation; restore/resume only under an `acquired` lease; token binding follows the lease, not the session. Contract tests for exclusion rules: a restored session's attachments derive from current grants (fixture policy change between snapshot and restore must change or deny attachments).
- L3: NanoCore black-box tests: live-reuse across two turns with identical keys; key-mismatch forces fresh session with recorded reason; kill backend mid-turn, observe stale-lease path, session `interrupted`, retry on replacement with coherent item log; restore-from-snapshot recovery when snapshot is newer than last step evidence and refusal when older; restart recovery re-adopts live sessions and closes pre-launch ones; expired snapshot cannot be restored.
- L5: smoke: packaged build executes two consecutive turns on one reused session on the localhost baseline.
- L6: story acceptance: a long task survives a NanoCore restart mid-step, the user sees the interruption, chooses retry, and the thread history remains complete and coherent.

Acceptance: fallback path never regresses; no test can restore credentials or stale policy attachments from a snapshot; every recovery branch leaves item-log coherence intact; session selection is fully explainable from recorded reasons.

## Risks & Mitigations

- Risk: strict equality causes near-zero reuse and constant relaunch cost. Mitigation: rejection reasons are recorded and measurable; relaxation to superset matching is a selector change, not a record migration.
- Risk: backend snapshot mechanisms capture secrets despite the contract. Mitigation: capability declaration requires the invalidation guarantee; L2/L3 tests plant canary credentials before snapshot and assert absence after restore.
- Risk: snapshot GC races an in-flight restore. Mitigation: restore takes a short-lived reference on the snapshot record inside the lease transaction; GC skips referenced snapshots.
- Risk: the recovery matrix drifts into a second workflow engine. Mitigation: the matrix computes options and defaults only; the decision stays with the workflow layer and Action Center.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: snapshots are explicit-only and are requested by workflow, recovery, or operator action rather than automatically at every bounded-step boundary; `AgentSessionStatus` includes a distinct `restoring` projected state so product surfaces and recovery logic can distinguish restore work from first-time initialization.

## Deferred / Future Work

- Fork and clone activation: parallel attempts, review branches, reproducible debugging, gated on workflow need and backend capability.
- Superset-compatible session reuse once rejected-candidate data justifies it.
- Cross-session warm cache reuse (deferred by the session-static spec).
- Snapshot cadence policy and snapshot cost budgeting.

## Links

- `docs/core/agent-session.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`
- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260703-openshell_mechanism_internalization.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260529-test_strategy.md`
