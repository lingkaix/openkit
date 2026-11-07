// openkit-test-platform: posix
// The linked-root fault uses a real POSIX directory symlink in the private fixture root.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { initializeScopedNotebook, pinScopedNotebook } from '../knowledge/scoped-notebook-owner.js';
import { FsStore } from '../lib/store.js';
import * as notebookReader from '../retrieval-knowledge-adapter.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { closeTestCoreDb, createTestCoreDb } from '../test-support/store.js';
import { readTestWorkspaceNotebookSelection } from '../test-support/workspace-notebook.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { prepareKnowledgeOverview } from './knowledge-overview.js';

const INDEX =
  '---\nokf_version: "0.2"\n---\n# Workspace navigation\nINITIAL-INDEX-AUTHORITY-MARKER\n';
const CHANGES = ['published-head', 'linked-root', 'default-binding', 'disabled-user'] as const;
const digest = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

/** Publishes through the real Notebook operation, including its native head and command evidence. */
async function publishIndex(
  f: { app: ReturnType<typeof createApp>; dataRoot: string; workspaceId: string },
  content: string
) {
  const baseRevision = readTestWorkspaceNotebookSelection(f.dataRoot, f.workspaceId).head
    .notebookCommit;
  const response = await f.app.request(
    ...operationRequest(
      'knowledge.notebook.update',
      { workspaceId: f.workspaceId },
      {
        body: JSON.stringify({
          requestId: randomUUID(),
          baseRevision,
          changes: [{ path: 'index.md', content }],
          summary: 'Publish authority test navigation',
        }),
      }
    )
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).notebookRevision as string;
}

/** Real scope owners and canonical bytes; no SQL, authorization or Notebook result is mocked. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'overview-authority-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Overview authority');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = await store.createThread(workspace.id, 'Receiving Thread');
  const actor = { kind: 'user' as const, id: userId };
  const requestActor = { kind: 'local' as const, userId };
  const turn = await store.createTurn(workspace.id, thread.id, 'Read navigation', actor);
  const app = createApp({ coreDb, dataRoot, store });
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const scope = { kind: 'workspace' as const, workspaceId: workspace.id };
  const knowledgeBaseId = readDefaultKnowledgeBaseId({ dataRoot, scope });
  initializeScopedNotebook({
    coreDb,
    actor: requestActor,
    target: { kind: 'server' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:overview-authority' },
  });
  const server = pinScopedNotebook({ coreDb, actor: requestActor, target: { kind: 'server' } });
  const serverIndex = server.read(['index.md']).files['index.md']!;
  const f = {
    dataRoot,
    coreDb,
    store,
    app,
    userId,
    actor,
    requestActor,
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    knowledgeBaseId,
    server,
    serverIndex,
  };
  return { ...f, notebookRevision: await publishIndex(f, INDEX) };
}

/** Changes real current truth only after a valid prepared selection exists. */
async function changeCurrent(
  f: Awaited<ReturnType<typeof fixture>>,
  change: (typeof CHANGES)[number]
) {
  if (change === 'published-head') {
    const revision = await publishIndex(f, INDEX.replace('INITIAL-INDEX', 'LATER-INDEX'));
    expect(revision).not.toBe(f.notebookRevision);
  } else if (change === 'linked-root') {
    const root = join(f.dataRoot, 'workspaces', f.workspaceId, 'knowledge');
    const retained = `${root}-retained`;
    await rename(root, retained);
    await symlink(retained, root, 'dir');
  } else if (change === 'default-binding') {
    // Core Knowledge / Knowledge Base Files: this version has one fixed default ID.
    // Deliberate fixture corruption is not a supported default-switch operation.
    const path = join(f.dataRoot, 'workspaces', f.workspaceId, 'config', 'workspace.jsonc');
    const source = readFileSync(path, 'utf8');
    expect(source).toContain(f.knowledgeBaseId);
    writeFileSync(path, source.replaceAll(f.knowledgeBaseId, allocateEntityId('kb')));
  } else {
    // The public lifecycle operation owns its real Core transaction, receipt and Audit.
    const response = await f.app.request(
      ...operationRequest(
        'user.disable',
        { targetUserId: f.userId },
        { body: JSON.stringify({ requestId: randomUUID() }) }
      )
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const disabled = await response.json();
    expect(disabled.user.status).toBe('disabled');
  }
}

/** Supplies the same real source and receiving audience to the producer and consumer. */
function readInput(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    dataRoot: f.dataRoot,
    workspaceId: f.workspaceId,
    access: {
      store: f.store,
      coreDb: f.coreDb,
      actor: f.actor,
      requestActor: f.requestActor,
      outputThreadId: f.threadId,
      outputTurnId: f.turnId,
    },
    pageIds: ['index'],
  };
}

it.each(CHANGES)(
  'keeps exact-index prepared input subject to live owner truth: %s',
  async (change) => {
    const f = await fixture();
    const input = readInput(f);
    const prepared = await notebookReader.prepareAuthorizedWorkspaceNotebookRead(input);
    const read = () =>
      notebookReader.readAuthorizedWorkspaceNotebookPages({
        ...input,
        notebookRead: prepared,
        notebookRevision: f.notebookRevision,
      });
    const expected = [
      { id: 'index', path: 'index.md', content: INDEX, contentDigest: digest(INDEX) },
    ];
    expect(read().pages).toEqual(expected);
    await changeCurrent(f, change);
    // Core Policy current admission and S39 exact selected bytes are independent predicates.
    if (change === 'published-head') {
      const result = read();
      expect(result.knowledgeBaseId).toBe(f.knowledgeBaseId);
      expect(result.notebookRevision).toBe(f.notebookRevision);
      expect(result.pages).toEqual(expected);
    } else expect(read).toThrow();
  }
);

it.each(CHANGES)(
  'rechecks the real overview after awaited exact-index preparation: %s',
  async (change) => {
    const f = await fixture();
    const prepare = notebookReader.prepareAuthorizedWorkspaceNotebookRead;
    let intercepted = false;
    // Fault injection at the public crossing retains the real producer result and real consumer.
    const barrier = vi
      .spyOn(notebookReader, 'prepareAuthorizedWorkspaceNotebookRead')
      .mockImplementation(async (input) => {
        const prepared = await prepare(input);
        if (!intercepted && input.workspaceId === f.workspaceId) {
          await changeCurrent(f, change);
          intercepted = true;
        }
        return prepared;
      });
    try {
      const overview = await prepareKnowledgeOverview(f);
      // An OLD implementation without this crossing has not exercised the new guard.
      expect(intercepted, 'Async Notebook preparation boundary was not reached.').toBe(true);
      const projection = JSON.parse(
        overview.text.slice('<knowledge_overviews>'.length, -'</knowledge_overviews>'.length)
      );
      const workspace = projection.overviews.find(
        (entry: { scope: string }) => entry.scope === `workspace:${f.workspaceId}`
      );
      const server = projection.overviews.find(
        (entry: { scope: string }) => entry.scope === 'server'
      );
      if (change === 'published-head') {
        // S39 Knowledge Handling binds canonical and delivered bytes to the captured commit.
        expect(workspace).toMatchObject({
          knowledgeBaseId: f.knowledgeBaseId,
          path: 'index.md',
          notebookRevision: f.notebookRevision,
          contentDigest: digest(INDEX),
          deliveredDigest: digest(INDEX),
          truncated: false,
          content: INDEX,
        });
        await expect(
          Promise.resolve().then(() => overview.assertCurrent())
        ).resolves.toBeUndefined();
      } else {
        expect(workspace).toMatchObject({ unavailable: true });
        for (const key of [
          'knowledgeBaseId',
          'notebookRevision',
          'contentDigest',
          'deliveredDigest',
          'content',
        ])
          expect(workspace).not.toHaveProperty(key);
        expect(JSON.stringify(projection)).not.toContain('INITIAL-INDEX-AUTHORITY-MARKER');
        expect(overview.text).not.toContain(f.dataRoot);
      }
      if (change === 'disabled-user') {
        if (server) expect(server).toEqual({ scope: 'server', unavailable: true });
      } else {
        // Workspace source failure grants no Server authority and revokes no independent Server grant.
        expect(server).toMatchObject({
          knowledgeBaseId: f.server.knowledgeBaseId,
          notebookRevision: f.server.notebookRevision,
          contentDigest: digest(f.serverIndex),
          content: f.serverIndex,
        });
      }
    } finally {
      barrier.mockRestore();
    }
  }
);
