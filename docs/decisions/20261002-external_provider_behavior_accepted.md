---
status: Accepted
date: "2026-10-02"
decider: Engineer
---
# External Provider Behavior Differences Are Accepted

## Decision

OpenKit does not detect, compensate for, or reject behavior outside its system boundary that differs from what its configuration declares, such as a remote Provider service or its stock adapter serializer not delivering a control that OpenKit handed over. OpenKit keeps its own service stable and correct and records what it handed; the external difference is accepted by default. The first instance is reasoning effort: when a request carries canonical `none`, the stock pi-ai Ant Ling serializer and a Chat Completions compatibility profile without effort forwarding send no explicit disabled control, and the Gateway neither adds Provider detection, rejects such members, nor patches the dependency for it. OpenKit's own stability, data correctness, and product logic remain fully owned and are not covered by this acceptance. The Gateway Responses API specification records the reasoning-effort instance.

## Reason

On 2026-10-02 the coordinator reported that two stock serializer branches cannot express a handed disabled reasoning control, that no shipped template reaches them, and that the alternatives were authoring guidance only, Gateway detection of the private stock branch, or an upstream patch. The engineer ruled: 「这是远端服务商的行为，不是我们系统需要处理的范围。我们只要保持我们的服务能够稳定正常的运作就可以了，至于系统外部的行为不一致，我们不予处理，默认接受。」, translated as “This is the remote Provider's behavior, not within the scope our system needs to handle. We only need to keep our service running stably and normally; inconsistencies in behavior outside the system we do not handle and accept by default.”

## Rejected Alternatives

- Detect the stock serializer branch in the Gateway and reject or refit members that cannot deliver a disabled control. It duplicates private dependency detection that drifts with each dependency release.
- Patch or fork the dependency so those branches send a disabled control. It moves remote-service behavior into OpenKit's maintenance scope.

## Revisit When

Coordinator-proposed revisit conditions, not an Engineer ruling: an external behavior difference destabilizes OpenKit's own service, corrupts or loses retained data, or breaks product logic that OpenKit owns.

## Affected Owners

- docs/specs/20260526-llm_gateway_responses_api.md
