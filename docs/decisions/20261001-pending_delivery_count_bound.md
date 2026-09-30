---
status: Accepted
date: "2026-10-01"
decider: Engineer
---
# Pending Delivery Count Bound

## Decision

The engineer chose 「删掉虚引用，只按数量限制」 (English: "delete the phantom reference, limit by count only") from the Consultant's recommended alternatives on 2026-10-01. Remove the nonexistent aggregate-input-budget reference. Preserve the 16-outcome limit and each producer or transport owner's actual limits. Carry every selected value completely, including the independent Turn input. The engineer accepts that a large input may exceed executor capacity and be refused downstream. The affected owner holds the exact admission, carriage and proof rules; this decision is not implementation acceptance.

## Reason

Sixteen MCP result limits do not bound captured arguments, questions, answers, trigger text and serialized envelope overhead. No accepted universal aggregate byte budget was found. Count-only faithful delivery is the smallest coherent rule and needs no new packing, overflow, durable state or hidden retry mechanism. Downstream refusal remains truthful under the existing delivery-proof owner.

## Rejected Alternatives

- Retain the reference and assert `16 × 512 KiB`: excludes unbounded components and gives a false byte proof.
- Add universal per-part caps now: rejects otherwise accepted input and requires complete metadata, escaping, retained-data and overflow semantics without a demonstrated capacity need.
- Add aggregate packing now: introduces trigger precedence, readiness order, starvation and single-oversize decisions that the present gap does not justify.
- Summarize, truncate, omit or mark delivered silently: destroys accepted content or fabricates delivery proof.

## Revisit When

Evidence shows that a supported input must reliably fit a specific executor. That requires a numeric admission limit with its complete measured representation, included fields, rejection boundary, treatment of retained records and oversized-outcome semantics.

## Affected Owners

- [Pending Requests](../specs/20260930-pending_requests.md#deliver)
