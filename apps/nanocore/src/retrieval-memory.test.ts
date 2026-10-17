// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetrieveKnowledgeRequestSchema } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { disableCanonicalUser } from './auth/user-lifecycle.js';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import { openAssistantTimeline } from './internal-agents/assistant-timeline.js';
import {
  applyMemoryForget,
  checkMemoryForgetIntent,
  prepareMemoryForgetCommand,
} from './knowledge/memory-forget.js';
import { editMemoryPage, readMemoryPage, saveMemoryPage } from './knowledge/memory-lifecycle.js';
import { updateOkfFrontmatter } from './knowledge/okf.js';
import {
  readUserKnowledgeSource,
  registerUserKnowledgeSource,
} from './knowledge/scoped-knowledge-sources.js';
import { initializeScopedNotebook } from './knowledge/scoped-notebook-owner.js';
import { FsStore } from './lib/store.js';
import { createPendingRequestOperationImplementations } from './pending-request-operations.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { installPendingRequestAdmission } from './runtime/pending-request-flow.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from './storage/db.js';
import {
  assertKnowledgeRetrievalTraceReadable,
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveUserMemory,
} from './storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import {
  publishRetrievalTrace,
  readRetrievalTrace,
  retrievalTraceRelativePath,
} from './storage/retrieval-traces.js';
import { serializeUserAuthoredKnowledgePage } from './storage/workspace-file-records.js';
import { notebookImportFixture } from './test-support/notebook-import.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const aliceId = 'usr_00000000-0000-7000-8000-000000000001';
const bobId = 'usr_00000000-0000-7000-8000-000000000002';
const marker = 'meridianMemoryMarker';
const foreignDeploymentId = 'dep_00000000-0000-7000-8000-000000000001';

/** Real canonical Users, private Timelines, Git notebooks and the ordinary Kernel service own all effects. */
function fixture(imported = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-retrieval-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  for (const userId of [aliceId, bobId])
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at) VALUES (?, 'human', 'Memory owner', ?, 0, ?, ?)"
      )
      .run(userId, [userId, 'example.invalid'].join('@'), Date.now(), Date.now());
  const store = new FsStore({ dataRoot });
  const importedWorkspaceId = allocateEntityId('ws');
  const workspace = imported
    ? store.importWorkspaceSnapshot({
        workspace: {
          id: importedWorkspaceId,
          name: 'Imported Memory output context',
          kind: 'general',
          status: 'active',
          counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
          createdAt: '2026-10-17T00:00:00.000Z',
          updatedAt: '2026-10-17T00:00:00.000Z',
          importedFrom: {
            sourceDeploymentId: foreignDeploymentId,
            sourceWorkspaceId: allocateEntityId('ws'),
            exportCreatedAt: '2026-10-17T00:00:00.000Z',
            manifestDigest: `sha256:${'0'.repeat(64)}`,
          },
        },
        threads: [],
        turns: [],
        knowledge: [],
        itemRevisions: [],
        artifacts: [],
        agentSessions: [],
        turnEvents: [],
        ...notebookImportFixture({
          workspaceId: importedWorkspaceId,
          knowledge: [],
          userId: aliceId,
        }),
      })
    : store.createWorkspace('Memory search', {
        requestId: randomUUID(),
        producer: { kind: 'user', id: aliceId },
        instructionReference: 'test:memory-search',
      });
  const workspaceId = workspace.id;
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  applyScopedMigrations(workspaceDb);
  const runtimeConfigManager = createRuntimeConfigManager({ dataRoot });
  const inflightCommands = new WeakMap();
  const users = [aliceId, bobId].map((userId) => {
    if (userId === aliceId)
      recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: userId });
    else
      coreDb.sqlite
        .prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES (?, ?, 'active', 'editor', NULL, ?, NULL, 1, ?, ?)"
        )
        .run(workspaceId, userId, Date.now(), Date.now(), Date.now());
    const userDb = openUserDb(dataRoot, userId);
    applyScopedMigrations(userDb);
    const actor = { kind: 'session' as const, userId };
    const writer = {
      coreDb,
      userDb,
      workspaceDb,
      actor,
      store,
      runtimeConfigManager,
      inflightCommands,
    };
    const baseRevision = initializeScopedNotebook({
      ...writer,
      target: { kind: 'user' },
      initialization: { requestId: randomUUID(), instructionReference: 'test:memory-search' },
    });
    const timeline = openAssistantTimeline(store, workspaceId, userId, 'Private Assistant');
    const access = {
      coreDb,
      userDb,
      store,
      requestActor: actor,
      actor: { kind: 'user' as const, id: userId },
      outputThreadId: timeline.id,
    };
    const query = () => ({
      dataRoot,
      workspaceId,
      access,
      caller: 'app-api' as const,
      query: marker,
    });
    const save = (base: string, pageId: string, body: string, sourceReferences: string[] = []) => {
      const content = serializeUserAuthoredKnowledgePage(
        {
          id: pageId,
          kind: 'preference',
          title: 'Personal preference',
          content: body,
          sourceReferences,
          createdAt: '2026-10-17T00:00:00.000Z',
          updatedAt: '2026-10-17T00:00:00.000Z',
        },
        { kind: 'user', userId }
      );
      return saveMemoryPage(writer, {
        requestId: randomUUID(),
        baseRevision: base,
        pageId,
        content,
        summary: 'Save personal search evidence',
      });
    };
    return { writer, access, query, save, timeline, baseRevision };
  });
  onTestFinished(async () => {
    await closeRetrievalServices();
    for (const user of users) user.writer.userDb.sqlite.close();
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    alice: users[0]!,
    bob: users[1]!,
    dataRoot,
    coreDb,
    store,
    workspaceId,
    workspaceRoot: join(dataRoot, 'workspaces', workspaceId),
  };
}

describe('governed current-self Memory search', () => {
  it('selects only self pages with exact User references and a private trace in an imported Workspace, independent of another User corpus', async () => {
    const f = fixture(true);
    f.store.archiveThread(f.workspaceId, f.alice.timeline.id);
    const saved = await f.alice.save(
      f.alice.baseRevision,
      'preferences',
      `${marker} ALICE_PRIVATE_BODY`
    );
    const first = await retrieveUserMemory(f.alice.query());
    await f.bob.save(f.bob.baseRevision, 'preferences', `${marker} BOB_PRIVATE_BODY ${marker}`);
    const result = await retrieveUserMemory(f.alice.query());
    expect(f.store.getThread(f.workspaceId, f.alice.timeline.id).status).toBe('archived');
    const page = readMemoryPage(f.alice.writer, 'preferences')!;
    expect(result).toMatchObject({
      sourceScope: `page/user/${aliceId}`,
      notebookRevision: saved.notebookRevision,
      retrievalParameters: { sourceScope: 'user', limit: 5 },
      selected: [
        {
          reference: { scopeId: `page/user/${aliceId}`, objectId: 'preferences' },
          revision: saved.notebookRevision,
          contentDigest: page.digest,
        },
      ],
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]!.score).toBe(first.selected[0]!.score);
    const bob = await retrieveUserMemory(f.bob.query());
    expect(bob.selected[0]!.reference.scopeId).toBe(`page/user/${bobId}`);
    expect(bob.selected[0]!.contentDigest).not.toBe(page.digest);
    expect(
      RetrieveKnowledgeRequestSchema.safeParse({ query: marker, sourceScope: 'user' }).success
    ).toBe(false);
    const trace = readRetrievalTrace(f.workspaceRoot, result.retrievalTraceRef!)!;
    expect(trace).toMatchObject({
      sourceScope: `page/user/${aliceId}`,
      queryContext: { threadId: f.alice.timeline.id, actor: { kind: 'user', id: aliceId } },
    });
    const bytes = readFileSync(
      join(f.workspaceRoot, retrievalTraceRelativePath(result.retrievalTraceRef!)),
      'utf8'
    );
    for (const value of [marker, 'ALICE_PRIVATE_BODY', 'BOB_PRIVATE_BODY', 'snippet', '"score"'])
      expect(bytes).not.toContain(value);
    expect(
      assertKnowledgeRetrievalTraceReadable({
        ...f.alice.query(),
        retrievalTraceRef: result.retrievalTraceRef!,
      })
    ).toEqual(trace);
    expect(
      assertKnowledgeRetrievalTraceReadable({
        ...f.alice.query(),
        access: { ...f.alice.access, userDb: undefined },
        retrievalTraceRef: result.retrievalTraceRef!,
      })
    ).toEqual(trace);
    expect(
      resolveWorkspaceKnowledgeRetrievalPages({
        ...f.alice.query(),
        retrievalTraceRef: result.retrievalTraceRef!,
      })?.[0]?.content
    ).toBe(page.content);
    // A new local self selection does not grant imported foreign-deployment evidence authority.
    const foreignTraceId = allocateEntityId('krt');
    const foreignTraceRef = { ...result.retrievalTraceRef!, objectId: foreignTraceId };
    publishRetrievalTrace(f.workspaceRoot, foreignTraceRef, {
      ...trace,
      traceId: foreignTraceId,
      queryContext: { ...trace.queryContext, serverId: foreignDeploymentId },
    });
    expect(() =>
      assertKnowledgeRetrievalTraceReadable({
        ...f.alice.query(),
        retrievalTraceRef: foreignTraceRef,
      })
    ).toThrowError(expect.objectContaining({ code: 'workspace_access_denied', status: 403 }));
    expect(() =>
      assertKnowledgeRetrievalTraceReadable({
        ...f.bob.query(),
        retrievalTraceRef: result.retrievalTraceRef!,
      })
    ).toThrow();
    expect(
      assertKnowledgeRetrievalTraceReadable({
        ...f.alice.query(),
        access: { ...f.alice.access, outputThreadId: undefined },
        retrievalTraceRef: result.retrievalTraceRef!,
      })
    ).toEqual(trace);
    await expect(
      retrieveUserMemory({
        ...f.alice.query(),
        pinnedReferences: [{ scopeId: `page/user/${bobId}`, objectId: 'preferences' }],
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('uses source-local pins and budgets, explicit state inspection and freshness without inventing User conflict authority', async () => {
    const f = fixture();
    const alpha = await f.alice.save(
      f.alice.baseRevision,
      'alpha',
      `${marker} ${marker} ${marker}`
    );
    const beta = await f.alice.save(alpha.notebookRevision, 'beta', marker);
    const archived = await f.alice.save(beta.notebookRevision, 'archived', marker);
    const current = readMemoryPage(f.alice.writer, 'archived')!;
    const changed = await editMemoryPage(f.alice.writer, {
      requestId: randomUUID(),
      baseRevision: archived.notebookRevision,
      pageId: 'archived',
      content: updateOkfFrontmatter({
        path: 'archived.md',
        content: current.content,
        updates: { openkit_status: 'archived', status: 'deprecated' },
      }),
      summary: 'Archive my preference',
    });
    const limited = await retrieveUserMemory({
      ...f.alice.query(),
      limit: 1,
      pinnedReferences: [{ scopeId: `page/user/${aliceId}`, objectId: 'beta' }],
    });
    expect(limited.selected.map(({ reference }) => reference.objectId)).toEqual(['beta']);
    expect(limited.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reference: { scopeId: `page/user/${aliceId}`, objectId: 'alpha' },
          reason: 'budget_exceeded',
        }),
        expect.objectContaining({
          reference: { scopeId: `page/user/${aliceId}`, objectId: 'archived' },
          reason: 'lower_conformance',
        }),
      ])
    );
    const all = await retrieveUserMemory({ ...f.alice.query(), states: ['active', 'archived'] });
    expect(all.selected.map(({ reference }) => reference.objectId).sort()).toEqual([
      'alpha',
      'archived',
      'beta',
    ]);
    await expect(
      retrieveUserMemory({ ...f.alice.query(), caller: 'assistant', states: ['archived'] })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const fresh = readMemoryPage(f.alice.writer, 'beta')!;
    await editMemoryPage(f.alice.writer, {
      requestId: randomUUID(),
      baseRevision: changed.notebookRevision,
      pageId: 'beta',
      content: updateOkfFrontmatter({
        path: 'beta.md',
        content: fresh.content,
        updates: { freshness: 'stale' },
      }),
      summary: 'Mark my preference stale',
    });
    expect((await retrieveUserMemory(f.alice.query())).excluded).toContainEqual(
      expect.objectContaining({
        reference: { scopeId: `page/user/${aliceId}`, objectId: 'beta' },
        reason: 'freshness_expired',
      })
    );
    const conflicts = join(f.dataRoot, 'users', aliceId, 'memory', 'conflicts');
    mkdirSync(conflicts);
    writeFileSync(join(conflicts, 'unsupported.jsonl'), '{}\n');
    await expect(retrieveUserMemory(f.alice.query())).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(readFileSync(join(conflicts, 'unsupported.jsonl'), 'utf8')).toBe('{}\n');
  });

  it('removes forgotten pages from existing postings and permits a new explicit page from a raw Source still suppressed for models', async () => {
    const f = fixture();
    const source = await registerUserKnowledgeSource(f.alice.writer, {
      requestId: randomUUID(),
      kind: 'document',
      title: 'Retained evidence',
      content: 'Exact raw evidence.',
    });
    const refs = [`source:${source.id}@${source.contentDigest}`];
    const saved = await f.alice.save(
      f.alice.baseRevision,
      'preferences',
      `${marker} saved interpretation`,
      refs
    );
    const before = await retrieveUserMemory(f.alice.query());
    expect(before.selected.map(({ reference }) => reference.objectId)).toEqual(['preferences']);
    const openWorkspace = () => openWorkspaceDb(f.dataRoot, f.workspaceId);
    installPendingRequestAdmission(f.store, { coreDb: f.coreDb, openWorkspace });
    const page = readMemoryPage(f.alice.writer, 'preferences')!;
    const requestId = randomUUID();
    const prepared = prepareMemoryForgetCommand(f.alice.writer, {
      requestId,
      workspaceId: f.workspaceId,
      pageId: 'preferences',
      notebookRevision: saved.notebookRevision,
      digest: page.digest,
    });
    const handlers = createPendingRequestOperationImplementations({
      coreDb: f.coreDb,
      store: f.store,
      inflightCommands: f.alice.writer.inflightCommands,
      repositoryWorkspaceDb: openWorkspace,
      checkCommandIntent: (sqlite, record, actor) =>
        checkMemoryForgetIntent(sqlite, record, actor, f.coreDb, f.store),
    });
    await handlers['approval.respond'](
      {
        requestId: randomUUID(),
        workspaceId: f.workspaceId,
        threadId: prepared.threadId,
        turnId: prepared.turnId,
        approvalRequestId: prepared.pendingRequestId,
        decision: 'granted',
      },
      {
        kind: 'public',
        actor: f.alice.writer.actor,
        actorRef: { kind: 'user', id: aliceId },
        scope: { kind: 'workspace', workspaceId: f.workspaceId },
      }
    );
    expect((await retrieveUserMemory(f.alice.query())).selected).toHaveLength(1);
    const removed = await applyMemoryForget(f.alice.writer, {
      requestId,
      pendingRequestId: prepared.pendingRequestId,
      workspaceId: f.workspaceId,
      threadId: prepared.threadId,
    });
    expect((await retrieveUserMemory(f.alice.query())).selected).toEqual([]);
    expect(() =>
      assertKnowledgeRetrievalTraceReadable({
        ...f.alice.query(),
        retrievalTraceRef: before.retrievalTraceRef!,
      })
    ).toThrow();
    await f.alice.save(
      removed.notebookRevision,
      'new-preferences',
      `${marker} explicit new interpretation`,
      refs
    );
    const next = await retrieveUserMemory(f.alice.query());
    expect(next.selected.map(({ reference }) => reference.objectId)).toEqual(['new-preferences']);
    expect(readUserKnowledgeSource(f.alice.writer, source.id, 'model')).toBeNull();
    expect(readUserKnowledgeSource(f.alice.writer, source.id, 'human')?.content).toBe(
      'Exact raw evidence.'
    );
    writeFileSync(
      join(f.dataRoot, 'users', aliceId, 'sources', 'materials', source.id, 'content.txt'),
      'Corrupt evidence.'
    );
    await expect(retrieveUserMemory(f.alice.query())).rejects.toMatchObject({
      code: 'recovery_required',
    });
  });

  it.each([
    'shared',
    'missing Timeline',
    'Worker',
    'disabled',
  ] as const)('refuses %s context before private generation or trace publication', async (kind) => {
    const f = fixture();
    await f.alice.save(f.alice.baseRevision, 'preferences', marker);
    const access = { ...f.alice.access };
    if (kind === 'shared')
      access.outputThreadId = f.store.createThread(
        f.workspaceId,
        'Shared',
        undefined,
        'conversation',
        { visibility: 'workspace' }
      ).id;
    if (kind === 'missing Timeline') access.outputThreadId = undefined as unknown as string;
    if (kind === 'Worker')
      access.actor = {
        kind: 'agent',
        id: 'worker',
        responsibleUserId: aliceId,
      } as unknown as typeof access.actor;
    if (kind === 'disabled')
      f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, aliceId))();
    await expect(retrieveUserMemory({ ...f.alice.query(), access })).rejects.toMatchObject({
      status: 403,
    });
    expect(existsSync(join(f.dataRoot, 'users', aliceId, 'indexes', 'retrieval'))).toBe(false);
    expect(
      existsSync(join(f.workspaceRoot, 'threads', f.alice.timeline.id, 'retrieval-traces'))
    ).toBe(false);
  });
});
