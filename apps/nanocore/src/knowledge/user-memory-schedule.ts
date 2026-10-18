import { allocateEntityId } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import { isCanonicalUserOperationAuthorized } from '../auth/operation-authorizer.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import { uuidv5 } from '../generative-kernel/uuid.js';
import { type FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { type CoreDb, openUserDb, type UserDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { ensureUserQuickChatWorkspace } from '../workspace-membership.js';
import { scanDailyKnowledgeMaintenance } from './knowledge-maintenance-schedule.js';
import {
  prepareUserMemoryMaintenance,
  type UserMemoryMaintenanceDependencies,
} from './user-memory-agent-maintenance.js';

/** Existing daily scan and scope records; no timer, session or execution authority is created. */
export function scanUserMemoryMaintenance(input: {
  readonly now: string;
  readonly store: FsStore;
  readonly coreDb: CoreDb;
  readonly runtimeConfigManager: RuntimeConfigManager;
  readonly localUserId?: string;
  readonly dependencies: (userDb: UserDb) => UserMemoryMaintenanceDependencies;
}): void {
  const { store, coreDb } = input;
  const turns = (userId: string) => {
    const workspaceId = quickChatWorkspaceIdForUser(userId);
    if (!store.listWorkspaces().some((workspace) => workspace.id === workspaceId)) return [];
    return store
      .listThreads(workspaceId)
      .filter(
        (thread) =>
          thread.entryPath === 'knowledge-manager' &&
          thread.visibility === 'private' &&
          thread.privateOwnerUserId === userId
      )
      .flatMap((thread) => store.listThreadTurns(workspaceId, thread.id));
  };
  scanDailyKnowledgeMaintenance({
    now: input.now,
    scopes: input.runtimeConfigManager.current().userConfigs.map(({ userId, config }) => ({
      ownerScope: { kind: 'user' as const, userId },
      schedule: config.knowledgeMaintenance?.schedule,
    })),
    listTurns: ({ ownerScope }) =>
      turns(ownerScope.userId)
        .filter((turn) => turn.startedAt !== null)
        .map((turn) => ({
          startedAt: turn.startedAt!,
          ...(turn.internalExecution?.knowledge
            ? {
                internalExecution: {
                  roleId: turn.internalExecution.roleId,
                  knowledge: turn.internalExecution.knowledge,
                },
              }
            : turn.triggerSource?.kind === 'automation' &&
                turn.triggerSource.summary === 'User Memory maintenance.'
              ? {
                  internalExecution: {
                    roleId: 'knowledge-manager',
                    knowledge: {
                      purpose: 'maintenance' as const,
                      ownerScope,
                      trigger: 'schedule' as const,
                    },
                  },
                }
              : {}),
        })),
    prepare: ({ ownerScope }, startedAt) => {
      const userId = ownerScope.userId;
      let userDb: UserDb | undefined;
      try {
        let actor: Actor | undefined;
        if (input.localUserId === userId) actor = { kind: 'local', userId };
        if (!actor || !isCanonicalUserOperationAuthorized(coreDb, actor))
          throw new Error('Current User maintenance authority is unavailable.');
        ensureUserQuickChatWorkspace({ coreDb, store, userId });
        userDb = openUserDb(coreDb.dataRoot, userId);
        applyScopedMigrations(userDb);
        const ownedDb = userDb;
        const prepared = prepareUserMemoryMaintenance(input.dependencies(ownedDb), {
          requestId: uuidv5(
            JSON.stringify(['memory.maintain', ownerScope, startedAt.slice(0, 10)])
          ),
          requestActor: actor,
          trigger: 'schedule',
          startedAt,
          instructions:
            'Consolidate this User notebook and its admitted explicit personal information. Preserve human edits and keep the Memory overview current. Do not learn from Workspace Threads.',
          sources: [],
          signal: new AbortController().signal,
        });
        return {
          execute: async () => {
            try {
              await prepared.execute();
            } catch {
              prepared.fail();
            } finally {
              ownedDb.sqlite.close();
            }
          },
          fail: () => {
            try {
              prepared.fail();
            } finally {
              if (ownedDb.sqlite.open) ownedDb.sqlite.close();
            }
          },
        };
      } catch {
        if (userDb?.sqlite.open) userDb.sqlite.close();
        // A missing credential is an inspectable skipped run, never a fabricated session.
        ensureUserQuickChatWorkspace({ coreDb, store, userId });
        const workspaceId = quickChatWorkspaceIdForUser(userId);
        const prior = turns(userId).find(
          (turn) => turn.triggerSource?.summary === 'User Memory maintenance.'
        );
        const thread = prior
          ? store.getThread(workspaceId, prior.threadId)
          : store.createThread(workspaceId, 'Memory maintenance', undefined, 'knowledge-manager', {
              visibility: 'private',
              privateOwnerUserId: userId,
            });
        const turn = store.createTurn(
          workspaceId,
          thread.id,
          'Scheduled User Memory maintenance was skipped.',
          { kind: 'user', id: userId },
          null,
          {
            agentId: 'knowledge-manager',
            executorKind: 'assistant',
            startedAt,
            triggerSource: { kind: 'automation', summary: 'User Memory maintenance.' },
          }
        );
        const completedAt = new Date().toISOString();
        store.createItem({
          id: allocateEntityId('it'),
          workspaceId,
          threadId: thread.id,
          turnId: turn.id,
          type: 'status',
          status: 'failed',
          level: 'error',
          title: 'Memory maintenance skipped',
          summary:
            'Current User authority, notebook or model admission is unavailable. Inspect the failure and request a new run.',
          createdAt: completedAt,
          completedAt,
        });
        store.updateTurn(turn.id, {
          status: 'failed',
          completedAt,
          error: {
            code: 'memory_maintenance_unavailable',
            message: 'Scheduled Memory maintenance could not be admitted.',
          },
        });
        return null;
      }
    },
    onError: () => console.warn('User Memory maintenance requires inspection.'),
  });
}
