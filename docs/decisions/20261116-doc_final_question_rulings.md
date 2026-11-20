---
status: Accepted
date: "2026-11-16"
decider: "Engineer, delegated to the DOC-FINAL ruling of 2026-11-16"
---
# DOC-FINAL Question Rulings

## Decision

The DOC-FINAL documentation alignment applies the following self-contained rulings across the specification, Core, and periphery corpus:

1. **Storage, backup, and work-data retention**:
   - `docs/specs/20260703-storage_layout_record_ownership.md` is rewritten to state the current physical database families and code table layout; unproduced Task-to-Goal explanation items are removed from its table, and both it and `docs/core/storage.md` state that a corrupt User database fails only that User while boot continues for other Users.
   - `docs/specs/20260921-work_data_retention_format.md` limits file rules to portable export and Worker capture; both it and `docs/core/storage.md` keep the access-class rule and delete the time-window wording; `docs/core/storage.md` admits `restricted-evidence` as code uses it; `legal-hold` stays reserved with no `v0.1.0` writer while keeping the deletion predicate and filing an issue for the operation.
   - `docs/specs/20261018-file_storage_and_knowledge_packages.md` owns storage lease records under ordinary Policy grants (with an `Implementation Gaps` line and issue for the missing producer) and states the reader format rules for duplicate handling, default root, and body media type.
   - `docs/specs/20260704-workspace_backup_export_import.md` removes Light App backup ownership (which moves to `docs/specs/20260908-generative_kernel_data_operations.md`) and states the archive path limits with long-path export refusal and the same-release restore rule as current rules, each with an `Implementation Gaps` line and issue.
   - `docs/specs/20260801-nanohost_workspace_data_boundary.md` names the workspace boundary root constant by its code owner.
2. **Vault, scheduler, NanoHost, and durable execution**:
   - `docs/specs/20260703-vault_secret_injection.md` absorbs credential access declarations, states each delivery channel with its implementation and activation state, and removes obsolete risk prose.
   - `docs/specs/20260703-durable_scheduler_design.md` absorbs runtime scheduling scale, sets the queue bound to fixed contract constant `20`, and links `docs/specs/20260802-nanohost_runtime_and_transport.md`, which owns on-demand idle Sandbox retirement.
   - In the NanoHost transport contract, credential renewal margin is `deadline - interval - bound`, slot `A` is the default at first credential issuance while either slot is valid, and the two timer statements follow code.
   - `docs/specs/20261019-durable_execution_and_control_store.md` becomes `Accepted` as the current contract without per-section status labels (unmet accepted rules go to `Implementation Gaps`, draft-only targets become issues, and `deliver-steer` is mapped per code under `#742`).
   - `docs/specs/20260628-nanocore_config_identity_contract.md` and `docs/specs/20261019-durable_execution_and_control_store.md` state the file revision service as the current configuration revision authority with a Gap and issue for database heads.
   - `docs/core/fault-tolerance.md` deletes historical measurements and narratives without linking change records, and `docs/specs/20260731-operational_telemetry_standardization.md` owns the closed stage strings emitted by code.
3. **Evidence, modes, Composer, timeline, and workspaces**:
   - `docs/specs/20260703-audit_usage_evidence_records.md` absorbs capability usage, states the current row form, drops "should carry" lists, and records the five unproduced recovery events in `Implementation Gaps` with an issue.
   - `docs/specs/20260704-chat_mode_assistant.md` matches the `resultRole` table and drops `approval-required` until the Assistant has a governed Tool; `docs/core/work-model.md`, `docs/specs/20260704-chat_mode_assistant.md`, `docs/specs/20260831-unified_conversation_composer.md`, and `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md` state that the Knowledge Manager opens its own `knowledge-manager` Thread and Turn for `knowledge.ask` while copying the returned answer and citations into the asking Chat Thread is answer projection rather than execution ownership (already implemented on `main`; add an `Implementation Gaps` line only if a separately evidenced own-Thread condition is unmet), and that busy-Thread submissions refuse with `thread_busy` except Task live steer (removing the Chat queue sentence, with a Gap and issue for the missing check).
   - `docs/specs/20260909-thread_visibility_and_sharing.md` and `docs/specs/20260704-chat_mode_assistant.md` keep shared conversation creation deferred in `v0.1.0` with a Gap (`creation is not gated`) and `IMPL-FIX` issue.
   - `docs/specs/20260704-task_mode_worker_delegation.md` states one request shape using direct-Task defaults, with Gap `#745` until code adopts it.
   - `docs/specs/20260531-human_attention_intervention_model.md` contracts only the produced human-attention kinds and members, keeping retained kinds as reserved and filing an issue to remove unproduced kinds from code.
   - `docs/specs/20261002-goal.md` keeps person-only authority for `goal.intent.revise` (with a Gap and `IMPL-FIX` issue for Coordinator admission and attribution) and places the derived index column outside the retained tuple.
   - `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md` and `docs/specs/20260902-agent_runtime_context_compaction.md` state that the Knowledge Manager uses shared-loop compaction and name `previousSummary`.
   - `docs/specs/20260831-unified_conversation_composer.md` adopts the code Composer interface (keeping Goal target wire kind `#744`) and owns dictation input; `docs/specs/20261108-conversation_timeline.md` follows registry data and code.
   - The one-way Personal Workspace data ruling of 2026-10-16 is recorded in its own decision record and the move sentence leaves `docs/core/work-model.md`.
4. **Security, operations, release, periphery, and held rulings**:
   - `docs/core/evidence.md` names security events as audit events while detailed lists stay in specifications; `docs/core/security.md` keeps the security principle while mechanics stay in `docs/specs/20261109-development_security.md`; `docs/specs/20261109-runtime_security.md` and `docs/specs/20261017-retained_format_register.md` name `security.containment`; `docs/specs/20261109-development_security.md` names the three tag-only release and promotion jobs with attestation permissions.
   - `docs/specs/20260909-deployment_host_requirements.md` bases its concurrency judgment on the single writer and the active-Turn bound and amends the systemd maintenance reservation.
   - `docs/specs/20260703-worker_control_protocol.md` names the qualification gate and qualified adapters; `docs/specs/20261014-retrieval_kernel.md` relabels the `P08` input; the first-release roadmap keeps `R102` open until `#245`; pilot statements and unbacked leading words leave role and governance documents; periphery procedures in `docs/toolchain.md` name owning files instead of counts, add the Retrieval Kernel pin to the update procedure, and state a lint exclusion only when a recorded reason exists (otherwise remove the exclusion sentence and open a GitHub issue); in `docs/cookbooks/release.md`, edit only after `RC9 PUBLISHED` and remove the CI-hold instruction only if the hold has ended (provisional on cluster K08 fact 3); delete guide transcripts and restated counts/constants (`T4`), and narrow the glossary row.
   - Held rulings from earlier audit passes are confirmed:
     - In `docs/specs/20260704-workflow_coordinator_internal_agent.md` and `docs/specs/20261002-goal.md` (surviving contract sections), replace legacy "Orchestrator" and "Task Mode Coordinator" role phrasing with the Internal Core Role `Workflow Coordinator`.
     - In `docs/core/work-model.md` and `docs/specs/20260704-workflow_coordinator_internal_agent.md`, Workflow Coordinator accepts only a trusted Task entry derived from the operation or an accepted handoff. It selects an eligible Worker and composes that request only. Its outcomes are `worker_turn` or `blocked`. It does not reclassify by keyword, and it does not own durable mode state, a Goal Plan, a Goal stop, progression, or context delivery. `worker_turn` keeps `requiredUserAction=none` and an empty prelaunch approval list. `blocked` requires refinement, carries no Worker payload, and creates no checkpoint or Worker Turn.
     - In `docs/specs/20261002-goal.md` and `docs/specs/20260704-workflow_coordinator_internal_agent.md`, Goal discovery consumes the runtime label, and Workflow Coordinator candidates omit it until a consumer exists. The installed release adapter registry is the source of that label set. Authored `runtime.kind` is not a universal closed enum. That registry has four adapters, but Goal discovery still admits only `codex` and `opencode`. The four-adapter registry is not proof that every consumer already admits all four. The accepted Goal contract keeps the registry label set, and the concrete consumer Gap stays with `docs/specs/20261002-goal.md`.
     - In `docs/core/protocol.md`, `docs/specs/20260921-work_data_retention_format.md`, `docs/specs/20261012-product_integrity_check.md`, and `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md` (following [Four Turn Terminal States](20260921-four_turn_terminal_states.md)), caller-cancelled still-nonterminal Knowledge Manager or maintenance Turns and Worker cancellation before backend effects produce terminal status `cancelled` with `stopReason=aborted`; Worker abort completion produces terminal status `interrupted` with `stopReason=aborted`; a Knowledge Manager owned deadline without caller cancellation produces terminal status `failed` with `stopReason=error`; all use the existing canonical `turn.completed` event and `turn-completed` payload with no new state, reason, or producer.
     - In `docs/specs/20260704-agent_session_continuity.md`, link the four Worker adapter specifications (`codex`, `opencode`, `pi`, and `deepseek`) rather than creating a new record, and in the NanoHost transport specification align the two liveness timer statements with code.
5. **Cross-corpus sweep rules (`R-SCHEMA`, `R-NUM`, `R-LABEL`, `R-DIGEST`, `R-TIME`)**:
   - `R-SCHEMA`: Never restate a field set, enum, or DDL held by an admitted contract artifact; name the artifact instead. List a closed protocol enum once in `docs/specs/20261021-protocol_identifiers_and_enums.md`. Include DDL only where a reader needs it to read saved data.
   - `R-NUM`: Every number in a document is a fixed contract constant or marked `"current default"` and matches code; remove any number that is neither.
   - `R-LABEL`: Include no tracker, plan, phase, or finding label unless the same document defines it; replace external labels with the owner link or GitHub issue number.
   - `R-DIGEST`: `docs/specs/20261021-protocol_identifiers_and_enums.md` owns the canonical digest form (RFC 8785 JSON + SHA-256). Each other owner lists only its inputs and links that specification, stating any code-retained exception explicitly.
   - `R-TIME`: Core carries no release staging label; staging lives in specification `Implementation Gaps` or the first-release roadmap, and only a release label that a decision record names as a contract boundary (such as `v0.1.0`) stays in Core.

## Reason

Round-2 documentation audit reviews identified 60 open questions, 4 held multi-owner corrections, and 5 recurring drift patterns (duplicated schemas and enums, unanchored numbers, phase/finding labels, repeated digest prose, and release staging labels in Core). Settling these rulings once under `G12` lets every document owner state the single current rule and exact implementation gaps without per-row round trips.

## Rejected Alternatives

- Retaining duplicated field tables, closed protocol enums, digest definitions, and non-contract numbers across multiple documents.
- Weakening accepted authorization, visibility, or data-continuity rules to match incomplete code instead of recording `Implementation Gaps` and `IMPL-FIX` issues.
- Editing root `AGENTS.md` for gap-maintenance wording that `docs/documentation-model.md` and `T3` already enforce.

## Revisit When

Revisit an individual question ruling when its linked `IMPL-FIX` or `FORMAT` issue lands, or when a post-`v0.1.0` migration decision replaces a pre-stable safe default.

## Affected Owners

- `docs/documentation-model.md`
- `docs/writing.md`
- `docs/change-execution.md`
- `docs/specs/20261021-protocol_identifiers_and_enums.md`
