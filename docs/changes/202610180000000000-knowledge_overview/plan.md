---
type: change-plan
status: in-progress
---
# Bounded Knowledge Overview Delivery

## Intent Revision 1

Source: coordinator GO after the 773d8fdc completeness audit. Working agents must be told what the Knowledge base contains, then ask the Knowledge Manager. Deliver the bounded revision-bound root index to Workers and Assistant command and pending-outcome runs through existing context assembly. No new record family. Size overflow must be explicit. User Memory and the held Server Thread increment are separate changes.

## Accepted Owners And Boundary

[Core Knowledge](../../core/knowledge.md) owns scope isolation and overview semantics. The [Knowledge Manager runtime owner](../../specs/20260704-knowledge_manager_internal_agent_runtime.md) requires the bounded root overview. [S39](../../specs/20260703-worker_context_package.md) owns existing package files, immutable request identity, inventory and digest. The Assistant role owner keeps ordinary rolling-context admission, capture and source guards. Use the existing authorized pinned Notebook readers and current actual Server credentials. No User notebook, model execution, search index, new authority, operation or Tool inventory is added.

## Method And Criteria

1. Read Workspace plus currently admitted Server roots at fixed commits. Deliver at most 4,096 UTF-8 content bytes per scope, exact canonical/delivered digests and truncation state. Unavailable roots reveal no storage diagnostic.
2. Add the ordinary Worker context file and a native input pointer without changing the canonical request or its digest. Existing package inventory retains the file; omit the optional projection to prove the ablation.
3. Supply Assistant command and pending-outcome context prefixes through the existing runtime. Current source authority is rechecked before dispatch, summary publication and answer publication; exact history and selected Skill input remain unchanged. The overview is required input to the ordinary answer and its capacity check, but is excluded from summary-production input. Continuity therefore cannot retain this transient navigation after its source grant changes, and an ordinary overview update does not invalidate historical summaries.
4. Regressions cover real Git revisions, UTF-8 limits, current authorization, the Worker file ablation and an actual fake-provider Assistant request. Run the complete touched-owner directories and inventory consumers, then independent Sol review and express landing on green main.

## Ownership And Evidence

Root writes the shared overview reader, Assistant integration, KM owner and context guide. The built-in gpt-6.1-sol high Builder owns Worker package/preparation source, their tests and S39 owner on a separate branch; root merges normally. The coordinator released naming-held joins against a normal merge of the naming branch before its main landing. Logs, exact review and landing state are retained in evidence/L-AK/checkpoint.md in the coordinator backlog. No real-provider acceptance is claimed by fake-backed checks.

The original complete gate exposed exact-request test arrays that omitted the new navigation and failed-start classification that compared native projection with the canonical request. The correction shares the fixed suffix derivation with that classifier, keeps the original Item equality, and rejects arbitrary additions. Complete module gates cover the correction; historical fixture oracles retain their private-source and replay assertions.
