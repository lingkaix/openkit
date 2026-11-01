import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import type { KernelCommandContext } from '../generative-kernel/commands.js';
import { createLightApp, createRecord } from '../generative-kernel/commands.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { listExportableLightAppFamilies } from './generative-portability.js';

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
  it('exports native Light App records and their values', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-light-app-portability-'));
    const store = await createDemoStore({ dataRoot });
    const context: KernelCommandContext = {
      store,
      inflightCommands: new WeakMap(),
      dataRoot,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      requestId: randomUUID(),
    };
    const created = await createLightApp(context, MAPPING_SCHEMA);
    await createRecord(
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
    const exported = listExportableLightAppFamilies(
      dataRoot,
      'ws_00000000-0000-7000-8000-000000000001'
    );
    expect(exported.apps).toHaveLength(1);
    expect(exported.records).toHaveLength(1);
    expect(Object.values(exported.records[0]!.record.values)).toEqual(
      expect.arrayContaining(['mem_1', 'crm_1', 'needs review', true])
    );
  });
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
