import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GENERATIVE_UI_NATIVE_CATALOG_ID,
  GENERATIVE_UI_PROTOCOL_VERSION,
  type LightAppSchemaInput,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { createLightApp, createRecord } from '../generative-kernel/commands.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import {
  getGenerativePresentation,
  publishGenerativePresentation,
  refreshGenerativePresentation,
  submitGenerativePresentationAction,
  type GenerativeUiCommandContext,
} from './commands.js';

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
          required: true,
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
 * Builds a Generative UI command context against an isolated data root.
 *
 * @param requestId Caller request id.
 * @returns Context plus close helper.
 */
function createContext(requestId = randomUUID()): GenerativeUiCommandContext & {
  close: () => void;
} {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-generative-ui-'));
  const store = createDemoStore({ dataRoot });
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return {
    store,
    inflightCommands: new WeakMap(),
    dataRoot,
    workspaceId: 'ws_demo',
    actor: { kind: 'user', id: 'user_local' },
    requestId,
    workspaceDb,
    close: () => workspaceDb.sqlite.close(),
  };
}

/**
 * Builds native createSurface plus updateComponents messages.
 *
 * @param surfaceId Shared surface id.
 * @param components Complete component set.
 * @returns Producer messages.
 */
function nativeMessages(surfaceId: string, components: unknown[]) {
  return [
    {
      version: GENERATIVE_UI_PROTOCOL_VERSION,
      createSurface: {
        surfaceId,
        catalogId: GENERATIVE_UI_NATIVE_CATALOG_ID,
        sendDataModel: false,
      },
    },
    {
      version: GENERATIVE_UI_PROTOCOL_VERSION,
      updateComponents: { surfaceId, components },
    },
  ];
}

describe('Generative UI commands', () => {
  it('publishes an item-source presentation onto a running turn', async () => {
    const context = createContext();
    try {
      const turn = context.store.createTurn(
        'ws_demo',
        'th_demo',
        'Publish a generated view',
        context.actor
      );
      const sourceItem = context.store.createItem({
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
      const published = await publishGenerativePresentation(context, {
        threadId: 'th_demo',
        turnId: turn.id,
        title: 'Mapping view',
        fallbackText: 'Membership 1 maps to CRM 1.',
        messages: nativeMessages('surface-item', [
          {
            id: 'root',
            component: { Column: { children: { explicitList: ['body', 'refresh'] } } },
          },
          { id: 'body', component: { Text: { text: { path: '/text' } } } },
          {
            id: 'refresh',
            component: {
              Button: {
                child: 'refreshLabel',
                action: { event: { name: 'refreshNow' } },
              },
            },
          },
          { id: 'refreshLabel', component: { Text: { text: { literalString: 'Refresh' } } } },
        ]),
        source: {
          kind: 'item',
          itemId: sourceItem.id,
          contentDigest: `sha256:${createHash('sha256').update(sourceItem.text, 'utf8').digest('hex')}`,
        },
        actions: [{ name: 'refreshNow', componentId: 'refresh', kind: 'refresh' }],
      });
      expect(published.publication).toBe('published');
      expect(published.messages).toHaveLength(3);
      const reread = getGenerativePresentation(context, published.id);
      expect(reread.itemId).toBe(published.itemId);
      const refreshed = refreshGenerativePresentation(context, published.id, {
        version: GENERATIVE_UI_PROTOCOL_VERSION,
        action: {
          name: 'refreshNow',
          surfaceId: 'surface-item',
          sourceComponentId: 'refresh',
          timestamp: new Date().toISOString(),
        },
      });
      expect(refreshed.messages[0]).toMatchObject({
        updateDataModel: { value: { text: 'Membership 1 maps to CRM 1.' } },
      });
    } finally {
      context.close();
    }
  });

  it('commits a kernel-record-update and rereads the new value', async () => {
    const context = createContext();
    try {
      const turn = context.store.createTurn(
        'ws_demo',
        'th_demo',
        'Edit a mapping annotation',
        context.actor
      );
      const app = await createLightApp({ ...context, requestId: randomUUID() }, MAPPING_SCHEMA);
      const collection = app.schema?.collections[0];
      const annotationField = collection?.fields.find((field) => field.name === 'annotation');
      expect(collection && annotationField).toBeTruthy();
      const record = await createRecord(
        { ...context, requestId: randomUUID() },
        app.appId,
        'mappings',
        app.schemaRevision,
        {
          membership_id: 'mem_1',
          crm_id: 'crm_1',
          annotation: 'needs review',
          active: true,
        }
      );
      const published = await publishGenerativePresentation(context, {
        threadId: 'th_demo',
        turnId: turn.id,
        title: 'Edit annotation',
        fallbackText: 'Edit the local mapping annotation.',
        messages: nativeMessages('surface-form', [
          {
            id: 'root',
            component: { Column: { children: { explicitList: ['note', 'save'] } } },
          },
          {
            id: 'note',
            component: {
              TextField: {
                label: 'Annotation',
                text: { path: '/records/0/data/annotation' },
              },
            },
          },
          {
            id: 'save',
            component: {
              Button: {
                child: 'saveLabel',
                action: {
                  event: {
                    name: 'saveAnnotation',
                    context: {
                      expectedRecordRevision: { path: '/records/0/revision' },
                      values: { path: '/records/0/data' },
                    },
                  },
                },
              },
            },
          },
          { id: 'saveLabel', component: { Text: { text: { literalString: 'Save' } } } },
        ]),
        source: {
          kind: 'kernel-records',
          appId: app.appId,
          collectionId: collection!.id,
          schemaRevision: app.schemaRevision,
          query: {
            page: 1,
            perPage: 1,
            filter: `id = "${record.id}"`,
            fields: 'annotation',
          },
        },
        actions: [
          {
            name: 'saveAnnotation',
            componentId: 'save',
            kind: 'kernel-record-update',
            recordId: record.id,
            writableFieldIds: [annotationField!.id],
          },
        ],
      });
      const updated = await submitGenerativePresentationAction(context, published.id, {
        version: GENERATIVE_UI_PROTOCOL_VERSION,
        action: {
          name: 'saveAnnotation',
          surfaceId: 'surface-form',
          sourceComponentId: 'save',
          timestamp: new Date().toISOString(),
          context: {
            expectedRecordRevision: record.revision,
            values: { annotation: 'reviewed' },
          },
        },
      });
      expect(updated.record).toMatchObject({ data: { annotation: 'reviewed' } });
    } finally {
      context.close();
    }
  });

  it('replays the same publish request and rejects changed arguments', async () => {
    const requestId = randomUUID();
    const context = createContext(requestId);
    try {
      const turn = context.store.createTurn(
        'ws_demo',
        'th_demo',
        'Replay publication',
        context.actor
      );
      const sourceItem = context.store.createItem({
        id: `it_${turn.id}_source`,
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'Stable source text.',
        createdAt: turn.startedAt ?? new Date().toISOString(),
        completedAt: turn.startedAt ?? new Date().toISOString(),
      });
      const input = {
        threadId: 'th_demo',
        turnId: turn.id,
        title: 'Stable view',
        fallbackText: 'Stable source text.',
        messages: nativeMessages('surface-replay', [
          { id: 'root', component: { Text: { text: { path: '/text' } } } },
        ]),
        source: {
          kind: 'item' as const,
          itemId: sourceItem.id,
          contentDigest: `sha256:${createHash('sha256').update(sourceItem.text, 'utf8').digest('hex')}`,
        },
        actions: [],
      };
      const first = await publishGenerativePresentation(context, input);
      const second = await publishGenerativePresentation(context, input);
      expect(second.id).toBe(first.id);
      await expect(
        publishGenerativePresentation(context, { ...input, title: 'Changed title' })
      ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    } finally {
      context.close();
    }
  });

  it('rejects publication onto a completed turn', async () => {
    const context = createContext();
    try {
      const turn = context.store.createTurn(
        'ws_demo',
        'th_demo',
        'Completed turn',
        context.actor
      );
      context.store.updateTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        durationMs: 1,
      });
      await expect(
        publishGenerativePresentation(context, {
          threadId: 'th_demo',
          turnId: turn.id,
          title: 'Too late',
          fallbackText: 'Turn already completed.',
          messages: nativeMessages('surface-late', [
            { id: 'root', component: { Text: { text: { literalString: 'Late' } } } },
          ]),
          source: {
            kind: 'item',
            itemId: 'it_missing',
            contentDigest: `sha256:${'0'.repeat(64)}`,
          },
          actions: [],
        })
      ).rejects.toBeInstanceOf(KernelCommandError);
    } finally {
      context.close();
    }
  });
});
