import { createHash } from 'node:crypto';

import {
  AcceptWorkspaceInvitationRequestSchema,
  AppUpdateStatusResponseSchema,
  ChangeWorkspaceMemberAccessRequestSchema,
  CreateWorkspaceInvitationRequestSchema,
  CreateWorkspaceVaultGrantRequestSchema,
  CreateWorkspaceVaultSecretRequestSchema,
  DeclineWorkspaceInvitationRequestSchema,
  DeleteWorkspaceRequestSchema,
  DisableUserRequestSchema,
  DisableUserResponseSchema,
  type JsonOperationId,
  LeaveWorkspaceRequestSchema,
  ListPluginCatalogResponseSchema,
  ListSkillCatalogResponseSchema,
  ListWorkspaceInvitationsResponseSchema,
  ListWorkspaceMembersResponseSchema,
  OPERATION_DEFINITIONS,
  operationHttpPath,
  operationModelInput,
  operationUsesBootstrapSecret,
  RecoverDeletedWorkspaceRequestSchema,
  RecoverDeletedWorkspaceResponseSchema,
  RecoverWorkspaceAccessRequestSchema,
  RemoveWorkspaceMemberRequestSchema,
  RevokeWorkspaceInvitationRequestSchema,
  RotateWorkspaceVaultSecretRequestSchema,
  SetProviderApiKeyRequestSchema,
  TransferWorkspaceOwnershipRequestSchema,
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
const WORKSPACE_ID_PARAMETER = {
  name: 'workspaceId',
  in: 'path',
  required: true,
  schema: { $ref: '#/components/schemas/WorkspaceId' },
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
const REQUEST_ID_HEADER = {
  name: 'x-openkit-request-id',
  in: 'header',
  required: true,
  schema: { type: 'string', format: 'uuid' },
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
    Object.entries(OPERATION_DEFINITIONS)
      .filter(([, definition]) => definition.binding === 'json')
      .map(([id, definition]) => [
        operationHttpPath(id),
        {
          post: appJsonOperation({
            operationId: id,
            tag: id.split('.')[0]!,
            summary: definition.description,
            ...(operationUsesBootstrapSecret(definition)
              ? { security: [] }
              : definition.scope.kind === 'server'
                ? { security: DEPLOYMENT_ADMIN_SECURITY }
                : {}),
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
    [K in JsonOperationId as `/api/app/operations/${K}`]: {
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
      '/api/app/workspaces/{workspaceId}/exports/{exportId}/archive': {
        get: {
          operationId: 'workspace.archive-download',
          tags: ['storage'],
          summary: OPERATION_DEFINITIONS['workspace.archive-download'].description,
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
          operationId: 'workspace.archive-import-dry-run',
          tags: ['storage'],
          summary: OPERATION_DEFINITIONS['workspace.archive-import-dry-run'].description,
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
          operationId: 'workspace.archive-import',
          tags: ['storage'],
          summary: OPERATION_DEFINITIONS['workspace.archive-import'].description,
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
          Object.entries(OPERATION_DEFINITIONS)
            .filter(([, definition]) => definition.binding === 'json')
            .flatMap(([id, definition]) => [
              [
                `${id}.input`,
                toJsonSchema(
                  operationModelInput(
                    definition.inputSchema,
                    definition.mutating ? ['requestId'] : []
                  )
                ),
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

        AppUpdateStatusResponse: toJsonSchema(AppUpdateStatusResponseSchema),
        ListPluginCatalogResponse: toJsonSchema(ListPluginCatalogResponseSchema),
        ListSkillCatalogResponse: toJsonSchema(ListSkillCatalogResponseSchema),
        CreateWorkspaceVaultSecretRequest: toJsonSchema(CreateWorkspaceVaultSecretRequestSchema),
        RotateWorkspaceVaultSecretRequest: toJsonSchema(RotateWorkspaceVaultSecretRequestSchema),
        CreateWorkspaceVaultGrantRequest: toJsonSchema(CreateWorkspaceVaultGrantRequestSchema),
        VaultAdminWorkspaceReference: toJsonSchema(VaultAdminWorkspaceReferenceSchema),
        WorkspaceVaultGrant: toJsonSchema(WorkspaceVaultGrantSchema),
        SetProviderApiKeyRequest: toJsonSchema(SetProviderApiKeyRequestSchema),
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
