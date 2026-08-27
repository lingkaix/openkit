import { createHash } from 'node:crypto';

import {
  AbortNanoHostTransportRotationResponseSchema,
  AcceptWorkspaceInvitationRequestSchema,
  AgentHealthRefreshResponseSchema,
  AppDiagnosticsResponseSchema,
  ApproveThreadGoalPlanRequestSchema,
  ApproveThreadGoalPlanResponseSchema,
  AppSearchResponseSchema,
  AutomationRecordSchema,
  BindThreadMaterialRequestSchema,
  BindThreadMaterialResponseSchema,
  CancelGoalSteeringRequestSchema,
  CancelGoalSteeringResponseSchema,
  CancelProviderSubscriptionAccountLoginRequestSchema,
  CancelSchedulerAdmissionResponseSchema,
  CapabilityUsageResponseSchema,
  ChangeWorkspaceMemberAccessRequestSchema,
  ConsumeOpenKitBootstrapTokenRequestSchema,
  ConsumeOpenKitBootstrapTokenResponseSchema,
  ConvertGoalSteeringToFollowUpRequestSchema,
  ConvertGoalSteeringToFollowUpResponseSchema,
  CreateAutomationRequestSchema,
  CreateOpenKitAccessTokenRequestSchema,
  CreateOpenKitAccessTokenResponseSchema,
  CreateProviderSubscriptionAccountRequestSchema,
  CreateThreadGoalPlanRequestSchema,
  CreateThreadGoalPlanResponseSchema,
  CreateWorkspaceInvitationRequestSchema,
  CreateWorkspaceMaterialRequestSchema,
  CreateWorkspaceMaterialResponseSchema,
  DataRootBackupCreateResponseSchema,
  DataRootBackupVerifyRequestSchema,
  DataRootBackupVerifyResponseSchema,
  DeclineWorkspaceInvitationRequestSchema,
  DecommissionNanoHostResponseSchema,
  DisableUserRequestSchema,
  DisableUserResponseSchema,
  EnrollNanoHostRequestSchema,
  EnrollNanoHostResponseSchema,
  ExcludeThreadMaterialRequestSchema,
  ExcludeThreadMaterialResponseSchema,
  ExecuteGitPushRequestSchema,
  ExecuteGitPushResponseSchema,
  GetAgentCatalogEntryResponseSchema,
  GetAgentEnvironmentPackageSnapshotResponseSchema,
  GetGitPushRecordResponseSchema,
  GetThreadMaterialResponseSchema,
  GetWorkspaceApplyResultResponseSchema,
  GetWorkspaceMaterialResponseSchema,
  GetWorkspaceMaterialRevisionResponseSchema,
  GetWorkspaceSyncReviewResponseSchema,
  ImportWorkspaceArtifactRequestSchema,
  ImportWorkspaceArtifactResponseSchema,
  IntroduceWorkspaceArtifactRequestSchema,
  IntroduceWorkspaceArtifactResponseSchema,
  IssueNanoHostTransportTokenRequestSchema,
  IssueNanoHostTransportTokenResponseSchema,
  KnowledgeDerivedIndexesResponseSchema,
  KnowledgeManagerAnswerRequestSchema,
  KnowledgeManagerAnswerResponseSchema,
  KnowledgeManagerDraftProposalRequestSchema,
  KnowledgeManagerDraftProposalResponseSchema,
  KnowledgeManagerHealthCheckRequestSchema,
  KnowledgeManagerHealthCheckResponseSchema,
  KnowledgeManagerPrepareContextRequestSchema,
  KnowledgeManagerPrepareContextResponseSchema,
  KnowledgeManagerSuggestRepairRequestSchema,
  KnowledgeManagerSuggestRepairResponseSchema,
  KnowledgeRetrievalResponseSchema,
  LeaveWorkspaceRequestSchema,
  ListAgentCatalogResponseSchema,
  ListAgentEnvironmentPackageSnapshotsResponseSchema,
  ListArtifactReviewsResponseSchema,
  ListAuthorizedWorkspacesResponseSchema,
  ListAutomationsResponseSchema,
  ListBackendWorkspaceHandlesResponseSchema,
  ListGitPushRecordsResponseSchema,
  ListHumanAttentionResponseSchema,
  ListInterruptedWorkerStatesResponseSchema,
  ListKnowledgeClaimsResponseSchema,
  ListKnowledgeConflictsResponseSchema,
  ListKnowledgeObservationsResponseSchema,
  ListKnowledgeSourcesResponseSchema,
  ListNanoHostTransportTokensResponseSchema,
  ListOpenKitAccessTokensResponseSchema,
  ListSchedulerAdmissionsResponseSchema,
  ListServerAuditEventsResponseSchema,
  ListServerPermissionDecisionsResponseSchema,
  ListServerVaultUseRecordsResponseSchema,
  ListStagedWorkspaceReviewsResponseSchema,
  ListThreadItemsResponseSchema,
  ListWorkerOutputManifestsResponseSchema,
  ListWorkspaceApplyPlansResponseSchema,
  ListWorkspaceApplyResultsResponseSchema,
  ListWorkspaceAuditEventsResponseSchema,
  ListWorkspaceChangeSetsResponseSchema,
  ListWorkspaceEvidenceBundlesResponseSchema,
  ListWorkspaceInputSnapshotsResponseSchema,
  ListWorkspaceInvitationsResponseSchema,
  ListWorkspaceMaterializationRecordsResponseSchema,
  ListWorkspaceMaterialRevisionsResponseSchema,
  ListWorkspaceMaterialsResponseSchema,
  ListWorkspaceMembersResponseSchema,
  ListWorkspacePermissionDecisionsResponseSchema,
  ListWorkspaceQuarantineRecordsResponseSchema,
  ListWorkspaceReconciliationRecordsResponseSchema,
  ListWorkspaceRepositoriesResponseSchema,
  ListWorkspaceRuntimeEvidenceResponseSchema,
  ListWorkspaceSyncReviewsResponseSchema,
  ListWorkspaceVaultGrantsResponseSchema,
  ListWorkspaceVaultInjectionPlansResponseSchema,
  ListWorkspaceVaultInjectionReceiptsResponseSchema,
  ListWorkspaceVaultUseRecordsResponseSchema,
  NanoHostRuntimeTargetStatusResponseSchema,
  PauseThreadGoalRequestSchema,
  PauseThreadGoalResponseSchema,
  ProviderSubscriptionAccountSchema,
  ProviderSubscriptionAccountsResponseSchema,
  ProviderSubscriptionQuotaSchema,
  ProviderSubscriptionsResponseSchema,
  QuickChatRequestSchema,
  QuickChatResponseSchema,
  ReadKnowledgeSourceResponseSchema,
  RecordKnowledgeClaimRequestSchema,
  RecordKnowledgeClaimResponseSchema,
  RecordKnowledgeConflictRequestSchema,
  RecordKnowledgeConflictResponseSchema,
  RecordKnowledgeObservationRequestSchema,
  RecordKnowledgeObservationResponseSchema,
  RecoverWorkspaceAccessRequestSchema,
  RegisterKnowledgeSourceRequestSchema,
  RegisterKnowledgeSourceResponseSchema,
  RemoveWorkspaceMemberRequestSchema,
  RequestGitPushApprovalRequestSchema,
  RequestGitPushApprovalResponseSchema,
  ResolveKnowledgeConflictRequestSchema,
  ResolveKnowledgeConflictResponseSchema,
  RestoreThreadMaterialRequestSchema,
  RestoreThreadMaterialResponseSchema,
  ResumeThreadGoalRequestSchema,
  ResumeThreadGoalResponseSchema,
  RetrieveKnowledgeRequestSchema,
  RetryInterruptedWorkerCheckpointRequestSchema,
  RetryInterruptedWorkerCheckpointResponseSchema,
  RetrySchedulerAdmissionResponseSchema,
  ReverseKnowledgeProposalRequestSchema,
  ReverseKnowledgeProposalResponseSchema,
  ReviseThreadGoalPlanRequestSchema,
  ReviseThreadGoalPlanResponseSchema,
  RevokeNanoHostTransportTokenResponseSchema,
  RevokeOpenKitAccessTokenResponseSchema,
  RevokeWorkspaceInvitationRequestSchema,
  RotateNanoHostTransportTokenRequestSchema,
  RotateNanoHostTransportTokenResponseSchema,
  RotateOpenKitAccessTokenRequestSchema,
  RotateOpenKitAccessTokenResponseSchema,
  RunThreadGoalStepRequestSchema,
  RunThreadGoalStepResponseSchema,
  RuntimeConfigFileListResponseSchema,
  RuntimeConfigFileReadResponseSchema,
  RuntimeConfigFileWriteRequestSchema,
  RuntimeConfigFileWriteResponseSchema,
  RuntimeConfigReloadRequestSchema,
  RuntimeConfigReloadResponseSchema,
  RuntimeConfigSchemaCatalogResponseSchema,
  RuntimeConfigValidationRequestSchema,
  RuntimeConfigValidationResponseSchema,
  SaveWorkspaceMaterialRevisionRequestSchema,
  SaveWorkspaceMaterialRevisionResponseSchema,
  SetupDiagnosticsResponseSchema,
  SetWorkspaceRepositoryRequestSchema,
  SetWorkspaceRepositoryResponseSchema,
  StartChatModeRequestSchema,
  StartChatModeResponseSchema,
  StartProviderSubscriptionAccountLoginRequestSchema,
  StartTaskModeRequestSchema,
  StartTaskModeResponseSchema,
  StartThreadGoalRequestSchema,
  StartThreadGoalResponseSchema,
  StorageLayoutReportResponseSchema,
  SubmitArtifactReviewDecisionRequestSchema,
  SubmitArtifactReviewDecisionResponseSchema,
  SubmitGoalReviewDecisionRequestSchema,
  SubmitGoalReviewDecisionResponseSchema,
  SubmitKnowledgeProposalDecisionRequestSchema,
  SubmitKnowledgeProposalDecisionResponseSchema,
  SubmitThreadGoalSteeringRequestSchema,
  SubmitThreadGoalSteeringResponseSchema,
  SubmitTurnFeedbackRequestSchema,
  SubmitWorkspaceRecoveryDecisionRequestSchema,
  SubmitWorkspaceRecoveryDecisionResponseSchema,
  SubmitWorkspaceSyncReviewDecisionRequestSchema,
  SubmitWorkspaceSyncReviewDecisionResponseSchema,
  SubscriptionProviderIdSchema,
  ThreadDashboardResponseSchema,
  ThreadGoalSummaryResponseSchema,
  TransferWorkspaceOwnershipRequestSchema,
  TurnFeedbackResponseSchema,
  UnbindThreadMaterialRequestSchema,
  UnbindThreadMaterialResponseSchema,
  UpdateAutomationRequestSchema,
  UpdateProviderSubscriptionAccountRequestSchema,
  VaultAdminBootstrapCodexAuthJsonRequestSchema,
  VaultAdminBootstrapCodexAuthJsonResponseSchema,
  VaultAdminListWorkspaceReferencesResponseSchema,
  VaultAdminLockResponseSchema,
  VaultAdminRebindWorkspaceReferenceRequestSchema,
  VaultAdminRebindWorkspaceReferenceResponseSchema,
  VaultAdminStatusResponseSchema,
  VaultAdminUnlockRequestSchema,
  VaultAdminUnlockResponseSchema,
  WorkspaceAccessRecoveryResponseSchema,
  WorkspaceDashboardResponseSchema,
  WorkspaceExportResponseSchema,
  WorkspaceImportDryRunRequestSchema,
  WorkspaceImportDryRunResponseSchema,
  WorkspaceImportRequestSchema,
  WorkspaceImportResponseSchema,
  WorkspaceInvitationMutationResponseSchema,
  WorkspaceMemberMutationResponseSchema,
  WorkspaceOwnershipMutationResponseSchema,
  WorkspaceRepositoryDiagnosticsResponseSchema,
} from '@openkit/app-api-schemas';
import {
  AgentIdSchema,
  ApiErrorSchema,
  ArtifactIdSchema,
  PROTOCOL_VERSION,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import type { Env, Handler, Hono } from 'hono';
import { z } from 'zod';

/** JSON value used by the OpenAPI document projection. */
export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Minimal OpenAPI document shape emitted by NanoCore. */
interface AppOpenApiDocument {
  openapi: '3.1.0';
  info: {
    title: string;
    version: string;
    description: string;
  };
  'x-openkit-protocol-version': string;
  'x-openkit-source-digest': string;
  paths: Record<string, Record<string, JsonValue>>;
  components: {
    securitySchemes: Record<string, JsonValue>;
    schemas: Record<string, JsonValue>;
  };
}

const JSON_CONTENT_TYPE = 'application/json';
const APP_API_VERSION = '0.1.0';
const DEPLOYMENT_ADMIN_SECURITY = [{ bearerAuth: [] }];
const SESSION_COOKIE_SECURITY = [{ sessionCookie: [] }];
const THREAD_ID_PARAMETER = {
  name: 'threadId',
  in: 'path',
  required: true,
  schema: { $ref: '#/components/schemas/ThreadId' },
} as const;
const TURN_ID_PARAMETER = {
  name: 'turnId',
  in: 'path',
  required: true,
  schema: { $ref: '#/components/schemas/TurnId' },
} as const;
const WORKSPACE_ID_PARAMETER = {
  name: 'workspaceId',
  in: 'path',
  required: true,
  schema: { $ref: '#/components/schemas/WorkspaceId' },
} as const;
const INVITATION_ID_PARAMETER = {
  name: 'invitationId',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
} as const;
const USER_ID_PARAMETER = {
  name: 'userId',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
} as const;
const ARTIFACT_ID_PARAMETER = {
  name: 'artifactId',
  in: 'path',
  required: true,
  schema: { $ref: '#/components/schemas/ArtifactId' },
} as const;
const ARTIFACT_VERSION_PARAMETER = {
  name: 'artifactVersion',
  in: 'path',
  required: true,
  schema: { type: 'integer', minimum: 1 },
} as const;
const MATERIAL_ID_PARAMETER = {
  name: 'materialId',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
} as const;
const REVISION_ID_PARAMETER = {
  name: 'revisionId',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
} as const;
const PENDING_TURN_ID_PARAMETER = {
  name: 'pendingTurnId',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
} as const;
const SUBSCRIPTION_PROVIDER_ID_PARAMETER = {
  name: 'subscriptionProviderId',
  in: 'path',
  required: true,
  schema: toInlineJsonSchema(SubscriptionProviderIdSchema),
};
const ACCOUNT_SLOT_ID_PARAMETER = {
  name: 'accountSlotId',
  in: 'path',
  required: true,
  schema: toInlineJsonSchema(CreateProviderSubscriptionAccountRequestSchema.shape.accountSlotId),
};

/**
 * Builds one authenticated JSON App API operation with the shared error envelope.
 *
 * @param input Operation identity, schemas, success response, and optional path parameters.
 * @returns Compact OpenAPI operation preserving the literal operation identifier.
 */
function appJsonOperation<const OperationId extends string>(input: {
  operationId: OperationId;
  tag: string;
  summary: string;
  responseStatus: '200' | '201';
  responseSchema: string;
  responseDescription?: string;
  requestSchema?: string;
  parameters?: JsonValue[];
  security?: JsonValue[];
}) {
  return {
    operationId: input.operationId,
    tags: [input.tag],
    summary: input.summary,
    security: input.security ?? [{ bearerAuth: [] }, { sessionCookie: [] }],
    ...(input.parameters ? { parameters: input.parameters } : {}),
    ...(input.requestSchema
      ? {
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: `#/components/schemas/${input.requestSchema}` },
              },
            },
          },
        }
      : {}),
    responses: {
      [input.responseStatus]: {
        description: input.responseDescription ?? input.summary,
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: { $ref: `#/components/schemas/${input.responseSchema}` },
          },
        },
      },
      default: {
        description: 'Protocol error envelope.',
        content: {
          [JSON_CONTENT_TYPE]: {
            schema: { $ref: '#/components/schemas/ApiError' },
          },
        },
      },
    },
  };
}
/** HTTP methods supported by the App API route catalog. */
export const APP_OPENAPI_ROUTE_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const registeredAppApiOperationIds = new WeakMap<object, string[]>();

/** Hono path literal projected from one OpenAPI path literal. */
type HonoPath<Path extends string> = Path extends `${infer Head}{${infer Parameter}}${infer Tail}`
  ? `${Head}:${Parameter}${HonoPath<Tail>}`
  : Path;

/** Canonical OpenAPI path catalog inferred from the document builder. */
type AppOpenApiPaths = ReturnType<typeof createAppOpenApiDocument>['paths'];

/** Method, path, and operation id union derived from the canonical route catalog. */
type AppApiRouteDefinition = {
  [Path in keyof AppOpenApiPaths]: {
    [Method in (typeof APP_OPENAPI_ROUTE_METHODS)[number]]: Method extends keyof AppOpenApiPaths[Path]
      ? AppOpenApiPaths[Path][Method] extends {
          readonly operationId: infer OperationId extends string;
        }
        ? {
            method: Method;
            operationId: OperationId;
            path: HonoPath<Path & string>;
          }
        : never
      : never;
  }[(typeof APP_OPENAPI_ROUTE_METHODS)[number]];
}[keyof AppOpenApiPaths];

/** One catalog route selected by its stable operation id. */
type AppApiRouteDefinitionFor<OperationId extends AppApiRouteDefinition['operationId']> = Pick<
  Extract<AppApiRouteDefinition, { operationId: OperationId }>,
  'method' | 'path'
>;

/** Runtime route lookup entry built once from the typed catalog. */
interface RuntimeAppApiRouteDefinition {
  /** Lowercase HTTP method accepted by Hono. */
  method: (typeof APP_OPENAPI_ROUTE_METHODS)[number];
  /** Hono path with colon-prefixed parameters. */
  path: string;
}

let appApiRouteDefinitions: Map<string, RuntimeAppApiRouteDefinition> | null = null;

/** App route operations intentionally excluded from the public OpenAPI projection. */
export const APP_OPENAPI_ROUTE_COVERAGE_EXCLUSIONS = [
  'POST /api/app/workspaces/{workspaceId}/threads/{threadId}/goal/test/supervise/step',
] as const;

/**
 * Registers one Hono handler from the route definition owned by its OpenAPI operation.
 *
 * @param app Hono application receiving the route.
 * @param operationId Stable OpenAPI operation identifier.
 * @param handler Runtime route handler.
 * @throws When the operation is unknown, already registered, or conflicts with a live route.
 */
export function registerAppApiRoute<
  E extends Env,
  OperationId extends AppApiRouteDefinition['operationId'],
>(
  app: Hono<E>,
  operationId: OperationId,
  handler: Handler<E, AppApiRouteDefinitionFor<OperationId>['path']>
): void {
  const definition = getAppApiRouteDefinition(operationId);
  const registeredOperationIds = registeredAppApiOperationIds.get(app) ?? [];

  if (registeredOperationIds.includes(operationId)) {
    throw new Error(`App API operation is already registered: ${operationId}`);
  }

  const runtimeMethod = definition.method.toUpperCase();
  if (app.routes.some(({ method, path }) => method === runtimeMethod && path === definition.path)) {
    throw new Error(`Hono route is already registered: ${runtimeMethod} ${definition.path}`);
  }

  app.on(definition.method, definition.path, handler);
  registeredOperationIds.push(operationId);
  registeredAppApiOperationIds.set(app, registeredOperationIds);
}

/**
 * Lists the OpenAPI operations registered through the shared runtime route path.
 *
 * @param app Hono application to inspect.
 * @returns Operation identifiers in runtime registration order.
 */
export function getRegisteredAppApiOperationIds<E extends Env>(app: Hono<E>): string[] {
  return [...(registeredAppApiOperationIds.get(app) ?? [])];
}

/**
 * Resolves one runtime route definition from the OpenAPI operation catalog.
 *
 * @param operationId Stable OpenAPI operation identifier.
 * @returns Runtime method and Hono path.
 * @throws When the document contains duplicate operation ids or the requested id is unknown.
 */
function getAppApiRouteDefinition<OperationId extends AppApiRouteDefinition['operationId']>(
  operationId: OperationId
): AppApiRouteDefinitionFor<OperationId> {
  if (!appApiRouteDefinitions) {
    const definitions = new Map<string, RuntimeAppApiRouteDefinition>();

    for (const [openApiPath, pathItem] of Object.entries(APP_OPENAPI_DOCUMENT.paths)) {
      for (const method of APP_OPENAPI_ROUTE_METHODS) {
        const operation = (pathItem as Readonly<Record<string, unknown>>)[method];

        if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
          continue;
        }

        const candidateOperationId = (operation as Readonly<Record<string, unknown>>).operationId;
        if (typeof candidateOperationId !== 'string' || candidateOperationId.length === 0) {
          throw new Error(`OpenAPI operation is missing operationId: ${method} ${openApiPath}`);
        }
        if (definitions.has(candidateOperationId)) {
          throw new Error(`Duplicate OpenAPI operationId: ${candidateOperationId}`);
        }

        const path = openApiPath.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
        if (path.includes('{') || path.includes('}')) {
          throw new Error(`Unsupported OpenAPI route path: ${openApiPath}`);
        }

        definitions.set(candidateOperationId, {
          method,
          path,
        });
      }
    }

    appApiRouteDefinitions = definitions;
  }

  const definition = appApiRouteDefinitions.get(operationId);
  if (!definition) {
    throw new Error(`Unknown App API operationId: ${operationId}`);
  }

  return definition as AppApiRouteDefinitionFor<OperationId>;
}

/**
 * Creates the current App API OpenAPI projection from shared Zod schemas.
 *
 * @returns OpenAPI 3.1 JSON for the implemented App API projection slice.
 */
export function createAppOpenApiDocument() {
  const document = {
    openapi: '3.1.0',
    info: {
      title: 'OpenKit App API',
      version: APP_API_VERSION,
      description:
        'Generated projection from OpenKit Zod schemas. Zod schemas in shared packages remain the source of truth.',
    },
    'x-openkit-protocol-version': PROTOCOL_VERSION,
    paths: {
      '/api/app/workspaces': {
        get: appJsonOperation({
          operationId: 'listAuthorizedWorkspaces',
          tag: 'workspace-sharing',
          summary: 'List Workspaces authorized for the current user.',
          responseStatus: '200',
          responseSchema: 'ListAuthorizedWorkspacesResponse',
        }),
      },
      '/api/app/workspaces/{workspaceId}/members': {
        get: appJsonOperation({
          operationId: 'listWorkspaceMembers',
          tag: 'workspace-sharing',
          summary: 'List Workspace members.',
          responseStatus: '200',
          responseSchema: 'ListWorkspaceMembersResponse',
          parameters: [WORKSPACE_ID_PARAMETER],
        }),
      },
      '/api/app/workspaces/{workspaceId}/invitations': {
        get: appJsonOperation({
          operationId: 'listWorkspaceInvitations',
          tag: 'workspace-sharing',
          summary: 'List Workspace invitations.',
          responseStatus: '200',
          responseSchema: 'ListWorkspaceInvitationsResponse',
          parameters: [WORKSPACE_ID_PARAMETER],
        }),
        post: appJsonOperation({
          operationId: 'createWorkspaceInvitation',
          tag: 'workspace-sharing',
          summary: 'Create a Workspace invitation.',
          responseStatus: '201',
          responseSchema: 'WorkspaceInvitationMutationResponse',
          requestSchema: 'CreateWorkspaceInvitationRequest',
          parameters: [WORKSPACE_ID_PARAMETER],
        }),
      },
      '/api/app/workspace-invitations': {
        get: appJsonOperation({
          operationId: 'listMyWorkspaceInvitations',
          tag: 'workspace-sharing',
          summary: 'List invitations for the current user.',
          responseStatus: '200',
          responseSchema: 'ListWorkspaceInvitationsResponse',
          security: SESSION_COOKIE_SECURITY,
        }),
      },
      '/api/app/workspace-invitations/{invitationId}/accept': {
        post: appJsonOperation({
          operationId: 'acceptWorkspaceInvitation',
          tag: 'workspace-sharing',
          summary: 'Accept a Workspace invitation.',
          responseStatus: '200',
          responseSchema: 'WorkspaceInvitationMutationResponse',
          requestSchema: 'AcceptWorkspaceInvitationRequest',
          parameters: [INVITATION_ID_PARAMETER],
          security: SESSION_COOKIE_SECURITY,
        }),
      },
      '/api/app/workspace-invitations/{invitationId}/decline': {
        post: appJsonOperation({
          operationId: 'declineWorkspaceInvitation',
          tag: 'workspace-sharing',
          summary: 'Decline a Workspace invitation.',
          responseStatus: '200',
          responseSchema: 'WorkspaceInvitationMutationResponse',
          requestSchema: 'DeclineWorkspaceInvitationRequest',
          parameters: [INVITATION_ID_PARAMETER],
          security: SESSION_COOKIE_SECURITY,
        }),
      },
      '/api/app/workspaces/{workspaceId}/invitations/{invitationId}/revoke': {
        post: appJsonOperation({
          operationId: 'revokeWorkspaceInvitation',
          tag: 'workspace-sharing',
          summary: 'Revoke a Workspace invitation.',
          responseStatus: '200',
          responseSchema: 'WorkspaceInvitationMutationResponse',
          requestSchema: 'RevokeWorkspaceInvitationRequest',
          parameters: [WORKSPACE_ID_PARAMETER, INVITATION_ID_PARAMETER],
        }),
      },
      '/api/app/workspaces/{workspaceId}/members/{userId}': {
        patch: appJsonOperation({
          operationId: 'changeWorkspaceMemberAccess',
          tag: 'workspace-sharing',
          summary: 'Change a Workspace member access level.',
          responseStatus: '200',
          responseSchema: 'WorkspaceMemberMutationResponse',
          requestSchema: 'ChangeWorkspaceMemberAccessRequest',
          parameters: [WORKSPACE_ID_PARAMETER, USER_ID_PARAMETER],
        }),
      },
      '/api/app/workspaces/{workspaceId}/members/{userId}/remove': {
        post: appJsonOperation({
          operationId: 'removeWorkspaceMember',
          tag: 'workspace-sharing',
          summary: 'Remove a Workspace member.',
          responseStatus: '200',
          responseSchema: 'WorkspaceMemberMutationResponse',
          requestSchema: 'RemoveWorkspaceMemberRequest',
          parameters: [WORKSPACE_ID_PARAMETER, USER_ID_PARAMETER],
        }),
      },
      '/api/app/workspaces/{workspaceId}/leave': {
        post: appJsonOperation({
          operationId: 'leaveWorkspace',
          tag: 'workspace-sharing',
          summary: 'Leave a Workspace.',
          responseStatus: '200',
          responseSchema: 'WorkspaceMemberMutationResponse',
          requestSchema: 'LeaveWorkspaceRequest',
          parameters: [WORKSPACE_ID_PARAMETER],
          security: SESSION_COOKIE_SECURITY,
        }),
      },
      '/api/app/workspaces/{workspaceId}/ownership/transfer': {
        post: appJsonOperation({
          operationId: 'transferWorkspaceOwnership',
          tag: 'workspace-sharing',
          summary: 'Transfer Workspace ownership.',
          responseStatus: '200',
          responseSchema: 'WorkspaceOwnershipMutationResponse',
          requestSchema: 'TransferWorkspaceOwnershipRequest',
          parameters: [WORKSPACE_ID_PARAMETER],
        }),
      },
      '/api/app/workspaces/{workspaceId}/access-recovery': {
        get: appJsonOperation({
          operationId: 'getWorkspaceAccessRecoveryState',
          tag: 'workspace-sharing',
          summary: 'Read administrator-safe Workspace access recovery state.',
          responseStatus: '200',
          responseSchema: 'WorkspaceAccessRecoveryResponse',
          parameters: [WORKSPACE_ID_PARAMETER],
          security: DEPLOYMENT_ADMIN_SECURITY,
        }),
        post: appJsonOperation({
          operationId: 'recoverWorkspaceAccess',
          tag: 'workspace-sharing',
          summary: 'Recover administrator Workspace access.',
          responseStatus: '200',
          responseSchema: 'WorkspaceAccessRecoveryResponse',
          requestSchema: 'RecoverWorkspaceAccessRequest',
          parameters: [WORKSPACE_ID_PARAMETER],
          security: DEPLOYMENT_ADMIN_SECURITY,
        }),
      },
      '/api/app/users/{userId}/disable': {
        post: appJsonOperation({
          operationId: 'disableUser',
          tag: 'user-lifecycle',
          summary: 'Disable a canonical user.',
          responseStatus: '200',
          responseSchema: 'DisableUserResponse',
          requestSchema: 'DisableUserRequest',
          parameters: [USER_ID_PARAMETER],
          security: DEPLOYMENT_ADMIN_SECURITY,
        }),
      },
      '/api/app/storage/layout-report': {
        get: {
          operationId: 'getStorageLayoutReport',
          tags: ['storage'],
          summary: 'Read the NanoCore storage layout report.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Storage layout report.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/StorageLayoutReportResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/diagnostics': {
        get: {
          operationId: 'getAppDiagnostics',
          tags: ['diagnostics'],
          summary: 'Read NanoCore app diagnostics and readiness.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'App diagnostics and readiness report.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/AppDiagnosticsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/setup/diagnostics': {
        get: {
          operationId: 'getSetupDiagnostics',
          tags: ['diagnostics'],
          summary: 'Read NanoCore setup diagnostics.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Setup diagnostics report.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/SetupDiagnosticsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/auth/tokens': {
        get: {
          operationId: 'listOpenKitAccessTokens',
          tags: ['auth'],
          summary: 'List redacted OpenKit access-token records.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Redacted access-token records.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListOpenKitAccessTokensResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
        post: {
          operationId: 'createOpenKitAccessToken',
          tags: ['auth'],
          summary: 'Issue an OpenKit access token and return the secret once.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/CreateOpenKitAccessTokenRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Issued access token and redacted record.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/CreateOpenKitAccessTokenResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/auth/bootstrap/consume': {
        post: {
          operationId: 'consumeOpenKitBootstrapToken',
          tags: ['auth'],
          summary: 'Consume the one-time server bootstrap token.',
          security: [],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/ConsumeOpenKitBootstrapTokenRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Issued owner server-admin token and redacted record.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ConsumeOpenKitBootstrapTokenResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/auth/tokens/{tokenId}/revoke': {
        post: {
          operationId: 'revokeOpenKitAccessToken',
          tags: ['auth'],
          summary: 'Revoke an OpenKit access token immediately.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'tokenId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Revoked access-token record.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RevokeOpenKitAccessTokenResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/auth/tokens/{tokenId}/rotate': {
        post: {
          operationId: 'rotateOpenKitAccessToken',
          tags: ['auth'],
          summary: 'Rotate an OpenKit access token and return the new secret once.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'tokenId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: false,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/RotateOpenKitAccessTokenRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Rotated access-token records and new secret.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RotateOpenKitAccessTokenResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/nanohost/enroll': {
        post: {
          operationId: 'enrollNanoHost',
          tags: ['nanohost'],
          summary: 'Enroll a NanoHost identity and first transport token.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/EnrollNanoHostRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Redacted NanoHost enrollment result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/EnrollNanoHostResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/nanohost/runtime-target': {
        get: appJsonOperation({
          operationId: 'getNanoHostRuntimeTargetStatus',
          tag: 'nanohost',
          summary: 'Read the configured NanoHost RuntimeTarget readiness status.',
          responseStatus: '200',
          responseSchema: 'NanoHostRuntimeTargetStatusResponse',
          security: DEPLOYMENT_ADMIN_SECURITY,
        }),
      },
      '/api/app/nanohost/tokens': {
        get: {
          operationId: 'listNanoHostTransportTokens',
          tags: ['nanohost'],
          summary: 'List redacted NanoHost transport token records.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Redacted NanoHost transport token records.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListNanoHostTransportTokensResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
        post: {
          operationId: 'issueNanoHostTransportToken',
          tags: ['nanohost'],
          summary: 'Issue a NanoHost transport token and deliver it through a named safe sink.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/IssueNanoHostTransportTokenRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Issued NanoHost transport token and redacted record.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/IssueNanoHostTransportTokenResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/nanohost/tokens/{tokenId}/revoke': {
        post: {
          operationId: 'revokeNanoHostTransportToken',
          tags: ['nanohost'],
          summary: 'Revoke a NanoHost transport token immediately.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'tokenId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Revoked NanoHost transport token record.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RevokeNanoHostTransportTokenResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/nanohost/tokens/{tokenId}/rotate': {
        post: {
          operationId: 'rotateNanoHostTransportToken',
          tags: ['nanohost'],
          summary:
            'Rotate a NanoHost transport token and deliver the successor through a named safe sink.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'tokenId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: false,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/RotateNanoHostTransportTokenRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Rotated NanoHost transport token records and named-sink slot result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RotateNanoHostTransportTokenResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/nanohost/tokens/{tokenId}/rotation/abort': {
        post: {
          operationId: 'abortNanoHostTransportTokenRotation',
          tags: ['nanohost'],
          summary: 'Abort a pending NanoHost transport token rotation.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'tokenId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Redacted NanoHost transport rotation abort result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/AbortNanoHostTransportRotationResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/nanohost/decommission': {
        post: {
          operationId: 'decommissionNanoHost',
          tags: ['nanohost'],
          summary: 'Decommission the configured NanoHost identity.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Redacted configured NanoHost decommission result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/DecommissionNanoHostResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/admin/config/reload': {
        post: {
          operationId: 'reloadRuntimeConfig',
          tags: ['runtime-config'],
          summary: 'Reload NanoCore runtime config.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/RuntimeConfigReloadRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Runtime config reload result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RuntimeConfigReloadResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/admin/config/files': {
        get: {
          operationId: 'listRuntimeConfigFiles',
          tags: ['runtime-config'],
          summary: 'List editable runtime config files.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Runtime config file summaries.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RuntimeConfigFileListResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/admin/config/file': {
        get: {
          operationId: 'getRuntimeConfigFile',
          tags: ['runtime-config'],
          summary: 'Read one runtime config file.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'id',
              in: 'query',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Runtime config file source.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RuntimeConfigFileReadResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
        post: {
          operationId: 'createRuntimeConfigFile',
          tags: ['runtime-config'],
          summary: 'Create one runtime config file.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/RuntimeConfigFileWriteRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Written runtime config file summary.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RuntimeConfigFileWriteResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
        put: {
          operationId: 'updateRuntimeConfigFile',
          tags: ['runtime-config'],
          summary: 'Update one runtime config file.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/RuntimeConfigFileWriteRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Updated runtime config file summary.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RuntimeConfigFileWriteResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/admin/config/schemas': {
        get: {
          operationId: 'getRuntimeConfigSchemas',
          tags: ['runtime-config'],
          summary: 'Read runtime config JSON Schema catalog.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Runtime config schema catalog.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RuntimeConfigSchemaCatalogResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/admin/config/validate': {
        post: {
          operationId: 'validateRuntimeConfig',
          tags: ['runtime-config'],
          summary: 'Validate draft runtime config source.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/RuntimeConfigValidationRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Runtime config validation result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RuntimeConfigValidationResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/automations': {
        get: {
          operationId: 'listAutomations',
          tags: ['automations'],
          summary: 'List configured automations.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          responses: {
            '200': {
              description: 'Automation records.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListAutomationsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
        post: {
          operationId: 'createAutomation',
          tags: ['automations'],
          summary: 'Create one automation.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/CreateAutomationRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Created automation record.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/AutomationRecord' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/automations/{automationId}': {
        patch: {
          operationId: 'updateAutomation',
          tags: ['automations'],
          summary: 'Update one automation.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            {
              name: 'automationId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/UpdateAutomationRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Updated automation record.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/AutomationRecord' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
        delete: {
          operationId: 'deleteAutomation',
          tags: ['automations'],
          summary: 'Delete one automation.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            {
              name: 'automationId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '204': {
              description: 'Automation deleted.',
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/agents/health/refresh': {
        post: {
          operationId: 'refreshAgentHealth',
          tags: ['app-utils'],
          summary: 'Refresh agent health for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Agent health and session summaries.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/AgentHealthRefreshResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/agents': {
        get: {
          operationId: 'listAgentCatalog',
          tags: ['agents'],
          summary: 'List product-visible agent catalog entries.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          responses: {
            '200': {
              description: 'Agent catalog entries.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListAgentCatalogResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/agents/{agentId}': {
        get: {
          operationId: 'getAgentCatalogEntry',
          tags: ['agents'],
          summary: 'Read one product-visible agent catalog entry.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            {
              name: 'agentId',
              in: 'path',
              required: true,
              schema: { $ref: '#/components/schemas/AgentId' },
            },
          ],
          responses: {
            '200': {
              description: 'Agent catalog entry.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/GetAgentCatalogEntryResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/provider-subscriptions': {
        get: appJsonOperation({
          operationId: 'listSubscriptionProviders',
          tag: 'provider-subscriptions',
          summary: 'List supported provider subscriptions.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responseStatus: '200',
          responseSchema: 'ProviderSubscriptionsResponse',
          responseDescription: 'Fixed supported provider-subscription inventory.',
        }),
      },
      '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts': {
        get: appJsonOperation({
          operationId: 'listProviderSubscriptionAccounts',
          tag: 'provider-subscriptions',
          summary: 'List provider-subscription account slots.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [SUBSCRIPTION_PROVIDER_ID_PARAMETER],
          responseStatus: '200',
          responseSchema: 'ProviderSubscriptionAccountsResponse',
          responseDescription: 'Sanitized provider-subscription account slots.',
        }),
        post: appJsonOperation({
          operationId: 'createProviderSubscriptionAccount',
          tag: 'provider-subscriptions',
          summary: 'Create one provider-subscription account slot.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [SUBSCRIPTION_PROVIDER_ID_PARAMETER],
          requestSchema: 'CreateProviderSubscriptionAccountRequest',
          responseStatus: '200',
          responseSchema: 'ProviderSubscriptionAccount',
          responseDescription: 'Created provider-subscription account slot.',
        }),
      },
      '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}': {
        patch: appJsonOperation({
          operationId: 'updateProviderSubscriptionAccount',
          tag: 'provider-subscriptions',
          summary: 'Update one provider-subscription account slot.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [SUBSCRIPTION_PROVIDER_ID_PARAMETER, ACCOUNT_SLOT_ID_PARAMETER],
          requestSchema: 'UpdateProviderSubscriptionAccountRequest',
          responseStatus: '200',
          responseSchema: 'ProviderSubscriptionAccount',
          responseDescription: 'Updated provider-subscription account slot.',
        }),
        delete: {
          operationId: 'deleteProviderSubscriptionAccount',
          tags: ['provider-subscriptions'],
          summary: 'Delete one provider-subscription account slot.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [SUBSCRIPTION_PROVIDER_ID_PARAMETER, ACCOUNT_SLOT_ID_PARAMETER],
          responses: {
            '204': {
              description: 'Provider-subscription account deleted.',
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/status': {
        get: appJsonOperation({
          operationId: 'getProviderSubscriptionAccountStatus',
          tag: 'provider-subscriptions',
          summary: 'Read one provider-subscription account status.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [SUBSCRIPTION_PROVIDER_ID_PARAMETER, ACCOUNT_SLOT_ID_PARAMETER],
          responseStatus: '200',
          responseSchema: 'ProviderSubscriptionAccount',
          responseDescription: 'Sanitized provider-subscription account status.',
        }),
      },
      '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/login': {
        post: appJsonOperation({
          operationId: 'startProviderSubscriptionAccountLogin',
          tag: 'provider-subscriptions',
          summary: 'Start one provider-subscription device-code login.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [SUBSCRIPTION_PROVIDER_ID_PARAMETER, ACCOUNT_SLOT_ID_PARAMETER],
          requestSchema: 'StartProviderSubscriptionAccountLoginRequest',
          responseStatus: '200',
          responseSchema: 'ProviderSubscriptionAccount',
          responseDescription: 'Accepted provider-subscription login interaction.',
        }),
      },
      '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/login/cancel':
        {
          post: appJsonOperation({
            operationId: 'cancelProviderSubscriptionAccountLogin',
            tag: 'provider-subscriptions',
            summary: 'Cancel one provider-subscription login interaction.',
            security: DEPLOYMENT_ADMIN_SECURITY,
            parameters: [SUBSCRIPTION_PROVIDER_ID_PARAMETER, ACCOUNT_SLOT_ID_PARAMETER],
            requestSchema: 'CancelProviderSubscriptionAccountLoginRequest',
            responseStatus: '200',
            responseSchema: 'ProviderSubscriptionAccount',
            responseDescription: 'Provider-subscription account after cancellation.',
          }),
        },
      '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/logout': {
        post: appJsonOperation({
          operationId: 'logoutProviderSubscriptionAccount',
          tag: 'provider-subscriptions',
          summary: 'Log out one provider-subscription account locally.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [SUBSCRIPTION_PROVIDER_ID_PARAMETER, ACCOUNT_SLOT_ID_PARAMETER],
          responseStatus: '200',
          responseSchema: 'ProviderSubscriptionAccount',
          responseDescription: 'Provider-subscription account after local logout.',
        }),
      },
      '/api/app/provider-subscriptions/{subscriptionProviderId}/accounts/{accountSlotId}/quota': {
        get: appJsonOperation({
          operationId: 'getProviderSubscriptionAccountQuota',
          tag: 'provider-subscriptions',
          summary: 'Read bounded provider-subscription quota availability.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [SUBSCRIPTION_PROVIDER_ID_PARAMETER, ACCOUNT_SLOT_ID_PARAMETER],
          responseStatus: '200',
          responseSchema: 'ProviderSubscriptionQuota',
          responseDescription: 'Bounded provider-subscription quota projection.',
        }),
      },
      '/api/app/quick-chat': {
        post: {
          operationId: 'quickChat',
          tags: ['app-utils'],
          summary: 'Run one completed non-streaming quick chat request.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/QuickChatRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Completed quick chat response.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/QuickChatResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/recovery/interrupted-workers': {
        get: {
          operationId: 'listInterruptedWorkers',
          tags: ['app-utils'],
          summary: 'List interrupted worker recovery states.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          responses: {
            '200': {
              description: 'Interrupted worker recovery states.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ListInterruptedWorkerStatesResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/interrupted-worker/{turnId}/retry':
        {
          post: {
            operationId: 'retryInterruptedWorkerCheckpoint',
            tags: ['app-utils'],
            summary: 'Release one interrupted worker attempt for a later retry.',
            security: [{ bearerAuth: [] }, { sessionCookie: [] }],
            parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER, TURN_ID_PARAMETER],
            requestBody: {
              required: true,
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/RetryInterruptedWorkerCheckpointRequest',
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Checkpoint retry result.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: {
                      $ref: '#/components/schemas/RetryInterruptedWorkerCheckpointResponse',
                    },
                  },
                },
              },
              default: {
                description: 'Protocol error envelope.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: { $ref: '#/components/schemas/ApiError' },
                  },
                },
              },
            },
          },
        },
      '/api/app/workspaces/{workspaceId}/scheduler/admissions': {
        get: {
          operationId: 'listSchedulerAdmissions',
          tags: ['app-utils'],
          summary: 'List workspace scheduler admissions with public queue state.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace scheduler admission read model.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListSchedulerAdmissionsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/scheduler/admissions/{queueEntryId}/retry': {
        post: {
          operationId: 'retrySchedulerAdmission',
          tags: ['app-utils'],
          summary: 'Requeue one denied scheduler admission.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'queueEntryId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Scheduler admission retry result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RetrySchedulerAdmissionResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/scheduler/admissions/{queueEntryId}/cancel': {
        post: {
          operationId: 'cancelSchedulerAdmission',
          tags: ['app-utils'],
          summary: 'Cancel one scheduler admission.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'queueEntryId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Scheduler admission cancellation result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/CancelSchedulerAdmissionResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/search': {
        get: {
          operationId: 'searchApp',
          tags: ['app-utils'],
          summary: 'Search app-local read models.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: false,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Search results.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/AppSearchResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/turns/{turnId}/feedback': {
        post: {
          operationId: 'submitTurnFeedback',
          tags: ['app-utils'],
          summary: 'Submit feedback for one turn.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [TURN_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/SubmitTurnFeedbackRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Stored turn feedback.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/TurnFeedbackResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/chat': {
        post: {
          operationId: 'startChatMode',
          tags: ['modes'],
          summary: 'Start one thread-scoped Chat Mode Assistant turn.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/StartChatModeRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Completed Chat Mode response.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/StartChatModeResponse' },
                },
              },
            },
            '202': {
              description: 'Accepted Chat Mode handoff or clarification response.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/StartChatModeResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/task': {
        post: {
          operationId: 'startTaskMode',
          tags: ['modes'],
          summary: 'Start one bounded Task Mode worker delegation.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/StartTaskModeRequest' },
              },
            },
          },
          responses: {
            '202': {
              description: 'Accepted Task Mode attempt or escalation.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/StartTaskModeResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/goal': {
        get: {
          operationId: 'getThreadGoalSummary',
          tags: ['modes'],
          summary: 'Read one thread Goal Mode summary.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Thread Goal Mode summary.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ThreadGoalSummaryResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
        post: {
          operationId: 'startThreadGoal',
          tags: ['modes'],
          summary: 'Start Goal Mode for one thread.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/StartThreadGoalRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Started Goal Mode objective.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/StartThreadGoalResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/steering': {
        post: {
          operationId: 'submitThreadGoalSteering',
          tags: ['modes'],
          summary: 'Submit active steering to Goal Mode.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/SubmitThreadGoalSteeringRequest' },
              },
            },
          },
          responses: {
            '202': {
              description: 'Queued Goal Mode steering.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/SubmitThreadGoalSteeringResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/steering/{pendingTurnId}/follow-up':
        {
          post: appJsonOperation({
            operationId: 'convertGoalSteeringToFollowUp',
            tag: 'modes',
            summary: 'Convert terminal Goal steering into Thread follow-up history.',
            responseStatus: '200',
            responseSchema: 'ConvertGoalSteeringToFollowUpResponse',
            requestSchema: 'ConvertGoalSteeringToFollowUpRequest',
            parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER, PENDING_TURN_ID_PARAMETER],
          }),
        },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/steering/{pendingTurnId}/cancel': {
        post: appJsonOperation({
          operationId: 'cancelGoalSteering',
          tag: 'modes',
          summary: 'Cancel terminal Goal steering.',
          responseStatus: '200',
          responseSchema: 'CancelGoalSteeringResponse',
          requestSchema: 'CancelGoalSteeringRequest',
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER, PENDING_TURN_ID_PARAMETER],
        }),
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/plan': {
        post: {
          operationId: 'createThreadGoalPlan',
          tags: ['modes'],
          summary: 'Draft one Goal Mode plan.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/CreateThreadGoalPlanRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Drafted Goal Mode plan.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/CreateThreadGoalPlanResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/plan/approve': {
        post: {
          operationId: 'approveThreadGoalPlan',
          tags: ['modes'],
          summary: 'Approve one Goal Mode plan.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/ApproveThreadGoalPlanRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Approved Goal Mode plan.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApproveThreadGoalPlanResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/plan/revise': {
        post: {
          operationId: 'reviseThreadGoalPlan',
          tags: ['modes'],
          summary: 'Request revision for one Goal Mode plan.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/ReviseThreadGoalPlanRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Recorded Goal Mode plan revision request.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ReviseThreadGoalPlanResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/pause': {
        post: {
          operationId: 'pauseThreadGoal',
          tags: ['modes'],
          summary: 'Pause one active Goal Mode workflow.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/PauseThreadGoalRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Paused Goal Mode workflow.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/PauseThreadGoalResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/resume': {
        post: {
          operationId: 'resumeThreadGoal',
          tags: ['modes'],
          summary: 'Resume one paused Goal Mode workflow.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/ResumeThreadGoalRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Resumed Goal Mode workflow.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ResumeThreadGoalResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/step': {
        post: {
          operationId: 'runThreadGoalStep',
          tags: ['modes'],
          summary: 'Run one bounded Goal Mode worker step.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/RunThreadGoalStepRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Goal Mode worker step result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RunThreadGoalStepResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/manager/answer': {
        post: {
          operationId: 'answerKnowledgeManager',
          tags: ['knowledge'],
          summary: 'Answer a question from workspace knowledge.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/KnowledgeManagerAnswerRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Knowledge Manager answer result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/KnowledgeManagerAnswerResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/sources': {
        get: {
          operationId: 'listKnowledgeSources',
          tags: ['knowledge'],
          summary: 'List registered workspace knowledge sources.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Registered knowledge sources.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListKnowledgeSourcesResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
        post: {
          operationId: 'registerKnowledgeSource',
          tags: ['knowledge'],
          summary: 'Register one workspace knowledge source.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/RegisterKnowledgeSourceRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Registered knowledge source.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RegisterKnowledgeSourceResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/sources/{sourceId}': {
        get: {
          operationId: 'readKnowledgeSource',
          tags: ['knowledge'],
          summary: 'Read one registered workspace knowledge source.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'sourceId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Registered knowledge source.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ReadKnowledgeSourceResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/observations': {
        get: {
          operationId: 'listKnowledgeObservations',
          tags: ['knowledge'],
          summary: 'List workspace Knowledge Store observations.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Knowledge Store observations.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListKnowledgeObservationsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
        post: {
          operationId: 'recordKnowledgeObservation',
          tags: ['knowledge'],
          summary: 'Record one workspace Knowledge Store observation.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/RecordKnowledgeObservationRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Recorded Knowledge Store observation.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RecordKnowledgeObservationResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/claims': {
        get: {
          operationId: 'listKnowledgeClaims',
          tags: ['knowledge'],
          summary: 'List workspace Knowledge Store claims.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Knowledge Store claims.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListKnowledgeClaimsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
        post: {
          operationId: 'recordKnowledgeClaim',
          tags: ['knowledge'],
          summary: 'Record one workspace Knowledge Store claim.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/RecordKnowledgeClaimRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Recorded Knowledge Store claim.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RecordKnowledgeClaimResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/conflicts': {
        get: {
          operationId: 'listKnowledgeConflicts',
          tags: ['knowledge'],
          summary: 'List workspace Knowledge Store conflicts.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Knowledge Store conflicts.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListKnowledgeConflictsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
        post: {
          operationId: 'recordKnowledgeConflict',
          tags: ['knowledge'],
          summary: 'Record one workspace Knowledge Store conflict.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/RecordKnowledgeConflictRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Recorded Knowledge Store conflict.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RecordKnowledgeConflictResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/conflicts/{conflictId}/resolution': {
        post: {
          operationId: 'resolveKnowledgeConflict',
          tags: ['knowledge'],
          summary: 'Resolve one workspace Knowledge Store conflict.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'conflictId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/ResolveKnowledgeConflictRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Resolved Knowledge Store conflict.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ResolveKnowledgeConflictResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/indexes': {
        get: {
          operationId: 'readKnowledgeIndexes',
          tags: ['knowledge'],
          summary: 'Read fresh derived Knowledge Store indexes.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Derived Knowledge Store indexes.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/KnowledgeDerivedIndexesResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/retrievals': {
        post: {
          operationId: 'retrieveKnowledge',
          tags: ['knowledge'],
          summary: 'Retrieve ranked Knowledge Store candidates and persist the trace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/RetrieveKnowledgeRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Knowledge Store retrieval trace.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/KnowledgeRetrievalResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/manager/context': {
        post: {
          operationId: 'prepareKnowledgeContext',
          tags: ['knowledge'],
          summary: 'Select a bounded governed Knowledge retrieval projection.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: {
                  $ref: '#/components/schemas/KnowledgeManagerPrepareContextRequest',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Governed Knowledge selection and retrieval trace reference.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/KnowledgeManagerPrepareContextResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/manager/proposals': {
        post: {
          operationId: 'draftKnowledgeProposal',
          tags: ['knowledge'],
          summary: 'Draft one review-required knowledge proposal.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: {
                  $ref: '#/components/schemas/KnowledgeManagerDraftProposalRequest',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Drafted pending knowledge proposal.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/KnowledgeManagerDraftProposalResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/manager/repairs': {
        post: {
          operationId: 'suggestKnowledgeRepairs',
          tags: ['knowledge'],
          summary: 'Suggest review-required knowledge repairs.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: {
                  $ref: '#/components/schemas/KnowledgeManagerSuggestRepairRequest',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Knowledge repair suggestions.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/KnowledgeManagerSuggestRepairResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/manager/health': {
        post: {
          operationId: 'checkKnowledgeHealth',
          tags: ['knowledge'],
          summary: 'Read one bounded Knowledge Manager health report.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: {
                  $ref: '#/components/schemas/KnowledgeManagerHealthCheckRequest',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Knowledge Manager health report.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/KnowledgeManagerHealthCheckResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/dashboard': {
        get: {
          operationId: 'getWorkspaceDashboard',
          tags: ['dashboards'],
          summary: 'Read one workspace dashboard read model.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace dashboard read model.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/WorkspaceDashboardResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/dashboard': {
        get: {
          operationId: 'getThreadDashboard',
          tags: ['dashboards'],
          summary: 'Read one thread dashboard read model.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Thread dashboard read model.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ThreadDashboardResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/items': {
        get: {
          operationId: 'listThreadItems',
          tags: ['dashboards'],
          summary: 'List durable item log entries for one thread.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            THREAD_ID_PARAMETER,
            {
              name: 'since',
              in: 'query',
              required: false,
              schema: { type: 'number' },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Thread item log entries.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListThreadItemsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/artifacts/{artifactId}/reviews': {
        get: appJsonOperation({
          operationId: 'listArtifactReviews',
          tag: 'reviews',
          summary: 'List version-keyed Artifact Reviews.',
          parameters: [WORKSPACE_ID_PARAMETER, ARTIFACT_ID_PARAMETER],
          responseStatus: '200',
          responseSchema: 'ListArtifactReviewsResponse',
        }),
      },
      '/api/app/workspaces/{workspaceId}/artifacts/{artifactId}/versions/{artifactVersion}/review/decision':
        {
          post: appJsonOperation({
            operationId: 'submitArtifactReviewDecision',
            tag: 'reviews',
            summary: 'Decide one exact Artifact Review.',
            parameters: [WORKSPACE_ID_PARAMETER, ARTIFACT_ID_PARAMETER, ARTIFACT_VERSION_PARAMETER],
            requestSchema: 'SubmitArtifactReviewDecisionRequest',
            responseStatus: '200',
            responseSchema: 'SubmitArtifactReviewDecisionResponse',
          }),
        },
      '/api/app/workspaces/{workspaceId}/artifacts/imports': {
        post: appJsonOperation({
          operationId: 'importWorkspaceArtifact',
          tag: 'artifacts',
          summary: 'Import one immutable Workspace-only Artifact.',
          parameters: [WORKSPACE_ID_PARAMETER],
          requestSchema: 'ImportWorkspaceArtifactRequest',
          responseStatus: '201',
          responseSchema: 'ImportWorkspaceArtifactResponse',
        }),
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/artifacts/{artifactId}/introductions': {
        post: appJsonOperation({
          operationId: 'introduceWorkspaceArtifact',
          tag: 'artifacts',
          summary: 'Introduce one exact Workspace-only Artifact version into a Thread.',
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER, ARTIFACT_ID_PARAMETER],
          requestSchema: 'IntroduceWorkspaceArtifactRequest',
          responseStatus: '201',
          responseSchema: 'IntroduceWorkspaceArtifactResponse',
        }),
      },
      '/api/app/workspaces/{workspaceId}/materials': {
        get: appJsonOperation({
          operationId: 'listWorkspaceMaterials',
          tag: 'materials',
          summary: 'List Workspace Materials.',
          parameters: [WORKSPACE_ID_PARAMETER],
          responseStatus: '200',
          responseSchema: 'ListWorkspaceMaterialsResponse',
        }),
        post: appJsonOperation({
          operationId: 'createWorkspaceMaterial',
          tag: 'materials',
          summary: 'Create one Workspace Material.',
          parameters: [WORKSPACE_ID_PARAMETER],
          requestSchema: 'CreateWorkspaceMaterialRequest',
          responseStatus: '201',
          responseSchema: 'CreateWorkspaceMaterialResponse',
        }),
      },
      '/api/app/workspaces/{workspaceId}/materials/{materialId}': {
        get: appJsonOperation({
          operationId: 'getWorkspaceMaterial',
          tag: 'materials',
          summary: 'Read one Workspace Material.',
          parameters: [WORKSPACE_ID_PARAMETER, MATERIAL_ID_PARAMETER],
          responseStatus: '200',
          responseSchema: 'GetWorkspaceMaterialResponse',
        }),
      },
      '/api/app/workspaces/{workspaceId}/materials/{materialId}/revisions': {
        get: appJsonOperation({
          operationId: 'listWorkspaceMaterialRevisions',
          tag: 'materials',
          summary: 'List immutable revisions for one Workspace Material.',
          parameters: [WORKSPACE_ID_PARAMETER, MATERIAL_ID_PARAMETER],
          responseStatus: '200',
          responseSchema: 'ListWorkspaceMaterialRevisionsResponse',
        }),
        post: appJsonOperation({
          operationId: 'saveWorkspaceMaterialRevision',
          tag: 'materials',
          summary: 'Save one immutable Workspace Material revision.',
          parameters: [WORKSPACE_ID_PARAMETER, MATERIAL_ID_PARAMETER],
          requestSchema: 'SaveWorkspaceMaterialRevisionRequest',
          responseStatus: '201',
          responseSchema: 'SaveWorkspaceMaterialRevisionResponse',
        }),
      },
      '/api/app/workspaces/{workspaceId}/materials/{materialId}/revisions/{revisionId}': {
        get: appJsonOperation({
          operationId: 'getWorkspaceMaterialRevision',
          tag: 'materials',
          summary: 'Read one exact Workspace Material revision.',
          parameters: [WORKSPACE_ID_PARAMETER, MATERIAL_ID_PARAMETER, REVISION_ID_PARAMETER],
          responseStatus: '200',
          responseSchema: 'GetWorkspaceMaterialRevisionResponse',
        }),
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/material': {
        get: appJsonOperation({
          operationId: 'getThreadMaterial',
          tag: 'materials',
          summary: 'Read the singular Material projection for one Thread.',
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          responseStatus: '200',
          responseSchema: 'GetThreadMaterialResponse',
        }),
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/materials/{materialId}/bind': {
        post: appJsonOperation({
          operationId: 'bindThreadMaterial',
          tag: 'materials',
          summary: 'Bind one Workspace Material to a Thread.',
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER, MATERIAL_ID_PARAMETER],
          requestSchema: 'BindThreadMaterialRequest',
          responseStatus: '200',
          responseSchema: 'BindThreadMaterialResponse',
        }),
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/materials/{materialId}/unbind': {
        post: appJsonOperation({
          operationId: 'unbindThreadMaterial',
          tag: 'materials',
          summary: 'Unbind one Workspace Material from a Thread.',
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER, MATERIAL_ID_PARAMETER],
          requestSchema: 'UnbindThreadMaterialRequest',
          responseStatus: '200',
          responseSchema: 'UnbindThreadMaterialResponse',
        }),
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/materials/{materialId}/exclude': {
        post: appJsonOperation({
          operationId: 'excludeThreadMaterial',
          tag: 'materials',
          summary: 'Exclude one bound Workspace Material from worker context.',
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER, MATERIAL_ID_PARAMETER],
          requestSchema: 'ExcludeThreadMaterialRequest',
          responseStatus: '200',
          responseSchema: 'ExcludeThreadMaterialResponse',
        }),
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/materials/{materialId}/restore': {
        post: appJsonOperation({
          operationId: 'restoreThreadMaterial',
          tag: 'materials',
          summary: 'Restore one bound Workspace Material to worker context.',
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER, MATERIAL_ID_PARAMETER],
          requestSchema: 'RestoreThreadMaterialRequest',
          responseStatus: '200',
          responseSchema: 'RestoreThreadMaterialResponse',
        }),
      },
      '/api/app/workspaces/{workspaceId}/action-center': {
        get: {
          operationId: 'listHumanAttention',
          tags: ['dashboards'],
          summary: 'List unified human attention rows for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Unified human attention rows.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListHumanAttentionResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/capability-usage': {
        get: {
          operationId: 'getCapabilityUsage',
          tags: ['diagnostics'],
          summary: 'Read capability-call and usage evidence for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace capability-call and usage evidence.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/CapabilityUsageResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/audit/events': {
        get: {
          operationId: 'listWorkspaceAuditEvents',
          tags: ['diagnostics'],
          summary: 'Read workspace audit events.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace audit events.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListWorkspaceAuditEventsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/evidence-bundles': {
        get: {
          operationId: 'listWorkspaceEvidenceBundles',
          tags: ['diagnostics'],
          summary: 'Read workspace evidence bundles.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace evidence bundles.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListWorkspaceEvidenceBundlesResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/runtime-evidence': {
        get: {
          operationId: 'listWorkspaceRuntimeEvidence',
          tags: ['diagnostics'],
          summary: 'Read workspace runtime evidence.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace runtime evidence.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListWorkspaceRuntimeEvidenceResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/audit/events': {
        get: {
          operationId: 'listServerAuditEvents',
          tags: ['diagnostics'],
          summary: 'Read server audit events.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Server audit events.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListServerAuditEventsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/permission-decisions': {
        get: {
          operationId: 'listWorkspacePermissionDecisions',
          tags: ['diagnostics'],
          summary: 'Read workspace permission decisions.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace permission decisions.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ListWorkspacePermissionDecisionsResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/permission-decisions': {
        get: {
          operationId: 'listServerPermissionDecisions',
          tags: ['diagnostics'],
          summary: 'Read server permission decisions.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Server permission decisions.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListServerPermissionDecisionsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/proposals/{proposalId}/decision': {
        post: {
          operationId: 'submitKnowledgeProposalDecision',
          tags: ['reviews'],
          summary: 'Record one knowledge proposal review decision.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'proposalId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/SubmitKnowledgeProposalDecisionRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Recorded knowledge proposal review decision.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/SubmitKnowledgeProposalDecisionResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/knowledge/proposals/{proposalId}/reversal': {
        post: {
          operationId: 'reverseKnowledgeProposal',
          tags: ['reviews'],
          summary: 'Remove one unchanged proposal-created Knowledge Page.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'proposalId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/ReverseKnowledgeProposalRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Derived projection after bounded Knowledge Proposal reversal.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ReverseKnowledgeProposalResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/goals/{goalId}/reviews/{reviewId}/decision':
        {
          post: {
            operationId: 'submitGoalReviewDecision',
            tags: ['reviews'],
            summary: 'Resolve one Goal Review attention row.',
            security: [{ bearerAuth: [] }, { sessionCookie: [] }],
            parameters: [
              WORKSPACE_ID_PARAMETER,
              THREAD_ID_PARAMETER,
              {
                name: 'goalId',
                in: 'path',
                required: true,
                schema: { type: 'string', minLength: 1 },
              },
              {
                name: 'reviewId',
                in: 'path',
                required: true,
                schema: { type: 'string', minLength: 1 },
              },
            ],
            requestBody: {
              required: true,
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/SubmitGoalReviewDecisionRequest' },
                },
              },
            },
            responses: {
              '200': {
                description: 'Resolved Goal Review decision.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: { $ref: '#/components/schemas/SubmitGoalReviewDecisionResponse' },
                  },
                },
              },
              default: {
                description: 'Protocol error envelope.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: { $ref: '#/components/schemas/ApiError' },
                  },
                },
              },
            },
          },
        },
      '/api/app/workspaces/{workspaceId}/workspace-sync/reviews': {
        get: {
          operationId: 'listWorkspaceSyncReviews',
          tags: ['workspace-sync'],
          summary: 'List workspace synchronization reviews for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace synchronization reviews.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListWorkspaceSyncReviewsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/workspace-sync/reviews/{reviewId}': {
        get: {
          operationId: 'getWorkspaceSyncReview',
          tags: ['workspace-sync'],
          summary: 'Read one workspace synchronization review.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'reviewId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Workspace synchronization review.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/GetWorkspaceSyncReviewResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/workspace-sync/reviews/{reviewId}/decision': {
        post: {
          operationId: 'submitWorkspaceSyncReviewDecision',
          tags: ['workspace-sync'],
          summary: 'Record one durable workspace synchronization review decision.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'reviewId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/SubmitWorkspaceSyncReviewDecisionRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Recorded durable workspace synchronization review decision.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/SubmitWorkspaceSyncReviewDecisionResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/workspace-sync/input-snapshots': {
        get: {
          operationId: 'listWorkspaceInputSnapshots',
          tags: ['workspace-sync'],
          summary: 'List durable workspace input snapshots for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace input snapshots.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListWorkspaceInputSnapshotsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/workspace-sync/materialization-records': {
        get: {
          operationId: 'listWorkspaceMaterializationRecords',
          tags: ['workspace-sync'],
          summary: 'List durable workspace materialization records for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace materialization records.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ListWorkspaceMaterializationRecordsResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/workspace-sync/backend-handles': {
        get: {
          operationId: 'listBackendWorkspaceHandles',
          tags: ['workspace-sync'],
          summary: 'List durable backend workspace handles for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Backend workspace handles.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListBackendWorkspaceHandlesResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/workspace-sync/output-manifests': {
        get: {
          operationId: 'listWorkerOutputManifests',
          tags: ['workspace-sync'],
          summary: 'List durable worker output manifests for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Worker output manifests.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListWorkerOutputManifestsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/workspace-sync/change-sets': {
        get: {
          operationId: 'listWorkspaceChangeSets',
          tags: ['workspace-sync'],
          summary: 'List durable workspace change sets for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace change sets.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListWorkspaceChangeSetsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/workspace-sync/staged-reviews': {
        get: {
          operationId: 'listStagedWorkspaceReviews',
          tags: ['workspace-sync'],
          summary: 'List durable staged workspace reviews for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Staged workspace reviews.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListStagedWorkspaceReviewsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/workspace-sync/apply-results': {
        get: {
          operationId: 'listWorkspaceApplyResults',
          tags: ['workspace-sync'],
          summary: 'List durable workspace apply results for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace apply results.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListWorkspaceApplyResultsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/workspace-sync/apply-plans': {
        get: {
          operationId: 'listWorkspaceApplyPlans',
          tags: ['workspace-sync'],
          summary: 'List durable workspace apply plans for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace apply plans.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListWorkspaceApplyPlansResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/workspace-sync/reconciliation-records': {
        get: {
          operationId: 'listWorkspaceReconciliationRecords',
          tags: ['workspace-sync'],
          summary: 'List durable workspace reconciliation records for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace reconciliation records.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ListWorkspaceReconciliationRecordsResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/workspace-sync/reconciliation-records/{reconciliationRecordId}/decision':
        {
          post: {
            operationId: 'submitWorkspaceRecoveryDecision',
            tags: ['workspace-sync'],
            summary: 'Record one workspace recovery decision.',
            security: [{ bearerAuth: [] }, { sessionCookie: [] }],
            parameters: [
              WORKSPACE_ID_PARAMETER,
              {
                name: 'reconciliationRecordId',
                in: 'path',
                required: true,
                schema: { type: 'string', minLength: 1 },
              },
            ],
            requestBody: {
              required: true,
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/SubmitWorkspaceRecoveryDecisionRequest',
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Recorded workspace recovery decision.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: {
                      $ref: '#/components/schemas/SubmitWorkspaceRecoveryDecisionResponse',
                    },
                  },
                },
              },
              default: {
                description: 'Protocol error envelope.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: { $ref: '#/components/schemas/ApiError' },
                  },
                },
              },
            },
          },
        },
      '/api/app/workspaces/{workspaceId}/workspace-sync/quarantine-records': {
        get: {
          operationId: 'listWorkspaceQuarantineRecords',
          tags: ['workspace-sync'],
          summary: 'List durable workspace quarantine records for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace quarantine records.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ListWorkspaceQuarantineRecordsResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/workspace-sync/apply-results/{applyResultId}': {
        get: {
          operationId: 'getWorkspaceApplyResult',
          tags: ['workspace-sync'],
          summary: 'Read one durable workspace apply result.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'applyResultId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Workspace apply result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/GetWorkspaceApplyResultResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/agent-environment/snapshots': {
        get: {
          operationId: 'listAgentEnvironmentPackageSnapshots',
          tags: ['agent-environment'],
          summary: 'List durable Agent Environment Package snapshots for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Agent Environment Package snapshots.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ListAgentEnvironmentPackageSnapshotsResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/agent-environment/snapshots/{snapshotId}': {
        get: {
          operationId: 'getAgentEnvironmentPackageSnapshot',
          tags: ['agent-environment'],
          summary: 'Read one durable Agent Environment Package snapshot.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'snapshotId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Agent Environment Package snapshot.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/GetAgentEnvironmentPackageSnapshotResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/data-root/backups': {
        post: {
          operationId: 'createDataRootBackup',
          tags: ['storage'],
          summary: 'Create and verify one server-managed hot data-root backup.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Data-root backup manifest and verification summary.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/DataRootBackupCreateResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/data-root/backups/{backupId}/verify': {
        post: {
          operationId: 'verifyDataRootBackup',
          tags: ['storage'],
          summary: 'Verify one server-managed data-root backup.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'backupId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/DataRootBackupVerifyRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Data-root backup verification summary.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/DataRootBackupVerifyResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/export': {
        post: {
          operationId: 'exportWorkspace',
          tags: ['storage'],
          summary: 'Create and verify one workspace export.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Workspace export manifest and verification summary.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/WorkspaceExportResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspace-imports/dry-run': {
        post: {
          operationId: 'dryRunWorkspaceImport',
          tags: ['storage'],
          summary: 'Verify a server-managed workspace export without importing it.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/WorkspaceImportDryRunRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Workspace import dry-run report.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/WorkspaceImportDryRunResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspace-imports': {
        post: {
          operationId: 'importWorkspace',
          tags: ['storage'],
          summary: 'Import one verified server-managed workspace export.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/WorkspaceImportRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Imported workspace and verification summary.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/WorkspaceImportResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/vault/status': {
        get: {
          operationId: 'getVaultAdminStatus',
          tags: ['vault'],
          summary: 'Read redacted vault backend status.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Redacted vault backend status.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/VaultAdminStatusResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/vault/unlock': {
        post: {
          operationId: 'unlockVaultAdminBackend',
          tags: ['vault'],
          summary: 'Unlock the configured vault backend.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/VaultAdminUnlockRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Redacted vault backend status after unlock.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/VaultAdminUnlockResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/vault/lock': {
        post: {
          operationId: 'lockVaultAdminBackend',
          tags: ['vault'],
          summary: 'Lock the configured vault backend.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Redacted vault backend status after lock.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/VaultAdminLockResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/vault/bootstrap/codex-auth-json': {
        post: {
          operationId: 'bootstrapCodexAuthJsonVaultReference',
          tags: ['vault'],
          summary: 'Store Codex auth JSON in the vault and create its runtime-file grant.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: {
                  $ref: '#/components/schemas/VaultAdminBootstrapCodexAuthJsonRequest',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Redacted Codex auth JSON vault reference and grant metadata.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/VaultAdminBootstrapCodexAuthJsonResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/vault/references/{referenceId}/rebind': {
        post: {
          operationId: 'rebindWorkspaceVaultReference',
          tags: ['vault'],
          summary: 'Rebind one imported workspace vault reference to local secret material.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'referenceId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: {
                  $ref: '#/components/schemas/VaultAdminRebindWorkspaceReferenceRequest',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Redacted rebound workspace vault reference metadata.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/VaultAdminRebindWorkspaceReferenceResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/vault/references': {
        get: {
          operationId: 'listWorkspaceVaultReferences',
          tags: ['vault'],
          summary: 'List redacted workspace vault references.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Redacted workspace vault references.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/VaultAdminListWorkspaceReferencesResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/vault/grants': {
        get: {
          operationId: 'listWorkspaceVaultGrants',
          tags: ['vault'],
          summary: 'List non-secret workspace vault grants.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Non-secret workspace vault grants.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ListWorkspaceVaultGrantsResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/vault/injection-plans': {
        get: {
          operationId: 'listWorkspaceVaultInjectionPlans',
          tags: ['vault'],
          summary: 'List non-secret workspace injection plans.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Non-secret workspace injection plans.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ListWorkspaceVaultInjectionPlansResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/vault/injection-receipts': {
        get: {
          operationId: 'listWorkspaceVaultInjectionReceipts',
          tags: ['vault'],
          summary: 'List non-secret workspace injection receipts.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Non-secret workspace injection receipts.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ListWorkspaceVaultInjectionReceiptsResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/vault/use-records': {
        get: {
          operationId: 'listWorkspaceVaultUseRecords',
          tags: ['vault'],
          summary: 'List redacted workspace vault use records.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Redacted workspace vault use records.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ListWorkspaceVaultUseRecordsResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/vault/use-records': {
        get: {
          operationId: 'listServerVaultUseRecords',
          tags: ['vault'],
          summary: 'List redacted server vault use records.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Redacted server vault use records.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ListServerVaultUseRecordsResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/repositories': {
        get: {
          operationId: 'listWorkspaceRepositories',
          tags: ['repositories'],
          summary: 'List redacted repository resources for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Redacted repository resources and default repository.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListWorkspaceRepositoriesResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/repositories/diagnostics': {
        get: {
          operationId: 'getWorkspaceRepositoryDiagnostics',
          tags: ['repositories'],
          summary: 'Read redacted repository diagnostics for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Redacted repository readiness diagnostics.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/WorkspaceRepositoryDiagnosticsResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/repositories/default': {
        put: {
          operationId: 'setDefaultWorkspaceRepository',
          tags: ['repositories'],
          summary: 'Create or update the default repository resource for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/SetWorkspaceRepositoryRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Redacted repository resource read model.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/SetWorkspaceRepositoryResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/repositories/git-push-records': {
        get: {
          operationId: 'listGitPushRecords',
          tags: ['repositories'],
          summary: 'List durable Git push records for one workspace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Redacted Git push records.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListGitPushRecordsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/repositories/git-push-records/{pushRecordId}': {
        get: {
          operationId: 'getGitPushRecord',
          tags: ['repositories'],
          summary: 'Read one durable Git push record.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'pushRecordId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Redacted Git push record.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/GetGitPushRecordResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/repositories/{resourceId}/git-push/approval': {
        post: {
          operationId: 'requestGitPushApproval',
          tags: ['repositories'],
          summary: 'Open one approval gate for a repository Git push.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'resourceId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/RequestGitPushApprovalRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Created approval gate and linked policy decision ids.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/RequestGitPushApprovalResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/repositories/{resourceId}/git-push': {
        post: {
          operationId: 'executeGitPush',
          tags: ['repositories'],
          summary: 'Execute one approved repository Git push.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'resourceId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/ExecuteGitPushRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Durable Git push attempt record.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ExecuteGitPushResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApiError' },
                },
              },
            },
          },
        },
      },
    } as const,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'okt',
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'better-auth.session_token',
        },
      },
      schemas: {
        AbortNanoHostTransportRotationResponse: toJsonSchema(
          AbortNanoHostTransportRotationResponseSchema
        ),
        AcceptWorkspaceInvitationRequest: toJsonSchema(AcceptWorkspaceInvitationRequestSchema),
        ChangeWorkspaceMemberAccessRequest: toJsonSchema(ChangeWorkspaceMemberAccessRequestSchema),
        CreateWorkspaceInvitationRequest: toJsonSchema(CreateWorkspaceInvitationRequestSchema),
        DeclineWorkspaceInvitationRequest: toJsonSchema(DeclineWorkspaceInvitationRequestSchema),
        DisableUserRequest: toJsonSchema(DisableUserRequestSchema),
        DisableUserResponse: toJsonSchema(DisableUserResponseSchema),
        LeaveWorkspaceRequest: toJsonSchema(LeaveWorkspaceRequestSchema),
        ListAuthorizedWorkspacesResponse: toJsonSchema(ListAuthorizedWorkspacesResponseSchema),
        ListWorkspaceInvitationsResponse: toJsonSchema(ListWorkspaceInvitationsResponseSchema),
        ListWorkspaceMembersResponse: toJsonSchema(ListWorkspaceMembersResponseSchema),
        RecoverWorkspaceAccessRequest: toJsonSchema(RecoverWorkspaceAccessRequestSchema),
        RemoveWorkspaceMemberRequest: toJsonSchema(RemoveWorkspaceMemberRequestSchema),
        RevokeWorkspaceInvitationRequest: toJsonSchema(RevokeWorkspaceInvitationRequestSchema),
        TransferWorkspaceOwnershipRequest: toJsonSchema(TransferWorkspaceOwnershipRequestSchema),
        WorkspaceAccessRecoveryResponse: toJsonSchema(WorkspaceAccessRecoveryResponseSchema),
        WorkspaceInvitationMutationResponse: toJsonSchema(
          WorkspaceInvitationMutationResponseSchema
        ),
        WorkspaceMemberMutationResponse: toJsonSchema(WorkspaceMemberMutationResponseSchema),
        WorkspaceOwnershipMutationResponse: toJsonSchema(WorkspaceOwnershipMutationResponseSchema),
        AgentId: toJsonSchema(AgentIdSchema),
        ApiError: toJsonSchema(ApiErrorSchema),
        AgentHealthRefreshResponse: toJsonSchema(AgentHealthRefreshResponseSchema),
        ArtifactId: toJsonSchema(ArtifactIdSchema),
        BindThreadMaterialRequest: toJsonSchema(BindThreadMaterialRequestSchema),
        BindThreadMaterialResponse: toJsonSchema(BindThreadMaterialResponseSchema),
        CreateWorkspaceMaterialRequest: toJsonSchema(CreateWorkspaceMaterialRequestSchema),
        CreateWorkspaceMaterialResponse: toJsonSchema(CreateWorkspaceMaterialResponseSchema),
        ExcludeThreadMaterialRequest: toJsonSchema(ExcludeThreadMaterialRequestSchema),
        ExcludeThreadMaterialResponse: toJsonSchema(ExcludeThreadMaterialResponseSchema),
        GetThreadMaterialResponse: toJsonSchema(GetThreadMaterialResponseSchema),
        GetWorkspaceMaterialResponse: toJsonSchema(GetWorkspaceMaterialResponseSchema),
        GetWorkspaceMaterialRevisionResponse: toJsonSchema(
          GetWorkspaceMaterialRevisionResponseSchema
        ),
        ImportWorkspaceArtifactRequest: toJsonSchema(ImportWorkspaceArtifactRequestSchema),
        ImportWorkspaceArtifactResponse: toJsonSchema(ImportWorkspaceArtifactResponseSchema),
        IntroduceWorkspaceArtifactRequest: toJsonSchema(IntroduceWorkspaceArtifactRequestSchema),
        IntroduceWorkspaceArtifactResponse: toJsonSchema(IntroduceWorkspaceArtifactResponseSchema),
        ListArtifactReviewsResponse: toJsonSchema(ListArtifactReviewsResponseSchema),
        ListWorkspaceMaterialRevisionsResponse: toJsonSchema(
          ListWorkspaceMaterialRevisionsResponseSchema
        ),
        ListWorkspaceMaterialsResponse: toJsonSchema(ListWorkspaceMaterialsResponseSchema),
        RestoreThreadMaterialRequest: toJsonSchema(RestoreThreadMaterialRequestSchema),
        RestoreThreadMaterialResponse: toJsonSchema(RestoreThreadMaterialResponseSchema),
        SaveWorkspaceMaterialRevisionRequest: toJsonSchema(
          SaveWorkspaceMaterialRevisionRequestSchema
        ),
        SaveWorkspaceMaterialRevisionResponse: toJsonSchema(
          SaveWorkspaceMaterialRevisionResponseSchema
        ),
        SubmitArtifactReviewDecisionRequest: toJsonSchema(
          SubmitArtifactReviewDecisionRequestSchema
        ),
        SubmitArtifactReviewDecisionResponse: toJsonSchema(
          SubmitArtifactReviewDecisionResponseSchema
        ),
        UnbindThreadMaterialRequest: toJsonSchema(UnbindThreadMaterialRequestSchema),
        UnbindThreadMaterialResponse: toJsonSchema(UnbindThreadMaterialResponseSchema),
        AppDiagnosticsResponse: toJsonSchema(AppDiagnosticsResponseSchema),
        AppSearchResponse: toJsonSchema(AppSearchResponseSchema),
        ApproveThreadGoalPlanRequest: toJsonSchema(ApproveThreadGoalPlanRequestSchema),
        ApproveThreadGoalPlanResponse: toJsonSchema(ApproveThreadGoalPlanResponseSchema),
        AutomationRecord: toJsonSchema(AutomationRecordSchema),
        CancelProviderSubscriptionAccountLoginRequest: toJsonSchema(
          CancelProviderSubscriptionAccountLoginRequestSchema
        ),
        CapabilityUsageResponse: toJsonSchema(CapabilityUsageResponseSchema),
        RetryInterruptedWorkerCheckpointRequest: toJsonSchema(
          RetryInterruptedWorkerCheckpointRequestSchema
        ),
        RetryInterruptedWorkerCheckpointResponse: toJsonSchema(
          RetryInterruptedWorkerCheckpointResponseSchema
        ),
        RetrySchedulerAdmissionResponse: toJsonSchema(RetrySchedulerAdmissionResponseSchema),
        CancelSchedulerAdmissionResponse: toJsonSchema(CancelSchedulerAdmissionResponseSchema),
        ConsumeOpenKitBootstrapTokenRequest: toJsonSchema(
          ConsumeOpenKitBootstrapTokenRequestSchema
        ),
        ConsumeOpenKitBootstrapTokenResponse: toJsonSchema(
          ConsumeOpenKitBootstrapTokenResponseSchema
        ),
        CreateAutomationRequest: toJsonSchema(CreateAutomationRequestSchema),
        CreateOpenKitAccessTokenRequest: toJsonSchema(CreateOpenKitAccessTokenRequestSchema),
        CreateOpenKitAccessTokenResponse: toJsonSchema(CreateOpenKitAccessTokenResponseSchema),
        CreateProviderSubscriptionAccountRequest: toJsonSchema(
          CreateProviderSubscriptionAccountRequestSchema
        ),
        CreateThreadGoalPlanRequest: toJsonSchema(CreateThreadGoalPlanRequestSchema),
        CreateThreadGoalPlanResponse: toJsonSchema(CreateThreadGoalPlanResponseSchema),
        DataRootBackupCreateResponse: toJsonSchema(DataRootBackupCreateResponseSchema),
        DataRootBackupVerifyRequest: toJsonSchema(DataRootBackupVerifyRequestSchema),
        DataRootBackupVerifyResponse: toJsonSchema(DataRootBackupVerifyResponseSchema),
        DecommissionNanoHostResponse: toJsonSchema(DecommissionNanoHostResponseSchema),
        EnrollNanoHostRequest: toJsonSchema(EnrollNanoHostRequestSchema),
        EnrollNanoHostResponse: toJsonSchema(EnrollNanoHostResponseSchema),
        ExecuteGitPushRequest: toJsonSchema(ExecuteGitPushRequestSchema),
        ExecuteGitPushResponse: toJsonSchema(ExecuteGitPushResponseSchema),
        GetAgentCatalogEntryResponse: toJsonSchema(GetAgentCatalogEntryResponseSchema),
        GetAgentEnvironmentPackageSnapshotResponse: toJsonSchema(
          GetAgentEnvironmentPackageSnapshotResponseSchema
        ),
        GetGitPushRecordResponse: toJsonSchema(GetGitPushRecordResponseSchema),
        GetWorkspaceApplyResultResponse: toJsonSchema(GetWorkspaceApplyResultResponseSchema),
        GetWorkspaceSyncReviewResponse: toJsonSchema(GetWorkspaceSyncReviewResponseSchema),
        IssueNanoHostTransportTokenRequest: toJsonSchema(IssueNanoHostTransportTokenRequestSchema),
        IssueNanoHostTransportTokenResponse: toJsonSchema(
          IssueNanoHostTransportTokenResponseSchema
        ),
        KnowledgeDerivedIndexesResponse: toJsonSchema(KnowledgeDerivedIndexesResponseSchema),
        KnowledgeRetrievalResponse: toJsonSchema(KnowledgeRetrievalResponseSchema),
        KnowledgeManagerAnswerRequest: toJsonSchema(KnowledgeManagerAnswerRequestSchema),
        KnowledgeManagerAnswerResponse: toJsonSchema(KnowledgeManagerAnswerResponseSchema),
        KnowledgeManagerDraftProposalRequest: toJsonSchema(
          KnowledgeManagerDraftProposalRequestSchema
        ),
        KnowledgeManagerDraftProposalResponse: toJsonSchema(
          KnowledgeManagerDraftProposalResponseSchema
        ),
        KnowledgeManagerHealthCheckRequest: toJsonSchema(KnowledgeManagerHealthCheckRequestSchema),
        KnowledgeManagerHealthCheckResponse: toJsonSchema(
          KnowledgeManagerHealthCheckResponseSchema
        ),
        KnowledgeManagerPrepareContextRequest: toJsonSchema(
          KnowledgeManagerPrepareContextRequestSchema
        ),
        KnowledgeManagerPrepareContextResponse: toJsonSchema(
          KnowledgeManagerPrepareContextResponseSchema
        ),
        KnowledgeManagerSuggestRepairRequest: toJsonSchema(
          KnowledgeManagerSuggestRepairRequestSchema
        ),
        KnowledgeManagerSuggestRepairResponse: toJsonSchema(
          KnowledgeManagerSuggestRepairResponseSchema
        ),
        ListAgentCatalogResponse: toJsonSchema(ListAgentCatalogResponseSchema),
        ListAgentEnvironmentPackageSnapshotsResponse: toJsonSchema(
          ListAgentEnvironmentPackageSnapshotsResponseSchema
        ),
        ListKnowledgeClaimsResponse: toJsonSchema(ListKnowledgeClaimsResponseSchema),
        ListKnowledgeConflictsResponse: toJsonSchema(ListKnowledgeConflictsResponseSchema),
        ListKnowledgeObservationsResponse: toJsonSchema(ListKnowledgeObservationsResponseSchema),
        ListKnowledgeSourcesResponse: toJsonSchema(ListKnowledgeSourcesResponseSchema),
        ListHumanAttentionResponse: toJsonSchema(ListHumanAttentionResponseSchema),
        ListGitPushRecordsResponse: toJsonSchema(ListGitPushRecordsResponseSchema),
        ListInterruptedWorkerStatesResponse: toJsonSchema(
          ListInterruptedWorkerStatesResponseSchema
        ),
        ListNanoHostTransportTokensResponse: toJsonSchema(
          ListNanoHostTransportTokensResponseSchema
        ),
        NanoHostRuntimeTargetStatusResponse: toJsonSchema(
          NanoHostRuntimeTargetStatusResponseSchema
        ),
        ListOpenKitAccessTokensResponse: toJsonSchema(ListOpenKitAccessTokensResponseSchema),
        ListSchedulerAdmissionsResponse: toJsonSchema(ListSchedulerAdmissionsResponseSchema),
        ListServerAuditEventsResponse: toJsonSchema(ListServerAuditEventsResponseSchema),
        ListServerPermissionDecisionsResponse: toJsonSchema(
          ListServerPermissionDecisionsResponseSchema
        ),
        ListServerVaultUseRecordsResponse: toJsonSchema(ListServerVaultUseRecordsResponseSchema),
        ListWorkspaceAuditEventsResponse: toJsonSchema(ListWorkspaceAuditEventsResponseSchema),
        ListWorkspaceEvidenceBundlesResponse: toJsonSchema(
          ListWorkspaceEvidenceBundlesResponseSchema
        ),
        ListWorkspaceVaultGrantsResponse: toJsonSchema(ListWorkspaceVaultGrantsResponseSchema),
        ListWorkspaceVaultInjectionPlansResponse: toJsonSchema(
          ListWorkspaceVaultInjectionPlansResponseSchema
        ),
        ListWorkspaceVaultInjectionReceiptsResponse: toJsonSchema(
          ListWorkspaceVaultInjectionReceiptsResponseSchema
        ),
        ListWorkspaceRuntimeEvidenceResponse: toJsonSchema(
          ListWorkspaceRuntimeEvidenceResponseSchema
        ),
        ListWorkspacePermissionDecisionsResponse: toJsonSchema(
          ListWorkspacePermissionDecisionsResponseSchema
        ),
        ListThreadItemsResponse: toJsonSchema(ListThreadItemsResponseSchema),
        ListAutomationsResponse: toJsonSchema(ListAutomationsResponseSchema),
        ListStagedWorkspaceReviewsResponse: toJsonSchema(ListStagedWorkspaceReviewsResponseSchema),
        ListWorkspaceApplyPlansResponse: toJsonSchema(ListWorkspaceApplyPlansResponseSchema),
        ListWorkspaceReconciliationRecordsResponse: toJsonSchema(
          ListWorkspaceReconciliationRecordsResponseSchema
        ),
        ListWorkspaceQuarantineRecordsResponse: toJsonSchema(
          ListWorkspaceQuarantineRecordsResponseSchema
        ),
        ListWorkspaceApplyResultsResponse: toJsonSchema(ListWorkspaceApplyResultsResponseSchema),
        ListWorkspaceChangeSetsResponse: toJsonSchema(ListWorkspaceChangeSetsResponseSchema),
        ListWorkspaceInputSnapshotsResponse: toJsonSchema(
          ListWorkspaceInputSnapshotsResponseSchema
        ),
        ListWorkspaceMaterializationRecordsResponse: toJsonSchema(
          ListWorkspaceMaterializationRecordsResponseSchema
        ),
        ListBackendWorkspaceHandlesResponse: toJsonSchema(
          ListBackendWorkspaceHandlesResponseSchema
        ),
        ListWorkerOutputManifestsResponse: toJsonSchema(ListWorkerOutputManifestsResponseSchema),
        ListWorkspaceRepositoriesResponse: toJsonSchema(ListWorkspaceRepositoriesResponseSchema),
        ListWorkspaceSyncReviewsResponse: toJsonSchema(ListWorkspaceSyncReviewsResponseSchema),
        ListWorkspaceVaultUseRecordsResponse: toJsonSchema(
          ListWorkspaceVaultUseRecordsResponseSchema
        ),
        SubmitWorkspaceSyncReviewDecisionRequest: toJsonSchema(
          SubmitWorkspaceSyncReviewDecisionRequestSchema
        ),
        SubmitWorkspaceSyncReviewDecisionResponse: toJsonSchema(
          SubmitWorkspaceSyncReviewDecisionResponseSchema
        ),
        SubmitWorkspaceRecoveryDecisionRequest: toJsonSchema(
          SubmitWorkspaceRecoveryDecisionRequestSchema
        ),
        SubmitWorkspaceRecoveryDecisionResponse: toJsonSchema(
          SubmitWorkspaceRecoveryDecisionResponseSchema
        ),
        QuickChatRequest: toJsonSchema(QuickChatRequestSchema),
        QuickChatResponse: toJsonSchema(QuickChatResponseSchema),
        RequestGitPushApprovalRequest: toJsonSchema(RequestGitPushApprovalRequestSchema),
        RequestGitPushApprovalResponse: toJsonSchema(RequestGitPushApprovalResponseSchema),
        ReadKnowledgeSourceResponse: toJsonSchema(ReadKnowledgeSourceResponseSchema),
        RecordKnowledgeClaimRequest: toJsonSchema(RecordKnowledgeClaimRequestSchema),
        RecordKnowledgeClaimResponse: toJsonSchema(RecordKnowledgeClaimResponseSchema),
        RecordKnowledgeConflictRequest: toJsonSchema(RecordKnowledgeConflictRequestSchema),
        RecordKnowledgeConflictResponse: toJsonSchema(RecordKnowledgeConflictResponseSchema),
        ResolveKnowledgeConflictRequest: toJsonSchema(ResolveKnowledgeConflictRequestSchema),
        ResolveKnowledgeConflictResponse: toJsonSchema(ResolveKnowledgeConflictResponseSchema),
        RecordKnowledgeObservationRequest: toJsonSchema(RecordKnowledgeObservationRequestSchema),
        RecordKnowledgeObservationResponse: toJsonSchema(RecordKnowledgeObservationResponseSchema),
        RegisterKnowledgeSourceRequest: toJsonSchema(RegisterKnowledgeSourceRequestSchema),
        RegisterKnowledgeSourceResponse: toJsonSchema(RegisterKnowledgeSourceResponseSchema),
        RetrieveKnowledgeRequest: toJsonSchema(RetrieveKnowledgeRequestSchema),
        PauseThreadGoalRequest: toJsonSchema(PauseThreadGoalRequestSchema),
        PauseThreadGoalResponse: toJsonSchema(PauseThreadGoalResponseSchema),
        ProviderSubscriptionAccount: toJsonSchema(ProviderSubscriptionAccountSchema),
        ProviderSubscriptionAccountsResponse: toJsonSchema(
          ProviderSubscriptionAccountsResponseSchema
        ),
        ProviderSubscriptionQuota: toJsonSchema(ProviderSubscriptionQuotaSchema),
        ProviderSubscriptionsResponse: toJsonSchema(ProviderSubscriptionsResponseSchema),
        ReviseThreadGoalPlanRequest: toJsonSchema(ReviseThreadGoalPlanRequestSchema),
        ReviseThreadGoalPlanResponse: toJsonSchema(ReviseThreadGoalPlanResponseSchema),
        ResumeThreadGoalRequest: toJsonSchema(ResumeThreadGoalRequestSchema),
        ResumeThreadGoalResponse: toJsonSchema(ResumeThreadGoalResponseSchema),
        RevokeNanoHostTransportTokenResponse: toJsonSchema(
          RevokeNanoHostTransportTokenResponseSchema
        ),
        RevokeOpenKitAccessTokenResponse: toJsonSchema(RevokeOpenKitAccessTokenResponseSchema),
        RotateNanoHostTransportTokenRequest: toJsonSchema(
          RotateNanoHostTransportTokenRequestSchema
        ),
        RotateNanoHostTransportTokenResponse: toJsonSchema(
          RotateNanoHostTransportTokenResponseSchema
        ),
        RotateOpenKitAccessTokenRequest: toJsonSchema(RotateOpenKitAccessTokenRequestSchema),
        RotateOpenKitAccessTokenResponse: toJsonSchema(RotateOpenKitAccessTokenResponseSchema),
        RuntimeConfigFileListResponse: toJsonSchema(RuntimeConfigFileListResponseSchema),
        RuntimeConfigFileReadResponse: toJsonSchema(RuntimeConfigFileReadResponseSchema),
        RuntimeConfigFileWriteRequest: toJsonSchema(RuntimeConfigFileWriteRequestSchema),
        RuntimeConfigFileWriteResponse: toJsonSchema(RuntimeConfigFileWriteResponseSchema),
        RuntimeConfigReloadRequest: toJsonSchema(RuntimeConfigReloadRequestSchema),
        RuntimeConfigReloadResponse: toJsonSchema(RuntimeConfigReloadResponseSchema),
        RuntimeConfigSchemaCatalogResponse: toJsonSchema(RuntimeConfigSchemaCatalogResponseSchema),
        RuntimeConfigValidationRequest: toJsonSchema(RuntimeConfigValidationRequestSchema),
        RuntimeConfigValidationResponse: toJsonSchema(RuntimeConfigValidationResponseSchema),
        RunThreadGoalStepRequest: toJsonSchema(RunThreadGoalStepRequestSchema),
        RunThreadGoalStepResponse: toJsonSchema(RunThreadGoalStepResponseSchema),
        SetWorkspaceRepositoryRequest: toJsonSchema(SetWorkspaceRepositoryRequestSchema),
        SetWorkspaceRepositoryResponse: toJsonSchema(SetWorkspaceRepositoryResponseSchema),
        SetupDiagnosticsResponse: toJsonSchema(SetupDiagnosticsResponseSchema),
        StartChatModeRequest: toJsonSchema(StartChatModeRequestSchema),
        StartChatModeResponse: toJsonSchema(StartChatModeResponseSchema),
        StartProviderSubscriptionAccountLoginRequest: toJsonSchema(
          StartProviderSubscriptionAccountLoginRequestSchema
        ),
        StartTaskModeRequest: toJsonSchema(StartTaskModeRequestSchema),
        StartTaskModeResponse: toJsonSchema(StartTaskModeResponseSchema),
        StartThreadGoalRequest: toJsonSchema(StartThreadGoalRequestSchema),
        StartThreadGoalResponse: toJsonSchema(StartThreadGoalResponseSchema),
        StorageLayoutReportResponse: toJsonSchema(StorageLayoutReportResponseSchema),
        CancelGoalSteeringRequest: toJsonSchema(CancelGoalSteeringRequestSchema),
        CancelGoalSteeringResponse: toJsonSchema(CancelGoalSteeringResponseSchema),
        ConvertGoalSteeringToFollowUpRequest: toJsonSchema(
          ConvertGoalSteeringToFollowUpRequestSchema
        ),
        ConvertGoalSteeringToFollowUpResponse: toJsonSchema(
          ConvertGoalSteeringToFollowUpResponseSchema
        ),
        SubmitGoalReviewDecisionRequest: toJsonSchema(SubmitGoalReviewDecisionRequestSchema),
        SubmitGoalReviewDecisionResponse: toJsonSchema(SubmitGoalReviewDecisionResponseSchema),
        SubmitKnowledgeProposalDecisionRequest: toJsonSchema(
          SubmitKnowledgeProposalDecisionRequestSchema
        ),
        SubmitKnowledgeProposalDecisionResponse: toJsonSchema(
          SubmitKnowledgeProposalDecisionResponseSchema
        ),
        ReverseKnowledgeProposalRequest: toJsonSchema(ReverseKnowledgeProposalRequestSchema),
        ReverseKnowledgeProposalResponse: toJsonSchema(ReverseKnowledgeProposalResponseSchema),
        SubmitThreadGoalSteeringRequest: toJsonSchema(SubmitThreadGoalSteeringRequestSchema),
        SubmitThreadGoalSteeringResponse: toJsonSchema(SubmitThreadGoalSteeringResponseSchema),
        SubmitTurnFeedbackRequest: toJsonSchema(SubmitTurnFeedbackRequestSchema),
        ThreadDashboardResponse: toJsonSchema(ThreadDashboardResponseSchema),
        ThreadId: toJsonSchema(ThreadIdSchema),
        ThreadGoalSummaryResponse: toJsonSchema(ThreadGoalSummaryResponseSchema),
        TurnId: toJsonSchema(TurnIdSchema),
        TurnFeedbackResponse: toJsonSchema(TurnFeedbackResponseSchema),
        UpdateAutomationRequest: toJsonSchema(UpdateAutomationRequestSchema),
        UpdateProviderSubscriptionAccountRequest: toJsonSchema(
          UpdateProviderSubscriptionAccountRequestSchema
        ),
        VaultAdminBootstrapCodexAuthJsonRequest: toJsonSchema(
          VaultAdminBootstrapCodexAuthJsonRequestSchema
        ),
        VaultAdminBootstrapCodexAuthJsonResponse: toJsonSchema(
          VaultAdminBootstrapCodexAuthJsonResponseSchema
        ),
        VaultAdminListWorkspaceReferencesResponse: toJsonSchema(
          VaultAdminListWorkspaceReferencesResponseSchema
        ),
        VaultAdminLockResponse: toJsonSchema(VaultAdminLockResponseSchema),
        VaultAdminRebindWorkspaceReferenceRequest: toJsonSchema(
          VaultAdminRebindWorkspaceReferenceRequestSchema
        ),
        VaultAdminRebindWorkspaceReferenceResponse: toJsonSchema(
          VaultAdminRebindWorkspaceReferenceResponseSchema
        ),
        VaultAdminStatusResponse: toJsonSchema(VaultAdminStatusResponseSchema),
        VaultAdminUnlockRequest: toJsonSchema(VaultAdminUnlockRequestSchema),
        VaultAdminUnlockResponse: toJsonSchema(VaultAdminUnlockResponseSchema),
        WorkspaceExportResponse: toJsonSchema(WorkspaceExportResponseSchema),
        WorkspaceImportDryRunRequest: toJsonSchema(WorkspaceImportDryRunRequestSchema),
        WorkspaceImportDryRunResponse: toJsonSchema(WorkspaceImportDryRunResponseSchema),
        WorkspaceImportRequest: toJsonSchema(WorkspaceImportRequestSchema),
        WorkspaceImportResponse: toJsonSchema(WorkspaceImportResponseSchema),
        WorkspaceDashboardResponse: toJsonSchema(WorkspaceDashboardResponseSchema),
        WorkspaceId: toJsonSchema(WorkspaceIdSchema),
        WorkspaceRepositoryDiagnosticsResponse: toJsonSchema(
          WorkspaceRepositoryDiagnosticsResponseSchema
        ),
      },
    },
  } satisfies Omit<AppOpenApiDocument, 'x-openkit-source-digest'>;

  return {
    ...document,
    'x-openkit-source-digest': digestOpenApiSource(document),
  };
}

/** Process-wide OpenAPI projection reused by runtime registration and document serving. */
export const APP_OPENAPI_DOCUMENT = createAppOpenApiDocument();

/**
 * Converts a Zod schema into the JSON Schema fragment embedded in OpenAPI.
 *
 * @param schema - Source Zod schema from a shared contract package.
 * @returns JSON Schema projection for the source schema.
 */
function toJsonSchema(schema: z.ZodType): JsonValue {
  return z.toJSONSchema(schema) as JsonValue;
}

/**
 * Converts a shared Zod schema into an inline OpenAPI schema fragment.
 *
 * @param schema - Source Zod schema from a shared contract package.
 * @returns JSON Schema projection without the root dialect declaration.
 */
function toInlineJsonSchema(schema: z.ZodType): JsonValue {
  const projection = z.toJSONSchema(schema);
  delete projection.$schema;
  return projection as JsonValue;
}

/**
 * Computes a stable source digest for the generated OpenAPI projection.
 *
 * @param document - Generated document content before the digest extension is added.
 * @returns SHA-256 digest that changes when version, route, or schema projection changes.
 */
function digestOpenApiSource(
  document: Omit<AppOpenApiDocument, 'x-openkit-source-digest'>
): string {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        components: document.components,
        info: document.info,
        openapi: document.openapi,
        paths: document.paths,
        protocolVersion: document['x-openkit-protocol-version'],
      })
    )
    .digest('hex')}`;
}
