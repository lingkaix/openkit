import { CreateAutomationRequestSchema } from '@openkit/app-api-schemas';
import {
  type ActorRef,
  responsibleUserIdForActor,
  SubmitTurnInputRequestSchema,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { asApiError } from '../api-errors.js';
import type { AutomationStore } from '../lib/automation-store.js';
import type { FsStore } from '../lib/store.js';
import { APP_OPENAPI_ROUTE_METHODS, createAppOpenApiDocument } from '../openapi.js';
import { evaluateWorkspaceRoleAccess, type ProductOperation } from '../policy/workspace-access.js';
import type { CoreDb } from '../storage/db.js';
import {
  listActiveWorkspaceIdsForActor,
  resolveWorkspaceRole,
  type WorkspaceRole,
} from '../workspace-membership.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import type { Actor } from './identity.js';
import type { AuthVariables } from './middleware.js';
import {
  PUBLIC_OPERATION_ACCESS,
  type PublicOperationAccess,
  type WorkspaceOperationAccess,
} from './operation-access.js';

const GatewayWorkspaceAttributionSchema = z
  .object({
    metadata: z
      .object({
        openkit: z
          .object({
            workspaceId: z.string().min(1).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Authorized Workspace context exposed to one guarded handler. */
export type WorkspaceAccess =
  | {
      /** Single-Workspace authorization result. */
      readonly kind: 'workspace';
      /** Canonical authorized Workspace id. */
      readonly workspaceId: string;
      /** Effective fixed role derived from current Core facts. */
      readonly effectiveRole: WorkspaceRole;
      /** Product operation allowed by the policy adapter. */
      readonly policyOperation: ProductOperation;
    }
  | {
      /** Multi-Workspace collection authorization result. */
      readonly kind: 'workspace-set';
      /** Canonical authorized Workspace ids. */
      readonly workspaceIds: string[];
      /** Product operation allowed for every returned Workspace. */
      readonly policyOperation: ProductOperation;
    };

/** Dependencies for exact public-operation authorization guards. */
export interface RegisterOperationAccessGuardsInput {
  /** Hono app receiving guards before public handlers are registered. */
  readonly app: Hono<{ Variables: AuthVariables }>;
  /** Existing process-local Automation owner used for opaque lineage. */
  readonly automationStore: AutomationStore;
  /** Core database owning Workspace registry and membership authority. */
  readonly coreDb: CoreDb;
  /** Derives the built-in Quick Chat Workspace for one canonical user. */
  readonly quickChatWorkspaceIdForUser: (userId: string) => string;
  /** Existing Workspace record owner used for opaque child lineage. */
  readonly store: FsStore;
  /** Process-local owner that fences ordinary Workspace mutations during deletion. */
  readonly workspaceMutationAdmission: WorkspaceMutationAdmission;
}

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

/** One successful single-Workspace policy result. */
interface AuthorizedWorkspace {
  /** Effective fixed role. */
  readonly effectiveRole: WorkspaceRole;
  /** Canonical Workspace id. */
  readonly workspaceId: string;
}

/**
 * Registers exact catalog-driven authorization guards before public handlers.
 *
 * @param input Existing authorization, storage, and lineage owners.
 * @throws When catalog metadata cannot be mapped to one unique canonical route.
 */
export function registerOperationAccessGuards(input: RegisterOperationAccessGuardsInput): void {
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
      const workspaceId = operationWorkspaceId(context, route, input);
      if (route.operationKey === 'deleteWorkspace' || !workspaceId) {
        await next();
        return;
      }
      if (input.workspaceMutationAdmission.isClosed(workspaceId)) {
        return workspaceAccessDenied();
      }
      if (!route.access.mutating) {
        await next();
        return;
      }
      const release = input.workspaceMutationAdmission.enter(workspaceId);
      if (!release) {
        return workspaceAccessDenied();
      }
      try {
        await next();
      } finally {
        release();
      }
    });
  }
}

/** Resolves the existing Workspace mutated by routes whose authorization scope is not Workspace. */
function operationWorkspaceId(
  context: Context<{ Variables: AuthVariables }>,
  route: OperationRoute,
  input: RegisterOperationAccessGuardsInput
): string | null {
  const access = context.get('workspaceAccess');
  if (access?.kind === 'workspace') {
    return access.workspaceId;
  }
  if (['leaveWorkspace', 'recoverWorkspaceAccess'].includes(route.operationKey)) {
    return context.req.param('workspaceId') || null;
  }
  if (['acceptWorkspaceInvitation', 'declineWorkspaceInvitation'].includes(route.operationKey)) {
    const row = input.coreDb.sqlite
      .prepare('SELECT workspace_id FROM workspace_invitations WHERE invitation_id = ?')
      .get(context.req.param('invitationId')) as { workspace_id: string } | undefined;
    return row?.workspace_id ?? null;
  }
  return null;
}

/**
 * Requires a handler-owned child to belong to its already authorized Workspace.
 *
 * @param access Central authorization result from request context.
 * @param actualWorkspaceId Workspace id read from the child record owner, or null when its scoped owner cannot distinguish missing from mismatched lineage.
 * @throws HTTPException carrying the uniform Workspace access denial response on mismatch.
 */
export function assertAuthorizedWorkspaceLineage(
  access: WorkspaceAccess | undefined,
  actualWorkspaceId: string | null
): asserts access is Extract<WorkspaceAccess, { kind: 'workspace' }> {
  if (access?.kind !== 'workspace' || access.workspaceId !== actualWorkspaceId) {
    throw new HTTPException(403, { res: workspaceAccessDenied() });
  }
}

/**
 * Evaluates an additional Workspace through the same actor and policy intersection as a guarded request.
 *
 * @param coreDb Core Workspace authority.
 * @param actor Authenticated request actor.
 * @param workspaceId Canonical Workspace id.
 * @param access Exact product operation and mutation posture.
 * @returns True only when the central Workspace predicate allows the operation.
 */
export function isWorkspaceOperationAuthorized(
  coreDb: CoreDb,
  actor: Actor,
  workspaceId: string,
  access: Pick<PublicOperationAccess, 'mutating' | 'policyOperation'>
): boolean {
  return authorizeWorkspace(coreDb, actor, workspaceId, access) !== null;
}

/**
 * Composes current Workspace authority from one actor, fixed role, policy operation, and caller-owned effect authority.
 *
 * @param coreDb Core Workspace authority.
 * @param workspaceId Canonical target Workspace id.
 * @param actor Immutable actor responsible for the effect.
 * @param operation Concrete product operation, including unknown values that must fail closed.
 * @param effectAuthority Whether the caller's existing effect-specific authority remains valid.
 * @returns The current effective Workspace role, or null when any authority component denies the effect.
 */
export function currentWorkspaceAuthority(
  coreDb: CoreDb,
  workspaceId: string,
  actor: ActorRef,
  operation: string,
  effectAuthority: boolean
): WorkspaceRole | null {
  if (!effectAuthority) {
    return null;
  }
  const responsibleUserId = responsibleUserIdForActor(actor);
  if (!responsibleUserId) {
    return null;
  }
  const role = resolveWorkspaceRole(coreDb, workspaceId, responsibleUserId);
  if (!role || evaluateWorkspaceRoleAccess({ operation, role }).effect !== 'allow') {
    return null;
  }
  return role;
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
  input: RegisterOperationAccessGuardsInput
): Promise<Response | null> {
  const actor = context.get('actor');
  if (!actor) {
    return workspaceAccessDenied();
  }

  if (route.access.scope === 'user') {
    if (route.access.authentication === 'canonical-user') {
      return actor.kind === 'local' || actor.kind === 'session' ? null : workspaceAccessDenied();
    }
    return authorizeGatewayOperation(context, actor, route.access, input.coreDb);
  }
  if (route.access.scope !== 'workspace') {
    return null;
  }
  if (actor.kind === 'token' && actor.tokenScope === 'server-admin') {
    return workspaceAccessDenied();
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
    return workspaceAccessDenied();
  }
  if (workspaceId === undefined) {
    return actor.kind === 'local' ||
      actor.kind === 'session' ||
      (actor.kind === 'token' && actor.tokenScope === 'server-admin')
      ? null
      : workspaceAccessDenied();
  }

  const authorized = authorizeWorkspace(coreDb, actor, workspaceId, access);
  if (!authorized) {
    return workspaceAccessDenied();
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
  input: RegisterOperationAccessGuardsInput
): Promise<Response | null> {
  if (route.access.resolver === 'authorized-workspace-set') {
    if (readonlyTokenCannotMutate(actor, route.access)) {
      return workspaceAccessDenied();
    }
    const workspaceIds = listActiveWorkspaceIdsForActor(input.coreDb, actor.userId).filter(
      (workspaceId) =>
        !input.workspaceMutationAdmission.isClosed(workspaceId) &&
        authorizeWorkspace(input.coreDb, actor, workspaceId, route.access) !== null
    );
    context.set('workspaceAccess', {
      kind: 'workspace-set',
      policyOperation: route.access.policyOperation,
      workspaceIds,
    });
    return null;
  }

  const workspaceId = await resolveWorkspaceId(context, actor, route, input);
  if (!workspaceId) {
    return workspaceAccessDenied();
  }
  const authorized = authorizeWorkspace(input.coreDb, actor, workspaceId, route.access);
  if (
    !authorized &&
    route.operationKey === 'deleteWorkspace' &&
    hasWorkspaceDeletionRetryAuthority(input.coreDb, actor, workspaceId)
  ) {
    return null;
  }
  if (
    !authorized ||
    (route.access.resolver === 'actor-quick-chat-workspace' && authorized.effectiveRole !== 'owner')
  ) {
    return workspaceAccessDenied();
  }
  context.set('workspaceAccess', {
    ...authorized,
    kind: 'workspace',
    policyOperation: route.access.policyOperation,
  });
  return null;
}

/** Checks the narrow original-owner authority that may only resume one deletion route. */
function hasWorkspaceDeletionRetryAuthority(
  coreDb: CoreDb,
  actor: Actor,
  workspaceId: string
): boolean {
  if (
    actor.kind === 'token' &&
    (actor.tokenScope !== 'workspace' || !actor.tokenWorkspaceIds?.includes(workspaceId))
  ) {
    return false;
  }
  const row = coreDb.sqlite
    .prepare(
      `SELECT registry.owner_user_id AS ownerUserId, registry.status, users.status AS userStatus
       FROM workspace_registry AS registry
       INNER JOIN users ON users.id = registry.owner_user_id
       WHERE registry.workspace_id = ?`
    )
    .get(workspaceId) as
    | { ownerUserId: string; status: 'active' | 'deleting' | 'deleted'; userStatus: string }
    | undefined;
  return (
    row?.ownerUserId === actor.userId &&
    row.userStatus === 'active' &&
    (row.status === 'deleting' || row.status === 'deleted')
  );
}

/**
 * Resolves one operation's Workspace through its declared owner shape.
 *
 * @param context Authenticated request context.
 * @param actor Authenticated request actor.
 * @param route Exact Workspace operation route.
 * @param input Existing lineage owners.
 * @returns Canonical Workspace id, or null when exact lineage cannot be established.
 */
async function resolveWorkspaceId(
  context: Context<{ Variables: AuthVariables }>,
  actor: Actor,
  route: OperationRoute & { readonly access: WorkspaceOperationAccess },
  input: RegisterOperationAccessGuardsInput
): Promise<string | null> {
  try {
    switch (route.access.resolver) {
      case 'actor-quick-chat-workspace':
        return input.quickChatWorkspaceIdForUser(actor.userId);
      case 'body-workspace':
        return bodyWorkspaceId(context, route.operationKey);
      case 'opaque-child-workspace':
        return opaqueChildWorkspaceId(context, actor, route.operationKey, input);
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
 * Authorizes one Workspace against current membership, credential, and policy facts.
 *
 * @param coreDb Core Workspace authority.
 * @param actor Authenticated request actor.
 * @param workspaceId Canonical target Workspace id.
 * @param access Exact operation metadata.
 * @returns Authorized Workspace and effective role, or null on any denial.
 */
function authorizeWorkspace(
  coreDb: CoreDb,
  actor: Actor,
  workspaceId: string,
  access: Pick<PublicOperationAccess, 'mutating' | 'policyOperation'>
): AuthorizedWorkspace | null {
  if (!tokenIncludesWorkspace(actor, workspaceId) || readonlyTokenCannotMutate(actor, access)) {
    return null;
  }
  const effectiveRole = currentWorkspaceAuthority(
    coreDb,
    workspaceId,
    { kind: 'user', id: actor.userId },
    access.policyOperation,
    true
  );
  if (!effectiveRole) {
    return null;
  }
  return { effectiveRole, workspaceId };
}

/**
 * Parses a required Workspace id through the exact body schema for one catalog operation.
 *
 * @param context Hono request context.
 * @param operationKey Exact body-owned operation.
 * @returns Canonical Workspace id, or null when the body is invalid for that operation.
 */
async function bodyWorkspaceId(
  context: Context<{ Variables: AuthVariables }>,
  operationKey: string
): Promise<string | null> {
  const body = await context.req.raw
    .clone()
    .json()
    .catch(() => null);
  if (operationKey === 'createAutomation') {
    const parsed = CreateAutomationRequestSchema.safeParse(body);
    return parsed.success ? parsed.data.workspaceId : null;
  }
  if (operationKey === 'POST /api/turns') {
    const parsed = SubmitTurnInputRequestSchema.safeParse(body);
    return parsed.success ? parsed.data.workspaceId : null;
  }
  return null;
}

/**
 * Resolves an opaque public child through its existing record owner.
 *
 * @param context Hono request context.
 * @param actor Authenticated request actor.
 * @param operationKey Exact opaque-child operation.
 * @param input Existing lineage owners.
 * @returns Canonical Workspace id, or null when the child cannot be resolved.
 */
function opaqueChildWorkspaceId(
  context: Context<{ Variables: AuthVariables }>,
  actor: Actor,
  operationKey: string,
  input: RegisterOperationAccessGuardsInput
): string | null {
  if (operationKey === 'updateAutomation' || operationKey === 'deleteAutomation') {
    const automationId = nonempty(context.req.param('automationId'));
    return automationId
      ? input.automationStore.getAutomation(actor.userId, automationId).workspaceId
      : null;
  }
  if (operationKey === 'submitTurnFeedback') {
    const turnId = nonempty(context.req.param('turnId'));
    return turnId ? input.store.getTurnById(turnId).workspaceId : null;
  }
  if (operationKey === 'POST /api/approvals/:approvalRequestId/respond') {
    const approvalRequestId = nonempty(context.req.param('approvalRequestId'));
    return approvalRequestId ? input.store.getApproval(approvalRequestId).workspaceId : null;
  }
  return null;
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
 * Checks one token's exact Workspace binding while leaving session and local actors unbounded.
 *
 * @param actor Authenticated request actor.
 * @param workspaceId Canonical target Workspace id.
 * @returns True when the actor's credential may address the Workspace.
 */
function tokenIncludesWorkspace(actor: Actor, workspaceId: string): boolean {
  if (actor.kind !== 'token') {
    return true;
  }
  if (actor.tokenScope !== 'workspace' && actor.tokenScope !== 'workspace-readonly') {
    return false;
  }
  return actor.tokenWorkspaceIds?.includes(workspaceId) === true;
}

/**
 * Checks the catalog mutation posture against a readonly token.
 *
 * @param actor Authenticated request actor.
 * @param access Exact operation metadata.
 * @returns True when a readonly credential cannot invoke the declared mutation.
 */
function readonlyTokenCannotMutate(
  actor: Actor,
  access: Pick<PublicOperationAccess, 'mutating'>
): boolean {
  return actor.kind === 'token' && actor.tokenScope === 'workspace-readonly' && access.mutating;
}

/**
 * Maps every guarded catalog entry to its canonical method and Hono route path.
 *
 * @returns Unique non-server operation routes.
 * @throws When a catalog operation has no canonical route owner.
 */
function guardedOperationRoutes(): OperationRoute[] {
  const appRoutes = appOperationRoutes();
  const routes: OperationRoute[] = [];

  for (const [operationKey, access] of Object.entries(PUBLIC_OPERATION_ACCESS)) {
    if (access.scope === 'server') {
      continue;
    }
    const direct = directOperationRoute(operationKey);
    const route = direct ?? appRoutes.get(operationKey);
    if (!route) {
      throw new Error(`Public operation has no canonical route: ${operationKey}.`);
    }
    routes.push({ ...route, access, operationKey });
  }
  return routes;
}

/**
 * Builds canonical App operation routes from the OpenAPI owner.
 *
 * @returns Operation id to method and Hono path mapping.
 * @throws When the OpenAPI owner contains a duplicate operation id.
 */
function appOperationRoutes(): Map<string, Pick<OperationRoute, 'method' | 'path'>> {
  const routes = new Map<string, Pick<OperationRoute, 'method' | 'path'>>();
  const document = createAppOpenApiDocument();

  for (const [openApiPath, pathItem] of Object.entries(document.paths)) {
    for (const method of APP_OPENAPI_ROUTE_METHODS) {
      const operation = (pathItem as Readonly<Record<string, unknown>>)[method];
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
        continue;
      }
      const operationId = (operation as Readonly<Record<string, unknown>>).operationId;
      if (typeof operationId !== 'string' || routes.has(operationId)) {
        throw new Error(`Invalid or duplicate App operation id at ${method} ${openApiPath}.`);
      }
      routes.set(operationId, {
        method: method.toUpperCase(),
        path: openApiPath.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1'),
      });
    }
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

/** Returns the uniform non-enumerating Workspace access failure. */
function workspaceAccessDenied(): Response {
  return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
}
