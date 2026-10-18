import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lightAppDbPath, lightAppRoot } from '../storage/app-db.js';
import { createDemoStore } from '../test-support/demo-store.js';
import {
  createLightApp,
  createRecord,
  getLightApp,
  getRecord,
  type KernelCommandContext,
  listLightAppSnapshots,
  listRecords,
  retireLightApp,
  rollbackLightAppSnapshot,
  updateLightAppSchema,
  upgradeLightAppFormat,
} from './commands.js';
import { collectionTableName, fieldColumnName } from './native.js';
import { admitLightAppDefinition, admitLightAppSchema } from './schema.js';
import { readLightAppSnapshots } from './snapshots.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates one isolated Core caller. */
function context(): KernelCommandContext {
  const dataRoot = mkdtempSync(join(tmpdir(), 'light-app-migrations-'));
  roots.push(dataRoot);
  return {
    dataRoot,
    store: createDemoStore({ dataRoot }),
    inflightCommands: new WeakMap(),
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    requestId: randomUUID(),
  };
}

/** Supplies fresh command lineage in the same authorized Workspace. */
function request(current: KernelCommandContext): KernelCommandContext {
  return { ...current, requestId: randomUUID() };
}

const schema: LightAppSchemaInput = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Contacts',
  purpose: 'Local annotations.',
  collections: [
    {
      name: 'contacts',
      type: 'base',
      description: 'Contacts.',
      fields: [
        { name: 'name', type: 'text', required: true, description: 'Name.' },
        { name: 'note', type: 'text', required: false, description: 'Recoverable annotation.' },
      ],
      indexes: [
        { unique: true, fields: ['name'] },
        { unique: false, fields: ['note'] },
      ],
    },
  ],
};

/** Retains stable IDs in an editable schema proposal. */
function proposal(app: Awaited<ReturnType<typeof createLightApp>>): LightAppSchemaInput {
  const { appId: _appId, schemaRevision: _revision, ...input } = app.schema!;
  return structuredClone(input);
}

describe('Light App migration recovery', () => {
  it('refuses missing or unknown recovery metadata versions before decoding core fields', async () => {
    const ctx = context();
    const app = await createLightApp(ctx, schema);
    const next = proposal(app);
    next.title = 'Updated title';
    await updateLightAppSchema(request(ctx), app.appId, 1, 1, next);
    const selected = listLightAppSnapshots(ctx.dataRoot, ctx.workspaceId, app.appId).snapshots[0]!;
    const path = join(
      lightAppRoot(ctx.dataRoot, ctx.workspaceId, app.appId),
      'snapshots',
      `${selected.snapshotId}.json`
    );
    for (const marker of [{}, { schemaVersion: 2 }]) {
      const invalid = JSON.stringify({ ...marker, snapshotId: 42 });
      writeFileSync(path, invalid);
      expect(() => readLightAppSnapshots(ctx.dataRoot, ctx.workspaceId, app.appId)).toThrow(
        'Unsupported retained record format.'
      );
      expect(readFileSync(path, 'utf8')).toBe(invalid);
    }
  });

  it('admits reusable definitions once and preserves their stable identities across app instances and template renames', () => {
    const definition = admitLightAppDefinition(schema);
    const first = admitLightAppSchema(definition, randomUUID(), 1);
    const second = admitLightAppSchema(definition, randomUUID(), 1);
    expect(first.collections).toEqual(second.collections);
    expect(definition).not.toHaveProperty('appId');
    expect(definition).not.toHaveProperty('schemaRevision');
    const next = structuredClone(definition);
    next.collections[0]!.name = 'people';
    next.collections[0]!.fields[0]!.name = 'display_name';
    expect(admitLightAppDefinition(next, definition).collections[0]!.fields[0]!.id).toBe(
      first.collections[0]!.fields[0]!.id
    );
  });

  it('binds catalog request replay to the raw selector and direct replay to the effective source', async () => {
    const ctx = context();
    const source = { entryId: 'contacts-template', digest: `sha256:${'a'.repeat(64)}` };
    const changedSource = { ...source, digest: `sha256:${'b'.repeat(64)}` };
    const requested = { entryId: source.entryId };
    const app = await createLightApp(ctx, schema, source, requested);
    expect(
      await createLightApp(ctx, { ...schema, title: 'Changed pointer' }, changedSource, requested)
    ).toEqual(app);
    await expect(createLightApp(ctx, schema, changedSource, changedSource)).rejects.toMatchObject({
      code: 'idempotency_key_conflict',
    });
    const update = request(ctx);
    const next = proposal(app);
    next.title = 'Admitted update';
    const updated = await updateLightAppSchema(update, app.appId, 1, 1, next, source, requested);
    expect(
      await updateLightAppSchema(
        update,
        app.appId,
        1,
        1,
        { ...next, title: 'New pointer' },
        changedSource,
        requested
      )
    ).toEqual(updated);
    expect(listLightAppSnapshots(ctx.dataRoot, ctx.workspaceId, app.appId).snapshots).toHaveLength(
      1
    );
    const direct = request(ctx);
    await createLightApp(direct, schema, source);
    await expect(createLightApp(direct, schema, changedSource)).rejects.toMatchObject({
      code: 'idempotency_key_conflict',
    });
  });

  it('adds collections and optional fields, renames and removes fields, then restores snapshot data after restart', async () => {
    const ctx = context();
    const app = await createLightApp(ctx, schema, {
      entryId: 'contacts-template',
      digest: `sha256:${'a'.repeat(64)}`,
    });
    const record = await createRecord(request(ctx), app.appId, 'contacts', 1, {
      name: 'Ada',
      note: 'retain me',
    });
    const next = proposal(app);
    next.collections[0]!.name = 'people';
    next.collections[0]!.fields = [
      { ...next.collections[0]!.fields[0]!, name: 'display_name' },
      { name: 'optional', type: 'bool', required: false, description: 'Optional flag.' },
    ];
    next.collections[0]!.indexes = [next.collections[0]!.indexes[0]!];
    next.collections.push({
      name: 'groups',
      type: 'base',
      description: 'Groups.',
      fields: [
        { name: 'label', type: 'text', required: true, description: 'Label.' },
        {
          name: 'contact',
          type: 'relation',
          required: false,
          description: 'Owner.',
          options: { collection: 'people' },
        },
      ],
      indexes: [{ unique: true, fields: ['label'] }],
    });
    const migrate = request(ctx);
    const updated = await updateLightAppSchema(migrate, app.appId, 1, 1, next);
    expect(updated).toMatchObject({
      kernelFormatVersion: 2,
      definitionVersion: updated.schemaDigest,
      definitionSource: null,
    });
    expect(await updateLightAppSchema(migrate, app.appId, 1, 1, next)).toEqual(updated);
    const surviving = getRecord(ctx.dataRoot, ctx.workspaceId, app.appId, 'people', record.id, 2);
    expect(surviving.data).toEqual({ display_name: 'Ada', optional: null });
    const db = new Database(lightAppDbPath(ctx.dataRoot, ctx.workspaceId, app.appId));
    const columns = db.pragma(
      `table_info(${collectionTableName(app.schema!.collections[0]!.id)})`
    ) as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain(
      fieldColumnName(app.schema!.collections[0]!.fields[1]!.id)
    );
    db.close();
    await expect(
      createRecord(request(ctx), app.appId, 'people', 2, { display_name: 'Ada' })
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      createRecord(request(ctx), app.appId, 'groups', 2, { label: 'team', contact: randomUUID() })
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await createRecord(request(ctx), app.appId, 'groups', 2, { label: 'team', contact: record.id });
    const snapshots = listLightAppSnapshots(ctx.dataRoot, ctx.workspaceId, app.appId).snapshots;
    expect(snapshots).toHaveLength(1);
    const selected = snapshots[0]!;
    const metadataPath = join(
      lightAppRoot(ctx.dataRoot, ctx.workspaceId, app.appId),
      'snapshots',
      `${selected.snapshotId}.json`
    );
    const retained = JSON.parse(readFileSync(metadataPath, 'utf8'));
    expect(retained.schemaVersion).toBe(1);
    const annotated = { ...retained, publicNote: 'Retain this description.' };
    writeFileSync(metadataPath, JSON.stringify(annotated));
    expect(readLightAppSnapshots(ctx.dataRoot, ctx.workspaceId, app.appId)).toEqual(snapshots);
    expect(JSON.parse(readFileSync(metadataPath, 'utf8'))).toEqual(annotated);
    await expect(
      rollbackLightAppSnapshot(request(ctx), app.appId, 1, selected.snapshotId)
    ).rejects.toMatchObject({ code: 'conflict' });
    const rollback = request(ctx);
    const restored = await rollbackLightAppSnapshot(rollback, app.appId, 2, selected.snapshotId);
    expect(restored).toMatchObject({
      appRevision: 3,
      schemaRevision: 1,
      kernelFormatVersion: 2,
      definitionVersion: app.schemaDigest,
      definitionSource: app.definitionSource,
    });
    const restarted = {
      ...ctx,
      store: createDemoStore({ dataRoot: ctx.dataRoot }),
      inflightCommands: new WeakMap(),
    };
    expect(
      await rollbackLightAppSnapshot(
        { ...restarted, requestId: rollback.requestId },
        app.appId,
        2,
        selected.snapshotId
      )
    ).toEqual(restored);
    expect(
      getRecord(ctx.dataRoot, ctx.workspaceId, app.appId, 'contacts', record.id, 1).data.note
    ).toBe('retain me');
    expect(getLightApp(ctx.dataRoot, ctx.workspaceId, app.appId).schema!.collections).toHaveLength(
      1
    );
    await expect(updateLightAppSchema(request(ctx), app.appId, 2, 1, next)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('preserves inbound and surviving outbound relations when a field removal rebuilds its table', async () => {
    const ctx = context();
    const related: LightAppSchemaInput = structuredClone(schema);
    related.collections[0]!.fields.push({
      name: 'peer',
      type: 'relation',
      required: false,
      description: 'Peer.',
      options: { collection: 'contacts' },
    });
    related.collections.push({
      name: 'links',
      type: 'base',
      description: 'Inbound links.',
      fields: [
        {
          name: 'contact',
          type: 'relation',
          required: true,
          description: 'Contact.',
          options: { collection: 'contacts' },
        },
      ],
      indexes: [],
    });
    const app = await createLightApp(ctx, related);
    const parent = await createRecord(request(ctx), app.appId, 'contacts', 1, {
      name: 'Ada',
      note: 'remove',
    });
    const peer = await createRecord(request(ctx), app.appId, 'contacts', 1, {
      name: 'Grace',
      peer: parent.id,
    });
    await createRecord(request(ctx), app.appId, 'links', 1, { contact: parent.id });
    const next = proposal(app);
    next.collections[0]!.fields.splice(1, 1);
    next.collections[0]!.indexes.splice(1, 1);
    const migrated = await updateLightAppSchema(request(ctx), app.appId, 1, 1, next);
    expect(
      getRecord(ctx.dataRoot, ctx.workspaceId, app.appId, 'contacts', peer.id, 2).data.peer
    ).toBe(parent.id);
    const removeRelation = proposal(migrated);
    removeRelation.collections[0]!.fields.splice(1, 1);
    await updateLightAppSchema(request(ctx), app.appId, 2, 2, removeRelation);
    expect(
      listRecords(ctx.dataRoot, ctx.workspaceId, app.appId, 'links', { schemaRevision: 3 })
        .items[0]!.data.contact
    ).toBe(parent.id);
    const db = new Database(lightAppDbPath(ctx.dataRoot, ctx.workspaceId, app.appId));
    db.pragma('foreign_keys = ON');
    expect(() =>
      db
        .prepare(
          `DELETE FROM "${collectionTableName(app.schema!.collections[0]!.id)}" WHERE id = ?`
        )
        .run(parent.id)
    ).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('closes committed command handles before a restore can replace the app file', async () => {
    const ctx = context();
    const app = await createLightApp(ctx, schema);
    const next = proposal(app);
    next.title = 'Renamed';
    await updateLightAppSchema(request(ctx), app.appId, 1, 1, next);
    const selected = listLightAppSnapshots(ctx.dataRoot, ctx.workspaceId, app.appId).snapshots[0]!;
    const pending = createRecord(request(ctx), app.appId, 'contacts', 2, { name: 'Later data' });
    const restoring = rollbackLightAppSnapshot(request(ctx), app.appId, 2, selected.snapshotId);
    expect(getLightApp(ctx.dataRoot, ctx.workspaceId, app.appId).schemaRevision).toBe(1);
    await pending;
    await restoring;
    expect(
      listRecords(ctx.dataRoot, ctx.workspaceId, app.appId, 'contacts', { schemaRevision: 1 }).items
    ).toEqual([]);
  });

  it('refuses fresh snapshot restore and format upgrade after retirement while preserving completed restore replay', async () => {
    const ctx = context();
    const app = await createLightApp(ctx, schema);
    const next = proposal(app);
    next.title = 'Updated contacts';
    const updated = await updateLightAppSchema(request(ctx), app.appId, 1, 1, next);
    const snapshot = listLightAppSnapshots(ctx.dataRoot, ctx.workspaceId, app.appId).snapshots[0]!;
    const restore = request(ctx);
    const restored = await rollbackLightAppSnapshot(
      restore,
      app.appId,
      updated.appRevision,
      snapshot.snapshotId
    );
    const retired = await retireLightApp(request(ctx), app.appId, restored.appRevision);
    const path = lightAppDbPath(ctx.dataRoot, ctx.workspaceId, app.appId);
    /** Reads the actual file and local mutation authority without changing them. */
    const inspect = () => {
      const sqlite = new Database(path, { fileMustExist: true, readonly: true });
      try {
        return {
          file: readFileSync(path),
          metadata: sqlite.prepare('SELECT * FROM app_metadata').all(),
          receipts: sqlite.prepare('SELECT * FROM idempotency_requests ORDER BY request_key').all(),
          audit: sqlite.prepare('SELECT * FROM audit_events ORDER BY audit_event_id').all(),
        };
      } finally {
        sqlite.close();
      }
    };
    const before = inspect();
    await expect(
      rollbackLightAppSnapshot(request(ctx), app.appId, retired.appRevision, snapshot.snapshotId)
    ).rejects.toMatchObject({
      code: 'unsupported_operation',
      message: 'Retired apps reject writes.',
    });
    expect(inspect()).toEqual(before);
    await expect(
      upgradeLightAppFormat(request(ctx), app.appId, retired.appRevision)
    ).rejects.toMatchObject({
      code: 'unsupported_operation',
      message: 'Retired apps reject writes.',
    });
    expect(inspect()).toEqual(before);
    expect(
      await rollbackLightAppSnapshot(restore, app.appId, updated.appRevision, snapshot.snapshotId)
    ).toEqual(retired);
    expect(inspect()).toEqual(before);
  });

  it('rejects unsupported changes and dangling references, and a snapshot publication failure preserves original data', async () => {
    const ctx = context();
    const app = await createLightApp(ctx, schema);
    const bad = proposal(app);
    bad.collections[0]!.fields[0]!.required = false;
    await expect(updateLightAppSchema(request(ctx), app.appId, 1, 1, bad)).rejects.toMatchObject({
      code: 'unsupported_operation',
    });
    const dangling = proposal(app);
    dangling.collections[0]!.fields.splice(1, 1);
    await expect(
      updateLightAppSchema(request(ctx), app.appId, 1, 1, dangling)
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const valid = proposal(app);
    valid.collections[0]!.fields.push({
      name: 'extra',
      type: 'text',
      required: false,
      description: 'Extra.',
    });
    const snapshotRoot = join(lightAppRoot(ctx.dataRoot, ctx.workspaceId, app.appId), 'snapshots');
    mkdirSync(snapshotRoot);
    rmSync(snapshotRoot, { recursive: true });
    // A file at the publication directory gives a deterministic local I/O failure.
    writeFileSync(snapshotRoot, 'blocked');
    await expect(updateLightAppSchema(request(ctx), app.appId, 1, 1, valid)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(getLightApp(ctx.dataRoot, ctx.workspaceId, app.appId).schemaDigest).toBe(
      app.schemaDigest
    );
  });

  it('captures a real pending native format migration and restores its old format without silent re-upgrade', async () => {
    const ctx = context();
    const app = await createLightApp(ctx, schema);
    const path = lightAppDbPath(ctx.dataRoot, ctx.workspaceId, app.appId);
    const db = new Database(path);
    // Rewind a complete native journal prefix, including the Audit shape before format migration.
    db.exec(
      'ALTER TABLE app_metadata DROP COLUMN definition_source_json; ALTER TABLE app_metadata DROP COLUMN kernel_format_version; ALTER TABLE audit_events DROP COLUMN authentication_json; DELETE FROM __drizzle_migrations WHERE created_at >= 1792227600000'
    );
    db.close();
    expect(getLightApp(ctx.dataRoot, ctx.workspaceId, app.appId).lifecycle).toBe('unavailable');
    const snapshotDirectory = join(
      lightAppRoot(ctx.dataRoot, ctx.workspaceId, app.appId),
      'snapshots'
    );
    writeFileSync(snapshotDirectory, 'blocked');
    await expect(upgradeLightAppFormat(request(ctx), app.appId, 1)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    const unchanged = new Database(path);
    expect(
      unchanged
        .prepare('SELECT COUNT(*) FROM __drizzle_migrations WHERE created_at = 1792227600000')
        .pluck()
        .get()
    ).toBe(0);
    unchanged.close();
    rmSync(snapshotDirectory);
    const upgrade = request(ctx);
    const interrupted = vi.spyOn(ctx.store, 'recordCommandRequest').mockImplementationOnce(() => {
      throw new Error('Simulated interruption after native journal commit.');
    });
    await expect(upgradeLightAppFormat(upgrade, app.appId, 1)).rejects.toThrow(
      'Simulated interruption'
    );
    interrupted.mockRestore();
    const restarted = {
      ...upgrade,
      store: createDemoStore({ dataRoot: ctx.dataRoot }),
      inflightCommands: new WeakMap(),
    };
    const upgraded = await upgradeLightAppFormat(restarted, app.appId, 1);
    expect(upgraded.kernelFormatVersion).toBe(2);
    expect(await upgradeLightAppFormat(upgrade, app.appId, 1)).toEqual(upgraded);
    const selected = listLightAppSnapshots(ctx.dataRoot, ctx.workspaceId, app.appId).snapshots[0]!;
    expect(selected).toMatchObject({ reason: 'kernel-format-migration', kernelFormatVersion: 1 });
    const restored = await rollbackLightAppSnapshot(
      request(ctx),
      app.appId,
      2,
      selected.snapshotId
    );
    expect(restored).toMatchObject({
      lifecycle: 'unavailable',
      appRevision: 3,
      kernelFormatVersion: 1,
      definitionVersion: app.schemaDigest,
    });
    expect(getLightApp(ctx.dataRoot, ctx.workspaceId, app.appId)).toMatchObject({
      lifecycle: 'unavailable',
      appRevision: 3,
      kernelFormatVersion: 1,
    });
    const raw = new Database(path);
    expect(
      (raw.pragma('table_info(app_metadata)') as Array<{ name: string }>).map(
        (column) => column.name
      )
    ).not.toContain('kernel_format_version');
    raw.close();
    expect((await upgradeLightAppFormat(request(ctx), app.appId, 3)).kernelFormatVersion).toBe(2);
    const unknown = new Database(path);
    unknown.pragma('ignore_check_constraints = ON');
    unknown.exec('UPDATE app_metadata SET kernel_format_version = 999');
    unknown.close();
    await expect(upgradeLightAppFormat(request(ctx), app.appId, 4)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
