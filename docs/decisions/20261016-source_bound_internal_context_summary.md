---
status: Accepted
date: "2026-10-16"
decider: Engineer
---
# Source-Bound Internal Context Summary

## Decision

Use a bounded source-bound canonical summary Item under the existing Thread owner. The summary names its exact source range and source digests. Current verification is mandatory before reuse; failed verification can never authorize silent truncation.

The ordinary Provider path produces the summary within the existing Assistant budget and retains usage, audit and failure evidence. A producer failure leaves that attempted boundary unadvanced and visible. Exact history remains retrievable through the existing history Tool. Web and CLI show the covered range so the user can inspect the model's retained context.

## Reason

The engineer approved this decision through the lane question channel on 2026-10-16. A useful rolling window must retain constraints and decisions while older exact history stays available on demand. Keeping all history until physical capacity fails preserves safety but cannot provide useful continuing conversation.

## Rejected Alternatives

A second conversation store, autonomous summarizer, runner and checkpoint owner were rejected because the existing canonical Item and admitted Turn provide the required ownership. A stateless Provider continuation was rejected because restart and source revocation must remain correct without Provider state.

## Revisit When

Revisit only if direct implementation evidence defeats these accepted constraints; do not weaken retained-source or current-authority checks.

## Affected Owners

- [Context Management](../specs/20260902-agent_runtime_context_compaction.md#source-bound-summary-items).
- [Core Items](../core/core-concepts.md#item).
