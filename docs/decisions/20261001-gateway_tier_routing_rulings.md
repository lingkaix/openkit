---
status: Accepted
date: "2026-10-01"
decider: Engineer, on a Consultant-reviewed proposal
---
# Gateway Tier Routing, Failure Handling, And Removal

## Decision

Accept cross-family logical tiers with one coherent minimum-limit and intersected capability contract, optional routing that defaults to automatic failover, primary plus authored ordered backups, terminal request-scoped failures, up to three same-member transient retries with exponential backoff before commit and within the request deadline, and removal without use-based guards or backup promotion. The engineer selected sealed-reasoning option A as an on-wire tag: only the producing member receives its opaque payload; other members receive readable-text handoff. After Consultant review, the engineer confirmed the coordinator’s bounded process-local item-to-member association instead, with no on-wire member discriminator, no stored payload bytes, a fixed entry ceiling, and least-recently-used eviction. Restart or eviction abandons attribution and loses same-member opaque continuity. The Gateway specification owns routing, failure kinds, commit, handoff, and tier templates; the backend, context-compaction, AEP, subscription-account, configuration, and DeepSeek adapter specifications own their respective boundary amendments. This record covers engineer rulings 1 through 6 of 2026-10-01; effort controls and deployment mappings are outside it.

## Reason

The engineer accepted the other recommendations and changed same-member retry to three uses of exponential backoff, saying “以避免服务端的抖动”, translated as “to avoid server-side jitter.” The bounded retry policy lets a brief transient failure settle on the same member before it fails a request or triggers a backup. It is fixed Gateway behavior rather than another administrator strategy setting.

On mixed-tier context limits, the engineer said “暂时先按照这个最简方案来执行”, translated as “for now, proceed with this simplest scheme.” Taking the minimum member context and output gives every member a contract the runtime can use without a new context override or Gateway handover compactor. Intersected capabilities and a shared-or-null family permit stable tiers to span vendors while preserving an admitted request's requirements.

The engineer chose sealed option A as an on-wire tag, translated from “A：打标签，非本成员则丢弃” as “A: tag it; discard it for a different member.” Consultant follow-up showed that the proposed tag cannot survive the inspected Codex round trip and conflicts with OpenKit’s exact-key admission and route-visibility boundaries. The coordinator therefore proposed a bounded process-local item-to-member association with no response field. On 2026-10-01, after discussing performance, memory use, leaks, and ciphertext handling, the engineer confirmed that Consultant-reviewed revision by choosing “有上限的内存表 (Recommended)”, translated as “a bounded in-memory table.” Each entry stores only the reasoning item id and producing member’s key, never ciphertext or other payload bytes; a fixed entry ceiling and least-recently-used eviction bound memory use. After restart or eviction, earlier capsules are unattributed, so even the producing member receives readable-text handoff for that history. This loses opaque reasoning continuity, not retained canonical data; it does not authorize a Gateway conversation store or a new response field.

Omitted routing preserves retained authored configuration's existing always-on failover with no migration. Request-scoped capability, context, output-limit, and refusal failures stay terminal so routing cannot silently change semantics or evade a refusal; context overflow remains typed for runtime compaction. Removal must remain possible despite use, while retained logical and route IDs truthfully represent unavailable supply. It therefore neither rewrites routes nor silently promotes a backup.

Source: Gateway routing proposal rev 4 and its Engineer Rulings section, with the sealed-reasoning Consultant follow-up, dated 2026-10-01. These discussion and research records preserve provenance; the affected specifications state the rules.

## Rejected Alternatives

- The rev 3 one-retry rule. The engineer replaced it with up to three exponential-backoff retries to ride out server-side jitter; concrete delays and the retry-after ceiling remain implementation choices, fixed Gateway constants small relative to the shared deadline so retry waiting preserves time for a backup.
- A configurable retry count. The accepted design keeps this transient recovery fixed and reserves the current strategy control for automatic failover, avoiding another administrator setting.
- Sealed option B, making every other member ineligible whenever history contains a capsule. It prevents cross-member failover for the rest of an ordinary Codex thread after its first capsule, although readable-text handoff can safely keep backups usable.
- A returned opaque member digest. The inspected Codex reasoning-item structure drops the unknown field on deserialization; a caller that retains it fails OpenKit's exact-key request check. The digest also discriminates routes on caller-held history, contrary to the compaction boundary. Embedding it in ciphertext would change the producer's opaque payload rather than preserve it.
- A stateless wrapped capsule. Gateway would wrap returned ciphertext with a member signature computed from a durable server key, then verify and strip it on return. It would survive restart without an in-memory association, but would require a durable server key and make caller-stored bytes differ from the vendor’s bytes. The engineer chose the bounded in-memory table instead.
- Promoting a backup when removing a Provider. That rewrites administrator-authored intent and activates a different primary even when failover is off; retained routes instead remain unavailable until explicitly edited.
- Per-tier fixed context/output overrides or Gateway-side compaction when handing from a larger member to a smaller member. The engineer chose the coherent minimum for now and reserved those alternatives for later routing strategies.

## Revisit When

A later dynamic, helper-model, fixed-limit, or smaller-member compaction routing strategy is designed from a demonstrated need; minimum member limits materially prevent a tier's intended work; loss of reasoning capsules after restart or eviction proves material, at which point the stateless wrapped-capsule alternative is the recorded next option; or representative Provider failure evidence defeats the closed classification or fixed retry policy. Reopening requires an owner amendment rather than hidden planner, transport, or observation behavior.

## Affected Owners

- [LLM Gateway Responses API](../specs/20260526-llm_gateway_responses_api.md)
- [Pi AI Unified LLM Backend](../specs/20260708-pi_ai_unified_llm_backend.md)
- [Agent Runtime Context Management And Compaction](../specs/20260902-agent_runtime_context_compaction.md)
- [Agent Environment Package](../specs/20260616-agent_environment_package.md)
- [Provider Subscription Accounts](../specs/20260721-provider_subscription_accounts.md)
- [NanoCore Config And Identity Contract](../specs/20260628-nanocore_config_identity_contract.md)
- [DeepSeek Worker Adapter](../specs/20260930-deepseek_worker_adapter.md)
- [Worker Turn Reliability Envelope](../specs/20260531-worker_turn_reliability_envelope.md)
- [Internal Agent Runtime](../specs/20260813-internal_agent_runtime.md)
