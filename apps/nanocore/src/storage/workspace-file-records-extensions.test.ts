import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveEntityId, formatReferenceUri } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { updateOkfFrontmatter } from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { captureWorkspaceSourceFixture } from '../test-support/workspace-source.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import {
  appendWorkspaceTurnEvent,
  loadWorkspaceFileRecords,
  serializeKnowledgeProposalRecord,
  serializeUserAuthoredKnowledgePage,
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
  it('preserves immutable Proposal bytes, ordered Review annotations and Source history on rewrite', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-history-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Knowledge');
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId: workspace.id });
    onTestFinished(() => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const root = join(dataRoot, 'workspaces', workspace.id);
    const initial = loadWorkspaceFileRecords(dataRoot).find(
      (record) => record.workspace.id === workspace.id
    )!;
    const body = 'Knowledge candidate.\n';
    const knowledgeBaseId = readDefaultKnowledgeBaseId({
      dataRoot,
      scope: { kind: 'workspace', workspaceId: workspace.id },
    });
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(root, 'knowledge', 'notebook.git'),
    });
    const producer = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
    const sourceBytes = serializeUserAuthoredKnowledgePage(
      {
        id: 'source',
        kind: 'project-context',
        title: 'Retained evidence',
        content: 'Published source bytes for the retained Proposal.',
        sourceReferences: [],
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      },
      { kind: 'workspace', workspaceId: workspace.id }
    );
    const initialRevision = notebook.publishedRevision();
    const baseRevision = notebook.prepare({
      baseRevision: initialRevision,
      changes: { 'source.md': sourceBytes },
      metadata: {
        summary: 'Publish retained source fixture',
        changeRequest: {
          requestId: 'annotation-source',
          inputDigest: `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`,
        },
        producer,
        authority: { kind: 'direct', instructionReference: 'test:retained-source' },
        sourceReferences: [],
      },
    });
    notebook.publish({ baseRevision: initialRevision, candidateRevision: baseRevision });
    const sourceReference = formatReferenceUri(
      {
        scopeId: `page/workspace/${workspace.id}/${knowledgeBaseId}`,
        objectId: 'source',
      },
      `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`
    );
    const proposalId = `kp_${'a'.repeat(64)}`;
    const candidateRevision = notebook.prepare({
      baseRevision,
      changes: { 'candidate.md': body },
      metadata: {
        summary: 'Retained annotation fixture',
        changeRequest: {
          requestId: 'annotation-candidate',
          inputDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        },
        producer,
        authority: { kind: 'proposal', proposalId },
        sourceReferences: [sourceReference],
      },
    });
    notebook.retainCandidate({ proposalId, candidateRevision });
    const proposal = {
      id: proposalId,
      baseRevision,
      candidateRevision,
      workspaceId: workspace.id,
      operation: 'notebook-change' as const,
      ownerScope: { kind: 'workspace' as const, workspaceId: workspace.id },
      knowledgePageId: 'candidate',
      canonicalPageBytes: body,
      contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      sourceReferences: [sourceReference],
      rationale: 'Retained rationale',
      confidence: 1,
      producer: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
      createdAt: workspace.createdAt,
    };
    const capturedContent = 'Retained canonical Source history.\n';
    const source = await captureWorkspaceSourceFixture({
      dataRoot,
      coreDb,
      store,
      userId,
      source: {
        id: 'ks_00000000-0000-7735-9de8-620b1f965365',
        workspaceId: workspace.id,
        kind: 'document' as const,
        title: 'History',
        uri: null,
        contentDigest: `sha256:${createHash('sha256').update(capturedContent).digest('hex')}`,
        originatingThreadId: null,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: workspace.createdAt,
        createdAt: workspace.createdAt,
        updatedAt: workspace.createdAt,
      },
      content: capturedContent,
    });
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
      ownerScope: proposal.ownerScope,
      baseRevision,
      candidateRevision,
      reviewId: deriveEntityId('kr', {
        ownerScope: { kind: 'workspace', workspaceId: workspace.id },
        proposalId: proposal.id,
        requestId: reviewRequestId,
      }),
      requestId: reviewRequestId,
      decision: 'deferred' as const,
      actor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
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
    const sourceRevision = notebook.publishedRevision();
    const annotatedPointer = updateOkfFrontmatter({
      path: `sources/${source.id}.md`,
      content: notebook.readSourcePointers(sourceRevision)[source.id]!,
      updates: { futureNote: 'retained' },
    });
    const annotatedCandidate = notebook.prepareSourcePointers({
      baseRevision: sourceRevision,
      changes: { [source.id]: annotatedPointer },
      metadata: {
        ...notebook.readRevision(sourceRevision).metadata,
        summary: 'Annotate descriptive Source history',
        changeRequest: {
          requestId: 'annotation-source-extension',
          inputDigest: `sha256:${createHash('sha256').update(annotatedPointer).digest('hex')}`,
        },
      },
    });
    const annotatedRevision = notebook.publish({
      baseRevision: sourceRevision,
      candidateRevision: annotatedCandidate,
    }).revision;
    const extended = loadWorkspaceFileRecords(dataRoot).find(
      (record) => record.workspace.id === workspace.id
    )!;
    expect(JSON.stringify(extended)).not.toContain('futureNote');
    const updatedPointer = updateOkfFrontmatter({
      path: `sources/${source.id}.md`,
      content: notebook.readSourcePointers(annotatedRevision)[source.id]!,
      updates: { title: 'Updated' },
    });
    const updatedCandidate = notebook.prepareSourcePointers({
      baseRevision: annotatedRevision,
      changes: { [source.id]: updatedPointer },
      metadata: {
        ...notebook.readRevision(annotatedRevision).metadata,
        summary: 'Update the descriptive Source title',
        changeRequest: {
          requestId: 'annotation-source-title',
          inputDigest: `sha256:${createHash('sha256').update(updatedPointer).digest('hex')}`,
        },
      },
    });
    const updatedRevision = notebook.publish({
      baseRevision: annotatedRevision,
      candidateRevision: updatedCandidate,
    }).revision;
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
    expect(notebook.readSourcePointers(updatedRevision)[source.id]).toBe(updatedPointer);
    expect(updatedPointer).toContain('futureNote');
    expect(
      new KnowledgeNotebook({
        repositoryPath: join(root, 'knowledge', 'notebook.git'),
      }).readSourcePointers(updatedRevision)[source.id]
    ).toBe(updatedPointer);
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
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
    store.createItem({
      id: 'it_00000000-0000-7107-a6b6-12de9088d8ca',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      createdAt: workspace.createdAt,
      type: 'user-message',
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      text: 'Request',
      status: 'completed',
      completedAt: workspace.createdAt,
    });
    const now = workspace.createdAt;
    store.createAgentSession({
      id: 'as_00000000-0000-74db-9692-cadae15b58fb',
      agentId: 'agent_history',
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'idle',
      message: null,
      createdAt: now,
      updatedAt: now,
      retainedStorage: {
        storageRef: 'wst_00000000-0000-7b39-9ec2-cb19893c9f63',
        workSlotRef: 'work',
      },
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
      id: 'ar_00000000-0000-780c-b09d-92983bad1f5b',
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
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        requestId: 'import-history',
        recordedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    });
    const root = join(dataRoot, 'workspaces', workspace.id);
    const workspacePath = join(root, 'workspace-record.json');
    const sessionPath = join(
      root,
      'runtime',
      'agent-sessions',
      'as_00000000-0000-74db-9692-cadae15b58fb',
      'session.json'
    );
    const artifactPath = join(
      root,
      'artifacts',
      'ar_00000000-0000-780c-b09d-92983bad1f5b',
      'artifact.json'
    );
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
          item: {
            ...item,
            actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          },
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
