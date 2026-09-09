---
type: change-plan
status: in-progress
date: 2026-09-09
---
# Generative Apps MVP

## Intent Epoch 1

Source: the engineer's 2026-09-09 request following the Generative Kernel and Generative UI design discussion. Deliver the simplest foundational MVP that makes Generative Kernel + Agent + Generative UI work inside OpenKit, so users can use it, provide feedback, and guide subsequent improvements. The request explicitly excludes implementing every feature of the full design in this first change. The stable data kernel, agent-first creation and management, and generative presentation are all necessary; a fixture-only UI or manually provisioned database is not the requested outcome.

The engineer also requires that `docs/product-vision.md` remain untouched unless they explicitly request changing that document; they discarded the earlier edits. Root `AGENTS.md` must preserve this rule. The primary personally authors the documents. Clean-context sub-agents may review or audit; adversarial Consultant/Verifier work uses an independent Claude Code agent through Herdr.

This turn prepares the implementation plan and corrects documentation governance and Draft blocker classification. It does not implement, deploy, commit, use customer credentials, or mutate external systems. This record remains `planned` until implementation actually begins. It is execution evidence, not a substitute for the owning specifications.

## Intent Epoch 2

Source: the engineer's next instruction on 2026-09-09 explicitly delegates settlement of the remaining implementation details to the primary and the independent Claude Code consultant. Kernel schema and interfaces primarily reference PocketBase. Generative UI reuses A2UI designs directly where they cover the concern, with AG-UI as supplementary reference; only necessary OpenKit adaptations are added. This authorizes closing the initial contract questions and accepting the two specifications after independent review, without another approval round for ordinary details inside the selected direction. The minimal MVP, per-app SQLite, primary-only document authorship, unchanged product vision, and no production implementation in this contract-freeze turn remain the boundaries.

## Owners And Write Boundary

- [Generative Apps](../../core/generative-apps.md): accepted concepts, data authority, agent-first usage, and composition.
- [Kernel](../../specs/20260908-generative_kernel_data_operations.md) and [Generative UI](../../specs/20260908-generative_ui_interaction.md): accepted initial implementation contracts; their initial-delivery boundaries distinguish the MVP from later extensions.
- [Storage layout](../../specs/20260703-storage_layout_record_ownership.md), [Core Protocol](../../core/protocol.md), and [portability](../../specs/20260704-workspace_backup_export_import.md): canonical record placement, existing receipt semantics, backup/recovery, and export/import.
- [Permissions](../../core/permissions.md), [Policy mapping](../../specs/20260703-policy_enforcement_mapping.md), and [Workspace membership](../../specs/20260715-multi_user_workspace_system.md): current caller, equal active-member eligibility, disclosure, and effect admission; no Light App ACL.
- [Worker capabilities](../../specs/20260703-worker_agent_capability.md), [Worker MCP supply](../../specs/20260704-worker_mcp_tool_supply.md), and [OpenKit Skill interface](../../specs/20260713-openkit_agent_skill_interface.md): selected Worker access and public operation discovery/invocation.
- [Web stack](../../specs/20260710-web_ui_rebuild_stack.md) and [Web surface projection](../../specs/20260628-web_product_surface_projection.md): official rendering dependencies, accessible host components, and product publication.

The primary owns this plan, the root governance amendment, the two initial contracts, their required storage, portability, audit, feature-envelope, Policy, Worker capability and Web/Plugin owner projections, and the generated index. Contract promotion also aligns `docs/roadmap.md` B3 and the specification index with the accepted scope and deferred extensions. Reviewers and the Claude consultant have no write ownership. Production ownership will be assigned by the affected seam when execution begins. `docs/product-vision.md` is excluded. The [earlier design record](../202609081810390001-generative_kernel_ui_design/plan.md) remains historical evidence; its broader scope does not expand this implementation plan.

## Working Checkpoint

### Current Facts And Acceptance Status

- Core design and both initial implementation contracts are accepted; both specifications are `Implementation: In Progress` while this MVP lands. Epoch 2 supplies authorization for the settled details. Initial schema, command, transaction, presentation, Item, action, Worker, Policy, storage and portable contracts are now fixed. No initial design blocker remains; full-feature completion and later extensions stay deferred.
- NanoCore Kernel, native Generative UI admission, Worker MCP `openkit-generative`, App API/Skill operations, Chat Item rendering through official A2UI v0.9, and Workspace feature markers are implemented on `feat/generative-apps-mvp`. The unpublished `/generative` fixture remains Tier C.
- Built-in Worker tools reuse App API operation Policy plus `deniedTools` / fail-closed `approvalRequiredTools`. This MVP does not edit `WORKSPACE_ROLE_OPERATION_CEILINGS`; equal active-member eligibility remains unmet for editor/viewer and is recorded in the Policy mapping.
- Existing portability covers per-app databases, definition bytes, native records, and retained presentations through explicit canonical-family exporters. Import verifies definition and presentation digests before remint.
- Live selected-Worker journey, browser E2E form/edit/refresh, and crash/restart proofs are **deferred** under the engineer exception. Typecheck, official A2UI v0.9 admission, Policy, portability, CLI bundle, and contract conformance are not waived.

### Proposed MVP And Why This Size

Use one user journey: the user asks an existing Task Worker to maintain membership-system-to-CRM ID mappings and one locally owned annotation. The agent creates an app from that intent, discovers its admitted schema, writes records through general commands, and produces an A2UI view in the same work Thread. The user changes an annotation through a generated form; Core validates and commits it; explicit refresh and a subsequent agent read observe the new value. No external CRM write or CRM-specific app implementation is needed to prove this local glue workflow.

The motivating app may include an ordinary `active` or `voided` field so the user can correct a mistaken entry through conditional update and exclude it from the active list without deleting data. This is agent-authored business schema, not a mandatory Kernel tombstone, hidden soft-delete rule, or new lifecycle. The usable journey must demonstrate this correction as well as creation.

| Seam | Initial delivery | Deliberate ceiling |
| --- | --- | --- |
| Kernel authority | One SQLite database per app; reviewable file-authored schema and semantic context; stable app/collection/field/record identities; native constraints; discoverable Workspace catalog. | Only a small declared scalar/type set and local app relationships actually supported by the initial contract. No arbitrary SQL or generic CMS service. |
| General data operations | Discover schema and capabilities; read/filter/order/page; create and conditional update; bounded atomic batches over explicit records. Each operation checks schema and relevant record revisions and returns precise validation/conflict/limit results. | No joins, aggregates, predicate-wide writes, physical deletion, or custom fixed operation required for this slice. Report unsupported operations; do not silently approximate them. |
| Agent management | Create, list, inspect, change labels/semantic context, add a nullable field safely, and retire an app through governed commands. Catalog is a projection of app authority. | No visual schema builder, marketplace, app installer, or per-app MCP process. |
| Agent access | Extend the existing selected Worker MCP path with one cohesive built-in data/presentation surface and exact server-derived scope. Add required one-to-one public API/Skill catalog coverage through existing tooling. | Do not revive the removed user-facing MCP interface, add a new Core agent role, expand ordinary Chat tools, or build an internal arbitrary-Plugin bridge. |
| Generative UI | Official A2UI v0.9, a minimal native catalog for text/list/form/action, shared Core admission, immutable accepted presentation revisions linked from Thread Items, explicit current-source refresh, and typed form submission. | No independent saved-view identity, automatic live subscription, custom component language, or HTML delegate in the MVP. The full mixed-rendering direction remains unchanged. |
| Integrity and evidence | Local schema/data/receipt atomicity; conflicts and duplicate handling; current Policy and audience checks; attributed effects; restart and unavailable-app behavior; existing backup/restore and Workspace export/import cover all new canonical families. | No custom audit database, command runner, distributed transaction, or full row-history/undo system. Destructive operations stay unavailable. |

Use native SQLite capabilities and existing command, catalog, transport, history, audit, and execution owners. Keep data commands usable without Web and render an ordinary existing result without creating a Kernel app. These are component-level checks inside the same implementation effort, not two separately published products or mandatory delivery queues.

For permissions, project equal active-member eligibility for the introduced operations through the existing authorizer and test it with active members, revoked members, and another Workspace. Inspect the actual parent checks: if an old role gate prevents the new operation, correct that shared enforcement seam and its affected contract/tests; do not add a bypass at the route or invent local grants. Credential, disclosure, sensitive-effect and human-gate rules still apply. Unrelated membership administration UI and broader role-removal work are not silently absorbed; if a shared cutover is inseparable, identify that concrete prerequisite and reframe the frontier before expanding it.

### Accepted Initial Contract

The initial Kernel owner fixes the collection/field grammar, stable identities, bounded PocketBase-style query/mutation shapes, conditional revisions, atomic app-local audit/receipt behavior, limits and errors. The UI owner retains standard v0.9 messages and actions, a small native catalog, exact-record form binding, immutable presentation/Item ownership, transport request identity and explicit partial-publication recovery. Existing storage, audit, portability, feature-envelope, Policy and Worker owners now carry their own concrete extensions. No production contract is supplied by this plan alone.

Under Epoch 2 authorization and independent contract review, both specifications are `Accepted` / `Not Started`. B3's initial design conditions are cleared and the specification index reflects that scope. Later saved views, HTML delegates, richer data operations and app packages require their own detailed admission before implementation; they do not block this first chain. Renderer package pins, implementation tests and upstream v1.0 publication do not withhold acceptance of the settled initial contract.

### Adaptive Execution Frontier

1. **Probe the first implementation seam.** Use the accepted initial owners to establish a failing Core integrity regression and a real selected Worker binding probe. The native SQLite and upstream A2UI schema probes already support contract feasibility but are not implementation proof. A gateway that cannot bind the caller/app without a new runtime, or storage that cannot preserve the required authority, defeats the proposed seam and requires a smaller corrected design before implementation grows.
2. **Implement the real vertical path.** Build the bounded headless data commands and their agent projection, then wire native A2UI admission/rendering and one actual form action into the existing Thread. Keep safe schema authoring and catalog discovery on the same path; no manually seeded database or fixed mapping-specific tool substitutes for agent creation. Validate a non-Kernel result without adding another product workflow.
3. **Qualify the same path for feedback use.** Prove restart, conflict, receipt, isolation, audit, fallback, backup/restore, and portable coverage with the actual new records. Complete the focused real-Worker and browser interaction before publishing the supported surface. Record any unimplemented broader predicates as deferred; do not mark all R096–R098 or the complete design finished.

This is a dependency sketch, not a frozen role sequence or future task queue. Production Kernel, Generative UI, Worker MCP, Skill/CLI, and Chat Item rendering are implemented in later epochs; live selected-Worker and browser proofs remain deferred. Routine field names, package selection, and test corrections do not require another permission cycle.

### Deciding Acceptance Observations

- From a user instruction in OpenKit, a real selected Worker creates the app and records through the governed interface, discovers exact schema/context, and generates an admitted native view. No developer edits authoritative data or hardcodes the customer's mapping into a custom Tool.
- A keyboard-accessible form edits one record through Core; a fresh agent query observes the value. A stale concurrent edit returns a conflict without losing the prior commit or the user's unsaved draft. A bounded batch with one invalid/conflicting member commits none of its changes.
- Same-request delivery cannot duplicate creation or mutation; changed arguments under the same request ID fail. Interrupted publication, expired/missing receipts, and reconnect return the owning outcome or explicit recovery condition; neither reopens nor reconnects replay effects.
- Native SQLite constraints reject invalid data. Failed schema activation leaves the old admitted schema/data readable; adding a nullable field preserves existing records. A retired app rejects mutation. Unsupported destructive requests leave data unchanged.
- Two apps cannot read or write one another's tables; another Workspace and a revoked member cannot obtain data or effect through Web, Worker, or CLI. Eligible active members receive the same new operation eligibility without an app ACL. Sensitive values are absent from routine audit payloads while actor, target, operation, revisions, and outcome remain attributable.
- Restart preserves the app, schema, records, and exact accepted Thread presentation. A corrupt/missing app authority is unavailable with original bytes preserved; healthy apps remain usable. Historical content is labeled; explicit refresh uses current data and authority, never LLM regeneration or action replay.
- A consistent backup/restore and Workspace export/import include an app created after startup, its native data, definition bytes, presentation revision and Item references. Restored/imported data and references match the admitted source; no credentials or active execution grants are imported. UI absence cannot hide a missing record family.
- Invalid or oversized declarations, unknown components and forged actions cannot load code or cause a write. Safe fallback, accessible labels, validation errors, and focus behavior work. An existing non-Kernel result renders through the same admission boundary.

Use the existing test layers and verification instruments. Unit/contract tests decide deterministic constraints, revisions, and admission; real SQLite fault/restart tests decide storage; a real selected Worker run decides agent access; browser integration decides the form and fallback; actual archive round-trips decide portability. Mocks and a producer report cannot substitute for those effect domains. Full repository gates are added only when the final touched surface requires them.

### Deferred Work And Feedback

The Kernel owner receives richer relational querying, upsert/predicate-wide batches, destructive evolution/recovery, app-scoped schema/resource packaging, and optional fixed operations when an actual workflow needs them. The UI owner receives explicit saved views, reusable templates, specialized HTML delegates, and an AG-UI adapter when a concrete interaction or consumer requires them. Existing supply/runtime owners receive internal-agent MCP/Skill invocation when a supported internal entry path needs it. A2UI v1.0 compatibility remains the target and is handled at its protocol boundary as the candidate evolves.

At the first usable delivery, record user attempts, unsupported queries/components, corrections, lost-work incidents, and maintenance friction through existing work/feedback channels. Use that evidence to select the next bounded extension. Do not add a telemetry subsystem, bespoke feedback database, or a predetermined implementation of every deferred feature.

## Planning Review And Verification

Independent Claude Code consultant `generative-consultant`, Herdr session `46a24122-3253-457a-b48d-d5bc08c0be83`, inspected the current proposal and owners and returned `Continue`: no surviving design/scope objection. Its initial MCP-path and inline-Item objections relied on older text and were withdrawn after inspecting the current capability and presentation owners. Per-app SQLite's storage/receipt/backup/portability costs remain in scope under the engineer's existing decision. Its valid correction-path suggestion uses an ordinary app field; its final bookkeeping finding is addressed by the explicit B3/spec-index promotion condition and engineer-approval boundary above. Clean-context registered Reviewer `/root/generative_mvp_plan_review` inspected the final plan, root rule, both Drafts, owning references and adjacent storage/Worker/Item/Web implementation, and reported no actionable findings. It independently confirmed that unresolved initial contract shapes and runtime probes remain future work, not evidence that implementation or full design acceptance has occurred.

Observed planning checks on 2026-09-09:

- `node --test tests/agents-root-contract.test.mjs`: 5 passed, 0 failed. Root `AGENTS.md` retains six top-level sections and 1,461 whitespace-separated words, below its 2,100-word ceiling.
- `node scripts/validate-spec-lifecycle.mjs`: passed.
- `node scripts/generate-doc-index.mjs --check`: passed; no index regeneration was needed for the new plan or scope corrections.
- `git diff --check`: passed. A direct local-link check resolved all 15 Markdown links in this plan.
- `git diff --exit-code HEAD -- docs/product-vision.md`: passed with no output; the file matches HEAD and the engineer's discard remains intact.
- `node scripts/validate-doc-model.mjs`: exit 1, solely because `docs/changes/202609081255000001-agent_plugin_skill_mcp_catalog/plan.md` has noncanonical `status: in-review`. `git show HEAD:docs/changes/202609081255000001-agent_plugin_skill_mcp_catalog/plan.md` confirms that value is pre-existing. This task leaves that unrelated record untouched and does not claim the full validator passed.

No product runtime acceptance observation above has been executed by this planning task. No production code, dependency, deployment, customer data, or Git commit changed. Implementation remains planned; the next work is the bounded first implementation seam.

## Contract Settlement And Verification

On 2026-09-09 the primary settled the initial contracts under Intent Epoch 2. PocketBase supplies the collection/field and records vocabulary; upstream A2UI supplies message, component and action shapes. AG-UI remains an optional state-transport adapter, not a new persistence authority. The existing Claude Code consultant session was used for independent trade-off scrutiny. After correcting its initial assumptions, it agreed that file publication cannot be made atomic by a SQLite transaction, request identity belongs outside the A2UI event, bounded live pagination is sufficient with explicit completeness, strict parsed filters need no SQL passthrough, and backup must verify definition bytes against the captured database. The final narrower consultation covered these protocol/platform trade-offs; it is not a claim that Claude reviewed every final owner edit.

Clean-context registered Reviewer `/root/generative_mvp_contract_review` independently inspected the actual contracts and adjacent owners. Its corrections now bind displayed record, control paths and submitted fields to the exact mutation target, keep nullable form values read-only, separate refresh's read posture, specify unique/null and catalog bounds, and preserve unpublished/imported history without activating target request identity. It reported no remaining material contract blocker before status promotion; final status/index verification is recorded below.

Focused feasibility evidence stays uncommitted under `temp/changes/202609090046400001-generative_apps_mvp/`. `protocol-probe.cjs` validates three native messages and one action against the retained upstream v0.9 server/client and basic-component schemas using installed Ajv; unknown components and missing action identity fail. It deliberately does not validate formats or claim OpenKit renderer/admission execution. `sqlite-probe.py` uses Python's SQLite to verify unique/null, foreign-key and non-null constraints, rollback of record plus receipt on audit failure, stale-revision no-op and committed persistence after reopen. It is not a crash-injection, Core route or real Worker test. Both probes passed.

Observed final contract checks on 2026-09-09: `node scripts/validate-spec-lifecycle.mjs` passed; `node scripts/generate-doc-index.mjs --check` passed after regeneration; `git diff --check` passed; 203 local Markdown link targets across changed tracked documents and the current contract/plan files resolved; both focused feasibility probes passed. The independent reviewer also ran `node --test tests/agents-root-contract.test.mjs` with 5 passed and 0 failed. `git diff --exit-code HEAD -- docs/product-vision.md` passed with no output. The full `node scripts/validate-doc-model.mjs` still exits 1 solely for the pre-existing unrelated `in-review` plan status named above. No check is waived or relabeled as passing.

Final independent acceptance: `/root/generative_mvp_contract_review` inspected the promoted bytes and accepted the material contracts with no actionable findings. It confirmed that both specification statuses, README, generated INDEX, B3 and checkpoint agree, and that the remaining uncertainty is implementation evidence rather than an unresolved initial design decision. This closes the contract-freeze work under Epoch 2.

## Implementation Epoch 3

Source: the engineer's 2026-09-09 request to land the accepted initial-delivery boundary after merge `e3ecaee7`, including published in-thread Web UI, in a worktree PR. Production Kernel, Generative UI, Skill/CLI, Worker MCP `openkit-generative`, backup/export coverage, and Chat Item rendering are in this epoch. The `/generative` fixture remains unpublished Tier C.

Permission finding: this MVP ships on the accepted Policy mapping (`workspace.read` / `workspace.configure` / `workspace.write` / `thread.read`) without editing `WORKSPACE_ROLE_OPERATION_CEILINGS`. Editor still cannot create or evolve a Light App schema, and viewer still cannot write records. Equal active-member eligibility in `docs/core/permissions.md` remains unmet for those fixed roles; the shared cutover is outside this frontier. Denial for missing, removed, and cross-Workspace callers reuses the existing authorizer.

Renderer finding: in-thread Chat maps the eight native A2UI types onto existing React Aria primitives. Official `@a2ui/react@0.11.0` was not added because it peer-depends on zod 3 while this repository is on zod 4; a source guard still forbids a bare `@a2ui/react` default (v0.8) import.

Herdr finding: independent Claude consultant and Codex reviewer/verifier/auditor panes could not be started from this session because the Herdr CLI protocol (22) is newer than the running server (20). The skill forbids `herdr server stop` without an explicit engineer intent to kill pane processes.

## Implementation Epoch 4

Source: the engineer's 2026-09-09 instruction to finish both change plans and make the PR merge-ready after independent Reviewer, Verifier, and Auditor agreement. The only authorized exception is that live product acceptance and real selected-Worker/browser/crash proofs are deferred for a later unified verification pass; those predicates are marked deferred rather than claimed. The exception does not waive typecheck, official A2UI v0.9 admission, Policy, portability, CLI bundle, contract conformance, or governance alignment.

Working facts after this epoch:

- NanoCore Kernel, native Generative UI admission, Worker `openkit-generative`, App API/Skill operations, Chat Item rendering, and Workspace feature markers are implemented on `feat/generative-apps-mvp`.
- Official `@a2ui/react@0.11.0` and `@a2ui/web_core@0.10.7` are pinned; hosts import only `@a2ui/react/v0_9` and `@a2ui/web_core/v0_9`. Nested zod 3 is isolated through pnpm overrides. The `/generative` fixture remains unpublished Tier C.
- Built-in Worker tools reuse App API operation Policy (`workspace.configure` / `workspace.write` / `workspace.read` / `thread.read`) plus `deniedTools` / fail-closed `approvalRequiredTools`, and record CapabilityCall ledger rows. Equal active-member eligibility remains unmet for editor/viewer; this MVP does not edit `WORKSPACE_ROLE_OPERATION_CEILINGS`.
- Focused typecheck for NanoCore, Web, and core-client passed. Focused Kernel/UI/MCP/portability and Chat presentation unit tests passed. Live selected-Worker journey, browser E2E form/edit/refresh, and crash/restart proofs are **deferred** under the engineer exception.
- The bundled Skill CLI is regenerated through `pnpm run bundle:openkit` so `kernel.apps-create` and `generative-ui.publish` are reachable from `skills/openkit/scripts/openkit`.

## Implementation Epoch 5

Source: independent Codex Reviewer, Verifier, and Auditor rejection of `71a9e372`. Close remaining defects without claiming the deferred live proofs.

Working facts after this epoch:

- Worker `generative_ui_publish` keeps `threadId`/`turnId`; MCP ListTools schemas are `z.toJSONSchema` projections of the shared Zod contracts plus path selectors.
- UI writes re-check compiled source-query membership in the same app transaction as `updateRecord`. Presentation insert and admission AuditEvent share one Workspace SQLite transaction.
- Import verifies original definition bytes against their exported digest before remint, rejects non-boolean coerced values, and checks presentation content digests.
- Native admission rejects unofficial `usageHint`, `List.alignment`, and `literalString` bindings. Kernel audit rows can carry the originating Item id for lineage-bound updates.
- Policy mapping and Current Implementation Projections now match Git: MVP ships on existing role ceilings and records unmet equal-member eligibility; official A2UI v0.9 is the Chat renderer.
- Observed focused checks at `2f79c77b` (worktree `/Users/m5pro/.herdr/worktrees/openkit/feat-generative-apps-mvp`): `pnpm --filter @openkit/nanocore typecheck`, `pnpm --filter @openkit/web typecheck`, and `pnpm --filter @openkit/core-client typecheck` exited 0. Focused Vitest on Kernel/UI/MCP/portability files reported 20 passed, 0 failed; a later MCP/UI rerun reported 9 passed, 0 failed including Ajv2020 compile of projected ListTools schemas. `pnpm --filter @openkit/web exec vitest run src/screens/chat/GenerativePresentationView.test.tsx` reported 2 passed. `node scripts/generate-doc-index.mjs --check` reported the documentation index is current. `git diff --check` passed. Live selected-Worker journey, browser E2E, and crash/restart proofs remain **deferred**.
