import {
  ArtifactIdSchema,
  ArtifactReviewIdSchema,
  InvitationIdSchema,
  KnowledgeReviewIdSchema,
  KnowledgeSourceIdSchema,
  MaterialIdSchema,
  MaterialRevisionIdSchema,
  PresentationIdSchema,
  ResourceCandidateIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  VaultGrantIdSchema,
  VaultReferenceIdSchema,
  WorkerStorageTargetIdSchema,
  WorkspaceIdSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { z } from 'zod';
import type {
  CommandRequestName,
  CommandRequestRecord,
  CommandRequestResponse,
  CommandRequestResponseKind,
  CommandRequestScope,
  ConversationCommandReceiptMetadata,
} from '../lib/store.js';
import type { ControlSqlStatement } from './control-store-worker-protocol.js';

/** Exact physical owner selected by one command request scope. */
export type CommandRequestOwner =
  | { readonly scope: 'core' }
  | { readonly scope: 'user'; readonly userId: string }
  | { readonly scope: 'workspace'; readonly workspaceId: string }
  | { readonly scope: 'app'; readonly workspaceId: string; readonly appId: string };

/** Fixed v1 payload for the sole extra metadata allowed on a retained command receipt. */
const StoredConversationMetadataV1Schema = z
  .object({
    targetRef: z.string().min(1),
    logicalModelId: z.string().min(1).nullable(),
    receivingWorkspaceId: WorkspaceIdSchema,
    receivingThreadId: ThreadIdSchema,
    downstream: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('task'), turnId: TurnIdSchema }).strict(),
        z
          .object({
            kind: z.literal('goal'),
            goalId: z.string().min(1),
            turnId: TurnIdSchema,
          })
          .strict(),
      ])
      .nullable(),
    resultKind: z.enum([
      'knowledge-answer',
      'provider-answer',
      'clarification',
      'task-handoff',
      'goal-handoff',
      'worker-turn',
      'goal-intent',
      'goal-steering',
      'refused',
    ]),
    status: z.union([z.literal(200), z.literal(202)]),
  })
  .strict();

/** Retained descriptive metadata is normalized without relaxing current receipt emission. */
const StoredConversationMetadataV1ReaderSchema = StoredConversationMetadataV1Schema.extend({
  downstream: z
    .discriminatedUnion('kind', [
      StoredConversationMetadataV1Schema.shape.downstream.unwrap().options[0].strip(),
      StoredConversationMetadataV1Schema.shape.downstream.unwrap().options[1].strip(),
    ])
    .nullable(),
}).strip();

/** The response discriminator selects its declared entity owner; other owners keep opaque keys. */
const COMMAND_RESPONSE_ID_SCHEMAS: Record<CommandRequestResponseKind, z.ZodType<string> | null> = {
  workspace: WorkspaceIdSchema,
  workspace_invitation: InvitationIdSchema,
  workspace_member: null,
  workspace_recovery: WorkspaceIdSchema,
  workspace_deletion: null,
  user: UserIdSchema,
  knowledge: null,
  knowledge_notebook_revision: null,
  knowledge_schema_report: null,
  knowledge_source: KnowledgeSourceIdSchema,
  thread: ThreadIdSchema,
  turn: TurnIdSchema,
  approval: null,
  pending_request: null,
  git_push_record: null,
  artifact: ArtifactIdSchema,
  artifact_review: ArtifactReviewIdSchema,
  evaluation_candidate_set: null,
  evaluation_judgement: null,
  workspace_sync_review: null,
  knowledge_proposal: null,
  knowledge_proposal_review: KnowledgeReviewIdSchema,
  light_app_definition: null,
  light_app_catalog: WorkspaceIdSchema,
  skill_version: null,
  skill_catalog: WorkspaceIdSchema,
  skill_candidate: ResourceCandidateIdSchema,
  goal: null,
  goal_plan: null,
  goal_review: null,
  pending_user_turn: null,
  steering_terminal_outcome: null,
  material: MaterialIdSchema,
  material_revision: MaterialRevisionIdSchema,
  thread_material_binding: MaterialIdSchema,
  light_app: null,
  light_app_record: null,
  light_app_batch: null,
  generative_presentation: PresentationIdSchema,
  worker_environment: WorkerStorageTargetIdSchema,
  catalog_mcp: null,
  vault_reference: VaultReferenceIdSchema,
  vault_grant: VaultGrantIdSchema,
};

/** Fixed retained scope payload; resolving the exact database owner remains a separate check. */
const StoredCommandScopeV1Schema = z.record(z.string(), z.string());

/** Parses the one retained command scope representation. */
export function parseStoredCommandScope(input: unknown): CommandRequestScope {
  return StoredCommandScopeV1Schema.parse(input);
}

/** Selects one exact durable owner from a command request scope. */
export function commandRequestOwner(scope: CommandRequestScope): CommandRequestOwner {
  const coreId = scope.coreId;
  const userId = scope.userId;
  const workspaceId = scope.workspaceId;
  const appId = scope.appId;
  if (
    coreId === 'server' &&
    userId === undefined &&
    workspaceId === undefined &&
    appId === undefined
  )
    return { scope: 'core' };
  if (coreId === undefined && userId && workspaceId === undefined && appId === undefined)
    return { scope: 'user', userId };
  if (coreId === undefined && workspaceId && userId === undefined && appId)
    return { scope: 'app', workspaceId, appId };
  if (coreId === undefined && workspaceId && userId === undefined && appId === undefined)
    return { scope: 'workspace', workspaceId };
  throw new Error(
    'Command request scope must name exactly one Core, User, Workspace, or App owner.'
  );
}

/** Validates one kind-named response pointer and its sole bounded optional metadata. */
export function normalizeCommandRequestResponse(
  command: CommandRequestName,
  response: CommandRequestResponse
): CommandRequestResponse {
  if (Object.keys(response).some((key) => !['kind', 'id', 'conversationMetadata'].includes(key)))
    throw new Error('Command receipt response contains unsupported fields.');
  if (!Object.hasOwn(COMMAND_RESPONSE_ID_SCHEMAS, response.kind))
    throw new Error('Command receipt response kind is unsupported.');
  COMMAND_RESPONSE_ID_SCHEMAS[response.kind]?.parse(response.id);
  if (response.conversationMetadata === undefined) return { kind: response.kind, id: response.id };
  if (command !== 'conversation.submit')
    throw new Error('Only conversation.submit may store extra command receipt metadata.');
  const parsed = StoredConversationMetadataV1Schema.safeParse(response.conversationMetadata);
  if (!parsed.success) throw new Error('conversation.submit command receipt metadata is invalid.');
  return { kind: response.kind, id: response.id, conversationMetadata: parsed.data };
}

/** Reads only the retained metadata core before exact response-pointer validation. */
export function readConversationMetadata(json: string): ConversationCommandReceiptMetadata {
  const result = StoredConversationMetadataV1ReaderSchema.safeParse(JSON.parse(json));
  if (!result.success) throw new Error('conversation.submit command receipt metadata is invalid.');
  return result.data;
}

/** One serialization owner for current scoped writes and native command composition. */
export function commandRequestValues(record: CommandRequestRecord) {
  const scope = parseStoredCommandScope(record.scope);
  const response = normalizeCommandRequestResponse(record.command, record.response);
  return {
    schema_version: writeRetainedV1({}).schemaVersion,
    request_key: record.key,
    command_name: record.command,
    request_id: record.requestId,
    scope_json: JSON.stringify(scope),
    input_hash: record.inputHash,
    response_kind: response.kind,
    response_id: response.id,
    response_json:
      response.conversationMetadata === undefined
        ? null
        : JSON.stringify(response.conversationMetadata),
    created_at: record.createdAt,
    expires_at: record.expiresAt,
  };
}

/** Prepares one original Workspace receipt for its complete native tuple. */
export function prepareControlCommandRequestStatement(
  workspaceId: string,
  record: CommandRequestRecord
): Extract<ControlSqlStatement, { mode: 'run' }> {
  WorkspaceIdSchema.parse(workspaceId);
  const owner = commandRequestOwner(parseStoredCommandScope(record.scope));
  if (owner.scope !== 'workspace' || owner.workspaceId !== workspaceId)
    throw new Error('Native command receipt requires its exact Workspace owner.');
  const values = commandRequestValues(record);
  const columns = Object.keys(values);
  return {
    mode: 'run',
    sql: `INSERT INTO idempotency_requests (${columns.join(', ')})
          VALUES (${columns.map(() => '?').join(', ')})`,
    parameters: Object.values(values),
    expectChanges: 1,
  };
}
