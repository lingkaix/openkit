---
status: Accepted
date: "2026-09-23"
decider: Engineer
---
# Specifications Declare A Kind And Are Divided At Promotion

## Decision

Every active specification declares one kind: concept, boundary, mechanism, topology, or process. The kind supports one placement rule: concept-specific semantics live in the concept's specification, while a cross-cutting mechanism specification owns the questions every member must answer plus a registry of its members. A Draft may be organized by feature or problem, following the real path from a rough idea through research and discussion; the division into kinds happens when it is promoted to Accepted, and an independent reviewer checks at that point that every criterion still exists.

## Reason

The engineer pointed out that Deep Module thinking cannot shape every specification, and that many specifications begin as a rough idea that an agent researches into a draft, so a perfect module division cannot be demanded at the start. The runtime child retention change showed the cost of shallow mechanism specifications: one new concept required short additions to seven specifications, most of them legitimate registry entries but some restating semantics that the concept's own specification should have answered. That is documentation-level Shotgun Surgery. Dividing at promotion treats the draft as a tracer bullet and promotion as its refactoring. Promotion is also where relocation loses qualifiers most often, so it receives the independent criterion check that DOC-015 requires.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-003.

## Rejected Alternatives

- Organizing every specification around one deep module. Rejected because boundary, topology, and process specifications have no single module.
- Requiring the final division in the first draft. Rejected because it contradicts how designs are actually discovered.
- New directories or document types per kind. Rejected; one frontmatter field is enough.

## Revisit When

A specification repeatedly fits no kind or two kinds equally, or the first promotions show that division at promotion loses criteria despite the independent check.

## Affected Owners

- docs/documentation-model.md
- docs/specs/README.md
- scripts/validate-doc-model.mjs
