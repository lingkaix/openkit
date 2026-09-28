---
status: Accepted
date: "2026-09-23"
decider: Engineer
---
# L2 Proves Boundary Behavior With Real Producers And Consumers

## Decision

The test strategy's L2 layer asks whether the two sides of a boundary agree in shape and in behavior at the crossing, including under failure. In-process composition of the real producer and the real consumer, with no double on either side of the crossing, fault injection at the crossing, and assertions written as invariants, is a core part of L2 and not an optional variant. The primary regression for a cross-boundary invariant is that composition test, not one test on each side. When a change alters a representation that crosses different owners, whether packages or effect domains, the primary names the seam in the plan, a reviewer checks that it was named, and a test author reads both owning contracts. A reviewer's reproduction of a boundary defect becomes a regression under the existing test-first rule; no new rule was added for that.

## Reason

The runtime child retention change put its defects between layers: in process, across packages, with real code on both sides. Fixture conformance answers the L2 question only indirectly, because both sides are checked against a fixture that one author wrote from intent, and that blind spot is where the defects were. Composition answers the same question directly by comparing behavior, not only shape. The engineer corrected the first proposal, which called these tests a named L2 variant, because L2 exists to ask whether both sides agree and a variant label would make the direct answer look optional. These tests stay deterministic and in process, so they belong to L2 and remain suitable for pull-request gates. A test author dispatched with one owning specification could not write them, which is why the dispatch rule changed. The four boundary defects found by review were all converted to regressions, so the existing test-first rule already worked for that part.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-006.

## Rejected Alternatives

- A new layer between L2 and L3. Rejected because L0–L6 is referenced across many documents and renumbering costs more than it returns.
- A named L2 variant. Rejected by the engineer as understating its role.
- Mechanical detection of seam-crossing changes. Rejected; naming the seam is a judgment checked by review.

## Revisit When

Composition tests prove too slow for pull-request gates, or boundary defects continue to escape L2 after seams are named.

## Affected Owners

- docs/specs/20260529-test_strategy.md
- docs/change-execution.md
- docs/roles/test-author.md
- docs/roles/reviewer.md
