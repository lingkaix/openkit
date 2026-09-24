---
status: Accepted
date: "2026-09-24"
decider: Engineer
---
# A Recorded Collector Fault Preserves The Work Outcome

## Decision

For Worker and Gateway collectors, a source or parser fault that is durably recorded as an unavailable or failure fact does not by itself change the actual work outcome or trigger another execution. Failure to persist required observations or failure facts remains fail-closed under the existing transport and execution owners. Authorization, revocation, lineage, and durable receipt requirements remain binding.

## Reason

Collection quality and the result of the work are distinct facts. A retained gap makes incomplete collection visible without relabeling completed work as failed. A failure that prevents the required facts from being recorded cannot make that claim and remains fail-closed. The engineer explicitly approved Proposal B during the runtime-retention handoff on 2026-09-24 after independent Consultant challenge and a concrete owner amendment.

## Rejected Alternatives

- Failing the work whenever collection faults, even after the gap is durably recorded. Rejected because it conflates work outcome and observation quality.
- Ignoring failures to persist required facts. Rejected because it would silently remove the required observation and receipt boundary.

## Revisit When

A separately governed operation requires complete capture as a precondition for its own success.

## Affected Owners

- docs/specs/20260921-work_data_retention_format.md
