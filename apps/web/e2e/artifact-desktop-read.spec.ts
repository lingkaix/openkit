import { createHash } from 'node:crypto';
import { CandidateSetRecordSchema, JudgementRecordSchema } from '@openkit/app-api-schemas';
import { createCoreClient, createRequestId } from '@openkit/core-client';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

/**
 * Desktop read and Use surfaces for an owner-imported Artifact.
 * The explicit version-1 Send and its HTTP 202 stay in artifact-candidate-sets.spec.ts.
 */
test('reads retained desktop Artifact versions and uses one without submitting', async ({
  page,
}) => {
  test.setTimeout(120_000);
  expect(page.viewportSize()?.width).toBeGreaterThanOrEqual(800);
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
      name: 'Artifact publication',
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
    const revised = '# Newer candidate head\n';
    await client.operations['artifact.version-commit']({
      workspaceId: workspace.id,
      artifactId: imported.artifactId,
      threadId: thread.id,
      expectedArtifactVersion: 1,
      title: 'Comparison report',
      summary: null,
      content: { format: 'markdown', body: revised },
      requestId: createRequestId(),
    });
    const ledger = 'Ledger line\n';
    const ledgerBytes = new Blob([ledger]);
    await client.artifactFiles.import(
      {
        workspaceId: workspace.id,
        requestId: createRequestId(),
        title: 'Ledger note',
        mediaType: 'text/plain',
        byteLength: ledgerBytes.size,
        contentDigest: `sha256:${createHash('sha256').update(ledger).digest('hex')}`,
      },
      ledgerBytes
    );
    const handoffThread = await client.operations['thread.create']({
      workspaceId: workspace.id,
      name: 'Candidate handoff',
      visibility: 'workspace',
    });
    const setupCatalog = await client.operations['conversation.targets']({
      workspaceId: workspace.id,
      threadId: handoffThread.id,
    });
    const worker = setupCatalog.targets.find(
      (target) => target.kind === 'new-task-worker' && target.availability === 'available'
    );
    expect(worker, 'The isolated stack must offer an available Worker target.').toBeTruthy();
    const handoff = await client.operations['conversation.submit']({
      workspaceId: workspace.id,
      threadId: handoffThread.id,
      input: 'Candidate handoff',
      targetRef: worker!.targetRef,
      ...(worker!.defaultLogicalModelId ? { logicalModelId: worker!.defaultLogicalModelId } : {}),
      artifactRefs: [],
      requestId: createRequestId(),
    });
    expect(handoff.outcome).not.toBe('refused');
    expect(handoff.receivingWorkspaceId).toBe(workspace.id);
    await expect
      .poll(
        async () => {
          const listed = await client.operations['conversation.navigation']({
            workspaceId: workspace.id,
          });
          const row = listed.items.find((item) => item.thread.id === handoff.receivingThreadId);
          return row?.activity ?? 'missing';
        },
        { timeout: 15_000 }
      )
      .toBe('task');

    await page.goto(`${stack.webUrl}/artifacts?workspaceId=${workspace.id}`);
    await expect(
      page.getByRole('navigation', { name: 'Primary workspace navigation' })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Comparison report/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Ledger note/ })).toBeVisible();
    await expect(page.getByText('File · v2', { exact: true })).toBeVisible();
    await expect(page.getByText('File · v1', { exact: true })).toBeVisible();
    await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /next page|load more/i })).toHaveCount(0);
    const filter = page.getByRole('textbox', { name: 'Filter', exact: true });
    await filter.fill('Ledger');
    await expect(page.getByRole('button', { name: /Ledger note/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Comparison report/ })).toHaveCount(0);
    await filter.fill('');
    await page.getByRole('button', { name: /Comparison report/ }).click();

    const history = page.getByRole('region', { name: 'Artifact version history' });
    await expect(history.getByText('Current head: version 2')).toBeVisible();
    await expect(history.getByText(revised, { exact: true })).toBeVisible();
    await expect(history.getByText(contentDigest, { exact: true })).toHaveCount(0);
    await history.getByRole('button', { name: 'View version 1', exact: true }).click();
    await expect(history.getByText('Viewing version 1', { exact: true })).toBeVisible();
    await expect(history.getByText('Historical version', { exact: true })).toBeVisible();
    await expect(history.getByText(revised, { exact: true })).toHaveCount(0);
    await expect(history.getByText('No parent', { exact: true })).toBeVisible();
    await expect(history.getByText('No producing conversation', { exact: true })).toBeVisible();
    await expect(history.getByText('No producing Turn', { exact: true })).toBeVisible();
    await expect(history.getByText('Imported file', { exact: true })).toBeVisible();
    await expect(
      history.getByText(`${bytes.size.toLocaleString()} bytes`, { exact: true })
    ).toBeVisible();
    await expect(history.getByText('text/markdown', { exact: true })).toHaveCount(0);
    await expect(history.getByText(imported.artifactId, { exact: true })).toHaveCount(0);
    await history.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(history.getByText('text/markdown', { exact: true })).toBeVisible();
    await expect(history.getByText(contentDigest, { exact: true })).toBeVisible();
    await expect(history.getByText(imported.artifactId, { exact: true })).toBeVisible();
    const downloadHref = await history
      .getByRole('link', { name: 'Download original' })
      .getAttribute('href');
    if (!downloadHref) throw new Error('The selected version download is unavailable.');
    const downloadUrl = new URL(downloadHref, stack.webUrl);
    expect(downloadUrl.searchParams.get('artifactVersion')).toBe('1');
    const download = await page.request.get(downloadUrl.href);
    expect(download.status()).toBe(200);
    expect(download.headers()['x-openkit-content-digest']).toBe(contentDigest);
    await history.getByRole('button', { name: 'View version 2', exact: true }).click();
    await expect(history.getByText('Version 1', { exact: true })).toBeVisible();
    await expect(history.getByText(revised, { exact: true })).toBeVisible();

    await history.getByRole('button', { name: 'Add exact version to comparison' }).click();
    await history.getByRole('button', { name: 'View version 1', exact: true }).click();
    const assessment = history.getByRole('region', { name: 'Artifact version assessments' });
    await assessment.getByRole('button', { name: 'Assess exact version' }).click();
    await assessment.getByRole('textbox', { name: 'Assessment note' }).fill('Keep this original.');
    const assessing = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/app/operations/evaluation.judgement-add'
    );
    await assessment.getByRole('button', { name: 'Record accept assessment' }).click();
    const assessed = await assessing;
    expect(assessed.status()).toBe(201);
    const judgement = JudgementRecordSchema.parse((await assessed.json()).judgement);
    expect(judgement.target).toEqual({
      kind: 'artifact-version',
      artifactId: imported.artifactId,
      artifactVersion: 1,
      contentDigest,
    });
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
    expect((await choosing).status()).toBe(200);
    await comparison.getByRole('button', { name: /Next conversation/ }).click();
    const receivingOption = page.locator(
      `[role="option"][data-key="${handoff.receivingThreadId}"]`
    );
    await expect(receivingOption).toHaveCount(1);
    await expect(receivingOption).toHaveAccessibleName('Candidate handoff');
    await receivingOption.click();
    const submitsBeforeUse = submissions.length;
    await comparison
      .getByRole('button', { name: 'Use selected in next Turn', exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/tasks/${workspace.id}/${handoff.receivingThreadId}$`)
    );
    await expect(page.getByRole('button', { name: 'Remove Comparison report' })).toBeVisible();
    expect(submissions).toHaveLength(submitsBeforeUse);
    // artifact-candidate-sets.spec.ts owns the explicit Send, artifactRefs version 1, and HTTP 202.
    expect(runtimeErrors).toEqual([]);
    expect(page.viewportSize()?.width).toBeGreaterThanOrEqual(800);
  } finally {
    await stack.stop();
  }
});
