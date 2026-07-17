import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LlmProjectionResult } from '../context/llm-projection.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { upsertWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import { prepareNextTurnContext } from './prepare-next-turn.js';

const TASK_EXECUTION_CONTRACT = {
  contextBudgetTokens: 12_000,
  resources: [
    {
      kind: 'repository' as const,
      reference: 'linked workspace repository',
      reason: 'The task changes repository code.',
    },
  ],
  expectedArtifacts: [{ kind: 'code-change' as const, description: 'NanoCore helper files.' }],
  verification: [
    {
      kind: 'test' as const,
      description: 'Run focused NanoCore tests.',
      command: 'pnpm --filter @openkit/nanocore test',
    },
  ],
  reviewPolicy: {
    required: true,
    reviewers: ['human'] as const,
    instructions: 'Review the focused diff and test evidence.',
  },
  escalationConditions: ['Escalate if repository setup is invalid.'],
};

/**
 * Opens a migrated Core database for prepare-next-turn tests.
 *
 * @returns Migrated Core database handles.
 */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-prepare-next-turn-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Creates a minimal local git repository marker for repository validation.
 *
 * @returns Local repository path.
 */
function createGitRepositoryPath(): string {
  const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-prepare-next-turn-repo-'));
  mkdirSync(join(repositoryPath, '.git'));
  return repositoryPath;
}

/**
 * Adds a ready default repository resource to one workspace.
 *
 * @param coreDb Open Core database handles.
 * @param workspaceId Workspace id that owns the repository.
 */
function addReadyRepository(coreDb: CoreDb, workspaceId: string): void {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'user_local', workspaceId);
  try {
    applyScopedMigrations(workspaceDb);
    upsertWorkspaceRepositoryResource(workspaceDb, {
      workspaceExists: (candidateWorkspaceId) => candidateWorkspaceId === workspaceId,
      workspaceId,
      displayName: 'OpenKit',
      localPath: createGitRepositoryPath(),
      now: () => '2026-05-31T00:00:00.000Z',
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Builds a context projection fixture for prepare-next-turn tests.
 *
 * @param includedItemIds Durable item ids included in provider-visible context.
 * @returns Context projection result.
 */
function projectionFixture(includedItemIds: readonly string[]): LlmProjectionResult {
  return {
    policyVersion: 1,
    contextPackageDigest: 'ctxpkg_sha256_demo',
    providerMessages: includedItemIds.map((itemId) => ({
      role: 'user',
      content: `Context from ${itemId}`,
    })),
    includedItemIds,
    excludedItems: [],
    decisions: [],
  };
}

describe('prepareNextTurnContext', () => {
  it('prepares authorized worker request facts for the next task', () => {
    const coreDb = createCoreDb();

    try {
      addReadyRepository(coreDb, 'ws_demo');

      const prepared = prepareNextTurnContext(coreDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        taskState: {
          objective: 'Add a helper for durable user turn queues.',
          acceptanceCriteria: ['Helper tests pass.', 'No raw user text is persisted.'],
          ...TASK_EXECUTION_CONTRACT,
        },
        contextProjection: projectionFixture(['item_context']),
      });

      expect(prepared.contextPackageDigest).toBe('ctxpkg_sha256_demo');
      expect(prepared.repository.resourceId).toBe('repo_default');
      expect(prepared.objective).toBe('Add a helper for durable user turn queues.');
      expect(prepared.workerRequestDetails).toMatchObject({
        acceptanceCriteria: ['Helper tests pass.', 'No raw user text is persisted.'],
        resources: TASK_EXECUTION_CONTRACT.resources,
        expectedArtifacts: [{ kind: 'code-change', description: 'NanoCore helper files.' }],
        constraints: {
          maxContextTokens: 12_000,
          maxWorkerIterations: 1,
        },
        verification: TASK_EXECUTION_CONTRACT.verification,
        reviewPolicy: TASK_EXECUTION_CONTRACT.reviewPolicy,
        escalationConditions: TASK_EXECUTION_CONTRACT.escalationConditions,
        reviewContext: null,
      });
      expect(prepared.contextRefs).toEqual([{ kind: 'item', id: 'item_context' }]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails when the workspace has no ready repository or no included context', () => {
    const coreDb = createCoreDb();

    try {
      expect(() =>
        prepareNextTurnContext(coreDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          taskState: {
            objective: 'Prepare a worker turn.',
            acceptanceCriteria: ['Worker request is created.'],
            ...TASK_EXECUTION_CONTRACT,
          },
          contextProjection: projectionFixture(['item_context']),
        })
      ).toThrow('Workspace repository not ready: ws_demo');

      addReadyRepository(coreDb, 'ws_demo');

      expect(() =>
        prepareNextTurnContext(coreDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          taskState: {
            objective: 'Prepare a worker turn.',
            acceptanceCriteria: ['Worker request is created.'],
            ...TASK_EXECUTION_CONTRACT,
          },
          contextProjection: projectionFixture([]),
        })
      ).toThrow('prepareNextTurnContext requires at least one included context item.');
    } finally {
      coreDb.sqlite.close();
    }
  });
});
