import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductSseEventEnvelopeSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { nativeProductScope } from './workspace-file-records.js';

it('returns one owner-authored error across timeline, dashboard, detail and replayed SSE without changing retained error bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'turn-error-projection-'));
  try {
    const store = await createDemoStore({ dataRoot: root });
    const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Recorded failure');
    const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Run selected work', {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    });
    const failed = await store.completeTurn(turn.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: {
        code: 'provider_call_failed',
        message: 'The provider stopped after earlier work may have succeeded.',
      },
    });
    const event = await store.persistTurnEvent(turn.id, {
      event: 'turn.completed',
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'turn-completed', stopReason: 'error', turn: failed },
    });
    const scope = nativeProductScope(root, turn.owner);
    const sqlite = new Database(scope.path, { readonly: true });
    const retained = () =>
      sqlite.prepare('SELECT record_json FROM control_turns WHERE id=?').get(turn.id);
    try {
      const original = retained();
      const app = createAppWithWorkspaceAuthority({ store, dataRoot: root });
      const input = { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id };
      const read = async (operation: string, body: Record<string, unknown> = input) => {
        const response = await app.request(`/api/app/operations/${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      const timeline = await read('thread.timeline');
      const dashboard = await read('thread.dashboard');
      const detail = await read('turn.read', { ...input, turnId: turn.id });
      const expected = {
        class: 'system',
        summary: 'OpenKit could not finish this run because a system operation failed.',
        actions: [
          {
            kind: 'inspect',
            owner: 'turn',
            operation: 'turn.read',
            input: { ...input, turnId: turn.id },
          },
        ],
      };
      expect(timeline.runs[0].error.presentation).toEqual(expected);
      expect(dashboard.turns[0].error.presentation).toEqual(expected);
      expect(detail.error.presentation).toEqual(expected);
      const response = await app.request(
        `/api/workspaces/${DEMO_WORKSPACE_ID}/threads/${thread.id}/events?turnId=${turn.id}&since=${event.sequence - 1}`
      );
      expect(response.status).toBe(200);
      const frames = (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => ProductSseEventEnvelopeSchema.parse(JSON.parse(line.slice(6))));
      expect(frames).toHaveLength(1);
      expect(frames[0]!.data).toMatchObject({
        type: 'turn-completed',
        turn: { error: { presentation: expected } },
      });
      expect(retained()).toEqual(original);
      expect(JSON.stringify(original)).not.toContain('presentation');
      expect(Buffer.byteLength(JSON.stringify(dashboard))).toBeLessThanOrEqual(32768);
      expect(Buffer.byteLength(JSON.stringify(timeline))).toBeLessThanOrEqual(262144);
    } finally {
      sqlite.close();
    }
  } finally {
    await disposeTestStore(root);
  }
});
