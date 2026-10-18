---
type: change-plan
status: in-progress
date: "2026-10-18"
branch: lane/ch
---
# Unified Interception Base And I16 Pilot

## Intent Revisions

- 2026-10-18: The engineer approved freezing binding and invocation formats before v0.1.0, a minimal common executor and one or two pilot rows. The coordinator assigned L-CH the base and I16 pilot, approved evidence/L-CH/interception-base-plan.md, required existing Policy/config and Audit ownership, one deterministic test provider, bounded availability behavior, one Astra format scrutiny and L-GA review of Policy parts. Other row migration stays after v0.1.0. A semantic-conflict list goes through the coordinator to the owner lanes; evidence-only gaps remain additive. C07 is a separate small additive channel cut. No Web code or host operation is authorized.

## Owners And Method

[Unified Interception](../../specs/20261018-nanocore_interception_and_information_consolidation.md), [Policy Enforcement](../../specs/20260703-policy_enforcement_mapping.md), [MCP Supply](../../specs/20260704-worker_mcp_tool_supply.md) and [Audit](../../core/audit.md) retain their owners. Runtime-neutral schemas belong to Protocol; Policy/config remains the binding authority and existing scoped Audit remains invocation authority. NanoCore's Policy bridge owns execution. The NGAC Kernel remains the final evaluator and is not extended.

I16 tests the actual MCP actor, current input, call, AEP and PermissionDecision seam without moving unrelated guards. Deterministic fixtures prove mode order, unavailable/error results, bounded timeout/circuit, current-version refusal and required evidence. Future Gateway tool-rule and storage-lease inputs reference their existing owners; this change activates neither provider integration nor a lease issuer.

## Write Ownership And Evidence

The lane root owns protocol/config schemas, the new Policy executor, Audit integration, I16 and its specification amendments. A separate Sol worktree owns C07 channels, its Core migration and channel owner text; the root waits before editing the shared Core journal or migration test. Shared Policy paths are serialized for L-GA review. Semantic audit is external evidence, with no adjacent fixes in this cut.

## Checkpoint

The coordinator approved the additive design and no reset. The format proposal is under the one approved Astra scrutiny. C07 and the semantic audit run independently. Implementation checks, review and landing receipts remain in lane evidence outside the repository. Complete affected suites and one full branch CI are required because the base crosses NanoCore, Protocol and config-schema. No passing result or implementation completion is claimed yet.
