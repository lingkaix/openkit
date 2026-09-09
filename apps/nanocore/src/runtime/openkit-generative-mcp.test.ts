import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { createDemoStore } from '../test-support/demo-store.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  OPENKIT_GENERATIVE_MCP_ID,
  createOpenkitGenerativeMcpSupply,
  dispatchOpenkitGenerativeTool,
} from './openkit-generative-mcp.js';

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

describe('openkit-generative MCP', () => {
  it('lists and creates a Light App in process without a catalog entry', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-generative-mcp-'));
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const supply = createOpenkitGenerativeMcpSupply();
    expect(supply.id).toBe(OPENKIT_GENERATIVE_MCP_ID);
    expect(supply.allowedTools).toContain('kernel_apps_create');
    const context = {
      store,
      inflightCommands: new WeakMap(),
      dataRoot,
      workspaceId: 'ws_demo',
      actor: { kind: 'user' as const, id: 'user_local' },
      workspaceDb,
      scope: {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: 'turn_demo',
        agentSessionId: 'session_demo',
        triggerActor: { kind: 'user' as const, id: 'user_local' },
      },
    };
    try {
      const created = await dispatchOpenkitGenerativeTool(context, 'kernel_apps_create', {
        ...SCHEMA,
        requestId: randomUUID(),
      });
      const listed = await dispatchOpenkitGenerativeTool(context, 'kernel_apps_list', {});
      const apps = listed.structuredContent as { items: Array<{ appId: string; title: string }> };
      expect(apps.items.some((item) => item.title === SCHEMA.title)).toBe(true);
      expect(created.structuredContent).toMatchObject({ title: SCHEMA.title, lifecycle: 'active' });
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
