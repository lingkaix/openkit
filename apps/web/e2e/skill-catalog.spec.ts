import { readFile } from 'node:fs/promises';
import { createCoreClient, createRequestId } from '@openkit/core-client';
import { expect, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;

test.afterEach(async () => {
  const current = stack;
  stack = null;
  if (current) await current.stop();
});

/** Retained inspection preserves exact bytes and leaves selection to an explicit catalog command. */
test('inspects retained Skill bytes and explicitly selects a different version', async ({
  page,
}) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  await page.goto(`${stack.webUrl}/settings/workspaces/new`);
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Skill inspection');
  const creation = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/workspace.create' &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  const created = await creation;
  expect(created.ok(), `Workspace creation returned HTTP ${created.status()}.`).toBe(true);
  const { id: workspaceId } = (await created.json()) as { id: string };
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();

  const client = createCoreClient({ baseUrl: stack.coreUrl });
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
  const firstText =
    '---\nname: browser-inspection\ndescription: Inspect retained Skill bytes.\n---\nFirst retained instructions.\n';
  const secondText = firstText.replace('First retained', 'Second retained');
  const first = await client.operations['catalog.skill-import']({
    workspaceId,
    activate: true,
    displayName: 'Browser inspection',
    expectedRevision: (await client.operations['catalog.read']({ workspaceId })).revision,
    requestId: createRequestId(),
    tree: [
      { kind: 'file', path: 'SKILL.md', contentBase64: Buffer.from(firstText).toString('base64') },
      { kind: 'file', path: 'payload.bin', contentBase64: binary.toString('base64') },
    ],
  });
  const second = await client.operations['catalog.skill-import']({
    workspaceId,
    id: first.entry.id,
    activate: false,
    displayName: 'Browser inspection',
    expectedRevision: first.revision,
    requestId: createRequestId(),
    tree: [
      { kind: 'file', path: 'SKILL.md', contentBase64: Buffer.from(secondText).toString('base64') },
      { kind: 'file', path: 'payload.bin', contentBase64: binary.toString('base64') },
    ],
  });
  expect(second.version.digest).not.toBe(first.version.digest);
  expect(second.entry.currentDigest).toBe(first.version.digest);

  await page.goto(`${stack.webUrl}/catalog`);
  await expect(page.getByRole('heading', { name: 'Catalog', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect Skill history', exact: true }).click();
  await page
    .getByRole('button', { name: `Inspect ${first.version.digest.slice(0, 19)}`, exact: true })
    .click();
  await page.getByRole('button', { name: 'Read SKILL.md', exact: true }).click();
  await expect(page.locator('pre')).toHaveText(firstText);
  await page.getByRole('button', { name: 'Read payload.bin', exact: true }).click();
  await expect(page.getByText(/preview unavailable|preview is unavailable/i)).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download exact file bytes', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('payload.bin');
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect(await readFile(downloadedPath as string)).toEqual(binary);

  await page
    .getByRole('button', {
      name: `Compare with ${second.version.digest.slice(0, 19)}`,
      exact: true,
    })
    .click();
  await expect(page.getByText('Changed: SKILL.md', { exact: true })).toBeVisible();
  expect(
    (await client.operations['catalog.read']({ workspaceId })).skills.find(
      (skill) => skill.id === first.entry.id
    )?.currentDigest
  ).toBe(first.version.digest);

  const selection = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/catalog.skill-select' &&
      response.request().method() === 'POST'
  );
  await page
    .getByRole('button', { name: `Use ${second.version.digest.slice(7, 15)}`, exact: true })
    .click();
  expect((await selection).ok()).toBe(true);
  await expect(
    page.getByRole('button', { name: `Current ${second.version.digest.slice(7, 15)}`, exact: true })
  ).toBeDisabled();
  expect(
    (await client.operations['catalog.read']({ workspaceId })).skills.find(
      (skill) => skill.id === first.entry.id
    )?.currentDigest
  ).toBe(second.version.digest);
});
