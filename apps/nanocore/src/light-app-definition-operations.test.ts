import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FsStore } from './lib/store.js';
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
  const workspace = store.createWorkspace('Definition lifecycle');
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: workspace.id });
  const app = createApp({ coreDb, dataRoot, store, mode: 'local' });
  const call = (operation: string, input: object) =>
    app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    expect(record.status, await record.clone().text()).toBe(201);
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
  } finally {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
