---
status: Accepted
date: "2026-10-12"
decider: Engineer
---
# Product Integrity Check

## Decision

On 2026-10-12 the engineer accepted three rules for the product integrity check. [Product Integrity Check](../specs/20261012-product_integrity_check.md) owns the operation and the rules. The operation is one Workspace operation, `integrity.workspace.check`, and a deployment scope waits until a present invariant needs one. Admission is administrator-only through the existing `audit.read` mapping, and the operation adds no access right. The first invariant set is `usage-attribution` for stories 3 and 7, and `terminal-turn-consistency` for story 10.

## Reason

The engineer wrote 「第二十一项和第二十二项我同意。」 at 2026-10-12T03:55:53Z. The English translation is "I agree with item twenty-one and item twenty-two." The engineer gave no further reason. The coordinator records that sentence as acceptance of the three draft questions.

The accepted reasons are the coordinator's recommendations, which are stated in the Decision and Alternatives Considered sections of [Product Integrity Check](../specs/20261012-product_integrity_check.md).

## Rejected Alternatives

A scope kind that means either deployment or Workspace lost. The operation uses the existing body Workspace selector.

A stored check history lost. The call response is the result, and no consumer needs a stored history.

A boot-time or readiness gate lost. Readiness already owns admission.

A second derivation of the restart classifier lost. The reliability owner already has one classifier for online closeout, replay, and boot.

The coordinator excluded an event-log repair, a snapshot coordinator, a grace period, an event identifier scheme, and an extension mechanism. The coordinator's instruction after the first independent review excludes a snapshot coordinator, a grace period, and an extension mechanism. The coordinator's instruction after the re-review excludes those three and an event identifier scheme, and it confirms that the complete event reader rewrites the event log. The reviews preserved those limits and did not reject a separate proposal for each mechanism. [Product Integrity Check](../specs/20261012-product_integrity_check.md) states the resulting contract.

Folding `knowledge.health.check` into this operation lost. That operation answers a different Knowledge question.

## Revisit When

When a present invariant needs a deployment check, revisit the scope. When an accepted owner changes who may read retained audit records, revisit admission. When a story needs an invariant that [Product Integrity Check](../specs/20261012-product_integrity_check.md) does not name, revisit the first set.

## Affected Owners

- [Product Integrity Check](../specs/20261012-product_integrity_check.md) states the operation, the two names, and the admission rule.
- [Policy Enforcement Mapping](../specs/20260703-policy_enforcement_mapping.md) owns the product-operation and access-right mapping.
- [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md) owns how a story names the integrity invariants that it relies on, and it does not define the operation.
- [Operation Definition](../specs/20261002-operation_definition.md) will receive the projection sentence when the family exists.
- Stories 3 and 7 depend on `usage-attribution`. Story 10 depends on `terminal-turn-consistency`.
