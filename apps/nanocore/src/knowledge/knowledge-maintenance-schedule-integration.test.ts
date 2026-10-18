import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationToolName } from '@openkit/app-api-schemas';
import { expect, it, onTestFinished } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { createKnowledgeAnswerApp } from '../test-support/knowledge-agent.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { KnowledgeNotebook } from './notebook.js';
import { currentServerMaintenanceActor } from './server-knowledge-maintenance.js';

it('never borrows a stored administrator credential for scheduled Server maintenance', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-server-schedule-authority-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  expect(currentServerMaintenanceActor(coreDb)).toBeUndefined();
  expect(currentServerMaintenanceActor(coreDb, userId)).toEqual({ kind: 'local', userId });
  const directory = join(dataRoot, 'config');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'server.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      knowledgeMaintenance: {
        enabled: false,
        reviewRequiredPageIds: [],
        schedule: { enabled: true },
      },
    })
  );
  const store = new FsStore({ dataRoot });
  let scan!: (instant: string) => void;
  createApp({
    mode: 'server',
    coreDb,
    dataRoot,
    store,
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
    onKnowledgeMaintenanceReady: (callback) => {
      scan = callback;
    },
  });
  scan('2026-10-18T08:00:00.000Z');
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const turns = store
    .listServerThreads()
    .flatMap((thread) => store.listServerThreadTurns(thread.id));
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ status: 'failed', triggerSource: { kind: 'automation' } });
  expect(turns[0]!.items).toContainEqual(
    expect.objectContaining({
      type: 'status',
      knowledgeMaintenanceResult: expect.objectContaining({ outcome: 'failed' }),
    })
  );
  scan('2026-10-18T09:00:00.000Z');
  expect(store.listServerThreadTurns(turns[0]!.threadId)).toHaveLength(1);
});

it('keeps scheduling off by default and retains a visible unavailable-model outcome once per day', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-schedule-app-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Scheduled maintenance');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const directory = join(dataRoot, 'workspaces', workspace.id, 'config');
  mkdirSync(directory, { recursive: true });
  const configure = (enabled: boolean) =>
    writeFileSync(
      join(directory, 'workspace.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        workspace: {
          name: workspace.name,
          internalRoles: [{ roleId: 'knowledge-manager', profileId: 'missing-knowledge-profile' }],
          knowledgeMaintenance: {
            enabled: false,
            reviewRequiredPageIds: [],
            ...(enabled ? { schedule: { enabled: true } } : {}),
          },
        },
      })
    );
  let scan!: (instant: string) => void;
  const boot = () =>
    createApp({
      coreDb,
      dataRoot,
      store,
      runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
      onKnowledgeMaintenanceReady: (callback) => {
        scan = callback;
      },
    });
  const turns = () =>
    store
      .listThreads(workspace.id)
      .flatMap((thread) => store.listThreadTurns(workspace.id, thread.id));
  configure(false);
  boot();
  scan('2026-10-17T10:00:00.000Z');
  expect(turns()).toEqual([]);
  configure(true);
  boot();
  scan('2026-10-17T10:01:00.000Z');
  const retained = turns();
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({
    agentId: 'knowledge-manager',
    status: 'failed',
    triggerSource: { kind: 'automation', summary: 'Knowledge Manager scheduled maintenance.' },
    error: { code: 'knowledge_maintenance_failed' },
  });
  const turn = retained[0]!;
  expect(
    store.listThreadItems(workspace.id, turn.threadId).filter((item) => item.turnId === turn.id)
  ).toContainEqual(
    expect.objectContaining({
      type: 'status',
      status: 'failed',
      title: 'Knowledge maintenance',
    })
  );
  // Boot and a later scan retain the same outcome; neither restarts model work.
  boot();
  scan('2026-10-17T20:00:00.000Z');
  expect(turns().map(({ id }) => id)).toEqual([turn.id]);
});

it('stops bounded maintenance through the public Turn command before a late Provider Tool can run', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-maintenance-stop-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Interruptible maintenance');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
  });
  const baseRevision = notebook.publishedRevision();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { app, createResponses } = createKnowledgeAnswerApp({ coreDb, dataRoot, store }, []);
  createResponses.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return {
      id: 'late-provider-response',
      object: 'response',
      output: [
        {
          type: 'function_call',
          call_id: 'late-edit',
          name: operationToolName('knowledge.notebook-workspace.update'),
          arguments: JSON.stringify({ script: 'echo late > late.md' }),
        },
      ],
    };
  });
  onTestFinished(() => {
    release.resolve();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const pending = app.request(
    ...operationRequest(
      'knowledge.maintain',
      {},
      {
        body: JSON.stringify({
          workspaceId: workspace.id,
          requestId: randomUUID(),
          instruction: 'Organize this notebook.',
        }),
      }
    )
  );
  try {
    await entered.promise;
    const turn = store
      .listThreads(workspace.id)
      .flatMap((thread) => store.listThreadTurns(workspace.id, thread.id))
      .find((turn) => turn.agentId === 'knowledge-manager')!;
    expect(turn.status).toBe('running');
    const stopped = await app.request(
      ...operationRequest(
        'turn.interrupt',
        {},
        {
          body: JSON.stringify({
            workspaceId: workspace.id,
            threadId: turn.threadId,
            turnId: turn.id,
            requestId: randomUUID(),
          }),
        }
      )
    );
    expect(stopped.status).toBe(200);
    expect(store.getTurnById(turn.id).status).toBe('cancelled');
    release.resolve();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'failed', turnId: turn.id });
    expect(notebook.publishedRevision()).toBe(baseRevision);
    expect(store.getTurnById(turn.id).items.some((item) => item.type === 'tool-call')).toBe(false);
    expect(createResponses).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await pending;
  }
});
