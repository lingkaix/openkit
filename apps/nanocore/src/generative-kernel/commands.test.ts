import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { KernelCommandError } from './errors.js';
import {
  createLightApp,
  createRecord,
  getLightApp,
  getRecord,
  listLightApps,
  listRecords,
  updateLightAppSchema,
  updateRecord,
} from './commands.js';
import type { KernelCommandContext } from './commands.js';
import { createDemoStore } from '../test-support/demo-store.js';

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

/**
 * Builds a Kernel command context against an isolated data root.
 *
 * @param requestId Caller request id.
 * @returns Context and owning Workspace id.
 */
function createContext(requestId = randomUUID()): KernelCommandContext & { workspaceId: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-kernel-'));
  const store = createDemoStore({ dataRoot });
  return {
    store,
    inflightCommands: new WeakMap(),
    dataRoot,
    workspaceId: 'ws_demo',
    actor: { kind: 'user', id: 'user_local' },
    requestId,
  };
}

describe('Generative Kernel commands', () => {
  it('creates an app and record, then rereads them after reopen', async () => {
    const context = createContext();
    const created = await createLightApp(context, MAPPING_SCHEMA);
    expect(created.lifecycle).toBe('active');
    expect(created.schema?.collections).toHaveLength(1);
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
    expect(record.data.membership_id).toBe('mem_1');
    expect(record.data.active).toBe(true);
    const listed = listLightApps(context.dataRoot, context.workspaceId);
    expect(listed.items.map((item) => item.appId)).toContain(created.appId);
    const reread = getLightApp(context.dataRoot, context.workspaceId, created.appId);
    expect(reread.schemaRevision).toBe(1);
    const fetched = getRecord(
      context.dataRoot,
      context.workspaceId,
      created.appId,
      'mappings',
      record.id,
      reread.schemaRevision
    );
    expect(fetched.data.annotation).toBe('needs review');
  });

  it('replays the same create request and rejects changed arguments', async () => {
    const requestId = randomUUID();
    const context = createContext(requestId);
    const first = await createLightApp(context, MAPPING_SCHEMA);
    const second = await createLightApp(context, MAPPING_SCHEMA);
    expect(second.appId).toBe(first.appId);
    await expect(
      createLightApp(context, { ...MAPPING_SCHEMA, title: 'Other title' })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
  });

  it('rejects stale record revisions and unique collisions', async () => {
    const context = createContext();
    const app = await createLightApp(context, MAPPING_SCHEMA);
    const first = await createRecord(
      { ...context, requestId: randomUUID() },
      app.appId,
      'mappings',
      app.schemaRevision,
      { membership_id: 'mem_1', crm_id: 'crm_1', annotation: null, active: true }
    );
    await expect(
      createRecord(
        { ...context, requestId: randomUUID() },
        app.appId,
        'mappings',
        app.schemaRevision,
        { membership_id: 'mem_1', crm_id: 'crm_1', annotation: 'dup', active: true }
      )
    ).rejects.toBeInstanceOf(KernelCommandError);
    await expect(
      updateRecord(
        { ...context, requestId: randomUUID() },
        app.appId,
        'mappings',
        first.id,
        {
          schemaRevision: app.schemaRevision,
          expectedRecordRevision: 99,
          data: { annotation: 'stale' },
        }
      )
    ).rejects.toMatchObject({ code: 'conflict' });
    const updated = await updateRecord(
      { ...context, requestId: randomUUID() },
      app.appId,
      'mappings',
      first.id,
      {
        schemaRevision: app.schemaRevision,
        expectedRecordRevision: first.revision,
        data: { annotation: 'corrected', active: false },
      }
    );
    expect(updated.data.active).toBe(false);
    expect(updated.revision).toBe(2);
    const active = listRecords(context.dataRoot, context.workspaceId, app.appId, 'mappings', {
      schemaRevision: app.schemaRevision,
      filter: 'active = true',
    });
    expect(active.completeResult).toBe(true);
    expect(active.items).toHaveLength(0);
  });

  it('adds a nullable field without dropping existing rows', async () => {
    const context = createContext();
    const app = await createLightApp(context, MAPPING_SCHEMA);
    const record = await createRecord(
      { ...context, requestId: randomUUID() },
      app.appId,
      'mappings',
      app.schemaRevision,
      { membership_id: 'mem_1', crm_id: 'crm_1', annotation: 'keep', active: true }
    );
    const collection = app.schema!.collections[0]!;
    const nextSchema: LightAppSchemaInput = {
      ...MAPPING_SCHEMA,
      collections: [
        {
          ...MAPPING_SCHEMA.collections[0]!,
          id: collection.id,
          fields: [
            ...MAPPING_SCHEMA.collections[0]!.fields.map((field, index) => ({
              ...field,
              id: collection.fields[index]!.id,
            })),
            {
              name: 'source_note',
              type: 'text',
              required: false,
              description: 'Where this mapping was observed.',
            },
          ],
        },
      ],
    };
    const updated = await updateLightAppSchema(
      { ...context, requestId: randomUUID() },
      app.appId,
      app.appRevision,
      app.schemaRevision,
      nextSchema
    );
    expect(updated.schemaRevision).toBe(2);
    const preserved = getRecord(
      context.dataRoot,
      context.workspaceId,
      app.appId,
      'mappings',
      record.id,
      updated.schemaRevision
    );
    expect(preserved.data.annotation).toBe('keep');
    expect(preserved.data.source_note).toBeNull();
  });
});
