---
status: Accepted
date: "2026-09-24"
decider: Engineer
---
# Design Principles For Systems Built By Agents

## Decision

Systems and workflows are designed around fast, clear feedback loops, because agents work best by exploring, building, testing, and trying again. At system boundaries this means fail fast: validate at admission and report a violated known invariant or an unknown required semantic immediately with an error that names its owner, instead of continuing with damaged state. Fail fast does not mean retry fast; a repeated method still needs a new hypothesis. Interfaces follow separation of concerns, composition over inheritance, and the open-closed principle applied only at a variation point that already exists, when a second or third member arrives, so that it agrees with the rule against predicting variants. Ablation is used during implementation: before handing work over, a builder asks of every mechanism it added which required behavior would fail without it, and a mechanism with no answer is a deletion candidate, which is decided only by an oracle shown to see that responsibility. Gray-box modules are adopted in two senses: the engineer decides interfaces while agents and tests own the inside, and tests protect the public seam's contract with limited internal observation only where return values cannot prove a responsibility such as recovery. From domain-driven design the project borrows Ubiquitous Language, Bounded Context, explicit translation between contexts, anti-corruption layers around external agent runtimes, aggregates sized by consistency needs rather than containment, and core, supporting, and generic subdomains to decide where design effort goes. From behavior-driven development it borrows specification by example with example mapping and agreement on examples before building, without a Gherkin runner. None of these requires a wholesale DDD or BDD refactor.

## Reason

The engineer proposed fail fast and feedback loops, the three interface principles, and asked whether Ablation, Gray-box Modules, DDD, and BDD offer useful ideas without full adoption. Measurement on 2026-09-24 found three class inheritance sites outside error types in production code, so composition is already practice and needs only a name. The open-closed principle was already part of SOLID in root AGENTS.md; what was missing was when it applies. The earlier architecture-first direction had already chosen moderate DDD and BDD.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-009.

## Rejected Alternatives

- Adopting DDD tactical patterns or BDD tooling wholesale. Rejected by the engineer.
- Building extension points in advance of a second variant. Rejected by the rule against speculative abstraction.

## Revisit When

A principle named here is repeatedly cited to justify added machinery, or feedback loops slow because fast checks stop observing their subject.

## Affected Owners

- docs/engineering-doctrine.md
- docs/core/foundation.md
- docs/roles/builder.md
- docs/roles/reviewer.md
- docs/roles/test-author.md
- docs/specs/20260529-test_strategy.md
