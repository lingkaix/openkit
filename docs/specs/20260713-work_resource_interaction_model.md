# Work Resource Interaction Model

Status: Accepted
Implementation: Not Started
Change Plan: `docs/changes/202607132212000001-work_resource_interaction_model.md`

## Owns

This spec owns the implementation-facing interaction model that lets users express precise intent against work resources without requiring every interaction to be plain text.

It owns the three work-resource planes, the distinction between a resource plane and the `Artifact` product role, the grounded-feedback language, the relationship between conversation and resource surfaces, the cross-plane reference contract, and the current implementation boundary.

It also owns the complete Phase 1 contract for a thread-bound workspace-native Markdown or text material: material identity, immutable revisions, explicit thread binding, queued next-turn inclusion, exact worker-visible revision capture, active-turn delivery, worker-produced change review, conflict-safe apply, recovery, Web projection, and acceptance criteria.

## Does Not Own

This spec does not redefine `Workspace`, `Thread`, `Turn`, `Item`, `Artifact`, `Knowledge`, `Knowledge Source`, `Context Package`, `Workspace Data Source`, `Agent Capability`, `Skill`, `ApprovalRequest`, or the four human-attention modes owned by core documents and existing specs.

It does not own physical workspace storage layout, general workspace synchronization transports, worker runtime protocols, sandbox implementation, vault internals, external-system schemas, provider-specific connectors, full media editors, professional project-file formats, A2UI itself, or screen-level Web information architecture.

It does not make ChatCut or any other specialized workbench a required dependency, does not require a desktop agent host, and does not define a universal plugin marketplace, universal editor protocol, universal workbench protocol, or universal `Resource` core entity.

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

OpenKit uses delegation as the default working posture, but delegation does not make all human interaction low-bandwidth.

The accepted product posture is: **delegate by default, collaborate on demand, and govern throughout**.

The default experience should minimize interruption while preserving strong control. Users should be able to assign a goal, observe progress, approve sensitive decisions, and receive results without continuously operating the worker. When work reaches intent formation, planning, taste calibration, comparison, review, or exact correction, the product must provide grounded, high-bandwidth interaction against the work itself.

Conversation-first therefore does not mean text-only. Conversation is the narrative and coordination layer, while the relevant work resource is the shared surface for precise intent.

OpenKit classifies work resources into three planes according to source-of-truth ownership, native editability, and interaction capability.

1. **Workspace-native Material** is authored and governed inside the OpenKit workspace and may be edited natively by the user.
2. **Managed Asset or Bundle** is preserved, previewed, compared, annotated, imported, or exported by OpenKit, while precise domain editing normally belongs to a specialized workbench.
3. **External System Resource** remains authoritative in a third-party system and is understood or operated through governed data-source, vault, capability, connector, and Skill paths.

These planes are not three `Artifact` kinds. `Artifact` remains the durable user-visible output role defined by the core model. A resource may be source material, an Artifact, Knowledge evidence, or a Context Package entry at different points in its lifecycle.

The current implementation phase covers only Plane 1 and must complete its full end-to-end chain before Plane 2 or Plane 3 interaction work begins. The first vertical slice is one thread-bound Markdown or plain-text material.

## Goals / Non-goals

### Goals

- Preserve delegation as the default without reducing precise collaboration to prose-only chat.
- Give users stable interaction primitives for compare, select, annotate, keep, change, remove, adjust, patch, accept, reject, and redo.
- Ground every precise instruction in a resource identity, exact revision or freshness point, locator, intent, and structured value.
- Keep conversation, resource interaction, human attention, worker execution, and governance connected through NanoCore-owned records.
- Keep the Web UI capable of completing the Plane 1 flow without requiring Codex or another desktop agent application as the interaction host.
- Let external worker runtimes perform the heavy work while NanoCore preserves authoritative state, input provenance, review, and handoff semantics.
- Separate workspace-native materials, managed assets or bundles, and external-system resources without turning `Artifact` into a universal file or data model.
- Preserve Knowledge as a cross-cutting semantic layer rather than treating it as another resource plane.
- Complete the full revision handoff for thread-bound workspace-native materials before broadening media, project-file, or external-system interaction.
- Reuse the existing Item, Context Package, workspace synchronization, staged review, Action Center, Data Source, Vault, Agent Capability, and Knowledge boundaries where they already own the required behavior.

### Non-goals

- Do not add `StrongInteractionMode`, `WeakInteractionMode`, or another core interaction-mode enum.
- Do not make every pointer movement, selection change, editor keystroke, or autosave event a worker input.
- Do not inject every workspace edit merely because the user is currently viewing a Thread.
- Do not add `native`, `media`, or `external` to the current `Artifact.kind` vocabulary.
- Do not create a universal `Resource` mega-entity or one schema that absorbs Materials, Artifacts, Knowledge Sources, Data Sources, and external records.
- Do not build a universal document, image, audio, video, canvas, timeline, CAD, design, or project-file editor.
- Do not implement full media editing, Final Cut project editing, Photoshop project editing, or arbitrary format conversion in OpenKit.
- Do not require ChatCut compatibility, MCP Apps hosting, iframe embedding, a plugin marketplace, or a desktop-agent application.
- Do not mirror CRM, ERP, accounting, warehouse, HR, or other domain-system records into an OpenKit-owned system of record.
- Do not implement arbitrary external writeback in the current phase.
- Do not implement CRDT, operational transformation, real-time multi-user coediting, or live mutation of an active worker filesystem in the current phase.
- Do not preserve backward compatibility for repository-owned internal shapes introduced or replaced during implementation.

## Background

The original product framing emphasized a weak-interaction, strong-management experience because model capability and harness reliability are expected to improve.

That prediction is directionally correct for procedural work. Better models, tools, sandboxes, retries, verification, and runtime harnesses should reduce the number of times a user must explain tool operation, decompose routine steps, or manually recover common execution failures.

The prediction is incomplete for work whose difficulty lies in discovering intent, evaluating alternatives, exercising taste, negotiating trade-offs, or specifying exact local corrections. Improved execution reliability does not automatically determine what the user wants, which candidate they prefer, where a result is wrong, or whether a subtle difference is acceptable.

The product should therefore reduce procedural interaction while increasing the precision available for human judgement. Strong management should mean strong system governance, not continuous human supervision.

OpenKit already has the correct stable human-attention primitives: Approval Gate, Elicitation Gate, Steering Input, and Review And Acceptance. The missing layer is a grounded interaction language and resource surface that lets those primitives carry more than undifferentiated prose.

The worker-runtime boundary does not prevent this design. The user interaction can occur in the OpenKit Web app, NanoCore can persist and route the resulting references and feedback, and a worker can consume the exact revision or projection in its own runtime. The UI, source of truth, and worker do not need to share one process or filesystem.

Specialized workbenches may remain valuable for Plane 2. An embedded workbench is only a presentation and interaction projection; NanoCore still needs stable resource identity, authorization, lineage, event, and handoff contracts, while the specialized service owns its domain model and edit operations.

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

OpenKit MUST NOT introduce a global strong-interaction mode. Existing human-attention semantics remain sufficient, and richer interaction is expressed through grounded payloads attached to ordinary input, steering, review, elicitation, or approval flows.

### Conversation-first, artifact-centered, grounded interaction

The target experience is **conversation-first, work-resource-centered, and grounded**.

Conversation explains why work exists, what is happening, what changed, and what decision is needed.

The active resource surface shows what the user and worker are discussing.

A selection or annotation identifies where the instruction applies.

A control or parameter expresses how much, how many, or which constrained value.

A comparison or ranking expresses which candidate is preferred.

A direct edit or patch expresses the exact desired result.

The Action Center identifies when human attention is required.

The term artifact-centered remains useful at the product level when the shared surface is a deliverable, but this spec uses work-resource-centered because not every shared surface is an `Artifact` in the core model.

### Three work-resource planes

OpenKit adopts three work-resource planes as an implementation and product-interaction taxonomy.

| Plane | Authoritative source of truth | Native OpenKit interaction | Worker supply | Current phase |
| --- | --- | --- | --- | --- |
| Workspace-native Material | OpenKit workspace | View, edit, revise, compare, annotate, comment, patch, review | Exact immutable revision plus traceable delta or summary | Full Phase 1 scope |
| Managed Asset or Bundle | OpenKit identity and lineage records, with bytes possibly in an artifact backend or external managed service | Import, export, preview, compare, annotate, comment, rank, review | Versioned asset or bundle reference plus derived representations | Defined here, implementation deferred |
| External System Resource | Third-party system of record | Connect, query, summarize, compare, propose change, review, approve | Bounded freshness-aware projection through governed capabilities | Defined here, implementation deferred |

The plane is determined by authority and lifecycle, not by MIME type.

A CSV maintained as an OpenKit workspace document can be Plane 1. A CSV exported as a task deliverable can be an Artifact and a Plane 2 managed file. A live CRM table remains Plane 3 even when it is rendered as rows in the Web UI.

An image may be a Knowledge Source, an input asset, or an Artifact. Its binary nature affects the available interaction and preview capabilities, but does not by itself decide its product role.

### Current implementation boundary

The current implementation phase MUST deliver the complete Plane 1 lifecycle before any Plane 2 or Plane 3 interaction implementation begins.

The first vertical slice MUST support exactly one workspace-native material kind: a Markdown or plain-text document that is explicitly bound to one Thread working set.

The first slice is complete only when the user can create or open the material, bind it to a Thread, save a stable revision without sending a separate chat message, see that revision queued for the next worker turn, prove which revision the worker received, review worker-proposed changes, apply them without clobbering newer user work, and recover the same state after restart.

Tables, structured documents, and additional Plane 1 formats MAY follow only by reusing the proven revision, binding, context, feedback, review, and recovery contract.

Plane 2 and Plane 3 sections in this spec establish boundaries and future compatibility constraints only. They do not authorize implementation in the current phase.

## Conceptual Model

### Resource plane is a classification, not a core entity

`Work resource` is a collective term used by this spec for anything a user and worker may inspect, discuss, transform, or act upon.

It MUST NOT become a new universal core record merely because the term is convenient in this document.

Implementation MUST continue to use the smallest owning concepts: workspace-native material records for Plane 1, `Artifact` for durable outputs, Knowledge Source and Derived Representation for evidence, Workspace Data Source for configured external inputs, Agent Capability for governed operations, Item for communication history, and Context Package for task-time worker projection.

Cross-plane UI read models MAY normalize fields for display, but such projections MUST NOT become a competing source of truth.

### Artifact is a role

`Artifact` remains the core-defined role for a durable user-visible output associated with a workspace and optionally a Thread or Turn.

Artifacts include reports, diffs, file bundles, generated assets, structured summaries, and exported documents. Their bytes may live outside protocol records, while identity and lineage remain workspace-scoped.

An Artifact is not the universal identity for every editable document, uploaded source, external record, or piece of feedback.

A workspace-native material MAY become an Artifact when it is exported or intentionally frozen as a deliverable. The editable material and the exported Artifact remain distinct identities linked by lineage.

When the user wants to turn an Artifact into an ongoing editable work object, OpenKit SHOULD create a Workspace-native Material derived from the selected Artifact version instead of silently changing the historical output in place.

An Artifact MAY become a Knowledge Source. Accepting an Artifact as evidence does not automatically make the Artifact itself reviewed Knowledge.

### Knowledge is cross-cutting

Knowledge is reusable workspace understanding and is not a fourth work-resource plane.

Plane 1 materials, Plane 2 assets, Plane 3 records, Artifacts, Thread history, and worker observations MAY all become Knowledge Sources.

Derived representations such as extracted text, OCR, captions, transcripts, thumbnails, waveforms, metadata, or summaries remain source projections until curated into reusable Knowledge.

Knowledge Pages are user-visible, editable, reusable workspace understanding. They may use Plane 1 revision and interaction mechanics where appropriate, but Knowledge governance, proposal, review, retrieval, and injection remain owned by the Knowledge model.

### Role transitions

The system MUST preserve explicit lineage when one role becomes another projection.

Examples:

- A CRM customer record is a Plane 3 External System Resource.
- A worker-generated quarterly analysis is an Artifact.
- An accepted, reusable sales insight derived from that analysis is Knowledge.
- A long-lived plan that the user edits inside OpenKit is a Plane 1 Workspace-native Material.
- Exporting that plan as a signed PDF creates an Artifact linked to the material revision; it does not replace the editable material.
- Importing an opaque design project creates a Plane 2 managed asset or bundle and MAY also register it as a Knowledge Source.

## Grounded Interaction Language

### Purpose

Grounded feedback increases interaction bandwidth by separating the target, location, intent, structured value, and optional explanation.

Plain text remains available, but precise interactions MUST NOT require the worker to infer the target or location from prose when the UI already knows them.

### Conceptual envelope

Every grounded interaction MUST preserve the following semantics.

```json
{
  "subject": {
    "kind": "workspace-material",
    "id": "material-id",
    "version": "revision-id"
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

This shape is conceptual and MUST be projected into the smallest existing Item, review, elicitation, approval, or App API command contract. It MUST NOT create a separate feedback log or a universal feedback database.

### Required semantics

`subject` identifies the material, Artifact, managed asset, candidate, derived representation, or external record under discussion.

`version` identifies the exact immutable revision, digest, capture, or `asOf` point the user saw.

`locator` identifies the smallest stable target area that can be interpreted by the owning resource type.

`intent` identifies what the user wants done or decided.

`value` carries structured data when the intent has a bounded representation.

`note` carries optional natural-language nuance and MUST NOT be required when the structured intent is already complete.

Grounded feedback MUST be immutable once recorded in Item history. A correction creates later input that supersedes or narrows the earlier instruction.

Grounded feedback is not an Artifact. It is Item-backed user input or an item-linked review, elicitation, or approval decision that references the exact work resource under discussion.

### Stable intent primitives

OpenKit adopts the following product-level primitives.

| Primitive | Meaning | Typical structured value |
| --- | --- | --- |
| Compare | Inspect differences between versions or candidates | Ordered subject references and comparison dimensions |
| Select | Choose one or more bounded targets | Selected references or locators |
| Rank | Express ordered preference | Ordered candidate references and optional rationale |
| Annotate | Attach guidance to an exact location | Locator, annotation kind, and comment |
| Keep | Preserve the selected content or property | Target locator and optional reason |
| Change | Request a modification without prescribing the complete result | Target locator, desired property, constraint, and optional note |
| Remove | Delete or exclude the selected content or property | Target locator and optional reason |
| Adjust | Set a bounded parameter | Parameter id, value, unit, range, or option id |
| Patch | Provide the exact desired replacement | Expected base revision plus replacement content or patch |
| Accept | Mark the reviewed result sufficient | Reviewed subject reference and optional scope |
| Reject | Mark the reviewed result unusable | Reviewed subject reference and reason |
| Redo | Request a replacement attempt | Reviewed subject reference, retained constraints, and changed direction |

These are interaction primitives, not new core workflow states.

### Locator vocabulary

Phase 1 MUST support document-level, heading or block-level, and text-range locators against an exact material revision.

Future Plane 1 table support MAY add sheet, table, row, column, cell, and cell-range locators.

Future Plane 2 support MAY add pixel region, normalized rectangle, polygon, layer reference, page, frame, timestamp, time range, transcript span, track, clip, or waveform-range locators.

Future Plane 3 support MAY add system, object type, record, field, query-result row, metric, and capture-range locators.

A locator MUST be interpreted only against the exact version or freshness point recorded in the subject.

If the subject has advanced and the locator cannot be relocated deterministically, the product MUST surface a stale-anchor state and request confirmation instead of silently applying the feedback to a guessed location.

### Mapping to human-attention modes

Grounded interaction composes with the existing human-attention model.

- A sensitive external change is an Approval Gate carrying a grounded change preview.
- A missing design choice is an Elicitation Gate carrying candidates and selection controls.
- A correction during active work is Steering Input carrying a material revision, locator, and intent.
- Artifact, diff, material, or candidate evaluation is Review And Acceptance carrying grounded verdicts and annotations.

The payload may be richer, but the lifecycle semantics remain those of the owning mode.

## Plane 1: Workspace-native Material

### Definition

A Workspace-native Material is a user-visible work object whose authoritative editable state is owned by the OpenKit workspace.

Plane 1 examples include Markdown documents, plain-text documents, structured documents, tables, notebook-like pages, plans, and other workspace-maintained materials for which OpenKit intentionally provides native editing.

The current slice supports only Markdown or plain text. Mentioning tables or structured documents in this definition does not place them in the current implementation scope.

### Minimal app-local records

Phase 1 requires three cohesive app-local contracts and MUST NOT introduce a universal resource hierarchy.

`WorkspaceMaterial` owns stable workspace-scoped identity, title, supported material kind, current revision reference, lifecycle metadata, and sensitivity metadata for one natively editable material.

`WorkspaceMaterial` MUST be used only when no more specific owning record already exists. A Knowledge Page retains Knowledge identity, and a future shared editing mechanism must project that identity into revision and Thread-binding behavior rather than wrapping it in a duplicate material identity.

`WorkspaceMaterialRevision` owns one immutable saved content snapshot with material id, revision id, parent revision id, content media type, content digest, author identity, creation time, and canonical content reference.

`ThreadMaterialBinding` owns the explicit association between one Thread working set and one Workspace Material, including the latest queued revision and any user decision to suppress a revision from automatic inclusion.

These contracts are app-local implementation records in the first slice. They MUST NOT be added to stable core concepts until dogfooding proves that their semantics are product-independent and durable.

The exact worker-seen revision MUST be owned by the Context Package trace and applied active-turn Item history, not duplicated as an independently authoritative receipt table.

The worker-produced edit MUST reuse the existing workspace change-set, staged review, and apply-precondition path rather than introducing a second material-only writeback engine.

### Revision contract

Every saved revision MUST be immutable and content-addressed.

The canonical revision representation SHOULD store a complete content snapshot for correctness and simple recovery. Diffs, summaries, extracted structure, and anchor maps are derived representations and MUST be reproducible from canonical revisions.

A normal Web edit MAY use manual save, blur save, or debounced autosave, but NanoCore MUST receive an atomic stable revision rather than one revision per keystroke.

Unsaved client-local edits are not worker-visible and MUST be shown as unsaved in the UI.

Saving several revisions before the next worker turn MUST coalesce the queued handoff to the latest stable revision while preserving historical revisions for comparison and recovery.

### Explicit Thread working-set binding

A material MUST be explicitly bound to a Thread before its revisions can be included automatically in that Thread's worker context.

Viewing a material beside a Thread, having the material open in a browser tab, or editing an unrelated material in the same workspace MUST NOT create an implicit binding.

The UI MUST show the binding and provide an explicit unbind action.

When a bound material receives a new stable revision, NanoCore MUST queue the latest revision for the next eligible worker turn without requiring a separate chat message.

The UI MUST show which revision is queued, which earlier revision the last worker context contained, and whether the change will be included automatically.

The user MUST be able to exclude the queued revision from the next turn or explicitly send it during active work.

### Next-turn handoff

At turn acceptance, NanoCore MUST freeze the exact set of bound material revisions for that turn.

Each selected material entry in the Context Package MUST carry the material id, revision id, parent revision id when applicable, media type, content digest, package-relative materialized path, inclusion reason, and sensitivity decision.

When a prior worker-visible revision exists, the package SHOULD include a derived delta or concise change summary from that exact revision to the newly selected revision.

The full selected revision remains authoritative. A delta or summary is an aid and MUST NOT replace the canonical content when the worker needs the material.

The Context Package trace MUST prove the exact revision and digest the worker was allowed to see.

A revision saved after turn acceptance MUST NOT mutate the frozen Context Package or live worker filesystem. It remains queued for a later turn unless the user invokes explicit active-turn delivery.

### Active-turn delivery

`Send now` is Steering Input, not a live file synchronization command and not a Context Package rewrite.

NanoCore MUST record an ordinary active-turn input Item that references the exact new revision and carries a grounded delta, summary, or selected content suitable for safe-point delivery.

Core and the worker adapter decide whether the input is applied at a safe point, queued after the current turn, or converted into a follow-up turn.

The UI MUST show the authoritative delivery outcome.

If the adapter cannot prove that the active worker received the revision or derived input, NanoCore MUST keep it pending for a later turn rather than marking it applied.

The effective worker-input provenance for an active turn is the immutable initial Context Package plus the ordered active-turn Items that the adapter confirms were applied.

### Worker output and writeback

A worker MUST operate against an immutable materialized input snapshot.

Worker changes MUST NOT mutate the authoritative Workspace Material directly.

A worker-proposed edit MUST identify the base material revision and content digest it used, produce a change set or replacement candidate, and enter staged review.

The review surface MUST let the user compare the worker proposal with the current authoritative revision, inspect grounded changes, accept, request refinement, redo, reject, or defer.

Applying an accepted change MUST use an expected-base precondition.

If the authoritative material still matches the worker base, NanoCore MAY apply the reviewed change and create a new immutable Workspace Material Revision.

If the authoritative material advanced after worker execution began, NanoCore MUST NOT overwrite it. The system MAY present a verified clean merge candidate, but any ambiguous or conflicting merge MUST return to review.

A revision created by accepted worker output MUST remain queued for a later worker turn until the system can prove which final content the worker has seen.

### User authority

Direct user edits are authoritative workspace input.

Worker edits are proposals until the governed apply path accepts them.

The system MUST preserve both the user revision and worker proposal when they diverge.

Redo and refinement MUST NOT delete earlier attempts, accepted annotations, or the provenance that explains the next turn.

### Recovery

After NanoCore restart, the system MUST recover the current material revision, immutable revision history, Thread binding, queued revision, suppression decision, Context Package receipts, pending active-turn delivery, staged worker proposal, review decision, and apply result.

Recovery MUST NOT infer worker visibility from the current material version. It must use recorded Context Package and applied Item provenance.

Missing revision bytes, digest mismatch, or unavailable materialization MUST produce typed recovery or source-unavailable states rather than substitution with the current revision.

### Phase 1 flow

```text
User creates or opens Workspace Material
  -> user explicitly binds material to Thread working set
  -> user saves immutable revision N
  -> NanoCore queues revision N for the next eligible turn
  -> Web shows revision N as queued and allows exclude or send now
  -> next turn freezes revision N into its Context Package
  -> materialization gives the worker revision N and records its digest
  -> worker performs bounded work against revision N
  -> worker returns result and optional change set based on revision N
  -> NanoCore stages the proposed change for review
  -> user accepts, refines, redoes, rejects, or defers
  -> conflict-safe apply creates revision N+1 when accepted
  -> revision N+1 is queued until a later worker turn proves receipt
```

### Phase 1 Web projection

The OpenKit Web UI MUST be sufficient to complete the Plane 1 flow without another desktop agent application.

The Web UI MUST consume NanoCore only through `@openkit/core-client` and MUST NOT access worker files, Core-private paths, or external runtime state directly.

The resource surface MUST support Markdown or text viewing and editing, stable save status, revision history, revision comparison, text selection, grounded annotation, direct patching, Thread binding, queued-inclusion status, exclusion, `Send now`, and staged worker-change review.

The conversation surface MUST show item-backed explanations of material inclusion, active-turn delivery, worker results, conflicts, and review outcomes.

The Action Center MAY project pending material review or stale-write conflicts, but it MUST remain a read model over owning records.

OpenKit-owned stable components SHOULD implement revision comparison, text-range annotation, binding status, and review controls.

A2UI MAY render task-specific forms, bounded parameters, options, tables, or candidate choices. It MUST NOT execute agent-provided code or replace the stable material revision and review components.

## Plane 2: Managed Asset or Bundle

### Definition and boundary

Plane 2 covers work whose meaningful source format is not safely or economically editable through a general OpenKit-native editor.

Examples include images, audio, video, design files, slide project files, Final Cut projects, Photoshop projects, and other opaque or multi-file domain formats.

OpenKit MUST NOT promise native precision editing for arbitrary Plane 2 formats.

OpenKit MAY own the asset identity, versions, lineage, review state, previews, derived representations, and import or export history while bytes live in files, object storage, an artifact backend, or a specialized external service.

### Native OpenKit interaction

The future OpenKit surface MAY provide import, export, preview, version comparison, candidate comparison, selection, ranking, annotation, comments, region or time-range feedback, review verdicts, and handoff status.

Precise domain editing SHOULD occur in a professional workbench or specialized service when the task requires operations beyond these stable primitives.

OpenKit MAY embed a specialized workbench when the provider exposes a secure supported embedding contract, but embedding is not required and does not transfer source-of-truth ownership to the iframe or Web client.

### Bundle contract

A complex project MUST be representable as a bundle rather than being forced into one file.

A future bundle manifest SHOULD identify the primary project file, linked assets, relative paths, content digests, media types, fonts, plugins, dependency notices, proxies, previews, and portability limitations.

OpenKit MAY preserve and transport an opaque bundle without understanding its internal object graph.

Preservation does not imply that OpenKit can open, edit, convert, or guarantee portability for every format.

Format-specific import, export, validation, and round-trip behavior belongs to an Agent Capability, connector, adapter, or Skill-backed workflow with explicit declared capabilities.

### Derived representations

Preview and grounded feedback SHOULD operate against stable derived representations such as thumbnails, page renders, proxy video, waveforms, transcripts, captions, metadata, or flattened previews.

Feedback MUST reference the derived-representation version and its relationship to the authoritative asset or bundle version.

The system MUST NOT pretend that a pixel-region or time-range annotation directly identifies an internal Photoshop layer, Final Cut clip object, or proprietary project node unless a format-specific adapter proves that mapping.

### Deferred implementation

No Plane 2 implementation is authorized in the current phase.

The current inline `Artifact` protocol shape is insufficient for general binary payloads and bundles. Any future implementation must extend artifact payload and storage contracts cleanly rather than encoding binary data or project manifests into the current inline text body.

## Plane 3: External System Resource

### Definition and boundary

Plane 3 covers business, financial, customer, operational, analytics, calendar, ticketing, or other records whose authoritative state remains in an external system.

Examples include CRM customers and opportunities, accounting transactions, ERP orders, support tickets, data-warehouse results, HR records, and calendar events.

OpenKit MUST NOT become the general manager or replacement source of truth for those systems.

### Responsibility split

The Workspace Data Source Catalog identifies and scopes configured external sources.

The Vault owns credentials and grants without exposing secret values.

MCP, API connectors, provider adapters, or Agent Capability routes perform governed reads and writes.

A Skill teaches procedural use and domain workflow, but a Skill is not the connection, credential, authority, or source of truth.

The Context Package supplies bounded task-relevant projections to the worker.

Knowledge preserves reviewed reusable understanding derived from external evidence, not raw replacement records for the external system.

### Read contract

A future external-resource projection MUST preserve source id, external object type, stable external record reference when available, capture time, freshness or `asOf`, query scope, provenance, sensitivity, and content digest where meaningful.

OpenKit MAY show summaries, selected fields, comparisons, action previews, or bounded tables needed for the task.

The product MUST NOT silently inject an entire external system or workspace catalog into worker context.

### Write contract

Any future external write MUST identify the exact target, expected current version or freshness point when supported, proposed change, actor, required permission, policy result, credential grant, audit context, and approval requirement.

Sensitive, destructive, irreversible, financial, customer-facing, or broad writes MUST use the appropriate Approval Gate.

A proposed external change is not complete until the external system confirms the effect and NanoCore records the result or typed failure.

OpenKit MAY provide review, diff, preview, approval, and status surfaces for these actions. It MUST NOT build a full CRM, ERP, accounting, or warehouse administration UI merely to expose the integration.

### Import boundary

An external record remains Plane 3 while it is a live reference or captured projection of the external system.

If the user explicitly imports a record or export as workspace-owned source material, the imported snapshot receives a new OpenKit identity and lineage back to the external source. The import does not change ownership of the original external record.

### Deferred implementation

No Plane 3 interaction or external writeback implementation is authorized in the current phase.

Existing Data Source, Vault, Agent Capability, audit, and Context Package mechanisms remain available as foundations and continue under their owning specs.

## Cross-plane Reference Contract

Every resource-specific projection used for worker context or grounded interaction MUST make the following facts recoverable through its owning records.

| Concern | Required meaning |
| --- | --- |
| Authority | Which workspace, external system, artifact backend, or specialized service owns the authoritative state |
| Identity | A stable typed reference that cannot be confused with another workspace or resource kind |
| Version or freshness | Immutable revision, digest, capture, external version, or `asOf` point |
| Capabilities | What the current actor may view, edit, annotate, export, query, propose, or apply |
| Representation | Which canonical content, preview, proxy, transcript, or other derived representation was used |
| Lineage | Where the resource came from and which output, source, revision, or external record it derives from |
| Sensitivity and policy | Workspace scope, access, redaction, approval, and retention constraints |
| Thread relationship | Whether and why the resource is bound to the Thread working set |
| Worker receipt | Which exact state the worker was allowed to see and which later inputs were confirmed applied |
| Change precondition | Which base state a proposed patch, apply, or external write expects |

These semantics MAY be normalized in client read models, but implementation MUST retain ownership in the existing domain records rather than duplicating all fields into one universal table.

## System Architecture

### OpenKit Web does not depend on a desktop agent host

For Plane 1, the user interacts with the OpenKit Web UI, NanoCore owns material and revision state, and the selected external worker runtime receives a materialized revision through the normal worker context and workspace planes.

```text
OpenKit Web
  -> @openkit/core-client
    -> NanoCore material, Thread, Item, Context Package, review, and audit state
      -> worker adapter and workspace materialization
        -> Codex, OpenCode, Pi, or another worker runtime
```

The worker may run on another process, machine, or service. That deployment difference does not require the user to operate the worker's native desktop application.

### External coordinator agent is optional

An external coordinator agent MAY combine the `openkit` Agent Skill Interface with a specialized domain Skill, tool, or workbench capability. In that topology, OpenKit governs the Thread, goals, approvals, provenance, and result lifecycle while the domain capability owns professional operations.

This is a valid future Plane 2 operating path, but it is not the only path and is not a prerequisite for the OpenKit Web product. Plane 1 remains fully operable through Web and NanoCore, and future Plane 2 integrations may use an external coordinator, an embedded workbench, a linked workbench, or a capability-only workflow according to the evidence for that domain.

### Future specialized workbench topology

A Plane 2 workbench may be external even when its UI is embedded.

```text
OpenKit Web
  -> NanoCore authorization and resource session
    -> specialized workbench service
      -> domain project state and operations
    <- versioned outputs, events, previews, and lineage
  <- review, status, and handoff projection
```

NanoCore SHOULD mediate authorization, resource identity, version lineage, and product-visible events. The specialized workbench SHOULD own its domain editing model and project state.

This topology is a future option, not a Phase 1 requirement and not a commitment to iframe, MCP Apps, ChatCut, or any one embedding protocol.

## Contract / Expected Behavior

### Invariants

- Conversation MUST remain usable without a resource surface, and a resource surface MUST remain traceable to the surrounding Thread when bound.
- A precise interaction MUST reference the exact version or freshness point the user evaluated.
- Feedback MUST be recorded through the owning Item, review, elicitation, approval, or App API path and MUST NOT create a competing hidden communication log.
- A bound Plane 1 stable revision MUST be eligible for automatic next-turn inclusion without a separate user message.
- An unbound or explicitly excluded material MUST NOT be included merely because it changed in the workspace.
- A turn MUST consume an immutable input snapshot.
- A later save MUST NOT mutate an already accepted turn's initial Context Package.
- Active-turn delivery MUST remain ordinary Steering Input and MUST expose whether it was applied, queued, or converted to follow-up work.
- Worker output MUST NOT overwrite newer user work.
- Direct user edits MUST remain authoritative, while worker changes remain proposals until governed apply.
- Artifact identity MUST remain reserved for durable user-visible outputs rather than becoming a universal resource id.
- Knowledge MUST remain reusable curated understanding rather than raw source storage or a replacement external system.
- Plane 2 and Plane 3 implementation MUST remain deferred until Plane 1 acceptance criteria pass and new evidence justifies expansion.

### Error and stale-state behavior

Missing material, missing revision, digest mismatch, invalid binding, stale locator, unavailable derived representation, unauthorized access, policy exclusion, and stale apply precondition MUST produce typed failures.

The system MUST NOT silently substitute the latest revision for a requested historical revision.

The system MUST NOT silently relocate a grounded annotation when the exact target cannot be proven.

The system MUST NOT mark a revision worker-visible unless Context Package or applied active-turn Item provenance proves delivery.

### Audit and privacy

Material creation, revision save, Thread binding, unbinding, queued-inclusion exclusion, active-turn send, worker receipt, staged proposal, review decision, apply result, conflict, export, import, and future external write SHOULD be auditable at the appropriate product level.

Audit and Item projections MUST avoid raw secret values, Core-private paths, external credentials, and unnecessarily duplicated sensitive content.

Workspace boundaries MUST be preserved in material ids, revision lookup, Thread binding, Context Package selection, preview access, derived-representation access, and worker materialization.

## Current Implementation Projection

The accepted contract is not implemented end to end.

The repository already contains important foundations.

- Core defines `Artifact` as a durable user-visible output and keeps Artifact communication item-backed.
- Core communication separates Control, Workspace, Artifact, and Capability planes.
- Active-turn input is ordinary input routed by NanoCore and applied at safe points.
- The Human Attention spec defines Approval Gate, Elicitation Gate, Steering Input, and Review And Acceptance without adding new core workflow objects.
- The Context Package contract already records selected workspace files, Artifacts, Knowledge, Sources, digests, inclusion traces, and replay semantics.
- Workspace synchronization already captures worker input snapshots, materialization records, worker change sets, staged review, preflight, conflict checks, apply, and recovery.
- The Workspace Data Source Catalog, Vault, Agent Capability, audit, and usage paths provide foundations for future Plane 3 work.
- The Web rebuild spec already selects A2UI for declarative agent-generated UI and prohibits arbitrary agent-provided code.

The missing Plane 1 path includes Workspace Material identity, immutable revisions, explicit Thread bindings, automatic next-turn queueing, material-specific Context Package projection, worker-seen revision presentation, grounded text feedback, Web editing and comparison, and the connection between material revision preconditions and existing staged workspace apply.

The current protocol `ArtifactSchema` supports only inline `markdown`, `text`, or `json` content and `report`, `diff`, `file`, or `summary` kinds. It MUST NOT be stretched into the Plane 2 bundle model during Phase 1.

## Proposed Design

### Phase 1 ownership map

| Layer | Phase 1 responsibility |
| --- | --- |
| `packages/protocol` and shared schemas | Stable ids and any cross-client material, revision, binding, grounded-input, and item-reference contracts proven necessary |
| `apps/nanocore` | Material revision authority, binding state, next-turn selection, Context Package trace, active-turn routing, staged review linkage, conflict checks, recovery, audit, and App API |
| `packages/core-client` | Typed material, binding, save, compare, queue, exclusion, send, and review operations |
| `apps/web` | Native Markdown or text editor, revision status, compare, annotation, Thread binding, queued inclusion, send-now feedback, and review UI |
| Worker adapter | Immutable materialization, applied-input acknowledgement, output manifest, base revision or digest, and safe interruption behavior |

### Phase 1 read model

The client SHOULD receive one cohesive Thread material projection that includes the bound material identity, current saved revision, queued revision, last worker-seen revision derived from provenance, current turn's frozen revision when present, pending active-turn delivery, staged proposal, conflict state, and available actions.

This projection is a read model. The canonical material revision, binding, Context Package, Item, and review records remain the sources of truth.

### Phase 1 command surface

The implementation MUST provide typed operations for creating or reading a supported material, saving an expected-base revision, listing revisions, reading or comparing revisions, binding or unbinding a material to a Thread, excluding or restoring the queued revision, sending a queued revision to an active turn, reading handoff status, and reviewing or applying a worker proposal.

Every mutating command MUST use request-id idempotency and expected-base semantics where concurrent changes can occur.

The Web and external Agent Skill Interface MUST consume public governed operations instead of reaching into NanoCore storage.

## Alternatives Considered

### Treat all three planes as Artifact kinds

Rejected. It would turn a durable output role into a universal resource model, blur editable source material with deliverables and external records, and conflict with existing Artifact, Knowledge Source, Data Source, and Context Package ownership.

### Keep interaction text-only

Rejected. The worker would have to infer target, location, candidate, and exact correction even when the UI already knows them, reducing precision in planning, taste calibration, and review.

### Add strong and weak interaction modes

Rejected. Interaction intensity changes within one Thread, while existing attention modes already own lifecycle semantics. A new mode would duplicate workflow state without improving grounding.

### Build a universal editor or workbench host

Rejected. Domain editors have incompatible state models, operations, performance needs, and file semantics. OpenKit should own stable compare, annotation, review, handoff, and governance primitives and integrate specialized workbenches only when justified.

### Require a desktop agent application for rich interaction

Rejected for Plane 1. OpenKit Web can edit materials and send versioned intent through NanoCore while the worker runs elsewhere. Requiring Codex or another desktop host would make the main product surface incomplete.

### Embed specialized workbenches as the primary architecture

Rejected. Embedding is one future presentation option and does not solve identity, lineage, authorization, worker handoff, or source-of-truth ownership by itself.

### Inject every workspace edit into the active Thread

Rejected. Workspace presence is not Thread intent. Automatic inclusion requires an explicit working-set binding and a stable saved revision.

### Stream every edit into the active worker filesystem

Rejected. It breaks immutable input provenance, creates races with worker writes, and requires live coediting semantics that the current product does not need.

### Adopt CRDT or operational transformation in Phase 1

Rejected. The product currently needs a versioned publish and handoff barrier, not simultaneous character-level editing by human and worker.

### Mirror external systems into OpenKit

Rejected. CRM, ERP, accounting, warehouse, and other domain systems retain authoritative records. OpenKit supplies bounded context and governed operations around them.

## Consequences

### Positive

- The product preserves autonomous work while supporting precise intent at the moments where human judgement matters.
- The Web UI becomes a complete interaction surface for the first native material flow even when the worker runtime is remote.
- Worker inputs become explainable through exact revisions and applied steering records.
- User edits and worker changes can coexist without silent overwrite.
- Artifact, Knowledge, Data Source, Context Package, and external-system boundaries remain coherent.
- Plane 2 and Plane 3 can later reuse stable feedback and reference semantics without forcing their domain state into OpenKit.

### Costs

- Phase 1 requires new app-local material, revision, binding, read-model, and public API surfaces.
- Revision persistence, context assembly, materialization, review, and Web UI must align across protocol, NanoCore, Core Client, and Web.
- Grounded anchors require stale-state behavior and cannot be treated as decorative UI metadata.
- Exact worker receipt requires durable provenance for both initial context and applied active-turn input.

## Rollout / Migration Plan

OpenKit is in internal development. The implementation MUST use the clean target without compatibility aliases or dual internal record shapes.

### Stage 0: Documentation authority

- Accept this spec and its change plan.
- Add the spec to the active index.
- Keep existing Artifact, Knowledge, Context Package, workspace synchronization, and Data Source specs as owners of their existing contracts.

### Stage 1: Freeze Plane 1 contracts with tests

- Define the smallest Workspace Material, immutable revision, and Thread binding schemas needed for one Markdown or text material.
- Define expected-base save semantics, queue coalescing, exclusion, and read-model behavior.
- Define Context Package material entries and exact revision trace behavior.
- Define grounded text locators and active-turn material-reference input.
- Write schema, contract, concurrency, and recovery tests before implementation.

### Stage 2: Implement NanoCore material authority and public operations

- Persist materials, immutable revisions, and Thread bindings in workspace-owned storage.
- Expose public App API and Core Client operations.
- Project queued and worker-seen state without duplicating provenance ownership.
- Add audit and typed error behavior.

### Stage 3: Complete worker handoff and writeback

- Freeze queued revisions at turn acceptance.
- Materialize the exact revision into the worker Context Package and workspace plane.
- Record worker receipt through package traces and active-turn delivery acknowledgements.
- Connect worker proposals and expected-base revisions to existing staged workspace review, conflict, and apply behavior.
- Verify restart recovery and digest failure behavior.

### Stage 4: Implement the Web material surface

- Add Markdown or text editing and stable revision save.
- Add explicit Thread binding, queued-inclusion state, exclusion, and send-now controls.
- Add revision comparison, text-range annotation, direct patching, and worker-proposal review.
- Keep server state in the Core Client and Web server-state layer rather than duplicating authority in client state.

### Stage 5: Dogfood and close Phase 1

- Run deterministic L0-L5 coverage and agent-first L6 stories.
- Dogfood through the OpenKit Agent Skill Interface and the Web UI against real worker runtimes.
- Record whether automatic next-turn inclusion is understood and trusted.
- Do not begin Plane 2 or Plane 3 implementation until all Phase 1 acceptance criteria pass.

## Testing Strategy / Acceptance Criteria

### L1 schema and unit coverage

- Material ids, revision ids, parent linkage, digests, media types, sensitivity, and expected-base validation are deterministic.
- A saved revision is immutable.
- Multiple saves coalesce the queued handoff to the latest stable revision without deleting history.
- An unrelated or unbound material is never selected.
- A stale text locator is rejected or surfaced for confirmation.
- A duplicate mutating request id does not create a duplicate revision, binding, or review decision.

### L2 contract and conformance coverage

- App API, Core Client, Context Package, Item references, and Web read models agree on material and revision identity.
- A Thread binding is explicit, workspace-scoped, and cannot reference another workspace.
- The initial Context Package and later applied active-turn inputs together reconstruct effective worker input.
- Artifact schemas remain unchanged by the Plane 1 slice unless a separately accepted need arises.

### L3 NanoCore black-box coverage

- A bound revision is frozen into the next turn even when the user sends no separate message about the edit.
- A revision saved after turn acceptance remains queued and does not mutate the running worker input.
- Excluding a queued revision prevents inclusion.
- `Send now` records Steering Input and reports applied, queued, or follow-up delivery truthfully.
- Restart preserves bindings, queues, exact worker-seen revisions, pending deliveries, proposals, and review state.
- Missing bytes, digest mismatch, stale base, and cross-workspace references fail closed.

### L4 Web browser coverage

- The user can edit and save a Markdown or text material, bind it to a Thread, see the queued revision, exclude it, or send it now.
- The user can compare revisions, select text, create grounded feedback, and see its exact revision anchor.
- The user can compare a worker proposal against the current revision and accept, refine, redo, reject, or defer.
- The UI never claims that a worker saw a revision without server provenance.
- The complete Phase 1 flow works without opening a desktop worker application.

### L5 health and integrity coverage

- Every material revision referenced by a Context Package or staged proposal can be resolved and digest-verified.
- Orphaned revisions, missing canonical content, invalid parent chains, and unresolved pending handoffs are reported by health checks.
- Backup, export, import, and recovery preserve material identity, revision history, bindings, and provenance according to their owning specs.

### L6 story acceptance

The canonical story MUST prove the following sequence.

1. A user creates a Thread and binds a Markdown material at revision 1.
2. A worker turn receives revision 1, and its Context Package records revision 1 and its digest.
3. The user edits the material and saves revision 2 without sending a separate chat message.
4. The UI shows revision 2 queued for the next eligible worker turn and identifies revision 1 as the last worker-seen revision.
5. The next turn receives revision 2 plus a traceable delta or summary from revision 1.
6. The worker produces a proposal based on revision 2.
7. The user edits the material to revision 3 while the proposal is pending.
8. Accepting the stale proposal does not overwrite revision 3 and instead produces a conflict or verified merge review.
9. Restarting NanoCore preserves every revision, binding, receipt, proposal, and pending decision.

Additional acceptance stories MUST prove unrelated-material exclusion, explicit queued-revision exclusion, active-turn send-now delivery, stale-anchor handling, workspace privacy, and worker proposal redo without deletion of prior attempts.

## Risks & Mitigations

- **Implicit inclusion surprises users.** Mitigation: require explicit Thread binding, show the queued revision and exact next-turn behavior, and provide one-step exclusion.
- **Autosave creates noisy revisions.** Mitigation: commit only stable coalesced saves and queue only the latest stable revision while retaining deliberate history.
- **Worker and user overwrite each other.** Mitigation: immutable worker input, base revision and digest, staged review, and expected-base apply.
- **Worker receipt becomes ambiguous.** Mitigation: Context Package trace plus applied active-turn Item acknowledgement are the only receipt authorities.
- **Grounded anchors drift.** Mitigation: exact revision anchoring, deterministic relocation only, and stale-anchor confirmation when proof is unavailable.
- **The taxonomy becomes a universal abstraction.** Mitigation: keep the planes as classification and reuse owning domain records rather than introducing a universal resource table.
- **Phase 2 scope leaks into Phase 1.** Mitigation: reject binary bundle, workbench, and external-writeback implementation until Phase 1 acceptance passes.
- **The Web becomes a heavy domain editor.** Mitigation: implement only stable native material primitives and keep professional editing in specialized workbenches when later evidence requires it.

## Stop Rules

If dogfooding shows that users cannot predict or trust automatic next-turn inclusion despite explicit binding and visible queue state, Phase 1 MUST shrink the behavior to an explicit `Publish to Thread` action rather than adding increasingly complex heuristics.

If the worker adapter cannot prove safe active-turn receipt, `Send now` MUST degrade to queued follow-up work rather than live filesystem mutation.

If two later complex asset types fail to share meaningful identity, preview, annotation, bundle, and round-trip primitives, OpenKit MUST NOT build a universal Plane 2 protocol; each capability should remain format-specific behind the common review and lineage boundary.

If a future external integration requires OpenKit to mirror a domain system to function, the design MUST be re-reviewed before implementation rather than silently turning NanoCore into that system of record.

## Open Questions

There are no blocking open questions for the Phase 1 contract.

- [Non-blocking] The exact text-anchor encoding may be chosen during test-first implementation as long as it preserves exact revision anchoring, deterministic validation, and stale-state behavior.

## Deferred / Future Work

- Additional Plane 1 material kinds such as structured documents, tables, spreadsheets, and notebook surfaces.
- Cross-material compare, candidate ranking, and richer parameter controls after the Markdown or text slice proves the primitive set.
- Plane 2 asset identity, binary payload storage, bundle manifests, derived-representation pipelines, specialized workbench sessions, and capability-declared round trips.
- Plane 2 image, audio, video, page, region, frame, time-range, transcript, track, and clip locator contracts.
- Plane 3 record projections, freshness models, query results, action previews, external write preconditions, confirmation receipts, and domain-specific approvals.
- Evidence-driven embedded workbench integration, including secure session creation, origin restrictions, event exchange, version handoff, and failure recovery.
- Promotion of proven app-local material semantics into stable core concepts only if multiple clients and runtimes demonstrate a durable product-independent contract.
- Multi-user coediting only after a demonstrated requirement exceeds versioned handoff and publish barriers.

## Resolved Decisions

- OpenKit is not purely weak-interaction; it is delegated by default and high-bandwidth when human judgement requires it.
- Conversation-first does not mean text-only.
- Rich interaction is grounded feedback over existing human-attention modes, not a new strong-interaction workflow mode.
- The three categories are work-resource planes, not Artifact kinds.
- Artifact remains a durable user-visible output role.
- Knowledge remains a cross-cutting semantic layer and external systems retain their authoritative records.
- OpenKit Web can complete Plane 1 without a desktop agent application even when execution occurs in an external worker runtime.
- Plane 1 uses explicit Thread binding, stable revisions, visible automatic next-turn queueing, immutable worker input, and conflict-safe staged writeback.
- Plane 2 supports future compare, annotation, review, import, export, and specialized-workbench handoff without promising universal editing.
- Plane 3 uses Data Source, Vault, Agent Capability, connector, Skill, Context Package, approval, and audit boundaries without becoming a domain-system UI.
- The current phase implements only the complete Plane 1 chain, beginning with one thread-bound Markdown or plain-text material.

## Links

- [Change Plan](../changes/202607132212000001-work_resource_interaction_model.md)
- [Product Vision](../product-vision.md)
- [Core Concepts](../core/core-concepts.md)
- [Communication Model](../core/communication.md)
- [Knowledge Model](../core/knowledge.md)
- [Human Attention And Intervention Model](./20260531-human_attention_intervention_model.md)
- [Worker Context Package](./20260703-worker_context_package.md)
- [Workspace Synchronization](./20260703-workspace_synchronization.md)
- [Workspace Data Source Catalog](./20260704-workspace_data_source_catalog.md)
- [Worker MCP Tool Supply](./20260704-worker_mcp_tool_supply.md)
- [Web UI Rebuild Stack](./20260710-web_ui_rebuild_stack.md)
- [OpenKit Agent Skill Interface](./20260713-openkit_agent_skill_interface.md)
