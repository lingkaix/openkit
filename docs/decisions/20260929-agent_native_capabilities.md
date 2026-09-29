---
status: Accepted
date: "2026-09-29"
decider: Engineer
---
# OpenKit Is Agent-Native

## Decision

OpenKit is an agent-native system. Agents are the premise of the platform, not one of its features. The premise is stated in `docs/product-vision.md`. The design rule it implies is a Foundation principle in `docs/core/foundation.md`: each Core capability is defined as one semantic operation that an agent can discover and invoke as naturally as a tool call, and its human surfaces and agent tool surfaces are projections of that operation. The Foundation principle keeps every decision that an owner reserves to a human with that human; agents can request, observe, and explain such a decision but never make it.

## Reason

The engineer stated this on 2026-09-29, translated from Chinese. Reasoned from first principles, OpenKit is agent-native. Traditional software, systems, and platforms treat agent or AI features as one part of the platform. OpenKit takes agent capability as the foundation and premise of the platform. Without agents, the platform stands neither as a product design nor in operation and use. Interfaces should therefore be conceived and designed in an agent-native form. The typical test is whether an agent can use a feature or interface, and whether it can use it as naturally and easily as it calls an MCP tool or makes a tool call.

The engineer also observed that communication was fragmented: between NanoCore agents and workers, between workers, and between NanoCore agents. The links were connected, but no unified, clean, agent-friendly, and efficient interface existed for using them.

The primary agent proposed placing the premise in the product vision and the semantic-operation design rule in Foundation, and the engineer approved that two-owner placement in the next discussion round. The semantic-operation formulation therefore originated in the agent's proposal and was accepted by the engineer; it is not a verbatim engineer statement. The placement rationale is agent analysis applying the documentation model: intent documents cannot be the sole authority for an implementation choice, so the design requirement belongs in Core.

The human-reserved qualifier was added by the agent. It is not a separate engineer ruling. It restates the existing human-final-authority invariant at the boundary of the new principle, because an unqualified rule that every capability is agent-invocable would let an agent make decisions, such as approvals, that the invariant keeps with humans.

## Rejected Alternatives

- State the whole principle only in the product vision. The accepted split avoids relying on an intent document as the sole authority for an implementation choice; the product vision remains citable as the product premise.
- State the design rule in `docs/engineering-doctrine.md`. The engineer considered this location and then approved the product-vision and Foundation split. Agent analysis, not a separately stated engineer reason: the rule concerns product capability design, whereas the engineering doctrine explains how the repository is engineered.
- Make every capability invocable by agents without exception. Rejected because it would let agents make decisions reserved to humans.

## Revisit When

- An engineer revises the product premise.
- A capability family cannot be given a natural agent projection without weakening an authority, credential, or containment boundary.

## Affected Owners

- docs/product-vision.md
- docs/core/foundation.md
