import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import { initializeWorkerRawOutput, readWorkerRawOutput } from '../runtime/worker-raw-output.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';

const roots: string[] = [];
const databases: WorkspaceDb[] = [];
let client: ReturnType<typeof getControlStoreWorkerClient> | undefined;

afterEach(async () => {
  await client?.shutdown();
  client = undefined;
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Prepares private dormant ledgers through their current owners before native command admission. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'control-capability-'));
  roots.push(root);
  const workspaceId = allocateEntityId('ws');
  const db = openWorkspaceDb(root, workspaceId);
  databases.push(db);
  applyScopedMigrations(db);

  /** Creates real inference proof for one exact Turn; callers finish setup before opening the writer. */
  function inference(
    scope = {
      workspaceId,
      threadId: allocateEntityId('th'),
      turnId: allocateEntityId('tu'),
    }
  ) {
    const call = startCapabilityCall({
      workspaceDb: db,
      ...scope,
      authorityActor: null,
      family: 'llm',
      operation: 'chat_completions',
      capabilityId: 'llm.gateway.use',
      redactionClass: 'metadata-only',
      serviceRef: 'worker-inference-gateway',
    });
    initializeWorkerRawOutput(db, call, scope);
    return { scope, callId: call.id, attemptId: randomUUID() };
  }

  /** Opens the existing worker against the already migrated private scope, then restricts Main to reads. */
  async function open() {
    db.sqlite.pragma('query_only = ON');
    client = getControlStoreWorkerClient();
    await client.open({
      database: workspaceId,
      path: db.sqlite.name,
      create: false,
      initialize: 'workspace',
      productOwner: { kind: 'workspace', workspaceId },
      dataRoot: root,
    });
    return client;
  }

  return { db, workspaceId, inference, open };
}

type Inference = ReturnType<ReturnType<typeof fixture>['inference']>;

/** Supplies only trusted value-free source positions; no native response or durable proof is fabricated. */
function position(
  inference: Inference,
  field: 'text' | 'tool-arguments' | 'reasoning',
  fromBytePosition: number,
  bytePosition: number
) {
  return { attemptId: inference.attemptId, partId: 0, field, fromBytePosition, bytePosition };
}

/** Reads original owner bytes to distinguish complete savepoint rollback from a partial watermark write. */
function proof(db: WorkspaceDb, callId: string) {
  return db.sqlite
    .prepare('SELECT extensions_json FROM capability_calls WHERE call_id = ?')
    .pluck()
    .get(callId);
}

describe('dormant native CapabilityCall raw observation boundary', () => {
  it('returns the final Turn aggregate and the total new charge for all positions in one command', async () => {
    const f = fixture();
    const inference = f.inference();
    const writer = await f.open();
    const command = { kind: 'raw-observe' as const, ...inference.scope, callId: inference.callId };
    await expect(
      writer.capability(f.workspaceId, {
        ...command,
        positions: [position(inference, 'text', 0, 2)],
      })
    ).resolves.toEqual({ rawOutputBytes: 2, chargedBytes: 2, exhausted: false });

    // Raw-Output Accounting owns the aggregate; DX owns committed visibility after native ACK.
    await expect(
      writer.capability(f.workspaceId, {
        ...command,
        positions: [
          position(inference, 'text', 2, 11),
          position(inference, 'tool-arguments', 0, 5),
          position(inference, 'reasoning', 0, 3),
        ],
      })
    ).resolves.toEqual({ rawOutputBytes: 19, chargedBytes: 17, exhausted: false });
    expect(readWorkerRawOutput(f.db, inference.scope)).toEqual({
      rawOutputBytes: 19,
      exhausted: false,
    });
  });

  it('rolls back a late gap and refuses queued same-Turn successors while sibling scopes commit', async () => {
    const f = fixture();
    const failed = f.inference();
    const successor = f.inference(failed.scope);
    const sibling = f.inference();
    const other = fixture();
    const otherInference = other.inference();
    const originals = [proof(f.db, failed.callId), proof(f.db, successor.callId)];
    const writer = await f.open();
    await other.open();

    // DX savepoints and accepted plan item 26 require local rollback and Turn-scoped failure isolation.
    const results = await Promise.allSettled([
      writer.capability(f.workspaceId, {
        kind: 'raw-observe',
        ...failed.scope,
        callId: failed.callId,
        positions: [position(failed, 'text', 0, 7), position(failed, 'tool-arguments', 1, 5)],
      }),
      writer.capability(f.workspaceId, {
        kind: 'raw-observe',
        ...successor.scope,
        callId: successor.callId,
        positions: [position(successor, 'text', 0, 11)],
      }),
      writer.capability(f.workspaceId, {
        kind: 'raw-observe',
        ...sibling.scope,
        callId: sibling.callId,
        positions: [position(sibling, 'text', 0, 3)],
      }),
      writer.capability(other.workspaceId, {
        kind: 'raw-observe',
        ...otherInference.scope,
        callId: otherInference.callId,
        positions: [position(otherInference, 'text', 0, 5)],
      }),
    ]);

    expect(results[0]).toMatchObject({
      status: 'rejected',
      reason: { commit: 'not-committed' },
    });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { commit: 'not-committed' },
    });
    expect(results[2]).toEqual({
      status: 'fulfilled',
      value: { rawOutputBytes: 3, chargedBytes: 3, exhausted: false },
    });
    expect(results[3]).toEqual({
      status: 'fulfilled',
      value: { rawOutputBytes: 5, chargedBytes: 5, exhausted: false },
    });
    expect([proof(f.db, failed.callId), proof(f.db, successor.callId)]).toEqual(originals);
    expect(readWorkerRawOutput(f.db, failed.scope)).toEqual({
      rawOutputBytes: 0,
      exhausted: false,
    });
    expect(readWorkerRawOutput(f.db, sibling.scope).rawOutputBytes).toBe(3);
    expect(readWorkerRawOutput(other.db, otherInference.scope).rawOutputBytes).toBe(5);
  });
});
