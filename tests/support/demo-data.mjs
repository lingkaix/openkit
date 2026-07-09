import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nanoCoreRoot = join(repoRoot, 'apps', 'nanocore');

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

  if (existsSync(join(workspaceRoot, 'store.json'))) {
    return;
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
  const agents = [
    {
      id: 'agent_codex_host',
      name: 'Codex Host Agent',
      kind: 'coder',
      status: 'enabled',
      modelId: 'model_codex',
      skillIds: [],
      profiles: [
        {
          id: 'default',
          displayName: 'Default Coding Profile',
          instructionsRef: null,
          modelId: null,
          skillIds: [],
          capabilityIds: [],
        },
      ],
      defaultProfileId: 'default',
      config: {
        adapterType: 'codex',
        command: 'codex app-server --listen stdio://',
        baseUrl: null,
        workspaceRoot: nanoCoreRoot,
        environment: {},
        capabilities: ['turns', 'streaming', 'interrupts'],
      },
      health: {
        status: 'unknown',
        message: 'Health is checked when a turn starts.',
        checkedAt: null,
      },
    },
    {
      id: 'agent_opencode_host',
      name: 'OpenCode Host Agent',
      kind: 'coder',
      status: 'enabled',
      modelId: 'model_opencode',
      skillIds: [],
      profiles: [
        {
          id: 'default',
          displayName: 'Default Coding Profile',
          instructionsRef: null,
          modelId: null,
          skillIds: [],
          capabilityIds: [],
        },
      ],
      defaultProfileId: 'default',
      config: {
        adapterType: 'opencode',
        command: 'opencode run --format default',
        baseUrl: 'http://localhost:4096',
        workspaceRoot: nanoCoreRoot,
        environment: {},
        capabilities: ['turns', 'streaming', 'interrupts'],
      },
      health: {
        status: 'unknown',
        message: 'Health is checked when a turn starts.',
        checkedAt: null,
      },
    },
  ];
  const snapshot = {
    workspaces: [workspace, quickChatWorkspace],
    workspaceResources: [
      [
        'ws_demo',
        {
          knowledge,
          skills: [],
          agents,
          models: [
            { id: 'model_codex', name: 'Codex', enabled: true, isDefault: true },
            { id: 'model_opencode', name: 'OpenCode', enabled: true, isDefault: false },
          ],
        },
      ],
      ['ws_quick_chat', { knowledge: [], skills: [], agents: [], models: [] }],
    ],
    threads: [thread],
    turns: [],
    items: [],
    approvals: [],
    agentSessions: [],
    artifacts: [],
    artifactReviews: [],
    knowledgeProposals: [],
    knowledgeProposalReviews: [],
    knowledgeSources: [],
    commandRequests: [],
    streamEvents: [],
  };
  const threadRoot = join(workspaceRoot, 'threads', 'th_demo');

  mkdirSync(threadRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, 'store.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(join(workspaceRoot, 'workspace.json'), `${JSON.stringify(workspace, null, 2)}\n`);
  writeFileSync(join(threadRoot, 'thread.json'), `${JSON.stringify(thread, null, 2)}\n`);
}
