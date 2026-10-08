---
status: Accepted
implementation: Partial
kind: topology
updated: 2026-10-06
---
# Durable Scheduler Design

## Owns

- The single-writer NanoCore admission queue for one configured execution backend.
- Idempotent exact admission, bounded FIFO dispatch, and one private execution attempt replacing the SessionLease as the execution grant.
- Attempt exclusion, operation acceptance uncertainty, exact same-worker reconnect, terminal handoff, and cleanup fencing.
- The scheduler boundary with the NanoCore-process backend adapter, worker control, NanoHost readiness, and Runtime Epoch invalidation.
- No Goal-to-Sandbox pin. The legacy nullable `pinnedGoalId` column is removed with the Goal implementation. Until then it must not gain a Goal-aware writer.

## Does Not Own

- Product workflow progression, Goal or Task lifecycle, review, Gate, Item, Artifact, or Workspace-apply decisions.
- Goal state and the Coordinator wake. The scheduler admits worker Turns. It does not wake the Coordinator and does not pin a Sandbox to a Goal. `docs/specs/20261002-goal.md` owns the Goal.
- Worker-control envelopes, process-key transport, message sequencing, or final-status schema.
- Storage layout or table DDL.
- Dynamic multi-target placement, fairness, aging, affinity, warm pools, per-scope scale policy, high availability, multi-process Core, or distributed takeover.
- Automatic reconstruction of every crash boundary or a recovery workflow for incomplete product owners.
- Recurring definition, occurrence, cadence, retry, or expiry semantics. This specification owns only the existing admission boundary they must reuse.
- NanoHost identity and transport, Runtime Epoch identity or lifecycle, OpenShell operations, sandbox create or delete, OS supervision, or fresh-empty readiness proof.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/architecture.md`
- `docs/core/sandbox.md`
- `docs/core/permissions.md`

## Summary

NanoCore schedules accepted work through one configured execution backend. Core owns the admission queue and one private attempt record; the attempt is the execution grant. The NanoHost backend adapter is a module inside the NanoCore process and owns Sandbox, Harness, and binding residency in its own tables. It implements the port in [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md#execution-backend-port). NanoHost Rust retains its existing epoch and process responsibilities. The [decision record](../decisions/20261006-execution_backend_port_in_nanocore.md) records this boundary.

The admission holds the exact queued request, not a second outcome or fence. Attempt exclusion and backend-private residency serve different purposes; Core keeps no second active-Turn capacity record. SQLite transactions commit Core coordination but cannot atomically commit an external process, provider call, repository effect, or Sandbox output. Unknown acceptance is inspected, never resubmitted or converted into automatic replacement.

References in this specification to NanoHost readiness and predecessor connections, worker process keys and heartbeat sequences, Harness inventory, Integration loopback drain, and worker-control final status specify the NanoHost profile's proof mechanisms, including their acceptance criteria. Backend-specific readiness, liveness, adoption, inventory, and physical fencing checks belong behind the execution backend boundary; generic admission, attempt, route, restart, and release coordination MUST NOT branch on backend family or require those mechanisms from every backend. Generic coordination requires exact operation and execution correlation, current authority, duplicate exclusion, authoritative stop or fence proof, and complete terminal handoff, output, evidence, outside collection, drain, and route-revocation barriers. Missing or contradictory required proof preserves refusal and exclusion. The NanoHost profile retains its attempt-held process-key hash and existing credential, worker-control verification, reconnect, and cleanup ownership unchanged. This scope distinction admits no other backend or alternative proof contract; those require acceptance in the affected existing owners.

## Goals / Non-goals

Goals:

- Persist accepted work and exact attempt intent before external execution effects.
- Permit at most one non-closed attempt per Turn, Thread, and assigned AgentSession; unknown and closing attempts hold exclusion.
- Bind launch and worker control to exact product, backend, immutable package, and process lineage.
- Preserve one bounded exact-worker reconnect across transport loss or NanoCore restart.
- Release Turn exclusion only after definite non-acceptance or proved execution fencing and the required terminal handoff, output, evidence, outside collection, loopback drain, and Turn route revocation.
- Retain safe resident bindings and the shared Sandbox after ordinary Turn completion; session loopback credentials remain.
- Preserve wider cleanup fences and truthful denial, interruption, unknown effects, and `recovery_required`.

Non-goals:

- Product workflow progression, Coordinator wakes, and Goal-to-Sandbox pinning remain with their existing owners.
- Core does not grant physical capacity, select a fleet placement, or reconstruct incomplete cross-store owners.
- This boundary adds no settlement workflow, recovery runner, or acceptance platform.

## Decision

NanoCore has one logical scheduler writer per data root. Admission and attempt ownership are Server-scope SQLite coordination facts. They commit conditionally under that writer; external backend effects remain a separate effect domain.

An admission records exact accepted input and digest, existing command identity, immutable trigger actor and non-secret credential provenance, requested Agent supply and storage selection, Workspace/Thread/Turn lineage, one configured backend id, queue order, and status. Exact insertion under the existing command identity is idempotent; different input or contradictory provenance conflicts. Queue insertion checks the configured queue bound in the accepting transaction. Eligible work is FIFO, without priority aging or pool policy.

The requested storage selection is an exact retained-resource constraint under [Persistent Worker Volumes](20260910-persistent_worker_volumes.md), reauthorized at dispatch with live membership, protected-source destination admission and current actor/credential policy. Immutable preparation inputs carry that constraint without Docker knowledge, a second execution grant, capacity owner or environment runner in the generic scheduler. Busy capacity keeps the original pending Turn queued; a stale explicit selection conflicts without silent rebasing or substitution. Existing no-effect and unknown-attempt rules remain unchanged. [User-Selected Workspace-Shared Sandboxes](../decisions/20261008-user_selected_workspace_shared_sandboxes.md) records the selection seam.

An execution attempt is private coordination for one admitted Turn, not a product run, public navigation object, or workflow. It replaces the SessionLease execution grant. It binds the admission, Workspace, Thread, Turn, assigned AgentSession, Agent, configured backend id, immutable preparation and launch-package references, exact binding and operation correlation, one absolute deadline fixed at submit, first terminal cause, cancellation intent, outcome, uncertainty, and accepted fencing evidence. Existing protocol/evidence owners retain payloads and fingerprints. The attempt keeps the worker process-key hash and exact reconnect lineage; it references the existing distinct control, inference, and capability credential bindings and their original hash evidence.

Only the attempt holds execution outcome and fence facts. Admission does not duplicate them. Conditional attempt updates reject stale or conflicting ownership and exclude every non-closed predecessor. Sandbox, Harness, and binding inventory remain separate private projections inside the backend adapter, as required by Core Runtime Model. Runtime Epoch, Gateway, container-runtime identity, and host paths remain NanoHost-private. Connection generation and predecessor-fence facts are correlation and cleanup proof, not scheduling capacity keys.

Delete worker pools, placement plans, capacity records, target health and probation, orphan-capacity accounting, unused supply-refresh scheduling gates, and lease-renewal scheduling and its cap machinery. Use the existing configured backend id throughout; local versus remote describes deployment and never creates another target identity. Core-mediated routes check the exact attempt, its credentials, current policy, explicit revocation, and its absolute deadline. The current default submit-to-expiry budget is the existing 7200-second total cap. The NanoHost adapter additionally applies its unchanged heartbeat, startup, stale-classification, and exact reconnect rules in [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md#nanohost-adapter-liveness). The current scheduling profile is owned by [Runtime Scheduling And Scale](20260703-runtime_scheduling_scale.md).

## Admission And Launch

- Admission resolves the immutable Turn/AEP `triggerActor` through the existing product lineage and applies the shared `runtime.launch` current-authority predicate before writing a new admission. Scheduler rows link the Turn, AgentSession, and package snapshot and must not copy another runtime `ActorRef` or use the derived responsible user as storage or capacity scope.
- A recurring occurrence is accepted when its exact scheduler queue row commits, not when dispatch or worker execution begins. Where the occurrence owner and admission row share `core.sqlite`, the occurrence acceptance and queue insert MUST use one transaction and one deterministic request identity. Exact replay returns that row; a conflicting identity fails `recovery_required`. Once committed, later queue denial, dispatch delay, Turn failure, interruption, unknown effect, or approval wait MUST NOT cause the occurrence owner to submit another admission.
- For an interactive human request authenticated by a currently usable administrator credential, the administrator's Web session or an administrator bearer, admission retains only the non-secret reference of that credential, bound to the immutable human triggerActor and exact admission. This credential reference is not a grant, ActorRef extension, AEP field, or Token secret. Null provenance uses the ordinary member/responsible-user path. Internal, automated, and recurring triggers cannot inherit an unpresented administrator credential. Exact replay must preserve the same provenance.
- Acceptance requires a nonmember administrator Task to complete through the real Worker authority chain, and persisted or reloaded admission with a revoked, expired, rebound, or otherwise unusable credential to deny its next governed effect. An ordinary caller remains denied foreign private conversation access. A currently usable administrator credential is eligible for that access under the administrator eligibility rule in [Core Permissions](../core/permissions.md).
- Dispatch and subsequent Worker launch, inference, tools, credential use and content publication resolve that same admission through existing exact Turn/attempt/package lineage and revalidate that credential's current owner, scope, usability, and active canonical User. Invalid recorded provenance, a revoked or expired credential, changed owner or scope, or contradictory lineage denies without membership fallback. Restart reloads the reference and applies the same live checks. It must never reconstruct an administrator grant from actor identity alone. The credential reference, actor, and request lineage remain available for audit. Effect-specific checks remain. Private audience follows the administrator eligibility rule in [Core Permissions](../core/permissions.md). No Token lifecycle or recovery owner is added.
- Dispatch rechecks the same current-authority predicate before preparation effects, token minting, and native submission. Invalid authority launches nothing and uses the existing denial or Turn failure owner; no retry or replacement is inferred.
- Product acceptance validates command identity, immutable input, product lineage, selected Agent readiness and setup constraints, and one nonterminal Turn per Thread. A pending worker Turn may lack an AgentSession before dispatch, as Core Protocol permits. Queueing grants no inference, capability, Vault, or native execution authority.
- Acceptance publishes the complete request-bound pending Turn, exact admission, and entry-owned checkpoint/context facts, with the initiating entry owner's applicable receipt or receipt-free source tuple, before response and dispatch eligibility. A direct or outer command retains its ordinary receipt; an outcome-initiated Assistant handoff retains its receipt-free exact source tuple under [Task Mode](20260704-task_mode_worker_delegation.md#entry-points) and [Chat Mode Assistant](20260704-chat_mode_assistant.md). Pending Request outcome admission and recurring admissions retain their existing entry owners and receive no new HTTP command receipt. The stores are not made atomically transactional across SQLite and files. Missing or contradictory members remain inspectable and non-dispatchable as `recovery_required`; no repair or receipt snapshot is introduced.
- A second Task on its own Thread receives HTTP 202 and reads as queued before dispatch. Exact replay validates the original owners and projects current state without another admission. Changed input conflicts. Queue-full is a definite refusal with no hidden later execution.
- Before any preparation effect, Core persists the exact attempt and its immutable preparation inputs. Within the one Core process, at most one dispatcher prepares a queued admission at a time through the existing in-process preparation claim ([decision](../decisions/20261002-scheduler_in_process_preparation_claim.md)). Background dispatch skips a claimed admission. The claim ends on dispatch, deferral, cancellation, or failure and is never persisted or recovered; the durable attempt prevents a second launch across restart. A receipt does not wait for preparation or submit.
- Backend preparation remains behind the adapter and the existing supply and Workspace owners. Before `submit`, Core persists the attempt and immutable finalized launch package, accepts the Workspace baseline, binds exactly one AgentSession, validates backend and binding compatibility, and rechecks current launch authority. The adapter enforces its exact Harness and Sandbox limits and the authoritative NanoHost readiness/predecessor fence. Missing, stale, conflicting, or non-ready proof prevents native submission.
- Core records the outstanding operation identity before calling the port. From that point its disposition is `unknown` until definite acceptance or non-acceptance is proved; a crash must not make a possible call look unsent.
- Busy is `not_accepted` only when nothing was reserved or submitted. Close that no-effect attempt and leave the same admission and pending Turn queued. A later eligible submission uses a new attempt identity after the predecessor is closed, never a replacement Turn.
- Accepted pending work is observed through its current attempt and is not submitted again from the ready queue. Once any operation may have occurred, inspect the same identity; a lost reply, timeout, or missing observation never authorizes resubmission.

## Attempt, Reconnect, And Cleanup

The attempt has exactly three phases. Backend readiness and native progress are observations, not additional attempt phases.

| Phase | Meaning and legal progress |
| --- | --- |
| `open` | The exact grant holds exclusion during preparation, submission, execution, and observation. Record the identity and disposition (`not_accepted`, `accepted`, or `unknown`) of the outstanding backend operation. Definite no-effect refusal can close it; terminal handoff, cancellation, authority loss, or cleanup ownership moves it to closing. |
| `closing` | New execution authority is revoked while required handoff and fencing are resolved. Outstanding effects remain accounted for, and exclusion remains held even when product outcome is known. |
| `closed` | Definite non-acceptance with no possible outstanding effects, or proved execution fence with required handoff, permits exclusion release. Preserve the first terminal cause, actual outcome, and any unknown prior effects; a fence never proves success or absence of prior effects. |

Cancellation and dispatch conditionally compete for the exact admission/attempt. A queued cancellation prevents dispatch. Cancellation after an operation may have occurred enters closing and invokes `cancel` for that same attempt; acknowledgement is not fencing proof. Exact late observations may refine that attempt's evidence but cannot undo cancellation, reopen a closed attempt, or authorize another execution. Conflicting or stale responses fail closed and retain the fence. Known outcome with unknown cleanup stays closing; proved fencing with unknown prior effects may close with truthful interruption or unknown outcome.

The absolute attempt deadline and explicit revocation bound Core-mediated authorization. The NanoHost adapter retains the existing liveness and bounded reconnect proof in [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md#nanohost-adapter-liveness). The attempt retains the Core-held process-key hash and exact adoption facts instead of a SessionLease. Core refuses routes while awaiting exact adoption even when the authority deadline has not expired. Only the exact process-key hash, product/backend/binding/package lineage, next sequence, unexpired deadline, predecessor-fenced connection, and conditional attempt ownership may adopt that same worker. A wrong reconnect request leaves an already armed deadline intact; exact adoption or its deadline owner alone wins the race. Successful adoption continues the same attempt, AgentSession, Turn, and checkpoint without native submission or Sandbox creation. Failed proof closes or fences the binding through its existing owner; a successor resumes natively only for new authorized work.

One pre-listen ownership scan performs durable classification, conditional fencing, and read-only restoration. It preserves exclusion and may re-derive bounded result-only request identities only from complete immutable owners. It neither adopts a worker before exact process presentation nor awaits NanoHost effects or effectful final-status closeout. After the ordinary listener admits the authoritative NanoHost connection, the existing maintenance owner serially inspects unresolved operations and continues already-owned cancellation, cleanup, and accepted-final-status closeout. A retained successor result settles only its exact expectation and cannot dispatch or replay an effect. No cleanup queue, second recovery lifecycle, timer family, or transport is added.

A disconnected healthy NanoHost is not recreated or invalidated solely because Core restarted or transport was lost. Definite physical cleanup or predecessor-domain fencing must name the exact affected execution; an ordinary ready report or connection generation is insufficient. NanoHost retains its existing whole-Runtime-Epoch invalidation for uncertain accepted create/delete and effect-capable member failure. The adapter preserves all affected Harness/Sandbox/binding fences until definite cleanup or predecessor fencing followed by fresh readiness is proved. Unknown and closing attempts remain exclusive throughout.

Ordinary Turn release requires terminal handoff, output, evidence, outside Workspace collection, the Integration loopback drain owned by [Worker Agent Capability](20260703-worker_agent_capability.md), and revocation of Turn upstream routes. It also proves that the binding is a safe open resident or locally cleaned. It does not require `session.close`, `bridge.close`, Sandbox deletion, or shared Sandbox replacement. Session loopback credentials and safe open bindings remain. Retained resume references and working volumes are not removed by release.

Backend-private residency without a live attempt is not an adoptable Turn. An idle binding is not an orphan execution. The adapter cleans an unowned effect-capable binding only through exact retained lineage and its existing cleanup owner; it preserves the physical fence after failure, missing ownership, or uncertainty. The post-listen drain permits at most one process-local cleanup attempt per affected boundary at a time. Definite physical cleanup is recorded independently for each exact existing session, with its existing server audit event; unrelated rows and versions remain untouched. Do not reconstruct orphan surplus counters, synthesize an attempt, receipt, or product outcome, or release exclusion from a missing row. Definite recorded cleanup may satisfy the reliability envelope's failed-start predicate; the product lifecycle owner performs that closeout. Each affected AgentSession and Turn retains its independent truthful outcome.

## Terminal Handoff

Worker-control `final_status` is transport evidence, not product completion authority. When its exact accepted record and safety-critical lineage agree, the scheduler may move the attempt into closing and let the existing worker-turn, AgentSession, checkpoint, evidence, Workspace handoff, backend, and mode owners finish their own transitions.

Only facts that affect authorization, duplicate external work, data loss, product outcome, or physical cleanup may block scheduler release. Audit rows, read models, serialized responses, and events are projections and do not become release authority.

A complete terminal owner tuple may finish through the existing owner transaction. A partial or contradictory tuple remains `recovery_required`; the scheduler does not infer a winner, synthesize a receipt, repeat an external effect, or create a settlement state.

## Missing-Turn Checkpoint Maintenance

Boot classification stays fail-closed when a Task checkpoint's product Turn cannot be read. `getTurn` reports one error both when that Turn is absent and when the same Turn id belongs to another Workspace or Thread. Restart recovery MUST NOT treat that error, a null `workerSessionId`, a failed checkpoint, or an attempt with first terminal cause `turn-start-failed` as proof that no Worker ran, and it MUST NOT delete the checkpoint.

A live synchronous Task invocation that cancels its own deferred or refused first admission MUST remove its own still-preparing checkpoint before returning the refusal when the complete attempt-local proof below holds. This exception applies to ordinary Task delegation, including a selected-Worker conversation or a Goal-dispatched Task. It ends preparation without asserting a worker outcome and introduces no terminal Turn, receipt, settlement record, or recovery lifecycle.

The invocation MUST establish that the checkpoint was created by this invocation for the same Workspace, Thread, reserved Turn, request identity, and canonical input hash, remains `preparing` with null worker session and StopReason, and has not been admitted to the caller. Exactly one admission must agree with that lineage, its cancellation must be durable, and the reserved Turn must have no attempt opened, no submit accepted or unknown, no durable product Turn under any owner, accepted worker input delivery, AgentSession execution association, backend session, worker-control record, or other contradictory execution evidence. A cancellation attempt or error code alone is insufficient. The invocation's own pre-admission context digest, context-selection diagnostics, and preparation authorization do not disqualify this proof. Terminal checkpoint evidence and evidence not proved to be that invocation's preparation do disqualify it.

After durable cancellation, the owning mode rechecks that proof and removes only the checkpoint in the Workspace transaction that applies any Workspace-local refusal writes required by the initiating mode. It preserves the cancelled admission and independently retained preparation, authorization, and evidence records. It does not release capacity, retire a runtime, publish Task success, or create a nested command receipt. Removal does not authorize another launch under the cancelled request identity; later work requires a new request, and existing replay predicates remain in force.

Core cancellation and Workspace checkpoint removal are separate commits. If cancellation is unproved, any required owner is missing, unreadable, changed, or contradictory, or checkpoint removal fails, preserve the checkpoint and surface the existing failure or recovery requirement. A crash between these commits retains the existing fail-closed restart behavior. This exception grants no boot-time, replay-time, historical, or operator bulk-deletion authority.

The decision and its accepted cross-store crash boundary are recorded in [a decision record](../decisions/20261006-live_cancelled_task_checkpoint_removal.md).

An already accepted queued Task has its durable product Turn and ordinary receipt and cannot satisfy this exception; its later preparation failure closes that same Turn through the initiating mode's existing owner.

Outside the live attempt-local exception above, a stopped-NanoCore operator command is the only supported deletion path for a missing-Turn leftover. It MUST hold the existing data-root lock, default to dry-run, accept only explicit checkpoint identities, and, on apply, write a consistent backup of each Workspace database it will change to a destination outside the data root before rechecking the selected row. It then MAY delete only that checkpoint through the existing terminal-checkpoint clearer. Classification and dry-run MUST NOT prune receipts, migrate Thread envelopes, repair approval history, or create missing databases. A matching command receipt, including an expired receipt, contradicts cleanup. Malformed checkpoint diagnostics are unreadable history. Context-assembly diagnostics are execution evidence even when a summary parser cannot reconstruct every field. The attempt's Workspace, Thread, Turn, and admission MUST match the checkpoint and command request.

The command admits a row only when every predicate holds:

- The checkpoint stage is `failed`, `stopReason` is `error`, `workerSessionId` is null, `goalId` is null, `taskId` is null, and `iteration` is 0.
- The checkpoint has no context digest, context-assembly diagnostics, item or artifact evidence, runtime-evidence row, evidence bundle, environment package, worker-control record, backend session, or AgentSession for that Turn.
- Published Turn files show that the Turn id is absent under every Workspace and Thread. A Turn present under any owner, including a lineage mismatch, refuses cleanup. Unreadable or corrupt history, including malformed checkpoint diagnostics, refuses cleanup for the invocation and deletes nothing.
- The Workspace and Thread records match the selected identity.
- No attempt for the Turn is open or closing, and the Turn does not have more than one attempt.
- No command receipt, package, control record, session, attempt, or admission contradicts the single proof below.

Proof is exactly one of these tuples. Anything else, including a missing or ambiguous owner, leaves the row for inspection:

- Exactly one admission for that Workspace, Thread, Turn, and command request has status `cancelled`, and that Turn has no attempt.
- Exactly one closed attempt for that Workspace, Thread, and Turn has first terminal cause `turn-start-failed` and definite pre-effect non-acceptance. It has no backend execution ownership, accepted heartbeat, worker sequence, process key, or route-token hash. Its admission is the only admission for the request and Turn, its status is `admitted`, and its request id matches the checkpoint. Exact retained input, package, and operation facts prove that no backend effect was possible.

The command does not create, update, or synthesize a Turn, receipt, attempt, admission, or backend residency row. It does not retry work, repair product history, clean runtime state, or release attempt exclusion or backend capacity. Deletion removes only the proved checkpoint. A later apply that no longer finds that checkpoint is a no-op. A row that changes between classification and deletion is left in place. Lock loss, backup failure, or an unreadable dependency refuses the invocation before deletion.

The stopped-server maintenance exception does not apply to nonterminal checkpoints, checkpoints with a durable Turn, or any boot path. Goal-affiliated checkpoints are closed or dropped with the Goal implementation, not by that operator exception.

## Backpressure And Failure Semantics

- A synchronous caller receives only its own admission's outcome; another request's failure is neither returned nor disclosed. Shared dispatch/acquisition failures not proved to belong to that caller remain with the affected owner.
- A caller told of a real failure has its still-queued admission cancelled and receives the original failure unchanged, including transient preparation failure. Background transient preparation failure may retain its existing queued retry. Once a queued receipt has been accepted, later preparation failure is recorded on that same Turn; it does not retroactively fail the original call ([decision](../decisions/20261006-execution_backend_port_in_nanocore.md)).
- Capacity deferral is accepted queued work, not a caller failure or requested deferred cancellation. The existing release-triggered wake or bounded retry pass rechecks authority and dispatches FIFO-eligible work. No durable retry job or automatic queue expiry is added.
- Missing or unready backend dependencies prevent launch with the existing typed diagnostic; permanent dependency failure, explicit cancellation, or authority loss is resolved through the existing admission/Turn owner.
- The NanoHost adapter refuses new routes after missed-heartbeat stale classification and holds needs-evidence exclusion. That classification proves neither success nor failure and releases no exclusion.
- NanoHost, Gateway, container-runtime, execution-server, or uncertain-cleanup failure fences affected execution and preserves independent AgentSession and Turn results. Unknown acceptance is not busy, and a terminal native result is not cleanup proof.
- Human-actionable denial or interruption may appear through Action Center; it owns no scheduler state.
- Post-effect uncertainty leads to original-operation inspection, bounded exact reconnect, cleanup, and truthful interruption, never automatic replay.

## Current Implementation Projection

The three admission projections use `scheduler.list`, `scheduler.retry` and `scheduler.cancel` through the composed operation definitions and `runtime/scheduler-admission-operations.ts`. Interrupted worker reads and release use `recovery.worker-list` and `recovery.checkpoint-retry` through `runtime/worker-recovery-operations.ts`. The derived transports preserve queue status transitions, Workspace audit placement, exact request receipts, original Turn/checkpoint lineage and terminal cleanup. Child audience admission uses minimum canonical selectors and current administrator eligibility; it creates no lease, launch, recovery runner or durable state.

Before the execution-backend amendment is implemented, NanoCore persists admission entries, placement plans, leases, pool and scheduler capacity rows, target-health summaries, worker-control bindings, and scheduler epochs. Dispatch, lease maintenance, health probing, and restart scanning run as in-process services. Ordinary successful NanoHost Turns release scheduler capacity after Turn-local backend cleanup while retaining the shared Sandbox. The current path admits multiple compatibility-keyed Harness records inside one Sandbox and retains one active-Turn unit per Harness; scheduler authorization for concurrent active Turns across those Harnesses remains unimplemented. Queueing does not implement concurrent native Turns; the current single active-Turn limit remains the proved first-slice limit. The duplicate RuntimeTarget `active_lease_id`, mutable `capacity_state`, and test-only claim or settle helpers have been deleted through the strict current migration; scheduler leases and capacity rows remain the only active-Turn grant. The legacy nullable `sandbox_runtime_records.pinned_goal_id` column is removed with the Goal implementation. Until then it must not gain a Goal-aware writer, and no Goal pin behavior is implemented.

The current admission insert is not request-idempotent, and `startProductTurn` may return `scheduler_admission_deferred` after its queue row already committed. The recurring occurrence transaction above is therefore unimplemented. Synchronous and background dispatch share the in-process preparation claim in Admission And Launch: the dispatch loop keeps one claim set per Core data root, so a synchronous caller joins an in-flight attempt for its own admission and background dispatch skips a claimed one.

The pre-listen restart scan now performs only durable classification, fencing, read-only restoration, and deterministic result-only expectation registration. The existing post-listener single-flight maintenance service resumes exact cleanup and fail-closed accepted-final-status recovery through ordinary transport. Worker-governance preparation consumes the sole configured NanoHost readiness projection before any fresh, reused, or replacement AgentSession can acquire a lease; runtime-binding and Sandbox uncertainty remain non-reusable and preserve the existing capacity fence. Real restart, reconnect, cleanup, and saturation acceptance remains outstanding.

Boot Task checkpoint classification still refuses a missing Turn. The stopped-server `task-checkpoint:clean` command implements the missing-Turn maintenance exception above: dry-run is the default, apply requires explicit checkpoint identities and an external Workspace-database backup, and deletion is limited to one proved failed Task checkpoint.

## Alternatives Considered

### Keep The Scaled Profile In The V1 Contract

Rejected. One configured target with bounded local capacity does not justify fairness, aging, weighted selection, per-scope caps, or multi-target compatibility. Future need can define those mechanisms without preserving the present Private row shapes.

### Guarantee Recovery At Every Admission-To-Launch Crash Point

Rejected. SQLite cannot atomically commit an external worker effect. V1 prevents duplicate launch where authority is provable and otherwise exposes interruption or `recovery_required` instead of building settlement and repair workflows.

### Use Process-Local State Only

Rejected. Durable attempt identity and reconnect fencing are necessary to reject stale or duplicate workers after NanoCore restart.

## Testing Strategy / Acceptance Criteria

- L1 proves idempotent exact insertion under the existing command identity, changed-input conflict, checked queue bound, eligible FIFO, recurring-occurrence atomic admission, and no occurrence resubmission after acceptance.
- L1 proves preparation runs once across synchronous and background dispatch, no durable preparation claim, foreign-error isolation, unchanged own failure with queued cancellation, and background transient retry. A capacity refusal closes its no-effect attempt while the original Turn/admission remains queued.
- L1 proves attempt-before-preparation and immutable-package/baseline/authority-before-submit ordering, per-Turn/Thread/AgentSession exclusion, unknown and closing exclusion, lost-response inspection without resubmission, stale-response rejection, and cancellation-versus-dispatch ownership.
- L1 proves backend-private Harness/Sandbox limits, exact compatibility, absolute deadline and revocation plus unchanged NanoHost heartbeat/startup refusal, Core-held process-key adoption and reconnect refusal, ordinary Turn release without shared Sandbox deletion, and wider cleanup fencing until exact proof.
- L1 proves the live cancelled-first-admission exception only for the invocation-owned still-preparing checkpoint with complete matching lineage, durable cancellation, no attempt opened, no submit accepted or unknown, no product Turn or other execution owner, and only its own preparation evidence. Recheck and Workspace-local refusal writes precede checkpoint-only removal; cancellation/removal failure or a crash preserves fail-closed history, and the cancelled identity cannot relaunch. Boot, replay, historical and bulk deletion gain no authority.
- L1 retains the missing-Turn operator-command proof: explicit apply only after dry-run classification, lock and outside backup, exact cancelled admission or definite pre-effect closed-attempt tuple, repeated-apply no-op, and refusal on lineage mismatch, unreadable history, open/closing or multiple attempts, non-null session, nonterminal checkpoint, Goal ownership, runtime evidence, or missing provenance. Boot never deletes that checkpoint.
- L2 proves two independent Tasks against one active slot each receive a durable 202 receipt; the second reads queued, has no completion or native start, and starts once after proved release. Exact replay while queued and after restart keeps its Turn and admission; changed input conflicts. A later preparation failure lands on that same Turn.
- L2 retains exact worker-control audience, credential hash, lineage, sequence, final-status, and complete/partial terminal-tuple predicates at the attempt boundary.
- L3 retains the existing deterministic Core kill/restart scenario: predecessor-fenced exact process adoption continues the same attempt without duplicate launch or Sandbox creation; failed proof uses existing cleanup and truthful independent outcomes, and later authorized work uses a natively resumed successor.
- L5 or opt-in A1 retains one configured local or remote NanoHost path, ordinary shared-Sandbox-preserving release, definite physical cleanup, uncertain-cleanup epoch invalidation, and exact predecessor-fence/fresh-ready proof. Existing runners and harnesses are reused.

Acceptance requires one configured backend id throughout admission, submit, collection, release, and restart inspection, no second Core capacity grant, no unauthorized or duplicate worker, truthful queued receipts and exact replay, retained distinct compatibility-keyed Harnesses and Thread-bound resident AgentSessions, and the complete existing output, evidence, collection, drain, revocation, reconnect, and cleanup proofs. Queueing does not claim concurrent native execution beyond the current proved limit. Incomplete or contradictory product tuples remain `recovery_required`; no synthetic winner, receipt, effect replay, or settlement owner is created.

## Risks And Mitigations

- Risk: stale execution continues after Core restart. Mitigation: Core-held process-key hash, exact lineage and sequence, absolute deadline and unchanged adapter liveness/reconnect deadlines, predecessor-fenced adoption, and conditional attempt exclusion.
- Risk: a lost response duplicates an external effect. Mitigation: record the operation before the call, preserve unknown, inspect the original, and close only on definite non-acceptance or proved fencing.
- Risk: private coordination becomes a second workflow engine. Mitigation: admissions own requests and attempts own execution grants; product outcomes, evidence, and retained data keep their existing owners.
- Risk: missing-Turn lookup hides wrong-owner history. Mitigation: boot never deletes; the stopped-server command requires global absence, exact pre-effect or cancellation proof, lock, explicit identities, and outside backup.

## Deferred / Future Work

Second backends, mixed placement, quotas, warm pools, a NanoHost operation journal, a separate admit operation, a describe operation, moving orchestration into NanoHost, and demand-driven idle-binding eviction are deferred. Dynamic fleet selection, fairness, aging, affinity, richer scale policy, multi-process Core, shared scheduler state, high availability, and hot failover require a separately accepted design. This is the single deferred-scope statement for the execution-backend amendment; it creates no current registry, schema, migration, option, runner, harness, or test requirement.

## Links

- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260711-scheduler_recurring_event_triggers.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260529-test_strategy.md`
