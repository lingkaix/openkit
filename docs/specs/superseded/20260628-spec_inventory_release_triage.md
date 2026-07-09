# Specification Inventory And Release Triage

Status: Superseded
Implementation: N/A

Superseded by `docs/specs/README.md`, `docs/specs/AGENTS.md`, and the live active/retired/superseded file layout.

## Summary

This document is the release-time inventory for `docs/specs/` after the OpenKit 0.0.1 documentation repositioning.

It is retained as historical evidence of the first cleanup pass. It is not active guidance and should not be used as the current spec inventory.

0.0.1 is now framed as the NanoCore kernel MVP plus MCP-first dogfooding loop. The specs below should be reviewed against that current posture before the first public developer-preview release.

This started as a triage seed. The first cleanup pass has now updated the simple current specs, created consolidated entry points, and moved historical specs into `superseded/` or `retired/` subfolders.

Future cleanup should continue from the remaining `Keep And Audit` list.

## Triage Rules

- Keep specs that define current contracts, accepted design decisions, test strategy, or still-useful implementation constraints.
- Update specs whose direction is still right but whose status, names, command examples, or implementation mapping now lag behind the repo.
- Merge specs that describe the same contract in multiple historical slices after the stable conclusion has become clear.
- Supersede specs that only describe historical MVP slices, old Web-first release gates, or decisions already promoted into `docs/core/`.
- Do not use superseded specs as active decision logs.

## Core Docs Release-Neutrality Follow-Up

Core docs are release-neutral doctrine. They do not own 0.0.1 scope, current implementation paths, concrete package names, current schema field lists, or development-only runtime placements.

Release posture, current implementation mapping, migration detail, and concrete schema projections belong in specs, changes, working logs, and implementation docs.

Host Agent is no longer a core deployment concept. Historical host-adapter specs may remain as implementation or supporting detail until their useful details are migrated or intentionally dropped.

Worker Governance container execution and gateway-mediated worker capability supply remain the active implementation proof path for current NanoCore dogfooding.

## Immediate Simple Updates Completed

These specs should be updated before release because their current status or wording may mislead readers about the 0.0.1 kernel/MCP-first posture.

| Spec | Current triage | Why |
| --- | --- | --- |
| Spec | Result | Notes |
| --- | --- | --- |
| `20260617-openkit_ai_interface.md` | Updated. | Status now reflects the implemented `@openkit/mcp` package, four current Skills, MCP-first Loop 0 dogfooding, and 0.x remote/auth gaps. |
| `20260627-openkit_development_loop_protocol.md` | Updated. | Status now reflects the active external-coordinator dogfood protocol and separates 0.0.1 developer-preview requirements from 0.x hardening. |
| `20260703-workspace_synchronization.md` | Updated. | Status now reflects partially implemented NanoCore records, App API/MCP read surfaces, Action Center projection, and remaining portability/recovery work. |
| `20260627-remote_openshell_gateway.md` | Updated. | Current implementation mapping now covers `remote-container`, deterministic tests, opt-in remote verification paths, and production hardening gaps. |
| `20260616-agent_environment_package.md` | Updated. | Status and implementation mapping now reflect Worker Governance placement, current `control.local` sidecar shape, and 0.x schema/provider/vault/audit work. |
| `20260531-human_attention_intervention_model.md` | Updated. | Current implementation mapping now reflects Action Center, Goal Review, artifact review, workspace review, and memory proposal projections. |

## Consolidated Retired Groups

These groups look like historical slices of the same contract. The next pass should decide whether to merge them into one current spec or promote the stable result into `docs/core/`.

### Agent Setup And Runtime Supply

- `20260416-unified_agent_setup_manifest.md`
- `20260517-agent_manifest_loader.md`
- `20260519-agent_profile_config.md`
- `20260522-agent_profile_model.md`
- `20260616-agent_environment_package.md`

Result: consolidated into `20260628-agent_setup_runtime_supply_contract.md`.

Historical files were moved to `docs/specs/retired/agent-setup-runtime-supply/` and marked `Status: Superseded`.

### Protocol Hardening And Naming

- `20260513-protocol_package_organization.md`
- `20260515-protocol_lifecycle_enums.md`
- `20260517-agent_session_naming_alignment.md`
- `20260517-artifact_item_naming.md`
- `20260517-protocol_output_delta_target.md`
- `20260527-core_protocol_hardening.md`

Result: consolidated into `20260628-protocol_contract_consolidation.md`.

Historical files were moved to `docs/specs/retired/protocol-hardening/` and marked `Status: Superseded`.

### Web MVP Slices

- `20260515-web_workspace_dashboard_read_model.md`
- `20260515-web_thread_list_create.md`
- `20260515-web_thread_workbench_streaming.md`
- `20260515-web_inline_approvals.md`
- `20260515-web_inline_questions.md`
- `20260515-web_turn_interruption.md`
- `20260515-web_artifact_detail.md`
- `20260515-web_workspace_memory_editing.md`
- `20260515-web_workspace_url_selection.md`
- `20260516-web_release_gates.md`
- `20260517-web_output_delta_reconciliation.md`

Result: moved under `docs/specs/superseded/web-ui-pre-rebuild/` and superseded by `20260628-web_product_surface_projection.md`.

These files no longer define 0.0.1 release readiness. They are retained only for future Web UI rebuild work.

### Auth, Identity, Config, And Data Layout

- `20260517-local_mode_identity.md`
- `20260517-better_auth_drizzle_schema.md`
- `20260517-server_auth_middleware.md`
- `20260519-server_config_data_layout.md`
- `20260525-runtime_config_reload.md`
- `20260526-layered_config_design.md`
- `20260526-runtime_config_ui.md`

Result: consolidated into `20260628-nanocore_config_identity_contract.md`.

Historical files were moved to `docs/specs/retired/nanocore-config-identity/` and marked `Status: Superseded`.

## Superseded Historical Specs

These specs already look historical or replaced. The next pass should verify links and mark replacements clearly.

| Spec | Candidate action | Why |
| --- | --- | --- |
| Spec | Result | Why |
| --- | --- | --- |
| `superseded/20260513-core_protocol_model_notes.md` | Superseded. | Stable conclusions have moved into `docs/core/` and `20260628-protocol_contract_consolidation.md`. |
| `superseded/20260526-codex_oauth_account_ux.md` | Superseded. | Replaced by current subscription-login/account-slot flow. |
| `superseded/20260516-release_readiness_fixes.md` | Superseded. | Describes an old Web-first release-readiness slice rather than current 0.0.1 kernel preview. |
| `superseded/20260518-staging_docker_distribution.md` | Superseded. | Historical release numbering and staging packaging details should not drive current public release posture. |
| `retired/protocol-hardening/20260513-protocol_package_organization.md` | Moved to protocol retired group. | Superseded by `20260628-protocol_contract_consolidation.md`. |

## Keep And Audit

These specs appear still useful and should be audited for status and implementation drift, but they are not obvious merge/removal candidates from file names and current grep evidence alone.

- `20260416-host_agent_adapter.md`
- `20260507-codex_agent_communication_modes.md`
- `20260515-codex_approval_bridge.md`
- `20260515-codex_user_input_bridge.md`
- `20260515-core_client_http_sse_helpers.md`
- `20260515-deterministic_simulator_executor.md`
- `20260515-nano_core_meta_capabilities.md`
- `20260515-nano_core_snapshot_reload.md`
- `20260515-nano_core_sse_replay.md`
- `20260517-codex_output_delta_bridge.md`
- `20260517-nano_core_drizzle_baseline.md`
- `20260517-nano_core_e2e_harness.md`
- `20260517-nano_core_mode_resolution.md`
- `20260517-nano_core_orchestrator.md`
- `20260517-openai_compat_facade.md`
- `20260517-per_turn_feedback.md`
- `20260522-vendor_snapshot_packages.md`
- `20260525-sustained_mode_long_running_agent.md`
- `20260526-codex_chatgpt_subscription_login.md`
- `20260526-llm_gateway_responses_api.md`
- `20260526-nano_core_lightweight_agents.md`
- `20260526-workspace_data_mounts.md`
- `20260528-core_client_boundary.md`
- `20260529-l6_story_acceptance.md`
- `20260529-remove_legacy_compatibility.md`
- `20260529-test_strategy.md`
- `20260531-worker_turn_reliability_envelope.md`

## Suggested Next Pass

1. Audit the remaining `Keep And Audit` specs for status, implementation drift, and replacement links.
2. Decide whether `20260507-codex_agent_communication_modes.md`, `20260416-host_agent_adapter.md`, and `20260531-worker_turn_reliability_envelope.md` should be consolidated with Worker Governance docs after the current NanoCore cleanup lands.
3. Promote stable test strategy and L6 story acceptance rules into core/cookbook docs if they are still current.
4. Keep superseded and retired specs available until their useful implementation detail has either been promoted or intentionally dropped.
5. After each batch, run active stale-name and markdown/static checks.
