import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  answerUserInput,
  grantApproval,
  linkWorkspaceRepository,
  type NanoCoreHarness,
  readTurnEventsUntil,
  removeDataRoot,
  startNanoCoreHarness,
  startSimulatorTurn,
} from './_lib/harness.js';

let harness: NanoCoreHarness | null = null;

afterEach(async () => {
  const current = harness;
  harness = null;

  if (current) {
    await current.stop();
    await removeDataRoot(current.dataRoot);
  }
});

describe('nanocore e2e local full turn', () => {
  it('runs an internal self-check turn and persists fs and sqlite state without source imports', async () => {
    harness = await startNanoCoreHarness();

    const workspaceId = 'ws_demo';
    const threadId = 'th_demo';
    await linkWorkspaceRepository(harness.baseUrl, harness.dataRoot, workspaceId);
    const turn = await startSimulatorTurn(
      harness.baseUrl,
      workspaceId,
      threadId,
      'Run black-box e2e verification.'
    );
    const turnId = String(turn.id);

    await readTurnEventsUntil(
      harness.baseUrl,
      workspaceId,
      threadId,
      turnId,
      (event) => event.event === 'approval.requested'
    );
    await grantApproval(harness.baseUrl, workspaceId, threadId, turnId, `ap_${turnId}`);
    await readTurnEventsUntil(
      harness.baseUrl,
      workspaceId,
      threadId,
      turnId,
      (event) => event.event === 'item.completed' && event.data.type === 'item-completed'
    );
    await answerUserInput(harness.baseUrl, workspaceId, threadId, turnId, 'concise');
    const events = await readTurnEventsUntil(
      harness.baseUrl,
      workspaceId,
      threadId,
      turnId,
      (event) => event.event === 'turn.completed'
    );

    expect(events.some((event) => event.event === 'turn.completed')).toBe(true);

    const workspaceRoot = join(harness.dataRoot, 'users', 'user_local', 'workspaces', workspaceId);
    const turnRoot = join(workspaceRoot, 'threads', threadId, 'turns', turnId);
    const itemsLog = readFileSync(join(turnRoot, 'items.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(statSync(join(workspaceRoot, 'workspace.json')).isFile()).toBe(true);
    expect(statSync(join(workspaceRoot, 'threads', threadId, 'thread.json')).isFile()).toBe(true);
    expect(statSync(join(turnRoot, 'turn.json')).isFile()).toBe(true);
    expect(itemsLog.some((item) => item.type === 'artifact-reference')).toBe(true);

    const sqlite = new Database(join(harness.dataRoot, 'server', 'db', 'core.sqlite'), {
      readonly: true,
    });
    const user = sqlite.prepare('select id, kind from users where id = ?').get('user_local') as
      | { id: string; kind: string }
      | undefined;
    sqlite.close();

    expect(user).toEqual({ id: 'user_local', kind: 'local' });
  });
});
