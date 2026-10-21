---
status: Accepted
date: "2026-10-21"
decider: Coordinator, under the engineer's standing delegation
---
# Pending Authority At Effect Submission

## Decision

The native Pending claim is an at-most-once reservation with native-owned checks. Main-owned current authority is checked synchronously at the existing effect-submission boundary after asynchronous preparation: after FULL claim acknowledgement and before external contact, or immediately before posting the complete Goal claim-and-effect transaction. Goal authority linearizes at that check; a later authority change does not revoke the admitted operation. Native withdrawal or conflicting business mutation that wins before the compare-and-set prevents the effect. Each later effect checks its own current authority.

CapabilityCall, PermissionDecision and required Audit retain their Main writer. The Main submission step writes the original rows with the existing request-derived execution call identity before contact. A failed authority check records a failed call with `upstreamContacted=false` and no usage, then posts native `execution-error`. A claimed unfinished request becomes `outcome-unknown` after restart and never executes again. Recovery preserves truthful contact knowledge: absence of the call row proves no contact. Claim, Goal effect, disposition and original receipt remain one native transaction. No lock, lease, snapshot, global gate, new ledger or cross-owner atomicity is added.

## Reason

The coordinator accepted this ordering on 2026-10-21 under the engineer's standing no-block delegation after independent consultation identified that Main identity, membership, Vault and configuration cannot participate atomically in the native Workspace claim. The external submission check lets revocation between claim and contact win. The Goal boundary admits one internal operation before post; later effects remain subject to their own checks. Keeping complete record families on Main preserves one logical writer per family.

## Rejected Alternatives

Moving CapabilityCall, PermissionDecision or Audit to a second writer; holding a Main SQL transaction across an await; treating a native claim as durable authority from another owner; adding a lock, lease, snapshot, gate, ledger or automatic effect replay.

## Revisit When

An accepted invariant requires these Main records atomically with a native claim, or independent deciding tests show that the ordered boundary permits another contact, an unauthorized submission or an untruthful recovery result.

## Affected Owners

- [Pending Requests](../specs/20260930-pending_requests.md), Execute A Granted Call and command-intent consumption.
- [Goal](../specs/20261002-goal.md), current authority and grant consumption.
- [Durable Execution And Control Store](../specs/20261019-durable_execution_and_control_store.md), Write And Space Budget.
