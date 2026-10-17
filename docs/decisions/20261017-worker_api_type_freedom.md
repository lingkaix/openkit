---
status: Accepted
date: "2026-10-17"
decider: Engineer
---
# Worker API-Type Freedom

## Decision

The engineer ruled at 02:30Z, confirmed by the coordinator's 04:25Z RESUME notice: a Worker request in Chat Completions or Responses form must work on every admitted route, natively where the upstream supports that type and through the existing conversion where it does not. Use stock pi-ai support; xAI uses `openai-responses`. Reuse the existing subscription-account wiring.

## Reason

Worker API selection must not make an otherwise representable configured route unusable. The existing stock-IR mapping and requested-format projection already serve both forms without another transport. Native xAI admission removes the immediate Worker blocker. Configured uncatalogued models remain usable through the existing conservative Chat transport instead of a catalog allowlist.

This ruling does not admit a semantic feature the selected API and existing mapping cannot preserve. Native-only controls, provider-executed tools and cross-protocol custom tools, deferred declarations and client search retain their existing admission boundary. There is no new account selection, durable field, dependency fork, retry path or public-format detour.

## Rejected Alternatives

Rejecting the public API type or an uncatalogued configured model would block an existing representable request. Adding a transport or selecting another account would duplicate existing owners. Dropping unsupported semantic requirements would misrepresent the request.

## Revisit When

Revisit when a required Worker semantic cannot be preserved by the selected stock API and accepted mapping; do not silently drop it.

## Affected Owners

[LLM Gateway Responses API](../specs/20260526-llm_gateway_responses_api.md) owns public admission and bounded mapping. [Pi AI Unified LLM Backend](../specs/20260708-pi_ai_unified_llm_backend.md) owns stock transport and the native channel.
