import { randomUUID } from 'node:crypto';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import type { z } from 'zod';

type Thread = z.infer<typeof ThreadSchema>;
type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;
type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

import {
  allocateEntityId,
  type KnowledgeEntrySchema,
  type ThreadSchema,
  type WorkspaceRecordSchema,
} from '@openkit/protocol';
import { FsStore, type FsStoreOptions } from '../lib/store.js';
import { FIXTURE_LOCAL_USER_ID } from './local-user.js';

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
  readonly knowledge: readonly KnowledgeEntry[];
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
  const knowledge: KnowledgeEntry[] = [
    {
      id: 'mem_project',
      kind: 'project-context',
      title: 'Product focus',
      content: 'Drive the workspace protocol through a real Codex-backed local agent adapter.',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  const thread: Thread = {
    id: ids.threadId,
    workspaceId: workspace.id,
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
 */
export function seedDemoWorkspace(store: FsStore, userId = FIXTURE_LOCAL_USER_ID): void {
  const demo = createDemoWorkspaceForUser(userId);

  try {
    store.getWorkspace(demo.workspace.id);
    return;
  } catch {
    store.importWorkspaceSnapshot({
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
        demo.knowledge.map((entry) => [
          `${entry.id}.md`,
          serializeUserAuthoredKnowledgePage(entry, {
            kind: 'workspace',
            workspaceId: demo.workspace.id,
          }),
        ])
      ),
    });
  }
}

/**
 * Creates a test store with Quick Chat plus the explicit Demo Workspace fixture.
 *
 * @param options Store options.
 * @param fixtureUserId User namespace used only to derive deterministic fixture ids.
 * @returns Store with project workspace fixtures.
 */
export function createDemoStore(
  options: FsStoreOptions = {},
  fixtureUserId = FIXTURE_LOCAL_USER_ID
): FsStore {
  const store = new FsStore(options);
  store.ensureQuickChatWorkspace(fixtureUserId);
  seedDemoWorkspace(store, fixtureUserId);
  return store;
}
