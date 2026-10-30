// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FsStore } from './lib/store.js';
import { lightAppDbPath, lightAppRoot } from './storage/app-db.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createAppWithLocalIdentity as createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** The real public catalog and Kernel owners share definition identity without implicit data migration. */
it('imports, pins, activates and restores a reusable definition through public operations', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-definition-operations-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const ownerUserId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Definition lifecycle');
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: workspace.id });
  const app = createApp({ coreDb, dataRoot, store, mode: 'local' });
  const call = (operation: string, input: object) =>
    app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...('requestId' in input && typeof input.requestId === 'string'
          ? { 'x-openkit-request-id': input.requestId }
          : {}),
      },
      body: JSON.stringify({ workspaceId: workspace.id, ...input }),
    });
  try {
    const imported = await call('catalog.light-app-import', {
      requestId: randomUUID(),
      expectedRevision: 0,
      entryId: 'admissions',
      displayName: 'Admissions',
      selectDefault: true,
      definition: {
        format: 'openkit.light-app',
        schemaVersion: 1,
        title: 'Admissions',
        purpose: 'Small local intake notes.',
        collections: [
          {
            name: 'applications',
            type: 'base',
            description: 'Intake.',
            fields: [
              {
                name: 'applicant',
                type: 'text',
                required: true,
                description: 'Synthetic applicant key.',
              },
              { name: 'note', type: 'text', required: false, description: 'Local annotation.' },
            ],
            indexes: [],
          },
        ],
      },
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const original = await imported.json();
    const createRequestId = randomUUID();
    const created = await call('kernel.apps.instantiate', {
      requestId: createRequestId,
      entryId: 'admissions',
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const live = await created.json();
    expect(live.definitionSource).toEqual({
      entryId: 'admissions',
      digest: original.version.digest,
    });
    const record = await call('kernel.records.create', {
      requestId: randomUUID(),
      appId: live.appId,
      collection: 'applications',
      schemaRevision: live.schemaRevision,
      data: { applicant: 'synthetic-001', note: 'Keep this value in recovery.' },
    });
    expect(record.status, await record.clone().text()).toBe(200);
    const saved = await record.json();
    const next = JSON.parse(original.version.definitionJson);
    next.collections[0].fields = next.collections[0].fields.filter(
      (field: { name: string }) => field.name !== 'note'
    );
    const revised = await call('catalog.light-app-import', {
      requestId: randomUUID(),
      expectedRevision: 1,
      entryId: 'admissions',
      displayName: 'Admissions',
      definition: next,
      parentDigest: original.version.digest,
    });
    expect(revised.status, await revised.clone().text()).toBe(201);
    const version = await revised.json();
    const pinned = await call('catalog.light-app-pin', {
      requestId: randomUUID(),
      expectedRevision: 2,
      entryId: 'admissions',
      digest: version.version.digest,
      expectedPinDigest: null,
    });
    expect(pinned.status, await pinned.clone().text()).toBe(200);
    const untouched = await call('kernel.apps.get', { appId: live.appId });
    expect((await untouched.json()).schemaRevision).toBe(live.schemaRevision);
    const replayedCreate = await call('kernel.apps.instantiate', {
      requestId: createRequestId,
      entryId: 'admissions',
    });
    expect(replayedCreate.status, await replayedCreate.clone().text()).toBe(201);
    expect((await replayedCreate.json()).definitionSource).toEqual(live.definitionSource);
    const activationRequestId = randomUUID();
    const activationInput = {
      requestId: activationRequestId,
      appId: live.appId,
      entryId: 'admissions',
      expectedAppRevision: live.appRevision,
      expectedSchemaRevision: live.schemaRevision,
    };
    const activated = await call('kernel.schema.activate', {
      requestId: activationRequestId,
      appId: live.appId,
      entryId: 'admissions',
      expectedAppRevision: live.appRevision,
      expectedSchemaRevision: live.schemaRevision,
    });
    expect(activated.status, await activated.clone().text()).toBe(200);
    const active = await activated.json();
    expect(active.definitionSource.digest).toBe(version.version.digest);
    const changedPin = await call('catalog.light-app-pin', {
      requestId: randomUUID(),
      expectedRevision: 3,
      entryId: 'admissions',
      digest: original.version.digest,
      expectedPinDigest: version.version.digest,
    });
    expect(changedPin.status, await changedPin.clone().text()).toBe(200);
    const replayedActivation = await call('kernel.schema.activate', activationInput);
    expect(replayedActivation.status, await replayedActivation.clone().text()).toBe(200);
    expect((await replayedActivation.json()).definitionSource).toEqual(active.definitionSource);
    const conflictingReplay = await call('kernel.schema.activate', {
      ...activationInput,
      digest: original.version.digest,
    });
    expect(conflictingReplay.status, await conflictingReplay.clone().text()).toBe(409);
    const snapshots = await call('kernel.snapshots.list', { appId: live.appId });
    expect(snapshots.status, await snapshots.clone().text()).toBe(200);
    const copies = await snapshots.json();
    expect(copies.snapshots).toHaveLength(1);
    const restored = await call('kernel.snapshots.rollback', {
      requestId: randomUUID(),
      appId: live.appId,
      expectedAppRevision: active.appRevision,
      snapshotId: copies.snapshots[0].snapshotId,
    });
    expect(restored.status, await restored.clone().text()).toBe(200);
    const recovered = await restored.json();
    expect(recovered.definitionVersion).toBe(live.definitionVersion);
    const reread = await call('kernel.records.get', {
      appId: live.appId,
      collection: 'applications',
      recordId: saved.id,
      schemaRevision: recovered.schemaRevision,
    });
    expect(reread.status, await reread.clone().text()).toBe(200);
    expect((await reread.json()).data.note).toBe('Keep this value in recovery.');
    const { appId: _appId, schemaRevision: _schemaRevision, ...proposal } = recovered.schema;
    const extendedResponse = await call('kernel.schema.update', {
      requestId: randomUUID(),
      appId: live.appId,
      expectedAppRevision: recovered.appRevision,
      expectedSchemaRevision: recovered.schemaRevision,
      schema: {
        ...proposal,
        collections: [
          ...proposal.collections,
          {
            name: 'local_notes',
            type: 'base',
            description: 'Locally admitted data absent from the catalog definition.',
            fields: [{ name: 'body', type: 'text', required: false, description: 'Local note.' }],
            indexes: [],
          },
        ],
      },
    });
    expect(extendedResponse.status, await extendedResponse.clone().text()).toBe(200);
    const extended = await extendedResponse.json();
    const preservedResponse = await call('kernel.records.get', {
      appId: live.appId,
      collection: 'applications',
      recordId: saved.id,
      schemaRevision: extended.schemaRevision,
    });
    expect(preservedResponse.status).toBe(200);
    const preservedRecord = await preservedResponse.json();
    // Catalog provenance cannot authorize removing a collection from the current live schema.
    const refused = await call('kernel.schema.activate', {
      requestId: randomUUID(),
      appId: live.appId,
      entryId: 'admissions',
      digest: original.version.digest,
      expectedAppRevision: extended.appRevision,
      expectedSchemaRevision: extended.schemaRevision,
    });
    expect.soft(refused.status).toBe(400);
    expect.soft(await refused.json()).toMatchObject({ code: 'unsupported_operation' });
    const currentResponse = await call('kernel.apps.get', { appId: live.appId });
    expect(currentResponse.status).toBe(200);
    const current = await currentResponse.json();
    expect.soft(current).toEqual(extended);
    const preservedAfter = await call('kernel.records.get', {
      appId: live.appId,
      collection: 'applications',
      recordId: saved.id,
      schemaRevision: current.schemaRevision,
    });
    expect(preservedAfter.status).toBe(200);
    expect(await preservedAfter.json()).toEqual(preservedRecord);
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

/** Creates an isolated real public-operation boundary for catalog refusal tests. */
async function catalogReadFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-definition-read-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const ownerUserId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Catalog read boundaries');
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: workspace.id });
  const app = createApp({ coreDb, dataRoot, store, mode: 'local' });
  return {
    dataRoot,
    workspaceId: workspace.id,
    call: (operation: string, input: object) =>
      app.request(`/api/app/operations/${operation}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...('requestId' in input && typeof input.requestId === 'string'
            ? { 'x-openkit-request-id': input.requestId }
            : {}),
        },
        body: JSON.stringify({ workspaceId: workspace.id, ...input }),
      }),
    async close() {
      coreDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

it('returns not_found for a Light App that was never created without adding inventory', async () => {
  const fixture = await catalogReadFixture();
  try {
    const appId = randomUUID();
    const databasePath = lightAppDbPath(fixture.dataRoot, fixture.workspaceId, appId);
    expect(existsSync(databasePath)).toBe(false);
    const response = await fixture.call('kernel.apps.get', { appId });
    expect.soft(response.status, await response.clone().text()).toBe(404);
    expect.soft(await response.json()).toMatchObject({ code: 'not_found' });
    expect(existsSync(databasePath)).toBe(false);
    const listed = await fixture.call('kernel.apps.list', {});
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(await listed.json()).toMatchObject({ totalItems: 0, items: [] });
  } finally {
    await fixture.close();
  }
});

it('reports unknown retained Light App facts as unavailable while other apps remain usable', async () => {
  const fixture = await catalogReadFixture();
  try {
    const created = [];
    for (const title of ['Unreadable app', 'Healthy app']) {
      const response = await fixture.call('kernel.apps.create', {
        requestId: randomUUID(),
        format: 'openkit.light-app',
        schemaVersion: 1,
        title,
        purpose: 'Exercise independent catalog read availability.',
        references: [],
        collections: [
          {
            name: 'notes',
            type: 'base',
            description: 'Local notes.',
            fields: [{ name: 'note', type: 'text', required: false, description: 'A note.' }],
            indexes: [],
          },
        ],
      });
      expect(response.status, await response.clone().text()).toBe(201);
      created.push(await response.json());
    }
    const [unreadable, healthy] = created;
    const original = await fixture.call('kernel.apps.get', { appId: unreadable.appId });
    expect(original.status, await original.clone().text()).toBe(200);
    expect(await original.json()).toEqual(unreadable);
    // Fault injection follows valid public creation; only this fixture's app authority is damaged.
    writeFileSync(
      lightAppDbPath(fixture.dataRoot, fixture.workspaceId, unreadable.appId),
      'Deliberately unreadable SQLite authority.'
    );
    const response = await fixture.call('kernel.apps.get', { appId: unreadable.appId });
    expect(response.status, await response.clone().text()).toBe(200);
    expect.soft(await response.json()).toMatchObject({
      appId: unreadable.appId,
      lifecycle: 'unavailable',
      schema: null,
      appRevision: null,
      schemaRevision: null,
      schemaDigest: null,
    });
    const unaffected = await fixture.call('kernel.apps.get', { appId: healthy.appId });
    expect(unaffected.status, await unaffected.clone().text()).toBe(200);
    expect(await unaffected.json()).toEqual(healthy);
    const listed = await fixture.call('kernel.apps.list', {});
    expect(listed.status, await listed.clone().text()).toBe(200);
    const inventory = await listed.json();
    expect(inventory.totalItems).toBe(2);
    expect(inventory.items).toHaveLength(2);
    expect
      .soft(inventory.items.find((item: { appId: string }) => item.appId === unreadable.appId))
      .toMatchObject({
        appId: unreadable.appId,
        lifecycle: 'unavailable',
        appRevision: null,
        schemaRevision: null,
        schemaDigest: null,
      });
    const { schema: _schema, capabilities: _capabilities, ...healthyMetadata } = healthy;
    expect(inventory.items.find((item: { appId: string }) => item.appId === healthy.appId)).toEqual(
      healthyMetadata
    );
    // Preserve the retained authority outside inventory while its original root becomes dangling.
    const retainedRoot = lightAppRoot(fixture.dataRoot, fixture.workspaceId, unreadable.appId);
    const preservedRoot = join(fixture.dataRoot, 'preserved-app-authority');
    renameSync(retainedRoot, preservedRoot);
    const absentTarget = join(fixture.dataRoot, 'absent-app-authority');
    expect(existsSync(absentTarget)).toBe(false);
    symlinkSync(absentTarget, retainedRoot, 'dir');
    const dangling = await fixture.call('kernel.apps.get', { appId: unreadable.appId });
    expect.soft(dangling.status, await dangling.clone().text()).toBe(200);
    expect.soft(await dangling.json()).toMatchObject({
      appId: unreadable.appId,
      lifecycle: 'unavailable',
      schema: null,
      appRevision: null,
      schemaRevision: null,
      schemaDigest: null,
    });
    expect(readFileSync(join(preservedRoot, 'data.sqlite'), 'utf8')).toBe(
      'Deliberately unreadable SQLite authority.'
    );
  } finally {
    await fixture.close();
  }
});
