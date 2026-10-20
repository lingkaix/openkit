import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type CommandRequestRecord, commandRequestKey } from '../lib/store.js';
import {
  getCommandRequestRecordFromDb,
  recordCommandRequestRecordInDb,
} from './command-request-records.js';
import type { ControlAdmission } from './control-store-admission.js';
import { openControlStoreProductReadHandle } from './control-store-products.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { coreDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';

const timestamp = '2026-10-20T00:00:00.000Z';
const roots: string[] = [];
let client: ReturnType<typeof getControlStoreWorkerClient> | undefined;
afterEach(async () => {
  await client?.shutdown();
  client = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Uses the actual Core journal and existing owning receipt producer, never test-owned product DDL or handlers. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'control-products-'));
  roots.push(root);
  const db = openCoreDb(root);
  try {
    applyMigrations(db);
    return { root, db, path: coreDbPath(root) };
  } catch (error) {
    db.sqlite.close();
    throw error;
  }
}

/** Current input and required Audit; replay must return the retained original without evaluating a new product candidate. */
function replayInput(receipt: CommandRequestRecord): ControlAdmission {
  return {
    receipt,
    products: [{ kind: 'thread', expectedRevision: 0, record: { schemaVersion: 1 } }],
    entries: [],
    audit: {
      id: allocateEntityId('aud'),
      workspaceId: null,
      threadId: null,
      turnId: null,
      itemId: null,
      capabilityCallId: null,
      permissionDecisionId: null,
      vaultGrantId: null,
      requestId: receipt.requestId,
      actor: null,
      subject: null,
      agentId: null,
      agentSessionId: null,
      category: 'command',
      action: receipt.command,
      resource: null,
      resourceRevision: null,
      outcome: 'succeeded',
      severity: 'info',
      summary: 'Admission replay',
      errorCode: null,
      createdAt: timestamp,
      occurredAt: timestamp,
    },
  } as ControlAdmission;
}

describe('prepared control product boundaries', () => {
  it('constructs the actual read-only product handle without replacing a legacy writable handle', () => {
    const f = fixture();
    let reader: ReturnType<typeof openControlStoreProductReadHandle> | undefined;
    try {
      reader = openControlStoreProductReadHandle(f.path, { kind: 'server' });
      const sqlite = reader.sqlite;
      expect(sqlite.readonly).toBe(true);
      expect(sqlite.pragma('query_only', { simple: true })).toBe(1);
      expect(() => sqlite.prepare('DELETE FROM audit_events').run()).toThrow();
      expect(f.db.sqlite.readonly).toBe(false);
      expect(() => f.db.sqlite.prepare('DELETE FROM audit_events WHERE 0').run()).not.toThrow();
    } finally {
      reader?.close();
      f.db.sqlite.close();
    }
  });

  it('replays native admission with descriptive additions in the original conversation receipt', async () => {
    const f = fixture();
    const scope = { coreId: 'server' };
    const requestId = randomUUID();
    const record: CommandRequestRecord = {
      key: commandRequestKey('conversation.submit', requestId, scope),
      command: 'conversation.submit',
      requestId,
      scope,
      inputHash: `sha256:${'a'.repeat(64)}`,
      response: {
        kind: 'turn',
        id: allocateEntityId('tu'),
        conversationMetadata: {
          targetRef: 'fixture-target',
          logicalModelId: null,
          receivingWorkspaceId: allocateEntityId('ws'),
          receivingThreadId: allocateEntityId('th'),
          downstream: null,
          resultKind: 'worker-turn',
          status: 202,
        },
      },
      createdAt: timestamp,
      expiresAt: '2026-10-27T00:00:00.000Z',
    };
    try {
      recordCommandRequestRecordInDb(f.db, record);
      // This is retained-data mutation, not a synthetic producer or ordinary public C3 proof.
      f.db.sqlite
        .prepare('UPDATE idempotency_requests SET response_json=? WHERE request_key=?')
        .run(
          JSON.stringify({
            ...record.response.conversationMetadata,
            annotation: { source: 'future-reader' },
          }),
          record.key
        );
      expect(getCommandRequestRecordFromDb(f.db, record.key, timestamp)?.response).toEqual(
        record.response
      );
    } finally {
      f.db.sqlite.close();
    }
    client = getControlStoreWorkerClient();
    await client.open({
      database: 'core',
      path: f.path,
      create: false,
      initialize: 'core',
      productOwner: { kind: 'server' },
    });
    await expect(client.transition('core', replayInput(record))).resolves.toEqual({
      replayed: true,
      response: record.response,
    });
  });
});
