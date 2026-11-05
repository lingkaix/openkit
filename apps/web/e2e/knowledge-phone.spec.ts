import { expect, test } from '@playwright/test';
import { type IsolatedWebStack, startIsolatedWebStack } from './_lib/servers.js';

/**
 * Phone Knowledge acceptance starts at 360 by 800 before the first navigation.
 * The desktop spec opens at 1280 and is not part of this run.
 * The phone sections bar is the navigation. The page catalog is the Pages list.
 * Version comparison is the labelled diff regions. This screen has no table.
 */

const TITLE = 'Phone catalog page';
const BODY = 'Phone acceptance keeps this page in the notebook.';
const SUMMARY = 'Publish the phone acceptance page.';

let stack: IsolatedWebStack | null = null;

test.use({ viewport: { width: 360, height: 800 } });

test.afterEach(async () => {
  const current = stack;
  stack = null;
  if (current) await current.stop();
});

test('reviews a structured Knowledge page from the phone sections bar', async ({ page }) => {
  test.setTimeout(120_000);
  expect(page.viewportSize()).toEqual({ width: 360, height: 800 });
  stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  let creates = 0;
  let updates = 0;
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/app/operations/knowledge.notebook.create') creates += 1;
    if (pathname === '/api/app/operations/knowledge.notebook.update') updates += 1;
  });

  await page.goto(stack.webUrl);
  await expect(page.getByRole('main', { name: 'Workspace' })).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Sections', exact: true });
  await expect(sections).toBeVisible();
  await expect(sections.getByRole('button', { name: 'Knowledge', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary workspace navigation' })).toHaveCount(
    0
  );
  await sections.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Maintain', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false'
  );

  const add = page.getByRole('button', { name: 'Add knowledge', exact: true });
  await expect(add).toBeEnabled();
  await add.click();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  expect(creates).toBe(0);
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(TITLE);
  await page.getByRole('textbox', { name: 'Content', exact: true }).fill(BODY);
  await page.getByRole('button', { name: /Page state/ }).click();
  await page.getByRole('option', { name: 'Draft — not retrieved by default', exact: true }).click();
  await expect(save).toBeEnabled();

  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/knowledge.notebook.create' &&
      response.request().method() === 'POST'
  );
  await save.click();
  const createResponse = await created;
  expect(createResponse.status()).toBe(200);
  expect(creates).toBe(1);
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

  await pages.getByRole('button', { name: TITLE, exact: true }).click();
  await expect(page.getByRole('article', { name: 'Preview' })).toBeVisible();
  await expect(page.getByRole('heading', { name: TITLE, exact: true })).toBeVisible();
  await expect(pages).toBeHidden();
  const back = page.getByRole('button', { name: 'Back', exact: true });
  await expect(back).toBeVisible();
  await back.click();
  await expect(pages).toBeVisible();
  await expect(page.getByRole('article', { name: 'Preview' })).toHaveCount(0);
  await expect(pages.getByRole('button', { name: TITLE, exact: true })).toBeVisible();

  await page.getByRole('button', { name: `Edit ${TITLE}`, exact: true }).click();
  const saveChanges = page.getByRole('button', { name: 'Save changes', exact: true });
  await expect(saveChanges).toBeDisabled();
  expect(updates).toBe(0);
  await page.getByRole('button', { name: /Page state/ }).click();
  await page
    .getByRole('option', { name: 'Archived — kept, not retrieved by default', exact: true })
    .click();
  await expect(saveChanges).toBeEnabled();
  const archived = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/knowledge.notebook.update' &&
      response.request().method() === 'POST'
  );
  await saveChanges.click();
  const archivedResponse = await archived;
  expect(archivedResponse.status()).toBe(200);
  expect(updates).toBe(1);
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
  await expect(page.getByRole('region', { name: `Current ${path}` })).toBeVisible();
  await expect(page.getByRole('region', { name: `Historical ${path}` })).toBeVisible();
  const editCurrent = page.getByRole('button', { name: `Edit current ${path}`, exact: true });
  await expect(editCurrent).toBeVisible();
  await editCurrent.click();
  const editor = page.getByRole('region', { name: `Edit ${path}` });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('textbox', { name: 'Page text/Markdown' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Current page text' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Edited page text' })).toBeVisible();
  const apply = page.getByRole('button', { name: 'Apply page edit', exact: true });
  await expect(apply).toBeDisabled();
  expect(updates).toBe(1);
  await editor.getByRole('button', { name: /Page state/ }).click();
  await page
    .getByRole('option', { name: 'Superseded — replaced by another page', exact: true })
    .click();
  await expect(apply).toBeDisabled();
  await page.getByRole('textbox', { name: 'Edit summary', exact: true }).fill(SUMMARY);
  await expect(apply).toBeEnabled();
  const superseded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/app/operations/knowledge.notebook.update' &&
      response.request().method() === 'POST'
  );
  await apply.click();
  const supersededResponse = await superseded;
  expect(supersededResponse.status()).toBe(200);
  expect(updates).toBe(2);
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
  await expect(pages).toBeHidden();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(pages).toBeVisible();

  await page.getByRole('button', { name: `Remove ${TITLE}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove knowledge' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(pages.getByRole('button', { name: TITLE, exact: true })).toBeVisible();
  expect(creates).toBe(1);
  expect(updates).toBe(2);

  await sections.getByRole('button', { name: 'Work', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New Task', exact: true })).toBeVisible();
  await sections.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Pages' }).getByRole('button', { name: TITLE, exact: true })
  ).toBeVisible();
  await expect(page.getByText('State: superseded', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary workspace navigation' })).toHaveCount(
    0
  );
  expect(page.viewportSize()).toEqual({ width: 360, height: 800 });
});
