---
status: Accepted
date: "2026-10-17"
decider: L-AW, under the coordinator-unavailable delegated rule
---
# Context Projection Accounting

## Decision

At 06:09:09 UTC, lane L-AW adopted the recommended fallback after the unanswered 05:53:30 UTC question under the coordinator-unavailable rule. The coordinator did not answer or adopt this fallback. Remove the requirement that each Context Package projection retain a model-specific token budget and accounting identity. [Worker Context Package](../specs/20260703-worker_context_package.md#knowledge-selection-input-and-delivery) owns the amended projection contract.

Keep the manifest's existing package allowance and the separately owned complete final-request admission, including the actual output reserve. A package or preview does not prove physical model fit. Preserve original and delivered digests, exact representation ranges, independent byte limits, immutable bytes, current authorization and existing package proofs. Add no durable counter, migration, predecessor reader, replacement field or accounting framework.

## Reason

The optional projection accounting field has no production producer. Its synthetic fixture and counted-token comparison do not establish complete request admission. Package allowance and final-request admission already have separate owners, while the projection must prove which bounded source bytes were delivered.

## Rejected Alternatives

- Require new per-projection counters or proof records: no current producer or delivery need requires that state.
- Treat a bounded projection as complete-request fit: it does not observe instructions, other content or the actual output reserve.
- Retain a legacy reader or migration for the unused field: the pre-stable reset boundary does not require that compatibility work.

## Revisit When

An accepted owner identifies a concrete consumer that needs per-projection accounting in addition to package allowance and complete final-request admission.

## Affected Owners

- [Worker Context Package](../specs/20260703-worker_context_package.md).
