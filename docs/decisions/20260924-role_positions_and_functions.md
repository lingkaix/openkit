---
status: Accepted
date: "2026-09-24"
decider: Engineer
---
# Roles Have A Position And A Function

## Decision

Agent roles are described on two axes. Position is relative to one scope of work: the dispatcher hands the scope over (the engineer, the OpenKit product Orchestrator, or a parent primary); the primary owns that scope's intent, integration, and acceptance, and each scope has exactly one; a delegate does part of the work for the primary. Positions nest: an agent that receives a scope from a dispatcher is the primary of that scope, and the agents it dispatches are its delegates. Function is the question a context answers: researcher, test author, builder, writer, reviewer, Consultant, or Auditor. "Orchestrator" remains a product term for the built-in coordinating agent that dispatches but does no work itself; the engineering vocabulary maps it to a dispatcher. "Copilot" is replaced by "delegate". No role is added and none is renamed. A primary may perform any function itself, which is the better choice when the context a delegate would need cannot be handed over without loss, as when the primary drafted documents after discussing them with the engineer; independence rules still apply, so another context checks what the primary produced. Because the primary's decomposition shapes where code and documents grow, the primary carries the design leading words: Deep Module and Information Hiding, Separation of Concerns, Seam, and Conway's Law, applied as dispatch along owner seams.

## Reason

The engineer observed that the primary of a small task does real work and hands side tasks to delegates, while the product Orchestrator only coordinates, and asked whether they are one role. Measurement on 2026-09-24 found that "Orchestrator" does not appear in the engineering governance at all, only in product documents, so the confusion was a collision between two bounded contexts. The discussion had also produced advisor, copilot, and writer; advisor was already folded into the Consultant, copilot names a position rather than a question, and writer answers a distinct editing question under constraints that differ from building.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-009.

## Rejected Alternatives

- Treating primary and Orchestrator as one role. Rejected; one is a position relative to a scope, the other a product component.
- Adding copilot or advisor as roles. Rejected as positions or stances of existing functions.
- Renaming existing roles. Rejected as churn without a clarity gain.

## Revisit When

A recurring kind of delegated work fits no function, or agents still confuse the product Orchestrator with the engineering primary after the glossary lands.

## Affected Owners

- docs/change-execution.md
- docs/roles/README.md
- docs/glossary.md
