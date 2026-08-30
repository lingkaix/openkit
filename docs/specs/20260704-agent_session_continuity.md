---
status: Accepted
implementation: Partial
updated: 2026-08-21
---
# AgentSession Continuity

## Owns

- The current durable AgentSession identity, one-current-per-Thread selection, historical replacement lineage, and relationship to one worker Turn and scheduler lease.
- Exact same-worker continuity during the bounded NanoCore-restart reconnect window.
- Exact compatible idle AgentSession reuse by later Turns in the same Thread, fresh Turn authority on every reuse, and internal successor replacement when reuse is forbidden.
- The fresh-session fallback after interruption or incompatible runtime supply.
- The boundary that keeps runtime continuity from becoming hidden product history, knowledge, credential state, or an availability promise.

## Does Not Own

- Canonical AgentSession meaning, product boundary, and lifecycle vocabulary, which belong to `docs/core/agent-session.md`.
- Lease timing, process-key adoption, worker-control sequencing, NanoHost transport replacement, sandbox cleanup, or Runtime Epoch invalidation.
- Workspace change collection, review, apply, or canonical product history.
- Snapshot stores, generic resume precedence, rollback, fork, clone, automatic retry, or recovery-option workflows. These are deferred and non-authorizing.

## Core References

- `docs/core/agent-session.md`
- `docs/core/runtime-model.md`
- `docs/core/work-model.md`
- `docs/core/sandbox.md`

## Summary

V1 continuity has two distinct paths. NanoCore may preserve the exact original worker, AgentSession, Turn, and lease across one bounded Core restart when the worker proves its memory-only process key, durable lineage, exact next sequence, and unexpired reconnect deadline. This is reconnect of the same active attempt, not replacement or replay.

After a Turn settles, a later Turn in the same Thread reuses the exact compatible idle current AgentSession when compatibility and hygiene are proved. Reuse preserves conversation continuity but supplies no carried authority: the later Turn receives fresh admission, AEP snapshot, Context Package, route credentials, lease, deadline, sequence scope, Workspace input snapshot, and current policy and Vault decisions. When reuse is forbidden, NanoCore first retires and runtime-fences the predecessor, then atomically creates the sole current successor for the same Thread. Ordinary product surfaces still show only the same Thread and its Turn outcome; AgentSession identity and replacement are restricted to authorized operator diagnostics.

Native continuity is process-independent. One shared Harness may supervise one independent native Agent instance per resident AgentSession, and a later Turn may either reuse that instance or start another instance that resumes the exact restricted native conversation handle. The same OS process is neither required nor sufficient; exact handle, session-local state, compatibility, hygiene, lineage, and current authority are required.

If exact continuity cannot be proved, the old AgentSession becomes non-reusable, the prior Turn and evidence remain visible, and the owning workflow exposes interruption, unknown outcome, or `recovery_required`. A later retry uses a fresh authorized AgentSession and a new Turn or request as required by its owning mode. Automatic retry of the interrupted attempt, snapshot restore, or transparent continuation is not a V1 requirement.

NanoCore restart, upgrade, or short network loss does not invalidate a healthy Runtime Epoch and does not recreate a Sandbox. The NanoHost, Sandbox Integration, and already-authorized worker continue locally. Continuity resumes only after one successor NanoHost transport session fences its predecessor and the exact same AgentSession, lease, backend session, package snapshot, process key, and next worker sequence are proven.

## Goals / Non-goals

Goals:

- Keep AgentSession continuity distinct from Thread and Item history and hidden from ordinary user navigation and action.
- Preserve the exact same worker after NanoCore restart when proof succeeds.
- Prevent a compatible but different worker from impersonating continuity.
- Preserve prior work and use a fresh authorized session when continuity fails.
- Reuse one exact compatible idle AgentSession for sequential Turns in its one lifetime Thread.
- Keep replacement identity and reason available to authorized operator diagnostics without exposing AgentSession to ordinary users.
- Keep credentials, Knowledge, and unimported sandbox state out of continuity authority.

Non-goals:

- Do not implement a general snapshot, restore, rollback, fork, or clone system.
- Do not automatically retry interrupted work on a replacement session.
- Do not promise that restart is invisible to the user.
- Do not add a continuity registry, recovery matrix, Action Center workflow, runner, or harness.

## Decision

`AgentSessionRecord` is the durable Core-side identity for runtime continuity. It must preserve the Workspace, Thread, Turn assignment when present, Agent, profile or AEP snapshot, runtime backend kind, current status, creation and close timestamps, and replacement or interruption reason needed for authorized diagnosis.

An AgentSession belongs to exactly one Thread for its whole life. A Thread has zero or more historical AgentSessions and at most one current AgentSession. The protocol's non-terminal statuses identify current continuity; `interrupted`, `failed`, and `closed` are terminal historical states and cannot be reopened. A later Turn in another Thread never reuses it, even when Workspace, Agent, profile, Sandbox, Harness, or native runtime family match.

The baseline has three permitted continuity outcomes:

1. Exact reconnect: the existing scheduler lease is inside its bounded reconnect window and the original worker proves the exact process key, product and package lineage, next sequence, and lease compare-and-set. The same AgentSession and Turn continue.
2. Later-Turn reuse: the prior Turn is terminal, the exact Thread-affine AgentSession is idle, its compatibility evidence is current, and every hygiene check succeeds. The same AgentSession receives a newly admitted Turn with fresh authority and current inputs.
3. Internal successor replacement: exact reconnect or later-Turn reuse is forbidden or unprovable. The predecessor and prior Turn remain unchanged, the predecessor becomes terminal and runtime-fenced, and separately authorized later work uses the sole current successor created from current manifest resolution, policy, credentials, Workspace materialization, and Core-owned Thread history.

There is no fourth outcome that silently substitutes a compatible worker for the original attempt.

An adapter whose native protocol creates a conversation only with the first prompt MAY open one capacity-holding AgentSession runtime binding with its native handle pending. The first accepted Turn must establish the exact handle and bind its digest before the AgentSession may return to reusable `idle`; failure, ambiguity, or cleanup uncertainty closes or fences that binding and never substitutes Core history for native continuity. A later Turn may launch a fresh native process against the retained exact handle and session-local state, but it receives fresh Turn authority and must prove the same conversation again before completion.

## Later-Turn Reuse And Successor Replacement

`SandboxCompatibilityKey` decides whether placement may use one shared Sandbox envelope; it neither decides conversation continuity nor permits an existing AgentSession to move between runtime bindings. `HarnessCompatibilityKey` selects one compatible Harness Instance inside that Sandbox and includes the runtime adapter, runtime image and command shape, process-global extensions, hooks, plugin and MCP posture, and process-static credential and configuration requirements. `AgentSessionCompatibilityKey` decides whether a later Turn may reuse the exact existing native conversation continuity in that exact Harness binding. For V1, the AgentSession key must match exactly and includes Agent and profile identity, Thread affinity, native conversation protocol, context and transcript posture, static policy envelope, logical-model admission posture, required features, the selected Harness key, and the exact `SessionCompatibilityKey` owned by the session-static materialization specification.

Compatibility evidence is immutable for one effective setup. Every later-Turn admission recomputes desired inputs from current owners and rejects reuse when the key is missing, stale, conflicting, unequal, revoked, or unsupported. Ordinary Turn input revisions do not invalidate compatibility when the current inputs fit the declared slots and the freshness barrier can reconcile them safely. A changed static path, process environment, OS user, logical-model admission posture, network envelope, credential visibility class, required Harness feature, Agent or profile identity, Thread, or incompatible setup generation requires replacement.

Reuse also requires all of these hygiene checks:

- The AgentSession is idle, its prior Turn is terminal, and no active lease, writer, command, or native operation remains.
- Required outputs, transcripts, and evidence from the prior Turn were collected, or their missing or quarantined status was truthfully finalized by their owners.
- Every Turn-scoped input, output, context, instruction, route, credential, transcript-spool, temporary, and control slot was cleared or replaced.
- The retained AgentSession baseline has proved identity, can reconcile to the selected current Workspace and source revisions without ambiguous overlap, and contains no unauthorized retained input.
- Current Agent, policy, permission, Vault, provider, sensitivity, isolation, capacity, and revocation checks admit the new Turn and continued placement.
- The native conversation binding, route separation, exact sequence, and AgentSession-local cleanup proof remain current and non-conflicting.

Fresh authority means the retained AgentSession supplies conversation continuity only. Every reused Turn receives one new immutable AEP snapshot, Context Package, route credentials, execution lease, deadline, sequence scope, current Workspace input snapshot, current source and Knowledge lineage, and current policy, permission, capability, provider, and Vault decisions. No prior package, credential, lease, route, permission decision, cached authorization, or sibling AgentSession authority is refreshed or carried forward.

When any compatibility or hygiene predicate fails, NanoCore closes or fences the predecessor binding through its existing owner and creates a successor only after fresh admission and required cleanup proof. The predecessor must be terminal and non-reusable before the successor atomically becomes current. Authorized operator diagnostics may retain the redacted predecessor, successor, and replacement boundary; ordinary App API and UI expose only the unchanged Thread, prior Turn outcome, current runtime availability, and actions permitted by the owning workflow.

Eviction of an idle AgentSession changes latency and replacement diagnostics only. It does not change Thread history, accepted Items, Workspace truth, evidence, or recovery truth. Retry after a denied or failed reuse decision is a new admission decision from current durable truth; it does not retry a prior native operation or reuse the prior Turn request identity.

## Setup Generations And Revocation

Desired and effective setup generations are immutable derived identities, not new Core product records. The desired generation derives from current Agent Manifest and profile resolution, Worker Skill and instruction digests, runtime image and adapter identity, policy digests, Workspace layout, provider and plugin posture, and current AEP requirements. The effective generation is what one Sandbox, Harness, and AgentSession binding can prove it materialized.

Every new AgentSession placement and later-Turn reuse decision compares current desired requirements with the exact effective generation. A compatible Turn receives fresh dynamic authority without changing static setup. An AgentSession-local instruction, Skill, provider posture, or other compatibility change marks the AgentSession stale for new Turns. A process-global Tool, plugin, native MCP, adapter, or Harness requirement drains and replaces the Harness under its owner. A runtime image, OS user, mount, network, credential-visibility, containment, or Sandbox-policy incompatibility requires Sandbox replacement. The accepted runtime owner decides the exact physical boundary; this specification decides only that a stale generation is never hot-patched and presented as unchanged continuity.

Ordinary non-security updates use rolling replacement: publish the new desired generation, reject new work on incompatible old bindings, admit and prove the replacement at the required boundary, route new AgentSessions and Turns only to the replacement, let already-running non-security-sensitive Turns settle under their pinned immutable authority, and close the old binding after output, evidence, route-revocation, and cleanup barriers complete. Missing or failed replacement dependencies leave new work blocked or unavailable and do not mutate the running generation.

Permission revocation, credential compromise, unsafe visibility, containment uncertainty, or another security-sensitive change is not rolling convenience. Current routes are revoked, affected work follows immediate interruption and the owning cleanup boundary, and no later Turn reuses the old AgentSession. Cleanup does not prove recall of already exposed material.

Restart recomputes desired inputs from current owners and adopts only an exact surviving effective generation and binding. A missing, stale, contradictory, duplicated-current, or unprovable generation rejects adoption or reuse and follows cleanup plus fresh admission; it never selects an approximately compatible generation. Observable acceptance requires a non-security update to pin admitted work and route new work to the proved successor, a security revocation to block reuse immediately, and operator evidence to preserve redacted replacement lineage while ordinary product surfaces remain AgentSession-free. No decision class is not applicable.

## Exact Reconnect Contract

- `awaiting-reconnect` is scheduler lease state, not a new AgentSession lifecycle or selection mode.
- NanoCore restart alone MUST NOT mark a reconnect-eligible worker complete, failed, or replaced.
- Successful adoption MUST preserve the same AgentSession id, Turn id, lease id, package snapshot, worker process, checkpoint, and accepted worker sequence.
- Successful adoption MUST preserve the same backend session and sandbox and MUST NOT create a replacement Runtime Epoch or sandbox.
- A wrong process key, lineage mismatch, stale or conflicting sequence, expired deadline, missing post-launch proof, or lost lease claim MUST reject adoption.
- Rejected adoption MUST NOT create a successor AgentSession while the reconnect window remains owned by the original lease.
- After deadline-owned cleanup, the AgentSession becomes non-reusable and the prior Turn preserves interruption or `recovery_required` under its existing owners.
- NanoHost service, effect-capable member, or execution-server failure interrupts or leaves unknown every affected AgentSession independently. It MUST NOT infer a shared result, migrate an AgentSession, or authorize an automatic replacement, and affected capacity remains unavailable until the NanoHost owner proves fresh-ready recovery.

## Successor Fallback

A fresh successor AgentSession is allowed for a separately authorized attempt only after the predecessor is terminal and runtime-fenced and current manifest resolution, policy, Vault grants, Sandbox requirements, AEP compatibility, Workspace materialization, and scheduler admission succeed.

The successor reads prior context from Core-owned Thread, Item, Artifact, Knowledge, and evidence records. It does not inherit unimported Sandbox files, worker-private caches, native provider sessions, raw resume handles, or hidden runtime state.

The fallback preserves the original attempt. It MUST NOT rewrite an interrupted Turn, claim that an uncertain external effect did not happen, or reuse the previous request identity to repeat a side effect.

## Deferred Snapshot Boundary

Snapshots, generic resume selection, serialized-state restore, rollback, fork, and clone have no current Core or specification owner. They are future, deferred, and non-authorizing rather than optional capabilities supplied by this contract. Exact later-Turn reuse under the section above is current scope and does not authorize any of these mechanisms.

Any future activation requires a present backend and workflow need plus an accepted specification that defines credential invalidation, current-policy reattachment, Workspace truth, lineage, failure, cleanup, and user-visible behavior. A future concept does not justify a current `SessionSnapshotRecord`, generic selector, restore workflow, migration, runner, harness, or test matrix.

Existing inactive snapshot or generic recovery-option helpers are Private implementation projections and may be removed without compatibility obligations if no current backend consumes them.

## Decision Completeness

The definition and exclusions are the exact reconnect, later-Turn reuse, and internal successor outcomes above; cross-Thread reuse, two current AgentSessions, compatible substitution during one active attempt, snapshot restore, automatic replay, inherited authority, and ordinary product exposure are excluded. Core-owned AgentSession, Thread, Turn, Item, and evidence records are durable authority, while runtime bindings, native conversations, compatibility keys, and replacement diagnostics are projections that cannot rewrite product history.

Creation, update, termination, retry, and recovery use existing owners: creation requires no current AgentSession, later-Turn reuse re-evaluates immutable compatibility and hygiene without mutating prior authority, termination closes exact local state after output and evidence barriers, successor creation atomically retires the predecessor, retry is a new authorized request, and restart recovery adopts only the exact active attempt or preserves interruption or uncertainty. Missing, stale, conflicting, duplicate-current, revoked, restart-unprovable, or dependency-failed inputs reject execution; an unprovable local cleanup widens the runtime fence and returns no affected capacity until its owner proves readiness.

Observable acceptance requires two sequential Turns in one Thread to use the same exact compatible idle current AgentSession with different fresh AEP, Context Package, lease, route, sequence, and input lineage; an incompatible or revoked case to retire the predecessor before one successor becomes current; another Thread never to reuse the first Thread's AgentSession; ordinary product surfaces to expose no AgentSession identity or action; and restart either to adopt the exact active attempt or to preserve a truthful interrupted, failed, unknown, or recovery-required outcome without compatible substitution. No decision class is not applicable.

## Current Implementation Projection

NanoCore persists AgentSession identity, policy and compatibility evidence, scheduler lease lineage, worker checkpoints, the bounded `awaiting-reconnect` path, and distinct Sandbox runtime, Harness instance, and AgentSession runtime bindings. The active restart implementation restores the exact lease-named AgentSession. The current NanoHost path supports stock RelayStream carriage, nested HTTP/2, a token-free long-lived Harness bootstrap, private Harness pull carriage, multiple open AgentSessions for distinct Threads, and Sandbox-preserving local close. Its Codex adapter starts one native child per Turn, reads the exact retained native handle from the AgentSession-private state root, invokes `codex exec resume`, and persists the handle after the Turn. No resident Codex process exists between Turns, so a later compatible AEP naturally enters the next child launch; the remaining configuration work is to mint and select that later AEP, not to add a resume input or process-replacement mechanism.

Normal product admission now derives the exact static SessionCompatibilityKey before a scheduler lease, admits work only through one ready configured NanoHost RuntimeTarget, reuses the sole compatible idle current AgentSession, and otherwise completes exact runtime-owned close or uncertainty fencing before terminalizing the predecessor and selecting one fresh internal identity. Store reload, Workspace import, and Harness binding projections enforce at most one current AgentSession per Thread; ordinary App API projections expose no AgentSession identity or action. The unowned generic AgentSession snapshot table, selector, restore options, and recovery matrix have been deleted through the strict current migration. Implementation remains Partial only until these local bytes and the exact shared-Sandbox lifecycle pass the required real-runner, restart, interrupt, cleanup, and fault acceptance.

## Testing Strategy / Acceptance Criteria

- L1 covers exact reconnect eligibility, wrong-key and lineage rejection, exact-next sequence, deadline ownership, same-AgentSession continuation, and fresh-AgentSession isolation from credentials and hidden runtime state.
- L2 covers the scheduler and worker-control boundary that authorizes adoption.
- L3 retains one deterministic NanoCore kill/restart scenario that proves predecessor-fenced exact adoption of the same worker, AgentSession, Sandbox, and next sequence or the documented interrupted fallback, with no replacement or duplicate launch.
- NanoHost and execution-server failure coverage proves every attached AgentSession receives its own interrupted or unknown outcome and no affected capacity returns before the owning cleanup proof.
- A higher-layer real worker check reuses the existing local or A1 acceptance path only when it proves transport integration unavailable at L1-L3.
- Later-Turn tests prove exact same-Thread reuse, one current AgentSession, exact compatibility-key matching, every hygiene boundary, fresh authority and input lineage, predecessor retirement before successor creation, rejection of cross-Thread reuse, and absence of AgentSession controls and identity from ordinary App API projections.
- No current tests are required for snapshot creation, restore precedence, rollback, fork, clone, superset compatibility, or an exhaustive recovery matrix.

Acceptance requires exact or rejected reconnect, same-Thread exact-compatible idle reuse with fresh authority, sole-current successor replacement when reuse is forbidden, preserved prior history, no secret or unimported Workspace state inheritance, no automatic duplicate attempt, no ordinary product exposure, and a working successor path for a new authorized request.

## Consequences

- NanoCore can preserve valuable remote work across a brief restart without promising transparent availability.
- Failure to reconnect is visible and may require a new request; this is an accepted bounded compromise.
- AgentSession continuity remains small enough that it cannot become a second workflow engine or a user-facing conversation model.

## Deferred / Future Work

- Snapshot and restore for a backend that can prove credential invalidation and Workspace isolation.
- A separately accepted snapshot, restore, rollback, fork, or clone contract for a concrete workflow and backend that need them.

Deferred work is non-authorizing and creates no current schema, state, implementation, migration, runner, harness, or test requirement.

## Links

- `docs/core/agent-session.md`
- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
