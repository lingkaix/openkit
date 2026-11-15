import {
  COMPOSER_TRANSCRIBE_MAX_BODY_BYTES,
  type JsonOperationId,
  OPERATION_DEFINITIONS,
  type OperationDefinition,
  operationUsesBootstrapSecret,
} from '@openkit/app-api-schemas';
import { WorkspaceIdSchema } from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { apiErrorPayload, asApiError, asOperationError } from './api-errors.js';
import { captureRetryContext, captureRetryHeaders } from './auth/capture-retry-context.js';
import type { Actor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import {
  PUBLIC_OPERATION_ACCESS,
  type PublicOperationAccess,
  type WorkspaceOperationAccess,
} from './auth/operation-access.js';
import {
  authorizedWorkspaceSet,
  authorizeWorkspace,
  DeploymentAdminRequiredError,
  isCanonicalUserOperationAuthorized,
  requireCurrentDeploymentAdmin,
  requireThreadAudience,
} from './auth/operation-authorizer.js';
import { assertScopeAdmitted } from './bootstrap/readiness.js';
import { submitConversationFiles } from './conversation-file-routes.js';
import type { FsStore } from './lib/store.js';
import { decodeTranscriptionAudio } from './llm/audio-transcription.js';
import { getAppApiRouteDefinition, registerAppApiRoute } from './openapi.js';
import {
  createOperationInvocation,
  type OperationInvocationDependencies,
} from './operation-composition.js';
import type { OperationInvocationContext } from './operation-contract.js';
import { OperationError, projectOperationError } from './operation-error.js';
import { parseOperationInput } from './operation-resolvers.js';
import type { WorkspaceMutationAdmission } from './storage/control-store-worker-client.js';
import type { CoreDb } from './storage/db.js';

/** Operation framing selects JSON or conversation file bodies; native invocation owns complete parsing and admission. */
export function registerOperationJsonRoutes(
  dependencies: OperationInvocationDependencies & {
    app: Hono<{ Variables: AuthVariables }>;
    requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  }
): void {
  const { app, requestStore } = dependencies;
  for (const [id, declared] of Object.entries(OPERATION_DEFINITIONS)) {
    const definition: OperationDefinition = declared;
    if (definition.binding !== 'json') continue;
    registerAppApiRoute(app, id as JsonOperationId, async (c) => {
      // Initialize response headers so returned Responses and the HTTP error handler inherit the same cache policy.
      c.res.headers.set('Cache-Control', 'no-store');
      try {
        const retryContext = c.req.header('x-openkit-retry-context');
        if (retryContext !== undefined && retryContext !== captureRetryContext(c.get('actor')))
          throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
        if (operationUsesBootstrapSecret(definition) && c.get('bootstrapSecretAdmission') !== true)
          throw new OperationError('core.auth.unauthenticated', 'Authentication required.', 401);
        if (
          definition.binaryRequestBody &&
          c.req.header('content-type') === definition.binaryRequestBody.mediaType
        ) {
          if (!dependencies.conversationService || !dependencies.fileAdmission)
            throw new OperationError(
              'operation_storage_unavailable',
              'File storage is unavailable.',
              503
            );
          return await submitConversationFiles(c, {
            ...dependencies,
            conversationService: dependencies.conversationService,
            fileAdmission: dependencies.fileAdmission,
            dataRoot: dependencies.dataRoot ?? null,
          });
        }
        const body = await readOperationBody(c, id);
        if (typeof body !== 'object' || body === null || Array.isArray(body))
          throw new OperationError(
            definition.invalidInputCode ?? 'invalid_request',
            'Invalid operation input.',
            400
          );
        const args = body as Record<string, unknown>;
        const requestId = c.req.header('x-openkit-request-id');
        if (definition.mutating && Object.hasOwn(args, 'requestId') && args.requestId !== requestId)
          throw new OperationError(
            'bound_input_conflict',
            'Request identity conflicts with its header.',
            403
          );
        const input =
          definition.mutating && 'requestId' in definition.inputSchema.shape
            ? { ...args, requestId }
            : args;
        // HTTP must refuse malformed input before selecting a request store; native entries independently use the same validator.
        const entry: OperationInvocationContext = operationUsesBootstrapSecret(definition)
          ? { kind: 'bootstrap', delivery: 'human', signal: c.req.raw.signal }
          : { kind: 'public', actor: c.get('actor'), delivery: 'human', signal: c.req.raw.signal };
        parseOperationInput(definition, input, entry);
        if (id === 'composer.transcribe' && typeof args.audio === 'string')
          decodeTranscriptionAudio(args.audio);
        let successStatus: 200 | 201 | 202 | 204 = definition.successStatus;
        const invoke = createOperationInvocation({
          ...dependencies,
          ...(entry.kind === 'bootstrap' ? {} : { store: requestStore(c) }),
        });
        const output = await invoke(id as JsonOperationId, input, {
          ...entry,
          observeSuccessStatus: (status) => {
            successStatus = status;
          },
        });
        return successStatus === 204 ? c.body(null, 204) : c.json(output, successStatus);
      } catch (error) {
        return asOperationError(error, projectOperationError(error), c.get('actor'));
      }
    });
  }
}

/** Reads JSON, counting composer.transcribe bytes before parse, including bodies without Content-Length. */
async function readOperationBody(
  c: Context<{ Variables: AuthVariables }>,
  id: string
): Promise<unknown> {
  if (id !== 'composer.transcribe') {
    return c.req.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) return null;
      throw error;
    });
  }
  const declared = c.req.header('content-length');
  if (declared !== undefined) {
    if (!/^\d+$/.test(declared)) {
      throw new OperationError('invalid_request', 'Invalid operation input.', 400);
    }
    if (Number(declared) > COMPOSER_TRANSCRIBE_MAX_BODY_BYTES) {
      throw new OperationError(
        'payload_too_large',
        'Transcription audio exceeds the size limit.',
        413
      );
    }
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > COMPOSER_TRANSCRIBE_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new OperationError(
        'payload_too_large',
        'Transcription audio exceeds the size limit.',
        413
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

const GatewayWorkspaceAttributionSchema = z
  .object({
    metadata: z
      .object({
        openkit: z
          .object({
            workspaceId: WorkspaceIdSchema.optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** One exact method and Hono path owned by a catalog operation. */
interface OperationRoute {
  /** Explicit access declaration for the operation. */
  readonly access: PublicOperationAccess;
  /** Uppercase HTTP method. */
  readonly method: string;
  /** Canonical App operation id or direct route key. */
  readonly operationKey: string;
  /** Hono path with colon-prefixed parameters. */
  readonly path: string;
}

/** Reports only an already-authorized target whose new mutation was not admitted. */
function frozenWorkspace(workspaceId: string, actor?: Actor, captureActive = false): Response {
  return Response.json(
    apiErrorPayload({
      code: 'workspace_frozen',
      message: 'Workspace is temporarily frozen.',
      details: {
        workspaceId,
        operation: 'capture',
        retryable: true,
        blockers: [
          { kind: 'publication', reason: 'frozen', reference: { workspaceId }, actions: [] },
        ],
      },
    }),
    { status: 409, ...(captureActive ? { headers: captureRetryHeaders(actor) } : {}) }
  );
}

/**
 * Registers exact catalog-driven authorization guards before public handlers.
 *
 * @param input Existing authorization, storage, and lineage owners.
 * @throws When catalog metadata cannot be mapped to one unique canonical route.
 */
export function registerRetainedOperationRoutes(input: {
  /** Hono app receiving guards before public handlers are registered. */
  readonly app: Hono<{ Variables: AuthVariables }>;
  /** Core database owning Workspace registry and membership authority. */
  readonly coreDb: CoreDb;
  /** App composition supplies only current shared availability, never caller authority. */
  readonly operationAvailable?: (operationKey: string) => boolean;
  /** Derives the built-in Quick Chat Workspace for one canonical user. */
  readonly quickChatWorkspaceIdForUser: (userId: string) => string;
  /** Existing Workspace record owner used for opaque child lineage. */
  readonly store: FsStore;
  /** Process-local owner that fences ordinary Workspace mutations during deletion. */
  readonly workspaceMutationAdmission: WorkspaceMutationAdmission;
}): void {
  const routesByPath = new Map<string, Map<string, OperationRoute>>();

  for (const route of guardedOperationRoutes()) {
    const methods = routesByPath.get(route.path) ?? new Map<string, OperationRoute>();
    if (methods.has(route.method)) {
      throw new Error(`Duplicate guarded public route: ${route.method} ${route.path}.`);
    }
    methods.set(route.method, route);
    routesByPath.set(route.path, methods);
  }

  for (const [path, methods] of routesByPath) {
    input.app.use(path, async (context, next) => {
      const route = methods.get(context.req.method.toUpperCase());
      if (!route) {
        await next();
        return;
      }

      const denied = await authorizeOperation(context, route, input);
      if (denied) {
        return denied;
      }
      if (input.operationAvailable && !input.operationAvailable(route.operationKey))
        return asApiError('Resource is unavailable.', 'route_group_unavailable', 403);
      const access = context.get('workspaceAccess');
      const workspaceId = access?.kind === 'workspace' ? access.workspaceId : null;
      if (!workspaceId) {
        await next();
        return;
      }
      // Eligibility permits the owning quarantine diagnosis, before lifecycle gate refusals.
      try {
        assertScopeAdmitted(input.coreDb.dataRoot, 'workspace', workspaceId);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'recovery_required' &&
          'status' in error &&
          error.status === 409
        )
          return asApiError(error.message, error.code, error.status);
        throw error;
      }
      // Capture keeps the Workspace visible and readable. Deletion close still hides it.
      if (input.workspaceMutationAdmission.isLifecycleClosed(workspaceId)) {
        if (route.access.mutating) return frozenWorkspace(workspaceId);
        return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
      }
      if (!route.access.mutating) {
        await next();
        return;
      }
      const release = input.workspaceMutationAdmission.enter(workspaceId);
      if (!release)
        return frozenWorkspace(
          workspaceId,
          context.get('actor'),
          input.workspaceMutationAdmission.isCaptureActive(workspaceId)
        );
      try {
        await next();
      } finally {
        release();
      }
    });
  }
}

/**
 * Authorizes one exact catalog operation and installs its bounded context result.
 *
 * @param context Authenticated Hono request context.
 * @param route Exact catalog route and access metadata.
 * @param input Existing authorization and lineage owners.
 * @returns Uniform denial response, or null after successful authorization.
 */
async function authorizeOperation(
  context: Context<{ Variables: AuthVariables }>,
  route: OperationRoute,
  input: Parameters<typeof registerRetainedOperationRoutes>[0]
): Promise<Response | null> {
  const actor = context.get('actor');
  if (!actor) {
    return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
  }

  if (route.access.scope === 'user') {
    if (route.access.authentication === 'canonical-user') {
      return isCanonicalUserOperationAuthorized(input.coreDb, actor, route.access.policyOperation)
        ? null
        : asApiError('Workspace access denied.', 'workspace_access_denied', 403);
    }
    return authorizeGatewayOperation(context, actor, route.access, input.coreDb);
  }
  if (route.access.scope !== 'workspace') {
    return null;
  }
  if (route.access.authentication === 'deployment-admin') {
    try {
      requireCurrentDeploymentAdmin(input.coreDb, actor);
    } catch (error) {
      if (error instanceof DeploymentAdminRequiredError) {
        return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
      }
      throw error;
    }
  }

  return authorizeWorkspaceOperation(context, actor, { ...route, access: route.access }, input);
}

/**
 * Applies optional public Gateway attribution without inventing a top-level fallback.
 *
 * @param context Authenticated Gateway request context.
 * @param actor Authenticated request actor.
 * @param access Gateway operation metadata.
 * @param coreDb Core Workspace authority.
 * @returns Uniform denial response, or null after successful optional attribution.
 */
async function authorizeGatewayOperation(
  context: Context<{ Variables: AuthVariables }>,
  actor: Actor,
  access: Extract<PublicOperationAccess, { authentication: 'gateway-actor' }>,
  coreDb: CoreDb
): Promise<Response | null> {
  const workspaceId = await gatewayWorkspaceId(context);
  if (workspaceId === null) {
    return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
  }
  if (workspaceId === undefined) {
    return isCanonicalUserOperationAuthorized(coreDb, actor, access.policyOperation)
      ? null
      : asApiError('Workspace access denied.', 'workspace_access_denied', 403);
  }

  const authorized = authorizeWorkspace(coreDb, actor, workspaceId, access);
  if (!authorized) {
    return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
  }
  context.set('workspaceAccess', {
    ...authorized,
    kind: 'workspace',
    policyOperation: access.policyOperation,
  });
  return null;
}

/**
 * Resolves and authorizes one direct Workspace operation.
 *
 * @param context Authenticated request context.
 * @param actor Authenticated request actor.
 * @param route Exact operation route.
 * @param input Existing authorization and lineage owners.
 * @returns Uniform denial response, or null after successful authorization.
 */
async function authorizeWorkspaceOperation(
  context: Context<{ Variables: AuthVariables }>,
  actor: Actor,
  route: OperationRoute & { readonly access: WorkspaceOperationAccess },
  input: Parameters<typeof registerRetainedOperationRoutes>[0]
): Promise<Response | null> {
  if (route.access.resolver === 'authorized-workspace-set') {
    if (
      actor.kind === 'token' &&
      actor.tokenScope === 'workspace-readonly' &&
      route.access.mutating
    ) {
      return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
    }
    const workspaceIds = authorizedWorkspaceSet(
      input.coreDb,
      actor,
      route.access,
      input.workspaceMutationAdmission
    );
    context.set('workspaceAccess', {
      kind: 'workspace-set',
      policyOperation: route.access.policyOperation,
      workspaceIds,
    });
    return null;
  }

  const workspaceId = resolveWorkspaceId(context, route);
  if (!workspaceId) {
    return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
  }
  const authorized = authorizeWorkspace(input.coreDb, actor, workspaceId, route.access);
  if (
    !authorized ||
    (route.access.resolver === 'actor-quick-chat-workspace' && !authorized.isOwner)
  ) {
    return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
  }
  context.set('workspaceAccess', {
    ...authorized,
    kind: 'workspace',
    policyOperation: route.access.policyOperation,
  });
  const threadId = nonempty(context.req.param('threadId'));
  if (threadId === null) return null;
  try {
    requireThreadAudience(
      input.store,
      input.coreDb,
      { kind: 'public', actor, signal: context.req.raw.signal },
      authorized.workspaceId,
      threadId,
      route.access.policyOperation,
      { quickChatWorkspaceIdForUser: input.quickChatWorkspaceIdForUser }
    );
    return null;
  } catch {
    return threadNotFound();
  }
}

/**
 * Resolves one operation's Workspace through its declared owner shape.
 * JSON selectors are admitted by native invocation and never create a retained HTTP guard.
 *
 * @param context Authenticated request context.
 * @param route Exact Workspace operation route.
 * @returns Canonical Workspace id, or null when exact lineage cannot be established.
 */
function resolveWorkspaceId(
  context: Context<{ Variables: AuthVariables }>,
  route: OperationRoute & { readonly access: WorkspaceOperationAccess }
): string | null {
  try {
    switch (route.access.resolver) {
      case 'actor-quick-chat-workspace':
      case 'body-workspace':
      case 'opaque-child-workspace':
        // These migrated selectors are admitted by native operation invocation.
        return null;
      case 'path-workspace':
      case 'workspace-child-lineage':
        return nonempty(context.req.param('workspaceId'));
      case 'authorized-workspace-set':
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Reads optional Workspace attribution only from `metadata.openkit.workspaceId`.
 *
 * @param context Public Gateway request context.
 * @returns Canonical Workspace id, undefined when absent, or null when malformed.
 */
async function gatewayWorkspaceId(
  context: Context<{ Variables: AuthVariables }>
): Promise<string | null | undefined> {
  const parsed = GatewayWorkspaceAttributionSchema.safeParse(
    await context.req.raw
      .clone()
      .json()
      .catch(() => null)
  );
  return parsed.success ? parsed.data.metadata?.openkit?.workspaceId : null;
}

/**
 * Maps retained routes to guards. Canonical operation routes perform native admission, including bounded streaming metadata.
 *
 * @returns Unique retained non-server operation routes.
 * @throws When a catalog operation has no canonical route owner.
 */
function guardedOperationRoutes(): OperationRoute[] {
  const appRoutes = appOperationRoutes();
  const routes: OperationRoute[] = [];

  for (const [operationKey, access] of Object.entries(PUBLIC_OPERATION_ACCESS)) {
    if (
      access.scope === 'server' ||
      (Object.hasOwn(OPERATION_DEFINITIONS, operationKey) &&
        OPERATION_DEFINITIONS[operationKey as keyof typeof OPERATION_DEFINITIONS].binding ===
          'json')
    ) {
      continue;
    }
    const direct = directOperationRoute(operationKey);
    const route = direct ?? appRoutes.get(operationKey);
    if (!route) {
      throw new Error(`Public operation has no canonical route: ${operationKey}.`);
    }
    // Canonical operation routes admit their parsed selectors before reading a body stream.
    // Retained archive paths continue to use the guards below.
    if (route.path === `/api/app/operations/${operationKey}`) continue;
    routes.push({ ...route, access, operationKey });
  }
  return routes;
}

/**
 * Builds canonical App operation routes from the checked source catalog bindings.
 *
 * @returns Operation id to method and Hono path mapping.
 * @throws When the source catalog contains a missing or duplicate operation id.
 */
function appOperationRoutes(): Map<string, Pick<OperationRoute, 'method' | 'path'>> {
  const routes = new Map<string, Pick<OperationRoute, 'method' | 'path'>>();

  for (const operationId of Object.keys(
    OPERATION_DEFINITIONS
  ) as (keyof typeof OPERATION_DEFINITIONS)[]) {
    const binding = getAppApiRouteDefinition(operationId);
    routes.set(operationId, {
      method: binding.method.toUpperCase(),
      path: binding.path,
    });
  }
  return routes;
}

/**
 * Parses an explicit direct route key from the catalog.
 *
 * @param operationKey Catalog operation key.
 * @returns Direct method and Hono path, or null for an App operation id.
 */
function directOperationRoute(
  operationKey: string
): Pick<OperationRoute, 'method' | 'path'> | null {
  const match = /^([A-Z]+) (\/.*)$/.exec(operationKey);
  return match ? { method: match[1] ?? '', path: match[2] ?? '' } : null;
}

/**
 * Normalizes one required route-derived identifier.
 *
 * @param value Raw route parameter.
 * @returns Non-empty value, or null.
 */
function nonempty(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

/** Returns the uniform missing-or-inaccessible Thread failure. */
function threadNotFound(): Response {
  return asApiError('Thread not found.', 'not_found', 404);
}
