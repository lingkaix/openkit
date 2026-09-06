---
status: Accepted
---
# Engineering Doctrine

This document explains the delegation premise and the observations behind repository governance. It is non-authoritative rationale: implementation and execution decisions resolve to root governance, Core, accepted specifications, and direct evidence.

## Delegation Is A Fallible System

Turn the engineer's intent and key decisions, at the lowest practical cognitive cost, into a system worth having, correctly implemented, and maintainable. Automation, document completeness, and review counts serve that purpose.

OpenKit is an experiment in delegating development, maintenance, and upgrades to capable agents. Engineers' attention, information capacity, and judgment are scarce: engineers express intent, contribute and correct architecture and implementation choices, resolve governing trade-offs, accept strict risk, and finally accept and use the system. Agents carry execution within those decisions and actively invite the engineer when an unresolved choice, missing authorization, or lack of a credible route needs human judgment. Useful human participation is an outcome of delegation, not a failure to hide or a count to drive to zero.

No participant is assumed infallible. Engineers can approve a poor decomposition, a primary agent can lose direction after context compression, a builder can implement the wrong premise correctly, and reviewer language can be misunderstood. A resilient loop keeps such errors local, preserves enough reality to recover, and continues toward the outcome instead of pretending errors can be designed away.

Long-horizon work cannot rely on one uninterrupted model context. Repeated compression and accumulated implementation detail can narrow attention even while every local step looks compliant. Direction must survive in source intent, append-only recorded decisions, and direct artifacts; working facts and methods stay cheap to revise. Independent fresh contexts can recover neglected premises and alternatives, but freshness alone proves neither independence nor correctness.

## Stable Direction, Plastic Method

User outcome, non-negotiables, acceptance, authority, and strict-effect boundaries anchor a task. Decomposition, role composition, test order, probes, correction strategy, and intermediate record shape are methods. Treating methods as permanent authority blocks learning; treating intent as a working guess causes drift.

Existing patterns are useful defaults because they encode experience. They become binding only when consequence requires them or repeated evidence shows that judgment alone does not reliably preserve the protected concern. A useful pattern can remain optional. A rule earns mechanical enforcement only when its subject is finite, its violation is directly observable, and the enforcement is cheaper than the failures it prevents.

The practical unit of progress is a changed artifact, belief, or decision. Activity, role transitions, status updates, and polished explanations are coordination cost. Predicting the intended change before a material action exposes empty motion more reliably than counting actions after the fact.

## Documents And Reality

Engineers own user intent; intent documents preserve durable direction, change records preserve sourced task intent, and accepted authorities preserve design decisions. Neither a well-written document nor an accepted design proves faithful capture of the source intent. Git, artifacts, running code, and external systems establish implementation facts without authorizing a different design. Fidelity therefore has two gaps to examine: source intent to recorded decisions, and accepted decisions to implementation. Change records and reports provide evidence, not design authority or substitutes for reading the artifact.

The economical time to catch these gaps is while affected work is understood. Compare the relevant source statements, owning decisions, and implementation as the task proceeds; correct ordinary drift locally and return a real decision to the engineer. Incremental Auditor scrutiny can include governing rules and relevant unchanged consumers. Sparse independent audits and mutation calibration remain useful for missed patterns and blind detectors; repeatedly rereading the entire growing corpus is not the default protection.

Authority should change more slowly than its projections. Core documents hold stable model decisions, specifications hold concrete contracts, and generated checks detect drift. Raw reasoning, transcripts, and temporary evidence stay outside the canonical corpus until a durable conclusion has an accepted owner.

Compression is selective, not lossy by convenience. A rewrite must preserve every criterion whose absence could change behavior, failure, recovery, ownership, security, or responsibility. At the same time, vocabulary has a cost: a named concept in an always-loaded contract is likely to become an obligation. One-use terminology belongs in discussion evidence, not governance.

## Testability And Verification

Testing is the main observation channel available to delegated engineering, so testability is an architectural property. A component that owns an effect domain should be the only component whose tests require that effect domain. If a check needs an effect its subject does not own, the boundary has leaked; granting the check broader access hides the symptom and preserves the defect.

A missing observation may justify a temporary probe or an owned observation channel. A valid disposable probe should not force permanent infrastructure. When deciding evidence needs a stable channel, its semantics belong with the subject; tests should not maintain a parallel observatory or claim a proxy proves an inaccessible effect.

Iteration latency matters separately from test coverage. Cheap local iterations let an agent run, observe, correct, and run again. When every attempt requires a remote authorization or formal handoff, the agent substitutes source inference for observation. Bounded disposable environments and focused checks preserve iteration without weakening credential, containment, data-loss, or irreversible-effect controls.

Tests themselves are fallible. A green harness may never have traversed its deciding assertion, a fixture may replace the real subject, and a review question may have no stopping condition. `docs/verification-instruments.md` therefore owns oracle classification, deliberate negative outcomes, effect-domain rules, and real-environment identity. These protections remain applicable when an instrument actually decides work; they are not reasons to manufacture a gate for every task.

## Independence By Consequence

Independent contexts are valuable when producer bias, uncertainty, authority, or consequence makes self-review insufficient. They are costly as a fixed sequence for every correction. The primary composes test authoring, implementation, review, consultation, audit, and research according to the failure that must be intercepted. It can steer or replace a role using source intent, artifacts, evidence, and unresolved objections; agreement and green results are not instructions to the replacement.

Consultant asks whether the work is valuable, the premise defensible, and the proposed route reasonable and feasible among the alternatives examined. Its best intervention is before substantial investment, using a proportionate proposal and cheap probes. Agreement is a reasoned decision with exposed assumptions, not proof of optimality. Reviewer asks whether the actual result is correct, complete, simple, and aligned with accepted intent and owners. Auditor examines fidelity across intent, authority, evidence, and implementation, including the governance itself. These are different questions, not consecutive sign-offs.

A fresh direction intervention cannot depend entirely on the drifting primary noticing drift. A concrete evidence or stage checkpoint can expose the route independently before its next substantial commitment. Prose alone cannot dispatch that context or guarantee its attention: the primary must arrange the intervention, and later observation must distinguish an instruction from actual operation. Consultant is not a routine final bug reviewer; a late direction judgment matters when the delivered scheme has materially changed.

A producer may inspect, test, and repair its work; it cannot provide its own independent acceptance. Shared conclusions, a new role name, or a replaced context do not erase co-authorship. Independent reviewers derive expectations from source intent and owning decisions, inspect actual artifacts, and retain contrary evidence. Stronger independence follows consequence and uncertainty rather than a universal role quota.

## Safety And Recovery

Authorization, confidentiality, credentials, data loss, destructive actions, publication and other external effects, sandbox containment, and concurrent writes remain strict. Their consequence is not reduced by ordinary proportionality. Uncertainty fails closed, cleanup reaches settlement, and residual state is reported truthfully.

Ordinary errors should not collapse the whole program. A failed hypothesis changes belief, an in-scope defect is corrected, and a defeated premise triggers reframe. A useful probe or independent intervention may restore a viable route; if it cannot, the agent should actively invite the engineer with the unresolved choice and best supported recommendation. Missing authorization is immediate. Endless probing to avoid asking spends attention and time without buying autonomy.

One writer per repository path is the minimum useful concurrency mechanism. More elaborate inventories and lease accounting are justified only if actual pilot evidence shows that this direct rule cannot preserve work.

## Learning Outside Execution

Executing agents should optimize for the user outcome, not for framework metrics. Raw transcripts, timings, checkpoints, artifacts, human interruptions, failed premises, and recovery evidence may be retained for later audit. Rates and scores do not return to the active loop as live breakers because they invite Goodhart behavior and turn measurement into another workflow controller.

Framework changes should follow repeated observations across completed work. A candidate pattern is tried before it becomes universal. When evidence supports an addition, install the smallest rule or mechanism that directly catches the repeated failure and state what would make it removable.

## Related Documents

- `AGENTS.md`
- `docs/change-execution.md`
- `docs/change-execution-rationale.md`
- `docs/verification-instruments.md`
- `docs/documentation-model.md`
