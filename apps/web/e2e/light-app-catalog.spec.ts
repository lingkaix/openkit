import {
  GetLightAppResponseSchema,
  LIGHT_APP_DEFINITION_OPERATION_DEFINITIONS,
  LightAppSchemaInputSchema,
  OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import { createCoreClient, createRequestId } from '@openkit/core-client';
import { expect, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;

test.afterEach(async () => {
  const current = stack;
  stack = null;
  await current?.stop();
});

/** Browser commands use real native admission, and snapshot restore recovers the original business value. */
test('imports a definition, creates and activates a Light App, then restores its automatic snapshot', async ({
  page,
}) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  await page.goto(`${stack.webUrl}/settings/workspaces/new`);
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Light App recovery');
  const creation = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/workspace.create' &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  const created = await creation;
  expect(created.ok()).toBe(true);
  const { id: workspaceId } = OPERATION_DEFINITIONS['workspace.create'].outputSchema.parse(
    await created.json()
  );
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  const definition = LightAppSchemaInputSchema.parse({
    format: 'openkit.light-app',
    schemaVersion: 1,
    title: 'Recovery notes',
    purpose: 'Keep local annotations.',
    collections: [
      {
        name: 'notes',
        type: 'base',
        description: 'Local notes.',
        indexes: [],
        fields: [
          { name: 'note', type: 'text', required: true, description: 'The local annotation.' },
        ],
      },
    ],
  });
  await page.goto(`${stack.webUrl}/catalog`);
  await page
    .getByRole('textbox', { name: 'Light App catalog ID', exact: true })
    .fill('recovery-notes');
  await page
    .getByRole('textbox', { name: 'Light App display name', exact: true })
    .fill('Recovery notes');
  await page.getByLabel('Definition JSON file', { exact: true }).setInputFiles({
    name: 'notes.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(definition)),
  });
  const importing = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/catalog.light-app-import'
  );
  await page.getByRole('button', { name: 'Import definition', exact: true }).click();
  const importedResponse = await importing;
  expect(importedResponse.ok()).toBe(true);
  const imported = LIGHT_APP_DEFINITION_OPERATION_DEFINITIONS[
    'catalog.light-app-import'
  ].outputSchema.parse(await importedResponse.json());
  await page
    .getByRole('button', { name: 'Inspect definition Recovery notes', exact: true })
    .click();
  await page
    .getByRole('button', { name: `Choose version ${imported.version.digest}`, exact: true })
    .click();
  await page.getByRole('button', { name: 'Use as default', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use as default', exact: true })).toBeDisabled();
  const instantiating = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/app/operations/kernel.apps.instantiate'
  );
  await page.getByRole('button', { name: 'Create Light App', exact: true }).click();
  const appResponse = await instantiating;
  expect(appResponse.ok()).toBe(true);
  const initial = GetLightAppResponseSchema.parse(await appResponse.json());
  const record = await client.operations['kernel.records.create']({
    workspaceId,
    appId: initial.appId,
    collection: 'notes',
    schemaRevision: initial.schemaRevision,
    data: { note: 'Retained before migration' },
    requestId: createRequestId(),
  });

  // Reuse admitted stable IDs from the retained template instead of inventing replacements for a revision.
  const revised = LightAppSchemaInputSchema.parse(JSON.parse(imported.version.definitionJson));
  revised.collections[0]!.fields.push({
    name: 'annotation',
    type: 'text',
    required: false,
    description: 'Optional extra context.',
  });
  await page
    .getByRole('textbox', { name: 'Light App catalog ID', exact: true })
    .fill('recovery-notes');
  await page
    .getByRole('textbox', { name: 'Light App display name', exact: true })
    .fill('Recovery notes');
  await page.getByLabel('Definition JSON file', { exact: true }).setInputFiles({
    name: 'revised-notes.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(revised)),
  });
  const revising = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/catalog.light-app-import'
  );
  await page.getByRole('button', { name: 'Import definition', exact: true }).click();
  const revisionResponse = await revising;
  expect(revisionResponse.ok()).toBe(true);
  const revision = LIGHT_APP_DEFINITION_OPERATION_DEFINITIONS[
    'catalog.light-app-import'
  ].outputSchema.parse(await revisionResponse.json());
  await page
    .getByRole('button', { name: `Choose version ${revision.version.digest}`, exact: true })
    .click();
  await page.getByRole('button', { name: 'Inspect app Recovery notes', exact: true }).click();
  const activating = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/app/operations/kernel.schema.activate'
  );
  await page.getByRole('button', { name: 'Apply definition to this app', exact: true }).click();
  const activationResponse = await activating;
  expect(activationResponse.ok()).toBe(true);
  const active = GetLightAppResponseSchema.parse(await activationResponse.json());
  await client.operations['kernel.records.update']({
    workspaceId,
    appId: active.appId,
    collection: 'notes',
    recordId: record.id,
    schemaRevision: active.schemaRevision,
    expectedRecordRevision: record.revision,
    data: { note: 'Later data to discard' },
    requestId: createRequestId(),
  });
  const snapshots = await client.operations['kernel.snapshots.list']({
    workspaceId,
    appId: active.appId,
  });
  expect(snapshots.snapshots).toHaveLength(1);
  const snapshot = snapshots.snapshots[0]!;
  await page.getByRole('button', { name: 'Refresh selected app', exact: true }).click();
  await page
    .getByRole('button', { name: `Restore snapshot ${snapshot.snapshotId}`, exact: true })
    .click();
  await expect(
    page.getByText(/All data changes after this snapshot will be discarded/)
  ).toBeVisible();
  const restoring = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/kernel.snapshots.rollback'
  );
  await page
    .getByRole('button', { name: 'Confirm restore and discard later data', exact: true })
    .click();
  const restoreResponse = await restoring;
  expect(restoreResponse.ok()).toBe(true);
  const restored = GetLightAppResponseSchema.parse(await restoreResponse.json());
  expect(restored.definitionVersion).toBe(initial.definitionVersion);
  expect(restored.appRevision).toBeGreaterThan(active.appRevision);
  const value = await client.operations['kernel.records.get']({
    workspaceId,
    appId: restored.appId,
    collection: 'notes',
    recordId: record.id,
    schemaRevision: restored.schemaRevision,
  });
  expect(value.data.note).toBe('Retained before migration');
  await expect(
    page.getByRole('button', { name: 'Confirm restore and discard later data', exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByText(
      new RegExp(
        `App revision ${restored.appRevision} · Schema revision ${restored.schemaRevision}`
      )
    )
  ).toBeVisible();
});
