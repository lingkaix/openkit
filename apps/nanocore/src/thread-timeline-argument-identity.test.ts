import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, type Item } from '@openkit/protocol';
import { afterEach, expect, it } from 'vitest';
import { createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from './test-support/local-user.js';
import { disposeTestStore } from './test-support/store.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

/** Publish original arguments through Store, then read the admitted public step window. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'timeline-arguments-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Exact arguments');
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Inspect repeated calls', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  const app = createAppWithWorkspaceAuthority({ store, dataRoot: root });
  const base = {
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    status: 'completed' as const,
    createdAt: '2026-11-12T20:00:00.000Z',
    completedAt: '2026-11-12T20:00:00.000Z',
  };
  const tool = (args: Record<string, unknown> | null, extra = {}) =>
    store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'tool-call',
      tool: 'inspect',
      server: 'ci',
      arguments: args,
      result: 'Same visible result',
      error: null,
      durationMs: 1,
      ...extra,
    });
  const command = (command: string, cwd = '.') =>
    store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'command-execution',
      command,
      cwd,
      output: 'Same visible output',
      exitCode: 0,
      durationMs: 1,
    });
  const read = async (input = {}) => {
    const response = await app.request('/api/app/operations/thread.timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: thread.id,
        view: 'items',
        turnId: turn.id,
        placement: 'step',
        ...input,
      }),
    });
    return { response, body: await response.json() };
  };
  return { store, thread, turn, base, tool, command, read };
}

it('R3/R4 identifies complete arguments, not equal output previews or object key order', async () => {
  const f = await fixture();
  const payload = 'x'.repeat(20_000);
  const first = await f.tool({ payload, nested: { b: 2, a: 1 } });
  const same = await f.tool(
    { nested: { a: 1, b: 2 }, payload },
    { status: 'failed', error: 'failed' }
  );
  const different = await f.tool({ payload: `${payload}different`, nested: { a: 1, b: 2 } });
  const otherTool = await f.tool({ payload, nested: { b: 2, a: 1 } }, { tool: 'other' });
  const otherServer = await f.tool({ payload, nested: { b: 2, a: 1 } }, { server: 'other' });
  const { response, body } = await f.read();
  expect(response.status).toBe(200);
  const row = (item: Item) => body.items.find((value: { id: string }) => value.id === item.id);
  const digest = row(first).argumentDigest;
  expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(row(same).argumentDigest).toBe(digest);
  for (const item of [different, otherTool, otherServer])
    expect(row(item).argumentDigest).not.toBe(digest);
  expect(row(first).detail).toEqual(row(different).detail);
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(262144);
});

it('R4 includes the complete recorded command and working directory, never its output', async () => {
  const f = await fixture();
  const command = `echo ${'x'.repeat(20_000)}`;
  const first = await f.command(command);
  const same = await f.command(command);
  const different = await f.command(`${command} different`);
  const otherDirectory = await f.command(command, 'src');
  const { body } = await f.read();
  const digest = (item: Item) =>
    body.items.find((row: { id: string }) => row.id === item.id).argumentDigest;
  expect(digest(first)).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(digest(same)).toBe(digest(first));
  expect(digest(different)).not.toBe(digest(first));
  expect(digest(otherDirectory)).not.toBe(digest(first));
});

it('does not invent arguments for a missing tool body or a non-call step', async () => {
  const f = await fixture();
  const missing = await f.tool(null);
  const item = await f.store.createItem({
    ...f.base,
    id: allocateEntityId('it'),
    type: 'reasoning',
    summary: [],
    content: ['A reported thought'],
  });
  const { body } = await f.read();
  for (const id of [missing.id, item.id])
    expect(body.items.find((row: { id: string }) => row.id === id).argumentDigest).toBeNull();
});

it('does not return a digest through a foreign Thread selector', async () => {
  const f = await fixture();
  await f.tool({ privateArgument: 'not in a sibling response' });
  const sibling = await f.store.createThread(DEMO_WORKSPACE_ID, 'Sibling');
  const { response, body } = await f.read({ threadId: sibling.id });
  expect(response.status).toBe(404);
  expect(JSON.stringify(body)).not.toContain('argumentDigest');
  expect(JSON.stringify(body)).not.toContain('privateArgument');
});
