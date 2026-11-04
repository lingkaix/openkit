import { expect, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

/**
 * Desktop initial navigation for Knowledge.
 * The viewport is set before the first document load. Width stays at or above the
 * 800px persistent sidebar. The 360px initial opening belongs to the phone acceptance.
 */

const TITLE = 'Desk catalog page';
const BODY = 'Desktop acceptance keeps this page in the notebook.';
const SUMMARY = 'Archive the desktop acceptance page.';

let stack: IsolatedWebStack | null = null;

test.afterEach(async () => {
  const current = stack;
  stack = null;
  if (current) await current.stop();
});

test('publishes a structured Knowledge page from the desktop sidebar', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  await page.goto(stack.webUrl);
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();

  const navigation = page.getByRole('navigation', { name: 'Primary workspace navigation' });
  await expect(navigation).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
  await navigation.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Maintain', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false'
  );

  const add = page.getByRole('button', { name: 'Add knowledge', exact: true });
  await expect(add).toBeEnabled();
  await add.click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(TITLE);
  await page.getByRole('textbox', { name: 'Content', exact: true }).fill(BODY);
  await page.getByRole('button', { name: /Page state/ }).click();
  await page.getByRole('option', { name: 'Draft — not retrieved by default', exact: true }).click();

  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/knowledge.notebook.create' &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const createResponse = await created;
  expect(createResponse.status()).toBe(200);
  const createdPage = createResponse.request().postDataJSON() as { content?: string };
  expect(createdPage.content).toContain('schema_version: openkit-scope-knowledge-schema-v4');
  expect(createdPage.content).toContain('openkit_status: draft');
  expect(createdPage.content).toContain('type: KnowledgePage');

  const pages = page.getByRole('list', { name: 'Pages' });
  await expect(pages.getByRole('button', { name: TITLE, exact: true })).toBeVisible();
  await expect(pages.getByText('State: draft', { exact: true })).toBeVisible();
  await expect(page.getByText('Content digest:', { exact: false })).toHaveCount(0);
  await expect(page.getByText('Type: KnowledgePage', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: `Details for ${TITLE}`, exact: true }).click();
  const pathLine = page.getByText(/^notes\/.+\.md$/);
  await expect(pathLine).toBeVisible();
  const path = (await pathLine.textContent())?.trim() ?? '';
  expect(path).toMatch(/^notes\/.+\.md$/);
  await expect(page.getByText('Type: KnowledgePage', { exact: true })).toBeVisible();
  await expect(page.getByText('Content digest:', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: `Edit ${TITLE}`, exact: true }).click();
  await page.getByRole('button', { name: /Page state/ }).click();
  await page
    .getByRole('option', { name: 'Archived — kept, not retrieved by default', exact: true })
    .click();
  const archived = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/knowledge.notebook.update' &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const archivedResponse = await archived;
  expect(archivedResponse.status()).toBe(200);
  const archivedPage = archivedResponse.request().postDataJSON() as {
    changes?: Array<{ content?: string }>;
    summary?: string;
  };
  expect(archivedPage.summary).toBe(`Edit ${path}`);
  expect(archivedPage.changes?.[0]?.content).toContain('openkit_status: archived');
  expect(archivedPage.changes?.[0]?.content).toContain('status: deprecated');
  await expect(pages.getByText('State: archived', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Notebook history', exact: true }).click();
  const revision = page.getByRole('radio', { name: `Create ${path}`, exact: true });
  // The revision card text covers the native input's center. A person selects the card.
  await revision.locator('xpath=ancestor::label[1]').click();
  await expect(revision).toBeChecked();
  const editCurrent = page.getByRole('button', { name: `Edit current ${path}`, exact: true });
  await expect(editCurrent).toBeVisible();
  await editCurrent.click();
  await expect(page.getByRole('region', { name: `Edit ${path}` })).toBeVisible();
  await page.getByRole('button', { name: /Page state/ }).click();
  await page
    .getByRole('option', { name: 'Superseded — replaced by another page', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Edit summary', exact: true }).fill(SUMMARY);
  const superseded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/knowledge.notebook.update' &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Apply page edit', exact: true }).click();
  const supersededResponse = await superseded;
  expect(supersededResponse.status()).toBe(200);
  const published = supersededResponse.request().postDataJSON() as {
    changes?: Array<{ content?: string }>;
    summary?: string;
  };
  expect(published.summary).toBe(SUMMARY);
  expect(published.changes?.[0]?.content).toContain('openkit_status: superseded');
  expect(published.changes?.[0]?.content).toContain('status: deprecated');
  await expect(
    page.getByText('Page was published in a new revision.', { exact: true })
  ).toBeVisible();
  await expect(pages.getByText('State: superseded', { exact: true })).toBeVisible();

  await pages.getByRole('button', { name: TITLE, exact: true }).click();
  await expect(page.getByRole('article', { name: 'Preview' })).toBeVisible();
  await expect(pages).toBeVisible();
  await expect(page.getByRole('heading', { name: TITLE, exact: true })).toBeVisible();

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(
    page.getByRole('navigation', { name: 'Primary workspace navigation' })
  ).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
  await expect(pages.getByRole('button', { name: TITLE, exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Preview' })).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/account$/);
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Primary workspace navigation' })
    .getByRole('button', { name: 'Knowledge', exact: true })
    .click();
  await expect(
    page.getByRole('list', { name: 'Pages' }).getByRole('button', { name: TITLE, exact: true })
  ).toBeVisible();
  await expect(page.getByText('State: superseded', { exact: true })).toBeVisible();
});
