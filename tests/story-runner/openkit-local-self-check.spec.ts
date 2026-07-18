import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  stack = await startIsolatedStoryWebStack({ mode: 'local', useSimulator: false });
  await page.goto(stack.webUrl);

  await page.getByRole('button', { name: /^New workspace$/ }).click();
  await page.getByLabel('New workspace').fill('Story Workspace');
  await page.getByRole('button', { name: /^Create workspace$/ }).click();
  await expect(page.getByRole('button', { name: 'Story Workspace' })).toBeVisible();
  assertionSummary.push('Workspace was created and displayed.');

  await page.getByLabel('New thread for Story Workspace').fill('Story thread');
  await page.getByRole('button', { name: /^New thread$/ }).click();
  await expect(page.getByRole('heading', { name: 'Story thread Dashboard' })).toBeVisible();
  assertionSummary.push('Thread dashboard was displayed.');
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
