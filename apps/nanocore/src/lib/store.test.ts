import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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
    threadItems: [],
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

    const workspaceSnapshotPath = join(
      dataRoot,
      'users',
      'user_local',
      'workspaces',
      'ws_demo',
      'store.json'
    );
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

    expect(existsSync(workspaceSnapshotPath)).toBe(true);
    expect(JSON.parse(readFileSync(artifactProjectionPath, 'utf8'))).toEqual(artifact);
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

  it('persists command idempotency records and prunes expired entries after restart', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });

    store.recordCommandRequest({
      command: 'thread.create',
      requestId: '0190f4c8-0000-7000-8000-000000000501',
      scope: { workspaceId: 'ws_demo' },
      inputHash: 'sha256:live',
      response: { kind: 'thread', id: 'th_demo' },
      createdAt: '2026-05-27T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    store.recordCommandRequest({
      command: 'thread.create',
      requestId: '0190f4c8-0000-7000-8000-000000000502',
      scope: { workspaceId: 'ws_demo' },
      inputHash: 'sha256:expired',
      response: { kind: 'thread', id: 'th_old' },
      createdAt: '2000-01-01T00:00:00.000Z',
      expiresAt: '2000-01-02T00:00:00.000Z',
    });

    const restarted = new FsStore({ dataRoot });

    expect(
      restarted.getCommandRequest('thread.create', '0190f4c8-0000-7000-8000-000000000501', {
        workspaceId: 'ws_demo',
      })?.response
    ).toEqual({ kind: 'thread', id: 'th_demo' });
    expect(
      restarted.getCommandRequest('thread.create', '0190f4c8-0000-7000-8000-000000000502', {
        workspaceId: 'ws_demo',
      })
    ).toBeNull();
    expect(restarted.listCommandRequests().map((record) => record.inputHash)).toEqual([
      'sha256:live',
    ]);
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
