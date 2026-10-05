---
status: Accepted
date: "2026-10-05"
decider: Engineer
---
# Open Extension Partition

## Decision

[Contract Evolution](../core/contract-evolution.md#closed-core-open-extension) owns the partition between exact authority-bearing shapes and tolerant descriptive shapes. A shape that instructs its receiver to perform an effect or carries authority stays exact and refuses unknown fields. This covers the fixed Core-to-NanoHost effect commands, the App update helper command, generated policy and storage attachment authority sent to NanoHost, Vault and credential record formats, admitted business writes such as Generative Kernel data operations, and exact export inventories. Version skew at these boundaries produces an explicit refusal rather than partial execution.

Every descriptive shape ignores unknown keys outside its closed core: message envelopes, results and acknowledgements, read models and responses, retained records, and descriptive configuration. Known core fields and their closed value domains stay strict, and emitted projections stay strictly valid. Ignored content from outside the reader's trust boundary is not persisted, forwarded, or displayed.

Removing a field from a reader needs no compatibility reader or migration. Data that still carries the field is ignored, and an older release that understands it keeps using it.

## Reason

The engineer first restated the existing open-extension principle on 2026-10-05. Translated from Chinese: "Our design also includes openness to extensions, including fields, configuration, and so on; this is already recorded, so check it. Fields and similar content that a newer version no longer handles are simply ignored. If the user runs an older version of OpenKit, those old data or fields automatically take effect. That is all. This is not compatibility, but it does provide some resilience across versions."

The coordinator then proposed the partition recorded above, and the engineer answered, translated from Chinese: "I agree with this design." Silently ignoring part of an effect instruction could report an effect as applied when it was not. Exact refusal preserves truthful execution at those boundaries, while ignoring descriptive additions preserves the existing open-extension principle without a compatibility layer.

## Rejected Alternatives

- Blanket exactness. Rejecting unknown descriptive keys would close descriptive shapes to extension and reject fields that a reader has simply stopped consuming.
- Blanket tolerance, including effect instructions. Silently omitting an unsupported part of an instruction could acknowledge an effect that was not applied.
- Passthrough of unknown content. Persisting, forwarding, or displaying ignored content from outside the reader's trust boundary would give unconsumed content a use that the reader has not validated.

## Revisit When

An ignored extension is found to have changed the meaning of a core field without being marked required, or tolerance hides a producer defect that exact validation would have caught, as in the [2026-09-30 ruling](20260930-closed_core_open_extension.md#revisit-when); or a demonstrated case shows that an effect instruction needs an ignorable descriptive annotation.

## Affected Owners

- [docs/core/contract-evolution.md](../core/contract-evolution.md): states the partition in this change.
- [docs/specs/20260802-nanohost_runtime_and_transport.md](../specs/20260802-nanohost_runtime_and_transport.md): aligned in the implementation change that touches it.
- [docs/specs/20260628-nanocore_config_identity_contract.md](../specs/20260628-nanocore_config_identity_contract.md): aligned in the implementation change that touches it.
- [docs/specs/20260528-core_client_boundary.md](../specs/20260528-core_client_boundary.md): aligned in the implementation change that touches it.
- [docs/specs/20260721-provider_subscription_accounts.md](../specs/20260721-provider_subscription_accounts.md): aligned in the implementation change that touches it.
- [docs/specs/20260910-app_update_delivery.md](../specs/20260910-app_update_delivery.md): aligned in the implementation change that touches it.
- [docs/specs/20260704-vault_backend_implementation.md](../specs/20260704-vault_backend_implementation.md): aligned in the implementation change that touches it.
- [docs/specs/20260908-generative_kernel_data_operations.md](../specs/20260908-generative_kernel_data_operations.md): aligned in the implementation change that touches it.
- [docs/specs/20260704-workspace_backup_export_import.md](../specs/20260704-workspace_backup_export_import.md): aligned in the implementation change that touches it.
