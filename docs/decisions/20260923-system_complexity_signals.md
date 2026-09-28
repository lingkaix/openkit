---
status: Accepted
date: "2026-09-23"
decider: Engineer
---
# System Complexity Is Governed At Design Time And Observed As Trends

## Decision

Complexity control is strengthened at design time rather than at cleanup time. When a new concept is proposed, three questions are asked: can it be an instance of an existing kind (closure), can it register into existing dispatch instead of changing every operation (additivity), and can its durable state be derived from existing facts. At the close of material work the primary records a few raw numbers in the change record, such as files and owners touched and owner documents changed. At a release boundary or on request, an Auditor compares those numbers as trends, first excluding measurement artifacts such as batch commits and generated files. The signals explain; they are never builder targets, thresholds, or gates. Triage separates essential complexity, which is the price of an engineer's choice and goes to the engineer as a trade-off with a recorded decision, from accidental complexity, which becomes a finding with its owner and smallest correction. A correction that changes governing design follows the challenge path with independent Consultant review and engineer approval. The same signal is measured again after correction, and a signal that recurs after correction is treated as a structural cause for the engineer, not as more local cleanup.

## Reason

The existing rules guard each change locally and did catch unused structure, but they have little leverage on system-level complexity. Measurement on 2026-09-23 showed all three of Ousterhout's symptoms: one feature touched 96 files and 8 specifications, single documents and files far exceed any agent context, and closed sets were restated invisibly in several places. In the runtime child retention change most of the volume was essential, yet the same knowledge was still restated in three places that local review did not flag. SICP's data-directed additivity, abstraction barriers, and closure property, together with Brooks's essential versus accidental complexity, give the design-time questions. Keeping signals away from builders avoids Goodhart's law.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-002.

## Rejected Alternatives

- New roles or a new process for complexity. Rejected; the work attaches to existing closeout and audit events.
- Thresholds or gates on the signals. Rejected because the measure would become the target.
- A repository-wide registry pattern. Rejected; a probe showed additivity pays only for repeated wiring, and type exhaustiveness is often enough.

## Revisit When

The recorded numbers prove unused at two consecutive audits, or a signal is found to be optimized for its own sake.

## Affected Owners

- docs/change-execution.md
- docs/roles/consultant.md
- docs/roles/auditor.md
- docs/engineering-doctrine.md
