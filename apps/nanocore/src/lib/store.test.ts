import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { AgentSessionSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { openUserDb, openWorkspaceDb } from '../storage/db.js';
import { userDbPath, workspaceDbPath } from '../storage/fs-layout.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createDemoWorkspaceForUser, FsStore } from './store.js';

/**
 * Creates the legacy project workspace fixture used by store tests.
 *
 * @param store Store that should own the fixture.
 */
function seedDemoWorkspace(store: FsStore): void {
  const demo = createDemoWorkspaceForUser('user_local');

  store.importWorkspaceSnapshot({
    workspace: demo.workspace,
    threads: [demo.thread],
    knowledge: demo.knowledge,
    turns: [],
    itemRevisions: [],
    artifacts: [],
    artifactReviews: [],
    agentSessions: [],
    turnEvents: [],
  });
}

/**
 * Finds serialized files containing one forbidden value.
 *
 * @param root Storage tree to inspect.
 * @param value Value that must not be serialized.
 * @returns Root-relative paths containing the value.
 */
function findStorageFilesContaining(root: string, value: string): string[] {
  return readdirSync(root, { encoding: 'utf8', recursive: true }).filter((path) => {
    const absolutePath = join(root, path);
    return (
      !path.split(sep).includes('db') &&
      statSync(absolutePath).isFile() &&
      readFileSync(absolutePath, 'utf8').includes(value)
    );
  });
}

describe('FsStore persistence', () => {
  it('seeds only Quick Chat for a new user', () => {
    const store = new FsStore();
    const workspaces = store.listWorkspaces();

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      id: 'ws_quick_chat',
      name: 'Quick Chat',
      kind: 'quick-chat',
      defaults: {
        defaultModelId: null,
        defaultAgentId: null,
        defaultSkillIds: [],
      },
    });
  });

  it('creates new user workspaces with runnable default execution resources', () => {
    const store = new FsStore();
    const workspace = store.createWorkspace('Runnable workspace');
    const resources = store.getWorkspaceResources(workspace.id);

    expect(workspace.defaults).toEqual({
      defaultModelId: 'model_codex',
      defaultAgentId: 'agent_codex_host',
      defaultSkillIds: [],
    });
    expect(resources.models.map((model) => model.id)).toContain('model_codex');
    expect(resources.agents.map((agent) => agent.id)).toContain('agent_codex_host');
    expect(store.getAgentForThread(workspace.id, 'th_new').id).toBe('agent_codex_host');
  });

  it('records exact artifact-reference lineage for turn-bound creates and updates', () => {
    const store = new FsStore();
    const workspace = store.createWorkspace('Artifact lineage workspace');
    const thread = store.createThread(workspace.id, 'Artifact lineage thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Create and update an artifact');
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const artifact = store.createArtifact({
      id: 'ar_turn_lineage',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Turn artifact',
      status: 'draft',
      summary: null,
      version: 1,
      content: { format: 'text', body: 'Artifact version one.' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    store.updateArtifact(workspace.id, artifact.id, {
      status: 'ready',
      summary: 'Artifact version two.',
      version: 2,
      updatedAt: timestamp,
    });

    const lineage = store
      .listWorkspaceItemRevisions(workspace.id)
      .filter((item) => item.type === 'artifact-reference' && item.artifactId === artifact.id);

    expect(lineage).toEqual([
      expect.objectContaining({
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        artifactId: artifact.id,
        artifactVersion: 1,
      }),
      expect.objectContaining({
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        artifactId: artifact.id,
        artifactVersion: 2,
      }),
    ]);
  });

  it('does not invent an Item for a workspace-only Artifact', () => {
    const store = new FsStore();
    const workspace = store.createWorkspace('Workspace-only artifact');
    const timestamp = new Date().toISOString();

    store.createArtifact({
      id: 'ar_workspace_only',
      workspaceId: workspace.id,
      threadId: null,
      turnId: null,
      kind: 'file',
      title: 'Imported artifact',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body: 'Imported outside a Thread.' },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(store.listAllItems()).toEqual([]);
  });

  it('does not retain a turn when its owning thread is missing', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });
    const orphanTurnId = 'tu_missing_thread';

    seedDemoWorkspace(store);

    expect(() =>
      store.createTurn('ws_demo', 'th_missing', 'Reject this turn', null, {
        turnId: orphanTurnId,
      })
    ).toThrow('Thread not found: th_missing');

    let inMemoryOrphan: ReturnType<FsStore['getTurnById']> | null = null;
    try {
      inMemoryOrphan = store.getTurnById(orphanTurnId);
    } catch {}

    const validThread = store.createThread('ws_demo', 'Persist after rejected turn');
    store.createTurn('ws_demo', validThread.id, 'Persist valid work');

    const restarted = new FsStore({ dataRoot });
    let restartedOrphan: ReturnType<FsStore['getTurnById']> | null = null;
    try {
      restartedOrphan = restarted.getTurnById(orphanTurnId);
    } catch {}

    expect.soft(inMemoryOrphan).toBeNull();
    expect.soft(restartedOrphan).toBeNull();
  });

  it('restores thread, turn, event, knowledge, artifact, and agent session history after restart', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });
    seedDemoWorkspace(store);
    const thread = store.createThread('ws_demo', 'Persistent thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Persist this work');
    const knowledgeEntry = store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Persisted knowledge',
      content: 'Knowledge survived restart.',
    });
    const knowledgeProposal = store.createKnowledgeProposal({
      id: 'kp_persisted',
      workspaceId: 'ws_demo',
      title: 'Persisted proposal',
      summary: 'Proposal survived restart.',
      status: 'pending',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      updatedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const knowledgeSourceContent = 'Persisted source material.';
    const knowledgeSource = store.createKnowledgeSource(
      {
        id: 'ks_persisted',
        workspaceId: 'ws_demo',
        kind: 'upload',
        title: 'Persisted source',
        uri: null,
        contentDigest: 'sha256:source',
        originatingThreadId: thread.id,
        originatingTurnId: turn.id,
        originatingFileId: 'file_persisted',
        capturedAt: turn.startedAt ?? new Date().toISOString(),
        createdAt: turn.startedAt ?? new Date().toISOString(),
        updatedAt: turn.startedAt ?? new Date().toISOString(),
      },
      knowledgeSourceContent
    );
    const knowledgeProposalReview = store.recordKnowledgeProposalReviewDecision({
      proposalId: knowledgeProposal.id,
      workspaceId: 'ws_demo',
      status: 'accepted',
      requestId: 'knowledge-review-request-1',
      message: 'Proposal accepted.',
      decidedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const reviewedKnowledgeProposal = {
      ...knowledgeProposal,
      status: 'accepted' as const,
      updatedAt: knowledgeProposalReview.decidedAt,
    };
    const agentSession = store.createAgentSession({
      id: 'as_persisted',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      status: 'busy',
      message: null,
      sessionCompatibilityKey: 'sha256:session-compatibility',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      updatedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const artifact = store.createArtifact({
      id: 'ar_persisted',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Persisted summary',
      status: 'ready',
      summary: 'History survived restart.',
      version: 1,
      content: { format: 'markdown', body: 'History survived restart.' },
      createdAt: turn.startedAt ?? new Date().toISOString(),
      updatedAt: turn.startedAt ?? new Date().toISOString(),
    });

    store.emitTurnEvent(turn.id, {
      event: 'artifact.created',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'artifact-created', artifact },
    });

    const artifactProjectionPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'artifacts',
      artifact.id,
      'artifact.json'
    );
    const artifactContentPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'artifacts',
      artifact.id,
      'files',
      'content.md'
    );
    const knowledgeProjectionPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'knowledge',
      'pages',
      `${knowledgeEntry.id}.md`
    );
    const knowledgeProposalProjectionPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'knowledge',
      'proposals',
      `${knowledgeProposal.id}.md`
    );
    const knowledgeReviewProjectionPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'knowledge',
      'reviews',
      `${knowledgeProposal.id}.json`
    );
    const knowledgeSourceProjectionPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'sources',
      'registry',
      `${knowledgeSource.id}.json`
    );
    const knowledgeSourceMaterialPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'sources',
      'materials',
      knowledgeSource.id,
      'content.txt'
    );
    const agentSessionProjectionPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'runtime',
      'agent-sessions',
      agentSession.id,
      'session.json'
    );
    const restarted = new FsStore({ dataRoot });

    expect(JSON.parse(readFileSync(artifactProjectionPath, 'utf8'))).toEqual({
      ...artifact,
      content: { format: artifact.content.format },
    });
    expect(readFileSync(artifactContentPath, 'utf8')).toBe('History survived restart.');
    expect(readFileSync(knowledgeProjectionPath, 'utf8')).toContain('Knowledge survived restart.');
    expect(readFileSync(knowledgeProposalProjectionPath, 'utf8')).toContain(
      'Proposal survived restart.'
    );
    expect(JSON.parse(readFileSync(knowledgeReviewProjectionPath, 'utf8'))).toEqual(
      knowledgeProposalReview
    );
    expect(JSON.parse(readFileSync(knowledgeSourceProjectionPath, 'utf8'))).toEqual(
      knowledgeSource
    );
    expect(readFileSync(knowledgeSourceMaterialPath, 'utf8')).toBe(knowledgeSourceContent);
    expect(JSON.parse(readFileSync(agentSessionProjectionPath, 'utf8'))).toEqual(agentSession);
    expect(restarted.listThreads('ws_demo').map((item) => item.id)).toContain(thread.id);
    expect(restarted.getTurn('ws_demo', thread.id, turn.id).id).toBe(turn.id);
    expect(restarted.getKnowledgeEntry('ws_demo', knowledgeEntry.id)).toEqual(knowledgeEntry);
    expect(restarted.listKnowledgeProposals('ws_demo')).toEqual([reviewedKnowledgeProposal]);
    expect(restarted.getKnowledgeProposalReviewDecision(knowledgeProposal.id)).toEqual(
      knowledgeProposalReview
    );
    expect(restarted.getKnowledgeSource('ws_demo', knowledgeSource.id)).toEqual(knowledgeSource);
    expect(restarted.readKnowledgeSourceMaterial('ws_demo', knowledgeSource.id)).toBe(
      knowledgeSourceContent
    );
    expect(restarted.listArtifacts('ws_demo').map((item) => item.id)).toContain(artifact.id);
    expect(restarted.getAgentSession(agentSession.id)).toEqual(agentSession);
    expect(restarted.getTurnEvents(turn.id).map((event) => event.event)).toContain(
      'artifact.created'
    );
    expect(
      restarted
        .getWorkspaceResources('ws_demo')
        .agents.map((agent) => agent.config.adapterType)
        .sort()
    ).toEqual(['codex', 'opencode', 'opencode']);
  });

  it('projects agent-session events before returning or notifying listeners', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });
    seedDemoWorkspace(store);
    const thread = store.createThread('ws_demo', 'Product-safe session events');
    const turn = store.createTurn('ws_demo', thread.id, 'Emit a product-safe session');
    const timestamp = '2026-07-12T00:00:00.000Z';
    const sourcePath = '/safe/fake/internal/sse-host-path-marker';
    const agentSession = store.createAgentSession({
      id: 'as_product_safe_event',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      status: 'busy',
      message: null,
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo',
          sourceKind: 'host-dir',
          sourcePath,
          workerPath: '/workspace/repo',
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const listenerEnvelopes: string[] = [];
    const unsubscribe = store.addTurnListener(turn.id, (event) => {
      listenerEnvelopes.push(JSON.stringify(event));
    });

    const emitted = store.emitTurnEvent(turn.id, {
      event: 'agent.session.updated',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'agent-session-updated', agentSession },
    });
    unsubscribe();

    const expectedAgentSession = AgentSessionSchema.parse(agentSession);
    const serializedEnvelopes = [JSON.stringify(emitted), ...listenerEnvelopes];

    expect(listenerEnvelopes).toHaveLength(1);
    for (const serializedEnvelope of serializedEnvelopes) {
      const parsed = JSON.parse(serializedEnvelope) as { data: { agentSession: unknown } };

      expect.soft(serializedEnvelope).not.toContain('workspaceRoots');
      expect.soft(serializedEnvelope).not.toContain('sourcePath');
      expect.soft(serializedEnvelope).not.toContain(sourcePath);
      expect.soft(parsed.data.agentSession).toEqual(expectedAgentSession);
    }
  });

  it('persists command idempotency records and prunes expired entries after restart', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Idempotency workspace');

    store.recordCommandRequest({
      command: 'thread.create',
      requestId: '0190f4c8-0000-7000-8000-000000000501',
      scope: { workspaceId: workspace.id },
      inputHash: 'sha256:live',
      response: {
        kind: 'thread',
        id: 'th_demo',
        snapshot: { state: 'queued', goalId: 'goal_original' },
      },
      createdAt: '2026-05-27T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    store.recordCommandRequest({
      command: 'thread.create',
      requestId: '0190f4c8-0000-7000-8000-000000000502',
      scope: { workspaceId: workspace.id },
      inputHash: 'sha256:expired',
      response: { kind: 'thread', id: 'th_old' },
      createdAt: '2000-01-01T00:00:00.000Z',
      expiresAt: '2000-01-02T00:00:00.000Z',
    });

    const restarted = new FsStore({ dataRoot });

    expect(
      restarted.getCommandRequest('thread.create', '0190f4c8-0000-7000-8000-000000000501', {
        workspaceId: workspace.id,
      })?.response
    ).toEqual({
      kind: 'thread',
      id: 'th_demo',
      snapshot: { state: 'queued', goalId: 'goal_original' },
    });
    expect(
      restarted.getCommandRequest('thread.create', '0190f4c8-0000-7000-8000-000000000502', {
        workspaceId: workspace.id,
      })
    ).toBeNull();
    expect(restarted.listCommandRequests().map((record) => record.inputHash)).toEqual([
      'sha256:live',
    ]);
  });

  it('does not create storage for workspace-scoped idempotency without a workspace', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });
    const workspaceId = 'ws_missing';

    expect(() =>
      store.recordCommandRequest({
        command: 'thread.create',
        requestId: '0190f4c8-0000-7000-8000-000000000505',
        scope: { workspaceId },
        inputHash: 'sha256:missing-workspace',
        response: { kind: 'thread', id: 'th_missing' },
      })
    ).toThrow(`Workspace not found: ${workspaceId}`);
    expect(
      store.getCommandRequest('thread.create', '0190f4c8-0000-7000-8000-000000000505', {
        workspaceId,
      })
    ).toBeNull();
    expect(existsSync(join(dataRoot, 'users', 'user_local', 'workspaces', workspaceId))).toBe(
      false
    );
  });

  it('homes durable command idempotency in its user or workspace database', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });
    seedDemoWorkspace(store);
    const userDb = openUserDb(dataRoot, 'user_local');
    const workspaceDb = openWorkspaceDb(dataRoot, 'user_local', 'ws_demo');
    try {
      applyScopedMigrations(userDb);
      applyScopedMigrations(workspaceDb);
    } finally {
      userDb.sqlite.close();
      workspaceDb.sqlite.close();
    }
    const workspaceRequestId = '0190f4c8-0000-7000-8000-000000000503';
    const userRequestId = '0190f4c8-0000-7000-8000-000000000504';

    store.recordCommandRequest({
      command: 'thread.create',
      requestId: workspaceRequestId,
      scope: { workspaceId: 'ws_demo' },
      inputHash: 'sha256:workspace-database-owner',
      response: { kind: 'thread', id: 'th_database_owned' },
      createdAt: '2026-07-12T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    store.recordCommandRequest({
      command: 'workspace.create',
      requestId: userRequestId,
      scope: {},
      inputHash: 'sha256:user-database-owner',
      response: { kind: 'workspace', id: 'ws_database_owned' },
      createdAt: '2026-07-12T00:00:01.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });

    for (const expected of [
      {
        inputHash: 'sha256:user-database-owner',
        path: userDbPath(dataRoot, 'user_local'),
        requestId: userRequestId,
      },
      {
        inputHash: 'sha256:workspace-database-owner',
        path: workspaceDbPath(dataRoot, 'user_local', 'ws_demo'),
        requestId: workspaceRequestId,
      },
    ]) {
      const sqlite = new Database(expected.path, { fileMustExist: true, readonly: true });
      try {
        const tableName = sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .pluck()
          .get('idempotency_requests');
        const row =
          tableName === 'idempotency_requests'
            ? sqlite
                .prepare(
                  'SELECT request_id AS requestId, input_hash AS inputHash FROM idempotency_requests WHERE request_id = ?'
                )
                .get(expected.requestId)
            : undefined;

        expect.soft(tableName).toBe('idempotency_requests');
        expect.soft(row).toEqual({
          requestId: expected.requestId,
          inputHash: expected.inputHash,
        });
      } finally {
        sqlite.close();
      }
    }

    const fileBackedRecordsRoot = join(dataRoot, 'users', 'user_local', 'workspaces');
    expect.soft(findStorageFilesContaining(fileBackedRecordsRoot, workspaceRequestId)).toEqual([]);
    expect.soft(findStorageFilesContaining(fileBackedRecordsRoot, userRequestId)).toEqual([]);
  });

  it('does not serialize dynamic execution resources under workspace storage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });
    seedDemoWorkspace(store);
    const marker = 'runtime_only_test_marker';
    const resources = store.getWorkspaceResources('ws_demo');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');

    resources.models.push({
      id: `model_${marker}`,
      name: 'Runtime-only test model',
      enabled: true,
      isDefault: false,
    });
    resources.skills.push({
      id: `skill_${marker}`,
      name: 'Runtime-only test skill',
      enabled: true,
    });
    store.upsertAgent('ws_demo', {
      ...agent,
      id: `agent_${marker}`,
      modelId: `model_${marker}`,
      skillIds: [`skill_${marker}`],
      config: {
        ...agent.config,
        environment: {
          OPENKIT_FAKE_API_TOKEN: `fake_${marker}_secret_not_real`,
        },
      },
    });

    expect(
      findStorageFilesContaining(
        join(dataRoot, 'users', 'user_local', 'workspaces', 'ws_demo'),
        marker
      )
    ).toEqual([]);
  });

  it('clamps derived turn duration when completion time is earlier than start time', () => {
    const store = new FsStore();
    seedDemoWorkspace(store);
    const thread = store.createThread('ws_demo', 'Clock drift thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Close under clock drift');

    const updated = store.updateTurn(turn.id, {
      completedAt: '2000-01-01T00:00:00.000Z',
      status: 'failed',
    });

    expect(updated.durationMs).toBe(0);
  });
});
