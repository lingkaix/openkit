import {
  ConsumeOpenKitBootstrapTokenRequestSchema,
  ConsumeOpenKitBootstrapTokenResponseSchema,
  CreateAutomationRequestSchema,
  CreateOpenKitAccessTokenRequestSchema,
  GoalStepReviewPolicyOverrideSchema,
  RotateOpenKitAccessTokenRequestSchema,
  UpdateAutomationRequestSchema,
  VaultAdminBootstrapCodexAuthJsonRequestSchema,
  VaultAdminUnlockRequestSchema,
  WorkspaceRelativePathSchema,
} from '@openkit/app-api-schemas';
import { createRequestId } from '@openkit/core-client';
import { RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import {
  ENCRYPTED_FALLBACK_CREDENTIAL_STORAGE_WARNING,
  type NanoCoreCredentialStorageBackend,
  type NanoCoreCredentialStore,
} from './credential-store.js';
import type { OpenKitNanoCoreClient } from './nanocore-client.js';
import { redactPublicValue } from './redaction.js';

/** Role used by rendered MCP prompt messages. */
export type PromptRole = 'user' | 'assistant';

/** Rendered MCP prompt message. */
export interface RenderedPromptMessage {
  /** Prompt message role. */
  role: PromptRole;
  /** Prompt message content. */
  content: string;
}

/** Rendered prompt returned by the registry. */
export interface RenderedPrompt {
  /** Prompt name. */
  name: string;
  /** Prompt messages. */
  messages: RenderedPromptMessage[];
}

/** MCP-facing tool definition held by the registry. */
export interface OpenKitToolDefinition {
  /** Stable MCP tool name. */
  name: OpenKitToolName;
  /** Human-readable tool description. */
  description: string;
  /** Input schema used by the MCP transport and tests. */
  inputSchema: z.ZodType;
  /** Whether the tool mutates NanoCore state. */
  mutating: boolean;
}

/** MCP-facing read-only resource definition. */
export interface OpenKitResourceDefinition {
  /** Resource URI or URI template. */
  uri: string;
  /** Human-readable resource description. */
  description: string;
}

/** Resource payload returned by the registry. */
export interface OpenKitResourceResult {
  /** Resource URI that was read. */
  uri: string;
  /** Resource MIME type. */
  mimeType: 'application/json';
  /** JSON text content. */
  text: string;
}

/** MCP-facing prompt definition. */
export interface OpenKitPromptDefinition {
  /** Stable prompt name. */
  name: OpenKitPromptName;
  /** Human-readable prompt description. */
  description: string;
}

/** Normalized tool result returned to MCP clients. */
export interface OpenKitToolResult {
  /** Whether the MCP facade completed the requested operation. */
  ok: boolean;
  /** Optional request id for mutating calls. */
  requestId?: string | undefined;
  /** Optional workspace id affected by the call. */
  workspaceId?: string | undefined;
  /** Optional thread id affected by the call. */
  threadId?: string | undefined;
  /** User-facing summary of the operation. */
  summary: string;
  /** Suggested next MCP actions for the desktop agent app. */
  nextSuggestedActions: string[];
  /** Schema-validated or otherwise public payload after redaction. */
  raw?: unknown | undefined;
}

/** Options for creating the OpenKit AI Interface registry. */
export interface CreateOpenKitAiInterfaceOptions {
  /** NanoCore facade used by tools and resources. */
  nanoCore: OpenKitNanoCoreClient;
  /** NanoCore endpoint URL used as the credential storage key. */
  nanoCoreBaseUrl?: string | undefined;
  /** Optional desktop credential store used by bootstrap setup flows. */
  credentialStore?: NanoCoreCredentialStore | undefined;
}

/** OpenKit AI Interface registry exposed to MCP transports and tests. */
export interface OpenKitAiInterfaceRegistry {
  /** Lists MCP tools. */
  listTools(): OpenKitToolDefinition[];
  /** Calls one MCP tool by name. */
  callTool(name: OpenKitToolName, input: unknown): Promise<OpenKitToolResult>;
  /** Lists MCP resources. */
  listResources(): OpenKitResourceDefinition[];
  /** Reads one MCP resource by URI. */
  readResource(uri: string): Promise<OpenKitResourceResult>;
  /** Lists MCP prompts. */
  listPrompts(): OpenKitPromptDefinition[];
  /** Renders one MCP prompt. */
  getPrompt(name: OpenKitPromptName, input?: unknown): RenderedPrompt;
}

/** Stable MCP tool names. */
export type OpenKitToolName = (typeof toolCatalog)[number]['name'];

/** Stable MCP prompt names. */
export type OpenKitPromptName = (typeof promptNames)[number];

const toolCatalog = [
  { mutating: false, name: 'openkit.read_status' },
  { mutating: false, name: 'openkit.read_runtime_diagnostics' },
  { mutating: false, name: 'openkit.read_storage_layout_report' },
  { mutating: true, name: 'openkit.consume_bootstrap_token' },
  { mutating: false, name: 'openkit.list_openkit_access_tokens' },
  { mutating: true, name: 'openkit.create_openkit_access_token' },
  { mutating: true, name: 'openkit.revoke_openkit_access_token' },
  { mutating: true, name: 'openkit.rotate_openkit_access_token' },
  { mutating: true, name: 'openkit.create_data_root_backup' },
  { mutating: false, name: 'openkit.verify_data_root_backup' },
  { mutating: false, name: 'openkit.read_vault_admin_status' },
  { mutating: true, name: 'openkit.unlock_vault_admin_backend' },
  { mutating: true, name: 'openkit.lock_vault_admin_backend' },
  { mutating: true, name: 'openkit.bootstrap_codex_auth_json_vault_reference' },
  { mutating: true, name: 'openkit.export_workspace' },
  { mutating: false, name: 'openkit.dry_run_workspace_import' },
  { mutating: true, name: 'openkit.import_workspace' },
  { mutating: false, name: 'openkit.read_workspace_vault_references' },
  { mutating: false, name: 'openkit.read_workspace_vault_grants' },
  { mutating: false, name: 'openkit.read_workspace_injection_plans' },
  { mutating: false, name: 'openkit.read_workspace_injection_receipts' },
  { mutating: false, name: 'openkit.read_workspace_vault_use_records' },
  { mutating: false, name: 'openkit.read_vault_use_records' },
  { mutating: true, name: 'openkit.rebind_workspace_vault_reference' },
  { mutating: false, name: 'openkit.read_capability_usage' },
  { mutating: false, name: 'openkit.read_workspace_audit_events' },
  { mutating: false, name: 'openkit.read_server_audit_events' },
  { mutating: false, name: 'openkit.read_workspace_permission_decisions' },
  { mutating: false, name: 'openkit.read_server_permission_decisions' },
  { mutating: true, name: 'openkit.start_nanocore' },
  { mutating: false, name: 'openkit.answer_knowledge' },
  { mutating: true, name: 'openkit.register_knowledge_source' },
  { mutating: false, name: 'openkit.list_knowledge_sources' },
  { mutating: false, name: 'openkit.read_knowledge_source' },
  { mutating: true, name: 'openkit.record_knowledge_observation' },
  { mutating: false, name: 'openkit.list_knowledge_observations' },
  { mutating: true, name: 'openkit.record_knowledge_claim' },
  { mutating: false, name: 'openkit.list_knowledge_claims' },
  { mutating: true, name: 'openkit.promote_knowledge_claim' },
  { mutating: true, name: 'openkit.record_knowledge_conflict' },
  { mutating: true, name: 'openkit.resolve_knowledge_conflict' },
  { mutating: false, name: 'openkit.list_knowledge_conflicts' },
  { mutating: true, name: 'openkit.retrieve_knowledge' },
  { mutating: false, name: 'openkit.read_knowledge_indexes' },
  { mutating: false, name: 'openkit.prepare_knowledge_context' },
  { mutating: false, name: 'openkit.read_knowledge_context_package_trace' },
  { mutating: false, name: 'openkit.read_knowledge_context_package_materialization' },
  { mutating: true, name: 'openkit.materialize_knowledge_context_package' },
  { mutating: true, name: 'openkit.draft_knowledge_proposal' },
  { mutating: false, name: 'openkit.suggest_knowledge_repairs' },
  { mutating: false, name: 'openkit.check_knowledge_health' },
  { mutating: false, name: 'openkit.list_interrupted_workers' },
  { mutating: true, name: 'openkit.clear_interrupted_worker_checkpoint' },
  { mutating: true, name: 'openkit.retry_interrupted_worker_checkpoint' },
  { mutating: true, name: 'openkit.retry_scheduler_admission' },
  { mutating: true, name: 'openkit.cancel_scheduler_admission' },
  { mutating: false, name: 'openkit.read_scheduler_admissions' },
  { mutating: false, name: 'openkit.list_recovery_pending_user_turns' },
  { mutating: true, name: 'openkit.cancel_recovery_pending_user_turn' },
  { mutating: true, name: 'openkit.edit_recovery_pending_user_turn' },
  { mutating: true, name: 'openkit.convert_recovery_pending_user_turn_to_follow_up' },
  { mutating: true, name: 'openkit.promote_recovery_pending_user_turn_to_interrupt' },
  { mutating: false, name: 'openkit.list_workspaces' },
  { mutating: true, name: 'openkit.create_workspace' },
  { mutating: true, name: 'openkit.update_workspace' },
  { mutating: false, name: 'openkit.list_automations' },
  { mutating: true, name: 'openkit.create_automation' },
  { mutating: true, name: 'openkit.update_automation' },
  { mutating: true, name: 'openkit.delete_automation' },
  { mutating: false, name: 'openkit.read_workspace_resources' },
  { mutating: false, name: 'openkit.list_runtime_config_files' },
  { mutating: false, name: 'openkit.read_runtime_config_file' },
  { mutating: false, name: 'openkit.validate_runtime_config' },
  { mutating: true, name: 'openkit.update_runtime_config_file' },
  { mutating: true, name: 'openkit.reload_runtime_config' },
  { mutating: true, name: 'openkit.restart_runtime_config_stale_session' },
  { mutating: true, name: 'openkit.link_repository' },
  { mutating: false, name: 'openkit.read_repositories' },
  { mutating: false, name: 'openkit.read_git_push_records' },
  { mutating: true, name: 'openkit.request_git_push_approval' },
  { mutating: true, name: 'openkit.execute_git_push' },
  { mutating: true, name: 'openkit.create_thread' },
  { mutating: false, name: 'openkit.read_thread' },
  { mutating: true, name: 'openkit.start_chat' },
  { mutating: true, name: 'openkit.start_task' },
  { mutating: true, name: 'openkit.start_goal' },
  { mutating: false, name: 'openkit.read_goal' },
  { mutating: true, name: 'openkit.draft_goal_plan' },
  { mutating: true, name: 'openkit.approve_goal_plan' },
  { mutating: true, name: 'openkit.revise_goal_plan' },
  { mutating: true, name: 'openkit.step_goal' },
  { mutating: true, name: 'openkit.submit_steering' },
  { mutating: false, name: 'openkit.read_action_center' },
  { mutating: true, name: 'openkit.resolve_action_center_item' },
  { mutating: false, name: 'openkit.read_workspace_reviews' },
  { mutating: false, name: 'openkit.read_workspace_sync_records' },
  { mutating: false, name: 'openkit.read_workspace_apply_results' },
  { mutating: false, name: 'openkit.read_agent_environment_package_snapshots' },
  { mutating: false, name: 'openkit.read_artifact' },
  { mutating: false, name: 'openkit.create_evidence_bundle' },
] as const;

const promptNames = [
  'operate_openkit',
  'run_goal_mode_step',
  'self_improve_openkit',
  'review_openkit_goal_result',
  'write_openkit_change_record',
] as const;

const optionalRequestIdSchema = z.object({ requestId: RequestIdSchema.optional() });
const workspaceSchema = z.object({ workspaceId: z.string().min(1) });
const threadSchema = workspaceSchema.extend({ threadId: z.string().min(1) });
const workspaceKindSchema = z.enum([
  'code',
  'content',
  'personal-ops',
  'research',
  'operations',
  'general',
]);
const runtimeConfigFileKindSchema = z.enum([
  'server',
  'provider',
  'agent',
  'workspace',
  'data-source',
]);
const runtimeConfigReloadModeSchema = z.enum(['safe', 'strict']);
const consumeBootstrapTokenToolSchema = ConsumeOpenKitBootstrapTokenRequestSchema.extend({
  storeCredential: z.boolean().default(false),
});
const tokenIdSchema = z.object({ tokenId: z.string().min(1) });
const automationIdSchema = z.object({ automationId: z.string().min(1) });

const toolSchemas = {
  'openkit.consume_bootstrap_token': consumeBootstrapTokenToolSchema,
  'openkit.list_openkit_access_tokens': z.object({}),
  'openkit.create_openkit_access_token': CreateOpenKitAccessTokenRequestSchema,
  'openkit.revoke_openkit_access_token': tokenIdSchema,
  'openkit.rotate_openkit_access_token': RotateOpenKitAccessTokenRequestSchema.merge(tokenIdSchema),
  'openkit.read_vault_admin_status': z.object({}),
  'openkit.unlock_vault_admin_backend': VaultAdminUnlockRequestSchema,
  'openkit.lock_vault_admin_backend': z.object({}),
  'openkit.bootstrap_codex_auth_json_vault_reference':
    VaultAdminBootstrapCodexAuthJsonRequestSchema,
  'openkit.list_automations': z.object({}),
  'openkit.create_automation': CreateAutomationRequestSchema,
  'openkit.update_automation': UpdateAutomationRequestSchema.merge(automationIdSchema),
  'openkit.delete_automation': automationIdSchema,
  'openkit.answer_knowledge': workspaceSchema.extend({
    limit: z.number().int().positive().max(10).optional(),
    query: z.string().min(1),
  }),
  'openkit.register_knowledge_source': workspaceSchema.merge(optionalRequestIdSchema).extend({
    content: z.string().min(1),
    kind: z.enum(['upload', 'url', 'document', 'transcript', 'code']),
    originatingFileId: z.string().min(1).optional(),
    originatingThreadId: z.string().min(1).optional(),
    originatingTurnId: z.string().min(1).optional(),
    title: z.string().min(1),
    uri: z.string().min(1).optional(),
  }),
  'openkit.list_knowledge_sources': workspaceSchema,
  'openkit.read_knowledge_source': workspaceSchema.extend({ sourceId: z.string().min(1) }),
  'openkit.record_knowledge_observation': workspaceSchema.merge(optionalRequestIdSchema).extend({
    confidence: z.number().min(0).max(1).optional(),
    freshness: z.enum(['current', 'stale', 'unknown']).optional(),
    kind: z.enum(['retrieval', 'source', 'maintenance', 'agent', 'user-feedback']),
    observedAt: z.string().min(1).optional(),
    producer: z.string().min(1),
    scope: z.string().min(1).optional(),
    sourceReferences: z.array(z.string().min(1)).optional(),
    status: z.enum(['retained', 'promoted', 'expired', 'archived']).optional(),
    summary: z.string().min(1),
  }),
  'openkit.list_knowledge_observations': workspaceSchema,
  'openkit.record_knowledge_claim': workspaceSchema.merge(optionalRequestIdSchema).extend({
    confidence: z.number().min(0).max(1).optional(),
    conflictStatus: z
      .enum(['none', 'conflicting', 'weak_evidence', 'stale', 'superseded', 'partially_superseded'])
      .optional(),
    freshness: z.enum(['current', 'stale', 'unknown']).optional(),
    producer: z.string().min(1),
    reviewState: z.enum(['needs-review', 'accepted', 'rejected', 'deferred']).optional(),
    scope: z.string().min(1).optional(),
    sourceReferences: z.array(z.string().min(1)).optional(),
    statement: z.string().min(1),
  }),
  'openkit.list_knowledge_claims': workspaceSchema,
  'openkit.promote_knowledge_claim': workspaceSchema.merge(optionalRequestIdSchema).extend({
    claimId: z.string().min(1),
  }),
  'openkit.record_knowledge_conflict': workspaceSchema.merge(optionalRequestIdSchema).extend({
    producer: z.string().min(1),
    sourceReferences: z.array(z.string().min(1)).optional(),
    status: z
      .enum([
        'conflicting',
        'needs_review',
        'weak_evidence',
        'stale',
        'superseded',
        'partially_superseded',
      ])
      .optional(),
    subjectReferences: z.array(z.string().min(1)).min(1),
    suggestedActions: z.array(z.string().min(1)).optional(),
    summary: z.string().min(1),
  }),
  'openkit.resolve_knowledge_conflict': workspaceSchema.merge(optionalRequestIdSchema).extend({
    conflictId: z.string().min(1),
    resolution: z.string().min(1),
    resolvedBy: z.string().min(1),
    status: z.enum(['resolved', 'superseded', 'partially_superseded']).optional(),
  }),
  'openkit.list_knowledge_conflicts': workspaceSchema,
  'openkit.read_knowledge_indexes': workspaceSchema,
  'openkit.retrieve_knowledge': workspaceSchema.extend({
    limit: z.number().int().positive().max(20).optional(),
    pinnedConceptIds: z.array(z.string().min(1)).optional(),
    query: z.string().min(1),
  }),
  'openkit.prepare_knowledge_context': workspaceSchema.extend({
    artifactIds: z.array(z.string().min(1)).max(20).optional(),
    limit: z.number().int().positive().max(10).optional(),
    query: z.string().min(1),
    workspaceFiles: z
      .array(z.object({ path: WorkspaceRelativePathSchema }))
      .max(20)
      .optional(),
    workspaceRootFiles: z
      .array(
        z.object({
          rootId: z
            .string()
            .min(1)
            .regex(/^[A-Za-z0-9._-]+$/),
          path: WorkspaceRelativePathSchema,
        })
      )
      .max(20)
      .optional(),
  }),
  'openkit.read_knowledge_context_package_trace': workspaceSchema.extend({
    contextPackageId: z.string().min(1),
  }),
  'openkit.read_knowledge_context_package_materialization': workspaceSchema.extend({
    contextPackageId: z.string().min(1),
  }),
  'openkit.materialize_knowledge_context_package': workspaceSchema.extend({
    contextPackageId: z.string().min(1),
  }),
  'openkit.draft_knowledge_proposal': workspaceSchema.merge(optionalRequestIdSchema).extend({
    confidence: z.number().min(0).max(1).optional(),
    sourceReferences: z.array(z.string().min(1)).optional(),
    summary: z.string().min(1),
    title: z.string().min(1),
  }),
  'openkit.suggest_knowledge_repairs': workspaceSchema.extend({
    limit: z.number().int().positive().max(20).optional(),
  }),
  'openkit.check_knowledge_health': workspaceSchema.extend({
    limit: z.number().int().positive().max(20).optional(),
  }),
  'openkit.approve_goal_plan': threadSchema
    .merge(optionalRequestIdSchema)
    .extend({ plan: z.unknown(), planItemId: z.string().min(1) }),
  'openkit.create_evidence_bundle': workspaceSchema.extend({
    goalId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
  }),
  'openkit.create_thread': workspaceSchema
    .merge(optionalRequestIdSchema)
    .extend({ initialMessage: z.string().min(1).optional(), title: z.string().min(1) }),
  'openkit.create_workspace': optionalRequestIdSchema.extend({ name: z.string().min(1) }),
  'openkit.draft_goal_plan': threadSchema.merge(optionalRequestIdSchema),
  'openkit.execute_git_push': workspaceSchema.merge(optionalRequestIdSchema).extend({
    approvalRequestId: z.string().min(1),
    repositoryResourceId: z.string().min(1),
  }),
  'openkit.create_data_root_backup': optionalRequestIdSchema,
  'openkit.verify_data_root_backup': z.object({
    backupId: z.string().min(1),
  }),
  'openkit.export_workspace': workspaceSchema.merge(optionalRequestIdSchema),
  'openkit.dry_run_workspace_import': z.object({
    sourceWorkspaceId: z.string().min(1),
    exportId: z.string().min(1),
  }),
  'openkit.import_workspace': z
    .object({
      sourceWorkspaceId: z.string().min(1),
      exportId: z.string().min(1),
    })
    .merge(optionalRequestIdSchema),
  'openkit.read_workspace_vault_references': workspaceSchema,
  'openkit.read_workspace_vault_grants': workspaceSchema,
  'openkit.read_workspace_injection_plans': workspaceSchema,
  'openkit.read_workspace_injection_receipts': workspaceSchema,
  'openkit.read_workspace_vault_use_records': workspaceSchema,
  'openkit.read_vault_use_records': z.object({}),
  'openkit.rebind_workspace_vault_reference': workspaceSchema
    .merge(optionalRequestIdSchema)
    .extend({
      materialBase64: z.string().min(1),
      referenceId: z.string().min(1),
    }),
  'openkit.read_capability_usage': workspaceSchema,
  'openkit.read_workspace_audit_events': workspaceSchema,
  'openkit.read_server_audit_events': z.object({}),
  'openkit.read_workspace_permission_decisions': workspaceSchema,
  'openkit.read_server_permission_decisions': z.object({}),
  'openkit.link_repository': workspaceSchema
    .merge(optionalRequestIdSchema)
    .extend({ displayName: z.string().min(1), localPath: z.string().min(1) }),
  'openkit.list_interrupted_workers': z.object({}),
  'openkit.clear_interrupted_worker_checkpoint': workspaceSchema.extend({
    terminalStage: z.enum(['completed', 'failed', 'aborted']),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
  }),
  'openkit.retry_interrupted_worker_checkpoint': workspaceSchema.extend({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
  }),
  'openkit.retry_scheduler_admission': workspaceSchema.extend({
    queueEntryId: z.string().min(1),
  }),
  'openkit.cancel_scheduler_admission': workspaceSchema.extend({
    queueEntryId: z.string().min(1),
  }),
  'openkit.read_scheduler_admissions': workspaceSchema,
  'openkit.list_recovery_pending_user_turns': workspaceSchema.extend({
    threadId: z.string().min(1),
  }),
  'openkit.cancel_recovery_pending_user_turn': workspaceSchema.extend({
    requestId: z.string().min(1),
    threadId: z.string().min(1),
  }),
  'openkit.edit_recovery_pending_user_turn': workspaceSchema.extend({
    requestId: z.string().min(1),
    text: z.string().min(1).max(20_000),
    threadId: z.string().min(1),
  }),
  'openkit.convert_recovery_pending_user_turn_to_follow_up': workspaceSchema.extend({
    requestId: z.string().min(1),
    threadId: z.string().min(1),
  }),
  'openkit.promote_recovery_pending_user_turn_to_interrupt': workspaceSchema.extend({
    requestId: z.string().min(1),
    threadId: z.string().min(1),
  }),
  'openkit.list_runtime_config_files': z.object({}),
  'openkit.list_workspaces': z.object({}),
  'openkit.read_action_center': workspaceSchema.extend({
    kind: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
  }),
  'openkit.read_artifact': workspaceSchema.extend({
    artifactId: z.string().min(1),
    threadId: z.string().min(1).optional(),
  }),
  'openkit.read_goal': threadSchema,
  'openkit.read_git_push_records': workspaceSchema.extend({
    pushRecordId: z.string().min(1).optional(),
  }),
  'openkit.request_git_push_approval': threadSchema.merge(optionalRequestIdSchema).extend({
    commitIds: z.array(z.string().min(1)).min(1),
    repositoryResourceId: z.string().min(1),
    sourceRef: z.string().min(1),
    targetBranch: z.string().min(1),
    turnId: z.string().min(1),
  }),
  'openkit.read_repositories': workspaceSchema,
  'openkit.read_runtime_config_file': z.object({ id: z.string().min(1) }),
  'openkit.read_status': z.object({
    threadId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
  }),
  'openkit.read_runtime_diagnostics': z.object({}),
  'openkit.read_storage_layout_report': z.object({}),
  'openkit.read_thread': threadSchema,
  'openkit.read_workspace_resources': workspaceSchema,
  'openkit.read_workspace_reviews': workspaceSchema.extend({
    reviewId: z.string().min(1).optional(),
  }),
  'openkit.read_workspace_sync_records': workspaceSchema.extend({
    kind: z
      .enum([
        'input-snapshots',
        'materialization-records',
        'backend-handles',
        'output-manifests',
        'change-sets',
        'apply-plans',
        'reconciliation-records',
        'quarantine-records',
        'sync-evidence-bundles',
        'staged-reviews',
      ])
      .optional(),
  }),
  'openkit.read_workspace_apply_results': workspaceSchema.extend({
    applyResultId: z.string().min(1).optional(),
  }),
  'openkit.read_agent_environment_package_snapshots': workspaceSchema.extend({
    snapshotId: z.string().min(1).optional(),
  }),
  'openkit.revise_goal_plan': threadSchema
    .merge(optionalRequestIdSchema)
    .extend({ revision: z.string().min(1) }),
  'openkit.resolve_action_center_item': workspaceSchema.merge(optionalRequestIdSchema).extend({
    actionId: z.string().min(1),
    comment: z.string().min(1).optional(),
    decision: z.string().min(1),
    rowId: z.string().min(1),
  }),
  'openkit.start_chat': threadSchema.merge(optionalRequestIdSchema).extend({
    input: z.string().min(1),
    model: z.string().min(1).optional(),
    providerId: z.string().min(1).optional(),
  }),
  'openkit.start_task': threadSchema.merge(optionalRequestIdSchema).extend({
    input: z.string().min(1),
    modelId: z.string().min(1).optional(),
  }),
  'openkit.start_goal': threadSchema
    .merge(optionalRequestIdSchema)
    .extend({ objective: z.string().min(1) }),
  'openkit.start_nanocore': z.object({
    dataRoot: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
    workspaceRoot: z.string().min(1).optional(),
  }),
  'openkit.step_goal': threadSchema.merge(optionalRequestIdSchema).extend({
    followUpDrainMode: z.literal('one_at_a_time').optional(),
    reviewPolicyOverride: GoalStepReviewPolicyOverrideSchema.optional(),
  }),
  'openkit.submit_steering': threadSchema
    .merge(optionalRequestIdSchema)
    .extend({ message: z.string().min(1) }),
  'openkit.reload_runtime_config': z.object({
    dryRun: z.boolean().optional(),
    mode: runtimeConfigReloadModeSchema.optional(),
  }),
  'openkit.restart_runtime_config_stale_session': workspaceSchema.extend({
    sessionId: z.string().min(1),
  }),
  'openkit.update_runtime_config_file': z.object({
    content: z.string().optional(),
    expectedRevision: z.string().min(1).nullable().optional(),
    id: z.string().min(1),
    kind: runtimeConfigFileKindSchema,
  }),
  'openkit.update_workspace': workspaceSchema.merge(optionalRequestIdSchema).extend({
    defaults: z
      .object({
        defaultAgentId: z.string().min(1).nullable().optional(),
        defaultModelId: z.string().min(1).nullable().optional(),
        defaultSkillIds: z.array(z.string().min(1)).optional(),
      })
      .optional(),
    kind: workspaceKindSchema.optional(),
    name: z.string().min(1).optional(),
    status: z.enum(['active', 'archived']).optional(),
  }),
  'openkit.validate_runtime_config': z.object({
    content: z.string(),
    id: z.string().min(1),
    mode: runtimeConfigReloadModeSchema.optional(),
  }),
} satisfies Record<OpenKitToolName, z.ZodType>;

const resources: OpenKitResourceDefinition[] = [
  { description: 'OpenKit AI Interface and NanoCore readiness.', uri: 'openkit://status' },
  {
    description: 'Public NanoCore runtime diagnostics, runtime config status, and capabilities.',
    uri: 'openkit://runtime/diagnostics',
  },
  {
    description: 'Read-only NanoCore storage layout and quarantine report.',
    uri: 'openkit://storage/layout-report',
  },
  {
    description: 'Workspaces visible to the current NanoCore session.',
    uri: 'openkit://workspaces',
  },
  {
    description: 'Runtime config file summaries exposed by NanoCore Settings routes.',
    uri: 'openkit://runtime-config/files',
  },
  {
    description: 'Runtime config source file content by file id.',
    uri: 'openkit://runtime-config/files/{fileId}',
  },
  {
    description: 'Runtime config JSON Schema catalog entries.',
    uri: 'openkit://runtime-config/schemas',
  },
  {
    description: 'Workspace repository resources and diagnostics.',
    uri: 'openkit://workspaces/{workspaceId}/repositories',
  },
  {
    description: 'Durable Git push records for one workspace.',
    uri: 'openkit://workspaces/{workspaceId}/repositories/git-push-records',
  },
  {
    description: 'Workspace audit event ledger.',
    uri: 'openkit://workspaces/{workspaceId}/audit/events',
  },
  {
    description: 'Workspace evidence bundle ledger.',
    uri: 'openkit://workspaces/{workspaceId}/evidence-bundles',
  },
  {
    description: 'Workspace runtime evidence ledger.',
    uri: 'openkit://workspaces/{workspaceId}/runtime-evidence',
  },
  {
    description: 'Server audit event ledger.',
    uri: 'openkit://audit/events',
  },
  {
    description: 'Workspace permission decision ledger.',
    uri: 'openkit://workspaces/{workspaceId}/permission-decisions',
  },
  {
    description: 'Server permission decision ledger.',
    uri: 'openkit://permission-decisions',
  },
  {
    description: 'Redacted workspace vault references.',
    uri: 'openkit://workspaces/{workspaceId}/vault/references',
  },
  {
    description: 'Non-secret workspace vault grants.',
    uri: 'openkit://workspaces/{workspaceId}/vault/grants',
  },
  {
    description: 'Non-secret workspace injection plans.',
    uri: 'openkit://workspaces/{workspaceId}/vault/injection-plans',
  },
  {
    description: 'Non-secret workspace injection receipts.',
    uri: 'openkit://workspaces/{workspaceId}/vault/injection-receipts',
  },
  {
    description: 'Redacted workspace vault use records.',
    uri: 'openkit://workspaces/{workspaceId}/vault/use-records',
  },
  {
    description: 'Redacted server vault use records.',
    uri: 'openkit://vault/use-records',
  },
  {
    description: 'Workspace resource bundle including knowledge, Skills, agents, and models.',
    uri: 'openkit://workspaces/{workspaceId}/resources',
  },
  {
    description: 'Unified Human Attention Action Center rows.',
    uri: 'openkit://workspaces/{workspaceId}/action-center',
  },
  {
    description: 'Workspace synchronization review records and change sets.',
    uri: 'openkit://workspaces/{workspaceId}/workspace-sync/reviews',
  },
  {
    description: 'Durable workspace synchronization product records.',
    uri: 'openkit://workspaces/{workspaceId}/workspace-sync/records',
  },
  {
    description: 'Durable workspace synchronization apply results.',
    uri: 'openkit://workspaces/{workspaceId}/workspace-sync/apply-results',
  },
  {
    description: 'Workspace-filtered scheduler admissions with queue position and denial reasons.',
    uri: 'openkit://workspaces/{workspaceId}/scheduler/admissions',
  },
  {
    description: 'Durable Agent Environment Package snapshots for one workspace.',
    uri: 'openkit://workspaces/{workspaceId}/agent-environment/snapshots',
  },
  {
    description: 'Thread summary and recent work items.',
    uri: 'openkit://workspaces/{workspaceId}/threads/{threadId}',
  },
  {
    description: 'Thread Goal Mode summary.',
    uri: 'openkit://workspaces/{workspaceId}/threads/{threadId}/goal',
  },
  {
    description: 'Thread durable item stream snapshot.',
    uri: 'openkit://workspaces/{workspaceId}/threads/{threadId}/items',
  },
  {
    description: 'Artifact metadata and content.',
    uri: 'openkit://workspaces/{workspaceId}/artifacts/{artifactId}',
  },
];

const prompts: OpenKitPromptDefinition[] = [
  { description: 'Connect to OpenKit and explain current state.', name: 'operate_openkit' },
  {
    description: 'Run exactly one Goal Mode step after human plan approval.',
    name: 'run_goal_mode_step',
  },
  {
    description: 'Use OpenKit to improve OpenKit through a bounded review loop.',
    name: 'self_improve_openkit',
  },
  {
    description: 'Review one Goal Mode result, artifact, or Action Center row.',
    name: 'review_openkit_goal_result',
  },
  {
    description: 'Decide whether an OpenKit change needs a durable change record.',
    name: 'write_openkit_change_record',
  },
];

/** Creates the OpenKit AI Interface registry used by MCP transports. */
export function createOpenKitAiInterface(
  options: CreateOpenKitAiInterfaceOptions
): OpenKitAiInterfaceRegistry {
  const tools = toolCatalog.map(({ mutating, name }) => ({
    description: toolDescription(name),
    inputSchema: toolSchemas[name],
    mutating,
    name,
  }));

  return {
    callTool: (name, input) => callTool(options, name, input),
    getPrompt: (name, input) => renderPrompt(name, input),
    listPrompts: () => [...prompts],
    listResources: () => [...resources],
    listTools: () => [...tools],
    readResource: (uri) => readResource(options.nanoCore, uri),
  };
}

/** Reads one OpenKit resource URI through the matching NanoCore facade method. */
async function readResource(
  nanoCore: OpenKitNanoCoreClient,
  uri: string
): Promise<OpenKitResourceResult> {
  const raw = await readResourcePayload(nanoCore, uri);
  return {
    mimeType: 'application/json',
    text: JSON.stringify(redactPublicValue(raw), null, 2),
    uri,
  };
}

/** Resolves a resource URI to a public NanoCore payload. */
async function readResourcePayload(nanoCore: OpenKitNanoCoreClient, uri: string): Promise<unknown> {
  if (uri === 'openkit://status') {
    return nanoCore.readStatus({});
  }

  if (uri === 'openkit://runtime/diagnostics') {
    return nanoCore.readRuntimeDiagnostics();
  }

  if (uri === 'openkit://storage/layout-report') {
    return nanoCore.readStorageLayoutReport();
  }

  if (uri === 'openkit://workspaces') {
    return nanoCore.listWorkspaces();
  }

  if (uri === 'openkit://runtime-config/files') {
    return nanoCore.listRuntimeConfigFiles();
  }

  if (uri === 'openkit://runtime-config/schemas') {
    return nanoCore.readRuntimeConfigSchemas();
  }

  const runtimeConfigFile = matchUri(uri, /^openkit:\/\/runtime-config\/files\/(.+)$/);
  if (runtimeConfigFile) {
    return nanoCore.readRuntimeConfigFile({ id: requiredUriPart(runtimeConfigFile, 0) });
  }

  const repositories = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/repositories$/);
  if (repositories) {
    return nanoCore.readRepositories({ workspaceId: requiredUriPart(repositories, 0) });
  }

  const gitPushRecords = matchUri(
    uri,
    /^openkit:\/\/workspaces\/([^/]+)\/repositories\/git-push-records$/
  );
  if (gitPushRecords) {
    return nanoCore.readGitPushRecords({ workspaceId: requiredUriPart(gitPushRecords, 0) });
  }

  const auditEvents = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/audit\/events$/);
  if (auditEvents) {
    return nanoCore.readWorkspaceAuditEvents({ workspaceId: requiredUriPart(auditEvents, 0) });
  }

  const evidenceBundles = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/evidence-bundles$/);
  if (evidenceBundles) {
    return nanoCore.readWorkspaceEvidenceBundles({
      workspaceId: requiredUriPart(evidenceBundles, 0),
    });
  }

  const runtimeEvidence = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/runtime-evidence$/);
  if (runtimeEvidence) {
    return nanoCore.readWorkspaceRuntimeEvidence({
      workspaceId: requiredUriPart(runtimeEvidence, 0),
    });
  }

  if (uri === 'openkit://audit/events') {
    return nanoCore.readServerAuditEvents();
  }

  const permissionDecisions = matchUri(
    uri,
    /^openkit:\/\/workspaces\/([^/]+)\/permission-decisions$/
  );
  if (permissionDecisions) {
    return nanoCore.readWorkspacePermissionDecisions({
      workspaceId: requiredUriPart(permissionDecisions, 0),
    });
  }

  if (uri === 'openkit://permission-decisions') {
    return nanoCore.readServerPermissionDecisions();
  }

  const vaultReferences = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/vault\/references$/);
  if (vaultReferences) {
    return nanoCore.readWorkspaceVaultReferences({
      workspaceId: requiredUriPart(vaultReferences, 0),
    });
  }

  const vaultGrants = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/vault\/grants$/);
  if (vaultGrants) {
    return nanoCore.readWorkspaceVaultGrants({
      workspaceId: requiredUriPart(vaultGrants, 0),
    });
  }

  const injectionPlans = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/vault\/injection-plans$/);
  if (injectionPlans) {
    return nanoCore.readWorkspaceInjectionPlans({
      workspaceId: requiredUriPart(injectionPlans, 0),
    });
  }

  const injectionReceipts = matchUri(
    uri,
    /^openkit:\/\/workspaces\/([^/]+)\/vault\/injection-receipts$/
  );
  if (injectionReceipts) {
    return nanoCore.readWorkspaceInjectionReceipts({
      workspaceId: requiredUriPart(injectionReceipts, 0),
    });
  }

  const vaultUseRecords = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/vault\/use-records$/);
  if (vaultUseRecords) {
    return nanoCore.readWorkspaceVaultUseRecords({
      workspaceId: requiredUriPart(vaultUseRecords, 0),
    });
  }

  if (uri === 'openkit://vault/use-records') {
    return nanoCore.readServerVaultUseRecords();
  }

  const workspaceResources = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/resources$/);
  if (workspaceResources) {
    return nanoCore.readWorkspaceResources({ workspaceId: requiredUriPart(workspaceResources, 0) });
  }

  const actionCenter = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/action-center$/);
  if (actionCenter) {
    return nanoCore.readActionCenter({ workspaceId: requiredUriPart(actionCenter, 0) });
  }

  const workspaceReviews = matchUri(
    uri,
    /^openkit:\/\/workspaces\/([^/]+)\/workspace-sync\/reviews$/
  );
  if (workspaceReviews) {
    return nanoCore.readWorkspaceReviews({ workspaceId: requiredUriPart(workspaceReviews, 0) });
  }

  const workspaceSyncRecords = matchUri(
    uri,
    /^openkit:\/\/workspaces\/([^/]+)\/workspace-sync\/records$/
  );
  if (workspaceSyncRecords) {
    return nanoCore.readWorkspaceSyncRecords({
      workspaceId: requiredUriPart(workspaceSyncRecords, 0),
    });
  }

  const workspaceApplyResults = matchUri(
    uri,
    /^openkit:\/\/workspaces\/([^/]+)\/workspace-sync\/apply-results$/
  );
  if (workspaceApplyResults) {
    return nanoCore.readWorkspaceApplyResults({
      workspaceId: requiredUriPart(workspaceApplyResults, 0),
    });
  }

  const schedulerAdmissions = matchUri(
    uri,
    /^openkit:\/\/workspaces\/([^/]+)\/scheduler\/admissions$/
  );
  if (schedulerAdmissions) {
    return nanoCore.readSchedulerAdmissions({
      workspaceId: requiredUriPart(schedulerAdmissions, 0),
    });
  }

  const agentEnvironmentPackageSnapshots = matchUri(
    uri,
    /^openkit:\/\/workspaces\/([^/]+)\/agent-environment\/snapshots$/
  );
  if (agentEnvironmentPackageSnapshots) {
    return nanoCore.readAgentEnvironmentPackageSnapshots({
      workspaceId: requiredUriPart(agentEnvironmentPackageSnapshots, 0),
    });
  }

  const thread = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/threads\/([^/]+)$/);
  if (thread) {
    return nanoCore.readThread({
      threadId: requiredUriPart(thread, 1),
      workspaceId: requiredUriPart(thread, 0),
    });
  }

  const goal = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/threads\/([^/]+)\/goal$/);
  if (goal) {
    return nanoCore.readGoal({
      threadId: requiredUriPart(goal, 1),
      workspaceId: requiredUriPart(goal, 0),
    });
  }

  const items = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/threads\/([^/]+)\/items$/);
  if (items) {
    return nanoCore.readThread({
      threadId: requiredUriPart(items, 1),
      workspaceId: requiredUriPart(items, 0),
    });
  }

  const artifact = matchUri(uri, /^openkit:\/\/workspaces\/([^/]+)\/artifacts\/([^/]+)$/);
  if (artifact) {
    return nanoCore.readArtifact({
      artifactId: requiredUriPart(artifact, 1),
      workspaceId: requiredUriPart(artifact, 0),
    });
  }

  throw new Error(`Unsupported OpenKit resource URI: ${uri}`);
}

/** Matches and decodes URI capture groups. */
function matchUri(uri: string, pattern: RegExp): string[] | null {
  const match = pattern.exec(uri);
  if (!match) {
    return null;
  }

  return match.slice(1).map((part) => decodeURIComponent(part));
}

/** Returns one required URI capture group. */
function requiredUriPart(parts: readonly string[], index: number): string {
  const part = parts[index];
  if (!part) {
    throw new Error(`Malformed OpenKit resource URI: missing part ${index}.`);
  }

  return part;
}

/** Calls one OpenKit tool after validating input and normalizing the response. */
async function callTool(
  options: CreateOpenKitAiInterfaceOptions,
  name: OpenKitToolName,
  input: unknown
): Promise<OpenKitToolResult> {
  const nanoCore = options.nanoCore;
  switch (name) {
    case 'openkit.read_status': {
      const parsed = toolSchemas['openkit.read_status'].parse(input);
      return readResponse(await nanoCore.readStatus(parsed), 'Status read.', parsed);
    }
    case 'openkit.read_runtime_diagnostics': {
      const parsed = toolSchemas['openkit.read_runtime_diagnostics'].parse(input);
      return readResponse(
        await nanoCore.readRuntimeDiagnostics(),
        'Runtime diagnostics read.',
        parsed
      );
    }
    case 'openkit.read_storage_layout_report': {
      const parsed = toolSchemas['openkit.read_storage_layout_report'].parse(input);
      return readResponse(
        await nanoCore.readStorageLayoutReport(),
        'Storage layout report read.',
        parsed
      );
    }
    case 'openkit.consume_bootstrap_token': {
      const parsed = toolSchemas['openkit.consume_bootstrap_token'].parse(input);
      const { storeCredential, ...request } = parsed;
      const result = ConsumeOpenKitBootstrapTokenResponseSchema.parse(
        await nanoCore.consumeBootstrapToken(request)
      );
      let credentialStorageBackend: NanoCoreCredentialStorageBackend | undefined;

      if (storeCredential) {
        if (!options.credentialStore?.writeNanoCoreToken || !options.nanoCoreBaseUrl) {
          throw new Error('NanoCore credential storage is not configured.');
        }
        credentialStorageBackend = options.credentialStore.writeNanoCoreToken({
          baseUrl: options.nanoCoreBaseUrl,
          token: result.token,
        });
      }
      return mutationResponse(
        storeCredential
          ? {
              ...result,
              credentialStorageBackend,
              ...(credentialStorageBackend === 'encrypted-file'
                ? { credentialStorageWarning: ENCRYPTED_FALLBACK_CREDENTIAL_STORAGE_WARNING }
                : {}),
            }
          : result,
        'Server bootstrap token consumed.',
        {},
        [request.token]
      );
    }
    case 'openkit.list_openkit_access_tokens': {
      const parsed = toolSchemas['openkit.list_openkit_access_tokens'].parse(input);
      return readResponse(
        await nanoCore.listOpenKitAccessTokens(),
        'OpenKit access tokens read.',
        parsed
      );
    }
    case 'openkit.create_openkit_access_token': {
      const request = toolSchemas['openkit.create_openkit_access_token'].parse(input);
      return mutationResponse(
        await nanoCore.createOpenKitAccessToken(request),
        'OpenKit access token issued.',
        {}
      );
    }
    case 'openkit.revoke_openkit_access_token': {
      const parsed = toolSchemas['openkit.revoke_openkit_access_token'].parse(input);
      return mutationResponse(
        await nanoCore.revokeOpenKitAccessToken(parsed),
        'OpenKit access token revoked.',
        {}
      );
    }
    case 'openkit.rotate_openkit_access_token': {
      const parsed = toolSchemas['openkit.rotate_openkit_access_token'].parse(input);
      return mutationResponse(
        await nanoCore.rotateOpenKitAccessToken(parsed),
        'OpenKit access token rotated.',
        {}
      );
    }
    case 'openkit.read_vault_admin_status': {
      const parsed = toolSchemas['openkit.read_vault_admin_status'].parse(input);
      return readResponse(
        await nanoCore.readVaultAdminStatus(),
        'Vault admin status read.',
        parsed
      );
    }
    case 'openkit.unlock_vault_admin_backend': {
      const parsed = toolSchemas['openkit.unlock_vault_admin_backend'].parse(input);
      return mutationResponse(
        await nanoCore.unlockVaultAdminBackend(parsed),
        'Vault backend unlocked.',
        {},
        [parsed.masterKeyBase64]
      );
    }
    case 'openkit.lock_vault_admin_backend': {
      const parsed = toolSchemas['openkit.lock_vault_admin_backend'].parse(input);
      return mutationResponse(
        await nanoCore.lockVaultAdminBackend(),
        'Vault backend locked.',
        parsed
      );
    }
    case 'openkit.bootstrap_codex_auth_json_vault_reference': {
      const parsed = toolSchemas['openkit.bootstrap_codex_auth_json_vault_reference'].parse(input);
      return mutationResponse(
        await nanoCore.bootstrapCodexAuthJsonVaultReference(parsed),
        'Codex auth JSON vault reference bootstrapped.',
        {},
        [parsed.authJsonBase64]
      );
    }
    case 'openkit.create_data_root_backup': {
      const request = withGeneratedRequestId(
        toolSchemas['openkit.create_data_root_backup'].parse(input)
      );
      return mutationResponse(
        await nanoCore.createDataRootBackup(),
        'Data-root backup created.',
        request
      );
    }
    case 'openkit.verify_data_root_backup': {
      const parsed = toolSchemas['openkit.verify_data_root_backup'].parse(input);
      return readResponse(
        await nanoCore.verifyDataRootBackup(parsed),
        'Data-root backup verified.',
        {}
      );
    }
    case 'openkit.export_workspace': {
      const request = withGeneratedRequestId(toolSchemas['openkit.export_workspace'].parse(input));
      return mutationResponse(
        await nanoCore.exportWorkspace(request),
        'Workspace export created.',
        request
      );
    }
    case 'openkit.dry_run_workspace_import': {
      const parsed = toolSchemas['openkit.dry_run_workspace_import'].parse(input);
      return readResponse(
        await nanoCore.dryRunWorkspaceImport(parsed),
        'Workspace import dry-run completed.',
        { workspaceId: parsed.sourceWorkspaceId }
      );
    }
    case 'openkit.import_workspace': {
      const request = withGeneratedRequestId(toolSchemas['openkit.import_workspace'].parse(input));
      return mutationResponse(await nanoCore.importWorkspace(request), 'Workspace imported.', {
        requestId: request.requestId,
        workspaceId: request.sourceWorkspaceId,
      });
    }
    case 'openkit.read_workspace_vault_references': {
      const parsed = toolSchemas['openkit.read_workspace_vault_references'].parse(input);
      return readResponse(
        await nanoCore.readWorkspaceVaultReferences(parsed),
        'Workspace vault references read.',
        { workspaceId: parsed.workspaceId }
      );
    }
    case 'openkit.read_workspace_vault_grants': {
      const parsed = toolSchemas['openkit.read_workspace_vault_grants'].parse(input);
      return readResponse(
        await nanoCore.readWorkspaceVaultGrants(parsed),
        'Workspace vault grants read.',
        { workspaceId: parsed.workspaceId }
      );
    }
    case 'openkit.read_workspace_injection_plans': {
      const parsed = toolSchemas['openkit.read_workspace_injection_plans'].parse(input);
      return readResponse(
        await nanoCore.readWorkspaceInjectionPlans(parsed),
        'Workspace injection plans read.',
        { workspaceId: parsed.workspaceId }
      );
    }
    case 'openkit.read_workspace_injection_receipts': {
      const parsed = toolSchemas['openkit.read_workspace_injection_receipts'].parse(input);
      return readResponse(
        await nanoCore.readWorkspaceInjectionReceipts(parsed),
        'Workspace injection receipts read.',
        { workspaceId: parsed.workspaceId }
      );
    }
    case 'openkit.read_workspace_vault_use_records': {
      const parsed = toolSchemas['openkit.read_workspace_vault_use_records'].parse(input);
      return readResponse(
        await nanoCore.readWorkspaceVaultUseRecords(parsed),
        'Workspace vault use records read.',
        { workspaceId: parsed.workspaceId }
      );
    }
    case 'openkit.read_vault_use_records': {
      toolSchemas['openkit.read_vault_use_records'].parse(input);
      return readResponse(
        await nanoCore.readServerVaultUseRecords(),
        'Server vault use records read.',
        {}
      );
    }
    case 'openkit.rebind_workspace_vault_reference': {
      const request = withGeneratedRequestId(
        toolSchemas['openkit.rebind_workspace_vault_reference'].parse(input)
      );
      return mutationResponse(
        await nanoCore.rebindWorkspaceVaultReference(request),
        'Workspace vault reference rebound.',
        { requestId: request.requestId, workspaceId: request.workspaceId },
        [request.materialBase64]
      );
    }
    case 'openkit.read_capability_usage': {
      const parsed = toolSchemas['openkit.read_capability_usage'].parse(input);
      return readResponse(
        await nanoCore.readCapabilityUsage(parsed),
        'Capability usage read.',
        parsed
      );
    }
    case 'openkit.read_workspace_audit_events': {
      const parsed = toolSchemas['openkit.read_workspace_audit_events'].parse(input);
      return readResponse(
        await nanoCore.readWorkspaceAuditEvents(parsed),
        'Workspace audit events read.',
        parsed
      );
    }
    case 'openkit.read_server_audit_events': {
      toolSchemas['openkit.read_server_audit_events'].parse(input);
      return readResponse(await nanoCore.readServerAuditEvents(), 'Server audit events read.', {});
    }
    case 'openkit.read_workspace_permission_decisions': {
      const parsed = toolSchemas['openkit.read_workspace_permission_decisions'].parse(input);
      return readResponse(
        await nanoCore.readWorkspacePermissionDecisions(parsed),
        'Workspace permission decisions read.',
        parsed
      );
    }
    case 'openkit.read_server_permission_decisions': {
      toolSchemas['openkit.read_server_permission_decisions'].parse(input);
      return readResponse(
        await nanoCore.readServerPermissionDecisions(),
        'Server permission decisions read.',
        {}
      );
    }
    case 'openkit.start_nanocore': {
      const parsed = toolSchemas['openkit.start_nanocore'].parse(input);
      return readResponse(await nanoCore.startNanoCore(parsed), 'NanoCore startup checked.', {});
    }
    case 'openkit.answer_knowledge': {
      const parsed = toolSchemas['openkit.answer_knowledge'].parse(input);
      return readResponse(await nanoCore.answerKnowledge(parsed), 'Knowledge answer read.', parsed);
    }
    case 'openkit.register_knowledge_source': {
      const request = withGeneratedRequestId(
        toolSchemas['openkit.register_knowledge_source'].parse(input)
      );
      return mutationResponse(
        await nanoCore.registerKnowledgeSource(request),
        'Knowledge source registered.',
        request
      );
    }
    case 'openkit.list_knowledge_sources': {
      const parsed = toolSchemas['openkit.list_knowledge_sources'].parse(input);
      return readResponse(
        await nanoCore.listKnowledgeSources(parsed),
        'Knowledge sources read.',
        parsed
      );
    }
    case 'openkit.read_knowledge_source': {
      const parsed = toolSchemas['openkit.read_knowledge_source'].parse(input);
      return readResponse(
        await nanoCore.readKnowledgeSource(parsed),
        'Knowledge source read.',
        parsed
      );
    }
    case 'openkit.record_knowledge_observation': {
      const request = withGeneratedRequestId(
        toolSchemas['openkit.record_knowledge_observation'].parse(input)
      );
      return mutationResponse(
        await nanoCore.recordKnowledgeObservation(request),
        'Knowledge observation recorded.',
        request
      );
    }
    case 'openkit.list_knowledge_observations': {
      const parsed = toolSchemas['openkit.list_knowledge_observations'].parse(input);
      return readResponse(
        await nanoCore.listKnowledgeObservations(parsed),
        'Knowledge observations read.',
        parsed
      );
    }
    case 'openkit.record_knowledge_claim': {
      const request = withGeneratedRequestId(
        toolSchemas['openkit.record_knowledge_claim'].parse(input)
      );
      return mutationResponse(
        await nanoCore.recordKnowledgeClaim(request),
        'Knowledge claim recorded.',
        request
      );
    }
    case 'openkit.list_knowledge_claims': {
      const parsed = toolSchemas['openkit.list_knowledge_claims'].parse(input);
      return readResponse(
        await nanoCore.listKnowledgeClaims(parsed),
        'Knowledge claims read.',
        parsed
      );
    }
    case 'openkit.promote_knowledge_claim': {
      const request = withGeneratedRequestId(
        toolSchemas['openkit.promote_knowledge_claim'].parse(input)
      );
      return mutationResponse(
        await nanoCore.promoteKnowledgeClaim(request),
        'Knowledge claim promoted.',
        request
      );
    }
    case 'openkit.record_knowledge_conflict': {
      const request = withGeneratedRequestId(
        toolSchemas['openkit.record_knowledge_conflict'].parse(input)
      );
      return mutationResponse(
        await nanoCore.recordKnowledgeConflict(request),
        'Knowledge conflict recorded.',
        request
      );
    }
    case 'openkit.resolve_knowledge_conflict': {
      const request = withGeneratedRequestId(
        toolSchemas['openkit.resolve_knowledge_conflict'].parse(input)
      );
      return mutationResponse(
        await nanoCore.resolveKnowledgeConflict(request),
        'Knowledge conflict resolved.',
        request
      );
    }
    case 'openkit.list_knowledge_conflicts': {
      const parsed = toolSchemas['openkit.list_knowledge_conflicts'].parse(input);
      return readResponse(
        await nanoCore.listKnowledgeConflicts(parsed),
        'Knowledge conflicts read.',
        parsed
      );
    }
    case 'openkit.read_knowledge_indexes': {
      const parsed = toolSchemas['openkit.read_knowledge_indexes'].parse(input);
      return readResponse(
        await nanoCore.readKnowledgeIndexes(parsed),
        'Knowledge indexes read.',
        parsed
      );
    }
    case 'openkit.retrieve_knowledge': {
      const parsed = toolSchemas['openkit.retrieve_knowledge'].parse(input);
      return mutationResponse(
        await nanoCore.retrieveKnowledge(parsed),
        'Knowledge retrieved.',
        parsed
      );
    }
    case 'openkit.prepare_knowledge_context': {
      const parsed = toolSchemas['openkit.prepare_knowledge_context'].parse(input);
      return readResponse(
        await nanoCore.prepareKnowledgeContext(parsed),
        'Knowledge context material read.',
        parsed
      );
    }
    case 'openkit.read_knowledge_context_package_trace': {
      const parsed = toolSchemas['openkit.read_knowledge_context_package_trace'].parse(input);
      return readResponse(
        await nanoCore.readKnowledgeContextPackageTrace(parsed),
        'Knowledge context package trace read.',
        parsed
      );
    }
    case 'openkit.read_knowledge_context_package_materialization': {
      const parsed =
        toolSchemas['openkit.read_knowledge_context_package_materialization'].parse(input);
      return readResponse(
        await nanoCore.readKnowledgeContextPackageMaterialization(parsed),
        'Knowledge context package materialization read.',
        parsed
      );
    }
    case 'openkit.materialize_knowledge_context_package': {
      const parsed = toolSchemas['openkit.materialize_knowledge_context_package'].parse(input);
      return mutationResponse(
        await nanoCore.materializeKnowledgeContextPackage(parsed),
        'Knowledge context package materialized.',
        parsed
      );
    }
    case 'openkit.draft_knowledge_proposal': {
      const request = withGeneratedRequestId(
        toolSchemas['openkit.draft_knowledge_proposal'].parse(input)
      );
      return mutationResponse(
        await nanoCore.draftKnowledgeProposal(request),
        'Knowledge proposal drafted.',
        request
      );
    }
    case 'openkit.suggest_knowledge_repairs': {
      const parsed = toolSchemas['openkit.suggest_knowledge_repairs'].parse(input);
      return readResponse(
        await nanoCore.suggestKnowledgeRepairs(parsed),
        'Knowledge repair suggestions read.',
        parsed
      );
    }
    case 'openkit.check_knowledge_health': {
      const parsed = toolSchemas['openkit.check_knowledge_health'].parse(input);
      return readResponse(
        await nanoCore.checkKnowledgeHealth(parsed),
        'Knowledge health read.',
        parsed
      );
    }
    case 'openkit.list_interrupted_workers': {
      const parsed = toolSchemas['openkit.list_interrupted_workers'].parse(input);
      return readResponse(
        await nanoCore.listInterruptedWorkers(),
        'Interrupted worker recovery states read.',
        parsed
      );
    }
    case 'openkit.clear_interrupted_worker_checkpoint': {
      const parsed = toolSchemas['openkit.clear_interrupted_worker_checkpoint'].parse(input);
      return mutationResponse(
        await nanoCore.clearInterruptedWorkerCheckpoint(parsed),
        'Interrupted worker checkpoint cleared.',
        parsed
      );
    }
    case 'openkit.retry_interrupted_worker_checkpoint': {
      const parsed = toolSchemas['openkit.retry_interrupted_worker_checkpoint'].parse(input);
      return mutationResponse(
        await nanoCore.retryInterruptedWorkerCheckpoint(parsed),
        'Interrupted worker checkpoint queued for retry.',
        parsed
      );
    }
    case 'openkit.retry_scheduler_admission': {
      const parsed = toolSchemas['openkit.retry_scheduler_admission'].parse(input);
      return mutationResponse(
        await nanoCore.retrySchedulerAdmission(parsed),
        'Scheduler admission queued for retry.',
        parsed
      );
    }
    case 'openkit.cancel_scheduler_admission': {
      const parsed = toolSchemas['openkit.cancel_scheduler_admission'].parse(input);
      return mutationResponse(
        await nanoCore.cancelSchedulerAdmission(parsed),
        'Scheduler admission cancelled.',
        parsed
      );
    }
    case 'openkit.read_scheduler_admissions': {
      const parsed = toolSchemas['openkit.read_scheduler_admissions'].parse(input);
      return readResponse(
        await nanoCore.readSchedulerAdmissions(parsed),
        'Scheduler admissions read.',
        parsed
      );
    }
    case 'openkit.list_recovery_pending_user_turns': {
      const parsed = toolSchemas['openkit.list_recovery_pending_user_turns'].parse(input);
      return readResponse(
        await nanoCore.listRecoveryPendingUserTurns(parsed),
        'Recovery pending user turns read.',
        parsed
      );
    }
    case 'openkit.cancel_recovery_pending_user_turn': {
      const parsed = toolSchemas['openkit.cancel_recovery_pending_user_turn'].parse(input);
      return mutationResponse(
        await nanoCore.cancelRecoveryPendingUserTurn(parsed),
        'Recovery pending user turn cancelled.',
        parsed
      );
    }
    case 'openkit.edit_recovery_pending_user_turn': {
      const parsed = toolSchemas['openkit.edit_recovery_pending_user_turn'].parse(input);
      return mutationResponse(
        await nanoCore.editRecoveryPendingUserTurn(parsed),
        'Recovery pending user turn edited.',
        parsed
      );
    }
    case 'openkit.convert_recovery_pending_user_turn_to_follow_up': {
      const parsed =
        toolSchemas['openkit.convert_recovery_pending_user_turn_to_follow_up'].parse(input);
      return mutationResponse(
        await nanoCore.convertRecoveryPendingUserTurnToFollowUp(parsed),
        'Recovery pending user turn converted to follow-up.',
        parsed
      );
    }
    case 'openkit.promote_recovery_pending_user_turn_to_interrupt': {
      const parsed =
        toolSchemas['openkit.promote_recovery_pending_user_turn_to_interrupt'].parse(input);
      return mutationResponse(
        await nanoCore.promoteRecoveryPendingUserTurnToInterrupt(parsed),
        'Recovery pending user turn promoted to interrupt.',
        parsed
      );
    }
    case 'openkit.list_workspaces': {
      const parsed = toolSchemas['openkit.list_workspaces'].parse(input);
      return readResponse(await nanoCore.listWorkspaces(), 'Workspaces read.', parsed);
    }
    case 'openkit.create_workspace': {
      const request = withGeneratedRequestId(toolSchemas['openkit.create_workspace'].parse(input));
      return mutationResponse(
        await nanoCore.createWorkspace(request),
        'Workspace created.',
        request
      );
    }
    case 'openkit.update_workspace': {
      const request = withGeneratedRequestId(toolSchemas['openkit.update_workspace'].parse(input));
      return mutationResponse(
        await nanoCore.updateWorkspace(request),
        'Workspace updated.',
        request
      );
    }
    case 'openkit.list_automations': {
      const parsed = toolSchemas['openkit.list_automations'].parse(input);
      return readResponse(await nanoCore.listAutomations(), 'Automations read.', parsed);
    }
    case 'openkit.create_automation': {
      const parsed = toolSchemas['openkit.create_automation'].parse(input);
      return mutationResponse(await nanoCore.createAutomation(parsed), 'Automation created.', {
        workspaceId: parsed.workspaceId,
      });
    }
    case 'openkit.update_automation': {
      const parsed = toolSchemas['openkit.update_automation'].parse(input);
      return mutationResponse(await nanoCore.updateAutomation(parsed), 'Automation updated.', {});
    }
    case 'openkit.delete_automation': {
      const parsed = toolSchemas['openkit.delete_automation'].parse(input);
      return mutationResponse(await nanoCore.deleteAutomation(parsed), 'Automation deleted.', {});
    }
    case 'openkit.read_workspace_resources': {
      const parsed = toolSchemas['openkit.read_workspace_resources'].parse(input);
      return readResponse(
        await nanoCore.readWorkspaceResources(parsed),
        'Workspace resources read.',
        parsed
      );
    }
    case 'openkit.list_runtime_config_files': {
      const parsed = toolSchemas['openkit.list_runtime_config_files'].parse(input);
      return readResponse(
        await nanoCore.listRuntimeConfigFiles(),
        'Runtime config files read.',
        parsed
      );
    }
    case 'openkit.read_runtime_config_file': {
      const parsed = toolSchemas['openkit.read_runtime_config_file'].parse(input);
      return readResponse(
        await nanoCore.readRuntimeConfigFile(parsed),
        'Runtime config file read.',
        {}
      );
    }
    case 'openkit.validate_runtime_config': {
      const parsed = toolSchemas['openkit.validate_runtime_config'].parse(input);
      return readResponse(
        await nanoCore.validateRuntimeConfig(parsed),
        'Runtime config draft validated.',
        {}
      );
    }
    case 'openkit.update_runtime_config_file': {
      const parsed = toolSchemas['openkit.update_runtime_config_file'].parse(input);
      return readResponse(
        await nanoCore.updateRuntimeConfigFile(parsed),
        'Runtime config file updated.',
        {}
      );
    }
    case 'openkit.reload_runtime_config': {
      const parsed = toolSchemas['openkit.reload_runtime_config'].parse(input);
      return readResponse(
        await nanoCore.reloadRuntimeConfig(parsed),
        'Runtime config reloaded.',
        {}
      );
    }
    case 'openkit.restart_runtime_config_stale_session': {
      const parsed = toolSchemas['openkit.restart_runtime_config_stale_session'].parse(input);
      return mutationResponse(
        await nanoCore.restartRuntimeConfigStaleSession(parsed),
        'Runtime config stale session restarted.',
        parsed
      );
    }
    case 'openkit.link_repository': {
      const request = withGeneratedRequestId(toolSchemas['openkit.link_repository'].parse(input));
      return mutationResponse(
        await nanoCore.linkRepository(request),
        'Repository linked.',
        request,
        [request.localPath]
      );
    }
    case 'openkit.read_repositories': {
      const parsed = toolSchemas['openkit.read_repositories'].parse(input);
      return readResponse(await nanoCore.readRepositories(parsed), 'Repositories read.', parsed);
    }
    case 'openkit.read_git_push_records': {
      const parsed = toolSchemas['openkit.read_git_push_records'].parse(input);
      return readResponse(
        await nanoCore.readGitPushRecords(parsed),
        'Git push records read.',
        parsed
      );
    }
    case 'openkit.request_git_push_approval': {
      const request = withGeneratedRequestId(
        toolSchemas['openkit.request_git_push_approval'].parse(input)
      );
      return mutationResponse(
        await nanoCore.requestGitPushApproval(request),
        'Git push approval requested.',
        request
      );
    }
    case 'openkit.execute_git_push': {
      const request = withGeneratedRequestId(toolSchemas['openkit.execute_git_push'].parse(input));
      return mutationResponse(
        await nanoCore.executeGitPush(request),
        'Git push executed.',
        request
      );
    }
    case 'openkit.create_thread': {
      const request = withGeneratedRequestId(toolSchemas['openkit.create_thread'].parse(input));
      return mutationResponse(await nanoCore.createThread(request), 'Thread created.', request);
    }
    case 'openkit.read_thread': {
      const parsed = toolSchemas['openkit.read_thread'].parse(input);
      return readResponse(await nanoCore.readThread(parsed), 'Thread read.', parsed);
    }
    case 'openkit.start_chat': {
      const request = withGeneratedRequestId(toolSchemas['openkit.start_chat'].parse(input));
      return mutationResponse(
        await nanoCore.startChat(request),
        'Chat Mode turn recorded.',
        request
      );
    }
    case 'openkit.start_task': {
      const request = withGeneratedRequestId(toolSchemas['openkit.start_task'].parse(input));
      return mutationResponse(
        await nanoCore.startTask(request),
        'Task Mode attempt started.',
        request
      );
    }
    case 'openkit.start_goal': {
      const request = withGeneratedRequestId(toolSchemas['openkit.start_goal'].parse(input));
      return mutationResponse(await nanoCore.startGoal(request), 'Goal Mode started.', request);
    }
    case 'openkit.read_goal': {
      const parsed = toolSchemas['openkit.read_goal'].parse(input);
      return readResponse(await nanoCore.readGoal(parsed), 'Goal Mode summary read.', parsed);
    }
    case 'openkit.draft_goal_plan': {
      const request = withGeneratedRequestId(toolSchemas['openkit.draft_goal_plan'].parse(input));
      return mutationResponse(
        await nanoCore.draftGoalPlan(request),
        'Goal Mode plan drafted.',
        request
      );
    }
    case 'openkit.approve_goal_plan': {
      const request = withGeneratedRequestId(toolSchemas['openkit.approve_goal_plan'].parse(input));
      return mutationResponse(
        await nanoCore.approveGoalPlan(request),
        'Goal Mode plan approved.',
        request
      );
    }
    case 'openkit.revise_goal_plan': {
      const request = withGeneratedRequestId(toolSchemas['openkit.revise_goal_plan'].parse(input));
      return mutationResponse(
        await nanoCore.reviseGoalPlan(request),
        'Goal Mode plan revision requested.',
        request
      );
    }
    case 'openkit.step_goal': {
      const request = {
        ...withGeneratedRequestId(toolSchemas['openkit.step_goal'].parse(input)),
        followUpDrainMode: 'one_at_a_time' as const,
      };
      return mutationResponse(
        await nanoCore.stepGoal(request),
        'One bounded Goal Mode step completed.',
        request
      );
    }
    case 'openkit.submit_steering': {
      const request = withGeneratedRequestId(toolSchemas['openkit.submit_steering'].parse(input));
      return mutationResponse(
        await nanoCore.submitSteering(request),
        'Goal Mode steering submitted.',
        request
      );
    }
    case 'openkit.read_action_center': {
      const parsed = toolSchemas['openkit.read_action_center'].parse(input);
      return readResponse(await nanoCore.readActionCenter(parsed), 'Action Center read.', parsed);
    }
    case 'openkit.read_workspace_reviews': {
      const parsed = toolSchemas['openkit.read_workspace_reviews'].parse(input);
      return readResponse(
        await nanoCore.readWorkspaceReviews(parsed),
        'Workspace synchronization reviews read.',
        parsed
      );
    }
    case 'openkit.read_workspace_sync_records': {
      const parsed = toolSchemas['openkit.read_workspace_sync_records'].parse(input);
      return readResponse(
        await nanoCore.readWorkspaceSyncRecords(parsed),
        'Workspace synchronization records read.',
        parsed
      );
    }
    case 'openkit.read_workspace_apply_results': {
      const parsed = toolSchemas['openkit.read_workspace_apply_results'].parse(input);
      return readResponse(
        await nanoCore.readWorkspaceApplyResults(parsed),
        'Workspace apply results read.',
        parsed
      );
    }
    case 'openkit.read_agent_environment_package_snapshots': {
      const parsed = toolSchemas['openkit.read_agent_environment_package_snapshots'].parse(input);
      return readResponse(
        await nanoCore.readAgentEnvironmentPackageSnapshots(parsed),
        'Agent Environment Package snapshots read.',
        parsed
      );
    }
    case 'openkit.resolve_action_center_item': {
      const request = withGeneratedRequestId(
        toolSchemas['openkit.resolve_action_center_item'].parse(input)
      );
      return mutationResponse(
        await nanoCore.resolveActionCenterItem(request),
        'Action Center item resolved.',
        request
      );
    }
    case 'openkit.read_artifact': {
      const parsed = toolSchemas['openkit.read_artifact'].parse(input);
      return readResponse(await nanoCore.readArtifact(parsed), 'Artifact read.', parsed);
    }
    case 'openkit.create_evidence_bundle': {
      const parsed = toolSchemas['openkit.create_evidence_bundle'].parse(input);
      return readResponse(
        await nanoCore.createEvidenceBundle(parsed),
        'Evidence bundle created.',
        parsed
      );
    }
  }
}

/** Builds a normalized response for read-only tools. */
function readResponse(
  raw: unknown,
  summary: string,
  input: { threadId?: string | undefined; workspaceId?: string | undefined }
): OpenKitToolResult {
  return {
    nextSuggestedActions: nextActionsForSummary(summary),
    ok: true,
    raw: redactPublicValue(raw),
    summary,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  };
}

/** Builds a normalized response for mutating tools. */
function mutationResponse(
  raw: unknown,
  summary: string,
  input: {
    requestId?: string | undefined;
    threadId?: string | undefined;
    workspaceId?: string | undefined;
  },
  extraSecrets: readonly string[] = []
): OpenKitToolResult {
  return {
    nextSuggestedActions: nextActionsForSummary(summary),
    ok: true,
    raw: redactPublicValue(raw, extraSecrets),
    summary,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  };
}

/** Adds a request id to parsed mutating tool input. */
function withGeneratedRequestId<T extends { requestId?: string | undefined }>(
  input: T
): T & { requestId: string } {
  return { ...input, requestId: input.requestId ?? createRequestId() };
}

/** Returns a concise human-readable tool description. */
function toolDescription(name: OpenKitToolName): string {
  return name
    .replace(/^openkit\./, '')
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

/** Suggests safe next actions for one normalized response. */
function nextActionsForSummary(summary: string): string[] {
  if (summary.includes('step')) {
    return [
      'Read openkit.read_goal.',
      'Read openkit.read_action_center.',
      'Present evidence before continuing.',
    ];
  }

  if (summary.includes('plan drafted')) {
    return [
      'Present the plan to the human.',
      'Call openkit.approve_goal_plan only after explicit approval.',
    ];
  }

  if (summary.includes('Repository')) {
    return [
      'Call openkit.read_repositories.',
      'Continue only if repository diagnostics are ready.',
    ];
  }

  if (summary.includes('Runtime config')) {
    return [
      'Read openkit.list_runtime_config_files.',
      'Validate draft config before updating files.',
      'Reload runtime config only after explaining the reload plan.',
    ];
  }

  if (summary.includes('Workspace')) {
    return [
      'Read openkit.list_workspaces.',
      'Read openkit.read_workspace_resources for the selected workspace.',
      'Configure repositories only after human confirmation.',
    ];
  }

  return [
    'Read current state before the next mutation.',
    'Ask the human before resolving review or approval rows.',
  ];
}

/** Renders one MCP prompt by name. */
function renderPrompt(name: OpenKitPromptName, input?: unknown): RenderedPrompt {
  const args = z.record(z.string(), z.unknown()).catch({}).parse(input);
  const base = [
    'Start by calling openkit.read_status and openkit.read_runtime_diagnostics, then explain the current OpenKit, NanoCore, runtime config, and worker capability state before acting.',
    'Use NanoCore through the OpenKit MCP tools only; do not bypass into storage, DATA_ROOT, environment variables, or runtime internals.',
    'Present Goal Mode plans to the human before approval and run exactly one bounded worker step at a time.',
    'After worker execution, read openkit.read_goal and openkit.read_action_center, summarize evidence, and ask the human to accept, refine, reject, or continue.',
    'Do not commit, push, tag, deploy, or trigger external side effects without explicit human approval.',
  ];

  const contentByName: Record<OpenKitPromptName, string> = {
    operate_openkit: [
      ...base,
      `Workspace: ${String(args.workspaceId ?? 'ask the human if missing')}.`,
      `Thread: ${String(args.threadId ?? 'ask the human if needed')}.`,
    ].join('\n'),
    review_openkit_goal_result: [
      ...base,
      `Review row: ${String(args.rowId ?? 'read Action Center first')}.`,
      `Artifact: ${String(args.artifactId ?? 'read relevant artifacts if present')}.`,
    ].join('\n'),
    run_goal_mode_step: [
      ...base,
      `Objective: ${String(args.objective ?? 'continue the existing approved objective')}.`,
    ].join('\n'),
    self_improve_openkit: [
      ...base,
      `Repository path: ${String(args.repositoryPath ?? 'ask the human for the OpenKit checkout path')}.`,
      `Objective: ${String(args.objective ?? 'identify one small, review-gated OpenKit improvement')}.`,
      'Use the MCP interface itself as the OpenKit user interface for this dogfood loop.',
      'Do not implement unattended recursive self-modification.',
    ].join('\n'),
    write_openkit_change_record: [
      ...base,
      'Read docs/change-tracking.md and root AGENTS.md before deciding whether to write or update a change record.',
      `Summary: ${String(args.summary ?? 'ask the human for the completed work summary')}.`,
    ].join('\n'),
  };

  return {
    messages: [{ content: contentByName[name], role: 'user' }],
    name,
  };
}
