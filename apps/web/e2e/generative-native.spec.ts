import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaceDataRoot } from './_lib/demo-data.js';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;
let fixtureRoot: string | null = null;
test.afterEach(async () => {
  await stack?.stop();
  stack = null;
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = null;
});

/** Native browser actions must use the retained exact source and preserve drafts on local failure. */
test('edits and refreshes native Kernel data, reopens after restart and groups an independent Tool source', async ({
  page,
}) => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'openkit-generative-browser-'));
  await seedDemoWorkspaceDataRoot(fixtureRoot);
  const [
    { FsStore },
    { openCoreDb, openWorkspaceDb },
    { applyScopedMigrations },
    kernel,
    ui,
    { createHash },
  ] = await Promise.all([
    import('../../nanocore/dist/lib/store.js'),
    import('../../nanocore/dist/storage/db.js'),
    import('../../nanocore/dist/storage/migrate.js'),
    import('../../nanocore/dist/generative-kernel/commands.js'),
    import('../../nanocore/dist/generative-ui/commands.js'),
    import('node:crypto'),
  ]);
  const store = new FsStore({ dataRoot: fixtureRoot });
  const workspaceId = store.listWorkspaces().find((workspace) => workspace.kind === 'code')!.id;
  const threadId = store.listThreads(workspaceId)[0]!.id;
  const coreDb = openCoreDb(fixtureRoot);
  const users = coreDb.sqlite.prepare("SELECT id FROM users WHERE kind = 'local'").all() as Array<{
    id: string;
  }>;
  coreDb.sqlite.close();
  expect(users).toHaveLength(1);
  const workspaceDb = openWorkspaceDb(fixtureRoot, workspaceId);
  applyScopedMigrations(workspaceDb);
  const actor = { kind: 'user' as const, id: users[0]!.id };
  const turn = store.createTurn(workspaceId, threadId, 'Native Generative browser proof', actor);
  const context = {
    store,
    workspaceDb,
    actor,
    dataRoot: fixtureRoot,
    workspaceId,
    requestId: randomUUID(),
    inflightCommands: new WeakMap(),
  };
  const messages = (surfaceId: string, components: unknown[]) => [
    {
      version: 'v0.9',
      createSurface: {
        surfaceId,
        catalogId: 'urn:openkit:a2ui:catalog:native:v1',
        sendDataModel: false,
      },
    },
    { version: 'v0.9', updateComponents: { surfaceId, components } },
  ];
  let appId: string;
  let recordId: string;
  try {
    const app = await kernel.createLightApp(context, {
      format: 'openkit.light-app',
      schemaVersion: 1,
      title: 'Native browser notes',
      purpose: 'Preserve local-only annotations without copying external records.',
      collections: [
        {
          name: 'notes',
          type: 'base',
          description: 'Local annotations.',
          indexes: [],
          fields: [
            {
              name: 'note',
              type: 'text',
              required: true,
              description: 'A local annotation owned by this Kernel.',
            },
          ],
        },
      ],
    });
    appId = app.appId;
    const record = await kernel.createRecord(
      { ...context, requestId: randomUUID() },
      appId,
      'notes',
      app.schemaRevision,
      { note: 'Original local note' }
    );
    recordId = record.id;
    const collection = app.schema!.collections[0]!;
    await ui.publishGenerativePresentation(
      { ...context, requestId: randomUUID() },
      {
        threadId,
        turnId: turn.id,
        title: 'Edit local note',
        fallbackText: 'Local note editor',
        messages: messages('native-note', [
          { id: 'root', component: 'Column', children: ['note', 'save', 'refresh'] },
          {
            id: 'note',
            component: 'TextField',
            label: 'Local note',
            value: { path: '/records/0/data/note' },
          },
          {
            id: 'save',
            component: 'Button',
            child: 'save-label',
            action: {
              event: {
                name: 'save',
                context: {
                  expectedRecordRevision: { path: '/records/0/revision' },
                  values: { path: '/records/0/data' },
                },
              },
            },
          },
          { id: 'save-label', component: 'Text', text: 'Save local note' },
          {
            id: 'refresh',
            component: 'Button',
            child: 'refresh-label',
            action: { event: { name: 'refresh' } },
          },
          { id: 'refresh-label', component: 'Text', text: 'Refresh local note' },
        ]),
        source: {
          kind: 'kernel-records',
          appId,
          collectionId: collection.id,
          schemaRevision: app.schemaRevision,
          query: { page: 1, perPage: 1, filter: `id = '${recordId}'`, fields: 'note' },
        },
        actions: [
          {
            name: 'save',
            componentId: 'save',
            kind: 'kernel-record-update',
            recordId,
            writableFieldIds: [collection.fields[0]!.id],
          },
          { name: 'refresh', componentId: 'refresh', kind: 'refresh' },
        ],
      }
    );
    const text = 'External source observation: 3 matches.';
    const source = store.createItem({
      id: 'it_00000000-0000-7000-8000-000000000059',
      workspaceId,
      threadId,
      turnId: turn.id,
      type: 'tool-call',
      status: 'completed',
      tool: 'selected-source-query',
      server: 'local-test',
      arguments: {},
      result: text,
      error: null,
      durationMs: 1,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await ui.publishGenerativePresentation(
      { ...context, requestId: randomUUID() },
      {
        threadId,
        turnId: turn.id,
        title: 'Independent observation',
        fallbackText: text,
        messages: messages('independent-observation', [
          { id: 'root', component: 'Text', text: { path: '/text' } },
        ]),
        source: {
          kind: 'item',
          itemId: source.id,
          contentDigest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        },
        actions: [],
      }
    );
  } finally {
    workspaceDb.sqlite.close();
  }

  stack = await startIsolatedWebStack({ mode: 'local', dataRoot: fixtureRoot, useSimulator: true });
  const coreUrl = stack.coreUrl;
  const operation = async (name: string, input: unknown) => {
    const response = await fetch(`${coreUrl}/api/app/operations/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
      body: JSON.stringify(input),
    });
    expect(response.ok).toBe(true);
    return response.json();
  };
  await page.goto(`${stack.webUrl}/chat/${workspaceId}/${threadId}`);
  const note = page.getByRole('textbox', { name: 'Local note', exact: true });
  await expect(note).toHaveValue('Original local note');
  await note.fill('Browser committed note');
  await page.getByRole('button', { name: 'Save local note', exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await operation('kernel.records.get', {
            workspaceId,
            appId,
            collection: 'notes',
            recordId,
            schemaRevision: 1,
          })
        ).data.note
    )
    .toBe('Browser committed note');
  await note.fill('Keep this unsaved draft');
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/app/operations/generative-ui.refresh') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Refresh local note', exact: true }).click();
  await refreshed;
  await expect(page.getByText(/^Current/)).toBeVisible();
  await expect(note).toHaveValue('Keep this unsaved draft');

  // A distinct owner write makes the displayed compare-and-set revision stale.
  await operation('kernel.records.update', {
    workspaceId,
    appId,
    collection: 'notes',
    recordId,
    schemaRevision: 1,
    expectedRecordRevision: 2,
    data: { note: 'Concurrent owner note' },
  });
  await page.getByRole('button', { name: 'Save local note', exact: true }).click();
  await expect(page.getByText('Record revision is stale.', { exact: true })).toBeVisible();
  await expect(note).toHaveValue('Keep this unsaved draft');
  expect(
    (
      await operation('kernel.records.get', {
        workspaceId,
        appId,
        collection: 'notes',
        recordId,
        schemaRevision: 1,
      })
    ).data.note
  ).toBe('Concurrent owner note');
  await expect(
    page.getByText('Source history · selected-source-query', { exact: true })
  ).toBeVisible();
  await expect(
    page
      .getByText('External source observation: 3 matches.', { exact: true })
      .filter({ visible: true })
  ).toHaveCount(1);

  await stack.restartCore();
  await page.reload();
  await expect(note).toHaveValue('Original local note');
  await page.getByRole('button', { name: 'Refresh local note', exact: true }).click();
  await expect(note).toHaveValue('Concurrent owner note');
  expect(
    (
      await operation('kernel.records.get', {
        workspaceId,
        appId,
        collection: 'notes',
        recordId,
        schemaRevision: 1,
      })
    ).revision
  ).toBe(3);
});
