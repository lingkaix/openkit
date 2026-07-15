# Work Resource Interaction Model

Type: change-plan
Status: planned
Canonical Spec: `docs/specs/20260713-work_resource_interaction_model.md`

## Intent

Establish the accepted OpenKit interaction model for precise human intent across workspace-native materials, managed assets or bundles, and external-system resources, while preserving existing Artifact, Knowledge, Context Package, human-attention, and external-system boundaries.

The implementation goal is deliberately narrower than the complete taxonomy. The current phase will implement only the complete Plane 1 lifecycle for one Thread-bound Markdown or plain-text material.

This record starts with documentation authority and implementation planning. No behavior change is included in the initial documentation checkpoint.

## Decision Summary

- The product posture is delegate by default, collaborate on demand, and govern throughout.
- Default interaction is low interruption and high control, while high-bandwidth grounded interaction is available for intent, planning, comparison, taste calibration, precise correction, and review.
- Conversation-first does not mean text-only; conversation carries narrative and coordination, while work-resource surfaces carry exact target, location, value, and review intent.
- Rich interaction reuses Approval Gate, Elicitation Gate, Steering Input, and Review And Acceptance rather than adding a strong-interaction mode.
- Work resources are classified into Workspace-native Material, Managed Asset or Bundle, and External System Resource planes according to authority, editability, and capability.
- The three planes are not Artifact kinds, and no universal Resource core entity will be introduced.
- Artifact remains the durable user-visible output role, while Knowledge remains a cross-cutting semantic layer.
- The current implementation phase covers only Workspace-native Material and begins with one Markdown or plain-text document explicitly bound to a Thread.
- A stable revision of a bound material is queued visibly for the next worker turn without requiring a separate user message.
- The worker consumes an immutable revision snapshot, exact receipt is recorded through Context Package or applied Steering Input provenance, and worker changes use staged review plus conflict-safe expected-base apply.
- OpenKit Web must complete the Plane 1 experience without requiring Codex or another desktop agent application.
- Managed assets, professional workbenches, binary bundles, external-system interaction, and external writeback remain defined boundaries but deferred implementation.

## Scope

### Documentation authority

- Add `docs/specs/20260713-work_resource_interaction_model.md` as the canonical accepted design.
- Add the new spec to the active specification index.
- Preserve the existing core definitions and ownership boundaries for Artifact, Knowledge, Item, Context Package, Data Source, Agent Capability, Workspace Synchronization, and human attention.
- Record Plane 2 and Plane 3 boundaries only to prevent Phase 1 implementation from creating incompatible ownership or data models.

### Phase 1 material identity and revision lifecycle

- Add the smallest app-local Workspace Material, immutable Workspace Material Revision, and Thread Material Binding contracts needed by one Markdown or plain-text material.
- Keep complete immutable content revisions canonical and treat diffs, summaries, anchor maps, and structural extraction as derived representations.
- Require expected-base semantics, content digests, request-id idempotency, workspace scope, and recoverable parent linkage.
- Coalesce several stable saves into the latest queued next-turn handoff while preserving revision history.
- Keep unsaved client drafts outside worker-visible state.

### Thread working set and worker handoff

- Require explicit Thread binding before a material revision can be selected automatically.
- Queue a new stable revision for the next eligible worker turn without requiring a separate chat message.
- Let the user see, exclude, restore, or explicitly send the queued revision.
- Freeze exact revision ids and digests at turn acceptance.
- Project the selected material into the Context Package and worker workspace with material id, revision id, parent, digest, media type, inclusion reason, sensitivity, and package-relative path.
- Derive the last worker-seen revision from Context Package and applied active-turn Item provenance rather than creating a second receipt authority.

### Grounded feedback and active-turn input

- Support document-level, heading or block-level, and text-range locators against exact revisions.
- Support the Plane 1 subset of compare, annotate, keep, change, remove, patch, accept, reject, and redo.
- Represent `Send now` as ordinary Steering Input carrying an exact material revision and grounded delta, summary, or selected content.
- Report applied, queued, or follow-up delivery truthfully and never mutate the frozen initial Context Package or live worker filesystem.

### Worker proposal, review, and apply

- Require worker proposals to identify the base material revision and digest.
- Reuse existing Workspace Change Set, staged review, Action Center, conflict, apply-preflight, and recovery paths.
- Let users compare, accept, refine, redo, reject, or defer worker-proposed changes.
- Prevent silent overwrite when the authoritative material advances after worker execution begins.
- Create a new immutable material revision after accepted conflict-safe apply.

### Web product surface

- Provide Markdown or text viewing and editing through the public Core Client boundary.
- Show saved, unsaved, queued, excluded, frozen-for-turn, worker-seen, pending-delivery, proposal, and conflict states.
- Provide explicit Thread binding, revision comparison, text-range annotation, direct patch, send-now, and proposal review.
- Keep A2UI available for task-specific bounded controls without using it to replace stable material or review components.
- Complete the entire Phase 1 user story in OpenKit Web without opening a desktop worker application.

## Non-Goals

- No Plane 2 binary asset, bundle, preview, media annotation, workbench session, import, export, or round-trip implementation in the current phase.
- No Plane 3 external-record interaction or external writeback implementation in the current phase.
- No ChatCut compatibility requirement, MCP Apps host, iframe platform, workbench marketplace, or universal plugin protocol.
- No full media, design, timeline, spreadsheet, or project-file editor.
- No Final Cut, Photoshop, or arbitrary project-format converter.
- No CRM, ERP, accounting, warehouse, HR, ticketing, or calendar administration UI.
- No `native`, `media`, or `external` Artifact kinds.
- No universal Resource table, hierarchy, or protocol object.
- No Strong Interaction Mode or Weak Interaction Mode.
- No ambient inclusion of unrelated workspace edits.
- No per-keystroke worker input, live active-worker filesystem mutation, CRDT, operational transformation, or real-time multi-user coediting.
- No backward-compatibility aliases or dual internal record shapes.

## Related Context

- [Core Architecture](../core/architecture.md)
- [Core Concepts](../core/core-concepts.md)
- [Work Model](../core/work-model.md)
- [Communication Model](../core/communication.md)
- [Knowledge Model](../core/knowledge.md)
- [Agent Workflow](../core/agent-workflow.md)
- [Agent Capability](../core/agent-capability.md)
- [Permissions](../core/permissions.md)
- [Audit](../core/audit.md)
- [Product Vision](../product-vision.md)
- [Work Resource Interaction Model](../specs/20260713-work_resource_interaction_model.md)
- [Human Attention And Intervention Model](../specs/20260531-human_attention_intervention_model.md)
- [Worker Context Package](../specs/20260703-worker_context_package.md)
- [Workspace Synchronization](../specs/20260703-workspace_synchronization.md)
- [Workspace Data Source Catalog](../specs/20260704-workspace_data_source_catalog.md)
- [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md)
- [Web UI Rebuild Stack](../specs/20260710-web_ui_rebuild_stack.md)
- [OpenKit Agent Skill Interface](../specs/20260713-openkit_agent_skill_interface.md)
- [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md)

## Current Baseline

- Core already defines Artifact as a durable user-visible output and keeps Artifact events item-backed.
- Core communication already separates Control, Workspace, Artifact, and Capability planes.
- Core already treats active-turn steering as ordinary input applied at safe points.
- NanoCore already exposes human attention through approval, elicitation, steering, review, and Action Center projections.
- Context Packages already support workspace files, Artifacts, Knowledge, Sources, content digests, selection traces, materialization, and replay.
- Workspace Synchronization already owns input snapshots, worker materialization, change sets, staged review, preflight, conflict detection, apply, evidence, and recovery.
- Workspace Data Source, Vault, Agent Capability, audit, and usage contracts already provide foundations for future external-system work.
- The current Artifact protocol remains an inline text or JSON shape and is not suitable as a universal binary bundle contract.
- The repository does not currently expose the complete Workspace Material identity, immutable revision, explicit Thread binding, visible next-turn queue, and exact worker-receipt flow required by Phase 1.

## Impacted Surfaces

- `packages/protocol`
- `packages/app-api-schemas`
- `packages/core-client`
- `apps/nanocore`
- `apps/web`
- worker Context Package and workspace materialization projections
- workspace storage, export, import, backup, recovery, audit, and health checks
- Action Center and staged workspace review projections
- L0-L6 tests and agent-first acceptance stories
- relevant core, product, spec, cookbook, and app or package README guidance as implementation lands

## Execution Plan

### Stage 0: Documentation authority

- Accept the canonical spec and link it from the active index.
- Verify lifecycle metadata, links, English-only repository text, Markdown formatting, and whitespace.
- End the initial documentation turn without behavior changes.

### Stage 1: Test-first shared contract slice

- Select the smallest cohesive schemas for Material, Revision, Thread Binding, grounded text reference, and the Thread material read model.
- Write failing L1 and L2 tests for immutable revision save, expected base, idempotency, explicit binding, queue coalescing, exclusion, cross-workspace denial, and stale locators.
- Define material Context Package entry and worker proposal base-revision requirements through tests.
- Keep app-local fields out of stable core protocol unless multiple clients or runtimes demonstrably need them.

### Stage 2: NanoCore material authority

- Implement workspace-owned persistence, revisions, bindings, public App API operations, Core Client methods, typed errors, audit, export, import, backup, and recovery.
- Project one cohesive Thread material read model while deriving worker-seen state from owning provenance records.
- Verify that unrelated materials and unsaved drafts cannot enter worker context.

### Stage 3: Worker context and active-turn handoff

- Freeze queued revisions during turn acceptance.
- Materialize the exact content and digest into the Context Package and worker workspace.
- Include a delta or summary from the last worker-seen revision when useful without replacing the full selected revision.
- Implement `Send now` through ordinary Steering Input and applied-input acknowledgement.
- Keep later saves queued and never rewrite the running turn's initial Context Package.

### Stage 4: Worker proposal and conflict-safe apply

- Connect worker output base revision and digest to existing Workspace Change Set and staged review records.
- Add compare, review verdict, expected-base apply, clean-merge candidate, conflict, and recovery tests before implementation.
- Preserve both user state and worker proposal when concurrent edits diverge.

### Stage 5: Web material surface

- Implement the native Markdown or text editor, stable save behavior, Thread binding, queue status, exclusion, send-now, revision comparison, text annotation, patch, and proposal review.
- Use the rebuilt Web stack and Core Client boundary.
- Keep stable resource interactions in OpenKit-owned components and use A2UI only for contextual bounded controls.

### Stage 6: Phase 1 verification and dogfooding

- Run L0-L5 deterministic checks and the canonical L6 story with real worker runtimes.
- Dogfood from both the Agent Skill Interface and OpenKit Web.
- Verify the user can predict what the worker will receive and can recover every revision and decision after restart.
- Close this record only after the complete Plane 1 acceptance chain passes.
- Create a separate accepted spec and change plan before beginning any Plane 2 or Plane 3 implementation.

## Verification Plan

### Documentation checkpoint

- `node scripts/validate-spec-lifecycle.mjs`
- `git diff --check`
- Relative-link validation for the new spec, change plan, and active index entry.
- Repository check proving the new accepted spec appears in the active index.
- Review proving the spec does not redefine Artifact, Knowledge, Data Source, Context Package, or the four human-attention modes.

### Implementation checkpoints

- L1 schema, revision, digest, locator, queue, idempotency, and concurrency tests.
- L2 App API, Core Client, Context Package, Item reference, staged review, and read-model conformance tests.
- L3 NanoCore black-box tests for automatic next-turn inclusion, explicit exclusion, send-now routing, restart, digest failure, stale apply, and workspace isolation.
- L4 browser tests for editing, binding, status, compare, annotation, send-now, and proposal review.
- L5 revision integrity, provenance, export, import, backup, recovery, and health checks.
- L6 agent-first story proving revision 1 receipt, user-only revision 2 save, automatic next-turn receipt, concurrent revision 3 conflict, and restart recovery.
- Repository-wide lint, typecheck, test, build, smoke, artifact-health, and story gates required by the accepted L0-L6 model.

## Expected Handoff Points

- Stage 0 ends the documentation-only checkpoint and hands the accepted contract into test-first implementation planning.
- Stage 1 must finish before Material, Revision, or Thread Binding production code is written.
- Stage 2 must establish authoritative persistence and public operations before Web implementation begins.
- Stage 3 must prove exact worker receipt before the UI may claim a revision was seen.
- Stage 4 must prove stale writes cannot clobber user work before proposal apply is exposed broadly.
- Stage 5 must remain within the Markdown or plain-text slice.
- Stage 6 must pass before Plane 2 or Plane 3 design is promoted into implementation.

## Known Risks

- **Scope expansion:** the three-plane taxonomy may be mistaken for authorization to build all three planes. Mitigation: only Plane 1 appears in current implementation stages and acceptance criteria.
- **Artifact boundary drift:** implementation may try to reuse the existing Artifact schema for editable materials. Mitigation: keep Artifact as output and introduce only the minimal app-local Material contracts.
- **Duplicate truth:** a convenient read model may become a second worker-receipt ledger. Mitigation: derive receipt from Context Package traces and applied active-turn Items.
- **Implicit inclusion confusion:** users may not understand why a change reached a worker. Mitigation: explicit Thread binding, visible queued revision, exclusion, and a stop rule that falls back to explicit `Publish to Thread`.
- **Concurrent overwrite:** worker output may be based on an older revision. Mitigation: base revision and digest, staged review, expected-base apply, and conflict preservation.
- **Premature abstraction:** a universal resource or locator system may be added for predicted formats. Mitigation: implement only text locators and Phase 1 records, then generalize from evidence.
- **Web/runtime coupling:** the Web may attempt to access worker files directly. Mitigation: all interaction goes through Core Client and NanoCore-owned references and state.

## Stop Rules

- If visible automatic inclusion remains confusing during dogfooding, replace it with explicit `Publish to Thread` rather than adding heuristics.
- If safe active-turn receipt cannot be proven, route `Send now` into a queued follow-up rather than mutating live worker state.
- If later complex asset types do not share useful bundle and annotation primitives, do not build a universal Plane 2 protocol.
- If external integration requires mirrored domain ownership, pause and re-review the architecture before implementation.

## Checkpoints

- 2026-07-13 — Accepted the delegated-by-default, collaborate-on-demand, govern-throughout interaction posture.
- 2026-07-13 — Accepted the three-plane classification and rejected treating the planes as Artifact kinds.
- 2026-07-13 — Accepted grounded feedback over existing human-attention modes and rejected a separate strong-interaction mode.
- 2026-07-13 — Accepted OpenKit Web as a complete Plane 1 interaction host independent of desktop worker applications.
- 2026-07-13 — Restricted the current implementation phase to the complete Workspace-native Material chain, beginning with one Thread-bound Markdown or plain-text material.
- 2026-07-13 — Documentation authority checkpoint completed; implementation remains planned.
