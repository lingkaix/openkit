import { createHash } from 'node:crypto';
import { CandidateSetRecordSchema } from '@openkit/app-api-schemas';
import { createCoreClient, createRequestId } from '@openkit/core-client';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

/** Real UI comparison keeps an older selected version in the ordinary explicit Send command. */
test('compares two retained versions and sends the selected older candidate explicitly', async ({
  page,
}) => {
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  const submissions: unknown[] = [];
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/app/operations/conversation.submit')
      submissions.push(request.postDataJSON());
  });
  try {
    const workspace = (await client.operations['workspace.list']({})).items.find(
      ({ workspace }) => workspace.kind === 'code'
    )?.workspace;
    if (!workspace) throw new Error('The isolated stack has no code Workspace.');
    const thread = await client.operations['thread.create']({
      workspaceId: workspace.id,
      name: 'Candidate continuation',
      visibility: 'workspace',
    });
    const original = '# First exact candidate\n';
    const contentDigest = `sha256:${createHash('sha256').update(original).digest('hex')}`;
    const bytes = new Blob([original]);
    const imported = await client.artifactFiles.import(
      {
        workspaceId: workspace.id,
        requestId: createRequestId(),
        title: 'Comparison report',
        mediaType: 'text/markdown',
        byteLength: bytes.size,
        contentDigest,
      },
      bytes
    );
    await client.operations['artifact.version-commit']({
      workspaceId: workspace.id,
      artifactId: imported.artifactId,
      threadId: thread.id,
      expectedArtifactVersion: 1,
      title: 'Comparison report',
      summary: null,
      content: { format: 'markdown', body: '# Newer candidate head\n' },
      requestId: createRequestId(),
    });
    await page.goto(
      `${stack.webUrl}/artifacts?workspaceId=${workspace.id}&artifact=${imported.artifactId}`
    );
    const history = page.getByRole('region', { name: 'Artifact version history' });
    await expect(history.getByText('Current head: version 2')).toBeVisible();
    await history.getByRole('button', { name: 'Add exact version to comparison' }).click();
    await history.getByRole('button', { name: 'View version 1', exact: true }).click();
    await expect(history.getByText(contentDigest, { exact: true })).toBeVisible();
    await history.getByRole('button', { name: 'Add exact version to comparison' }).click();
    const comparison = page.getByRole('region', { name: 'Artifact comparisons' });
    const creating = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/app/operations/evaluation.candidate-set-create'
    );
    await comparison.getByRole('button', { name: 'Create comparison', exact: true }).click();
    const created = await creating;
    expect(created.status()).toBe(201);
    expect(CandidateSetRecordSchema.parse(await created.json()).candidates).toHaveLength(2);
    await comparison.getByRole('button', { name: /Candidate choice/ }).click();
    await page.getByRole('option', { name: /Comparison report · version 1/ }).click();
    await comparison
      .getByRole('textbox', { name: 'Choice note' })
      .fill('Continue the first exact result.');
    const choosing = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/app/operations/evaluation.candidate-set-select'
    );
    await comparison.getByRole('button', { name: 'Record choice', exact: true }).click();
    const chosen = await choosing;
    expect(chosen.status()).toBe(200);
    const record = CandidateSetRecordSchema.parse(await chosen.json());
    const judgement = record.judgements.filter((entry) => entry.kind === 'select').at(-1);
    expect(judgement?.choice).toEqual({
      artifactId: imported.artifactId,
      artifactVersion: 1,
      contentDigest,
    });
    await comparison.getByRole('button', { name: /Next conversation/ }).click();
    await page.getByRole('option', { name: 'Candidate continuation', exact: true }).click();
    await comparison
      .getByRole('button', { name: 'Use selected in next Turn', exact: true })
      .click();
    await expect(page.getByRole('button', { name: 'Remove Comparison report' })).toBeVisible();
    expect(submissions).toEqual([]);
    await page
      .getByRole('textbox', { name: 'Message' })
      .fill('Continue from the selected exact version.');
    await page.getByRole('button', { name: /Conversation agent$/ }).click();
    await page.getByRole('option', { name: 'New Shard + Worker', exact: true }).click();
    const sending = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/app/operations/conversation.submit'
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const sent = await sending;
    expect(sent.status()).toBe(202);
    expect(sent.request().postDataJSON().artifactRefs).toEqual([
      { artifactId: imported.artifactId, artifactVersion: 1 },
    ]);
    expect(runtimeErrors).toEqual([]);
  } finally {
    await stack.stop();
  }
});
