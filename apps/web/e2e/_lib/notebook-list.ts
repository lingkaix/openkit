import type { Page, Response } from '@playwright/test';

/** The notebook list read that contains the page bytes just published. */
export function waitForSupersededNotebookList(page: Page): Promise<Response> {
  return page.waitForResponse(async (response) => {
    if (
      response.request().method() !== 'POST' ||
      new URL(response.url()).pathname !== '/api/app/operations/knowledge.notebook.list' ||
      !response.ok()
    )
      return false;
    return (await response.text()).includes('openkit_status: superseded');
  });
}
