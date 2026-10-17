---
status: Accepted
date: "2026-10-17"
decider: Engineer; design by the coordinator and an independent Consultant under the engineer's delegation, reviewed by an independent Reviewer
---
# Fault Tolerance And Work Collection

## Decision

OpenKit has one Core aspect, [Fault Tolerance](../core/fault-tolerance.md), that states the fault model, the correctness properties that every aspect keeps under failure, the collection-before-loss principle, the proportional recovery policy and the limits of what OpenKit guarantees. The focus is data consistency and correctness. Availability comes second.

OpenKit does not rely on Worker Harnesses to keep work information after a Sandbox is revoked or deleted. OpenKit collects the complete, correct and valuable information about admitted work while the work runs and stores it through its own owners. It does not retain raw native information as a goal, unless that information is proven valuable and can be retained and used effectively. Native Worker history has no OpenKit format promise.

Native resume is an optimization. A failed resume is explicit. The Thread keeps its history and truthful Turn outcomes, and work continues in a new Thread with the old Thread as its parent and authorized Core records as its context. This agrees with the existing AgentSession rule that native resume failure is explicit and never replaced silently by an empty conversation or by reconstruction.

The concrete owner changes are: [Storage](../core/storage.md) gains one acknowledgement point per canonical store and fails closed on absent authority-bearing storage that a durable record expects; [AgentSession](../core/agent-session.md) states the new-Thread continuation; [Runtime Model](../core/runtime-model.md) collects while the work runs.

## Reason

The engineer's words on 2026-10-17 at 04:48Z, verbatim, answering the coordinator's questions on backup consistency and on unreadable native history:

> 3. 这个没有问题。我需要强调一下，我们之所以十分的看重建立自己的稳定的数据留存格式的目的，就是因为我们没有办法保证我们接入的所有 worker 和 harness 自己。 能够在沙盒被撤销甚至删除之后，还能够留存下完整的工作信息。 因此我们看重的是，我们能够从运行的过程当中收集够完整的、正确的、有价值的信息, 而非对原始信息的留存(除非原始的信息的确是有价值的，并且被证明能够有效被留存与利用的)。

Translation:

> 3. No problem with this. I need to stress the reason why we value building our own stable data retention format so much: we cannot guarantee that every Worker and Harness we connect can keep the complete work information after its Sandbox is revoked or even deleted. Therefore what we value is that we can collect complete, correct and valuable information from the running process, not the retention of original information (unless the original information is really valuable and is proven to be retained and used effectively).

The engineer's words on 2026-10-17 at 05:07Z, verbatim:

> 第二是关于系统的容错性的问题，包括你说的 worker 原生历史数据读不了，怎样处理的问题，我们从 first principle 出发来整体思考一下。我认为当前系统当中 我们有几个可能的不稳定因素。第一是系统本身，包括存储；第二是网络；第三就是我们所依赖的这些还在快速演进当中的 worker harness。另外还有比如 LLM provider, 远程的 MCP 等外部服务。我认为，我们可以对我们系统的容错机制以及局限再写一篇核心文档(由你和独立的 Astra consultant 合力 设计，确定之后由你撰写, sol 审稿), 目的是承认这些不稳定的因素，同时尽力确保系统和服务的稳定运作。重点是关注数据的一致性与正确性。

Translation:

> Second is the question of system fault tolerance, including the question you raised of how to handle unreadable Worker native history; let us think about it as a whole from first principles. I think the current system has several possible unstable factors. First, the system itself, including storage; second, the network; third, the Worker Harnesses we depend on, which still evolve fast. There are also external services such as LLM providers and remote MCP servers. I think we can write one more Core document on the fault-tolerance mechanisms and limits of our system (designed jointly by you and an independent Astra consultant, written by you once settled, reviewed by Sol). The purpose is to acknowledge these unstable factors and at the same time do our best to keep the system and service working stably. The focus is data consistency and correctness.

The coordinator and an independent Consultant designed the document separately and then compared the results. Both arrived at the same principles, and a static audit of the existing owners found no contradiction between them. The independent Reviewer accepted the document after bounded wording corrections. Revoked or deleted Sandbox state cannot be read later, so collection at teardown or reconstruction from native formats cannot be the basis of the work record. Existing owners already supply durable commits, request replay, unknown outcomes and fail-closed storage; the new aspect states the shared policy and its limits instead of adding mechanisms.

## Rejected Alternatives

Relying on native history for continuity or audit was rejected: Harness formats change fast, native history can be lost with the Sandbox, and it carries no OpenKit format promise.

Converting or reconstructing native history after a failed resume was rejected: it can present a context that the agent never had as continued, and it adds a converter for every Harness.

A general reliability ledger, reconciliation service, cross-system rollback or exhaustive fault matrix was rejected as not proportional: the existing owners already record the facts that recovery needs, and the remaining uncertainty is reported as unknown for a human decision.

Automatic purge of retained native volumes was rejected: the collection rule does not make native data worthless, and Storage keeps its retained-volume protections.

## Revisit When

Revisit when a Harness offers a stable, documented and versioned history format that proves valuable to retain, when an owner shows that a specific reachable failure needs a mechanism that the existing owners cannot provide, or when a deployment needs stronger availability guarantees than interruption and a deliberate new attempt.

## Affected Owners

- [Fault Tolerance](../core/fault-tolerance.md): new Core aspect.
- [Storage](../core/storage.md): acknowledgement point; fail closed on absent authority-bearing storage that a durable record expects.
- [AgentSession](../core/agent-session.md): new-Thread continuation after a failed resume.
- [Runtime Model](../core/runtime-model.md): collection while the work runs.
- [Core README](../core/README.md): required aspect set, term index and reading order.
