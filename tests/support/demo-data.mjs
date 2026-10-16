import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Writes the explicit Demo Workspace fixture used by black-box tests.
 *
 * @param {string} dataRoot NanoCore data root to seed.
 * @returns {void}
 */
export function seedDemoWorkspaceDataRoot(dataRoot) {
  const workspaceRoot = join(dataRoot, 'workspaces', 'ws_00000000-0000-7000-8000-000000000001');
  const quickChatRoot = join(dataRoot, 'workspaces', 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28');
  const workspacePath = join(workspaceRoot, 'workspace-record.json');
  const quickChatPath = join(quickChatRoot, 'workspace-record.json');

  if (existsSync(workspacePath) && existsSync(quickChatPath)) {
    return;
  }
  if (existsSync(workspacePath) || existsSync(quickChatPath)) {
    throw new Error('Demo workspace fixture is partially initialized.');
  }

  const timestamp = new Date().toISOString();
  const workspace = {
    id: 'ws_00000000-0000-7000-8000-000000000001',
    kind: 'code',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const quickChatWorkspace = {
    id: 'ws_7d54f339-a119-5221-bbbf-bfbf3e8a3f28',
    kind: 'personal',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const thread = {
    id: 'th_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    name: 'Protocol design review',
    preview: 'Review the UI-first workspace protocol slice and tighten payload boundaries.',
    status: 'active',
    entryPath: 'conversation',
    visibility: 'workspace',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const knowledge = [
    {
      id: 'mem_project',
      kind: 'project-context',
      title: 'Product focus',
      content: 'Drive the workspace protocol through a real Codex-backed local agent adapter.',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  const threadRoot = join(workspaceRoot, 'threads', 'th_00000000-0000-7000-8000-000000000001');
  const knowledgePage = [
    '---',
    'type: "KnowledgePage"',
    `title: ${JSON.stringify(knowledge[0].title)}`,
    'schema_version: "openkit-workspace-knowledge-schema-v1"',
    'status: "active"',
    'scope: "workspace"',
    'source_refs: []',
    'review_state: "accepted"',
    'sensitivity: "normal"',
    'freshness: "current"',
    `openkit_entry_kind: ${JSON.stringify(knowledge[0].kind)}`,
    `created_at: ${JSON.stringify(knowledge[0].createdAt)}`,
    `updated_at: ${JSON.stringify(knowledge[0].updatedAt)}`,
    `openkit_entry_id: ${JSON.stringify(knowledge[0].id)}`,
    '---',
    knowledge[0].content,
    '',
  ].join('\n');

  for (const root of [workspaceRoot, quickChatRoot]) {
    for (const relativePath of [
      'artifacts',
      'config',
      'knowledge/pages',
      'knowledge/proposals',
      'knowledge/reviews',
      'runtime/agent-sessions',
      'sources/derived',
      'sources/materials',
      'sources/registry',
      'threads',
    ]) {
      mkdirSync(join(root, relativePath), { recursive: true });
    }
  }

  mkdirSync(join(threadRoot, 'turns'), { recursive: true });
  writeFileSync(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`);
  writeFileSync(quickChatPath, `${JSON.stringify(quickChatWorkspace, null, 2)}\n`);
  writeFileSync(
    join(workspaceRoot, 'config', 'workspace.jsonc'),
    `${JSON.stringify({ schemaVersion: 1, workspace: { name: 'Demo Workspace', defaultAgentId: 'agent_codex_host' } }, null, 2)}\n`
  );
  writeFileSync(
    join(quickChatRoot, 'config', 'workspace.jsonc'),
    `${JSON.stringify({ schemaVersion: 1, workspace: { name: 'Personal', defaultAgentId: null } }, null, 2)}\n`
  );
  writeFileSync(
    join(threadRoot, 'thread.json'),
    `${JSON.stringify(
      {
        ...thread,
        schemaVersion: 1,
        recordType: 'thread',
        ownerScope: 'workspace',
        lineage: { workspaceId: thread.workspaceId, threadId: thread.id },
        contentDigest: `sha256:${createHash('sha256').update(JSON.stringify(thread)).digest('hex')}`,
        redactionLevel: 'none',
        sensitivity: 'workspace',
        requiredFeatures: ['openkit.thread-entry.v1', 'openkit.thread-visibility.v1'],
        extensions: {},
      },
      null,
      2
    )}\n`
  );
  writeFileSync(join(workspaceRoot, 'knowledge', 'pages', 'mem_project.md'), knowledgePage);
}

/**
 * Records the canonical local owner membership for the demo Workspace files.
 *
 * @param {string} dataRoot NanoCore data root containing the demo Workspace files.
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
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: localUserId,
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
  } finally {
    coreDb.sqlite.close();
  }
}
