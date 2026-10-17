import { createHash } from 'node:crypto';
import {
  StartTaskModeResponseSchema,
  ThreadDashboardResponseSchema,
} from '@openkit/app-api-schemas';
import { createCoreClient, createRequestId } from '@openkit/core-client';
import { ThreadSchema } from '@openkit/protocol';
import { expect, type Page, test } from '@playwright/test';
import { isQuestionAnswerResponse } from './_lib/question-answer-response.js';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;

test.afterEach(async () => {
  const current = stack;
  stack = null;

  if (current) {
    await current.stop();
  }
});

/**
 * Verifies private Assistant reuse, member navigation, refused undisclosed handoff, and safe Debug inspection.
 *
 * Contract: docs/specs/20260529-test_strategy.md
 */
test('completes the local Workspace self-check', async ({ page }) => {
  const browserRuntimeErrors: string[] = [];
  page.on('pageerror', (error) => browserRuntimeErrors.push(error.message));

  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  await page.goto(stack.webUrl);
  expect(browserRuntimeErrors, 'browser startup must not raise runtime errors').toEqual([]);

  await page.getByRole('button', { name: /^Settings$/ }).click();
  await page.getByRole('button', { name: /^New workspace$/ }).click();
  await page.getByLabel('Name').fill('Story Workspace');
  await page.getByRole('button', { name: /^Create workspace$/ }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  const firstOpening = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/thread.create' && response.ok()
  );
  await page.getByRole('button', { name: /^Assistant$/ }).click();
  const assistant = ThreadSchema.parse(await (await firstOpening).json());
  expect(assistant.visibility).toBe('private');
  const selector = { workspaceId: assistant.workspaceId, threadId: assistant.id };
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  expect((await client.operations['thread.dashboard'](selector)).turns).toEqual([]);

  await page.getByRole('button', { name: /^Members$/ }).click();
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  await page.getByRole('button', { name: /^Back to app$/ }).click();
  const secondOpening = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/thread.create' && response.ok()
  );
  // The opener precedes the retained Timeline row with the same visible title.
  await page
    .getByRole('button', { name: /^Assistant$/ })
    .first()
    .click();
  expect(ThreadSchema.parse(await (await secondOpening).json()).id).toBe(assistant.id);
  expect((await client.operations['thread.dashboard'](selector)).turns).toEqual([]);
  await page.getByRole('textbox', { name: 'Message' }).fill('Story thread');
  await page.getByRole('button', { name: /Conversation agent$/ }).click();
  await page.getByRole('option', { name: 'New Shard + Worker' }).click();
  await page.getByRole('button', { name: /^Send message$/ }).click();
  await expect(
    page.getByText(
      'Explicit disclosure admission is required before private Assistant input becomes shared Task work.',
      { exact: true }
    )
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: assistant.name })).toBeVisible();
  expect(
    (await client.operations['thread.list']({ workspaceId: assistant.workspaceId })).items.map(
      (thread) => ({ id: thread.id, visibility: thread.visibility })
    )
  ).toEqual([{ id: assistant.id, visibility: 'private' }]);

  await page.getByRole('button', { name: /^Settings$/ }).click();
  await page.getByRole('button', { name: /^General$/ }).click();
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  // The heading renders before the separate Workspace read supplies the form.
  await expect(page.getByLabel('Display name')).toHaveValue('Story Workspace', {
    timeout: 15_000,
  });
  await page.getByRole('button', { name: /^Debug$/ }).click();
  await expect(page.getByRole('heading', { name: 'Debug' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Runtime evidence' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('sk-openkit');
});

/** Minimal Material identity read only to route the browser to its new record. */
interface MaterialSummary {
  /** Workspace-owned Material identity. */
  materialId: string;
  /** User-visible title used to find the browser-created record. */
  title: string;
  /** Current immutable revision selected by the Material owner. */
  currentRevisionId: string | null;
}

/** Minimal immutable revision identity needed by the visible projection assertion. */
interface MaterialRevision {
  /** Workspace-owned immutable revision identity. */
  revisionId: string;
}

/** Minimal pending proposal identity used only to route visible review actions. */
interface ProposalArtifactSummary {
  /** Artifact identity exposed by the browser review route. */
  id: string;
  /** Immutable version selected for the exact original download. */
  version: number;
  /** Digest of the proposal original, independent of its storage form. */
  contentDigest: string;
}

/** Minimal Review projection needed to select the exact revision-2 proposals. */
interface ProposalReviewSummary {
  /** Immutable Material base recorded by the version-keyed Review. */
  materialProposal: { baseRevisionId: string } | null;
}

/** Exact immutable revision read used only for post-conflict preservation assertions. */
interface MaterialRevisionView extends MaterialRevision {
  /** Canonical immutable revision bytes. */
  content: string;
}

/** Minimal bound Thread Material projection needed for exact recovery assertions. */
interface ThreadMaterialSummary {
  /** Bound Workspace Material owner. */
  resource: MaterialSummary;
  /** Current immutable revision projected for the bound Material. */
  currentRevision: MaterialRevision | null;
  /** Automatic next-turn inclusion choice. */
  inclusionState: 'included' | 'excluded';
  /** Exact revision queued for the next worker Turn. */
  latestQueuedRevisionId: string | null;
  /** Latest revision proven available to a worker. */
  lastWorkerSeenRevisionId: string | null;
  /** Revision selected by the current non-terminal worker Turn. */
  currentTurnRevisionId: string | null;
}

/**
 * Reads one successful controlled-setup response from the isolated Core.
 *
 * @param path App API path below the isolated Core URL.
 * @param input Optional definition-derived operation input.
 * @returns Parsed response body.
 * @throws When the stack is absent, the request fails, the status is not 200, or JSON is invalid.
 */
async function getJson<T>(path: string, input?: Record<string, unknown>): Promise<T> {
  if (!stack) throw new Error('The isolated Web stack is not running.');
  const response = await fetch(
    `${stack.coreUrl}${path}`,
    input
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
      : undefined
  );
  const body = await response.text();
  expect(response.status, `${input ? 'POST' : 'GET'} ${path}: ${body}`).toBe(200);
  return JSON.parse(body) as T;
}

/** Downloads the exact authorized proposal original and verifies its digest before comparing applied Material bytes. */
async function proposalOriginal(artifact: ProposalArtifactSummary): Promise<string> {
  if (!stack) throw new Error('The isolated Web stack is not running.');
  const query = new URLSearchParams({
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    artifactId: artifact.id,
    artifactVersion: String(artifact.version),
  });
  const response = await fetch(`${stack.coreUrl}/api/app/operations/artifact.download?${query}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('x-openkit-content-digest')).toBe(artifact.contentDigest);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(artifact.contentDigest);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Creates and saves one Material through the visible route.
 *
 * @param page Browser page connected to the isolated Web app.
 * @param threadId Thread used by the registered Material route.
 * @param title User-visible Material title.
 * @param content Exact first revision bytes.
 * @returns Server-visible identity of the browser-created Material.
 * @throws When a browser action, visible assertion, or controlled setup read fails.
 */
async function createMaterial(
  page: Page,
  threadId: string,
  title: string,
  content: string
): Promise<MaterialSummary> {
  await page.goto(`${stack?.webUrl}/materials/ws_00000000-0000-7000-8000-000000000001/${threadId}`);
  await page
    .getByRole('button', { name: /^New Material$/ })
    .first()
    .click();
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: /^Create Material$/ }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByLabel(title).fill(content);
  await page.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  const response = await getJson<{ materials: MaterialSummary[] }>(
    '/api/app/operations/material.list',
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' }
  );
  const material = response.materials.find((candidate) => candidate.title === title);
  expect(material, `Material ${title} must be server-visible after browser save`).toBeTruthy();
  return material!;
}

/**
 * Returns immutable revision summaries for one Material.
 *
 * @param materialId Workspace-owned Material identity.
 * @returns Immutable revisions in server order.
 * @throws When the controlled setup read fails or returns invalid JSON.
 */
async function materialRevisions(materialId: string): Promise<MaterialRevision[]> {
  return (
    await getJson<{ revisions: MaterialRevision[] }>('/api/app/operations/material.revision-list', {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      materialId: materialId,
    })
  ).revisions;
}

/**
 * Reads one exact immutable Material revision after a visible product action.
 *
 * @param materialId Workspace-owned Material identity.
 * @param revisionId Immutable revision identity.
 * @returns Exact canonical revision view.
 */
async function materialRevision(
  materialId: string,
  revisionId: string
): Promise<MaterialRevisionView> {
  return (
    await getJson<{ revision: MaterialRevisionView }>(
      '/api/app/operations/material.revision-read',
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        materialId: materialId,
        revisionId: revisionId,
      }
    )
  ).revision;
}

/**
 * Admits direct Task work in the explicitly bound Thread and observes its terminal question.
 *
 * @param page Browser page connected to the isolated Web app.
 * @param threadId Explicitly bound Thread that owns the Task Turn.
 * @param input Exact user-visible Task request.
 * @returns Resolves after a 202 response, visible question, and verified terminal Turn.
 * @throws When Task admission, question rendering, or terminal proof fails.
 */
async function startTaskTurn(page: Page, threadId: string, input: string): Promise<void> {
  if (!stack) throw new Error('The isolated Web stack is not running.');
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const requestId = createRequestId();
  const response = await page.request.post(`${stack.coreUrl}/api/app/operations/task.start`, {
    headers: { 'x-openkit-request-id': requestId },
    data: { workspaceId, threadId, input, requestId },
  });
  const responseBody = await response.text();
  expect(response.status(), `Task Turn start response: ${responseBody}`).toBe(202);
  const submission = StartTaskModeResponseSchema.parse(JSON.parse(responseBody));
  expect(submission.turn).toMatchObject({ workspaceId, threadId });
  await page.goto(`${stack.webUrl}/tasks/${workspaceId}/${threadId}`);
  await expect(page.getByText('Which summary tone should the simulator use?')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Couldn't send that message. Try again.")).toHaveCount(0);
  const turn = await getJson<{ status: string; contextPackageDigest: string | null }>(
    '/api/app/operations/turn.read',
    { workspaceId, threadId, turnId: submission.turn.id }
  );
  expect(turn.status).toBe('completed');
  expect(turn.contextPackageDigest).toMatch(/^ctxpkg_sha256_[a-f0-9]{64}$/);
}

/** Reads canonical Turn ids before this isolated fixture answers a pending question. */
async function threadTurnIds(threadId: string): Promise<Set<string>> {
  const dashboard = ThreadDashboardResponseSchema.parse(
    await getJson('/api/app/operations/thread.dashboard', {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId,
    })
  );
  return new Set(dashboard.turns.map((turn) => turn.id));
}

/** The answer acknowledgement resolves the question before its separate outcome-delivery Turn finishes. Wait for that real Turn before restarting Core or reading its outputs. */
async function waitForAnswerTurn(
  threadId: string,
  priorTurnIds: ReadonlySet<string>
): Promise<void> {
  await expect
    .poll(
      async () => {
        const dashboard = ThreadDashboardResponseSchema.parse(
          await getJson('/api/app/operations/thread.dashboard', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId,
          })
        );
        const delivered = dashboard.turns.filter((turn) => !priorTurnIds.has(turn.id));
        return delivered.length === 1 && delivered[0]!.status === 'completed';
      },
      {
        timeout: 15_000,
        message: 'The answer must complete its separate canonical outcome-delivery Turn.',
      }
    )
    .toBe(true);
}

/**
 * Proves the fixed visible Plane 1 handoff, restart, proposal, apply, and conflict sequence.
 *
 * Contract: docs/specs/20260713-work_resource_interaction_model.md, acceptance step 2.
 */
test('completes the fixed visible Material handoff and proposal-conflict sequence', async ({
  page,
}) => {
  // Cold startup, two worker turns, and two Core restarts share this bounded harness budget. Per-action and assertion timeouts still detect stalled progress.
  test.setTimeout(120_000);
  const browserRuntimeErrors: string[] = [];
  page.on('pageerror', (error) => browserRuntimeErrors.push(error.message));
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const threadId = 'th_00000000-0000-7000-8000-000000000001';
  const revisionOneContent = '# Release note\n\nRevision one.';
  const revisionTwoContent =
    '# Release note\n\nRevision two, saved after revision one was delivered.';
  const primary = await createMaterial(page, threadId, 'Release Material', revisionOneContent);
  const [revisionOne] = await materialRevisions(primary.materialId);
  expect(revisionOne).toBeTruthy();

  await page.getByRole('button', { name: /^Bind Material$/ }).click();
  const threadMaterial = page.getByRole('region', { name: 'Thread Material' });
  await expect(threadMaterial.getByText('bound', { exact: true })).toBeVisible();
  await expect(
    threadMaterial.getByText('Current revision', { exact: true }).locator('..').locator('dd')
  ).toHaveText(revisionOne.revisionId);
  await expect(
    threadMaterial.getByText('Queued revision', { exact: true }).locator('..').locator('dd')
  ).toHaveText(revisionOne.revisionId);

  await startTaskTurn(page, threadId, 'Create a summary from the exact first release revision.');
  const materialProjectionResponse = page.waitForResponse((response) => {
    if (
      response.request().method() !== 'POST' ||
      new URL(response.url()).pathname !== '/api/app/operations/material.thread-read'
    )
      return false;
    const input = response.request().postDataJSON();
    return (
      input.workspaceId === 'ws_00000000-0000-7000-8000-000000000001' && input.threadId === threadId
    );
  });
  await page.goto(
    `${stack.webUrl}/materials/ws_00000000-0000-7000-8000-000000000001/${threadId}/${primary.materialId}`
  );
  const projectionResponse = await materialProjectionResponse;
  const projectionBody = await projectionResponse.text();
  await expect(
    page
      .getByRole('region', { name: 'Thread Material' })
      .getByText('Worker-seen revision', { exact: true })
      .locator('..')
      .locator('dd'),
    `Thread Material response ${projectionResponse.status()}: ${projectionBody}`
  ).toHaveText(revisionOne.revisionId);
  // S16 acceptance step 2 proves delivery; a pending question does not keep its Turn non-terminal.
  await expect(
    page
      .getByRole('region', { name: 'Thread Material' })
      .getByText('Current-turn revision', { exact: true })
      .locator('..')
      .locator('dd')
  ).toHaveText('Unknown / none / not available');

  const materialEditor = page.getByLabel('Release Material');
  await materialEditor.fill(revisionTwoContent);
  const saveResponse = page.waitForResponse((response) => {
    if (
      response.request().method() !== 'POST' ||
      new URL(response.url()).pathname !== '/api/app/operations/material.revision-save'
    )
      return false;
    const input = response.request().postDataJSON();
    return (
      input.workspaceId === 'ws_00000000-0000-7000-8000-000000000001' &&
      input.materialId === primary.materialId
    );
  });
  await page.getByRole('button', { name: /^Save$/ }).click();
  const revisionTwoSave = await saveResponse;
  expect(
    revisionTwoSave.ok(),
    `Revision two save response ${revisionTwoSave.status()}: ${await revisionTwoSave.text()}`
  ).toBe(true);
  const revisionsAfterSecondSave = await materialRevisions(primary.materialId);
  const revisionTwo = revisionsAfterSecondSave.find(
    (revision) => revision.revisionId !== revisionOne.revisionId
  );
  expect(revisionTwo, 'Revision two must be server-visible after the browser save').toBeTruthy();

  const updatedThreadMaterial = page.getByRole('region', { name: 'Thread Material' });
  await expect(
    updatedThreadMaterial.getByText('Current revision', { exact: true }).locator('..').locator('dd')
  ).toHaveText(revisionTwo!.revisionId);
  await expect(
    updatedThreadMaterial.getByText('Queued revision', { exact: true }).locator('..').locator('dd')
  ).toHaveText(revisionTwo!.revisionId);
  await expect(
    updatedThreadMaterial
      .getByText('Worker-seen revision', { exact: true })
      .locator('..')
      .locator('dd')
  ).toHaveText(revisionOne.revisionId);
  await expect(
    updatedThreadMaterial
      .getByText('Current-turn revision', { exact: true })
      .locator('..')
      .locator('dd')
  ).toHaveText('Unknown / none / not available');

  await page.goto(`${stack.webUrl}/tasks/ws_00000000-0000-7000-8000-000000000001/${threadId}`);
  await page.getByRole('textbox', { name: 'Tone' }).fill('Concise');
  const beforeAnswer = await threadTurnIds(threadId);
  const answerResponse = page.waitForResponse(isQuestionAnswerResponse);
  await page.getByRole('button', { name: /^Submit answers$/ }).click();
  const answer = await answerResponse;
  expect(answer.ok(), `Worker user-input response ${answer.status()}: ${await answer.text()}`).toBe(
    true
  );
  // The answer response precedes the separate canonical Item refresh on a shared test host.
  await expect(page.getByText('You answered')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByText('Which summary tone should the simulator use?')).toHaveCount(0);

  await waitForAnswerTurn(threadId, beforeAnswer);
  await stack.restartCore();
  await startTaskTurn(page, threadId, 'Use the exact queued second release revision.');
  await expect(page.getByText('Which summary tone should the simulator use?')).toBeVisible();
  await page.getByRole('textbox', { name: 'Tone' }).fill('Concise');
  const beforeSecondAnswer = await threadTurnIds(threadId);
  const secondAnswerResponse = page.waitForResponse(isQuestionAnswerResponse);
  await page.getByRole('button', { name: /^Submit answers$/ }).click();
  const secondAnswer = await secondAnswerResponse;
  expect(
    secondAnswer.ok(),
    `Second worker user-input response ${secondAnswer.status()}: ${await secondAnswer.text()}`
  ).toBe(true);
  await expect(page.getByText('You answered')).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByText('Which summary tone should the simulator use?')).toHaveCount(0);

  await waitForAnswerTurn(threadId, beforeSecondAnswer);

  const artifacts = (
    await getJson<{ items: ProposalArtifactSummary[] }>('/api/app/operations/artifact.list', {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    })
  ).items;
  const proposals = (
    await Promise.all(
      artifacts.map(async (artifact) => {
        const reviews = (
          await getJson<{ reviews: ProposalReviewSummary[] }>(
            '/api/app/operations/artifact.review-list',
            { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', artifactId: artifact.id }
          )
        ).reviews;
        return reviews.some(
          (review) => review.materialProposal?.baseRevisionId === revisionTwo!.revisionId
        )
          ? artifact
          : null;
      })
    )
  ).filter((artifact): artifact is ProposalArtifactSummary => artifact !== null);
  expect(proposals).toHaveLength(2);
  const proposalTexts = await Promise.all(proposals.map(proposalOriginal));
  await page.goto(
    `${stack.webUrl}/goals/ws_00000000-0000-7000-8000-000000000001/${threadId}/artifacts/${proposals[0]!.id}`
  );
  await expect(page.getByRole('region', { name: /reviewed artifact proposal/i })).toBeVisible();
  await expect(page.getByRole('region', { name: /recorded base revision/i })).toContainText(
    revisionTwoContent
  );
  await expect(page.getByRole('complementary', { name: 'Provenance and review' })).toContainText(
    threadId
  );
  const previousViewport = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.setViewportSize({ width: 800, height: 600 });
  const overflow = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth);
  await expect(page.getByRole('region', { name: /reviewed artifact proposal/i })).toBeVisible();
  const accept = page.getByRole('button', { name: /^Accept$/ });
  await accept.scrollIntoViewIfNeeded();
  await expect(accept).toBeVisible();
  await accept.click();
  await expect(page.getByRole('status', { name: 'Artifact review' })).toContainText('Approved');
  await page.setViewportSize(previousViewport);

  await page.goto(
    `${stack.webUrl}/materials/ws_00000000-0000-7000-8000-000000000001/${threadId}/${primary.materialId}`
  );
  await expect(materialEditor).toHaveValue(proposalTexts[0]!);
  const revisionsAfterApply = await materialRevisions(primary.materialId);
  expect(revisionsAfterApply).toHaveLength(3);
  const appliedRevisions = revisionsAfterApply.filter(
    (revision) =>
      revision.revisionId !== revisionOne.revisionId &&
      revision.revisionId !== revisionTwo!.revisionId
  );
  expect(appliedRevisions).toHaveLength(1);
  const appliedRevision = appliedRevisions[0]!;
  await expect(materialRevision(primary.materialId, appliedRevision.revisionId)).resolves.toEqual(
    expect.objectContaining({
      revisionId: appliedRevision.revisionId,
      content: proposalTexts[0]!,
    })
  );
  const materialAfterApply = (
    await getJson<{ material: MaterialSummary }>('/api/app/operations/material.read', {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      materialId: primary.materialId,
    })
  ).material;
  expect(materialAfterApply.currentRevisionId).toBe(appliedRevision.revisionId);
  const revisionThreeContent = '# Release note\n\nA newer user revision after proposal one.';
  await materialEditor.fill(revisionThreeContent);
  await page.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  const revisionsAfterUserSave = await materialRevisions(primary.materialId);
  expect(revisionsAfterUserSave).toHaveLength(4);
  const userRevisions = revisionsAfterUserSave.filter(
    (revision) =>
      !revisionsAfterApply.some((candidate) => candidate.revisionId === revision.revisionId)
  );
  expect(userRevisions).toHaveLength(1);
  const userRevision = userRevisions[0]!;
  await expect(materialRevision(primary.materialId, userRevision.revisionId)).resolves.toEqual(
    expect.objectContaining({ revisionId: userRevision.revisionId, content: revisionThreeContent })
  );
  const materialAfterUserSave = (
    await getJson<{ material: MaterialSummary }>('/api/app/operations/material.read', {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      materialId: primary.materialId,
    })
  ).material;
  expect(materialAfterUserSave.currentRevisionId).toBe(userRevision.revisionId);
  const revisionIdsAfterUserSave = revisionsAfterUserSave
    .map((revision) => revision.revisionId)
    .sort();

  await page.goto(
    `${stack.webUrl}/goals/ws_00000000-0000-7000-8000-000000000001/${threadId}/artifacts/${proposals[1]!.id}`
  );
  const reviewedProposal = page.getByRole('region', { name: /reviewed artifact proposal/i });
  const recordedBase = page.getByRole('region', { name: /recorded base revision/i });
  await expect(reviewedProposal).toBeVisible();
  await expect(reviewedProposal).toContainText(proposalTexts[1]!);
  await expect(recordedBase).toContainText(revisionTwoContent);
  await page.getByRole('button', { name: /^Accept$/ }).click();
  await expect(page.getByText(/conflict|changed since the proposal base/i)).toBeVisible();
  await expect(page.getByText('Awaiting decision.')).toBeVisible();
  const revisionsAfterConflict = await materialRevisions(primary.materialId);
  expect(revisionsAfterConflict.map((revision) => revision.revisionId).sort()).toEqual(
    revisionIdsAfterUserSave
  );
  const materialAfterConflict = (
    await getJson<{ material: MaterialSummary }>('/api/app/operations/material.read', {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      materialId: primary.materialId,
    })
  ).material;
  expect(materialAfterConflict.currentRevisionId).toBe(userRevision.revisionId);
  const retainedProposal = (
    await getJson<{ items: ProposalArtifactSummary[] }>('/api/app/operations/artifact.list', {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    })
  ).items.find((artifact) => artifact.id === proposals[1]!.id)!;
  expect(retainedProposal.version).toBe(proposals[1]!.version);
  expect(retainedProposal.contentDigest).toBe(proposals[1]!.contentDigest);
  expect(await proposalOriginal(retainedProposal)).toBe(proposalTexts[1]!);

  await stack.restartCore();
  await page.reload();
  await expect(page.getByText('Awaiting decision.')).toBeVisible();
  await expect(page.getByRole('region', { name: /reviewed artifact proposal/i })).toContainText(
    proposalTexts[1]!
  );
  await expect(page.getByRole('region', { name: /recorded base revision/i })).toContainText(
    revisionTwoContent
  );
  await page.goto(
    `${stack.webUrl}/materials/ws_00000000-0000-7000-8000-000000000001/${threadId}/${primary.materialId}`
  );
  const recoveredRevisions = await materialRevisions(primary.materialId);
  expect(recoveredRevisions.map((revision) => revision.revisionId).sort()).toEqual(
    revisionIdsAfterUserSave
  );
  const recoveredRevisionViews = await Promise.all(
    recoveredRevisions.map((revision) => materialRevision(primary.materialId, revision.revisionId))
  );
  expect(
    Object.fromEntries(
      recoveredRevisionViews.map((revision) => [revision.revisionId, revision.content])
    )
  ).toEqual({
    [revisionOne.revisionId]: revisionOneContent,
    [revisionTwo!.revisionId]: revisionTwoContent,
    [appliedRevision.revisionId]: proposalTexts[0]!,
    [userRevision.revisionId]: revisionThreeContent,
  });
  const recoveredProjection = (
    await getJson<{ material: ThreadMaterialSummary | null }>(
      '/api/app/operations/material.thread-read',
      { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', threadId: threadId }
    )
  ).material;
  expect(recoveredProjection).not.toBeNull();
  expect(recoveredProjection).toMatchObject({
    resource: {
      materialId: primary.materialId,
      currentRevisionId: userRevision.revisionId,
    },
    currentRevision: { revisionId: userRevision.revisionId },
    inclusionState: 'included',
    latestQueuedRevisionId: userRevision.revisionId,
    lastWorkerSeenRevisionId: revisionTwo!.revisionId,
    currentTurnRevisionId: null,
  });
  const recoveredThreadMaterial = page.getByRole('region', { name: 'Thread Material' });
  await expect(recoveredThreadMaterial.getByText('bound', { exact: true })).toBeVisible();
  await expect(recoveredThreadMaterial.getByText('included', { exact: true })).toBeVisible();
  await expect(
    recoveredThreadMaterial
      .getByText('Current revision', { exact: true })
      .locator('..')
      .locator('dd')
  ).toHaveText(userRevision.revisionId);
  await expect(
    recoveredThreadMaterial
      .getByText('Queued revision', { exact: true })
      .locator('..')
      .locator('dd')
  ).toHaveText(userRevision.revisionId);
  await expect(
    recoveredThreadMaterial
      .getByText('Worker-seen revision', { exact: true })
      .locator('..')
      .locator('dd')
  ).toHaveText(revisionTwo!.revisionId);
  await expect(
    recoveredThreadMaterial
      .getByText('Current-turn revision', { exact: true })
      .locator('..')
      .locator('dd')
  ).toHaveText('Unknown / none / not available');
  expect(browserRuntimeErrors, 'Plane 1 browser flow must not raise runtime errors').toEqual([]);
  await expect(page.locator('body')).not.toContainText('sk-openkit');
});
