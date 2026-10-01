---
status: Accepted
date: "2026-10-02"
decider: Engineer
---
# Inference Account Observation Projection

## Decision

The account list and detail read model gains one optional `inferenceObservation` member carrying process-local access-rejection and quota-exhaustion observations. Each part is present only when observed and carries its own observation time; the member is absent when neither is observed. Observations are scoped to the exact account and credential material version, and absence means unknown remote acceptance or quota, never healthy or exhausted. Provider Subscription Accounts owns the shape, same-credential proof, lifecycle and public projection. The Gateway Provider card reads this member without an upstream quota request under the Web projection owner.

The quota response keeps its existing union and meaning and reflects only its live upstream result, without an inference-observation overlay. A successful `available` result clears the quota observation, and an accepted quota read clears the access observation, under the existing same-version and success predicates. The projection changes neither locally resolvable login nor credential custody, adds no durable observation store, and does not make observations a routing input.

## Reason

On 2026-10-02, the coordinator proposed an optional observation member on the account read model instead of overlaying inference observations onto the quota response. The engineer accepted the coordinator's proposal in Gateway routing proposal, Engineer Ruling 14: 「账号读模型加字段 (Recommended)」, translated as “Add a field to the account read model (Recommended).”

The owner already required inference-only rejection feedback for both providers without a quota refresh, but the only public observation surface was the quota union. That union could express `authentication_required` but could not express quota exhaustion, and the account read model had no observation member. An account read-model projection makes these process-local observations visible without changing the meaning of the separate live quota read or requiring an upstream request to show inference feedback.

## Rejected Alternatives

- Overlay inference observations onto the quota response when its upstream read fails, with a new exhausted availability value and a precedence rule. This would extend the quota union and mix earlier inference evidence with a live quota result, requiring consumers to distinguish which source controls availability and observation time. The engineer chose a separate account read-model member and preserved the quota union and meaning instead.

## Revisit When

Coordinator-proposed revisit conditions, not an Engineer ruling: observations must survive restart, or routing starts consuming them.

## Affected Owners

- docs/specs/20260721-provider_subscription_accounts.md
- docs/specs/20260628-web_product_surface_projection.md
