import { createHash } from 'node:crypto';

import {
  AgentHealthRefreshResponseSchema,
  AppDiagnosticsResponseSchema,
  ApproveThreadGoalPlanRequestSchema,
  ApproveThreadGoalPlanResponseSchema,
  AppSearchResponseSchema,
  AutomationRecordSchema,
  CancelOpenAICodexOAuthRequestSchema,
  CancelRecoveryPendingUserTurnResponseSchema,
  CancelSchedulerAdmissionResponseSchema,
  CapabilityUsageResponseSchema,
  ClearInterruptedWorkerCheckpointRequestSchema,
  ClearInterruptedWorkerCheckpointResponseSchema,
  CodexOAuthAccountSummarySchema,
  CodexOAuthAccountsPayloadSchema,
  CodexOAuthStatusPayloadSchema,
  ConsumeOpenKitBootstrapTokenRequestSchema,
  ConsumeOpenKitBootstrapTokenResponseSchema,
  ConvertRecoveryPendingUserTurnToFollowUpResponseSchema,
  CreateAutomationRequestSchema,
  CreateInterruptedRecoveryStateResponseSchema,
  CreateOpenAICodexOAuthAccountRequestSchema,
  CreateOpenKitAccessTokenRequestSchema,
  CreateOpenKitAccessTokenResponseSchema,
  CreateThreadGoalPlanResponseSchema,
  DataRootBackupCreateResponseSchema,
  DataRootBackupVerifyRequestSchema,
  DataRootBackupVerifyResponseSchema,
  EditRecoveryPendingUserTurnRequestSchema,
  EditRecoveryPendingUserTurnResponseSchema,
  ExecuteGitPushRequestSchema,
  ExecuteGitPushResponseSchema,
  GetAgentCatalogEntryResponseSchema,
  GetAgentEnvironmentPackageSnapshotResponseSchema,
  GetGitPushRecordResponseSchema,
  GetWorkspaceApplyResultResponseSchema,
  GetWorkspaceSyncReviewResponseSchema,
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
  ListAgentCatalogResponseSchema,
  ListAgentEnvironmentPackageSnapshotsResponseSchema,
  ListAutomationsResponseSchema,
  ListBackendWorkspaceHandlesResponseSchema,
  ListGitPushRecordsResponseSchema,
  ListHumanAttentionResponseSchema,
  ListInterruptedWorkerStatesResponseSchema,
  ListKnowledgeClaimsResponseSchema,
  ListKnowledgeConflictsResponseSchema,
  ListKnowledgeObservationsResponseSchema,
  ListKnowledgeSourcesResponseSchema,
  ListOpenKitAccessTokensResponseSchema,
  ListRecoveryPendingUserTurnsResponseSchema,
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
  ListWorkspaceInjectionPlansResponseSchema,
  ListWorkspaceInjectionReceiptsResponseSchema,
  ListWorkspaceInputSnapshotsResponseSchema,
  ListWorkspaceMaterializationRecordsResponseSchema,
  ListWorkspacePermissionDecisionsResponseSchema,
  ListWorkspaceQuarantineRecordsResponseSchema,
  ListWorkspaceReconciliationRecordsResponseSchema,
  ListWorkspaceRepositoriesResponseSchema,
  ListWorkspaceRuntimeEvidenceResponseSchema,
  ListWorkspaceSyncReviewsResponseSchema,
  ListWorkspaceVaultGrantsResponseSchema,
  ListWorkspaceVaultUseRecordsResponseSchema,
  MaterializeKnowledgeContextPackageResponseSchema,
  PauseThreadGoalResponseSchema,
  PromoteKnowledgeClaimRequestSchema,
  PromoteKnowledgeClaimResponseSchema,
  PromoteRecoveryPendingUserTurnToInterruptResponseSchema,
  QueueAgentSessionTerminalCommandRequestSchema,
  QueueAgentSessionTerminalCommandResponseSchema,
  QuickChatRequestSchema,
  QuickChatResponseSchema,
  ReadKnowledgeManagerContextPackageTraceResponseSchema,
  ReadKnowledgeSourceResponseSchema,
  RecordKnowledgeClaimRequestSchema,
  RecordKnowledgeClaimResponseSchema,
  RecordKnowledgeConflictRequestSchema,
  RecordKnowledgeConflictResponseSchema,
  RecordKnowledgeObservationRequestSchema,
  RecordKnowledgeObservationResponseSchema,
  RegisterKnowledgeSourceRequestSchema,
  RegisterKnowledgeSourceResponseSchema,
  RequestGitPushApprovalRequestSchema,
  RequestGitPushApprovalResponseSchema,
  ResolveKnowledgeConflictRequestSchema,
  ResolveKnowledgeConflictResponseSchema,
  RestartRuntimeConfigStaleSessionResponseSchema,
  ResumeThreadGoalResponseSchema,
  RetrieveKnowledgeRequestSchema,
  RetryInterruptedWorkerCheckpointResponseSchema,
  RetrySchedulerAdmissionResponseSchema,
  ReviseThreadGoalPlanRequestSchema,
  ReviseThreadGoalPlanResponseSchema,
  RevokeOpenKitAccessTokenResponseSchema,
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
  SetupDiagnosticsResponseSchema,
  SetWorkspaceRepositoryRequestSchema,
  SetWorkspaceRepositoryResponseSchema,
  StartChatModeRequestSchema,
  StartChatModeResponseSchema,
  StartOpenAICodexOAuthRequestSchema,
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
  ThreadDashboardResponseSchema,
  ThreadGoalSummaryResponseSchema,
  TurnFeedbackResponseSchema,
  UpdateAutomationRequestSchema,
  UpdateOpenAICodexOAuthAccountRequestSchema,
  VaultAdminBootstrapCodexAuthJsonRequestSchema,
  VaultAdminBootstrapCodexAuthJsonResponseSchema,
  VaultAdminListWorkspaceReferencesResponseSchema,
  VaultAdminLockResponseSchema,
  VaultAdminRebindWorkspaceReferenceRequestSchema,
  VaultAdminRebindWorkspaceReferenceResponseSchema,
  VaultAdminStatusResponseSchema,
  VaultAdminUnlockRequestSchema,
  VaultAdminUnlockResponseSchema,
  WorkspaceDashboardResponseSchema,
  WorkspaceExportResponseSchema,
  WorkspaceImportDryRunRequestSchema,
  WorkspaceImportDryRunResponseSchema,
  WorkspaceImportRequestSchema,
  WorkspaceImportResponseSchema,
  WorkspaceRepositoryDiagnosticsResponseSchema,
} from '@openkit/app-api-schemas';
import {
  AgentIdSchema,
  AgentSessionIdSchema,
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
      '/api/app/workspaces/{workspaceId}/runtime-config/stale-sessions/{sessionId}/restart': {
        post: {
          operationId: 'restartRuntimeConfigStaleSession',
          tags: ['runtime-config'],
          summary: 'Retire a stale runtime config worker session.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'sessionId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Stale runtime config session restart result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/RestartRuntimeConfigStaleSessionResponse',
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
      '/api/app/oauth/openai-codex/accounts': {
        get: {
          operationId: 'listOpenAICodexOAuthAccounts',
          tags: ['oauth'],
          summary: 'List server-owned OpenAI Codex OAuth account slots.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          responses: {
            '200': {
              description: 'Sanitized OpenAI Codex OAuth account slots.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/CodexOAuthAccountsPayload' },
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
          operationId: 'createOpenAICodexOAuthAccount',
          tags: ['oauth'],
          summary: 'Create one server-owned OpenAI Codex OAuth account slot.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/CreateOpenAICodexOAuthAccountRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Created OpenAI Codex OAuth account slot.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/CodexOAuthAccountSummary' },
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
      '/api/app/oauth/openai-codex/accounts/{accountSlotId}': {
        patch: {
          operationId: 'updateOpenAICodexOAuthAccount',
          tags: ['oauth'],
          summary: 'Update one server-owned OpenAI Codex OAuth account slot.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'accountSlotId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/UpdateOpenAICodexOAuthAccountRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Updated OpenAI Codex OAuth account slot.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/CodexOAuthAccountSummary' },
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
          operationId: 'deleteOpenAICodexOAuthAccount',
          tags: ['oauth'],
          summary: 'Delete one server-owned OpenAI Codex OAuth account slot.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'accountSlotId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '204': {
              description: 'OpenAI Codex OAuth account deleted.',
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
      '/api/app/oauth/openai-codex/accounts/{accountSlotId}/status': {
        get: {
          operationId: 'getOpenAICodexOAuthAccountStatus',
          tags: ['oauth'],
          summary: 'Read one OpenAI Codex OAuth account login status.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'accountSlotId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Sanitized OpenAI Codex OAuth login status.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/CodexOAuthStatusPayload' },
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
      '/api/app/oauth/openai-codex/accounts/{accountSlotId}/start': {
        post: {
          operationId: 'startOpenAICodexOAuthAccountLogin',
          tags: ['oauth'],
          summary: 'Start one OpenAI Codex OAuth login.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'accountSlotId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/StartOpenAICodexOAuthRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'OpenAI Codex OAuth login status.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/CodexOAuthStatusPayload' },
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
      '/api/app/oauth/openai-codex/accounts/{accountSlotId}/cancel': {
        post: {
          operationId: 'cancelOpenAICodexOAuthAccountLogin',
          tags: ['oauth'],
          summary: 'Cancel one pending OpenAI Codex OAuth login.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'accountSlotId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/CancelOpenAICodexOAuthRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'OpenAI Codex OAuth login status after cancellation.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/CodexOAuthStatusPayload' },
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
      '/api/app/oauth/openai-codex/accounts/{accountSlotId}/logout': {
        post: {
          operationId: 'logoutOpenAICodexOAuthAccount',
          tags: ['oauth'],
          summary: 'Log out one OpenAI Codex OAuth account.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'accountSlotId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'OpenAI Codex OAuth login status after logout.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/CodexOAuthStatusPayload' },
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
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/interrupted-worker': {
        post: {
          operationId: 'createInterruptedRecoveryState',
          tags: ['app-utils'],
          summary: 'Create deterministic interrupted worker recovery state.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Created deterministic interrupted worker recovery state.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/CreateInterruptedRecoveryStateResponse',
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
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/interrupted-worker/{turnId}/terminal':
        {
          post: {
            operationId: 'clearInterruptedWorkerCheckpoint',
            tags: ['app-utils'],
            summary: 'Clear one interrupted worker checkpoint after terminal state is saved.',
            security: [{ bearerAuth: [] }, { sessionCookie: [] }],
            parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER, TURN_ID_PARAMETER],
            requestBody: {
              required: true,
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ClearInterruptedWorkerCheckpointRequest',
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Checkpoint cleanup result.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: {
                      $ref: '#/components/schemas/ClearInterruptedWorkerCheckpointResponse',
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
            summary: 'Queue one interrupted worker checkpoint for retry.',
            security: [{ bearerAuth: [] }, { sessionCookie: [] }],
            parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER, TURN_ID_PARAMETER],
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
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/pending-user-turns': {
        get: {
          operationId: 'listRecoveryPendingUserTurns',
          tags: ['app-utils'],
          summary: 'List pending user turns for one thread recovery state.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Pending user turns for the thread recovery state.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ListRecoveryPendingUserTurnsResponse',
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
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/pending-user-turns/{requestId}/cancel':
        {
          post: {
            operationId: 'cancelRecoveryPendingUserTurn',
            tags: ['app-utils'],
            summary: 'Cancel one pending user turn for one thread recovery state.',
            security: [{ bearerAuth: [] }, { sessionCookie: [] }],
            parameters: [
              WORKSPACE_ID_PARAMETER,
              THREAD_ID_PARAMETER,
              {
                name: 'requestId',
                in: 'path',
                required: true,
                schema: { type: 'string', minLength: 1 },
              },
            ],
            responses: {
              '200': {
                description: 'Pending user turn cancellation result.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: {
                      $ref: '#/components/schemas/CancelRecoveryPendingUserTurnResponse',
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
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/pending-user-turns/{requestId}/edit':
        {
          post: {
            operationId: 'editRecoveryPendingUserTurn',
            tags: ['app-utils'],
            summary: 'Edit one pending user turn for one thread recovery state.',
            security: [{ bearerAuth: [] }, { sessionCookie: [] }],
            parameters: [
              WORKSPACE_ID_PARAMETER,
              THREAD_ID_PARAMETER,
              {
                name: 'requestId',
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
                    $ref: '#/components/schemas/EditRecoveryPendingUserTurnRequest',
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Pending user turn edit result.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: {
                      $ref: '#/components/schemas/EditRecoveryPendingUserTurnResponse',
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
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/pending-user-turns/{requestId}/follow-up':
        {
          post: {
            operationId: 'convertRecoveryPendingUserTurnToFollowUp',
            tags: ['app-utils'],
            summary: 'Convert one pending user turn to follow-up delivery.',
            security: [{ bearerAuth: [] }, { sessionCookie: [] }],
            parameters: [
              WORKSPACE_ID_PARAMETER,
              THREAD_ID_PARAMETER,
              {
                name: 'requestId',
                in: 'path',
                required: true,
                schema: { type: 'string', minLength: 1 },
              },
            ],
            responses: {
              '200': {
                description: 'Pending user turn follow-up conversion result.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: {
                      $ref: '#/components/schemas/ConvertRecoveryPendingUserTurnToFollowUpResponse',
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
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/recovery/pending-user-turns/{requestId}/interrupt':
        {
          post: {
            operationId: 'promoteRecoveryPendingUserTurnToInterrupt',
            tags: ['app-utils'],
            summary: 'Promote one pending user turn to an active-turn interrupt.',
            security: [{ bearerAuth: [] }, { sessionCookie: [] }],
            parameters: [
              WORKSPACE_ID_PARAMETER,
              THREAD_ID_PARAMETER,
              {
                name: 'requestId',
                in: 'path',
                required: true,
                schema: { type: 'string', minLength: 1 },
              },
            ],
            responses: {
              '200': {
                description: 'Pending user turn interrupt promotion result.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: {
                      $ref: '#/components/schemas/PromoteRecoveryPendingUserTurnToInterruptResponse',
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
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/agent-sessions/{agentSessionId}/terminal-commands':
        {
          post: {
            operationId: 'queueAgentSessionTerminalCommand',
            tags: ['app-utils'],
            summary: 'Queue one terminal command for an active agent session.',
            security: [{ bearerAuth: [] }, { sessionCookie: [] }],
            parameters: [
              WORKSPACE_ID_PARAMETER,
              THREAD_ID_PARAMETER,
              {
                name: 'agentSessionId',
                in: 'path',
                required: true,
                schema: { $ref: '#/components/schemas/AgentSessionId' },
              },
            ],
            requestBody: {
              required: true,
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/QueueAgentSessionTerminalCommandRequest',
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Queued terminal command.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: {
                      $ref: '#/components/schemas/QueueAgentSessionTerminalCommandResponse',
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
            '200': {
              description: 'Queued or blocked Goal Mode steering.',
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
      '/api/app/workspaces/{workspaceId}/threads/{threadId}/goal/plan': {
        post: {
          operationId: 'createThreadGoalPlan',
          tags: ['modes'],
          summary: 'Draft one Goal Mode plan.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, THREAD_ID_PARAMETER],
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
      '/api/app/workspaces/{workspaceId}/knowledge/claims/{claimId}/promotion': {
        post: {
          operationId: 'promoteKnowledgeClaim',
          tags: ['knowledge'],
          summary: 'Promote one accepted Knowledge Store claim into review.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'claimId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/PromoteKnowledgeClaimRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Promoted Knowledge Store claim draft.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/PromoteKnowledgeClaimResponse' },
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
          summary: 'Prepare source-traceable knowledge context material.',
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
              description: 'Prepared knowledge context material.',
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
      '/api/app/workspaces/{workspaceId}/knowledge/manager/context/{contextPackageId}': {
        get: {
          operationId: 'readKnowledgeContextPackageTrace',
          tags: ['knowledge'],
          summary: 'Read one persisted Knowledge Manager context package trace.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'contextPackageId',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            '200': {
              description: 'Persisted knowledge context package trace.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/ReadKnowledgeManagerContextPackageTraceResponse',
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
      '/api/app/workspaces/{workspaceId}/knowledge/manager/context/{contextPackageId}/materialization':
        {
          get: {
            operationId: 'readKnowledgeContextPackageMaterialization',
            tags: ['knowledge'],
            summary: 'Read one materialized Knowledge Manager context package.',
            security: [{ bearerAuth: [] }, { sessionCookie: [] }],
            parameters: [
              WORKSPACE_ID_PARAMETER,
              {
                name: 'contextPackageId',
                in: 'path',
                required: true,
                schema: { type: 'string', minLength: 1 },
              },
            ],
            responses: {
              '200': {
                description: 'Previously materialized worker-visible context package summary.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: {
                      $ref: '#/components/schemas/MaterializeKnowledgeContextPackageResponse',
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
          post: {
            operationId: 'materializeKnowledgeContextPackage',
            tags: ['knowledge'],
            summary: 'Materialize one Knowledge Manager context package for worker-visible files.',
            security: [{ bearerAuth: [] }, { sessionCookie: [] }],
            parameters: [
              WORKSPACE_ID_PARAMETER,
              {
                name: 'contextPackageId',
                in: 'path',
                required: true,
                schema: { type: 'string', minLength: 1 },
              },
            ],
            responses: {
              '200': {
                description: 'Worker-visible context package materialization summary.',
                content: {
                  [JSON_CONTENT_TYPE]: {
                    schema: {
                      $ref: '#/components/schemas/MaterializeKnowledgeContextPackageResponse',
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
      '/api/app/workspaces/{workspaceId}/artifacts/{artifactId}/review': {
        post: {
          operationId: 'submitArtifactReviewDecision',
          tags: ['reviews'],
          summary: 'Record one artifact review decision.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'artifactId',
              in: 'path',
              required: true,
              schema: { $ref: '#/components/schemas/ArtifactId' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/SubmitArtifactReviewDecisionRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Recorded artifact review decision.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/SubmitArtifactReviewDecisionResponse' },
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
          operationId: 'listWorkspaceInjectionPlans',
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
                    $ref: '#/components/schemas/ListWorkspaceInjectionPlansResponse',
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
          operationId: 'listWorkspaceInjectionReceipts',
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
                    $ref: '#/components/schemas/ListWorkspaceInjectionReceiptsResponse',
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
        post: {
          operationId: 'createDefaultWorkspaceRepository',
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
        AgentId: toJsonSchema(AgentIdSchema),
        AgentSessionId: toJsonSchema(AgentSessionIdSchema),
        ApiError: toJsonSchema(ApiErrorSchema),
        AgentHealthRefreshResponse: toJsonSchema(AgentHealthRefreshResponseSchema),
        ArtifactId: toJsonSchema(ArtifactIdSchema),
        AppDiagnosticsResponse: toJsonSchema(AppDiagnosticsResponseSchema),
        AppSearchResponse: toJsonSchema(AppSearchResponseSchema),
        ApproveThreadGoalPlanRequest: toJsonSchema(ApproveThreadGoalPlanRequestSchema),
        ApproveThreadGoalPlanResponse: toJsonSchema(ApproveThreadGoalPlanResponseSchema),
        AutomationRecord: toJsonSchema(AutomationRecordSchema),
        CancelOpenAICodexOAuthRequest: toJsonSchema(CancelOpenAICodexOAuthRequestSchema),
        CapabilityUsageResponse: toJsonSchema(CapabilityUsageResponseSchema),
        ClearInterruptedWorkerCheckpointRequest: toJsonSchema(
          ClearInterruptedWorkerCheckpointRequestSchema
        ),
        ClearInterruptedWorkerCheckpointResponse: toJsonSchema(
          ClearInterruptedWorkerCheckpointResponseSchema
        ),
        RetryInterruptedWorkerCheckpointResponse: toJsonSchema(
          RetryInterruptedWorkerCheckpointResponseSchema
        ),
        RetrySchedulerAdmissionResponse: toJsonSchema(RetrySchedulerAdmissionResponseSchema),
        CancelSchedulerAdmissionResponse: toJsonSchema(CancelSchedulerAdmissionResponseSchema),
        CodexOAuthAccountSummary: toJsonSchema(CodexOAuthAccountSummarySchema),
        CodexOAuthAccountsPayload: toJsonSchema(CodexOAuthAccountsPayloadSchema),
        CodexOAuthStatusPayload: toJsonSchema(CodexOAuthStatusPayloadSchema),
        ConsumeOpenKitBootstrapTokenRequest: toJsonSchema(
          ConsumeOpenKitBootstrapTokenRequestSchema
        ),
        ConsumeOpenKitBootstrapTokenResponse: toJsonSchema(
          ConsumeOpenKitBootstrapTokenResponseSchema
        ),
        CreateAutomationRequest: toJsonSchema(CreateAutomationRequestSchema),
        CreateInterruptedRecoveryStateResponse: toJsonSchema(
          CreateInterruptedRecoveryStateResponseSchema
        ),
        CreateOpenKitAccessTokenRequest: toJsonSchema(CreateOpenKitAccessTokenRequestSchema),
        CreateOpenKitAccessTokenResponse: toJsonSchema(CreateOpenKitAccessTokenResponseSchema),
        CreateOpenAICodexOAuthAccountRequest: toJsonSchema(
          CreateOpenAICodexOAuthAccountRequestSchema
        ),
        CreateThreadGoalPlanResponse: toJsonSchema(CreateThreadGoalPlanResponseSchema),
        DataRootBackupCreateResponse: toJsonSchema(DataRootBackupCreateResponseSchema),
        DataRootBackupVerifyRequest: toJsonSchema(DataRootBackupVerifyRequestSchema),
        DataRootBackupVerifyResponse: toJsonSchema(DataRootBackupVerifyResponseSchema),
        ExecuteGitPushRequest: toJsonSchema(ExecuteGitPushRequestSchema),
        ExecuteGitPushResponse: toJsonSchema(ExecuteGitPushResponseSchema),
        GetAgentCatalogEntryResponse: toJsonSchema(GetAgentCatalogEntryResponseSchema),
        GetAgentEnvironmentPackageSnapshotResponse: toJsonSchema(
          GetAgentEnvironmentPackageSnapshotResponseSchema
        ),
        GetGitPushRecordResponse: toJsonSchema(GetGitPushRecordResponseSchema),
        GetWorkspaceApplyResultResponse: toJsonSchema(GetWorkspaceApplyResultResponseSchema),
        GetWorkspaceSyncReviewResponse: toJsonSchema(GetWorkspaceSyncReviewResponseSchema),
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
        ReadKnowledgeManagerContextPackageTraceResponse: toJsonSchema(
          ReadKnowledgeManagerContextPackageTraceResponseSchema
        ),
        MaterializeKnowledgeContextPackageResponse: toJsonSchema(
          MaterializeKnowledgeContextPackageResponseSchema
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
        ListOpenKitAccessTokensResponse: toJsonSchema(ListOpenKitAccessTokensResponseSchema),
        ListRecoveryPendingUserTurnsResponse: toJsonSchema(
          ListRecoveryPendingUserTurnsResponseSchema
        ),
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
        ListWorkspaceInjectionPlansResponse: toJsonSchema(
          ListWorkspaceInjectionPlansResponseSchema
        ),
        ListWorkspaceInjectionReceiptsResponse: toJsonSchema(
          ListWorkspaceInjectionReceiptsResponseSchema
        ),
        ListWorkspaceRuntimeEvidenceResponse: toJsonSchema(
          ListWorkspaceRuntimeEvidenceResponseSchema
        ),
        ListWorkspacePermissionDecisionsResponse: toJsonSchema(
          ListWorkspacePermissionDecisionsResponseSchema
        ),
        CancelRecoveryPendingUserTurnResponse: toJsonSchema(
          CancelRecoveryPendingUserTurnResponseSchema
        ),
        ConvertRecoveryPendingUserTurnToFollowUpResponse: toJsonSchema(
          ConvertRecoveryPendingUserTurnToFollowUpResponseSchema
        ),
        PromoteRecoveryPendingUserTurnToInterruptResponse: toJsonSchema(
          PromoteRecoveryPendingUserTurnToInterruptResponseSchema
        ),
        EditRecoveryPendingUserTurnRequest: toJsonSchema(EditRecoveryPendingUserTurnRequestSchema),
        EditRecoveryPendingUserTurnResponse: toJsonSchema(
          EditRecoveryPendingUserTurnResponseSchema
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
        PromoteKnowledgeClaimRequest: toJsonSchema(PromoteKnowledgeClaimRequestSchema),
        PromoteKnowledgeClaimResponse: toJsonSchema(PromoteKnowledgeClaimResponseSchema),
        QueueAgentSessionTerminalCommandRequest: toJsonSchema(
          QueueAgentSessionTerminalCommandRequestSchema
        ),
        QueueAgentSessionTerminalCommandResponse: toJsonSchema(
          QueueAgentSessionTerminalCommandResponseSchema
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
        RestartRuntimeConfigStaleSessionResponse: toJsonSchema(
          RestartRuntimeConfigStaleSessionResponseSchema
        ),
        RecordKnowledgeObservationRequest: toJsonSchema(RecordKnowledgeObservationRequestSchema),
        RecordKnowledgeObservationResponse: toJsonSchema(RecordKnowledgeObservationResponseSchema),
        RegisterKnowledgeSourceRequest: toJsonSchema(RegisterKnowledgeSourceRequestSchema),
        RegisterKnowledgeSourceResponse: toJsonSchema(RegisterKnowledgeSourceResponseSchema),
        RetrieveKnowledgeRequest: toJsonSchema(RetrieveKnowledgeRequestSchema),
        PauseThreadGoalResponse: toJsonSchema(PauseThreadGoalResponseSchema),
        ReviseThreadGoalPlanRequest: toJsonSchema(ReviseThreadGoalPlanRequestSchema),
        ReviseThreadGoalPlanResponse: toJsonSchema(ReviseThreadGoalPlanResponseSchema),
        ResumeThreadGoalResponse: toJsonSchema(ResumeThreadGoalResponseSchema),
        RevokeOpenKitAccessTokenResponse: toJsonSchema(RevokeOpenKitAccessTokenResponseSchema),
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
        StartOpenAICodexOAuthRequest: toJsonSchema(StartOpenAICodexOAuthRequestSchema),
        StartTaskModeRequest: toJsonSchema(StartTaskModeRequestSchema),
        StartTaskModeResponse: toJsonSchema(StartTaskModeResponseSchema),
        StartThreadGoalRequest: toJsonSchema(StartThreadGoalRequestSchema),
        StartThreadGoalResponse: toJsonSchema(StartThreadGoalResponseSchema),
        StorageLayoutReportResponse: toJsonSchema(StorageLayoutReportResponseSchema),
        SubmitArtifactReviewDecisionRequest: toJsonSchema(
          SubmitArtifactReviewDecisionRequestSchema
        ),
        SubmitArtifactReviewDecisionResponse: toJsonSchema(
          SubmitArtifactReviewDecisionResponseSchema
        ),
        SubmitGoalReviewDecisionRequest: toJsonSchema(SubmitGoalReviewDecisionRequestSchema),
        SubmitGoalReviewDecisionResponse: toJsonSchema(SubmitGoalReviewDecisionResponseSchema),
        SubmitKnowledgeProposalDecisionRequest: toJsonSchema(
          SubmitKnowledgeProposalDecisionRequestSchema
        ),
        SubmitKnowledgeProposalDecisionResponse: toJsonSchema(
          SubmitKnowledgeProposalDecisionResponseSchema
        ),
        SubmitThreadGoalSteeringRequest: toJsonSchema(SubmitThreadGoalSteeringRequestSchema),
        SubmitThreadGoalSteeringResponse: toJsonSchema(SubmitThreadGoalSteeringResponseSchema),
        SubmitTurnFeedbackRequest: toJsonSchema(SubmitTurnFeedbackRequestSchema),
        ThreadDashboardResponse: toJsonSchema(ThreadDashboardResponseSchema),
        ThreadId: toJsonSchema(ThreadIdSchema),
        ThreadGoalSummaryResponse: toJsonSchema(ThreadGoalSummaryResponseSchema),
        TurnId: toJsonSchema(TurnIdSchema),
        TurnFeedbackResponse: toJsonSchema(TurnFeedbackResponseSchema),
        UpdateAutomationRequest: toJsonSchema(UpdateAutomationRequestSchema),
        UpdateOpenAICodexOAuthAccountRequest: toJsonSchema(
          UpdateOpenAICodexOAuthAccountRequestSchema
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
