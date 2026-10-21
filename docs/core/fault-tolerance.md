---
status: Accepted
---
# Fault Tolerance Model

This document owns the OpenKit fault model, durable execution, the correctness properties that every aspect keeps under failure, the collection-before-loss principle, the proportional recovery policy, and the explicit limits of what OpenKit can guarantee.

This document does not own command identity and replay, Turn lifecycle, AgentSession replacement, capability call outcomes, storage formats, retention, backup procedure, approval delivery, Vault injection, or provider retry algorithms. Those owners keep their concrete rules; this document states the shared policy they realize and the limits they disclose.

## Purpose

OpenKit depends on parts it cannot make reliable: its own processes and storage, networks, fast-changing Worker Harnesses, and external services such as LLM providers, remote MCP servers, code hosts and channels. OpenKit accepts that these parts fail. Its goal is that a failure never makes product data wrong: OpenKit does not show unestablished information as fact, does not lose content it acknowledged, does not invent or silently repeat an effect, and says that an outcome is unknown when it does not know it. Availability is the second goal. A clear error and a deliberate new attempt are better than a guess or an elaborate recovery.

## Principles

**OpenKit records are the product truth; everything else is evidence.** [Foundation](foundation.md) owns durable product truth. Worker reports, native histories, provider output, MCP results and channel receipts are evidence with a recorded origin. They become product records only through their owner's validation.

**Acknowledge only what is durable.** A success shown to a user, client or agent follows the durable commit of the content it describes. Content is durable before a durable reference to it is published; the reference is the commit point.

**Report only what the evidence establishes.** A timeout, disconnect or crash establishes that a result is unavailable, not that an effect did not happen. Unknown is a valid, visible outcome. A later attempt keeps the earlier attempt's result and uncertainty.

Effect uncertainty and any recovery requirement are expressed by the effect owner and the recovery owner respectively, and interruption MUST NOT infer that an effect did not happen.

**Recover from durable records.** Recovery MUST start from the effect owner's durable records. Before dispatch, that owner MUST record the effect intent and the decision that permits it. If the result is not established, recovery MUST preserve the uncertainty and use the owning recovery contract to obtain proof or report unknown. Recorded decisions remain evidence; any further governed effect MUST satisfy current authorization under [Policy](policy.md).

**One owner and one deadline per operation.** An operation that crosses a process or network boundary MUST have one end-to-end owner and one deadline covering its waiting, delivery, execution allowance and result collection. Inner waits and retries MUST use the remaining allowance, and a liveness signal MUST NOT extend it. Expiry MUST stop ordinary retries and invoke the owner's failure or unknown-outcome handling; it MUST NOT be treated as proof that external execution has stopped. Cleanup remains subject to the runtime's fencing requirements.

**Name the failure.** Failure diagnostics MUST identify the reporting owner, the observed failed check and the lifecycle stage reached. They MUST distinguish an observed failure from an unproved cause.

**Collect valuable information while it exists.** Harness, Sandbox and native state are temporary and may become unreadable or be deleted. OpenKit collects the information it needs to understand admitted work and its result while the work runs. It does not depend on teardown-time recovery or on native history. The decision and its reason are recorded in [Fault Tolerance And Work Collection](../decisions/20261017-fault_tolerance_and_work_collection.md).

**Continue committed work without replaying unknown effects.** Normal progress and restart use the same execution owner and committed steps. An unsafe or unproved external continuation stops with a truthful state and requires deliberate new admission. Recovery never guesses, replays a lost native Worker, or adds a parallel workflow.

**Contain failure to its owning scope.** Unreadable or unsupported Workspace authority quarantines that Workspace as recovery-required and inspectable; the server and healthy Workspaces can still boot. Untrustworthy server-scoped authority, including users, server Knowledge, configuration and Host state, refuses whole-server boot. This rule is storage-neutral and applies before and after the control-store replacement. A failed provider, MCP server, Worker or channel blocks its dependent operations. Shared authority, a shared writer or loss of containment can require a wider fence. The [durable execution decision](../decisions/20261019-durable_execution_and_control_store.md) records the failure-scope ruling.

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

## Durable Execution

The same `End-To-End Owner` advances normal work and work reopened after restart from each `Safe Point` and committed step outcome. Completed steps are not executed again. Effect intent and its permitting decision precede dispatch and open the `Danger Window`; result and dependent local state share one commit at the `Acknowledgement Point`. Unknown effects retain uncertainty and their required fences. The [durable execution decision](../decisions/20261019-durable_execution_and_control_store.md) replaces scattered execution and recovery authority rather than adding a parallel workflow service.

Durable signals and timers preserve waiting and wake conditions through restart. They reuse existing request and schedule semantics. Human outcomes still enter later Turns; there is no paused Turn status or default response expiry. A lost Worker cannot resume its executing code: its step becomes unknown, its Turn is interrupted truthfully, and continuation requires a newly admitted Turn with proved native-session continuity. Failed native resume follows [AgentSession](agent-session.md).

Global dispatch may index Workspace-owned work, but that index is rebuildable and cannot become a second durable queue. Server-owned capacity and physical bindings are separate effect authority. Their reservation and release must be idempotent under exact work identity; a missing acknowledgement never permits duplicate allocation or unproved capacity release. Necessary Host, Worker and attachment fences remain until an owner-proved replacement protects their failure boundary.

Execution history retains lifecycle timing, outcomes and failed checks through the existing work-data owners. Operational spans are projections of those facts. Journal correlation identifiers grant no execution, access or cleanup authority, and telemetry loss cannot erase work history or determine retry.

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

[Storage](storage.md) owns the acknowledgement point: one mutable control transition commits in one owning-store transaction over already durable immutable content. A cross-scope or external effect has separately committed intent and outcome; it is not made atomic with that transaction. Pending replacement, existing file-backed publication still must acknowledge only synchronized content and report incomplete authority explicitly. OpenKit uses no distributed transaction.

Damaged, unreadable or unsupported authority-bearing storage fails closed within its owning scope. Missing authority-bearing storage that a durable record expects also fails closed there. Workspace quarantine preserves the original bytes and a typed owner/check diagnosis, blocks dependent effects, and never substitutes derived state. Recovery preserves what remains in place and never replaces lost authority with a fresh empty store. Derived indexes and caches are rebuilt only from intact authority; an index never substitutes for missing canonical content. A storage failure stops the affected writes and keeps readable history readable. A backup reports the Worker volumes and external references it does not cover.

### Network

[Protocol](protocol.md) and [Communication](communication.md) own request identity, replay, stream ordering, cursor expiry and terminal evidence. A lost response calls for an authoritative read or the same request identity, not a new Turn. A client that stops observing does not stop server work. Output that cannot be collected within the owner's bounds fails the affected work explicitly; it is never dropped silently under a complete result.

[Communication](communication.md#acknowledged-command-delivery) owns acknowledged delivery and proven non-receipt. Redelivery admitted by that contract does not repeat an effect whose outcome is unknown.

### Worker Harnesses

[Runtime Model](runtime-model.md) owns collection: messages, accepted instructions and decisions, meaningful tool and effect outcomes, output files and Artifacts, and errors are collected through admitted interfaces while the work runs, and stored through existing Item, Artifact, evidence and Workspace owners. Complete means the information needed to understand the admitted work and its result; it does not mean every native event, private reasoning trace or temporary file. A lossy summary does not replace content its owner requires. When required collection fails, OpenKit keeps what arrived and reports the missing part; it never claims complete capture. A scan of changing files is not a consistent snapshot. Planned disposal collects first; urgent revocation does not wait for collection.

[AgentSession](agent-session.md) owns native continuity. Native resume is an optimization. A failed resume is explicit and keeps the old Thread, its history and its truthful Turn outcomes. Work continues only through a new Thread that an authorized actor starts with the old Thread as its parent, and whose context comes from authorized Core records, such as a context compact. Pending requests and their approvals stay with the old Thread and its owners; the new Thread receives no executable approval from it. OpenKit never reconstructs native continuity or presents a new conversation as resumed. The collection and continuation decision is recorded in [Fault Tolerance And Work Collection](../decisions/20261017-fault_tolerance_and_work_collection.md). Harness protocol or format drift fails at its compatibility check, and unknown required semantics fail closed under [Contract Evolution](contract-evolution.md).

### External services

[Mediation](mediation.md) owns call outcomes, including unknown, and forbids automatic replay of an uncertain effect. Provider, MCP and external storage failures stay inside their dependent call or Turn. Returned structures are validated before acceptance; a model's statement that an action succeeded is not the result of that action's owner. Bounded retry or provider fallback is permitted only where the owning specification establishes that it is safe and authorized, and never after output is accepted. OpenKit performs no cross-system rollback, automatic compensation or general reconciliation.

## Boundaries And Non-Goals

This document adds no public entity, protocol status value or separate recovery service. The [durable execution decision](../decisions/20261019-durable_execution_and_control_store.md) permits one replacement execution authority, not the duplicate universal Run or event ledger previously excluded. It does not authorize replay of an unknown effect or change a domain owner's retry rules. It does not make native histories or opaque Worker volumes a recovery prerequisite, and it does not authorize purging them; [Storage](storage.md) keeps its retained-volume protections.

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

## Limits

OpenKit does not guarantee:

- bytes that were never collected, native runtime formats, hidden reasoning, or resumption of a destroyed process
- provider or external service availability, the semantic truth of generated text, or the correctness of external systems
- exactly-once external execution, a total order across independent streams, zero downtime, or bounded recovery time
- persistence after power loss when the disk or file system does not honor synchronization requests
- survival of accepted content after the loss of the storage medium without a usable backup; a local retained volume is not an off-host backup
- that restore reverses external effects; restore returns only the consistency point its backup covers
- reproducible LLM output from a new inference request; retained output remains available through its owner's history and replay rules

Before `v0.1.0`, release resets are explicit operator actions under [Contract Evolution](contract-evolution.md), never automatic fault recovery.

## Relationships To Other Core Aspects

- [Foundation](foundation.md) owns durable product truth and trust boundaries; this document applies them to failure.
- [Storage](storage.md) owns acknowledgement points, integrity failure handling, retained volumes and backup coverage.
- [Protocol](protocol.md) and [Communication](communication.md) own request replay, Turn outcomes, streams, pending-outcome delivery and closeout.
- [Runtime Model](runtime-model.md) owns scheduling, placement, collection, interruption and execution-domain cleanup, and projects durable execution, safe points and danger windows onto the execution lifecycle.
- [Mediation](mediation.md#enforcement-points) owns enforcement points and [Policy](policy.md) owns current authorization at each governed effect boundary.
- [AgentSession](agent-session.md) owns native continuity and its failure.
- [Mediation](mediation.md) and [Vault](vault.md) own external call outcomes and secret injection receipts.
- [Knowledge](knowledge.md) owns notebook publication and its recovery-required outcome.
- [Contract Evolution](contract-evolution.md) owns format compatibility, backup integrity and pre-stable resets.

## Abstract Realization Notes

Each owner realizes these rules with its existing mechanism. A fault matrix across every component is not required. Repeated restart, retry and failure text in other aspects should refer to this document and keep only the owner's concrete predicate.
