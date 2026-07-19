# Work Resource Interaction Model

Type: change-plan
Status: in-progress
Canonical Spec: `docs/specs/20260713-work_resource_interaction_model.md`

## Intent

Establish the accepted OpenKit interaction model for precise human intent across workspace-native materials, managed assets or bundles, and external-system resources, while preserving existing Artifact, Knowledge, Context Package, human-attention, and external-system boundaries.

The implementation goal is deliberately narrower than the complete taxonomy. WP-4 implements the Plane 1 kernel lifecycle for one Thread-bound Markdown or plain-text material through Stage 4; the rebuilt Web projection and its Web-dependent acceptance remain part of the accepted Plane 1 target but are sequenced into the post-program S10 work.

This record starts with documentation authority and implementation planning. No behavior change is included in the initial documentation checkpoint.

## Absorbed G01 Evictions (2026-07-17)

This plan is work package WP-4 of the [OpenKit Execution Program](./202607172152230001-openkit_execution_program.md). The alignment audit's G01 closeout evicted these items here per the program eviction map: the S16 Material identity, immutable revision, Thread binding, inclusion queue, reads, typed expected-base rejection, restart, and portable-export slice; the S39 Context Package trace, Goal steering delivery, and `lastWorkerSeenRevisionId`; the exact Artifact command surface (introduction, workspace-only import, deterministic refine and redo); Material worker proposal and conflict-safe writeback implementation after the WP-3 G05/C09 owner decision; and the final projections plus minimal acceptance for those items.

The program's convergence rules bind all work here. G01's accepted contract decisions recorded in the audit checkpoints (Material command shapes, steering serialization, fail-closed delivery predicates, Artifact authority tuples) are design inputs to reuse, not targets to reopen.

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
- The worker consumes an immutable revision snapshot, exact availability is proven through an accepted Context Package, and worker changes use the version-keyed Artifact Review plus conflict-safe expected-base apply.
- Worker transcript closeout collects declared Artifact bytes through the existing retained stock OpenShell session, rejects bounded or exact-secret violations before canonical writes, and creates the exact Artifact, reference Item, and version-owned Review without another transfer service.
- Artifact Review decisions now use the version-keyed Workspace SQLite owner; accepted Material proposals apply in its existing transaction, while refinement and redo retain exact prior Artifact, media, feedback, Agent, Turn, admission, and S39 request lineage with bounded `recovery_required` gaps.
- S51 now exports, validates, remints, and revalidates the related Material, Revision, Binding, Review, and Context Package graph as non-authorizing imported history, including one focused re-export and re-import proof for that subgraph.
- OpenKit Web must complete the Plane 1 experience without requiring Codex or another desktop agent application; that release-coupled projection is deferred to the post-program S10 rebuild rather than implemented temporarily on the retiring Solid stack.
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
- Derive the last worker-seen revision from the accepted Context Package and verified materialization provenance rather than creating a second receipt authority.

### Active-turn input

- Represent `Send now` as ordinary Steering Input carrying one exact Material revision under the existing Goal pending-input owner.
- Report unrecorded rejection, queued, applied, follow-up, or cancelled delivery truthfully and never mutate the frozen initial Context Package or live worker filesystem.
- Use one immutable `SteeringTerminalOutcome` only for follow-up and cancellation; commit that outcome, its body-free receipt, and pending-row deletion in the same final Workspace transaction after any required deterministic follow-up Turn and Item verify. Keep applied proof in S39 and add no terminal lifecycle or recovery workflow.
- Keep grounded annotation, text-range patching, locators, and compare-driven feedback outside this change; they require a separate accepted specification.

### Worker proposal, review, and apply

- Represent a worker proposal as one immutable turn-output Artifact version only when its producing operation explicitly supplies one candidate Material tuple that matches exactly one entry in the same source Turn's accepted S39 trace; absence is not a proposal and ambiguity fails closed.
- Reuse that `ArtifactReview`, the existing Material owners, and one `workspace.sqlite` transaction for decision, expected-base apply, bound-queue coalescing, applied-revision identity, and receipt; do not reuse Workspace Sync or add proposal, apply-result, settlement, or recovery records.
- Let users compare, accept, refine, redo, reject, or defer worker-proposed changes.
- Return `conflict` with the Review still pending and zero writes when the authoritative Material has advanced; do not merge or rebase.
- Create exactly one immutable Material revision from the reviewed Artifact bytes after accepted conflict-safe apply, with the decision actor as revision author and worker attribution retained in the Review source lineage.

### Web product surface

- Provide Markdown or text viewing and editing through the public Core Client boundary.
- Show saved, unsaved, queued, excluded, frozen-for-turn, worker-seen, pending-delivery, proposal, and conflict states.
- Provide explicit Thread binding, revision comparison, send-now, and proposal review.
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
- Core requires accepted Steering Input to have one owning delivery path and authoritative outcome without prescribing adapter mechanics.
- NanoCore exposes human attention through approval, elicitation, review, and Action Center projections; Action Center now also projects the exact unresolved Goal steering owner without becoming command authority.
- The generic direct-Turn path now returns typed `thread_busy` before recording implicit input when another Turn owns the Thread.
- Goal steering now accepts one exact message or non-restricted current Material revision only for a checkpoint-backed active Goal Turn, retains one Thread-unique pending owner, and replays from the existing command ledger. Applied delivery requires the exact S39 trace; terminal follow-up and cancellation preserve immutable historical lineage without a generic queue or live worker mutation.
- The former generic queue, recovery actions, public seed, and dedicated recovery runner remain deleted. Goal-specific pending ownership, applied cleanup, terminal conversion, cancellation, and restart projection reuse the Item, Goal, Turn, Context Package, command receipt, and one Workspace outcome owner instead of recreating that platform.
- Artifact records now carry exact current-content digest, mutation-request proof, and immutable turn-output or direct-import origin. NanoCore implements workspace-only direct import and idle-Thread introduction through the App API and Core Client; introduction creates one deterministic completed Core-local Turn and exact `artifact-reference` Item while preserving the imported Artifact's null top-level Thread and Turn. A request-owned Artifact authority footprint without its cross-store receipt fails closed as `recovery_required`.
- Knowledge-specific Context Packages support workspace files, Artifacts, Knowledge, Sources, content digests, selection traces, materialization, and replay. Real Task and Goal worker launches now also persist and verify the separate S39 worker-Turn `context-package.json` owner, exact generated `context` handoff, Material selection or exclusion, and backend-session lineage before launch.
- Workspace Synchronization already owns input snapshots, worker materialization, change sets, staged review, preflight, conflict detection, apply, evidence, and recovery.
- Workspace Data Source, Vault, Agent Capability, audit, and usage contracts already provide foundations for future external-system work.
- The current Artifact protocol remains an inline text or JSON shape and is not suitable as a universal binary bundle contract.
- NanoCore owns exactly three Workspace Material tables, immutable linear revisions, singular Thread bindings, queue coalescing, the closed Thread material read model, and eleven public Material operations. `lastWorkerSeenRevisionId`, `currentTurnRevisionId`, and `activeDelivery` now derive only from verified Stage 3 provenance and exact pending ownership; no stored last-seen or delivery projection was added.

## Impacted Surfaces

- `packages/protocol`
- `packages/app-api-schemas`
- `packages/core-client`
- `apps/nanocore`
- `apps/web`
- worker Context Package and workspace materialization projections
- workspace storage, export, import, backup, recovery, audit, and health checks
- Action Center and exact Artifact Review projections; staged Workspace Review appears only in negative alias-exclusion checks
- L0-L6 tests and agent-first acceptance stories
- relevant core, product, spec, cookbook, and app or package README guidance as implementation lands

## Execution Plan

### Stage 0: Documentation authority

- Reconcile S16, S39, S23 session workspace materialization, S46 storage ownership, C07, and the App API on the body-free receipt default, the one immutable steering terminal outcome, exact generated context-slot handoff predicates, opaque cross-Workspace lookup, current-version Artifact Review, worker artifact collection, restricted Agent-Skill delivery, and success statuses.
- Verify lifecycle metadata, links, English-only repository text, Markdown formatting, and whitespace.
- Do not begin production implementation until an independent review finds no remaining owner, lifecycle, failure, restart, or acceptance ambiguity in this bounded slice.

### Stage 1: Test-first shared contract slice

- Add the smallest app-local schemas for Material, Revision, Thread Binding, Artifact Review, and the Thread material read model; do not add them to stable Core protocol.
- Write failing schema tests for the closed views, six Material mutations, exact success identities, nullable expected revision, digest format, reserved request prefix, and owner-only field exclusion. Stage the checked path, `operationId`, and success-status tests with their legal runtime owners: Artifact import, Artifact introduction, and the eleven Material operations immediately before Stage 2; the two version-owned Artifact Review operations immediately before Stage 4. This keeps Stage 1 green, preserves live-route equality, and avoids an idle Review table or route before a valid producer exists.
- Treat path-Workspace authorization failure as `forbidden` and an opaque missing id inside an authorized Workspace as `stale`; tests MUST NOT scan another Workspace to distinguish existence.
- Keep app-local fields out of stable core protocol unless multiple clients or runtimes demonstrably need them.

### Stage 2: NanoCore material authority

- Implement exactly three workspace-owned Material tables, one cohesive transactional owner, the eleven public Material operations, Artifact import and introduction, their Core Client methods, and typed errors using the existing Workspace database and command ledger. Do not add the version-owned Artifact Review table or its two routes before Stage 4.
- Prove the six mutations with one table-driven transition set, receipt replay and conflict, expected-base zero-write, queue coalescing, singular binding, and one representative transaction rollback; do not add a crash matrix or recovery framework.
- After the authority and routes pass, extend only existing SQLite backup evidence. Do not add the new owners to portable export/import yet: S51 requires the three Material families, version-owned Artifact Review, and Context Package reference rewrites to enter one complete portability slice after Stages 3-4 provide every owner.
- Project one cohesive Thread material read model; until Stage 3 lands its owning provenance, `lastWorkerSeenRevisionId`, `currentTurnRevisionId`, and `activeDelivery` remain null rather than being inferred.

### Stage 3: Worker context and active-turn handoff

- Freeze queued revisions during turn acceptance.
- Materialize the exact content and digest through the dedicated read-only Context Package root at `/openkit/context`, one existing Workspace Input Snapshot, one completed Workspace Materialization Record, and one immutable S39 trace.
- Derive last-worker-seen state from verified accepted traces only; do not add a stored last-seen field, delta, summary, or alternate handoff.
- Implement `Send now` only after the exact Goal pending-input owner and accepted Context Package proof defined by S16 exist; return typed busy for a direct Turn with no delivery owner.
- Keep later saves queued and never rewrite the running turn's initial Context Package.
- Verify that unrelated materials and unsaved drafts cannot enter worker context.

### Stage 4: Worker proposal and conflict-safe apply

- Add the one version-keyed Workspace SQLite `ArtifactReview` table and its two public operations only when this stage has a valid producer, then connect only an immutable worker-output Artifact version with one explicit, uniquely S39-verified Material candidate; leave every other Review candidate null. Delete the replaced unversioned file owner without migration or dual write.
- Add compare, review decision, one-transaction expected-base apply, exact replay, stale-base zero-write, contradictory-authority, and portable-reference rewrite tests before implementation.
- Preserve both user state and worker proposal when concurrent edits diverge.
- Extend the existing S51 export/import graph once for all three Material families, version-owned Artifact Review, and Context Package references after their owners exist. Do not add a temporary non-portable classification, partial graph, second transfer mechanism, or compatibility migration.

### Stage 5: Web material surface — deferred to S10

- Implement the native Markdown or text editor, stable save behavior, Thread binding, queue status, exclusion, send-now, revision comparison, and proposal review as part of the post-program S10 rebuild.
- Use the rebuilt Web stack and Core Client boundary.
- Keep stable resource interactions in OpenKit-owned components and use A2UI only for contextual bounded controls.
- Do not add a temporary Solid projection or pull the S10 rebuild into WP-4.

### Stage 6: Phase 1 verification and dogfooding — Web-dependent closure deferred to S10

- Reuse the completed Stage 1-4 package, NanoCore, portability, real-worker, and repository evidence as the WP-4 kernel exit; do not repeat it through another runner or harness.
- Run the remaining Web-dependent L4 and canonical end-to-end story after Stage 5 exists on the rebuilt stack.
- Dogfood from both the Agent Skill Interface and OpenKit Web after the rebuilt Web projection lands.
- Verify the user can predict what the worker will receive and can recover every revision and decision after restart.
- Close the complete Plane 1 record only after the deferred acceptance chain passes; this does not keep the Execution Program's WP-4 kernel package open.
- Create a separate accepted spec and change plan before beginning any Plane 2 or Plane 3 implementation.

## Verification Plan

### Documentation checkpoint

- `node scripts/validate-spec-lifecycle.mjs`
- `git diff --check`
- Relative-link validation for the new spec, change plan, and active index entry.
- Repository check proving the new accepted spec appears in the active index.
- Review proving the spec does not redefine Artifact, Knowledge, Data Source, Context Package, or the four human-attention modes.

### Implementation checkpoints

- L1 schema, revision, digest, queue, idempotency, and concurrency tests.
- L2 App API, Core Client, Context Package, Item reference, Artifact Review, read-model, and negative staged-Workspace-Review alias conformance tests.
- L3 NanoCore black-box tests for automatic next-turn inclusion, explicit exclusion, send-now routing, restart, digest failure, expected-base conflict, and workspace isolation.
- L4 browser tests for editing, binding, status, compare, send-now, and proposal review.
- L5 revision integrity, provenance, export, import, backup, recovery, and health checks.
- L6 agent-first story proving revision 1 availability, user-only revision 2 save, automatic next-turn availability, concurrent revision 3 conflict, and restart recovery.
- Repository-wide lint, typecheck, test, build, smoke, artifact-health, and story gates required by the accepted L0-L6 model.

## Expected Handoff Points

- Stage 0 ends the documentation-only checkpoint and hands the accepted contract into test-first implementation planning.
- Stage 1 must finish before Material, Revision, or Thread Binding production code is written.
- Stage 2 must establish authoritative persistence and public operations before Web implementation begins.
- Stage 3 must prove exact worker availability before the UI may claim a revision was seen.
- Stage 4 must prove expected-base conflicts cannot clobber user work before proposal apply is exposed broadly.
- Stage 5 must remain within the Markdown or plain-text slice and starts only inside the post-program S10 rebuilt-stack work.
- The Web-dependent Stage 6 closure must pass before Plane 2 or Plane 3 design is promoted into implementation; it is not an entry gate for WP-5.

## Known Risks

- **Scope expansion:** the three-plane taxonomy may be mistaken for authorization to build all three planes. Mitigation: only Plane 1 appears in current implementation stages and acceptance criteria.
- **Artifact boundary drift:** implementation may try to reuse the existing Artifact schema for editable materials. Mitigation: keep Artifact as output and introduce only the minimal app-local Material contracts.
- **Duplicate truth:** a convenient read model may become a second worker-availability ledger. Mitigation: derive availability from accepted Context Package and materialization provenance.
- **Implicit inclusion confusion:** users may not understand why a change reached a worker. Mitigation: explicit Thread binding, visible queued revision, exclusion, and a stop rule that falls back to explicit `Publish to Thread`.
- **Concurrent overwrite:** worker output may be based on an older revision. Mitigation: immutable Artifact proposal, S39-proven base tuple, version-keyed Artifact Review, expected-base apply, and conflict preservation without merge or rebase.
- **Premature abstraction:** a universal resource system may be added for predicted formats. Mitigation: implement only the Phase 1 Material records and existing Artifact Review owner, then generalize from evidence.
- **Web/runtime coupling:** the Web may attempt to access worker files directly. Mitigation: all interaction goes through Core Client and NanoCore-owned references and state.

## Stop Rules

- If visible automatic inclusion remains confusing during dogfooding, replace it with explicit `Publish to Thread` rather than adding heuristics.
- Accept Goal `Send now` only through the governed worker path that can persist its accepted Context Package trace; any path or required steering candidate without that delivery capability returns `goal_steering_delivery_unavailable` before reservation. Reject a direct Turn with no delivery owner using typed busy rather than mutating live worker state.
- If later complex asset types do not share useful bundle and annotation primitives, do not build a universal Plane 2 protocol.
- If external integration requires mirrored domain ownership, pause and re-review the architecture before implementation.

## Checkpoints

- 2026-07-13 — Accepted the delegated-by-default, collaborate-on-demand, govern-throughout interaction posture.
- 2026-07-13 — Accepted the three-plane classification and rejected treating the planes as Artifact kinds.
- 2026-07-13 — Retained grounded feedback as deferred direction over existing human-attention modes, rejected a separate strong-interaction mode, and required a separate accepted specification before implementation.
- 2026-07-13 — Accepted OpenKit Web as a complete Plane 1 interaction host independent of desktop worker applications.
- 2026-07-13 — Restricted the current implementation phase to the complete Workspace-native Material chain, beginning with one Thread-bound Markdown or plain-text material.
- 2026-07-13 — Documentation authority checkpoint completed; implementation remains planned.
- 2026-07-16 — Selective rehydration restored only decision-grade contracts: immutable Artifact origin, exact Thread introduction, logical Artifact/reference commit, input-delivery predicates, refine and redo concurrency, unique Material authorities, stable idempotency scope, restart ordering, and partial-failure behavior. Repeated rationale, rollout steps, speculative future-plane protocols, and generalized workbench machinery remain deleted.
- 2026-07-16 — C02 completed the turn-bound Artifact lineage, handled rollback, active-Turn refinement guard, and direct-Turn busy fallback. Independent real-worker tracing proved that Goal steering had no delivery-proof owner, so the route and Web now fail closed and the unsupported slice shrank by more than 1,500 net lines across implementation, tests, UI, and generated schema. Real Goal delivery remains owned by S05, S13, S39, and this Partial specification.
- 2026-07-18 — WP-3/G05 selected the target version-keyed `ArtifactReview` plus one `workspace.sqlite` Material transaction as the worker-proposal decision and apply owner. The current unversioned file Review is not that owner and will be deleted when Stage 4 lands without migration or dual write. Workspace Sync reuse, merge/rebase, and new proposal, apply-result, settlement, or recovery records are rejected; implementation remains in WP-4.
- 2026-07-18 — WP-4 documentation entry reconciled body-free receipt semantics, one immutable non-lifecycle steering outcome, exact App API statuses, opaque Workspace lookup, current-version-only Review decisions, existing worker artifact collection, restricted Agent-Skill delivery, and the dedicated S39 handoff predicate. Optional delta/summary scope is removed; independent contract review precedes Stage 1.
- 2026-07-18 — Stage 0 completed after two independent contract reviews and one minimality review returned clean. S39 now closes the generated `context` slot, package-root digest, WIS/WMR and backend-session tuple, singular Material selection and queue CAS proof, exact exclusion and steering failure mappings, and `currentTurnRevisionId`; S16, S23, S46, C07, App API, and this plan agree without a new lifecycle or recovery framework. Stage 1 test-first app-local schemas are active; no behavior implementation was part of this checkpoint.
- 2026-07-18 — Stage 1 completed with one runtime-neutral `material.ts` module covering the closed Phase 1 views, nine mutation bodies, and fifteen bounded responses. The package passed 68 tests, typecheck, lint, and build; repository checks passed; two contract reviews and one deletion-first review returned clean after removing two bookkeeping-only assertions. Stage 2 starts with checked contracts for Artifact import, Artifact introduction, and the eleven Material operations; the two Artifact Review routes remain at Stage 4 so no unused authority is created. Material portability also waits for Stage 4 so S51 receives one complete graph rewrite rather than a temporary partial transfer contract.
- 2026-07-18 — Stage 2 completed. Artifact import and idle-Thread introduction now preserve exact digest, request, origin, deterministic Turn, and reference proof; any request-owned Artifact authority footprint without its receipt fails closed with `recovery_required`. Exactly three Material tables and one transactional owner implement the eleven public operations with expected-base zero-write, immutable revision lineage, queue coalescing, singular binding, restart persistence, and the existing hot-backup path. NanoCore passed 203 files and 2,005 tests with one file and three tests skipped; protocol passed 152 tests, App API schemas passed 68 tests, Core Client passed 26 tests, and OpenAPI passed 13 tests, together with the applicable typecheck, lint, build, repository, and whitespace gates. Stage 3 owns S39 handoff and steering; Stage 4 owns version-keyed Artifact Review, writeback, and portability.
- 2026-07-18 — Stage 3 completed. Task and Goal worker launches now persist and verify one exact S39 Context Package trace before backend launch, stock OpenShell materializes the dedicated read-only package without a fork or patch, and worker-seen plus current-Turn Material projections derive only from that accepted trace and existing handoff owners. Goal steering reuses one Thread-unique pending owner and the shared command ledger, reports `202 queued`, proves `applied` only through the accepted trace, preserves exact terminal follow-up or cancellation lineage, and fails before Turn reservation when the required steering Material exceeds the existing Context Package budget. No new scheduler state, recovery workflow, settlement engine, runner, or harness was added. NanoCore passed 207 files and 2,047 tests with one file and three tests skipped; protocol passed 152 tests, config schema passed 129 tests, App API schemas passed 70 tests, Core Client passed 27 tests, the Skill interface passed 10 tests, and OpenAPI passed 14 tests, together with the applicable typecheck, lint, build, OpenAPI, repository, lifecycle, and whitespace gates. Stage 4 now owns the version-keyed Artifact Review producer, conflict-safe Material apply, and the single complete portability graph update.
- 2026-07-18 — Stage 4 contract entry completed before implementation. The existing transcript and retained-session data plane now has one executable declaration, bounded-copy, UTF-8 and JSON, exact byte-substring credential guard, restart-cleanup fallback, deterministic Artifact and Review, imported-history, and target-Agent rule. Collection transfers at most 16 MiB plus one sentinel payload byte, restored sessions never re-resolve credentials, and imported refinement or redo requires the exact currently enabled target Agent or returns `stale` with zero writes. An independent contract review returned clean after these three decision-changing predicates were made explicit. Test-first implementation is active and remains limited to the existing Artifact, Item, Workspace SQLite, Material, Context Package, command ledger, Turn, scheduler, and S51 transfer owners.
- 2026-07-18 — Stage 4 completed. Retained stock OpenShell sessions now collect the bounded declaration bytes into exact turn-output Artifacts, reference Items, and version-keyed Reviews; proposal apply, review replay, target-Agent refinement or redo, Action Center projection, and checkpoint-backed S39 launch reuse the accepted owners and bounded `recovery_required` posture. S51 validates and remints the complete related Material, Revision, Binding, Review, request, Thread, Item, event, and Context Package graph, then revalidates the target and proves one focused re-export and re-import cycle without granting imported history runtime authority. Independent deletion-first review found one contradictory trace-path export defect, which now fails closed through the existing portable-file validator with one targeted regression; it found no deletable over-engineered mechanism. NanoCore passed 208 files with one skipped and 2,107 tests with three skipped before that final 73-test regression slice; App API schemas passed 71 tests, Core Client 28, and Worker Shim 161, with their typecheck, lint, and build gates plus NanoCore build, generated OpenAPI, lifecycle, repository, and whitespace checks. Stage 5 is next.
- 2026-07-18 — Stage 5 preflight stopped before behavior implementation because this plan requires the rebuilt Web stack, S10 is accepted but not started, and the Execution Program expressly excludes that rebuild. The current Solid test baseline was repaired only for Stage 4 Artifact and Core Client shape changes and now passes 125 tests, typecheck, lint, and build. One owning-plan decision must either defer Stage 5 and Stage 6 to the post-program S10 rebuild or expressly authorize a bounded temporary Solid projection; no temporary UI or rebuild expansion is implied by this checkpoint.
- 2026-07-19 — WP-4 closed at its verified Stage 4 kernel boundary. Stage 5 and the Web-dependent remainder of Stage 6 retain their accepted S16 requirements but move together into the post-program S10 rebuilt-stack work after G09; no temporary Solid projection, duplicate acceptance runner, or S10 scope absorption is authorized. This bounded sequencing compromise preserves the product target while allowing the Execution Program to enter WP-5.
