---
status: Accepted
implementation: Not Started
kind: concept
date: "2026-09-30"
updated: "2026-09-30"
---
# Pending Requests

## Owns

- The pending request concept for approval requests and user-input requests: its definition, its durable record, and its lifecycle of raise, resolve, end, and deliver.
- The captured call binding of an approval that governs a call, the claim that makes its execution at most once, and the recorded execution disposition.
- The publication of a request's outcome as Items, the delivery association between the outcome and the Turn that delivers it, when such a Turn is admitted, and the closeout of an outcome that no requester can receive.
- The per-Thread bound on outstanding requests, the invalidating events, and the mapping of outcomes onto Approval status.
- The semantics of the answer and withdraw commands, and the pending-request semantics of the existing approval response command.
- The canonical-load validation of the record against its Items and receipts.

## Does Not Own

- Turn lifecycle, Turn triggers, and Item semantics, owned by `docs/core/protocol.md`, which states the pending request semantics this specification implements.
- The Action Center card and its controls, owned by [Human Attention And Intervention Model](20260531-human_attention_intervention_model.md).
- Gateway MCP transport, catalog, schema snapshots, and upstream execution, owned by [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md).
- Built-in tool identity, the tool call envelope, and `CapabilityCall`, owned by [Worker Agent Capability](20260703-worker_agent_capability.md).
- The repository push effect, its barriers, and `GitPushRecord`, owned by [Git Write Workflow](20260704-git_write_workflow.md).
- Policy evaluation and `PermissionDecision`, owned by [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md) and `docs/core/permissions.md`.
- Goal Plan, Goal Review, Artifact Review, Workspace Sync Review, and Knowledge Review, which keep their own durable identity and already accept a response after their source Turn is terminal.
- Goal Mode execution, which is unavailable until the Goal redesign.

## Core References

- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/permissions.md`
- `docs/core/work-model.md`
- `docs/core/agent-session.md`

## Related Docs

- [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md)
- [Worker Agent Capability](20260703-worker_agent_capability.md)
- [Human Attention And Intervention Model](20260531-human_attention_intervention_model.md)
- [Task Mode Worker Delegation](20260704-task_mode_worker_delegation.md)
- [Git Write Workflow](20260704-git_write_workflow.md)
- [Chat Mode Assistant](20260704-chat_mode_assistant.md)
- [Work Data Retention Format](20260921-work_data_retention_format.md)
- [Delayed User Input](superseded/20260921-delayed_user_input.md), historical evidence from the Draft this specification supersedes
- [Earlier-version data is not carried](../decisions/20260930-earlier_version_data_not_carried.md)

## Summary

An agent that needs a person's approval or answer raises a pending request and keeps working. The request is durable, is not a Turn status, and has no default deadline. The responsible user resolves it out of band. For an approval that governs a tool call, the gateway then re-evaluates the captured call against current facts and executes it at most once. The outcome reaches the agent on a later Turn of the same Thread. One record owns both kinds of request, and every producer that used to pause a Turn in `awaiting_human` moves onto it.

## Goals / Non-goals

Goals:
- One mechanism for every approval and every user-input request, whatever the requester, with a variable approver of which only the responsible human is activated.
- The approver sees exactly the effect that will execute, and nothing depends on the agent reproducing its arguments.
- A request survives the end of the Turn and of the AgentSession that raised it.
- A late answer is a legitimate arrival, not a recovery error.

Non-goals:
- A default deadline or expiry timer. A configurable deadline policy may be added later.
- An agent approver. The approver field exists; no agent approver is activated.
- Agent-initiated withdrawal. It is designed here, aligned with MCP `tasks/cancel`, and not enabled, because the MCP draft is unreleased.
- Native MCP Tasks on the wire. The semantics already align with SEP-2848, so a later switch changes only the wire.
- A ninth pending-request owner, a second list of waiting work, a fifth Turn terminal, or a new Turn status.
- Secret answers. A secret question stays visible and cannot be answered.

## Background

The earlier design coupled both request kinds to the Turn. An approval or question set the Turn to `awaiting_human` with a `humanGate`, the worker was stopped through a `human-gate` interrupt, its AgentSession was suspended and then closed, and a later Task claimed a granted MCP effect by re-proposing the call within one hour. The engineer ruled that this came from binding the AgentSession and Turn lifetimes together, and replaced it with the decisions recorded in [pending tool calls](../decisions/20260930-pending_tool_calls.md), [no default deadline](../decisions/20260930-pending_requests_have_no_deadline.md), and [AgentSession as an execution binding](../decisions/20260929-agent_session_is_an_execution_binding.md).

The superseded Delayed User Input Draft gathered evidence that this specification carries forward without repeating it:
- **Eight owners.** Eight pending-request owners exist. Four of them, Goal Plan, Goal Review, Artifact Review, and Workspace Sync Review, already accept a response after their source Turn is terminal and keep independent durable identity. Approval and user input were the only two whose admission and lifecycle stayed on the Turn. This specification decouples those two. It is their durable record, not a ninth owner, and Action Center stays the one list of waiting work.
- **Late answers looked broken.** A late answer to an approval surfaced as `recovery_required` because the gate was no longer exact and active. `recovery_required` stays correct for a missing receipt, a contradictory owner, or an interrupted effect, and is never the result of a person simply answering late.
- **Unused statuses.** `expired`, `superseded`, and `withdrawn` were declared with no production writer, and the one-hour MCP expiry was a read-time check while the Approval stayed `pending`.
- **Link-back.** Link-back uses the Item `id`, an in-package reference that import remints through exact identity mapping. It may fail to resolve and must never point at the wrong record. `seq` is only a per-file truncation counter.
- **Configuration apply.** A configuration apply is a late response to an earlier proposal. Its marker Item belongs on the Turn that executes the apply, with link-back to the proposing Item, and is never written onto an already terminal proposing Turn.
- **Ending evidence.** Evidence that a request ended carries the request identity, the reason, the deciding actor, the time, and a link back to the initiating Item. `StatusItemSchema` has no structured slots for those facts, so this record holds them and the Item carries a readable summary; no new retention container is added.

## Decision

A pending request is the durable record of one approval request or one user-input request. It is raised by a governed call or command, resolved or ended by a person or an invalidating event, and delivered to its requester by a later Turn on the same Thread. Raising it never changes the status of the Turn that raised it. The record is the source of the request's state and of the Approval status, and Items remain its communication record.

## Contract / Expected Behavior

### Definition And Exclusions

A pending request has one kind, `approval` or `user-input`, and one requester:
- **A worker agent**, which raises it through a governed MCP call: an approval-required external tool, human-mode `repository_push`, or the built-in `work_request_input` tool.
- **The internal Assistant**, which raises a clarification question in Chat Mode, and later an approval-required MCP call when its internal branch is implemented.
- **A person**, whose own governed command requires another decision, such as a human-mode host push through the App API. A grant for a person's request executes nothing by itself; the person or external coordinator performs the governed command afterward through its owner, as the Git owner's host execute command does.

Exclusions:
- In-Sandbox tool use never raises an approval.
- A native runtime permission prompt is refused and never becomes a request.
- A review verdict is not a request here; it stays with its own owner.
- A native effect that has no gateway operation cannot be approved.

### The Record

The workspace record `PendingRequest` holds:
- identity: the request id, which is the `approvalRequestId` or `userInputRequestId` already used by Items, plus the Workspace, the Thread, the raising Turn, and the request Item;
- `kind` and the requester, with its Agent and AgentSession where the requester is an agent;
- the responsible user, who alone may resolve or withdraw it today;
- `state`: `pending`, `resolved`, or `ended`;
- for a resolved request: the resolution (`granted`, `denied`, or `answered`), the deciding actor, the decision time, and, for an answer, the answer map;
- for an ended request: `withdrawn` or `invalidated`, the invalidating event, the ending actor, and the time;
- for an approval that governs an agent's captured call, the captured call binding: server id, catalog revision, schema snapshot, tool, the full canonical arguments and their digest, and the originating authorization context, which is the Thread, Turn, AgentSession, Agent, responsible user, package digest, and policy decision;
- for a person's approval, the exact intent of the governed command it authorizes, such as the host push intent;
- for either kind of approval, the claim (`unclaimed`, `claimed`, or `finished`), the execution `CapabilityCall` id derived from the request id, the disposition (`approved-executed`, `denied-not-executed`, `execution-error`, or `outcome-unknown`) with its reason, and the bounded normalized result held for delivery;
- the publication Turn: the one Turn on which the outcome's Items are written, set once and never moved, and, for a person's grant invalidated after its decision, the separate invalidation Turn of that invalidation's `status` Item, which is absent until its publication is admitted and is then set once before the Item is written, while the recorded `denied-not-executed` stays durable as it waits;
- the delivery state: `undelivered`, `frozen` with the delivering Turn id, `delivered` with that Turn id, `delivery-unknown` with that Turn id, or `closed-out`, which states that no delivery to the requester followed and none will, and asserts nothing about what the requester saw.

The ApprovalRequest projection reads its status from this record; approval state is never derived from Items. Arguments and results are sensitive work data: they are never copied into usage or audit rows, and the held result is cleared once its delivery is proved. The record is a Workspace SQLite family under the storage layout owner's schema rule.

### Exact Effect Disclosure

An approval's exact effect detail is a read-only projection of its immutable captured binding. For a captured MCP call it contains the server id, tool name, argument digest and the complete canonical arguments. For a repository push it contains the repository, source ref, commit ids and target branch. It never contains a resolved credential, a private endpoint or runtime internals.

Cards, Items and attention lists carry a summary of at most 2,048 UTF-8 bytes and never the raw captured arguments. Only the request's responsible user, with current access to its Thread, can read the complete detail. The detail is at most 524,288 bytes of compact canonical UTF-8 JSON. Detail is unavailable if it exceeds that limit, cannot be loaded completely, or cannot be shown without omitting an effect-bearing value. Truncated or redacted content is never presented as exact.

Grant requires available exact detail. The response command checks this before it records a grant. When detail is unavailable, the command returns `409 approval_preview_unavailable` with no grant, no claim and no upstream contact, and the request stays open. Deny and withdraw remain available. No preview-read record is created. The decision is recorded in [a decision record](../decisions/20261001-approval_exact_effect_disclosure.md).

### Raise

Raising runs inside the governed call or command, in this order:
1. The caller's current authorization is evaluated, and the Thread must not be archived. A call that is not requestable fails as `capability_denied` and records nothing.
2. **Deduplication.** A repeated call matches a `pending` request on the same Thread when it has the same qualified binding: server id, catalog revision, schema snapshot, tool, canonical arguments, Agent, and responsible user. A repeated `work_request_input` matches when it has the same Agent and the same canonical question payload. A match returns the existing request's pending result and records nothing new. It never substitutes an earlier effect for a different one, and it does not decide whether two calls after a terminal outcome are the same occurrence.
3. **Bound.** A Thread holds at most 16 `pending` requests. A raise over the bound fails as `request_limit_reached` before any write.
4. **Recording.** The request, the ApprovalRequest projection for an approval, and the request Item on the raising Turn are written together. The raising `CapabilityCall` is recorded as `denied` with no upstream contact for an approval, and as `succeeded` for `work_request_input`, whose function is to record the question.
5. **Pending result.** The call returns at once with the same pending fields in its structured and text content: `status` (`pending-approval` or `pending-input`), the request id, and a next-step sentence telling the agent that the outcome will arrive on a later Turn and that it must not call again to claim it. An approval's result is `isError: true`, because the tool has not executed. A `work_request_input` result is `isError: false`, because recording the question is the tool's function.

A call that policy allows without approval is not a pending request. Automatic-mode repository push is the one accepted automatic grant: the policy grants at once, the push executes inside the call, and its Approval record is written already `resolved`, `granted` by the policy actor `nanocore-repo-push-policy`, with nothing to deliver. A policy grant is never presented as a human decision and is not an agent approver.

### Resolve

- **Approval.** The existing approval response command, `POST /api/approvals/{approvalRequestId}/respond` with `granted` or `denied`, is accepted while the request is `pending`, whatever the status of the raising Turn.
- **Answer.** The command `user_input.answer`, projected as `POST /api/user-input-requests/{userInputRequestId}/answer` with the Workspace, Thread, command `requestId`, and `answers`, is accepted while the request is `pending`. The answer rules are unchanged: `answers` is `{ [questionId]: [string] }` with exactly one non-empty value per question, the keys equal every and only the request's question ids, a missing or extra key or a duplicate question id is `400 invalid_request`, and a request containing a secret question returns `400 secret_input_not_supported` before any write. It replaces the answer branch of `turn.input.submit`.

Rules shared by both commands:
- **Actor.** Only the responsible user may resolve, with current Workspace membership and authority. Another actor gets `workspace_access_denied`.
- **Replay and conflict.** One response wins. An exact replay returns the recorded outcome through the command receipt. A different decision or answer map for the same request is `409 idempotency_key_conflict`. A response to a request that is already resolved or ended returns `409 request_not_pending` with the recorded state, before any write.
- **Missing owner.** A request whose record, Item, or projection is missing or contradictory returns `409 recovery_required` without writes. A slow answer is never that case.

Recording a denial or an answer sets `state=resolved` with the resolution, the actor, and the time; a denial moves the Approval to `denied`, and a denial of an approval that governs a call records `denied-not-executed` in the same write. A grant of an approval that governs an agent's captured call is recorded only together with its execution decision, as the next section defines, so such a grant is never published unclaimed. A grant of a person's request is recorded as `resolved` and `granted` with its claim `unclaimed`, and the person's own governed command claims it later. The Approval moves to `granted` with the grant. The command's receipt is published after any disposition is recorded.

### Execute A Granted Call

Execution after a grant, for an approval that governs an agent's captured call, runs inside the approval response command and never in a background process:
1. **Resolution of asynchronous inputs.** A value that needs asynchronous resolution, such as a credential read from the Vault, is resolved first.
2. **Re-evaluation, grant, and claim in one step.** One synchronous step of NanoCore's single writer, with no suspension inside it, evaluates against the captured binding the state that another command can change: the request is `pending`; the Thread is not archived or deleted; the current Workspace membership and authority of the responsible user and of the requesting Agent; the Thread's current supply for that server and tool; the current schema snapshot; current policy; and the Vault grants behind the values resolved in the first step. For a push, the Git owner's barriers apply: host commit, review linkage, current Vault, and target. In the same step, the compare-and-set on the request records the grant with its actor and time, and either sets the claim to `claimed` with the execution `CapabilityCall` id when every check passed, or records `denied-not-executed` with its reason and leaves the claim `unclaimed` when one failed. A failed Thread, membership, or Agent check is an invalidating event, which ends the request as End defines instead of granting it.
3. **Execution.** The gateway executes the captured call exactly as bound, or the Git owner runs the push for exactly the bound intent, with the ordinary timeout and result bounds.
4. **Disposition.** The claim moves to `finished` with `approved-executed` (the call succeeded), `execution-error` (it failed and its outcome is known), or `outcome-unknown` (contact may have happened and the outcome cannot be established). The execution `CapabilityCall` is recorded as `succeeded`, `failed`, or `unknown`, with its upstream-contact knowledge. Usage follows the ordinary rule: none when upstream is proved not contacted.

The step in point 2 is the linearization point for authority. A revocation, withdrawal, archive, or response that commits before it is seen by it; one that commits after it finds the request already granted and claimed, and the call proceeds under the authority current at its claim. A `pending` request therefore moves to exactly one of: granted and claimed, granted and not executed, denied, answered, granted for a person, or ended. A claimed request can no longer end, and an ended request can no longer be claimed.

A person's grant waits for the person's own governed command, such as the Git owner's host execute command, which claims it through the same kind of step after its owner's own checks. An invalidating event before that command records `denied-not-executed` with the event as its reason, which is terminal and prevents a later claim; the recorded grant stays, and the command then fails before any effect.

A denial records `denied-not-executed` without re-evaluation. A crash before the step leaves the request `pending`, and the command's incomplete receipt returns `recovery_required` to a replay of the same command without any execution. After a restart, a claim that is `claimed` and not `finished` becomes `outcome-unknown` and is never executed again, even when no contact was made; a push attempt without a `GitPushRecord` keeps the Git owner's unknown-outcome rule and is never retried.

### End

A pending request ends without resolution:
- **Withdrawal.** The command `pending_request.withdraw`, projected as `POST /api/pending-requests/{pendingRequestId}/withdraw` with the Workspace, Thread, and command `requestId`, lets the responsible user withdraw a `pending` request. The Approval becomes `withdrawn`. Agent withdrawal is defined with the same effect and is not enabled.
- **Invalidating events.** Archive or deletion of the Thread, which are the operations that close a Thread, deletion of the Workspace, loss of the responsible user's membership or authority, and removal of the requesting Agent or loss of its authority. The Approval becomes `expired`. The command that archives or deletes a Thread, or deletes a Workspace, ends that scope's pending requests in its own write, and archive closes out the Thread's outcomes as Closeout defines. Loss of membership or authority is detected and written at the next response, withdrawal, execution, or delivery attempt; no process scans for it.

Ending sets `state=ended` with the reason, actor, and time, through the step that Execute A Granted Call defines.

Release, replacement, or failure of the requesting AgentSession does not end a request; neither does the end of the raising Turn, a restart, or elapsed time.

### Deliver

An outcome is a resolution with its disposition, where there is one, or an ending. It is ready when it is final: an answer, a denial, an ending, a grant of an agent's captured call whose disposition is recorded, or a person's grant, which is ready at once as a decision because the person performs the effect afterward. A granted approval whose execution is still running is not ready. Every ready outcome is delivered to its requester, including a withdrawal, so that the agent does not wait for an answer that will not come; an outcome that no requester can receive is closed out instead.

Matching an outcome to a Turn:
- An outcome is delivered only by a Turn whose executor is its requester: a worker outcome by a worker Turn on that Thread, an Assistant outcome by an Assistant Turn, and a person's outcome by a Core-local Turn.
- A Turn admitted for any cause, such as a user message or a retry, freezes into its input the ready, `undelivered` outcomes that match its executor, in readiness order, up to 16 per Turn, and keeps its own trigger. Freezing sets `delivery=frozen` with that Turn id in the same write as the Turn's admission. The rest wait for the next Turn.
- When matching outcomes are ready and no Turn is being admitted, Core admits an outcome-initiated Turn for them. Its trigger is `approval-resolution` when it carries any approval outcome and `user-input` otherwise, with a summary naming the counts, and its trigger actor is the deciding user of the first outcome, or the system for an ending.

The 16-outcome limit bounds how many outcomes a Turn carries, not their bytes. There is no aggregate input byte budget. Delivery carries every selected value completely and never truncates, drops or summarizes one. Each producer and transport keeps its own limits and typed refusals. A large input can therefore be refused downstream by an executor. That refusal is handled by the existing delivery rules. The decision is recorded in [a decision record](../decisions/20261001-pending_delivery_count_bound.md).

When admission is attempted, with no polling process:
- when an outcome becomes ready while the Thread has no non-terminal Turn, which is inside the response, answer, or withdraw command, after any execution;
- at the terminal barrier of every Turn on the Thread, except the barrier of an outcome-initiated worker Turn refused before native submission, whose released outcomes wait for the next other trigger so that a Thread whose agent cannot start does not loop;
- at boot, after scheduler fencing, for each Thread with ready `undelivered` outcomes and no non-terminal Turn.

Only one outcome-initiated Turn is admitted at a time. When several executors have waiting outcomes, the worker or Assistant Turn goes first and a person's outcomes follow at the next idle point.

Execution and the proof that ends delivery, per executor:
- **Worker requester.** The Thread's worker Agent runs the Turn, which is created `pending`, is admitted under current authority, and waits for worker scheduler capacity. The frozen outcomes enter its worker input as structured context: each request, its resolution or ending, and, for every approval that governs a call, the disposition with its reason and any bounded result. The Turn runs on the current AgentSession, or on a successor that resumes the native conversation when that binding has ended. Delivery is proved by native submission.
- **Assistant requester.** The Chat Mode owner runs the Turn with the answer as the clarified input, with no AgentSession and no worker scheduler capacity. Delivery is proved when the Assistant service durably accepts the Turn input.
- **Person requester.** A Core-local Turn records the Items and completes, runs no agent, and needs no scheduler capacity. Delivery is proved by that Turn's completion, written together with its Items.

**Publication.** An outcome's Items are written once, on its publication Turn, which is the first Turn that freezes it or its closeout Turn. The record names the publication Turn in the same write that freezes the outcome, before the Items are written. Each Item's id is derived from the request id and the Item's role (request, decision, answer, disposition, ending, or invalidation), so a publication is identified exactly. Restart completes an incomplete publication on its named Turn, after scheduler fencing and before any command is admitted, by writing only the missing Items of that already-decided outcome, which Core admits as completion of an already-decided publication; it never publishes the outcome elsewhere. A later Turn that delivers the same outcome, after a refusal proved before delivery, carries it as structured input that references those Items, and writes none. The Items, written as input before any agent output:
- an `approval-decision` Item for a resolved approval, with its actor, decision, `decidedAt`, and causation to the request Item;
- a `user-input-response` Item for an answer, with its actor, answer map, `answeredAt`, and causation to the request Item;
- for every granted approval that governs an agent's captured call, its disposition: a `tool-call` Item authored by Core when the call was claimed, with `approved-executed`, `execution-error`, or `outcome-unknown` and a bounded, redacted result summary where one exists, or a `status` Item stating that the call was not executed and why, for `denied-not-executed`;
- a `status` Item for an ended request, whose summary states the reason and whose causation is the request Item.

`decidedAt` and `answeredAt` are required on those Items. No Item is ever back-filled onto the raising Turn.

A person's grant is delivered as a decision only: its Core-local Turn writes the `approval-decision` Item. The effect and result of the person's later governed command are published by that command's owner, such as the Git owner's push record, and never by redelivering the request. A `denied-not-executed` that an invalidating event records later for a person's grant is a separate fact, published on its own Core-local invalidation Turn that the record names separately. That publication is admitted by the invalidating command when the Thread is idle, at the Thread's next terminal barrier when a Turn is running, or at boot after scheduler fencing when no non-terminal Turn remains; its admission does not depend on the decision being undelivered. It has the same three phases as any publication: while it waits there is no invalidation Turn and no invalidation Item; a named invalidation Turn with its Item missing is an in-progress publication; and a completed one has exactly one matching invalidation `status` Item on that Turn. Its Item id is derived from the request id and the invalidation role, and the same id, content, Thread-lineage, and restart-completion checks apply to it independently of the decision's publication, so a named incomplete invalidation publication is completed before ordinary command admission. Publishing the invalidation never moves or republishes the decision and does not itself change the decision's delivery state; archive closeout may independently change an undelivered decision to `closed-out`.

Outcome of delivery:
- The executor's proof sets `delivered` and clears any held result.
- A refusal proved before that proof returns the frozen outcomes to `undelivered`, with their publication Turn kept.
- When that proof is unknown, as when native submission or the Assistant's input acceptance cannot be established, the outcomes are set to `delivery-unknown`. They are never resubmitted automatically; the Turn follows ordinary recovery, and a later user message does not re-deliver them.

### Closeout

An outcome is closed out rather than delivered when no requester can receive it: its Thread is archived, or its requesting Agent is removed from the Thread or loses its authority. Closeout never takes an outcome that is `frozen`, `delivered`, `delivery-unknown`, or already `closed-out`: a frozen outcome stays with its delivering Turn, whose proof decides it. Closeout Items, like delivered Items, are never written onto the Turn that raised the request or onto another run's Turn; they go on a Core-local service Turn with trigger `system-input` that runs no agent, needs no scheduler capacity, has no input bound, and completes in the command that writes it.

Archive closes out inside the archive command, in this order:
1. **Refusals.** Archive fails before any write with `409 request_executing` while the Thread holds a claimed, unfinished execution, and with `409 thread_busy` while the Thread has a non-terminal Turn and archive would end a pending request, select an outcome, including one frozen into that Turn, or publish an outstanding person-grant invalidation, even one recorded by an earlier command for a decision already delivered. The caller retries after the execution finishes, or after the Turn ends or is interrupted. Archive of a busy Thread with nothing to close out is not refused.
2. **Selection.** The pending requests the archive ends, the person's grants it turns into `denied-not-executed`, and every other final outcome of the Thread that is `undelivered`. Any already-recorded person-grant invalidation whose status publication is outstanding is selected independently of the decision's delivery state.
3. **Publication.** A selected outcome that already has a publication Turn, because an earlier delivery attempt was refused, gets no new Item. Every other selected outcome gets its Items, as Deliver lists them, on one Core-local closeout Turn. For a person's grant turned into `denied-not-executed` by this archive, or a selected outstanding invalidation, Core writes the invalidation `status` Item on that closeout Turn; that Turn serves as the invalidation Turn defined in Deliver.
4. **Result.** Only selected original outcomes become `closed-out`. Publishing a separate invalidation leaves the decision's delivery state unchanged, so a decision already delivered remains `delivered`. All of this is written before the Thread's archived status, so no Turn is ever admitted to an archived Thread.

Loss of the requesting Agent's authority closes out that requester's final outcomes that are `undelivered` in the same way: in the command that detects the loss when the Thread has no non-terminal Turn, and otherwise at that Turn's terminal barrier, where admission finds that the requester can no longer execute and admits the Core-local closeout Turn instead of a delivering Turn.

A closed-out outcome is never delivered later, even when an archived Thread is restored, and an ended request is never reopened. Deleting a Thread or a Workspace deletes its requests with its history under the deletion owner and writes no Item.

### Blocking And Presentation

A `pending` request is blocking when its raising Turn is terminal and no later Turn has started on its Thread. Blocking is computed from those facts, never stored, and changes presentation only. Action Center shows every `pending` request as decidable until it is resolved or ended, with its age, the number of Turns since it was raised, and whether it is blocking. A request remains decidable after its raising Turn completes.

### Conflict, Missing, Stale, Restart, And Dependency Failure

- **Stale facts.** Re-evaluation at execution time is the only defense against stale facts; staleness is shown to the approver, never enforced by a clock.
- **Dependency failure.** A dependency failure during re-evaluation records `denied-not-executed`; a failure after contact records `execution-error` or `outcome-unknown`. Neither is retried.
- **Restart.** Restart reads every state from this record, validated as below. It never denies, ends, or re-pauses a request because its raising Turn ended, never reopens a terminal Turn, never re-executes a claimed call, completes an incomplete publication only on its named publication or invalidation Turn, and admits a waiting person-grant invalidation publication on a Core-local Turn once no non-terminal Turn remains.
- **Partial writes.** A partial write that leaves a request Item without a record, or a record without its Item, is `recovery_required` and inspect-only; no action is offered and nothing is synthesized.
- **Cross-domain truth.** Core storage and the upstream system are separate effect domains. No cross-domain atomicity is claimed, and an unknown effect stays unknown.

### Canonical Load Validation

The record is authoritative for request state, claim, disposition, and delivery; Items are its communication projection and never a source of authority. Command admission and canonical load check the same predicates for each record:
- **Lineage.** The request Item exists on the raising Turn, whose Thread and Workspace are the record's, and the Item's kind and request id match the record.
- **Parties.** The requester and responsible user match the request Item, and a recorded resolution's actor is the responsible user or, for a policy grant, the accepted policy actor.
- **One winner.** The record holds at most one resolution and at most one ending, and where the receipt of the command that resolved or ended the request is still retained, it matches the record; an expired receipt is not a conflict.
- **Publication phase.** An outcome with no publication Turn has no outcome Items, as when it is resolved and waits behind a busy Turn. An outcome whose publication Turn is named and whose Items are incomplete is an in-progress publication, which restart completes as Deliver defines; the Items present match it by id and content. A completed publication has exactly the outcome's Items, once, on that Turn, matching its resolution, disposition, or ending; a later delivery attempt's input references them and adds none. A person's grant invalidated after its decision applies the same three phases to its separate invalidation publication: no invalidation Turn and no invalidation Item while it waits, a named invalidation Turn with its Item missing as an in-progress publication, and exactly one matching invalidation `status` Item on that Turn once complete.
- **Legal combinations.** `pending` has no resolution, ending, disposition, or claim other than `unclaimed`, and its delivery is `undelivered`. A denial or answer has claim `unclaimed`. An agent's grant has claim `claimed` or `finished`, or claim `unclaimed` with `denied-not-executed`. A person's grant has claim `unclaimed` with no disposition while it waits for the person's command, claim `unclaimed` with `denied-not-executed` after an invalidation, or claim `claimed` or `finished`. `finished` has one of the three post-claim dispositions. An ended request has no resolution and claim `unclaimed`. A request that is not ready has delivery `undelivered`.
- **Delivery association.** A `frozen`, `delivered`, or `delivery-unknown` record names a Turn on the same Thread that was admitted after the outcome was ready and whose executor is the requester. A published outcome names its publication Turn on the same Thread. A `closed-out` record names its publication Turn.

A record that fails a predicate, such as missing request lineage, conflicting Item content, or an outcome Item on a Turn the record does not name, is inspect-only and returns `recovery_required` to every command on it. Load never picks a winner, never reconstructs a resolution, grant, or claim from Items, and never repairs the record; the rest of the Thread stays usable. A `claimed` record without a disposition is the restart case above and is not a validation failure.

### Earlier Versions

This version starts from a new data root and reads no data that an earlier version wrote, as [the engineer decided](../decisions/20260930-earlier_version_data_not_carried.md). There is no upgrade migration of retained requests, gates, Turn fields, AgentSessions, or scheduler and checkpoint rows. The reload-time derivation of approval state from Items and the denial authored by `nanocore-boot-reconciliation` are deleted.

## Current Implementation Projection

Nothing in this specification is implemented. Today approval and user input set the Turn to `awaiting_human` with `humanGate`; worker gates stop the runtime through a `human-gate` interrupt, suspend and then close the AgentSession, and require a new Task; the MCP approval expires one hour after creation and is claimed by a later call; reload denies an undecided approval on a terminal Turn and otherwise restores `awaiting_human`; the Chat clarification answer path works only in the simulator; and the App API host push pauses its Turn. The change record lists the code sites.

## Alternatives Considered

- **Keep the Turn-pausing gate for non-worker requesters.** Rejected, because it keeps two approval mechanisms against the one-mechanism decision.
- **Write the decision on the raising Turn.** Rejected, because a terminal Turn is never reopened and a reply is never back-filled where the request arose.
- **Deliver the decision on the active Turn when the Thread is busy.** Rejected, because that Turn belongs to another run and its agent would not see it; the delivering Turn is where the requester learns the outcome.
- **Append closeout Items to the Thread's active Turn at archive.** Rejected, because that Turn may be the one that raised the request, where a reply is never back-filled; archive with something to close out waits for an idle Thread instead.
- **Extend `ApprovalRequest`, `PermissionDecision`, or the `CapabilityCall` ledger to hold the captured arguments.** Rejected, because none can hold full arguments additively under their contracts, and user-input requests would still need a lifecycle owner.
- **A background delivery runner.** Rejected, because admission at the command, the terminal barrier, and boot covers every case without a new process.
- **Admit a closeout Turn after archive.** Rejected, because archive prevents new Turns; closeout is written before the archived status instead.
- **Migrate earlier-version requests and gates.** Rejected by the engineer's data-retirement decision.
- **A default expiry.** Rejected by the engineer.

## Consequences

- A Task is its Thread and all of its Turns; the delivering Turn is part of the Task.
- The protocol loses `awaiting_human`, `humanGate`, AgentSession `suspended`, and StopReason `ask_user`, and every exhaustive switch over them stops compiling until it is corrected, as intended.
- An approval-required call does not stop the worker, and a pending request does not hold scheduler capacity.
- The approver may see a request long after it was raised; the card discloses its age, and execution re-evaluates it.

## Rollout / Migration Plan

This lands in the agent communication redesign's first implementation stage, together with the Gateway on the MCP SDK v2 and the resident AgentSession lifecycle. The removal of the reload derivation and denial lands in the same change. No compatibility path and no migration is kept.

## Testing Strategy / Acceptance Criteria

L3 NanoCore black-box checks through the App API and the Gateway with a stub MCP server and a deterministic worker:
- An approval-required call makes no upstream contact, returns `isError: true` with the pending fields, and leaves the Turn `running`; the worker continues and the Turn completes.
- A grant after the raising Turn completed executes the captured call exactly once, records `approved-executed`, and admits one delivering Turn with trigger `approval-resolution` carrying the decision, the disposition, and the result.
- A second identical call while pending returns the same request; changed arguments raise a new one.
- Grant after the tool left the supply, or after a policy or credential change, records `denied-not-executed` with no contact.
- A crash between claim and finish yields `outcome-unknown` after restart and no second execution.
- Deny, withdraw, and Thread archive each end or resolve without execution, and the Approval status is `denied`, `withdrawn`, or `expired`; a denial and a withdrawal reach the agent, and an archive closes out without delivering.
- A membership or Agent authority revocation that commits after the response command resolved its credentials but before its synchronous step makes that step end the request with no contact; a revocation after the step finds the request claimed. Archive and withdrawal behave the same around the step, and neither order executes an ended request or ends a claimed one.
- A grant that re-evaluation refuses, because the tool left the supply, delivers the decision `granted` together with a `status` Item and structured input stating `denied-not-executed` and why.
- A claim left unfinished by a crash delivers `outcome-unknown` in both the Item and the structured input.
- An answer while another Turn is running is recorded at once and delivered by the next Turn; two non-terminal Turns never exist.
- A grant whose execution is still running when another Turn on the Thread terminates is not frozen into the next Turn; the response command admits the delivering Turn after the disposition is recorded.
- A user message admitted while outcomes are ready carries them and keeps trigger `user-input` from the message; a retry keeps trigger `retry`.
- A withdrawal is delivered to the agent as an ending; a withdrawal racing a claim either ends the request or loses to the claim, never both.
- Archiving an idle Thread ends its pending requests and publishes every unpublished undelivered outcome on one completed Core-local Turn written before the archived status, with a `status` Item per ending; no Turn is admitted after archive, and restoring the Thread delivers none of them again.
- Archive while a claimed execution runs returns `409 request_executing`, and archive while a Turn is non-terminal and something waits to be closed out returns `409 thread_busy`, each with no write to any request on the Thread; archive of a busy Thread with nothing to close out succeeds; archive succeeds after the execution settles, including by restart as `outcome-unknown`.
- A requesting Agent that loses authority while its Thread is busy has its outcomes closed out on a Core-local Turn at that Turn's terminal barrier, never on the running Turn.
- More than 16 outcomes waiting at archive are all published on the one closeout Turn.
- A crash after the record names a publication Turn and before its Items are complete, for a delivering Turn and for a closeout Turn, is completed on that Turn at restart before any command is admitted, never elsewhere; a resolved outcome waiting behind a busy Turn with no Items loads cleanly.
- A worker delivery refused before native submission, followed by a user message that delivers the same answer, leaves exactly one `user-input-response` Item, on the first Turn, and the second Turn's input references it.
- A person's host-push grant is delivered as a decision on a Core-local Turn with no scheduler capacity, the person's execute command then performs the push under the Git owner, and an outcome that became ready during that Turn is admitted at its terminal barrier.
- A person's grant that is invalidated before the person's execute command keeps the grant, records `denied-not-executed` with one invalidation `status` Item on a Core-local Turn, keeps the decision's delivery state under the invalidation publication itself, and the command fails before any effect; this holds when the decision was already delivered and when its delivery was refused after publication, and archive independently closes out an undelivered decision.
- A delivered person's grant invalidated while another Turn runs loads cleanly while its invalidation publication waits, archive during that wait returns `409 thread_busy`, and its one invalidation `status` Item is published once on a Core-local Turn at that Turn's terminal barrier, or at boot when a crash precedes the barrier.
- A crash after the record names an invalidation Turn and before its `status` Item is written is completed on that named Turn at restart before any command is admitted.
- Canonical load of fixtures with two resolutions, the same outcome's Items on two Turns, a decision Item on another Thread, a `frozen` record naming a Turn of another executor, and an Item that says granted for a `pending` record each makes that request inspect-only `recovery_required`, and the rest of the Thread stays usable; a valid fixture with a refused attempt and a later delivery, and one whose resolving receipt has expired, load cleanly.
- An answer to a resolved or ended request returns `409 request_not_pending`, a changed answer map `409 idempotency_key_conflict`, and a secret question `400 secret_input_not_supported`, each before any write.
- The seventeenth pending request on one Thread fails `request_limit_reached`.
- A delivering Turn refused before native submission releases its outcomes, and no second delivering Turn is admitted by that Turn's own barrier.
- Reload with a pending request on a terminal Turn keeps it pending and decidable.

For each of the four worker runtimes, the code-level acceptance in the change record exercises `work_request_input` and an approval-required call through the real runtime distribution against synthetic providers, including waking an idle AgentSession and a successor that resumes.

## Risks & Mitigations

- **Risk:** requests accumulate without a deadline. **Mitigation:** the per-Thread bound, Action Center age and blocking disclosure, withdrawal, and invalidating events.
- **Risk:** a grant executes against changed facts. **Mitigation:** full re-evaluation inside the response command, and the approver sees the exact captured call.
- **Risk:** a delivering Turn fails repeatedly. **Mitigation:** a pre-native refusal does not trigger another delivering Turn from its own barrier.
- **Risk:** a grant races an invalidating event. **Mitigation:** one compare-and-set on the request records the grant together with its claim or its non-execution, so no agent grant waits unclaimed.

## Resolved Decisions

- One record for both request kinds, as the durable record of the two existing Turn-coupled owners rather than a ninth owner.
- An outcome's Items are published once, and closeout on archive is written before the archived status.
- An outcome is delivered only when final, only by a Turn whose executor is its requester, and an independently admitted Turn keeps its own trigger.
- Decisions and answers are durable at response time in the record and written as Items on their publication Turn: the first delivering Turn, or the closeout placement when no requester can receive them.
- The approval status map: `denied`, `withdrawn`, `expired`, and `superseded` reserved.
- The bound of 16 pending requests per Thread and 16 outcomes per delivering Turn.

## Deferred / Future Work

- A configurable deadline policy.
- Agent approvers for non-sensitive requests.
- Agent-initiated withdrawal through MCP `tasks/cancel`, and native MCP Tasks once a pinned client drives them.
- Secret answers through a Vault-backed input contract.
- Goal Mode requests, in the Goal redesign.

## Links

- [Approvals And Input Requests Are Pending Tool Calls Delivered As New Turns](../decisions/20260930-pending_tool_calls.md)
- [Pending Requests Have No Default Deadline And Expire Only By Events](../decisions/20260930-pending_requests_have_no_deadline.md)
- [AgentSession Is One Active Execution Binding, Independent Of Turns](../decisions/20260929-agent_session_is_an_execution_binding.md)
- [Goal Mode Entry Is Unavailable Until The Goal Redesign](../decisions/20260930-goal_entry_unavailable_until_redesign.md)
