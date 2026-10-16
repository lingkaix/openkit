import { expect, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

let stack: IsolatedWebStack | null = null;

test.afterEach(async () => {
  await stack?.stop();
  stack = null;
});

/** Browser routing must preserve the exact owner tuple, including literal percent escapes. */
test('opens and reloads the exact Artifact review from Action Center', async ({ page }) => {
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const workspaceId = 'ws_/?#%_%2F';
  const threadId = 'th_/?#%_%2F';
  const artifactId = 'ar_/?#%_%2F';
  const at = '2026-10-15T00:00:00.000Z';
  const contentDigest = `sha256:${'a'.repeat(64)}`;
  const artifactReads: unknown[] = [];
  const reviewReads: unknown[] = [];
  const goalReads: unknown[] = [];
  await page.route('**/api/app/operations/workspace.list', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        items: [{ ...body.items[0], workspace: { ...body.items[0].workspace, id: workspaceId } }],
      },
    });
  });
  await page.route('**/api/app/operations/conversation.navigation', (route) =>
    route.fulfill({ json: { items: [] } })
  );
  await page.route('**/api/app/operations/attention.list', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'artifact-review:review1',
            kind: 'artifact_review',
            workspaceId,
            threadId,
            turnId: 'turn1',
            reviewId: 'review1',
            artifactId,
            artifactVersion: 1,
            title: 'Review exact output',
            summary: 'Inspect the exact output.',
            severity: 'needs_input',
            createdAt: at,
            recommendedAction: 'Inspect the output.',
            source: {
              type: 'artifact_review',
              reviewId: 'review1',
              workspaceId,
              threadId,
              turnId: 'turn1',
              artifactId,
              artifactVersion: 1,
            },
            actions: [
              {
                kind: 'open_artifact',
                label: 'Open artifact',
                method: 'POST',
                href: '/api/app/operations/artifact.read',
              },
            ],
          },
        ],
      },
    })
  );
  await page.route('**/api/app/operations/artifact.read', async (route) => {
    artifactReads.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        id: artifactId,
        workspaceId,
        threadId,
        turnId: 'turn1',
        kind: 'report',
        title: 'Exact worker output',
        status: 'ready',
        summary: null,
        version: 1,
        content: { format: 'text', body: 'Exact output bytes.' },
        contentDigest,
        lastMutationRequestId: 'request1',
        origin: { kind: 'turn-output', threadId, turnId: 'turn1', requestId: 'request1' },
        createdAt: at,
        updatedAt: at,
      },
    });
  });
  await page.route('**/api/app/operations/artifact.review-list', async (route) => {
    reviewReads.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        reviews: [
          {
            workspaceId,
            reviewId: 'review1',
            artifactId,
            artifactVersion: 1,
            contentDigest,
            sourceThreadId: threadId,
            sourceTurnId: 'turn1',
            sourceAgentId: 'agent1',
            materialProposal: null,
            decision: null,
            decisionActorId: null,
            feedback: null,
            decidedAt: null,
            followUpTurnId: null,
            appliedMaterialRevisionId: null,
            createdAt: at,
          },
        ],
      },
    });
  });
  await page.route('**/api/app/operations/goal.read', async (route) => {
    goalReads.push(route.request().postDataJSON());
    await route.fulfill({
      json: { goal: null, cards: [], versions: [], tasks: [], requests: [] },
    });
  });
  await page.goto(stack.webUrl);
  await page.getByRole('link', { name: 'Open goal' }).click();
  const expectedPath = `/goals/${encodeURIComponent(workspaceId)}/${encodeURIComponent(threadId)}/artifacts/${encodeURIComponent(artifactId)}`;
  await expect(page).toHaveURL(`${stack.webUrl}${expectedPath}`);
  await expect(page.getByText('Exact output bytes.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Exact output bytes.', { exact: true })).toBeVisible();
  expect(artifactReads).toEqual(Array(2).fill({ workspaceId, artifactId }));
  expect(reviewReads).toEqual(Array(2).fill({ workspaceId, artifactId }));
  await page.getByRole('link', { name: /back to goal/i }).click();
  await expect(page.getByRole('heading', { name: 'Create Goal' })).toBeVisible();
  expect(goalReads).toEqual([{ workspaceId, threadId }]);
});
