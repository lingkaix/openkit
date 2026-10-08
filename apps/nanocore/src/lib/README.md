# Library

This directory contains NanoCore's existing app-local product-state aggregate and deterministic simulator. It is not a general utility directory.

## Boundaries

- `store.ts` presents one request-facing API over workspace, thread, turn, item, artifact, session, knowledge, and event state while canonical record placement and validation remain under `../storage/`. After a Turn is a sealed terminal, `updateTurn`, `createItem`, `emitTurnEvent`, and `updateItem` admit only completion of an already-decided publication or a named field-limited display-projection refresh, judged by identity and content.
- `DISPLAY_PROJECTION_REFRESH_FIELDS` names the existing Item level, title and summary admission; failed-start recovery reuses that list while comparing every other decided snapshot field. Missing-publication equality remains separate.
- `store.ts` is still a broad aggregate; do not add a new record family or workflow here by default. New behavior belongs with its concrete route, runtime, policy, provider, Vault, or storage owner.
- Process-local turn-event listeners and timers are runtime projections, not durable authorities. Canonical event history remains workspace-owned file state.
- Event envelopes project non-UUID App command ids to stable Workspace/Thread-scoped protocol UUIDs using the existing UUID helper; command receipts, checkpoints, and Worker packages retain the original command identity. The exported `projectTurnEventRequestId` supplies the same projection to recovery proofs so matching events must also agree with their command owner.
- `store.ts` does not own a Knowledge context materialization path; S61 owns retrieval traces and S39 owns worker Context Package files under `../storage/`.
- Split an existing family only when the new owner receives direct callers and removes a complete responsibility. Do not hide the same aggregate behind a pass-through repository or single-implementation interface.
- `simulator.ts` owns deterministic demo execution only and must use the same public store invariants as production paths. Product-backed questions use the existing Worker MCP `work_request_input` dispatcher and Pending Request owner before the raising Turn completes; answers arrive through frozen input on a later Turn of the same Task, never by reopening the raising Turn. Its modeled native start proves delivery only after accepting that exact input and its ordinary verified S39 trace, including for an outcome Turn without a Task checkpoint. That Turn retains its exact input under the existing Pending Request system actor for trace verification. Carried outcomes preserve the independently admitted command Item and exact replay regardless of checkpoint presence. Standalone protocol fixtures without Core storage cannot exercise durable answers.

## Verification

Run the nearest store, reload, canonical-file, event-stream, and simulator tests affected by a change, followed by the package gates in the [NanoCore source guide](../README.md).

The canonical Turn record preserves optional `reasoningEffort` at creation and reload. `updateTurn` refuses changes to this immutable admission field. Existing command receipts hash explicit submission content, so identical replay preserves the original choice even after an Agent default changes.

`FsStore.getApprovalProjectionLineage` returns only Workspace and Thread selectors from the existing Approval map under the selected Workspace for opaque-child admission. The Pending Request command owner still decides missing or contradictory canonical-record outcomes.

`AutomationStore.getAutomationLineage` selects only Workspace and user ownership from the existing process-local record maps for opaque-child admission. `listAuthorizedAutomations` applies admitted Workspace candidates and current administrator eligibility. `FsStore.getTurnLineage` returns only Workspace and Thread selectors from the existing Turn map before addressed-Turn content access. These selectors add no index or durable owner. Native feedback loads Turn content only after Workspace and Thread admission; minimum Turn lineage never scans Workspaces.

`StoreRecordNotFoundError`, `AutomationRecordNotFoundError`, and `KnowledgeProposalAuthorityError` distinguish known native refusals from unexpected exceptions without changing record data or messages. Families translate these errors into the neutral operation contract; storage does not frame transport responses.

`createKnowledgeSource` authors a neutral `knowledge_source_register_failed` 404 before any source or receipt write when Turn lineage lacks its Thread or a source id belongs to another Workspace. The Knowledge family preserves that definite refusal; unrelated storage and implementation exceptions remain unclassified.

`FsStore.updateAgentSession` admits the materializer's private `retainedStorage` association and slot once and refuses any later replacement or erasure. It remains historical provenance after terminalization and does not enter the public AgentSession projection or grant attachment authority.

The simulator Material fixtures invoke the canonical definition-derived JSON operations and retain their queue, projection and worker-delivery assertions.

The simulator publishes its two deterministic Material candidates through the shared exact-byte Artifact validator and existing Artifact/Review owners, with the process-private no-injection evidence constructor. It emits no Artifact declaration payload and cannot provide that proof to Worker MCP capture. Ordinary Worker submission requires the original Worker evidence set.
