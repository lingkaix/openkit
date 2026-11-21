import { createCoreClient, createRequestId } from '@openkit/core-client';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';
import { FIXTURE_ASSISTANT_ANSWER } from './_lib/simulator-inference.js';

test('the local owner can submit and reopen an Assistant reply in Personal and shared Workspaces', async ({
  page,
}) => {
  const stack = await startIsolatedWebStack({ mode: 'local', withAssistant: true });
  try {
    const client = createCoreClient({ baseUrl: stack.coreUrl });
    const { items } = await client.operations['workspace.list']({});
    const personal = items.find(({ workspace }) => workspace.kind === 'personal')!.workspace;
    const shared = items.find(({ workspace }) => workspace.kind !== 'personal')!.workspace;
    for (const { id: workspaceId, kind } of [personal, shared]) {
      const thread = await client.operations['thread.create']({
        workspaceId,
        name: 'Private Assistant',
        requestId: createRequestId(),
      });
      expect(thread.visibility).toBe('private');

      await page.goto(`${stack.webUrl}/chat/${workspaceId}/${thread.id}`);
      await page.getByRole('textbox', { name: 'Message' }).fill('Please reply to this message.');
      const submit = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/app/operations/conversation.submit' &&
          response.request().method() === 'POST'
      );
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const response = await submit;
      expect(response.status(), `${kind}: ${await response.text()}`).toBe(200);
      expect(await response.json()).toMatchObject({
        outcome: 'answered',
        turn: { status: 'completed' },
        item: { type: 'assistant-message', text: FIXTURE_ASSISTANT_ANSWER },
      });

      // Reopen the Timeline to verify the reply comes from retained history.
      await page.reload();
      await expect(page.getByText(FIXTURE_ASSISTANT_ANSWER, { exact: true })).toBeVisible();
    }
  } finally {
    await stack.stop();
  }
});
