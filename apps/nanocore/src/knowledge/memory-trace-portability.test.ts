// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, WorkspaceRecordSchema } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { openAssistantTimeline } from '../internal-agents/assistant-timeline.js';
import { FsStore } from '../lib/store.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import {
  assertKnowledgeRetrievalTraceReadable,
  resolveWorkspaceKnowledgeRetrievalPages,
  retrieveUserMemory,
} from '../storage/index-rebuild.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  allocateRetrievalTraceId,
  publishRetrievalTrace,
  readRetrievalTrace,
  retrievalTraceRelativePath,
} from '../storage/retrieval-traces.js';
import { verifyWorkspaceExportTree } from '../storage/workspace-export.js';
import {
  createVerifiedWorkspaceExport,
  existingWorkspaceExportRoot,
} from '../storage/workspace-transfer-routes.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { notebookImportFixture } from '../test-support/notebook-import.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { readMemoryPage, saveMemoryPage } from './memory-lifecycle.js';
import { KnowledgeNotebook } from './notebook.js';
import { registerUserKnowledgeSource } from './scoped-knowledge-sources.js';
import { initializeScopedNotebook, resolveScopedNotebookOwner } from './scoped-notebook-owner.js';

const query = 'portablePreferenceMarker';

/** Separate real deployments deliberately use the same canonical local User identity. */
async function deployment() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memory-trace-portability-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'local' as const, userId };
  const actorRef = { kind: 'user' as const, id: userId };
  const userDb = openUserDb(dataRoot, userId);
  applyScopedMigrations(userDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Memory trace portability', {
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
  initializeScopedNotebook({
    ...writer,
    target: { kind: 'user' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:memory-portability' },
  });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(
      resolveScopedNotebookOwner({ ...writer, target: { kind: 'user' } }).notebookRoot,
      'notebook.git'
    ),
  });
  const timeline = await openAssistantTimeline(store, workspace.id, userId, 'Private Assistant');
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
      baseRevision: notebook.publishedRevision(),
      pageId: 'preferences',
      content: serializeKnowledgePageFixture(
        {
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
    await shutdownControlStoreWorkerClient();
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
    const source = await deployment();
    const target = await deployment();
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
    const exported = await createVerifiedWorkspaceExport({
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
    const traceRelative = retrievalTraceRelativePath(selected.retrievalTraceRef!);
    const exportedTraceText = verified.fileContents.get(`workspace-files/${traceRelative}`)!;
    expect(JSON.parse(exportedTraceText)).toEqual(
      JSON.parse(
        readFileSync(
          join(source.dataRoot, 'workspaces', source.workspace.id, traceRelative),
          'utf8'
        )
      )
    );
    const exportedTrace = JSON.parse(exportedTraceText);
    expect(exportedTrace.queryContext).toEqual(original.queryContext);
    expect(exportedTrace.queryContext.serverId).toBe(sourceServerId);
    expect(exportedTrace.queryContext.workspaceId).toBe(source.workspace.id);
    expect(exportedTrace.selected[0]).toMatchObject({
      reference: { scopeId: userPageScope(source), objectId: 'preferences' },
      revision: saved.notebookRevision,
      sourceReferences: sourceRefs,
    });

    const targetPage = readMemoryPage(target.writer, 'preferences')!;
    const importedId = allocateEntityId('ws');
    const imported = await target.store.importWorkspaceSnapshot({
      ...notebookImportFixture({
        workspaceId: importedId,
        knowledge: [],
        userId: target.userId,
      }),
      workspace: WorkspaceRecordSchema.parse({
        id: importedId,
        name: 'Imported memory trace',
        kind: 'general',
        status: 'active',
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        importedFrom: {
          sourceDeploymentId: sourceServerId,
          sourceWorkspaceId: source.workspace.id,
          exportCreatedAt: verified.manifest.exportCreatedAt,
          manifestDigest: verified.manifestDigest,
        },
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
      }),
      threads: [],
      turns: [],
      knowledge: [],
      itemRevisions: [],
      artifacts: [],
      agentSessions: [],
      turnEvents: [],
    });
    recordWorkspaceOwnerMembership({
      coreDb: target.coreDb,
      workspaceId: imported.id,
      ownerUserId: target.userId,
    });
    const foreignThread = await openAssistantTimeline(
      target.store,
      imported.id,
      target.userId,
      'Imported trace owner'
    );
    const foreignTraceId = allocateRetrievalTraceId();
    const reference = {
      scopeId: `retrieval-trace/thread/${imported.id}/${foreignThread.id}`,
      objectId: foreignTraceId,
    };
    publishRetrievalTrace(join(target.dataRoot, 'workspaces', imported.id), reference, {
      ...original,
      traceId: foreignTraceId,
      queryContext: {
        ...original.queryContext,
        serverId: sourceServerId,
        workspaceId: imported.id,
        threadId: foreignThread.id,
      },
    });
    const access = { ...target.access, outputThreadId: foreignThread.id };
    const persisted = readRetrievalTrace(
      join(target.dataRoot, 'workspaces', imported.id),
      reference
    )!;
    expect(persisted.queryContext.serverId).toBe(sourceServerId);
    expect(persisted.selected).toEqual(original.selected);
    expect(readMemoryPage(target.writer, 'preferences')).toEqual(targetPage);
    expect(existsSync(join(target.dataRoot, 'users', target.userId, 'sources'))).toBe(false);
    expect(() =>
      assertKnowledgeRetrievalTraceReadable({
        dataRoot: target.dataRoot,
        workspaceId: imported.id,
        access,
        retrievalTraceRef: reference,
      })
    ).toThrowError(expect.objectContaining({ status: 403 }));
    expect(() =>
      resolveWorkspaceKnowledgeRetrievalPages({
        dataRoot: target.dataRoot,
        workspaceId: imported.id,
        access,
        retrievalTraceRef: reference,
        caller: 'app-api',
      })
    ).toThrowError(expect.objectContaining({ status: 403 }));
    const fresh = await retrieveUserMemory({
      dataRoot: target.dataRoot,
      workspaceId: imported.id,
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
        workspaceId: imported.id,
        access,
        retrievalTraceRef: fresh.retrievalTraceRef!,
      }).traceId
    ).toBe(fresh.retrievalTraceRef!.objectId);

    const sameId = allocateEntityId('ws');
    const sameWorkspace = await source.store.importWorkspaceSnapshot({
      ...notebookImportFixture({
        workspaceId: sameId,
        knowledge: [],
        userId: source.userId,
      }),
      workspace: WorkspaceRecordSchema.parse({
        id: sameId,
        name: 'Same deployment memory trace',
        kind: 'general',
        status: 'active',
        counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        importedFrom: {
          sourceDeploymentId: sourceServerId,
          sourceWorkspaceId: source.workspace.id,
          exportCreatedAt: verified.manifest.exportCreatedAt,
          manifestDigest: verified.manifestDigest,
        },
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
      }),
      threads: [],
      turns: [],
      knowledge: [],
      itemRevisions: [],
      artifacts: [],
      agentSessions: [],
      turnEvents: [],
    });
    recordWorkspaceOwnerMembership({
      coreDb: source.coreDb,
      workspaceId: sameWorkspace.id,
      ownerUserId: source.userId,
    });
    const sameThread = await openAssistantTimeline(
      source.store,
      sameWorkspace.id,
      source.userId,
      'Same deployment owner'
    );
    const sameTraceId = allocateRetrievalTraceId();
    const sameReference = {
      scopeId: `retrieval-trace/thread/${sameWorkspace.id}/${sameThread.id}`,
      objectId: sameTraceId,
    };
    publishRetrievalTrace(join(source.dataRoot, 'workspaces', sameWorkspace.id), sameReference, {
      ...original,
      traceId: sameTraceId,
      queryContext: {
        ...original.queryContext,
        workspaceId: sameWorkspace.id,
        threadId: sameThread.id,
      },
    });
    expect(
      assertKnowledgeRetrievalTraceReadable({
        dataRoot: source.dataRoot,
        workspaceId: sameWorkspace.id,
        access: { ...source.access, outputThreadId: sameThread.id },
        retrievalTraceRef: sameReference,
      }).selected
    ).toEqual(original.selected);
  });
});

/** Keeps each deployment's actual User base in retained trace references. */
function userPageScope(owner: Awaited<ReturnType<typeof deployment>>): string {
  return `page/user/${owner.userId}/${readDefaultKnowledgeBaseId({ dataRoot: owner.dataRoot, scope: { kind: 'user', userId: owner.userId } })}`;
}
