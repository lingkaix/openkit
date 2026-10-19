import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LightAppSchemaInputSchema } from '@openkit/app-api-schemas';
import { allocateEntityId, formatReferenceUri } from '@openkit/protocol';
import { expect, it } from 'vitest';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import {
  createLightApp,
  createRecord,
  getLightApp,
  getRecord,
  type KernelCommandContext,
  updateLightAppSchema,
} from './commands.js';

/** App discovery retains exact meaning targets without making external availability a data fence. */
it('retains pinned page/raw references across revision and restart while app records stay usable', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-c03-discovery-'));
  try {
    const store = createDemoStore({ dataRoot });
    const base = {
      store,
      dataRoot,
      workspaceId: DEMO_WORKSPACE_ID,
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      inflightCommands: new WeakMap(),
    } satisfies Omit<KernelCommandContext, 'requestId'>;
    const command = () => ({ ...base, requestId: randomUUID() });
    // This independently allocated base has no target data; references never create or grant it.
    const knowledgeBaseId = allocateEntityId('kb');
    const page = {
      scopeId: `page/workspace/${DEMO_WORKSPACE_ID}/${knowledgeBaseId}`,
      objectId: 'rules/admissions',
    };
    const raw = {
      scopeId: `raw/workspace/${DEMO_WORKSPACE_ID}/${knowledgeBaseId}`,
      objectId: 'source/intake.txt',
    };
    const firstReferences = [
      formatReferenceUri(page, `sha256:${'a'.repeat(64)}`),
      formatReferenceUri(raw, `sha256:${'b'.repeat(64)}`),
    ];
    const created = await createLightApp(
      command(),
      LightAppSchemaInputSchema.parse({
        format: 'openkit.light-app',
        schemaVersion: 1,
        title: 'Case notes',
        purpose: 'Operational label; referenced meaning remains external.',
        references: firstReferences,
        collections: [
          {
            name: 'notes',
            type: 'base',
            description: 'Local state label.',
            indexes: [],
            fields: [{ name: 'note', type: 'text', required: false, description: 'Note label.' }],
          },
        ],
      })
    );
    expect(created.schema).toMatchObject({ references: firstReferences });
    const record = await createRecord(command(), created.appId, 'notes', 1, {
      note: 'Keep this local content.',
    });
    const before = getLightApp(dataRoot, DEMO_WORKSPACE_ID, created.appId);
    const nextReferences = [formatReferenceUri(page, `sha256:${'c'.repeat(64)}`)];
    const updated = await updateLightAppSchema(command(), created.appId, before.appRevision, 1, {
      format: 'openkit.light-app',
      schemaVersion: 1,
      title: before.schema!.title,
      purpose: before.schema!.purpose,
      collections: before.schema!.collections,
      references: nextReferences,
    });
    expect(updated.schema).toMatchObject({ schemaRevision: 2, references: nextReferences });
    expect(updated.schema!.collections).toEqual(before.schema!.collections);
    expect(before.schema).toMatchObject({ schemaRevision: 1, references: firstReferences });

    const restarted = createDemoStore({ dataRoot });
    expect(restarted.getWorkspace(DEMO_WORKSPACE_ID).id).toBe(DEMO_WORKSPACE_ID);
    const discovered = getLightApp(dataRoot, DEMO_WORKSPACE_ID, created.appId);
    expect(discovered.schema).toEqual(updated.schema);
    expect(
      getRecord(dataRoot, DEMO_WORKSPACE_ID, created.appId, 'notes', record.id, 2).data
    ).toEqual({ note: 'Keep this local content.' });
    const later = await createRecord(
      { ...command(), store: restarted },
      created.appId,
      'notes',
      2,
      { note: 'Still writable.' }
    );
    expect(later.data).toEqual({ note: 'Still writable.' });
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
