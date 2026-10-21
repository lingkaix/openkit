import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Writes the explicit native Demo Workspace fixture used by black-box tests.
 *
 * @param {string} dataRoot NanoCore data root to seed.
 * @returns {Promise<void>} Resolves after native fixture publication and writer shutdown.
 */
export async function seedDemoWorkspaceDataRoot(dataRoot) {
  const demoExists = existsSync(
    join(dataRoot, 'workspaces', 'ws_00000000-0000-7000-8000-000000000001')
  );
  const personalExists = existsSync(
    join(dataRoot, 'workspaces', 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28')
  );
  if (demoExists !== personalExists) {
    throw new Error('Demo workspace fixture is partially initialized.');
  }
  if (demoExists && personalExists) return;
  const [{ FsStore }, { createDemoWorkspaceForUser }, { shutdownControlStoreWorkerClient }] =
    await Promise.all([
      import('../../apps/nanocore/dist/lib/store.js'),
      import('../../apps/nanocore/dist/test-support/demo-store.js'),
      import('../../apps/nanocore/dist/storage/control-store-worker-client.js'),
    ]);
  try {
    await seedDemoWorkspaceAuthority(dataRoot);
    const userId = 'usr_00000000-0000-7000-8000-000000000001';
    const demo = createDemoWorkspaceForUser(userId);
    const store = new FsStore({ dataRoot });
    const timestamp = demo.workspace.createdAt;
    for (const fixture of [
      {
        workspace: demo.workspace,
        threads: [demo.thread],
        knowledge: demo.knowledge,
        knowledgeBaseId: 'kb_00000000-0000-7000-8000-000000000001',
        defaultAgentId: 'agent_codex_host',
      },
      {
        workspace: {
          id: 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28',
          name: 'Personal',
          kind: 'personal',
          status: 'active',
          counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        threads: [],
        knowledge: [],
        knowledgeBaseId: 'kb_00000000-0000-7000-8000-000000000002',
        defaultAgentId: null,
      },
    ]) {
      await store.importWorkspaceSnapshot({
        workspace: fixture.workspace,
        defaultKnowledgeBaseId: fixture.knowledgeBaseId,
        threads: fixture.threads,
        knowledge: fixture.knowledge,
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
          fixture.knowledge.map((page) => [page.path, page.content])
        ),
        stageWorkspace: ({ workspaceRoot }) => {
          writeFileSync(
            join(workspaceRoot, 'config', 'workspace.jsonc'),
            `${JSON.stringify(
              {
                schemaVersion: 1,
                workspace: {
                  name: fixture.workspace.name,
                  defaultAgentId: fixture.defaultAgentId,
                  defaultKnowledgeBaseId: fixture.knowledgeBaseId,
                  knowledgeMounts: [
                    {
                      name: 'managed',
                      backend: 'local',
                      root: 'raw',
                      default: true,
                      knowledgeBaseId: fixture.knowledgeBaseId,
                    },
                  ],
                },
              },
              null,
              2
            )}\n`
          );
        },
      });
    }
  } finally {
    await shutdownControlStoreWorkerClient();
  }
}

/**
 * Records the canonical local owner memberships for both native fixture Workspaces.
 *
 * @param {string} dataRoot NanoCore data root containing the native demo Workspace.
 * @returns {Promise<void>} Resolves after Core membership authority is durable.
 */
export async function seedDemoWorkspaceAuthority(dataRoot) {
  const [
    { ensureLocalUser: ensureFixtureLocalUser },
    { openCoreDb },
    { applyMigrations },
    { recordWorkspaceOwnerMembership },
  ] = await Promise.all([
    import('../../apps/nanocore/dist/test-support/local-user.js'),
    import('../../apps/nanocore/dist/storage/db.js'),
    import('../../apps/nanocore/dist/storage/migrate.js'),
    import('../../apps/nanocore/dist/workspace-membership.js'),
  ]);
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    const localUserId = ensureFixtureLocalUser(coreDb);
    for (const workspaceId of [
      'ws_00000000-0000-7000-8000-000000000001',
      'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28',
    ]) {
      recordWorkspaceOwnerMembership({ coreDb, ownerUserId: localUserId, workspaceId });
    }
  } finally {
    coreDb.sqlite.close();
  }
}
