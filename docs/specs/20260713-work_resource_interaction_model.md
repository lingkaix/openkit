# Work Resource Interaction Model

Status: Accepted
Implementation: Partial
Change Plan: `docs/changes/202607132212000001-work_resource_interaction_model.md`

## Owns

This spec owns the implementation-facing interaction model that lets users express precise intent against work resources without requiring every interaction to be plain text.

It owns the three work-resource planes as a classification boundary, the distinction between a resource plane and the `Artifact` product role, the deferred boundary for future grounded interaction, the relationship between conversation and a material surface, and the current implementation boundary.

It owns the authorized Phase 1 contract for one Thread-bound workspace-native Markdown or plain-text material through material identity, immutable revisions, explicit Thread binding, queued next-turn inclusion, exact worker-visible revision capture, active-turn delivery, worker proposal review and conflict-safe apply, recovery, Web projection, and acceptance criteria. The G05/C09 review selected the existing version-keyed `ArtifactReview` as the single proposal decision and apply owner; this specification authorizes no parallel review, apply, or recovery engine.

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

The first and only authorized vertical slice is one Thread-bound Markdown or plain-text material with immutable revisions, explicit binding, exact worker-input provenance, and worker proposals governed by the existing version-keyed `ArtifactReview`. Accepted apply is one app-local Workspace transaction over that Review and the existing Material owners; Workspace Sync is not an alias for this path.

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

NanoCore now stores exact current-content digest, mutation-request proof, and immutable turn-output or imported origin on every Artifact. Direct workspace-only import and idle-Thread `artifact.introduce` are available through the public App API and Core Client. Introduction creates one deterministic completed Core-local Turn and exact `artifact-reference` Item while preserving the imported Artifact's null top-level Thread and Turn. Generic metadata `PATCH`, `artifact.register`, and Artifact deletion are absent.

NanoCore now owns exactly `workspace_materials`, `workspace_material_revisions`, and `thread_material_bindings`, with immutable linear revisions, singular Thread binding, queue coalescing, six mutations, five reads, and command receipts. Each Material mutation and its receipt commit in one Workspace SQLite transaction. Artifact-family authority and the Workspace receipt remain separate effect domains: a request-owned Artifact authority footprint without its receipt returns `recovery_required` on exact retry without receipt reconstruction, effect repetition, settlement, or automatic repair.

Real Task and Goal worker launches now persist and verify the immutable S39 Context Package trace, exact generated `context` handoff, selected Material revision and digest, queue mutation proof, and accepted backend materialization before launch. `lastWorkerSeenRevisionId` and `currentTurnRevisionId` are derived only from those verified traces. Goal steering now uses the Thread-unique `PendingUserTurnRecord`, original Item, applied Context Package proof, immutable `SteeringTerminalOutcome`, and body-free command receipts for queued, applied, follow-up, cancellation, cleanup, restart, and exact replay; no live worker filesystem mutation or second delivery lifecycle exists. Worker transcript import now creates the exact canonical turn-output Artifact, reference Item, and version-owned Artifact Review, verifies an explicit Material proposal against the same accepted S39 trace, and applies an accepted current-base proposal with the Review, new immutable revision, current pointer, bound queues, and receipt in one Workspace SQLite transaction. S51 exports and remints the complete Material, Revision, Binding, Review, and Context Package graph; its bounded imported-history verifier may contribute only historical `lastWorkerSeenRevisionId`. Web projection and complete Phase 1 acceptance remain unimplemented, and checkpoint diagnostics MUST NOT substitute for delivery proof.

The first slice MUST support one workspace-native Markdown or plain-text material explicitly bound to one Thread working set.

The authorized Phase 1 slice is complete only when the user can create or open the material, bind it to a Thread, save a stable revision without sending a separate chat message, see that revision queued for the next worker turn, prove which revision the worker received, review an exact worker proposal against that revision, apply it without overwriting a newer user revision, and recover the same state after restart.

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
| `imported` | `sourceKind`, `sourceId`, `sourceDigest`, `actor`, `requestId`, `recordedAt` | `actor` is the authenticated importer's exact durable `ActorRef`; the Artifact's top-level `threadId` and `turnId` MUST remain null before and after later communication. |

`imported` means that canonical content entered through a governed direct-import request and therefore requires `sourceKind=direct-import` with `sourceId` equal to that accepted request id. These fields are self-contained provenance owned by the Artifact origin; they are not a foreign authority and do not authorize a new provenance record. They MUST NOT contain a raw host path, credential, transient upload handle, or inferred source. `sourceDigest` verifies the canonical source bytes accepted as Artifact version 1 and remains immutable; top-level `contentDigest` verifies the current Artifact version. Every S16 content digest is `sha256:` plus 64 lowercase hexadecimal digits over the exact canonical UTF-8 content bytes, without newline or Unicode normalization. Audit events and UI labels are projections. A new origin or source kind requires a demonstrated source with one uniquely resolvable canonical byte payload and a specification update. Workspace Input Snapshot and Evidence Bundle records do not currently own such a payload, so `artifact.register` and a `registered` origin are not authorized in Phase 1.

`artifact.import` has one exact success shape. Its Artifact id is deterministic from actor, Workspace, command, and request identity; `workspaceId` is the addressed Workspace; `threadId` and `turnId` are null; `kind=file`; `status=ready`; `summary=null`; `version=1`; `title` is the caller title; `content.body` is the exact submitted string; `lastMutationRequestId=origin.requestId=origin.sourceId=requestId`; `origin.kind=imported`; `origin.sourceKind=direct-import`; `origin.actor` is the authenticated actor's exact `ActorRef`; `origin.sourceDigest` equals the top-level `contentDigest`; and `origin.recordedAt=createdAt=updatedAt` is the accepted command time. Media type maps exactly as `text/markdown -> content.format=markdown`, `text/plain -> content.format=text`, and `application/json -> content.format=json`; every other media type is `400 invalid_request`. Import creates no Thread, Item, Turn, Agent, or Artifact Review owner.

Every work-produced Artifact creation or content, title, or summary update communicated in a Thread MUST increment `version` exactly once and commit the matching current `contentDigest`. A lifecycle-status-only change MUST NOT change `version`. Every mutation MUST carry the expected current version and set Artifact `lastMutationRequestId` to that request.

Each communicating Turn owns exactly one `artifact-reference` Item for one Artifact. Its identity is stable for `(artifactId, communicatingTurnId)`, and its `lastMutationRequestId` owns the request proof for the currently communicated version. The Item MUST advance that field in place when the same Turn commits the Artifact's next version; communication by a later Turn creates a different Item with that communication request id, even when it communicates the same Artifact version. An Item MUST NOT move between Turns, change Artifact identity, or be rewritten by a projection. This preserves one unambiguous Item owner while allowing the same version to be communicated in different Turns or Threads.

A work-produced Artifact version and the producing or mutating Turn's required `artifact-reference` Item state form one acknowledged logical commit. NanoCore MUST acknowledge the mutation only after both sides are durable and mutually valid. A handled validation or persistence failure MUST leave both sides at the previous complete version or leave neither newly created record visible. After restart, storage MUST expose either the old complete commit or the new complete commit; a detected half-state MUST fail closed and MUST NOT be repaired by inference, compatibility parsing, or a second settlement workflow. The physical commit and crash-consistency mechanism remains owned by `docs/specs/20260703-storage_layout_record_ownership.md`.

A workspace-only Artifact import MAY exist before Thread introduction only with its immutable `imported` origin. Introduction uses the exact `artifact.introduce` command scoped by authenticated actor, Workspace, Thread, and required `requestId`; its canonical caller input is exactly `{ artifactId, expectedArtifactVersion }`. One deterministic idle-Thread admission rechecks that the Thread has no non-terminal Turn, reserves the deterministic Turn and `artifact-reference` Item identities, writes that Core-local Turn directly as `completed`, writes the completed reference Item for the exact Artifact version, and then publishes the command receipt under the Artifact-family compromise below. The Turn has no Agent, Agent Session, provider call, worker, scheduler admission, checkpoint, or runtime effect. Leaving the Artifact's immutable origin and top-level null Thread and Turn unchanged is part of the same acknowledged success predicate.

Any active Turn, including a Goal Turn or user-input gate, returns `409 thread_busy` before an Item, Turn, pending row, or command record; this bounded compromise requires the caller to wait for an idle Thread instead of extending Goal steering or gate payloads. Because the rejection is unrecorded, the same request id and input may be retried after the Thread becomes idle. Exact replay of an accepted command returns exactly `{ artifactId, artifactVersion, turnId, itemId }`, whose Turn is the original deterministic completed Turn and whose Item is its exact `artifact-reference`; it does not return copied Turn or Item bodies. Changed input returns `idempotency_key_conflict`, an expected-version mismatch returns `conflict`, and any partial or contradictory accepted tuple returns `recovery_required` without creating another Turn or Item. Concurrent admission succeeds for only one competing Turn transaction; the loser reevaluates the busy predicate and cannot double-record introduction.

Introduction does not rewrite origin or the Artifact's null top-level `threadId` and `turnId`. Replaying the same accepted request MUST return the same Item, Turn, and delivery outcome. A missing or malformed origin in a create request returns `invalid_request`; submitted source bytes that do not match `sourceDigest` return `source_digest_mismatch`; an already durable Artifact missing valid origin or digest proof returns `recovery_required`; and an expected Artifact version mismatch returns `conflict`. All fail before creating an Item, Turn, or pending row. A materialized Artifact index or read model MUST NOT invent, infer, or replace origin or Item lineage.

Artifact and Item file authority, and a refinement or redo follow-up Turn plus worker admission, cannot share one physical transaction with the existing Workspace command ledger. Phase 1 accepts one bounded fail-closed compromise for those Artifact-family commands: persist the complete operation-specific Artifact, reference, introduction, or follow-up authority tuple first, publish its command receipt immediately afterward, and acknowledge only after both succeed. An `accepted`, `rejected`, or `deferred` decision for a non-Material Artifact, and a `rejected` or `deferred` Material proposal decision, have no downstream effect and therefore commit the version-owned Review decision and receipt together in `workspace.sqlite`; accepted Material proposal apply uses the same database transaction for the Review, Material revision graph, bindings, and receipt. A handled authority-write or receipt-write failure rolls back to the prior complete tuple where the existing owner can do so. After restart, a complete request-owned cross-store tuple without its receipt returns `recovery_required` on exact retry; NanoCore does not infer the winner, synthesize the receipt, repeat the side effect, or add a settlement workflow. Artifact `origin.requestId`, top-level and reference `lastMutationRequestId`, the deterministic introduction identities, and Artifact Review `decisionRequestId` provide the operation-specific request proof for detecting a gap.

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

Phase 1 Material authority requires exactly three new app-local Material record families and MUST NOT introduce a universal resource hierarchy. Active steering separately adds the two bounded owner families `PendingUserTurnRecord` and `SteeringTerminalOutcome`, while Artifact refinement tightens the existing `ArtifactReview` into the version-keyed owner defined below; none is a fourth Material record. The same table names all existing and bounded non-Material owners that interact with the three Material families so migration and scope accounting remain explicit.

| Product truth | Unique authority | Required state |
| --- | --- | --- |
| Material identity and current saved state | `WorkspaceMaterial` | `workspaceId`, `materialId`, `title`, `kind`, nullable `currentRevisionId`, `sensitivity`, `lastMutationRequestId`, `createdAt`, and `updatedAt` |
| Immutable saved content | `WorkspaceMaterialRevision` | `workspaceId`, `materialId`, `revisionId`, nullable `parentRevisionId`, `mediaType`, `contentDigest`, exact canonical UTF-8 `content`, `authorId`, `createdByRequestId`, and `createdAt` |
| Thread association and next-turn intent | `ThreadMaterialBinding` | `workspaceId`, `threadId`, `materialId`, `bindingState` as `bound` or `unbound`, nullable `latestQueuedRevisionId`, `inclusionState` as `included` or `excluded`, `lastMutationRequestId`, `createdAt`, and `updatedAt` |
| Turn-frozen and worker-available revision | Context Package trace plus existing Workspace Input Snapshot and Workspace Materialization Record | exact material id, revision id, parent revision id, digest, inclusion reason, nullable binding mutation request proof, package path, sensitivity decision, and S39's completed verified handoff predicate; no materialization status field |
| Active Goal steering delivery | Input Item plus `PendingUserTurnRecord` until an accepted Context Package trace or an exact terminal outcome is durable | `workspaceId`, `threadId`, deterministic `pendingTurnId`, `goalId`, `activeTurnId`, `requestId`, `contentItemId`, `inputKind` as `message` or `material`, nullable `materialId`, `revisionId`, and `contentDigest`, `queueMode`, `receivedAt`, and nullable `terminalClaimKind`, `terminalClaimId`, and `terminalClaimedAt` used only as the first-writer fence below |
| Follow-up or cancellation history | Immutable `SteeringTerminalOutcome`; applied delivery uses S39 instead | `workspaceId`, `threadId`, deterministic `outcomeId`, `state`, `pendingTurnId`, `sendRequestId`, `terminalRequestId`, `contentItemId`, `goalId`, `activeTurnId`, `inputKind`, nullable exact Material tuple, nullable deterministic follow-up Turn and Item ids, and `acceptedAt` |
| Artifact review, Material proposal apply, and refinement | Existing app-local `ArtifactReview` keyed by `(artifactId, artifactVersion)` plus existing Material owners or a reserved follow-up Turn only when required | deterministic `reviewId`, Workspace, exact Artifact version and digest, nullable source Thread, Turn, and Agent, nullable `materialProposal` base tuple, nullable first-writer decision tuple, nullable `appliedMaterialRevisionId`, and nullable deterministic `followUpTurnId` |

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

At worker Turn acceptance, NanoCore MUST freeze one exact Material selection set from eligible bound queues plus any exact claimed Goal-steering input, with at most one selected revision per Material.

Each selected material entry in the Context Package MUST carry material id, revision id, parent revision id when applicable, media type, content digest, package-relative materialized path, inclusion reason, nullable `bindingMutationRequestId`, and sensitivity decision. A `thread_binding` entry carries the exact selected binding's `lastMutationRequestId`. A `goal_steering` entry remains selected by its exact claimed `PendingUserTurnRecord` and takes precedence whenever a binding also queues the same Material, regardless of revision; it carries that binding proof only when the queued revision equals the steering revision, and otherwise carries null so the different queued revision remains eligible for a later Turn.

Context Package trace MUST prove the exact revision and digest the worker was allowed to see.

Automatic `thread_binding` selection is allowed only from a `bound` and `included` `ThreadMaterialBinding` whose queued revision resolves and passes digest verification. `goal_steering` selection instead requires the exact claimed pending row, Item, Goal, Turn, Material tuple, and S39 application proof defined below; it does not require a binding. Preparation records alone are not a product result. `revision_selected` is true only after the Turn is durably accepted and its immutable Context Package trace contains the required material fields. `revision_materialized` is true only after that same Turn is durably accepted and the matching Workspace Input Snapshot and completed verified Workspace Materialization Record preserve the same revision and digest under S39; no status or lifecycle field is inferred.

NanoCore MAY clear `latestQueuedRevisionId` only for a selected entry with non-null `bindingMutationRequestId`, only after the worker Turn is durably accepted with the selected Context Package and materialization handoff complete, and only through compare-and-set when the binding remains `bound` and `included`, still points to that selected revision, and its `lastMutationRequestId` still equals that proof. A `goal_steering` entry with null binding proof never changes a binding queue. If a later save, exclusion, unbind, restore, or rebind changed the binding mutation proof, including intentionally requeueing the same immutable revision, the compare-and-set is a no-op and the later intent remains queued. Admission, source, digest, or materialization failure before this predicate MUST fail Turn admission and leave the queued revision unchanged; it MUST NOT infer availability, accept a partial Turn, or substitute another revision.

If restart or a handled post-acceptance failure leaves an entry with non-null `bindingMutationRequestId` queued under that same proof, the verified accepted S39 trace and its completed handoff authorize only the bounded compare-and-set above. Before selecting work for a later Turn, NanoCore MUST attempt that exact cleanup and re-read the binding; it MUST NOT select the already-proven queue mutation again. A null proof or later binding mutation makes cleanup a no-op and preserves the current binding, while missing or contradictory authority named by a non-null proof returns `recovery_required`. No cleanup record or queue lifecycle is added.

A revision saved after turn acceptance MUST NOT mutate the frozen Context Package or live worker filesystem. It remains queued for a later turn unless explicit active-turn delivery produces a verified `goal_steering` trace entry carrying the exact same non-null binding mutation proof; only that entry may consume the matching queue through the bounded compare-and-set above.

### Active-turn delivery

`Send now` is Steering Input, not live file synchronization and not a Context Package rewrite.

The target contract assigns queued delivery to the Goal worker loop only after the real worker path can persist an immutable accepted Context Package trace for the exact Goal, Turn, and Item. Until that proof owner exists, the Goal and generic direct-Turn adapters own typed rejection, and an exact active `user-input` gate owns its direct response. Web, Agent Skill, Action Center, checkpoint diagnostics, and worker-private state MUST NOT decide or infer the outcome.

The submission command is `goal.steering.send`, scoped by authenticated actor, Workspace, Thread, and required `requestId`. Its canonical caller input is exactly one of `{ message }` for ordinary non-empty text steering or `{ materialId, revisionId, contentDigest, note? }` for an exact Workspace Material revision; every supplied string is non-empty, and the resolved current Goal and active Turn are outputs that MUST NOT enter the input hash. Submission has exactly two results. A rejection returns the mapped typed error and creates no Item, pending row, command record of any status, Turn, or scheduler admission. A valid active-Goal submission derives `pendingTurnId` and `contentItemId` from the command scope and request, creates one completed `user-message` Item on `activeTurnId` with `parentItemId=null`, `causationId=requestId`, and `createdAt=completedAt=receivedAt`, and creates the matching `PendingUserTurnRecord` as one logical commit. For `inputKind=message`, all three Material fields are null and Item text is the exact `message`. For `inputKind=material`, all three Material fields equal the verified caller tuple and Item text is the exact `note` when supplied or `Use Workspace Material <materialId> revision <revisionId>.` otherwise. The pending row, not parsed Item text, owns Material selection. NanoCore then writes one completed send-command record whose body-free response pointer is exactly `{ kind: "pending_user_turn", id: pendingTurnId }`, whose public response is `queued`, and returns exactly `state=queued`, `pendingTurnId`, `requestId`, `contentItemId`, `goalId`, and `activeTurnId`; it MUST NOT embed a mutable Goal or Thread projection. Replay of that send command always returns the original `queued` acceptance response, while callers fetch the current Goal or Thread projection separately to observe later delivery state. If either the input Item or pending row is durable without its matching counterpart or exact Goal and Turn lineage, inspection and exact-request replay return `recovery_required`; they do not create the missing counterpart, accept a second command, or infer delivery.

Within this contract, `PendingUserTurnRecord.requestId` and the send response's `requestId` always mean the original `goal.steering.send` request. A later terminal command has a distinct caller-supplied request id, named `terminalRequestId` in durable proof; it never replaces or aliases the send request identity.

There may be at most one `PendingUserTurnRecord` for one `(workspaceId, threadId)`, including a terminally claimed row awaiting bounded cleanup; `goalId` preserves its original Goal lineage but is not part of the uniqueness key. Completed-receipt replay is checked first. The matching send receipt MUST NOT be pruned while the row exists. A different send request while that row exists returns `409 conflict` with zero writes, even when a newer Goal is active; V1 does not coalesce, reorder, prioritize, or create a steering queue. After winner-owned cleanup deletes the row, a later request may create the next one and normal receipt retention resumes. This Thread-level bounded serialization is the authority behind the singular `activeDelivery` read shape.

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

For Material input, authorization to the path Workspace is checked before any Material or revision lookup; failure returns `forbidden` without business records. After that authorization succeeds, identifiers are opaque and lookup is restricted to that Workspace database. A missing identifier, including an identifier that happens to exist in another Workspace, returns `stale`; NanoCore MUST NOT scan another Workspace to distinguish those cases. Within the authorized Workspace, the table above is exhaustive: loss of the addressed current revision is `stale`, inconsistent Material-to-revision ownership or a caller-digest mismatch is `conflict`, restricted sensitivity is `sensitive_content`, and corrupt durable revision authority is `recovery_required`. None may fall back to the latest revision or caller-supplied bytes.

| Delivery state | Durable authority and predicate |
| --- | --- |
| `queued` | The exact completed input Item and unique `PendingUserTurnRecord` both exist and no terminal proof or downstream effect record exists. The pending row preserves the original Goal, active Turn, request, Item, exact input kind and Material tuple when applicable, `queueMode=safe_point_steering`, and `receivedAt`; a claim with zero downstream effects remains externally queued and only its identical claimant may resume it. Release is limited to the same-invocation handled-failure and Goal-terminal rules below. |
| `applied` | The pending row was first claimed for `applied` by the exact Goal step and reserved Context Package identity, and the exact Item is preserved in that immutable Context Package trace of a specific accepted worker Turn under the same Goal. That trace is terminal delivery proof even if a crash leaves the original pending row temporarily present. |
| `follow-up` | The pending row was first claimed for `follow-up` by the conversion command, the deterministic `followUpTurnId` and `followUpItemId` name one completed Core-local Turn and copied user input Item with exact causation to the original Item, and one immutable `SteeringTerminalOutcome` names both identities plus the original input kind and nullable exact Material tuple. The Turn, Item, and outcome are terminal conversion proof, and the outcome's transaction removes the pending row. This historical conversion does not execute the input or create a Task or Goal worker Turn. |
| `cancelled` | The pending row was first claimed for `cancelled` by the terminal command's `terminalRequestId`, and one immutable `SteeringTerminalOutcome` names that exact claim, original send request and Item, input kind, and nullable exact Material tuple without a new Turn or delivery proof. The outcome's transaction removes the pending row; the audit event is only a projection. |

`queued` is the only non-terminal delivery state and MUST transition exactly once to `applied`, `follow-up`, or `cancelled`. Before writing any terminal proof, the operation MUST compare-and-set the existing pending row from no terminal claim to its exact `terminalClaimKind`, `terminalClaimId`, and one captured `terminalClaimedAt`; for follow-up or cancellation, `terminalClaimedAt` equals the outcome's `acceptedAt`. A winning claim with zero downstream effects remains externally queued. Only the identical claimant may resume it after restart. It may CAS-release the exact three-field claim only during the same handled request after a synchronous pre-effect failure and before returning; boot, another request, and timeout never release it. Before the original Goal becomes terminal, its terminal transition MUST atomically release a zero-effect `applied` claim or fail `recovery_required` when any downstream effect or contradiction exists. A competing application, conversion, or cancellation returns `409 conflict` before effects. One complete deterministic follow-up Turn-and-Item pair matching the winning claim but missing only its terminal outcome permits the identical still-pending terminal request to publish that one bounded outcome, its receipt, and cleanup in one Workspace transaction; neither a different request nor boot recovery may invent it. One half of that pair, a mismatched pair, or any other partial or contradictory downstream Context Package, Turn, Item, or outcome effect returns `recovery_required` and retains the claim for inspection. Complete matching proof projects the terminal result and permits only winner-owned cleanup. This is a three-field fence on the existing pending owner, not a settlement lifecycle or second delivery state.

`terminalClaimId` has one source per kind and is never caller-selected independently: `applied` uses the deterministic `contextPackageId` reserved by the winning `goal.step`; `follow-up` uses the deterministic `followUpTurnId`; and `cancelled` uses the cancel command's immutable `terminalRequestId`. Identical replay MUST present the same kind and exact id, and restart validates terminal proof against that id before resuming or cleaning the claim.

An exact applied Context Package trace has precedence over a residual pending row and authorizes only its matching claimant to CAS-delete that row; it MUST NOT deliver the Item again or select a newer Goal. Follow-up and cancellation instead insert their immutable outcome, receipt, and pending-row deletion in one transaction, so an outcome coexisting with its pending row is contradictory `recovery_required`, not a cleanup state. A claim with no downstream effect remains queued under the rule above; once any downstream effect exists, incomplete or contradictory proof returns `recovery_required`. After cleanup, immutable Items, Context Package traces, Turns, and `SteeringTerminalOutcome` records remain history but `activeDelivery` becomes null rather than selecting among historical proofs.

The generic direct-Turn adapter currently has no safe-point or later-delivery owner. When an implicit input arrives while its Thread has a non-terminal Turn, NanoCore MUST return typed `409 thread_busy` before recording any input state or command record. Repeating the request while busy returns the same unrecorded rejection; after the Turn becomes terminal, the same request id MUST be eligible for ordinary new-Turn admission because no earlier command was accepted.

Valid `Send now` input to an active Goal MAY be accepted as `queued` only when the Goal worker loop is a concrete later-delivery owner that can persist and deliver the required Context Package trace. Valid means that authorization, absence of another pending row, exact Material revision and digest when supplied, original Goal and active-Turn lineage, idempotency preconditions, and delivery capability all pass; each failure uses the exact mapping above. Before that capability exists, submission returns `503 goal_steering_delivery_unavailable` and creates no Item, pending row, command record, Turn, or scheduler admission. After that capability exists, the consuming Goal step first wins the exact `applied` claim with its reserved Turn and Context Package identity, then accepts the package containing the Item and, for `inputKind=material`, the exact pending-row Material tuple, and only then deletes the row. If the original active Turn becomes terminal while its Goal remains non-terminal, the row remains under that Goal and only the same Goal's next worker Turn may claim it. If the Goal becomes terminal first, automatic consumption stops and the Action Center exposes only convert-to-follow-up and cancel for that row.

The terminal commands are exactly `goal.steering.follow_up` and `goal.steering.cancel`. Each is scoped by authenticated actor, Workspace, Thread, `pendingTurnId`, and required terminal-command `requestId`, with no semantic request body; lookup precedes the current Goal or Turn projection. Durable proof names that caller value `terminalRequestId` and separately retains `sendRequestId` from the pending row. Both commands require the pending row's original Goal to be terminal; a nonterminal original Goal returns `409 conflict` before claiming because its next Goal step remains the only delivery owner. The winning operation captures one `acceptedAt` before its claim. `SteeringTerminalOutcome` is one immutable Workspace business record, not command-receipt metadata: its deterministic `outcomeId` is derived from Workspace, Thread, pending Turn, and terminal request; it contains exactly `workspaceId`, `threadId`, `outcomeId`, `state`, `pendingTurnId`, `sendRequestId`, `terminalRequestId`, `contentItemId`, `goalId`, `activeTurnId`, `inputKind`, nullable `materialId`, `revisionId`, and `contentDigest`, nullable `followUpTurnId`, nullable `followUpItemId`, and `acceptedAt`; `state` is exactly `follow-up` or `cancelled`, the three Material fields are all null for message input and all exact for Material input, and both follow-up identities are non-null only for `follow-up`. The command receipt stores only the outcome resource kind and `outcomeId` permitted by C07, and replay projects the public result from that immutable owner rather than storing a response snapshot. The public follow-up response is exactly `{ state: "follow-up", pendingTurnId, requestId: terminalRequestId, sourceRequestId: sendRequestId, contentItemId, goalId, activeTurnId, followUpTurnId, followUpItemId }`, and the public cancel response is exactly `{ state: "cancelled", pendingTurnId, requestId: terminalRequestId, sourceRequestId: sendRequestId, contentItemId, goalId, activeTurnId }`. Neither exposes the recovery-only input kind or Material fields. The outcome, matching receipt, and pending-row deletion commit together; the outcome has no mutable lifecycle, queue role, or authority over current delivery after cleanup.

The follow-up command additionally requires an idle Thread, derives `followUpTurnId` and `followUpItemId` deterministically from the pending identity and `terminalRequestId`, and wins the `follow-up` claim. It then writes one Core-local Turn directly as `completed` with `humanGate=null`, `error=null`, `configVersion=null`, `startedAt=completedAt=acceptedAt`, and `durationMs=0`, plus one completed `user-message` Item whose text exactly copies the original input Item, whose `parentItemId` is the original `contentItemId`, whose `causationId` is `terminalRequestId`, and whose `createdAt=completedAt=acceptedAt`. It does not invoke or alias `turn.start` and creates no Coordinator decision, scheduler admission, Agent, Agent Session, provider call, AEP snapshot, worker request, materialization, or S39 Context Package trace. After that pair is durable, the outcome, receipt, and row deletion commit together. This bounded conversion places the input in post-Goal Thread history but deliberately does not choose a work mode or execute it; subsequent work requires an explicit ordinary command. An active Thread returns `thread_busy` before claiming and leaves the row unchanged. Cancel wins the `cancelled` claim and commits its outcome, receipt, and row deletion in one Workspace transaction without a Turn. Identical receipt replay returns only the winning tuple; an identical still-pending follow-up claim may finish only the exact deterministic pair and final transaction above. Changed scope or reuse of either request identity with inconsistent lineage returns `idempotency_key_conflict`, a competing winning claim returns `conflict`, and missing or contradictory proof returns `recovery_required`. Neither command may retarget the row to a newer Goal.

An explicit input carrying `turnId` is a response to the exact active `user-input` gate, not generic steering. A missing or terminal Turn returns typed `stale`; an existing Turn without an active gate returns typed `not_awaiting_input`. Both fail without writing Item or queue state. An implicit input received when no Turn is active starts a new ordinary Turn.

After restart, queued state is reconstructed from the unique input Item and `PendingUserTurnRecord`, including its exact Material tuple when applicable; a terminal claim with zero downstream effects remains externally queued and permits only identical-claim resume, while any partial or contradictory effect returns `recovery_required`. Boot and a later request never release it; only the explicitly named Goal-terminal rule may release a zero-effect applied claim after its claiming invocation. Applied state is reconstructed only from the exact accepted Context Package trace matching the winning claim and the same Item and Material tuple; only that proof may coexist temporarily with a residual row and authorize bounded cleanup. Follow-up state is reconstructed from the matching deterministic completed Core-local Turn, copied Item, `SteeringTerminalOutcome`, and receipt; cancellation is reconstructed from the matching outcome and receipt, and either outcome requires the pending row to be absent. The same send request id MUST replay its original `queued` acceptance under the original Workspace, Thread, Goal, and active Turn even when delivery advanced or a newer Goal or Turn is current.

Effective worker-input provenance is the immutable initial Context Package plus later accepted Context Package traces that contain the ordered active-turn Items.

### Worker output and writeback

A worker MUST operate against an immutable materialized input snapshot.

Worker changes MUST NOT mutate the authoritative Workspace Material directly.

A worker-proposed Material edit MUST be one immutable `turn-output` Artifact version whose canonical bytes and content digest are the proposal. The existing worker-output artifact declaration MAY carry exactly one optional `materialProposal` field beside that Artifact's existing declaration fields as `{ materialId, baseRevisionId, baseContentDigest }`; no second message, protocol phase, or proposal record is introduced. A collectable declaration has one unique transcript sequence, non-empty title, existing Artifact kind, canonical absolute POSIX `path`, and exact `mediaType` of `text/markdown`, `text/plain`, or `application/json`. Its path MUST be a strict child of exactly one AEP `workspace.outputs` root whose `registerAsArtifacts=true` and `retention=sync-on-turn-end`; equality with the root, traversal, non-canonical spelling, duplicate paths, or zero or multiple matching roots is `invalid_request`. Media type maps respectively to Artifact `content.format=markdown`, `text`, or `json`; file names and extensions never select the format.

NanoCore obtains exact bytes through the existing S23 and S30 worker-output data-plane boundary while the owning backend session is still retained and only after the worker's terminal output barrier. Collection follows declaration-sequence order and starts with a 16 MiB remaining budget. For each declaration, the backend MUST use its existing retained-session command and download operations to create and fetch a backend-owned temporary bounded copy containing at most `remainingBytes + 1` source bytes; it MUST NOT download the unbounded declared file directly. A fetched copy larger than `remainingBytes` rejects the complete set immediately, so aggregate Artifact payload transfer for one Turn is bounded by 16 MiB plus the one sentinel byte even when a worker-controlled file is arbitrarily large. Every declared file MUST be non-empty well-formed UTF-8, JSON bytes MUST parse when `content.format=json`, and the aggregate accepted Artifact bytes for one Turn MUST NOT exceed 16 MiB; bytes are neither newline-normalized nor Unicode-normalized. NanoCore MUST collect and validate the complete declaration set before the first Artifact or Review write. A live artifact notice and a transcript path remain diagnostic candidates rather than content authority. A malformed declaration, missing file, invalid bytes, excess bound, duplicate identity, unsupported content, or bounded-copy failure is `invalid_request` with no Artifact or Review write; the existing backend cleanup lifecycle owns every temporary copy.

Before any Artifact write, the backend MUST compare every collected byte payload with every exact non-empty sensitive value injected for that materialization, including runtime environment, runtime file, direct-provider, worker-control, and trusted-relay values. The comparison set contains one UTF-8 byte sequence for each exact injected value, deduplicated by byte equality; a runtime-file entry contributes its complete injected file content as one sequence rather than lines or a path. A match exists when any payload contains any sequence contiguously at any byte offset, including when the sequence is embedded in a larger payload; whole-payload equality is not required. Secret environment, file, and provider values remain backend-private process memory only until collection or cleanup; the existing scheduler-owned sandbox binding reference remains durable only under its runtime owner but is also included in this comparison because the worker receives it as control and trusted-relay authority. The assembled comparison set MUST NOT enter a package, transcript, diagnostic, log, new durable record, or response. Any match rejects the complete candidate set with a redacted fail-closed result and zero Artifact or Review writes. This is exact-value protection, not generic DLP: user-authored content and encoded, transformed, derived, or non-literal secret material are not generically scanned. A restored session whose original injected-value set is unavailable MAY still complete non-Artifact closeout, but any artifact declaration MUST first run the existing backend cleanup lifecycle and then return `recovery_required`; NanoCore MUST NOT add a state, persist the set, or re-resolve possibly rotated credentials to make restart collection succeed.

Each accepted declaration creates exactly one version-1 Artifact with id `worker-artifact-${packageSnapshotId}-${sequence}`, the addressed Workspace and AEP Thread and Turn, the declared kind and title, `status=ready`, `summary=null`, the mapped format and exact decoded content, its exact digest, and `lastMutationRequestId=origin.requestId` equal to the non-null AEP request id. Its origin is exactly `{ kind: "turn-output", threadId, turnId, requestId }`, and `createdAt=updatedAt` is the one terminal final-status acceptance time already used by turn-end transcript import. A missing request identity, occupied deterministic Artifact or reference identity, existing unequal Artifact tuple, or partial Artifact/reference/Review tuple is `recovery_required`; no sequence substitution or random id is allowed. The existing Artifact owner creates the exact same-Turn `artifact-reference` Item, and the Artifact version becomes acknowledged only after that reference and the required Review below are durable.

Absence of `materialProposal` means that Artifact version is not a Material proposal. The candidate is untrusted operation input and is not another durable owner. A structurally valid candidate MUST be copied into the version-keyed `ArtifactReview` if and only if the exact tuple occurs exactly once in the same source Turn's accepted S39 Context Package trace, the Artifact is an eligible text-compatible `turn-output`, and the tuple resolves to the same Workspace Material and immutable base revision; absence MUST store null. Text compatibility is closed: a `kind=markdown` Material accepts only Artifact `content.format=markdown`, a `kind=text` Material accepts only Artifact `content.format=text`, and `content.format=json` is never a Phase 1 Material proposal. A malformed, duplicate, ambiguous, ineligible, incompatible, or unmatched candidate is `invalid_request` and leaves the Artifact version and Review unwritten. Missing or contradictory already-durable source Turn, accepted S39 trace, Material, or base-revision authority is `recovery_required`. No decision caller may add or replace the candidate, and no path, name, identifier prefix, current binding, latest Material projection, or mere trace visibility may infer proposal intent, target, or base.

After portable S51 import, S39's separate imported-history verifier MAY satisfy only the read-only same-Turn Material-tuple integrity check for an existing imported Review. The historical result authorizes no mutation: a target decision still requires the exact unresolved Review, current Artifact version and bytes, authenticated target actor, ordinary target request and receipt, and, for proposal apply, the current expected Material base and existing atomic Workspace transaction. Imported `sourceAgentId` is historical lineage and only an exact selector: refinement or redo additionally requires the target Workspace's current Agent catalog to contain one enabled Agent with that exact id. Missing or disabled target Agent authority returns `409 stale` with the Review unresolved and zero writes; NanoCore MUST NOT reject the import, remap the historical id, or substitute a default Agent. A permitted refinement or redo MUST create a fresh target-local Turn, admission, Agent Session, lease, backend handoff, and strict S39 trace; it MUST NOT reconnect to or adopt imported runtime state. Imported history never proves worker delivery, launch, replay, reconnect, steering `applied`, capability authority, credential authority, or an external effect.

Artifact Review decisions remain local to one exact Artifact version and MUST NOT be translated into a staged Workspace Review by identifier prefix, route fallback, or verdict mapping. `reviewId` is exactly `arev_${digest24}`, where `digest24` is the first 24 lowercase hexadecimal characters of SHA-256 over the canonical JSON serialization of `[workspaceId, artifactId, artifactVersion]`, encoded as UTF-8, and there is at most one `ArtifactReview` owner for that pair. Its exact fields are `workspaceId`, `reviewId`, `artifactId`, `artifactVersion`, `contentDigest`, nullable `sourceThreadId`, `sourceTurnId`, and `sourceAgentId`, nullable `materialProposal` as exactly `{ materialId, baseRevisionId, baseContentDigest }`, nullable `decision`, `decisionActorId`, `decisionRequestId`, `feedback`, `decidedAt`, `followUpTurnId`, and `appliedMaterialRevisionId`, plus `createdAt`. The owner snapshots the source fields and immutable proposal tuple when that version becomes reviewable; both `materialProposal` and the Artifact version are immutable thereafter. Later Artifact versions create distinct immutable Review history and never overwrite the earlier owner. Every decision and result field is initially null, and first-writer compare-and-set accepts exactly `accepted`, `needs_refinement`, `redo`, `rejected`, or `deferred` with required request and actor identity. Same-request and same-input replay returns the same owner; changed input is `idempotency_key_conflict`; a competing decision is `stale`; a contradictory owner is `recovery_required`.

Phase 1 stores no independent historical Artifact-content table. Before any unresolved Review decision, the current Artifact record MUST still have exactly the Review's `artifactVersion`, `contentDigest`, ready status, immutable origin, and canonical bytes. A newer current version, missing current bytes, or any mismatch returns `recovery_required` without deciding the historical Review or substituting another version. After a decision, a later Artifact version may advance the current Artifact while the decided Review retains the prior version and digest as historical decision evidence; validation then uses the decision's existing result owners, such as the exact applied Material revision or refinement or redo follow-up Turn, and MUST NOT require, infer, or synthesize a historical Artifact body.

A turn-output Artifact version that becomes `ready` creates its unresolved `ArtifactReview` in the same acknowledged logical commit unless its Artifact is the presentation Artifact named by an existing durable Workspace Sync Review. Its `materialProposal` is null when the producing operation supplied no candidate and is the exact verified candidate under the preceding predicate otherwise. Imported Artifacts create no Review owner and expose no refine or redo action; changing one starts ordinary new work. A decision request for a valid imported version returns `409 stale` because no review target exists, while an imported version with a durable Artifact Review or an eligible non-Workspace-Sync turn-output version missing its required Review is contradictory `recovery_required`. The Action Center projects a generic Artifact Review row only from an explicit unresolved owner whose exact Artifact version is still `ready`. A durable Workspace Sync Review's exact `artifactId` relation always excludes that entire immutable presentation Artifact from generic candidates, regardless of review state; if any Artifact Review owner exists for that Artifact, the projection is inspect-only `recovery_required` rather than two action rows. Identifier prefixes and Item absence are never authority.

`rejected` and `deferred` complete the Review with `followUpTurnId=null` and `appliedMaterialRevisionId=null`; feedback is optional but must be non-empty when supplied. `accepted` behaves the same for a null `materialProposal`. For a non-null Material proposal, `accepted` first verifies that the immutable Review tuple equals the unique S39 tuple, the named base revision belongs to the named Material, `baseContentDigest` equals that revision's verified canonical content digest, and the exact reviewed Artifact version bytes and digest remain intact. Any disagreement is contradictory authority and returns `recovery_required` without mutation. Only after those integrity predicates pass does NanoCore compare the Material's current pointer with `baseRevisionId`; a different current revision returns `409 conflict` with the Review still pending and zero Review, Material, revision, binding, or receipt writes. A current base captures one `decidedAt` and commits one `workspace.sqlite` transaction containing Review first-writer compare-and-set, one new immutable `WorkspaceMaterialRevision`, the Material current pointer with `lastMutationRequestId=decisionRequestId` and `updatedAt=decidedAt`, every currently bound Thread binding's coalesced `latestQueuedRevisionId`, preserved `inclusionState`, `lastMutationRequestId=decisionRequestId`, and `updatedAt=decidedAt`, `decisionActorId`, `decisionRequestId`, `decidedAt`, `appliedMaterialRevisionId`, and the command receipt. The new revision has `parentRevisionId=baseRevisionId`, exact content and `contentDigest` from the reviewed Artifact version, media type derived and validated from the immutable Material kind, `authorId=decisionActorId`, `createdByRequestId=decisionRequestId`, and `createdAt=decidedAt`; all other immutable Material and binding fields remain unchanged. Worker attribution remains the Review's source lineage. Success is acknowledged only when all named rows are durable. Missing or contradictory Artifact, trace, Material, revision, digest, decision, or applied-result authority returns `recovery_required` without mutation. No merge or rebase is attempted.

Only `needs_refinement` and `redo` require explicit non-empty feedback, a turn-output origin, and an exact source Thread, Turn, and assigned Agent. The Review's `sourceAgentId` selects but does not authorize the next attempt: the current Workspace Agent catalog MUST contain exactly that enabled Agent before the Review is claimed, and absence or disabled state returns `409 stale` with zero writes rather than substituting another Agent. A null `materialProposal` validates the immutable Review, exact current Artifact version, digest, canonical bytes, and source lineage without requiring a Material, base revision, or S39 Material tuple. A non-null proposal additionally applies the same S39, Material, base-revision, and digest integrity checks used by accepted apply and requires its exact base still to be current; a different current revision returns `409 conflict` before the Review is claimed or a follow-up is created, while contradictory integrity remains `recovery_required`. Missing source lineage for a claimed turn-output version is `409 recovery_required`; an imported Artifact is merely ineligible and never reaches that command. The follow-up Turn id and worker request id are deterministic from the Review decision request, preserve the reviewed version and prior attempt, carry the exact Artifact id, version, media type, digest, canonical content, feedback, decision, and nullable Material proposal tuple through the existing Turn input, and reuse that currently authorized Agent id. The resulting worker attempt may produce a new immutable Artifact version with its own Review; it cannot mutate or replace the earlier proposal.

Refinement or redo MAY create its follow-up only when the source Thread has no other non-terminal Turn. If another Turn is active at preflight, NanoCore returns `409 thread_busy` before claiming the decision or creating effects, and the same request may be retried after the Thread becomes idle. After preflight, the Review atomically records the exact first-writer decision and reserved `followUpTurnId` before Turn or scheduler effects. A claimed decision with no downstream effect may be resumed only by identical replay; any partial or contradictory Turn or admission returns `recovery_required`. Complete matching Turn input and worker admission are terminal proof and permit the original response only after the command receipt is durable. Retry validates and reuses the reserved identities; it never creates another Turn, defaults feedback, changes Agent, or adds a Review lifecycle or queue field. A crash after complete follow-up proof but before its cross-store receipt returns `recovery_required` rather than synthesizing that receipt.

Workspace Material worker proposal and writeback are the narrow Artifact Review specialization above. The current repository/filesystem Workspace Change Set, staged Workspace Review, Apply Plan, and Apply Result require backend materialization, repository or filesystem strategy, paths, and external-effect verification; they are not authorized as aliases for an app-local Markdown Material revision. Implementation MUST NOT create a Material proposal record or route, translate decisions into Workspace Sync, add merge or clean-merge behavior, or add a fourth review, apply, reconciliation, settlement, or recovery framework.

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

The command ledger is written only after the owning business mutation reaches its documented success predicate. Before effects, every S16 command uses one stateless precedence rather than a recovery workflow: a completed matching receipt validates the canonical input hash and projects its named durable business owner; the same key with changed input returns `idempotency_key_conflict`; otherwise an explicitly named still-pending owner below may continue only its exact reserved operation. No S16 command reconstructs, synthesizes, or republishes a missing or expired receipt from a completed owner effect. A request-owned effect without its required receipt, or any partial or contradictory tuple not covered by an exact pending owner, returns `recovery_required` without repeating the effect. Material commands and every Artifact Review decision that stays within `workspace.sqlite`, including accepted Material proposal apply, need no live-operation exception because their owner graph and receipt share one transaction. Portable Workspace import is a separate complete owner: S51 rewrites Material and Artifact Review request proof to reserved `import-lineage:` tokens, imports no source command receipts, and forbids those tokens from command lookup, so the accepted imported graph is not a half-state and pre-export command replay is intentionally unavailable. Task and Goal terminal-checkpoint exceptions remain owned only by S05, S12, and S13 and do not authorize S16 reconstruction. An expected-base or current-state mismatch returns `conflict`. This lookup creates no recovery record or lifecycle.

A mutation spanning records or storage scopes MUST publish its success record only after every owning write is durable. Partial failure has one owner per operation:

| Operation | Permitted recovery state |
| --- | --- |
| Artifact creation or version plus required reference | No pending state. A handled failure exposes the prior complete pair or neither new record; a crash half-state fails closed under the storage contract. |
| Workspace-only Artifact introduction | Idle-Thread admission acknowledges only after the deterministic completed Turn, exact `artifact-reference` Item, and receipt are durable. An active Thread is an unrecorded `thread_busy` rejection. A complete authority tuple without its receipt or any partial or contradictory tuple returns `recovery_required`, and exact-request replay MUST NOT synthesize the receipt or create another Turn or Item. |
| Material create, save, or binding transition | No pending state or cross-store half-state. The Material owners and command receipt commit or roll back in the same Workspace transaction. |
| Accepted Material proposal | No pending state or cross-store half-state. The exact Artifact Review decision, immutable Material revision, current pointer, affected binding queues, applied revision reference, and receipt commit or roll back in one Workspace transaction. A stale base remains an unresolved Review and returns `conflict` with zero writes. |
| Goal Steering Input | Before a claim, the complete input Item plus Thread-unique `PendingUserTurnRecord` pair remains under the original Goal and Turn; either half without the other returns `recovery_required` and exact replay does not repair it. A claim with zero downstream effects permits only identical resume; release is limited to the same handled invocation before return or the exact zero-effect applied-claim Goal-terminal rule. Any partial or contradictory effect returns `recovery_required`. A matching applied Context Package trace authorizes only winner-owned pending-row cleanup. Follow-up or cancellation instead commits the exact immutable `SteeringTerminalOutcome`, receipt, and pending-row deletion together after any required deterministic Turn and Item verify. Every terminal proof preserves the original Item, distinct send and terminal request identities, and exact pending-row Material tuple when applicable. No delivery, Turn, cancellation, or settlement lifecycle is added. |
| Artifact refinement or redo | The exact version-owned Artifact Review decision and reserved `followUpTurnId` own exact-request retry until the matching Turn input and worker admission are durable; no separate lifecycle field is added. |

Restart MUST never choose the newest-looking projection, duplicate a side effect, or create a reconciliation, settlement, provenance, or receipt workflow outside these owners. Existing Workspace Reconciliation records remain limited to their workspace backend recovery scope. Cross-file atomic publication remains the storage specification's responsibility, not authorization for an S16 recovery framework.

### Web projection

The OpenKit Web UI MUST be sufficient to complete the Plane 1 flow without another desktop agent application.

The Web UI MUST use public Core Client operations and MUST NOT access worker files, Core-private paths, or external runtime state directly.

The material surface MUST support Markdown or text viewing and editing, stable save status, revision history and comparison, Thread binding, queued-inclusion status, exclusion, `Send now`, and comparison and decision of an exact worker Material proposal. Grounded annotation, text-range patching, and locator controls remain deferred and MUST NOT be implied by this requirement.

The conversation surface MUST show item-backed explanations of material inclusion, active-turn delivery, worker results, conflicts, and review outcomes.

The Action Center MAY project only the exact Artifact Review owner described above and the exact unresolved Goal steering `PendingUserTurnRecord` defined by this specification. An Artifact Review row and source MUST contain at least `reviewId`, `artifactId`, and `artifactVersion`, and its row identity derives from that version-owned Review; an Artifact-id-only source is invalid. Any executable Artifact Review decision action MUST address the versioned decision endpoint and MUST NOT use a generic review fallback. The steering row exposes its original Goal lineage and only exposes follow-up and cancellation after that Goal is terminal; the projection is not command authority. A rejected Material expected-base command creates no durable conflict owner or Action Center row, and projection MUST NOT create a Material writeback, delivery, or conflict lifecycle.

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
| `revision_selected` | The accepted Turn's Context Package trace names the exact material, revision, parent, digest, inclusion reason, nullable binding mutation request proof, package path, and sensitivity decision. |
| `revision_materialized` | The accepted Turn's matching Workspace Input Snapshot and completed verified Workspace Materialization Record preserve the selected revision and digest under S39's exact handoff predicate; no status field is required. |
| `worker_available` | An accepted worker Turn references the selected Context Package and the materialization handoff completed; this does not claim that the model read or understood the content. |
| `active_input_queued` | The completed send-command record, input Item, and matching `PendingUserTurnRecord` identify one original Goal and active Turn, and no exact application, follow-up, or cancellation proof exists. |
| `active_input_applied` | The exact `applied` claim and Item have durable Context Package provenance for the claimed accepted worker Turn under the same Goal. A residual pending row means only bounded CAS cleanup remains and cannot change or suppress this result. |
| `active_input_follow_up` | The deterministic completed Core-local Turn, copied Item, immutable `SteeringTerminalOutcome`, and receipt agree on the original active-turn Item, `sendRequestId`, `terminalRequestId`, and nullable Material tuple, and the pending row is absent. |
| `active_input_cancelled` | The immutable `SteeringTerminalOutcome` and receipt agree, no delivery or follow-up proof exists, and the pending row is absent. |
| `material_proposal_applied` | The exact Review has `decision=accepted` and its non-null `appliedMaterialRevisionId` resolves to the immutable proposal bytes; the Material current pointer, affected binding queues, decision tuple, and command receipt agree in the same Workspace transaction. |
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
- An accepted Material proposal MUST apply only from the exact immutable Artifact version and exact S39-proven base tuple recorded by its Review; no current-state inference, merge, rebase, path alias, or Workspace Sync translation is permitted.
- Artifact identity MUST remain reserved for durable user-visible outputs and MUST follow the Item-lineage boundary in this spec.
- Artifact origin is immutable, and each version plus its required provenance or reference Item revision MUST commit as one logical mutation.
- Refinement and redo MUST preserve earlier attempts and MUST NOT bypass another non-terminal Turn or create a competing workspace writer.
- Replay and restart MUST preserve the originally accepted lineage and outcome rather than resolving through a newer current Goal, Turn, revision, binding, or projection.
- Plane 2 and Plane 3 MUST remain deferred until separately authorized.

### Error and stale-state behavior

Failure mapping is exact. Missing or malformed required request fields are `invalid_request`; submitted bytes that disagree with their digest are `source_digest_mismatch`; a temporarily unavailable pre-acceptance source or materializer is `source_unavailable`; and missing or invalid content in already durable authority, including a reviewed Artifact's recorded source Turn or assigned Agent, is `recovery_required`. An absent or terminal requested target, historical revision, or gate is `stale`; an existing Turn without an active input gate is `not_awaiting_input`; request-id reuse with different immutable input or lineage is `idempotency_key_conflict`; an expected-version, expected-base, binding-state, or active-ownership mismatch is `conflict`; and attempted worker delivery of a restricted Material is `sensitive_content`. Unauthorized access is `forbidden`, and `thread_busy` is reserved for a valid request prevented only by another non-terminal Turn.

The S16 HTTP mapping is closed: `invalid_request` and `source_digest_mismatch` are `400`; `forbidden` is `403`; `source_unavailable` and `goal_steering_delivery_unavailable` are `503`; and `recovery_required`, `stale`, `not_awaiting_input`, `idempotency_key_conflict`, `conflict`, `sensitive_content`, and `thread_busy` are `409`. No S16 route chooses another status for the same code or returns a success-shaped error body.

`thread_busy` applies only when an otherwise valid request is prevented by another non-terminal Turn. A missing or terminal target returns `stale`, unavailable Goal delivery returns `goal_steering_delivery_unavailable`, a corrupt durable owner pair returns `recovery_required`, and expected-state or idempotency failures retain their exact codes above; none are collapsed into `thread_busy`.

The system MUST NOT substitute the latest revision for a requested historical revision.

The system MUST NOT mark a revision worker-visible unless an accepted worker Turn's exact Context Package proves availability.

A dependency outage or half-state MUST follow the operation-specific recovery table above. Artifact/provenance half-states fail closed under the storage contract; Material revision, pointer, binding, queue, Artifact Review decision and applied-revision reference, and receipt writes share one Workspace transaction; Goal input remains in its existing pending row; and refinement or redo remains in its unresolved version-owned Artifact Review. No implementation may choose a different owner or fabricate the missing half.

### Audit and privacy

Successful Material creation, revision save, Thread binding, unbinding, queued-inclusion exclusion, active-turn send, worker availability, and Artifact Review decisions SHOULD be auditable at the appropriate product level. A rejected expected-base request may emit a redacted request-failure audit event only under the general audit contract; it does not become Material conflict authority.

Audit and Item projections MUST avoid secret values, Core-private paths, external credentials, and unnecessary sensitive-content duplication.

Workspace boundaries MUST be preserved in material identity, revision lookup, Thread binding, Context Package selection, review, and worker materialization.

Every S16 App API route authorizes the path Workspace before looking up any target identifier. After authorization, all Material, revision, Thread, Artifact, and Review lookups are restricted to that Workspace's owners. An opaque identifier that is absent there returns the route's `stale` result even if the same string exists elsewhere; implementations MUST NOT scan another Workspace to distinguish foreign from unknown identifiers. `forbidden` is reserved for failure to access the addressed path Workspace or another independently provable authorization failure before target disclosure.

## Phase 1 Public Design

### Public Material read models

The closed public `ArtifactReviewView` contains exactly `workspaceId`, `reviewId`, `artifactId`, `artifactVersion`, `contentDigest`, nullable `sourceThreadId`, `sourceTurnId`, and `sourceAgentId`, nullable `materialProposal` as exactly `{ materialId, baseRevisionId, baseContentDigest }`, nullable `decision`, `decisionActorId`, `feedback`, `decidedAt`, `followUpTurnId`, and `appliedMaterialRevisionId`, plus `createdAt`. The owner-only `decisionRequestId` is excluded from every public response, and an imported `import-lineage:` token is never exposed or accepted as command identity. Artifact Review list returns these views in ascending `artifactVersion` order; decision responses remain the bounded success identity in the App API contract rather than returning the owner row.

Public Material reads use three closed shapes. `WorkspaceMaterialView` contains exactly `workspaceId`, `materialId`, `title`, `kind`, nullable `currentRevisionId`, `sensitivity`, `createdAt`, and `updatedAt`. `WorkspaceMaterialRevisionSummary` contains exactly `workspaceId`, `materialId`, `revisionId`, nullable `parentRevisionId`, `mediaType`, `contentDigest`, `authorId`, and `createdAt`; `WorkspaceMaterialRevisionView` adds only the exact canonical `content`. Internal request-proof fields such as `lastMutationRequestId` and `createdByRequestId` remain owner and recovery data and are not public response fields.

The Material list returns ordered `WorkspaceMaterialView` records, Material get returns one such record, revision list returns ordered `WorkspaceMaterialRevisionSummary` records, and exact revision get returns one `WorkspaceMaterialRevisionView`. A client compares revisions by reading the two exact immutable revisions; no comparison result becomes authority.

The Thread material response is exactly `{ material: null }` when no Material is currently bound. Otherwise `material` contains exactly `workspaceId`, `threadId`, one `WorkspaceMaterialView` as `resource`, nullable `WorkspaceMaterialRevisionSummary` as `currentRevision`, `inclusionState`, nullable `latestQueuedRevisionId`, nullable `lastWorkerSeenRevisionId`, nullable `currentTurnRevisionId`, and nullable `activeDelivery`. `inclusionState` is `included` or `excluded`. `activeDelivery` is derived only from the Thread's single unresolved or not-yet-cleaned `PendingUserTurnRecord`; it is null when that row is absent, has `inputKind=message`, or names another Material. When present, it contains exactly `state`, `pendingTurnId`, `requestId`, `contentItemId`, `goalId`, `activeTurnId`, `materialId`, `revisionId`, and `contentDigest`, where `requestId` is the row's original send request, the Material fields equal the pending row, and state is exactly `queued` or `applied`. A zero-effect follow-up or cancellation claim remains `queued`; its completed outcome transaction deletes the row, so the projection then becomes null. The read model never ranks historical outcomes by timestamp or identifier. Expected-base rejection is only the typed mutation response and is not retained in this read model. Clients may choose presentation actions from this projection, but command validation remains authoritative and no action list becomes another lifecycle owner.

A public read whose non-null revision, binding, Context Package, or delivery identity does not resolve to the matching Workspace owner returns `recovery_required`; it MUST NOT silently null the field, substitute the latest revision, or expose a partial projection.

This projection is a read model. Material revision, binding, Context Package, Item, and review records remain authoritative.

Without either a strict accepted Turn-owned immutable S39 Context Package trace or an S51 imported-history trace that passes S39's bounded portable-history verifier, `lastWorkerSeenRevisionId` MUST be null. NanoCore MUST NOT infer it from a checkpoint digest, AEP, latest Material revision, Workspace Input Snapshot, Workspace Materialization Record, or worker-local receipt.

`lastWorkerSeenRevisionId` is derived for the currently bound Material by ordering strict accepted worker Turns and verified imported-history worker Turns in the current Thread by `(startedAt, turnId)` descending and selecting the first verified trace whose `materialSelections` names that Material. It is null when none does. A strict trace requires its accepted runtime handoff owners; an imported-history trace requires its complete portable owners and exact bytes but carries no live handoff. Missing or contradictory authority returns `recovery_required` rather than falling back to an older trace or current revision. Imported history never contributes `currentTurnRevisionId` or `activeDelivery`, and no stored last-seen field or index becomes a second authority.

`currentTurnRevisionId` is derived only from the exact verified trace for the Thread authority's current non-terminal worker Turn and the currently bound Material. It is the revision named by that trace's unique `materialSelections` entry for the Material; it is null when there is no current non-terminal worker Turn, that Turn is Core-local or not yet accepted, or its verified trace contains no selection for the Material. A current accepted worker Turn whose named trace, Material selection, revision, package bytes, or handoff authority is missing or contradictory returns `recovery_required`; NanoCore MUST NOT substitute the current Material revision, latest historical trace, queued revision, or pending steering input.

An authorized human-facing App API client may read and edit a restricted Material revision, but `sensitivity=restricted` forbids exact content transfer through the transport-neutral Agent Skill and worker delivery. The Agent Skill catalog may expose `listWorkspaceMaterials`, `getWorkspaceMaterial`, `listWorkspaceMaterialRevisions`, `getThreadMaterial`, `bindThreadMaterial`, `unbindThreadMaterial`, `excludeThreadMaterial`, and `restoreThreadMaterial` for restricted Materials because their closed inputs and responses contain no canonical content. Its `getWorkspaceMaterialRevision` and `saveWorkspaceMaterialRevision` handlers MUST preflight the Material metadata and return `409 sensitive_content` without calling the content-bearing route when sensitivity is restricted; `createWorkspaceMaterial` likewise rejects caller input with `sensitivity=restricted`. Public and internal Materials may use those three content-capable operations normally. The catalog MUST NOT add an alternate raw route, generic call, or CLI escape that bypasses this boundary.

### Command surface

The Phase 1 mutation names and canonical caller inputs are closed:

| Command | Immutable scope | Canonical caller input |
| --- | --- | --- |
| `artifact.import` | actor, Workspace, `requestId` | `{ title, mediaType, contentDigest, content }`; Artifact id and `sourceId=requestId` are outputs |
| `artifact.introduce` | actor, Workspace, Thread, `requestId` | `{ artifactId, expectedArtifactVersion }` under the idle-Thread contract above |
| `artifact.review.decide` | actor, Workspace, Artifact, Artifact version, `requestId` | exactly `{ decision, feedback? }` for `accepted`, `rejected`, or `deferred`, and exactly `{ decision, feedback }` for `needs_refinement` or `redo`; supplied feedback is non-empty; a non-null Review `materialProposal` makes `accepted` the atomic expected-base Material apply above without adding caller input |
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
- An Artifact becomes a Material proposal only from one explicit worker-output candidate that matches exactly one same-Turn S39 base tuple; absence leaves the Review candidate null, ambiguity fails closed, accepted apply creates exactly one fully bound immutable revision and coalesces current bound queues, while a different current revision returns `conflict` with the Review still pending and zero writes.

### L2 contract and conformance coverage

- Public API, Core Client, Context Package, Item references, and Web read models agree on material and revision identity.
- A Thread binding is explicit, workspace-scoped, and cannot reference another workspace.
- The initial Context Package plus later accepted Context Package traces containing active-turn Items reconstruct effective worker input.
- A work-produced Artifact creation or update communicated in a Thread has an exact `artifact-reference` Item for the communicated Artifact version in that Thread and Turn, while the Artifact record has no `itemId`.
- A workspace-only Artifact import preserves explicit provenance, and introducing it into a Thread creates an exact `artifact-reference` Item.
- Every public read model derives `revision_saved`, queued, selected, materialized, worker-available, active-input, and Artifact Review outcomes from the authority table and observable predicates rather than independent status fields; expected-base conflict and stale remain typed command responses and are not retained as read-model state.
- Artifact Review, Material, revision, binding, receipt, export, and import schemas agree on the exact nullable Material proposal tuple and applied revision reference; no Workspace Sync record is accepted as an alias.

### L3 NanoCore black-box coverage

- A bound revision is frozen into the next turn without a separate message about the edit.
- A revision saved after turn acceptance remains queued and does not mutate running worker input.
- Excluding a queued revision prevents inclusion.
- `Send now` distinguishes unrecorded rejection from initial queued acceptance, keeps send-command replay queued, and reports queued or applied through the current-delivery projection; follow-up and cancellation return their exact terminal response, retain one immutable outcome, and leave current delivery null.
- Restart preserves bindings, queues, exact worker-seen revisions, pending deliveries, and Artifact Review state.
- Restart and duplicate-request tests cover command-ledger loss with a complete deterministic result, retained pending ownership, Goal or Turn lifecycle change, and handled partial persistence failure without duplicate side effects.
- Missing content, digest mismatch, expected-base conflict, and cross-workspace references fail closed.
- Accepted Material proposal apply is atomic in `workspace.sqlite`; exact replay returns the same applied revision, stale base performs no write, and contradictory proposal, trace, digest, or applied-revision authority returns `recovery_required` without retrying an effect.

### L4 Web browser coverage

- The user can edit and save a material, bind it to a Thread, see queued state, exclude it, or send it now.
- The user can compare immutable revisions without that comparison authorizing a grounded-feedback command.
- The user can inspect Artifact Review history and initiate refinement or redo without deleting the reviewed version or prior attempt.
- The user can compare an exact Material proposal with its recorded base, accept it only while that base is current, and retain both proposal and newer user state after a conflict.
- The UI never claims that a worker saw a revision without server provenance.
- The complete Phase 1 flow works without opening a desktop worker application.

### L5 integrity coverage

- Every material revision referenced by a Context Package can be resolved and digest-verified.
- Invalid parent chains, missing canonical content, and unresolved pending handoffs are reported.
- Restart recovery preserves material identity, revision history, bindings, and worker-input provenance.
- Artifact/provenance, Artifact/reference including workspace-only introduction, revision/current-pointer, binding/queue, queue/Context Package, and Artifact Review fault injection proves that acknowledged state is complete and unacknowledged half-state is rolled back or fails closed.
- Portable export/import remints every Material proposal target, base revision, and applied revision reference coherently and rejects a missing or contradictory graph.

### L6 story acceptance

The canonical story MUST prove the following sequence.

1. A user creates a Thread and binds a Markdown material at revision 1.
2. A worker turn receives revision 1, and its Context Package records revision 1 and its digest.
3. The user saves revision 2 without sending a separate chat message.
4. The product shows revision 2 queued and identifies revision 1 as the last worker-seen revision.
5. The next turn receives the exact revision 2 bytes and its trace proves the selected Material, revision, and digest.
6. Restarting NanoCore preserves every revision, binding, queue decision, and worker-availability proof without substituting a newer revision.
7. A worker proposal against revision 2 becomes one immutable turn-output Artifact and version-keyed Review, accepted apply creates one new Material revision from those exact bytes, and a concurrent newer user revision instead leaves the Review pending with `conflict` and no Material write.

Additional acceptance MUST cover unrelated-material exclusion, explicit queued-revision exclusion, active-turn delivery, workspace isolation, and redo without deletion of prior attempts.

## Stop Rules

If users cannot predict or trust automatic next-turn inclusion despite explicit binding and visible queue state, Phase 1 MUST shrink to an explicit `Publish to Thread` action rather than add heuristics.

The current slice accepts Goal steering only into the unique pending owner defined above and may mark it applied only after the consuming Goal step persists and verifies the exact S39 Context Package trace. If that worker path or its required steering candidate cannot satisfy the delivery predicate, the Goal step MUST return `goal_steering_delivery_unavailable` before reserving a Turn while leaving the pending input queued; the direct-Turn adapter MUST return typed busy before accepting implicit input during another Turn. Neither path may mutate the live worker filesystem or create a substitute receipt, settlement, or recovery workflow.

Material worker proposal implementation MUST stop if the selected version-keyed Artifact Review plus one `workspace.sqlite` transaction cannot express the complete success predicate. It MUST NOT add a Material proposal record or route, Workspace Sync alias, merge or rebase engine, Apply Plan or Apply Result, settlement state, or recovery workflow to avoid that boundary.

If future asset types fail to share meaningful contracts, OpenKit MUST NOT build a universal Plane 2 protocol.

If a future external integration requires OpenKit to mirror a domain system, the design MUST be re-reviewed before implementation.

## Open Questions

There are no blocking open questions for the authorized Phase 1 slice. G05/C09 resolved Material worker writeback to the exact version-keyed Artifact Review and existing Material owner transaction defined above.

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
