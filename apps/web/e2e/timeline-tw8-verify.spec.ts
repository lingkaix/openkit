import { createCoreClient } from '@openkit/core-client';
import { allocateEntityId } from '@openkit/protocol';
import { expect, test } from '@playwright/test';
import { tw8Fixture } from '../src/screens/chat/timeline/tw8-verify-fixture';
import { startIsolatedWebStack } from './_lib/servers.js';

// Owner: conversation_timeline Back-links, Opening, and U12. This journey starts
// from the real Audit row and resolver, not a manually assembled destination URL.
test('R2 an audit back-link brings its historical run into view and moves keyboard focus there', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stack = await startIsolatedWebStack({ mode: 'local', useSimulator: true });
  const client = createCoreClient({ baseUrl: stack.coreUrl });
  try {
    const workspaceId = (await client.operations['workspace.list']({})).items[0]?.workspace.id;
    if (!workspaceId) throw new Error('The isolated stack has no admitted Workspace.');
    const thread = await client.operations['thread.create']({
      workspaceId,
      name: 'Historical source',
      visibility: 'workspace',
    });
    const latest = await client.operations['turn.start']({
      workspaceId,
      threadId: thread.id,
      agentId: 'agent_codex_host',
      modelId: 'reasoning',
      input: 'Reply with one short sentence.',
    });
    await expect
      .poll(
        async () => {
          const dashboard = await client.operations['thread.dashboard']({
            workspaceId,
            threadId: thread.id,
          });
          return dashboard.turns.find((run) => run.id === latest.id)?.status;
        },
        { timeout: 45_000 }
      )
      .toMatch(/completed|failed|cancelled/);
    const f = tw8Fixture(workspaceId, thread.id);
    const targetId = allocateEntityId('tu');
    const runs = Array.from({ length: 31 }, (_, index) =>
      f.run(
        index + 1,
        index === 20 ? targetId : index === 30 ? latest.id : allocateEntityId('tu'),
        index === 20
          ? 'Historical target is here'
          : index === 30
            ? 'Latest admitted run'
            : `Earlier admitted run ${index + 1}: ${'retained context '.repeat(8)}`
      )
    );
    await page.route('**/api/app/operations/thread.timeline', async (route) => {
      const input = route.request().postDataJSON() as {
        anchor?: { kind: string; turnId?: string };
      };
      await route.fulfill({
        json: f.page(runs, input.anchor?.kind === 'turn' ? { turnId: input.anchor.turnId! } : null),
      });
    });
    await page.route('**/api/app/operations/audit.workspace-list', async (route) => {
      const body = await (await route.fetch()).json();
      await route.fulfill({
        json: {
          ...body,
          auditEvents: [
            {
              id: 'aud_11111111-2222-5333-8444-555555555555',
              workspaceId,
              threadId: thread.id,
              turnId: targetId,
              category: 'artifact',
              action: 'artifact.version-commit',
              outcome: 'succeeded',
              summary: 'Historical target audit event',
              severity: 'info',
              createdAt: f.at,
            },
            ...(body.auditEvents ?? []),
          ],
        },
      });
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    // Route selection establishes the Workspace through the normal UI owner.
    await page.goto(`${stack.webUrl}/chat/${workspaceId}/${thread.id}`);
    await expect(
      page.getByRole('heading', { name: 'Historical source', exact: true })
    ).toBeVisible();
    await page.goto(`${stack.webUrl}/workspace/usage`);
    await page.getByRole('button', { name: 'Records', exact: true }).click();
    const auditRow = page.getByText('Historical target audit event', { exact: true }).locator('..');
    const source = auditRow.getByRole('link', { name: /^From: Historical source/ });
    await expect(source).toBeVisible();
    await source.click();
    const content = page.getByText('Historical target is here', { exact: true });
    await expect(content).toBeInViewport({ timeout: 10_000 });
    await expect
      .poll(
        () =>
          content.evaluate((node) => {
            const entry = node.closest('article');
            const active = document.activeElement;
            return Boolean(
              entry &&
                active &&
                active !== document.body &&
                (entry.contains(active) ||
                  (active.contains(entry) && !active.textContent?.includes('Latest admitted run')))
            );
          }),
        {
          message:
            'Keyboard focus must move to the addressed historical run, not the removed source link or page body',
        }
      )
      .toBe(true);
  } finally {
    await stack.stop();
  }
});
