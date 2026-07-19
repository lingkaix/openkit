import {
  AcceptWorkspaceInvitationRequestSchema,
  type AuthorizedWorkspaceSummary,
  AuthorizedWorkspaceSummarySchema,
  ChangeWorkspaceMemberAccessRequestSchema,
  CreateWorkspaceInvitationRequestSchema,
  DeclineWorkspaceInvitationRequestSchema,
  DisableUserRequestSchema,
  DisableUserResponseSchema,
  LeaveWorkspaceRequestSchema,
  ListAuthorizedWorkspacesResponseSchema,
  ListWorkspaceInvitationsResponseSchema,
  ListWorkspaceMembersResponseSchema,
  RecoverWorkspaceAccessRequestSchema,
  RemoveWorkspaceMemberRequestSchema,
  RevokeWorkspaceInvitationRequestSchema,
  TransferWorkspaceOwnershipRequestSchema,
  WorkspaceAccessRecoveryResponseSchema,
  type WorkspaceAccessRecoveryState,
  type WorkspaceInvitation,
  WorkspaceInvitationMutationResponseSchema,
  type WorkspaceMember,
  WorkspaceMemberMutationResponseSchema,
  WorkspaceOwnershipMutationResponseSchema,
  WorkspaceSharingErrorSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { apiErrorPayload, asCommandError, asInvalidRequestError } from './api-errors.js';
import { recordServerAuditEvent } from './audit-events.js';
import { type Actor, isDeploymentAdminActor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import {
  assertAuthorizedWorkspaceLineage,
  isWorkspaceOperationAuthorized,
} from './auth/operation-authorizer.js';
import { disableCanonicalUser } from './auth/user-lifecycle.js';
import {
  type CommandRequestRecord,
  type FsStore,
  quickChatWorkspaceIdForUser,
} from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import type { CoreDb } from './storage/db.js';
import {
  acceptWorkspaceInvitation,
  type CreateWorkspaceInvitationResult,
  changeWorkspaceMemberAccess,
  createWorkspaceInvitation,
  declineWorkspaceInvitation,
  getWorkspaceAccessRecoveryState,
  getWorkspaceInvitation,
  getWorkspaceMember,
  getWorkspaceRegistryFact,
  leaveWorkspace,
  listAuthorizedWorkspaceRegistryFacts,
  listMyWorkspaceInvitations,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  type RecoverWorkspaceAccessResult,
  recoverWorkspaceAccess,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
  type TransferWorkspaceOwnershipResult,
  transferWorkspaceOwnership,
  type WorkspaceInvitationTransitionResult,
  type WorkspaceMemberMutationResult,
  type WorkspaceRegistryFact,
} from './workspace-sharing.js';

/** Stable Core scope selector shared by every Stage 5 lifecycle receipt. */
const CORE_RECEIPT_OWNER = { coreId: 'server' } as const;

/** Route error with one stable public code and optional safe details. */
class WorkspaceSharingRouteError extends Error {
  /** Stable public error code. */
  public readonly code: string;
  /** Optional product-safe error details. */
  public readonly details: unknown;
  /** HTTP response status. */
  public readonly status: number;

  /** Creates one route-owned typed failure. */
  public constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'WorkspaceSharingRouteError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

/** Dependencies for the closed Stage 5 Workspace sharing route surface. */
export interface RegisterWorkspaceSharingRoutesInput {
  /** Hono app receiving the exact OpenAPI-owned routes. */
  readonly app: Hono<{ Variables: AuthVariables }>;
  /** Optional Core database; handlers fail closed when it is unavailable. */
  readonly coreDb: CoreDb | undefined;
  /** Existing process-local command collapse map. */
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  /** Resolves the process-local shared Workspace store for one request. */
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}

/**
 * Registers the exact fifteen sharing and user-lifecycle App API operations.
 *
 * @param input Existing app, Core, receipt, and Workspace owners.
 */
export function registerWorkspaceSharingRoutes(input: RegisterWorkspaceSharingRoutesInput): void {
  const { app, inflightCommands, requestStore } = input;

  registerAppApiRoute(app, 'listAuthorizedWorkspaces', (context) => {
    try {
      const coreDb = requireCoreDb(input.coreDb);
      const access = context.get('workspaceAccess');
      if (access?.kind !== 'workspace-set') {
        throw accessDenied();
      }
      const store = requestStore(context);
      const actorId = requireActor(context).userId;
      const facts = new Map(
        listAuthorizedWorkspaceRegistryFacts(coreDb, actorId).map((fact) => [
          fact.workspaceId,
          fact,
        ])
      );
      const items = access.workspaceIds.map((workspaceId) => {
        const fact = facts.get(workspaceId);
        if (!fact) {
          throw accessDenied();
        }
        return AuthorizedWorkspaceSummarySchema.parse({
          effectiveRole: fact.effectiveRole,
          membershipRevision: fact.membershipRevision,
          ownerUserId: fact.ownerUserId,
          registryRevision: fact.registryRevision,
          workspace: store.getWorkspace(workspaceId),
        });
      });
      return context.json(ListAuthorizedWorkspacesResponseSchema.parse({ items }));
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceMembers', (context) => {
    try {
      return context.json(
        ListWorkspaceMembersResponseSchema.parse({
          items: listWorkspaceMembers(
            requireCoreDb(input.coreDb),
            context.req.param('workspaceId')
          ),
        })
      );
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceInvitations', (context) => {
    try {
      return context.json(
        ListWorkspaceInvitationsResponseSchema.parse({
          items: listWorkspaceInvitations(
            requireCoreDb(input.coreDb),
            context.req.param('workspaceId')
          ),
        })
      );
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'createWorkspaceInvitation', async (context) => {
    try {
      const coreDb = requireCoreDb(input.coreDb);
      const store = requestStore(context);
      const actorId = requireActor(context).userId;
      const workspaceId = context.req.param('workspaceId');
      const request = CreateWorkspaceInvitationRequestSchema.parse(
        await context.req.json().catch(() => ({}))
      );
      requireShareableWorkspace(coreDb, workspaceId);
      const invitation = await runIdempotentCommand({
        command: 'workspace.invitation.create',
        coreDb,
        coreTransaction: true,
        execute: () => {
          requireNoLifecycleAudit(coreDb, {
            action: 'workspace.invitation.create',
            actorId,
            requestId: request.requestId,
            workspaceId,
          });
          const result = createWorkspaceInvitation({
            coreDb,
            inviterUserId: actorId,
            inviteeEmail: request.inviteeEmail,
            proposedAccessLevel: request.proposedAccessLevel,
            workspaceId,
          });
          const created = requireCreatedInvitation(result);
          recordLifecycleAudit(coreDb, {
            action: 'workspace.invitation.create',
            actorId,
            requestId: request.requestId,
            resource: `workspace-invitation:${created.invitationId}`,
            resourceRevision: created.revision,
            subjectId: created.inviteeUserId,
            summary: 'Workspace invitation created.',
            workspaceId,
          });
          return created;
        },
        inflightCommands,
        input: request,
        replay: (record) => {
          const replayed = requireReceiptInvitation(coreDb, record);
          assertAuthorizedWorkspaceLineage(context.get('workspaceAccess'), replayed.workspaceId);
          return replayed;
        },
        requestId: request.requestId,
        responseId: (result) => result.invitationId,
        responseKind: 'workspace_invitation',
        scope: { ...CORE_RECEIPT_OWNER, actorId, targetWorkspaceId: workspaceId },
        store,
      });
      return context.json(WorkspaceInvitationMutationResponseSchema.parse({ invitation }), 201);
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'listMyWorkspaceInvitations', (context) => {
    try {
      return context.json(
        ListWorkspaceInvitationsResponseSchema.parse({
          items: listMyWorkspaceInvitations(
            requireCoreDb(input.coreDb),
            requireActor(context).userId
          ),
        })
      );
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'acceptWorkspaceInvitation', async (context) => {
    try {
      const coreDb = requireCoreDb(input.coreDb);
      const store = requestStore(context);
      const actorId = requireActor(context).userId;
      const invitationId = context.req.param('invitationId');
      const request = AcceptWorkspaceInvitationRequestSchema.parse(
        await context.req.json().catch(() => ({}))
      );
      const invitation = await runInvitationTransition({
        action: 'workspace.invitation.accept',
        actorId,
        coreDb,
        execute: () =>
          acceptWorkspaceInvitation({
            coreDb,
            expectedRevision: request.expectedRevision,
            invitationId,
            inviteeUserId: actorId,
            workspaceId: invitationWorkspaceIdForInvitee(coreDb, invitationId, actorId),
          }),
        inflightCommands,
        invitationId,
        request,
        store,
        summary: 'Workspace invitation accepted.',
      });
      return context.json(WorkspaceInvitationMutationResponseSchema.parse({ invitation }));
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'declineWorkspaceInvitation', async (context) => {
    try {
      const coreDb = requireCoreDb(input.coreDb);
      const store = requestStore(context);
      const actorId = requireActor(context).userId;
      const invitationId = context.req.param('invitationId');
      const request = DeclineWorkspaceInvitationRequestSchema.parse(
        await context.req.json().catch(() => ({}))
      );
      const invitation = await runInvitationTransition({
        action: 'workspace.invitation.decline',
        actorId,
        coreDb,
        execute: () =>
          declineWorkspaceInvitation({
            coreDb,
            expectedRevision: request.expectedRevision,
            invitationId,
            inviteeUserId: actorId,
            workspaceId: invitationWorkspaceIdForInvitee(coreDb, invitationId, actorId),
          }),
        inflightCommands,
        invitationId,
        request,
        store,
        summary: 'Workspace invitation declined.',
      });
      return context.json(WorkspaceInvitationMutationResponseSchema.parse({ invitation }));
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'revokeWorkspaceInvitation', async (context) => {
    try {
      const coreDb = requireCoreDb(input.coreDb);
      const store = requestStore(context);
      const actorId = requireActor(context).userId;
      const workspaceId = context.req.param('workspaceId');
      const invitationId = context.req.param('invitationId');
      const existing = getWorkspaceInvitation(coreDb, invitationId);
      assertAuthorizedWorkspaceLineage(
        context.get('workspaceAccess'),
        existing?.workspaceId ?? null
      );
      const request = RevokeWorkspaceInvitationRequestSchema.parse(
        await context.req.json().catch(() => ({}))
      );
      const invitation = await runInvitationTransition({
        action: 'workspace.invitation.revoke',
        actorId,
        coreDb,
        execute: () =>
          revokeWorkspaceInvitation({
            coreDb,
            expectedRevision: request.expectedRevision,
            invitationId,
            ownerUserId: actorId,
            workspaceId,
          }),
        inflightCommands,
        invitationId,
        request,
        store,
        summary: 'Workspace invitation revoked.',
        workspaceId,
      });
      return context.json(WorkspaceInvitationMutationResponseSchema.parse({ invitation }));
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'changeWorkspaceMemberAccess', async (context) => {
    try {
      const coreDb = requireCoreDb(input.coreDb);
      const store = requestStore(context);
      const actorId = requireActor(context).userId;
      const workspaceId = context.req.param('workspaceId');
      const memberUserId = context.req.param('userId');
      assertMemberLineage(context, coreDb, workspaceId, memberUserId);
      const request = ChangeWorkspaceMemberAccessRequestSchema.parse(
        await context.req.json().catch(() => ({}))
      );
      const member = await runMemberMutation({
        action: 'workspace.member.access.change',
        actorId,
        coreDb,
        execute: () =>
          changeWorkspaceMemberAccess({
            accessLevel: request.accessLevel,
            coreDb,
            expectedRevision: request.expectedRevision,
            memberUserId,
            ownerUserId: actorId,
            workspaceId,
          }),
        inflightCommands,
        memberUserId,
        request,
        store,
        summary: 'Workspace membership access changed.',
        workspaceId,
      });
      return context.json(WorkspaceMemberMutationResponseSchema.parse({ member }));
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'removeWorkspaceMember', async (context) => {
    try {
      const coreDb = requireCoreDb(input.coreDb);
      const store = requestStore(context);
      const actorId = requireActor(context).userId;
      const workspaceId = context.req.param('workspaceId');
      const memberUserId = context.req.param('userId');
      assertMemberLineage(context, coreDb, workspaceId, memberUserId);
      const request = RemoveWorkspaceMemberRequestSchema.parse(
        await context.req.json().catch(() => ({}))
      );
      const member = await runMemberMutation({
        action: 'workspace.member.remove',
        actorId,
        coreDb,
        execute: () =>
          removeWorkspaceMember({
            coreDb,
            expectedRevision: request.expectedRevision,
            memberUserId,
            ownerUserId: actorId,
            workspaceId,
          }),
        inflightCommands,
        memberUserId,
        request,
        store,
        summary: 'Workspace member removed.',
        workspaceId,
      });
      return context.json(WorkspaceMemberMutationResponseSchema.parse({ member }));
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'leaveWorkspace', async (context) => {
    try {
      const coreDb = requireCoreDb(input.coreDb);
      const store = requestStore(context);
      const actor = requireActor(context);
      const actorId = actor.userId;
      const workspaceId = context.req.param('workspaceId');
      const request = LeaveWorkspaceRequestSchema.parse(await context.req.json().catch(() => ({})));
      const scope = {
        ...CORE_RECEIPT_OWNER,
        actorId,
        targetUserId: actorId,
        targetWorkspaceId: workspaceId,
      };
      const receipt = store.getCommandRequest('workspace.leave', request.requestId, scope, coreDb);
      const currentlyAuthorized = isWorkspaceOperationAuthorized(coreDb, actor, workspaceId, {
        mutating: true,
        policyOperation: 'workspace.leave',
      });
      const exactReceipt = isExactLeaveReceipt(coreDb, receipt, workspaceId, actorId);
      if ((receipt && !exactReceipt) || (!currentlyAuthorized && !exactReceipt)) {
        throw accessDenied();
      }
      const member = await runMemberMutation({
        action: 'workspace.leave',
        actorId,
        coreDb,
        execute: () =>
          leaveWorkspace({
            coreDb,
            expectedRevision: request.expectedRevision,
            memberUserId: actorId,
            workspaceId,
          }),
        inflightCommands,
        memberUserId: actorId,
        request,
        store,
        summary: 'Workspace member left.',
        workspaceId,
      });
      return context.json(WorkspaceMemberMutationResponseSchema.parse({ member }));
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'transferWorkspaceOwnership', async (context) => {
    try {
      const coreDb = requireCoreDb(input.coreDb);
      const store = requestStore(context);
      const actorId = requireActor(context).userId;
      const workspaceId = context.req.param('workspaceId');
      const request = TransferWorkspaceOwnershipRequestSchema.parse(
        await context.req.json().catch(() => ({}))
      );
      requireShareableWorkspace(coreDb, workspaceId);
      const workspace = await runIdempotentCommand({
        command: 'workspace.ownership.transfer',
        coreDb,
        coreTransaction: true,
        execute: () => {
          requireNoLifecycleAudit(coreDb, {
            action: 'workspace.ownership.transfer',
            actorId,
            requestId: request.requestId,
            resource: `workspace:${workspaceId}`,
          });
          const result = transferWorkspaceOwnership({
            coreDb,
            currentOwnerUserId: actorId,
            expectedRegistryRevision: request.expectedRegistryRevision,
            targetUserId: request.targetUserId,
            workspaceId,
          });
          const registry = requireTransferResult(result, coreDb, store, actorId, workspaceId);
          if (result.kind === 'transferred') {
            recordLifecycleAudit(coreDb, {
              action: 'workspace.ownership.transfer',
              actorId,
              requestId: request.requestId,
              resource: `workspace:${workspaceId}`,
              resourceRevision: registry.registryRevision,
              subjectId: request.targetUserId,
              summary: 'Workspace ownership transferred.',
              workspaceId,
            });
          }
          return authorizedWorkspaceSummary(coreDb, store, actorId, workspaceId);
        },
        inflightCommands,
        input: request,
        replay: (record) => {
          requireReceiptPointer(record, 'workspace', workspaceId);
          return authorizedWorkspaceSummary(coreDb, store, actorId, workspaceId);
        },
        requestId: request.requestId,
        responseId: (result) => result.workspace.id,
        responseKind: 'workspace',
        scope: { ...CORE_RECEIPT_OWNER, actorId, targetWorkspaceId: workspaceId },
        store,
      });
      return context.json(WorkspaceOwnershipMutationResponseSchema.parse({ workspace }));
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'getWorkspaceAccessRecoveryState', (context) => {
    try {
      const coreDb = requireCoreDb(input.coreDb);
      const actor = requireDeploymentAdministrator(context);
      const workspaceId = context.req.param('workspaceId');
      requireShareableWorkspace(coreDb, workspaceId);
      const recovery = getWorkspaceAccessRecoveryState(coreDb, workspaceId, actor.userId);
      if (!recovery) {
        throw accessDenied();
      }
      return context.json(WorkspaceAccessRecoveryResponseSchema.parse({ recovery }));
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'recoverWorkspaceAccess', async (context) => {
    try {
      const coreDb = requireCoreDb(input.coreDb);
      const store = requestStore(context);
      const actor = requireDeploymentAdministrator(context);
      const actorId = actor.userId;
      const workspaceId = context.req.param('workspaceId');
      requireShareableWorkspace(coreDb, workspaceId);
      const request = RecoverWorkspaceAccessRequestSchema.parse(
        await context.req.json().catch(() => ({}))
      );
      const recovery = await runIdempotentCommand({
        command: 'workspace.access.recover',
        coreDb,
        coreTransaction: true,
        execute: () => {
          const action = `workspace.access.recover.${request.action}`;
          requireNoLifecycleAudit(coreDb, {
            action,
            actorId,
            requestId: request.requestId,
            resource: `workspace:${workspaceId}`,
          });
          const formerOwnerUserId = getWorkspaceAccessRecoveryState(
            coreDb,
            workspaceId,
            actorId
          )?.ownerUserId;
          const result = recoverWorkspaceAccess({
            action: request.action,
            administratorUserId: actorId,
            coreDb,
            expectedRegistryRevision: request.expectedRegistryRevision,
            workspaceId,
          });
          const current = requireRecoveryResult(result);
          if (result.kind === 'recovered') {
            recordLifecycleAudit(coreDb, {
              action,
              actorId,
              requestId: request.requestId,
              resource: `workspace:${workspaceId}`,
              resourceRevision: current.registryRevision,
              ...(request.action === 'transfer-ownership-to-self' &&
              formerOwnerUserId &&
              formerOwnerUserId !== actorId
                ? { subjectId: formerOwnerUserId }
                : {}),
              summary: 'Workspace access recovered.',
              workspaceId,
            });
          }
          return current;
        },
        inflightCommands,
        input: request,
        replay: (record) => {
          requireReceiptPointer(record, 'workspace_recovery', workspaceId);
          return requireRecoveryState(coreDb, workspaceId, actorId);
        },
        requestId: request.requestId,
        responseId: (result) => result.workspaceId,
        responseKind: 'workspace_recovery',
        scope: { ...CORE_RECEIPT_OWNER, actorId, targetWorkspaceId: workspaceId },
        store,
      });
      return context.json(WorkspaceAccessRecoveryResponseSchema.parse({ recovery }));
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });

  registerAppApiRoute(app, 'disableUser', async (context) => {
    try {
      const coreDb = requireCoreDb(input.coreDb);
      const store = requestStore(context);
      const actor = requireDeploymentAdministrator(context);
      const actorId = actor.userId;
      const targetUserId = context.req.param('userId');
      const request = DisableUserRequestSchema.parse(await context.req.json().catch(() => ({})));
      const user = await runIdempotentCommand({
        command: 'user.disable',
        coreDb,
        coreTransaction: true,
        execute: () => {
          requireNoLifecycleAudit(coreDb, {
            action: 'user.disable',
            actorId,
            requestId: request.requestId,
            resource: `user:${targetUserId}`,
          });
          const result = disableCanonicalUser(coreDb, targetUserId);
          if (!result) {
            throw accessDenied();
          }
          if (result.changed) {
            recordLifecycleAudit(coreDb, {
              action: 'user.disable',
              actorId,
              requestId: request.requestId,
              resource: `user:${targetUserId}`,
              subjectId: targetUserId,
              summary: 'Canonical user disabled.',
            });
          }
          return result.user;
        },
        inflightCommands,
        input: request,
        replay: (record) => {
          requireReceiptPointer(record, 'user', targetUserId);
          return requireDisabledUser(coreDb, targetUserId);
        },
        requestId: request.requestId,
        responseId: (result) => result.userId,
        responseKind: 'user',
        scope: { ...CORE_RECEIPT_OWNER, actorId, targetUserId },
        store,
      });
      return context.json(DisableUserResponseSchema.parse({ user }));
    } catch (error) {
      return sharingErrorResponse(error);
    }
  });
}

/** Input shared by the three invitation terminal command wrappers. */
interface RunInvitationTransitionInput {
  /** Stable lifecycle audit and command name. */
  readonly action:
    | 'workspace.invitation.accept'
    | 'workspace.invitation.decline'
    | 'workspace.invitation.revoke';
  /** Authenticated canonical actor id. */
  readonly actorId: string;
  /** Open Core database. */
  readonly coreDb: CoreDb;
  /** Domain transition executed inside the Core transaction. */
  readonly execute: () => WorkspaceInvitationTransitionResult;
  /** Existing in-flight collapse owner. */
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  /** Exact path invitation id. */
  readonly invitationId: string;
  /** Parsed request used for stable input hashing. */
  readonly request: { readonly expectedRevision: number; readonly requestId: string };
  /** Existing shared Workspace store. */
  readonly store: FsStore;
  /** Redacted lifecycle audit summary. */
  readonly summary: string;
  /** Exact Workspace for owner-controlled revocation. */
  readonly workspaceId?: string;
}

/** Runs one invitation terminal transition through the shared Core receipt boundary. */
async function runInvitationTransition(
  input: RunInvitationTransitionInput
): Promise<WorkspaceInvitation> {
  return runIdempotentCommand({
    command: input.action,
    coreDb: input.coreDb,
    coreTransaction: true,
    execute: () => {
      requireNoLifecycleAudit(input.coreDb, {
        action: input.action,
        actorId: input.actorId,
        requestId: input.request.requestId,
        resource: `workspace-invitation:${input.invitationId}`,
      });
      const result = input.execute();
      const invitation = requireInvitationTransition(result);
      recordLifecycleAudit(input.coreDb, {
        action: input.action,
        actorId: input.actorId,
        requestId: input.request.requestId,
        resource: `workspace-invitation:${invitation.invitationId}`,
        resourceRevision: invitation.revision,
        ...(input.action === 'workspace.invitation.revoke'
          ? { subjectId: invitation.inviteeUserId }
          : {}),
        summary: input.summary,
        workspaceId: invitation.workspaceId,
      });
      return invitation;
    },
    inflightCommands: input.inflightCommands,
    input: input.request,
    replay: (record) => {
      const invitation = requireReceiptInvitation(input.coreDb, record);
      if (
        invitation.invitationId !== input.invitationId ||
        (input.workspaceId !== undefined && invitation.workspaceId !== input.workspaceId) ||
        (input.workspaceId === undefined && invitation.inviteeUserId !== input.actorId)
      ) {
        throw accessDenied();
      }
      return invitation;
    },
    requestId: input.request.requestId,
    responseId: (result) => result.invitationId,
    responseKind: 'workspace_invitation',
    scope: {
      ...CORE_RECEIPT_OWNER,
      actorId: input.actorId,
      targetInvitationId: input.invitationId,
      ...(input.workspaceId ? { targetWorkspaceId: input.workspaceId } : {}),
    },
    store: input.store,
  });
}

/** Input shared by membership change, removal, and leave command wrappers. */
interface RunMemberMutationInput {
  /** Stable lifecycle command name. */
  readonly action: 'workspace.member.access.change' | 'workspace.member.remove' | 'workspace.leave';
  /** Authenticated actor id. */
  readonly actorId: string;
  /** Open Core database. */
  readonly coreDb: CoreDb;
  /** Domain mutation executed inside the Core transaction. */
  readonly execute: () => WorkspaceMemberMutationResult;
  /** Existing in-flight collapse owner. */
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  /** Membership subject and response pointer id. */
  readonly memberUserId: string;
  /** Parsed request used for input hashing. */
  readonly request: Readonly<Record<string, unknown>> & { readonly requestId: string };
  /** Existing shared Workspace store. */
  readonly store: FsStore;
  /** Redacted lifecycle audit summary. */
  readonly summary: string;
  /** Exact Workspace containing the membership. */
  readonly workspaceId: string;
}

/** Runs one membership mutation through the shared Core receipt boundary. */
async function runMemberMutation(input: RunMemberMutationInput): Promise<WorkspaceMember> {
  return runIdempotentCommand({
    command: input.action,
    coreDb: input.coreDb,
    coreTransaction: true,
    execute: () => {
      requireNoLifecycleAudit(input.coreDb, {
        action: input.action,
        actorId: input.actorId,
        requestId: input.request.requestId,
        resource: `workspace-member:${input.workspaceId}:${input.memberUserId}`,
      });
      const result = input.execute();
      const member = requireMemberMutation(result);
      if (result.kind !== 'unchanged') {
        recordLifecycleAudit(input.coreDb, {
          action: input.action,
          actorId: input.actorId,
          requestId: input.request.requestId,
          resource: `workspace-member:${input.workspaceId}:${input.memberUserId}`,
          resourceRevision: member.revision,
          subjectId: input.memberUserId,
          summary: input.summary,
          workspaceId: input.workspaceId,
        });
      }
      return member;
    },
    inflightCommands: input.inflightCommands,
    input: input.request,
    replay: (record) => {
      requireReceiptPointer(record, 'workspace_member', input.memberUserId);
      return requireReceiptMember(input.coreDb, input.workspaceId, input.memberUserId);
    },
    requestId: input.request.requestId,
    responseId: (result) => result.userId,
    responseKind: 'workspace_member',
    scope: {
      ...CORE_RECEIPT_OWNER,
      actorId: input.actorId,
      targetUserId: input.memberUserId,
      targetWorkspaceId: input.workspaceId,
    },
    store: input.store,
  });
}

/** Requires an authenticated actor installed by the shared auth middleware. */
function requireActor(context: Context<{ Variables: AuthVariables }>): Actor {
  const actor = context.get('actor');
  if (!actor) {
    throw accessDenied();
  }
  return actor;
}

/** Requires explicit local or server-admin deployment authority. */
function requireDeploymentAdministrator(context: Context<{ Variables: AuthVariables }>): Actor {
  const actor = requireActor(context);
  if (!isDeploymentAdminActor(actor)) {
    throw accessDenied();
  }
  return actor;
}

/** Requires configured Core lifecycle storage. */
function requireCoreDb(coreDb: CoreDb | undefined): CoreDb {
  if (!coreDb) {
    throw accessDenied();
  }
  return coreDb;
}

/** Rejects the deterministic owner-only Quick Chat Workspace without opening its content. */
function requireShareableWorkspace(coreDb: CoreDb, workspaceId: string): void {
  const registry = getWorkspaceRegistryFact(coreDb, workspaceId);
  if (registry && workspaceId === quickChatWorkspaceIdForUser(registry.ownerUserId)) {
    throw new WorkspaceSharingRouteError(
      'quick_chat_not_shareable',
      'Quick Chat workspaces cannot be shared.',
      409
    );
  }
}

/** Returns the uniform non-enumerating access failure. */
function accessDenied(): WorkspaceSharingRouteError {
  return new WorkspaceSharingRouteError('workspace_access_denied', 'Workspace access denied.', 403);
}

/** Requires exact current Core child lineage for one member route. */
function assertMemberLineage(
  context: Context<{ Variables: AuthVariables }>,
  coreDb: CoreDb,
  workspaceId: string,
  userId: string
): void {
  const member = getWorkspaceMember(coreDb, workspaceId, userId);
  assertAuthorizedWorkspaceLineage(context.get('workspaceAccess'), member?.workspaceId ?? null);
}

/** Builds one current authorized Workspace summary from Core and Workspace owners. */
function authorizedWorkspaceSummary(
  coreDb: CoreDb,
  store: FsStore,
  userId: string,
  workspaceId: string
): AuthorizedWorkspaceSummary {
  const fact = listAuthorizedWorkspaceRegistryFacts(coreDb, userId).find(
    (candidate) => candidate.workspaceId === workspaceId
  );
  if (!fact) {
    throw accessDenied();
  }
  return AuthorizedWorkspaceSummarySchema.parse({
    effectiveRole: fact.effectiveRole,
    membershipRevision: fact.membershipRevision,
    ownerUserId: fact.ownerUserId,
    registryRevision: fact.registryRevision,
    workspace: store.getWorkspace(workspaceId),
  });
}

/** Reads the exact invitee-bound Workspace id without exposing another invitation. */
function invitationWorkspaceIdForInvitee(
  coreDb: CoreDb,
  invitationId: string,
  inviteeUserId: string
): string {
  const invitation = getWorkspaceInvitation(coreDb, invitationId);
  if (!invitation || invitation.inviteeUserId !== inviteeUserId) {
    throw accessDenied();
  }
  return invitation.workspaceId;
}

/** Fails closed when a request-owned lifecycle effect exists without its Core receipt. */
function requireNoLifecycleAudit(
  coreDb: CoreDb,
  input: {
    readonly action: string;
    readonly actorId: string;
    readonly requestId: string;
    readonly resource?: string;
    readonly workspaceId?: string;
  }
): void {
  const predicates = [
    'request_id = ?',
    'action = ?',
    "outcome = 'succeeded'",
    "json_extract(actor_json, '$.kind') = 'user'",
    "json_extract(actor_json, '$.id') = ?",
  ];
  const values: string[] = [input.requestId, input.action, input.actorId];
  if (input.resource) {
    predicates.push('resource = ?');
    values.push(input.resource);
  }
  if (input.workspaceId) {
    predicates.push('workspace_id = ?');
    values.push(input.workspaceId);
  }
  const found = coreDb.sqlite
    .prepare(`SELECT 1 FROM audit_events WHERE ${predicates.join(' AND ')} LIMIT 1`)
    .get(...values);
  if (found) {
    throw new WorkspaceSharingRouteError(
      'recovery_required',
      'The command effect exists without its matching receipt.',
      409
    );
  }
}

/** Input for one immutable Core lifecycle audit record. */
interface LifecycleAuditInput {
  /** Stable lifecycle action. */
  readonly action: string;
  /** Authenticated user actor. */
  readonly actorId: string;
  /** Exact request id. */
  readonly requestId: string;
  /** Redacted resource identity. */
  readonly resource: string;
  /** Positive resulting authority revision when applicable. */
  readonly resourceRevision?: number;
  /** Affected user when different from the actor. */
  readonly subjectId?: string;
  /** Redacted result summary. */
  readonly summary: string;
  /** Affected Workspace when applicable. */
  readonly workspaceId?: string;
}

/** Records one successful Core-owned lifecycle mutation. */
function recordLifecycleAudit(coreDb: CoreDb, input: LifecycleAuditInput): void {
  recordServerAuditEvent({
    action: input.action,
    actor: { id: input.actorId, kind: 'user' },
    category: 'command',
    coreDb,
    outcome: 'succeeded',
    requestId: input.requestId,
    resource: input.resource,
    ...(input.resourceRevision ? { resourceRevision: input.resourceRevision } : {}),
    ...(input.subjectId && input.subjectId !== input.actorId
      ? { subject: { id: input.subjectId, kind: 'user' as const } }
      : {}),
    summary: input.summary,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
}

/** Requires one successful invitation creation result. */
function requireCreatedInvitation(result: CreateWorkspaceInvitationResult): WorkspaceInvitation {
  if (result.kind === 'created') {
    return result.invitation;
  }
  throwDomainFailure(result);
}

/** Requires one successful invitation terminal transition. */
function requireInvitationTransition(
  result: WorkspaceInvitationTransitionResult
): WorkspaceInvitation {
  if (result.kind === 'accepted' || result.kind === 'declined' || result.kind === 'revoked') {
    return result.invitation;
  }
  throwDomainFailure(result);
}

/** Requires one successful or exact no-op membership mutation. */
function requireMemberMutation(result: WorkspaceMemberMutationResult): WorkspaceMember {
  if (result.kind === 'changed' || result.kind === 'removed' || result.kind === 'unchanged') {
    return result.member;
  }
  throwDomainFailure(result);
}

/** Requires one successful or exact no-op recovery result. */
function requireRecoveryResult(result: RecoverWorkspaceAccessResult): WorkspaceAccessRecoveryState {
  if (result.kind === 'recovered' || result.kind === 'unchanged') {
    return result.recovery;
  }
  throwDomainFailure(result);
}

/** Requires one successful or no-op ownership transfer and maps its conflict safely. */
function requireTransferResult(
  result: TransferWorkspaceOwnershipResult,
  coreDb: CoreDb,
  store: FsStore,
  actorId: string,
  workspaceId: string
): WorkspaceRegistryFact {
  if (result.kind === 'transferred' || result.kind === 'unchanged') {
    return result.registry;
  }
  if (result.kind === 'revision_conflict') {
    throw new WorkspaceSharingRouteError('revision_conflict', 'Workspace revision conflict.', 409, {
      current: authorizedWorkspaceSummary(coreDb, store, actorId, workspaceId),
      resource: 'workspace',
    });
  }
  throw accessDenied();
}

/** Maps one closed domain failure to the exact public error family. */
function throwDomainFailure(
  result:
    | CreateWorkspaceInvitationResult
    | WorkspaceInvitationTransitionResult
    | WorkspaceMemberMutationResult
    | RecoverWorkspaceAccessResult
): never {
  switch (result.kind) {
    case 'workspace_access_denied':
      throw accessDenied();
    case 'invitee_unavailable':
      throw new WorkspaceSharingRouteError(
        'invitee_unavailable',
        'The invitation target is unavailable.',
        404
      );
    case 'owner_transfer_required':
      throw new WorkspaceSharingRouteError(
        'owner_transfer_required',
        'Workspace ownership must be transferred first.',
        409
      );
    case 'invitation_not_pending':
      throw new WorkspaceSharingRouteError(
        'invitation_not_pending',
        'Workspace invitation is not pending.',
        409,
        { current: result.invitation }
      );
    case 'revision_conflict': {
      if ('invitation' in result) {
        throw new WorkspaceSharingRouteError(
          'revision_conflict',
          'Workspace invitation revision conflict.',
          409,
          { current: result.invitation, resource: 'invitation' }
        );
      }
      if ('member' in result) {
        throw new WorkspaceSharingRouteError(
          'revision_conflict',
          'Workspace membership revision conflict.',
          409,
          { current: result.member, resource: 'membership' }
        );
      }
      throw new WorkspaceSharingRouteError(
        'revision_conflict',
        'Workspace recovery revision conflict.',
        409,
        { current: result.recovery, resource: 'workspace_recovery' }
      );
    }
    default:
      throw new Error('Unexpected successful Workspace sharing result.');
  }
}

/** Reads one invitation pointer for central receipt replay. */
function requireReceiptInvitation(
  coreDb: CoreDb,
  record: CommandRequestRecord
): WorkspaceInvitation {
  if (record.response.kind !== 'workspace_invitation') {
    throw recoveryRequired();
  }
  const invitation = getWorkspaceInvitation(coreDb, record.response.id);
  if (!invitation) {
    throw recoveryRequired();
  }
  return invitation;
}

/** Requires one receipt to retain its exact resource-pointer contract. */
function requireReceiptPointer(
  record: CommandRequestRecord,
  kind: CommandRequestRecord['response']['kind'],
  id: string
): void {
  if (record.response.kind !== kind || record.response.id !== id) {
    throw recoveryRequired();
  }
}

/** Reads one membership pointer for central receipt replay. */
function requireReceiptMember(
  coreDb: CoreDb,
  workspaceId: string,
  userId: string
): WorkspaceMember {
  const member = getWorkspaceMember(coreDb, workspaceId, userId);
  if (!member) {
    throw recoveryRequired();
  }
  return member;
}

/** Reads one safe recovery projection for central receipt replay. */
function requireRecoveryState(
  coreDb: CoreDb,
  workspaceId: string,
  administratorUserId: string
): WorkspaceAccessRecoveryState {
  const recovery = getWorkspaceAccessRecoveryState(coreDb, workspaceId, administratorUserId);
  if (!recovery) {
    throw recoveryRequired();
  }
  return recovery;
}

/** Reads one disabled-user projection for central receipt replay. */
function requireDisabledUser(
  coreDb: CoreDb,
  userId: string
): z.infer<typeof DisableUserResponseSchema>['user'] {
  const row = coreDb.sqlite
    .prepare('SELECT id AS userId, status, disabled_at AS disabledAt FROM users WHERE id = ?')
    .get(userId) as
    | { readonly disabledAt: string | null; readonly status: string; readonly userId: string }
    | undefined;
  if (!row || row.status !== 'disabled' || !row.disabledAt) {
    throw recoveryRequired();
  }
  return DisableUserResponseSchema.parse({
    user: { disabledAt: row.disabledAt, status: 'disabled', userId: row.userId },
  }).user;
}

/** Checks the sole bounded post-leave receipt replay exception. */
function isExactLeaveReceipt(
  coreDb: CoreDb,
  receipt: CommandRequestRecord | null,
  workspaceId: string,
  actorId: string
): boolean {
  if (!receipt || receipt.response.kind !== 'workspace_member' || receipt.response.id !== actorId) {
    return false;
  }
  const member = getWorkspaceMember(coreDb, workspaceId, actorId);
  return member?.status === 'removed';
}

/** Returns the uniform missing-receipt recovery failure. */
function recoveryRequired(): WorkspaceSharingRouteError {
  return new WorkspaceSharingRouteError(
    'recovery_required',
    'The command outcome cannot be proven from its current durable owners.',
    409
  );
}

/** Converts one route, validation, lineage, or central command failure to HTTP. */
function sharingErrorResponse(error: unknown): Response {
  if (error instanceof HTTPException) {
    throw error;
  }
  if (error instanceof z.ZodError) {
    return asInvalidRequestError(error);
  }
  if (error instanceof WorkspaceSharingRouteError) {
    const payload = apiErrorPayload({
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
      message: error.message,
    });
    const parsed = WorkspaceSharingErrorSchema.safeParse(payload);
    return parsed.success
      ? Response.json(parsed.data, { status: error.status })
      : asCommandError(error, error.code, error.status);
  }
  return asCommandError(error, 'workspace_sharing_failed', 500);
}
