import type Database from 'better-sqlite3';
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
  input: ControlNanoHostTransportInput,
  native?: { readonly sqlite: Database.Database }
): ControlNanoHostTransportResult {
  assertControlProductWriter(coreDb.sqlite);
  if ('actor' in input && input.actor) requireNanoHostTransportAdministrator(coreDb, input);
  switch (input.kind) {
    case 'lifecycle-audit':
      recordNanoHostTransportLifecycleAuditEvent(
        coreDb,
        input.action,
        input.record,
        input.actorUserId,
        native,
        input.predecessor
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
    default:
      return applyNanoHostTransportMutation(coreDb.sqlite, input);
  }
}

type NanoHostAdministratorTransportInput = Extract<
  ControlNanoHostTransportInput,
  { kind: 'issue' | 'enroll' | 'rotate' | 'revoke' | 'abort' | 'decommission' }
> & {
  readonly actor: NonNullable<Extract<ControlNanoHostTransportInput, { kind: 'enroll' }>['actor']>;
};

/** Rechecks the original Administrator on the pinned Core peer, then uses the Native Token tuple. */
export function applyNanoHostAdministratorTransport(
  sqlite: Database.Database,
  coreDb: CoreDb,
  input: NanoHostAdministratorTransportInput
): ControlNanoHostTransportResult {
  requireNanoHostTransportAdministrator(coreDb, input);
  return applyNanoHostTransportMutation(sqlite, input);
}

function requireNanoHostTransportAdministrator(
  coreDb: CoreDb,
  input: Exclude<
    ControlNanoHostTransportInput,
    { kind: 'verify' | 'lifecycle-audit' | 'decommission-audit' }
  >
): void {
  try {
    requireCurrentDeploymentAdmin(
      coreDb,
      input.actor ? nanoHostTransportAdminFacts(input.actor) : undefined,
      'record' in input ? input.record.now : input.now
    );
  } catch (error) {
    if (!(error instanceof DeploymentAdminRequiredError)) throw error;
    const refusal = NANOHOST_TRANSPORT_ADMIN_REFUSAL;
    throw new OperationError(refusal.code, refusal.message, refusal.status, { cause: error });
  }
}

/** Runs an admitted transport mutation against only its owning SQLite transaction. */
export function applyNanoHostTransportMutation(
  sqlite: Database.Database,
  input: Exclude<ControlNanoHostTransportInput, { kind: 'lifecycle-audit' | 'decommission-audit' }>
): ControlNanoHostTransportResult {
  assertControlProductWriter(sqlite);
  switch (input.kind) {
    case 'issue':
      return { kind: 'record', record: createNanoHostTransportTokenRecord(sqlite, input.record) };
    case 'enroll':
      return { kind: 'record', record: enrollNanoHostTransportIdentity(sqlite, input.record) };
    case 'verify':
      return {
        kind: 'record',
        record: verifyNanoHostTransportTokenRecord(sqlite, input.tokenHash, input),
      };
    case 'revoke':
      return {
        kind: 'record',
        record: revokeNanoHostTransportTokenRecord(sqlite, input.tokenId, input),
      };
    case 'cutover':
      return {
        kind: 'record',
        record: completeNanoHostTransportTokenCutover(sqlite, input.tokenId, input),
      };
    case 'rotate':
      return {
        kind: 'rotation',
        result: rotateNanoHostTransportTokenRecord(sqlite, input.tokenId, input),
      };
    case 'abort':
      return { kind: 'abort', result: abortNanoHostTransportTokenRotation(sqlite, input) };
    case 'decommission': {
      const records = decommissionNanoHostTransportTokens(sqlite, input.identityId, input);
      decommissionNanoHostIntegrationIdentity(sqlite, input.identityId, input.deploymentId, input);
      return { kind: 'decommission', records };
    }
  }
}

function createNanoHostTransportTokenRecord(
  sqlite: Database.Database,
  input: Extract<ControlNanoHostTransportInput, { kind: 'issue' }>['record']
): NanoHostTransportTokenRecord {
  if (
    !isNanoHostTransportIdentityActive(sqlite, input.ownerNanoHostIdentityId, input.deploymentId)
  ) {
    throw new Error(
      'NanoHost transport token issuance requires the exact active identity and deployment pair.'
    );
  }

  const tokenId = input.tokenId;
  const now = (input.now ?? new Date()).toISOString();

  sqlite
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

  const record = getNanoHostTransportTokenRecord(sqlite, tokenId);
  if (!record) {
    throw new Error(`NanoHost transport token record was not created: ${tokenId}`);
  }

  return record;
}

function enrollNanoHostTransportIdentity(
  sqlite: Database.Database,
  input: Extract<ControlNanoHostTransportInput, { kind: 'enroll' }>['record']
): NanoHostTransportTokenRecord {
  return sqlite.transaction(() => {
    const now = (input.now ?? new Date()).toISOString();
    const rows = sqlite
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
    const retainedTokenHistory = sqlite
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
      sqlite
        .prepare(
          `INSERT INTO nanohost_integration_identities (
            identity_id, deployment_id, status, created_at
          ) VALUES (?, ?, 'active', ?)`
        )
        .run(input.ownerNanoHostIdentityId, input.deploymentId, now);
      return createNanoHostTransportTokenRecord(sqlite, input);
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

    const reactivated = sqlite
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

    return createNanoHostTransportTokenRecord(sqlite, input);
  })();
}

function isNanoHostTransportIdentityActive(
  sqlite: Database.Database,
  identityId: string,
  deploymentId: string
): boolean {
  return Boolean(
    sqlite
      .prepare(
        `SELECT 1 FROM nanohost_integration_identities
         WHERE identity_id = ? AND deployment_id = ? AND status = 'active'`
      )
      .get(identityId, deploymentId)
  );
}

function verifyNanoHostTransportTokenRecord(
  sqlite: Database.Database,
  expectedHash: string,
  options: {
    channel?: string | undefined;
    now?: Date | undefined;
    source?: string | undefined;
  } = {}
): VerifiedNanoHostTransportTokenRecord | null {
  const row = sqlite
    .prepare('SELECT * FROM nanohost_transport_tokens WHERE token_hash = ?')
    .get(expectedHash) as NanoHostTransportTokenRow | undefined;

  if (!row || row.token_hash !== expectedHash) {
    return null;
  }

  if (
    row.token_type !== NANOHOST_TRANSPORT_TOKEN_TYPE ||
    row.scope !== NANOHOST_TRANSPORT_TOKEN_SCOPE ||
    !isNanoHostTransportIdentityActive(sqlite, row.owner_nanohost_identity_id, row.deployment_id)
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
  sqlite
    .prepare(
      `UPDATE nanohost_transport_tokens
       SET last_used_at = ?, last_used_channel = ?, last_used_source = ?
       WHERE token_id = ?`
    )
    .run(lastUsedAt, options.channel ?? null, options.source ?? null, row.token_id);

  return getNanoHostTransportTokenRecord(sqlite, row.token_id);
}

function revokeNanoHostTransportTokenRecord(
  sqlite: Database.Database,
  tokenId: string,
  options: { now?: Date | undefined } = {}
): NanoHostTransportTokenRecord | null {
  const now = (options.now ?? new Date()).toISOString();
  sqlite
    .prepare(
      `UPDATE nanohost_transport_tokens
       SET status = 'revoked', revoked_at = ?
       WHERE token_id = ? AND status != 'revoked'`
    )
    .run(now, tokenId);

  return getNanoHostTransportTokenRecord(sqlite, tokenId);
}

function rotateNanoHostTransportTokenRecord(
  sqlite: Database.Database,
  tokenId: string,
  input: Extract<ControlNanoHostTransportInput, { kind: 'rotate' }>
): { record: NanoHostTransportTokenRecord; rotatedRecord: NanoHostTransportTokenRecord } | null {
  const current = getNanoHostTransportTokenRecord(sqlite, tokenId);
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
  const rotate = sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE nanohost_transport_tokens
         SET status = 'rotated', rotation_overlap_expires_at = ?
         WHERE token_id = ?`
      )
      .run(overlapExpiresAt, tokenId);

    const record = createNanoHostTransportTokenRecord(sqlite, {
      tokenId: input.successorTokenId,
      tokenHash: input.successorTokenHash,
      deploymentId: current.deploymentId,
      expiresAt: current.expiresAt,
      now,
      ownerNanoHostIdentityId: current.ownerNanoHostIdentityId,
      predecessorTokenId: current.tokenId,
      responsibleServerAdminActorId: current.responsibleServerAdminActorId,
    });
    const rotatedRecord = getNanoHostTransportTokenRecord(sqlite, tokenId);

    if (!rotatedRecord) {
      throw new Error(`NanoHost transport token record was not rotated: ${tokenId}`);
    }

    return { record, rotatedRecord };
  });

  return rotate();
}

function decommissionNanoHostTransportTokens(
  sqlite: Database.Database,
  ownerNanoHostIdentityId: string,
  options: { now?: Date | undefined } = {}
): NanoHostTransportTokenRecord[] {
  const now = (options.now ?? new Date()).toISOString();
  const rows = sqlite
    .prepare(
      `SELECT token_id FROM nanohost_transport_tokens
       WHERE owner_nanohost_identity_id = ? AND status != 'revoked'`
    )
    .all(ownerNanoHostIdentityId) as Array<{ token_id: string }>;

  const revoked: NanoHostTransportTokenRecord[] = [];
  for (const row of rows) {
    const record = revokeNanoHostTransportTokenRecord(sqlite, row.token_id, {
      now: new Date(now),
    });
    if (record) {
      revoked.push(record);
    }
  }

  return revoked;
}

function decommissionNanoHostIntegrationIdentity(
  sqlite: Database.Database,
  identityId: string,
  deploymentId: string,
  options: { now?: Date | undefined } = {}
): void {
  const updated = sqlite
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
  sqlite: Database.Database,
  tokenId: string
): NanoHostTransportTokenRecord | null {
  const row = sqlite
    .prepare('SELECT * FROM nanohost_transport_tokens WHERE token_id = ?')
    .get(tokenId) as NanoHostTransportTokenRow | undefined;

  return row ? readNanoHostTransportTokenRecord(row) : null;
}

function completeNanoHostTransportTokenCutover(
  sqlite: Database.Database,
  predecessorTokenId: string,
  options: { now?: Date | undefined } = {}
): NanoHostTransportTokenRecord | null {
  const current = getNanoHostTransportTokenRecord(sqlite, predecessorTokenId);
  if (!current) {
    return null;
  }

  const now = (options.now ?? new Date()).toISOString();
  sqlite
    .prepare(
      `UPDATE nanohost_transport_tokens
       SET status = 'rotated', rotation_overlap_expires_at = ?
       WHERE token_id = ? AND status != 'revoked'`
    )
    .run(now, predecessorTokenId);

  return getNanoHostTransportTokenRecord(sqlite, predecessorTokenId);
}

function abortNanoHostTransportTokenRotation(
  sqlite: Database.Database,
  input: {
    predecessorTokenId: string;
    successorTokenId: string;
    now?: Date | undefined;
  }
): {
  predecessor: NanoHostTransportTokenRecord;
  successor: NanoHostTransportTokenRecord;
} | null {
  const predecessor = getNanoHostTransportTokenRecord(sqlite, input.predecessorTokenId);
  const successor = getNanoHostTransportTokenRecord(sqlite, input.successorTokenId);
  if (!predecessor || !successor) {
    return null;
  }

  const now = input.now ?? new Date();
  const abort = sqlite.transaction(() => {
    revokeNanoHostTransportTokenRecord(sqlite, input.successorTokenId, { now });
    sqlite
      .prepare(
        `UPDATE nanohost_transport_tokens
         SET status = 'active', rotation_overlap_expires_at = NULL, revoked_at = NULL
         WHERE token_id = ? AND status = 'rotated' AND revoked_at IS NULL`
      )
      .run(input.predecessorTokenId);

    const restored = getNanoHostTransportTokenRecord(sqlite, input.predecessorTokenId);
    const revokedSuccessor = getNanoHostTransportTokenRecord(sqlite, input.successorTokenId);
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
  actorUserId: string | null,
  native?: { readonly sqlite: Database.Database },
  carried?: NanoHostTransportTokenRecord
): void {
  if (action === 'nanohost.transport.rotate' && record.status === 'revoked') {
    // The Native abort stage returns the exact predecessor of this successor's lineage.
    const abortPredecessor =
      carried &&
      carried.tokenId === record.predecessorTokenId &&
      carried.ownerNanoHostIdentityId === record.ownerNanoHostIdentityId &&
      carried.deploymentId === record.deploymentId
        ? carried
        : undefined;
    if (record.predecessorTokenId && !native && !abortPredecessor)
      throw new OperationError(
        'nanohost_transport_storage_unavailable',
        'NanoHost transport storage is unavailable.',
        503
      );
    const predecessor = record.predecessorTokenId
      ? native
        ? getNanoHostTransportTokenRecord(native.sqlite, record.predecessorTokenId)
        : abortPredecessor
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
