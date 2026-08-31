---
status: Accepted
implementation: Implemented
date: 2026-08-31
---
# Unified Conversation Composer

## Owns

This specification owns the Workspace-scoped conversation-target catalog, the shared user-observable Composer interaction contract, and the one structured conversation submission that turns Composer choices into calls to existing Assistant, Knowledge Manager, Goal Orchestrator, Worker, Task Mode, Thread, Turn, Item, Artifact, AgentSession, Agent supply, and Gateway owners.

## Does Not Own

- `docs/core/work-model.md` owns Thread, Turn, Item, Task, Goal, conversation-continuity, and product-mode semantics.
- `docs/core/agent-supply.md` owns Agent and profile composition, and `docs/specs/20260703-agent_manifest_aep_resolution.md` owns resolved Worker setup.
- `docs/specs/20260704-chat_mode_assistant.md`, `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`, `docs/specs/20260704-goal_mode_coordination.md`, and `docs/specs/20260704-task_mode_worker_delegation.md` own execution after a target is selected.
- `docs/specs/20260526-llm_gateway_responses_api.md` owns logical-model admission and private Provider routing.
- `docs/specs/20260713-work_resource_interaction_model.md` owns Artifact import and reference semantics. This specification adds no upload store, blob protocol, or attachment lifecycle.
- `docs/specs/20260628-web_product_surface_projection.md` owns publication of this capability through the Web product, and `docs/specs/20260710-web_ui_rebuild_stack.md` owns component and client-state placement. `DESIGN.md` is a non-authoritative visual projection. This specification owns the observable Composer layout, sizing, keyboard, selection, and draft-retention behavior below.
- This specification creates no Shard, AgentSession, Harness, Sandbox, process, Provider route, or account identity and exposes none of those infrastructure identities to ordinary clients.

## Core References

- `docs/core/work-model.md`
- `docs/core/agent-supply.md`
- `docs/core/architecture.md`
- `docs/core/identity.md`
- `docs/core/protocol.md`

## Summary

One Composer can address a built-in role, an applicable running or warm Worker, or a new Task Worker and can express one logical-model preference and zero or more existing Artifact references. NanoCore publishes the valid choices as a context-sensitive read model and accepts one idempotent structured submission. The submission resolves the selected target once, records the resulting durable Thread and Turn lineage through existing owners, and invokes the existing role or workflow service instead of adding a dispatcher lifecycle.

The product label `New Shard + Worker` means "create a linked Task execution Thread and start bounded Worker work." `Shard` is not a Core entity and has no record, identifier, API, storage, or lifecycle.

## Composer Interaction Contract

The shared Composer is one rounded container with an upper text-entry region and a fixed lower action row. The text area initially accommodates approximately two and one-half lines, grows with its measured content until `min(240px, 40vh)`, and then scrolls internally without moving the action row. The lower row contains, from left to right, the Artifact or supported text-file action, the conversation-target selector, flexible space, the logical-model selector, and the circular Send action.

The target selector may show the built-in Assistant, a running Goal Orchestrator, the Workspace Knowledge Manager, pinned reusable Worker supply with warm availability, running Workers, and `New Shard + Worker`. The model selector shows only logical models admitted for the selected target; changing the target preserves the model only when it remains admitted. Selected Artifacts appear as removable context chips between the text region and the action row.

Enter submits while text composition is inactive, Shift+Enter inserts a newline, every icon-only action has an accessible name and visible focus treatment, both selectors are keyboard operable, and unavailable choices expose their reason. Send is enabled only when non-whitespace text or at least one accepted Artifact reference is present, no local import is pending, the selected target remains available, the selected model remains admitted, and an identical request is not already pending. A failed or uncertain submission preserves the exact draft, target, model, Artifact references, and request identity.

## Target Catalog

NanoCore exposes `GET /api/app/workspaces/:workspaceId/conversation-targets`. The response is a Workspace-authorized read model whose entries have this closed product shape:

```ts
interface ConversationTarget {
  targetRef: string;
  kind:
    | 'assistant'
    | 'goal-orchestrator'
    | 'knowledge-manager'
    | 'warm-worker'
    | 'running-worker'
    | 'new-task-worker';
  label: string;
  description: string | null;
  availability: 'available' | 'busy' | 'unavailable';
  unavailableReason: string | null;
  threadId: string | null;
  profileId: string | null;
  logicalModels: readonly {
    id: string;
    label: string;
    capabilities: readonly string[];
  }[];
  defaultLogicalModelId: string | null;
}
```

The response envelope contains the ordered `targets` and one `defaultTargetRef`. `targetRef` is an opaque deterministic projection of the target kind plus its stable existing product owner identifiers and selected Agent profile when applicable. The same owner tuple yields the same reference across catalog reads and NanoCore restarts, a changed or removed owner tuple yields a different or missing reference, and request replay retains the originally accepted reference. It is a lookup key and not durable authority. `threadId` is present only for a target whose conversation continuity belongs to an existing product Thread. `profileId` is a product Agent-profile selection and is not a runtime instance. Logical-model capabilities are the Gateway-derived closed projection; entries contain no model-family classification, Provider profile, provider-native model, account slot, route member, Harness, Sandbox, process, or AgentSession identity.

The catalog contains the built-in Assistant and Workspace Knowledge Manager when applicable, the running Goal Orchestrator for an active Goal, pinned reusable Worker supplies whose product-safe availability is warm, running Workers whose owning Threads the User may access, and one `new-task-worker` action. A `warm-worker` entry names reusable Agent supply and its profile, never a warm Sandbox or placement identity. Entries are deduplicated by `targetRef`, use product-safe labels, and report current availability rather than hiding a known busy or temporarily unavailable target.

Creation and update are a context-specific join over the existing Agent catalog, internal-role availability, Goal and Thread state, AgentSession readiness, Workspace configuration, User preference, and Gateway logical-model state. The conversation catalog owns no Agent health, runtime health, warm placement, or readiness fact and must consume the product-safe projections of those owners rather than recompute them. Removing or replacing one of those owners removes or changes the catalog entry on the next read. NanoCore restart rebuilds the catalog from those owners; the catalog itself has no persistence or recovery lifecycle.

## Structured Submission

NanoCore exposes `POST /api/app/workspaces/:workspaceId/threads/:threadId/conversation-turns` and the public command identity `conversation.submit`. The request is strict:

```ts
interface SubmitConversationTurnRequest {
  requestId: string;
  input: string;
  targetRef: string;
  logicalModelId?: string;
  artifactRefs: readonly {
    artifactId: string;
    artifactVersion: number;
  }[];
}
```

`input` may be empty only when at least one Artifact reference is present. Artifact references are ordered, unique by `(artifactId, artifactVersion)`, and must resolve to readable versions in the same Workspace. A local uploaded UTF-8 Markdown, text, or JSON file first uses the existing `artifact.import` command, after which the Composer submits the resulting Artifact reference. This slice adds no multipart route, transient upload handle, binary upload, or parallel attachment owner.

The immutable command scope is actor, Workspace, originating Thread, and `requestId`. The canonical input hash includes the exact input, target reference, optional logical-model preference, and ordered Artifact references. An identical replay returns the original result without re-resolving the target or repeating role, workflow, provider, Thread, Turn, Item, Artifact, worker, or Goal effects. Reusing the request identity with different canonical input returns `idempotency_key_conflict` before effects.

NanoCore validates the selected catalog entry and logical model at command acceptance. An omitted model uses the effective preference chain owned by the configuration, Agent-profile, and internal-role contracts. A supplied model is a per-submission logical-model preference and must be admitted for the selected target. The accepted logical model stays visible in the response and durable inference lineage, while concrete Gateway route selection remains private and may vary for each Provider call within the accepted logical model's derived capability and model-family contract.

## Target Dispatch

Target dispatch is a synchronous branch over existing services, not a durable dispatcher or workflow:

- `assistant` invokes the Core Assistant in the originating Thread.
- `knowledge-manager` invokes the Workspace Knowledge Manager in the originating Thread and projects its answer through ordinary Turn and Item history.
- `goal-orchestrator` uses the existing Goal steering owner for the named Goal Thread.
- `warm-worker` starts the next Task Turn in the Thread selected or created under the existing Task and AgentSession continuity rules.
- `running-worker` addresses only its owning Thread. If the owning workflow already accepts steering, NanoCore uses that command. If the target cannot accept input while its Turn is active, submission returns `target_busy` with no effects and the client retains the draft for an explicit retry.
- `new-task-worker` creates one linked Task execution Thread from the originating Thread and enters the existing Task Mode start path with the selected Agent profile and logical-model preference. It creates no Shard entity.

The response names the accepted outcome, originating Workspace and Thread, receiving Workspace and Thread, created or continued Turn when one exists, selected target, accepted logical model, and existing handoff or failure projection. `receivingWorkspaceId` equals the originating Workspace for ordinary branches and names the actual receiving Workspace for an existing cross-Workspace owner such as a Quick Chat handoff. It does not contain placement or private routing identities. A target chosen from an earlier catalog read is revalidated at submission; NanoCore does not silently substitute another target when it is missing, stale, busy, unauthorized, or incompatible.

The request always carries a `targetRef`. When the User makes no explicit choice, the client sends the catalog's `defaultTargetRef`; its resolution is owned solely by `docs/specs/20260628-nanocore_config_identity_contract.md`. An unresolved default makes the catalog unavailable with the owner's typed configuration error rather than selecting the first entry.

## Lifecycle, Failure, And Recovery

On a starter surface with no Thread, the client first uses the existing Thread-create command with its own request identity, then submits `conversation.submit` against the accepted Thread. A successful Thread creation followed by a failed or uncertain conversation submission leaves an ordinary empty Thread and the complete Composer draft for exact retry; it does not roll back Thread creation, infer a Turn, or hide the Thread. Active-Thread submission skips that first command.

Creation begins when `conversation.submit` accepts its immutable scope and canonical input. Update occurs only in the invoked existing owner. The command terminates when that owner has produced the complete accepted response tuple or a typed no-effect rejection. This specification owns no pending row, queue, settlement workflow, or background recovery process.

The command receipt stores only the branch discriminator, accepted target reference, logical-model ID, receiving Workspace and Thread IDs, created or continued Turn ID when one exists, existing Goal or Task handoff identifiers when required, result kind, and accepted HTTP status. Assistant, Knowledge Manager, Goal Orchestrator, warm Worker, running Worker, and new Task Worker branches each reconstruct replay from that receipt plus their existing durable owners. Identical replay never re-resolves the target or repeats a role call, Provider call, worker launch, steering effect, Thread, Turn, Item, Goal, Task, or Artifact effect. A missing or contradictory named owner returns `recovery_required`; the receipt stores no prompt, Item body, assistant content, Provider output, runtime identity, or full response body.

Missing target, unavailable target, busy target, disallowed model, missing Artifact version, and Workspace denial fail before role or workflow effects. A dependency failure after an existing owner accepts work follows that owner's durable failure and recovery contract. A partial or contradictory command receipt and product tuple returns `recovery_required`; NanoCore does not infer completion or repeat an external or provider effect. Process restart replays from the command receipt and existing business owners. A user-requested new attempt after a terminal failure uses a new request identity.

The client retains exact text, target, model, Artifact references, and request identity after transport uncertainty or typed failure. It clears the draft only after an accepted response. It may refresh the catalog after `target_missing`, `target_busy`, `target_unavailable`, or `model_not_allowed`, but it must not silently change the pending selection or automatically resubmit.

## Current Implementation Projection

NanoCore implements `GET /api/app/workspaces/:workspaceId/conversation-targets` and `POST /api/app/workspaces/:workspaceId/threads/:threadId/conversation-turns` with strict target, logical-model, Artifact-reference, command-receipt, replay, and recovery behavior. The catalog includes Assistant, Knowledge Manager, active Goal Orchestrator, warm Worker, running Worker, and new Task Worker choices when their owning resources are available. Submission reuses existing Assistant, Knowledge, Goal, Worker, Task, Thread, Turn, Item, Artifact, and scheduler owners and adds no Shard record or second workflow engine.

`@openkit/core-client` exposes `client.app.getConversationTargets` and `client.app.submitConversation`; `StartChatMode*`, `client.app.startChatMode`, the Chat-specific App route, and `chat.start` are absent. Direct Task, Goal, and Knowledge operations remain available to non-Composer callers.

The Web Composer implements the accepted two-region design with bounded auto-growth, Artifact selection and bounded text upload, context-filtered Agent targets, logical model selection, send action, accessible keyboard behavior, and exact draft plus request-identity preservation after failure. Product surfaces display only logical model and product target identities.

## Testing Strategy / Acceptance Criteria

- L1 schema tests cover every target kind, strict requests and responses, empty-input Artifact submission, duplicate or cross-Workspace Artifact rejection, logical-model validation, and absence of private runtime or Gateway fields.
- L2 client and command tests prove request-id insertion, canonical hashing, stable target-reference derivation, exact replay for every branch, changed-input conflict, stale-target rejection, receiving-Workspace projection, and no silent target or model substitution.
- L3 NanoCore tests exercise Assistant, Knowledge Manager, Goal Orchestrator, warm Worker, running Worker, and new Task Worker branches through their existing owners, including busy rejection and linked Task Thread creation without a Shard record.
- L4 Web tests prove the two-region action order, approximately two-and-one-half-line minimum, `min(240px, 40vh)` maximum, target and model filtering, Artifact selection and supported text-file import, preserved draft and request identity after failure, starter Thread half-state, exact retry, Enter and Shift+Enter behavior, keyboard and screen-reader operation, and no concrete Provider or runtime identity in the UI.
- One end-to-end story selects `New Shard + Worker`, submits a supported Artifact and logical model, observes the linked Task Thread and Worker Turn, and proves the worker-visible model stays logical while Gateway evidence records the private route.

Acceptance requires one target catalog, one structured submit command, no second workflow engine, no durable Shard, exact reuse of existing execution owners, one visible logical-model choice, and complete draft preservation on failure.

## Alternatives Considered

- Extend the existing text-only `chat.start` name while making it dispatch non-Assistant targets. Rejected because the public name would lie about its scope.
- Add one endpoint per target kind. Rejected because the Composer would become a client-side dispatcher and duplicate idempotency and error handling.
- Add an attachment store or general binary upload service. Rejected because the current bounded Artifact import already supports the required first upload path.
- Expose AgentSession or Sandbox identities in the target selector. Rejected because Thread and Agent supply are the product owners and runtime placement is private.

## Links

- `docs/specs/20260628-web_product_surface_projection.md`
- `docs/specs/20260710-web_ui_rebuild_stack.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-task_mode_worker_delegation.md`
- `docs/specs/20260713-work_resource_interaction_model.md`
- `docs/specs/20260528-core_client_boundary.md`
