import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { afterEach, expect, it } from 'vitest';
import { listSqliteAuditEvents } from '../audit-events.js';
import { importWorkspaceLightAppDefinition } from '../catalog/light-app-catalog.js';
import { createRemainingKernelOperationImplementations } from '../generative-operations.js';
import { createKernelOperationImplementations } from '../kernel-operation-implementations.js';
import { createLightAppDefinitionOperationImplementations } from '../light-app-definition-operations.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { openExistingAppDb } from '../storage/app-db.js';
import { openWorkspaceDb } from '../storage/db.js';
import { createDemoStore } from '../test-support/demo-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const threadId = 'th_00000000-0000-7000-8000-000000000001';
const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
const schema: LightAppSchemaInput = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Execution evidence',
  purpose: 'Audit proof.',
  collections: [
    {
      name: 'entries',
      type: 'base',
      description: 'Entries.',
      indexes: [],
      fields: [{ name: 'note', type: 'text', required: true, description: 'Note.' }],
    },
  ],
};

/** Exercises the admitted native seam against the real app-local Audit owner. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-a15-'));
  roots.push(dataRoot);
  const store = createDemoStore({ dataRoot });
  const turn = store.createTurn(workspaceId, threadId, 'Native work', actor);
  const dependencies = {
    store,
    coreDb: undefined,
    inflightCommands: new WeakMap(),
    repositoryWorkspaceDb: (id: string) => openWorkspaceDb(dataRoot, id),
  };
  const operations = {
    ...createRemainingKernelOperationImplementations(dependencies),
    ...createKernelOperationImplementations(dependencies),
  };
  const context: AdmittedOperationContext = {
    kind: 'worker',
    actor,
    actorRef: actor,
    scope: { kind: 'workspace', workspaceId },
    requestId: randomUUID(),
    bindings: { workspaceId },
    lineage: {
      workspaceId,
      threadId,
      turnId: turn.id,
      agentSessionId: 'unused',
      packageSnapshotId: 'unused',
    },
  };
  const audit = (appId: string) => {
    const db = openExistingAppDb(dataRoot, workspaceId, appId);
    try {
      return listSqliteAuditEvents(db.sqlite, workspaceId);
    } finally {
      db.sqlite.close();
    }
  };
  return { store, dataRoot, dependencies, operations, context, turn, audit };
}

it('retains the executing Worker Turn on native create, record writes, batch and lifecycle Audit without relabeling replay', async () => {
  const f = fixture();
  const created = await f.operations['kernel.apps.create'](
    { ...schema, workspaceId, requestId: randomUUID() },
    f.context
  );
  const scope = { workspaceId, appId: created.appId, schemaRevision: 1, collection: 'entries' };
  const input = { ...scope, requestId: randomUUID(), data: { note: 'first' } };
  const record = await f.operations['kernel.records.create'](input, f.context);
  await f.operations['kernel.records.update'](
    {
      ...scope,
      requestId: randomUUID(),
      recordId: record.id,
      expectedRecordRevision: 1,
      data: { note: 'second' },
    },
    f.context
  );
  await f.operations['kernel.records.batch'](
    {
      workspaceId,
      appId: created.appId,
      schemaRevision: 1,
      requestId: randomUUID(),
      requests: [
        {
          method: 'POST',
          url: '/api/collections/entries/records',
          body: { data: { note: 'batch' } },
        },
      ],
    },
    f.context
  );
  const { appId: _appId, schemaRevision: _schemaRevision, ...admitted } = created.schema!;
  await f.operations['kernel.schema.update'](
    {
      workspaceId,
      appId: created.appId,
      requestId: randomUUID(),
      expectedAppRevision: 1,
      expectedSchemaRevision: 1,
      schema: { ...admitted, title: 'Revised' },
    },
    f.context
  );
  await f.operations['kernel.apps.retire'](
    { workspaceId, appId: created.appId, requestId: randomUUID(), expectedAppRevision: 2 },
    f.context
  );
  const events = f.audit(created.appId);
  expect(events.map((event) => event.action)).toEqual([
    'kernel.apps.create',
    'kernel.records.create',
    'kernel.records.update',
    'kernel.records.batch',
    'kernel.schema.update',
    'kernel.apps.retire',
  ]);
  expect(events.map((event) => [event.threadId, event.turnId])).toEqual(
    events.map(() => [threadId, f.turn.id])
  );
  const human: AdmittedOperationContext = {
    kind: 'public',
    actor: { kind: 'local', userId: actor.id },
    actorRef: actor,
    scope: { kind: 'workspace', workspaceId },
  };
  await f.operations['kernel.records.create'](input, human);
  expect(f.audit(created.appId)).toEqual(events);
});

it('retains trusted internal Turn context, leaves direct human execution unknown and refuses mismatched Turn scope before writes', async () => {
  const f = fixture();
  const human: AdmittedOperationContext = {
    kind: 'public',
    actor: { kind: 'local', userId: actor.id },
    actorRef: actor,
    scope: { kind: 'workspace', workspaceId },
  };
  const internal = {
    ...human,
    delivery: 'model' as const,
    queryContext: { threadId, turnId: f.turn.id },
  };
  const created = await f.operations['kernel.apps.create'](
    { ...schema, workspaceId, requestId: randomUUID() },
    internal
  );
  const scope = { workspaceId, appId: created.appId, schemaRevision: 1, collection: 'entries' };
  await f.operations['kernel.records.create'](
    { ...scope, requestId: randomUUID(), data: { note: 'human' } },
    human
  );
  expect(f.audit(created.appId).map((event) => [event.threadId, event.turnId])).toEqual([
    [threadId, f.turn.id],
    [null, null],
  ]);
  const coordinator: AdmittedOperationContext = {
    ...human,
    kind: 'coordinator',
    workspaceId,
    threadId,
    turnId: f.turn.id,
    goalId: 'unused',
    requestId: randomUUID(),
  };
  await f.operations['kernel.records.create'](
    { ...scope, requestId: randomUUID(), data: { note: 'coordinator' } },
    coordinator
  );
  expect(f.audit(created.appId)[2]).toMatchObject({ threadId, turnId: f.turn.id });

  await expect(
    f.operations['kernel.records.create'](
      { ...scope, requestId: randomUUID(), data: { note: 'invalid' } },
      {
        ...internal,
        queryContext: { threadId: 'th_00000000-0000-7000-8000-000000000002', turnId: f.turn.id },
      }
    )
  ).rejects.toMatchObject({ code: 'workspace_access_denied' });
  expect(f.audit(created.appId)).toHaveLength(3);
});

it('carries trusted execution through definition instantiation and schema activation', async () => {
  const f = fixture();
  const operations = createLightAppDefinitionOperationImplementations(f.dependencies);
  const imported = importWorkspaceLightAppDefinition({
    dataRoot: f.dataRoot,
    workspaceId,
    expectedRevision: 0,
    entryId: 'execution',
    displayName: 'Execution',
    definition: schema,
    producer: actor,
    createdAt: new Date().toISOString(),
    selectDefault: true,
  });
  const created = await operations['kernel.apps.instantiate'](
    { workspaceId, requestId: randomUUID(), entryId: 'execution' },
    f.context
  );
  await operations['kernel.schema.activate'](
    {
      workspaceId,
      requestId: randomUUID(),
      appId: created.appId,
      entryId: 'execution',
      digest: imported.version.digest,
      expectedAppRevision: 1,
      expectedSchemaRevision: 1,
    },
    f.context
  );
  expect(
    f.audit(created.appId).map((event) => [event.action, event.threadId, event.turnId])
  ).toEqual([
    ['kernel.apps.create', threadId, f.turn.id],
    ['kernel.schema.update', threadId, f.turn.id],
  ]);
});
