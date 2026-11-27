---
status: Accepted
---
# Fault Tolerance Model

This document owns the OpenKit fault model, durable execution, the correctness properties that every aspect keeps under failure, the two planes of the execution environment, the rules for fencing, release, replacement, unknown outcomes, suspicion and occupancy, the exit of every hold, the collection-before-loss principle, the proportional recovery policy, and the explicit limits of what OpenKit can guarantee.

This document does not own command identity and replay, Turn lifecycle, AgentSession replacement, capability call outcomes, storage formats, retention, backup procedure, approval delivery, Vault injection, or provider retry algorithms. Those owners keep their concrete rules; this document states the shared policy they realize and the limits they disclose.

## Purpose

OpenKit depends on parts it cannot make reliable: its own processes and storage, networks, fast-changing Worker Harnesses, and external services such as LLM providers, remote MCP servers, code hosts and channels. OpenKit accepts that these parts fail. Its goal is that a failure never makes product data wrong: OpenKit does not show unestablished information as fact, does not lose content it acknowledged, does not invent or silently repeat an effect, and says that an outcome is unknown when it does not know it. Availability is the second goal. A clear error and a deliberate new attempt are better than a guess or an elaborate recovery.

## Principles

**OpenKit records are the product truth; everything else is evidence.** [Doctrine](doctrine.md) owns durable product truth. Worker reports, native histories, provider output, MCP results and channel receipts are evidence with a recorded origin. They become product records only through their owner's validation.

**Acknowledge only what is durable.** A success shown to a user, client or agent follows the durable commit of the content it describes. Content is durable before a durable reference to it is published; the reference is the commit point.

**Report only what the evidence establishes.** A timeout, disconnect or crash establishes that a result is unavailable, not that an effect did not happen. Unknown is a valid, visible outcome. A later attempt keeps the earlier attempt's result and uncertainty.

Effect uncertainty and any recovery requirement are expressed by the effect owner and the recovery owner respectively, and interruption MUST NOT infer that an effect did not happen.

**Recover from durable records.** Recovery MUST start from the effect owner's durable records. Before dispatch, that owner MUST record the effect intent and the decision that permits it. If the result is not established, recovery MUST preserve the uncertainty and use the owning recovery contract to obtain proof or report unknown. Recorded decisions remain evidence; any further governed effect MUST satisfy current authorization under [Policy](policy.md).

**One owner and one deadline per operation.** An operation that crosses a process or network boundary MUST have one end-to-end owner and one deadline covering its waiting, delivery, execution allowance and result collection. Inner waits and retries MUST use the remaining allowance, and a liveness signal MUST NOT extend it. Expiry MUST stop ordinary retries and invoke the owner's failure or unknown-outcome handling; it MUST NOT be treated as proof that external execution has stopped. Cleanup remains subject to the runtime's fencing requirements.

**Name the failure.** Failure diagnostics MUST identify the reporting owner, the observed failed check and the lifecycle stage reached. They MUST distinguish an observed failure from an unproved cause.

**Collect valuable information while it exists.** Harness, Sandbox and native state are temporary and may become unreadable or be deleted. OpenKit collects the information it needs to understand admitted work and its result while the work runs. It does not depend on teardown-time recovery or on native history. The decision and its reason are recorded in [Fault Tolerance And Work Collection](../decisions/20261017-fault_tolerance_and_work_collection.md).

**Continue committed work without replaying unknown effects.** Normal progress and restart use the same execution owner and committed steps. An unsafe or unproved external continuation stops with a truthful state and requires deliberate new admission. Recovery never guesses, replays a lost native Worker, or adds a parallel workflow.

**Contain failure to its owning scope.** Unreadable or unsupported Workspace authority quarantines that Workspace as recovery-required and inspectable. The server and healthy Workspaces can still boot. If Control Kernel authority or the Server configuration required for startup is untrustworthy, refuse whole-server boot. A failed Core Service, Core Extension, provider, MCP server, Worker, or channel blocks dependent effects. Shared authority, a shared writer, or loss of containment can require a wider fence. The [storage ownership decision](../decisions/20261120-control_kernel_and_service_storage.md) and [Storage](storage.md#server-storage-owners) identify the Server failure domains.

**Attribute Boot recovery to its Workspace.** A Boot step that walks Workspaces attributes a failure to the Workspace that caused it. That Workspace stays held for the affected operation, and its stored bytes do not change. Boot continues with the other Workspaces and opens the listeners. Readiness shows the held Workspace and the cause. Boot stops only when the common owner or the list of Workspaces is not trustworthy.

**Choose for each plane what a doubt costs.** From a distance a dead process, a slow process and a cut link look the same, and no mechanism removes that. OpenKit does not try to build a perfect scheduler. For decisions, exclusion, effects and receipts it chooses consistency: a doubt holds. For work in progress, observations and the capacity view it chooses availability: work continues and a stale view is replaced. [Planes](#planes) owns the split. The decision is recorded in [Long-Running Sandbox And Worker Layer](../decisions/20261126-long_running_sandbox_and_worker_layer.md).

**Every hold has an exit.** A hold names its owner, its bound and its exit. The exit is automatic when the owner of the proof can be reached. It is a visible human decision when that owner cannot be reached or cannot answer. A hold blocks only what lives on the held unit.

**Keep controls proportional to reachable loss.** Controls protect user content, authorization, secrets and scope isolation against failures that can actually happen. Operators are trusted, and model or Worker claims can be wrong without malice. Durable execution replaces its scattered state and bespoke recovery; it MUST NOT add a second proof, reconciliation or reliability ledger beside those owners.

**State the limits.** What OpenKit cannot guarantee is written down, not hidden.

## Canonical Terms

`Fault Source` is one of the four groups of failing parts in the fault model below.

`Durable Execution` is continuation of an existing work execution from committed state and step outcomes, not replay of native agent code or a new public Run.

`Acknowledgement Point` is the durable commit after which an owner may report that content or a decision is accepted.

`Collection Before Loss` is the rule that valuable work information is collected while its source is still readable.

`Safe Point` is an owner-defined committed state whose facts can be recovered from durable records alone. It does not establish the current state of a dependent external execution.

`Danger Window` is an interval in which durable records do not establish whether an external effect occurred or what its result was. It includes uncertainty after dispatch and before receipt or execution is proved.

`End-To-End Owner` is the one owner whose deadline bounds an operation across every layer it crosses.

`Decision Plane` is the set of facts for which OpenKit chooses consistency: decisions with desired state, exclusion claims, effects and receipts.

`Observation Plane` is the set of facts for which OpenKit chooses availability: work in progress, observed state, and views derived from it.

`Fence` is the durable revocation, in Core's own store, of the authority of one incarnation. It needs no other party.

`Stop Unit` is a unit whose owner can stop it from outside and can observe that it is absent. The outside stop unit of a Worker is its Sandbox incarnation.

`Receipt` is durable evidence, bound to an original key, that an input was accepted, a status was final, a capture or debit happened, or an effect was done.

`Governed Abandonment` is the administrator decision that closes an attempt without its missing handoffs, for fenced scopes only, and records the residual effects.

## Durable Execution

The same owner advances normal work and work reopened after restart. Completed steps are not executed again. Effect intent and its permitting decision precede dispatch; result and dependent local state share one commit. Unknown effects retain uncertainty and their required fences. The [durable execution decision](../decisions/20261019-durable_execution_and_control_store.md) replaces scattered execution and recovery authority rather than adding a parallel workflow service.

Durable signals and timers preserve waiting and wake conditions through restart. They reuse existing request and schedule semantics. Human outcomes still enter later Turns; there is no paused Turn status or default response expiry. A lost Worker cannot resume its executing code: its step becomes unknown, its Turn is interrupted truthfully, and continuation requires a newly admitted Turn with proved native-session continuity. Failed native resume follows [AgentSession](agent-session.md).

Global dispatch may index Workspace-owned work, but that index is rebuildable and cannot become a second durable queue. Server-owned capacity and physical bindings are separate effect authority. Their reservation and release must be idempotent under exact work identity; a missing acknowledgement never permits duplicate allocation or unproved capacity release. Necessary Host, Worker and attachment fences remain until an owner-proved replacement protects their failure boundary.

Execution history retains lifecycle timing, outcomes and failed checks through the existing work-data owners. Operational spans are projections of those facts ([Evidence](evidence.md#telemetry)). Journal correlation identifiers grant no execution, access or cleanup authority, and telemetry loss cannot erase work history or determine retry.

## Planes

Core owns the decisions and records them through its durable storage owners. Around it are providers outside the Sandbox, one Worker Shim in each Sandbox incarnation, and Worker processes that can crash, hang, ignore a stop and leave children. Two facts keep the choice simple. Only Core allocates, so a cut-off environment cannot claim anything. Every exclusive physical resource lives on one Host, and Core never moves one across a partition: Core waits for it, or leaves it and continues on state that Core owns.

| Plane | Facts | Truth | During a doubt | Repair |
| --- | --- | --- | --- | --- |
| Decision | Turn, attempt, desired state, grants, draining and other latches | Core | The environment gets no new authority. | None needed |
| Decision | Exclusion: one live attempt for a Thread, one live Worker for an AgentSession, one holder of a work slot, one Volume writer, Host capacity | Core claims | The claim stays, charged to its own incarnation. | Proof of release, or proved replacement of a wider unit |
| Decision | Effects and receipts | The gate that does the effect | An effect at a Core gate is refused. An unknown effect holds. | Read-back by the original key; never a new key |
| Observation | Work in progress: processes, working bytes, transcripts | The environment | It continues to the end of what was authorized. It starts nothing new. | Offered on return; see [Acceptance Boundary](#acceptance-boundary) |
| Observation | Liveness, inventory, usage, progress | The producer | It is stale. | The next full report replaces it. |
| Observation | Capacity view, placement hints | Derived | A stale view causes a refusal and never a second claim. | The next report |

A fact of the Decision Plane is a retained record. A fact of the Observation Plane is a view, except an observation that a decision cites as its proof. [Contract Evolution](contract-evolution.md#retained-data-continuity) owns that rule.

## Fencing, Release And Replacement

These rules apply to every unit of the execution environment: a Worker, a Sandbox incarnation and an execution-substrate epoch. Each owner realizes them with its own mechanism.

### Fence First

Core revokes the authority of an incarnation in its own store before any other step. From then on Core refuses each action of that incarnation that passes a Core gate.

A fence covers Core gates only. It stops no local process and it releases nothing. A call that was already admitted, a grant that was already delivered, and a grant held at Sandbox level end only at the outside stop unit. A fence is effective for a Worker only when every model route of that Worker passes Core. [Sandbox](sandbox.md#fence-effectiveness) owns the consequence for sharing.

### Release By Proof

An exclusive resource returns to use only by proof. The proof has three parts, in this order:

1. **Ingress closed.** The desired state of the unit is `stop`. That decision is durable, and the executor refuses a start for that ID. Desired state is monotonic: `run`, then `stop`, never back. A restart is a new ID.
2. **Accepted work joined.** Each operation that the executor accepted for that ID has a definite result. Or the lifetime of the executor ended and its parent proved that end.
3. **Observed absent.** After parts 1 and 2, the owner of the stop unit observes that the exact incarnation is absent. A missing list entry counts only then, and only where the provider declares it a proof.

If part 2 cannot be met, the proof comes from the parent: the parent unit is replaced and proved fresh and empty. A timeout, a missed heartbeat, a kill or delete acknowledgement alone, a reconnect and a clock jump are never a proof.

### Replace On Core-Owned State

Core may start a replacement when the fence is durable and release is proved for each exclusive resource that the replacement reuses. A resource that is not released is not reused. The replacement takes a fresh resource and starts from state that Core owns. New capacity never authorizes a duplicate Turn.

Bytes that a predecessor left stay in place. Nothing is deleted because of a doubt. The successor is told that the bytes exist; OpenKit does not merge them. A governed abandonment closes an attempt without its handoffs and releases no physical claim.

### Unknown Has An Owner

Before a call crosses a boundary, the caller makes four things durable: the operation key, the receiver, the payload digest and the exclusion. A read-back by the original key has three values:

- **Committed.**
- **Proved not committed.** The receiver is quiescent. Complete authoritative history shows the original key is absent, or the original sequence is unchanged.
- **Unknown.** This includes a receipt that was lost or overwritten.

The deadline of the operation starts the escalation in [Exit Of Every Hold](#exit-of-every-hold). It never changes the value. When a receiver can never answer, the value stays unknown and replay stays disabled; the logical exit is a governed abandonment. Settlement (did it commit) and absence (is it gone) have separate owners and separate tests.

The owner of an operation changes by phase:

| Phase | Owner |
| --- | --- |
| The key is not yet durable | The caller. Nothing happened. |
| The key is durable, delivery is not known | The Core reconciler |
| Accepted | The receiver executes. Core settles by key. |
| Result produced | The producer keeps the receipt until Core acknowledges that key. |
| Reconnect | The same owner and the same key |
| The receiver restarted | Its parent proves its end. Then Core reads durable state or settles the operation as unknown. |

### Suspicion And Return

A missed liveness signal is a suspicion. It stops routes and new placement only, and the next valid signal undoes it. A suspected party returns only by authenticated current lineage, exact sequence, and authority that has not expired. A duplicate message does not renew liveness. Repeated suspicion does not extend the original deadline.

Stop, recycle and abandonment are decisions, and decisions are monotonic. A Worker that returns after `stop` is stopped, and what it reports is evidence. The cost of this rule is work lost when a suspicion was false and its bound ended. Long bounds limit that cost; a cleverer detector does not.

### Disposable Processes

A restart at any level is a new incarnation that continues from disk and from Core records. A new process parent adopts no child of its predecessor: a new Worker Shim adopts no Worker, and a new Host agent adopts no Sandbox. A live child may stay across a reconnect of its parent, because the parent is the same incarnation; the full inventory confirms it. Core is not a process parent. After a Core restart the environment attaches again by lineage.

### Occupancy And Limits

Before contact, the deciding writer reserves all affected claims it owns in one transaction. Obligations in other stores use receipt handoffs. A unit that is starting, stopping or unknown counts as occupied. Occupancy is the count of Core's own claims that are not proved released. There is no second counter. The cost is stranded capacity: at most one unit for each unproved incarnation, visible, with an exit.

A hard limit exists only where each use passes a Core gate. There the reservation is the cap, and the gate enforces it at use. A route that does not pass Core has no meter and no cap, and the act that shares such material says so. Core does not account CPU, memory or disk inside a Sandbox; the bounds are the maximum number of Workers of the Sandbox and the limits of its provider. Quota or budget that is used up gives a typed park.

### Acceptance Boundary

An observation is replaceable: the next full report replaces it. A receipt is not replaceable. A receipt of a fenced attempt is still accepted as evidence by its original key. A product result advances a Thread only from an attempt that is not fenced.

### Exit Of Every Hold

A wider stop is used only after the bound of the narrower one. Each affected Turn keeps its own result from its own evidence.

| Doubt | Thread progress | Physical release | Exit |
| --- | --- | --- | --- |
| The stop of a Worker is not proved | The Sandbox incarnation enters draining, then Core recycles it. With no other admitted attempt, Core recycles it at once. [Sandbox](sandbox.md#draining) owns the rule. | After the incarnation is proved absent | Automatic |
| The Worker Shim is silent or gone; the Host can be reached | The same shim may return inside the outage budget, by lineage. Else Core recycles the incarnation. | After the incarnation is proved absent | Automatic |
| A Sandbox peer has a different version | Core refuses the peer before any effect and orders one recycle of the Sandbox incarnation onto the current image. If the mismatch stays, Core stops retries and shows a maintenance hold. A message from a refused peer authorizes nothing. | After the incarnation is proved absent | Automatic once, then human |
| A Host peer has a different version | Core refuses the peer before any effect. A compatible payload through authorized replacement is required before the Host renews its epoch. If that path is unavailable or the mismatch stays, Core shows a maintenance hold and stops retries. A message from a refused peer authorizes nothing. | After the fresh epoch is proved ready and empty | Authorized replacement, or maintenance hold |
| A Sandbox create or delete is unknown | Core repeats the delete of that ID and observes until the original deadline, where the provider declares that observation a proof. Else the execution-substrate epoch enters draining and is renewed. | After the fresh epoch is proved ready and empty | Automatic |
| The Host cannot be reached | Routes stop. The attempt stays open with its exclusion, and the Turn shows as interrupted with an unknown outcome. A new Thread can be placed on other resources. To continue this Thread on other resources needs a governed abandonment. | Never by time. A Host that was declared lost renews its epoch before it is admitted again. | Human, safe |
| A reply is lost inside Core | Core reads back after it observes the end of the writer. It restarts the writer if the writer can attach again. Else it stops the process and recovers at Boot. | Claims that were charged stay charged until the read-back settles. | Automatic |
| A receiver can never answer | The outcome stays unknown. There is no replay. The exit is a governed abandonment. | By the row of its unit | Human |
| Quota or budget is used up | A typed park. The exits are the reset time, another authorized route, a top-up by the owner, or a cancel. | None held | Automatic at reset; else shown to the owner |

A hold with an automatic exit needs no operator. A hold with a human exit keeps its claim charged, is visible to the people who can end it, and blocks only what lives on that unit.

## Fault Model

| Fault source | Failures that can affect data |
| --- | --- |
| OpenKit and its storage | Process death between writes; restart; bug; upgrade; concurrent conflicting updates; full disk; interrupted write or append; damaged, missing or unavailable canonical storage; stale derived indexes; incomplete backup coverage. |
| Network | Lost request or response; duplicate submission; disconnect during streaming; delayed output from a released binding; partition while a remote process continues; interrupted output transfer. |
| Worker Harnesses | Crash or hang; protocol, event or format drift; malformed, missing or wrong self-reported output; lost or unreadable native history; failed native resume; Sandbox lost or deleted; files changing during collection. |
| External services | LLM provider outage, throttling, partial generation or model change; malformed model output; MCP schema or capability change; an external mutation that completes while its response is lost; credential revocation; unavailable external source bytes. |

Shared storage, hosts and execution domains can cause correlated failures across these sources.

## Correctness Properties

These are observable properties of the whole system. They add no status values.

1. **Accepted content survives an ordinary restart.** Acknowledged input, decisions and published results stay readable from their owners with the same identity, content and lineage, while the storage medium remains usable.
2. **A failed mutation has no partial authority.** It leaves the previous state or an explicit recovery-required state. It never exposes partial success or an empty replacement for damaged or missing authority.
3. **Failures do not invent outcomes.** A lost connection, a killed Worker or a lost provider response never establishes completion, non-execution, delivery or native continuity.
4. **Retry keeps identity and effect boundaries.** Repeating an accepted request within its owner's replay contract creates no duplicate work. An effect with an unknown outcome is not repeated automatically.
5. **Useful work does not depend on native history.** When native history is absent or unreadable, Core still shows the collected work and can start an explicitly new, linked Thread from authorized Core records. It does not claim to restore hidden context.
6. **Degradation keeps access boundaries.** A failed dependency never causes OpenKit to serve another scope's data, expose a secret or skip an authorization check.

## Rules By Fault Source

### OpenKit and storage

[Storage](storage.md) owns the acknowledgement point: one mutable control transition commits in one owning-store transaction over already durable immutable content. A cross-scope or external effect has separately committed intent and outcome; it is not made atomic with that transaction. File-backed publication must acknowledge only synchronized content and report incomplete authority explicitly. OpenKit uses no distributed transaction.

Damaged, unreadable or unsupported authority-bearing storage fails closed within its owning scope. Missing authority-bearing storage that a durable record expects also fails closed there. Workspace quarantine preserves the original bytes and a typed owner/check diagnosis, blocks dependent effects, and never substitutes derived state. Recovery preserves what remains in place and never replaces lost authority with a fresh empty store. Derived indexes and caches are rebuilt only from intact authority; an index never substitutes for missing canonical content. A storage failure stops the affected writes and keeps readable history readable. A backup reports the Worker volumes and external references it does not cover.

### Restore Evidence

Restore from verified copies for retained work, contributor history, and manifests. Rebuild projections only from complete, identifiable sources. Bindings, challenges, credentials, enable generations, and notices require proved continuity, reauthorization, or reconciliation. If audience proof is missing, refuse attach, purge, and disclosure. Loss of trigger storage preserves imposed Policy restrictions. Each route applies the strictest recovery rule required by the facts it uses.

- When the kernel is ahead, settle a matching owner intent from the original kernel receipt. Restore missing published bytes or recipient claims only from exact evidence. An enqueued or possibly sent notice remains unknown beside older communication state.
- When a service or extension is ahead, inspect settlement if its kernel receipt or grant is missing. Absence in a skewed history confers no dispatch authority. Validate trigger cursors by event identity at the saved append position. Rescan with deduplication or expose the gap.
- When both histories are behind, fence the predecessor deployment and remote writers. Restrict ingress to recovery until possibly superseded AuthSessions, tokens, and bindings are fenced or reauthorized. Hold effects that could duplicate delivery. Preserve an independently provable route to re-enrol the administrator. Matching schemas and timestamps do not resolve later external history.

### Input Read-Back And Scoped Release

Receiver acceptance acknowledges intake. Core records consumption only when receiver read-back identifies processing of the exact input on its target Turn. Repeated text, a reused slot, an answer, or an intake acknowledgement alone provides insufficient evidence. Lost evidence after possible contact is unknown. Weaker evidence cannot erase a stronger finding. A proved refusal before effect returns to the original admission rules. Core inspects the original input and holds its obligation until consumption or governed resolution. Uncertainty never permits resend or promotion to another Turn.

A steer that Core selected keeps its original obligation until exact consumption or governed resolution. When its delivery is unknown, Core releases the waiter and keeps the obligation. An interrupt is desired state of the Turn and is not a one-shot operation. Core keeps the original request and attempt, the decision between a terminal result and an interrupt, the refusal of a conflicting request, and the observed settlement or unknown. If the terminal transition wins first, its recorded decision proves that Core admitted no interrupt. If interrupt admission wins first, a later terminal transition can follow a delivered interrupt whose reply was lost. Core keeps the original settlement or unknown, and cleanup waits for settlement. Core uses no separate lookup call for this evidence. The regular exchange with the environment carries it by key.

Definite nonacceptance with no outstanding effects permits attempt closure and eligible requeue. Otherwise, Core enters closing, revokes scoped credentials, preserves the first stop cause, and inspects the original operation. Successful release requires terminal handoff, output, evidence, outside-Workspace collection, integration drain, route revocation, and a sufficient fence. Include Core publishers, shared volumes, native execution, tools, delayed creates, and paid resources when identifying writers and unresolved effects.

A lifetime bound covers only its documented writer domain after the last possible start, including renewal or resumption. Use monotonic elapsed time while live and the original absolute deadline across restart. If the elapsed bound cannot be proved, hold dispatch that depends on that bound. A kill acknowledgement, missing list entry, clock jump, or reconnect supplies insufficient proof of termination.

An authorized administrator may abandon enumerated missing handoffs only for fenced scopes. Compare-and-set the original execution revision and commit the proof, abandonment decision and surviving exclusions together. Later inspection may release only the references newly covered by proof. Keep unfenced references after logical closure and enforce them at claim and placement. Release a Turn, Thread, or AgentSession exclusion only when every writer covered by it is fenced. A volume still writable by an unfenced predecessor blocks reuse of that volume. A proved-disjoint destination may proceed once old publishers are fenced. Hold the encompassing scope when the affected writers cannot be bounded. Track remote cleanup independently.

### Result Classes

An operation that did not complete has one of three outcomes. **Temporary:** the owner proved that it did not start the operation and that the cause ends with no action. **Refused:** the owner decided no. **Unknown:** the owner accepted the operation and the reply was lost, or the owner cannot prove either case. The outcome is set where the cause is known. The owner that receives the call absorbs a temporary cause inside that call, within its existing bounded wait, and checks authority again before it accepts. When the wait ends, the route keeps its current failure contract. This paragraph adds no retry and no status value to a wire contract. An error with no outcome keeps the current refusal of its route. If a commit was possible before the error, the caller treats the outcome as unknown and inspects by the original identity.

### Network

[Protocol](protocol.md) and [Communication](communication.md) own request identity, replay, stream ordering, cursor expiry and terminal evidence. A lost response calls for an authoritative read or the same request identity, not a new Turn. A client that stops observing does not stop server work. Output that cannot be collected within the owner's bounds fails the affected work explicitly; it is never dropped silently under a complete result.

[Communication](communication.md#acknowledged-command-delivery) owns acknowledged delivery and proven non-receipt. Redelivery admitted by that contract does not repeat an effect whose outcome is unknown.

### Worker Harnesses

[Runtime Model](runtime-model.md) owns collection: messages, accepted instructions and decisions, meaningful tool and effect outcomes, output files and Artifacts, and errors are collected through admitted interfaces while the work runs, and stored through existing Item, Artifact, evidence and Workspace owners. Complete means the information needed to understand the admitted work and its result; it does not mean every native event, private reasoning trace or temporary file. A lossy summary does not replace content its owner requires. When required collection fails, OpenKit keeps what arrived and reports the missing part; it never claims complete capture. A scan of changing files is not a consistent snapshot. Planned disposal collects first; urgent revocation does not wait for collection.

[AgentSession](agent-session.md) owns native continuity. Native resume is an optimization. A failed resume is explicit and keeps the old Thread, its history and its truthful Turn outcomes. Work continues only through a new Thread that an authorized actor starts with the old Thread as its parent, and whose context comes from authorized Core records, such as a context compact. Pending requests and their approvals stay with the old Thread and its owners; the new Thread receives no executable approval from it. OpenKit never reconstructs native continuity or presents a new conversation as resumed. The collection and continuation decision is recorded in [Fault Tolerance And Work Collection](../decisions/20261017-fault_tolerance_and_work_collection.md). Harness protocol or format drift fails at its compatibility check, and unknown required semantics fail closed under [Contract Evolution](contract-evolution.md).

### External services

[Mediation](mediation.md) owns call outcomes, including unknown, and forbids automatic replay of an uncertain effect. Provider, MCP and external storage failures stay inside their dependent call or Turn. Returned structures are validated before acceptance; a model's statement that an action succeeded is not the result of that action's owner. Bounded retry or provider fallback is permitted only where the owning specification establishes that it is safe and authorized, and never after output is accepted. OpenKit performs no cross-system rollback, automatic compensation or general reconciliation.

## Boundaries And Non-Goals

This document adds no public entity, protocol status value or separate recovery service. The [durable execution decision](../decisions/20261019-durable_execution_and_control_store.md) permits one replacement execution authority, not a duplicate universal Run or event ledger. It does not authorize replay of an unknown effect or change a domain owner's retry rules. It does not make native histories or opaque Worker volumes a recovery prerequisite, and it does not authorize purging them; [Storage](storage.md) keeps its retained-volume protections.

## Invariants

- A success MUST NOT be reported before the content it describes reaches its owner's acknowledgement point.
- An integrity failure in authority-bearing storage, or the absence of authority-bearing storage that a durable record expects, MUST fail closed in its owning scope. Workspace quarantine MUST NOT prevent healthy Workspaces from booting unless shared authority or containment is affected. Recovery MUST preserve what remains and MUST NOT replace lost authority with an empty store.
- A timeout, disconnect, crash or interruption MUST NOT be reported as proof that an effect did or did not happen.
- An effect with an unknown outcome MUST NOT be repeated automatically.
- An inner retry, wait or liveness signal MUST NOT extend the deadline set by an operation's end-to-end owner.
- A decision that permits an effect MUST be durably recorded before that effect can occur. A recorded decision MUST NOT substitute for current authorization when a further effect is dispatched.
- Diagnostics for a failure MUST identify the owner, the failed check and the lifecycle stage.
- Required collection that fails MUST be reported as incomplete, never as complete success.
- A failed native resume MUST NOT be presented as continued context; continuation MUST use a new Thread whose parent is the old Thread and whose context comes from authorized Core records.
- A failure in one scope, Worker or external dependency MUST NOT expose another scope's data or a secret, or bypass authorization.
- A derived index or cache MUST NOT replace missing canonical content.
- An exclusive resource MUST NOT return to use on a timeout, a missed heartbeat, an acknowledgement alone, a reconnect or an undeclared list miss. Release MUST follow closed ingress, joined accepted work and observed absence, or the proved replacement of the parent unit.
- A fence MUST be durable in Core before a replacement starts. A replacement MUST NOT reuse a resource whose release is not proved, and new capacity MUST NOT authorize a duplicate Turn.
- A unit that is starting, stopping or unknown MUST count as occupied.
- A deadline MUST NOT change an unknown outcome into a known outcome, and repeated suspicion MUST NOT extend a deadline.
- A suspected party MUST return only by authenticated current lineage, exact sequence and unexpired authority.
- A new process parent MUST NOT adopt a child of its predecessor.
- A product result of a fenced attempt MUST NOT advance a Thread. Its receipts MUST stay acceptable as evidence by their original key.
- Every hold MUST name its owner, its bound and its exit. A hold whose exit needs a human MUST be visible and MUST keep its claim charged.

## Limits

OpenKit does not guarantee:

- bytes that were never collected, native runtime formats, hidden reasoning, or resumption of a destroyed process
- provider or external service availability, the semantic truth of generated text, or the correctness of external systems
- exactly-once external execution, a total order across independent streams, zero downtime, or bounded recovery time
- persistence after power loss when the disk or file system does not honor synchronization requests
- survival of accepted content after the loss of the storage medium without a usable backup; a local retained volume is not an off-host backup
- that restore reverses external effects; restore returns only the consistency point its backup covers
- reproducible LLM output from a new inference request; retained output remains available through its owner's history and replay rules
- that admitted work in a draining Sandbox completes, or that the files of one Worker are protected from another Worker in the same Sandbox
- continuity of processes or memory across a Sandbox wake or any restart
- a cap or a meter on a route that does not pass a Core gate
- automatic continuation of a Thread while its Host cannot be reached

Before `v0.1.0`, release resets are explicit operator actions under [Contract Evolution](contract-evolution.md), never automatic fault recovery.

## Relationships To Other Core Aspects

- [Doctrine](doctrine.md) owns durable product truth and trust boundaries; this document applies them to failure.
- [Storage](storage.md) owns acknowledgement points, integrity failure handling, retained volumes and backup coverage.
- [Protocol](protocol.md) and [Communication](communication.md) own request replay, Turn outcomes, streams, pending-outcome delivery and closeout.
- [Runtime Model](runtime-model.md) owns scheduling, placement, collection, interruption and execution-domain cleanup, the roles of the environment provider and the Worker Shim, and projects durable execution, safe points, danger windows and the rules of [Fencing, Release And Replacement](#fencing-release-and-replacement) onto the execution lifecycle.
- [Sandbox](sandbox.md) owns the long-running Sandbox, its incarnation, draining, sleep and wake, and the effect of fence effectiveness on sharing.
- [Mediation](mediation.md#enforcement-points) owns enforcement points and [Policy](policy.md) owns current authorization at each governed effect boundary.
- [AgentSession](agent-session.md) owns native continuity and its failure.
- [Mediation](mediation.md), [Evidence](evidence.md), and [Vault](vault.md) own external call outcomes, evidence and telemetry boundaries, and secret injection receipts.
- [Knowledge](knowledge.md) owns notebook publication and its recovery-required outcome.
- [Contract Evolution](contract-evolution.md) owns format compatibility, backup integrity and pre-stable resets.

## Abstract Realization Notes

Each owner realizes these rules with its existing mechanism. A fault matrix across every component is not required. Repeated restart, retry and failure text in other aspects should refer to this document and keep only the owner's concrete predicate.
