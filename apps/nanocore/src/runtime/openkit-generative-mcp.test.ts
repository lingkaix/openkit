import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
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

/** Records the exact attempt/package authority used by the selected Worker projection. */
function workerAuthority(dataRoot: string, turnId: string) {
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: 'queue_test',
    requestId: 'request_test',
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId,
    turnInput: 'Proof',
    requestedAgentId: 'agent_codex_host',
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: 'lease_test',
    agentSessionId: 'session_demo',
    inputRef: 'package_test',
    bindingRef: 'binding_test',
    sessionCompatibilityKey: 'generative-test',
    now: () => new Date().toISOString(),
  });
  return coreDb;
}

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
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(workspaceDb);
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Proof',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const coreDb = workerAuthority(dataRoot, turn.id);
    const supply = createOpenkitGenerativeMcpSupply();
    expect(supply.id).toBe(OPENKIT_GENERATIVE_MCP_ID);
    expect(supply.allowedTools).toContain('kernel_apps_create');
    const context = {
      coreDb,
      packageSnapshotId: 'package_test',
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      protocolRequestId: randomUUID(),
      store,
      inflightCommands: new WeakMap(),
      dataRoot,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      actor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
      workspaceDb,
      scope: {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        agentSessionId: 'session_demo',
        triggerActor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
      },
    };
    try {
      const created = await dispatchOpenkitGenerativeTool(context, 'kernel_apps_create', {
        ...SCHEMA,
      });
      const listed = await dispatchOpenkitGenerativeTool(context, 'kernel_apps_list', {});
      const apps = listed.structuredContent as { items: Array<{ appId: string; title: string }> };
      expect(apps.items.some((item) => item.title === SCHEMA.title)).toBe(true);
      expect(created.structuredContent).toMatchObject({ title: SCHEMA.title, lifecycle: 'active' });
      const app = created.structuredContent as { appId: string; schemaRevision: number };
      const record = await dispatchOpenkitGenerativeTool(
        { ...context, protocolRequestId: randomUUID() },
        'kernel_records_create',
        {
          appId: app.appId,
          collection: 'mappings',
          schemaRevision: app.schemaRevision,
          data: { membership_id: 'member-1', crm_id: 'customer-1', active: true },
        }
      );
      const retained = record.structuredContent as { id: string; revision: number };
      const updateContext = { ...context, protocolRequestId: randomUUID() };
      const update = {
        appId: app.appId,
        collection: 'mappings',
        recordId: retained.id,
        schemaRevision: app.schemaRevision,
        expectedRecordRevision: retained.revision,
        data: { active: false },
      };
      const result = await dispatchOpenkitGenerativeTool(
        updateContext,
        'kernel_records_update',
        update
      );
      expect(result.structuredContent).toMatchObject({
        id: retained.id,
        revision: 2,
        data: { active: false },
      });
      expect(
        await dispatchOpenkitGenerativeTool(updateContext, 'kernel_records_update', update)
      ).toEqual(result);
      await expect(
        dispatchOpenkitGenerativeTool(
          { ...context, protocolRequestId: randomUUID() },
          'kernel_records_update',
          update
        )
      ).rejects.toMatchObject({ code: 'conflict' });
      const current = await dispatchOpenkitGenerativeTool(context, 'kernel_records_get', {
        appId: app.appId,
        collection: 'mappings',
        recordId: retained.id,
        schemaRevision: app.schemaRevision,
      });
      expect(current.structuredContent).toMatchObject({
        id: retained.id,
        revision: 2,
        data: { active: false },
      });
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('binds publication Thread and Turn from immutable Worker lineage', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-generative-mcp-publish-'));
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    applyScopedMigrations(workspaceDb);
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Publish a generated view',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    const coreDb = workerAuthority(dataRoot, turn.id);
    const sourceItem = store.createItem({
      id: allocateEntityId('it'),
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Membership 1 maps to CRM 1.',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const context = {
      coreDb,
      packageSnapshotId: 'package_test',
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      protocolRequestId: randomUUID(),
      store,
      inflightCommands: new WeakMap(),
      dataRoot,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      actor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
      workspaceDb,
      scope: {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        agentSessionId: 'session_demo',
        triggerActor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
      },
    };
    try {
      const published = await dispatchOpenkitGenerativeTool(context, 'generative_ui_publish', {
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
      expect(JSON.stringify(publishTool?.inputSchema)).not.toContain('threadId');
      expect(JSON.stringify(publishTool?.inputSchema)).not.toContain('turnId');
      expect(published.structuredContent).toMatchObject({
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
      });
      const count = () =>
        (
          workspaceDb.sqlite
            .prepare('SELECT COUNT(*) AS n FROM generative_presentations')
            .get() as { n: number }
        ).n;
      expect(count()).toBe(1);
      await expect(
        dispatchOpenkitGenerativeTool(context, 'generative_ui_publish', {
          threadId: 'foreign',
          turnId: turn.id,
        })
      ).rejects.toMatchObject({ code: 'bound_input_conflict', status: 403 });
      expect(count()).toBe(1);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
