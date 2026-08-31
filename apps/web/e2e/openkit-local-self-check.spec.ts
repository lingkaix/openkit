import { expect, type Page, test } from '@playwright/test';
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
 * Verifies the fixed local Workspace, Thread, and secret-safe Debug inspection path.
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

  await page.getByRole('button', { name: /^New conversation$/ }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('Story thread');
  await page.getByRole('button', { name: /Conversation agent$/ }).click();
  await page.getByRole('option', { name: 'New Shard + Worker' }).click();
  await page.getByRole('button', { name: /^Send message$/ }).click();
  await expect(page.getByRole('heading', { name: 'Story thread' })).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole('button', { name: /^General$/ }).click();
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  await expect(page.getByLabel('Display name')).toHaveValue('Story Workspace');
  await page.getByRole('button', { name: /^Settings$/ }).click();
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
  /** Exact proposal bytes rendered by the review surface. */
  content: { body: string };
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
 * @returns Parsed response body.
 * @throws When the stack is absent, the request fails, the status is not 200, or JSON is invalid.
 */
async function getJson<T>(path: string): Promise<T> {
  if (!stack) throw new Error('The isolated Web stack is not running.');
  const response = await fetch(`${stack.coreUrl}${path}`);
  const body = await response.text();
  expect(response.status, `GET ${path}: ${body}`).toBe(200);
  return JSON.parse(body) as T;
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
  await page.goto(`${stack?.webUrl}/materials/ws_demo/${threadId}`);
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
    '/api/app/workspaces/ws_demo/materials'
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
    await getJson<{ revisions: MaterialRevision[] }>(
      `/api/app/workspaces/ws_demo/materials/${materialId}/revisions`
    )
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
      `/api/app/workspaces/ws_demo/materials/${materialId}/revisions/${revisionId}`
    )
  ).revision;
}

/**
 * Starts one visible Task Turn and waits for the simulator's real non-secret user-input Gate.
 *
 * @param page Browser page connected to the isolated Web app.
 * @param threadId Thread that owns the Turn.
 * @param input Exact user-visible Task request.
 * @returns Resolves after a 202 response and visible question prove non-vacuity.
 * @throws When browser submission, the Task response, or Gate rendering fails.
 */
async function startTaskTurn(page: Page, threadId: string, input: string): Promise<void> {
  await page.goto(`${stack?.webUrl}/tasks/ws_demo/${threadId}`);
  await page.getByRole('textbox', { name: 'Message' }).fill(input);
  const turnResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/app/workspaces/ws_demo/threads/${threadId}/conversation-turns`)
  );
  await page.getByRole('button', { name: /^Send message$/ }).click();
  const response = await turnResponse;
  expect(response.status(), `Task Turn start response: ${await response.text()}`).toBe(202);
  await expect(page.getByText('Which summary tone should the simulator use?')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Couldn't send that message. Try again.")).toHaveCount(0);
}

/**
 * Proves the fixed visible Plane 1 handoff, restart, proposal, apply, and conflict sequence.
 *
 * Contract: docs/specs/20260713-work_resource_interaction_model.md, acceptance step 2.
 */
test('completes the fixed visible Material handoff and proposal-conflict sequence', async ({
  page,
}) => {
  test.setTimeout(55_000);
  const browserRuntimeErrors: string[] = [];
  page.on('pageerror', (error) => browserRuntimeErrors.push(error.message));
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const threadId = 'th_demo';
  const revisionOneContent = '# Release note\n\nRevision one.';
  const revisionTwoContent = '# Release note\n\nRevision two, saved while revision one is active.';
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
  const materialProjectionResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/app/workspaces/ws_demo/threads/${threadId}/material`)
  );
  await page.goto(`${stack.webUrl}/materials/ws_demo/${threadId}/${primary.materialId}`);
  const projectionResponse = await materialProjectionResponse;
  const projectionBody = await projectionResponse.text();
  await expect(
    page
      .getByRole('region', { name: 'Thread Material' })
      .getByText('Current-turn revision', { exact: true })
      .locator('..')
      .locator('dd'),
    `Thread Material response ${projectionResponse.status()}: ${projectionBody}`
  ).toHaveText(revisionOne.revisionId);

  const materialEditor = page.getByLabel('Release Material');
  await materialEditor.fill(revisionTwoContent);
  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response
        .url()
        .endsWith(`/api/app/workspaces/ws_demo/materials/${primary.materialId}/revisions`)
  );
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
  ).toHaveText(revisionOne.revisionId);

  await page.goto(`${stack.webUrl}/tasks/ws_demo/${threadId}`);
  await page.getByRole('textbox', { name: 'Tone' }).fill('Concise');
  const answerResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/turns')
  );
  await page.getByRole('button', { name: /^Submit answers$/ }).click();
  const answer = await answerResponse;
  expect(answer.ok(), `Worker user-input response ${answer.status()}: ${await answer.text()}`).toBe(
    true
  );
  await expect(page.getByText('You answered').last()).toBeVisible();
  await expect(page.getByText('Which summary tone should the simulator use?')).toHaveCount(0);

  await stack.restartCore();
  await startTaskTurn(page, threadId, 'Use the exact queued second release revision.');
  await expect(page.getByText('Which summary tone should the simulator use?')).toBeVisible();
  await page.getByRole('textbox', { name: 'Tone' }).fill('Concise');
  const secondAnswerResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/turns')
  );
  await page.getByRole('button', { name: /^Submit answers$/ }).click();
  const secondAnswer = await secondAnswerResponse;
  expect(
    secondAnswer.ok(),
    `Second worker user-input response ${secondAnswer.status()}: ${await secondAnswer.text()}`
  ).toBe(true);
  await expect(page.getByText('You answered').last()).toBeVisible();
  await expect(page.getByText('Which summary tone should the simulator use?')).toHaveCount(0);

  const artifacts = (
    await getJson<{ items: ProposalArtifactSummary[] }>('/api/workspaces/ws_demo/artifacts')
  ).items;
  const proposals = (
    await Promise.all(
      artifacts.map(async (artifact) => {
        const reviews = (
          await getJson<{ reviews: ProposalReviewSummary[] }>(
            `/api/app/workspaces/ws_demo/artifacts/${artifact.id}/reviews`
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
  await page.goto(`${stack.webUrl}/goals/ws_demo/${threadId}/artifacts/${proposals[0]!.id}`);
  await expect(page.getByRole('region', { name: /reviewed artifact proposal/i })).toBeVisible();
  await expect(page.getByRole('region', { name: /recorded base revision/i })).toContainText(
    revisionTwoContent
  );
  await expect(page.getByRole('complementary', { name: 'Provenance and review' })).toContainText(
    threadId
  );
  await page.getByRole('button', { name: /^Accept$/ }).click();
  await expect(page.getByRole('status', { name: 'Artifact review' })).toContainText('Approved');

  await page.goto(`${stack.webUrl}/materials/ws_demo/${threadId}/${primary.materialId}`);
  await expect(materialEditor).toHaveValue(proposals[0]!.content.body);
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
      content: proposals[0]!.content.body,
    })
  );
  const materialAfterApply = (
    await getJson<{ material: MaterialSummary }>(
      `/api/app/workspaces/ws_demo/materials/${primary.materialId}`
    )
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
    await getJson<{ material: MaterialSummary }>(
      `/api/app/workspaces/ws_demo/materials/${primary.materialId}`
    )
  ).material;
  expect(materialAfterUserSave.currentRevisionId).toBe(userRevision.revisionId);
  const revisionIdsAfterUserSave = revisionsAfterUserSave
    .map((revision) => revision.revisionId)
    .sort();

  await page.goto(`${stack.webUrl}/goals/ws_demo/${threadId}/artifacts/${proposals[1]!.id}`);
  const reviewedProposal = page.getByRole('region', { name: /reviewed artifact proposal/i });
  const recordedBase = page.getByRole('region', { name: /recorded base revision/i });
  await expect(reviewedProposal).toBeVisible();
  await expect(reviewedProposal).toContainText(proposals[1]!.content.body);
  await expect(recordedBase).toContainText(revisionTwoContent);
  await page.getByRole('button', { name: /^Accept$/ }).click();
  await expect(page.getByText(/conflict|changed since the proposal base/i)).toBeVisible();
  await expect(page.getByText('Awaiting decision.')).toBeVisible();
  const revisionsAfterConflict = await materialRevisions(primary.materialId);
  expect(revisionsAfterConflict.map((revision) => revision.revisionId).sort()).toEqual(
    revisionIdsAfterUserSave
  );
  const materialAfterConflict = (
    await getJson<{ material: MaterialSummary }>(
      `/api/app/workspaces/ws_demo/materials/${primary.materialId}`
    )
  ).material;
  expect(materialAfterConflict.currentRevisionId).toBe(userRevision.revisionId);
  expect(
    (
      await getJson<{ items: ProposalArtifactSummary[] }>('/api/workspaces/ws_demo/artifacts')
    ).items.find((artifact) => artifact.id === proposals[1]!.id)?.content.body
  ).toBe(proposals[1]!.content.body);

  await stack.restartCore();
  await page.reload();
  await expect(page.getByText('Awaiting decision.')).toBeVisible();
  await expect(page.getByRole('region', { name: /reviewed artifact proposal/i })).toContainText(
    proposals[1]!.content.body
  );
  await expect(page.getByRole('region', { name: /recorded base revision/i })).toContainText(
    revisionTwoContent
  );
  await page.goto(`${stack.webUrl}/materials/ws_demo/${threadId}/${primary.materialId}`);
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
    [appliedRevision.revisionId]: proposals[0]!.content.body,
    [userRevision.revisionId]: revisionThreeContent,
  });
  const recoveredProjection = (
    await getJson<{ material: ThreadMaterialSummary | null }>(
      `/api/app/workspaces/ws_demo/threads/${threadId}/material`
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
