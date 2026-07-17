# Work Resource Interaction Model

Status: Accepted
Implementation: Partial
Change Plan: `docs/changes/202607132212000001-work_resource_interaction_model.md`

## Owns

This spec owns the implementation-facing interaction model that lets users express precise intent against work resources without requiring every interaction to be plain text.

It owns the three work-resource planes as a classification boundary, the distinction between a resource plane and the `Artifact` product role, the deferred boundary for future grounded interaction, the relationship between conversation and a material surface, and the current implementation boundary.

It owns the authorized Phase 1 contract for one Thread-bound workspace-native Markdown or plain-text material through material identity, immutable revisions, explicit Thread binding, queued next-turn inclusion, exact worker-visible revision capture, active-turn delivery, recovery, Web projection, and acceptance criteria. It preserves decision-grade constraints for worker proposals and conflict-safe apply, but does not authorize that writeback path until its single review and apply owner is settled with G05/C09.

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

The first and only authorized vertical slice is one Thread-bound Markdown or plain-text material with immutable revisions, explicit binding, and exact worker-input provenance. Worker proposal and writeback are deferred inside Plane 1 until one existing owner is selected; this specification does not authorize a parallel review or apply engine.

Plane 2 and Plane 3 are deferred boundary definitions. They do not authorize implementation, shared schemas, generalized frameworks, connectors, workbench integration, or public product surfaces.

## Goals / Non-goals

### Goals

- Preserve delegation as the default while allowing precise collaboration against the work itself.
- Preserve a narrow future boundary for grounded feedback without authorizing a locator schema, feedback command family, or editor framework in this slice.
- Keep conversation, material interaction, human attention, worker execution, and review connected through NanoCore-owned records.
- Make the Web UI sufficient for the complete Phase 1 flow without requiring a desktop agent application.
- Keep worker runtimes responsible for execution while NanoCore preserves authoritative material state, input provenance, review, and handoff truth.
- Reuse existing Item, Context Package, Action Center, permission, audit, and Knowledge boundaries, and reuse workspace synchronization or staged review only where their exact existing authority contract actually matches.

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

Current turn-produced Artifacts preserve paired Thread and Turn lineage, maintain one same-Turn `artifact-reference` Item, and roll back handled Artifact/reference write failures. They do not yet implement this specification's immutable origin, content digest, mutation request proof, per-communicating-Turn reference identity, later-Turn communication, workspace-only import, or explicit Thread introduction. The generic metadata `PATCH` remains a removal-only current route with no production consumer and is not S16 authority.

Cross-file process-crash atomicity remains owned by the storage audit in C09. Workspace-only Artifact provenance, explicit introduction into a Thread, Plane 1 Material, Revision, Thread Binding, worker-availability proof, Web, and acceptance remain unimplemented. The real Goal worker launch receives the complete structured worker request, but no immutable accepted Context Package trace proves the exact Items or Material revisions delivered to that Turn. Goal steering therefore fails closed without business records until S05, S13, and S39 provide that existing-authority delivery path; checkpoint diagnostics MUST NOT substitute for delivery proof. The former generic pending-input table, runtime module, queue drain, recovery routes and actions, Action Center rows, schemas, Core Client and removal-only MCP methods, OpenAPI paths, import/export family, public deterministic seed, Web fixtures, and dedicated recovery story are absent. No current `PendingUserTurnRecord` exists: the record and terminal commands defined below remain target authority that may be implemented only with exact original-Goal and active-Turn lineage, immutable delivery proof, terminal claim, command receipt, and deterministic downstream effect.

The first slice MUST support one workspace-native Markdown or plain-text material explicitly bound to one Thread working set.

The authorized authority-and-delivery slice is complete only when the user can create or open the material, bind it to a Thread, save a stable revision without sending a separate chat message, see that revision queued for the next worker turn, prove which revision the worker received, and recover the same state after restart. Worker proposal and writeback require the separate owner decision above before they can become implementation or acceptance work.

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

`imported` means that canonical content entered through a governed direct-import request and therefore requires `sourceKind=direct-import` with `sourceId` equal to that accepted request id. These fields are self-contained provenance owned by the Artifact origin; they are not a foreign authority and do not authorize a new provenance record. They MUST NOT contain a raw host path, credential, transient upload handle, or inferred source. `sourceDigest` verifies the canonical source bytes accepted as Artifact version 1 and remains immutable; top-level `contentDigest` verifies the current Artifact version. Every S16 content digest is `sha256:` plus 64 lowercase hexadecimal digits over the exact canonical UTF-8 content bytes, without newline or Unicode normalization. Audit events and UI labels are projections. A new origin or source kind requires a demonstrated source with one uniquely resolvable canonical byte payload and a specification update. Workspace Input Snapshot and Evidence Bundle records do not currently own such a payload, so `artifact.register` and a `registered` origin are not authorized in Phase 1.

`artifact.import` has one exact success shape. Its Artifact id is deterministic from actor, Workspace, command, and request identity; `workspaceId` is the addressed Workspace; `threadId` and `turnId` are null; `kind=file`; `status=ready`; `summary=null`; `version=1`; `title` is the caller title; `content.body` is the exact submitted string; `lastMutationRequestId=origin.requestId=origin.sourceId=requestId`; `origin.kind=imported`; `origin.sourceKind=direct-import`; `origin.actorId` is the authenticated actor; `origin.sourceDigest` equals the top-level `contentDigest`; and `origin.recordedAt=createdAt=updatedAt` is the accepted command time. Media type maps exactly as `text/markdown -> content.format=markdown`, `text/plain -> content.format=text`, and `application/json -> content.format=json`; every other media type is `400 invalid_request`. Import creates no Thread, Item, Turn, Agent, or Artifact Review owner.

Every work-produced Artifact creation or content, title, or summary update communicated in a Thread MUST increment `version` exactly once and commit the matching current `contentDigest`. A lifecycle-status-only change MUST NOT change `version`. Every mutation MUST carry the expected current version and set Artifact `lastMutationRequestId` to that request.

Each communicating Turn owns exactly one `artifact-reference` Item for one Artifact. Its identity is stable for `(artifactId, communicatingTurnId)`, and its `lastMutationRequestId` owns the request proof for the currently communicated version. The Item MUST advance that field in place when the same Turn commits the Artifact's next version; communication by a later Turn creates a different Item with that communication request id, even when it communicates the same Artifact version. An Item MUST NOT move between Turns, change Artifact identity, or be rewritten by a projection. This preserves one unambiguous Item owner while allowing the same version to be communicated in different Turns or Threads.

A work-produced Artifact version and the producing or mutating Turn's required `artifact-reference` Item state form one acknowledged logical commit. NanoCore MUST acknowledge the mutation only after both sides are durable and mutually valid. A handled validation or persistence failure MUST leave both sides at the previous complete version or leave neither newly created record visible. After restart, storage MUST expose either the old complete commit or the new complete commit; a detected half-state MUST fail closed and MUST NOT be repaired by inference, compatibility parsing, or a second settlement workflow. The physical commit and crash-consistency mechanism remains owned by `docs/specs/20260703-storage_layout_record_ownership.md`.

A workspace-only Artifact import MAY exist before Thread introduction only with its immutable `imported` origin. Introduction uses the exact `artifact.introduce` command scoped by authenticated actor, Workspace, Thread, and required `requestId`; its canonical caller input is exactly `{ artifactId, expectedArtifactVersion }`. One deterministic idle-Thread admission rechecks that the Thread has no non-terminal Turn, reserves the deterministic Turn and `artifact-reference` Item identities, writes that Core-local Turn directly as `completed`, writes the completed reference Item for the exact Artifact version, and then publishes the command receipt under the Artifact-family compromise below. The Turn has no Agent, Agent Session, provider call, worker, scheduler admission, checkpoint, or runtime effect. Leaving the Artifact's immutable origin and top-level null Thread and Turn unchanged is part of the same acknowledged success predicate.

Any active Turn, including a Goal Turn or user-input gate, returns `409 thread_busy` before an Item, Turn, pending row, or command record; this bounded compromise requires the caller to wait for an idle Thread instead of extending Goal steering or gate payloads. Because the rejection is unrecorded, the same request id and input may be retried after the Thread becomes idle. Exact replay of an accepted command returns the original completed Turn and Item; changed input returns `idempotency_key_conflict`, an expected-version mismatch returns `conflict`, and any partial or contradictory accepted tuple returns `recovery_required` without creating another Turn or Item. Concurrent admission succeeds for only one competing Turn transaction; the loser reevaluates the busy predicate and cannot double-record introduction.

Introduction does not rewrite origin or the Artifact's null top-level `threadId` and `turnId`. Replaying the same accepted request MUST return the same Item, Turn, and delivery outcome. A missing or malformed origin in a create request returns `invalid_request`; submitted source bytes that do not match `sourceDigest` return `source_digest_mismatch`; an already durable Artifact missing valid origin or digest proof returns `recovery_required`; and an expected Artifact version mismatch returns `conflict`. All fail before creating an Item, Turn, or pending row. A materialized Artifact index or read model MUST NOT invent, infer, or replace origin or Item lineage.

Artifact and Item file authority, and a refinement or redo follow-up Turn plus worker admission, cannot share one physical transaction with the existing Workspace command ledger. Phase 1 accepts one bounded fail-closed compromise for those Artifact-family commands: persist the complete operation-specific Artifact, reference, introduction, or follow-up authority tuple first, publish its command receipt immediately afterward, and acknowledge only after both succeed. An `accepted`, `rejected`, or `deferred` Artifact Review decision has no downstream effect and therefore commits its version-owned Review decision and receipt together in `workspace.sqlite`; it does not use the cross-store compromise. A handled authority-write or receipt-write failure rolls back to the prior complete tuple where the existing owner can do so. After restart, a complete request-owned cross-store tuple without its receipt returns `recovery_required` on exact retry; NanoCore does not infer the winner, synthesize the receipt, repeat the side effect, or add a settlement workflow. Artifact `origin.requestId`, top-level and reference `lastMutationRequestId`, the deterministic introduction identities, and Artifact Review `decisionRequestId` provide the operation-specific request proof for detecting a gap.

A Workspace-native Material MAY be exported or intentionally frozen as an Artifact. The editable material and exported Artifact remain distinct identities connected by explicit lineage.

### Knowledge remains cross-cutting

Knowledge remains reusable workspace understanding rather than another work-resource plane.

A material or Artifact MAY become a Knowledge Source, but Knowledge proposal, review, retrieval, and injection remain owned by the Knowledge model.

## Deferred Grounded Interaction Boundary

Grounded annotation, exact text-range patching, locator relocation, compare-driven feedback, and related editor controls are not authorized by this Phase 1 slice. Their product direction remains compatible with conversation, Item, review, elicitation, and approval owners, but no conceptual payload, intent enum, locator value, command, status, UI requirement, or test in this document may be treated as an implementation contract.

A future implementation requires a separately accepted specification that names one concrete product need and defines the exact command scope and canonical input, locator units and stale rules, durable Item or review owner, lifecycle, replay, failure mapping, privacy boundary, public API, and acceptance evidence. It MUST reuse an existing lifecycle where one fits and MUST NOT introduce a universal feedback or locator framework.

## Plane 1: Workspace-native Material

### Definition

A Workspace-native Material is a user-visible work object whose authoritative editable state is owned by the OpenKit workspace.

The current slice supports only Markdown or plain text.

### Minimal app-local records

Phase 1 requires three app-local records and MUST NOT introduce a universal resource hierarchy.

| Product truth | Unique authority | Required state |
| --- | --- | --- |
| Material identity and current saved state | `WorkspaceMaterial` | `workspaceId`, `materialId`, `title`, `kind`, nullable `currentRevisionId`, `sensitivity`, `lastMutationRequestId`, `createdAt`, and `updatedAt` |
| Immutable saved content | `WorkspaceMaterialRevision` | `workspaceId`, `materialId`, `revisionId`, nullable `parentRevisionId`, `mediaType`, `contentDigest`, exact canonical UTF-8 `content`, `authorId`, `createdByRequestId`, and `createdAt` |
| Thread association and next-turn intent | `ThreadMaterialBinding` | `workspaceId`, `threadId`, `materialId`, `bindingState` as `bound` or `unbound`, nullable `latestQueuedRevisionId`, `inclusionState` as `included` or `excluded`, `lastMutationRequestId`, `createdAt`, and `updatedAt` |
| Turn-frozen and worker-available revision | Context Package trace plus existing Workspace Input Snapshot and Workspace Materialization Record | exact material id, revision id, parent revision id, digest, inclusion reason, package path, sensitivity decision, and materialization status |
| Active Goal steering delivery | Input Item plus `PendingUserTurnRecord` until an accepted Context Package trace or an exact terminal-command proof is durable | `workspaceId`, `threadId`, deterministic `pendingTurnId`, `goalId`, `activeTurnId`, `requestId`, `contentItemId`, `inputKind` as `message` or `material`, nullable `materialId`, `revisionId`, and `contentDigest`, `queueMode`, `receivedAt`, and nullable `terminalClaimKind`, `terminalClaimId`, and `terminalClaimedAt` used only as the first-writer fence below |
| Artifact review and refinement | Existing app-local `ArtifactReview` keyed by `(artifactId, artifactVersion)` plus a reserved follow-up Turn only when required | deterministic `reviewId`, Workspace, exact Artifact version and digest, nullable source Thread, Turn, and Agent, nullable first-writer decision tuple, and nullable deterministic `followUpTurnId` |

The three Material records and their command receipts are authoritative rows in the same Workspace `workspace.sqlite`. Each save or binding transition commits every named Material owner and its receipt in one database transaction; there is no Material file authority, cross-store receipt reconstruction, pending mutation, or settlement state. `WorkspaceMaterialRevision.content` is the canonical content. S46 and S51 require strict portable line-oriented export/import for all three row families and identity/reference rewriting on collision; no private Material directory or `contentRef` layout is authorized in Phase 1.

These records MUST remain app-local until multiple real consumers prove product-independent semantics that justify promotion.

Thread material read models, Action Center rows, indexes, audit summaries, and Web state are projections over these owners. They MUST NOT independently advance revisions, clear queues, accept reviews, infer worker availability, or recover state.

`worker-seen` in product copy means that an accepted worker Turn references the exact Context Package, the selected revision passed digest verification, and the workspace materialization handoff completed. It proves that the revision was made available to the worker; it MUST NOT claim model cognition. No separate worker-receipt record or table is permitted.

Creating a Material creates one `WorkspaceMaterial` with null `currentRevisionId`; the first save supplies expected null and creates revision 1. Phase 1 has no Material archive or delete lifecycle. Explicit unbind ends only a Thread association and preserves the Material and all revisions.

Material `sensitivity` is exactly `public`, `internal`, or `restricted` and is required at creation; no default or later mutation exists. Every value remains Workspace-scoped and does not widen authorization or export access. `public` and `internal` are eligible for Context Package selection subject to the existing permission, policy, budget, and binding predicates. `restricted` remains readable and editable by an authorized user but is excluded from automatic and `Send now` worker delivery with the trace reason `sensitive_content`; an explicit worker-delivery override is not authorized in Phase 1.

### Revision contract

Every saved revision MUST be immutable and content-addressed.

The canonical revision SHOULD store a complete content snapshot for correctness and recovery. Diffs, summaries, extracted structure, and anchor maps are derived and MUST be reproducible from canonical revisions.

NanoCore MUST receive an atomic stable revision rather than one revision per keystroke.

Unsaved client-local edits are not worker-visible and MUST be shown as unsaved.

Saving several revisions before the next worker turn MUST coalesce queued handoff to the latest stable revision while preserving historical revisions.

The save command MUST carry a request id and expected current revision id, including explicit null for first save. The new revision's `parentRevisionId` MUST equal that expected revision. Material kind fixes revision media type: `markdown` derives `text/markdown`, and `text` derives `text/plain`; the caller does not submit media type, and an unknown field is `400 invalid_request`. One acknowledged Workspace transaction MUST create the immutable revision with exact content and verified digest, compare-and-set `WorkspaceMaterial.currentRevisionId` together with `lastMutationRequestId`, coalesce every `bound` binding's `latestQueuedRevisionId` to the new revision while preserving its current inclusion state and recording that request, and publish the command receipt. `revision_saved` is true only when all effects are durable. An expected-revision mismatch MUST return typed `409 conflict` with no revision, pointer, queue, conflict record, audit success, or command receipt. Replaying one accepted request MUST return the same revision and MUST NOT advance the queue again.

### Explicit Thread binding

A material MUST be explicitly bound to a Thread before its revisions can be included automatically in that Thread's worker context.

Phase 1 permits at most one `bound` Material per Thread. Binding another Material while one is bound returns `409 conflict` with no mutation; an unbound historical binding does not block a new bind. This singular bound owner is the source for the Thread material read model.

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

Only exact replay of the accepted request returns its original successful result after the target state has been reached. A different request whose expected state is stale returns typed `conflict` without mutation even when its desired target already matches the current projection; no command acquires implicit last-writer or no-op authority. A save advances `latestQueuedRevisionId` for both included and excluded bound bindings. Rebinding an unbound Material uses the bind result above and does not restore an old exclusion or queue. A read projection MUST NOT infer binding from an open editor, recent Thread, or Context Package history.

### Next-turn handoff

At turn acceptance, NanoCore MUST freeze the exact set of bound material revisions selected for that turn.

Each selected material entry in the Context Package MUST carry material id, revision id, parent revision id when applicable, media type, content digest, package-relative materialized path, inclusion reason, and sensitivity decision.

Context Package trace MUST prove the exact revision and digest the worker was allowed to see.

Selection is allowed only from a `bound` and `included` `ThreadMaterialBinding` whose queued revision resolves and passes digest verification. Preparation records alone are not a product result. `revision_selected` is true only after the Turn is durably accepted and its immutable Context Package trace contains the required material fields. `revision_materialized` is true only after that same Turn is durably accepted and the matching Workspace Input Snapshot and ready Workspace Materialization Record preserve the same revision and digest.

NanoCore MAY clear `latestQueuedRevisionId` only after the worker Turn is durably accepted with the selected Context Package and materialization handoff complete, and only through compare-and-set when the binding still points to that selected revision. If a later save advanced the queue during preparation, the later revision MUST remain queued. Admission, source, digest, or materialization failure before this predicate MUST fail Turn admission and leave the queued revision unchanged; it MUST NOT infer availability, accept a partial Turn, or substitute another revision.

A revision saved after turn acceptance MUST NOT mutate the frozen Context Package or live worker filesystem. It remains queued for a later turn unless the user invokes explicit active-turn delivery.

### Active-turn delivery

`Send now` is Steering Input, not live file synchronization and not a Context Package rewrite.

The target contract assigns queued delivery to the Goal worker loop only after the real worker path can persist an immutable accepted Context Package trace for the exact Goal, Turn, and Item. Until that proof owner exists, the Goal and generic direct-Turn adapters own typed rejection, and an exact active `user-input` gate owns its direct response. Web, Agent Skill, Action Center, checkpoint diagnostics, and worker-private state MUST NOT decide or infer the outcome.

The submission command is `goal.steering.send`, scoped by authenticated actor, Workspace, Thread, and required `requestId`. Its canonical caller input is exactly one of `{ message }` for ordinary non-empty text steering or `{ materialId, revisionId, contentDigest, note? }` for an exact Workspace Material revision; every supplied string is non-empty, and the resolved current Goal and active Turn are outputs that MUST NOT enter the input hash. Submission has exactly two results. A rejection returns the mapped typed error and creates no Item, pending row, command record of any status, Turn, or scheduler admission. A valid active-Goal submission derives `pendingTurnId` and `contentItemId` from the command scope and request, creates one completed `user-message` Item on `activeTurnId` with `parentItemId=null`, `causationId=requestId`, and `createdAt=completedAt=receivedAt`, and creates the matching `PendingUserTurnRecord` as one logical commit. For `inputKind=message`, all three Material fields are null and Item text is the exact `message`. For `inputKind=material`, all three Material fields equal the verified caller tuple and Item text is the exact `note` when supplied or `Use Workspace Material <materialId> revision <revisionId>.` otherwise. The pending row, not parsed Item text, owns Material selection. NanoCore then writes one completed send-command record whose response is `queued` and returns exactly `state=queued`, `pendingTurnId`, `requestId`, `contentItemId`, `goalId`, and `activeTurnId`; it MUST NOT embed a mutable Goal or Thread projection. Replay of that send command always returns the original `queued` acceptance response, while callers fetch the current Goal or Thread projection separately to observe later delivery state. If either the input Item or pending row is durable without its matching counterpart or exact Goal and Turn lineage, inspection and exact-request replay return `recovery_required`; they do not create the missing counterpart, accept a second command, or infer delivery.

Within this contract, `PendingUserTurnRecord.requestId` and the send response's `requestId` always mean the original `goal.steering.send` request. A later terminal command has a distinct caller-supplied request id, named `terminalRequestId` in durable proof; it never replaces or aliases the send request identity.

There may be at most one `PendingUserTurnRecord` for one `(workspaceId, threadId)`, including a terminally claimed row awaiting bounded cleanup; `goalId` preserves its original Goal lineage but is not part of the uniqueness key. Completed-receipt replay is checked first. A different send request while that row exists returns `409 conflict` with zero writes, even when a newer Goal is active; V1 does not coalesce, reorder, prioritize, or create a steering queue. After winner-owned cleanup deletes the row, a later request may create the next one. This Thread-level bounded serialization is the authority behind the singular `activeDelivery` read shape.

| Rejection condition | HTTP status and code |
| --- | --- |
| No non-terminal Turn exists for the active Goal, or its recorded Turn is missing or terminal | `409 stale` |
| A non-terminal Turn exists but is not the active Goal's checkpoint-backed worker Turn | `409 thread_busy` |
| The named Material or revision is absent, or the Material's current revision no longer equals the named revision | `409 stale` |
| The named revision exists in the authorized Workspace but is not owned by the named Material, or the caller's `contentDigest` differs from that revision's authoritative digest | `409 conflict` |
| The named Material has `sensitivity=restricted` | `409 sensitive_content` |
| The named durable revision has missing canonical content or its stored digest no longer verifies | `409 recovery_required` |
| Another unresolved or not-yet-cleaned pending steering row exists for the same Thread | `409 conflict` |
| The request id already owns different input or different Goal/Turn/Item lineage | `409 idempotency_key_conflict` |
| Exactly one of the request-owned Item or pending row exists, or their Goal/Turn lineage is missing or corrupt | `409 recovery_required` |
| The active worker adapter cannot persist and deliver the required immutable Context Package trace | `503 goal_steering_delivery_unavailable` |
| Authorization or workspace ownership fails | The existing authorization error without business records |

For Material input, authorization and Workspace ownership are checked before revision disclosure, so a cross-Workspace Material or revision returns `forbidden` rather than revealing whether it exists. Within the authorized Workspace, the table above is exhaustive: absence or loss of the addressed current revision is `stale`, inconsistent Material-to-revision ownership or a caller-digest mismatch is `conflict`, restricted sensitivity is `sensitive_content`, and corrupt durable revision authority is `recovery_required`. None may fall back to the latest revision or caller-supplied bytes.

| Delivery state | Durable authority and predicate |
| --- | --- |
| `queued` | The exact completed input Item and unique `PendingUserTurnRecord` both exist and no terminal proof or downstream effect record exists. The pending row preserves the original Goal, active Turn, request, Item, exact input kind and Material tuple when applicable, `queueMode=safe_point_steering`, and `receivedAt`; a claim with zero downstream effect records remains externally queued and only its identical claimant may resume or release it. |
| `applied` | The pending row was first claimed for `applied` by the exact Goal step and reserved Context Package identity, and the exact Item is preserved in that immutable Context Package trace of a specific accepted worker Turn under the same Goal. That trace is terminal delivery proof even if a crash leaves the original pending row temporarily present. |
| `follow-up` | The pending row was first claimed for `follow-up` by the conversion command, the deterministic `followUpTurnId` and `followUpItemId` name one completed Core-local Turn and copied user input Item with exact causation to the original Item, and the completed command record names both identities plus the original input kind and nullable exact Material tuple. The Turn, Item, and command record are terminal conversion proof even if the original pending row remains. This historical conversion does not execute the input or create a Task or Goal worker Turn. |
| `cancelled` | The pending row was first claimed for `cancelled` by the terminal command's `terminalRequestId`, and one completed cancel-command record names that exact claim, original send request and Item, input kind, and nullable exact Material tuple and exists without a new Turn or delivery proof. That record is terminal cancellation proof even if the pending row remains; the audit event is only a projection. |

`queued` is the only non-terminal delivery state and MUST transition exactly once to `applied`, `follow-up`, or `cancelled`. Before writing any terminal proof, the operation MUST compare-and-set the existing pending row from no terminal claim to its exact `terminalClaimKind` and immutable claim identity. A winning claim with zero downstream effect records remains queued and permits only identical-claim resume or deterministic compare-and-set release; a competing application, conversion, or cancellation returns `409 conflict` before effects. One complete deterministic follow-up Turn-and-Item pair matching the winning claim but missing only its terminal command record permits the identical terminal request to publish that one bounded record and continue cleanup; neither a different request nor boot recovery may invent it. One half of that pair, a mismatched pair, or any other partial or contradictory downstream Context Package, Turn, Item, or terminal-command-record effect returns `recovery_required` and retains the claim for inspection. Complete matching proof projects the terminal result and permits only winner-owned cleanup. This is a three-field fence on the existing pending owner, not a settlement lifecycle or second delivery state.

`terminalClaimId` has one source per kind and is never caller-selected independently: `applied` uses the deterministic `contextPackageId` reserved by the winning `goal.step`; `follow-up` uses the deterministic `followUpTurnId`; and `cancelled` uses the cancel command's immutable `terminalRequestId`. Identical replay MUST present the same kind and exact id, and restart validates terminal proof against that id before resuming or cleaning the claim.

Terminal proof has precedence over a residual pending row. Once exact application, follow-up, or cancellation proof matching the winning claim and original Item is durable, and the proof also preserves the exact pending-row Material tuple when `inputKind=material`, only that claimant may CAS-delete the exact row and publish its original command projection where applicable; it MUST NOT deliver the Item again, create another Turn or Item, cancel a different row, or select a newer Goal. A claim with no downstream effect remains queued under the rule above; once any downstream effect record exists, incomplete or contradictory proof returns `recovery_required`. Complete proof projects the terminal result only while the residual row remains available to the current-delivery projection; after bounded cleanup, immutable Items, Context Package traces, Turns, and terminal command records remain history but `activeDelivery` becomes null rather than selecting among historical proofs.

The generic direct-Turn adapter currently has no safe-point or later-delivery owner. When an implicit input arrives while its Thread has a non-terminal Turn, NanoCore MUST return typed `409 thread_busy` before recording any input state or command record. Repeating the request while busy returns the same unrecorded rejection; after the Turn becomes terminal, the same request id MUST be eligible for ordinary new-Turn admission because no earlier command was accepted.

Valid `Send now` input to an active Goal MAY be accepted as `queued` only when the Goal worker loop is a concrete later-delivery owner that can persist and deliver the required Context Package trace. Valid means that authorization, absence of another pending row, exact Material revision and digest when supplied, original Goal and active-Turn lineage, idempotency preconditions, and delivery capability all pass; each failure uses the exact mapping above. Before that capability exists, submission returns `503 goal_steering_delivery_unavailable` and creates no Item, pending row, command record, Turn, or scheduler admission. After that capability exists, the consuming Goal step first wins the exact `applied` claim with its reserved Turn and Context Package identity, then accepts the package containing the Item and, for `inputKind=material`, the exact pending-row Material tuple, and only then deletes the row. If the original active Turn becomes terminal while its Goal remains non-terminal, the row remains under that Goal and only the same Goal's next worker Turn may claim it. If the Goal becomes terminal first, automatic consumption stops and the Action Center exposes only convert-to-follow-up and cancel for that row.

The terminal commands are exactly `goal.steering.follow_up` and `goal.steering.cancel`. Each is scoped by authenticated actor, Workspace, Thread, `pendingTurnId`, and required terminal-command `requestId`, with no semantic request body; lookup precedes the current Goal or Turn projection. Durable proof names that caller value `terminalRequestId` and separately retains `sendRequestId` from the pending row. Both commands require the pending row's original Goal to be terminal; a nonterminal original Goal returns `409 conflict` before claiming because its next Goal step remains the only delivery owner. The winning operation captures one `acceptedAt` before its claim, and the completed terminal command record's `createdAt` equals that value. Each completed record carries one bounded immutable proof snapshot containing exactly `state`, `pendingTurnId`, `sendRequestId`, `terminalRequestId`, `contentItemId`, `goalId`, `activeTurnId`, `inputKind`, nullable `materialId`, `revisionId`, and `contentDigest`, nullable `followUpTurnId`, and nullable `followUpItemId`; the three Material fields are all null for message input and all exact for Material input, while both follow-up identities are non-null only for `follow-up`. The public follow-up response is exactly `{ state: "follow-up", pendingTurnId, requestId: terminalRequestId, sourceRequestId: sendRequestId, contentItemId, goalId, activeTurnId, followUpTurnId, followUpItemId }`, and the public cancel response is exactly `{ state: "cancelled", pendingTurnId, requestId: terminalRequestId, sourceRequestId: sendRequestId, contentItemId, goalId, activeTurnId }`. Neither exposes the recovery-only input kind or Material fields, so the proof snapshot does not become a second public Material read model. The matching send and terminal command records MUST NOT be pruned while their pending row exists; after winner-owned cleanup, normal command-retention policy applies and no terminal command record is a live delivery owner.

The follow-up command additionally requires an idle Thread, derives `followUpTurnId` and `followUpItemId` deterministically from the pending identity and `terminalRequestId`, and wins the `follow-up` claim. It then writes one Core-local Turn directly as `completed` with `humanGate=null`, `error=null`, `configVersion=null`, `startedAt=completedAt=acceptedAt`, and `durationMs=0`, plus one completed `user-message` Item whose text exactly copies the original input Item, whose `parentItemId` is the original `contentItemId`, whose `causationId` is `terminalRequestId`, and whose `createdAt=completedAt=acceptedAt`. It does not invoke or alias `turn.start` and creates no Coordinator decision, scheduler admission, Agent, Agent Session, provider call, AEP snapshot, worker request, materialization, or S39 Context Package trace. The completed proof record is written after that pair, then the row is deleted and the public response is published. This bounded conversion places the input in post-Goal Thread history but deliberately does not choose a work mode or execute it; subsequent work requires an explicit ordinary command. An active Thread returns `thread_busy` before claiming and leaves the row unchanged. Cancel wins the `cancelled` claim, writes its completed proof record without a Turn, then deletes the row. Identical replay returns or completes only the winning tuple, changed scope or reuse of either request identity with inconsistent lineage returns `idempotency_key_conflict`, a competing winning claim returns `conflict`, and missing or contradictory proof returns `recovery_required`. Neither command may retarget the row to a newer Goal.

An explicit input carrying `turnId` is a response to the exact active `user-input` gate, not generic steering. A missing or terminal Turn returns typed `stale`; an existing Turn without an active gate returns typed `not_awaiting_input`. Both fail without writing Item or queue state. An implicit input received when no Turn is active starts a new ordinary Turn.

After restart, queued state is reconstructed from the unique input Item and `PendingUserTurnRecord`, including its exact Material tuple when applicable; a terminal claim with zero downstream effect records remains externally queued and permits only identical-claim replay or deterministic pre-effect release, while any partial or contradictory effect returns `recovery_required`. Applied state is reconstructed only from the exact accepted Context Package trace matching the winning claim and the same Item and Material tuple; follow-up state is reconstructed only from the matching deterministic completed Core-local Turn, copied Item, and follow-up command record carrying the exact send and terminal request identities; cancellation is reconstructed only from the matching completed cancel-command record. Terminal proof wins over a residual row and permits only the bounded closeout above. The same send request id MUST replay its original `queued` acceptance under the original Workspace, Thread, Goal, and active Turn even when delivery advanced or a newer Goal or Turn is current.

Effective worker-input provenance is the immutable initial Context Package plus later accepted Context Package traces that contain the ordered active-turn Items.

### Worker output and writeback

A worker MUST operate against an immutable materialized input snapshot.

Worker changes MUST NOT mutate the authoritative Workspace Material directly.

A future worker-proposed edit must identify the base material revision and content digest and enter the one governed owner selected by the deferred decision below; this sentence is a boundary, not current implementation authorization.

Artifact Review decisions remain local to one exact Artifact version and MUST NOT be translated into a staged Workspace Review by identifier prefix, route fallback, or verdict mapping. `reviewId` is deterministic from Workspace, Artifact id, and Artifact version, and there is at most one `ArtifactReview` owner for that pair. Its exact fields are `workspaceId`, `reviewId`, `artifactId`, `artifactVersion`, `contentDigest`, nullable `sourceThreadId`, `sourceTurnId`, and `sourceAgentId`, nullable `decision`, `decisionActorId`, `decisionRequestId`, `feedback`, `decidedAt`, and `followUpTurnId`, plus `createdAt`. The owner snapshots the source fields when that version becomes reviewable; later Artifact versions create distinct immutable Review history and never overwrite the earlier owner. Every decision field is initially null, and first-writer compare-and-set accepts exactly `accepted`, `needs_refinement`, `redo`, `rejected`, or `deferred` with required request and actor identity. Same-request and same-input replay returns the same owner; changed input is `idempotency_key_conflict`; a competing decision is `stale`; a contradictory owner is `recovery_required`.

A turn-output Artifact version that becomes `ready` creates its unresolved `ArtifactReview` in the same acknowledged logical commit unless its Artifact is the presentation Artifact named by an existing durable Workspace Sync Review. Imported Artifacts create no Review owner and expose no refine or redo action; changing one starts ordinary new work. A decision request for a valid imported version returns `409 stale` because no review target exists, while an imported version with a durable Artifact Review or an eligible non-Workspace-Sync turn-output version missing its required Review is contradictory `recovery_required`. The Action Center projects a generic Artifact Review row only from an explicit unresolved owner whose exact Artifact version is still `ready`. A durable Workspace Sync Review's exact `artifactId` relation always excludes that entire immutable presentation Artifact from generic candidates, regardless of review state; if any Artifact Review owner exists for that Artifact, the projection is inspect-only `recovery_required` rather than two action rows. Identifier prefixes and Item absence are never authority.

`accepted`, `rejected`, and `deferred` complete the Review with `followUpTurnId=null`; feedback is optional but must be non-empty when supplied. Only `needs_refinement` and `redo` require explicit non-empty feedback, a turn-output origin, and an exact source Thread, Turn, and assigned Agent. Missing source lineage for such a claimed turn-output version is `409 recovery_required`; an imported Artifact is merely ineligible and never reaches that command. The follow-up Turn id and worker request id are deterministic from the Review decision request, preserve the reviewed version and prior attempt, carry the exact Artifact id, version, digest, canonical content, feedback, and decision through the existing Turn input, and reuse the source Agent.

Refinement or redo MAY create its follow-up only when the source Thread has no other non-terminal Turn. If another Turn is active at preflight, NanoCore returns `409 thread_busy` before claiming the decision or creating effects, and the same request may be retried after the Thread becomes idle. After preflight, the Review atomically records the exact first-writer decision and reserved `followUpTurnId` before Turn or scheduler effects. A claimed decision with no downstream effect may be resumed only by identical replay; any partial or contradictory Turn or admission returns `recovery_required`. Complete matching Turn input and worker admission are terminal proof and permit the original response only after the command receipt is durable. Retry validates and reuses the reserved identities; it never creates another Turn, defaults feedback, changes Agent, or adds a Review lifecycle or queue field. A crash after complete follow-up proof but before its cross-store receipt returns `recovery_required` rather than synthesizing that receipt.

Workspace Material worker proposal and writeback remain a deferred part of Plane 1. The current repository/filesystem Workspace Change Set, staged Workspace Review, Apply Plan, and Apply Result require backend materialization, repository or filesystem strategy, paths, and external-effect verification; they are not authorized as aliases for an app-local Markdown Material revision. Until G05/C09 and this specification select one exact proposal, decision, apply, and recovery owner, production MUST stop after Material identity, immutable revision, binding, queue, read, and shared Context Package delivery. It MUST NOT create a Material proposal route, translate Artifact Review decisions, force Material into Workspace Sync records, or add a fourth generic review/apply framework.

The deferred writeback contract must preserve these decision-grade boundaries: worker output is an immutable proposal against one exact base Material revision and digest; it never mutates Material authority directly; user edits remain authoritative; accepted apply uses an expected-base compare-and-set and the same immutable revision commit predicate as direct save; a newer user revision is never overwritten; review acceptance alone is not apply success; indeterminate effects cannot be blindly retried; and every prior attempt remains visible. These constraints are a non-authorizing checklist until the owner decision above is accepted.

### User authority

Direct user edits are authoritative workspace input.

Worker edits are proposals until the governed apply path accepts them.

The system MUST preserve both the user revision and worker proposal when they diverge.

Redo and refinement MUST NOT delete earlier attempts or provenance.

### Recovery

After NanoCore restart, the authorized slice MUST recover the current material revision, immutable revision history, Thread binding, queued revision, exclusion decision, Context Package provenance, pending active-turn delivery, and Artifact refinement or redo claim.

Recovery MUST NOT infer worker visibility from the current material revision. It MUST use accepted Context Package traces that name the exact initial or active-turn Items.

A known durable revision whose canonical content is missing or whose digest no longer verifies MUST return `recovery_required`. Source bytes or a materialization dependency that is temporarily unavailable before Turn acceptance MUST return retryable `source_unavailable`. A stored accepted materialization whose files or digest no longer verify MUST return `recovery_required`. None may substitute the current revision.

Every mutating command MUST use one stable request id, deterministic resource identity, and expected-base precondition where state can advance concurrently. A create command MUST reserve its resource id from immutable scope plus request id before effects. `WorkspaceMaterialRevision.createdByRequestId` owns revision-create proof; Artifact and `artifact-reference` Item `lastMutationRequestId` own current version and communication proof; `WorkspaceMaterial` and `ThreadMaterialBinding.lastMutationRequestId` own their current mutable state; and existing pending, review, and command records retain their named request fields. These fields support recovery but do not replace the command ledger. Idempotency lookup scope contains only immutable identifiers supplied by the request path or reserved before execution. If the request does not name a Goal or Turn, lookup MUST use the addressed Workspace and Thread and the accepted result MUST persist the resolved Goal and Turn; replay MUST NOT resolve a newer current projection before consulting the ledger.

The command ledger is written only after the owning business mutation reaches its documented success predicate. Before executing effects, NanoCore uses one stateless lookup precedence rather than a recovery workflow: replay a completed matching command record; otherwise validate and reconstruct a complete deterministic business result only when its named owner carries the same request and immutable input or expected-base lineage; otherwise resume only the exact operation-specific pending owner named below. Artifact import, Artifact introduction, work-produced Artifact mutation, and Artifact refinement or redo are the explicit exceptions: a complete cross-store authority tuple without its Workspace command receipt is the half-state above and returns `recovery_required` without receipt reconstruction. Material commands and Artifact Review decisions with no downstream effect need no live-operation exception because their owner and receipt share one Workspace transaction. Portable Workspace import is a separate complete owner: S51 rewrites Material and Artifact Review request proof to reserved `import-lineage:` tokens, imports no source command receipts, and forbids those tokens from command lookup or receipt reconstruction, so the accepted imported graph is not a half-state and pre-export command replay is intentionally unavailable. Task and Goal terminal-checkpoint receipt reconstruction remains owned only by S05, S12, and S13. Reuse of a request id with different immutable input or lineage returns `idempotency_key_conflict`; an expected-base or current-state mismatch returns `conflict`; and an advanced mutable result with neither ledger nor retained request proof returns `recovery_required`. This lookup creates no recovery record or lifecycle.

A mutation spanning records or storage scopes MUST publish its success record only after every owning write is durable. Partial failure has one owner per operation:

| Operation | Permitted recovery state |
| --- | --- |
| Artifact creation or version plus required reference | No pending state. A handled failure exposes the prior complete pair or neither new record; a crash half-state fails closed under the storage contract. |
| Workspace-only Artifact introduction | Idle-Thread admission acknowledges only after the deterministic completed Turn, exact `artifact-reference` Item, and receipt are durable. An active Thread is an unrecorded `thread_busy` rejection. A complete authority tuple without its receipt or any partial or contradictory tuple returns `recovery_required`, and exact-request replay MUST NOT synthesize the receipt or create another Turn or Item. |
| Material create, save, or binding transition | No pending state or cross-store half-state. The Material owners and command receipt commit or roll back in the same Workspace transaction. |
| Goal Steering Input | Before a claim, the complete input Item plus Thread-unique `PendingUserTurnRecord` pair remains under the original Goal and Turn; either half without the other returns `recovery_required` and exact replay does not repair it. A claim with zero downstream effects permits only identical replay or deterministic pre-effect release; any partial or contradictory effect returns `recovery_required`. After the matching Context Package trace, or the deterministic completed Core-local follow-up Turn plus copied Item and exact terminal-command record, or the exact cancel-command record is durable, that proof takes precedence over a residual row and authorizes only winner-owned CAS deletion. Every terminal proof preserves the original Item, distinct send and terminal request identities, and exact pending-row Material tuple when applicable. No delivery, Turn, cancellation, or settlement state is duplicated. |
| Artifact refinement or redo | The exact version-owned Artifact Review decision and reserved `followUpTurnId` own exact-request retry until the matching Turn input and worker admission are durable; no separate lifecycle field is added. |

Restart MUST never choose the newest-looking projection, duplicate a side effect, or create a reconciliation, settlement, provenance, or receipt workflow outside these owners. Existing Workspace Reconciliation records remain limited to their workspace backend recovery scope. Cross-file atomic publication remains the storage specification's responsibility, not authorization for an S16 recovery framework.

### Web projection

The OpenKit Web UI MUST be sufficient to complete the Plane 1 flow without another desktop agent application.

The Web UI MUST use public Core Client operations and MUST NOT access worker files, Core-private paths, or external runtime state directly.

The material surface MUST support Markdown or text viewing and editing, stable save status, revision history and comparison, Thread binding, queued-inclusion status, exclusion, and `Send now`. Material worker-change review remains outside the authorized slice until the writeback owner decision below; grounded annotation, text-range patching, and locator controls remain deferred and MUST NOT be implied by this requirement.

The conversation surface MUST show item-backed explanations of material inclusion, active-turn delivery, worker results, conflicts, and review outcomes.

The Action Center MAY project only the exact Artifact Review owner described above. A rejected Material expected-base command creates no durable conflict owner or Action Center row, and projection MUST NOT create a Material writeback or conflict lifecycle.

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
| `artifact_origin_recorded` | The Artifact's immutable origin exists and its Thread and Turn fields obey the origin-kind rule; imported version 1 verified `sourceDigest` at acceptance, while the current version independently verifies top-level `contentDigest`. |
| `artifact_version_committed` | The Artifact version, digest, `lastMutationRequestId`, and required exact reference Item state are durable and mutually valid; neither half is independently visible. |
| `artifact_introduced` | An accepted Thread input Turn contains an `artifact-reference` Item for the exact workspace-only Artifact version and communication request, while the Artifact origin remains unchanged. |
| `revision_saved` | The immutable revision exists and verifies, `WorkspaceMaterial.currentRevisionId` and `lastMutationRequestId` identify it and its command through expected-base compare-and-set, and every bound binding queue coalesced under that request in the same acknowledged logical commit. |
| `revision_queued` | A bound `ThreadMaterialBinding.latestQueuedRevisionId` equals the revision and inclusion state is `included`. |
| `revision_selected` | The accepted Turn's Context Package trace names the exact material, revision, parent, digest, inclusion reason, package path, and sensitivity decision. |
| `revision_materialized` | The accepted Turn's matching Workspace Input Snapshot and ready Workspace Materialization Record preserve the selected revision and digest. |
| `worker_available` | An accepted worker Turn references the selected Context Package and the materialization handoff completed; this does not claim that the model read or understood the content. |
| `active_input_queued` | The completed send-command record, input Item, and matching `PendingUserTurnRecord` identify one original Goal and active Turn, and no exact application, follow-up, or cancellation proof exists. |
| `active_input_applied` | The exact `applied` claim and Item have durable Context Package provenance for the claimed accepted worker Turn under the same Goal. A residual pending row means only bounded CAS cleanup remains and cannot change or suppress this result. |
| `active_input_follow_up` | The exact `follow-up` claim, deterministic completed Core-local Turn, copied Item, and terminal command record agree on the original active-turn Item, `sendRequestId`, `terminalRequestId`, and nullable Material tuple. A residual pending row means only bounded CAS cleanup remains and cannot change or suppress this result. |
| `active_input_cancelled` | The exact `cancelled` claim and completed cancel-command record are durable and no delivery or follow-up proof exists. A residual pending row means only bounded CAS cleanup remains and cannot change or suppress this result. |
| `idempotency_key_conflict` | A request id already owns different immutable input or resource lineage; no mutation or side effect is committed. |
| `conflict` | An existing authority disagrees with the expected version or base, active-Turn ownership, or binding transition independently of request-id reuse; no conflicting mutation or side effect is committed. |
| `stale` | The requested historical revision, gate, or target Turn is absent, terminal, expired, or otherwise no longer addressable; the system does not retarget or substitute by inference. |

### Invariants

- Conversation MUST remain usable without a material surface, and a bound material surface MUST remain traceable to its Thread.
- Grounded interaction remains deferred until a separate accepted specification defines one exact owner and command; this slice MUST NOT create a hidden feedback or locator log.
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

Failure mapping is exact. Missing or malformed required request fields are `invalid_request`; submitted bytes that disagree with their digest are `source_digest_mismatch`; a temporarily unavailable pre-acceptance source or materializer is `source_unavailable`; and missing or invalid content in already durable authority, including a reviewed Artifact's recorded source Turn or assigned Agent, is `recovery_required`. An absent or terminal requested target, historical revision, or gate is `stale`; an existing Turn without an active input gate is `not_awaiting_input`; request-id reuse with different immutable input or lineage is `idempotency_key_conflict`; an expected-version, expected-base, binding-state, or active-ownership mismatch is `conflict`; and attempted worker delivery of a restricted Material is `sensitive_content`. Unauthorized access is `forbidden`, and `thread_busy` is reserved for a valid request prevented only by another non-terminal Turn.

`thread_busy` applies only when an otherwise valid request is prevented by another non-terminal Turn. A missing or terminal target returns `stale`, unavailable Goal delivery returns `goal_steering_delivery_unavailable`, a corrupt durable owner pair returns `recovery_required`, and expected-state or idempotency failures retain their exact codes above; none are collapsed into `thread_busy`.

The system MUST NOT substitute the latest revision for a requested historical revision.

The system MUST NOT mark a revision worker-visible unless an accepted worker Turn's exact Context Package proves availability.

A dependency outage or half-state MUST follow the operation-specific recovery table above. Artifact/provenance half-states fail closed under the storage contract; Material revision, pointer, binding, queue, and receipt writes share one Workspace transaction; Goal input remains in its existing pending row; and refinement or redo remains in its unresolved version-owned Artifact Review. No implementation may choose a different owner or fabricate the missing half.

### Audit and privacy

Successful Material creation, revision save, Thread binding, unbinding, queued-inclusion exclusion, active-turn send, worker availability, and Artifact Review decisions SHOULD be auditable at the appropriate product level. A rejected expected-base request may emit a redacted request-failure audit event only under the general audit contract; it does not become Material conflict authority.

Audit and Item projections MUST avoid secret values, Core-private paths, external credentials, and unnecessary sensitive-content duplication.

Workspace boundaries MUST be preserved in material identity, revision lookup, Thread binding, Context Package selection, review, and worker materialization.

## Phase 1 Public Design

### Public Material read models

The closed public `ArtifactReviewView` contains exactly `workspaceId`, `reviewId`, `artifactId`, `artifactVersion`, `contentDigest`, nullable `sourceThreadId`, `sourceTurnId`, and `sourceAgentId`, nullable `decision`, `decisionActorId`, `feedback`, `decidedAt`, and `followUpTurnId`, plus `createdAt`. The owner-only `decisionRequestId` is excluded from every public response, and an imported `import-lineage:` token is never exposed or accepted as command identity. Artifact Review list returns these views in ascending `artifactVersion` order; decision responses remain the bounded success identity in the App API contract rather than returning the owner row.

Public Material reads use three closed shapes. `WorkspaceMaterialView` contains exactly `workspaceId`, `materialId`, `title`, `kind`, nullable `currentRevisionId`, `sensitivity`, `createdAt`, and `updatedAt`. `WorkspaceMaterialRevisionSummary` contains exactly `workspaceId`, `materialId`, `revisionId`, nullable `parentRevisionId`, `mediaType`, `contentDigest`, `authorId`, and `createdAt`; `WorkspaceMaterialRevisionView` adds only the exact canonical `content`. Internal request-proof fields such as `lastMutationRequestId` and `createdByRequestId` remain owner and recovery data and are not public response fields.

The Material list returns ordered `WorkspaceMaterialView` records, Material get returns one such record, revision list returns ordered `WorkspaceMaterialRevisionSummary` records, and exact revision get returns one `WorkspaceMaterialRevisionView`. A client compares revisions by reading the two exact immutable revisions; no comparison result becomes authority.

The Thread material response is exactly `{ material: null }` when no Material is currently bound. Otherwise `material` contains exactly `workspaceId`, `threadId`, one `WorkspaceMaterialView` as `resource`, nullable `WorkspaceMaterialRevisionSummary` as `currentRevision`, `inclusionState`, nullable `latestQueuedRevisionId`, nullable `lastWorkerSeenRevisionId`, nullable `currentTurnRevisionId`, and nullable `activeDelivery`. `inclusionState` is `included` or `excluded`. `activeDelivery` is derived only from the Thread's single unresolved or not-yet-cleaned `PendingUserTurnRecord`; it is null when that row is absent, has `inputKind=message`, or names another Material. When present, it contains exactly `state`, `pendingTurnId`, `requestId`, `contentItemId`, `goalId`, `activeTurnId`, `materialId`, `revisionId`, and `contentDigest`, where `requestId` is the row's original send request, the Material fields equal the pending row, and state is `queued`, `applied`, `follow-up`, or `cancelled` under terminal-proof precedence. Cleanup makes it null, so the read model never ranks historical proofs by timestamp or identifier. Expected-base rejection is only the typed mutation response and is not retained in this read model. Clients may choose presentation actions from this projection, but command validation remains authoritative and no action list becomes another lifecycle owner.

A public read whose non-null revision, binding, Context Package, or delivery identity does not resolve to the matching Workspace owner returns `recovery_required`; it MUST NOT silently null the field, substitute the latest revision, or expose a partial projection.

This projection is a read model. Material revision, binding, Context Package, Item, and review records remain authoritative.

Until S39 persists an accepted Turn-owned immutable Context Package trace, `lastWorkerSeenRevisionId` MUST be null. NanoCore MUST NOT infer it from a checkpoint digest, AEP, latest Material revision, Workspace Input Snapshot, Workspace Materialization Record, or worker-local receipt.

### Command surface

The Phase 1 mutation names and canonical caller inputs are closed:

| Command | Immutable scope | Canonical caller input |
| --- | --- | --- |
| `artifact.import` | actor, Workspace, `requestId` | `{ title, mediaType, contentDigest, content }`; Artifact id and `sourceId=requestId` are outputs |
| `artifact.introduce` | actor, Workspace, Thread, `requestId` | `{ artifactId, expectedArtifactVersion }` under the idle-Thread contract above |
| `artifact.review.decide` | actor, Workspace, Artifact, Artifact version, `requestId` | exactly `{ decision, feedback? }` for `accepted`, `rejected`, or `deferred`, and exactly `{ decision, feedback }` for `needs_refinement` or `redo`; supplied feedback is non-empty |
| `material.create` | actor, Workspace, `requestId` | `{ title, kind, sensitivity }`, where kind is exactly `markdown` or `text`; Material id is an output |
| `material.save` | actor, Workspace, Material, `requestId` | `{ expectedRevisionId, contentDigest, content }`; media type is derived from immutable Material kind, and revision id is an output |
| `material.bind` | actor, Workspace, Thread, Material, `requestId` | `{ expectedBindingState }`, where the value is exactly `absent` or `unbound` |
| `material.unbind` | actor, Workspace, Thread, Material, `requestId` | `{ expectedBindingState: "bound" }` |
| `material.exclude` | actor, Workspace, Thread, Material, `requestId` | `{ expectedBindingState: "bound", expectedInclusionState: "included", expectedQueuedRevisionId }` |
| `material.restore` | actor, Workspace, Thread, Material, `requestId` | `{ expectedBindingState: "bound", expectedInclusionState: "excluded" }` |

Canonical input hashing uses the verified digest rather than duplicating submitted bytes in the ledger. Every command applies the owner, transition, expected-base, success, replay, and recovery predicates defined above. `goal.steering.send`, its terminal commands, and Artifact Review retain their already-named owners; S16 creates no alias or Material review/apply lifecycle.

Caller `requestId` values for every Material and Artifact Review command MUST NOT begin with the reserved `import-lineage:` prefix; such input is `400 invalid_request` before owner or receipt lookup. Only S51 import may write those historical lineage tokens, and no public response exposes them.

Artifact import and Material save use strict JSON requests with one UTF-8 `content` string; Phase 1 adds no upload service, multipart body, blob protocol, transient upload handle, or caller-selected Material media type. Artifact import accepts exactly `text/markdown`, `text/plain`, or `application/json`; `application/json` content MUST be syntactically valid JSON but remains stored as the exact submitted string, and invalid syntax is `400 invalid_request` with no writes. Material save derives `text/markdown` or `text/plain` from the immutable Material kind. The digest is computed over the exact UTF-8 bytes of `content`, without newline, Unicode, or JSON normalization. The command ledger stores the verified digest rather than the content bytes.

Typed reads cover Artifact and Material lookup, exact revision list and content retrieval, client-side comparison of immutable revisions, Thread material projection, active delivery status, and Artifact Review projection. Reads do not mutate authority or enter the command ledger.

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
- Revision persistence, context assembly, materialization, Artifact Review, and Web projection must align.
- Exact worker availability requires an accepted Turn, its Context Package, and verified materialization provenance for initial and active-turn input.

## Testing Strategy / Acceptance Criteria

### L1 schema and unit coverage

- Material ids, revision ids, parent linkage, digests, media types, sensitivity, and expected-base validation are deterministic.
- A saved revision is immutable.
- Multiple saves coalesce queued handoff to the latest stable revision without deleting history.
- An unrelated or unbound material is never selected.
- A duplicate request id does not create a duplicate revision, binding, or review decision.
- Artifact import creates the exact immutable imported origin and rejects missing request fields or digest mismatch. An Artifact version commit or Thread introduction returns `conflict` for an expected-version mismatch, and every failed mutation leaves the Artifact plus required provenance or reference at the prior complete state or absent.
- Generic direct-Turn input produces `thread_busy` with no Item, pending row, admission, or accepted command while another Turn is active, and the same request may start normally after terminal state.
- Goal steering replay remains bound to the original Goal and Turn after they become terminal or a newer Goal appears.
- Artifact refinement or redo does not record an accepted decision or create a follow-up while another Turn is active, and exact-request retry creates only one follow-up after the Thread becomes idle.

### L2 contract and conformance coverage

- Public API, Core Client, Context Package, Item references, and Web read models agree on material and revision identity.
- A Thread binding is explicit, workspace-scoped, and cannot reference another workspace.
- The initial Context Package plus later accepted Context Package traces containing active-turn Items reconstruct effective worker input.
- A work-produced Artifact creation or update communicated in a Thread has an exact `artifact-reference` Item for the communicated Artifact version in that Thread and Turn, while the Artifact record has no `itemId`.
- A workspace-only Artifact import preserves explicit provenance, and introducing it into a Thread creates an exact `artifact-reference` Item.
- Every public read model derives `revision_saved`, queued, selected, materialized, worker-available, active-input, and Artifact Review outcomes from the authority table and observable predicates rather than independent status fields; expected-base conflict and stale remain typed command responses and are not retained as read-model state.

### L3 NanoCore black-box coverage

- A bound revision is frozen into the next turn without a separate message about the edit.
- A revision saved after turn acceptance remains queued and does not mutate running worker input.
- Excluding a queued revision prevents inclusion.
- `Send now` distinguishes unrecorded rejection from initial queued acceptance, keeps send-command replay queued, and reports queued, applied, follow-up, or cancelled current status truthfully.
- Restart preserves bindings, queues, exact worker-seen revisions, pending deliveries, and Artifact Review state.
- Restart and duplicate-request tests cover command-ledger loss with a complete deterministic result, retained pending ownership, Goal or Turn lifecycle change, and handled partial persistence failure without duplicate side effects.
- Missing content, digest mismatch, expected-base conflict, and cross-workspace references fail closed.

### L4 Web browser coverage

- The user can edit and save a material, bind it to a Thread, see queued state, exclude it, or send it now.
- The user can compare immutable revisions without that comparison authorizing a grounded-feedback command.
- The user can inspect Artifact Review history and initiate refinement or redo without deleting the reviewed version or prior attempt.
- The UI never claims that a worker saw a revision without server provenance.
- The complete Phase 1 flow works without opening a desktop worker application.

### L5 integrity coverage

- Every material revision referenced by a Context Package can be resolved and digest-verified.
- Invalid parent chains, missing canonical content, and unresolved pending handoffs are reported.
- Restart recovery preserves material identity, revision history, bindings, and worker-input provenance.
- Artifact/provenance, Artifact/reference including workspace-only introduction, revision/current-pointer, binding/queue, queue/Context Package, and Artifact Review fault injection proves that acknowledged state is complete and unacknowledged half-state is rolled back or fails closed.

### L6 story acceptance

The canonical story MUST prove the following sequence.

1. A user creates a Thread and binds a Markdown material at revision 1.
2. A worker turn receives revision 1, and its Context Package records revision 1 and its digest.
3. The user saves revision 2 without sending a separate chat message.
4. The product shows revision 2 queued and identifies revision 1 as the last worker-seen revision.
5. The next turn receives the exact revision 2 bytes and its trace proves the selected Material, revision, and digest.
6. Restarting NanoCore preserves every revision, binding, queue decision, and worker-availability proof without substituting a newer revision.

Additional acceptance MUST cover unrelated-material exclusion, explicit queued-revision exclusion, active-turn delivery, workspace isolation, and redo without deletion of prior attempts.

## Stop Rules

If users cannot predict or trust automatic next-turn inclusion despite explicit binding and visible queue state, Phase 1 MUST shrink to an explicit `Publish to Thread` action rather than add heuristics.

For the current slice, Goal steering MUST return `goal_steering_delivery_unavailable` before accepting input because the real worker path cannot yet persist the required Context Package trace, while the direct-Turn adapter MUST return typed busy before accepting implicit input during another Turn. Neither path may mutate the live worker filesystem or create a substitute receipt, settlement, or recovery workflow.

Material worker proposal or writeback MUST NOT enter implementation, public operations, Web acceptance, or runtime recovery until G05/C09 and this specification select one exact proposal, decision, apply, and recovery owner. The selection MUST reuse or narrow an existing authority and MUST NOT create another generic review/apply framework.

If future asset types fail to share meaningful contracts, OpenKit MUST NOT build a universal Plane 2 protocol.

If a future external integration requires OpenKit to mirror a domain system, the design MUST be re-reviewed before implementation.

## Open Questions

There are no blocking open questions for the authorized Material authority-and-delivery slice. The Material worker-writeback owner remains deliberately unresolved and non-authorizing until the G05/C09 group decision is accepted in this specification.

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
