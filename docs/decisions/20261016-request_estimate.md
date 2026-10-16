---
status: Accepted
date: "2026-10-16"
decider: Engineer, relayed by the coordinator at 18:33 UTC
---
# Complete Model Request Estimate

## Decision

Admit every route with a conservative local estimate of the complete final request and the selected physical model's capacity and output reserve. The current estimate is `ceil(finalRequestUtf8Bytes / 3) + 4096`, including native continuity bytes. Use an exact counter only where it is local and cheap. Add no per-request network count call. A route does not fail merely because exact accounting is unknown. An actual Provider context-length refusal remains one clear error that the caller can act on by reducing input or retrieving a smaller excerpt.

The engineer directed: "admission uses a conservative local estimate (for example UTF-8 bytes / 3 plus a fixed margin) for every route; use an exact counter only where it is local and cheap; no extra network count call per request; no route fails because its accounting is unknown. If the provider still rejects for context length, return one clear error the user can act on (Simplicity rule 4)."

S39 owns the rule. The final selected payload after stock serialization and native overlays supplies instructions, history, Tool definitions, Tool results and media; transport continuity is included separately when it is not in that payload. The estimate is not actual token usage or a proved upper bound. Missing physical capacity retains the Gateway's existing configuration refusal. Output capacity is reserved independently.

## Reason

The engineer chose a small local estimate and an explicit error over additional network latency or loss of existing routes. Large input data stays with its original owner and uses bounded previews and on-demand reads. Independent source byte, line, envelope and aggregate bounds, authorization and original-versus-delivered identities are unchanged.

## Superseded Requirement

S39 previously required: "Use a model-specific tokenizer or a documented conservative model-specific bound; never use `ceil(bytes/4)` as a hard token limit." The model-specific accounting requirement in the 2026-10-15 Large Files And Model Context decision is superseded by this ruling for request admission. This ruling does not describe the estimate as a hard token proof and does not change source or output accounting.

## Rejected Alternatives

- A remote count call before every inference adds latency and can make otherwise usable native or custom routes unavailable.
- A generic byte ratio described as an exact count or a proved bound overstates what it establishes.
- Full-body fallback or silent source expansion defeats the existing bounded input rule.

## Revisit When

Use a local exact counter when an existing route supplies one cheaply. Revisit the estimate if supported requests show material false refusals or repeated actionable context errors. Do not create a measurement campaign or new lifecycle to qualify ordinary admission.

## Owners

- [Worker Context Package](../specs/20260703-worker_context_package.md).
- [Internal Agent Runtime](../specs/20260813-internal_agent_runtime.md).
- [LLM Gateway](../specs/20260526-llm_gateway_responses_api.md).
- [Large Files And Model Context](20261015-large_files_and_model_context.md).
