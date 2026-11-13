// Storage integration fixtures exercise retained native authority through the public timeline read.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as policyKernel from '@openkit/policy-kernel';
import { allocateEntityId, type Item } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as auditOwner from '../audit-events.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { taskSteerCausation } from '../runtime/task-steer-receipt.js';
import { createApp, createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { commandRequestKey } from './command-request-records.js';
import { commandInputHash } from './control-store-input.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';

const databases: CoreDb[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.sqlite.close();
  for (const root of roots.splice(0)) await disposeTestStore(root);
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'thread-timeline-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const thread = await store.createThread(
    DEMO_WORKSPACE_ID,
    'Timeline',
    undefined,
    'conversation',
    { visibility: 'workspace' }
  );
  const app = createAppWithWorkspaceAuthority({ store, dataRoot: root });
  const coreDb = openCoreDb(root);
  databases.push(coreDb);
  const selector = { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id };
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Timeline input', actor);
  const message = (text: string) =>
    store.createItem({
      id: allocateEntityId('it'),
      owner: { kind: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text,
      createdAt: '2026-11-08T16:00:00.000Z',
      completedAt: '2026-11-08T16:00:00.000Z',
    });
  async function read(input: Record<string, unknown> = {}) {
    const response = await app.request('/api/app/operations/thread.timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...selector, ...input }),
    });
    return { response, body: await response.json() };
  }
  return { app, store, coreDb, root, thread, turn, selector, actor, message, read };
}

describe('Thread timeline windows', () => {
  it('anchors inside a running run and pages original Item positions without moving revised or appended Items', async () => {
    const f = await fixture();
    const messages: Item[] = [];
    for (let i = 0; i < 115; i++) messages.push(await f.message(`Note ${i}`));
    const anchored = await f.read({ anchor: { kind: 'item', itemId: messages[60]!.id } });
    expect(anchored.response.status).toBe(200);
    expect(anchored.body.anchor).toEqual({ turnId: f.turn.id, itemId: messages[60]!.id });
    expect(
      anchored.body.itemWindow.items.some((item: { id: string }) => item.id === messages[60]!.id)
    ).toBe(true);
    const first = await f.read({ view: 'items', turnId: f.turn.id, limit: 50 });
    expect(first.response.status).toBe(200);
    const before = first.body.items.map((item: { id: string }) => item.id);
    await f.store.updateItem(messages[0]!.id, { text: 'Revised note' });
    const appended = await f.message('Appended after the first page');
    const second = await f.read({ cursor: first.body.afterCursor });
    expect(second.response.status).toBe(200);
    expect(second.body.items.some((item: { id: string }) => before.includes(item.id))).toBe(false);
    expect(second.body.items.some((item: { id: string }) => item.id === appended.id)).toBe(false);
    const backwards = await f.read({ cursor: second.body.beforeCursor });
    expect(backwards.body.items.map((item: { id: string }) => item.id)).toEqual(before);
    expect(backwards.body.items[0].detail.value.text).toBe('Revised note');
    const other = await f.store.createThread(f.selector.workspaceId, 'Other cursor audience');
    const foreignCursor = await f.read({ threadId: other.id, cursor: first.body.afterCursor });
    expect(foreignCursor.response.status).toBe(400);
  });

  it('carries the current latest plan and three latest notes while keeping steps in their own window', async () => {
    const f = await fixture();
    const notes: Item[] = [];
    for (let index = 0; index < 5; index++) notes.push(await f.message(`Progress ${index}`));
    const base = {
      owner: f.turn.owner,
      threadId: f.thread.id,
      turnId: f.turn.id,
      status: 'completed' as const,
      createdAt: '2026-11-08T17:00:00.000Z',
      completedAt: '2026-11-08T17:00:00.000Z',
    };
    await f.store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'plan',
      title: 'Old plan',
      summary: null,
      steps: [],
    });
    const plan = await f.store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'plan',
      title: 'Latest plan',
      summary: null,
      steps: [{ id: 'step-1', title: 'Verify the fix', status: 'in_progress' }],
    });
    await f.store.updateItem(plan.id, { title: 'Current latest plan' });
    const step = await f.store.createItem({
      ...base,
      id: allocateEntityId('it'),
      type: 'file-change',
      path: 'result.txt',
      changeKind: 'modified',
    });
    const result = await f.read();
    expect(result.response.status).toBe(200);
    const run = result.body.runs[0];
    expect(run.plan.detail.value.title).toBe('Current latest plan');
    expect(run.noteItemIds).toEqual(notes.slice(-3).map((item) => item.id));
    expect(run.finalItemId).toBeNull();
    expect(
      run.narrative.every((item: { placement: string }) => item.placement === 'narrative')
    ).toBe(true);
    expect(run.statistics).toMatchObject({ steps: 1, filesChanged: 1, messages: 5 });
    const items = await f.read({ view: 'items', turnId: f.turn.id, placement: 'step' });
    expect(items.body.items.map((item: { id: string }) => item.id)).toEqual([step.id]);
  });

  it('returns an exact bounded UTF-8 tail for a file-backed command output', async () => {
    const f = await fixture();
    const output = `Beginning ${'x'.repeat(262_144)} final 🙂`;
    const item = await f.store.createItem({
      id: allocateEntityId('it'),
      owner: f.turn.owner,
      threadId: f.thread.id,
      turnId: f.turn.id,
      type: 'command-execution',
      command: 'fixture command',
      cwd: '.',
      output,
      exitCode: 0,
      durationMs: 1,
      status: 'completed',
      createdAt: '2026-11-08T17:00:00.000Z',
      completedAt: '2026-11-08T17:00:00.000Z',
    });
    const result = await f.read({ view: 'items', turnId: f.turn.id, placement: 'step' });
    expect(result.response.status).toBe(200);
    const projected = result.body.items.find((row: { id: string }) => row.id === item.id);
    expect(projected.detail).toMatchObject({
      kind: 'preview',
      field: 'output',
      side: 'tail',
      sizeBytes: Buffer.byteLength(output),
      truncated: true,
    });
    expect(Buffer.byteLength(projected.detail.text)).toBeLessThanOrEqual(4096);
    expect(output.endsWith(projected.detail.text)).toBe(true);
    expect(projected.detail.text.endsWith('final 🙂')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThanOrEqual(262144);
  });

  it('keeps a 2000-message run within 256 KiB with bounded notes, counts and narrative continuation', async () => {
    const f = await fixture();
    for (let i = 0; i < 2000; i++) await f.message(`Progress ${i}: ${'x'.repeat(6000)}`);
    const { response, body } = await f.read();
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(262144);
    const run = body.runs.find((entry: { id: string }) => entry.id === f.turn.id);
    expect(run.statistics.messages).toBe(2000);
    expect(run.noteItemIds).toHaveLength(3);
    expect(run.narrative.length).toBeLessThanOrEqual(24);
    expect(run.narrativeCursor).toEqual(expect.any(String));
    for (const item of run.narrative)
      if (item.detail.kind === 'preview')
        expect(Buffer.byteLength(item.detail.text)).toBeLessThanOrEqual(4096);
  }, 180_000);

  it('bounds the whole run window and keeps run cursors stable when later runs are admitted', async () => {
    const f = await fixture();
    await f.store.completeTurn(f.turn.id, {
      status: 'completed',
      completedAt: '2026-11-08T17:00:00.000Z',
    });
    const ids: string[] = [];
    for (let index = 0; index < 36; index++) {
      const turn = await f.store.createTurn(
        f.selector.workspaceId,
        f.thread.id,
        `Run ${index}`,
        f.actor
      );
      ids.push(turn.id);
      for (let note = 0; note < 4; note++)
        await f.store.createItem({
          id: allocateEntityId('it'),
          owner: { kind: 'workspace', workspaceId: f.selector.workspaceId },
          threadId: f.thread.id,
          turnId: turn.id,
          type: 'assistant-message',
          status: 'completed',
          text: `Run ${index} note ${note} ${'x'.repeat(6000)}`,
          createdAt: '2026-11-08T16:00:00.000Z',
          completedAt: '2026-11-08T16:00:00.000Z',
        });
      await f.store.completeTurn(turn.id, {
        status: 'failed',
        error: { code: 'fixture_error', message: '🧪'.repeat(4096) },
        completedAt: '2026-11-08T17:00:00.000Z',
      });
    }
    const nearStart = await f.read({ anchor: { kind: 'turn', turnId: ids[1] } });
    expect(nearStart.response.status).toBe(200);
    const anchorIndex = nearStart.body.runs.findIndex((run: { id: string }) => run.id === ids[1]);
    expect(anchorIndex).toBe(2);
    expect(nearStart.body.runs.slice(anchorIndex + 1)).toHaveLength(10);
    expect(nearStart.body.afterCursor).not.toBeNull();
    const first = await f.read();
    expect(first.response.status).toBe(200);
    expect(first.body.runs).toHaveLength(31);
    expect(Buffer.byteLength(JSON.stringify(first.body))).toBeLessThanOrEqual(262144);
    const later = await f.store.createTurn(
      f.selector.workspaceId,
      f.thread.id,
      'Later admission',
      f.actor
    );
    const older = await f.read({ cursor: first.body.beforeCursor });
    expect(older.response.status).toBe(200);
    expect(older.body.runs.some((run: { id: string }) => run.id === later.id)).toBe(false);
    const newer = await f.read({ cursor: older.body.afterCursor });
    expect(newer.body.runs.map((run: { id: string }) => run.id)).toEqual(
      first.body.runs.map((run: { id: string }) => run.id)
    );
  }, 60_000);

  it('derives catch-up from actual displayed membership and the viewer own newer action without marking earlier notes', async () => {
    const f = await fixture();
    const first = await f.message('Earlier unread note');
    const second = await f.message('Actually displayed note');
    const mark = await f.app.request('/api/app/operations/thread.mark-read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...f.selector, itemIds: [second.id] }),
    });
    expect(mark.status).toBe(200);
    const anchored = await f.read({ anchor: { kind: 'catch-up' } });
    expect(anchored.body.anchor).toEqual({ turnId: f.turn.id, itemId: second.id });
    const action = await f.store.createItem({
      id: allocateEntityId('it'),
      owner: f.turn.owner,
      threadId: f.thread.id,
      turnId: f.turn.id,
      type: 'user-message',
      actor: f.actor,
      text: 'My newer action',
      status: 'completed',
      createdAt: '2026-11-08T17:00:00.000Z',
      completedAt: '2026-11-08T17:00:00.000Z',
    });
    expect((await f.read({ anchor: { kind: 'catch-up' } })).body.catchUpAnchor).toEqual({
      turnId: f.turn.id,
      itemId: action.id,
    });
    const state = await f.app.request('/api/app/operations/thread.read-state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...f.selector, itemIds: [first.id, second.id] }),
    });
    expect(await state.json()).toMatchObject({
      readItemIds: [second.id],
      unreadItemIds: [first.id],
    });
  });

  it('resolves an attention row through its owner and an explicit run anchor without inventing an Item', async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const itemId = allocateEntityId('it');
    const db = openWorkspaceDb(f.root, f.selector.workspaceId);
    try {
      await raiseRecordedPendingRequest(f.store, db.sqlite, {
        requestId,
        workspaceId: f.selector.workspaceId,
        threadId: f.thread.id,
        raisingTurnId: f.turn.id,
        requestItemId: itemId,
        kind: 'approval',
        requesterKind: 'worker',
        agentId: 'agent_demo',
        responsibleUserId: FIXTURE_LOCAL_USER_ID,
        approval: {
          kind: 'permission',
          title: 'Choose whether to continue',
          description: 'Exact effect remains at its owner.',
        },
        now: '2026-11-08T17:00:00.000Z',
      });
    } finally {
      db.sqlite.close();
    }
    const row = await f.read({ anchor: { kind: 'attention', rowId: `approval:${requestId}` } });
    expect(row.response.status).toBe(200);
    expect(row.body.anchor).toEqual({ turnId: f.turn.id, itemId });
    expect(row.body.itemWindow.items.some((item: { id: string }) => item.id === itemId)).toBe(true);
    const run = await f.read({ anchor: { kind: 'turn', turnId: f.turn.id } });
    expect(run.response.status).toBe(200);
    expect(run.body.anchor).toEqual({ turnId: f.turn.id });
    expect(run.body.itemWindow).toBeNull();
  });

  it('keeps Thread reads available when the policy owner denies audit.read and never loads the joined Audit source', async () => {
    const f = await fixture();
    await f.message('Public note');
    const actual = policyKernel.evaluateAccess;
    const evaluate = vi
      .spyOn(policyKernel, 'evaluateAccess')
      .mockImplementation((policy, request) =>
        actual(
          {
            ...policy,
            associations: policy.associations.map((association) => ({
              ...association,
              accessRights: association.accessRights.filter((right) => right !== 'ar:audit-read'),
            })),
          },
          request
        )
      );
    const readAudit = vi.spyOn(auditOwner, 'readTurnInterruptAudit');
    const result = await f.read();
    expect(result.response.status).toBe(200);
    expect(result.body.runs[0].interruptedBy).toEqual({ visibility: 'restricted' });
    expect(readAudit).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalled();
  });

  it('joins only exact completed steer receipts and leaves missing delivery evidence unknown', async () => {
    const f = await fixture();
    const examples: Array<{
      item: Item;
      requestId: string;
      disposition: 'accepted' | 'refused' | 'unknown' | 'missing';
    }> = [];
    for (const disposition of ['accepted', 'refused', 'unknown', 'missing'] as const) {
      const requestId = randomUUID();
      const item = await f.store.createItem({
        id: allocateEntityId('it'),
        owner: f.turn.owner,
        threadId: f.thread.id,
        turnId: f.turn.id,
        type: 'user-message',
        actor: f.actor,
        text: `Instruction ${disposition}`,
        causationId: taskSteerCausation(requestId),
        status: 'completed',
        createdAt: '2026-11-08T17:00:00.000Z',
        completedAt: '2026-11-08T17:00:00.000Z',
      });
      examples.push({ item, requestId, disposition });
    }
    await shutdownControlStoreWorkerClient();
    // Retained completed receipts qualify the read projection, not a native steering exchange.
    // The Task service and its complete native writer/acceptance qualification land with TB6.
    const sqlite = new Database(workspaceDbPath(f.root, f.selector.workspaceId));
    try {
      for (const example of examples) {
        if (example.disposition === 'missing' || example.item.type !== 'user-message') continue;
        const scope = {
          workspaceId: f.selector.workspaceId,
          threadId: f.thread.id,
          actorId: f.actor.id,
        };
        const hash = commandInputHash({
          workspaceId: f.selector.workspaceId,
          threadId: f.thread.id,
          turnId: f.turn.id,
          input: example.item.text,
        });
        sqlite
          .prepare(`INSERT INTO idempotency_requests (schema_version,request_key,command_name,request_id,
          scope_json,input_hash,response_kind,response_id,response_json,created_at,expires_at)
          VALUES (1,?,'task.steer',?,?,?,'turn',?,?,?,?)`)
          .run(
            commandRequestKey('task.steer', example.requestId, scope),
            example.requestId,
            JSON.stringify(scope),
            hash,
            f.turn.id,
            JSON.stringify({
              turnId: f.turn.id,
              inputItemId: example.item.id,
              inputHash: hash,
              disposition: example.disposition,
              reason: null,
              executionId: 'private-fixture-execution',
              operationId: 'private-fixture-operation',
            }),
            '2026-11-08T17:00:00.000Z',
            '2099-01-01T00:00:00.000Z'
          );
      }
    } finally {
      sqlite.close();
    }
    const result = await f.read({ view: 'items', turnId: f.turn.id });
    expect(result.response.status).toBe(200);
    expect(result.body.items.map((item: { steer: { state: string } }) => item.steer.state)).toEqual(
      ['accepted', 'not-delivered', 'unknown', 'unknown']
    );
    expect(JSON.stringify(result.body)).not.toContain('private-fixture-');
  });

  it('attributes Stop only to its authorized recorded Audit actor', async () => {
    const f = await fixture();
    await f.store.completeTurn(f.turn.id, {
      status: 'interrupted',
      completedAt: '2026-11-08T17:00:00.000Z',
    });
    const db = openWorkspaceDb(f.root, f.selector.workspaceId);
    const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000777' };
    try {
      auditOwner.recordWorkspaceAuditEvent({
        workspaceDb: db,
        workspaceId: f.selector.workspaceId,
        threadId: f.thread.id,
        turnId: f.turn.id,
        actor,
        action: 'turn.interrupt',
        resource: `turn:${f.turn.id}`,
        outcome: 'succeeded',
        summary: 'Stop request accepted.',
      });
    } finally {
      db.sqlite.close();
    }
    const result = await f.read();
    expect(result.response.status).toBe(200);
    expect(result.body.runs[0].interruptedBy).toEqual({ visibility: 'available', actor });
    expect(result.body.runs[0].interruptedBy.actor).not.toEqual(f.actor);
  });

  it('redacts an Artifact from another private Thread before projecting its label or count into shared work', async () => {
    const f = await fixture();
    const privateThread = await f.store.createThread(
      f.selector.workspaceId,
      'Private source',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000999',
      }
    );
    const privateTurn = await f.store.createTurn(
      f.selector.workspaceId,
      privateThread.id,
      'Private',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000999',
      }
    );
    const body = 'Private source body marker';
    const requestId = randomUUID();
    const artifact = await f.store.createArtifact({
      id: allocateEntityId('ar'),
      workspaceId: f.selector.workspaceId,
      threadId: privateThread.id,
      turnId: privateTurn.id,
      kind: 'summary',
      title: 'Private source label marker',
      status: 'ready',
      summary: body,
      version: 1,
      content: { format: 'markdown', body },
      contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      lastMutationRequestId: requestId,
      origin: {
        kind: 'turn-output',
        threadId: privateThread.id,
        turnId: privateTurn.id,
        requestId,
      },
      createdAt: '2026-11-08T17:00:00.000Z',
      updatedAt: '2026-11-08T17:00:00.000Z',
    });
    const citation = await f.store.createItem({
      id: allocateEntityId('it'),
      owner: f.turn.owner,
      threadId: f.thread.id,
      turnId: f.turn.id,
      type: 'artifact-reference',
      artifactId: artifact.id,
      artifactVersion: 1,
      lastMutationRequestId: requestId,
      title: artifact.title,
      summary: artifact.summary,
      status: 'completed',
      createdAt: '2026-11-08T17:00:00.000Z',
      completedAt: '2026-11-08T17:00:00.000Z',
    });
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      scope: 'workspace',
      workspaceIds: [f.selector.workspaceId],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const app = createApp({ mode: 'server', coreDb: f.coreDb, store: f.store });
    const response = await app.request('/api/app/operations/thread.timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.secret}` },
      body: JSON.stringify(f.selector),
    });
    expect(response.status).toBe(200);
    const projection = await response.json();
    const text = JSON.stringify(projection);
    expect(text).not.toContain('Private source');
    expect(text).not.toContain(artifact.id);
    expect(text).not.toContain(citation.id);
    expect(projection.runs[0].statistics.itemCounts['artifact-reference']).toBeUndefined();
    expect(projection.restrictedReferences).toBe(true);
    const bodyResponse = await app.request('/api/app/operations/thread.item-body', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.secret}` },
      body: JSON.stringify({ ...f.selector, turnId: f.turn.id, itemId: citation.id }),
    });
    expect(bodyResponse.status).toBe(404);
    const refusal = await bodyResponse.text();
    expect(refusal).not.toContain('Private source');
    expect(refusal).not.toContain(artifact.id);
    const actual = policyKernel.evaluateAccess;
    vi.spyOn(policyKernel, 'evaluateAccess').mockImplementation((policy, request) =>
      actual(
        {
          ...policy,
          associations: policy.associations.map((association) => ({
            ...association,
            accessRights: association.accessRights.filter((right) => right !== 'ar:artifact-read'),
          })),
        },
        request
      )
    );
    const sourceRead = vi.spyOn(f.store, 'getArtifact');
    const deniedBody = await app.request('/api/app/operations/thread.item-body', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.secret}` },
      body: JSON.stringify({ ...f.selector, turnId: f.turn.id, itemId: citation.id }),
    });
    expect(deniedBody.status).toBe(404);
    expect(sourceRead).not.toHaveBeenCalled();
    await f.store.persistTurnEvent(f.turn.id, {
      event: 'item.created',
      ...f.selector,
      turnId: f.turn.id,
      data: { type: 'item-created', item: citation },
    });
    const completed = await f.store.completeTurn(f.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    await f.store.persistTurnEvent(f.turn.id, {
      event: 'turn.completed',
      ...f.selector,
      turnId: f.turn.id,
      data: { type: 'turn-completed', stopReason: 'completed', turn: completed },
    });
    const stream = await app.request(
      `/api/workspaces/${f.selector.workspaceId}/threads/${f.thread.id}/events?turnId=${f.turn.id}`,
      { headers: { authorization: `Bearer ${token.secret}` } }
    );
    expect(stream.status).toBe(200);
    const wire = await stream.text();
    expect(wire).not.toContain('Private source');
    expect(wire).not.toContain(citation.id);
    expect(wire).not.toContain(artifact.id);
    expect(wire.split('data: ').length - 1).toBe(1);
  });

  it('rejects a foreign Thread Item anchor without disclosing its text', async () => {
    const f = await fixture();
    const other = await f.store.createThread(f.selector.workspaceId, 'Other');
    const turn = await f.store.createTurn(f.selector.workspaceId, other.id, 'Other', f.actor);
    const item = await f.store.createItem({
      id: allocateEntityId('it'),
      owner: { kind: 'workspace', workspaceId: f.selector.workspaceId },
      threadId: other.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Foreign body marker',
      createdAt: '2026-11-08T16:00:00.000Z',
      completedAt: '2026-11-08T16:00:00.000Z',
    });
    const result = await f.read({ anchor: { kind: 'item', itemId: item.id } });
    expect([403, 404]).toContain(result.response.status);
    expect(JSON.stringify(result.body)).not.toContain('Foreign body marker');
  });
});
