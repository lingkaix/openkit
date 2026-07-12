import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Writes the explicit Demo Workspace fixture used by black-box tests.
 *
 * @param {string} dataRoot NanoCore data root to seed.
 * @param {{ userId?: string }} [options] Seed options.
 * @returns {void}
 */
export function seedDemoWorkspaceDataRoot(dataRoot, options = {}) {
  const userId = options.userId ?? 'user_local';
  const workspaceRoot = join(dataRoot, 'users', userId, 'workspaces', 'ws_demo');
  const quickChatRoot = join(dataRoot, 'users', userId, 'workspaces', 'ws_quick_chat');
  const workspacePath = join(workspaceRoot, 'workspace.json');
  const quickChatPath = join(quickChatRoot, 'workspace.json');

  if (existsSync(workspacePath) && existsSync(quickChatPath)) {
    return;
  }
  if (existsSync(workspacePath) || existsSync(quickChatPath)) {
    throw new Error('Demo workspace fixture is partially initialized.');
  }

  const timestamp = new Date().toISOString();
  const workspace = {
    id: 'ws_demo',
    name: 'Demo Workspace',
    kind: 'code',
    status: 'active',
    defaults: {
      defaultModelId: 'model_codex',
      defaultAgentId: 'agent_codex_host',
      defaultSkillIds: [],
    },
    counts: {
      threadCount: 1,
      artifactCount: 0,
      knowledgeEntryCount: 1,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const quickChatWorkspace = {
    id: 'ws_quick_chat',
    name: 'Quick Chat',
    kind: 'quick-chat',
    status: 'active',
    defaults: {
      defaultModelId: null,
      defaultAgentId: null,
      defaultSkillIds: [],
    },
    counts: {
      threadCount: 0,
      artifactCount: 0,
      knowledgeEntryCount: 0,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const thread = {
    id: 'th_demo',
    workspaceId: 'ws_demo',
    name: 'Protocol design review',
    preview: 'Review the UI-first workspace protocol slice and tighten payload boundaries.',
    status: 'active',
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
  const threadRoot = join(workspaceRoot, 'threads', 'th_demo');
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
      'knowledge/pages',
      'knowledge/proposals',
      'knowledge/reviews',
      'reviews/artifacts',
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
  writeFileSync(join(threadRoot, 'thread.json'), `${JSON.stringify(thread, null, 2)}\n`);
  writeFileSync(join(workspaceRoot, 'knowledge', 'pages', 'mem_project.md'), knowledgePage);
}
