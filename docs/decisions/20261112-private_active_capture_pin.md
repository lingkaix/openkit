---
status: Accepted
date: "2026-11-12"
decider: Coordinator under engineer standing authority
---
# Private Active Capture Pin

## Decision

The private recovery-capture message may carry one `active` variant with `workspaceId`, `captureId`, `state` of `active`, and `origin` of `manual` or `automatic`. The public protocol, the retained capture record, the protocol version, and the existing `finished` and `abandoned` variants stay unchanged. The native outer FULL transaction calls the same deciding body as the standalone active-capture wrapper. It is not a copy, and it omits no check. The reply and the retained read keep the original creation time. A peer that does not recognize `active` refuses it with the existing error and never treats it as terminal. The pin keeps its original hold phase. It does not release and then reacquire the posting hold, and it uses only the holder's own barrier. Ordering against a waiting global hold stays with the existing hold owner and is tested there.

This approval is not an implementation, and it is not acceptance of capture. The variant is pending.

## Reason

Active protection has to be decided by the same body that creates the retained active record. A second writer, or a copied predicate, would split that decision. One private variant on the existing recovery-capture message can run inside the native FULL transaction. It adds no public operation, retained field, native operation name, retry, service, or durable marker.

## Rejected Alternatives

- Leave active protection on a second writer beside the native owner.
- Copy the deciding predicate into generic SQL.
- Add a public operation, retained field, protocol version, or new durable marker.

## Revisit When

Revisit if the native FULL transaction cannot call the original deciding body, or if a smaller existing owner can pin an active capture without this variant. Revisit when the storage foundation records the landed realization. This record does not close that work.

## Affected Owners

- [Durable Execution And Control Store](../specs/20261019-durable_execution_and_control_store.md#snapshot-cut-and-capture-protection)
