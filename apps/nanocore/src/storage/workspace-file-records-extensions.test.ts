import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import {
  appendWorkspaceTurnEvent,
  loadWorkspaceFileRecords,
  serializeKnowledgeProposalRecord,
  writeWorkspaceFileRecords,
} from './workspace-file-records.js';

/** Adds an inert annotation to a real canonical object without changing its known core. */
function annotate(path: string, nested: readonly string[] = []): void {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  let target = value;
  for (const key of nested) target = target[key];
  target.futureNote = 'retained';
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

describe('descriptive canonical history extensions', () => {
  it('preserves immutable Proposal bytes, ordered Review annotations and Source history on rewrite', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-history-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Knowledge');
    const root = join(dataRoot, 'workspaces', workspace.id);
    const initial = loadWorkspaceFileRecords(dataRoot).find(
      (record) => record.workspace.id === workspace.id
    )!;
    const body = 'Knowledge candidate.\n';
    const proposal = {
      id: `kp_${'a'.repeat(64)}`,
      workspaceId: workspace.id,
      operation: 'create' as const,
      knowledgePageId: 'candidate',
      canonicalPageBytes: body,
      contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      sourceReferences: [`knowledge:source@sha256:${'b'.repeat(64)}`],
      rationale: 'Retained rationale',
      confidence: 1,
      producer: { kind: 'user' as const, id: 'user_local' },
      createdAt: workspace.createdAt,
    };
    const source = {
      id: 'ks_history',
      workspaceId: workspace.id,
      kind: 'document' as const,
      title: 'History',
      uri: null,
      contentDigest: `sha256:${'c'.repeat(64)}`,
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: workspace.createdAt,
      createdAt: workspace.createdAt,
      updatedAt: workspace.createdAt,
    };
    writeWorkspaceFileRecords(root, {
      ...initial,
      knowledgeProposals: [proposal],
      knowledgeSources: [source],
    });
    const proposalPath = join(root, 'knowledge', 'proposals', `${proposal.id}.md`);
    const bytes = readFileSync(proposalPath, 'utf8').replace(
      'producer: {',
      'future_note: "retained"\nproducer: {"futureNote":"retained",'
    );
    writeFileSync(proposalPath, bytes);
    const loaded = loadWorkspaceFileRecords(dataRoot).find(
      (record) => record.workspace.id === workspace.id
    )!;
    expect(serializeKnowledgeProposalRecord(loaded.knowledgeProposals[0]!)).toBe(bytes);
    expect(JSON.stringify(loaded.knowledgeProposals)).not.toContain('futureNote');
    const reviewRequestId = '0190f4c8-0000-7000-8000-000000000801';
    const review = {
      proposalId: proposal.id,
      workspaceId: workspace.id,
      reviewId: `kr_${createHash('sha256')
        .update(
          JSON.stringify({
            workspaceId: workspace.id,
            proposalId: proposal.id,
            requestId: reviewRequestId,
          })
        )
        .digest('hex')}`,
      requestId: reviewRequestId,
      decision: 'deferred' as const,
      actor: { kind: 'user' as const, id: 'user_local' },
      proposalDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      knowledgePageId: proposal.knowledgePageId,
      contentDigest: proposal.contentDigest,
      targetAbsentAtDecision: null,
      decidedAt: workspace.createdAt,
    };
    writeWorkspaceFileRecords(root, { ...loaded, knowledgeProposalReviews: [review] });
    const reviewPath = join(root, 'knowledge', 'reviews', `${proposal.id}.json`);
    annotate(reviewPath);
    annotate(reviewPath, ['decisions', '0']);
    annotate(reviewPath, ['decisions', '0', 'actor']);
    const sourcePath = join(root, 'sources', 'registry', `${source.id}.json`);
    annotate(sourcePath);
    const extended = loadWorkspaceFileRecords(dataRoot).find(
      (record) => record.workspace.id === workspace.id
    )!;
    expect(JSON.stringify(extended)).not.toContain('futureNote');
    writeWorkspaceFileRecords(root, {
      ...extended,
      knowledgeSources: [{ ...extended.knowledgeSources[0]!, title: 'Updated' }],
    });
    const reopened = loadWorkspaceFileRecords(dataRoot).find(
      (record) => record.workspace.id === workspace.id
    )!;
    expect(reopened.knowledgeSources[0]?.title).toBe('Updated');
    expect(readFileSync(proposalPath, 'utf8')).toBe(bytes);
    expect(readFileSync(reviewPath, 'utf8')).toContain('futureNote');
    expect(readFileSync(sourcePath, 'utf8')).toContain('futureNote');
    const reviewFile = JSON.parse(readFileSync(reviewPath, 'utf8'));
    reviewFile.decisions.push(reviewFile.decisions[0]);
    writeFileSync(reviewPath, JSON.stringify(reviewFile));
    expect(() => loadWorkspaceFileRecords(dataRoot)).toThrow(/append-only/);
  });
  it('reads, updates and reopens Workspace, Actor, Item, Artifact and AgentSession history', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-history-extensions-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('History');
    const thread = store.createThread(workspace.id, 'History');
    const turn = store.createTurn(workspace.id, thread.id, 'Request', {
      kind: 'user',
      id: 'user_local',
    });
    store.createItem({
      id: 'it_history',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      createdAt: workspace.createdAt,
      type: 'user-message',
      actor: { kind: 'user', id: 'user_local' },
      text: 'Request',
      status: 'completed',
      completedAt: workspace.createdAt,
    });
    const now = workspace.createdAt;
    store.createAgentSession({
      id: 'as_history',
      agentId: 'agent_history',
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'idle',
      message: null,
      createdAt: now,
      updatedAt: now,
      retainedStorage: { storageRef: `wst_${'a'.repeat(32)}`, workSlotRef: 'work' },
      sandboxSummary: { access: 'none', workspaceRootRefs: [], summary: null },
      workspaceRoots: [
        {
          id: 'root_host',
          sourceKind: 'host-dir',
          sourcePath: '/history',
          workerPath: '/work/history',
          access: 'read-only',
        },
        {
          id: 'root_remote',
          sourceKind: 'remote-git',
          sourceCommit: 'a'.repeat(40),
          workerPath: '/work/remote',
          access: 'read-only',
        },
      ],
    });
    const body = 'Retained artifact.';
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    store.createArtifact({
      id: 'ar_history',
      workspaceId: workspace.id,
      threadId: null,
      turnId: null,
      kind: 'file',
      title: 'History',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body },
      contentDigest: digest,
      lastMutationRequestId: 'import-history',
      origin: {
        kind: 'imported',
        sourceKind: 'direct-import',
        sourceId: 'import-history',
        sourceDigest: digest,
        actor: { kind: 'user', id: 'user_local' },
        requestId: 'import-history',
        recordedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    });
    const root = join(dataRoot, 'workspaces', workspace.id);
    const workspacePath = join(root, 'workspace-record.json');
    const sessionPath = join(root, 'runtime', 'agent-sessions', 'as_history', 'session.json');
    const artifactPath = join(root, 'artifacts', 'ar_history', 'artifact.json');
    const turnPath = join(root, 'threads', thread.id, 'turns', turn.id, 'turn.json');
    for (const [path, nesting] of [
      [workspacePath, []],
      [turnPath, []],
      [turnPath, ['triggerActor']],
      [sessionPath, []],
      [sessionPath, ['sandboxSummary']],
      [sessionPath, ['retainedStorage']],
      [sessionPath, ['workspaceRoots', '0']],
      [sessionPath, ['workspaceRoots', '1']],
      [artifactPath, []],
      [artifactPath, ['origin']],
      [artifactPath, ['origin', 'actor']],
      [artifactPath, ['content']],
    ] as const)
      annotate(path, nesting);
    const itemsPath = join(root, 'threads', thread.id, 'turns', turn.id, 'items.jsonl');
    const item = JSON.parse(readFileSync(itemsPath, 'utf8').trim());
    item.futureNote = 'retained';
    item.actor.futureNote = 'retained';
    writeFileSync(itemsPath, `${JSON.stringify(item)}\n`);
    const itemBytes = readFileSync(itemsPath, 'utf8');
    const snapshots = [
      { event: 'workspace.updated', data: { type: 'workspace-updated', workspace } },
      { event: 'turn.updated', data: { type: 'turn-updated', turn: store.getTurnById(turn.id) } },
      {
        event: 'item.created',
        data: {
          type: 'item-created',
          item: { ...item, actor: { kind: 'user', id: 'user_local' } },
        },
      },
    ];
    for (const [index, snapshot] of snapshots.entries())
      appendWorkspaceTurnEvent(root, {
        protocolVersion: '1',
        sequence: index + 1,
        requestId: null,
        timestamp: now,
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        ...snapshot,
      } as Parameters<typeof appendWorkspaceTurnEvent>[1]);
    const eventsPath = join(
      root,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'runtime',
      'events.jsonl'
    );
    const events = readFileSync(eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const event of events) {
      event.futureNote = 'retained';
      event.data.futureNote = 'retained';
      const snapshot = event.data.workspace ?? event.data.turn ?? event.data.item;
      snapshot.futureNote = 'retained';
      if (snapshot.triggerActor) {
        snapshot.triggerActor.futureNote = 'retained';
        for (const nested of snapshot.items) nested.actor.futureNote = 'retained';
      }
      if (snapshot.actor) snapshot.actor.futureNote = 'retained';
    }
    // A field name known to another event remains inert on this event variant.
    events[0].data.turn = { futureNote: 'retained' };
    writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const eventBytes = readFileSync(eventsPath, 'utf8');
    const loaded = loadWorkspaceFileRecords(dataRoot).find(
      (entry) => entry.workspace.id === workspace.id
    )!;
    expect(JSON.stringify(loaded)).not.toContain('futureNote');
    writeWorkspaceFileRecords(root, {
      ...loaded,
      workspace: { ...loaded.workspace, status: 'archived' },
    });
    const reopened = loadWorkspaceFileRecords(dataRoot).find(
      (entry) => entry.workspace.id === workspace.id
    )!;
    expect(reopened.workspace.status).toBe('archived');
    expect(JSON.stringify(reopened)).not.toContain('futureNote');
    for (const path of [workspacePath, turnPath, sessionPath, artifactPath])
      expect(readFileSync(path, 'utf8')).toContain('futureNote');
    expect(readFileSync(itemsPath, 'utf8')).toBe(itemBytes);
    expect(readFileSync(eventsPath, 'utf8')).toBe(eventBytes);
    annotate(sessionPath, ['retainedStorage']);
    const damaged = JSON.parse(readFileSync(sessionPath, 'utf8'));
    damaged.status = 'future';
    writeFileSync(sessionPath, JSON.stringify(damaged));
    expect(() => loadWorkspaceFileRecords(dataRoot)).toThrow();
  });
});
