---
type: change-plan
status: verified
date: 2026-09-08
completed: 2026-09-09
---
# Generative Kernel And Generative UI Design

## Intent Epoch 1

Source: the engineer's current task and explicit agreement with the preceding design discussion. Generative UI and Generative Kernel are distinct concepts and need independent owning specifications. Kernel owns small durable Workspace data structures and reusable operations for professional cross-system work; UI owns presentation and interaction and may consume Kernel, existing OpenKit records, or external results. Existing Web specifications retain the rendering stack and published-surface responsibility. Kernel-backed UI is a composed acceptance scenario, not the definition of Generative UI.

The engineer accepts drafting stable operations with explicit input/output, implementation/version, permission, and failure semantics; safe schema creation/evolution with conflict and migration failure handling that preserves existing data; and separate temporary versus reusable UI with explicit reopen, source, version, and current-authority behavior. Implementations may start from A2UI v0.9 now and target eventual v1.0 interoperability after inspecting candidate improvements; neither upstream stable publication nor renderer availability is a gate for current work.

This task is a major design and architecture documentation change. The primary personally authors every document. Clean-context sub-agents may perform Reviewer and Auditor work; adversarial Consultant or Verifier work must use an independent Claude Code agent through Herdr. No production implementation, dependency installation, commit, publication, external SaaS mutation, or customer-data migration is requested.

Acceptance: coherent Core principles, two independently scoped Draft specifications with concrete proposed lifecycles and acceptance predicates, aligned current projections and roadmap blockers, exact documentation-check evidence, independent review and intent scrutiny, and adversarial Claude Code findings reconciled against actual owners. Unsettled physical persistence and execution details remain explicit blocking Draft questions rather than implied implementation permission. B3 is not declared cleared by document creation.

## Owners And Write Boundary

The primary is the sole writer of this bundle, the two new specifications, and affected existing documentation: Core architecture/storage and Core term index; product vision; Web stack and product-surface specifications; DESIGN.md; Roadmap; the named temporary pathway blocker note; relevant spec index/projection links; and the generated documentation index. Expand to a directly affected owner only when needed to remove an actual contradiction, recording why here. Reviewer, Auditor, and Claude Code receive no write ownership.

Accepted owners: `docs/core/architecture.md`, `docs/core/storage.md`, `docs/core/communication.md`, `docs/core/protocol.md`, `docs/core/agent-capability.md`, `docs/core/permissions.md`, `docs/core/vault.md`, `docs/core/audit.md`, `docs/specs/20260703-storage_layout_record_ownership.md`, `docs/specs/20260703-schema_evolution_record_envelope.md`, `docs/specs/20260704-workspace_backup_export_import.md`, `docs/specs/20260713-work_resource_interaction_model.md`, `docs/specs/20260713-openkit_agent_skill_interface.md`, `docs/specs/20260710-web_ui_rebuild_stack.md`, and `docs/specs/20260628-web_product_surface_projection.md`. Documentation and execution governance remain in `docs/documentation-model.md` and `docs/change-execution.md`.

## Intent Epoch 2

This supplements Epoch 1 from the same engineer source after the independent Auditor identified omitted distinctions. Kernel is a backend for small cross-system low-code/CMS-style glue, not a CRM replacement or full frontend/backend builder. AG-UI and OpenAI Apps SDK/Plugins inform architecture and integration without requiring another transport or iframe runtime. The Worker-aware versus Worker-transparent production question is answered by the proposed optional-producer design: either can submit through the same Core admission boundary, with no mandatory UI agent. This is a drafting choice for review, not a claim that the implementation exists.

Additional affected authorities are `docs/core/contract-evolution.md` for general evolution, `docs/specs/20260703-policy_enforcement_mapping.md` for unique operation/access-right registration, `docs/specs/20260531-human_attention_intervention_model.md` for owned approval/elicitation, and `docs/specs/20260703-worker_agent_capability.md` for Worker capability families. The file-envelope specification does not own SQLite DDL. No additional authority document is created for these existing concerns.

## Intent Epoch 3

Source: the engineer's 2026-09-09 Agent Native clarification and explicit request for a separate Core document. Generative Kernel is each Light App's stable schema plus data; Agent is the primary consumer, with schema and contextual semantic discovery plus expressive general data operations. Fixed optimized or sensitive operations are optional Agent Plugin resources (prefer one MCP, with Skills and possible CLI tools), not a mandatory business-command layer. The preceding storage direction is file-authored schema and one SQLite database per Light App. Existing systems retain domain authority. The combined image is Generative Kernel + AI Agent + Generative UI, avoiding the complexity of traditional full-stack builders and custom execution platforms.

The initial authorization target gives every active Workspace member all Workspace and Light App operation eligibility through the existing Policy Kernel; it does not add per-app ACLs or remove current credential, confidentiality, human-gate, integrity, and audit requirements. This supersedes the previous owner/editor/viewer grant ceiling as a design target, not as a claim of changed runtime. The internal-agent MCP/Skill question is answered with a proposed selected existing Assistant entry path and governed resource bridge, not an automatic capability grant to all internal roles. The engineer explicitly selected standard Apps SDK/MCP tool and UI-resource interfaces with A2UI rendering first; HTML iframe hosting and full MCP Apps host conformance are not selected. A2UI v0.9 work and eventual v1.0 compatibility remain the direction.

Write ownership expands, still primary-only, to the new `docs/core/generative-apps.md`, Core Permissions and Agent Supply, and the existing multi-user and Policy-mapping specifications where their old role ceiling directly conflicts. Existing generic internal Tool admission remains intact. All other role contexts remain read-only. Acceptance is a standalone settled Core aspect, aligned Draft proposals and affected owners, accurate runtime gaps, and independent inspection. No production implementation or specification-wide finalization is requested by this clarification.

## Intent Epoch 4

Source: the engineer's subsequent explicit mixed-rendering design replaces Epoch 3's A2UI-only first-host scope. A2UI organizes the surface; OpenKit native components are the default; one generic PluginWidget delegate hosts registered MCP Apps HTML for maps, timelines, canvases, and other specialized interactions. The Plugin owns its HTML/JS/CSS. Agent references exact Plugin/resource identity and may author/register new widget resources through governed creation. OpenKit owns isolation, standard bridge mediation, typed state/event exchange with native siblings, current-authority execution, and local failure containment. No arbitrary URL grants host capabilities, and no direct DOM coupling is allowed. The engineer asks to reuse existing A2UI/AG-UI standards for remaining persistence and interaction design where they apply.

The primary will personally revise Core, UI/Web/Design projections, and the Draft persistence proposal, using the linked official A2UI/MCP Apps guides as evidence. Standard component/resource/bridge/state contracts do not establish OpenKit's Item, saved-view, retention, or portability authority. Those remaining details must be stated as concrete proposals with honest owner-extension prerequisites. Independent Claude scrutiny now includes the delegated HTML effect boundary.

## Intent Epoch 5

Source: the engineer's latest supplementary direction. Agent-led creation, modification, and management under user intent is the primary Light App path. Schema import/export is supported as another path, optionally including related Generative UI, MCP, Skills, or Agent Plugin resources. Light App management should be catalog-shaped like Plugin/Skill management. The primary will preserve one Workspace-scoped Light App Catalog projection over existing app identity/schema/lifecycle owners, not introduce a second installer or version authority. The app-scoped package/optional resource closure uses the existing portability and component owners and remains a concrete Draft contract to freeze.

Additional write-boundary reconciliation: the primary owns the directly affected `docs/specs/20260703-storage_layout_record_ownership.md` app storage/receipt direction and `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md` consumer boundary. The primary additionally owns the directly affected backup/export specification's generative inventory and inert-resource classification. These remove actual physical-scope and resource-version ambiguities; exact implementation extensions remain Draft. The contract-stability baseline readiness rows are also reconciled because they incorrectly promoted the old role ceiling as durable Core authority.

## Proposal And Prior Scrutiny

Use existing Core aspects for stable boundaries and two narrow specifications for concrete proposals. Preserve existing Policy, identity, Vault, Audit, work, execution, and portability authorities rather than creating Kernel-specific replacements. Business entity definitions belong to individual modules, not universal Core Customer/Member concepts. A UI declaration never grants execution rights, and saved UI never becomes an alternative business-data authority.

Previous independent research and a two-turn Claude Code consultation are retained under `temp/research/20260908-generative-discussion/`. The useful findings are optional Worker UI awareness, independent UI and data probes, explicit export coverage for any new record family, and a real comparison of physical tables versus validated document rows. The consultant withdrew its inference that a static export test prohibited generated tables; the test is a projection, not architecture authority. No dynamic-table or fixed-four-table choice has been accepted. Current code is a fixture-only local A2UI-like shell, not a live upstream A2UI implementation.

## Checkpoint

Current state: Epochs 3–5 are authored and reviewed. The primary wrote the independent Accepted Core aspect and aligned the two Drafts, Workspace permission target, storage/portability and Plugin consumer boundaries, Web/Design, product vision, Roadmap, and indexes. Reviewer and Auditor inspected actual corrected bytes. The independent Claude consultant's substantive counterexamples are reconciled; its last scope-label finding is corrected by the explicit Light App package Owns entry in the portability owner. Final focused checks are recorded below; the Reviewer also inspected the last portability Owns correction and reports no remaining finding. The documentation slice is complete with the known unrelated full-corpus validation failure.

The settled direction is per-app schema/data, agent-led catalog management, optional schema/resource import/export, general data operations, optional Agent Plugin behavior, and A2UI with a governed MCP Apps HTML delegate. Exact query/record/package/Item schemas, destructive-data recovery proofs, selected internal capability assembly, and browser-host conformance remain Draft prerequisites. No implementation or publication readiness is claimed.

Method: primary authors; clean Reviewer inspects actual bytes; clean Auditor checks source-intent fidelity and neighboring owners; independent Claude Code challenges the concrete diff through Herdr; primary corrects findings and runs proportional documentation checks. Roles do not author the documents or grant engineer approval.

## Prior Epochs 1–2 Closeout

The primary personally authored the two Drafts and every related document edit. The only generated artifact is `docs/INDEX.md`, produced by its existing generator. No production code, dependency, test infrastructure, runtime configuration, commit, or customer data changed. The ignored pathway note is updated locally and is not part of the tracked diff.

Independent review used clean-context registered Reviewer `/root/generative_doc_review` and Auditor `/root/generative_intent_audit`, both read-only. Adversarial scrutiny used the independent Claude Code consultant through Herdr, agent `generative-consultant`, pane `wW:p6`, session `46a24122-3253-457a-b48d-d5bc08c0be83`, also with no write ownership. Prior external research remains uncommitted under `temp/research/20260908-generative-ui-a2ui/`, `temp/research/20260908-generative-ui-interaction/`, `temp/research/20260908-generative-kernel-backends/`, and `temp/research/20260908-generative-discussion/`.

### Reconciled Findings

| Independent finding | Correction and deciding authority |
| --- | --- |
| Auditor: R098 accidentally absorbed general UI and the combined blocker coupled independent work. | R098 is again only the composed Kernel-backed journey. B3 states separate Kernel/UI contract dependencies and required existing-owner extensions without reordering the pathway. |
| Auditor: proposed optional Worker/deterministic production became binding in Accepted Core. | Core and DESIGN are producer-neutral. The optional allocation is explicitly a proposed Decision in the UI Draft. |
| Reviewer: command receipts held results and replayed old outcomes. | Kernel follows the Core protocol's metadata-only result-resource reference, current-owner projection, seven-day baseline, and `recovery_required` semantics. No response-body receipt or synthetic recovery owner remains. |
| Reviewer: unsaved input was modeled as a mutually exclusive source mode. | Historical/live source modes are separate from the ephemeral draft overlay, which saving/reopening a definition does not persist. |
| Claude: re-pointing a CRM connection can reinterpret old external IDs. | Source references retain observed immutable external instance identity; the named capability-owner extension must verify the current instance and invalidate mismatches. |
| Claude: a CRM writeback plus local annotation had an implied composite receipt. | They are separate receipted operations related by existing lineage. Automatic composition needs an accepted existing execution binding, not a new Kernel runner. |
| Claude: runtime tables were allegedly prohibited by the existing explicitly named record-graph clause. | The primary challenged the physical-table inference. Claude withdrew it after reading the owner: both mappings must name the canonical graph and prove complete inventory/portability; neither is prohibited solely by physical table naming. |
| Claude: destructive schema evolution could lose populated values without recovery; Reviewer: the primary's first correction invented a universal export-before-delete protocol. | Auditor adjudicated the smaller route. Atomic failure rollback remains; destructive populated-value removal and physical deletion stay unavailable until an accepted command-specific data-loss/recovery contract proves exact prior-value recovery, including concurrent inserts, or leaves the case unsupported. Blocking Q1 names that work. No per-command scoped export, universal CRUD export gate, cross-store atomicity, or irreversible-risk acceptance is invented. |
| Reviewer/Claude: missing Decision and owner references, stale source link, and outcome wording that obscured unknown results. | Added proposed Decisions, explicit Blocking questions, identity/evolution/Policy/attention/capability references, restored actual reference links, and stated inspectable outcome or explicit unknown state. |

The Reviewer withdrew a suggestion to translate newly authored product-vision prose into Chinese: current root `LANG-001` requires English documentation, so the primary leaves unrelated legacy Chinese content untouched. An existing Web `Partial` versus prose `Implemented` discrepancy is outside this change's certifiable scope and is not repaired by asserting unverified runtime completion.

## Prior Epochs 1–2 Verification Evidence

- `node scripts/validate-spec-lifecycle.mjs`: passed.
- `node scripts/generate-doc-index.mjs`: wrote the index; its only diff adds the two Draft entries.
- `node scripts/generate-doc-index.mjs --check`: passed.
- `git diff --check`: passed.
- `node scripts/validate-doc-model.mjs`: failed with exactly one pre-existing error: `docs/changes/202609081255000001-agent_plugin_skill_mcp_catalog/plan.md` uses noncanonical `status: in-review`. `git show HEAD:<that path>` confirms the same value in HEAD; this task did not edit it. The Reviewer independently reproduced that result. The full validator is not reported green.

These checks establish documentation structure and consistency, not runtime behavior. The storage, destructive-migration, capability, A2UI, and saved-view acceptance predicates have not been executed. Both new specifications remain `Draft` / `Not Started`; B3 and UI publication remain open. Final independent closure: the Reviewer reports no actionable findings in the final diff and three new documents; the Auditor reports no remaining intent/authority discrepancy; the Herdr Claude consultant reports no concrete durability contradiction and requested only the now-applied schema-availability qualifier. The last focused checks passed after that correction. The documentation slice is verified with the explicitly recorded pre-existing full-corpus validator failure; no specification is promoted to Accepted by these review verdicts.

## Closeout Summary

The primary personally authored the new `docs/core/generative-apps.md` and every design/projection edit. `docs/INDEX.md` alone is generated by the existing tool. The concept owner records Light App, Light App Catalog, Generative Kernel, and Generative UI with agent-first semantic discovery, flexible general operations, data integrity, optional Agent Plugin behavior, mixed native/delegated presentation, and explicit lifecycle/failure/acceptance boundaries. The Kernel Draft selects schema files plus one SQLite database per app and agent-led catalog management with app-scoped schema/resource import/export; the UI Draft selects standard resource profiles, A2UI layout, a single governed MCP Apps delegate, immutable presentation storage, Item references, and separate saved-view identity.

The permission owner now records equal active-member eligibility through Policy. Its concrete multi-user schema, lifecycle, API target, tests, roadmap, and stability classification are aligned; old role-based runtime details are explicitly current/pre-cutover evidence. Token, private scope, Quick Chat isolation, exact human gates, Vault, data-loss protection, and deletion recovery retain their owners. Current runtime still enforces old role ceilings and has no implemented Light App or mixed UI path. The ordinary Assistant's fixed Tool set remains unchanged; the selected generative-app entry path and MCP bridge are proposals.

Independent read-only assurance used fresh Reviewer `/root/generative_apps_final_review`, Auditor `/root/generative_core_intent_audit`, and the existing independent Claude Code consultant through Herdr `generative-consultant` (session `46a24122-3253-457a-b48d-d5bc08c0be83`). Reviewer and Auditor report no remaining actionable/source-intent findings in corrected bytes. The consultant withdrew its mistaken inference that physically partitioned receipts require duplicate authority or ATTACH, and closed the storage, UI, membership, and presentation counterexamples after inspection. Its last request was an explicit app-package scope in the portability owner's Owns list, now present.

The useful corrections are retained in their owners: app-local integrity failure without empty-store repair; complete backup inventory and matching schema bytes; immutable executable-resource and asset pinning; inert portable HTML with target re-admission; no whole-model disclosure from delegated widgets; scoped statement/effect audit evidence; and effect-proportional preview/Policy/Human Attention for shared executable-resource publication, without a new widget-approval lifecycle. The Auditor adjudicated the last confirmation question against existing Core Permissions, not a new engineer approval request. External research is uncommitted under `temp/research/20260909-generative-mixed-ui/` alongside the earlier PocketBase and protocol research.

No production code, test infrastructure, dependencies, runtime configuration, live permissions, customer data, Git commit, or publication changed. Core direction is Accepted; both implementation specifications remain Draft / Not Started, and B3 remains open on their named concrete contracts and evidence. Documentation completion does not authorize implementation by implication.

## Verification Evidence

- `node scripts/validate-spec-lifecycle.mjs`: passed.
- `node scripts/generate-doc-index.mjs`: generated the three new Core/spec index entries using the existing generator.
- `node scripts/generate-doc-index.mjs --check`: passed.
- `git diff --check`: passed.
- `node scripts/validate-doc-model.mjs`: the only failure remains the untouched pre-existing `status: in-review` in `docs/changes/202609081255000001-agent_plugin_skill_mcp_catalog/plan.md`; independent Reviewer confirmed the same value in HEAD. The full-corpus validator is not green.

These checks validate document structure and projections. They do not test SQLite crash recovery, backup/copy/import, actual member-permission cutover, MCP execution, browser isolation, widget/native linkage, or saved-view behavior. Those remain implementation acceptance predicates in the Drafts and existing owners.
