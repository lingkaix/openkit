# @openkit/mcp

`@openkit/mcp` is the standard stdio MCP control surface for operating NanoCore from MCP-capable desktop agent applications.

It is a user-facing channel parallel to the Web UI. It is not a NanoCore backend, worker runtime, installer, shell gateway, package manager, deployment tool, or internal admin API.

This README is the operational package guide for running, configuring, and verifying the MCP server. The canonical product and boundary design lives in [`docs/specs/20260617-openkit_ai_interface.md`](../docs/specs/20260617-openkit_ai_interface.md).

## Scope

- Exposes OpenKit as a product channel over stdio MCP.
- Calls NanoCore through public App API, Core protocol, `@openkit/core-client`, and shared schemas.
- Provides tools, resources, and prompts for status, runtime diagnostics, workspace setup, runtime config setup, repositories, approval-gated GitHub push records and execution, workspace portability, threads, Chat Mode, Task Mode, Goal Mode, Action Center, scheduler admission read models, artifacts, server and workspace permission-decision records, workspace audit records, workspace review records, redacted Agent Environment Package snapshots, and evidence bundles.
- Connects to a configured local or remote NanoCore endpoint through `OPENKIT_NANOCORE_URL`.
- Keeps worker-side MCP capability supply out of scope.
- Keeps backend process supervision, generic shell, generic commit, tag, publish, and deploy tools out of scope. Push is exposed only through the approval-gated, GitHub-only NanoCore `workspace.git.push` contract.

## User Setup Flow

For a user connecting a desktop AI application to an existing NanoCore deployment, the expected flow is:

1. Configure the MCP server with the NanoCore endpoint and any deployment-provided scoped NanoCore token.
2. Call `openkit.read_status` and `openkit.read_runtime_diagnostics` to verify NanoCore reachability, product capability flags, runtime config status, and worker communication readiness.
3. Call `openkit.list_workspaces` to inspect existing workspaces.
4. Call `openkit.create_workspace` when the user wants a new workspace.
5. Call `openkit.update_workspace` to set workspace kind, status, and defaults.
6. Call `openkit.read_workspace_resources` to inspect Knowledge Store entries, Skills, agents, and models visible to the workspace.
7. Call `openkit.list_runtime_config_files`, `openkit.read_runtime_config_file`, `openkit.validate_runtime_config`, `openkit.update_runtime_config_file`, `openkit.reload_runtime_config`, and `openkit.restart_runtime_config_stale_session` when the human explicitly wants to configure server, provider, agent, workspace, or workspace data source catalog files through NanoCore public admin routes or retire a stale worker session after a session-scoped config change.
8. Link a repository with `openkit.link_repository` only after the human confirms the NanoCore-visible local path.
9. Create or resume a thread, use Chat Mode for lightweight Assistant turns, start Task Mode for one bounded delegated worker task, or start Goal Mode, draft and approve a plan, run one bounded step, read Action Center and artifacts, and ask the human before continuing.

## Skills

OpenKit-authored Skills live at the repository top level:

- `skills/openkit-setup`: use when the desktop AI app is helping an end user connect to an existing local or remote NanoCore backend.
- `skills/openkit-setup-dev`: use when the desktop AI app is setting up this repository for dogfooding.
- `skills/openkit-loop`: use after setup when the desktop AI app is coordinating bounded end-user workspace work.
- `skills/openkit-loop-dev`: use after developer setup when the desktop AI app is coordinating review-gated OpenKit self-improvement.

Use [`skills/README.md`](../skills/README.md) for the Skill selection matrix. This package does not own Skill content; it only exposes the MCP surface those Skills teach agents to operate.

## Local Development

Start NanoCore separately:

```bash
pnpm --filter @openkit/nanocore dev
```

Run the MCP server:

```bash
pnpm --filter @openkit/mcp build
OPENKIT_NANOCORE_URL=http://127.0.0.1:3000 pnpm --filter @openkit/mcp start
```

For source development, use `pnpm --filter @openkit/mcp dev`. The default NanoCore URL is `http://127.0.0.1:3000`.

For remote NanoCore deployments, set `OPENKIT_NANOCORE_URL` to the deployment-provided base URL and provide a server-issued scoped `okt_` token through `OPENKIT_NANOCORE_TOKEN`, an OS keychain entry keyed by the exact NanoCore URL, or the MCP encrypted fallback credential file. Do not store token values in repository files, examples, artifacts, or change records.

## Desktop Agent MCP Configuration

Use this shape for Codex, Pi Agent, or any MCP-capable desktop agent app that accepts a command, args, working directory, and environment:

```json
{
  "mcpServers": {
    "openkit": {
      "command": "pnpm",
      "args": ["--filter", "@openkit/mcp", "start"],
      "cwd": "/Users/m5pro/Documents/AI/openkit",
      "env": {
        "OPENKIT_NANOCORE_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

Remote server-mode configurations may add `OPENKIT_NANOCORE_TOKEN` in `env` when the deployment has supplied a scoped NanoCore token through public auth instructions. If that variable is absent, the MCP server reads the OS keychain entry keyed by `OPENKIT_NANOCORE_URL`: macOS uses a generic password with service `openkit.nanocore.token` and account equal to the URL, Linux uses a Secret Service entry with attributes `application=openkit` and `nanocore-url=<OPENKIT_NANOCORE_URL>`, and Windows uses Credential Manager target `openkit.nanocore.token:<OPENKIT_NANOCORE_URL>`. If no keychain token is available, MCP reads an encrypted fallback file under the user's OpenKit config directory and emits a degraded-storage warning. `openkit.consume_bootstrap_token` with `storeCredential: true` writes the returned token to Linux Secret Service or Windows Credential Manager through stdin when available, and otherwise uses the encrypted fallback.

## MCP Methods

The stdio server implements newline-delimited JSON-RPC for the MCP `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, and `prompts/get` methods.

`tools/list` returns JSON Schema generated from the tool validation schemas. `tools/call` returns text content plus structured content.

## Tool Groups

- Status and diagnostics: `openkit.read_status`, `openkit.read_runtime_diagnostics`, `openkit.read_storage_layout_report`, `openkit.read_capability_usage`, `openkit.start_nanocore`.
- Auth setup and token administration: `openkit.consume_bootstrap_token`, `openkit.list_openkit_access_tokens`, `openkit.create_openkit_access_token`, `openkit.revoke_openkit_access_token`, `openkit.rotate_openkit_access_token`.
- Workspaces: `openkit.list_workspaces`, `openkit.create_workspace`, `openkit.update_workspace`, `openkit.read_workspace_resources`, `openkit.answer_knowledge`, `openkit.prepare_knowledge_context`, `openkit.read_knowledge_context_package_trace`, `openkit.materialize_knowledge_context_package`, `openkit.draft_knowledge_proposal`, `openkit.suggest_knowledge_repairs`, `openkit.check_knowledge_health`, `openkit.record_knowledge_observation`, `openkit.list_knowledge_observations`, `openkit.record_knowledge_claim`, `openkit.list_knowledge_claims`, `openkit.record_knowledge_conflict`, `openkit.resolve_knowledge_conflict`, `openkit.list_knowledge_conflicts`, `openkit.retrieve_knowledge`, `openkit.read_knowledge_indexes`.
- Automations: `openkit.list_automations`, `openkit.create_automation`, `openkit.update_automation`, `openkit.delete_automation`.
- Workspace portability and vault admin: `openkit.create_data_root_backup`, `openkit.verify_data_root_backup`, `openkit.read_vault_admin_status`, `openkit.unlock_vault_admin_backend`, `openkit.lock_vault_admin_backend`, `openkit.bootstrap_codex_auth_json_vault_reference`, `openkit.export_workspace`, `openkit.dry_run_workspace_import`, `openkit.import_workspace`, `openkit.read_workspace_vault_references`, `openkit.read_workspace_vault_use_records`, `openkit.read_vault_use_records`, `openkit.rebind_workspace_vault_reference`.
- Runtime config: `openkit.list_runtime_config_files`, `openkit.read_runtime_config_file`, `openkit.validate_runtime_config`, `openkit.update_runtime_config_file`, `openkit.reload_runtime_config`, `openkit.restart_runtime_config_stale_session`.
- Repositories: `openkit.link_repository`, `openkit.read_repositories`, `openkit.read_git_push_records`, `openkit.request_git_push_approval`, `openkit.execute_git_push`.
- Threads, Chat Mode, Task Mode, and Goal Mode: `openkit.create_thread`, `openkit.read_thread`, `openkit.start_chat`, `openkit.start_task`, `openkit.start_goal`, `openkit.read_goal`, `openkit.draft_goal_plan`, `openkit.approve_goal_plan`, `openkit.revise_goal_plan`, `openkit.step_goal`, `openkit.submit_steering`, `openkit.list_interrupted_workers`, `openkit.list_recovery_pending_user_turns`, `openkit.cancel_recovery_pending_user_turn`, `openkit.edit_recovery_pending_user_turn`, `openkit.convert_recovery_pending_user_turn_to_follow_up`, `openkit.promote_recovery_pending_user_turn_to_interrupt`, `openkit.clear_interrupted_worker_checkpoint`, `openkit.retry_interrupted_worker_checkpoint`, `openkit.read_scheduler_admissions`, `openkit.retry_scheduler_admission`, `openkit.cancel_scheduler_admission`.
- Review and evidence: `openkit.read_action_center`, `openkit.resolve_action_center_item`, `openkit.read_workspace_audit_events`, `openkit.read_server_audit_events`, `openkit.read_workspace_permission_decisions`, `openkit.read_server_permission_decisions`, `openkit.read_workspace_reviews`, `openkit.read_workspace_sync_records`, `openkit.read_workspace_apply_results`, `openkit.read_agent_environment_package_snapshots`, `openkit.read_artifact`, `openkit.create_evidence_bundle`, and the `openkit://workspaces/{workspaceId}/evidence-bundles` resource.

## Missing Product Surface

The current MCP package is now close to a complete interaction shell for an already reachable NanoCore endpoint, but the following product gaps remain outside this package until NanoCore exposes stable public contracts:

- Auth bootstrap: MCP can consume the one-time server bootstrap token, optionally store the returned NanoCore token through `storeCredential: true`, administer redacted OpenKit access-token records through public App API facades, and authenticate with `OPENKIT_NANOCORE_TOKEN`, OS keychain read, or encrypted fallback read. It does not yet provide a complete sign-in, account selection, token refresh, or macOS keychain write setup that avoids secret-bearing command argv.
- Server discovery: MCP accepts a configured `OPENKIT_NANOCORE_URL`, but it does not yet discover local or remote NanoCore deployments, enumerate organizations, or negotiate endpoint capabilities beyond `openkit.read_status` and `openkit.read_runtime_diagnostics`.
- Server lifecycle: `openkit.start_nanocore` is still diagnostic-only. Starting, stopping, upgrading, restarting, or supervising NanoCore should be a separate trusted installer or service-management contract, not a generic MCP shell.
- Config safety workflow: MCP can list, read, validate, update, and reload public runtime config files. It still needs product-level preview UX for diff review, restart-required warnings, staged approval, rollback, and secret-slot selection before this becomes a polished end-user setup wizard.
- Vault admin setup: MCP can read redacted vault status, unlock or lock the configured backend, bootstrap Codex auth JSON, list redacted workspace vault references, read redacted server and workspace vault-use records, and rebind imported workspace vault references through public App API facades. It still needs a polished operator UX for key-source selection, key rotation, secret inventory review, and safe secret entry that avoids secret-bearing command argv.
- Workspace onboarding: MCP can list/create/update workspaces and read workspace resources. It still needs public NanoCore contracts for richer workspace templates, membership/permission management, default repository selection policy, model/provider selection UX, and workspace deletion or archival policy.
- Repository path mapping: MCP can link a repository path, but remote NanoCore deployments need a first-class way to explain NanoCore-visible paths, mounted volumes, and host-to-server path translation before users can reliably link local projects to remote workers.
- Audit and permissions: MCP calls existing public routes with the caller's NanoCore auth context and sends stable channel/source labels for bearer-token last-used summaries. Fine-grained MCP tool authorization, full audit-record linkage, and server-side policy restrictions should live in NanoCore public API and auth layers.

## Commands

```bash
pnpm --filter @openkit/mcp test
pnpm --filter @openkit/mcp typecheck
pnpm --filter @openkit/mcp build
pnpm --filter @openkit/mcp lint
pnpm --filter @openkit/mcp format
pnpm --filter @openkit/mcp smoke:nanocore
```

`smoke:nanocore` expects `apps/nanocore/dist/index.js` and `mcp/dist/index.js` to exist. Build both packages first. It starts a temporary NanoCore process with the deterministic internal self-check executor, connects through the MCP stdio server, links a disposable git repository, creates a thread, starts Goal Mode, drafts and approves a plan, runs one bounded step, reads Goal Mode and Action Center state, and builds an evidence bundle.

Set `OPENKIT_MCP_SMOKE_REPOSITORY=/Users/m5pro/Documents/AI/openkit` to run the same smoke against the OpenKit checkout as the linked repository without allowing real provider quota or repository mutation.

Set `OPENKIT_MCP_SMOKE_CORE_MODE=server` to run the same smoke against a temporary server-mode NanoCore. The smoke reads the owner-only bootstrap token emission, consumes it through the public App API, creates a workspace with the returned `server-admin` token, issues a scoped workspace token, passes it to the MCP server through `OPENKIT_NANOCORE_TOKEN`, and then exercises the MCP loop.

Set `OPENKIT_MCP_SMOKE_NANOCORE_URL` to point the smoke at an already running NanoCore instead of starting a temporary local process. When the existing NanoCore runs on another machine or inside a container, set `OPENKIT_MCP_SMOKE_REMOTE_REPOSITORY` to the repository path as seen by that NanoCore process.

Set `OPENKIT_MCP_SMOKE_OBJECTIVE` to override the default Goal Mode objective when an external NanoCore deployment should prove a specific worker behavior, such as creating a small reviewable file in a disposable repository.
