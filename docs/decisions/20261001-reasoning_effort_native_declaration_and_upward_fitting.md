---
status: Accepted
date: "2026-10-01"
decider: Engineer
---
# Reasoning Effort Native Declaration And Upward Fitting

## Decision

On every reasoning route, including one whose AEP `reasoningEffortLevels` list is empty, adapters whose runtimes need native level metadata declare all seven canonical levels with their exact Gateway wire values. Advertisement remains the Composer and diagnostic projection and does not restrict native declaration; native requests carry the recorded Turn effort unchanged, and Gateway alone fits it. AEP owns this shared rule, and each adapter owns its native mapping. Codex needs no native declaration because App Server `turn/start.effort` carries any string.

When the serving member lacks a requested level, Gateway uses its nearest higher supported level in canonical order; only when it supports none above the request does it use its nearest lower supported level, which is its highest. Gateway owns fitting, intersection advertisement, and requested/effective private lineage; the latter two are unchanged. This decision supersedes only the nearest-lower fitting clause of [Reasoning Effort Rulings](20261001-reasoning_effort_rulings.md), not its other decisions.

On a route whose AEP entry has no `reasoningEffortLevels`, all four adapters send no native effort and record in the existing bounded adapter diagnostics that the effort was not delivered because the model has no reasoning. The Turn does not fail, and the native conversation keeps its current selection under [the retention decision](20261001-reasoning_effort_retention.md). AEP owns this exception, and the adapter owners project it alongside their native controls.

## Reason

On 2026-10-01, the coordinator recommended declaring all seven canonical levels on every reasoning route. The engineer accepted that recommendation and amended the fitting direction: 「我同意你这个声明全部七级的设计，但是 Gateway 在适配的时候，不是统一往下适配，而是往上适配一个级别，也就是和 Pi 遇到未声明级别的那个行为一致。」 Translated: “I agree with your design of declaring all seven levels, but when the Gateway fits, it should not always fit downward; it should fit up one level, consistent with Pi's behavior for an undeclared level.” Full-set native declaration is the coordinator's recommendation accepted by the engineer; upward fitting is the engineer's own amendment.

The pinned-runtime probe found that Codex sends any string unchanged, Pi clamps an undeclared level to the nearest higher declared level and otherwise to the nearest lower one, and OpenCode and DeepSeek refuse an undeclared level without sending a request. Pi's `clampThinkingLevel` in pi-ai `dist/models.js` is the algorithm the engineer named as the fitting reference. Declaring the full canonical set resolves native divergence when a Turn's recorded effort lies outside its model's advertised list; the Gateway remains the only fitter. Source: Gateway routing proposal, Engineer Ruling 10, following the pinned-runtime effort probe. The probe establishes runtime capability, not implementation of production adapter delivery or Gateway fitting.

For routes without reasoning, the engineer on 2026-10-01 chose 「不投递，写诊断 (Recommended)」, translated as “Do not deliver; write a diagnostic (Recommended).” Forced delivery would fail on OpenCode and DeepSeek because they have no native control for such a model, while Pi would clamp it to `off`. Skipping delivery preserves the Turn and the native conversation's current selection; the Provider sees what it would see after Gateway dropped the value. Source: Gateway routing proposal, Engineer Ruling 11, with Ruling 9 owning retention.

## Rejected Alternatives

- Declare only the advertised levels in native metadata. The four runtimes then diverge as the probe showed: Codex forwards any string, Pi clamps, and OpenCode and DeepSeek refuse without sending a request.
- Fit to the nearest lower supported level. The engineer replaced that direction with Pi's upward-first algorithm and highest-supported fallback when no higher level exists.
- Declare all seven levels on every route and let Gateway drop effort for models without reasoning. In Ruling 11, the engineer chose native non-delivery with a diagnostic instead.

## Revisit When

Coordinator-proposed revisit conditions, not an Engineer ruling: upward fitting makes requests materially costlier or slower than Users expect, or a pinned runtime cannot carry all seven canonical levels unchanged on reasoning routes.

## Affected Owners

- docs/specs/20260616-agent_environment_package.md
- docs/specs/20260526-llm_gateway_responses_api.md
- docs/specs/20260716-codex_worker_adapter.md
- docs/specs/20260716-pi_worker_adapter.md
- docs/specs/20260716-opencode_worker_adapter.md
- docs/specs/20260930-deepseek_worker_adapter.md
