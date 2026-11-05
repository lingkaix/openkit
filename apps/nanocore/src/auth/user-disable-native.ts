import { isDeepStrictEqual } from 'node:util';
import { commandRequestKey } from '../lib/store.js';
import { IdempotencyKeyConflictError, OperationError } from '../operation-error.js';
import {
  getCommandRequestRecordFromDb,
  recordControlCommandRequestRecordInDb,
} from '../storage/command-request-records.js';
import { commandInputHash, presentControlFacts } from '../storage/control-store-input.js';
import { ControlProductPreconditionError } from '../storage/control-store-product-records.js';
import { assertControlProductWriter } from '../storage/control-store-products.js';
import type { CoreDb } from '../storage/db.js';
import type {
  ControlCoreSharing,
  ControlCoreSharingResult,
} from '../storage/workspace-sharing-codecs.js';
import {
  accessDenied,
  recordLifecycleAudit,
  requireDisabledUser,
  requireNoLifecycleAudit,
} from '../workspace-sharing-operations.js';
import { isCurrentDeploymentAdministrator } from './operation-authorizer.js';
import { disableCanonicalUser } from './user-lifecycle.js';

/** Applies the original complete User/session/Token/Audit/receipt tuple on its existing native Core savepoint. */
export function applyControlUserDisable(
  db: CoreDb,
  input: Extract<ControlCoreSharing, { command: 'user.disable' }>
): Extract<ControlCoreSharingResult, { kind: 'user' }> {
  assertControlProductWriter(db.sqlite);
  if (db.scope !== 'core' || !db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  const { receipt, request, targetUserId } = input;
  const actor = presentControlFacts(input.actor);
  const actorId = actor.userId;
  const expectedScope = { coreId: 'server', actorId, targetUserId };
  if (
    receipt.command !== input.command ||
    receipt.requestId !== request.requestId ||
    receipt.responseKind !== 'user' ||
    !isDeepStrictEqual(receipt.scope, expectedScope) ||
    receipt.key !== commandRequestKey(input.command, receipt.requestId, expectedScope) ||
    receipt.inputHash !== commandInputHash(request) ||
    receipt.expiresAt <= receipt.createdAt
  )
    throw new ControlProductPreconditionError();
  // Keep public Kernel admission outside this original tuple. Recheck only its current durable identity facts.
  if (!isCurrentDeploymentAdministrator(db, actor))
    throw new OperationError(
      'deployment_admin_required',
      'Current deployment administrator authority is required.',
      403
    );
  const prior = getCommandRequestRecordFromDb(db, receipt.key, receipt.createdAt);
  if (prior) {
    if (prior.inputHash !== receipt.inputHash) throw new IdempotencyKeyConflictError();
    if (
      prior.command !== input.command ||
      prior.requestId !== receipt.requestId ||
      !isDeepStrictEqual(prior.scope, expectedScope) ||
      prior.response.kind !== 'user' ||
      prior.response.id !== targetUserId
    )
      throw new OperationError(
        'recovery_required',
        'The command outcome cannot be proven from its current durable owners.',
        409
      );
    return { kind: 'user', value: requireDisabledUser(db, targetUserId) };
  }
  requireNoLifecycleAudit(db, {
    action: 'user.disable',
    actorId,
    requestId: request.requestId,
    resource: `user:${targetUserId}`,
  });
  const result = disableCanonicalUser(db, targetUserId);
  if (!result) throw accessDenied();
  if (result.changed)
    recordLifecycleAudit(db, {
      action: 'user.disable',
      actorId,
      requestId: request.requestId,
      resource: `user:${targetUserId}`,
      subjectId: targetUserId,
      summary: 'Canonical user disabled.',
    });
  recordControlCommandRequestRecordInDb(db, {
    ...receipt,
    scope: expectedScope,
    response: { kind: 'user', id: result.user.userId },
  });
  return { kind: 'user', value: result.user };
}
