import { createHash } from 'node:crypto';
import {
  CandidateSetRecordSchema,
  JudgementRecordSchema,
  SubmitConversationResponseSchema,
} from '@openkit/app-api-schemas';
import { createCoreClient, createRequestId } from '@openkit/core-client';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

/** Real UI comparison keeps an older selected version in the ordinary explicit Send command. */
test('compares two retained versions and sends the selected older candidate explicitly', async ({
  page,
}) => {
  test.setTimeout(120_000);
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
    const navigationBar = page.getByRole('navigation', { name: 'Primary workspace navigation' });
    await expect(
      navigationBar.getByRole('button', { name: workspace.name, exact: true })
    ).toBeVisible();
    await navigationBar.getByRole('button', { name: 'New Task', exact: true }).click();
    const newTask = page.getByRole('dialog', { name: 'New Task' });
    await newTask.getByRole('textbox', { name: 'Brief' }).fill('Candidate handoff');
    const started = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/app/operations/conversation.submit' &&
        response.request().method() === 'POST'
    );
    await newTask.getByRole('button', { name: 'Start Task', exact: true }).click();
    const startedResponse = await started;
    const startedText = await startedResponse.text();
    const handoff = SubmitConversationResponseSchema.parse(JSON.parse(startedText));
    expect(startedResponse.status(), `${handoff.outcome}: ${handoff.explanation}`).toBe(202);
    expect(handoff.receivingWorkspaceId).toBe(workspace.id);
    await expect
      .poll(
        async () => {
          const listed = await client.operations['conversation.navigation']({
            workspaceId: workspace.id,
          });
          const row = listed.items.find((item) => item.thread.id === handoff.receivingThreadId);
          return row?.thread.owner.kind === 'workspace' &&
            row.thread.owner.workspaceId === workspace.id
            ? row.activity
            : 'unbound';
        },
        { timeout: 15_000 }
      )
      .toBe('task');
    await page.goto(
      `${stack.webUrl}/artifacts?workspaceId=${workspace.id}&artifact=${imported.artifactId}`
    );
    const history = page.getByRole('region', { name: 'Artifact version history' });
    await expect(history.getByText('Current head: version 2')).toBeVisible();
    await history.getByRole('button', { name: 'Add exact version to comparison' }).click();
    await history.getByRole('button', { name: 'View version 1', exact: true }).click();
    await history.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(history.getByText(contentDigest, { exact: true })).toBeVisible();
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
    expect(judgement.actor.kind).toBe('user');
    await expect(assessment.getByText('Keep this original.', { exact: true })).toBeVisible();
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
    const selection = record.judgements.filter((entry) => entry.kind === 'select').at(-1);
    expect(selection?.choice).toEqual({
      artifactId: imported.artifactId,
      artifactVersion: 1,
      contentDigest,
    });
    await comparison.getByRole('button', { name: /Next conversation/ }).click();
    await page.getByRole('option', { name: 'Candidate handoff', exact: true }).click();
    const submitsBeforeUse = submissions.length;
    await comparison
      .getByRole('button', { name: 'Use selected in next Turn', exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/tasks/${workspace.id}/${handoff.receivingThreadId}$`)
    );
    await expect(page.getByRole('button', { name: 'Remove Comparison report' })).toBeVisible();
    expect(submissions).toHaveLength(submitsBeforeUse);
    await page
      .getByRole('textbox', { name: 'Message' })
      .fill('Continue from the selected exact version.');
    const sending = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/app/operations/conversation.submit'
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const sent = await sending;
    expect(sent.status()).toBe(202);
    const payload = sent.request().postDataJSON();
    expect(payload.artifactRefs).toEqual([{ artifactId: imported.artifactId, artifactVersion: 1 }]);
    const catalog = await client.operations['conversation.targets']({
      workspaceId: workspace.id,
      threadId: handoff.receivingThreadId,
    });
    const admitted = catalog.targets.find((target) => target.targetRef === payload.targetRef);
    expect(admitted?.availability).toBe('available');
    expect(['new-task-worker', 'warm-worker', 'running-worker']).toContain(admitted?.kind);
    expect(runtimeErrors).toEqual([]);
  } finally {
    await stack.stop();
  }
});
