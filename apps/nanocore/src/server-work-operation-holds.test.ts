import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents } from './audit-events.js';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import {
  prepareServerKnowledgeMaintenance,
  type ServerKnowledgeMaintenanceDependencies,
} from './knowledge/server-knowledge-maintenance.js';
import { listServerKnowledgeSources } from './knowledge/server-knowledge-owner.js';
import { FsStore } from './lib/store.js';
import { createOperationInvocation } from './operation-composition.js';
import { readDurableCommandRequestRecords } from './storage/command-request-records.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { serverStoragePath } from './storage/db.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb } from './test-support/store.js';

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-work-hold-'));
  const coreDb = createTestCoreDb(dataRoot);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local', userId } as const;
  const store = new FsStore({ dataRoot });
  const serverKnowledgeMaintenance = {
    coreDb,
    store,
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
    inflightCommands: new WeakMap(),
    pin: vi.fn<ServerKnowledgeMaintenanceDependencies['pin']>(),
    run: vi.fn<ServerKnowledgeMaintenanceDependencies['run']>(),
  } satisfies ServerKnowledgeMaintenanceDependencies;
  const invoke = createOperationInvocation({ coreDb, store, serverKnowledgeMaintenance });
  const assertNoEffects = () => {
    expect(existsSync(serverStoragePath(dataRoot, 'server-work'))).toBe(false);
    expect(readDurableCommandRequestRecords(dataRoot)).toEqual({ status: 'readable', records: [] });
    expect(
      listServerAuditEvents(coreDb).filter((event) => event.action.startsWith('server-work.'))
    ).toEqual([]);
    expect(listServerKnowledgeSources({ coreDb, actor })).toEqual([]);
    expect(serverKnowledgeMaintenance.pin).not.toHaveBeenCalled();
    expect(serverKnowledgeMaintenance.run).not.toHaveBeenCalled();
  };
  return { invoke, actor, assertNoEffects, serverKnowledgeMaintenance };
}

const unavailable = { code: 'operation_storage_unavailable', status: 503 };

it.each([
  ['thread.server.list', {}],
  ['thread.server.read', { threadId: allocateEntityId('th') }],
  ['turn.server.interrupt', { turnId: allocateEntityId('tu') }],
  ['knowledge.server.maintain', { requestId: randomUUID(), instruction: 'Review retained pages.' }],
  ['knowledge.server.tell', { requestId: randomUUID(), content: 'Synthetic note.', sources: [] }],
] as const)('holds %s at public admission with Server work absent', async (operation, input) => {
  const f = fixture();
  await expect(
    f.invoke(operation, input, { kind: 'public', actor: f.actor })
  ).rejects.toMatchObject(unavailable);
  f.assertNoEffects();
});

it('holds scheduled Server Knowledge maintenance before staging or inference', async () => {
  const f = fixture();
  await expect(
    prepareServerKnowledgeMaintenance(f.serverKnowledgeMaintenance, {
      requestId: randomUUID(),
      actor: { kind: 'user', id: f.actor.userId },
      trigger: 'schedule',
      instructions: 'Review retained pages.',
      sources: [],
      signal: new AbortController().signal,
    })
  ).rejects.toMatchObject(unavailable);
  f.assertNoEffects();
});
