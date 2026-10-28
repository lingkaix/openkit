#!/usr/bin/env node
/**
 * Static test-governance checks and one TAP skip assertion for repository tests.
 *
 * The platform-interface rule is a bounded enumeration of named surfaces. It cannot catch platform dependence that uses other interfaces, and it does not claim completeness of that residual.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import ts from 'typescript';

// Pre-3b files, including the accepted87f6f8892 frozen Workspace journal test, retain setup.
// This fixed path set is not regenerated when new tests add storage coupling.
const STORAGE_TEST_GRANDFATHERED_PATHS = new Set([
  'apps/nanocore/e2e/migration-idempotency.spec.ts',
  'apps/nanocore/e2e/openkit-cli.spec.ts',
  'apps/nanocore/e2e/server-boot.spec.ts',
  'apps/nanocore/e2e/workspace-portability.spec.ts',
  'apps/nanocore/e2e/workspace-scope-admission.spec.ts',
  'apps/nanocore/src/action-center.test.ts',
  'apps/nanocore/src/administration/administration-capture.test.ts',
  'apps/nanocore/src/administration/administration-lifetime.test.ts',
  'apps/nanocore/src/administration/administration-routes.test.ts',
  'apps/nanocore/src/administration/mcp-discovery-preview.test.ts',
  'apps/nanocore/src/administration/nanohost-runtime-target-tool.test.ts',
  'apps/nanocore/src/administration/operation-invocation.test.ts',
  'apps/nanocore/src/administration/server-mcp-operations.test.ts',
  'apps/nanocore/src/administrator-cleanup-operation-projections.test.ts',
  'apps/nanocore/src/agents/catalog-routes.test.ts',
  'apps/nanocore/src/agents/setup-ledger.test.ts',
  'apps/nanocore/src/agents/workspace-workers.test.ts',
  'apps/nanocore/src/app-search.scope-admission.test.ts',
  'apps/nanocore/src/app-update/app-update-routes.test.ts',
  'apps/nanocore/src/app-update/preflight.test.ts',
  'apps/nanocore/src/artifact-file-commands.test.ts',
  'apps/nanocore/src/artifact-files.test.ts',
  'apps/nanocore/src/artifact-folder-routes.test.ts',
  'apps/nanocore/src/artifact-judgements.test.ts',
  'apps/nanocore/src/artifact-operation-projections.test.ts',
  'apps/nanocore/src/artifact-reviews.test.ts',
  'apps/nanocore/src/artifact-routes.test.ts',
  'apps/nanocore/src/artifact-versions.test.ts',
  'apps/nanocore/src/assistant-context-portability.test.ts',
  'apps/nanocore/src/assistant-history-integration.test.ts',
  'apps/nanocore/src/assistant-semantic-handoff.test.ts',
  'apps/nanocore/src/audit-events.test.ts',
  'apps/nanocore/src/auth-token-app.test.ts',
  'apps/nanocore/src/auth/access-token-attribution.test.ts',
  'apps/nanocore/src/auth/access-token-operation-projections.test.ts',
  'apps/nanocore/src/auth/access-token-store.test.ts',
  'apps/nanocore/src/auth/admin-recovery.test.ts',
  'apps/nanocore/src/auth/better-auth.test.ts',
  'apps/nanocore/src/auth/bootstrap-token.test.ts',
  'apps/nanocore/src/auth/identifier-reset-dry-run.test.ts',
  'apps/nanocore/src/auth/identity-cutover.test.ts',
  'apps/nanocore/src/auth/identity.test.ts',
  'apps/nanocore/src/auth/middleware.server-mode.test.ts',
  'apps/nanocore/src/auth/nanohost-transport-admission.test.ts',
  'apps/nanocore/src/auth/nanohost-transport-lifecycle.test.ts',
  'apps/nanocore/src/auth/nanohost-transport-routes.test.ts',
  'apps/nanocore/src/auth/nanohost-transport-sink.test.ts',
  'apps/nanocore/src/auth/nanohost-transport-token-store.test.ts',
  'apps/nanocore/src/auth/operation-authorizer.test.ts',
  'apps/nanocore/src/auth/server-flow.test.ts',
  'apps/nanocore/src/auth/thread-resource-admission.test.ts',
  'apps/nanocore/src/auth/user-lifecycle.test.ts',
  'apps/nanocore/src/automation-operation-projections.test.ts',
  'apps/nanocore/src/automation.test.ts',
  'apps/nanocore/src/b10-operation-cutover.test.ts',
  'apps/nanocore/src/b6-operation-retirement.test.ts',
  'apps/nanocore/src/bootstrap/audit.test.ts',
  'apps/nanocore/src/bootstrap/scope-admission.test.ts',
  'apps/nanocore/src/bootstrap/workspace-recovery.test.ts',
  'apps/nanocore/src/bootstrap/workspace-retirement.test.ts',
  'apps/nanocore/src/caller-operation-projections.test.ts',
  'apps/nanocore/src/capability/server-usage-ledger.test.ts',
  'apps/nanocore/src/capability/usage-ledger.test.ts',
  'apps/nanocore/src/catalog/catalog-mutation-audit.test.ts',
  'apps/nanocore/src/catalog/catalog-operation-projections.test.ts',
  'apps/nanocore/src/catalog/catalog-routes.test.ts',
  'apps/nanocore/src/catalog/skill-candidate-loop.test.ts',
  'apps/nanocore/src/catalog/skill-management-commands.test.ts',
  'apps/nanocore/src/catalog/skill-native-candidate.test.ts',
  'apps/nanocore/src/channel-pending-seam.test.ts',
  'apps/nanocore/src/channels/discord.test.ts',
  'apps/nanocore/src/config/administration-configuration.test.ts',
  'apps/nanocore/src/config/agent-native-environment.test.ts',
  'apps/nanocore/src/config/delegated-worker-git-read.test.ts',
  'apps/nanocore/src/config/model-catalog.test.ts',
  'apps/nanocore/src/config/resource-policy-confirmation.test.ts',
  'apps/nanocore/src/config/runtime-config-operation-projections.test.ts',
  'apps/nanocore/src/config/runtime-config-routes.test.ts',
  'apps/nanocore/src/config/workspace-agent-pinning.test.ts',
  'apps/nanocore/src/context/knowledge-overview.test.ts',
  'apps/nanocore/src/context/worker-context-authorities.test.ts',
  'apps/nanocore/src/context/worker-context-projection.test.ts',
  'apps/nanocore/src/conversation-file-routes.test.ts',
  'apps/nanocore/src/conversation-navigation.test.ts',
  'apps/nanocore/src/core-command-admission-errors.test.ts',
  'apps/nanocore/src/core-command-operation-projections.test.ts',
  'apps/nanocore/src/core-command-typed-errors.test.ts',
  'apps/nanocore/src/core-thread-audience-stream.test.ts',
  'apps/nanocore/src/core-thread-audience.test.ts',
  'apps/nanocore/src/dashboard-search-visibility.test.ts',
  'apps/nanocore/src/deployment-admin-routes.test.ts',
  'apps/nanocore/src/deployment-mode-matrix.test.ts',
  'apps/nanocore/src/diagnostics/readiness.test.ts',
  'apps/nanocore/src/diagnostics/snapshot.test.ts',
  'apps/nanocore/src/docker/app-persistence-smoke.test.ts',
  'apps/nanocore/src/equal-workspace-members.test.ts',
  'apps/nanocore/src/evaluation-candidates.test.ts',
  'apps/nanocore/src/evaluation-judgement-operations.test.ts',
  'apps/nanocore/src/evidence-bundles.test.ts',
  'apps/nanocore/src/execution-operation-authority.test.ts',
  'apps/nanocore/src/gateway-settings-diagnostics.test.ts',
  'apps/nanocore/src/generative-kernel/a15-lineage.test.ts',
  'apps/nanocore/src/generative-kernel/meaning-discovery.test.ts',
  'apps/nanocore/src/generative-kernel/snapshots.test.ts',
  'apps/nanocore/src/generative-operation-projections.test.ts',
  'apps/nanocore/src/generative-ui-routes.test.ts',
  'apps/nanocore/src/generative-ui/commands.test.ts',
  'apps/nanocore/src/generative-ui/thread-audience.test.ts',
  'apps/nanocore/src/governance-routes.test.ts',
  'apps/nanocore/src/host-repository-retirement.test.ts',
  'apps/nanocore/src/internal-agents/assistant-command-run.test.ts',
  'apps/nanocore/src/internal-agents/assistant-history-range.test.ts',
  'apps/nanocore/src/internal-agents/assistant-skill-resources.test.ts',
  'apps/nanocore/src/internal-agents/gateway-provider-http-rejection.test.ts',
  'apps/nanocore/src/internal-agents/gateway-provider.test.ts',
  'apps/nanocore/src/internal-agents/internal-context-source-error.test.ts',
  'apps/nanocore/src/internal-agents/knowledge-manager-agent.test.ts',
  'apps/nanocore/src/internal-agents/knowledge-manager-deadline.test.ts',
  'apps/nanocore/src/kernel-routes.test.ts',
  'apps/nanocore/src/knowledge-consolidation-public.test.ts',
  'apps/nanocore/src/knowledge-manager.test.ts',
  'apps/nanocore/src/knowledge-notebook-history.test.ts',
  'apps/nanocore/src/knowledge-notebook-page-admission.test.ts',
  'apps/nanocore/src/knowledge-notebook-page-contract.test.ts',
  'apps/nanocore/src/knowledge-notebook-publication.test.ts',
  'apps/nanocore/src/knowledge-notebook-reads.test.ts',
  'apps/nanocore/src/knowledge-notebook-review.test.ts',
  'apps/nanocore/src/knowledge-operation-projections.test.ts',
  'apps/nanocore/src/knowledge-server-answer.test.ts',
  'apps/nanocore/src/knowledge-source-lineage.test.ts',
  'apps/nanocore/src/knowledge/control-maintenance-admission.test.ts',
  'apps/nanocore/src/knowledge/knowledge-agent-maintenance.test.ts',
  'apps/nanocore/src/knowledge/knowledge-agent.test.ts',
  'apps/nanocore/src/knowledge/knowledge-maintenance-command.test.ts',
  'apps/nanocore/src/knowledge/knowledge-maintenance-deadline.test.ts',
  'apps/nanocore/src/knowledge/knowledge-maintenance-schedule-integration.test.ts',
  'apps/nanocore/src/knowledge/knowledge-meaning-reference.test.ts',
  'apps/nanocore/src/knowledge/knowledge-result.test.ts',
  'apps/nanocore/src/knowledge/managed-source-authority.test.ts',
  'apps/nanocore/src/knowledge/memory-forget.test.ts',
  'apps/nanocore/src/knowledge/memory-history.test.ts',
  'apps/nanocore/src/knowledge/memory-lifecycle.test.ts',
  'apps/nanocore/src/knowledge/memory-trace-portability.test.ts',
  'apps/nanocore/src/knowledge/notebook-audit.test.ts',
  'apps/nanocore/src/knowledge/notebook-initialization.test.ts',
  'apps/nanocore/src/knowledge/notebook-proposal-preview.test.ts',
  'apps/nanocore/src/knowledge/notebook-publication.test.ts',
  'apps/nanocore/src/knowledge/notebook-workspace-portability.test.ts',
  'apps/nanocore/src/knowledge/scoped-knowledge-sources.test.ts',
  'apps/nanocore/src/knowledge/scoped-notebook-owner.test.ts',
  'apps/nanocore/src/knowledge/scoped-notebook-publication.test.ts',
  'apps/nanocore/src/knowledge/server-knowledge-maintenance.test.ts',
  'apps/nanocore/src/knowledge/server-knowledge-owner.test.ts',
  'apps/nanocore/src/knowledge/server-knowledge-runtime.test.ts',
  'apps/nanocore/src/knowledge/source-bytes.test.ts',
  'apps/nanocore/src/knowledge/source-error-boundary.test.ts',
  'apps/nanocore/src/knowledge/source-maintenance-context.test.ts',
  'apps/nanocore/src/knowledge/source-meaning-reference.test.ts',
  'apps/nanocore/src/knowledge/source-mount-collision.test.ts',
  'apps/nanocore/src/knowledge/source-native-role-authority.test.ts',
  'apps/nanocore/src/knowledge/source-pointer-cutover.test.ts',
  'apps/nanocore/src/knowledge/source-request-identity-boundary.test.ts',
  'apps/nanocore/src/knowledge/source-summary-editing.test.ts',
  'apps/nanocore/src/knowledge/source-workspace-maintenance-context.test.ts',
  'apps/nanocore/src/knowledge/tell-intake-framing.test.ts',
  'apps/nanocore/src/knowledge/typed-authoring-guidance.test.ts',
  'apps/nanocore/src/knowledge/typed-knowledge-pages.test.ts',
  'apps/nanocore/src/knowledge/typed-rule-continuity.test.ts',
  'apps/nanocore/src/knowledge/user-memory-agent-maintenance.test.ts',
  'apps/nanocore/src/knowledge/user-memory-first-use-outcome.test.ts',
  'apps/nanocore/src/knowledge/user-memory-schedule.test.ts',
  'apps/nanocore/src/knowledge/user-memory-tell-ask.test.ts',
  'apps/nanocore/src/knowledge/user-source-error-boundary.test.ts',
  'apps/nanocore/src/knowledge/workspace-source-cutover.test.ts',
  'apps/nanocore/src/lib/automation-store.test.ts',
  'apps/nanocore/src/lib/simulator.test.ts',
  'apps/nanocore/src/lib/store-artifact-versions.test.ts',
  'apps/nanocore/src/lib/store-capture-coverage.test.ts',
  'apps/nanocore/src/lib/store-directory-publication.test.ts',
  'apps/nanocore/src/lib/store-failure-scope.test.ts',
  'apps/nanocore/src/lib/store-late-publication-failure.test.ts',
  'apps/nanocore/src/lib/store-native-products.test.ts',
  'apps/nanocore/src/lib/store-persistence-scope.test.ts',
  'apps/nanocore/src/lib/store-publication-durability.test.ts',
  'apps/nanocore/src/lib/store-reload.test.ts',
  'apps/nanocore/src/lib/store-server-threads.test.ts',
  'apps/nanocore/src/lib/store-terminal-write-admission.test.ts',
  'apps/nanocore/src/lib/store-thread-owner-boundaries.test.ts',
  'apps/nanocore/src/lib/store-turn-publication-order.test.ts',
  'apps/nanocore/src/lib/store-unacknowledged-publication.test.ts',
  'apps/nanocore/src/lib/store.test.ts',
  'apps/nanocore/src/light-app-definition-operations.test.ts',
  'apps/nanocore/src/llm-gateway-policy.test.ts',
  'apps/nanocore/src/llm-gateway.test.ts',
  'apps/nanocore/src/llm/gateway-effort.test.ts',
  'apps/nanocore/src/llm/gateway-lineage.test.ts',
  'apps/nanocore/src/llm/gateway-routes.test.ts',
  'apps/nanocore/src/llm/gateway-usage.test.ts',
  'apps/nanocore/src/llm/model-capture.test.ts',
  'apps/nanocore/src/llm/provider-subscription-accounts.test.ts',
  'apps/nanocore/src/llm/server-model-capture.test.ts',
  'apps/nanocore/src/llm/system-prompt-digest.test.ts',
  'apps/nanocore/src/llm/worker-inference-diagnostics.test.ts',
  'apps/nanocore/src/llm/worker-raw-provider-stock.test.ts',
  'apps/nanocore/src/material-content-bound.test.ts',
  'apps/nanocore/src/material-cutover.test.ts',
  'apps/nanocore/src/material-judgements.test.ts',
  'apps/nanocore/src/material-native-authority.test.ts',
  'apps/nanocore/src/material-range-corrections.test.ts',
  'apps/nanocore/src/material-routes.test.ts',
  'apps/nanocore/src/memory-forget-projections.test.ts',
  'apps/nanocore/src/memory-operation-projections.test.ts',
  'apps/nanocore/src/memory-search-operation-projections.test.ts',
  'apps/nanocore/src/memory-source-operation-projections.test.ts',
  'apps/nanocore/src/meta.test.ts',
  'apps/nanocore/src/migrated-execution-retirement.test.ts',
  // Existing Mode assertions moved unchanged to isolated files; no new storage-coupled cases.
  'apps/nanocore/src/mode-entry-assistant.test.ts',
  'apps/nanocore/src/mode-entry-effort.test.ts',
  'apps/nanocore/src/mode-entry-memory.test.ts',
  'apps/nanocore/src/mode-entry-routes.test.ts',
  'apps/nanocore/src/notifications/attention.test.ts',
  'apps/nanocore/src/operation-error.test.ts',
  'apps/nanocore/src/operation-projections.test.ts',
  'apps/nanocore/src/operation-resolvers.scope-admission.test.ts',
  'apps/nanocore/src/pending-request-operations.test.ts',
  'apps/nanocore/src/personal-assistant-timeline.test.ts',
  'apps/nanocore/src/policy/agent-gate-provider.test.ts',
  'apps/nanocore/src/policy/agent-gate.test.ts',
  'apps/nanocore/src/policy/goal-domain-administration.test.ts',
  'apps/nanocore/src/policy/goal-domains.test.ts',
  'apps/nanocore/src/policy/goal-task-classification.test.ts',
  'apps/nanocore/src/policy/interception.test.ts',
  'apps/nanocore/src/policy/permission-decisions.test.ts',
  'apps/nanocore/src/policy/resource-policy-requests.test.ts',
  'apps/nanocore/src/provider-profile-delete.test.ts',
  'apps/nanocore/src/provider-readiness-composition.test.ts',
  'apps/nanocore/src/provider-subscription-routes.test.ts',
  'apps/nanocore/src/providers/vault-credential-resolver.test.ts',
  'apps/nanocore/src/quick-chat-workspace.test.ts',
  'apps/nanocore/src/quick-chat.test.ts',
  'apps/nanocore/src/remote-mcp-routes.test.ts',
  'apps/nanocore/src/remote-mcp-workspace-export.test.ts',
  'apps/nanocore/src/retrieval-knowledge-governance.test.ts',
  'apps/nanocore/src/retrieval-knowledge.test.ts',
  'apps/nanocore/src/retrieval-memory.test.ts',
  'apps/nanocore/src/retrieval-query-context.test.ts',
  'apps/nanocore/src/retrieval-sources.test.ts',
  'apps/nanocore/src/runtime-config-files.test.ts',
  'apps/nanocore/src/runtime-config-reload.test.ts',
  'apps/nanocore/src/runtime/administrator-cleanup-view.test.ts',
  'apps/nanocore/src/runtime/aep-snapshot-durability.test.ts',
  'apps/nanocore/src/runtime/aep-snapshot-ledger.test.ts',
  'apps/nanocore/src/runtime/agent-environment.test.ts',
  'apps/nanocore/src/runtime/agent-skill-supply.test.ts',
  'apps/nanocore/src/runtime/cancelled-admission-checkpoint-cleanup.test.ts',
  'apps/nanocore/src/runtime/captured-pending-call.test.ts',
  'apps/nanocore/src/runtime/control-goal-command.test.ts',
  'apps/nanocore/src/runtime/execution-attempt-formats.test.ts',
  'apps/nanocore/src/runtime/execution-backend-port.test.ts',
  'apps/nanocore/src/runtime/execution-step-journal.test.ts',
  'apps/nanocore/src/runtime/external-trigger-service.test.ts',
  'apps/nanocore/src/runtime/feedback.test.ts',
  'apps/nanocore/src/runtime/goal-coordinator.test.ts',
  'apps/nanocore/src/runtime/goal-discovery.test.ts',
  'apps/nanocore/src/runtime/goal-domain-approval.test.ts',
  'apps/nanocore/src/runtime/goal-domain-publication.test.ts',
  'apps/nanocore/src/runtime/goal-inspection.test.ts',
  'apps/nanocore/src/runtime/goal-owner.test.ts',
  'apps/nanocore/src/runtime/goal-pending-cutover.test.ts',
  'apps/nanocore/src/runtime/goal-task-administration.test.ts',
  'apps/nanocore/src/runtime/goal-task-policy-context.test.ts',
  'apps/nanocore/src/runtime/goal-task-runtime-policy.test.ts',
  'apps/nanocore/src/runtime/goal-wake.test.ts',
  'apps/nanocore/src/runtime/idempotent-command.test.ts',
  'apps/nanocore/src/runtime/mcp-tool-schema-snapshots.test.ts',
  'apps/nanocore/src/runtime/nanohost-delete-result.test.ts',
  'apps/nanocore/src/runtime/nanohost-epoch-audit.test.ts',
  'apps/nanocore/src/runtime/nanohost-harness-records.test.ts',
  'apps/nanocore/src/runtime/nanohost-lifecycle-diagnostics.test.ts',
  'apps/nanocore/src/runtime/nanohost-runtime-target.test.ts',
  'apps/nanocore/src/runtime/nanohost-session-dispatch.test.ts',
  'apps/nanocore/src/runtime/native-archive-pending-race.test.ts',
  'apps/nanocore/src/runtime/native-environment.test.ts',
  'apps/nanocore/src/runtime/openkit-generative-mcp.test.ts',
  'apps/nanocore/src/runtime/openkit-work-mcp.test.ts',
  'apps/nanocore/src/runtime/orchestrator.test.ts',
  'apps/nanocore/src/runtime/pending-authority.test.ts',
  'apps/nanocore/src/runtime/pending-requests.scope-admission.test.ts',
  'apps/nanocore/src/runtime/pending-requests.test.ts',
  'apps/nanocore/src/runtime/provider-readiness.test.ts',
  'apps/nanocore/src/runtime/recurring-schedule-preparation.test.ts',
  'apps/nanocore/src/runtime/recurring-schedule-service.test.ts',
  'apps/nanocore/src/runtime/runtime-evidence.test.ts',
  'apps/nanocore/src/runtime/scheduler-admission-audience.test.ts',
  'apps/nanocore/src/runtime/scheduler-admission-routes.test.ts',
  'apps/nanocore/src/runtime/scheduler-dispatch-loop.scope-admission.test.ts',
  'apps/nanocore/src/runtime/scheduler-dispatch-loop.test.ts',
  'apps/nanocore/src/runtime/scheduler-dispatch-service.test.ts',
  'apps/nanocore/src/runtime/scheduler-lease-maintenance-service.test.ts',
  'apps/nanocore/src/runtime/scheduler-lease-watch-loop.test.ts',
  'apps/nanocore/src/runtime/scheduler-restart-recovery.test.ts',
  'apps/nanocore/src/runtime/server-mcp-process.test.ts',
  'apps/nanocore/src/runtime/skill-run-selection.test.ts',
  'apps/nanocore/src/runtime/task-admission.test.ts',
  'apps/nanocore/src/runtime/task-terminal-fact.test.ts',
  'apps/nanocore/src/runtime/thread-native-resume.test.ts',
  'apps/nanocore/src/runtime/turn-executor-factory.test.ts',
  'apps/nanocore/src/runtime/worker-artifact-atomicity.test.ts',
  'apps/nanocore/src/runtime/worker-backend-cleanup-projection.test.ts',
  'apps/nanocore/src/runtime/worker-backend-sessions.test.ts',
  'apps/nanocore/src/runtime/worker-checkpoint-failed-start.test.ts',
  'apps/nanocore/src/runtime/worker-checkpoints.test.ts',
  'apps/nanocore/src/runtime/worker-control-cancellation.test.ts',
  'apps/nanocore/src/runtime/worker-control-gateway.test.ts',
  'apps/nanocore/src/runtime/worker-control-rebuild.test.ts',
  'apps/nanocore/src/runtime/worker-control-records.test.ts',
  'apps/nanocore/src/runtime/worker-environment-runtime-effects.test.ts',
  'apps/nanocore/src/runtime/worker-final-handoff-ownership.test.ts',
  'apps/nanocore/src/runtime/worker-first-release-faults.test.ts',
  'apps/nanocore/src/runtime/worker-governance-backend.test.ts',
  'apps/nanocore/src/runtime/worker-governance-turn-executor.test.ts',
  'apps/nanocore/src/runtime/worker-image-environment.test.ts',
  'apps/nanocore/src/runtime/worker-image-settlements.test.ts',
  'apps/nanocore/src/runtime/worker-lifecycle-telemetry.test.ts',
  'apps/nanocore/src/runtime/worker-mcp-gateway.test.ts',
  'apps/nanocore/src/runtime/worker-no-allocation-recovery.test.ts',
  'apps/nanocore/src/runtime/worker-raw-output.test.ts',
  'apps/nanocore/src/runtime/worker-recovery-routes.test.ts',
  'apps/nanocore/src/runtime/worker-recovery.test.ts',
  'apps/nanocore/src/runtime/worker-runtime-provenance.test.ts',
  'apps/nanocore/src/runtime/worker-skill-snapshot.test.ts',
  'apps/nanocore/src/runtime/worker-storage-bindings.test.ts',
  'apps/nanocore/src/runtime/worker-transcript.test.ts',
  'apps/nanocore/src/runtime/worker-turn-failure.test.ts',
  'apps/nanocore/src/runtime/worker-turn-loop.test.ts',
  'apps/nanocore/src/runtime/workspace-apply-plans.test.ts',
  'apps/nanocore/src/runtime/workspace-apply-results.test.ts',
  'apps/nanocore/src/runtime/workspace-execution-journal.test.ts',
  'apps/nanocore/src/runtime/workspace-filesystem-staging.test.ts',
  'apps/nanocore/src/runtime/workspace-quarantine-records.test.ts',
  'apps/nanocore/src/runtime/workspace-reconciliation-records.test.ts',
  'apps/nanocore/src/runtime/workspace-review-application.test.ts',
  'apps/nanocore/src/runtime/workspace-snapshot-chain.test.ts',
  'apps/nanocore/src/runtime/workspace-sync-operations.test.ts',
  'apps/nanocore/src/runtime/workspace-sync-records.test.ts',
  'apps/nanocore/src/scheduler-admission-contract.test.ts',
  'apps/nanocore/src/scheduler-records.test.ts',
  'apps/nanocore/src/search.test.ts',
  'apps/nanocore/src/server-knowledge-retrieval.test.ts',
  'apps/nanocore/src/server-shared-mcp.test.ts',
  'apps/nanocore/src/server-thread-operation-projections.test.ts',
  'apps/nanocore/src/server.test.ts',
  'apps/nanocore/src/skill-candidate-artifact.test.ts',
  'apps/nanocore/src/task-pending-operation-projections.test.ts',
  'apps/nanocore/src/test-support/demo-data-contract.test.ts',
  'apps/nanocore/src/thread-dashboard.test.ts',
  'apps/nanocore/src/thread-read-state.test.ts',
  'apps/nanocore/src/turn-routes.test.ts',
  'apps/nanocore/src/user-memory-first-use-operation-projections.test.ts',
  'apps/nanocore/src/user-memory-operation-projections.test.ts',
  'apps/nanocore/src/vault-injection-plans.test.ts',
  'apps/nanocore/src/vault-injection-receipts.test.ts',
  'apps/nanocore/src/vault/grant-issuance.test.ts',
  'apps/nanocore/src/vault/vault-admin-audit-events.test.ts',
  'apps/nanocore/src/vault/vault-admin-routes.test.ts',
  'apps/nanocore/src/vault/vault-grant-narrowing.test.ts',
  'apps/nanocore/src/vault/vault-grant-requests.test.ts',
  'apps/nanocore/src/vault/vault-grants.test.ts',
  'apps/nanocore/src/vault/vault-references.test.ts',
  'apps/nanocore/src/vault/vault-revocation-projection.test.ts',
  'apps/nanocore/src/vault/vault-use-audited-backend.test.ts',
  'apps/nanocore/src/vault/vault-use-records.test.ts',
  'apps/nanocore/src/worker-control-routes.test.ts',
  'apps/nanocore/src/worker-environments/worker-environment-activation.test.ts',
  'apps/nanocore/src/worker-environments/worker-environment-app.test.ts',
  'apps/nanocore/src/worker-environments/worker-environment-operations.test.ts',
  'apps/nanocore/src/worker-environments/worker-environment-routes.test.ts',
  'apps/nanocore/src/worker-inference-routes.test.ts',
  'apps/nanocore/src/worker-mcp-routes.test.ts',
  'apps/nanocore/src/workspace-child-lineage.test.ts',
  'apps/nanocore/src/workspace-dashboard.test.ts',
  'apps/nanocore/src/workspace-deletion-evidence.test.ts',
  'apps/nanocore/src/workspace-deletion-routes.test.ts',
  'apps/nanocore/src/workspace-lifecycle-operations.test.ts',
  'apps/nanocore/src/workspace-materials.test.ts',
  'apps/nanocore/src/workspace-membership.test.ts',
  'apps/nanocore/src/workspace-retirement.test.ts',
  'apps/nanocore/src/workspace-routes.test.ts',
  'apps/nanocore/src/workspace-sharing-routes.test.ts',
  'apps/nanocore/src/workspace-sharing.test.ts',
  'apps/web/e2e/_lib/servers.spec.ts',
  'apps/web/e2e/generative-native.spec.ts',
  'packages/worker-shim/src/adapters/opencode.test.ts',
  'tests/upgrade-from-previous-corpus.test.mjs',
  'tests/upgrade-from-previous-sql-corpus.test.mjs',
  'tests/upgrade-from-previous.test.mjs',
]);
const STORAGE_OWNER_TEST_ROOTS = ['apps/nanocore/src/storage/', 'packages/storage/'];
const SQL_STATEMENT =
  /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|ROLLBACK|REPLACE|ATTACH|VACUUM)\b/iu;

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TEST_COMMAND_MAX_BUFFER = 64 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set(['.git', '.turbo', 'coverage', 'dist', 'node_modules', 'temp']);
const CHILD_PROCESS_CALLEES = new Set([
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'spawn',
  'spawnSync',
]);
const CONTAINER_RUNTIMES = new Set(['docker', 'nerdctl', 'podman']);
const LINK_RESOLUTION_CALLEES = new Set([
  'readlink',
  'readlinkSync',
  'realpath',
  'realpathSync',
  'symlink',
  'symlinkSync',
]);
const PLATFORM_PATH_CALLEES = new Set([
  'access',
  'accessSync',
  'existsSync',
  'lstat',
  'lstatSync',
  'readFile',
  'readFileSync',
  'readdir',
  'readdirSync',
  'readlink',
  'readlinkSync',
  'stat',
  'statSync',
]);
const CONTAINER_SUBJECT_PRAGMA = '// openkit-test-container-subject';
const PLATFORM_POSIX_PRAGMA = '// openkit-test-platform: posix';
const PLATFORM_DIVERGENCE_PRAGMA = '// openkit-test-platform-divergence';
const HOST_PLACEMENT_PREFIX = /^bash\s+scripts\/test-env\.sh\s+host\b/u;
const OPENKIT_ENV_NAME = /^OPENKIT_[A-Z0-9_]+$/u;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]+=[^\s;|&<>]*$/u;
const SHELL_CALLEES = new Set(['exec', 'execSync']);
const UNATTRIBUTED_SKIP_SUMMARY =
  /^\s*(?:(?:Test Files|Tests)\s+(\d+)\s+skipped\b|ℹ\s+skipped\s+(\d+)\b)/gimu;
const PRE_RUN_BINARY_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/**
 * Validates static test-governance rules for one repository tree.
 *
 * Container-runtime and platform-interface findings are bounded syntactic conversions. Dockerfile text reads are allowed. The platform families do not cover dependence expressed through other interfaces.
 *
 * @param {string} root Repository or fixture root.
 * @returns {string[]} Stable file and line findings.
 */
export function validateTestGovernance(root) {
  const errors = [];
  const resolvedRoot = resolve(root);
  const hostMappedPaths = hostMappedTestPaths(resolvedRoot);
  for (const path of testFiles(resolvedRoot)) {
    const text = readFileSync(path, 'utf8');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const containerSubject = containerSubjectPragmaHolds(text, hostMappedPaths, resolvedRoot, path);
    const platformFilePragma =
      hasExactPragma(text, PLATFORM_POSIX_PRAGMA) ||
      hasExactPragma(text, PLATFORM_DIVERGENCE_PRAGMA);
    const osBindings = nodeOsBindings(source);
    const relativePath = relative(resolvedRoot, path).split('\\').join('/');
    const storageOwner = STORAGE_OWNER_TEST_ROOTS.some((prefix) => relativePath.startsWith(prefix));
    if (!storageOwner && !STORAGE_TEST_GRANDFATHERED_PATHS.has(relativePath)) {
      visit(source, (node) => {
        const access = testStorageAccess(node);
        if (access) errors.push(finding(path, source, node, access));
      });
    }
    visit(source, (node) => {
      collectSkipFinding(errors, path, source, node);
      if (!containerSubject) {
        const runtime = containerRuntimeInvocation(node);
        if (runtime) {
          errors.push(finding(path, source, node, `test invokes container runtime ${runtime}`));
        }
      }
      if (!platformFilePragma && !platformPredicateCovers(node)) {
        const family = platformInterfaceFamily(node, osBindings);
        if (family) errors.push(finding(path, source, node, family));
      }
    });
  }
  return errors;
}

/** Finds named direct SQLite surfaces, not inert SQL examples or general owner operations. */
function testStorageAccess(node) {
  if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
    const specifier = node.moduleSpecifier;
    if (
      ts.isStringLiteral(specifier) &&
      /(?:^|\/)(?:better-sqlite3|node:sqlite)$/u.test(specifier.text)
    ) {
      return 'test imports an internal SQLite handle; use the storage owner';
    }
  }
  const member = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression)
      ? node.argumentExpression.text
      : null;
  if (member === 'sqlite') return 'test accesses an internal SQLite handle; use the storage owner';
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : '';
    if (/^(?:open|bind)(?:Core|Workspace|User|LightApp)(?:Db|Sqlite)$/u.test(name)) {
      return 'test opens an internal SQLite handle; use the storage owner';
    }
    const input = node.arguments[0];
    if (
      ts.isPropertyAccessExpression(callee) &&
      !ts.isRegularExpressionLiteral(callee.expression) &&
      ['prepare', 'exec'].includes(name) &&
      input &&
      (ts.isStringLiteralLike(input) || ts.isTemplateExpression(input)) &&
      SQL_STATEMENT.test(ts.isTemplateExpression(input) ? input.head.text : input.text)
    ) {
      return 'test executes raw SQL outside a storage owner';
    }
  }
  if (
    ts.isTaggedTemplateExpression(node) &&
    ((ts.isIdentifier(node.tag) && node.tag.text === 'sql') ||
      (ts.isPropertyAccessExpression(node.tag) && node.tag.name.text === 'sql'))
  ) {
    return 'test uses raw SQL outside a storage owner';
  }
  return null;
}

/** Runs one test command exactly once and returns runner-governance failures. */
export function runTestSuite(options) {
  return executeTestSuite(options).errors;
}

/** Executes one command and retains its output for the CLI projection. */
function executeTestSuite(options) {
  const command = options.command ?? [];
  if (!Array.isArray(command) || command.length === 0) {
    return { errors: ['A test command is required.'], stderr: '', stdout: '' };
  }
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: TEST_COMMAND_MAX_BUFFER,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const errors = [];
  if (result.error) errors.push(`Test command failed to start: ${result.error.message}`);
  if (result.signal) errors.push(`Test command ended from signal ${result.signal}.`);
  if (result.status !== null && result.status !== 0) {
    errors.push(`Test command exited with status ${result.status}.`);
  }
  const cwd = options.cwd ?? process.cwd();
  const declarations = options.allowedSkipDeclarations ?? declaredSkipNames(cwd);
  const discoveredTestFiles = options.discoveredTestFiles ?? relativeTestFiles(cwd);
  // Reporter decoration must not hide skips; retain raw streams for the CLI.
  const output = stripVTControlCharacters(`${stdout}\n${stderr}`);
  for (const name of reportedTapSkipNames(output)) {
    if (!fileBoundSkipIsAllowed(hierarchyParts(name), declarations, discoveredTestFiles)) {
      errors.push(`Test suite reported undeclared skip: ${name}`);
    }
  }
  const unattributedSkipped = unattributedSkippedCount(output);
  if (unattributedSkipped > 0) {
    errors.push(
      `Test suite reported ${unattributedSkipped} skipped test(s) that cannot be attributed to a declared pre-run opt-in`
    );
  }
  return { errors, stderr, stdout };
}

/** Returns test files beneath one repository root without following generated dependency trees. */
function testFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(resolve(directory, entry.name));
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        files.push(resolve(directory, entry.name));
      }
    }
  }
  return files.sort();
}

/** Visits every syntax node in source order. */
function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

/** Returns the property name invoked by one call expression. */
function callMember(node) {
  return ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
}

/** Finds the nearest ancestor matching one TypeScript predicate. */
function ancestor(node, predicate) {
  let current = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

/** Collects one anti-skip finding for a skip, skipIf, or runIf call. */
function collectSkipFinding(errors, path, source, node) {
  if (!ts.isCallExpression(node)) return;
  const member = callMember(node);
  if (member !== 'skip' && member !== 'skipIf' && member !== 'runIf') return;
  if (member === 'skipIf' || member === 'runIf') {
    const condition = node.arguments[0];
    if (!condition || !isDeclaredPreRunCondition(condition)) {
      errors.push(
        finding(
          path,
          source,
          node,
          `${member} requires a pre-run platform or OPENKIT_* opt-in declaration`
        )
      );
    }
    return;
  }
  const catchClause = ancestor(node, ts.isCatchClause);
  if (catchClause) {
    errors.push(finding(path, source, node, 'skip is reachable from a caught runtime error'));
    return;
  }
  let guarded = false;
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isIfStatement(current)) continue;
    guarded = true;
    if (!isDeclaredPreRunCondition(current.expression)) {
      errors.push(
        finding(path, source, node, 'skip is conditioned on a runtime result or capability probe')
      );
      return;
    }
  }
  if (guarded) return;
  errors.push(finding(path, source, node, 'skip lacks a declared pre-run opt-in'));
}

/** Recognizes a pre-run condition composed only of bounded inputs, literals, and operators. */
function isDeclaredPreRunCondition(node) {
  return isPreRunExpressionShape(node) && containsBoundedPreRunInput(node);
}

/** Returns whether one expression uses only bounded pre-run inputs, literals, and operators. */
function isPreRunExpressionShape(node) {
  if (!node) return false;
  if (ts.isParenthesizedExpression(node)) return isPreRunExpressionShape(node.expression);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return isPreRunExpressionShape(node.operand);
  }
  if (ts.isBinaryExpression(node)) {
    return (
      PRE_RUN_BINARY_OPERATORS.has(node.operatorToken.kind) &&
      isPreRunExpressionShape(node.left) &&
      isPreRunExpressionShape(node.right)
    );
  }
  if (isPreRunLiteral(node)) return true;
  if (isProcessProperty(node, 'platform')) return true;
  return isOpenkitEnvAccess(node);
}

/** Returns whether one expression names process.platform or process.env.OPENKIT_*. */
function containsBoundedPreRunInput(node) {
  let found = false;
  visit(node, (child) => {
    if (isProcessProperty(child, 'platform') || isOpenkitEnvAccess(child)) found = true;
  });
  return found;
}

/** Returns whether one node is a literal permitted in a pre-run predicate. */
function isPreRunLiteral(node) {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  );
}

/** Returns whether one node is `process.env.OPENKIT_*` or `process.env['OPENKIT_*']`. */
function isOpenkitEnvAccess(node) {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    node.expression.name.text === 'env' &&
    OPENKIT_ENV_NAME.test(node.name.text)
  ) {
    return true;
  }
  return (
    ts.isElementAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    node.expression.name.text === 'env' &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    OPENKIT_ENV_NAME.test(node.argumentExpression.text)
  );
}

/** Returns whether one source file contains an exact one-line pragma. */
function hasExactPragma(text, pragma) {
  return text.split(/\r?\n/u).includes(pragma);
}

/** Collects test paths named in arguments of an anchored `bash scripts/test-env.sh host` script. */
function hostMappedTestPaths(root) {
  const manifestPath = join(root, 'package.json');
  if (!existsSync(manifestPath)) return new Set();
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return new Set();
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest))
    return new Set();
  const paths = new Set();
  for (const command of Object.values(manifest.scripts ?? {})) {
    if (typeof command !== 'string' || !HOST_PLACEMENT_PREFIX.test(command)) continue;
    const argumentText = command.replace(HOST_PLACEMENT_PREFIX, '');
    const hostArguments = argumentText.split(/\s*(?:&&|\|\||;|&|\|)\s*/u)[0] ?? '';
    for (const token of hostArguments.split(/\s+/u)) {
      const mapped = token.replace(/^\.\//u, '');
      if (TEST_FILE.test(mapped)) paths.add(mapped.split('\\').join('/'));
    }
  }
  return paths;
}

/** Returns whether exact container-subject pragma is backed by a host-placed root script naming this file. */
function containerSubjectPragmaHolds(text, hostMappedPaths, root, path) {
  if (!hasExactPragma(text, CONTAINER_SUBJECT_PRAGMA)) return false;
  const relativePath = relative(root, path).split('\\').join('/');
  return hostMappedPaths.has(relativePath);
}

/** Counts unnamed Vitest or Node spec skips, which cannot prove file-bound authorization. */
function unattributedSkippedCount(output) {
  let skipped = 0;
  for (const match of output.matchAll(UNATTRIBUTED_SKIP_SUMMARY)) {
    skipped = Math.max(skipped, Number(match[1] ?? match[2] ?? 0));
  }
  return skipped;
}

/** Reads TAP and Turbo-prefixed tap-flat skip titles from one suite's combined output. */
function reportedTapSkipNames(output) {
  const names = [];
  for (const line of output.split(/\r?\n/u)) {
    const stripped = line.replace(/^(?:[^:\s]+:)+\s+/u, '');
    const match = /^(?:ok|not ok)\s+\d+\s+-\s+(.+?)\s+#\s+SKIP\b/u.exec(stripped);
    if (match?.[1]) names.push(match[1].trim());
  }
  return names;
}

/** Splits one TAP skip title into `>`-separated hierarchy components. */
function hierarchyParts(name) {
  return name
    .split(/\s*>\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Authorizes a TAP skip only when a reporter suffix uniquely matches one discovered test file. */
function fileBoundSkipIsAllowed(parts, declarations, discoveredTestFiles) {
  if (!Array.isArray(declarations) || declarations.length === 0) return false;
  if (!Array.isArray(discoveredTestFiles) || discoveredTestFiles.length === 0) return false;
  const reporterFiles = parts
    .map((part) => part.replace(/^\.\//u, '').split('\\').join('/'))
    .filter((part) => TEST_FILE.test(part));
  if (reporterFiles.length === 0) return false;
  const matchedFiles = new Set();
  for (const reporterFile of reporterFiles) {
    const matches = discoveredTestFiles.filter((file) => pathSuffixMatch(file, reporterFile));
    if (matches.length !== 1) return false;
    matchedFiles.add(matches[0]);
  }
  if (matchedFiles.size !== 1) return false;
  const file = [...matchedFiles][0];
  const names = new Set(
    declarations
      .filter((declaration) => declaration.file === file)
      .map((declaration) => declaration.name)
  );
  const titleParts = parts.filter(
    (part) => !TEST_FILE.test(part.replace(/^\.\//u, '').split('\\').join('/'))
  );
  return titleParts.some((part) => names.has(part));
}

/** Returns whether one discovered path suffix-matches a reporter file component. */
function pathSuffixMatch(discoveredFile, reporterFile) {
  const discovered = discoveredFile.split('\\').join('/');
  const reporter = reporterFile.replace(/^\.\//u, '').split('\\').join('/');
  return (
    discovered === reporter ||
    discovered.endsWith(`/${reporter}`) ||
    reporter.endsWith(`/${discovered}`)
  );
}

/** Returns whether a skipIf/runIf platform predicate covers this node's test or suite subtree. */
function platformPredicateCovers(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isCallExpression(parent)) {
      const member = callMember(parent);
      if ((member === 'skipIf' || member === 'runIf') && isPlatformPredicate(parent.arguments[0])) {
        return true;
      }
      const callee = parent.expression;
      if (
        ts.isCallExpression(callee) &&
        (callMember(callee) === 'skipIf' || callMember(callee) === 'runIf') &&
        isPlatformPredicate(callee.arguments[0]) &&
        isFunctionLike(current)
      ) {
        return true;
      }
    }
    current = parent;
  }
  return false;
}

/** Returns whether one condition is a wholly pre-run predicate that names process.platform. */
function isPlatformPredicate(node) {
  return Boolean(node) && isDeclaredPreRunCondition(node) && containsProcessPlatform(node);
}

/** Returns whether one expression tree contains `process.platform`. */
function containsProcessPlatform(node) {
  let found = false;
  visit(node, (child) => {
    if (isProcessProperty(child, 'platform')) found = true;
  });
  return found;
}

/** Returns whether one node is a function expression used as a test or suite callback. */
function isFunctionLike(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** Collects imported and namespaced node:os platform and arch bindings. */
function nodeOsBindings(source) {
  const names = new Set();
  const namespaces = new Set();
  visit(source, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
    if (node.moduleSpecifier.text !== 'node:os' && node.moduleSpecifier.text !== 'os') return;
    const clause = node.importClause;
    if (!clause) return;
    if (clause.name) namespaces.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) return;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      return;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === 'arch' || imported === 'platform') names.add(element.name.text);
    }
  });
  return { names, namespaces };
}

/** Returns the identifier or property name invoked by one call expression. */
function calleeName(node) {
  if (!ts.isCallExpression(node)) return null;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

/** Returns a literal docker, podman, or nerdctl command executed through child_process. */
function containerRuntimeInvocation(node) {
  const callee = calleeName(node);
  if (!CHILD_PROCESS_CALLEES.has(callee ?? '')) return null;
  const command = node.arguments[0];
  if (!command || !ts.isStringLiteralLike(command)) return null;
  const text = command.text.trim();
  if (SHELL_CALLEES.has(callee)) return shellContainerRuntime(text);
  return pathContainerRuntime(text);
}

/** Returns a container runtime named by a literal executable path. */
function pathContainerRuntime(text) {
  const base = posix.basename(text.replace(/\\/g, '/'));
  return CONTAINER_RUNTIMES.has(base) ? base : null;
}

/** Returns a container runtime from a shell string after bounded leading NAME=value tokens. */
function shellContainerRuntime(text) {
  const tokens = text.split(/\s+/u).filter(Boolean);
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index])) index += 1;
  if (index >= tokens.length) return null;
  return pathContainerRuntime(tokens[index]);
}

/** Returns whether one node is `process.<name>`. */
function isProcessProperty(node, name) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === name
  );
}

/**
 * Names one enumerated platform-interface family, or null when the node is outside the list.
 *
 * @param {ts.Node} node Current syntax node.
 * @param {{ names: Set<string>, namespaces: Set<string> }} osBindings Imported node:os bindings.
 * @returns {string|null} Finding text naming the family.
 */
function platformInterfaceFamily(node, osBindings) {
  if (isProcessProperty(node, 'platform')) {
    return 'undeclared process.platform platform interface';
  }
  if (ts.isCallExpression(node) && isProcessProperty(node.expression, 'kill')) {
    return 'undeclared process-group platform interface (process.kill or signal)';
  }
  if (ts.isPropertyAssignment(node)) {
    const name = ts.isIdentifier(node.name)
      ? node.name.text
      : ts.isStringLiteralLike(node.name)
        ? node.name.text
        : null;
    if (name === 'detached' && node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return 'undeclared process-group platform interface (detached process group)';
    }
  }
  if (
    ts.isStringLiteralLike(node) &&
    ts.isCallExpression(node.parent) &&
    PLATFORM_PATH_CALLEES.has(calleeName(node.parent) ?? '')
  ) {
    if (node.text.startsWith('/proc') || node.text.startsWith('/sys/fs/cgroup')) {
      return 'undeclared /proc or cgroup platform interface';
    }
  }
  if (LINK_RESOLUTION_CALLEES.has(calleeName(node) ?? '')) {
    return 'undeclared realpath, readlink, or symlink link-resolution platform interface';
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    osBindings.names.has(node.expression.text)
  ) {
    return `undeclared node:os platform interface os.${node.expression.text}`;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    osBindings.namespaces.has(node.expression.expression.text) &&
    (node.expression.name.text === 'arch' || node.expression.name.text === 'platform')
  ) {
    return `undeclared node:os platform interface os.${node.expression.name.text}`;
  }
  return null;
}

/** Formats one stable file and line finding. */
function finding(path, source, node, message) {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  return `${path}:${line}: ${message}`;
}

/** Returns repository-relative test paths discovered under one root. */
function relativeTestFiles(root) {
  return testFiles(root).map((path) => relative(root, path).split('\\').join('/'));
}

/** Collects file-bound test or suite names whose skip predicates are declared before execution. */
function declaredSkipNames(root) {
  const names = [];
  for (const path of testFiles(root)) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const file = relative(root, path).split('\\').join('/');
    visit(source, (node) => {
      if (!ts.isCallExpression(node) || !ts.isCallExpression(node.expression)) return;
      const declaration = node.expression;
      const member = callMember(declaration);
      if (member !== 'skipIf' && member !== 'runIf') return;
      const condition = declaration.arguments[0];
      const name = node.arguments[0];
      if (
        condition &&
        isDeclaredPreRunCondition(condition) &&
        name &&
        ts.isStringLiteralLike(name)
      ) {
        names.push({ file, name: name.text });
      }
    });
  }
  return names;
}

/** Runs the command-line projection. */
function main(argv) {
  if (argv[0] === '--run') {
    const separator = argv.indexOf('--');
    const command = separator === -1 ? [] : argv.slice(separator + 1);
    const root = process.cwd();
    const result = executeTestSuite({
      allowedSkipDeclarations: declaredSkipNames(root),
      command,
      discoveredTestFiles: relativeTestFiles(root),
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    report(result.errors);
    return;
  }
  report(validateTestGovernance(resolve(argv[0] ?? process.cwd())));
}

/** Prints findings and selects the CLI exit status. */
function report(errors) {
  if (errors.length === 0) return;
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
