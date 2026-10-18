// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import {
  findAssistantTimeline,
  openAssistantTimeline,
} from '../internal-agents/assistant-timeline.js';
import { FsStore } from '../lib/store.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import {
  assertKnowledgeRetrievalTraceReadable,
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveUserMemory,
} from '../storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { readRetrievalTrace } from '../storage/retrieval-traces.js';
import { verifyWorkspaceExportTree } from '../storage/workspace-export.js';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import { readWorkspaceImportSnapshot } from '../storage/workspace-import.js';
import {
  createVerifiedWorkspaceExport,
  existingWorkspaceExportRoot,
  importVerifiedWorkspace,
} from '../storage/workspace-transfer-routes.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { readMemoryPage, saveMemoryPage } from './memory-lifecycle.js';
import { registerUserKnowledgeSource } from './scoped-knowledge-sources.js';
import { initializeScopedNotebook } from './scoped-notebook-owner.js';

const query = 'portablePreferenceMarker';

/** Separate real deployments deliberately use the same canonical local User identity. */
function deployment() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-trace-portability-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const actorRef = { kind: 'user' as const, id: userId };
  const userDb = openUserDb(dataRoot, userId);
  applyScopedMigrations(userDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Memory trace portability', {
    requestId: randomUUID(),
    producer: actorRef,
    instructionReference: 'test:memory-trace-portability',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const databases = new Set<ReturnType<typeof openWorkspaceDb>>();
  const workspaceDb = (workspaceId: string) => {
    const db = openWorkspaceDb(dataRoot, workspaceId);
    applyScopedMigrations(db);
    databases.add(db);
    return db;
  };
  workspaceDb(workspace.id);
  const writer = {
    coreDb,
    userDb,
    actor,
    store,
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
    inflightCommands: new WeakMap(),
  };
  const baseRevision = initializeScopedNotebook({
    ...writer,
    target: { kind: 'user' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:memory-portability' },
  });
  const timeline = openAssistantTimeline(store, workspace.id, userId, 'Private Assistant');
  const access = {
    coreDb,
    userDb,
    store,
    requestActor: actor,
    actor: actorRef,
    outputThreadId: timeline.id,
  };
  const save = (sourceReferences: string[] = []) =>
    saveMemoryPage(writer, {
      requestId: randomUUID(),
      baseRevision,
      pageId: 'preferences',
      content: serializeUserAuthoredKnowledgePage(
        {
          id: 'preferences',
          kind: 'preference',
          title: 'PRIVATE_MEMORY_TITLE_ONLY',
          content: `${query} PRIVATE_MEMORY_BODY_ONLY`,
          sourceReferences,
          createdAt: '2026-10-17T00:00:00.000Z',
          updatedAt: '2026-10-17T00:00:00.000Z',
        },
        { kind: 'user', userId }
      ),
      summary: 'Explicit self preference',
    });
  onTestFinished(async () => {
    await closeRetrievalServices();
    for (const db of databases) if (db.sqlite.open) db.sqlite.close();
    userDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    dataRoot,
    coreDb,
    userId,
    actor,
    actorRef,
    store,
    workspace,
    workspaceDb,
    writer,
    access,
    save,
  };
}

describe('User Memory selection trace portability', () => {
  it('exports only authorized trace metadata, preserves foreign User evidence without target access, and admits fresh self selection', async () => {
    const source = deployment();
    const target = deployment();
    expect(target.userId).toBe(source.userId);
    const sourceServerId = readDataRootLayoutMarker(source.dataRoot).deploymentId;
    const targetServerId = readDataRootLayoutMarker(target.dataRoot).deploymentId;
    expect(targetServerId).not.toBe(sourceServerId);
    const literal = await registerUserKnowledgeSource(source.writer, {
      requestId: randomUUID(),
      kind: 'document',
      title: 'PRIVATE_SOURCE_TITLE_ONLY',
      content: 'PRIVATE_SOURCE_BODY_ONLY',
    });
    const sourceRefs = [`source:${literal.id}@${literal.contentDigest}`];
    const saved = await source.save(sourceRefs);
    await target.save();
    const selected = await retrieveUserMemory({
      dataRoot: source.dataRoot,
      workspaceId: source.workspace.id,
      access: source.access,
      caller: 'app-api',
      query,
      pinnedReferences: [{ scopeId: userPageScope(source), objectId: 'preferences' }],
    });
    expect(selected.selected).toHaveLength(1);
    const original = readRetrievalTrace(
      join(source.dataRoot, 'workspaces', source.workspace.id),
      selected.retrievalTraceRef!
    )!;
    const exported = createVerifiedWorkspaceExport({
      authorityActor: source.actorRef,
      authorityUserId: source.userId,
      administratorEligible: isCurrentDeploymentAdministrator(source.coreDb, source.actor),
      coreDb: source.coreDb,
      dataRoot: source.dataRoot,
      repositoryWorkspaceDb: source.workspaceDb,
      requestActor: source.actor,
      store: source.store,
      workspaceId: source.workspace.id,
    });
    const verified = verifyWorkspaceExportTree({
      exportRoot: existingWorkspaceExportRoot(
        source.dataRoot,
        source.workspace.id,
        exported.verified.manifest.id
      ),
    });
    expect(verified.manifest.contentDigest).toBe(exported.verified.manifest.contentDigest);
    const paths = [...verified.fileContents.keys()];
    expect(paths.filter((path) => path.includes('/retrieval-traces/'))).toHaveLength(1);
    expect(paths.some((path) => /(?:^|\/)(?:users|memory)(?:\/|$)/.test(path))).toBe(false);
    const allBytes = [...verified.fileContents.values()].join('\n');
    for (const text of [
      query,
      'PRIVATE_MEMORY_TITLE_ONLY',
      'PRIVATE_MEMORY_BODY_ONLY',
      'PRIVATE_SOURCE_TITLE_ONLY',
      'PRIVATE_SOURCE_BODY_ONLY',
    ])
      expect(allBytes).not.toContain(text);
    expect(allBytes).not.toContain('"score"');

    const snapshot = readWorkspaceImportSnapshot({
      verified,
      targetWorkspaceId: source.workspace.id,
      targetServerId,
    });
    const [tracePath, importedTrace] = [...snapshot.portableFileState.retrievalTraceFiles][0]!;
    expect(importedTrace).toEqual({
      ...original,
      queryContext: {
        ...original.queryContext,
        workspaceId: snapshot.workspace.id,
        threadId: snapshot.threads[0]!.id,
      },
    });
    expect(importedTrace.queryContext.serverId).toBe(sourceServerId);
    expect(importedTrace.selected[0]).toMatchObject({
      reference: { scopeId: userPageScope(source), objectId: 'preferences' },
      revision: saved.notebookRevision,
      sourceReferences: sourceRefs,
    });
    expect(tracePath).toBe(
      `threads/${snapshot.threads[0]!.id}/retrieval-traces/${original.traceId}.json`
    );

    const targetPage = readMemoryPage(target.writer, 'preferences')!;
    const imported = importVerifiedWorkspace({
      authorityUserId: target.userId,
      coreDb: target.coreDb,
      dataRoot: target.dataRoot,
      requestId: randomUUID(),
      store: target.store,
      verified,
    });
    const workspaceId = imported.workspace.id;
    const timeline = findAssistantTimeline(target.store, workspaceId, target.userId)!;
    const access = { ...target.access, outputThreadId: timeline.id };
    const reference = {
      scopeId: `retrieval-trace/thread/${workspaceId}/${timeline.id}`,
      objectId: original.traceId,
    };
    const persisted = readRetrievalTrace(
      join(target.dataRoot, 'workspaces', workspaceId),
      reference
    )!;
    expect(persisted.queryContext.serverId).toBe(sourceServerId);
    expect(persisted.selected).toEqual(original.selected);
    expect(readMemoryPage(target.writer, 'preferences')).toEqual(targetPage);
    expect(existsSync(join(target.dataRoot, 'users', target.userId, 'sources'))).toBe(false);
    expect(() =>
      assertKnowledgeRetrievalTraceReadable({
        dataRoot: target.dataRoot,
        workspaceId,
        access,
        retrievalTraceRef: reference,
      })
    ).toThrowError(expect.objectContaining({ status: 403 }));
    expect(() =>
      resolveWorkspaceKnowledgeRetrievalPages({
        dataRoot: target.dataRoot,
        workspaceId,
        access,
        retrievalTraceRef: reference,
        caller: 'app-api',
      })
    ).toThrowError(expect.objectContaining({ status: 403 }));
    const fresh = await retrieveUserMemory({
      dataRoot: target.dataRoot,
      workspaceId,
      access,
      caller: 'app-api',
      query,
    });
    expect(fresh.queryContext.serverId).toBe(targetServerId);
    expect(fresh.selected).toMatchObject([
      {
        reference: { scopeId: userPageScope(target), objectId: 'preferences' },
        contentDigest: targetPage.digest,
      },
    ]);
    expect(
      assertKnowledgeRetrievalTraceReadable({
        dataRoot: target.dataRoot,
        workspaceId,
        access,
        retrievalTraceRef: fresh.retrievalTraceRef!,
      }).traceId
    ).toBe(fresh.retrievalTraceRef!.objectId);

    const sameDeployment = importVerifiedWorkspace({
      authorityUserId: source.userId,
      coreDb: source.coreDb,
      dataRoot: source.dataRoot,
      requestId: randomUUID(),
      store: source.store,
      verified,
    });
    const sameWorkspaceId = sameDeployment.workspace.id;
    const sameTimeline = findAssistantTimeline(source.store, sameWorkspaceId, source.userId)!;
    expect(
      assertKnowledgeRetrievalTraceReadable({
        dataRoot: source.dataRoot,
        workspaceId: sameWorkspaceId,
        access: { ...source.access, outputThreadId: sameTimeline.id },
        retrievalTraceRef: {
          scopeId: `retrieval-trace/thread/${sameWorkspaceId}/${sameTimeline.id}`,
          objectId: original.traceId,
        },
      }).selected
    ).toEqual(original.selected);
  });
});

/** Keeps each deployment's actual User base in retained trace references. */
function userPageScope(owner: ReturnType<typeof deployment>): string {
  return `page/user/${owner.userId}/${readDefaultKnowledgeBaseId({ dataRoot: owner.dataRoot, scope: { kind: 'user', userId: owner.userId } })}`;
}
