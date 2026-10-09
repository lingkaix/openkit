---
status: Accepted
implementation: Partial
kind: concept
updated: "2026-10-09"
---
# Task Mode Worker Delegation

## Owns

- Task Mode as the delegated-work path for bounded, near-term user requests.
- The V1 flow from Assistant or user request to Workflow Coordinator routing, worker selection, thread/turn creation, bounded worker execution, result collection, and user-facing completion.
- The single-worker default delegation contract.
- Task Mode item, artifact, evidence, and Action Center projection requirements.
- Exact running-Task live steer, its ordinary input Item, completed command receipt, failure and recovery semantics, and observable delivery result.

## Does Not Own

- Chat Mode direct replies or Assistant tool boundaries. `docs/specs/20260704-chat_mode_assistant.md` owns those.
- The Goal, its cards, its Plan versions, the wake marker, and completion. `docs/specs/20261002-goal.md` owns those. An authorized Coordinator request is another admission source for a Task that was admitted under a Goal. Standalone Task Mode does not gain a loop.
- Reusable Workflow Coordinator internals beyond this mode. `docs/specs/20260704-workflow_coordinator_internal_agent.md` owns the Internal Core Role contract.
- Worker runtime communication, control protocol, scheduler, AEP, or workspace sync internals.
- Knowledge Store governance or Knowledge Manager maintenance.

## Core References

- `docs/core/core-concepts.md`
- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/architecture.md`
- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-supply.md`
- `docs/core/communication.md`

## Summary

Task Mode is for bounded delegated work: the user supplies an instruction for one bounded attempt, NanoCore routes it through Workflow Coordinator, one worker agent performs it on the Task's Thread, and the result is returned with artifacts, evidence, and any pending human attention. A Task is its Thread and all of its Turns: the first Turn comes from the Task command, and later Turns come from the user's follow-up messages or from delivered outcomes of the worker's pending requests. When the Task was admitted under a Goal, an authorized Coordinator request is another admission source. Standalone Task Mode does not gain a loop. A Task attempt remains bounded, and continuation after a stop is an ordinary new authorized Turn on the same Task Thread or an existing Goal Coordinator decision under [the Reliability envelope](20260531-worker_turn_reliability_envelope.md#worker-turn-envelope).

Task Mode is heavier than Chat Mode because it starts worker execution. It is lighter than a Goal because it does not own a continuous outcome or an approved Plan version. An explicit Goal selection uses create Goal.

## Goals / Non-goals

### Goals

- Make simple delegated work first-class before long-running Goal Mode is needed.
- Keep worker execution traceable through thread, turn, item, artifact, evidence, and AgentSession records.
- Let Workflow Coordinator select a worker and compose the semantic worker request while the Task Mode service persists, materializes, and delivers it without exposing adapter-private launch details to product surfaces.
- Return a Task projection derived from the exact Turn, Item, Artifact, review, evidence, and command-idempotency owners rather than a Task-only record. An escalation names the Goal when that Goal still exists.
- Allow escalation from Task Mode to Goal Mode when the task becomes larger than expected.

### Non-goals

- Do not require explicit plan approval for every Task Mode request.
- Do not run unbounded loops.
- Do not let worker agents write directly to product state outside Core-owned review/apply flows.
- Do not let Assistant bypass Workflow Coordinator to start worker execution.
- Do not support multi-worker orchestration as the default Task Mode path.

## Background

`docs/core/work-model.md` defines Task Mode as delegated work that needs worker-agent execution, progress tracking, artifacts, evidence, or review. `docs/core/agent-workflow.md` says Task Mode should route to Workflow Coordinator and use bounded worker steps when execution is required. Existing worker runtime, control, scheduler, AEP, and workspace sync specs supply the lower-level pieces but do not define the user-facing Task Mode contract.

## Decision

- Task Mode is the default delegated-work path for bounded tasks that do not need explicit plan negotiation.
- Workflow Coordinator owns the bounded routing, worker-selection, and semantic worker-request decision. Task Mode has no durable Task record: the command-idempotency row owns replay, Turn owns execution state, Items and Artifacts own output, review and evidence records own their own decisions, and the Goal owner owns an escalation created through create Goal. The Task service validates and applies that owner tuple, persists and delivers context, requests scheduler launch, and projects the result.
- The first Task Mode slice uses one selected worker agent and one bounded worker turn by default.
- An authenticated direct `task.start` request, or an authorized explicit Assistant Task handoff, selects bounded worker delegation. A structurally valid, nonempty instruction authorizes one bounded worker attempt; it does not assert that all information needed to finish is already available. Natural-language vocabulary, question form, task size inferred from prose, or the availability of a possible Chat answer MUST NOT override that selected mode. The worker interprets the instruction and may raise pending approval and user-input requests under [Pending Requests](20260930-pending_requests.md). Negations and supplied material remain constraints and context, not authorization for the actions they mention. The worker may complete with a reply, evidence, a truthful blocker, or a recommendation to use Goal Mode. No Task Turn starts another Turn on its own. The reason and accepted clarification cost are recorded in [Explicit Task Delegation](../decisions/20261004-explicit_task_delegation.md).
- A worker may recommend an explicit Goal selection when the request becomes multi-step, ambiguous, high-risk, or long-running; selecting Task does not create a Goal from prompt keywords.

## Contract / Expected Behavior

### Entry points

Task Mode may start from:

- Assistant handoff
- direct product UI or remote MCP interface operation
- user request in an existing thread
- a new user request after a prior completed or failed Task attempt

Every direct Task App API entry MUST include and preserve the initiating user request, Workspace id, addressed Thread id, authenticated actor context, and client-visible `requestId`; `@openkit/core-client` may generate it before sending, but NanoCore rejects a missing id. Direct Task entry executes in that addressed Thread. Every handoff instead creates one new receiving Thread in the Workspace that owns the receiving execution, sets that Thread's `parentThreadId` to the originating Thread, and leaves a handoff reference Item in the originating Thread; it never reuses the originating Thread for the worker execution. Direct `task.start` command identity is the command name, actor id, Workspace id, Thread id, and request id. Its canonical input hash covers only the caller-supplied `input`, optional `logicalModelId`, and complete caller-supplied storage choice (an exact retained Sandbox reference with its expected revision, or create-from-template with its exact template reference/revision and bounded name); Coordinator output, default-model resolution, eligible-worker snapshots, context selection, and current projections are execution results and MUST NOT be re-resolved before replay lookup. A user correction or retry is an ordinary new Task command with a new request id; the prior attempt remains visible in Thread history, but V1 adds no Task-only refinement, causation, or retry lifecycle. Typed refinement of an Artifact remains owned by Artifact Review. Goal completion is the person's acceptance, not a review verdict.

NanoCore looks up the direct Task command identity before Coordinator, worker, Goal, or current-state resolution. The same identity and input MUST replay the original Task response or Task-to-Goal escalation under the original Thread, Turn, and Goal lineage. Reusing that identity with different caller input returns `409 idempotency_key_conflict`; neither case may create another Thread, Turn, Goal, scheduler admission, or side effect. A direct worker delegation derives its Task Turn, status Item, and `preparing` checkpoint identities from the immutable command scope and request id. A handoff additionally derives its new receiving Thread from the immutable outer command scope and derives the Task Turn inside that receiving Thread; the originating Thread retains only the handoff Item and does not receive or reconstruct worker history. An escalation derives its new receiving Coordinator Thread, Goal, objective Turn and Item inside that Thread, and Task-to-Goal reference Item in the originating Task Thread from the same scope. If the complete request-bound `preparing` checkpoint exists with no Turn or admission effect, exact replay may perform the one first launch authorized by S05. For that direct command only, a complete outcome tuple without its `task.start` receipt may publish that receipt; a missing checkpoint with effects, an incomplete checkpoint lineage, a second effect, or any contradictory tuple returns `recovery_required`. This replay refusal also applies after the [live attempt-local cancellation exception](20260703-durable_scheduler_design.md#missing-turn-checkpoint-maintenance) removes a checkpoint; the retained cancelled admission prevents a fresh launch under that identity. A Task Turn that has raised pending requests is an ordinary Turn with its ordinary outcome, and replay never relaunches it. No Task-specific pending command, settlement record, or recovery lifecycle is permitted.

Task terminal closeout uses the same derived classifier during independently observed worker completion, exact replay, and boot recovery. For a direct Task command, a terminal checkpoint plus complete Turn, AgentSession, canonical StopReason, evidence, review or workspace-handoff when required, backend adapter and closed execution-attempt owners may either validate an existing `task.start` receipt or publish that deterministic missing receipt when no Task closeout write exists. A conversation-to-Task attempt from a command-initiated Assistant Turn instead requires its sole outer `conversation.submit` receipt; if that receipt is absent, closeout is `recovery_required` and MUST NOT create `task.start`. A handoff from an outcome-initiated Assistant Turn instead requires the exact source tuple that [Chat Mode Assistant](20260704-chat_mode_assistant.md) defines, the admitted Assistant Turn, its completed handoff Item, and the downstream lineage, and it has no receipt to publish; if that tuple is absent or conflicting, closeout is `recovery_required` and MUST NOT create `task.start` or a conversation receipt. The classifier clears the checkpoint only after the applicable receipt is durable. Any partial receipt or projection tuple, missing required owner, or conflicting request identity remains discoverable as `recovery_required`; recovery never reruns Coordinator, starts the worker, or invents a Task record.

The complete closeout tuple is backend-specific without weakening its authority. Unless the complete proof for [checkpoint-owned failed start before Worker submission](20260531-worker_turn_reliability_envelope.md#failed-start-before-worker-submission) applies, when the AgentSession names an AEP snapshot, closeout MUST validate the exact AEP, accepted worker-control final status, exact backend quiescence or cleanup proof with complete workspace handoff, closed execution attempt with accepted fence, Turn and AgentSession state, canonical terminal event, immutable worker-input Item, and checkpoint evidence; absence or contradiction of any owner fails closed. The bounded in-process adapter compromise applies only when the exact AgentSession durably has no AEP snapshot and therefore owns no worker-control or backend-session records: a live or replayed already-terminal checkpoint may close only when its request-bound input Item parses as the accepted structured worker request and hashes to the checkpoint context digest, the exact AgentSession and closed execution attempt agree with the Turn and command admission, the canonical event or active Gate agrees with the StopReason, and checkpoint evidence still resolves. Such an adapter checkpoint in `preparing` or `running_worker` cannot be recovered after restart and remains `recovery_required`; the compromise creates no synthetic AEP, final status, backend record, recovery state, or compatibility path.

A queued Task that fails before AgentSession assignment closes through the same initiating-mode classifier. It requires the exact request-bound Turn/admission/checkpoint/input and either the applicable direct or outer command receipt or the exact receipt-free source tuple for an outcome-initiated Assistant handoff defined above, canonical failure evidence and terminal publications, no native submission, and no competing execution owner. If an attempt exists, it must be closed with definite non-acceptance and no possible outstanding effect; if none exists, complete durable pre-effect owners must prove that boundary. Do not synthesize AgentSession, AEP, worker-control final status, or backend cleanup. Partial or contradictory proof remains `recovery_required`. This is failure of the same accepted Turn, not a replacement or missing-Turn cleanup path.

A worker's approval or user-input request in a direct Task is a pending request. Raising it leaves the Turn running; the Turn completes, fails, or is cancelled through its ordinary owner, the AgentSession stays bound, and the checkpoint follows that Turn's ordinary terminal path. The response is recorded on the request and delivered to the worker by the next Turn on the Task's Thread, which [Pending Requests](20260930-pending_requests.md) admits and which is part of the same Task. The response causes no separate checkpoint closeout, waiting checkpoint stage, suspension of the source AgentSession, or new `task.start`, and it resumes no paused worker.

Worker final status must satisfy the canonicalization contract in [Worker Turn Reliability Envelope](20260531-worker_turn_reliability_envelope.md#worker-turn-envelope). This version starts from a new data root and reads no earlier-version data ([decision](../decisions/20260930-earlier_version_data_not_carried.md)). A final status outside that contract, or any other contradictory tuple, is preserved as recorded and stays `recovery_required`: Task Mode MUST NOT synthesize a request, publish a receipt, project a human-waiting Turn, offer an answer or approval action, retry, or resume the worker from it.

A Chat-subordinate Task worker raises requests on its receiving Thread exactly as a direct Task does. A user-input request is non-secret elicitation, not authorization: a secret question is refused, and it creates or requires no Approval, policy action, or `PermissionDecision`. The answer command validates the answering actor against the request's responsible user, who is the actor of the outer `conversation.submit` command, or, for a handoff from an outcome-initiated Assistant Turn, the responsible user of the pending request that admitted that Turn. The outer `conversation.submit` receipt, where one exists, remains the sole delegation-ledger owner and is never mutated or re-published; a handoff from an outcome-initiated Assistant Turn is owned by its source tuple in [Chat Mode Assistant](20260704-chat_mode_assistant.md), and no nested `task.start` receipt is required in either case. The answer is delivered on the receiving Thread's next Turn, whose admission keeps the handoff lineage (`parentThreadId`, receiving Thread, and `resultKind=task-handoff`). Receipt lookup precedes mutation; the same answer command identity with the same answer map replays, a changed answer map returns `409 idempotency_key_conflict`, a secret question returns `400 secret_input_not_supported` before any write, and a missing or contradictory request, receipt, or lineage owner returns `409 recovery_required` without worker resume, replacement work, or inferred repair.

### Worker Thread Sandbox Selection

Initial Task admission accepts an exact retained Sandbox reference/revision or fresh creation from an exact admitted template revision under [Persistent Worker Volumes](20260910-persistent_worker_volumes.md). Current members may select another member's eligible Workspace-shared Sandbox; requesting actor and exact resource choice remain separate immutable facts. Direct command identity/hash and conversational or Goal handoff preserve that choice before Coordinator decisions are recomputed. The requested choice stays with existing command/admission lineage; established association/work-slot/native continuity stays with the worker Thread through its existing storage/AgentSession binding. No Task configuration or preference table is added.

Deliver only context and native state admitted by their source owners to the receiving shared destination. A fresh Thread receives its own native conversation and mutable slot even when shared files are accessible. Existing private continuation keeps its exact restricted association. Omission on ordinary continuation uses the exact recorded association/work slot and native pair; a different choice after continuity conflicts before effects without reset, fresh-session fallback or replay. An unconsumed choice may change through ordinary revision-checked Thread intent before first admitted execution, never by retargeting queued or active work. New work without a choice keeps the fresh-retained-storage default from manifest supply; unavailable explicit choices never fall back. The full selection and refusal criteria stay in [Persistent Worker Volumes](20260910-persistent_worker_volumes.md); [User-Selected Workspace-Shared Sandboxes](../decisions/20261008-user_selected_workspace_shared_sandboxes.md) records the ruling.

### Live steer

#### Definition and exclusions

`task.steer` submits an authorized additional user instruction to one Task Thread's exact running Turn and current worker binding. It preserves the Turn, execution attempt, AgentSession, original admission input, selected model, effort, environment, and effect authority. It may influence subsequent worker decisions, but does not undo effects already performed. The [Task Live-Steer Rulings](../decisions/20261008-task_live_steer_rulings.md) record the accepted scope and visible guarantee.

Steer is not a new Task or Turn, a Pending Request answer, Plan approval, Goal intent or card mutation, permission escalation, interrupt, pause, or resume. The runtime selects its native processing boundary; Core selects no safe point and keeps no future-step input list. Native buffering is private adapter behavior, qualified against the same-Turn boundary. Persisted native input never authorizes execution on a successor Turn. A runtime without a qualified same-Turn boundary is unsupported even when it has a native input hook.

The initial input shape is nonempty bounded text only. Non-whitespace text is required, and the exact submitted bytes are retained without normalization. Payload bounds protect the existing control envelope and bounded native exchange; implementation chooses the text limit within those bounds. Model, effort, environment, binary attachments, Artifact references, and new capability selections are inapplicable fields and are refused before effects. A client preserves an inapplicable draft rather than discarding its fields. Ordinary `conversation.submit` remains the explicit path for follow-up text and Artifacts on a fresh Turn.

#### Public operation and actors

The single public entry is `task.steer({ workspaceId, threadId, turnId, requestId, input })`, registered through [Operation Definition](20261002-operation_definition.md). Every field is required; `input` is text and the request rejects unknown effect-bearing fields. The caller supplies no actor, AgentSession, Harness, lease, runtime or native Turn identifier, provider, or configuration. NanoCore resolves the exact current binding from the authorized Task Turn. `pending` worker admission is ineligible; only the addressed running Turn can receive this operation.

The actor must pass current Workspace and Thread access, mutation admission, and the existing `turn.run` execution policy against the exact target. Seeing a Worker does not authorize steering it. Current administrator eligibility, private Thread audience, and effect-specific approval rules remain intact. Missing, inaccessible, or mis-scoped targets use existing indistinguishable absence or denial before content disclosure or work-history writes.

A personal agent invokes this same operation through the existing bearer-authenticated remote MCP `search`, `describe`, and `call` surface. The authenticated Token's user is the actor; audit retains its Token reference and `remote-mcp` channel. This adds no personal-agent identity, token scope, MCP tool family, transport, or worker-to-Core steering channel. The Coordinator may use the same Task service for linked work only through existing trusted invocation and delegated Plan authority. Before delivery, recheck current actor, Goal and card cancellation, and the Plan commitment. Worker MCP exposure still requires explicit supply and authority admission; one worker has no general authority to steer another.

Text describing a new material commitment activates no Plan and grants no governed effect. Intent, Plan approval, Pending Requests, and effect owners retain those decisions. A Goal with several running Tasks requires selection of an exact Task Thread and Turn; there is no implicit recipient or broadcast. The Coordinator's own Thread is not a Task steer target.

| Public outcome | Observable result |
| --- | --- |
| Accepted | Success identifies the same Workspace, Thread, Turn, and input Item with `delivery="accepted"`. The runtime accepted the instruction for native processing during that Turn; model reading, obedience, and completion are not promised. |
| Unsupported | `409 steer_unsupported` means the input or runtime cannot satisfy the qualified live-steer contract. Known lack of support is refused before admission and native contact. |
| Stale target | `409 steer_target_stale` means the addressed Turn ended, was replaced, or no longer has the exact live binding. It never selects a newer Turn. |
| Busy | `409 steer_busy` means a different request occupies the existing Harness operation slot. Refusal precedes Item admission; no backlog is created. |
| Unknown | `409 steer_outcome_unknown` identifies the retained input Item and exact target when dispatch or native acceptance cannot be proved. It is neither success nor definite non-delivery. |
| Other definite refusal | Existing authorization, validation, absence, conflict, and dependency errors retain their owning semantics and safe reason. A post-admission refusal retains the Item and completed refusal receipt. |

#### Durable authority and projections

One ordinary `user-message` Item on the addressed Turn owns the instruction, real actor, exact original text, arrival time, and command causation. Its presence means submitted to that Turn, not consumed by the model. Steer does not rewrite the immutable initiating worker request, Context Package, checkpoint input, or Task admission receipt.

The existing completed command-receipt family admits bounded immutable metadata for `task.steer`: target Turn, input Item id, canonical input hash, accepted/refused/unknown disposition, safe reason, and private-operation correlation sufficient to verify its source result. Receipts contain no prompt copy, native body, or credential. This admission extends receipt serialization only; it adds no receipt lifecycle, pending-command table, or steer store. The Harness record owns private dispatch and result truth. The public receipt retains the product result before that private result can be displaced by another operation.

The authorized timeline and read projection join the Item with its retained result and distinguish `Sending`, `Accepted by running worker`, `Not delivered`, and `Delivery unknown`. Sending exists only while the exact live attempt exists and promises no eventual delivery. A missing completed receipt after ownership loss is unknown, not indefinitely queued. Do not label the instruction applied or read. A late exact acknowledgement may complete a not-yet-completed receipt without changing terminal Turn content; an already completed receipt remains immutable, and no late success or error Item is appended to a terminal Turn. Native history is execution evidence, not product delivery authority.

#### Lifecycle and effect boundary

1. Look up the receipt and existing attempt by immutable command scope before resolving current execution or selecting another target. For a new attempt, validate the whole request, current authority, exact running Turn and live binding, qualified support, payload bound, and free Harness slot. Known failures precede Item, scheduler, and native effects.
2. Under existing exact-Turn mutation serialization, derive the input Item identity from operation, actor, Workspace, Thread, and request id independently of input bytes and target Turn. The canonical hash covers exact text and addressed Turn. Check existing attempt evidence and append that Item durably while the addressed Turn is still non-terminal. This write precedes every possible native dispatch, including after process-local request ownership is lost.
3. Enqueue one private `turn.steer` through [Worker Control Protocol](20260703-worker_control_protocol.md#harness-control-operations). It names the exact binding, Turn and execution-attempt lineage, input Item, and payload digest. Queued storage retains body references; bounded text is materialized only for the authenticated downward exchange. It is typed user content, never interpreted by the control boundary as executable or shell text, an arbitrary path, or new runtime configuration. The shim rechecks exact active native work and invokes the adapter mapping once.
4. The private result is `succeeded`, `refused`, or `unknown`. Success requires the adapter's exact native acceptance evidence, not Core receipt or a successful byte write. Persist the immutable public receipt before releasing the retained private result for slot reuse. A definite refusal discovered after Item admission retains that Item and its refusal receipt; only pre-admission refusal promises zero work-history writes.
5. Completed exact replay returns the original disposition with no native contact or current-target resolution. Concurrent identical calls share one attempt; changed text or target under the same command scope returns `409 idempotency_key_conflict`. An Item or private attempt without a provable completed receipt prevents fresh execution and exposes unknown or existing recovery evidence. Receipt expiry does not turn retained attempt evidence into fresh authority. The caller inspects before explicitly choosing a new request; no automatic resend, follow-up promotion, compensation, or new-request retry is installed.

Item append, Workspace receipt storage, Core Harness storage, and the external runtime are separate effect boundaries, with no cross-store or cross-runtime transaction. A crash between local writes can leave an inspectable Item without delivery. A crash after dispatch can leave an unknown native outcome. Write-before-dispatch and result-before-slot-reuse are required ordering guarantees; an unprovable gap fails closed. If the existing storage seam cannot satisfy either ordering, report that concrete finding rather than adding another durable owner. Steer creates no checkpoint transition, continuation, terminal state, or recovery runner; original Task closeout remains authoritative.

#### Conflicts, failures, and recovery

| Condition | Required outcome |
| --- | --- |
| Missing or inaccessible target, wrong Thread or Workspace | Existing scoped absence or denial, no content leakage or writes; global Worker discovery does not prove access. |
| Turn ends before Item admission | Stale refusal with no Item, native call, new Turn, or fallback. |
| Turn ends after Item admission but before dispatch | Recheck and record definite non-delivery only when absence of dispatch is proved; preserve the Item and never rebind it. |
| Native completion races dispatch | The native exact-active-work guard or qualified adapter boundary decides acceptance. Proven refusal remains refused; uncertain transport or correlation is unknown. A delayed success acknowledges the old Turn only. |
| Exact duplicate or changed request | Replay one retained result or share one attempt for identical scope/input; changed text or target conflicts. Receipt loss or expiry with retained attempt evidence never permits re-execution. |
| Different concurrent requests | The existing single Harness slot admits one; another gets busy before Item admission. No backlog or client-selected ordering is added. Sequential accepted submissions follow the native order the adapter proves. |
| Core restart or reconnect | A never-dispatched queued command proceeds only after exact surviving-binding adoption and fresh target and authority checks. Dispatched effects are never redelivered. An exact retained result may settle the original receipt; missing evidence is unknown under existing admission and cleanup fences. |
| NanoHost or native host restart | A new process is not the old active Turn. Existing continuity owners alone authorize exact surviving-binding adoption; host replacement loses that proof. Retained native input cannot spill into successor admission. Missing cleanup or resume proof makes the adapter unsupported. |
| Harness failure or response loss | After possible dispatch, preserve the original Item and target and report unknown. Do not infer refusal, success, a replacement worker, or automatic retry; existing containment and cleanup owners fence uncertainty. |
| Interrupt races steer | Once interrupt authorization wins before steer dispatch, send no new steer. Already-dispatched input cannot be unsent; interrupt follows its existing owner without promising the text was unconsumed. Record steer disposition separately from the Turn terminal. |
| Slow native acceptance | Use existing bounded control-call and failure discipline, without waiting for model consumption or indefinitely holding the private slot. Unresponsive steer enters unknown and cleanup handling, creates no second interrupt route, and must not weaken the existing interrupt-delivery requirement. |
| Authorization revoked while pending | Revalidate before dispatch and refuse unsent input. After dispatch, preserve truthful uncertainty and apply existing revocation and interrupt rules. Text never restores a revoked grant. |
| Native input can spill into the next Turn | Refuse with `steer_unsupported`; no custom queue, inferred completion, cancel/restart sequence, or cross-Turn promotion may conceal the missing proof. |

#### Observable acceptance

| Proof surface | Required observation |
| --- | --- |
| Request and authorization | Missing exact Turn, empty or oversized text, extra authority/configuration fields, and attachments refuse before effects. Inaccessible private targets disclose no content. Remote MCP and HTTP use the same actor, target, receipt, and errors. |
| Same-Turn acceptance | Exactly one subsequent user Item and one native invocation identify the addressed running Task Turn. Original input, model, effort, environment, attempt, AgentSession, and execution authority remain unchanged; no second Turn or admission exists. Native acceptance evidence is correlated, and the product does not claim model consumption. |
| Replay and write gaps | Observe retained bytes and native invocation counts after faults following Item append, enqueue, dispatch, native acceptance, and before public receipt publication. Recreated owners and same/changed requests never resend a possibly dispatched effect; receipt expiry does not defeat that fence. |
| Races and recovery | Natural terminal, interrupt, revoked authority, reconnect, Core restart, host loss, successor admission, and lost responses preserve exact targeting, truthful refusal or unknown, cleanup fencing, and no stale native-input spill. Slow steer preserves bounded slot settlement and the existing interrupt-delivery bound. Reuse existing restart instruments. |
| Runtime qualification | Each enabled adapter proves the contract at its declared pin through native work, terminal and interrupt races, and retained state across successor admission. Schema presence, a mock, a resolved Promise, or another runtime's pass cannot enable support. |
| Goal and Composer | An exact linked Task receives steer without Goal intent/card/Plan mutation, Goal completion, a Goal input store, a new Goal operation, or a steer-only wake. Card edits alone invoke no native steer; the Coordinator refuses live steer. Unsupported or uncertain Composer submissions retain the exact draft and target without automatic follow-up. |

### Routing and worker selection

Workflow Coordinator must produce one `WorkerCoordinatorDecision`. `decision=worker_turn` enters the bounded delegation branch and the Task Mode service projects a `TaskDelegationDecision` containing:

- selected mode: `task`
- worker target id and agent setup summary
- confidence and routing rationale
- required context package references
- required approvals before launch, which is exactly empty in V1
- expected stop condition
- `escalationRecommended=false`; historical Goal escalation receipts return no Task delegation decision

Rules:

- Before admission, Core retains structural validation, actor and audience authorization, Workspace and Thread eligibility, capability and worker-readiness filtering, command identity and exact replay checks, scheduler admission, and the existing safety and recovery predicates. Invalid input or unavailable authority returns the existing owning typed error without a worker effect. Explicit Task delegation selects a worker and composes the request without semantic reclassification. A failed admission such as no eligible worker returns `409 task_mode_not_delegated` before a Task command record, checkpoint, Turn, Goal, or scheduler effect; it is not a verdict about the caller's natural-language verb. A direct caller may retry the same request id and input because no command was accepted; a conversation-originated attempt returns control to the outer conversation command, which must persist one clarification or refusal tuple rather than claiming a completed Task handoff.
- If no suitable worker is ready, Task Mode returns `409 task_mode_not_delegated` with a typed readiness diagnostic before writing a command record, checkpoint, Turn, pending Task state, or hidden local execution. Because the rejection owns no durable effect or accepted command, the same request id and input may be tried again after readiness changes; once any Task or Goal tuple is accepted, the normal replay rules apply.
- Before calling Coordinator, the Task Mode service must exclude candidates that fail agent catalog readiness, AEP constraints, workspace policy, runtime placement, or requested-capability eligibility. Coordinator selects only among the supplied eligible readiness summaries; neither boundary may restore an excluded candidate.
- Coordinator must not embed adapter-native launch payloads in product records.
- Direct `task.start` or an explicit Chat handoff authorizes only bounded delegation. It does not pre-authorize credential use, destructive operations, publication, or other governed effects; those use their existing in-Turn approval owners. A Coordinator decision that reports a non-empty prelaunch approval list is invalid for V1 and returns `409 task_mode_not_delegated` under the same no-command, no-effect, direct-retry or outer-Chat rule above.

### Worker execution

- Direct Task Mode uses its addressed Thread. A handoff creates exactly one receiving Thread under the lineage rule above and never reuses the originating Thread. Task Mode then writes one `preparing` Worker Checkpoint containing the command request id, canonical input hash, deterministic reserved Turn id, and null Goal and Task ids before launch effects. Its context assembly retains only the context digest, selected context references, and governed Knowledge selection; it does not select or project a NanoCore host repository or `repositoryResourceId`. The selected Agent manifest `sourceRef` and Workspace data-source catalog are the source authority validated before scheduler admission. The worker envelope creates only that Turn and its first scheduler admission; an exact checkpoint with no effects may authorize that one first launch, while a missing or contradictory Thread, checkpoint, Turn, or admission tuple returns `recovery_required` and never creates a replacement. When a synchronous invocation cancels its own first admission with no attempt opened and no submit accepted or unknown, it removes its preparation checkpoint only through [Durable Scheduler Design's live attempt-local exception](20260703-durable_scheduler_design.md#missing-turn-checkpoint-maintenance). The cancelled admission remains authoritative, removal does not authorize replay to launch work, and a later attempt uses a new request. This is distinct from the pre-admission readiness refusal, which creates no scheduler admission and permits the same request to be tried again. A conversation-originated refusal stays with its outer command owner.
- Task Knowledge preparation and public preparation share that governed retrieval and the `knowledge.read` admission in [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md). The Task service assigns `task-mode` as trusted caller context and never accepts it as a caller-supplied field. The Task output and the public output stay the distinct contracts in [Knowledge Manager](20260704-knowledge_manager_internal_agent_runtime.md). Source, audience, and trace authority stay with [Knowledge Store Implementation](20260703-knowledge_store_implementation.md). Retrieval keeps the mutating posture [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md) states when it updates an authoritative index or trace.
- The accepted Task worker input is the complete Coordinator `workerRequest`, never the caller prompt or public Task decision summary. Task Mode sets its exact `reviewContext` field to null, schema-parses the request, and delivers the parsed value as compact JSON through the existing scheduler, AEP, worker, Turn, and `user-message` Item path defined by S15. This text-adapter compromise adds no Task payload row or delivery workflow.
- A direct Task has no Plan version, so its fixed Coordinator defaults are part of this contract rather than caller-controlled pseudo-Task state: `acceptanceCriteria=['The bounded worker task satisfies the requested objective.', 'The worker reports verification evidence or a clear blocker.']`; `resources=[]`; `expectedArtifacts=[{ kind: 'code-change', description: 'Focused workspace changes needed to satisfy the objective.' }, { kind: 'test-result', description: 'Verification evidence from the focused checks.' }]`; `constraints={ maxContextTokens: 240000, maxWorkerIterations: 1 }`, where one worker iteration is the Turn that the Task command starts; later Turns on the Task's Thread are ordinary Turns and do not re-run the Coordinator; `verification=[{ kind: 'manual', description: 'Run the checks named by the worker task or explain why they cannot run.' }]`; `reviewPolicy={ required: false, reviewers: ['human'], instructions: 'Review the worker result, changed files, and verification evidence.' }`; `escalationConditions=['Escalate if a source, tool or authorization required to complete the objective is unavailable or invalid.', 'An empty local work slot alone is not a blocker when admitted tools can complete the objective. Stay within the objective and current authorization, and follow the existing approval requirements for every governed effect.', 'Escalate if the task requires broader decomposition.']`; and `reviewContext=null`. The request contains no `requiresUserConfirmation` or generic stop-condition field; Task Mode has no Task Review producer or hidden completion gate, while independent Artifact, workspace, and governed-effect reviews retain their existing owners. These defaults distinguish a missing prerequisite for the objective from a valid empty work slot under [Session Static Workspace Materialization](20260704-session_static_workspace_materialization.md); platform-managed external hosting follows the selected Gateway-mediated vendor MCP under [Hosting Goes Through The Gateway MCP](../decisions/20261002-hosting_through_gateway_mcp.md) and its existing authorization and approval requirements.
- Worker execution must use the AEP, static workspace materialization, context package, vault injection, and capability gateway contracts where applicable.
- The worker may produce artifacts, evidence, workspace sync reviews, Action Center rows, and final status.
- Sensitive actions still require the relevant approval and permission decisions.

### Completion states

A Task is its Thread and all of its Turns; each worker Turn is bounded, and none starts another on its own. Its state is a projection over those Turns, their checkpoints and evidence, and the Thread's pending requests, not a second durable lifecycle. The active and waiting rows below describe the current Turn or waiting state; the terminal rows describe the last Turn when no Turn is active, no ready outcome is waiting for delivery, and no request is blocking under [Pending Requests](20260930-pending_requests.md):

| Projected state | Required owner tuple |
| --- | --- |
| `queued` | The Task's exact admitted worker Turn is pending before native dispatch, with its original admission and no completion. It may have no AgentSession until dispatch. |
| `running` | A Turn on the Task's Thread is running, or ready outcomes of pending requests await admission of their delivering Turn. |
| `completed` | The Turn and terminal checkpoint prove `stopReason=completed`; unresolved Artifact or Workspace reviews remain independently visible and do not rewrite Task state. |
| `awaiting-human` | No Turn is active on the Task's Thread, no ready outcome is waiting for delivery, and a blocking pending request exists under [Pending Requests](20260930-pending_requests.md): its raising Turn is terminal and no later Turn has started on the Thread. Blocking is computed, never stored. Its answer or decision is delivered by the next Turn of the same Task. |
| `blocked` | Terminal evidence proves `length` or `budget_exhausted`; or no accepted final status exists and the exact scheduler-cleanup, interrupted Turn and AgentSession, and nonterminal checkpoint predicate exposes interrupted-worker recovery. That last case is recoverable interruption projection, not terminal closeout. |
| `cancelled` | An accepted cancellation request causes the Turn to terminate `interrupted` with canonical `stopReason=aborted`, or an accepted worker-control final status canonicalizes to `aborted`, including raw `status=interrupted` with raw `stopReason=aborted`. Cancellation is the Task outcome projected from that interruption; this worker delegation projection does not require the separate Core Turn terminal status `cancelled`. |
| `failed` | Terminal evidence proves `error` and the Turn carries typed failure diagnostics. |
| `escalated-to-goal` | A retained escalation: no Task worker Turn started, and the outer command record and the Task-to-Goal status Item name one escalation. The Goal is named when it still exists. A Goal removed by the accepted deletion is known absence and does not make the receipt unreadable. An explicit Goal selection calls create Goal. |

When no Turn is active, no ready outcome is waiting for delivery, and no request is blocking, the projection is the last Turn's outcome. An older pending request whose raising Turn ended, and after which a later Turn has started, stays independently visible and decidable and does not project `awaiting-human`.

A completed Turn without matching terminal stop evidence is incomplete, not `completed`. A lower-level `continue` outcome is invalid because a Task never starts another worker Turn on its own. Later Turns come from a user message, a delivered outcome, or, when the Task was admitted under a Goal, an authorized Coordinator request. A `continue` outcome returns `task_stop_decision_invalid` without another Turn, checkpoint, or scheduler admission.

`needs-review` is not a V1 Task state. Review remains an independent durable review record and Action Center projection so Task Mode does not invent another review authority.

### Escalation to Goal Mode

A worker should recommend explicit Goal selection when:

- the worker identifies multiple dependent steps
- the task requires plan approval
- the task becomes high-risk or expensive
- the task needs multiple workers or long-running coordination
- the user asks to turn the task into a broader objective

Selecting Task does not implicitly authorize creation of a Goal from prompt keywords. An explicit Goal selection uses the Goal owner's create Goal operation and its visible handoff contract. A worker that discovers the request exceeds a bounded Task reports that limitation and recommends the existing Goal path; it neither creates a Goal nor starts a loop by itself. Goal creation, approval, and completion retain their existing owners. The originating Thread keeps a handoff Item. The Coordinator Thread does not copy or rewrite the original Task attempt's Thread history. An authorized Coordinator request may admit an ordinary Task when the active Plan version authorizes that card. The admitted input cites the card revision and the Plan version. The Task owner still owns the Turn. Historical escalation receipts stay readable. Replay does not recreate a Goal. A Goal removed by the accepted deletion is known absence.

### Readable initiating request projection

The authorized Thread dashboard exposes `taskInputs` as derived `{ itemId, objective }` summaries of structured delegation requests identified by the existing fully verified Context Package trace for each Turn. The trace must identify the exact same-Thread initiating Item and verify its immutable request bytes; a matching JSON shape or Item id alone is insufficient provenance. NanoCore parses that verified Item with the existing structured delegation schema and returns only its objective and Item identity. Missing or inconsistent provenance, unsupported request families, and malformed input produce no summary for that Turn; they do not hide or rewrite its Item. The projection has no storage, mutation, retry, or recovery lifecycle: every read derives it from existing owners under the ordinary Thread audience gate. Web and remote MCP consume the same dashboard field. Web shows the objective and preserves the complete recorded text in an expandable disclosure; ordinary human JSON and unproven input remain verbatim. Acceptance requires exact objective-to-Item matching, preserved original bytes, unchanged ordinary JSON, and no exposure of runtime identity.

### Command response and replay authority

The public Task response is a projection of existing business owners, not a durable Task record and not a copy of the Workflow Coordinator decision. `StartTaskModeResponse` contains the response Turn, its owner-derived state, optional completion from the completed assistant Item, current Item, Artifact, and Review evidence identifiers, and an optional Goal escalation derived from the Goal and the handoff Item when that Goal still exists. The full `TaskDelegationDecision` is an internal launch input that must be persisted and delivered through the accepted worker-request and Context Package owners; it MUST NOT be copied into the command receipt or exposed as an otherwise unowned replay payload.

A fresh worker-starting command returns HTTP 202 once its request scope and canonical caller-input hash, entry-owned checkpoint/context facts, exact pending Turn, and idempotent admission are durable. Publish the complete tuple and the ordinary receipt pointing to that Turn before response and before dispatch eligibility. No execution attempt or AgentSession is required before acknowledging queued work. The admission insert uses the existing command identity: exact input reuses the same row and Turn, and changed input conflicts. The configured queue bound is checked before accepting another request. Across SQLite and files this is a validated complete tuple, not invented cross-store atomicity; an incomplete or contradictory tuple stays inspectable and non-dispatchable as `recovery_required`.

A pending Task projects `queued` with no completion; running and terminal work project their truthful current owners. Capacity deferral retains the same queued Turn, admission, and receipt. This applies to independent Task Threads and preserves one nonterminal Turn per Thread. A queued Turn grants no inference or capability authority. Dispatch later binds exactly one AgentSession and immutable launch package before native start. A later preparation failure is recorded on that same Turn and remains visible through its receipt; a caller told of a real failure still has its queued admission cancelled. Worker execution and terminal closeout proceed independently of response delivery or connection loss and retain their database and process-local ownership until finished. Existing reads and exact replay expose progress; no Task record, response snapshot, polling operation, or queue-specific Turn lifecycle is added. The [execution-backend decision](../decisions/20261006-execution_backend_port_in_nanocore.md) records the superseded admission timing and projection.

An exact receipt replay of a queued or running Turn validates the same request-bound checkpoint/context facts, immutable input, Turn, and exact admission lineage and projects current owner state without waiting for worker completion. It validates an initiating input Item when present, but admission precedes that Item and does not require a terminal StopReason. Missing or contradictory authority returns `409 recovery_required` without a replacement launch. Terminal replay and checkpoint cleanup still require the complete existing backend-specific closeout tuple and applicable durable receipt; early receipt publication never weakens those predicates.

`task.start` uses ordinary current-resource replay and stores no payload snapshot. Its ledger row contains only the normal command metadata and the original response Turn identifier. On replay, NanoCore validates that Turn against the receipt Workspace and either the addressed direct-Task Thread or the deterministic receiving-Thread lineage of the accepted handoff. When the command's handoff Item and the Goal created from it still exist, the projection is `escalated-to-goal`; otherwise the existing bounded worker Turn owns the Task state, completion, and current evidence projection. Missing or contradictory originating Thread, receiving Thread, parent, reference Item, or Turn lineage returns `409 recovery_required`. A missing Goal removed by the accepted deletion is known absence and is not that result. A contradictory non-Goal owner still returns `409 recovery_required`. Replay never reruns the deterministic coordinator, launches another worker, creates another Thread, or creates another Goal. Because this is a current-owner projection, later legitimate Turn progress may advance `state`, `completion`, and evidence while retaining the original lineage.

## Accepted Design

Task Mode composes existing lower-level services: Assistant or UI entry, Workflow Coordinator decision, context package assembly, scheduler placement, worker control, workspace sync/review/apply, Action Center, and evidence records. NanoCore should implement this as a thin workflow service over those contracts rather than a separate runtime.

## Current Implementation Projection

Live steer is an accepted contract awaiting implementation and runtime qualification. The public `task.steer`, private `turn.steer`, receipt metadata, and delivery projection above are required targets, not claims of existing support. No adapter is qualified for this complete contract by the source inspection that motivated it.

NanoCore now has the first distinct Task Mode App API contract and bounded worker-launch path. `@openkit/app-api-schemas` defines `StartTaskModeRequestSchema`, the internal launch projection `TaskDelegationDecisionSchema`, and `StartTaskModeResponseSchema`; `@openkit/core-client` exposes `client.operations['task.start']`; remote MCP and the administrator CLI expose the `task.start` operation; and NanoCore serves `POST /api/app/operations/task.start`.

The route supplies trusted explicit Task entry intent to Workflow Coordinator before launch, skips semantic reclassification, and rejects failed worker admission or a worker decision whose required action is not `none` with typed `task_mode_not_delegated` instead of falling back to hidden local execution, and starts one bounded worker turn through the existing durable scheduler, worker startup, AEP, Workspace data-source `sourceRef`, and turn evidence paths. Coordinator now returns `requiredUserAction=none` for an accepted worker Turn, so the internal Task projection no longer launders an unowned confirmation into an empty approval list. The current automatic project Chat handoff and pending-outcome routing classify prose through the conversational Coordinator path. They do not implement an explicit Assistant Task Tool invocation; that integration remains incomplete and must use the same explicit admission contract once implemented. In the first Knowledge Manager integration slice, matching workspace knowledge becomes `knowledge` refs alongside the default Workspace and Thread refs. Direct Task and Chat-to-Task now schema-parse the complete Coordinator request with `reviewContext=null`, serialize it as compact JSON, and deliver those exact bytes through the scheduler, AEP, worker input, Turn input, and Turn-owned `user-message` Item. S39 persists and verifies the immutable Context Package trace for those exact bytes; complete materialized Knowledge content remains incomplete.

Direct `task.start` no longer creates a Goal from classification keywords. Historical escalation receipts stay readable and replay does not recreate a Goal. Ordinary project Chat retains conversational classification and its existing Goal handoff path.

Historical deterministic L6 evidence covered the Task Mode entry point, a bounded approval Gate, Gate closeout without worker resume, exact blocked replay, and Task-to-Goal escalation without requiring real provider quota, real Codex credentials, or a live OpenShell worker backend. The retired MCP-only story is not an active release gate; the current operation definitions cover `task.start` through remote MCP and administrator CLI, while lower-layer tests retain the Task and Gate invariants. The historical evidence rejects the former simulator-only sequence that continued through a second question Gate into an Artifact. Completed worker results still project the final completed `assistant-message` as `completion.itemId` and `completion.text`; paused or Gate-closed blocked attempts keep `completion: null`. Task Mode evidence remains a projection of existing Turn Item, Artifact, and Workspace Review owners rather than a Task-only evidence store.

The opt-in real OpenShell/Codex L3 runner `apps/nanocore/e2e/task-mode-real-worker-runner.mjs`, invoked by `pnpm -w test:e2e:real-task-mode`, validates the real worker path against an existing NanoCore deployment. The gate requires explicit real-worker and provider-quota opt-in, uses the deployment-admin runtime-config owner to create one credential-free HTTPS Git catalog entry with an exact commit, safe-reloads that session-scoped catalog without restart, invokes `client.operations['task.start']` through the separate product client, accepts the admitted Turn, waits through existing `turn.read` and exact `task.start` replay for owner-derived `completed` Task state, treats any returned reviews only as independent cleanup work, requires visible thread items, requires at least one completed assistant-message item from the worker path, and writes only redacted evidence. It never calls `repositories.setDefault` or supplies a NanoCore host repository path. This runner proves the worker integration boundary; remote MCP and `task.start` CLI projection are covered separately and do not require a duplicate real-worker runner. The a1 acceptance run passed against NanoCore on `http://127.0.0.1:54001` with `openkit/worker-codex:dev`, Codex auth/config injection, model `gpt-5.5`, and a real OpenShell sandbox. Worker-shim failure transcripts now preserve redacted stdout/stderr diagnostics for failed Codex launches, and NanoCore retries transient OpenShell provider detach conflicts so cleanup races do not mask worker outcomes.

Direct `task.start` and the Assistant automatic Task handoff return at validated durable admission while the observed worker envelope retains execution ownership through closeout. The direct receipt immediately binds the admitted Turn; exact live replay uses checkpoint and scheduler input authority before the initiating Item is available. Terminal checkpoint collection remains receipt-first and requires complete closeout. The current direct `task.start` path derives its Turn and downstream scheduler lineage from the complete command identity, writes the request id and canonical caller-input hash into the existing checkpoint before launch, delivers the complete structured Coordinator worker request through the Turn-owned input Item, and validates replay or missing-receipt recovery against that Item, checkpoint, Turn, AgentSession, agent, lease, canonical event, evidence, and backend-specific closeout tuple. Exact receipt replay and owner-without-receipt classification do not rerun Coordinator or the worker; contradictory input, an incomplete owner tuple, or an unsafe receipt gap fails closed as `recovery_required`. Online and restart WorkerGovernance closeout preserve the same accepted non-Gate canonical outcome instead of laundering every non-completed worker status into `error`.

Before the redesign, direct Task structured user-input and approval Gates used the exact shared closeout that pending requests replace: the response or decision Item closes the old Turn and AgentSession without adapter continuation, retains the Gate pair as evidence, applies the fixed Task projection, releases scheduler ownership, publishes the response receipt, and only then permits checkpoint deletion. This works for the bounded in-process tuple and for an AEP-backed Gate only when its accepted final status, backend cleanup, workspace handoff, and full Gate lineage agree. A raw AEP `blocked/ask_user` without an exact Core Gate takes the bounded S05 interruption fallback and remains `recovery_required`; it is not converted into a Task Gate. Partial or contradictory Gate writes remain inspectable as `recovery_required`, not repair instructions.

Conversation-subordinate user-input Gate closeout and the required receiving-Thread handoff lineage are not implemented yet. The current shared closeout accepts only direct `task.start` ownership. The legacy Goal `goal.step` closeout leaves with the new Goal implementation and is not this contract. The current legacy Chat handoff still derives the worker Turn from the originating Thread, so this specification remains Partial until the outer `conversation.submit` validation and new-Thread branch above are implemented and verified without a nested Task receipt or copied worker history. The accepted design replaces that Gate closeout with a pending request whose answer does not close the raising Turn.

Boot now fences scheduler and worker-control state before scanning direct Task checkpoints with the same owner classifier used online. It closes or cleans only a complete direct-command tuple, preserves live or reconnecting work, and leaves every missing, conflicting, outer-command, or otherwise unprovable tuple discoverable while readiness reports `recovery_required`. Accepted S39 Context Package trace materialization is implemented; this specification remains Partial because complete Knowledge content delivery is still incomplete. That gap must reuse the named owners and may not add a Task row, settlement workflow, compatibility path, or Task-specific recovery state.

## Alternatives Considered

- Use a Goal for every delegated task. Rejected: simple tasks should not require an approved Plan version.
- Let Assistant start worker turns directly. Rejected: worker delegation belongs to Workflow Coordinator.
- Support multi-worker task orchestration in V1 Task Mode. Rejected: multi-worker coordination belongs to a Goal unless a future accepted task recipe needs it.

## Consequences

- Users get a direct path from request to worker result for ordinary delegated work.
- A Goal remains reserved for a continuous outcome.
- Task Mode creates a clear implementation target for worker delegation before full long-running coordination.

## Testing Strategy / Acceptance Criteria

- L1: routing and worker-selection unit tests.
- L2: contract tests for `TaskDelegationDecision`, required request identity, item projection, exact owner-derived states, and absence of a Task-only state or review record.
- L2: Turn A raises a user-input request and ends; Turn B then starts and completes without answering it. The Task projects B's settled outcome, the request is not blocking and remains decidable, and no blocking flag is stored.
- L3: NanoCore black-box test for direct Task Mode execution with one deterministic worker.
- L2: held-worker canonical JSON and remote MCP calls return schema-valid admission and durable Turn-pointer receipts before completion is released; exact live replay returns current state and changed input conflicts with exactly one launch and admission. Release proves canonical Turn and assistant Item reads, same-lineage terminal replay and completion, and exactly-once attempt and checkpoint closeout. A controlled post-admission failure preserves the receipt and inspectable owners without hidden relaunch. Assistant automatic Task handoff obeys the same event ordering while retaining the original Assistant result and downstream lineage.
- L3: prove the exact Coordinator-composed worker request and authorized context references reach the materialized worker input.
- L3: same-request replay returns the original Task or escalated Goal lineage, including the original scheduler admission or the Goal when it still exists, while a conflicting payload, including a changed Sandbox or template choice under the same request identity, returns `idempotency_key_conflict`; exact replay creates no extra effect, and conflicting input creates no effect. A deleted Goal is known absence and is not recreated.
- L3: a conversation-subordinate non-secret user-input answer is accepted only for the exact actor, Workspace, originating and receiving Threads, request hash, pending request on the deterministic Task Turn, and outer `conversation.submit` task-handoff receipt or, for a handoff from an outcome-initiated Assistant Turn, its exact source tuple; the answer is recorded on that request and does not close the raising Turn, and delivery is a later Turn of the same Task. Exact answer replay duplicates no Item, cleanup, release, receipt, or checkpoint deletion, changed answers conflict, owner mismatch fails closed, restart never resumes the raising worker Turn, and no nested `task.start` receipt exists.
- L3: explicit Task instructions mentioning Goal or plan admit bounded worker work without creating a Goal; historical Task-to-Goal receipts still replay without recreating a Goal.
- L6: story acceptance where a user delegates a bounded task, sees worker progress, reviews output, and receives a final answer.

Acceptance: explicit Task selection always runs through Workflow Coordinator for one bounded worker attempt when hard admission predicates pass, preserves the instruction bytes, records visible state, and never silently becomes a Goal or hidden local execution. Explicit Goal selection calls create Goal through its existing owner. A Coordinator-admitted Task remains an ordinary Task.

## Risks & Mitigations

- Risk: Task Mode grows into an unbounded loop. Mitigation: every worker Turn is bounded, no Turn starts another on its own, later Turns come from a user message, a delivered outcome, or an authorized Coordinator request on a Goal-admitted Task, and pending requests are bounded per Thread. Standalone Task Mode does not gain a loop.
- Risk: Coordinator selection becomes opaque. Mitigation: record routing rationale and selected worker summary.
- Risk: simple task failures are hard to recover. Mitigation: stable completion states and Action Center recovery rows.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: Task Mode performs no automatic worker retry. A user-requested retry is an ordinary new Turn on the same Task Thread with a new request id, and the prior attempt remains unchanged in Thread history; there is no hidden replay, Task-specific causation record, or retry lifecycle. The Thread's current AgentSession may serve the retry, which is not a resume of the prior Turn. Every Chat-to-Task handoff creates a new receiving Thread in the executing Workspace, links it to the originating Chat Thread through `parentThreadId`, and leaves only a handoff reference Item in the originating Thread.

## Deferred / Future Work

- Multi-worker Task Mode recipes.
- Task templates.
- Automatic task decomposition without a Goal.
- Task-level saved presets.

## Links

- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20261002-goal.md`
- `docs/specs/20260704-workflow_coordinator_internal_agent.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-workspace_synchronization.md`
