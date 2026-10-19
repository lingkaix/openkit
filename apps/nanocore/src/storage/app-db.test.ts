import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import type { KernelCommandContext } from '../generative-kernel/commands.js';
import { createLightApp } from '../generative-kernel/commands.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createAppDb, lightAppDbPath, openExistingAppDb } from './app-db.js';

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

describe('AppDb', () => {
  it.each([
    'creation',
    'reopen',
  ] as const)('uses incremental vacuum and secure deletion on the actual App %s connection', async (phase) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-app-deletion-policy-'));
    const store = createDemoStore({ dataRoot });
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    let db: ReturnType<typeof createAppDb>;
    if (phase === 'creation') {
      const appId = randomUUID();
      mkdirSync(dirname(lightAppDbPath(dataRoot, workspaceId, appId)), { recursive: true });
      db = createAppDb(dataRoot, workspaceId, appId);
    } else {
      const created = await createLightApp(
        {
          store,
          inflightCommands: new WeakMap(),
          dataRoot,
          workspaceId,
          actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          requestId: randomUUID(),
        },
        SCHEMA
      );
      db = openExistingAppDb(dataRoot, workspaceId, created.appId);
    }
    try {
      const policy = {
        autoVacuum: db.sqlite.pragma('auto_vacuum', { simple: true }),
        secureDelete: db.sqlite.pragma('secure_delete', { simple: true }),
      };
      console.info('deletion-policy', { scope: 'app', phase, ...policy });
      // INCREMENTAL is 2; secure deletion must be ON (1), not FAST (2).
      expect.soft(policy.autoVacuum).toBe(2);
      expect.soft(policy.secureDelete).toBe(1);
    } finally {
      db.sqlite.close();
    }
  });
  it('reopens an existing app database without create-on-read', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-app-db-'));
    const store = createDemoStore({ dataRoot });
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
});
