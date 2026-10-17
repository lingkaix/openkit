---
status: Accepted
date: "2026-10-17"
decider: Engineer
---
# Local Estimate For Internal Model Requests

## Decision

The engineer's 18:33 UTC ruling, conveyed by the coordinator, requires a local complete-request estimate for every internal Agent Provider route. [Worker Context Package](../specs/20260703-worker_context_package.md#bounded-model-projection) owns this admission rule. The estimate covers the final serialized text payload, native continuity, and existing output reserve against the selected model capacity. Its current default divides UTF-8 input bytes by three, rounds up, and adds a fixed margin. Exact counting is allowed only when local and cheap. Per-request remote counting and refusal solely because exact accounting is unavailable are excluded, including for Codex subscription routes. Provider context rejection returns one actionable error. This paragraph paraphrases the conveyed ruling; it is not a verbatim quotation.

This decision covers internal text transport. Quick Chat already uses the shared internal Agent loop and receives the same admission. Large inputs remain bounded and retrieved on demand. Worker request admission, media transport and accounting, independent byte caps, source identities, authorization, and durable ownership retain their existing contracts.

## Reason

Internal Agent work must remain usable across valid Provider routes without depending on a counter that the route does not supply. A local estimate gives each dispatch a cheap capacity check over the actual request. The estimate cannot prove the Provider's token count. A clear Provider overflow error gives the caller a direct correction without adding a retry, accounting ledger, or recovery loop. Large-file projection and retrieval address oversized inputs through their existing owners.

## Rejected Alternatives

- Count tokens through a network endpoint before every inference. The ruling excludes this extra request and dependency.
- Refuse a valid route when exact accounting is unavailable. This would block admitted subscription and internal Agent routes for an accounting limitation.
- Present a byte heuristic as a proved token upper bound. The estimate cannot establish that guarantee.
- Add a separate Quick Chat runtime or new loop. Quick Chat already uses the shared internal Agent Gateway.

## Revisit When

Revisit the estimate when Provider context rejections or unnecessary local refusals show that its current ratio or margin prevents useful bounded work. A local, cheap tokenizer may improve estimation without adding a network count dependency. Media admission requires its own accepted scope and cost model before this text rule is extended.

## Affected Owners

- [Worker Context Package](../specs/20260703-worker_context_package.md#bounded-model-projection).
- [Internal Agent Runtime](../specs/20260813-internal_agent_runtime.md).
- [Pi AI Unified LLM Backend](../specs/20260708-pi_ai_unified_llm_backend.md).
- [LLM Gateway Responses API](../specs/20260526-llm_gateway_responses_api.md).
