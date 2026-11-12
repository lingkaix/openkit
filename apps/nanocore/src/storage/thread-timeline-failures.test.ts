import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, type ItemStatus } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { openWorkspaceDb } from './db.js';
import * as immutableBodies from './immutable-content-read.js';

const roots: string[] = [];
const time = '2026-11-12T05:20:00.000Z';
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

/** Creates retained state only through its real owner, then reads the public timeline operation. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'timeline-failures-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Recorded failures');
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const turn = await store.createTurn(
    DEMO_WORKSPACE_ID,
    thread.id,
    'Inspect recorded failures',
    actor
  );
  const app = createAppWithWorkspaceAuthority({ store, dataRoot: root });
  const selector = { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id };
  const base = {
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    status: 'completed' as const,
    createdAt: time,
    completedAt: time,
  };
  const bodyForbidden = new Set<string>();
  const actual = store.readThreadTimelineSnapshot.bind(store);
  vi.spyOn(store, 'readThreadTimelineSnapshot').mockImplementation((workspaceId, threadId, read) =>
    actual(workspaceId, threadId, (snapshot) =>
      read(
        new Proxy(snapshot, {
          get(target, key, receiver) {
            if (key === 'item')
              return (id: string) => {
                expect(bodyForbidden.has(id), `Statistics must not read step body ${id}`).toBe(
                  false
                );
                return target.item(id);
              };
            if (key === 'revision')
              return (turnId: string, id: string, revision: number) => {
                expect(bodyForbidden.has(id), `Statistics must not read step revision ${id}`).toBe(
                  false
                );
                return target.revision(turnId, id, revision);
              };
            if (key === 'revisions')
              return (turnId: string, after: number, limit: number) => {
                const entries = target.revisions(turnId, after, limit);
                for (const entry of entries)
                  if (entry.item) expect(bodyForbidden.has(entry.item.id)).toBe(false);
                return entries;
              };
            return Reflect.get(target, key, receiver);
          },
        })
      )
    )
  );
  async function operation(name: string, input: Record<string, unknown> = {}) {
    const response = await app.request(`/api/app/operations/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...selector, ...input }),
    });
    const text = await response.text();
    expect(response.status, `${name}: ${text}`).toBe(200);
    return JSON.parse(text);
  }
  async function read(beforeTimeline?: () => void) {
    // Digest legitimately reads post-B revisions. Put B after all fixture steps to isolate statistics IO.
    const boundary = await store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'assistant-message',
      text: 'Displayed after the recorded steps',
    });
    await operation('thread.mark-read', { itemIds: [boundary.id] });
    beforeTimeline?.();
    const body = await operation('thread.timeline');
    expect(body.catchUpAnchor).toEqual({ turnId: turn.id, itemId: boundary.id });
    const run = body.runs.find((row: { id: string }) => row.id === turn.id);
    expect(run).toBeDefined();
    return run.statistics;
  }
  async function command(
    status: ItemStatus,
    exitCode: number | null,
    output = 'Recorded command output'
  ) {
    const item = await store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'command-execution',
      status,
      command: 'fixture command',
      cwd: '.',
      output,
      exitCode,
      durationMs: 1,
      completedAt: status === 'in_progress' ? null : time,
    });
    bodyForbidden.add(item.id);
    return item;
  }
  async function tool(status: ItemStatus, error: string | null) {
    const item = await store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'tool-call',
      status,
      tool: 'fixture.read',
      server: null,
      arguments: {},
      result: 'Recorded result; effect certainty is not inferred',
      error,
      durationMs: 1,
      completedAt: status === 'in_progress' ? null : time,
    });
    bodyForbidden.add(item.id);
    return item;
  }
  return { root, store, thread, turn, base, read, command, tool, bodyForbidden };
}

describe('Timeline recorded failure statistics', () => {
  // Owner: Conversation Timeline, Run Entries summary; Claims, Evidence And Judgement; U7 folds.
  it('requires exact zero counts when no failed step is recorded', async () => {
    const f = await fixture();
    expect(await f.read()).toMatchObject({ failedStepCount: 0, failedCommandCount: 0 });
  });

  it('counts recorded command and tool failures once, without inferring failure from unknown or unfinished work', async () => {
    const f = await fixture();
    const commands: Array<[ItemStatus, number | null, number]> = [
      ['failed', null, 1],
      ['completed', 7, 1],
      ['failed', 2, 1],
      ['completed', 0, 0],
      ['completed', null, 0],
      ['in_progress', null, 0],
      ['declined', null, 0],
    ];
    let failedCommands = 0;
    let failedSteps = 0;
    for (const [status, exitCode, failure] of commands) {
      await f.command(status, exitCode);
      failedCommands += failure;
      failedSteps += failure;
      expect(await f.read()).toMatchObject({
        failedStepCount: failedSteps,
        failedCommandCount: failedCommands,
      });
    }
    const tools: Array<[ItemStatus, string | null, number]> = [
      ['failed', null, 1],
      ['completed', 'Recorded tool error', 1],
      ['failed', 'Same failure, not a second one', 1],
      ['completed', '', 0],
      ['completed', null, 0],
      ['in_progress', null, 0],
      ['declined', null, 0],
    ];
    for (const [status, error, failure] of tools) {
      await f.tool(status, error);
      failedSteps += failure;
      expect(await f.read()).toMatchObject({ failedStepCount: failedSteps, failedCommandCount: 3 });
    }
    expect(await f.read()).toMatchObject({ failedStepCount: 6, failedCommandCount: 3 });
  });

  it('includes safe failed steps but excludes protected Knowledge and narrative Items from the aggregate', async () => {
    const f = await fixture();
    const reasoning = await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'reasoning',
      status: 'failed',
      summary: ['Recorded failed reasoning step'],
      content: [],
    });
    const file = await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'file-change',
      status: 'failed',
      path: 'result.txt',
      changeKind: 'modified',
    });
    f.bodyForbidden.add(reasoning.id);
    f.bodyForbidden.add(file.id);
    expect(await f.read()).toMatchObject({ failedStepCount: 2, failedCommandCount: 0 });
    const knowledge = await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'knowledge-injection',
      status: 'failed',
      summary: 'Protected source',
      knowledgeEntryIds: [],
      policySummary: null,
    });
    f.bodyForbidden.add(knowledge.id);
    await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'assistant-message',
      status: 'failed',
      text: 'A narrative failure is not a step',
    });
    await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'status',
      status: 'failed',
      level: 'error',
      title: 'Narrative error',
      summary: null,
    });
    expect(await f.read()).toMatchObject({
      failedStepCount: 2,
      failedCommandCount: 0,
      coverage: 'partial',
    });
  });

  it('uses only current revisions and removes a failure when the original Item succeeds', async () => {
    const f = await fixture();
    const command = await f.command('failed', 1);
    const tool = await f.tool('completed', 'Original error');
    expect(await f.read()).toMatchObject({ failedStepCount: 2, failedCommandCount: 1 });
    await f.store.updateItem(command.id, { output: 'Revised output; same recorded failure' });
    await f.store.updateItem(tool.id, { result: 'Revised diagnostic; same recorded error' });
    expect(await f.read()).toMatchObject({ failedStepCount: 2, failedCommandCount: 1 });
    await f.store.updateItem(command.id, { status: 'completed', exitCode: 0 });
    expect(await f.read()).toMatchObject({ failedStepCount: 1, failedCommandCount: 0 });
    await f.store.updateItem(tool.id, { status: 'completed', error: null });
    expect(await f.read()).toMatchObject({ failedStepCount: 0, failedCommandCount: 0 });
    await f.store.updateItem(command.id, { status: 'completed', exitCode: 9 });
    expect(await f.read()).toMatchObject({ failedStepCount: 1, failedCommandCount: 1 });
  });

  it('counts a file-backed command without reading its large output or any complete history at timeline time', async () => {
    const f = await fixture();
    const command = await f.command('completed', 1, 'Large recorded output. '.repeat(30_000));
    const db = openWorkspaceDb(f.root, DEMO_WORKSPACE_ID);
    let commandDigest: string;
    try {
      const row = db.sqlite
        .prepare(
          "SELECT content_json FROM control_product_entries WHERE kind='item' AND id=? AND revision=1"
        )
        .get(command.id) as { content_json: string };
      const descriptor = JSON.parse(row.content_json);
      expect(descriptor.reference.representation).not.toBe('inline');
      commandDigest = descriptor.reference.contentDigest;
    } finally {
      db.sqlite.close();
    }
    const statistics = await f.read(() => {
      const actualRead = immutableBodies.readImmutableContentBytes;
      vi.spyOn(immutableBodies, 'readImmutableContentBytes').mockImplementation(
        (mount, owner, content, cap) => {
          expect(
            (content.reference as { contentDigest: string }).contentDigest,
            'Statistics must not read the immutable command file'
          ).not.toBe(commandDigest);
          return actualRead(mount, owner, content, cap);
        }
      );
      for (const name of [
        'listThreadTurns',
        'listThreadItems',
        'listThreads',
        'listArtifacts',
        'listCommandRequests',
      ] as const) {
        vi.spyOn(f.store, name).mockImplementation(() => {
          throw new Error(`Timeline statistics must not census ${name}`);
        });
      }
    });
    expect(statistics).toMatchObject({ failedStepCount: 1, failedCommandCount: 1 });
  });
});
