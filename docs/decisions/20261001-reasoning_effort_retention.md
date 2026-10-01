---
status: Accepted
date: "2026-10-01"
decider: Engineer
---
# Reasoning Effort Retention Within A Conversation

## Decision

A Turn with no recorded effort carries no adapter override, so its native runtime keeps the conversation's current selection: its native default or the last effort delivered on that conversation. Gateway private lineage records the effort the request actually carried. Composer preselects the Thread's last admitted effort while the selected logical model still advertises it; otherwise there is no preselection. A preselected value is an ordinary explicit submission. Core Protocol owns the absent immutable Turn value, AEP owns delivery and retention, Gateway owns request lineage and fitting, and Composer owns the visible selection projected by Web. Each adapter owns its native control and mapping.

## Reason

On 2026-10-01, asked what a Turn with no effort and no Agent default should do after an earlier Turn chose `high`, the engineer chose 「沿用上次选择 (Recommended)」, translated as “Keep the last selection (Recommended).” This is the runtimes' native behavior, needs no extra mechanism, and is the same on all four runtimes. Source: Gateway routing proposal, Engineer Ruling 9, following the pinned-runtime effort probe. The probe is evidence of runtime capability, not a claim that the production adapters already implement delivery.

## Rejected Alternatives

- Restore a default on every Turn without effort. This would need per-adapter work and may be impossible on Codex for custom-Provider models. The engineer chose native retention instead.

## Revisit When

Users find the retained effort surprising, or the pinned runtimes gain a reset to default.

## Affected Owners

- docs/core/protocol.md
- docs/specs/20260616-agent_environment_package.md
- docs/specs/20260526-llm_gateway_responses_api.md
- docs/specs/20260703-agent_manifest_aep_resolution.md
- docs/specs/20260716-codex_worker_adapter.md
- docs/specs/20260716-pi_worker_adapter.md
- docs/specs/20260716-opencode_worker_adapter.md
- docs/specs/20260930-deepseek_worker_adapter.md
- docs/specs/20260831-unified_conversation_composer.md
- docs/specs/20260628-web_product_surface_projection.md
