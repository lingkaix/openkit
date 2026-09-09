import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import {
  createOpenkitGenerativeMcpSupply,
  dispatchOpenkitGenerativeTool,
  OPENKIT_GENERATIVE_MCP_ID,
  OPENKIT_GENERATIVE_TOOLS,
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
  it('projects ListTools schemas that Ajv2020 can compile', () => {
    const validator = new Ajv2020({ allErrors: false, strict: false });
    for (const tool of OPENKIT_GENERATIVE_TOOLS) {
      expect(() => validator.compile(tool.inputSchema)).not.toThrow();
    }
  });
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

  it('publishes a native presentation without dropping threadId', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-generative-mcp-publish-'));
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const turn = store.createTurn('ws_demo', 'th_demo', 'Publish a generated view', {
      kind: 'user',
      id: 'user_local',
    });
    const sourceItem = store.createItem({
      id: `it_${turn.id}_source`,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Membership 1 maps to CRM 1.',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: turn.startedAt ?? new Date().toISOString(),
    });
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
        turnId: turn.id,
        agentSessionId: 'session_demo',
        triggerActor: { kind: 'user' as const, id: 'user_local' },
      },
    };
    try {
      const published = await dispatchOpenkitGenerativeTool(context, 'generative_ui_publish', {
        requestId: randomUUID(),
        threadId: 'th_demo',
        turnId: turn.id,
        title: 'Mapping view',
        fallbackText: 'Membership 1 maps to CRM 1.',
        messages: [
          {
            version: 'v0.9',
            createSurface: {
              surfaceId: 'surface-item',
              catalogId: 'urn:openkit:a2ui:catalog:native:v1',
              sendDataModel: false,
            },
          },
          {
            version: 'v0.9',
            updateComponents: {
              surfaceId: 'surface-item',
              components: [
                { id: 'root', component: 'Column', children: ['body'] },
                { id: 'body', component: 'Text', text: { path: '/text' } },
              ],
            },
          },
        ],
        source: {
          kind: 'item',
          itemId: sourceItem.id,
          contentDigest: `sha256:${createHash('sha256').update(sourceItem.text, 'utf8').digest('hex')}`,
        },
        actions: [],
      });
      expect(published.structuredContent).toMatchObject({ publication: 'published' });
      const publishTool = OPENKIT_GENERATIVE_TOOLS.find(
        (tool) => tool.name === 'generative_ui_publish'
      );
      expect(JSON.stringify(publishTool?.inputSchema)).toContain('threadId');
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
