# Specifications

This directory contains design specifications for non-trivial OpenKit changes.

Specs are the contract layer between stable core documents and implementation.
They translate core concepts, boundaries, and principles into concrete,
verifiable design contracts for modules, protocols, data models, lifecycle
rules, migration paths, and implementation work.

Use [`docs/change-tracking.md`](../change-tracking.md) as the canonical policy for how specs relate to stable core docs, change records, and working logs.

## Purpose

- Preserve important design decisions, alternatives, trade-offs, constraints, rollout plans, removal plans, migration plans, and open questions.
- Make current architecture and technical decisions discoverable without forcing readers to reconstruct them from historical change records.
- Sit below stable `docs/core/` model documents and above implementation lifecycle records in `docs/changes/`.
- Define implementation-facing contracts that can be reviewed, tested, and evolved without redefining core concepts.
- Capture current implementation projections when useful, while keeping those projections separate from stable conceptual definitions.

## What Belongs In A Spec

Specs should describe concrete design and implementation contracts:

- Scope, ownership, non-ownership, and links to the stable core documents the spec depends on.
- Behavioral contracts, expected behavior, state transitions, lifecycle rules, error semantics, permission rules, and recovery semantics.
- Interfaces, protocol shapes, data shapes, API boundaries, storage layout decisions, event contracts, gateway contracts, and tool contracts.
- Implementation projections that map the design to current packages, endpoints, tables, files, runtime services, or adapters.
- Removal, migration, rollout, and deprecation plans when behavior or data must change over time.
- External interoperability constraints when OpenKit intentionally projects or consumes an external protocol.
- Security, privacy, identity, permission, credential, network, audit, metering, or observability constraints that are part of the contract.
- Testing strategy and acceptance criteria that explain how the design is verified.
- Open questions that represent unresolved design decisions related to the current spec.
- Deferred or future work that is important but outside the current contract or implementation scope.

## What Does Not Belong In A Spec

Specs must not become a second source of truth for stable core concepts.

Do not put these in specs:

- Product vision, mission, product-level principles, or broad system philosophy that belongs in `docs/product-vision.md` or `docs/core/`.
- Canonical definitions already owned by `docs/core/`; specs may reference or project them, but must not redefine them.
- Task logs, release progress logs, implementation journals, or one-off summaries that belong in `docs/changes/` or `docs/working_logs/`.
- Raw research notes or external references; distill accepted conclusions into a design decision instead.
- Detailed code walkthroughs unless they are needed as a current implementation projection.
- Repeated explanations of concepts already covered by another active spec; use cross-references instead.

## When To Write A Spec

Write or update a spec when a change has meaningful alternatives, long-term consequences, removal or migration concerns, rollout concerns, protocol or API impact, data layout impact, or developer workflow impact.

Do not use specs as task logs, release progress logs, or one-off implementation summaries.

## Relationship To Other Directories

- `docs/core/` owns stable core model decisions.
- `docs/specs/` owns implementation-facing design contracts, alternatives, consequences, rollout plans, migration plans, and unresolved questions.
- `docs/changes/` owns concise lifecycle records for material PRs, standalone important changes, and release summaries.
- `docs/working_logs/` owns archived long-run release PRDs, task lists, and progress logs.

Core documents define canonical concepts once. Specs reference those concepts and
describe how they are realized for a concrete module, protocol, data shape, or
workflow. Change records explain what changed in a specific lifecycle event.

## Active Spec Index

Current specs live at the root of this directory. Read the relevant core document first, then the active spec that owns the concrete implementation contract.

Kernel, protocol, and product surfaces:

- [`20260628-protocol_contract_consolidation.md`](./20260628-protocol_contract_consolidation.md)
- [`20260528-core_client_boundary.md`](./20260528-core_client_boundary.md)
- [`20260628-nanocore_config_identity_contract.md`](./20260628-nanocore_config_identity_contract.md)
- [`20260704-nanocore_bootstrap_readiness.md`](./20260704-nanocore_bootstrap_readiness.md)
- [`20260704-remote_auth_credential_bootstrap.md`](./20260704-remote_auth_credential_bootstrap.md)
- [`20260704-app_api_openapi_projection.md`](./20260704-app_api_openapi_projection.md)
- [`20260628-web_product_surface_projection.md`](./20260628-web_product_surface_projection.md)
- [`20260710-web_ui_rebuild_stack.md`](./20260710-web_ui_rebuild_stack.md)
- [`20260617-openkit_ai_interface.md`](./20260617-openkit_ai_interface.md)

Workflow, human attention, and verification:

- [`20260704-chat_mode_assistant.md`](./20260704-chat_mode_assistant.md)
- [`20260704-task_mode_worker_delegation.md`](./20260704-task_mode_worker_delegation.md)
- [`20260704-goal_mode_coordination.md`](./20260704-goal_mode_coordination.md)
- [`20260704-workflow_coordinator_internal_agent.md`](./20260704-workflow_coordinator_internal_agent.md)
- [`20260709-quick_chat_workspace.md`](./20260709-quick_chat_workspace.md)
- [`20260704-knowledge_manager_internal_agent_runtime.md`](./20260704-knowledge_manager_internal_agent_runtime.md)
- [`20260627-openkit_development_loop_protocol.md`](./20260627-openkit_development_loop_protocol.md)
- [`20260531-worker_turn_reliability_envelope.md`](./20260531-worker_turn_reliability_envelope.md)
- [`20260531-human_attention_intervention_model.md`](./20260531-human_attention_intervention_model.md)
- [`20260529-test_strategy.md`](./20260529-test_strategy.md)
- [`20260529-l6_story_acceptance.md`](./20260529-l6_story_acceptance.md)

Worker runtime, supply, and synchronization:

- [`20260616-agent_environment_package.md`](./20260616-agent_environment_package.md)
- [`20260628-agent_setup_runtime_supply_contract.md`](./20260628-agent_setup_runtime_supply_contract.md)
- [`20260703-agent_manifest_aep_resolution.md`](./20260703-agent_manifest_aep_resolution.md)
- [`20260629-worker_runtime_communication_model.md`](./20260629-worker_runtime_communication_model.md)
- [`20260711-worker_runtime_subagent_provenance.md`](./20260711-worker_runtime_subagent_provenance.md)
- [`20260627-remote_openshell_gateway.md`](./20260627-remote_openshell_gateway.md)
- [`20260708-container_image_packaging.md`](./20260708-container_image_packaging.md)
- [`20260704-session_static_workspace_materialization.md`](./20260704-session_static_workspace_materialization.md)
- [`20260704-workspace_data_source_catalog.md`](./20260704-workspace_data_source_catalog.md)
- [`20260703-runtime_scheduling_scale.md`](./20260703-runtime_scheduling_scale.md)
- [`20260703-durable_scheduler_design.md`](./20260703-durable_scheduler_design.md)
- [`20260703-worker_control_protocol.md`](./20260703-worker_control_protocol.md)
- [`20260703-worker_context_package.md`](./20260703-worker_context_package.md)
- [`20260703-worker_agent_capability.md`](./20260703-worker_agent_capability.md)
- [`20260704-worker_mcp_tool_supply.md`](./20260704-worker_mcp_tool_supply.md)
- [`20260704-agent_session_continuity.md`](./20260704-agent_session_continuity.md)
- [`20260703-workspace_synchronization.md`](./20260703-workspace_synchronization.md)
- [`20260704-git_write_workflow.md`](./20260704-git_write_workflow.md)
- [`20260709-worker_credential_access_declarations.md`](./20260709-worker_credential_access_declarations.md)
- [`20260709-worker_sandbox_freedom_policy.md`](./20260709-worker_sandbox_freedom_policy.md)
- [`20260711-scheduler_recurring_event_triggers.md`](./20260711-scheduler_recurring_event_triggers.md)

Storage, knowledge, policy, vault, audit, and metering:

- [`20260703-storage_layout_record_ownership.md`](./20260703-storage_layout_record_ownership.md)
- [`20260703-schema_evolution_record_envelope.md`](./20260703-schema_evolution_record_envelope.md)
- [`20260702-knowledge_store_governance_rules.md`](./20260702-knowledge_store_governance_rules.md)
- [`20260703-knowledge_store_implementation.md`](./20260703-knowledge_store_implementation.md)
- [`20260629-openkit_policy_model.md`](./20260629-openkit_policy_model.md)
- [`20260703-policy_enforcement_mapping.md`](./20260703-policy_enforcement_mapping.md)
- [`20260703-vault_secret_injection.md`](./20260703-vault_secret_injection.md)
- [`20260704-vault_backend_implementation.md`](./20260704-vault_backend_implementation.md)
- [`20260703-openshell_mechanism_internalization.md`](./20260703-openshell_mechanism_internalization.md)
- [`20260703-audit_usage_evidence_records.md`](./20260703-audit_usage_evidence_records.md)
- [`20260704-workspace_backup_export_import.md`](./20260704-workspace_backup_export_import.md)
- [`20260710-self_improvement_evaluation_loop.md`](./20260710-self_improvement_evaluation_loop.md)
- [`20260711-evaluation_harness_design.md`](./20260711-evaluation_harness_design.md)

Capability and provider slices:

- [`20260526-llm_gateway_responses_api.md`](./20260526-llm_gateway_responses_api.md)
- [`20260703-pi_ai_provider_gateway_adoption.md`](./20260703-pi_ai_provider_gateway_adoption.md)
- [`20260708-pi_ai_unified_llm_backend.md`](./20260708-pi_ai_unified_llm_backend.md)
- [`20260704-capability_usage_gateway_foundation.md`](./20260704-capability_usage_gateway_foundation.md)
- [`20260526-codex_chatgpt_subscription_login.md`](./20260526-codex_chatgpt_subscription_login.md)
- [`20260522-vendor_snapshot_packages.md`](./20260522-vendor_snapshot_packages.md)
- [`20260711-skill_catalog_versioning_pinning.md`](./20260711-skill_catalog_versioning_pinning.md)

Historical or supporting material lives under the status-matching `superseded/`, `retired/`, or `rejected/` directory and must not be treated as current guidance unless an active root spec links to it explicitly as background.

## Status Values

Every spec MUST state exactly one document-authority status near the top.

`Status` describes whether the document is current guidance. It does not
describe whether the implementation is complete.

- `Draft`: proposed or still being shaped.
- `Accepted`: current guidance for implementation and review.
- `Deprecated`: still describes existing legacy or external interoperability behavior, but should not be extended as the future design direction.
- `Superseded`: its contract or substantive proposal continues under a named replacement spec or stable core document, which is now the current authority.
- `Retired`: its contract or product capability ended without a successor contract, including a module or product surface that was removed or deliberately reset.
- `Rejected`: the proposal never became current guidance because review found it unsound, infeasible, unnecessary, or contrary to the chosen direction.

`Archived` is not a status. It describes retaining a non-active file for
historical evidence under `superseded/`, `retired/`, or `rejected/`.

The existence of a later document about the same product area does not by
itself make an older spec `Superseded`. Use `Superseded` only when the later
authority actually continues or absorbs the earlier contract or substantive proposal. Use `Retired`
when the old contract was ended and a later design starts again from a new
contract.

Do not use `Completed` as a `Status`. Completion is implementation alignment,
not document authority.

## Implementation Values

Every spec MUST state exactly one implementation-alignment value near the top.

`Implementation` describes how the current system relates to the spec contract.
It does not decide whether the spec is current guidance.

- `Not Started`: the accepted contract has no meaningful implementation yet.
- `In Progress`: implementation work is actively underway.
- `Partial`: the system implements part of the contract, but acceptance criteria are not fully satisfied.
- `Implemented`: the system, tests, and current implementation projection are aligned with the spec contract.
- `Diverged`: the current system no longer matches the spec and the spec or implementation needs review.
- `N/A`: implementation alignment does not apply to this spec.

The values and capitalization above are exact. Do not introduce descriptive
variants such as `Not started` or `Standard-aligned subset`; explain narrower
alignment under `Current Implementation Projection` and use the closest exact
value.

Common combinations:

- `Status: Draft` with `Implementation: N/A` or `Not Started` while the design is still being shaped.
- `Status: Accepted` with any implementation value from `Not Started` through `Implemented`.
- `Status: Accepted` with `Implementation: Diverged` when the design is still intended to be current but the implementation or documentation has drifted.
- `Status: Deprecated` when existing legacy or external interoperability behavior remains documented but should not be extended.
- `Status: Superseded` with `Implementation: N/A` when a named replacement owns the continuing contract.
- `Status: Retired` with `Implementation: N/A` when the contract or capability ended without a successor.
- `Status: Rejected` with `Implementation: N/A` when a proposal was declined before acceptance.

When a diverged spec is reconciled and again represents the current contract,
keep or restore `Status: Accepted` and set `Implementation` to the real
alignment value.

## Lifecycle Transitions

Normal transitions are:

```text
Draft -> Accepted
Draft -> Rejected
Draft -> Superseded
Accepted -> Deprecated -> Superseded | Retired
Accepted -> Superseded
Accepted -> Retired
Deprecated -> Accepted
```

`Deprecated` is transitional: the old behavior still exists and needs current
documentation, but it must not be extended. `Superseded`, `Retired`, and
`Rejected` are terminal document-authority states. A terminal spec may return
to an active state only through an explicit new decision that explains why the
earlier terminal decision no longer applies. Returning a `Deprecated` spec to
`Accepted` likewise requires an explicit decision that cancels the deprecation.

## Lifecycle Evidence

Every `Deprecated`, `Superseded`, `Retired`, or `Rejected` spec MUST include the
following metadata near the top:

```markdown
Status Changed: YYYY-MM-DD
Current Guidance: <repository-relative link or None>
Decision Evidence: <change record, PR, issue, or commit link>
```

It MUST also include a substantive `Lifecycle Reason` section. Every archived
terminal spec MUST additionally include a substantive `Retention Reason`
section.

- `Lifecycle Reason` explains what decision or condition ended or restricted the old document's authority, why the old contract is no longer current, and which parts of the old direction are invalid or discontinued.
- `Retention Reason` explains which historical constraints, rejected alternatives, migration details, edge cases, or audit evidence remain useful enough to keep the file.
- A generic statement such as "retained for historical context" is not a sufficient lifecycle reason or archived-spec retention reason.
- Reasons MUST be supported by the linked decision evidence. Agents MUST NOT invent a reason when evidence is missing; they must leave the document unmoved and record the evidence gap in the governing change plan.

Additional rules depend on the terminal state:

- `Deprecated` MUST link to current guidance and include a `Rollout / Migration Plan` with an exit condition.
- `Superseded` MUST identify the replacement authority in `Current Guidance`; the replacement must actually absorb or continue the old contract or substantive proposal.
- `Retired` MUST use `Current Guidance: None` for the ended contract. Related new work may be linked as context, but it must not be presented as a replacement unless the contract continues.
- `Rejected` MUST identify why the proposal was not accepted. `Current Guidance` may be `None` or may link to the independently chosen direction.

## Active And Archived Specs

Keep current specs at the root of `docs/specs/`.

Use `docs/specs/superseded/` only for `Status: Superseded` documents whose
contracts or substantive proposals were absorbed or continued by named current guidance.

Use `docs/specs/retired/` only for `Status: Retired` documents whose contracts,
modules, capabilities, or product directions ended without successor contracts.

Use `docs/specs/rejected/` only when at least one real `Status: Rejected` spec
needs historical retention; do not create the directory speculatively.

Root-level current specs MUST use `Draft`, `Accepted`, or `Deprecated`.
Archived specs MUST use the status matching their directory. Directory
placement never substitutes for explicit lifecycle metadata and evidence.

## Internal Development Compatibility Rule

OpenKit is in active internal development. Specs must not preserve repository-owned backward compatibility layers for old internal shapes, names, file layouts, route forms, command forms, schema defaults, or runtime selectors.

When an internal contract changes, the clean target wins. Specs should describe direct removal, same-change migration, repair tooling, or replacement links rather than permanent compatibility readers, aliases, shims, or fallback behavior.

Compatibility language is allowed only when it describes intentional external interoperability, temporary operator migration evidence, or a historical spec that has been moved out of the active root.

## Filename Convention

Use a sortable date and descriptive slug:

```text
YYYYMMDD-short_name.md
```

Example:

```text
20260210-ui-navigation.md
```

## Suggested Structure

Use the existing decision-document shape, with explicit boundary and contract
sections added. New important specs should use this structure unless a section is
clearly irrelevant.

```markdown
# Title

Status: Draft
Implementation: Not Started

## Owns

## Does Not Own

## Core References

## Summary

## Goals / Non-goals

## Background

## Decision

## Contract / Expected Behavior

## Proposed Design

## Current Implementation Projection

## Alternatives Considered

## Consequences

## Rollout / Migration Plan

## Testing Strategy / Acceptance Criteria

## Risks & Mitigations

## Open Questions

## Deferred / Future Work

## Links
```

## Template Usage

- New important specs should include `Status`, `Implementation`, `Owns`, `Does Not Own`, `Core References`, `Summary`, `Goals / Non-goals`, `Decision`, and `Testing Strategy / Acceptance Criteria`.
- Protocol, data, lifecycle, storage, gateway, identity, permission, metering, audit, or runtime specs should include `Contract / Expected Behavior`.
- Removal, migration, deprecation, or rollout specs should include `Rollout / Migration Plan`.
- Specs that discuss current code should put package names, endpoints, file paths, database tables, and implementation status under `Current Implementation Projection`.
- Small specs may omit irrelevant sections, but they must still make ownership, non-ownership, status, implementation alignment, and lifecycle links clear.
- Deprecated and archived specs must include the lifecycle metadata and evidence required above.
- Existing and new specs must separate document authority into `Status` and implementation alignment into `Implementation`.

## Open Questions And Deferred Work

`Open Questions` are unresolved design decision entries for the current spec.
They should help close the design, not collect broad prompts, brainstorming
notes, or permanent philosophical questions.

Use these categories:

- `[Blocking]`: must be answered before the spec can move from `Draft` to `Accepted`.
- `[Non-blocking]`: does not block the current contract, but may affect a later extension or implementation choice.

Accepted specs should not contain blocking open questions. If a blocking
question remains, keep the spec in `Draft` or narrow the accepted contract so the
question becomes explicitly non-blocking.

Use `Deferred / Future Work` for important questions or work that should not be
answered by the current spec or its related implementation. Deferred items should
not change the meaning of the accepted contract.

Do not use `Open Questions` for:

- General prompts meant only to inspire thought.
- Product vision or system-wide philosophy that belongs in `docs/product-vision.md` or `docs/core/`.
- Backlog items, task lists, or release progress.
- Questions already owned by another active spec.

## Writing Style

- Prefer verifiable language: `MUST`, `SHOULD`, and `MAY`, or clear equivalents such as "must", "should", and "may".
- Keep each normative rule focused on one behavior or constraint.
- Use examples to clarify rules, not to replace rules.
- Mark unresolved design decisions as `Open Questions` and out-of-scope future material as `Deferred / Future Work` instead of mixing them into accepted contract text.
- Distinguish target design from current implementation.
- Cross-reference other specs or core documents instead of copying their definitions.

## Local Agent Rules

See [`AGENTS.md`](./AGENTS.md) for local execution rules that apply when creating, moving, updating, or superseding specs.
