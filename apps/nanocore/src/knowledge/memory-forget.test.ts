import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { openAssistantTimeline } from '../internal-agents/assistant-timeline.js';
import { createPendingRequestOperationImplementations } from '../pending-request-operations.js';
import { projectApprovalEffect } from '../runtime/pending-request-disclosure.js';
import { installPendingRequestAdmission } from '../runtime/pending-request-flow.js';
import { readPendingRequest } from '../runtime/pending-requests.js';
import { type CoreDb, openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import { userDbPath } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  applyMemoryForget,
  checkMemoryForgetIntent,
  prepareMemoryForget,
  prepareMemoryForgetCommand,
} from './memory-forget.js';
import { diffMemoryHistory, readMemoryHistory, restoreMemoryHistory } from './memory-history.js';
import { editMemoryPage, readMemoryPage, saveMemoryPage } from './memory-lifecycle.js';
import { readMemorySuppressions } from './memory-maintenance.js';
import { KnowledgeNotebook } from './notebook.js';
import {
  readUserKnowledgeSource,
  registerUserKnowledgeSource,
} from './scoped-knowledge-sources.js';
import { initializeScopedNotebook } from './scoped-notebook-owner.js';

/** Issues an actual test administrator credential without changing Memory ownership or its private audience. */
function administrativeReviewer(coreDb: CoreDb): Actor {
  const userId = 'usr_00000000-0000-7000-8000-000000000002';
  const at = new Date().toISOString();
  coreDb.sqlite
    .prepare(`INSERT INTO users
    (id, kind, display_name, email, email_verified, created_at, updated_at, status)
    VALUES (?, 'human', 'Administrative reviewer', ?, 0, ?, ?, 'active')`)
    .run(userId, ['fixture-reviewer', 'example.invalid'].join('@'), at, at);
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  return { kind: 'token', userId, tokenId: token.tokenId, tokenScope: 'server-admin' };
}

/** Composes actual self admission, canonical pending rows and Items, public decisions and Git publication. */
async function fixture(sourceBacked = false) {
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
  const source = sourceBacked
    ? await registerUserKnowledgeSource(writer, {
        requestId: randomUUID(),
        kind: 'document',
        title: 'Personal evidence',
        content: 'Independent retained Source bytes.\r\n',
      })
    : null;
  const references = source
    ? [`source:${source.id}`, `source:${source.id}@${source.contentDigest}`]
    : [];
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
        sourceReferences: references,
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
    if (writer.userDb.sqlite.open) writer.userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return { writer, request, apply, decide, content, saved, notebook, turn, thread, source };
}

describe('Item-confirmed self Memory forget', () => {
  it('binds actual Source retention to the human grant and retains only source-version fingerprints after exact forgetting', async () => {
    const f = await fixture(true);
    const source = f.source!;
    const prepared = prepareMemoryForget(f.writer, f.request);
    const record = readPendingRequest(f.writer.workspaceDb.sqlite, prepared.pendingRequestId)!;
    const preview = projectApprovalEffect({
      record,
      store: f.writer.store,
      coreDb: f.writer.coreDb,
      actor: f.writer.actor,
    });
    expect(preview.status).toBe('available');
    if (preview.status !== 'available') throw new Error('Source retention disclosure unavailable.');
    expect(preview.detail).toContain(`source:${source.id}@${source.contentDigest}`);
    expect(preview.detail).toContain(
      'Registered Source versions and captured bytes remain independently retained'
    );
    expect(preview.detail).not.toContain('This source-free page');
    await f.decide(prepared.pendingRequestId);
    expect(f.notebook.publishedRevision()).toBe(f.saved.notebookRevision);
    expect(readMemoryPage(f.writer, 'preference')?.content).toContain(
      'Private exact forgotten text.'
    );
    const removed = await f.apply(prepared.pendingRequestId);
    expect(readMemoryPage(f.writer, 'preference')).toBeNull();
    const root = join(f.writer.coreDb.dataRoot, 'users', f.writer.actor.userId, 'memory');
    const rows = readMemorySuppressions(root, f.writer.actor.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.sourceFingerprints).toEqual([
      `source:${source.id}@${source.contentDigest}`,
    ]);
    expect(JSON.stringify(rows)).not.toContain('Private exact forgotten text.');
    expect(readUserKnowledgeSource(f.writer, source.id)?.content).toBe(
      'Independent retained Source bytes.\r\n'
    );
    expect(
      projectApprovalEffect({
        record: readPendingRequest(f.writer.workspaceDb.sqlite, prepared.pendingRequestId)!,
        store: f.writer.store,
        coreDb: f.writer.coreDb,
        actor: f.writer.actor,
      }).status
    ).toBe('unavailable');
    expect(
      readMemoryHistory(f.writer, {}).revisions.find(
        ({ revision }) => revision === f.saved.notebookRevision
      )?.availability
    ).toBe('unavailable');
    const selection = {
      baseRevision: removed.notebookRevision,
      fromRevision: f.saved.notebookRevision,
      pageIds: ['preference'],
    };
    expect(() => diffMemoryHistory(f.writer, selection)).toThrow('Memory page unavailable.');
    await expect(
      restoreMemoryHistory(f.writer, {
        ...selection,
        requestId: randomUUID(),
        summary: 'Do not revive',
      })
    ).rejects.toThrow('Memory page unavailable.');
    f.writer.store.updateTurn(f.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const later = await saveMemoryPage(f.writer, {
      requestId: randomUUID(),
      baseRevision: removed.notebookRevision,
      pageId: 'new-preference',
      content: f.content('new-preference', 'Explicit new human interpretation.'),
      summary: 'Save under a new identity',
    });
    expect(await f.apply(prepared.pendingRequestId)).toEqual(removed);
    expect(f.notebook.publishedRevision()).toBe(later.notebookRevision);
  });

  it.each([
    'grant',
    'apply',
  ] as const)('rechecks actual Source bytes before %s and withholds the captured preview without repair', async (stage) => {
    const f = await fixture(true);
    const prepared = prepareMemoryForget(f.writer, f.request);
    if (stage === 'apply') await f.decide(prepared.pendingRequestId);
    const material = join(
      f.writer.coreDb.dataRoot,
      'users',
      f.writer.actor.userId,
      'sources',
      'materials',
      f.source!.id,
      'content.txt'
    );
    writeFileSync(material, 'Corrupt retained Source.');
    const record = readPendingRequest(f.writer.workspaceDb.sqlite, prepared.pendingRequestId)!;
    expect(
      projectApprovalEffect({
        record,
        store: f.writer.store,
        coreDb: f.writer.coreDb,
        actor: f.writer.actor,
      }).status
    ).toBe('unavailable');
    if (stage === 'grant')
      await expect(f.decide(prepared.pendingRequestId)).rejects.toMatchObject({
        code: 'approval_preview_unavailable',
      });
    else
      await expect(f.apply(prepared.pendingRequestId)).rejects.toMatchObject({
        code: 'grant_conflict',
      });
    if (stage === 'grant') {
      expect(() =>
        checkMemoryForgetIntent(
          f.writer.workspaceDb.sqlite,
          record,
          f.writer.actor,
          f.writer.coreDb,
          f.writer.store
        )
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      expect(() => prepareMemoryForget(f.writer, f.request)).toThrowError(
        expect.objectContaining({ code: 'recovery_required' })
      );
    }
    expect(f.notebook.publishedRevision()).toBe(f.saved.notebookRevision);
    expect(readFileSync(material, 'utf8')).toBe('Corrupt retained Source.');
    expect(
      readMemorySuppressions(
        join(f.writer.coreDb.dataRoot, 'users', f.writer.actor.userId, 'memory'),
        f.writer.actor.userId
      )
    ).toEqual([]);
  });

  it('refuses corrupt Sources before preparation and never opens a replacement User database for a retained preview', async () => {
    const f = await fixture(true);
    const material = join(
      f.writer.coreDb.dataRoot,
      'users',
      f.writer.actor.userId,
      'sources',
      'materials',
      f.source!.id,
      'content.txt'
    );
    const original = readFileSync(material);
    writeFileSync(material, 'Corrupt Source.');
    expect(() => prepareMemoryForget(f.writer, f.request)).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(readPendingRequest(f.writer.workspaceDb.sqlite, f.request.requestId)).toBeNull();
    writeFileSync(material, original);
    const prepared = prepareMemoryForget(f.writer, f.request);
    const record = readPendingRequest(f.writer.workspaceDb.sqlite, prepared.pendingRequestId)!;
    f.writer.userDb.sqlite.close();
    const database = userDbPath(f.writer.coreDb.dataRoot, f.writer.actor.userId);
    rmSync(database);
    expect(
      projectApprovalEffect({
        record,
        store: f.writer.store,
        coreDb: f.writer.coreDb,
        actor: f.writer.actor,
      }).status
    ).toBe('unavailable');
    expect(existsSync(database)).toBe(false);
    expect(f.notebook.publishedRevision()).toBe(f.saved.notebookRevision);
  });

  it('keeps Source inspection unjoined for a non-self administrator confirmation', async () => {
    const f = await fixture(true);
    const prepared = prepareMemoryForget(f.writer, f.request);
    const administrator = administrativeReviewer(f.writer.coreDb);
    const record = readPendingRequest(f.writer.workspaceDb.sqlite, prepared.pendingRequestId)!;
    expect(
      projectApprovalEffect({
        record,
        store: f.writer.store,
        coreDb: f.writer.coreDb,
        actor: administrator,
      }).status
    ).toBe('unavailable');
    await expect(
      f.decide(prepared.pendingRequestId, 'granted', administrator)
    ).rejects.toMatchObject({ code: 'approval_preview_unavailable' });
    expect(() =>
      checkMemoryForgetIntent(
        f.writer.workspaceDb.sqlite,
        record,
        administrator,
        f.writer.coreDb,
        f.writer.store
      )
    ).toThrowError(expect.objectContaining({ code: 'workspace_access_denied' }));
    expect(f.notebook.publishedRevision()).toBe(f.saved.notebookRevision);
  });

  it('prepares an idle user command on one truthful local Turn and reuses its canonical lineage on replay', async () => {
    const f = await fixture();
    f.writer.store.updateTurn(f.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const { threadId: _threadId, turnId: _turnId, ...input } = f.request;
    const before = f.writer.store.listThreadTurns(input.workspaceId, f.thread.id).length;
    const result = prepareMemoryForgetCommand(f.writer, input);
    const turn = f.writer.store.getTurnById(result.turnId);
    expect(turn).toMatchObject({
      workspaceId: input.workspaceId,
      threadId: f.thread.id,
      status: 'completed',
      triggerActor: { kind: 'user', id: f.writer.actor.userId },
    });
    expect(turn.agentId).toBeUndefined();
    expect(turn.agentSessionId).toBeUndefined();
    expect(f.writer.store.getTurnExecutor(turn.id)).toBe('person');
    expect(prepareMemoryForgetCommand(f.writer, input)).toEqual(result);
    expect(() =>
      prepareMemoryForgetCommand(f.writer, { ...input, digest: `sha256:${'0'.repeat(64)}` })
    ).toThrow();
    expect(f.writer.store.listThreadTurns(input.workspaceId, f.thread.id)).toHaveLength(before + 1);
    expect(f.notebook.publishedRevision()).toBe(f.saved.notebookRevision);
  });

  it('withholds captured Memory prose from a usable administrator after the owning User is disabled', async () => {
    const f = await fixture();
    const prepared = prepareMemoryForget(f.writer, f.request);
    const record = readPendingRequest(f.writer.workspaceDb.sqlite, prepared.pendingRequestId)!;
    const actor = administrativeReviewer(f.writer.coreDb);
    const preview = () =>
      projectApprovalEffect({ record, store: f.writer.store, coreDb: f.writer.coreDb, actor });
    expect(preview().status).toBe('available');
    f.writer.coreDb.sqlite.transaction(() =>
      disableCanonicalUser(f.writer.coreDb, f.writer.actor.userId)
    )();
    expect(preview()).toMatchObject({ status: 'unavailable' });
  });
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
    const administrator = administrativeReviewer(f.writer.coreDb);
    await f.decide(prepared.pendingRequestId, 'granted', administrator);
    expect(
      readPendingRequest(f.writer.workspaceDb.sqlite, prepared.pendingRequestId)
    ).toMatchObject({
      state: 'resolved',
      resolution: 'granted',
      decidingActor: { kind: 'user', id: administrator.userId },
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
