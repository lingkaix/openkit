import { HTTPException } from 'hono/http-exception';
import { presentControlFacts } from '../storage/control-store-input.js';
import { ControlProductPreconditionError } from '../storage/control-store-product-records.js';
import type { CoreDb } from '../storage/db.js';
import { resolveWorkspaceMembershipRelation } from '../workspace-sharing.js';
import type {
  ControlAccessTokenLifecycle,
  ControlAccessTokenLifecycleResult,
} from './access-token-lifecycle-codecs.js';
import {
  DeploymentAdminRequiredError,
  insertOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
  rotateOpenKitAccessTokenRecord,
} from './access-token-store.js';
import { evaluateProductAuthorization } from './operation-authorizer.js';
import { isCanonicalUserActive } from './user-lifecycle.js';

/** Repeats current Core authority, then applies the original canonical tuple in its native savepoint. */
export function applyControlAccessTokenLifecycle(
  coreDb: CoreDb,
  input: ControlAccessTokenLifecycle
): ControlAccessTokenLifecycleResult {
  if (coreDb.scope !== 'core' || !coreDb.sqlite.inTransaction)
    throw new ControlProductPreconditionError();
  // Main admission is not a grant across FIFO waiting. Reuse its exact current
  // server/api.call/mutating predicate, including credential and User eligibility.
  try {
    if (
      evaluateProductAuthorization(
        coreDb,
        presentControlFacts(input.actor),
        { kind: 'server' },
        'api.call',
        true
      ).effect !== 'allow'
    )
      return { kind: 'denied', code: 'workspace_access_denied' };
  } catch (error) {
    if (error instanceof DeploymentAdminRequiredError)
      return { kind: 'denied', code: 'deployment_admin_required' };
    if (error instanceof HTTPException && error.status === 403)
      return { kind: 'denied', code: 'workspace_access_denied' };
    throw error;
  }
  if (input.kind === 'issue') {
    if (!isCanonicalUserActive(coreDb, input.ownerUserId))
      return { kind: 'denied', code: 'access_token_owner_invalid' };
    if (
      input.scope !== 'server-admin' &&
      input.workspaceIds.some(
        (id) => resolveWorkspaceMembershipRelation(coreDb, id, input.ownerUserId) === null
      )
    )
      return { kind: 'denied', code: 'core.auth.scope_forbidden' };
    return {
      kind: 'issue',
      record: insertOpenKitAccessTokenRecord(coreDb, {
        ...input.token,
        ownerUserId: input.ownerUserId,
        scope: input.scope,
        workspaceIds: input.workspaceIds,
        issuedAt: new Date().toISOString(),
        expiresAt: input.expiresAt,
      }),
    };
  }
  if (input.kind === 'revoke')
    return { kind: 'revoke', record: revokeOpenKitAccessTokenRecord(coreDb, input.tokenId) };
  return {
    kind: 'rotate',
    value: rotateOpenKitAccessTokenRecord(coreDb, input.tokenId, {
      graceSeconds: input.graceSeconds,
      successor: input.successor,
    }),
  };
}
