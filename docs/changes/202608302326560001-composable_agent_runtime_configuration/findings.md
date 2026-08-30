# Findings

This report records non-authorizing findings raised by the independent Claude Code consultant and their disposition under the owning plan.

## Follow-up Index

- [x] `CARC-FND-001` [closed] Configuration scope ownership and authored composition
- [x] `CARC-FND-002` [closed] Duplicate Internal Role Catalog proposal
- [x] `CARC-FND-003` [closed] Logical-model routing and internal-role pinning conflict
- [x] `CARC-FND-004` [closed] Gateway fallback reversal lacks an owned contract
- [ ] `CARC-FND-005` [open] Worker credentials are resolved but not materialized
- [ ] `CARC-FND-006` [open] Workspace record rename and editable-field split can fail open
- [ ] `CARC-FND-007` [open] Harness concurrency owners and vocabulary are incomplete
- [ ] `CARC-FND-008` [open] Public model selection currently selects an Agent
- [x] `CARC-FND-009` [closed] Accepted owner inventory is incomplete
- [ ] `CARC-FND-010` [open] Pi direct-provider routing conflicts with hidden routes
- [x] `CARC-FND-011` [closed] Composer Shard label has no durable owner
- [ ] `CARC-FND-012` [open] Gateway model discovery leaks and over-advertises provider supply
- [ ] `CARC-FND-013` [open] Composer submission is Assistant-specific and attachment-free
- [x] `CARC-FND-014` [closed] Required-feature registry table diverged from implementation
- [x] `CARC-FND-015` [closed] Accepted runtime owners retained one-route and one-Harness contradictions
- [x] `CARC-FND-016` [closed] Logical-model capability and family strings lacked authority
- [ ] `CARC-FND-017` [open] Workspace public projection and config join are not implemented
- [x] `CARC-FND-018` [closed] Reload plan and native resume were documented as implemented seams
- [x] `CARC-FND-019` [closed] Composer ownership, lifecycle, target stability, and replay were incomplete
- [x] `CARC-FND-020` [closed] Documentation statuses and related accepted projections were stale
- [x] `CARC-FND-021` [closed] Change checkpoint did not describe the actual work state

## [closed] CARC-FND-001 — Configuration scope ownership and authored composition

- **Observation:** The plan assigns the Server, Workspace, and User scope relationship to Architecture and frames Workspace extension as resolver expansion, although Core Concepts and Identity own those terms and Agent Supply requires one authored setup before one-way resolution.
- **Impact:** Leaving the framing unchanged would duplicate canonical ownership and could turn resolution into a second authored authority.
- **Evidence:** The independent consultant cited `docs/core/core-concepts.md`, `docs/core/identity.md`, `docs/core/agent-supply.md:222`, and `docs/core/agent-supply.md:260` and classified owner placement and composition framing as design defects.
- **Owner:** `docs/core/core-concepts.md`, `docs/core/identity.md`, and `docs/core/agent-supply.md`.
- **Next action:** Amend the plan and accepted owners so Server manifest plus Workspace binding plus User preference form one composed authored setup before the existing one-way resolver runs. Closed 2026-08-31: the owning documents now carry the accepted relationship and composition boundary.
- **Closing verdict:** Closed because canonical scope ownership and the authored-composition boundary are now aligned.
- **Closure evidence:** `docs/core/core-concepts.md`, `docs/core/identity.md`, `docs/core/agent-supply.md`, `docs/specs/20260628-nanocore_config_identity_contract.md`, and `docs/specs/20260703-agent_manifest_aep_resolution.md` place the relationship and composed setup before one-way resolution.

## [closed] CARC-FND-002 — Duplicate Internal Role Catalog proposal

- **Observation:** The proposed Internal Role Catalog duplicates the already accepted Internal Role Execution Profile.
- **Impact:** A second entity would split role-configuration ownership and add an unnecessary catalog lifecycle.
- **Evidence:** The independent consultant cited `docs/specs/20260813-internal_agent_runtime.md:10`, `docs/specs/20260813-internal_agent_runtime.md:238`, and `docs/specs/20260813-internal_agent_runtime.md:250`.
- **Owner:** `docs/specs/20260813-internal_agent_runtime.md`.
- **Next action:** Remove the new catalog concept and give the existing execution profile a concrete Server file plus Workspace and User selection projection. Closed 2026-08-31: the existing Internal Role Execution Profile remains the sole entity.
- **Closing verdict:** Closed because the duplicate catalog proposal was deleted.
- **Closure evidence:** `docs/specs/20260813-internal_agent_runtime.md` remains the sole semantic owner and `docs/specs/20260628-nanocore_config_identity_contract.md` gives it one Server projection file without a second entity.

## [closed] CARC-FND-003 — Logical-model routing and internal-role pinning conflict

- **Observation:** Per-call concrete Gateway rerouting conflicts with the current internal-role contract that pins a concrete provider and model for one product execution and forbids mid-dispatch substitution.
- **Impact:** Internal-role independence and capability requirements cannot be enforced if every private route is treated as equivalent.
- **Evidence:** The independent consultant cited `docs/specs/20260813-internal_agent_runtime.md:240`, `docs/specs/20260813-internal_agent_runtime.md:246`, and `docs/specs/20260813-internal_agent_runtime.md:250`.
- **Owner:** `docs/specs/20260813-internal_agent_runtime.md` and `docs/specs/20260526-llm_gateway_responses_api.md`.
- **Next action:** Define a logical model with declared capabilities and an independence or family class, pin the product execution to that logical contract, and permit per-call route changes only among members satisfying it. Closed 2026-08-31: the accepted correction derives capability and family from the pinned catalog rather than trusting authored declarations.
- **Closing verdict:** Closed because per-call routing now preserves one proved logical contract.
- **Closure evidence:** `docs/specs/20260526-llm_gateway_responses_api.md` derives capability and family, while `docs/specs/20260813-internal_agent_runtime.md` pins the logical ID, effective capabilities, and `modelFamilyId` for one run.

## [closed] CARC-FND-004 — Gateway fallback reversal lacks an owned contract

- **Observation:** The plan proposes future provider and account fallback while the accepted Gateway specification explicitly excludes provider or account fallback.
- **Impact:** Load balancing, quota rotation, and failover would otherwise enter implementation without owned eligibility, retry, attribution, and terminal-failure semantics.
- **Evidence:** The independent consultant cited the Non-goals and Provider Profiles sections of `docs/specs/20260526-llm_gateway_responses_api.md` and the one-account-slot-per-profile rule.
- **Owner:** `docs/specs/20260526-llm_gateway_responses_api.md` and `docs/specs/20260721-provider_subscription_accounts.md`.
- **Next action:** Explicitly supersede the non-goal, define the smallest ordered route-member contract and safe failure classes, and defer weights, health algorithms, and strategy frameworks. Closed 2026-08-31: implementation is limited to that accepted ordered-route fallback contract.
- **Closing verdict:** Closed because the smallest current fallback contract and its exclusions have one accepted owner.
- **Closure evidence:** `docs/specs/20260526-llm_gateway_responses_api.md` defines ordered members, pre-output eligibility, attempt lineage, exhaustion, stable failures, and explicit balancing deferrals.

## [open] CARC-FND-005 — Worker credentials are resolved but not materialized

- **Observation:** Production resolves and receipts provider, runtime-environment, and runtime-file credentials but the NanoHost governance backend does not consume them during materialization.
- **Impact:** Workspace credential binding and dynamic existing-secret replacement cannot pass real end-to-end acceptance in the current implementation.
- **Evidence:** The independent consultant cited `apps/nanocore/src/runtime/worker-governance-turn-executor.ts:1116`, `apps/nanocore/src/runtime/worker-governance-turn-executor.ts:1307`, and `apps/nanocore/src/runtime/turn-executor-factory.ts:881`.
- **Owner:** `docs/specs/20260709-worker_credential_access_declarations.md`, `docs/specs/20260703-vault_secret_injection.md`, and the NanoHost materialization owners.
- **Next action:** Keep credential materialization inside this plan, complete the NanoHost or OpenShell projection, and prove existing-secret replacement plus process-static addition behavior through the real effect domain.

## [open] CARC-FND-006 — Workspace record rename and editable-field split can fail open

- **Observation:** Some current readers silently skip a Workspace when `workspace.json` is absent while others fail, so a direct rename to `workspace-record.json` can make an old directory look half-built. The same current record also owns editable `name` and execution defaults that belong in `workspace.jsonc` under the accepted target.
- **Impact:** Boot index reconstruction could omit authoritative Workspace state without a compatibility alias or a visible error, while a partial field move could create two writers or lose the Workspace name.
- **Evidence:** The independent consultant cited `apps/nanocore/src/storage/index-rebuild.ts:435` and `apps/nanocore/src/storage/command-request-records.ts:127` plus export and import readers.
- **Owner:** `docs/specs/20260703-storage_layout_record_ownership.md` and `docs/specs/20260704-workspace_backup_export_import.md`.
- **Next action:** Define and implement a loud fail-closed rejection when an old record file is present, move `name` and `defaultAgentId` atomically into `workspace.jsonc`, delete `defaultModelId` and `defaultSkillIds`, sweep every reader and writer, and retain no dual read or migration alias.

## [open] CARC-FND-007 — Harness concurrency owners and vocabulary are incomplete

- **Observation:** The requested multi-Harness and concurrent-AgentSession behavior is blocked by a one-Harness database index, Harness and NanoCore single-active-Turn checks, absent scheduler authorization, and a required-feature description that incorrectly permits concurrent Turns in one AgentSession.
- **Impact:** Editing only the Harness would bypass the unique scheduling authority and contradict the one-active-Turn-per-AgentSession invariant.
- **Evidence:** The independent consultant cited `apps/nanocore/src/storage/schema/nanohost-harness-runtime.ts:101`, `packages/worker-shim/src/harness.ts:183`, `apps/nanocore/src/runtime/turn-executor-factory.ts:567`, `docs/specs/20260703-runtime_scheduling_scale.md:71`, and `packages/config-schema/src/schema-evolution.ts:34`.
- **Owner:** `docs/specs/20260703-runtime_scheduling_scale.md`, `docs/specs/20260703-durable_scheduler_design.md`, and `docs/specs/20260802-nanohost_runtime_and_transport.md`.
- **Next action:** Activate the reserved compatibility seam across all three owners, keep one active Turn per Thread and AgentSession, and update the existing `session.concurrent-turns` registry description plus mirrored table together without renaming the feature.

## [open] CARC-FND-008 — Public model selection currently selects an Agent

- **Observation:** Current public `modelId` handling derives an Agent from provider-native model equality and rejects independently selected Agent and model combinations.
- **Impact:** The Composer cannot offer independent Agent and logical Model selectors until this inversion is removed.
- **Evidence:** The independent consultant cited `apps/nanocore/src/runtime/orchestrator.ts:148`, `apps/nanocore/src/runtime/orchestrator.ts:226`, and `apps/nanocore/src/runtime/product-turn-start.ts:95`.
- **Owner:** The Turn request, Agent selector, Agent Manifest resolver, and Gateway logical-model contract.
- **Next action:** Delete model-to-Agent resolution, add explicit Agent and profile input, and make `modelId` only a logical model preference validated after Agent selection.

## [closed] CARC-FND-009 — Accepted owner inventory is incomplete

- **Observation:** The plan omits seven accepted owners whose contracts the requested implementation changes.
- **Impact:** Documentation edits could leave scheduler, credential, Pi, subscription-account, Core Client, or portable Workspace contracts stale.
- **Evidence:** The independent consultant named `docs/specs/20260703-runtime_scheduling_scale.md`, `docs/specs/20260703-durable_scheduler_design.md`, `docs/specs/20260709-worker_credential_access_declarations.md`, `docs/specs/20260716-pi_worker_adapter.md`, `docs/specs/20260721-provider_subscription_accounts.md`, `docs/specs/20260528-core_client_boundary.md`, and `docs/specs/20260704-workspace_backup_export_import.md`.
- **Owner:** The owning plan.
- **Next action:** Add the seven documents to the owner inventory and modify each only for the contract it uniquely owns. Closed 2026-08-31: the plan inventory and documentation diff include those affected owners.
- **Closing verdict:** Closed because every material affected owner identified by the consultant is now in the inventory and diff.
- **Closure evidence:** The plan's Accepted Owners section names the scheduling, credential, Pi, subscription-account, Core Client, and Workspace portability documents, and the current documentation diff updates each affected contract.

## [open] CARC-FND-010 — Pi direct-provider routing conflicts with hidden routes

- **Observation:** The accepted Pi worker adapter is direct-provider-only and carries worker-visible provider credentials, while the target design requires every dispatchable worker route to remain Gateway-private.
- **Impact:** Pi cannot truthfully participate in the logical-model contract without a relay-capable projection or an explicit non-ready disposition.
- **Evidence:** The independent consultant cited `docs/specs/20260716-pi_worker_adapter.md` and the closed runtime-route matrix in `docs/specs/20260703-agent_manifest_aep_resolution.md`.
- **Owner:** `docs/specs/20260716-pi_worker_adapter.md` and the Agent Manifest, AEP, and Gateway owners.
- **Next action:** Make Gateway-private relay support a readiness requirement and keep Pi non-dispatchable under this target until its pinned adapter can satisfy it; do not preserve the direct-provider exception.

## [closed] CARC-FND-011 — Composer Shard label has no durable owner

- **Observation:** `Shard` has no accepted or implemented repository concept, while Thread, Turn, and Task Mode already express a new bounded worker execution.
- **Impact:** Promoting Shard from a UI label would create an unneeded durable task entity and duplicate lifecycle truth.
- **Evidence:** The independent consultant found no repository Shard definition and cited the current text-only `Composer` and Chat starter request paths.
- **Owner:** `docs/core/work-model.md` and `docs/specs/20260704-task_mode_worker_delegation.md`.
- **Next action:** Keep New Shard + Worker as a product label for creating a new Task execution Thread and worker, with no Shard record, API identity, or lifecycle. Closed 2026-08-31: implementation uses the existing Task Thread lifecycle.
- **Closing verdict:** Closed because no Shard entity is needed or authorized.
- **Closure evidence:** `docs/core/work-model.md`, `docs/specs/20260704-task_mode_worker_delegation.md`, and `docs/specs/20260831-unified_conversation_composer.md` map the label to linked Task Thread creation and reject a Shard record, identifier, API, or lifecycle.

## [open] CARC-FND-012 — Gateway model discovery leaks and over-advertises provider supply

- **Observation:** `GET /v1/models` advertises models across allowlisted profiles and exposes `owned_by: profile.id`, while dispatch resolves only one default provider and rejects models absent from that profile.
- **Impact:** The public model catalog can advertise an unusable model and leaks a concrete provider profile identity that the logical-model design must hide.
- **Evidence:** The independent consultant cited `apps/nanocore/src/llm/gateway-routes.ts:1744`, `apps/nanocore/src/llm/gateway-routes.ts:1785`, `apps/nanocore/src/llm/gateway-routes.ts:1986`, and `apps/nanocore/src/app.ts:1022`.
- **Owner:** `docs/specs/20260526-llm_gateway_responses_api.md`.
- **Next action:** Make model discovery and dispatch use the same logical-model catalog, remove provider profile identity from public ownership fields, and add a two-provider regression.

## [open] CARC-FND-013 — Composer submission is Assistant-specific and attachment-free

- **Observation:** The shared Web `Composer` emits only a text string, the starter creates a Thread and calls `client.app.startChatMode`, and the strict Chat request contains only `input` and `requestId`. The current public command name and receipt owner are Assistant-specific even though the requested control must address internal roles, existing Workers, and new Task work.
- **Impact:** Adding target-specific calls in Web would turn the client into a second dispatcher, duplicate replay behavior, and leave the Agent and Model selectors unrelated to one accepted command. Adding a general upload service would also duplicate the existing Artifact import owner for the first supported text-file slice.
- **Evidence:** Current `apps/web/src/primitives/Composer.tsx`, `apps/web/src/screens/chat/ChatStarter.tsx`, `apps/web/src/screens/chat/data.ts`, `packages/app-api-schemas/src/chat-mode.ts`, `packages/core-client/src/app.ts`, and `apps/nanocore/src/mode-entry-routes.ts` show the text-only `chat.start` chain; `artifact.import` already accepts bounded UTF-8 Markdown, text, and JSON content.
- **Owner:** `docs/specs/20260831-unified_conversation_composer.md`, `docs/specs/20260528-core_client_boundary.md`, and `docs/specs/20260713-work_resource_interaction_model.md`.
- **Next action:** Replace `chat.start` with one structured `conversation.submit` command and one Workspace target catalog, branch into existing execution owners inside NanoCore, reuse Artifact import for supported local text files, and retain no old route or second dispatcher.

## [closed] CARC-FND-014 — Required-feature registry table diverged from implementation

- **Observation:** The first documentation draft renamed `session.concurrent-turns` to `runtime.harness.concurrent-turns` while the shared registry and its contract test retained the current identifier.
- **Impact:** The docs-only baseline failed `@openkit/config-schema` tests and could not truthfully precede implementation.
- **Evidence:** Both independent documentation reviewers reproduced the registry/spec-table mismatch.
- **Owner:** `docs/specs/20260703-schema_evolution_record_envelope.md` and `@openkit/config-schema`.
- **Next action:** Restore the current registry identifier and exact implemented description in the mirrored table, then update the semantic description in code and the table together during Stage E. Closed 2026-08-31: the docs-only registry projection again matches implementation.
- **Closing verdict:** Closed because the docs-only table again mirrors the implemented registry and no rename remains.
- **Closure evidence:** `docs/specs/20260703-schema_evolution_record_envelope.md` retains `session.concurrent-turns`; its current table matches `packages/config-schema/src/schema-evolution.ts`, while Stage E owns the semantic-description correction in both artifacts together.

## [closed] CARC-FND-015 — Accepted runtime owners retained one-route and one-Harness contradictions

- **Observation:** Session materialization, AgentSession continuity, worker communication, and policy projections still asserted one route, one active Turn across a Harness, or no Harness compatibility key.
- **Impact:** The new AEP and multi-Harness target would have contradicted accepted upstream owners even if its own documents were internally consistent.
- **Evidence:** The FalseFire review identified the conflicting sections in the session-static, AgentSession-continuity, worker-runtime, AEP, policy, OpenShell, and image owners.
- **Owner:** The affected accepted runtime specifications.
- **Next action:** Reconcile the one-route, one-Harness, and single-flight language across every affected accepted runtime owner. Closed 2026-08-31: implementation now has one coherent target across those owners.
- **Closing verdict:** Closed because the accepted runtime owners now state one coherent target without one-route or one-Harness contradictions.
- **Closure evidence:** The worker-communication, session-static, AgentSession-continuity, AEP, NanoHost, worker-control, policy, OpenShell, and image specifications agree on logical-model admission, per-Session single flight, bounded cross-Session concurrency, and multiple compatibility-keyed Harnesses.

## [closed] CARC-FND-016 — Logical-model capability and family strings lacked authority

- **Observation:** The first Gateway draft allowed arbitrary authored `capabilities` and `independenceClass` strings with no closed vocabulary or validating owner.
- **Impact:** Route equivalence and role independence could be asserted rather than proved.
- **Evidence:** Both documentation reviews requested a closed authority and the repository already vendors models.dev fields including model family and capability facts.
- **Owner:** `docs/specs/20260526-llm_gateway_responses_api.md` and `@openkit/models-dev-catalog`.
- **Next action:** Remove free-form capability and independence assertions and derive route equivalence from one pinned catalog plus endpoint matrix. Closed 2026-08-31: the Gateway owner now defines that derivation.
- **Closing verdict:** Closed because route equivalence is derived from a pinned authority rather than asserted through free strings.
- **Closure evidence:** `docs/specs/20260526-llm_gateway_responses_api.md` authors only logical identity, display name, and ordered routes and derives the effective capabilities and `modelFamilyId` from `@openkit/models-dev-catalog` plus the endpoint matrix.

## [open] CARC-FND-017 — Workspace public projection and config join are not implemented

- **Observation:** Current protocol and Store code still serialize `name` and `defaults` in `WorkspaceRecordSchema` and `workspace.json` rather than joining editable config with a system record.
- **Impact:** Moving the files alone would either remove the product-visible name or leave duplicate authority and stale defaults.
- **Evidence:** The FalseFire review traced `packages/protocol/src/models/workspace.ts` and the Store creation path.
- **Owner:** Storage layout, configuration identity, protocol/App API projection, Core Client, and Web Workspace consumers.
- **Next action:** In Stage E, delete `WorkspaceDefaultsSchema`, retain protocol `name` only as a joined config projection, implement atomic pair creation and last-known-good failure behavior, and update every reader, writer, export, import, fixture, and test.

## [closed] CARC-FND-018 — Reload plan and native resume were documented as implemented seams

- **Observation:** The first correction treated `staleWhenPackageChanges` as a reload-plan output and exact native-handle resume as missing. Second-round code falsification proved that the name belongs to an unused AEP field, while Codex already launches one child per Turn and resumes the retained native handle from AgentSession-private state.
- **Impact:** Keeping the false claims would authorize an unnecessary reload consumer, resident-process replacement path, and adapter input while making the stated acceptance predicate impossible for the implemented per-Turn runtime.
- **Evidence:** `packages/config-schema/src/agent-environment.ts`, `apps/nanocore/src/runtime/agent-environment.ts`, `apps/nanocore/src/config/runtime-config.ts`, `packages/worker-shim/src/harness.ts`, and `packages/worker-shim/src/adapters/codex.ts` show the unused AEP value, actual reload outcomes, per-Turn child launch, exact `codex exec resume`, and retained handle persistence.
- **Owner:** Configuration reload, AgentSession continuity, NanoHost runtime, worker control, and Codex adapter contracts.
- **Next action:** In Stage E, consume the reload plan after the active Turn, add the smallest exact resume input through the accepted adapter boundary, prove the retained handle, and fall back to ordinary successor AgentSession replacement when resume cannot be proved. Reframed and closed 2026-08-31: remove the unused AEP field, preserve the existing Codex resume path, and prove that later composed setup enters the next per-Turn launch; add resident-process replacement only if an implemented adapter demonstrates that present need.
- **Closing verdict:** Closed because current facts and the accepted activation contract now use the implemented per-Turn process lifecycle and delete the speculative mechanism.
- **Closure evidence:** `docs/specs/20260628-nanocore_config_identity_contract.md`, `docs/specs/20260704-agent_session_continuity.md`, `docs/specs/20260703-agent_manifest_aep_resolution.md`, `docs/specs/20260703-vault_secret_injection.md`, `docs/specs/20260709-worker_credential_access_declarations.md`, and `docs/specs/20260802-nanohost_runtime_and_transport.md` state natural next-Turn activation and exact existing Codex resume.

## [closed] CARC-FND-019 — Composer ownership, lifecycle, target stability, and replay were incomplete

- **Observation:** Observable Composer behavior was split among DESIGN and Web docs, target references lacked stability rules, starter Thread half-state was unspecified, and replay did not close every dispatch branch or cross-Workspace response.
- **Impact:** UI and NanoCore could implement incompatible contracts or repeat an effect after uncertainty.
- **Evidence:** Both independent documentation reviews identified authority inversion and missing lifecycle or replay semantics.
- **Owner:** `docs/specs/20260831-unified_conversation_composer.md` with Web projection and stack owners.
- **Next action:** Move observable Composer behavior, target stability, starter failure disposition, and exact branch replay into one accepted owner. Closed 2026-08-31: implementation follows that Composer and command lifecycle contract.
- **Closing verdict:** Closed because one accepted specification now owns the missing Composer behavior and command lifecycle.
- **Closure evidence:** `docs/specs/20260831-unified_conversation_composer.md` defines the exact interaction, stable target reference, catalog join boundary, starter half-state, receipt fields, every dispatch replay, legacy command disposition, and receiving Workspace and Thread.

## [closed] CARC-FND-020 — Documentation statuses and related accepted projections were stale

- **Observation:** Multi-user Workspace and Pi specs remained marked Implemented despite new accepted but unimplemented targets, while several active policy, OpenShell, image, and Quick Chat projections retained stale vocabulary.
- **Impact:** Readers and implementation agents could mistake the target for current behavior or follow conflicting defaults and Provider-route guidance.
- **Evidence:** The governance audit enumerated the stale status and projection locations.
- **Owner:** Each affected specification.
- **Next action:** Correct implementation metadata and sweep every affected accepted projection for stale Provider, Harness, Workspace, and Quick Chat language. Closed 2026-08-31: the affected projections distinguish implemented behavior from accepted target behavior.
- **Closing verdict:** Closed because implementation metadata and active projections now distinguish current behavior from the accepted target.
- **Closure evidence:** The multi-user Workspace and Pi headers are `Partial`; the AEP, NanoHost, AgentSession, image, Quick Chat, policy, OpenShell, materialization, and communication specs record current divergences and reconciled target vocabulary.

## [closed] CARC-FND-021 — Change checkpoint did not describe the actual work state

- **Observation:** The first checkpoint claimed that no accepted document had been edited, counted twelve consultant findings despite thirteen entries, and did not record the two failed independent documentation reviews.
- **Impact:** The execution ledger could not be used to decide the documentation gate honestly.
- **Evidence:** The repository-governance audit compared the checkpoint with the actual diff and review results.
- **Owner:** This change record.
- **Next action:** Correct the checkpoint's document count, finding count, review outcomes, and implementation frontier, then keep it current at each durable boundary. Closed 2026-08-31: the checkpoint matches the current repository and review state.
- **Closing verdict:** Closed because the change ledger now matches the repository and review state.
- **Closure evidence:** The plan's Working Checkpoint records forty-four modified tracked documents plus two new documents, all thirteen consultant findings, both initial review failures, remaining open implementation work, and the independent re-review gate.
