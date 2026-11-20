import { randomUUID } from 'node:crypto';
import { allocateEntityId } from '@openkit/protocol';
import { sha256CanonicalJson, sha256Hex } from '@openkit/protocol/digest';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { denyPendingRequest, raisePendingRequest } from '../runtime/pending-requests.js';
import { commandRequestKey, writeCommandRequestRecordInDb } from './command-request-records.js';
import { discordInteractionEnvelope, inspectPendingDecision } from './communication-inbound.js';
import type { ChannelInboundOrigin } from './communication-port.js';
import { commandInputHash } from './control-store-input.js';
import { bindWorkspaceSqlite } from './db.js';
import { applyNativeScopeMigrations } from './migrate.js';

it('proves only the original committed Workspace response with its exact input, actor and raising Turn', () => {
  const sqlite = new Database(':memory:');
  try {
    applyNativeScopeMigrations(sqlite, 'workspace');
    const origin: ChannelInboundOrigin = {
      envelope: discordInteractionEnvelope('communication-fixture', '201', sha256Hex('signed DM')),
      workspaceId: allocateEntityId('ws'),
      threadId: allocateEntityId('th'),
      pendingRequestId: 'ap_exact_communication',
      turnId: allocateEntityId('tu'),
      userId: allocateEntityId('usr'),
      bindingRevision: randomUUID(),
      disclosureDigest: sha256Hex('disclosure'),
      operation: 'approval.respond',
    };
    const db = bindWorkspaceSqlite(sqlite, '.', origin.workspaceId);
    const createdAt = '2026-11-20T10:00:00.000Z';
    const expiresAt = '2026-11-27T10:00:00.000Z';
    const scope = {
      workspaceId: origin.workspaceId,
      threadId: origin.threadId,
      turnId: origin.turnId,
      approvalRequestId: origin.pendingRequestId,
    };
    const inputHash = commandInputHash({
      ...scope,
      requestId: origin.envelope.requestId,
      decision: 'denied',
    });
    const receipt = {
      key: commandRequestKey('approval.respond', origin.envelope.requestId, scope),
      command: 'approval.respond',
      requestId: origin.envelope.requestId,
      scope,
      inputHash,
      response: { kind: 'approval', id: origin.pendingRequestId },
      createdAt,
      expiresAt,
    } as const;
    raisePendingRequest(sqlite, {
      requestId: origin.pendingRequestId,
      workspaceId: origin.workspaceId,
      threadId: origin.threadId,
      raisingTurnId: origin.turnId,
      requestItemId: allocateEntityId('it'),
      responsibleUserId: origin.userId,
      requesterKind: 'person',
      kind: 'approval',
      approval: { kind: 'permission', title: 'Fixture', description: 'An exact effect' },
      now: createdAt,
    });
    expect(inspectPendingDecision(db, origin, createdAt, inputHash)).toBeNull();
    writeCommandRequestRecordInDb(db, receipt);
    expect(inspectPendingDecision(db, origin, createdAt, inputHash)).toBeNull();

    denyPendingRequest(
      sqlite,
      origin.pendingRequestId,
      { kind: 'user', id: origin.userId },
      createdAt
    );
    expect(inspectPendingDecision(db, origin, createdAt, inputHash)).toBe(
      sha256CanonicalJson(receipt)
    );
    expect(
      inspectPendingDecision(
        db,
        { ...origin, userId: allocateEntityId('usr') },
        createdAt,
        inputHash
      )
    ).toBeNull();
    expect(
      inspectPendingDecision(
        db,
        { ...origin, turnId: allocateEntityId('tu') },
        createdAt,
        inputHash
      )
    ).toBeNull();
    expect(
      inspectPendingDecision(db, origin, createdAt, commandInputHash({ decision: 'approved' }))
    ).toBeNull();
    expect(inspectPendingDecision(db, origin, expiresAt, inputHash)).toBeNull();
  } finally {
    sqlite.close();
  }
});
