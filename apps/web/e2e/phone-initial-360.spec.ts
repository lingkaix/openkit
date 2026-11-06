import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CandidateSetRecordSchema,
  JudgementRecordSchema,
  ListAuthorizedWorkspacesResponseSchema,
  SubmitConversationResponseSchema,
} from '@openkit/app-api-schemas';
import { createCoreClient, createRequestId } from '@openkit/core-client';
import { ThreadSchema, workspaceIdForOwner } from '@openkit/protocol';
import { expect, type Page, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

/**
 * Phone acceptance starts at 360 by 800 before the first navigation.
 * The older phone-shell spec still opens a thread from the desktop sidebar and then shrinks.
 */

test.use({ viewport: { width: 360, height: 800 } });

async function stopStack(stack: IsolatedWebStack | null) {
  if (stack) await stack.stop();
}

async function selectWorkspace(page: Page, workspaceName: string) {
  // `/` replaces itself with Action Center and that navigation closes More.
  await page.waitForURL((url) => url.pathname !== '/');
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await expect(sections.getByRole('button')).toHaveCount(5);
  await sections.getByRole('button', { name: 'More', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'More' });
  await expect(drawer).toBeVisible();
  const selected = drawer.getByRole('button', { name: workspaceName, exact: true });
  const personal = drawer.getByRole('button', { name: 'Personal', exact: true });
  await expect(selected.or(personal)).toBeVisible();
  if ((await selected.count()) === 0) {
    await personal.click();
    await page.getByRole('menuitem', { name: workspaceName, exact: true }).click();
  }
  await expect(selected).toBeVisible();
  await drawer.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await expect(drawer).toBeHidden();
}

async function openNewTask(page: Page) {
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Work', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Personal Assistant', exact: true })).toHaveCount(
    0
  );
  await page.getByRole('button', { name: 'New Task', exact: true }).click();
  return page.getByRole('dialog', { name: 'New Task' });
}

test('opens navigation, Knowledge, Gateway, and the private Assistant at 360', async ({ page }) => {
  test.setTimeout(120_000);
  expect(page.viewportSize()).toEqual({ width: 360, height: 800 });
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const runtimeErrors: string[] = [];
  let threadCreates = 0;
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/app/operations/thread.create') threadCreates += 1;
  });
  try {
    const listed = ListAuthorizedWorkspacesResponseSchema.parse(
      await (
        await fetch(`${stack.coreUrl}/api/app/operations/workspace.list`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).json()
    );
    const personal = listed.items.find((item) => item.workspace.kind === 'personal')?.workspace;
    expect(personal).toBeTruthy();
    await page.goto(stack.webUrl);
    const sections = page.getByRole('navigation', { name: 'Sections' });
    await expect(sections.getByRole('button')).toHaveCount(5);
    await expect(
      page.getByRole('navigation', { name: 'Primary workspace navigation' })
    ).toHaveCount(0);
    await sections.getByRole('button', { name: 'Knowledge', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
    await sections.getByRole('button', { name: 'Work', exact: true }).click();
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New Task', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Goals', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New Goal', exact: true })).toBeVisible();
    await selectWorkspace(page, personal!.name);
    await sections.getByRole('button', { name: 'Assistant', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Action Center', exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Personal Assistant', exact: true })
    ).toBeVisible();
    const opening = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/app/operations/thread.create' &&
        response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Personal Assistant', exact: true }).click();
    const createdResponse = await opening;
    expect(createdResponse.status()).toBe(200);
    const createdRequest = createdResponse.request().postDataJSON();
    expect(createdRequest).toMatchObject({ workspaceId: personal!.id, name: 'Assistant' });
    expect(createdRequest).not.toHaveProperty('visibility');
    expect(createdRequest).not.toHaveProperty('threadId');
    const assistant = ThreadSchema.parse(await createdResponse.json());
    expect(assistant.visibility).toBe('private');
    expect(assistant.owner).toEqual({ kind: 'workspace', workspaceId: personal!.id });
    await expect(page).toHaveURL(new RegExp(`/chat/${personal!.id}/${assistant.id}$`));
    await expect(page.getByRole('heading', { name: 'Assistant', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message' }).fill('Story thread');
    await expect(page.getByRole('button', { name: /Conversation agent$/ })).toHaveCount(0);
    await expect(page.getByText('The Assistant is not available.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    const client = createCoreClient({ baseUrl: stack.coreUrl });
    const targets = await client.operations['conversation.targets']({
      workspaceId: personal!.id,
      threadId: assistant.id,
    });
    const worker = targets.targets.find(
      (target) => target.kind === 'new-task-worker' && target.availability === 'available'
    );
    expect(worker, 'The isolated stack must offer an available Worker target.').toBeTruthy();
    const refused = await client.operations['conversation.submit']({
      workspaceId: personal!.id,
      threadId: assistant.id,
      input: 'Story thread',
      targetRef: worker!.targetRef,
      requestId: createRequestId(),
    });
    expect(refused.outcome).toBe('refused');
    expect(refused.explanation).toBe(
      'Explicit disclosure admission is required before private Assistant input becomes shared Task work.'
    );
    expect(
      (await client.operations['thread.list']({ workspaceId: personal!.id })).items.map(
        (thread) => ({
          id: thread.id,
          visibility: thread.visibility,
        })
      )
    ).toEqual([{ id: assistant.id, visibility: 'private' }]);
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await sections.getByRole('button', { name: 'Assistant', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${personal!.id}/${assistant.id}$`));
    expect(threadCreates).toBe(1);
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await sections.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await sections.getByRole('button', { name: 'More', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Gateway', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Gateway', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/gateway$/);
    const overflow = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.viewportWidth).toBeLessThanOrEqual(360);
    expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);
    expect(page.viewportSize()).toEqual({ width: 360, height: 800 });
    expect(runtimeErrors).toEqual([]);
  } finally {
    await stopStack(stack);
  }
});

test('admits an empty Workspace Task from the phone Work list', async ({ page }) => {
  test.setTimeout(120_000);
  expect(page.viewportSize()).toEqual({ width: 360, height: 800 });
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const submissions: unknown[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/app/operations/conversation.submit')
      submissions.push(request.postDataJSON());
  });
  try {
    const client = createCoreClient({ baseUrl: stack.coreUrl });
    const workspace = (await client.operations['workspace.list']({})).items.find(
      ({ workspace }) => workspace.kind === 'code'
    )?.workspace;
    if (!workspace) throw new Error('The isolated stack has no code Workspace.');
    await page.goto(stack.webUrl);
    await selectWorkspace(page, workspace.name);
    const newTask = await openNewTask(page);
    await newTask.getByRole('textbox', { name: 'Brief' }).fill('Phone empty task');
    const provisionalThread = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/app/operations/thread.create' &&
        response.request().method() === 'POST'
    );
    const started = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/app/operations/conversation.submit' &&
        response.request().method() === 'POST'
    );
    await newTask.getByRole('button', { name: 'Start Task', exact: true }).click();
    const createdResponse = await provisionalThread;
    expect(createdResponse.status()).toBe(200);
    const createdRequest = createdResponse.request().postDataJSON();
    expect(createdRequest).toMatchObject({
      workspaceId: workspace.id,
      name: 'Phone empty task',
      visibility: 'workspace',
    });
    expect(createdRequest).not.toHaveProperty('threadId');
    const createdThread = ThreadSchema.parse(await createdResponse.json());
    expect(createdThread.visibility).toBe('workspace');
    expect(createdThread.owner).toEqual({ kind: 'workspace', workspaceId: workspace.id });
    const startedResponse = await started;
    const startedText = await startedResponse.text();
    const handoff = SubmitConversationResponseSchema.parse(JSON.parse(startedText));
    expect(startedResponse.status(), `${handoff.outcome}: ${handoff.explanation}`).toBe(202);
    expect(handoff.receivingWorkspaceId).toBe(workspace.id);
    expect(handoff.turn.owner).toEqual({ kind: 'workspace', workspaceId: workspace.id });
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
    await expect(page).toHaveURL(
      new RegExp(`/tasks/${workspace.id}/${handoff.receivingThreadId}$`)
    );
    expect(submissions).toHaveLength(1);
    expect(page.viewportSize()).toEqual({ width: 360, height: 800 });
  } finally {
    await stopStack(stack);
  }
});

test('keeps file consent in front of phone Task admission', async ({ page }) => {
  test.setTimeout(120_000);
  expect(page.viewportSize()).toEqual({ width: 360, height: 800 });
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const artifactImports: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/app/operations/artifact.import')
      artifactImports.push(request.method());
  });
  try {
    const workspaces = await fetch(`${stack.coreUrl}/api/app/operations/workspace.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(workspaces.status).toBe(200);
    const workspace = ListAuthorizedWorkspacesResponseSchema.parse(
      await workspaces.json()
    ).items.find(({ workspace }) => workspace.kind === 'code')?.workspace;
    expect(workspace).toBeTruthy();
    const workspaceId = workspace!.id;
    const artifactInventory = async () => {
      const response = await fetch(`${stack.coreUrl}/api/app/operations/artifact.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const before = await artifactInventory();
    const originals = [
      {
        name: 'exact-original.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from([0, 0xff, 0x80, 13, 10]),
      },
      {
        name: 'empty-original.data',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(0),
      },
    ];
    await page.goto(stack.webUrl);
    await selectWorkspace(page, workspace!.name);
    const newTask = await openNewTask(page);
    await newTask
      .getByRole('textbox', { name: 'Brief' })
      .fill('Inspect the attached exact originals.');
    await newTask.getByLabel('Task files').setInputFiles(originals);
    expect(artifactImports).toEqual([]);
    expect(await artifactInventory()).toEqual(before);
    await newTask.getByRole('button', { name: 'Start Task', exact: true }).click();
    const disclosure = page.getByRole('dialog', { name: 'Share selected files with Worker' });
    await expect(disclosure.getByLabel('Work brief')).toHaveText(
      'Inspect the attached exact originals.'
    );
    for (const file of originals)
      await expect(disclosure.getByText(file.name, { exact: true })).toBeVisible();
    expect(await artifactInventory()).toEqual(before);
    expect(artifactImports).toEqual([]);
    const provisionalThread = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/app/operations/thread.create' &&
        response.request().method() === 'POST'
    );
    const accepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/app/operations/conversation.submit' &&
        response.request().headers()['content-type'] ===
          'application/vnd.openkit.conversation-files'
    );
    await disclosure.getByRole('button', { name: 'Share files and send' }).click();
    const createdResponse = await provisionalThread;
    expect(createdResponse.request().postDataJSON()).toMatchObject({
      name: 'Inspect the attached exact originals.',
      visibility: 'workspace',
    });
    expect(ThreadSchema.parse(await createdResponse.json()).visibility).toBe('workspace');
    const response = await accepted;
    expect(response.status(), await response.text()).toBe(202);
    const result = SubmitConversationResponseSchema.parse(await response.json());
    expect(result.turn.owner).toEqual({ kind: 'workspace', workspaceId });
    const turnWorkspaceId = workspaceIdForOwner(result.turn.owner);
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
          turnWorkspaceId,
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
    expect(page.viewportSize()).toEqual({ width: 360, height: 800 });
  } finally {
    await stopStack(stack);
  }
});

test('routes the selected artifact version from the phone without submitting', async ({ page }) => {
  test.setTimeout(120_000);
  expect(page.viewportSize()).toEqual({ width: 360, height: 800 });
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const submissions: unknown[] = [];
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/app/operations/conversation.submit')
      submissions.push(request.postDataJSON());
  });
  try {
    const client = createCoreClient({ baseUrl: stack.coreUrl });
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
    // Preserve the retained phone failure as a regression; Use itself must not submit.
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
    expect(page.viewportSize()).toEqual({ width: 360, height: 800 });
  } finally {
    await stopStack(stack);
  }
});
