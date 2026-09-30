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

## Collaboration Across Time

Code, comments, tests, and architecture documents are a collaboration medium between present authors and future maintainers. Language-standard documentation of functions, interfaces, and other changed entities should preserve the context needed to use and change them correctly. A description that merely repeats the syntax cannot explain why a constraint exists, what could break if it changes, or when a workaround can disappear. Root AGENTS.md CODEDOC-002 owns the required context and debt traceability; the [engineer's decision](decisions/20260928-maintainer_context_and_debt_traceability.md) records its rationale. Architectural rules belong in their confirmed Core or specification owner, while decision records retain reasons and alternatives.

## Stable Direction, Plastic Method

User outcome, non-negotiables, acceptance, authority, and strict-effect boundaries anchor a task. Decomposition, role composition, test order, probes, correction strategy, and intermediate record shape are methods. Treating methods as permanent authority blocks learning; treating intent as a working guess causes drift.

Existing patterns are useful defaults because they encode experience. They become binding only when consequence requires them or repeated evidence shows that judgment alone does not reliably preserve the protected concern. A useful pattern can remain optional. A rule earns mechanical enforcement only when its subject is finite, its violation is directly observable, and the enforcement is cheaper than the failures it prevents.

The practical unit of progress is a changed artifact, belief, or decision. Activity, role transitions, status updates, and polished explanations are coordination cost. Predicting the intended change before a material action exposes empty motion more reliably than counting actions after the fact.

## Discovery And Reuse

Repository entrypoints, names, types, and filesystem grouping provide an agent's working map. A useful module hides decisions that callers would otherwise reconstruct; a guide points to that owner and its real consumers without maintaining a second API catalog. Reuse becomes cheaper when the code carries this structure, not merely when instructions ask agents to search harder.

Local consolidation of transport policy, Composer imports, and conversation destinations removed independently maintained rules under existing owners. Keeping authored and resolved schema differences showed the other side of DRY: similar syntax can express different contracts. SOLID, KISS, YAGNI, cohesion, and coupling help judge those boundaries without prescribing classes or layers. Code Smells focus investigation on concrete maintenance costs and risks.

The engineer's direction for this work is that the codebase itself, more than prompts or instructions, decides whether agents can work in it efficiently, and that an agent should be treated like a newcomer who joins twenty times a day. The engineer decides business semantics, module responsibilities, and key seams; agents and tests own the inside. That is the useful sense of a gray-box module: callers and tests rely on the public seam, and internals stay free to change. A module is deep when its callers must know fewer internal concepts, call orders, and compensation steps, which is why a synonym facade does not count. Conway's Law applies to agent work as well: code grows along the lines along which the primary dispatches it, so dispatching along owner seams keeps modules cohesive. The decision and its reason are recorded in [a decision record](decisions/20260922-architecture_first_discoverability.md).

Concrete behavior examples can guide existing tests without a new Gherkin stack; shared domain language need not introduce a Service hierarchy. From domain-driven design the project takes Ubiquitous Language, Bounded Context with explicit translation between contexts, anti-corruption layers around external agent runtimes, aggregates sized by consistency rather than containment, and the split into core, supporting, and generic subdomains to decide where design effort goes. From behavior-driven development it takes specification by example: rules illustrated with examples agreed before building, with open questions written down. The pilot's two fresh discovery samples both found valid entrypoints, while the consolidated caller needed fewer steps. That supports local interface simplification, not a general claim of better agent discovery or a mandate for full DDD adoption. Root governance and verification owners continue to decide execution and evidence requirements.

## Complexity

Local rules catch unused structure in one change but have little leverage on the system as a whole. Ousterhout names the symptoms that matter: change amplification, cognitive load, and unknown unknowns. In September 2026 one feature touched 96 files and 8 specifications, single documents and files exceeded any agent's context, and closed sets were restated invisibly in several places. Brooks's distinction between essential and accidental complexity keeps the response honest: complete retention, crash durability, and multi-user operation are requirements the engineer chose, and their cost is a trade-off for the engineer, not a defect to be cleaned up.

The strongest lever is at design time. SICP supplies the questions: whether a new concept can be an instance of an existing kind (the closure property), whether a new member can register into existing dispatch instead of changing every operation (additivity through data-directed design), and whether callers can use data only through its constructors and selectors (the abstraction barrier), which means a value is bound once and passed on opaquely. Durable state, replay, ordering, and recovery cause much of this project's complexity, so the preference is to append facts and derive everything else. A probe found that additivity pays only for repeated wiring and that type exhaustiveness is often enough, so it is a question, not a repository-wide registry pattern. Complexity signals explain trends to an Auditor and never become targets, because of Goodhart's law.

Agents work best in fast loops of exploring, building, testing, and trying again, so systems and workflows should give feedback that is fast, clear, and trustworthy. At a boundary that means failing fast with an error that names the owner; in a workflow it means focused checks near the module, cheap probes, and error labels that point at the right seam. A fast loop can decay into trying until green, which is why failing fast never means retrying fast. Because the project is experimental and agent orchestration changes quickly, settled mechanisms stay stable while extension stays open. Every shape the project owns, from storage formats and directory layouts to interface and protocol fields, keeps a closed core and an open extension space: the values of a core field form a closed set, so an unexpected value fails closed instead of silently changing meaning, while a reader ignores additive content it does not know, so an extension costs existing readers nothing. Only an unknown required or authority-bearing extension fails closed; the engineer's ruling is recorded in [a decision record](decisions/20260930-closed_core_open_extension.md). Composition over inheritance and separation of concerns are already the practice; the open-closed principle applies at a variation point that already has a second member, not in anticipation of one. The decision and its reason are recorded in [a decision record](decisions/20260924-design_principles_for_agent_work.md).

## Documents And Reality

Documents are this project's primary source of truth, and the test of that claim is a rebuild: after every implementation file is deleted, an agent should be able to rebuild a system that meets the design and behavior expectations from the documents alone, perhaps in another language or stack. The test is falsifiable, which makes it useful; every question the rebuilding agent must ask marks a gap, and every sentence it cannot use without source code marks a coupling. It follows that normative text avoids implementation identifiers and line citations, that boundary conformance tests are part of the executable specification, that specifications constrain boundaries and invariants rather than internal method, and that technology choices that are decisions carry their reasons. Documents therefore enter the build like code: normalization stores each fact once, traceability links each criterion to its tests and back, and specification mutation, document ablation, and a sampled rebuild probe establish the power of documents by intervention rather than by reading.

Reasons need their own home. A rule's owner states what is true now and may be rewritten; why a rule exists and who decided it is needed only when someone wants to change it, which is Chesterton's fence. Decision records keep that part append-only outside the owner, so owners can be compressed without losing reasons.

Strategic Programming makes continual design maintenance part of useful delivery. For non-trivial changes, roughly 10–20% additional design attention is a useful heuristic, not a time quota, score, or entitlement to expand scope; its source is recorded in [Strategic Programming With A 10–20% Design Heuristic](decisions/20260922-strategic_programming_heuristic.md). Invest in the affected path when a concrete simplification or stronger boundary has present value; no-change is a valid result. Speculative abstractions and unrelated cleanup do not become justified by an investment percentage. Challenges to accepted design follow the independent Consultant and engineer decision boundary owned by repository execution governance.

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

A role has a position and a function. The primary of a scope owns its intent and acceptance, may do any function itself, and delegates side work when the main line needs only its conclusion, which preserves its context budget. A strong primary with cheap, bounded delegates puts the weak link where checks catch its errors. The reverse arrangement, a weak primary consulting a strong advisor, leaves the information channel under the control of the weaker model, which is poor at judging when and what to ask, so capability gaps are filled by choosing the primary well and consulting at objective triggers. A cheap delegate is worth using only when checking its result costs less than producing it.

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

Concentrated maintenance rounds complement upkeep inside each change, because the 2026-09-22 pilot showed that registered, independently audited rounds can remove residue safely while scores could not decide its edge cases. The same method can evaluate a governance change: replay a task under the old and new governance, plant seeded defects for the new review roles, and have an independent Auditor review the output against questions registered beforehand.

Framework changes should follow repeated observations across completed work. A candidate pattern is tried before it becomes universal. When evidence supports an addition, install the smallest rule or mechanism that directly catches the repeated failure and state what would make it removable.

## Related Documents

- `AGENTS.md`
- `docs/change-execution.md`
- `docs/change-execution-rationale.md`
- `docs/verification-instruments.md`
- `docs/documentation-model.md`
