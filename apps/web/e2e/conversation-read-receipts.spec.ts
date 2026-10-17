import { createCoreClient } from '@openkit/core-client';
import { expect, test } from '@playwright/test';
import { startIsolatedWebStack } from './_lib/servers.js';

/** Real API reads do not mark a reply read; its displayed body does, and Core retains that receipt. */
test('records an actually displayed reply and retains it after Core restart', async ({ page }) => {
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });

  try {
    const { items: workspaces } = await client.operations['workspace.list']({});
    const workspace = workspaces[0]?.workspace;
    if (!workspace) throw new Error('The isolated simulator has no accessible Workspace.');
    const workspaceId = workspace.id;
    const thread = await client.operations['thread.create']({
      workspaceId,
      name: 'Read receipt browser proof',
      visibility: 'workspace',
    });
    const selector = { workspaceId, threadId: thread.id };
    const turn = await client.operations['turn.start']({
      ...selector,
      agentId: 'agent_codex_host',
      modelId: 'reasoning',
      input: 'Prepare the deterministic simulator reply for the read receipt check.',
    });
    await expect
      .poll(
        async () => {
          const { items } = await client.operations['thread.items'](selector);
          return items.some(
            (item) =>
              item.turnId === turn.id &&
              item.type === 'assistant-message' &&
              item.status === 'completed' &&
              item.text.trim().length > 0
          );
        },
        { timeout: 20_000, message: 'The simulator must publish a completed assistant body.' }
      )
      .toBe(true);
    const { items } = await client.operations['thread.items'](selector);
    const message = items.find(
      (item) =>
        item.turnId === turn.id && item.type === 'assistant-message' && item.status === 'completed'
    );
    if (!message || message.type !== 'assistant-message') {
      throw new Error('The completed simulator assistant message is missing.');
    }

    // Fetch every existing Thread projection while the browser has displayed no message body.
    const [, , navigation] = await Promise.all([
      client.operations['thread.items'](selector),
      client.operations['thread.dashboard'](selector),
      client.operations['conversation.navigation']({ workspaceId }),
      client.operations['thread.read-state'](selector),
    ]);
    expect(navigation.items.find((item) => item.thread.id === thread.id)?.unreadCount).toBe(1);
    expect(await client.operations['thread.read-state'](selector)).toEqual({
      readItemIds: [],
      unreadItemIds: [message.id],
    });

    let displayedItemIds: unknown;
    page.on('request', (request) => {
      if (
        request.method() !== 'POST' ||
        new URL(request.url()).pathname !== '/api/app/operations/thread.mark-read'
      )
        return;
      const input = request.postDataJSON();
      if (input.workspaceId === workspaceId && input.threadId === thread.id) {
        displayedItemIds = input.itemIds;
      }
    });
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto(`${stack.webUrl}/chat/${workspaceId}/${thread.id}`);
    await page.bringToFront();
    const body = page.getByRole('article').getByText(message.text, { exact: true });
    await expect(body).toBeVisible();
    // Receipt refresh can replace the body; the viewport assertion retries the current locator.
    await expect(body).toBeInViewport();
    await expect.poll(() => displayedItemIds).toEqual([message.id]);
    const readState = { readItemIds: [message.id], unreadItemIds: [] };
    await expect.poll(() => client.operations['thread.read-state'](selector)).toEqual(readState);

    // Leave the body before restart so a second display cannot hide lost server persistence.
    await page.goto('about:blank');
    await stack.restartCore();
    expect(await client.operations['thread.read-state'](selector)).toEqual(readState);
  } finally {
    await stack.stop();
  }
});
