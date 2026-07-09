import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ItemSchema,
  KnowledgeEntrySchema,
  ThreadSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import { seedDemoWorkspace } from '../test-support/demo-store.js';
import { FsStore } from './store.js';

const timestamp = '2026-07-06T00:00:00.000Z';

/**
 * Builds a minimal workspace import payload for FsStore tests.
 *
 * @param workspaceId Imported workspace id.
 * @param threadId Imported thread id.
 * @param itemId Imported item id.
 * @returns Import payload accepted by FsStore.
 */
function workspaceImportPayload(
  workspaceId: string,
  threadId: string = 'th_blocked',
  itemId: string = 'it_blocked'
): Parameters<FsStore['importWorkspaceSnapshot']>[0] {
  return {
    workspace: WorkspaceRecordSchema.parse({
      id: workspaceId,
      name: 'Imported workspace',
      kind: 'general',
      status: 'active',
      defaults: {
        defaultModelId: 'model_codex',
        defaultAgentId: 'agent_codex_host',
        defaultSkillIds: [],
      },
      counts: {
        threadCount: 0,
        artifactCount: 0,
        knowledgeEntryCount: 0,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    threads: [
      ThreadSchema.parse({
        id: threadId,
        workspaceId,
        name: 'Imported thread',
        preview: 'Imported thread',
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ],
    knowledge: [
      KnowledgeEntrySchema.parse({
        id: `kn_${workspaceId}`,
        kind: 'project-context',
        title: 'Imported context',
        content: 'This entry belongs to the imported workspace.',
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ],
    threadItems: [
      ItemSchema.parse({
        id: itemId,
        workspaceId,
        threadId,
        turnId: `turn_${workspaceId}`,
        type: 'user-message',
        status: 'completed',
        text: 'Imported message',
        createdAt: timestamp,
        completedAt: timestamp,
      }),
    ],
  };
}

describe('FsStore snapshot reload', () => {
  it('reloads workspace, thread, turn, items, approval, artifact, knowledge, agent session, and events', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-reload-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Reload Workspace');
    const knowledge = store.createKnowledgeEntry(workspace.id, {
      kind: 'project-context',
      title: 'Reload context',
      content: 'Snapshot reload should preserve this knowledge entry.',
    });
    const thread = store.createThread(workspace.id, 'Reload thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Persist the whole turn');
    const knowledgeSourceContent = 'Reload source material.';
    const knowledgeSource = store.createKnowledgeSource(
      {
        id: `ks_${turn.id}`,
        workspaceId: workspace.id,
        kind: 'upload',
        title: 'Reload source',
        uri: null,
        contentDigest: 'sha256:reload-source',
        originatingThreadId: thread.id,
        originatingTurnId: turn.id,
        originatingFileId: `file_${turn.id}`,
        capturedAt: turn.startedAt ?? new Date().toISOString(),
        createdAt: turn.startedAt ?? new Date().toISOString(),
        updatedAt: turn.startedAt ?? new Date().toISOString(),
      },
      knowledgeSourceContent
    );
    const userItem = store.createItem({
      id: `it_user_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      text: 'Persist the whole turn',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const assistantItem = store.createItem({
      id: `it_assistant_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'The turn was persisted.',
      createdAt: userItem.createdAt,
      completedAt: userItem.completedAt,
    });
    const approval = store.createApproval({
      id: `ap_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Approve reload',
      description: 'Approval survives snapshot reload.',
      createdAt: userItem.createdAt,
      resolvedAt: null,
    });
    const agentSession = store.createAgentSession({
      id: `session_${thread.id}`,
      agentId: 'agent_codex_host',
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'busy',
      message: null,
      createdAt: userItem.createdAt,
      updatedAt: userItem.createdAt,
    });
    const artifact = store.createArtifact({
      id: `ar_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Reload artifact',
      status: 'ready',
      summary: 'Artifact survives snapshot reload.',
      version: 1,
      content: { format: 'markdown', body: 'Artifact survives snapshot reload.' },
      createdAt: userItem.createdAt,
      updatedAt: userItem.createdAt,
    });
    const agentSessionEvent = store.emitTurnEvent(turn.id, {
      event: 'agent.session.updated',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'agent-session-updated', agentSession },
    });
    const artifactEvent = store.emitTurnEvent(turn.id, {
      event: 'artifact.created',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'artifact-created', artifact },
    });
    const completedTurn = store.updateTurn(turn.id, {
      status: 'completed',
      completedAt: userItem.completedAt,
    });
    const persistedThread = store.getThread(workspace.id, thread.id);

    store.flushSnapshot();

    const workspaceSnapshotPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      workspace.id,
      'store.json'
    );
    const restarted = new FsStore({ dataRoot });

    expect(existsSync(workspaceSnapshotPath)).toBe(true);
    expect(restarted.getWorkspace(workspace.id)).toEqual(store.getWorkspace(workspace.id));
    expect(restarted.getWorkspaceResources(workspace.id).knowledge).toContainEqual(knowledge);
    expect(restarted.getKnowledgeSource(workspace.id, knowledgeSource.id)).toEqual(knowledgeSource);
    expect(restarted.readKnowledgeSourceMaterial(workspace.id, knowledgeSource.id)).toBe(
      knowledgeSourceContent
    );
    expect(restarted.getThread(workspace.id, thread.id)).toEqual(persistedThread);
    expect(restarted.getTurn(workspace.id, thread.id, turn.id)).toEqual(completedTurn);
    expect(restarted.listThreadItems(workspace.id, thread.id)).toEqual([userItem, assistantItem]);
    expect(restarted.getApproval(approval.id)).toEqual(approval);
    expect(restarted.getAgentSession(agentSession.id)).toEqual(agentSession);
    expect(restarted.getArtifact(workspace.id, artifact.id)).toEqual(artifact);
    expect(restarted.getTurnEvents(turn.id)).toEqual([agentSessionEvent, artifactEvent]);
  });

  it('loads an existing snapshot through the public load API', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-load-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Public load API');
    const persistencePath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      workspace.id,
      'store.json'
    );
    const loader = new FsStore();

    expect(existsSync(persistencePath)).toBe(true);
    expect(loader.loadSnapshot(persistencePath)).toBe(true);
    expect(loader.getWorkspace(workspace.id)).toEqual(store.getWorkspace(workspace.id));
  });

  it('loads the newest data-root snapshot instead of the first sorted snapshot', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-newest-snapshot-'));
    const store = new FsStore({ dataRoot });
    seedDemoWorkspace(store);
    const staleSnapshotPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_0',
      'store.json'
    );
    const defaultSnapshotPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'store.json'
    );

    mkdirSync(join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_0'), {
      recursive: true,
    });
    writeFileSync(staleSnapshotPath, readFileSync(defaultSnapshotPath));

    const workspace = store.createWorkspace('Newest snapshot workspace');
    const restarted = new FsStore({ dataRoot });

    expect(restarted.getWorkspace(workspace.id)).toEqual(workspace);
  });

  it('rolls back imported records when persistence fails', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-import-rollback-'));
    const store = new FsStore({ dataRoot });
    const workspaceId = 'ws_blocked';
    const threadId = 'th_blocked';
    const workspacePath = join(dataRoot, 'users', 'user_local', 'workspaces', workspaceId);

    mkdirSync(join(dataRoot, 'users', 'user_local', 'workspaces'), { recursive: true });
    writeFileSync(workspacePath, 'not a directory');

    expect(() => store.importWorkspaceSnapshot(workspaceImportPayload(workspaceId))).toThrow();

    expect(() => store.getWorkspace(workspaceId)).toThrow(`Workspace not found: ${workspaceId}`);
    expect(() => store.getWorkspaceResources(workspaceId)).toThrow(
      `Workspace not found: ${workspaceId}`
    );
    expect(() => store.getThread(workspaceId, threadId)).toThrow(`Thread not found: ${threadId}`);
    expect(() => store.listThreadItems(workspaceId, threadId)).toThrow(
      `Thread not found: ${threadId}`
    );
  });

  it('stages imported workspace files before publishing the final workspace root', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-import-staging-'));
    const store = new FsStore({ dataRoot });
    const workspaceId = 'ws_staged';
    const stagingPath = join(dataRoot, 'users', 'user_local', 'workspaces', '.staging');

    writeFileSync(stagingPath, 'not a directory');

    expect(() =>
      store.importWorkspaceSnapshot(workspaceImportPayload(workspaceId, 'th_staged', 'it_staged'))
    ).toThrow();

    expect(existsSync(join(dataRoot, 'users', 'user_local', 'workspaces', workspaceId))).toBe(
      false
    );
    expect(() => store.getWorkspace(workspaceId)).toThrow(`Workspace not found: ${workspaceId}`);
  });

  it('runs imported workspace side effects inside the staging root', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-import-staged-effects-'));
    const store = new FsStore({ dataRoot });
    const workspaceId = 'ws_staged_effects';
    const finalRoot = join(dataRoot, 'users', 'user_local', 'workspaces', workspaceId);
    let finalRootExistedDuringCallback = true;

    store.importWorkspaceSnapshot({
      ...workspaceImportPayload(workspaceId, 'th_staged_effects', 'it_staged_effects'),
      stageWorkspace: ({ workspaceRoot }) => {
        finalRootExistedDuringCallback = existsSync(finalRoot);
        writeFileSync(join(workspaceRoot, 'db', 'staged-side-effect.txt'), 'published');
      },
    });

    expect(finalRootExistedDuringCallback).toBe(false);
    expect(readFileSync(join(finalRoot, 'db', 'staged-side-effect.txt'), 'utf8')).toBe('published');
  });

  it('discards staged workspace side effects when import staging fails', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-import-staged-effects-fail-'));
    const store = new FsStore({ dataRoot });
    const workspaceId = 'ws_staged_effects_fail';

    expect(() =>
      store.importWorkspaceSnapshot({
        ...workspaceImportPayload(workspaceId, 'th_staged_effects_fail', 'it_staged_effects_fail'),
        stageWorkspace: ({ workspaceRoot }) => {
          writeFileSync(join(workspaceRoot, 'db', 'staged-side-effect.txt'), 'discarded');
          throw new Error('staged effect failed');
        },
      })
    ).toThrow('staged effect failed');

    expect(existsSync(join(dataRoot, 'users', 'user_local', 'workspaces', workspaceId))).toBe(
      false
    );
    expect(() => store.getWorkspace(workspaceId)).toThrow(`Workspace not found: ${workspaceId}`);
  });

  it('cleans orphaned import staging roots on startup', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-import-staging-cleanup-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Staging cleanup workspace');
    const stagingRoot = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      '.staging',
      'ws_orphaned'
    );

    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(join(stagingRoot, 'store.json'), '{}');

    const restarted = new FsStore({ dataRoot });

    expect(restarted.getWorkspace(workspace.id)).toEqual(workspace);
    expect(existsSync(stagingRoot)).toBe(false);
  });

  it('rejects snapshots with removed workspace default worker ids', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-removed-worker-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Removed worker defaults');
    const persistencePath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      workspace.id,
      'store.json'
    );
    const snapshot = JSON.parse(readFileSync(persistencePath, 'utf8')) as {
      workspaces: Array<{ defaults: Record<string, unknown> }>;
    };

    snapshot.workspaces = snapshot.workspaces.map((item) => ({
      ...item,
      defaults: {
        defaultModelId: item.defaults.defaultModelId,
        defaultSkillIds: item.defaults.defaultSkillIds,
        ['default' + 'WorkerId']: 'worker_codex_host',
      },
    }));
    writeFileSync(persistencePath, `${JSON.stringify(snapshot, null, 2)}\n`);

    expect(() => new FsStore({ dataRoot })).toThrow(new RegExp('default' + 'WorkerId'));
  });

  it('rejects snapshots with removed workspace resource workers', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-removed-resources-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Removed worker resources');
    const persistencePath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      workspace.id,
      'store.json'
    );
    const snapshot = JSON.parse(readFileSync(persistencePath, 'utf8')) as {
      workspaceResources: Array<[string, Record<string, unknown>]>;
    };
    const resourceEntry = snapshot.workspaceResources.find(
      ([workspaceId]) => workspaceId === workspace.id
    );

    if (!resourceEntry) {
      throw new Error('Expected workspace resources in snapshot.');
    }

    const [, resources] = resourceEntry;
    const agents = resources.agents as Array<Record<string, unknown>>;

    Reflect.set(
      resources,
      'workers',
      agents.map((agent) => {
        const worker = { ...agent };

        delete worker.defaultProfileId;
        delete worker.profiles;

        return {
          ...worker,
          id:
            typeof worker.id === 'string' && worker.id.startsWith('agent_')
              ? `worker_${worker.id.slice('agent_'.length)}`
              : worker.id,
          name:
            typeof worker.name === 'string' ? worker.name.replace('Agent', 'Worker') : worker.name,
        };
      })
    );
    delete resources.agents;
    writeFileSync(persistencePath, `${JSON.stringify(snapshot, null, 2)}\n`);

    expect(() => new FsStore({ dataRoot })).toThrow(
      new RegExp('workspaceResources\\.' + 'workers')
    );
  });

  it('rejects snapshots with replay events missing protocol versions', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-removed-event-version-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Removed event protocol version');
    const thread = store.createThread(workspace.id, 'Replay event thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Replay event turn');
    const persistencePath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      workspace.id,
      'store.json'
    );

    store.emitTurnEvent(turn.id, {
      event: 'turn.started',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'turn-started', turnId: turn.id, status: 'running' },
    });

    const snapshot = JSON.parse(readFileSync(persistencePath, 'utf8')) as {
      streamEvents: Array<[string, Array<Record<string, unknown>>]>;
    };
    const replayEntry = snapshot.streamEvents.find(([turnId]) => turnId === turn.id);

    if (!replayEntry?.[1][0]) {
      throw new Error('Expected a persisted replay event.');
    }

    delete replayEntry[1][0].protocolVersion;
    writeFileSync(persistencePath, `${JSON.stringify(snapshot, null, 2)}\n`);

    expect(() => new FsStore({ dataRoot })).toThrow(/protocolVersion/);
  });
});
