# Work Resource Interaction Model

Status: Accepted
Implementation: Partial
Change Plan: `docs/changes/202607132212000001-work_resource_interaction_model.md`

## Owns

This spec owns the implementation-facing interaction model that lets users express precise intent against work resources without requiring every interaction to be plain text.

It owns the three work-resource planes as a classification boundary, the distinction between a resource plane and the `Artifact` product role, grounded interaction for the current Plane 1 slice, the relationship between conversation and a material surface, and the current implementation boundary.

It owns the Phase 1 contract for one Thread-bound workspace-native Markdown or plain-text material: material identity, immutable revisions, explicit Thread binding, queued next-turn inclusion, exact worker-visible revision capture, active-turn delivery, worker-produced change review, conflict-safe apply, recovery, Web projection, and acceptance criteria.

## Does Not Own

This spec does not redefine `Workspace`, `Thread`, `Turn`, `Item`, `Artifact`, `Knowledge`, `Knowledge Source`, `Context Package`, Workspace Data Source, Agent Capability, Skill, `ApprovalRequest`, or human-attention lifecycle semantics owned elsewhere.

It does not own physical workspace storage layout, general workspace synchronization transports, worker runtime protocols, sandbox implementation, vault internals, external-system schemas, provider-specific connectors, full media editors, professional project-file formats, A2UI, or screen-level Web information architecture.

It does not define a universal `Resource` entity, feedback framework, locator framework, editor protocol, workbench protocol, connector model, or plugin marketplace.

## Core References

- `docs/core/architecture.md`
- `docs/core/core-concepts.md`
- `docs/core/work-model.md`
- `docs/core/communication.md`
- `docs/core/knowledge.md`
- `docs/core/agent-workflow.md`
- `docs/core/agent-capability.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/product-vision.md`

## Summary

The accepted product posture is: **delegate by default, collaborate on demand, and govern throughout**.

Conversation remains the narrative and coordination layer, while a relevant work resource may become the shared surface for precise intent.

OpenKit classifies work resources into three planes according to source-of-truth ownership and native editability, but the current implementation scope covers only Plane 1.

The first and only authorized vertical slice is one Thread-bound Markdown or plain-text material with immutable revisions, explicit binding, exact worker-input provenance, grounded text interaction, governed worker proposals, and conflict-safe apply.

Plane 2 and Plane 3 are deferred boundary definitions. They do not authorize implementation, shared schemas, generalized frameworks, connectors, workbench integration, or public product surfaces.

## Goals / Non-goals

### Goals

- Preserve delegation as the default while allowing precise collaboration against the work itself.
- Ground Phase 1 feedback in one material identity, exact revision, stable text locator, intent, and optional explanation.
- Keep conversation, material interaction, human attention, worker execution, and review connected through NanoCore-owned records.
- Make the Web UI sufficient for the complete Phase 1 flow without requiring a desktop agent application.
- Keep worker runtimes responsible for execution while NanoCore preserves authoritative material state, input provenance, review, and handoff truth.
- Reuse existing Item, Context Package, workspace synchronization, staged review, Action Center, permission, audit, and Knowledge boundaries.

### Non-goals

- Do not add a global strong-interaction or weak-interaction mode.
- Do not make pointer movement, selection changes, keystrokes, or autosave events worker inputs.
- Do not inject workspace edits merely because the user is viewing a Thread.
- Do not add the three planes to `Artifact.kind`.
- Do not create a universal resource, feedback, locator, document, editor, workbench, or connector abstraction.
- Do not build native media, design, CAD, project-file, or external-system editing in this phase.
- Do not implement Plane 2, Plane 3, arbitrary external writeback, CRDT, operational transformation, real-time multi-user coediting, or live mutation of an active worker filesystem.
- Do not preserve backward compatibility for repository-owned internal shapes replaced during implementation.

## Decision

### Strategic product thesis

Model capability and harness maturity will eliminate interaction created only by the need to operate tools. They will not eliminate interaction required to form intent, exercise taste, judge quality, or explore possibility.

As high-quality candidate generation becomes cheaper, users may perform more creative exploration through comparison, preview, selection, and fine adjustment rather than less. High-bandwidth interaction therefore moves from teaching AI how to execute toward jointly deciding what should exist.

OpenKit MUST cover the continuous transition from delegation to co-creation, but it MUST NOT reproduce domain production workbenches such as ChatCut, Figma, or CAD tools. This boundary determines whether OpenKit remains an Agent manager or grows into a Human + Agent work system.

The higher-layer capability OpenKit must own is **judgement grounding**: converting human judgement that is difficult to express in prose into Agent input that is precise, localized, executable, and replayable.

**OpenKit should not only let users tell an Agent what to do. It should let users transmit professional judgement that is not yet fully verbalized through selection, comparison, annotation, adjustment, and local modification.**

This capability becomes more important as models become stronger because a small intent error can drive an increasingly large amount of correct but misdirected automated execution.

OpenKit's durable product moat is the ability to compress tacit human judgement into signals that an Agent can interpret and act on accurately without requiring OpenKit to become the domain tool itself.

### Product interaction posture

OpenKit MUST delegate by default, allow high-bandwidth collaboration on demand, and maintain governance throughout the lifecycle.

The default product behavior SHOULD be low interruption and high control. Routine work should progress without demanding continuous user attention, while state, provenance, pending decisions, risk, and outputs remain visible.

Interaction intensity is phase-dependent, not task-type-dependent. One Thread may move from delegation, to collaborative planning, to delegated execution, to precise review, and back to delegated refinement.

OpenKit MUST NOT introduce a global strong-interaction mode. Richer interaction composes with existing input, steering, review, elicitation, and approval paths.

### Conversation-first, work-resource-centered, grounded interaction

The target experience is **conversation-first, work-resource-centered, and grounded**.

Conversation explains why work exists, what is happening, what changed, and what decision is needed.

The active material surface shows what the user and worker are discussing.

A text selection or annotation identifies where an instruction applies, while an exact patch may express the desired replacement.

The Action Center identifies when human attention is required without replacing Thread and Item history.

### Three work-resource planes

| Plane | Authority boundary | Current authorization |
| --- | --- | --- |
| Workspace-native Material | Editable state is owned by the OpenKit workspace | Plane 1 Markdown or plain-text slice only |
| Managed Asset or Bundle | OpenKit may preserve identity and lineage while domain editing remains elsewhere | Deferred and non-authorizing |
| External System Resource | Authoritative state remains in a third-party system | Deferred and non-authorizing |

The plane is determined by authority and lifecycle, not MIME type.

These planes are classifications, not three `Artifact` kinds and not a shared record hierarchy.

### Current implementation boundary

The implementation status of this accepted contract is **Partial**.

Exact versioned lineage between turn-bound Artifacts and their communicating `artifact-reference` Items is implemented across protocol, persistence validation, worker transcript import, search indexing, export, import, and OpenAPI projection. Handled Artifact/reference write failures restore prior state, and refinement or redo rejects an unrelated active Turn before claiming the review.

Cross-file process-crash atomicity remains owned by the storage audit in C09. Workspace-only Artifact provenance, explicit introduction into a Thread, Plane 1 Material, Revision, Thread Binding, worker-availability proof, conflict-safe apply, Web, and acceptance remain unimplemented. The real Goal worker launch currently receives only the delegation objective, and no generic immutable worker Context Package trace exists to prove delivery of accepted active-turn input. Goal steering therefore fails closed without business records until S05, S13, and S39 provide that existing-authority delivery path; checkpoint diagnostics, pending rows, and recovery actions MUST NOT substitute for delivery proof.

The first slice MUST support one workspace-native Markdown or plain-text material explicitly bound to one Thread working set.

The slice is complete only when the user can create or open the material, bind it to a Thread, save a stable revision without sending a separate chat message, see that revision queued for the next worker turn, prove which revision the worker received, provide grounded text feedback, review worker-proposed changes, apply them without clobbering newer user work, and recover the same state after restart.

Plane 2 and Plane 3 MUST remain unimplemented until Plane 1 acceptance passes and a separate accepted specification authorizes the next concrete use case.

## Concept Boundaries

### Work resource is a classification

`Work resource` is a collective term for something a user and worker may inspect, discuss, transform, or act upon.

It MUST NOT become a universal core record, shared table, protocol union, or generalized framework.

Implementation MUST use the smallest existing owner or the three Plane 1 app-local records defined below.

### Artifact and Item lineage

`Artifact` remains the core-defined role for a durable user-visible output. It is not the universal identity for editable material, imported source, external state, or feedback.

An Artifact record does not own or embed an `itemId`. Item lineage is expressed by the `artifact-reference` Item that communicates the Artifact inside a Thread.

Every Artifact MUST carry current-version `contentDigest`, current-state `lastMutationRequestId`, and one immutable `origin` owned inline by the Artifact record:

| `origin.kind` | Required authority fields | Thread and Turn rule |
| --- | --- | --- |
| `turn-output` | `threadId`, `turnId`, `requestId` | The Artifact's top-level `threadId` and `turnId` MUST equal the origin and identify the producing work. |
| `imported` | `sourceKind`, `sourceId`, `sourceDigest`, `actorId`, `requestId`, `recordedAt` | The Artifact's top-level `threadId` and `turnId` MUST remain null before and after later communication. |
| `registered` | `sourceKind`, `sourceId`, `sourceDigest`, `actorId`, `requestId`, `recordedAt` | The Artifact's top-level `threadId` and `turnId` MUST remain null before and after later communication. |

`imported` means that canonical content entered through a governed direct-import request and therefore requires `sourceKind=direct-import` with `sourceId` equal to that accepted request id. `registered` means that an existing durable source was adopted and therefore requires `sourceKind=workspace-input-snapshot` or `sourceKind=evidence-bundle` with `sourceId` equal to that exact existing record id. A registered source MUST resolve with the same digest when the Artifact is accepted. These fields are self-contained provenance owned by the Artifact origin; they are not a foreign authority and do not authorize a new import, registration, or provenance record. They MUST NOT contain a raw host path, credential, transient upload handle, or inferred source. `sourceDigest` verifies the canonical source bytes accepted as Artifact version 1 and remains immutable; top-level `contentDigest` verifies the current Artifact version. Every S16 content digest is `sha256:` plus 64 lowercase hexadecimal digits over the exact canonical UTF-8 content bytes, without newline or Unicode normalization. Audit events and UI labels are projections. A new origin or source kind requires a demonstrated source and a specification update.

Every work-produced Artifact creation or content, title, or summary update communicated in a Thread MUST increment `version` exactly once and commit the matching current `contentDigest`. A lifecycle-status-only change MUST NOT change `version`. Every mutation MUST carry the expected current version and set Artifact `lastMutationRequestId` to that request.

Each communicating Turn owns exactly one `artifact-reference` Item for one Artifact. Its identity is stable for `(artifactId, communicatingTurnId)`, and its `lastMutationRequestId` owns the request proof for the currently communicated version. The Item MUST advance that field in place when the same Turn commits the Artifact's next version; communication by a later Turn creates a different Item with that communication request id, even when it communicates the same Artifact version. An Item MUST NOT move between Turns, change Artifact identity, or be rewritten by a projection. This preserves one unambiguous Item owner while allowing the same version to be communicated in different Turns or Threads.

A work-produced Artifact version and the producing or mutating Turn's required `artifact-reference` Item state form one acknowledged logical commit. NanoCore MUST acknowledge the mutation only after both sides are durable and mutually valid. A handled validation or persistence failure MUST leave both sides at the previous complete version or leave neither newly created record visible. After restart, storage MUST expose either the old complete commit or the new complete commit; a detected half-state MUST fail closed and MUST NOT be repaired by inference, compatibility parsing, or a second settlement workflow. The physical commit and crash-consistency mechanism remains owned by `docs/specs/20260703-storage_layout_record_ownership.md`.

A workspace-only Artifact import or registration MAY exist before Thread introduction only with its immutable `imported` or `registered` origin. Introduction is one idempotent Thread input command naming `artifactId` and `expectedArtifactVersion`. With no non-terminal Turn, ordinary admission creates one new Turn and its reference Item. With an active Goal Turn, the existing Goal steering owner creates the reference Item against that original Turn and queues it under that Goal. With an active non-Goal Turn, the command returns `409 thread_busy` without an Item or accepted command. An explicit `turnId` is accepted only for that exact Turn's active `user-input` gate; a missing or terminal target returns `stale`, while an existing non-gated target returns `not_awaiting_input`. No path may select an arbitrary existing Turn.

Introduction does not rewrite origin or the Artifact's null top-level `threadId` and `turnId`. Replaying the same accepted request MUST return the same Item, Turn, and delivery outcome. A missing or malformed origin in a create request returns `invalid_request`; submitted source bytes that do not match `sourceDigest` return `source_digest_mismatch`; an already durable Artifact missing valid origin or digest proof returns `recovery_required`; and an expected Artifact version mismatch returns `conflict`. All fail before creating an Item, Turn, or pending row. A materialized Artifact index or read model MUST NOT invent, infer, or replace origin or Item lineage.

A Workspace-native Material MAY be exported or intentionally frozen as an Artifact. The editable material and exported Artifact remain distinct identities connected by explicit lineage.

### Knowledge remains cross-cutting

Knowledge remains reusable workspace understanding rather than another work-resource plane.

A material or Artifact MAY become a Knowledge Source, but Knowledge proposal, review, retrieval, and injection remain owned by the Knowledge model.

## Phase 1 Grounded Interaction

### Purpose and envelope

Phase 1 grounded interaction increases precision by separating the target material revision, text location, requested intent, exact value when present, and optional explanation.

```json
{
  "subject": {
    "kind": "workspace-material",
    "id": "material-id",
    "revisionId": "revision-id"
  },
  "locator": {
    "kind": "text-range",
    "value": {}
  },
  "intent": "change",
  "value": {},
  "note": "Optional human explanation"
}
```

This shape is conceptual. It MUST be projected into the smallest existing Item, review, elicitation, approval, or App API command contract and MUST NOT create a separate feedback log or universal feedback schema.

The subject MUST identify one Workspace Material and exact immutable revision.

The locator MUST identify a document, heading or block, or text range against that revision.

The intent MUST describe the requested Phase 1 action.

The value MUST carry a bounded replacement or structured input when the intent requires one.

The note MAY carry natural-language nuance and MUST NOT be required when the structured interaction is complete.

Grounded feedback MUST be immutable once recorded in Item history. A correction creates later input that supersedes or narrows the earlier instruction.

Grounded feedback is not an Artifact. It is Item-backed user input or an item-linked review, elicitation, or approval decision.

### Phase 1 intents

| Intent | Phase 1 meaning |
| --- | --- |
| Annotate | Attach guidance to an exact text locator |
| Change | Request a modification without prescribing the full replacement |
| Patch | Provide the exact desired replacement against an expected base revision |
| Accept | Accept the reviewed proposal for the stated scope |
| Reject | Reject the reviewed proposal with a reason |
| Redo | Request a replacement attempt while preserving selected constraints |

Compare and text selection are product operations, not global workflow states or universal intent enums.

Additional intents or locators require a demonstrated Plane 1 need or a separately accepted future-plane specification.

### Locator behavior

Phase 1 MUST support document-level, heading or block-level, and text-range locators against an exact material revision.

If the material has advanced and the locator cannot be relocated deterministically, the product MUST surface a stale-anchor state and request confirmation instead of applying feedback to a guessed location.

Grounded payloads compose with existing human-attention and workflow paths; they do not redefine their lifecycle semantics.

## Plane 1: Workspace-native Material

### Definition

A Workspace-native Material is a user-visible work object whose authoritative editable state is owned by the OpenKit workspace.

The current slice supports only Markdown or plain text.

### Minimal app-local records

Phase 1 requires three app-local records and MUST NOT introduce a universal resource hierarchy.

| Product truth | Unique authority | Required state |
| --- | --- | --- |
| Material identity and current saved state | `WorkspaceMaterial` | `workspaceId`, `materialId`, `title`, `kind`, nullable `currentRevisionId`, `sensitivity`, `lastMutationRequestId`, `createdAt`, and `updatedAt` |
| Immutable saved content | `WorkspaceMaterialRevision` | `materialId`, `revisionId`, nullable `parentRevisionId`, `mediaType`, `contentDigest`, `authorId`, `createdByRequestId`, `createdAt`, and canonical `contentRef` |
| Thread association and next-turn intent | `ThreadMaterialBinding` | `workspaceId`, `threadId`, `materialId`, `bindingState` as `bound` or `unbound`, nullable `latestQueuedRevisionId`, `inclusionState` as `included` or `excluded`, `lastMutationRequestId`, `createdAt`, and `updatedAt` |
| Turn-frozen and worker-available revision | Context Package trace plus existing Workspace Input Snapshot and Workspace Materialization Record | exact material id, revision id, parent revision id, digest, inclusion reason, package path, sensitivity decision, and materialization status |
| Active Goal material delivery | Grounded input Item plus `PendingUserTurnRecord` until an accepted Context Package trace or causally linked follow-up Turn is durable | `goalId`, `activeTurnId`, `requestId`, `contentItemId`, `queueMode`, and `receivedAt` |
| Material proposal decision and apply outcome | Existing Workspace Change Set, staged Workspace Review, Workspace Apply Plan, and Workspace Apply Result | base revision and digest; `accept`, `reject`, or `defer` decision; expected-base precondition; conflict or blocked reason; and verified apply result |
| Artifact refinement or redo orchestration | Existing Artifact Review plus its reserved follow-up Turn | exact Artifact version, `needs_refinement` or `redo`, request id, feedback, source Agent, lifecycle, and deterministic `followUpTurnId` |

These records MUST remain app-local until multiple real consumers prove product-independent semantics that justify promotion.

Thread material read models, Action Center rows, indexes, audit summaries, and Web state are projections over these owners. They MUST NOT independently advance revisions, clear queues, accept reviews, infer worker availability, or recover state.

`worker-seen` in product copy means that an accepted worker Turn references the exact Context Package, the selected revision passed digest verification, and the workspace materialization handoff completed. It proves that the revision was made available to the worker; it MUST NOT claim model cognition. No separate worker-receipt record or table is permitted.

Creating a Material creates one `WorkspaceMaterial` with null `currentRevisionId`; the first save supplies expected null and creates revision 1. Phase 1 has no Material archive or delete lifecycle. Explicit unbind ends only a Thread association and preserves the Material and all revisions.

### Revision contract

Every saved revision MUST be immutable and content-addressed.

The canonical revision SHOULD store a complete content snapshot for correctness and recovery. Diffs, summaries, extracted structure, and anchor maps are derived and MUST be reproducible from canonical revisions.

NanoCore MUST receive an atomic stable revision rather than one revision per keystroke.

Unsaved client-local edits are not worker-visible and MUST be shown as unsaved.

Saving several revisions before the next worker turn MUST coalesce queued handoff to the latest stable revision while preserving historical revisions.

The save command MUST carry a request id and expected current revision id, including explicit null for first save. The new revision's `parentRevisionId` MUST equal that expected revision. One acknowledged logical commit MUST create the immutable revision, verify its digest, compare-and-set `WorkspaceMaterial.currentRevisionId`, and coalesce every `bound` binding's `latestQueuedRevisionId` to the new revision while preserving its current inclusion state. `revision_saved` is true only when all four effects are durable. An expected-revision mismatch MUST return typed `conflict` with no new visible revision, pointer, or queue change. Replaying one accepted request MUST return the same revision and MUST NOT advance the queue again. The physical transaction, publication, and cross-file crash proof remain owned by `docs/specs/20260703-storage_layout_record_ownership.md`.

### Explicit Thread binding

A material MUST be explicitly bound to a Thread before its revisions can be included automatically in that Thread's worker context.

Viewing a material beside a Thread, keeping it open, or editing an unrelated material in the same workspace MUST NOT create an implicit binding.

The product MUST show the binding and provide an explicit unbind action.

When a bound material receives a stable revision, NanoCore MUST queue its latest revision for the next eligible worker turn without requiring a separate chat message.

The product MUST show the queued revision, the last worker-seen revision when known, and whether automatic inclusion is enabled.

The user MUST be able to exclude the queued revision from the next turn or explicitly send it during active work.

Bind, unbind, exclude, and restore commands MUST be request-id idempotent and carry the expected binding state. Their only valid transitions are:

| Command | Preconditions | Committed result |
| --- | --- | --- |
| bind | Binding absent or `unbound` | `bindingState=bound`, `inclusionState=included`, and `latestQueuedRevisionId` equals the Material's current revision or null when unsaved. |
| unbind | `bindingState=bound` | Preserve the record with `bindingState=unbound`, `inclusionState=included`, and `latestQueuedRevisionId=null`. |
| exclude | `bindingState=bound`, `inclusionState=included`, and a queued revision exists | Retain the exact `latestQueuedRevisionId` and set `inclusionState=excluded`. |
| restore | `bindingState=bound` and `inclusionState=excluded` | Retain the latest queue, including a revision advanced by a later save, and set `inclusionState=included`. |

A command whose expected state matches an already-reached target is a successful no-op and MUST preserve exclusion and queue fields; replay of the same accepted request returns its original result. A save advances `latestQueuedRevisionId` for both included and excluded bound bindings. Rebinding an unbound Material uses the bind result above and does not restore an old exclusion or queue. Any other transition or expected-state mismatch returns typed `conflict` without mutation. A read projection MUST NOT infer binding from an open editor, recent Thread, or Context Package history.

### Next-turn handoff

At turn acceptance, NanoCore MUST freeze the exact set of bound material revisions selected for that turn.

Each selected material entry in the Context Package MUST carry material id, revision id, parent revision id when applicable, media type, content digest, package-relative materialized path, inclusion reason, and sensitivity decision.

When a prior worker-visible revision exists, the package SHOULD include a derived delta or concise summary from that revision to the selected revision.

The full selected revision remains authoritative. A delta or summary MUST NOT replace canonical content when the worker needs the material.

Context Package trace MUST prove the exact revision and digest the worker was allowed to see.

Selection is allowed only from a `bound` and `included` `ThreadMaterialBinding` whose queued revision resolves and passes digest verification. Preparation records alone are not a product result. `revision_selected` is true only after the Turn is durably accepted and its immutable Context Package trace contains the required material fields. `revision_materialized` is true only after that same Turn is durably accepted and the matching Workspace Input Snapshot and ready Workspace Materialization Record preserve the same revision and digest.

NanoCore MAY clear `latestQueuedRevisionId` only after the worker Turn is durably accepted with the selected Context Package and materialization handoff complete, and only through compare-and-set when the binding still points to that selected revision. If a later save advanced the queue during preparation, the later revision MUST remain queued. Admission, source, digest, or materialization failure before this predicate MUST fail Turn admission and leave the queued revision unchanged; it MUST NOT infer availability, accept a partial Turn, or substitute another revision.

A revision saved after turn acceptance MUST NOT mutate the frozen Context Package or live worker filesystem. It remains queued for a later turn unless the user invokes explicit active-turn delivery.

### Active-turn delivery

`Send now` is Steering Input, not live file synchronization and not a Context Package rewrite.

The target contract assigns queued delivery to the Goal worker loop only after the real worker path can persist an immutable accepted Context Package trace for the exact Goal, Turn, and Item. Until that proof owner exists, the Goal and generic direct-Turn adapters own typed rejection, and an exact active `user-input` gate owns its direct response. Web, Agent Skill, Action Center, checkpoint diagnostics, and worker-private state MUST NOT decide or infer the outcome.

Submission has exactly two results. A rejection returns the mapped typed error and creates no Item, pending row, command record of any status, Turn, or scheduler admission. A valid active-Goal submission creates the grounded Item and `PendingUserTurnRecord` as one logical commit, writes one completed send-command record whose response is `queued`, and returns the stable status identity. The acceptance response contains exactly `state=queued`, `pendingTurnId`, `requestId`, `contentItemId`, `goalId`, and `activeTurnId`; it MUST NOT embed a mutable Goal or Thread projection. Replay of that send command always returns the original `queued` acceptance response, while callers fetch the current Goal or Thread projection separately to observe later delivery state.

| Rejection condition | HTTP status and code |
| --- | --- |
| No non-terminal Turn exists for the active Goal, or its recorded Turn is missing or terminal | `409 stale` |
| A non-terminal Turn exists but is not the active Goal's checkpoint-backed worker Turn | `409 thread_busy` |
| The request id already owns different input or different Goal/Turn/Item lineage | `409 idempotency_key_conflict` |
| A request-owned pending row exists but its required Item or Goal/Turn lineage is missing or corrupt | `409 recovery_required` |
| The active worker adapter cannot persist and deliver the required immutable Context Package trace | `503 goal_steering_delivery_unavailable` |
| Authorization or workspace ownership fails | The existing authorization error without business records |

| Delivery state | Durable authority and predicate |
| --- | --- |
| `queued` | The grounded input Item and one `PendingUserTurnRecord` both exist. The pending row identifies the original `goalId`, `activeTurnId`, `requestId`, `contentItemId`, `queueMode=safe_point_steering`, and `receivedAt`. |
| `applied` | The exact Item is preserved in the immutable Context Package trace of a specific accepted worker Turn under the same Goal. The pending row is removed only in the same owning commit that makes this proof durable. |
| `follow-up` | A distinct follow-up Turn and its user input Item exist with causation to the original Item and active Turn. The pending row is removed only after that Turn is durably accepted. |
| `cancelled` | One completed cancel-command record exists and the pending row is removed without a new Turn or delivery claim. The audit event is a projection of that command, not recovery authority. |

`queued` is the only non-terminal delivery state and MUST transition exactly once to `applied`, `follow-up`, or `cancelled`. The status read model derives that current state from the named authorities and MUST NOT translate row deletion, worker completion, an audit event, or a recent current Turn into an `applied` claim.

The generic direct-Turn adapter currently has no safe-point or later-delivery owner. When an implicit input arrives while its Thread has a non-terminal Turn, NanoCore MUST return typed `409 thread_busy` before recording any input state or command record. Repeating the request while busy returns the same unrecorded rejection; after the Turn becomes terminal, the same request id MUST be eligible for ordinary new-Turn admission because no earlier command was accepted.

Valid `Send now` input to an active Goal MAY be accepted as `queued` only when the Goal worker loop is a concrete later-delivery owner that can persist and deliver the required Context Package trace. Valid means that authorization, exact Material revision and digest, original Goal and active-Turn lineage, idempotency preconditions, and delivery capability all pass; each failure uses the exact mapping above. Before that capability exists, submission returns `503 goal_steering_delivery_unavailable` and creates no Item, pending row, command record, Turn, or scheduler admission. After the capability exists, the pending row remains until an accepted worker Context Package proves inclusion. If the original active Turn becomes terminal while its Goal remains non-terminal, the row remains under that Goal and only the same Goal's next worker Turn may consume it. If the Goal becomes terminal first, automatic consumption stops and the Action Center exposes only convert-to-follow-up and cancel for that row. Convert-to-follow-up requires an idle Thread, creates one causally linked ordinary Turn, and removes the row only when that Turn is accepted; an active Thread returns `thread_busy` and leaves the row unchanged. Cancel removes the row only in the logical commit that writes the completed cancel-command record. Neither transition may retarget the row to a newer Goal.

An explicit input carrying `turnId` is a response to the exact active `user-input` gate, not generic steering. A missing or terminal Turn returns typed `stale`; an existing Turn without an active gate returns typed `not_awaiting_input`. Both fail without writing Item or queue state. An implicit input received when no Turn is active starts a new ordinary Turn.

After restart, queued state is reconstructed from the grounded Item and `PendingUserTurnRecord`; applied state is reconstructed only from the exact accepted Context Package trace; follow-up state is reconstructed from the causally linked Turn and Item; cancellation is reconstructed only from the completed cancel-command record. The same send request id MUST replay its original `queued` acceptance under the original Workspace, Thread, Goal, and active Turn even when the delivery status advanced or a newer Goal or Turn is current.

Effective worker-input provenance is the immutable initial Context Package plus later accepted Context Package traces that contain the ordered active-turn Items.

### Worker output and writeback

A worker MUST operate against an immutable materialized input snapshot.

Worker changes MUST NOT mutate the authoritative Workspace Material directly.

A worker-proposed edit MUST identify the base material revision and content digest, produce a change set or replacement candidate, and enter staged review.

The review surface MUST compare the worker proposal with the current authoritative revision and support accept, refinement, redo, reject, or defer.

For a Workspace Material proposal, the staged Workspace Review is the only owner of `accept`, `reject`, or `defer` and of readiness for governed apply. Artifact Review MUST NOT duplicate those decisions. The existing Artifact Review is the only owner of `needs_refinement` or `redo` follow-up orchestration; those choices leave the staged Workspace Review unchanged. Refinement and redo MUST preserve the reviewed Artifact version and prior attempt, create a distinct causally linked follow-up Turn, and reuse the source Turn's exact Agent. If the reviewed durable Artifact names a source Turn or assigned Agent that is missing, NanoCore MUST return `409 recovery_required` before an Artifact Review claim, Turn creation, or scheduler admission. The request id and deterministic `followUpTurnId` bind replay to the original Artifact, version, Thread, Agent, decision, and feedback.

The Artifact review route MAY create that follow-up only when the Thread has no other non-terminal Turn. If another Turn is active at preflight, it MUST return typed `409 thread_busy` before recording the decision, changing a Workspace Review, creating a Turn, or admitting scheduler work. The caller MAY retry the same request after the Thread becomes idle. There is no workflow-specific bypass or second queue.

After preflight, the existing Artifact Review record MUST claim the exact request as `pending` with deterministic `followUpTurnId` before Turn or scheduler effects. A failure before that claim leaves no decision. Any failure or concurrent admission after the claim retains that exact pending decision; only an identical request may resume it after the Thread becomes idle. The review becomes `completed` only after the matching follow-up Turn is durably accepted and linked. Retry MUST validate and reuse the reserved Turn and MUST NOT create another. A conflicting request receives typed `conflict`. No review queue, settlement workflow, or second work-status owner is permitted.

Applying an accepted change MUST use an expected-base precondition.

If the authoritative material still matches the worker base and all authority, path, policy, write, and verification checks pass, NanoCore MUST apply the accepted reviewed change and create a new immutable Workspace Material Revision.

If the authoritative material advanced, NanoCore MUST NOT overwrite it. The system MAY present a verified clean merge candidate, but ambiguous or conflicting changes MUST return to review.

Review `accepted` does not mean proposal `applied`. A proposal is applied only when the existing Workspace Apply Result reports `applied` after expected-base comparison, path and authority checks, the write, and post-apply verification. An expected-base mismatch or ambiguous merge produces `conflicted`. A deterministic clean merge creates a new staged Workspace Review and still requires acceptance; it is not an applied result. An unavailable source, policy denial, failed verification, or indeterminate side effect produces `blocked` with its exact reason. Indeterminate effects remain blocked until verification resolves them and MUST NOT be retried as a blind write.

A revision created from accepted worker output remains queued until a later accepted worker Turn proves availability through its Context Package.

### User authority

Direct user edits are authoritative workspace input.

Worker edits are proposals until the governed apply path accepts them.

The system MUST preserve both the user revision and worker proposal when they diverge.

Redo and refinement MUST NOT delete earlier attempts, accepted annotations, or provenance.

### Recovery

After NanoCore restart, the system MUST recover the current material revision, immutable revision history, Thread binding, queued revision, exclusion decision, Context Package provenance, pending active-turn delivery, staged worker proposal, review decision, and apply result.

Recovery MUST NOT infer worker visibility from the current material revision. It MUST use accepted Context Package traces that name the exact initial or active-turn Items.

A known durable revision whose canonical content is missing or whose digest no longer verifies MUST return `recovery_required`. Source bytes or a materialization dependency that is temporarily unavailable before Turn acceptance MUST return retryable `source_unavailable`. A stored accepted materialization whose files or digest no longer verify MUST return `recovery_required`. None may substitute the current revision.

Every mutating command MUST use one stable request id, deterministic resource identity, and expected-base precondition where state can advance concurrently. A create command MUST reserve its resource id from immutable scope plus request id before effects. `WorkspaceMaterialRevision.createdByRequestId` owns revision-create proof; Artifact and `artifact-reference` Item `lastMutationRequestId` own current version and communication proof; `WorkspaceMaterial` and `ThreadMaterialBinding.lastMutationRequestId` own their current mutable state; and existing pending, review, apply, and command records retain their named request fields. These fields support recovery but do not replace the command ledger. Idempotency lookup scope contains only immutable identifiers supplied by the request path or reserved before execution. If the request does not name a Goal or Turn, lookup MUST use the addressed Workspace and Thread and the accepted result MUST persist the resolved Goal and Turn; replay MUST NOT resolve a newer current projection before consulting the ledger.

The command ledger is written only after the owning business mutation reaches its documented success predicate. Before executing effects, NanoCore uses one stateless lookup precedence rather than a recovery workflow: replay a completed matching command record; otherwise validate and reconstruct a complete deterministic business result only when its named owner carries the same request and immutable input or expected-base lineage; otherwise resume only the exact operation-specific pending owner named below. A mismatch returns `conflict`; an advanced mutable result with neither ledger nor retained request proof returns `recovery_required`; and an indeterminate apply remains `blocked`. This lookup creates no recovery record or lifecycle.

A mutation spanning records or storage scopes MUST publish its success record only after every owning write is durable. Partial failure has one owner per operation:

| Operation | Permitted recovery state |
| --- | --- |
| Artifact creation or version plus required reference | No pending state. A handled failure exposes the prior complete pair or neither new record; a crash half-state fails closed under the storage contract. |
| Workspace-only Artifact introduction | Ordinary admission exposes the accepted Turn and exact `artifact-reference` Item together or neither. Active-Goal introduction uses only the existing grounded Item plus `PendingUserTurnRecord`. Any other durable half-state returns `recovery_required`, and exact-request replay MUST NOT create another Turn, Item, or pending row. |
| Material create, save, or binding transition | No pending state. A handled failure exposes the prior complete authority state; a crash half-state fails closed under the storage contract. |
| Goal Steering Input | The existing grounded Item plus `PendingUserTurnRecord` remains under the original Goal and Turn until applied, converted to follow-up, or cancelled. |
| Artifact refinement or redo | The existing Artifact Review `pending` lifecycle and reserved `followUpTurnId` own exact-request retry until the Turn is accepted. |
| Workspace apply | The existing Workspace Apply Result remains `blocked` with the exact verification or dependency reason; the staged Workspace Review remains the sole `accept`, `reject`, or `defer` decision source. |

Restart MUST never choose the newest-looking projection, duplicate a side effect, or create a reconciliation, settlement, provenance, or receipt workflow outside these owners. Existing Workspace Reconciliation records remain limited to their workspace backend recovery scope. Cross-file atomic publication remains the storage specification's responsibility, not authorization for an S16 recovery framework.

### Web projection

The OpenKit Web UI MUST be sufficient to complete the Plane 1 flow without another desktop agent application.

The Web UI MUST use public Core Client operations and MUST NOT access worker files, Core-private paths, or external runtime state directly.

The material surface MUST support Markdown or text viewing and editing, stable save status, revision history and comparison, text selection, grounded annotation, direct patching, Thread binding, queued-inclusion status, exclusion, `Send now`, and staged worker-change review.

The conversation surface MUST show item-backed explanations of material inclusion, active-turn delivery, worker results, conflicts, and review outcomes.

The Action Center MAY project pending material review or stale-write conflict, but it MUST remain a read model over owning records.

## Deferred Plane Boundaries

### Plane 2: Managed Asset or Bundle

Plane 2 covers an asset or bundle whose meaningful source format is not safely or economically editable through the Plane 1 material surface.

OpenKit MAY later preserve identity, version lineage, review state, previews, and import or export provenance while domain editing remains with a specialized owner.

This definition does not authorize Plane 2 records, bundle manifests, binary payload changes, derived-representation pipelines, workbench sessions, embedding, round-trip adapters, UI, or worker protocol.

Any Plane 2 implementation requires evidence from a concrete asset type and a separate accepted specification and change plan.

### Plane 3: External System Resource

Plane 3 covers a record whose authoritative state remains in an external system.

OpenKit MAY later provide bounded context and governed operations through existing Data Source, Vault, Permission, Agent Capability, approval, and audit owners without replacing that external source of truth.

This definition does not authorize external-resource records, shared projection schemas, connectors, query surfaces, writeback, synchronization, domain UI, or worker protocol.

Any Plane 3 implementation requires evidence from a concrete external system and a separate accepted specification and change plan.

### Non-authorizing future checklist

Future Plane 2 or Plane 3 design must address authority, identity, version or freshness, representation, lineage, permission, sensitivity, Thread relationship, worker-availability proof, and change precondition through its owning records.

This checklist is not a shared schema, universal reference contract, implementation plan, or authorization to add cross-plane machinery.

## Phase 1 Architecture Boundary

```text
OpenKit Web
  -> @openkit/core-client
    -> NanoCore material, Thread, Item, Context Package, review, and audit state
      -> worker adapter and workspace materialization
        -> selected worker runtime
```

The worker may run in another process, machine, or service. That deployment difference does not require the user to operate the worker's native application.

NanoCore remains authoritative for material revisions, bindings, accepted worker-input provenance, review state, and public product truth.

## Contract / Expected Behavior

### Observable result predicates

| Result | Required external observation |
| --- | --- |
| `artifact_origin_recorded` | The Artifact's immutable origin exists and its Thread and Turn fields obey the origin-kind rule; imported or registered version 1 verified `sourceDigest` at acceptance, while the current version independently verifies top-level `contentDigest`. |
| `artifact_version_committed` | The Artifact version, digest, `lastMutationRequestId`, and required exact reference Item state are durable and mutually valid; neither half is independently visible. |
| `artifact_introduced` | An accepted Thread input Turn contains an `artifact-reference` Item for the exact workspace-only Artifact version and communication request, while the Artifact origin remains unchanged. |
| `revision_saved` | The immutable revision exists and verifies, `WorkspaceMaterial.currentRevisionId` points to it through expected-base compare-and-set, and every bound binding queue coalesced in the same acknowledged logical commit. |
| `revision_queued` | A bound `ThreadMaterialBinding.latestQueuedRevisionId` equals the revision and inclusion state is `included`. |
| `revision_selected` | The accepted Turn's Context Package trace names the exact material, revision, parent, digest, inclusion reason, package path, and sensitivity decision. |
| `revision_materialized` | The accepted Turn's matching Workspace Input Snapshot and ready Workspace Materialization Record preserve the selected revision and digest. |
| `worker_available` | An accepted worker Turn references the selected Context Package and the materialization handoff completed; this does not claim that the model read or understood the content. |
| `active_input_queued` | The completed send-command record, grounded Item, and matching `PendingUserTurnRecord` identify one original Goal and active Turn. |
| `active_input_applied` | The exact Item has durable Context Package provenance for a specific accepted worker Turn under the same Goal and no pending row remains. |
| `active_input_follow_up` | A distinct accepted Turn and its grounded input Item have causation to the original active-turn Item and Turn and no pending row remains. |
| `active_input_cancelled` | The completed cancel-command record is durable, no pending row remains, and no delivery or follow-up Turn is claimed. |
| `conflict` | An existing authority disagrees with the expected base, immutable lineage, active-Turn ownership, binding transition, or idempotency input; no conflicting mutation or side effect is committed. |
| `stale` | The requested historical revision, locator, gate, or target Turn is absent, terminal, expired, or otherwise no longer addressable; the system does not relocate, retarget, or substitute by inference. |
| `blocked` | The existing Apply Result names the unavailable dependency, policy denial, failed verification, or indeterminate effect and does not claim apply success. |
| `proposal_applied` | The Workspace Apply Result is `applied` and expected-base, authority, path, write, and post-apply verification all succeeded; review acceptance or a merge candidate alone is insufficient. |

### Invariants

- Conversation MUST remain usable without a material surface, and a bound material surface MUST remain traceable to its Thread.
- A grounded interaction MUST reference the exact material revision the user evaluated.
- Grounded feedback MUST use an owning Item, review, elicitation, approval, or App API path and MUST NOT create a hidden communication log.
- A bound stable revision MUST be eligible for automatic next-turn inclusion without a separate message.
- An unbound or explicitly excluded material MUST NOT be included merely because it changed in the workspace.
- A turn MUST consume an immutable input snapshot.
- A later save MUST NOT mutate an accepted turn's initial Context Package.
- Accepted active-turn delivery MUST remain ordinary Steering Input and MUST expose whether it was applied, queued, or converted to follow-up work; an adapter without a delivery owner MUST reject before recording it.
- Worker output MUST NOT overwrite newer user work.
- Direct user edits MUST remain authoritative, while worker changes remain proposals until governed apply.
- Artifact identity MUST remain reserved for durable user-visible outputs and MUST follow the Item-lineage boundary in this spec.
- Artifact origin is immutable, and each version plus its required provenance or reference Item revision MUST commit as one logical mutation.
- Refinement and redo MUST preserve earlier attempts and MUST NOT bypass another non-terminal Turn or create a competing workspace writer.
- Replay and restart MUST preserve the originally accepted lineage and outcome rather than resolving through a newer current Goal, Turn, revision, binding, or projection.
- Plane 2 and Plane 3 MUST remain deferred until separately authorized.

### Error and stale-state behavior

Failure mapping is exact. Missing or malformed required request fields are `invalid_request`; submitted bytes that disagree with their digest are `source_digest_mismatch`; a temporarily unavailable pre-acceptance source or materializer is `source_unavailable`; and missing or invalid content in already durable authority, including a reviewed Artifact's recorded source Turn or assigned Agent, is `recovery_required`. An absent or terminal requested target, historical revision, gate, or locator is `stale`; an existing Turn without an active input gate is `not_awaiting_input`; and an expected-version, expected-base, binding-state, immutable-lineage, or idempotency mismatch is `conflict`. Unauthorized access is `forbidden`, apply-time policy denial is `blocked`, and `thread_busy` is reserved for a valid request prevented only by another non-terminal Turn.

An input or refinement that cannot enter its addressed active Thread without violating the owning delivery or concurrency rule MUST return typed `thread_busy` before recording an accepted command.

The system MUST NOT substitute the latest revision for a requested historical revision.

The system MUST NOT relocate a grounded annotation when the exact target cannot be proven.

The system MUST NOT mark a revision worker-visible unless an accepted worker Turn's exact Context Package proves availability.

A dependency outage or half-state MUST follow the operation-specific recovery table above. Artifact/provenance, revision/pointer, and binding/queue half-states fail closed under the storage contract; Goal input remains in its existing pending row; refinement or redo remains in its existing pending Artifact Review; and apply remains in its existing blocked Apply Result. No implementation may choose a different owner or fabricate the missing half.

### Audit and privacy

Material creation, revision save, Thread binding, unbinding, queued-inclusion exclusion, active-turn send, worker availability, staged proposal, review decision, apply result, and conflict SHOULD be auditable at the appropriate product level.

Audit and Item projections MUST avoid secret values, Core-private paths, external credentials, and unnecessary sensitive-content duplication.

Workspace boundaries MUST be preserved in material identity, revision lookup, Thread binding, Context Package selection, review, and worker materialization.

## Phase 1 Public Design

### Thread material read model

The client SHOULD receive one cohesive Thread material projection containing the bound material identity, current saved revision, queued revision, last worker-seen revision derived from provenance, current turn's frozen revision when present, pending active-turn delivery, staged proposal, conflict state, and available actions.

This projection is a read model. Material revision, binding, Context Package, Item, and review records remain authoritative.

### Command surface

The implementation MUST provide typed governed operations for workspace-only Artifact import or registration with immutable origin and for introduction of an exact Artifact version into one accepted Thread Turn. Storage-only creation with null Thread and Turn and no origin is invalid.

The implementation MUST provide typed public operations for creating or reading a material, saving an expected-base revision, listing and comparing revisions, binding or unbinding a material, excluding or restoring queued inclusion, sending a queued revision to an active turn, reading handoff status, and reviewing or applying a worker proposal.

Every mutating command MUST use request-id idempotency, stable immutable scope, and expected-base semantics where concurrent changes can occur.

Web and Agent Skill Interface consumers MUST use governed public operations instead of NanoCore storage.

## Alternatives Considered

| Alternative | Decision |
| --- | --- |
| Treat every plane as an Artifact kind | Rejected because it turns a durable output role into a universal resource model |
| Keep interaction text-only | Rejected because known target and location would be discarded and re-inferred from prose |
| Add strong and weak interaction modes | Rejected because interaction intensity changes within one Thread and existing lifecycle owners remain sufficient |
| Inject every workspace edit | Rejected because workspace presence is not Thread intent; explicit binding is required |
| Stream edits into the active worker filesystem | Rejected because it breaks immutable input provenance and introduces live synchronization races |
| Adopt CRDT or operational transformation | Rejected because Phase 1 needs a versioned publish and handoff barrier, not character-level coediting |

## Consequences

### Positive

- The product preserves delegated work while supporting precise intent where human judgement matters.
- Worker inputs become explainable through exact material revisions and applied steering records.
- User edits and worker proposals can coexist without silent overwrite.
- Artifact, Knowledge, Context Package, and workflow ownership remain separate.

### Costs

- Phase 1 requires app-local material, revision, binding, read-model, and public operation surfaces.
- Revision persistence, context assembly, materialization, review, and Web projection must align.
- Grounded anchors require explicit stale-state behavior.
- Exact worker availability requires an accepted Turn, its Context Package, and verified materialization provenance for initial and active-turn input.

## Testing Strategy / Acceptance Criteria

### L1 schema and unit coverage

- Material ids, revision ids, parent linkage, digests, media types, sensitivity, and expected-base validation are deterministic.
- A saved revision is immutable.
- Multiple saves coalesce queued handoff to the latest stable revision without deleting history.
- An unrelated or unbound material is never selected.
- A stale text locator is rejected or surfaced for confirmation.
- A duplicate request id does not create a duplicate revision, binding, or review decision.
- Artifact import or registration rejects missing origin and digest mismatch, returns `conflict` for expected-version mismatch, and leaves an Artifact plus required provenance or reference at the prior complete state or absent after failure.
- Generic direct-Turn input produces `thread_busy` with no Item, pending row, admission, or accepted command while another Turn is active, and the same request may start normally after terminal state.
- Goal steering replay remains bound to the original Goal and Turn after they become terminal or a newer Goal appears.
- Artifact refinement or redo does not record an accepted decision or create a follow-up while another Turn is active, and exact-request retry creates only one follow-up after the Thread becomes idle.

### L2 contract and conformance coverage

- Public API, Core Client, Context Package, Item references, and Web read models agree on material and revision identity.
- A Thread binding is explicit, workspace-scoped, and cannot reference another workspace.
- The initial Context Package plus later accepted Context Package traces containing active-turn Items reconstruct effective worker input.
- A work-produced Artifact creation or update communicated in a Thread has an exact `artifact-reference` Item for the communicated Artifact version in that Thread and Turn, while the Artifact record has no `itemId`.
- A workspace-only Artifact import or registration preserves explicit provenance, and introducing it into a Thread creates an exact `artifact-reference` Item.
- Every public read model derives `revision_saved`, queued, selected, materialized, worker-available, active-input, conflict, stale, and apply outcomes from the authority table and observable predicates rather than independent status fields.

### L3 NanoCore black-box coverage

- A bound revision is frozen into the next turn without a separate message about the edit.
- A revision saved after turn acceptance remains queued and does not mutate running worker input.
- Excluding a queued revision prevents inclusion.
- `Send now` distinguishes unrecorded rejection from initial queued acceptance, keeps send-command replay queued, and reports queued, applied, follow-up, or cancelled current status truthfully.
- Restart preserves bindings, queues, exact worker-seen revisions, pending deliveries, proposals, and review state.
- Restart and duplicate-request tests cover command-ledger loss with a complete deterministic result, retained pending ownership, Goal or Turn lifecycle change, and handled partial persistence failure without duplicate side effects.
- Missing content, digest mismatch, expected-base conflict, and cross-workspace references fail closed.

### L4 Web browser coverage

- The user can edit and save a material, bind it to a Thread, see queued state, exclude it, or send it now.
- The user can compare revisions, select text, create grounded feedback, and see its exact revision anchor.
- The user can compare a worker proposal with the current revision and accept, refine, redo, reject, or defer.
- The UI never claims that a worker saw a revision without server provenance.
- The complete Phase 1 flow works without opening a desktop worker application.

### L5 integrity coverage

- Every material revision referenced by a Context Package or staged proposal can be resolved and digest-verified.
- Invalid parent chains, missing canonical content, and unresolved pending handoffs are reported.
- Restart recovery preserves material identity, revision history, bindings, and worker-input provenance.
- Artifact/provenance, Artifact/reference including workspace-only introduction, revision/current-pointer, binding/queue, queue/Context Package, and review/apply fault injection proves that acknowledged state is complete and unacknowledged half-state is rolled back or fails closed.

### L6 story acceptance

The canonical story MUST prove the following sequence.

1. A user creates a Thread and binds a Markdown material at revision 1.
2. A worker turn receives revision 1, and its Context Package records revision 1 and its digest.
3. The user saves revision 2 without sending a separate chat message.
4. The product shows revision 2 queued and identifies revision 1 as the last worker-seen revision.
5. The next turn receives revision 2 plus a traceable delta or summary from revision 1.
6. The worker produces a proposal based on revision 2.
7. The user edits the material to revision 3 while the proposal is pending.
8. Accepting the stale proposal does not overwrite revision 3 and instead produces a conflict or verified merge review.
9. Restarting NanoCore preserves every revision, binding, worker-availability proof, proposal, and pending decision.

Additional acceptance MUST cover unrelated-material exclusion, explicit queued-revision exclusion, active-turn delivery, stale-anchor handling, workspace isolation, and redo without deletion of prior attempts.

## Stop Rules

If users cannot predict or trust automatic next-turn inclusion despite explicit binding and visible queue state, Phase 1 MUST shrink to an explicit `Publish to Thread` action rather than add heuristics.

For the current slice, Goal steering MUST return `goal_steering_delivery_unavailable` before accepting input because the real worker path cannot yet persist the required Context Package trace, while the direct-Turn adapter MUST return typed busy before accepting implicit input during another Turn. Neither path may mutate the live worker filesystem or create a substitute receipt, settlement, or recovery workflow.

If future asset types fail to share meaningful contracts, OpenKit MUST NOT build a universal Plane 2 protocol.

If a future external integration requires OpenKit to mirror a domain system, the design MUST be re-reviewed before implementation.

## Open Questions

There are no blocking open questions for Phase 1.

- [Non-blocking] The exact text-anchor encoding may be chosen during test-first implementation if it preserves exact revision anchoring, deterministic validation, and stale-state behavior.

## Deferred / Future Work

- Additional Plane 1 material kinds after the Markdown or plain-text slice proves the contract.
- Cross-material comparison and richer bounded controls after a demonstrated need.
- Plane 2 design only through a concrete asset type and separately accepted specification.
- Plane 3 design only through a concrete external system and separately accepted specification.
- Promotion of proven app-local material semantics only after multiple consumers demonstrate a durable product-independent contract.
- Multi-user coediting only after a demonstrated requirement exceeds versioned handoff and publish barriers.

## Links

- [Change Plan](../changes/202607132212000001-work_resource_interaction_model.md)
- [Product Vision](../product-vision.md)
- [Core Concepts](../core/core-concepts.md)
- [Work Model](../core/work-model.md)
- [Communication Model](../core/communication.md)
- [Knowledge Model](../core/knowledge.md)
- [Human Attention And Intervention Model](./20260531-human_attention_intervention_model.md)
- [Worker Context Package](./20260703-worker_context_package.md)
- [Workspace Synchronization](./20260703-workspace_synchronization.md)
- [OpenKit Agent Skill Interface](./20260713-openkit_agent_skill_interface.md)
