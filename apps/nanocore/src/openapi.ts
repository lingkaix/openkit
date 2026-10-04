import { createHash } from 'node:crypto';

import {
  AcceptWorkspaceInvitationRequestSchema,
  ActivateWorkerEnvironmentRequestSchema,
  ActivateWorkerEnvironmentResponseSchema,
  AppDiagnosticsResponseSchema,
  ApplyAdministrationConfigurationRequestSchema,
  ApplyAdministrationConfigurationResponseSchema,
  AppUpdateStatusResponseSchema,
  BindThreadMaterialRequestSchema,
  BindThreadMaterialResponseSchema,
  ChangeWorkspaceMemberAccessRequestSchema,
  ConsumeOpenKitBootstrapTokenRequestSchema,
  ConsumeOpenKitBootstrapTokenResponseSchema,
  CreateOpenKitAccessTokenRequestSchema,
  CreateOpenKitAccessTokenResponseSchema,
  CreateWorkspaceInvitationRequestSchema,
  CreateWorkspaceMaterialRequestSchema,
  CreateWorkspaceMaterialResponseSchema,
  CreateWorkspaceVaultGrantRequestSchema,
  CreateWorkspaceVaultSecretRequestSchema,
  DeclineWorkspaceInvitationRequestSchema,
  DeleteWorkspaceRequestSchema,
  DisableUserRequestSchema,
  DisableUserResponseSchema,
  ExcludeThreadMaterialRequestSchema,
  ExcludeThreadMaterialResponseSchema,
  GetThreadMaterialResponseSchema,
  GetWorkerEnvironmentStatusResponseSchema,
  GetWorkspaceMaterialResponseSchema,
  GetWorkspaceMaterialRevisionResponseSchema,
  LeaveWorkspaceRequestSchema,
  ListMyAdminAccessTokensResponseSchema,
  ListOpenKitAccessTokensResponseSchema,
  ListPluginCatalogResponseSchema,
  ListSkillCatalogResponseSchema,
  ListWorkerEnvironmentsResponseSchema,
  ListWorkspaceInvitationsResponseSchema,
  ListWorkspaceMaterialRevisionsResponseSchema,
  ListWorkspaceMaterialsResponseSchema,
  ListWorkspaceMembersResponseSchema,
  OPERATION_DEFINITIONS,
  type OperationId,
  operationHttpPath,
  operationModelInput,
  PrepareAppUpdateRequestSchema,
  PrepareAppUpdateResponseSchema,
  PrepareWorkerEnvironmentRequestSchema,
  PrepareWorkerEnvironmentResponseSchema,
  PurgeWorkerEnvironmentRequestSchema,
  PurgeWorkerEnvironmentResponseSchema,
  RecoverDeletedWorkspaceRequestSchema,
  RecoverDeletedWorkspaceResponseSchema,
  RecoverWorkspaceAccessRequestSchema,
  RemoveWorkspaceMemberRequestSchema,
  RestoreThreadMaterialRequestSchema,
  RestoreThreadMaterialResponseSchema,
  RevokeOpenKitAccessTokenResponseSchema,
  RevokeWorkspaceInvitationRequestSchema,
  RotateOpenKitAccessTokenRequestSchema,
  RotateOpenKitAccessTokenResponseSchema,
  RotateWorkspaceVaultSecretRequestSchema,
  SaveWorkspaceMaterialRevisionRequestSchema,
  SaveWorkspaceMaterialRevisionResponseSchema,
  SelectWorkerEnvironmentRequestSchema,
  SelectWorkerEnvironmentResponseSchema,
  SetMyAdminAccessTokenDefaultRequestSchema,
  SetMyAdminAccessTokenDefaultResponseSchema,
  SetProviderApiKeyRequestSchema,
  SetupDiagnosticsResponseSchema,
  StartAppUpdateRequestSchema,
  SubmitAdministrationConversationRequestSchema,
  SubmitAdministrationConversationResponseSchema,
  TransferWorkspaceOwnershipRequestSchema,
  UnbindThreadMaterialRequestSchema,
  UnbindThreadMaterialResponseSchema,
  VaultAdminBootstrapCodexAuthJsonRequestSchema,
  VaultAdminRebindWorkspaceReferenceRequestSchema,
  VaultAdminUnlockRequestSchema,
  VaultAdminWorkspaceReferenceSchema,
  WorkspaceAccessRecoveryResponseSchema,
  WorkspaceDeletionResponseSchema,
  WorkspaceImportDryRunResponseSchema,
  WorkspaceImportResponseSchema,
  WorkspaceInvitationMutationResponseSchema,
  WorkspaceMemberMutationResponseSchema,
  WorkspaceOwnershipMutationResponseSchema,
  WorkspaceVaultGrantSchema,
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
/** Deployment-admin operations accept a presented server-admin bearer or a derived-admin session cookie. */
const DEPLOYMENT_ADMIN_SECURITY = [{ bearerAuth: [] }, { sessionCookie: [] }];
const SESSION_COOKIE_SECURITY = [{ sessionCookie: [] }];
const THREAD_ID_PARAMETER = {
  name: 'threadId',
  in: 'path',
  required: true,
  schema: { $ref: '#/components/schemas/ThreadId' },
} as const;
const WORKSPACE_ID_PARAMETER = {
  name: 'workspaceId',
  in: 'path',
  required: true,
  schema: { $ref: '#/components/schemas/WorkspaceId' },
} as const;
const WORKER_ENVIRONMENT_STORAGE_REF_PARAMETER = {
  name: 'storageRef',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^wst_[a-f0-9]{32}$' },
} as const;
const WORKSPACE_EXPORT_ID_PARAMETER = {
  name: 'exportId',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
} as const;
const _INVITATION_ID_PARAMETER = {
  name: 'invitationId',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
} as const;
const _USER_ID_PARAMETER = {
  name: 'userId',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
} as const;
const MATERIAL_ID_PARAMETER = {
  name: 'materialId',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
} as const;
const REQUEST_ID_HEADER = {
  name: 'x-openkit-request-id',
  in: 'header',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const;
const REVISION_ID_PARAMETER = {
  name: 'revisionId',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
} as const;

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
  responseStatus: '200' | '201' | '202' | '204';
  responseStatuses?: readonly ('200' | '201' | '202' | '204')[];
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
      ...Object.fromEntries(
        (input.responseStatuses ?? [input.responseStatus]).map((status) => [
          status,
          {
            description: input.responseDescription ?? input.summary,
            ...(status === '204'
              ? {}
              : {
                  content: {
                    [JSON_CONTENT_TYPE]: {
                      schema: { $ref: `#/components/schemas/${input.responseSchema}` },
                    },
                  },
                }),
          },
        ])
      ),
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
export const APP_OPENAPI_ROUTE_COVERAGE_EXCLUSIONS = [] as const;

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

/** Derives the migrated JSON bindings and their contract references. */
function operationPaths() {
  return Object.fromEntries(
    Object.entries(OPERATION_DEFINITIONS).map(([id, definition]) => [
      operationHttpPath(id),
      {
        post: appJsonOperation({
          operationId: id,
          tag: id.split('.')[0]!,
          summary: definition.description,
          ...(definition.scope.kind === 'server' ? { security: DEPLOYMENT_ADMIN_SECURITY } : {}),
          requestSchema: `${id}.input`,
          responseSchema: `${id}.output`,
          responseStatus:
            'successStatus' in definition ? (`${definition.successStatus}` as const) : '200',
          ...('successStatuses' in definition
            ? {
                responseStatuses: definition.successStatuses.map(
                  (status) => `${status}` as '200' | '202'
                ),
              }
            : {}),
          ...(definition.mutating && 'requestId' in definition.inputSchema.shape
            ? { parameters: [REQUEST_ID_HEADER] }
            : {}),
        }),
      },
    ])
  ) as {
    [K in OperationId as `/api/app/operations/${K}`]: {
      post: ReturnType<typeof appJsonOperation<K>>;
    };
  };
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
      ...operationPaths(),
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
      '/api/app/auth/my-admin-tokens': {
        get: appJsonOperation({
          operationId: 'listMyAdminAccessTokens',
          tag: 'auth',
          summary: "List the signed-in user's redacted server-admin tokens and effective default.",
          responseStatus: '200',
          responseSchema: 'ListMyAdminAccessTokensResponse',
          security: SESSION_COOKIE_SECURITY,
        }),
      },
      '/api/app/auth/my-admin-tokens/default': {
        put: appJsonOperation({
          operationId: 'setMyAdminAccessTokenDefault',
          tag: 'auth',
          summary: 'Select one owned usable server-admin token as the signed-in user default.',
          responseStatus: '200',
          responseSchema: 'SetMyAdminAccessTokenDefaultResponse',
          requestSchema: 'SetMyAdminAccessTokenDefaultRequest',
          security: SESSION_COOKIE_SECURITY,
        }),
      },
      '/api/app/administration/configuration/apply': {
        post: {
          operationId: 'applyAdministrationConfiguration',
          tags: ['administration'],
          summary: 'Apply one exact human-confirmed private configuration candidate.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/ApplyAdministrationConfigurationRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Actual persistence and reload outcome.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ApplyAdministrationConfigurationResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/ApiError' } },
              },
            },
          },
        },
      },
      '/api/app/administration/conversation-turns': {
        post: {
          operationId: 'submitAdministrationConversation',
          tags: ['administration'],
          summary: 'Submit one turn to the current user private administration entry.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: {
                  $ref: '#/components/schemas/SubmitAdministrationConversationRequest',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Completed private administration response.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/SubmitAdministrationConversationResponse',
                  },
                },
              },
            },
            '202': {
              description: 'Accepted administration proposal or clarification response.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: {
                    $ref: '#/components/schemas/SubmitAdministrationConversationResponse',
                  },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/ApiError' } },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/worker-environments': {
        get: {
          operationId: 'listWorkerEnvironments',
          tags: ['worker-environments'],
          summary: 'List retained Worker environments admitted for the current user.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            WORKSPACE_ID_PARAMETER,
            {
              name: 'after',
              in: 'query',
              required: false,
              schema: { type: 'string', pattern: '^wst_[a-f0-9]{32}$' },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
          ],
          responses: {
            '200': {
              description: 'Bounded authorized retained Worker environments.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ListWorkerEnvironmentsResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/ApiError' } },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/worker-environments/select': {
        post: {
          operationId: 'selectWorkerEnvironment',
          tags: ['worker-environments'],
          summary: 'Validate one explicit retained Worker environment selection.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [WORKSPACE_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/SelectWorkerEnvironmentRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Current read-only selection admission result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/SelectWorkerEnvironmentResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/ApiError' } },
              },
            },
          },
        },
      },
      '/api/app/worker-environments/prepare': {
        post: {
          operationId: 'prepareWorkerEnvironment',
          tags: ['worker-environments'],
          summary: 'Prepare and inspect one immutable Worker environment candidate.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/PrepareWorkerEnvironmentRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Resolved candidate and bounded affected-work preview.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/PrepareWorkerEnvironmentResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/ApiError' } },
              },
            },
          },
        },
      },
      '/api/app/worker-environments/activate': {
        post: {
          operationId: 'activateWorkerEnvironment',
          tags: ['worker-environments'],
          summary: 'Activate one approved exact Worker environment candidate.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/ActivateWorkerEnvironmentRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Truthful activation, retained, or unknown outcome.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/ActivateWorkerEnvironmentResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/ApiError' } },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/worker-environments/{storageRef}/status': {
        get: {
          operationId: 'getWorkerEnvironmentStatus',
          tags: ['worker-environments'],
          summary: 'Inspect current Core and host Worker environment facts.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [WORKSPACE_ID_PARAMETER, WORKER_ENVIRONMENT_STORAGE_REF_PARAMETER],
          responses: {
            '200': {
              description: 'Current exact retained Worker environment status.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/GetWorkerEnvironmentStatusResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/ApiError' } },
              },
            },
          },
        },
      },
      '/api/app/workspaces/{workspaceId}/worker-environments/{storageRef}/purge': {
        post: {
          operationId: 'purgeWorkerEnvironment',
          tags: ['worker-environments'],
          summary: 'Purge one approved exact unreferenced retained Worker environment.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [WORKSPACE_ID_PARAMETER, WORKER_ENVIRONMENT_STORAGE_REF_PARAMETER],
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/PurgeWorkerEnvironmentRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Definite purge or truthful retained or unknown result.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/PurgeWorkerEnvironmentResponse' },
                },
              },
            },
            default: {
              description: 'Protocol error envelope.',
              content: {
                [JSON_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/ApiError' } },
              },
            },
          },
        },
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
      '/api/app/app-update/prepare': {
        post: {
          operationId: 'prepareAppUpdate',
          tags: ['app-update'],
          summary: 'Prepare one closed App-update source without replacing the running App.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/PrepareAppUpdateRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Prepared review object with a host-issued receipt id.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/PrepareAppUpdateResponse' },
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
      '/api/app/app-update/start': {
        post: {
          operationId: 'startAppUpdate',
          tags: ['app-update'],
          summary: 'Start one prepared App-update receipt after explicit maintenance consent.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          requestBody: {
            required: true,
            content: {
              [JSON_CONTENT_TYPE]: {
                schema: { $ref: '#/components/schemas/StartAppUpdateRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Host receipt projection after start handoff.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/AppUpdateStatusResponse' },
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
      '/api/app/app-update/{requestId}': {
        get: {
          operationId: 'getAppUpdateStatus',
          tags: ['app-update'],
          summary: 'Read one host-owned App-update receipt by id.',
          security: DEPLOYMENT_ADMIN_SECURITY,
          parameters: [
            {
              name: 'requestId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'Host receipt projection.',
              content: {
                [JSON_CONTENT_TYPE]: {
                  schema: { $ref: '#/components/schemas/AppUpdateStatusResponse' },
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
      '/api/app/workspaces/{workspaceId}/exports/{exportId}/archive': {
        get: {
          operationId: 'downloadWorkspaceExportArchive',
          tags: ['storage'],
          summary: 'Download one verified workspace export as a Zstandard-compressed tar stream.',
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          parameters: [WORKSPACE_ID_PARAMETER, WORKSPACE_EXPORT_ID_PARAMETER],
          responses: {
            '200': {
              description: 'Canonical portable Workspace archive stream.',
              content: {
                'application/vnd.openkit.workspace-export+tar.zstd': {
                  schema: { type: 'string', format: 'binary' },
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
      '/api/app/workspace-archives/import-dry-run': {
        post: {
          operationId: 'dryRunWorkspaceArchiveImport',
          tags: ['storage'],
          summary: 'Verify one streamed portable Workspace archive without importing it.',
          security: SESSION_COOKIE_SECURITY,
          requestBody: {
            required: true,
            content: {
              'application/vnd.openkit.workspace-export+tar.zstd': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Workspace archive import dry-run report.',
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
      '/api/app/workspace-archives/import': {
        post: {
          operationId: 'importWorkspaceArchive',
          tags: ['storage'],
          summary: 'Import one streamed portable Workspace archive.',
          security: SESSION_COOKIE_SECURITY,
          parameters: [
            {
              name: 'x-openkit-request-id',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/vnd.openkit.workspace-export+tar.zstd': {
                schema: { type: 'string', format: 'binary' },
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
        ...Object.fromEntries(
          Object.entries(OPERATION_DEFINITIONS).flatMap(([id, definition]) => [
            [
              `${id}.input`,
              toJsonSchema(operationModelInput(definition.inputSchema, ['requestId'])),
            ],
            [`${id}.output`, toJsonSchema(definition.outputSchema)],
          ])
        ),
        AcceptWorkspaceInvitationRequest: toJsonSchema(AcceptWorkspaceInvitationRequestSchema),
        ChangeWorkspaceMemberAccessRequest: toJsonSchema(ChangeWorkspaceMemberAccessRequestSchema),
        CreateWorkspaceInvitationRequest: toJsonSchema(CreateWorkspaceInvitationRequestSchema),
        DeclineWorkspaceInvitationRequest: toJsonSchema(DeclineWorkspaceInvitationRequestSchema),
        DeleteWorkspaceRequest: toJsonSchema(DeleteWorkspaceRequestSchema),
        DisableUserRequest: toJsonSchema(DisableUserRequestSchema),
        DisableUserResponse: toJsonSchema(DisableUserResponseSchema),
        LeaveWorkspaceRequest: toJsonSchema(LeaveWorkspaceRequestSchema),
        ListWorkspaceInvitationsResponse: toJsonSchema(ListWorkspaceInvitationsResponseSchema),
        ListWorkerEnvironmentsResponse: toJsonSchema(ListWorkerEnvironmentsResponseSchema),
        ListWorkspaceMembersResponse: toJsonSchema(ListWorkspaceMembersResponseSchema),
        RecoverWorkspaceAccessRequest: toJsonSchema(RecoverWorkspaceAccessRequestSchema),
        RecoverDeletedWorkspaceRequest: toJsonSchema(RecoverDeletedWorkspaceRequestSchema),
        RecoverDeletedWorkspaceResponse: toJsonSchema(RecoverDeletedWorkspaceResponseSchema),
        RemoveWorkspaceMemberRequest: toJsonSchema(RemoveWorkspaceMemberRequestSchema),
        RevokeWorkspaceInvitationRequest: toJsonSchema(RevokeWorkspaceInvitationRequestSchema),
        TransferWorkspaceOwnershipRequest: toJsonSchema(TransferWorkspaceOwnershipRequestSchema),
        WorkspaceAccessRecoveryResponse: toJsonSchema(WorkspaceAccessRecoveryResponseSchema),
        WorkspaceDeletionResponse: toJsonSchema(WorkspaceDeletionResponseSchema),
        WorkspaceInvitationMutationResponse: toJsonSchema(
          WorkspaceInvitationMutationResponseSchema
        ),
        WorkspaceMemberMutationResponse: toJsonSchema(WorkspaceMemberMutationResponseSchema),
        WorkspaceOwnershipMutationResponse: toJsonSchema(WorkspaceOwnershipMutationResponseSchema),
        AgentId: toJsonSchema(AgentIdSchema),
        ApiError: toJsonSchema(ApiErrorSchema),
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
        UnbindThreadMaterialRequest: toJsonSchema(UnbindThreadMaterialRequestSchema),
        UnbindThreadMaterialResponse: toJsonSchema(UnbindThreadMaterialResponseSchema),
        AppDiagnosticsResponse: toJsonSchema(AppDiagnosticsResponseSchema),
        AppUpdateStatusResponse: toJsonSchema(AppUpdateStatusResponseSchema),
        ConsumeOpenKitBootstrapTokenRequest: toJsonSchema(
          ConsumeOpenKitBootstrapTokenRequestSchema
        ),
        ConsumeOpenKitBootstrapTokenResponse: toJsonSchema(
          ConsumeOpenKitBootstrapTokenResponseSchema
        ),
        CreateOpenKitAccessTokenRequest: toJsonSchema(CreateOpenKitAccessTokenRequestSchema),
        CreateOpenKitAccessTokenResponse: toJsonSchema(CreateOpenKitAccessTokenResponseSchema),
        GetWorkerEnvironmentStatusResponse: toJsonSchema(GetWorkerEnvironmentStatusResponseSchema),
        ListOpenKitAccessTokensResponse: toJsonSchema(ListOpenKitAccessTokensResponseSchema),
        ListPluginCatalogResponse: toJsonSchema(ListPluginCatalogResponseSchema),
        ListMyAdminAccessTokensResponse: toJsonSchema(ListMyAdminAccessTokensResponseSchema),
        ListSkillCatalogResponse: toJsonSchema(ListSkillCatalogResponseSchema),
        PurgeWorkerEnvironmentRequest: toJsonSchema(PurgeWorkerEnvironmentRequestSchema),
        PurgeWorkerEnvironmentResponse: toJsonSchema(PurgeWorkerEnvironmentResponseSchema),
        PrepareAppUpdateRequest: toJsonSchema(PrepareAppUpdateRequestSchema),
        PrepareAppUpdateResponse: toJsonSchema(PrepareAppUpdateResponseSchema),
        PrepareWorkerEnvironmentRequest: toJsonSchema(PrepareWorkerEnvironmentRequestSchema),
        PrepareWorkerEnvironmentResponse: toJsonSchema(PrepareWorkerEnvironmentResponseSchema),
        RevokeOpenKitAccessTokenResponse: toJsonSchema(RevokeOpenKitAccessTokenResponseSchema),
        RotateOpenKitAccessTokenRequest: toJsonSchema(RotateOpenKitAccessTokenRequestSchema),
        RotateOpenKitAccessTokenResponse: toJsonSchema(RotateOpenKitAccessTokenResponseSchema),
        SelectWorkerEnvironmentRequest: toJsonSchema(SelectWorkerEnvironmentRequestSchema),
        SelectWorkerEnvironmentResponse: toJsonSchema(SelectWorkerEnvironmentResponseSchema),
        SetMyAdminAccessTokenDefaultRequest: toJsonSchema(
          SetMyAdminAccessTokenDefaultRequestSchema
        ),
        SetMyAdminAccessTokenDefaultResponse: toJsonSchema(
          SetMyAdminAccessTokenDefaultResponseSchema
        ),
        CreateWorkspaceVaultSecretRequest: toJsonSchema(CreateWorkspaceVaultSecretRequestSchema),
        RotateWorkspaceVaultSecretRequest: toJsonSchema(RotateWorkspaceVaultSecretRequestSchema),
        CreateWorkspaceVaultGrantRequest: toJsonSchema(CreateWorkspaceVaultGrantRequestSchema),
        VaultAdminWorkspaceReference: toJsonSchema(VaultAdminWorkspaceReferenceSchema),
        WorkspaceVaultGrant: toJsonSchema(WorkspaceVaultGrantSchema),
        SetProviderApiKeyRequest: toJsonSchema(SetProviderApiKeyRequestSchema),
        SetupDiagnosticsResponse: toJsonSchema(SetupDiagnosticsResponseSchema),
        SubmitAdministrationConversationRequest: toJsonSchema(
          SubmitAdministrationConversationRequestSchema
        ),
        SubmitAdministrationConversationResponse: toJsonSchema(
          SubmitAdministrationConversationResponseSchema
        ),
        ApplyAdministrationConfigurationRequest: toJsonSchema(
          ApplyAdministrationConfigurationRequestSchema
        ),
        ApplyAdministrationConfigurationResponse: toJsonSchema(
          ApplyAdministrationConfigurationResponseSchema
        ),
        ActivateWorkerEnvironmentRequest: toJsonSchema(ActivateWorkerEnvironmentRequestSchema),
        ActivateWorkerEnvironmentResponse: toJsonSchema(ActivateWorkerEnvironmentResponseSchema),
        StartAppUpdateRequest: toJsonSchema(StartAppUpdateRequestSchema),
        ThreadId: toJsonSchema(ThreadIdSchema),
        TurnId: toJsonSchema(TurnIdSchema),
        VaultAdminBootstrapCodexAuthJsonRequest: toJsonSchema(
          VaultAdminBootstrapCodexAuthJsonRequestSchema
        ),
        VaultAdminRebindWorkspaceReferenceRequest: toJsonSchema(
          VaultAdminRebindWorkspaceReferenceRequestSchema
        ),
        VaultAdminUnlockRequest: toJsonSchema(VaultAdminUnlockRequestSchema),
        WorkspaceImportDryRunResponse: toJsonSchema(WorkspaceImportDryRunResponseSchema),
        WorkspaceImportResponse: toJsonSchema(WorkspaceImportResponseSchema),
        WorkspaceId: toJsonSchema(WorkspaceIdSchema),
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
