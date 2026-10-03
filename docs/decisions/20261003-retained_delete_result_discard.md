---
status: Accepted
date: "2026-10-03"
decider: Coordinator, under the engineer's standing delegation to decide in the engineer's absence, on an independent Consultant's two-round analysis
---
# Retained Delete Result Discard

## Decision

The Coordinator decided that a retained successful sandbox.delete result may receive ordinary empty 204 without mutation when no pending command or result-only expectation exists, its complete deterministic request identity derives from exactly one matching backend row, that row is physical-cleaned or cleaned, and the body is exactly the matched Sandbox with state deleted. [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md) owns the exception. The acknowledgement disposes of transport delivery; it proves neither prior dispatch nor effect settlement and releases no capacity. Invalid, ambiguous, or unfinished-cleanup cases keep terminal rejection. No durable receipt or NanoHost change is added.

## Reason

A retained delete result after NanoCore restart could terminate NanoHost even after physical cleanup. Deterministic identity proves correlation rather than prior settlement. The Consultant's second round found that broader discard could remove the only retained result needed by unfinished cleanup, leaving a later result-only expectation stalled. Restricting discard to physical-cleaned or cleaned rows avoids that recovery dependency while preserving existing cleanup ownership.

Source decision: temp/comm-redesign/engineer-queue.md, entry "NanoHost exit on a retained delete result after a NanoCore restart", dated 2026-10-03. Source analysis: temp/interface-unification/reports/nanohost-stale-result/consult-report.md, including Round 2. Landing commit: 4da2d0d2a5299e4d80695b2edb3fa2be7c472fb3. These are provenance references, not behavioral authority.

## Rejected Alternatives

- An immutable successful-result receipt on the backend row: the Coordinator rejected new durable state, and the Consultant withdrew that recommendation when acknowledgement was reframed as delivery disposal rather than settlement.
- Discard against any correlated backend row: the Consultant found a counterexample in which unfinished cleanup later waits for the discarded result. The chosen exception excludes those rows.

## Revisit When

None recorded.

## Affected Owners

- [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md)
