---
status: Accepted
date: "2026-09-23"
decider: Engineer
---
# Review Uses Executable Counterexamples And Raw Observations, Not Scores

## Decision

Independent review of work that crosses a representation boundary favors executable counterexamples against invariants, such as decode-then-check, reassembly across units, replay after publication, and resumption at a watermark. Reviewer and Auditor ask what callers must know or do to use a module correctly, including internal steps, flags, ordering, and fallbacks, and they report raw before and after observations with their direction, without scores or sums. When work is dispatched in parallel, each interpretation rule it depends on has one named owner, as well as each writable path. The following are not adopted: scoring frameworks as gates, the pilot's unproven discovery hypothesis as a standing rule, fixed rounds with audits every second round, repository-wide Gherkin or mutation requirements, and the 10–20% design heuristic as a quota.

## Reason

In the runtime child retention change, four boundary defects were found by a reviewer who wrote short scripts at the boundary while the builders' focused suites passed. Of the pilot's observation framework, only the caller-burden question and the reporting discipline were new; its other items repeated existing rules, and its scores could not decide edge cases mechanically. Named concepts in the always-loaded contract tend to become obligations, so these questions live in the role contracts.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, topics one and four.

## Rejected Alternatives

- Adopting the pilot's full observation framework with codes. Rejected as mostly duplicated and unscoreable.
- Relying on builder focused suites for boundary behavior. Rejected by the observed defects.

## Revisit When

Seeded-defect calibration shows the review path missing a boundary defect class, or raw observations prove unusable without aggregation.

## Affected Owners

- docs/roles/reviewer.md
- docs/roles/auditor.md
- docs/change-execution.md
