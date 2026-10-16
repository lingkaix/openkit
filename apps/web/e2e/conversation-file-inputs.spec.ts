import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ListAuthorizedWorkspacesResponseSchema,
  SubmitConversationResponseSchema,
} from '@openkit/app-api-schemas';
import { expect, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;
test.afterEach(async () => {
  const current = stack;
  stack = null;
  await current?.stop();
});

/** Exercises the browser selection and actual public carriage, not a mocked attachment upload. */
test('keeps files as local drafts and publishes exact originals only on the receiving Turn', async ({
  page,
}) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const runtimeErrors: string[] = [];
  const artifactImports: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/app/operations/artifact.import')
      artifactImports.push(request.method());
  });
  const workspaces = await fetch(`${stack.coreUrl}/api/app/operations/workspace.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(workspaces.status).toBe(200);
  const workspaceId = ListAuthorizedWorkspacesResponseSchema.parse(
    await workspaces.json()
  ).items.find(({ workspace }) => workspace.kind === 'code')?.workspace.id;
  expect(workspaceId).toBeTruthy();
  const artifactInventory = async () => {
    const response = await fetch(`${stack!.coreUrl}/api/app/operations/artifact.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  const before = await artifactInventory();
  await page.goto(`${stack.webUrl}/chat`);
  const originals = [
    {
      name: 'exact-original.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([0, 0xff, 0x80, 13, 10]),
    },
    { name: 'empty-original.data', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) },
  ];
  await page.getByRole('button', { name: 'Add artifact or upload attachment' }).click();
  await page.locator('input[type="file"]').setInputFiles(originals);
  for (const file of originals)
    await expect(page.getByRole('button', { name: `Remove file ${file.name}` })).toBeVisible();
  expect(artifactImports).toEqual([]);
  expect(await artifactInventory()).toEqual(before);

  await page
    .getByRole('textbox', { name: 'Message' })
    .fill('Inspect the attached exact originals.');
  await page.getByRole('button', { name: /Conversation agent$/ }).click();
  await page.getByRole('option', { name: 'New Shard + Worker' }).click();
  const accepted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/conversation.submit' &&
      response.request().headers()['content-type'] === 'application/vnd.openkit.conversation-files'
  );
  await page.getByRole('button', { name: /^Send message$/ }).click();
  const disclosure = page.getByRole('dialog', { name: 'Share selected files with Worker' });
  await expect(disclosure.getByLabel('Work brief')).toHaveText(
    'Inspect the attached exact originals.'
  );
  for (const file of originals)
    await expect(disclosure.getByText(file.name, { exact: true })).toBeVisible();
  expect(await artifactInventory()).toEqual(before);
  await disclosure.getByRole('button', { name: 'Share files and send' }).click();
  const response = await accepted;
  expect(response.status(), await response.text()).toBe(202);
  const result = SubmitConversationResponseSchema.parse(await response.json());
  expect(result.turn.fileInputs).toEqual(
    originals.map((file) => ({
      name: file.name,
      mediaType: file.mimeType,
      sizeBytes: file.buffer.length,
      contentDigest: `sha256:${createHash('sha256').update(file.buffer).digest('hex')}`,
    }))
  );
  for (const [ordinal, file] of originals.entries()) {
    const payload = await readFile(
      join(
        stack.dataRoot,
        'workspaces',
        result.turn.workspaceId,
        'threads',
        result.turn.threadId,
        'turns',
        result.turn.id,
        'inputs',
        String(ordinal),
        'payload'
      )
    );
    expect(payload).toEqual(file.buffer);
  }
  expect(artifactImports).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});
