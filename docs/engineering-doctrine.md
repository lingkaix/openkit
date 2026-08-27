---
status: Accepted
---
# Engineering Doctrine

This document explains the delegation premise and the observations behind repository governance. It is non-authoritative rationale: implementation and execution decisions resolve to root governance, Core, accepted specifications, and direct evidence.

## Delegation Is A Fallible System

OpenKit is an experiment in delegating most engineering execution to agents while engineers retain user intent, architecture, governing trade-offs, strict-risk acceptance, and final approval. The premise is that current agents can own a repository of this shape when boundaries remain understandable and independently verifiable.

No participant is assumed infallible. Engineers can approve a poor decomposition, a primary agent can lose direction after context compression, a builder can implement the wrong premise correctly, and reviewer language can be misunderstood. A resilient loop keeps such errors local, preserves enough reality to recover, and continues toward the outcome instead of pretending errors can be designed away.

Long-horizon work cannot rely on one uninterrupted model context. Direction must survive in append-only user intent and direct artifacts; working facts and methods must remain cheap to revise. Where a compacted or resumed context is about to pay for a belief it can no longer check, a fresh context is more valuable than asking the drifting context to certify itself.

## Stable Direction, Plastic Method

User outcome, non-negotiables, acceptance, authority, and strict-effect boundaries anchor a task. Decomposition, role composition, test order, probes, correction strategy, and intermediate record shape are methods. Treating methods as permanent authority blocks learning; treating intent as a working guess causes drift.

Existing patterns are useful defaults because they encode experience. They become binding only when consequence requires them or repeated evidence shows that judgment alone does not reliably preserve the protected concern. A useful pattern can remain optional. A rule earns mechanical enforcement only when its subject is finite, its violation is directly observable, and the enforcement is cheaper than the failures it prevents.

The practical unit of progress is a changed artifact, belief, or decision. Activity, role transitions, status updates, and polished explanations are coordination cost. Predicting the intended change before a material action exposes empty motion more reliably than counting actions after the fact.

## Documents And Reality

Engineers own user intent; intent documents durably preserve recorded user intent, and accepted authorities durably preserve accepted decisions that agents execute. Git, artifacts, running code, and external systems are sources of factual state. An audit surfaces divergence among current engineer intent, its durable record, accepted authority, and factual state for engineer disposition rather than silently choosing which one should change. Change records preserve execution context and cannot promote themselves into design authority. A report is a claim about an artifact, not a substitute for reading it.

Authority should change more slowly than its projections. Core documents hold stable model decisions, specifications hold concrete contracts, and generated checks detect drift. Raw reasoning, transcripts, and temporary evidence stay outside the canonical corpus until a durable conclusion has an accepted owner.

Compression is selective, not lossy by convenience. A rewrite must preserve every criterion whose absence could change behavior, failure, recovery, ownership, security, or responsibility. At the same time, vocabulary has a cost: a named concept in an always-loaded contract is likely to become an obligation. One-use terminology belongs in discussion evidence, not governance.

## Testability And Verification

Testing is the main observation channel available to delegated engineering, so testability is an architectural property. A component that owns an effect domain should be the only component whose tests require that effect domain. If a check needs an effect its subject does not own, the boundary has leaked; granting the check broader access hides the symptom and preserves the defect.

A system that does not expose an observation required for verification forces tests to build a parallel observatory. Where no product surface may reveal the fact, the owning design should provide a named verification-only channel. This decision belongs with the subject, not inside a late acceptance gate.

Iteration latency matters separately from test coverage. Cheap local iterations let an agent run, observe, correct, and run again. When every attempt requires a remote authorization or formal handoff, the agent substitutes source inference for observation. Bounded disposable environments and focused checks preserve iteration without weakening credential, containment, data-loss, or irreversible-effect controls.

Tests themselves are fallible. A green harness may never have traversed its deciding assertion, a fixture may replace the real subject, and a review question may have no stopping condition. `docs/verification-instruments.md` therefore owns oracle classification, deliberate negative outcomes, effect-domain rules, and real-environment identity. These protections remain applicable when an instrument actually decides work; they are not reasons to manufacture a gate for every task.

## Independence By Consequence

Independent contexts are valuable when producer bias, uncertainty, authority, or consequence makes self-review insufficient. They are costly when invoked as a fixed sequence for every small correction. The primary agent should compose test authoring, implementation, review, verification, audit, and research capabilities according to the failure that must be intercepted.

Reviewer, verifier, and auditor answer different epistemic questions without imposing a fixed order or cadence. Routine review asks whether the delivered artifact is correct, complete, simple, and aligned with its owner; rarer verification tries to falsify a key blocker, closure claim, design sufficiency, or the necessity of a mechanism; rare audit reads longitudinally from recorded intent through accepted authority, projections and tests, implementation, and runtime evidence to expose drift, calibrate detection, or preserve a terminal archive. Each produces evidence for the responsible acceptor and does not authorize new intent, architecture, trade-offs, strict-risk acceptance, or final approval.

A producer never accepts an authority-bearing artifact solely through its own report. Routine reversible work may be accepted from direct artifact inspection and focused execution evidence. Strict effects and material cross-owner claims warrant stronger independence. Fresh-context direction review serves a different purpose from artifact review and stays narrow because an unspent belief costs nothing; its owner decides where the spending happens.

## Safety And Recovery

Authorization, confidentiality, credentials, data loss, destructive actions, publication and other external effects, sandbox containment, and concurrent writes remain strict. Their consequence is not reduced by ordinary proportionality. Uncertainty fails closed, cleanup reaches settlement, and residual state is reported truthfully.

Ordinary errors should not collapse the whole program. A failed hypothesis changes belief; a defect inside the accepted outcome is corrected; a defeated premise triggers reframe; only a real intent, authority, strict-effect, trade-off, or residual-risk decision requires the engineer. This keeps human attention for decisions only a human owns.

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
