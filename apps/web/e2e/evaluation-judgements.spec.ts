import { createHash } from 'node:crypto';
import { JudgementRecordSchema } from '@openkit/app-api-schemas';
import { createCoreClient, createRequestId } from '@openkit/core-client';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

/** A visible correction must retain its exact original and truthful resulting revision. */
test('applies an exact Material range and retains the original judgement after reload', async ({
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
      name: 'Exact correction',
      visibility: 'workspace',
    });
    const title = 'Correction original';
    const { materialId } = await client.operations['material.create']({
      workspaceId: workspace.id,
      requestId: createRequestId(),
      title,
      kind: 'text',
      sensitivity: 'internal',
    });
    const original = 'A😀B\n';
    const contentDigest = `sha256:${createHash('sha256').update(original).digest('hex')}`;
    const { revisionId } = await client.operations['material.revision-save']({
      workspaceId: workspace.id,
      materialId,
      requestId: createRequestId(),
      expectedRevisionId: null,
      content: original,
      contentDigest,
    });
    await page.goto(`${stack.webUrl}/materials/${workspace.id}/${thread.id}/${materialId}`);
    await expect(page.getByRole('textbox', { name: title, exact: true })).toHaveValue(original);
    const panel = page.getByRole('region', { name: 'Material revision judgements' });
    await panel.getByRole('button', { name: 'Assess selected revision' }).click();
    await panel.getByRole('textbox', { name: 'Range start' }).fill('1');
    await panel.getByRole('textbox', { name: 'Range end' }).fill('3');
    await panel.getByRole('button', { name: 'Use feedback range', exact: true }).click();
    await panel.getByRole('textbox', { name: 'Replacement text' }).fill('C');
    await panel
      .getByRole('textbox', { name: 'Correction note' })
      .fill('Replace this exact symbol.');
    const applying = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/app/operations/material.range-correct'
    );
    await panel.getByRole('button', { name: 'Apply range correction', exact: true }).click();
    const applied = await applying;
    expect(applied.status()).toBe(201);
    const judgement = JudgementRecordSchema.parse((await applied.json()).judgement);
    expect(judgement.target).toEqual({
      kind: 'material-range',
      materialId,
      revisionId,
      contentDigest,
      offsetUnit: 'utf-16',
      start: 1,
      end: 3,
      originalText: '😀',
    });
    if (judgement.kind !== 'correct' || judgement.choice.outcome !== 'apply')
      throw new Error('The correction did not return its applied revision.');
    const result = judgement.choice.resultingRevision;
    expect(result.contentDigest).toBe(
      `sha256:${createHash('sha256').update('ACB\n').digest('hex')}`
    );
    await expect(panel.getByText('Applied correction', { exact: true })).toBeVisible();
    await expect(panel.getByText(result.revisionId, { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: title, exact: true })).toHaveValue('ACB\n');
    await page.reload();
    await expect(page.getByRole('textbox', { name: title, exact: true })).toHaveValue('ACB\n');
    const retained = await client.operations['material.revision-read']({
      workspaceId: workspace.id,
      materialId,
      revisionId,
    });
    expect(retained.revision.content).toBe(original);
    expect(retained.revision.judgements).toEqual([judgement]);
    const current = await client.operations['material.read']({
      workspaceId: workspace.id,
      materialId,
    });
    expect(current.material.currentRevisionId).toBe(result.revisionId);
    expect(runtimeErrors).toEqual([]);
  } finally {
    await stack.stop();
  }
});
