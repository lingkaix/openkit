---
status: Accepted
date: "2026-09-23"
decider: Engineer
---
# Documents Pass When A System Can Be Rebuilt From Them

## Decision

The governing test of documentation as the single source of truth is this: after every implementation file is deleted, an agent can rebuild a system that meets the design and behavior expectations from the documents alone, possibly in another language, stack, or internal design. The engineering doctrine states the principle. A rebuild probe, which gives a fresh agent only the documents of one small, well-bounded subsystem and checks its result against existing black-box conformance tests, joins specification mutation as a documentation-governance instrument owned by the verification calibration program. The probe is not run as part of adopting it. Writing rules follow from the test: normative text does not depend on implementation identifiers or line citations, boundary conformance tests are part of the executable specification, specifications constrain boundaries and invariants rather than internal method unless an internal decision is load-bearing, and technology choices that are decisions state their reasons.

## Reason

The engineer defined success for this project as documents that let an agent reassemble the system after the implementation is gone. The criterion is falsifiable, which makes it usable: every question the rebuilding agent must ask is a specification gap, and every sentence it cannot use without source code is a coupling. Like mutation testing, it establishes the power of the documents by intervention rather than by reading. On 2026-09-23, 45 of 92 specifications cited source paths in their bodies and 96 file-and-line citations existed across them, none in Core.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-003.

## Rejected Alternatives

- Running a rebuild on every documentation change. Rejected as too expensive; the probe is sampled.
- Judging documentation quality by reading or by validator results. Rejected because validators pass through missing criteria and reading does not show what a rebuilder would have to guess.

## Revisit When

After the first actual rebuild probe, when its result shows how its conditions of use should change.

## Affected Owners

- docs/engineering-doctrine.md
- docs/specs/20260719-verification_calibration.md
- docs/specs/README.md
- docs/writing.md
