---
status: Accepted
date: "2026-10-01"
decider: Engineer
---
# Native Modality Subset

## Decision

Modality intersection continues to define the admitted logical contract. An adapter whose runtime cannot represent a promised modality projects the subset its runtime supports and records the omitted modalities in its existing bounded adapter diagnostics, so the drop is not silent. For modality support, it refuses a new launch only when that subset lacks `text`. Agent Environment Package owns the shared projection and diagnostic rule; each adapter owns its native representation and supported subset. Pi and DeepSeek's pinned runtimes support `text` and `image` input.

## Reason

On 2026-10-01, the coordinator proposed that Pi and DeepSeek project only the modalities their runtimes support instead of refusing the model. The engineer accepted that proposal: 「让这两个 adapter 只投影自己支持的模态，而不是拒绝整个模型。同意这个」 Translated: “Have these two adapters project only the modalities they support instead of refusing the whole model. Agreed.” Source: Gateway routing proposal, Engineer Ruling 12.

Both adapters previously refused a route whose coherent contract also promised `pdf`, `audio` or `video`, following AEP's prohibition on silently dropping a promised modality. To avoid that refusal, the template slice added a text-and-image-only backup to each paid tier (`gpt-5.4-mini`, `gpt-5.1`, `gpt-5.4-pro`) solely to narrow the intersection. That also cut `smart` from about 1,000,000 to 400,000 context tokens. Supported-subset projection with diagnostics replaces the refusal and removes the need for those three narrowing backups. This record does not claim that the adapters already implement subset projection; they still refuse until the implementation slice lands.

## Rejected Alternatives

- Keep the refusal and narrow each tier's intersection with a text-and-image-only member. This required three backups solely to constrain modality advertisement and reduced `smart`'s context; the engineer accepted the coordinator's supported-subset proposal instead.

## Revisit When

Coordinator-proposed revisit condition, not an Engineer ruling: a Worker is asked to read an input kind its runtime cannot represent and the omission is not visible enough to the User.

## Affected Owners

- docs/specs/20260616-agent_environment_package.md
- docs/specs/20260716-pi_worker_adapter.md
- docs/specs/20260930-deepseek_worker_adapter.md
