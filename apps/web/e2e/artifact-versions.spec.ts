import { createHash } from 'node:crypto';
import { createCoreClient } from '@openkit/core-client';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

/** Real browser publication retains the first original and exact parent lineage after a new head. */
test('creates a second Artifact version and inspects and downloads the first original', async ({
  page,
}) => {
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  try {
    const workspace = (await client.operations['workspace.list']({})).items.find(
      ({ workspace }) => workspace.kind === 'code'
    )?.workspace;
    if (!workspace) throw new Error('The isolated stack has no code Workspace.');
    const thread = await client.operations['thread.create']({
      workspaceId: workspace.id,
      name: 'Artifact publication',
      visibility: 'workspace',
    });
    await page.goto(`${stack.webUrl}/artifacts?workspaceId=${workspace.id}`);
    const firstContent = '# Exact original\n\nKeep the first version.\n';
    const firstDigest = `sha256:${createHash('sha256').update(firstContent).digest('hex')}`;
    await page.getByRole('button', { name: 'Import artifact', exact: true }).click();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Versioned report');
    await page.getByRole('textbox', { name: 'Media type', exact: true }).fill('text/markdown');
    await page.getByRole('textbox', { name: 'Content', exact: true }).fill(firstContent);
    const importing = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/app/operations/artifact.import'
    );
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const imported = await importing;
    expect(imported.status()).toBe(201);
    const { artifactId } = await imported.json();
    await page.getByRole('button', { name: /Versioned report/ }).click();
    const history = page.getByRole('region', { name: 'Artifact version history' });
    await expect(history.getByText('Current head: version 1')).toBeVisible();
    await expect(history.getByText(firstDigest, { exact: true })).toBeVisible();
    await history.getByRole('button', { name: 'Create next version', exact: true }).click();
    const draft = page.getByRole('region', { name: 'Create next Artifact version' });
    await draft.getByRole('button', { name: /Publishing conversation/ }).click();
    await page.getByRole('option', { name: 'Artifact publication', exact: true }).click();
    const secondContent = '# Explicit revised version\n\nThe first version remains unchanged.\n';
    await draft.getByRole('textbox', { name: 'Version content', exact: true }).fill(secondContent);
    const committing = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/app/operations/artifact.version-commit'
    );
    await draft.getByRole('button', { name: 'Save new version', exact: true }).click();
    const committed = await committing;
    expect(committed.status()).toBe(201);
    const result = await committed.json();
    expect(result.artifact.id).toBe(artifactId);
    expect(result.artifact.version).toBe(2);
    expect(result.version.parentVersion).toBe(1);
    expect(result.version.threadId).toBe(thread.id);
    await expect(history.getByText('Current head: version 2')).toBeVisible();
    await history.getByRole('button', { name: 'View version 2', exact: true }).click();
    await expect(history.getByText(secondContent, { exact: true })).toBeVisible();
    await expect(history.getByText('Version 1', { exact: true })).toBeVisible();
    await expect(history.getByText(result.version.turnId, { exact: true })).toBeVisible();
    await history.getByRole('button', { name: 'View version 1', exact: true }).click();
    await expect(history.getByText('Viewing version 1', { exact: true })).toBeVisible();
    await expect(history.getByText(firstDigest, { exact: true })).toBeVisible();
    await expect(history.getByText('No parent', { exact: true })).toBeVisible();
    await expect(history.getByText(secondContent, { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Add to conversation', exact: true })
    ).toBeDisabled();
    const downloadUrl = await history
      .getByRole('link', { name: 'Download original' })
      .getAttribute('href');
    if (!downloadUrl) throw new Error('The exact original download is unavailable.');
    expect(new URL(downloadUrl, stack.webUrl).searchParams.get('artifactVersion')).toBe('1');
    const download = await page.request.get(new URL(downloadUrl, stack.webUrl).href);
    expect(download.status()).toBe(200);
    expect(download.headers()['x-openkit-content-digest']).toBe(firstDigest);
    expect(await download.body()).toEqual(Buffer.from(firstContent));
    await expect(history.getByText('Current head: version 2')).toBeVisible();
    expect(runtimeErrors).toEqual([]);
  } finally {
    await stack.stop();
  }
});
