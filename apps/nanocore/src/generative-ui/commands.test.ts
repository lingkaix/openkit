import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GENERATIVE_UI_NATIVE_CATALOG_ID,
  GENERATIVE_UI_PROTOCOL_VERSION,
  type LightAppSchemaInput,
} from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createLightApp,
  createRecord,
  listLightApps,
  updateRecord,
} from '../generative-kernel/commands.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  type GenerativeUiCommandContext,
  getGenerativePresentation,
  publishGenerativePresentation,
  refreshGenerativePresentation,
  submitGenerativePresentationAction,
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
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  applyScopedMigrations(workspaceDb);
  return {
    store,
    inflightCommands: new WeakMap(),
    dataRoot,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    requestId,
    workspaceDb,
    close: () => {
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
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
  it('binds exact completed Tool result text without creating a Kernel', async () => {
    const context = createContext();
    try {
      const turn = context.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Show the observation',
        context.actor
      );
      const text = 'The external source reported 3 matches.';
      const sourceItem = context.store.createItem({
        id: allocateEntityId('it'),
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        type: 'tool-call',
        status: 'completed',
        tool: 'search',
        server: 'selected-source',
        arguments: {},
        result: text,
        error: null,
        durationMs: 1,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      const published = await publishGenerativePresentation(context, {
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        title: 'Observation',
        fallbackText: text,
        messages: nativeMessages('tool-source', [
          { id: 'root', component: 'Text', text: { path: '/text' } },
        ]),
        source: {
          kind: 'item',
          itemId: sourceItem.id,
          contentDigest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        },
        actions: [],
      });
      expect(listLightApps(context.dataRoot, context.workspaceId).totalItems).toBe(0);
      expect(published.source).toMatchObject({ kind: 'item', itemId: sourceItem.id });
      expect(published.messages[2]).toMatchObject({ updateDataModel: { value: { text } } });
      for (const changedSource of [
        { status: 'failed' as const },
        { result: null },
        { result: 'Changed retained observation' },
      ]) {
        context.store.updateItem(sourceItem.id, changedSource);
        expect(() => getGenerativePresentation(context, published.id)).toThrow(KernelCommandError);
        context.store.updateItem(sourceItem.id, sourceItem);
      }
      expect(getGenerativePresentation(context, published.id).id).toBe(published.id);
      expect(
        context.workspaceDb.sqlite
          .prepare('SELECT COUNT(*) AS n FROM generative_presentations')
          .get()
      ).toEqual({ n: 1 });
    } finally {
      context.close();
    }
  });

  it('publishes generated text once and normalizes its source without terminalizing the Turn', async () => {
    const context = createContext();
    try {
      const turn = context.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Present the answer',
        context.actor
      );
      const input = {
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        title: 'Answer',
        fallbackText: 'A generated answer.',
        messages: nativeMessages('answer-source', [
          { id: 'root', component: 'Text', text: { path: '/text' } },
        ]),
        source: { kind: 'answer' as const, text: 'A generated answer.' },
        actions: [],
      };
      const published = await publishGenerativePresentation(context, input);
      expect(published.source.kind).toBe('item');
      const source = context.store
        .listAllItems()
        .find(
          (item) => item.id === (published.source.kind === 'item' ? published.source.itemId : '')
        );
      expect(source).toMatchObject({
        type: 'assistant-message',
        text: input.source.text,
        status: 'completed',
        turnId: turn.id,
      });
      expect(
        context.store.getTurn(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          turn.id
        ).status
      ).toBe(turn.status);
      expect(await publishGenerativePresentation(context, input)).toEqual(published);
      expect(
        context.store
          .listAllItems()
          .filter((item) => item.turnId === turn.id && item.type === 'assistant-message')
      ).toHaveLength(1);
      await expect(
        publishGenerativePresentation(context, {
          ...input,
          source: { kind: 'answer', text: 'Changed answer' },
        })
      ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    } finally {
      context.close();
    }
  });

  it.each([
    { status: 'in_progress' as const, result: 'Partial observation', digestMatches: true },
    { status: 'failed' as const, result: 'Failed observation', digestMatches: true },
    { status: 'completed' as const, result: null, digestMatches: true },
    { status: 'completed' as const, result: 'Actual observation', digestMatches: false },
  ])('refuses incomplete, missing or mismatched Tool bytes before publication: $status / $result', async ({
    status,
    result,
    digestMatches,
  }) => {
    const context = createContext();
    try {
      const turn = context.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Show the observation',
        context.actor
      );
      const source = context.store.createItem({
        id: allocateEntityId('it'),
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        type: 'tool-call',
        status,
        tool: 'search',
        server: null,
        arguments: {},
        result,
        error: null,
        durationMs: 1,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      await expect(
        publishGenerativePresentation(context, {
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: turn.id,
          title: 'Observation',
          fallbackText: 'Observation',
          messages: nativeMessages('tool-refusal', [
            { id: 'root', component: 'Text', text: { path: '/text' } },
          ]),
          source: {
            kind: 'item',
            itemId: source.id,
            contentDigest: `sha256:${createHash('sha256')
              .update(digestMatches ? (result ?? '') : 'Invented observation')
              .digest('hex')}`,
          },
          actions: [],
        })
      ).rejects.toBeInstanceOf(KernelCommandError);
      expect(
        context.workspaceDb.sqlite
          .prepare('SELECT COUNT(*) AS n FROM generative_presentations')
          .get()
      ).toEqual({ n: 0 });
      expect(
        context.store.listAllItems().some((item) => item.type === 'generative-ui-reference')
      ).toBe(false);
    } finally {
      context.close();
    }
  });

  it('keeps source-only interruption inspectable and refuses automatic publication repair', async () => {
    const context = createContext();
    try {
      const turn = context.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Present the answer',
        context.actor
      );
      const input = {
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        title: 'Answer',
        fallbackText: 'Retained answer.',
        messages: nativeMessages('interrupted-answer', [
          { id: 'root', component: 'Text', text: { path: '/text' } },
        ]),
        source: { kind: 'answer' as const, text: 'Retained answer.' },
        actions: [],
      };
      const createItem = context.store.createItem.bind(context.store);
      const interrupted = vi.spyOn(context.store, 'createItem').mockImplementation((item) => {
        const retained = createItem(item);
        if (item.type === 'assistant-message')
          throw new Error('Injected source publication interruption');
        return retained;
      });
      await expect(publishGenerativePresentation(context, input)).rejects.toThrow(
        'Injected source publication interruption'
      );
      interrupted.mockRestore();
      expect(
        context.store
          .listAllItems()
          .filter((item) => item.turnId === turn.id && item.type === 'assistant-message')
      ).toHaveLength(1);
      await expect(publishGenerativePresentation(context, input)).rejects.toMatchObject({
        code: 'recovery_required',
      });
      expect(
        context.workspaceDb.sqlite
          .prepare('SELECT COUNT(*) AS n FROM generative_presentations')
          .get()
      ).toEqual({ n: 0 });
      expect(
        context.store
          .listCommandRequests()
          .filter((receipt) => receipt.command === 'generative-ui.publish')
      ).toHaveLength(0);
    } finally {
      context.close();
    }
  });

  it('validates answer declarations before retaining source text', async () => {
    const context = createContext();
    try {
      const turn = context.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Present the answer',
        context.actor
      );
      await expect(
        publishGenerativePresentation(context, {
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: turn.id,
          title: 'Answer',
          fallbackText: 'Answer',
          messages: nativeMessages('invalid-answer', [
            { id: 'root', component: 'Script', text: 'Invalid' },
          ]),
          source: { kind: 'answer', text: 'Must not be retained.' },
          actions: [],
        })
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(context.store.listAllItems().filter((item) => item.turnId === turn.id)).toHaveLength(
        0
      );
    } finally {
      context.close();
    }
  });

  it('refuses private Tool result disclosure into a shared destination even for an administrator', async () => {
    const context = createContext();
    try {
      const privateThread = context.store.createThread(
        'ws_00000000-0000-7000-8000-000000000001',
        'Private Tool observation',
        undefined,
        'conversation',
        { visibility: 'private', privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001' }
      );
      const sourceTurn = context.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        privateThread.id,
        'Read a private source',
        context.actor
      );
      const destination = context.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Show the result publicly',
        context.actor
      );
      const text = 'Private Tool result';
      const source = context.store.createItem({
        id: allocateEntityId('it'),
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: privateThread.id,
        turnId: sourceTurn.id,
        type: 'tool-call',
        status: 'completed',
        tool: 'query',
        server: null,
        arguments: {},
        result: text,
        error: null,
        durationMs: 1,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      await expect(
        publishGenerativePresentation(
          { ...context, administratorEligible: true },
          {
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            turnId: destination.id,
            title: 'Observation',
            fallbackText: 'Observation',
            messages: nativeMessages('private-tool', [
              { id: 'root', component: 'Text', text: { path: '/text' } },
            ]),
            source: {
              kind: 'item',
              itemId: source.id,
              contentDigest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
            },
            actions: [],
          }
        )
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        context.workspaceDb.sqlite
          .prepare('SELECT COUNT(*) AS n FROM generative_presentations')
          .get()
      ).toEqual({ n: 0 });
    } finally {
      context.close();
    }
  });

  it('publishes an item-source presentation onto a running turn', async () => {
    const context = createContext();
    try {
      const turn = context.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Publish a generated view',
        context.actor
      );
      const sourceItem = context.store.createItem({
        id: testEntityId('it', `it_${turn.id}_source`),
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'Membership 1 maps to CRM 1.',
        createdAt: turn.startedAt ?? new Date().toISOString(),
        completedAt: turn.startedAt ?? new Date().toISOString(),
      });
      const published = await publishGenerativePresentation(context, {
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        title: 'Mapping view',
        fallbackText: 'Membership 1 maps to CRM 1.',
        messages: nativeMessages('surface-item', [
          {
            id: 'root',
            component: 'Column',
            children: ['body', 'refresh'],
          },
          { id: 'body', component: 'Text', text: { path: '/text' } },
          {
            id: 'refresh',
            component: 'Button',
            child: 'refreshLabel',
            action: { event: { name: 'refreshNow' } },
          },
          { id: 'refreshLabel', component: 'Text', text: 'Refresh' },
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
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
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
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        title: 'Edit annotation',
        fallbackText: 'Edit the local mapping annotation.',
        messages: nativeMessages('surface-form', [
          {
            id: 'root',
            component: 'Column',
            children: ['note', 'save'],
          },
          {
            id: 'note',
            component: 'TextField',
            label: 'Annotation',
            value: { path: '/records/0/data/annotation' },
          },
          {
            id: 'save',
            component: 'Button',
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
          { id: 'saveLabel', component: 'Text', text: 'Save' },
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

  it('refuses a form write after the record leaves the bound source query', async () => {
    const context = createContext();
    try {
      const turn = context.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
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
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        title: 'Edit annotation',
        fallbackText: 'Edit the local mapping annotation.',
        messages: nativeMessages('surface-form', [
          {
            id: 'root',
            component: 'Column',
            children: ['note', 'save'],
          },
          {
            id: 'note',
            component: 'TextField',
            label: 'Annotation',
            value: { path: '/records/0/data/annotation' },
          },
          {
            id: 'save',
            component: 'Button',
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
          { id: 'saveLabel', component: 'Text', text: 'Save' },
        ]),
        source: {
          kind: 'kernel-records',
          appId: app.appId,
          collectionId: collection!.id,
          schemaRevision: app.schemaRevision,
          query: {
            page: 1,
            perPage: 1,
            filter: `id = "${record.id}" && active = true`,
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
      const voided = await updateRecord(
        { ...context, requestId: randomUUID() },
        app.appId,
        'mappings',
        record.id,
        {
          schemaRevision: app.schemaRevision,
          expectedRecordRevision: record.revision,
          data: { active: false },
        }
      );
      await expect(
        submitGenerativePresentationAction({ ...context, requestId: randomUUID() }, published.id, {
          version: GENERATIVE_UI_PROTOCOL_VERSION,
          action: {
            name: 'saveAnnotation',
            surfaceId: 'surface-form',
            sourceComponentId: 'save',
            timestamp: new Date().toISOString(),
            context: {
              expectedRecordRevision: voided.revision,
              values: { annotation: 'should not write' },
            },
          },
        })
      ).rejects.toMatchObject({ code: 'validation_failed' });
    } finally {
      context.close();
    }
  });

  it('rolls back presentation insert when admission audit fails', async () => {
    const context = createContext();
    try {
      const turn = context.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Publish a generated view',
        context.actor
      );
      const sourceItem = context.store.createItem({
        id: testEntityId('it', `it_${turn.id}_source`),
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'Membership 1 maps to CRM 1.',
        createdAt: turn.startedAt ?? new Date().toISOString(),
        completedAt: turn.startedAt ?? new Date().toISOString(),
      });
      context.workspaceDb.sqlite.exec(
        `CREATE TRIGGER reject_generative_audit BEFORE INSERT ON audit_events
         BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;`
      );
      await expect(
        publishGenerativePresentation(context, {
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: turn.id,
          title: 'Mapping view',
          fallbackText: 'Membership 1 maps to CRM 1.',
          messages: nativeMessages('surface-item', [
            { id: 'root', component: 'Column', children: ['body'] },
            { id: 'body', component: 'Text', text: { path: '/text' } },
          ]),
          source: {
            kind: 'item',
            itemId: sourceItem.id,
            contentDigest: `sha256:${createHash('sha256').update(sourceItem.text, 'utf8').digest('hex')}`,
          },
          actions: [],
        })
      ).rejects.toBeTruthy();
      const rows = context.workspaceDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM generative_presentations')
        .get() as { count: number };
      expect(rows.count).toBe(0);
    } finally {
      context.close();
    }
  });

  it('replays the same publish request and rejects changed arguments', async () => {
    const requestId = randomUUID();
    const context = createContext(requestId);
    try {
      const turn = context.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Replay publication',
        context.actor
      );
      const sourceItem = context.store.createItem({
        id: testEntityId('it', `it_${turn.id}_source`),
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'Stable source text.',
        createdAt: turn.startedAt ?? new Date().toISOString(),
        completedAt: turn.startedAt ?? new Date().toISOString(),
      });
      const input = {
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        title: 'Stable view',
        fallbackText: 'Stable source text.',
        messages: nativeMessages('surface-replay', [
          { id: 'root', component: 'Text', text: { path: '/text' } },
        ]),
        source: {
          kind: 'item' as const,
          itemId: sourceItem.id,
          contentDigest: `sha256:${createHash('sha256').update(sourceItem.text, 'utf8').digest('hex')}`,
        },
        actions: [],
      };
      const first = await publishGenerativePresentation(context, input);
      expect(context.workspaceDb.sqlite.prepare('SELECT schema_version FROM generative_presentations WHERE presentation_id = ?').get(first.id)).toEqual({ schema_version: 1 });
      const second = await publishGenerativePresentation(context, input);
      expect(second.id).toBe(first.id);
      await expect(
        publishGenerativePresentation(context, { ...input, title: 'Changed title' })
      ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    } finally {
      context.close();
    }
  });

  it('rejects an unknown retained presentation format before read or replay', async () => {
    const requestId = randomUUID();
    const context = createContext(requestId);
    try {
      const turn = context.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Replay publication',
        context.actor
      );
      const sourceItem = context.store.createItem({
        id: testEntityId('it', `it_${turn.id}_source`),
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'Stable source text.',
        createdAt: turn.startedAt ?? new Date().toISOString(),
        completedAt: turn.startedAt ?? new Date().toISOString(),
      });
      const input = {
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        title: 'Stable view',
        fallbackText: 'Stable source text.',
        messages: nativeMessages('surface-replay', [
          { id: 'root', component: 'Text', text: { path: '/text' } },
        ]),
        source: {
          kind: 'item' as const,
          itemId: sourceItem.id,
          contentDigest: `sha256:${createHash('sha256').update(sourceItem.text, 'utf8').digest('hex')}`,
        },
        actions: [],
      };
      const first = await publishGenerativePresentation(context, input);
      context.workspaceDb.sqlite.prepare("UPDATE generative_presentations SET schema_version = 2, source_json = 'invalid-json' WHERE presentation_id = ?").run(first.id);
      expect(() => getGenerativePresentation(context, first.id)).toThrow('Unsupported retained record format.');
      await expect(publishGenerativePresentation(context, input)).rejects.toThrow('Unsupported retained record format.');
      expect(context.workspaceDb.sqlite.prepare('SELECT schema_version, source_json FROM generative_presentations WHERE presentation_id = ?').get(first.id)).toEqual({ schema_version: 2, source_json: 'invalid-json' });
    } finally {
      context.close();
    }
  });

  it('rejects publication onto a completed turn', async () => {
    const context = createContext();
    try {
      const turn = context.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
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
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: turn.id,
          title: 'Too late',
          fallbackText: 'Turn already completed.',
          messages: nativeMessages('surface-late', [
            { id: 'root', component: 'Text', text: 'Late' },
          ]),
          source: {
            kind: 'item',
            itemId: 'it_00000000-0000-7cd6-8d25-15aa6e49eadb',
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
