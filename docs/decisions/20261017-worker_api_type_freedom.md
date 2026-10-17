---
status: Accepted
date: "2026-10-17"
decider: Engineer
---
# Worker API-Type Freedom

## Decision

The engineer ruled at 02:30Z, confirmed by the coordinator's 04:25Z RESUME notice: a Worker request in Chat Completions or Responses form must work on every admitted route, natively where the upstream supports that type and through the existing conversion where it does not. Use stock pi-ai support; xAI uses `openai-responses`. Reuse the existing subscription-account wiring.

## Reason And Scope

Worker API selection must not make an otherwise representable configured route unusable. The existing stock-IR mapping and requested-format projection already serve both forms without another transport. Native xAI admission removes the immediate Worker blocker. Configured uncatalogued models remain usable through the existing conservative Chat transport instead of a catalog allowlist. Local custom tools reuse the existing string-input stock mapping and public custom-call projection; this does not add provider execution authority.

This ruling does not admit a semantic feature the selected API and existing mapping cannot preserve. Native-only controls, provider-executed tools, deferred declarations and client search on a cross-protocol route retain their existing admission boundary. There is no new account selection, durable field, dependency fork, retry path or public-format detour.

## Affected Owners And Revisit

[LLM Gateway Responses API](../specs/20260526-llm_gateway_responses_api.md) owns public admission and bounded mapping. [Pi AI Unified LLM Backend](../specs/20260708-pi_ai_unified_llm_backend.md) owns stock transport and the native channel. Revisit when a required Worker semantic cannot be preserved by the selected stock API and accepted mapping; do not silently drop it.
