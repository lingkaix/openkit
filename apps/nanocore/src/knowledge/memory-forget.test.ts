import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { openAssistantTimeline } from '../internal-agents/assistant-timeline.js';
import { createPendingRequestOperationImplementations } from '../pending-request-operations.js';
import { projectApprovalEffect } from '../runtime/pending-request-disclosure.js';
import { installPendingRequestAdmission } from '../runtime/pending-request-flow.js';
import { readPendingRequest } from '../runtime/pending-requests.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  applyMemoryForget,
  checkMemoryForgetIntent,
  prepareMemoryForget,
} from './memory-forget.js';
import { editMemoryPage, readMemoryPage, saveMemoryPage } from './memory-lifecycle.js';
import { KnowledgeNotebook } from './notebook.js';
import { initializeScopedNotebook } from './scoped-notebook-owner.js';

/** Composes actual self admission, canonical pending rows and Items, public decisions and Git publication. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-forget-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const store = createDemoStore();
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId: DEMO_WORKSPACE_ID });
  const userDb = openUserDb(dataRoot, userId);
  const workspaceDb = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
  applyScopedMigrations(userDb);
  applyScopedMigrations(workspaceDb);
  const writer = {
    coreDb,
    userDb,
    workspaceDb,
    actor,
    store,
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
    inflightCommands: new WeakMap(),
  };
  const base = initializeScopedNotebook({
    ...writer,
    target: { kind: 'user' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:memory-forget' },
  });
  const content = (pageId: string, body: string) =>
    serializeUserAuthoredKnowledgePage(
      {
        id: pageId,
        kind: 'preference',
        title: 'Personal preference',
        content: body,
        sourceReferences: [],
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
      },
      { kind: 'user', userId }
    );
  const saved = await saveMemoryPage(writer, {
    requestId: randomUUID(),
    baseRevision: base,
    pageId: 'preference',
    content: content('preference', 'Private exact forgotten text.'),
    summary: 'Save my preference',
  });
  const thread = openAssistantTimeline(store, DEMO_WORKSPACE_ID, userId, 'Private Timeline');
  const turn = store.createTurn(
    DEMO_WORKSPACE_ID,
    thread.id,
    'Forget my preference',
    { kind: 'user', id: userId },
    null,
    { executorKind: 'person' }
  );
  const openWorkspace = () => openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
  installPendingRequestAdmission(store, { coreDb, openWorkspace });
  const request = {
    requestId: randomUUID(),
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: thread.id,
    turnId: turn.id,
    pageId: 'preference',
    notebookRevision: saved.notebookRevision,
    digest: readMemoryPage(writer, 'preference')!.digest,
  };
  const handlers = createPendingRequestOperationImplementations({
    coreDb,
    store,
    inflightCommands: writer.inflightCommands,
    repositoryWorkspaceDb: openWorkspace,
    checkCommandIntent: (sqlite, record, decidingActor) =>
      checkMemoryForgetIntent(sqlite, record, decidingActor, coreDb, store),
  });
  const decide = (
    pendingRequestId: string,
    decision: 'granted' | 'denied' = 'granted',
    decidingActor: Actor = actor
  ) =>
    handlers['approval.respond'](
      {
        requestId: randomUUID(),
        workspaceId: request.workspaceId,
        threadId: request.threadId,
        turnId: request.turnId,
        approvalRequestId: pendingRequestId,
        decision,
      },
      {
        kind: 'public',
        actor: decidingActor,
        actorRef: { kind: 'user', id: decidingActor.userId },
        scope: { kind: 'workspace', workspaceId: request.workspaceId },
      }
    );
  const apply = (pendingRequestId: string) =>
    applyMemoryForget(writer, {
      requestId: request.requestId,
      pendingRequestId,
      workspaceId: request.workspaceId,
      threadId: request.threadId,
    });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'users', userId, 'memory', 'notebook.git'),
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
    writer.workspaceDb.sqlite.close();
    writer.userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return { writer, request, apply, decide, content, saved, notebook, turn, thread };
}

describe('Item-confirmed self Memory forget', () => {
  it('refuses an absent grant and mismatched private context without changing content', async () => {
    const f = await fixture();
    const prepared = prepareMemoryForget(f.writer, f.request);
    await expect(f.apply(prepared.pendingRequestId)).rejects.toMatchObject({
      code: 'approval_required',
    });
    expect(() =>
      prepareMemoryForget(f.writer, { ...f.request, digest: `sha256:${'0'.repeat(64)}` })
    ).toThrow();
    expect(() =>
      prepareMemoryForget(f.writer, {
        ...f.request,
        requestId: randomUUID(),
        threadId: 'th_00000000-0000-7000-8000-000000000001',
      })
    ).toThrow();
    await f.decide(prepared.pendingRequestId);
    const configRoot = join(f.writer.coreDb.dataRoot, 'users', f.writer.actor.userId, 'config');
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(
      join(configRoot, 'user.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        knowledgeMaintenance: { enabled: false, reviewRequiredPageIds: ['preference'] },
      })
    );
    expect(f.writer.runtimeConfigManager.reload({ mode: 'safe' }).status).toBe('applied');
    await expect(f.apply(prepared.pendingRequestId)).rejects.toMatchObject({
      code: 'review_required',
    });
    expect(f.notebook.publishedRevision()).toBe(f.saved.notebookRevision);
    expect(readMemoryPage(f.writer, 'preference')?.content).toContain(
      'Private exact forgotten text.'
    );
  });

  it('captures exact disclosure and actual human decision but executes only the later apply', async () => {
    const f = await fixture();
    const prepared = prepareMemoryForget(f.writer, f.request);
    expect(prepareMemoryForget(f.writer, f.request)).toEqual(prepared);
    const record = readPendingRequest(f.writer.workspaceDb.sqlite, prepared.pendingRequestId)!;
    expect(
      f.writer.store.getTurnById(f.turn.id).items.filter((item) => item.type === 'approval-request')
    ).toHaveLength(1);
    const preview = projectApprovalEffect({
      record,
      store: f.writer.store,
      coreDb: f.writer.coreDb,
      actor: f.writer.actor,
    });
    expect(preview.status).toBe('available');
    if (preview.status !== 'available') throw new Error('Exact detail unavailable');
    expect(preview.detail).toContain('Private exact forgotten text.');
    expect(preview.detail).toContain(f.request.digest);
    expect(preview.detail).toContain('backup');
    expect(record.description).not.toContain('Private exact forgotten text.');
    const administratorId = 'usr_00000000-0000-7000-8000-000000000002';
    const at = new Date().toISOString();
    f.writer.coreDb.sqlite
      .prepare(`INSERT INTO users
      (id, kind, display_name, email, email_verified, created_at, updated_at, status)
      VALUES (?, 'human', 'Administrative reviewer', ?, 0, ?, ?, 'active')`)
      .run(administratorId, ['fixture-reviewer', 'example.invalid'].join('@'), at, at);
    const token = createOpenKitAccessTokenRecord(f.writer.coreDb, {
      ownerUserId: administratorId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const administrator: Actor = {
      kind: 'token',
      userId: administratorId,
      tokenId: token.tokenId,
      tokenScope: 'server-admin',
    };
    await f.decide(prepared.pendingRequestId, 'granted', administrator);
    expect(
      readPendingRequest(f.writer.workspaceDb.sqlite, prepared.pendingRequestId)
    ).toMatchObject({
      state: 'resolved',
      resolution: 'granted',
      decidingActor: { kind: 'user', id: administratorId },
      claim: 'unclaimed',
    });
    expect(f.notebook.publishedRevision()).toBe(f.saved.notebookRevision);
    await expect(
      applyMemoryForget(
        { ...f.writer, actor: administrator },
        {
          requestId: f.request.requestId,
          pendingRequestId: prepared.pendingRequestId,
          workspaceId: f.request.workspaceId,
          threadId: f.request.threadId,
        }
      )
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const result = await f.apply(prepared.pendingRequestId);
    expect(result.outcome).toBe('published');
    expect(readMemoryPage(f.writer, 'preference')).toBeNull();
    expect(f.notebook.readRevision(result.notebookRevision).files['preference.md']).toBeUndefined();
    expect(f.notebook.readRevision(f.saved.notebookRevision).files['preference.md']).toContain(
      'Private exact forgotten text.'
    );
  });

  it('refuses a stale target terminally and cannot use the grant after another edit', async () => {
    const f = await fixture();
    const prepared = prepareMemoryForget(f.writer, f.request);
    await f.decide(prepared.pendingRequestId);
    const edited = await editMemoryPage(f.writer, {
      requestId: randomUUID(),
      baseRevision: f.saved.notebookRevision,
      pageId: 'preference',
      content: f.content('preference', 'Later human text.'),
      summary: 'Edit my preference',
    });
    await expect(f.apply(prepared.pendingRequestId)).rejects.toMatchObject({
      code: 'grant_conflict',
    });
    expect(
      readPendingRequest(f.writer.workspaceDb.sqlite, prepared.pendingRequestId)?.disposition
    ).toBe('denied-not-executed');
    await expect(f.apply(prepared.pendingRequestId)).rejects.toThrow();
    expect(f.notebook.publishedRevision()).toBe(edited.notebookRevision);
    expect(readMemoryPage(f.writer, 'preference')?.content).toContain('Later human text.');
  });

  it('replays the exact outcome after decision delivery and a later new save', async () => {
    const f = await fixture();
    const prepared = prepareMemoryForget(f.writer, f.request);
    await f.decide(prepared.pendingRequestId);
    const removed = await f.apply(prepared.pendingRequestId);
    // Deliver the person decision after apply: the shared pending owner clears its held result.
    f.writer.store.updateTurn(f.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    expect(
      readPendingRequest(f.writer.workspaceDb.sqlite, prepared.pendingRequestId)?.heldResult
    ).toBeNull();
    const later = await saveMemoryPage(f.writer, {
      requestId: randomUUID(),
      baseRevision: removed.notebookRevision,
      pageId: 'new-preference',
      content: f.content('new-preference', 'Later saved content.'),
      summary: 'Save a new preference',
    });
    f.writer.workspaceDb.sqlite.close();
    f.writer.userDb.sqlite.close();
    f.writer.workspaceDb = openWorkspaceDb(f.writer.coreDb.dataRoot, f.request.workspaceId);
    f.writer.userDb = openUserDb(f.writer.coreDb.dataRoot, f.writer.actor.userId);
    expect(await f.apply(prepared.pendingRequestId)).toEqual(removed);
    expect(f.notebook.publishedRevision()).toBe(later.notebookRevision);
    expect(readMemoryPage(f.writer, 'new-preference')?.content).toContain('Later saved content.');
    await expect(
      applyMemoryForget(f.writer, {
        requestId: randomUUID(),
        pendingRequestId: prepared.pendingRequestId,
        workspaceId: f.request.workspaceId,
        threadId: f.request.threadId,
      })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
  });

  it('withholds confirmation prose after suppression even when Git publication fails and never repeats it', async () => {
    const f = await fixture();
    const prepared = prepareMemoryForget(f.writer, f.request);
    await f.decide(prepared.pendingRequestId);
    const publish = vi.spyOn(KnowledgeNotebook.prototype, 'publish').mockImplementationOnce(() => {
      throw new Error('Publication outcome could not be established.');
    });
    await expect(f.apply(prepared.pendingRequestId)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    await expect(f.apply(prepared.pendingRequestId)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(readMemoryPage(f.writer, 'preference')).toBeNull();
    const record = readPendingRequest(f.writer.workspaceDb.sqlite, prepared.pendingRequestId)!;
    expect(record.governedIntent).toHaveProperty('content');
    expect(
      projectApprovalEffect({
        record,
        store: f.writer.store,
        coreDb: f.writer.coreDb,
        actor: f.writer.actor,
      })
    ).toMatchObject({ status: 'unavailable' });
  });
});
