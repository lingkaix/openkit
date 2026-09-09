import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { createLightApp } from '../generative-kernel/commands.js';
import type { KernelCommandContext } from '../generative-kernel/commands.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { lightAppDbPath, openExistingAppDb } from './app-db.js';

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
  it('reopens an existing app database without create-on-read', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-app-db-'));
    const store = createDemoStore({ dataRoot });
    const context: KernelCommandContext = {
      store,
      inflightCommands: new WeakMap(),
      dataRoot,
      workspaceId: 'ws_demo',
      actor: { kind: 'user', id: 'user_local' },
      requestId: randomUUID(),
    };
    const created = await createLightApp(context, SCHEMA);
    const db = openExistingAppDb(dataRoot, 'ws_demo', created.appId);
    try {
      expect(db.scope).toBe('app');
      expect(db.appId).toBe(created.appId);
      expect(lightAppDbPath(dataRoot, 'ws_demo', created.appId)).toContain(created.appId);
    } finally {
      db.sqlite.close();
    }
    expect(() => openExistingAppDb(dataRoot, 'ws_demo', randomUUID())).toThrow(KernelCommandError);
  });
});
