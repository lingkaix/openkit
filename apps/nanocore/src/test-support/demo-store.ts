import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { z } from 'zod';
import { knowledgePageFixture } from './knowledge-page.js';

type Thread = z.infer<typeof ThreadSchema>;
type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;
type KnowledgeNotebookPage = z.infer<typeof KnowledgeNotebookPageSchema>;

import {
  allocateEntityId,
  type KnowledgeNotebookPageSchema,
  type ThreadSchema,
  type TurnSchema,
  type WorkspaceRecordSchema,
} from '@openkit/protocol';
import { FsStore, type FsStoreOptions } from '../lib/store.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { coreDbPath } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from './local-user.js';
import { notebookImportFixture } from './notebook-import.js';
import { createTestStore } from './store.js';

const userFixtures = new Map<string, { workspaceId: string; threadId: string }>();
/** Explicit canonical IDs retained by the ordinary Demo fixture. */
export const DEMO_WORKSPACE_ID = 'ws_00000000-0000-7000-8000-000000000001';
/** Explicit canonical starter Thread retained by the ordinary Demo fixture. */
export const DEMO_THREAD_ID = 'th_00000000-0000-7000-8000-000000000001';

/**
 * Demo workspace fixture for tests and local development tools.
 */
export interface DemoWorkspaceFixture {
  /** Project workspace record. */
  readonly workspace: WorkspaceRecord;
  /** Starter thread owned by the project workspace. */
  readonly thread: Thread;
  /** Starter knowledge entries owned by the project workspace. */
  readonly knowledge: readonly KnowledgeNotebookPage[];
}

/**
 * Creates the explicit Demo Workspace fixture for one user without mutating a store.
 *
 * @param userId User id that should own the fixture ids.
 * @returns Demo workspace snapshot pieces that can be imported into a store.
 */
export function createDemoWorkspaceForUser(userId: string): DemoWorkspaceFixture {
  const timestamp = new Date().toISOString();
  let ids = userFixtures.get(userId);
  if (!ids) {
    ids =
      userId === FIXTURE_LOCAL_USER_ID
        ? { workspaceId: DEMO_WORKSPACE_ID, threadId: DEMO_THREAD_ID }
        : { workspaceId: allocateEntityId('ws'), threadId: allocateEntityId('th') };
    userFixtures.set(userId, ids);
  }
  const workspace: WorkspaceRecord = {
    id: ids.workspaceId,
    name: 'Demo Workspace',
    kind: 'code',
    status: 'active',
    counts: {
      threadCount: 1,
      artifactCount: 0,
      knowledgeEntryCount: 1,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const knowledge: KnowledgeNotebookPage[] = [
    knowledgePageFixture(
      {
        id: 'mem_project',
        title: 'Product focus',
        content: 'Drive the workspace protocol through a real Codex-backed local agent adapter.',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      { kind: 'workspace', workspaceId: workspace.id }
    ),
  ];
  const thread: Thread = {
    id: ids.threadId,
    owner: { kind: 'workspace', workspaceId: workspace.id },
    name: 'Protocol design review',
    preview: 'Review the UI-first workspace protocol slice and tighten payload boundaries.',
    status: 'active',
    entryPath: 'conversation',
    visibility: 'workspace',
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return { workspace, thread, knowledge };
}

/**
 * Imports the Demo Workspace fixture into a store when it is absent.
 *
 * @param store Store that should receive the demo fixture.
 * @param userId User id namespace for the fixture ids.
 * @returns After the native fixture import is durably acknowledged.
 */
export async function seedDemoWorkspace(
  store: FsStore,
  userId = FIXTURE_LOCAL_USER_ID
): Promise<void> {
  const demo = createDemoWorkspaceForUser(userId);

  try {
    store.getWorkspace(demo.workspace.id);
    return;
  } catch {
    await store.importWorkspaceSnapshot({
      workspace: demo.workspace,
      threads: [demo.thread],
      knowledge: demo.knowledge,
      turns: [],
      itemRevisions: [],
      artifacts: [],
      agentSessions: [],
      turnEvents: [],
      notebookInitialization: {
        requestId: randomUUID(),
        producer: { kind: 'user', id: userId },
        instructionReference: 'test-fixture:demo-workspace',
      },
      initialNotebookFiles: Object.fromEntries(
        demo.knowledge.map((page) => [page.path, page.content])
      ),
    });
  }
}

/**
 * Creates a test store with Quick Chat plus the explicit Demo Workspace fixture.
 *
 * @param options Store options.
 * @param fixtureUserId User namespace used only to derive deterministic fixture ids.
 * @returns Promise for the Store after its native Workspace fixtures are durably acknowledged.
 */
export async function createDemoStore(
  options: FsStoreOptions = {},
  fixtureUserId = FIXTURE_LOCAL_USER_ID
): Promise<FsStore> {
  // File-backed native product readers require their actual Core schema before Store construction.
  if (options.dataRoot && !existsSync(coreDbPath(options.dataRoot))) {
    const coreDb = openCoreDb(options.dataRoot);
    try {
      applyMigrations(coreDb);
    } finally {
      coreDb.sqlite.close();
    }
  }
  const store = new FsStore(options);
  await store.ensureQuickChatWorkspace(fixtureUserId);
  await seedDemoWorkspace(store, fixtureUserId);
  return store;
}

/**
 * Cold-imports earlier extra private history without admitting a new duplicate.
 * @param store Fresh unpublished personal Workspace destination; its native writer is stopped first.
 * @param userId Canonical User owning both retained private conversations.
 * @returns After validated native import; no original-release or live command ACK is claimed.
 */
export async function seedRetainedPersonalWorkspace(
  store: FsStore,
  userId = FIXTURE_LOCAL_USER_ID
) {
  await shutdownControlStoreWorkerClient();
  const demo = createDemoWorkspaceForUser(userId);
  const workspace = await new FsStore().ensureQuickChatWorkspace(userId);
  await store.importWorkspaceSnapshot({
    workspace,
    threads: ['Timeline', 'Retained history'].map((name, index) => ({
      ...demo.thread,
      id: allocateEntityId('th'),
      owner: { kind: 'workspace' as const, workspaceId: workspace.id },
      name,
      visibility: 'private' as const,
      privateOwnerUserId: userId,
      createdAt: new Date(Date.parse(workspace.createdAt) + index).toISOString(),
      updatedAt: new Date(Date.parse(workspace.createdAt) + index).toISOString(),
    })),
    turns: [],
    knowledge: [],
    itemRevisions: [],
    artifacts: [],
    agentSessions: [],
    turnEvents: [],
    ...notebookImportFixture({ workspaceId: workspace.id, knowledge: [], userId }),
  });
}

/**
 * Cold-imports terminal Worker history into a fresh unpublished Demo Workspace.
 * @param options Caller-owned fixture root; existing Workspace roots are refused.
 * @param entries Explicit earlier work, with no native execution, receipt or release claim.
 * @returns Store whose retained products passed the real snapshot import owner.
 */
export async function createRetainedDemoStore(
  options: { dataRoot: string },
  entries: readonly {
    name: string;
    input: string;
    agentId: string;
    timestamp: string;
    failed?: {
      completedAt: string;
      message: string;
      error: NonNullable<z.infer<typeof TurnSchema>['error']>;
    };
  }[]
): Promise<FsStore> {
  const retained = await createDemoStore();
  for (const entry of entries) {
    const thread = await retained.createThread(DEMO_WORKSPACE_ID, entry.name);
    const turn = await retained.createTurn(
      DEMO_WORKSPACE_ID,
      thread.id,
      entry.input,
      { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      null,
      { startedAt: entry.timestamp }
    );
    const session = await retained.createAgentSession({
      id: allocateEntityId('as'),
      agentId: entry.agentId,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: thread.id,
      status: entry.failed ? 'failed' : 'idle',
      message: entry.failed?.message ?? null,
      createdAt: entry.timestamp,
      updatedAt: entry.failed?.completedAt ?? entry.timestamp,
    });
    await retained.updateTurn(turn.id, {
      agentId: entry.agentId,
      agentSessionId: session.id,
      status: entry.failed ? 'failed' : 'completed',
      completedAt: entry.failed?.completedAt ?? entry.timestamp,
      ...(entry.failed ? { error: entry.failed.error } : {}),
    });
  }
  await shutdownControlStoreWorkerClient();
  const store = createTestStore(options);
  const coreDb = openCoreDb(options.dataRoot);
  try {
    ensureLocalUser(coreDb);
  } finally {
    coreDb.sqlite.close();
  }
  const workspace = retained.getWorkspace(DEMO_WORKSPACE_ID);
  const threads = retained.listThreads(workspace.id);
  const turns = threads.flatMap((thread) => retained.listThreadTurns(workspace.id, thread.id));
  const knowledge = retained.getWorkspaceResources(workspace.id).knowledge;
  await store.importWorkspaceSnapshot({
    workspace,
    threads,
    turns,
    knowledge,
    itemRevisions: turns.flatMap((turn) => turn.items),
    artifacts: [],
    agentSessions: retained.listWorkspaceAgentSessions(workspace.id),
    turnEvents: turns.map((turn) => [turn.id, retained.getTurnEventsForExport(turn.id)]),
    turnCaptureCoverage: new Map(
      turns.map((turn) => [turn.id, retained.getTurnCaptureCoverage(turn.id)!])
    ),
    ...notebookImportFixture({ workspaceId: workspace.id, knowledge }),
  });
  return store;
}
