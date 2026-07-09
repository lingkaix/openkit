import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const storyPath = resolve(process.cwd(), '../../tests/stories/openkit-local-self-check.story.md');

/**
 * Isolated local stack returned by the story web-stack helper.
 */
type StoryStack = {
  /** Base URL for the NanoCore API. */
  coreUrl: string;
  /** Temporary data root removed when the stack stops. */
  dataRoot: string;
  /** Stops spawned services and removes temporary data. */
  stop(): Promise<void>;
  /** Base URL for the Web UI. */
  webUrl: string;
};

/**
 * Workspace list response shape used by repository setup.
 */
type StoryWorkspaceListResponse = {
  /** Workspace records currently visible to the local story stack. */
  items: Array<{ id: string; name: string }>;
};

let stack: StoryStack | null = null;

test.afterEach(async () => {
  const current = stack;
  stack = null;

  if (current) {
    await current.stop();
  }
});

test('runs the OpenKit local self-check story', async ({ page }, testInfo) => {
  const { parseStoryDocument, validateStoryMetadata } = await import('./story-metadata.mjs');
  const { startIsolatedStoryWebStack } = await import('./web-stack.mjs');
  const storyText = readFileSync(storyPath, 'utf8');
  const story = parseStoryDocument(storyText, storyPath);
  const assertionSummary: string[] = [];

  validateStoryMetadata(story.metadata, storyPath);
  await testInfo.attach('story', {
    path: storyPath,
    contentType: 'text/markdown',
  });

  stack = await startIsolatedStoryWebStack({ mode: 'local', useSimulator: true });
  await page.goto(stack.webUrl);

  await page.getByRole('button', { name: /^New workspace$/ }).click();
  await page.getByLabel('New workspace').fill('Story Workspace');
  await page.getByRole('button', { name: /^Create workspace$/ }).click();
  await expect(page.getByRole('button', { name: 'Story Workspace' })).toBeVisible();
  const repositoryPath = createStoryRepository(stack.dataRoot);
  const workspaceId = await findWorkspaceId(stack.coreUrl, 'Story Workspace');
  await linkDefaultRepository(stack.coreUrl, workspaceId, repositoryPath);
  assertionSummary.push('Workspace was created and displayed.');

  await page.getByLabel('New thread for Story Workspace').fill('Story thread');
  await page.getByRole('button', { name: /^New thread$/ }).click();
  await expect(page.getByRole('heading', { name: 'Story thread Dashboard' })).toBeVisible();
  assertionSummary.push('Thread dashboard was displayed.');

  await page.getByLabel('Turn prompt').fill('Run the story simulator full flow.');
  await page.getByRole('button', { name: /^Send turn$/ }).click();
  await expect(page.getByText(/simulator: ok/i).first()).toBeVisible();
  await expect(page.getByText(/Approve simulated workspace update/).first()).toBeVisible();
  assertionSummary.push('Simulator output and approval gate were visible.');

  await page.getByRole('button', { name: /^Approve$/ }).click();
  await expect(page.getByText(/^Granted$/)).toBeVisible();
  assertionSummary.push('Approval gate was granted.');

  await expect(
    page.getByLabel('Attention needed').getByText(/Which summary tone should the simulator use/i)
  ).toBeVisible();
  await page.getByLabel('Answer').fill('Concise');
  await page.getByRole('button', { name: /^Submit$/ }).click();
  await expect(page.getByText(/Concise/)).toBeVisible();
  assertionSummary.push('Question gate accepted the answer.');

  await expect(page.getByRole('button', { name: /^View artifact$/ }).first()).toBeVisible();
  await page
    .getByRole('button', { name: /^View artifact$/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: /Simulated protocol summary/i })).toBeVisible();
  await expect(page.getByText(/Simulator answer: Concise/i)).toBeVisible();
  assertionSummary.push('Generated artifact rendered the simulator answer.');

  await page.getByRole('button', { name: /^Back$/ }).click();
  await page.getByRole('button', { name: /^Settings$/ }).click();
  await page.getByRole('button', { name: /^Diagnostics$/ }).click();
  await expect(page.getByRole('heading', { name: /^Diagnostics$/ })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('sk-openkit');
  assertionSummary.push('Diagnostics rendered without raw secret markers.');

  await testInfo.attach('assertion-summary', {
    body: assertionSummary.join('\n'),
    contentType: 'text/plain',
  });
});

/**
 * Creates a minimal disposable git repository marker inside the story data root.
 *
 * @param dataRoot Temporary story data root.
 * @returns Absolute path to the disposable repository fixture.
 */
function createStoryRepository(dataRoot: string): string {
  const repositoryPath = join(dataRoot, 'story-repository');

  mkdirSync(join(repositoryPath, '.git'), { recursive: true });

  return repositoryPath;
}

/**
 * Finds one workspace id by display name through the public Core API.
 *
 * @param coreUrl Base URL for the NanoCore API.
 * @param workspaceName Workspace name to find.
 * @returns Matching workspace id.
 * @throws Error when the workspace list cannot be read or the workspace is absent.
 */
async function findWorkspaceId(coreUrl: string, workspaceName: string): Promise<string> {
  const response = await fetch(`${coreUrl}/api/workspaces`);

  if (!response.ok) {
    throw new Error(`Could not list workspaces: ${response.status}.`);
  }

  const payload = (await response.json()) as StoryWorkspaceListResponse;
  const workspace = payload.items.find((item) => item.name === workspaceName);

  if (!workspace) {
    throw new Error(`Workspace ${workspaceName} was not listed by NanoCore.`);
  }

  return workspace.id;
}

/**
 * Links the default repository resource for one workspace through the App API setup route.
 *
 * @param coreUrl Base URL for the NanoCore API.
 * @param workspaceId Workspace id that owns the repository.
 * @param repositoryPath Absolute path to the disposable repository fixture.
 * @returns Resolves after the repository is linked.
 * @throws Error when repository linking fails.
 */
async function linkDefaultRepository(
  coreUrl: string,
  workspaceId: string,
  repositoryPath: string
): Promise<void> {
  const response = await fetch(
    `${coreUrl}/api/app/workspaces/${encodeURIComponent(workspaceId)}/repositories/default`,
    {
      body: JSON.stringify({
        displayName: 'Story repository',
        localPath: repositoryPath,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }
  );

  if (!response.ok) {
    throw new Error(`Could not link story repository: ${response.status}.`);
  }
}
