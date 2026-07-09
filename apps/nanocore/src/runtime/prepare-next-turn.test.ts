import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { LlmProjectionResult } from '../context/llm-projection.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { upsertWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import { prepareNextTurn } from './prepare-next-turn.js';
import {
  drainFollowUpInputs,
  drainSteeringForSafePoint,
  enqueueFollowUpInput,
  enqueueSteeringForSafePoint,
} from './user-turn-queues.js';

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

describe('prepareNextTurn', () => {
  it('prepares a structured worker request for the next task', () => {
    const coreDb = createCoreDb();

    try {
      addReadyRepository(coreDb, 'ws_demo');

      const prepared = prepareNextTurn(coreDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalState: {
          goalId: 'goal_demo',
          title: 'Ship release',
          objective: 'Make v0.0.6 ready for release.',
          acceptanceCriteria: ['Release checks pass.'],
        },
        taskState: {
          taskId: 'task_demo',
          title: 'Implement storage helper',
          objective: 'Add a helper for durable user turn queues.',
          acceptanceCriteria: ['Helper tests pass.', 'No raw user text is persisted.'],
          expectedArtifacts: [{ kind: 'code-change', description: 'NanoCore helper files.' }],
          verification: [
            {
              kind: 'test',
              description: 'Run focused NanoCore tests.',
              command: 'pnpm --filter @openkit/nanocore test',
            },
          ],
          stopConditions: ['Stop after verification fails twice.'],
        },
        contextProjection: projectionFixture(['item_context']),
        steeringMessages: [],
        followUpInputs: [],
      });

      expect(prepared.contextPackageDigest).toBe('ctxpkg_sha256_demo');
      expect(prepared.repository.resourceId).toBe('repo_default');
      expect(prepared.delegationRequest).toMatchObject({
        objective: 'Add a helper for durable user turn queues.',
        acceptanceCriteria: ['Helper tests pass.', 'No raw user text is persisted.'],
        expectedArtifacts: [{ kind: 'code-change', description: 'NanoCore helper files.' }],
        constraints: {
          maxContextTokens: 240000,
          maxWorkerIterations: 1,
          requiresUserConfirmation: true,
          stopConditions: ['Stop after verification fails twice.'],
        },
      });
      expect(prepared.delegationRequest.contextRefs).toEqual([
        { kind: 'workspace', id: 'ws_demo' },
        { kind: 'thread', id: 'th_demo' },
        { kind: 'item', id: 'item_context' },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('includes queued steering and follow-up item refs in the prepared request', () => {
    const coreDb = createCoreDb();
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'user_local', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      addReadyRepository(coreDb, 'ws_demo');
      enqueueSteeringForSafePoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_steering',
        contentItemId: 'item_steering',
        receivedAt: '2026-05-31T00:00:00.000Z',
      });
      enqueueFollowUpInput(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_follow_up',
        contentItemId: 'item_follow_up',
        receivedAt: '2026-05-31T00:01:00.000Z',
      });

      const prepared = prepareNextTurn(coreDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalState: {
          goalId: 'goal_demo',
          title: 'Ship release',
          objective: 'Make v0.0.6 ready for release.',
          acceptanceCriteria: ['Release checks pass.'],
        },
        taskState: {
          taskId: 'task_demo',
          title: 'Implement queue drain',
          objective: 'Drain queued inputs for the next worker turn.',
          acceptanceCriteria: ['Queued steering is included.'],
          expectedArtifacts: [{ kind: 'code-change', description: 'Queue helper files.' }],
          verification: [{ kind: 'test', description: 'Run queue helper tests.' }],
          stopConditions: ['Stop when queued input cannot be prepared.'],
        },
        contextProjection: projectionFixture(['item_context']),
        steeringMessages: drainSteeringForSafePoint(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
        }),
        followUpInputs: drainFollowUpInputs(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          drainMode: 'all',
        }),
      });

      expect(prepared.delegationRequest.contextRefs).toEqual([
        { kind: 'workspace', id: 'ws_demo' },
        { kind: 'thread', id: 'th_demo' },
        { kind: 'item', id: 'item_context' },
        { kind: 'item', id: 'item_steering' },
        { kind: 'item', id: 'item_follow_up' },
      ]);
      expect(prepared.steeringMessages.map((message) => message.pendingTurn.requestId)).toEqual([
        'req_steering',
      ]);
      expect(prepared.followUpInputs.map((input) => input.pendingTurn.requestId)).toEqual([
        'req_follow_up',
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('keeps generated review instructions within the delegation schema limit', () => {
    const coreDb = createCoreDb();

    try {
      addReadyRepository(coreDb, 'ws_demo');

      const prepared = prepareNextTurn(coreDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        goalState: {
          goalId: 'goal_demo',
          title: `Research ${'NemoClaw '.repeat(200)}`,
          objective: `Compare OpenShell orchestration. ${'Use concrete evidence. '.repeat(200)}`,
          acceptanceCriteria: [`Criteria ${'must remain bounded. '.repeat(120)}`],
        },
        taskState: {
          taskId: 'task_demo',
          title: `Write report ${'with source citations. '.repeat(120)}`,
          objective: 'Produce one research report.',
          acceptanceCriteria: ['Report is committed.'],
          expectedArtifacts: [{ kind: 'document', description: 'Research report.' }],
          verification: [{ kind: 'manual', description: 'Review report.' }],
          stopConditions: ['Stop after one bounded worker turn.'],
        },
        contextProjection: projectionFixture(['item_context']),
        steeringMessages: [],
        followUpInputs: [],
      });

      expect(prepared.delegationRequest.reviewPolicy.instructions.length).toBeLessThanOrEqual(2000);
      expect(prepared.delegationRequest.reviewPolicy.instructions).toContain('[truncated]');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails when the workspace has no ready repository or no included context', () => {
    const coreDb = createCoreDb();

    try {
      expect(() =>
        prepareNextTurn(coreDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalState: {
            goalId: 'goal_demo',
            title: 'Ship release',
            objective: 'Make v0.0.6 ready for release.',
            acceptanceCriteria: ['Release checks pass.'],
          },
          taskState: {
            taskId: 'task_demo',
            title: 'Implement helper',
            objective: 'Prepare a worker turn.',
            acceptanceCriteria: ['Worker request is created.'],
            expectedArtifacts: [{ kind: 'code-change', description: 'Runtime helper.' }],
            verification: [{ kind: 'test', description: 'Run helper tests.' }],
            stopConditions: ['Stop on missing repository.'],
          },
          contextProjection: projectionFixture(['item_context']),
          steeringMessages: [],
          followUpInputs: [],
        })
      ).toThrow('Workspace repository not ready: ws_demo');

      addReadyRepository(coreDb, 'ws_demo');

      expect(() =>
        prepareNextTurn(coreDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          goalState: {
            goalId: 'goal_demo',
            title: 'Ship release',
            objective: 'Make v0.0.6 ready for release.',
            acceptanceCriteria: ['Release checks pass.'],
          },
          taskState: {
            taskId: 'task_demo',
            title: 'Implement helper',
            objective: 'Prepare a worker turn.',
            acceptanceCriteria: ['Worker request is created.'],
            expectedArtifacts: [{ kind: 'code-change', description: 'Runtime helper.' }],
            verification: [{ kind: 'test', description: 'Run helper tests.' }],
            stopConditions: ['Stop on missing context.'],
          },
          contextProjection: projectionFixture([]),
          steeringMessages: [],
          followUpInputs: [],
        })
      ).toThrow('prepareNextTurn requires at least one included context item.');
    } finally {
      coreDb.sqlite.close();
    }
  });
});
