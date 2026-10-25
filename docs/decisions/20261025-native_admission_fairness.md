---
status: Accepted
date: "2026-10-25"
decider: Engineer through coordinator rulings at 21:1xZ, 21:55Z and 2026-10-26 01:57Z
---
# Native Admission Fairness And Effect Closeout

## Decision

Bound the existing physical database/Turn publication FIFO to eight total pending publications, including its active publication. Check distinct multi-Turn selectors atomically and refuse excess work before preparation or posting. This bounds one Turn's admission footprint without adding a scheduler, allocator or durable queue.

Reserve one count credit before durable MCP call admission. Only that exact call's serial terminal commands and required terminal tool-call Item publication borrow it; the original invocation owns release. Child discovery has its own credit, while cold opening, admission and unrelated publication keep ordinary accounting. An existing producer context carries the identity without a new registry or retained record. The terminal Item retains same-Turn ordering but bypasses new-admission per-Turn and aggregate byte-pressure refusal. A genuine publication failure is privately diagnosed and surfaced explicitly without rewriting a settled effect; successful SQL or acknowledgement is never synthesized.

A credited closeout charges its actual envelope and material bytes but is exempt from aggregate byte-pressure refusal. Ordinary new work sees that charge and yields first. Existing per-item ceilings remain. This also applies to builtin Knowledge answers without a new answer cap. Project definite native non-commit only at the pre-contact admission boundary; preserve original-receipt inspection and unknown-effect rules.

## Reason

Measured overload let one Turn reserve almost the entire shared count budget before its predecessor settled, starving peer Turns and effect admission. Eight bounds its pending depth while retaining the existing same-Turn ordering and bounded native writer.

Fresh closeout admission can strand an already contacted effect behind later new work. Keeping the original call's count credit preserves service for its existing terminal tuple, without promising successful SQL or concealing a lost acknowledgement.


Removing the Turn bound restores single-Turn monopolization. Releasing the credit before original settlement or removing byte priority lets new work refuse an admitted effect's finish. Ambient database-wide borrowing would let unrelated calls evade admission. Generic certainty projection would misclassify post-contact SQL failure as no effect.

## Rejected Alternatives

Worst-case byte pre-reservation was rejected: it would restrict otherwise valid slow Tools and serialize uncapped Knowledge answers behind the full material allowance before those bytes exist. At closeout, result bytes already exist in memory; refusing them does not reclaim those bytes and can turn a known effect into unknown. The accepted exemption may exceed the aggregate byte threshold by credited in-flight closeouts, bounded by their existing per-item ceilings. It introduces no extra queue or retry and does not relax FULL acknowledgement or immutable-content durability.


## Revisit When

Revisit with measured service or memory failure that the existing admitted-input bounds cannot contain. Preserve the accepted durability, original-receipt inspection and unknown-effect rules; a changed trade-off requires an engineer decision.

## Affected Owners

The governing rule is [Durable Execution And Control Store, DX Write And Space Budget](../specs/20261019-durable_execution_and_control_store.md#dx-write-and-space-budget). [Capability Usage Gateway Foundation](../specs/20260704-capability_usage_gateway_foundation.md) retains contact, original receipt, usage and unknown-outcome ownership. Qualification preserves physical commit counts, crash cuts, bounded drain, sibling service and exact reopen.
