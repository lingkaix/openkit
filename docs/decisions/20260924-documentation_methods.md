---
status: Accepted
date: "2026-09-24"
decider: Engineer
---
# Documents Are Built And Governed Like Code

## Decision

Documentation, the project's primary source of truth, enters the build and governance process. Design and governance documents live under docs/, while each local guide stays beside the directory it describes. Documents follow progressive disclosure organized by concept, not by length: a large concept has one entry document with its definition, invariants, ownership boundary, and a list of its child documents, and each child owns one self-contained part. Every document opens with a summary. A soft size limit triggers a split review instead of a gate, and splitting an existing large specification is its own change with an independent criterion check. The generated index stays a projection, and a hand-written situation index gives the layered entry. The execution rule is doc-first: when observable behavior or a contract changes, the owning criterion changes first or in the same change; an implementation-only change updates no normative document and touches a local guide only when that guide is affected. The documentation toolset borrows from classic software engineering: normalization (each fact stored once, with projections linked to their source), traceability between criteria and tests in both directions, design by contract for boundary specifications, terminology lint over the avoid list, and a test pyramid for documents with structural validators at the base, specification mutation in the middle, and a sampled rebuild probe at the top. Document ablation complements specification mutation: removing a clause asks whether any derivation would change, and mutating it asks whether a projection would notice, which sorts clauses into keep, gap, over-constraint, and deletion candidate. Document complexity signals, such as required reading words, link fan-in and fan-out, owners touched per change, restated facts, and undefined terms, are explanatory trends for the Auditor, never targets.

## Reason

The engineer proposed placing documents under docs/, progressive disclosure with small linked documents, a root index, and a mandatory documentation update with every feature change. Measurement on 2026-09-24 showed that most of this already existed, with two gaps: the largest specification had 51,229 words and seven others exceeded 9,000, and a mechanical "update documents with every change" rule would push implementation detail into normative text. Splitting by length rather than by concept would scatter one concept's invariants across files, which is where relocations have silently broken before.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-009.

## Rejected Alternatives

- Splitting documents into chapter files by length. Rejected for scattering invariants.
- Requiring a documentation edit in every feature change. Rejected for accumulating implementation detail.
- Readability scores. Rejected as uninformative.

## Revisit When

A split entry document still exceeds what one agent context can use, or doc-first proves unenforceable in review.

## Affected Owners

- docs/writing.md
- docs/documentation-model.md
- docs/specs/README.md
- AGENTS.md
- docs/specs/20260719-verification_calibration.md
