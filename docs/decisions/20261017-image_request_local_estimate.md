---
status: Accepted
date: "2026-10-17"
decider: L-AW, under the coordinator-unavailable ordinary-decision rule
---
# Local Estimate For Admitted Image Requests

## Decision

At 05:50:45 UTC, L-AW adopted the recommended local image allowance under the lane's coordinator-unavailable rule. The question recorded at 05:35:28 UTC had received no answer. This records L-AW's ordinary fallback decision, not an engineer or coordinator answer. [Worker Context Package](../specs/20260703-worker_context_package.md#bounded-model-projection) owns the complete-request admission rule. [Bounded Media Processors](../specs/20260713-work_resource_interaction_model.md#bounded-media-processors) owns independent processing and delivery limits.

The existing final physical-request callback adds an approximate local allowance of 8,192 tokens per transport-admitted inline PNG/JPEG occurrence. The local counting projection replaces only the actual image data values in Native Responses user-message content arrays and function-result output arrays. It retains text, metadata, native continuity, the existing fixed margin and actual output reserve. The Provider payload remains unchanged. Existing selected-model image-input admission still applies. The allowance is neither model-specific token proof nor a universal Provider bound. No remote counter, tokenizer service, new route or admission mode is added. Unknown exact accounting alone does not refuse an otherwise admitted route.

## Reason

Bounded images need a separate local allowance because serialized base64 bytes do not describe visual token cost. A fixed allowance gives the existing final callback an ordinary capacity estimate without claiming complete media proof. Independent source and delivered bytes, pixels, decoded RGBA allocation, child heap, wall time, authorization and raw output limits remain binding. Provider context rejection retains one actionable error. The coordinator can review and reverse the fallback.

## Rejected Alternatives

- Count base64 bytes as ordinary text tokens. This confuses transport encoding size with image cost.
- Add per-request network counting or a tokenizer service. These add a dependency that the accepted local estimate excludes.
- Refuse image-capable routes solely because exact visual accounting is unavailable. This prevents the accepted bounded image behavior for an accounting limitation.
- Describe the allowance as a proved bound for all models. No such proof supports it.
- Strip arbitrary data-URL text or schema examples. These are text and must remain in the text estimate.

## Revisit When

Revisit the allowance when observed Provider context rejections or unnecessary local refusals prevent useful bounded image work. Revisit the fallback when the coordinator reviews it. A wider media or serializer scope needs its own owner amendment.

## Affected Owners

- [Worker Context Package](../specs/20260703-worker_context_package.md#bounded-model-projection).
- [Work Resource Interaction](../specs/20260713-work_resource_interaction_model.md#bounded-media-processors).
