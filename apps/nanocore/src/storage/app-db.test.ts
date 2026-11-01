import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { KernelCommandContext } from '../generative-kernel/commands.js';
import { createLightApp, createRecord } from '../generative-kernel/commands.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import { collectionTableName } from '../generative-kernel/native.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { lightAppDbPath, openAppDbReadOnly, openExistingAppDb } from './app-db.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';

const SCHEMA: LightAppSchemaInput = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Membership CRM map',
  purpose: 'Local membership-to-CRM mappings.',
  collections: [
    {
      name: 'mappings',
      type: 'base',
      description: 'Mappings.',
      fields: [
        {
          name: 'membership_id',
          type: 'text',
          required: true,
          description: 'Membership id.',
        },
        {
          name: 'crm_id',
          type: 'text',
          required: true,
          description: 'CRM id.',
        },
        {
          name: 'active',
          type: 'bool',
          required: true,
          description: 'Whether the mapping is active.',
        },
      ],
      indexes: [],
    },
  ],
};

const MAPPING_SCHEMA: LightAppSchemaInput = {
  format: 'openkit.light-app',
  schemaVersion: 1,
  title: 'Membership CRM map',
  purpose: 'Map membership ids to CRM customer ids with a local annotation.',
  collections: [
    {
      name: 'mappings',
      type: 'base',
      description: 'One membership-to-CRM mapping.',
      fields: [
        {
          name: 'membership_id',
          type: 'text',
          required: true,
          description: 'Membership platform user id.',
          namespace: 'membership.prod',
        },
        {
          name: 'crm_id',
          type: 'text',
          required: true,
          description: 'CRM customer id.',
          namespace: 'crm.prod',
        },
        {
          name: 'annotation',
          type: 'text',
          required: false,
          description: 'Local note that the CRM cannot store.',
        },
        {
          name: 'active',
          type: 'bool',
          required: true,
          description: 'False when the mapping is voided.',
        },
      ],
      indexes: [{ fields: ['membership_id', 'crm_id'], unique: true }],
    },
  ],
};

const temporaryRoots: string[] = [];

async function createContext(
  requestId = randomUUID()
): Promise<KernelCommandContext & { workspaceId: string }> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-kernel-'));
  temporaryRoots.push(dataRoot);
  const store = await createDemoStore({ dataRoot });
  return {
    store,
    inflightCommands: new WeakMap(),
    dataRoot,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    requestId,
  };
}

describe('AppDb', () => {
  it('reopens an existing app database without create-on-read', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-app-db-'));
    const store = await createDemoStore({ dataRoot });
    const context: KernelCommandContext = {
      store,
      inflightCommands: new WeakMap(),
      dataRoot,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      requestId: randomUUID(),
    };
    const created = await createLightApp(context, SCHEMA);
    const db = openExistingAppDb(
      dataRoot,
      'ws_00000000-0000-7000-8000-000000000001',
      created.appId
    );
    try {
      expect(db.scope).toBe('app');
      expect(db.appId).toBe(created.appId);
      expect(db.sqlite.readonly).toBe(true);
      expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
      expect(db.sqlite.pragma('busy_timeout', { simple: true })).toBe(1_000);
      expect(
        lightAppDbPath(dataRoot, 'ws_00000000-0000-7000-8000-000000000001', created.appId)
      ).toContain(created.appId);
    } finally {
      db.sqlite.close();
    }
    expect(() =>
      openExistingAppDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001', randomUUID())
    ).toThrow(KernelCommandError);
  });

  it('rolls back the business row and Audit when the native receipt is refused', async () => {
    const context = await createContext();
    const app = await createLightApp(context, MAPPING_SCHEMA);
    const path = lightAppDbPath(context.dataRoot, context.workspaceId, app.appId);
    const requestId = randomUUID();
    const inspect = () => {
      const sqlite = new Database(path, { fileMustExist: true, readonly: true });
      try {
        sqlite.pragma('query_only = ON');
        return {
          records: sqlite
            .prepare(`SELECT * FROM "${collectionTableName(app.schema!.collections[0]!.id)}"`)
            .all(),
          audit: sqlite.prepare('SELECT * FROM audit_events ORDER BY audit_event_id').all(),
          receipts: sqlite.prepare('SELECT * FROM idempotency_requests ORDER BY request_key').all(),
        };
      } finally {
        sqlite.close();
      }
    };
    const before = inspect();
    const fixture = new Database(path, { fileMustExist: true });
    fixture.exec(`CREATE TRIGGER refuse_app_receipt BEFORE INSERT ON idempotency_requests
      WHEN NEW.command_name = 'kernel.records.create' AND NEW.request_id = '${requestId}'
      BEGIN SELECT RAISE(ABORT, 'private App receipt refusal'); END`);
    fixture.close();
    const input = {
      membership_id: 'mem_refused',
      crm_id: 'crm_refused',
      annotation: 'Must roll back with its receipt.',
      active: true,
    };
    const refused = await createRecord(
      { ...context, requestId },
      app.appId,
      'mappings',
      app.schemaRevision,
      input
    ).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: 'validation_failed',
      message: 'Record failed a native constraint.',
      path: 'data',
    });
    expect((refused as Error).message).not.toContain('private App receipt refusal');
    expect(inspect()).toEqual(before);
    const recovery = new Database(path, { fileMustExist: true });
    recovery.exec('DROP TRIGGER refuse_app_receipt');
    recovery.close();
    const committed = await createRecord(
      { ...context, requestId },
      app.appId,
      'mappings',
      app.schemaRevision,
      input
    );
    expect(committed.data).toEqual(input);
    const after = inspect();
    expect(after.records).toHaveLength(1);
    expect(after.audit).toHaveLength(before.audit.length + 1);
    expect(after.receipts).toHaveLength(before.receipts.length + 1);
  });

  it('refuses corrupt candidate bytes without changing the file or its directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-app-db-candidate-'));
    const path = join(root, 'candidate.sqlite');
    const bytes = Buffer.from('not a SQLite database');
    writeFileSync(path, bytes);
    const before = lstatSync(path);
    const entries = readdirSync(root);
    try {
      expect(() => openAppDbReadOnly(path)).toThrow(
        expect.objectContaining({ code: 'unavailable' })
      );
      expect(readFileSync(path)).toEqual(bytes);
      expect(lstatSync(path).ino).toBe(before.ino);
      expect(readdirSync(root)).toEqual(entries);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
