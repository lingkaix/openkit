import { isDeepStrictEqual } from 'node:util';
import { AuthorizedWorkspaceSummarySchema } from '@openkit/app-api-schemas';
import { recordServerAuditEvent } from '../audit-events.js';
import {
  currentWorkspaceAuthority,
  DeploymentAdminRequiredError,
  evaluateProductAuthorization,
  isCurrentDeploymentAdministrator,
  isWorkspaceOperationAuthorized,
  requireAdministratorOperation,
} from '../auth/operation-authorizer.js';
import { commandRequestKey, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { IdempotencyKeyConflictError, OperationError } from '../operation-error.js';
import { readAuditEventRowV1 } from '../policy/retained-records-v1.js';
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  declineWorkspaceInvitation,
  getWorkspaceAccessRecoveryState,
  getWorkspaceInvitation,
  getWorkspaceMember,
  getWorkspaceRegistryFact,
  leaveWorkspace,
  recoverWorkspaceAccess,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
  transferWorkspaceOwnership,
} from '../workspace-sharing.js';
import { accessDenied } from '../workspace-sharing-operations.js';
import {
  getCommandRequestRecordFromDb,
  recordControlCommandRequestRecordInDb,
} from './command-request-records.js';
import { commandInputHash, presentControlFacts } from './control-store-input.js';
import {
  assertControlProductWriter,
  ControlProductPreconditionError,
} from './control-store-products.js';
import type { CoreDb } from './db.js';
import {
  type ControlCoreSharing,
  type ControlCoreSharingResult,
  ControlCoreSharingSchema,
} from './workspace-sharing-codecs.js';

/** The existing non-enumerating Core authorization refusal. */
function denied(): never {
  throw accessDenied();
}
/** A missing original effect/receipt is never reconstructed. */
function recovery(): never {
  throw new OperationError(
    'recovery_required',
    'The command outcome cannot be proven from its current durable owners.',
    409
  );
}
/** Projects only live Core relation facts; the Workspace content snapshot supplies no authority. */
function summary(
  db: CoreDb,
  input: Extract<ControlCoreSharing, { command: 'workspace.ownership.transfer' }>
) {
  const registry = getWorkspaceRegistryFact(db, input.workspaceId);
  if (!registry) return denied();
  const member = getWorkspaceMember(db, input.workspaceId, input.actor.userId);
  return AuthorizedWorkspaceSummarySchema.parse({
    workspace: input.workspace,
    ownerUserId: registry.ownerUserId,
    registryRevision: registry.registryRevision,
    isOwner: registry.ownerUserId === input.actor.userId,
    membershipRevision: member?.revision ?? null,
    membershipStatus: member?.status ?? null,
    accessCause: isCurrentDeploymentAdministrator(db, presentControlFacts(input.actor))
      ? 'administrator'
      : 'membership',
  });
}
/** Maps exactly the existing closed domain refusals, including their typed current-record details. */
function domainFailure(
  result:
    | ReturnType<typeof createWorkspaceInvitation>
    | ReturnType<typeof acceptWorkspaceInvitation>
    | ReturnType<typeof removeWorkspaceMember>
    | ReturnType<typeof recoverWorkspaceAccess>
): never {
  switch (result.kind) {
    case 'workspace_access_denied':
      return denied();
    case 'invitee_unavailable':
      throw new OperationError('invitee_unavailable', 'The invitation target is unavailable.', 404);
    case 'owner_transfer_required':
      throw new OperationError(
        'owner_transfer_required',
        'Workspace ownership must be transferred first.',
        409
      );
    case 'invitation_not_pending':
      throw new OperationError(
        'invitation_not_pending',
        'Workspace invitation is not pending.',
        409,
        { details: { current: result.invitation } }
      );
    case 'revision_conflict':
      if ('invitation' in result)
        throw new OperationError(
          'revision_conflict',
          'Workspace invitation revision conflict.',
          409,
          { details: { current: result.invitation, resource: 'invitation' } }
        );
      if ('member' in result)
        throw new OperationError(
          'revision_conflict',
          'Workspace membership revision conflict.',
          409,
          { details: { current: result.member, resource: 'membership' } }
        );
      throw new OperationError('revision_conflict', 'Workspace recovery revision conflict.', 409, {
        details: { current: result.recovery, resource: 'workspace_recovery' },
      });
    default:
      throw new Error('Unexpected successful Workspace sharing result.');
  }
}
/** Refuses an effect-owned Audit without its original receipt, rather than replaying the effect. */
function requireNoAudit(
  db: CoreDb,
  action: string,
  actorId: string,
  requestId: string,
  resource?: string,
  workspaceId?: string
): void {
  const predicates = ['request_id = ?', 'action = ?', "outcome = 'succeeded'"];
  const values = [requestId, action];
  if (resource) {
    predicates.push('resource = ?');
    values.push(resource);
  }
  if (workspaceId) {
    predicates.push('workspace_id = ?');
    values.push(workspaceId);
  }
  const found = db.sqlite
    .prepare(`SELECT * FROM audit_events WHERE ${predicates.join(' AND ')}`)
    .all(...values)
    .map(readAuditEventRowV1)
    .some(({ actor }) => actor?.kind === 'user' && actor.id === actorId);
  if (found)
    throw new OperationError(
      'recovery_required',
      'The command effect exists without its matching receipt.',
      409
    );
}
/** Existing Audit owner, joined only to this family's exact native command savepoint. */
function audit(
  db: CoreDb,
  input: {
    action: string;
    actorId: string;
    requestId: string;
    resource: string;
    resourceRevision: number;
    summary: string;
    workspaceId: string;
    subjectId?: string;
  }
): void {
  recordServerAuditEvent({
    coreDb: db,
    action: input.action,
    actor: { kind: 'user', id: input.actorId },
    category: 'command',
    outcome: 'succeeded',
    requestId: input.requestId,
    resource: input.resource,
    resourceRevision: input.resourceRevision,
    summary: input.summary,
    workspaceId: input.workspaceId,
    ...(input.subjectId && input.subjectId !== input.actorId
      ? { subject: { kind: 'user' as const, id: input.subjectId } }
      : {}),
  });
}
/** Selects a retained original result without producing another effect or Audit. */
function replay(db: CoreDb, input: ControlCoreSharing, id: string): ControlCoreSharingResult {
  switch (input.command) {
    case 'workspace.invitation.create':
    case 'workspace.invitation.accept':
    case 'workspace.invitation.decline':
    case 'workspace.invitation.revoke': {
      const invitation = getWorkspaceInvitation(db, id);
      if (!invitation) return recovery();
      if (
        ('invitationId' in input && invitation.invitationId !== input.invitationId) ||
        ('workspaceId' in input && invitation.workspaceId !== input.workspaceId)
      )
        return recovery();
      return { kind: 'invitation', value: invitation };
    }
    case 'workspace.member.remove':
    case 'workspace.leave': {
      if (id !== input.memberUserId) return recovery();
      const member = getWorkspaceMember(db, input.workspaceId, id);
      if (!member) return recovery();
      return { kind: 'member', value: member };
    }
    case 'workspace.ownership.transfer':
      if (id !== input.workspaceId) return recovery();
      return { kind: 'workspace', value: summary(db, input) };
    case 'workspace.access.recover': {
      if (id !== input.workspaceId) return recovery();
      const current = getWorkspaceAccessRecoveryState(db, input.workspaceId, input.actor.userId);
      if (!current) return recovery();
      return { kind: 'recovery', value: current };
    }
  }
}
/** Commits one complete public sharing mutation, required Audit and original receipt on the owning Core savepoint. */
export function applyControlCoreSharing(
  db: CoreDb,
  value: ControlCoreSharing
): ControlCoreSharingResult {
  assertControlProductWriter(db.sqlite);
  const input = ControlCoreSharingSchema.parse(value);
  const { receipt, request, command } = input;
  const actor = presentControlFacts(input.actor);
  const actorId = actor.userId;
  const expectedKind = command.startsWith('workspace.invitation.')
    ? 'workspace_invitation'
    : command === 'workspace.ownership.transfer'
      ? 'workspace'
      : command === 'workspace.access.recover'
        ? 'workspace_recovery'
        : 'workspace_member';
  const expectedScope: Record<string, string> = {
    coreId: 'server',
    actorId,
    ...('workspaceId' in input ? { targetWorkspaceId: input.workspaceId } : {}),
    ...('invitationId' in input ? { targetInvitationId: input.invitationId } : {}),
    ...('memberUserId' in input ? { targetUserId: input.memberUserId } : {}),
  };
  if (
    receipt.command !== command ||
    receipt.requestId !== request.requestId ||
    receipt.responseKind !== expectedKind ||
    !isDeepStrictEqual(receipt.scope, expectedScope) ||
    receipt.key !== commandRequestKey(command, receipt.requestId, expectedScope) ||
    receipt.inputHash !== commandInputHash(request) ||
    receipt.expiresAt <= receipt.createdAt ||
    ('workspace' in input && input.workspace.id !== input.workspaceId)
  )
    throw new ControlProductPreconditionError();
  const prior = getCommandRequestRecordFromDb(db, receipt.key, receipt.createdAt);
  // The public admission may precede other queued Core commands; use current native facts again.
  if (command === 'workspace.access.recover') {
    try {
      requireAdministratorOperation(db, actor, 'deployment.recover');
    } catch (error) {
      if (!(error instanceof DeploymentAdminRequiredError)) throw error;
      throw new OperationError(
        'deployment_admin_required',
        'Current deployment administrator authority is required.',
        403
      );
    }
  } else if (
    command === 'workspace.invitation.accept' ||
    command === 'workspace.invitation.decline'
  ) {
    if (
      evaluateProductAuthorization(
        db,
        actor,
        { kind: 'invitation', invitationId: input.invitationId },
        'invitation.respond',
        true
      ).effect !== 'allow'
    )
      return denied();
  } else if (command === 'workspace.leave') {
    const exactRemoved =
      prior?.response.kind === 'workspace_member' &&
      prior.response.id === actorId &&
      input.memberUserId === actorId &&
      getWorkspaceMember(db, input.workspaceId, actorId)?.status === 'removed';
    if (
      input.memberUserId !== actorId ||
      (!exactRemoved &&
        !isWorkspaceOperationAuthorized(db, actor, input.workspaceId, {
          mutating: true,
          policyOperation: 'workspace.leave',
        }))
    )
      return denied();
  } else if (
    evaluateProductAuthorization(
      db,
      actor,
      { kind: 'workspace', workspaceId: input.workspaceId },
      'membership.manage',
      true
    ).effect !== 'allow'
  )
    return denied();
  if (prior) {
    if (prior.inputHash !== receipt.inputHash) throw new IdempotencyKeyConflictError();
    if (
      prior.command !== command ||
      prior.requestId !== receipt.requestId ||
      !isDeepStrictEqual(prior.scope, expectedScope) ||
      prior.response.kind !== expectedKind
    )
      return recovery();
    return replay(db, input, prior.response.id);
  }
  if (
    input.command === 'workspace.invitation.create' ||
    input.command === 'workspace.ownership.transfer' ||
    input.command === 'workspace.access.recover'
  ) {
    const registry = getWorkspaceRegistryFact(db, input.workspaceId);
    if (
      registry &&
      input.workspaceId === quickChatWorkspaceIdForUser(registry.ownerUserId, db.dataRoot)
    )
      throw new OperationError(
        'quick_chat_not_shareable',
        'Personal Workspaces cannot be shared.',
        409
      );
  }
  const authorization = (workspaceId: string) =>
    evaluateProductAuthorization(
      db,
      actor,
      { kind: 'workspace', workspaceId },
      'membership.manage',
      true
    );
  let result: ControlCoreSharingResult;
  switch (command) {
    case 'workspace.invitation.create': {
      requireNoAudit(db, command, actorId, request.requestId, undefined, input.workspaceId);
      const created = createWorkspaceInvitation({
        coreDb: db,
        inviterUserId: actorId,
        authorization: authorization(input.workspaceId),
        workspaceId: input.workspaceId,
        inviteeEmail: input.request.inviteeEmail,
      });
      if (created.kind !== 'created') return domainFailure(created);
      const invitation = created.invitation;
      audit(db, {
        action: command,
        actorId,
        requestId: request.requestId,
        resource: `workspace-invitation:${invitation.invitationId}`,
        resourceRevision: invitation.revision,
        subjectId: invitation.inviteeUserId,
        summary: 'Workspace invitation created.',
        workspaceId: input.workspaceId,
      });
      result = { kind: 'invitation', value: invitation };
      break;
    }
    case 'workspace.invitation.accept':
    case 'workspace.invitation.decline':
    case 'workspace.invitation.revoke': {
      requireNoAudit(
        db,
        command,
        actorId,
        request.requestId,
        `workspace-invitation:${input.invitationId}`
      );
      const current = getWorkspaceInvitation(db, input.invitationId);
      if (!current) return denied();
      if (command === 'workspace.invitation.revoke' && current.workspaceId !== input.workspaceId)
        return denied();
      if (
        command !== 'workspace.invitation.revoke' &&
        evaluateProductAuthorization(
          db,
          actor,
          { kind: 'invitation', invitationId: input.invitationId },
          'invitation.respond',
          true
        ).effect !== 'allow'
      )
        return denied();
      let transitioned: ReturnType<typeof acceptWorkspaceInvitation>;
      if (command === 'workspace.invitation.accept') {
        if (
          !currentWorkspaceAuthority(
            db,
            current.workspaceId,
            { kind: 'user', id: current.inviterUserId },
            'membership.manage',
            true,
            undefined,
            { retainedPolicyAuthor: true, dependencyFailure: 'throw' }
          )
        )
          return denied();
        transitioned = acceptWorkspaceInvitation({
          coreDb: db,
          invitationId: input.invitationId,
          workspaceId: current.workspaceId,
          inviteeUserId: current.inviteeUserId,
          expectedRevision: input.request.expectedRevision,
        });
      } else if (command === 'workspace.invitation.decline')
        transitioned = declineWorkspaceInvitation({
          coreDb: db,
          invitationId: input.invitationId,
          workspaceId: current.workspaceId,
          inviteeUserId: current.inviteeUserId,
          expectedRevision: input.request.expectedRevision,
        });
      else
        transitioned = revokeWorkspaceInvitation({
          coreDb: db,
          invitationId: input.invitationId,
          workspaceId: input.workspaceId,
          actorUserId: actorId,
          authorization: authorization(input.workspaceId),
          expectedRevision: input.request.expectedRevision,
        });
      if (
        transitioned.kind !== 'accepted' &&
        transitioned.kind !== 'declined' &&
        transitioned.kind !== 'revoked'
      )
        return domainFailure(transitioned);
      const invitation = transitioned.invitation;
      audit(db, {
        action: command,
        actorId,
        requestId: request.requestId,
        resource: `workspace-invitation:${invitation.invitationId}`,
        resourceRevision: invitation.revision,
        ...(command === 'workspace.invitation.revoke'
          ? { subjectId: invitation.inviteeUserId }
          : {}),
        summary:
          command === 'workspace.invitation.accept'
            ? 'Workspace invitation accepted.'
            : command === 'workspace.invitation.decline'
              ? 'Workspace invitation declined.'
              : 'Workspace invitation revoked.',
        workspaceId: invitation.workspaceId,
      });
      result = { kind: 'invitation', value: invitation };
      break;
    }
    case 'workspace.member.remove':
    case 'workspace.leave': {
      requireNoAudit(
        db,
        command,
        actorId,
        request.requestId,
        `workspace-member:${input.workspaceId}:${input.memberUserId}`
      );
      if (
        command === 'workspace.leave' &&
        (input.memberUserId !== actorId ||
          !isWorkspaceOperationAuthorized(db, actor, input.workspaceId, {
            mutating: true,
            policyOperation: 'workspace.leave',
          }))
      )
        return denied();
      const changed =
        command === 'workspace.leave'
          ? leaveWorkspace({
              coreDb: db,
              workspaceId: input.workspaceId,
              memberUserId: input.memberUserId,
              expectedRevision: input.request.expectedRevision,
            })
          : removeWorkspaceMember({
              coreDb: db,
              workspaceId: input.workspaceId,
              memberUserId: input.memberUserId,
              actorUserId: actorId,
              authorization: authorization(input.workspaceId),
              expectedRevision: input.request.expectedRevision,
            });
      if (changed.kind !== 'removed') return domainFailure(changed);
      audit(db, {
        action: command,
        actorId,
        requestId: request.requestId,
        resource: `workspace-member:${input.workspaceId}:${input.memberUserId}`,
        resourceRevision: changed.member.revision,
        subjectId: input.memberUserId,
        summary:
          command === 'workspace.leave' ? 'Workspace member left.' : 'Workspace member removed.',
        workspaceId: input.workspaceId,
      });
      result = { kind: 'member', value: changed.member };
      break;
    }
    case 'workspace.ownership.transfer': {
      requireNoAudit(db, command, actorId, request.requestId, undefined, input.workspaceId);
      const changed = transferWorkspaceOwnership({
        coreDb: db,
        workspaceId: input.workspaceId,
        actorUserId: actorId,
        authorization: authorization(input.workspaceId),
        targetUserId: input.request.targetUserId,
        expectedRegistryRevision: input.request.expectedRegistryRevision,
      });
      if (changed.kind === 'revision_conflict')
        throw new OperationError('revision_conflict', 'Workspace revision conflict.', 409, {
          details: { current: summary(db, input), resource: 'workspace' },
        });
      if (changed.kind !== 'transferred' && changed.kind !== 'unchanged') return denied();
      if (changed.kind === 'transferred')
        audit(db, {
          action: command,
          actorId,
          requestId: request.requestId,
          resource: `workspace:${input.workspaceId}`,
          resourceRevision: changed.registry.registryRevision,
          subjectId: input.request.targetUserId,
          summary: 'Workspace ownership transferred.',
          workspaceId: input.workspaceId,
        });
      result = { kind: 'workspace', value: summary(db, input) };
      break;
    }
    case 'workspace.access.recover': {
      try {
        requireAdministratorOperation(db, actor, 'deployment.recover');
      } catch (error) {
        if (!(error instanceof DeploymentAdminRequiredError)) throw error;
        throw new OperationError(
          'deployment_admin_required',
          'Current deployment administrator authority is required.',
          403
        );
      }
      const action = `workspace.access.recover.${input.request.action}`;
      requireNoAudit(db, action, actorId, request.requestId, `workspace:${input.workspaceId}`);
      const formerOwnerUserId = getWorkspaceAccessRecoveryState(
        db,
        input.workspaceId,
        actorId
      )?.ownerUserId;
      const changed = recoverWorkspaceAccess({
        coreDb: db,
        workspaceId: input.workspaceId,
        administratorUserId: actorId,
        action: input.request.action,
        expectedRegistryRevision: input.request.expectedRegistryRevision,
      });
      if (changed.kind !== 'recovered' && changed.kind !== 'unchanged')
        return domainFailure(changed);
      if (changed.kind === 'recovered')
        audit(db, {
          action,
          actorId,
          requestId: request.requestId,
          resource: `workspace:${input.workspaceId}`,
          resourceRevision: changed.recovery.registryRevision,
          ...(input.request.action === 'transfer-ownership-to-self' &&
          formerOwnerUserId &&
          formerOwnerUserId !== actorId
            ? { subjectId: formerOwnerUserId }
            : {}),
          summary: 'Workspace access recovered.',
          workspaceId: input.workspaceId,
        });
      result = { kind: 'recovery', value: changed.recovery };
      break;
    }
  }
  const id =
    result.kind === 'invitation'
      ? result.value.invitationId
      : result.kind === 'member'
        ? result.value.userId
        : result.kind === 'workspace'
          ? result.value.workspace.id
          : result.value.workspaceId;
  recordControlCommandRequestRecordInDb(db, {
    ...receipt,
    scope: expectedScope,
    response: { kind: receipt.responseKind, id },
  });
  return result;
}
