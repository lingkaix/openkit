import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { createLightApp, createRecord, getLightApp, getRecord } from '../generative-kernel/commands.js';
import type { KernelCommandContext } from '../generative-kernel/commands.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { ensureWorkspaceLayout } from './fs-layout.js';
import { importLightAppFamilies, listExportableLightAppFamilies } from './generative-portability.js';

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
        },
        {
          name: 'crm_id',
          type: 'text',
          required: true,
          description: 'CRM customer id.',
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

describe('Light App portability', () => {
  it('exports native records and reconstructs them under reminted app identity', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-light-app-portability-'));
    const store = createDemoStore({ dataRoot });
    const context: KernelCommandContext = {
      store,
      inflightCommands: new WeakMap(),
      dataRoot,
      workspaceId: 'ws_demo',
      actor: { kind: 'user', id: 'user_local' },
      requestId: randomUUID(),
    };
    const created = await createLightApp(context, MAPPING_SCHEMA);
    const record = await createRecord(
      { ...context, requestId: randomUUID() },
      created.appId,
      'mappings',
      created.schemaRevision,
      {
        membership_id: 'mem_1',
        crm_id: 'crm_1',
        annotation: 'needs review',
        active: true,
      }
    );
    const exported = listExportableLightAppFamilies(dataRoot, 'ws_demo');
    expect(exported.apps).toHaveLength(1);
    expect(exported.records).toHaveLength(1);
    expect(Object.values(exported.records[0]!.record.values)).toEqual(
      expect.arrayContaining(['mem_1', 'crm_1', 'needs review', true])
    );

    const targetWorkspaceId = 'ws_imported';
    const targetRoot = ensureWorkspaceLayout(dataRoot, targetWorkspaceId).root;
    const reminted = importLightAppFamilies({
      workspaceRoot: targetRoot,
      sourceWorkspaceId: 'ws_demo',
      targetWorkspaceId,
      apps: exported.apps,
      definitions: exported.definitions,
      records: exported.records,
    });
    const targetAppId = reminted.get(created.appId);
    expect(targetAppId).toBeTruthy();
    expect(targetAppId).not.toBe(created.appId);
    const imported = getLightApp(dataRoot, targetWorkspaceId, targetAppId!);
    expect(imported.title).toBe(created.title);
    expect(imported.schemaRevision).toBe(created.schemaRevision);
    const importedRecord = getRecord(
      dataRoot,
      targetWorkspaceId,
      targetAppId!,
      'mappings',
      record.id,
      imported.schemaRevision
    );
    expect(importedRecord.data.annotation).toBe('needs review');
    expect(importedRecord.data.active).toBe(true);
  });
});
