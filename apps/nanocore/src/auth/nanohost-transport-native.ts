import { recordServerAuditEvent } from '../audit-events.js';
import { OperationError } from '../operation-error.js';
import { assertControlProductWriter } from '../storage/control-store-products.js';
import type { CoreDb } from '../storage/db.js';
import {
  DeploymentAdminRequiredError,
  requireCurrentDeploymentAdmin,
} from './access-token-store.js';
import {
  type ControlNanoHostTransportInput,
  type ControlNanoHostTransportResult,
  NANOHOST_TRANSPORT_ADMIN_REFUSAL,
  type NanoHostTransportTokenRow,
  nanoHostTransportAdminFacts,
  readNanoHostTransportTokenRecord,
} from './nanohost-transport-codecs.js';
import {
  evaluateNanoHostTransportTokenUsability,
  NANOHOST_TRANSPORT_TOKEN_SCOPE,
  NANOHOST_TRANSPORT_TOKEN_TYPE,
} from './nanohost-transport-token.js';
import type {
  NanoHostTransportTokenRecord,
  VerifiedNanoHostTransportTokenRecord,
} from './nanohost-transport-token-store.js';

/** Applies one original credential tuple or separate Audit stage in the existing native savepoint. */
export function applyControlNanoHostTransport(
  coreDb: CoreDb,
  input: ControlNanoHostTransportInput
): ControlNanoHostTransportResult {
  assertControlProductWriter(coreDb.sqlite);
  if ('actor' in input && input.actor) {
    try {
      requireCurrentDeploymentAdmin(
        coreDb,
        nanoHostTransportAdminFacts(input.actor),
        'record' in input ? input.record.now : 'now' in input ? input.now : undefined
      );
    } catch (error) {
      if (!(error instanceof DeploymentAdminRequiredError)) throw error;
      const refusal = NANOHOST_TRANSPORT_ADMIN_REFUSAL;
      throw new OperationError(refusal.code, refusal.message, refusal.status, { cause: error });
    }
  }
  switch (input.kind) {
    case 'issue':
      return { kind: 'record', record: createNanoHostTransportTokenRecord(coreDb, input.record) };
    case 'enroll':
      return { kind: 'record', record: enrollNanoHostTransportIdentity(coreDb, input.record) };
    case 'verify':
      return {
        kind: 'record',
        record: verifyNanoHostTransportTokenRecord(coreDb, input.tokenHash, input),
      };
    case 'revoke':
      return {
        kind: 'record',
        record: revokeNanoHostTransportTokenRecord(coreDb, input.tokenId, input),
      };
    case 'cutover':
      return {
        kind: 'record',
        record: completeNanoHostTransportTokenCutover(coreDb, input.tokenId, input),
      };
    case 'rotate':
      return {
        kind: 'rotation',
        result: rotateNanoHostTransportTokenRecord(coreDb, input.tokenId, input),
      };
    case 'abort':
      return { kind: 'abort', result: abortNanoHostTransportTokenRotation(coreDb, input) };
    case 'decommission': {
      const records = decommissionNanoHostTransportTokens(coreDb, input.identityId, input);
      decommissionNanoHostIntegrationIdentity(coreDb, input.identityId, input.deploymentId, input);
      return { kind: 'decommission', records };
    }
    case 'lifecycle-audit':
      recordNanoHostTransportLifecycleAuditEvent(
        coreDb,
        input.action,
        input.record,
        input.actorUserId
      );
      return { kind: 'audit' };
    case 'decommission-audit': {
      recordServerAuditEvent({
        action: 'nanohost.transport.decommission',
        actor: { kind: 'user', id: input.actorUserId },
        category: 'system',
        coreDb,
        outcome: 'succeeded',
        resource: `nanohost-transport-identity:${input.identityId}`,
        severity: 'info',
        summary: `NanoHost ${input.identityId} decommissioned for deployment ${input.deploymentId}; newly revoked ${input.newlyRevokedCount} transport token${input.newlyRevokedCount === 1 ? '' : 's'}; retained lineage count=${input.retainedTokenCount}; lineage=${input.tokenLineage || 'none'}.`,
      });
      return { kind: 'audit' };
    }
  }
}

function createNanoHostTransportTokenRecord(
  coreDb: CoreDb,
  input: Extract<ControlNanoHostTransportInput, { kind: 'issue' }>['record']
): NanoHostTransportTokenRecord {
  if (
    !isNanoHostTransportIdentityActive(coreDb, input.ownerNanoHostIdentityId, input.deploymentId)
  ) {
    throw new Error(
      'NanoHost transport token issuance requires the exact active identity and deployment pair.'
    );
  }

  const tokenId = input.tokenId;
  const now = (input.now ?? new Date()).toISOString();

  coreDb.sqlite
    .prepare(
      `INSERT INTO nanohost_transport_tokens (
        token_id,
        token_hash,
        owner_nanohost_identity_id,
        token_type,
        scope,
        deployment_id,
        status,
        issued_at,
        expires_at,
        predecessor_token_id,
        responsible_server_admin_actor_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
    )
    .run(
      tokenId,
      input.tokenHash,
      input.ownerNanoHostIdentityId,
      NANOHOST_TRANSPORT_TOKEN_TYPE,
      NANOHOST_TRANSPORT_TOKEN_SCOPE,
      input.deploymentId,
      now,
      input.expiresAt,
      input.predecessorTokenId ?? null,
      input.responsibleServerAdminActorId
    );

  const record = getNanoHostTransportTokenRecord(coreDb, tokenId);
  if (!record) {
    throw new Error(`NanoHost transport token record was not created: ${tokenId}`);
  }

  return record;
}

function enrollNanoHostTransportIdentity(
  coreDb: CoreDb,
  input: Extract<ControlNanoHostTransportInput, { kind: 'enroll' }>['record']
): NanoHostTransportTokenRecord {
  return coreDb.sqlite.transaction(() => {
    const now = (input.now ?? new Date()).toISOString();
    const rows = coreDb.sqlite
      .prepare(
        `SELECT identity_id, deployment_id, status
         FROM nanohost_integration_identities
         WHERE identity_id = ? OR deployment_id = ?`
      )
      .all(input.ownerNanoHostIdentityId, input.deploymentId) as Array<{
      deployment_id: string;
      identity_id: string;
      status: string;
    }>;
    const retainedTokenHistory = coreDb.sqlite
      .prepare(
        `SELECT COUNT(*) AS count
         FROM nanohost_transport_tokens
         WHERE owner_nanohost_identity_id = ? OR deployment_id = ?`
      )
      .get(input.ownerNanoHostIdentityId, input.deploymentId) as { count: number };
    if (rows.length === 0 && Number(retainedTokenHistory.count) > 0) {
      throw new Error(
        'NanoHost enrollment conflicts with an existing identity or deployment binding.'
      );
    }

    if (rows.length === 0) {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_integration_identities (
            identity_id, deployment_id, status, created_at
          ) VALUES (?, ?, 'active', ?)`
        )
        .run(input.ownerNanoHostIdentityId, input.deploymentId, now);
      return createNanoHostTransportTokenRecord(coreDb, input);
    }

    const exact = rows[0];
    if (
      rows.length !== 1 ||
      !exact ||
      exact.identity_id !== input.ownerNanoHostIdentityId ||
      exact.deployment_id !== input.deploymentId
    ) {
      throw new Error(
        'NanoHost enrollment conflicts with an existing identity or deployment binding.'
      );
    }
    if (exact.status === 'active') {
      throw new Error('Configured NanoHost identity is already enrolled.');
    }
    if (exact.status !== 'decommissioned') {
      throw new Error(
        'NanoHost enrollment requires the exact decommissioned identity and deployment pair.'
      );
    }

    const reactivated = coreDb.sqlite
      .prepare(
        `UPDATE nanohost_integration_identities
         SET status = 'active', decommissioned_at = NULL
         WHERE identity_id = ? AND deployment_id = ? AND status = 'decommissioned'`
      )
      .run(input.ownerNanoHostIdentityId, input.deploymentId);
    if (reactivated.changes !== 1) {
      throw new Error(
        'NanoHost enrollment could not reactivate the exact decommissioned identity.'
      );
    }

    return createNanoHostTransportTokenRecord(coreDb, input);
  })();
}

function isNanoHostTransportIdentityActive(
  coreDb: CoreDb,
  identityId: string,
  deploymentId: string
): boolean {
  return Boolean(
    coreDb.sqlite
      .prepare(
        `SELECT 1 FROM nanohost_integration_identities
         WHERE identity_id = ? AND deployment_id = ? AND status = 'active'`
      )
      .get(identityId, deploymentId)
  );
}

function verifyNanoHostTransportTokenRecord(
  coreDb: CoreDb,
  expectedHash: string,
  options: {
    channel?: string | undefined;
    now?: Date | undefined;
    source?: string | undefined;
  } = {}
): VerifiedNanoHostTransportTokenRecord | null {
  const row = coreDb.sqlite
    .prepare('SELECT * FROM nanohost_transport_tokens WHERE token_hash = ?')
    .get(expectedHash) as NanoHostTransportTokenRow | undefined;

  if (!row || row.token_hash !== expectedHash) {
    return null;
  }

  if (
    row.token_type !== NANOHOST_TRANSPORT_TOKEN_TYPE ||
    row.scope !== NANOHOST_TRANSPORT_TOKEN_SCOPE ||
    !isNanoHostTransportIdentityActive(coreDb, row.owner_nanohost_identity_id, row.deployment_id)
  ) {
    return null;
  }

  const usability = evaluateNanoHostTransportTokenUsability(
    {
      expiresAt: row.expires_at,
      rotationOverlapExpiresAt: row.rotation_overlap_expires_at,
      status: row.status,
    },
    options.now
  );

  if (!usability.usable) {
    return null;
  }

  const lastUsedAt = (options.now ?? new Date()).toISOString();
  coreDb.sqlite
    .prepare(
      `UPDATE nanohost_transport_tokens
       SET last_used_at = ?, last_used_channel = ?, last_used_source = ?
       WHERE token_id = ?`
    )
    .run(lastUsedAt, options.channel ?? null, options.source ?? null, row.token_id);

  return getNanoHostTransportTokenRecord(coreDb, row.token_id);
}

function revokeNanoHostTransportTokenRecord(
  coreDb: CoreDb,
  tokenId: string,
  options: { now?: Date | undefined } = {}
): NanoHostTransportTokenRecord | null {
  const now = (options.now ?? new Date()).toISOString();
  coreDb.sqlite
    .prepare(
      `UPDATE nanohost_transport_tokens
       SET status = 'revoked', revoked_at = ?
       WHERE token_id = ? AND status != 'revoked'`
    )
    .run(now, tokenId);

  return getNanoHostTransportTokenRecord(coreDb, tokenId);
}

function rotateNanoHostTransportTokenRecord(
  coreDb: CoreDb,
  tokenId: string,
  input: Extract<ControlNanoHostTransportInput, { kind: 'rotate' }>
): { record: NanoHostTransportTokenRecord; rotatedRecord: NanoHostTransportTokenRecord } | null {
  const current = getNanoHostTransportTokenRecord(coreDb, tokenId);
  const now = input.now ?? new Date();

  if (
    !current ||
    current.status !== 'active' ||
    !evaluateNanoHostTransportTokenUsability(
      {
        expiresAt: current.expiresAt,
        rotationOverlapExpiresAt: current.rotationOverlapExpiresAt,
        status: current.status,
      },
      now
    ).usable
  ) {
    return null;
  }

  const overlapExpiresAt = new Date(now.getTime() + input.overlapSeconds * 1000).toISOString();
  const rotate = coreDb.sqlite.transaction(() => {
    coreDb.sqlite
      .prepare(
        `UPDATE nanohost_transport_tokens
         SET status = 'rotated', rotation_overlap_expires_at = ?
         WHERE token_id = ?`
      )
      .run(overlapExpiresAt, tokenId);

    const record = createNanoHostTransportTokenRecord(coreDb, {
      tokenId: input.successorTokenId,
      tokenHash: input.successorTokenHash,
      deploymentId: current.deploymentId,
      expiresAt: current.expiresAt,
      now,
      ownerNanoHostIdentityId: current.ownerNanoHostIdentityId,
      predecessorTokenId: current.tokenId,
      responsibleServerAdminActorId: current.responsibleServerAdminActorId,
    });
    const rotatedRecord = getNanoHostTransportTokenRecord(coreDb, tokenId);

    if (!rotatedRecord) {
      throw new Error(`NanoHost transport token record was not rotated: ${tokenId}`);
    }

    return { record, rotatedRecord };
  });

  return rotate();
}

function decommissionNanoHostTransportTokens(
  coreDb: CoreDb,
  ownerNanoHostIdentityId: string,
  options: { now?: Date | undefined } = {}
): NanoHostTransportTokenRecord[] {
  const now = (options.now ?? new Date()).toISOString();
  const rows = coreDb.sqlite
    .prepare(
      `SELECT token_id FROM nanohost_transport_tokens
       WHERE owner_nanohost_identity_id = ? AND status != 'revoked'`
    )
    .all(ownerNanoHostIdentityId) as Array<{ token_id: string }>;

  const revoked: NanoHostTransportTokenRecord[] = [];
  for (const row of rows) {
    const record = revokeNanoHostTransportTokenRecord(coreDb, row.token_id, {
      now: new Date(now),
    });
    if (record) {
      revoked.push(record);
    }
  }

  return revoked;
}

function decommissionNanoHostIntegrationIdentity(
  coreDb: CoreDb,
  identityId: string,
  deploymentId: string,
  options: { now?: Date | undefined } = {}
): void {
  const updated = coreDb.sqlite
    .prepare(
      `UPDATE nanohost_integration_identities
       SET status = 'decommissioned', decommissioned_at = ?
       WHERE identity_id = ? AND deployment_id = ? AND status = 'active'`
    )
    .run((options.now ?? new Date()).toISOString(), identityId, deploymentId);
  if (updated.changes !== 1) {
    throw new Error(
      'NanoHost decommission requires the exact active identity and deployment pair.'
    );
  }
}

function getNanoHostTransportTokenRecord(
  coreDb: CoreDb,
  tokenId: string
): NanoHostTransportTokenRecord | null {
  const row = coreDb.sqlite
    .prepare('SELECT * FROM nanohost_transport_tokens WHERE token_id = ?')
    .get(tokenId) as NanoHostTransportTokenRow | undefined;

  return row ? readNanoHostTransportTokenRecord(row) : null;
}

function completeNanoHostTransportTokenCutover(
  coreDb: CoreDb,
  predecessorTokenId: string,
  options: { now?: Date | undefined } = {}
): NanoHostTransportTokenRecord | null {
  const current = getNanoHostTransportTokenRecord(coreDb, predecessorTokenId);
  if (!current) {
    return null;
  }

  const now = (options.now ?? new Date()).toISOString();
  coreDb.sqlite
    .prepare(
      `UPDATE nanohost_transport_tokens
       SET status = 'rotated', rotation_overlap_expires_at = ?
       WHERE token_id = ? AND status != 'revoked'`
    )
    .run(now, predecessorTokenId);

  return getNanoHostTransportTokenRecord(coreDb, predecessorTokenId);
}

function abortNanoHostTransportTokenRotation(
  coreDb: CoreDb,
  input: {
    predecessorTokenId: string;
    successorTokenId: string;
    now?: Date | undefined;
  }
): {
  predecessor: NanoHostTransportTokenRecord;
  successor: NanoHostTransportTokenRecord;
} | null {
  const predecessor = getNanoHostTransportTokenRecord(coreDb, input.predecessorTokenId);
  const successor = getNanoHostTransportTokenRecord(coreDb, input.successorTokenId);
  if (!predecessor || !successor) {
    return null;
  }

  const now = input.now ?? new Date();
  const abort = coreDb.sqlite.transaction(() => {
    revokeNanoHostTransportTokenRecord(coreDb, input.successorTokenId, { now });
    coreDb.sqlite
      .prepare(
        `UPDATE nanohost_transport_tokens
         SET status = 'active', rotation_overlap_expires_at = NULL, revoked_at = NULL
         WHERE token_id = ? AND status = 'rotated' AND revoked_at IS NULL`
      )
      .run(input.predecessorTokenId);

    const restored = getNanoHostTransportTokenRecord(coreDb, input.predecessorTokenId);
    const revokedSuccessor = getNanoHostTransportTokenRecord(coreDb, input.successorTokenId);
    if (!restored || !revokedSuccessor) {
      throw new Error('NanoHost transport rotation abort failed to update token records.');
    }
    return { predecessor: restored, successor: revokedSuccessor };
  });

  return abort();
}

/** Preserves the four original lifecycle summaries and actor suffixes. */
function recordNanoHostTransportLifecycleAuditEvent(
  coreDb: CoreDb,
  action:
    | 'nanohost.transport.enroll'
    | 'nanohost.transport.issue'
    | 'nanohost.transport.revoke'
    | 'nanohost.transport.rotate',
  record: NanoHostTransportTokenRecord,
  actorUserId: string | null
): void {
  if (action === 'nanohost.transport.rotate' && record.status === 'revoked') {
    const predecessor = record.predecessorTokenId
      ? getNanoHostTransportTokenRecord(coreDb, record.predecessorTokenId)
      : null;
    recordServerAuditEvent({
      action,
      category: 'system',
      coreDb,
      outcome: 'failed',
      severity: 'warning',
      ...(actorUserId ? { actor: { kind: 'user', id: actorUserId } } : {}),
      errorCode: 'nanohost_transport_rotate_failed',
      resource: `nanohost-transport-token:${record.tokenId}`,
      summary: `NanoHost ${record.ownerNanoHostIdentityId} rotation for deployment ${record.deploymentId} supplied no active replacement: predecessor ${record.predecessorTokenId ?? 'unavailable'} status=${predecessor?.status ?? 'unavailable'}; successor ${record.tokenId} status=${record.status}. Requested by ${actorUserId ?? record.responsibleServerAdminActorId}. Existing enrollment or rotation recovery is required.`,
    });
    return;
  }
  const actorSuffix = actorUserId ? ` Requested by ${actorUserId}.` : '';
  let summary: string;
  switch (action) {
    case 'nanohost.transport.enroll':
      summary = `NanoHost ${record.ownerNanoHostIdentityId} enrolled with transport token ${record.tokenId} for deployment ${record.deploymentId}.${actorSuffix}`;
      break;
    case 'nanohost.transport.issue':
      summary = `NanoHost transport token ${record.tokenId} issued for ${record.ownerNanoHostIdentityId}.${actorSuffix}`;
      break;
    case 'nanohost.transport.revoke':
      summary = `NanoHost transport token ${record.tokenId} revoked.${actorSuffix}`;
      break;
    case 'nanohost.transport.rotate':
      summary = `NanoHost transport token ${record.predecessorTokenId ?? record.tokenId} rotated to ${record.tokenId}.${actorSuffix}`;
      break;
  }

  recordServerAuditEvent({
    action,
    category: 'system',
    coreDb,
    outcome: 'succeeded',
    resource: `nanohost-transport-token:${record.tokenId}`,
    severity: 'info',
    summary,
  });
}
