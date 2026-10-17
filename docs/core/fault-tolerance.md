---
status: Accepted
---
# Fault Tolerance Model

This document owns the OpenKit fault model, the correctness properties that every aspect keeps under failure, the collection-before-loss principle, the proportional recovery policy, and the explicit limits of what OpenKit can guarantee.

This document does not own command identity and replay, Turn lifecycle, AgentSession replacement, capability call outcomes, storage formats, retention, backup procedure, approval delivery, Vault injection, or provider retry algorithms. Those owners keep their concrete rules; this document states the shared policy they realize and the limits they disclose.

## Purpose

OpenKit depends on parts it cannot make reliable: its own processes and storage, networks, fast-changing Worker Harnesses, and external services such as LLM providers, remote MCP servers, code hosts and channels. OpenKit accepts that these parts fail. Its goal is that a failure never makes product data wrong: OpenKit does not show unestablished information as fact, does not lose content it acknowledged, does not invent or silently repeat an effect, and says that an outcome is unknown when it does not know it. Availability is the second goal. A clear error and a deliberate new attempt are better than a guess or an elaborate recovery.

## Principles

**OpenKit records are the product truth; everything else is evidence.** [Foundation](foundation.md) owns durable product truth. Worker reports, native histories, provider output, MCP results and channel receipts are evidence with a recorded origin. They become product records only through their owner's validation.

**Acknowledge only what is durable.** A success shown to a user, client or agent follows the durable commit of the content it describes. Content is durable before a durable reference to it is published; the reference is the commit point.

**Report only what the evidence establishes.** A timeout, disconnect or crash establishes that a result is unavailable, not that an effect did not happen. Unknown is a valid, visible outcome. A later attempt keeps the earlier attempt's result and uncertainty.

**Collect valuable information while it exists.** Harness, Sandbox and native state are temporary and may become unreadable or be deleted. OpenKit collects the information it needs to understand admitted work and its result while the work runs. It does not depend on teardown-time recovery or on native history. The decision and its reason are recorded in [Fault Tolerance And Work Collection](../decisions/20261017-fault_tolerance_and_work_collection.md).

**Prefer interruption and a deliberate new attempt.** When a failure breaks an operation, OpenKit stops it with a truthful state and lets an authorized actor start a new attempt. Transparent recovery is an optional optimization; it never adds a second workflow and never guesses.

**Contain failure to the affected dependency.** A failed provider, MCP server, Worker, Workspace store or channel blocks only the operations that depend on it. Wider interruption is justified only by shared authority, a shared writer or loss of containment.

**Keep controls proportional to reachable loss.** Controls protect user content, authorization, secrets and scope isolation against failures that can actually happen. Operators are trusted, and model or Worker claims can be wrong without malice. OpenKit adds no general proof, reconciliation or reliability ledger beyond the owners that already need one.

**State the limits.** What OpenKit cannot guarantee is written down, not hidden.

## Canonical Terms

`Fault Source` is one of the four groups of failing parts in the fault model below.

`Acknowledgement Point` is the durable commit after which an owner may report that content or a decision is accepted.

`Collection Before Loss` is the rule that valuable work information is collected while its source is still readable.

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

[Storage](storage.md) owns the acknowledgement point for each canonical store: an ordinary transaction, an atomic file publication with the required synchronization, or the existing append discipline. A mutation that spans files and SQLite records has one owner that states which committed state readers accept; incomplete state returns that owner's error, never a guessed repair. OpenKit uses no distributed transaction.

Damaged or unreadable authority-bearing storage fails closed. Missing authority-bearing storage that a durable record expects also fails closed. Recovery preserves what remains in place and never replaces lost authority with a fresh empty store. Derived indexes and caches are rebuilt only from intact authority; an index never substitutes for missing canonical content. A storage failure stops the affected writes and keeps readable history readable. A backup reports the Worker volumes and external references it does not cover.

### Network

[Protocol](protocol.md) and [Communication](communication.md) own request identity, replay, stream ordering, cursor expiry and terminal evidence. A lost response calls for an authoritative read or the same request identity, not a new Turn. A client that stops observing does not stop server work. Output that cannot be collected within the owner's bounds fails the affected work explicitly; it is never dropped silently under a complete result.

### Worker Harnesses

[Runtime Model](runtime-model.md) owns collection: messages, accepted instructions and decisions, meaningful tool and effect outcomes, output files and Artifacts, and errors are collected through admitted interfaces while the work runs, and stored through existing Item, Artifact, evidence and Workspace owners. Complete means the information needed to understand the admitted work and its result; it does not mean every native event, private reasoning trace or temporary file. A lossy summary does not replace content its owner requires. When required collection fails, OpenKit keeps what arrived and reports the missing part; it never claims complete capture. A scan of changing files is not a consistent snapshot. Planned disposal collects first; urgent revocation does not wait for collection.

[AgentSession](agent-session.md) owns native continuity. Native resume is an optimization. A failed resume is explicit and keeps the old Thread, its history and its truthful Turn outcomes. Work continues only through a new Thread that an authorized actor starts with the old Thread as its parent, and whose context comes from authorized Core records, such as a context compact. Pending requests and their approvals stay with the old Thread and its owners; the new Thread receives no executable approval from it. OpenKit never reconstructs native continuity or presents a new conversation as resumed. The collection and continuation decision is recorded in [Fault Tolerance And Work Collection](../decisions/20261017-fault_tolerance_and_work_collection.md). Harness protocol or format drift fails at its compatibility check, and unknown required semantics fail closed under [Contract Evolution](contract-evolution.md).

### External services

[Agent Capability](agent-capability.md) owns call outcomes, including unknown, and forbids automatic replay of an uncertain effect. Provider, MCP and external storage failures stay inside their dependent call or Turn. Returned structures are validated before acceptance; a model's statement that an action succeeded is not the result of that action's owner. Bounded retry or provider fallback is permitted only where the owning specification establishes that it is safe and authorized, and never after output is accepted. OpenKit performs no cross-system rollback, automatic compensation or general reconciliation.

## Boundaries And Non-Goals

This document adds no entity, record, status value, ledger or recovery service. It does not authorize a new retry, replay, reconstruction or reconciliation mechanism. It does not make native histories or opaque Worker volumes a recovery prerequisite, and it does not authorize purging them; [Storage](storage.md) keeps its retained-volume protections.

## Invariants

- A success MUST NOT be reported before the content it describes reaches its owner's acknowledgement point.
- An integrity failure in authority-bearing storage, or the absence of authority-bearing storage that a durable record expects, MUST fail closed. Recovery MUST preserve what remains and MUST NOT replace lost authority with an empty store.
- A timeout, disconnect, crash or interruption MUST NOT be reported as proof that an effect did or did not happen.
- An effect with an unknown outcome MUST NOT be repeated automatically.
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
- [Runtime Model](runtime-model.md) owns collection, interruption and execution-domain cleanup.
- [AgentSession](agent-session.md) owns native continuity and its failure.
- [Agent Capability](agent-capability.md) and [Vault](vault.md) own external call outcomes and secret injection receipts.
- [Knowledge](knowledge.md) owns notebook publication and its recovery-required outcome.
- [Contract Evolution](contract-evolution.md) owns format compatibility, backup integrity and pre-stable resets.

## Abstract Realization Notes

Each owner realizes these rules with its existing mechanism. A fault matrix across every component is not required. Repeated restart, retry and failure text in other aspects should refer to this document and keep only the owner's concrete predicate.
