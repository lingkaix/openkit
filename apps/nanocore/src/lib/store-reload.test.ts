import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ItemSchema,
  KnowledgeEntrySchema,
  PROTOCOL_VERSION,
  ThreadSchema,
  TurnSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import { FsStore } from './store.js';

const timestamp = '2026-07-06T00:00:00.000Z';
const localActor = { kind: 'user', id: 'user_local' } as const;

/**
 * Computes the canonical S16 digest for exact UTF-8 Artifact content.
 *
 * @param content Exact Artifact body.
 * @returns Lowercase SHA-256 digest with the required prefix.
 */
function artifactDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * Builds the matching current-version proof for a work-produced Artifact fixture.
 *
 * @param threadId Producing Thread id.
 * @param turnId Producing Turn id.
 * @param requestId Artifact creation request id.
 * @param content Exact Artifact body.
 * @returns S16 content, mutation, and immutable-origin proof.
 */
function turnOutputArtifactProof(
  threadId: string,
  turnId: string,
  requestId: string,
  content: string
) {
  return {
    contentDigest: artifactDigest(content),
    lastMutationRequestId: requestId,
    origin: {
      kind: 'turn-output' as const,
      threadId,
      turnId,
      requestId,
    },
  };
}

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
  const item = ItemSchema.parse({
    id: itemId,
    workspaceId,
    threadId,
    turnId: `turn_${workspaceId}`,
    type: 'user-message',
    actor: localActor,
    status: 'completed',
    text: 'Imported message',
    createdAt: timestamp,
    completedAt: timestamp,
  });

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
    turns: [
      TurnSchema.parse({
        id: item.turnId,
        workspaceId,
        threadId,
        triggerActor: localActor,
        items: [item],
        status: 'completed',
        humanGate: null,
        error: null,
        configVersion: null,
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 0,
      }),
    ],
    itemRevisions: [item],
    artifacts: [],
    agentSessions: [],
    turnEvents: [],
  };
}

describe('FsStore canonical reload', () => {
  it('rebuilds every workspace from canonical records and resolves the latest item revision', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-canonical-reload-'));
    const store = new FsStore({ dataRoot });
    const firstWorkspace = store.createWorkspace('First canonical workspace');
    const firstThread = store.createThread(firstWorkspace.id, 'First canonical thread');
    const firstTurn = store.createTurn(
      firstWorkspace.id,
      firstThread.id,
      'Persist the first canonical turn',
      localActor
    );
    const firstItem = store.createItem({
      id: `it_${firstTurn.id}`,
      workspaceId: firstWorkspace.id,
      threadId: firstThread.id,
      turnId: firstTurn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Initial canonical item text.',
      createdAt: firstTurn.startedAt ?? timestamp,
      completedAt: firstTurn.startedAt ?? timestamp,
    });
    const updatedFirstItem = store.updateItem(firstItem.id, {
      text: 'Latest canonical item text.',
    });
    const secondWorkspace = store.createWorkspace('Second canonical workspace');
    const secondThread = store.createThread(secondWorkspace.id, 'Second canonical thread');
    const secondTurn = store.createTurn(
      secondWorkspace.id,
      secondThread.id,
      'Persist the second canonical turn',
      localActor
    );
    const secondItem = store.createItem({
      id: `it_${secondTurn.id}`,
      workspaceId: secondWorkspace.id,
      threadId: secondThread.id,
      turnId: secondTurn.id,
      type: 'user-message',
      actor: localActor,
      status: 'completed',
      text: 'Second workspace item.',
      createdAt: secondTurn.startedAt ?? timestamp,
      completedAt: secondTurn.startedAt ?? timestamp,
    });
    const firstWorkspaceRoot = join(dataRoot, 'workspaces', firstWorkspace.id);
    const firstItemsPath = join(
      firstWorkspaceRoot,
      'threads',
      firstThread.id,
      'turns',
      firstTurn.id,
      'items.jsonl'
    );

    writeFileSync(
      firstItemsPath,
      `${JSON.stringify(firstItem)}\n${JSON.stringify(updatedFirstItem)}\n`
    );
    const restarted = new FsStore({ dataRoot });

    expect(restarted.getWorkspace(firstWorkspace.id)).toEqual(
      store.getWorkspace(firstWorkspace.id)
    );
    expect(restarted.getThread(firstWorkspace.id, firstThread.id)).toEqual(
      store.getThread(firstWorkspace.id, firstThread.id)
    );
    expect(restarted.getTurn(firstWorkspace.id, firstThread.id, firstTurn.id)).toEqual(
      store.getTurn(firstWorkspace.id, firstThread.id, firstTurn.id)
    );
    expect(restarted.listThreadItems(firstWorkspace.id, firstThread.id)).toEqual([
      updatedFirstItem,
    ]);
    expect(restarted.getWorkspace(secondWorkspace.id)).toEqual(
      store.getWorkspace(secondWorkspace.id)
    );
    expect(restarted.getThread(secondWorkspace.id, secondThread.id)).toEqual(
      store.getThread(secondWorkspace.id, secondThread.id)
    );
    expect(restarted.getTurn(secondWorkspace.id, secondThread.id, secondTurn.id)).toEqual(
      store.getTurn(secondWorkspace.id, secondThread.id, secondTurn.id)
    );
    expect(restarted.listThreadItems(secondWorkspace.id, secondThread.id)).toEqual([secondItem]);
  });

  it('does not create workspace-wide store snapshots during normal persistence', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-canonical-persist-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Canonical persistence workspace');
    const thread = store.createThread(workspace.id, 'Canonical persistence thread');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Persist canonical records only',
      localActor
    );

    store.createItem({
      id: `it_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      actor: localActor,
      status: 'completed',
      text: 'Canonical persistence only.',
      createdAt: turn.startedAt ?? timestamp,
      completedAt: turn.startedAt ?? timestamp,
    });

    expect(
      store
        .listWorkspaces()
        .some((persistedWorkspace) =>
          existsSync(join(dataRoot, 'workspaces', persistedWorkspace.id, 'store.json'))
        )
    ).toBe(false);
  });

  it('appends item revisions to the canonical item log', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-item-log-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Append-only item workspace');
    const thread = store.createThread(workspace.id, 'Append-only item thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Append item revisions', localActor);
    const item = store.createItem({
      id: `it_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'in_progress',
      text: 'Initial item revision.',
      createdAt: turn.startedAt ?? timestamp,
      completedAt: null,
    });
    const itemsPath = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'items.jsonl'
    );
    const turnPath = join(dirname(itemsPath), 'turn.json');
    const initialLog = readFileSync(itemsPath, 'utf8');
    const updatedItem = store.updateItem(item.id, {
      status: 'completed',
      text: 'Completed item revision.',
      completedAt: item.createdAt,
    });

    const appendedLog = readFileSync(itemsPath, 'utf8');
    expect(appendedLog.startsWith(initialLog)).toBe(true);
    expect(JSON.parse(appendedLog.slice(initialLog.length))).toEqual(updatedItem);
    const turnRecord = JSON.parse(readFileSync(turnPath, 'utf8')) as { items: unknown[] };
    expect(turnRecord.items).toEqual([]);
    expect(JSON.stringify(turnRecord)).not.toContain(updatedItem.text);
  });

  it('reloads canonical workspace records and event logs without store.json', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-reload-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Reload Workspace');
    const knowledge = store.createKnowledgeEntry(workspace.id, {
      kind: 'project-context',
      title: 'Reload context',
      content: 'Snapshot reload should preserve this knowledge entry.',
    });
    const thread = store.createThread(workspace.id, 'Reload thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Persist the whole turn', localActor);
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
      actor: localActor,
      status: 'completed',
      text: 'Persist the whole turn',
      createdAt: turn.startedAt ?? new Date().toISOString(),
      completedAt: turn.startedAt ?? new Date().toISOString(),
    });
    store.createItem({
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
      description: 'Approval survives canonical reload.',
      createdAt: userItem.createdAt,
      resolvedAt: null,
    });
    const approvalRequestItem = store.createItem({
      id: `it_approval_request_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: approval.id,
      title: approval.title,
      description: approval.description,
      kind: approval.kind,
      createdAt: userItem.createdAt,
      completedAt: userItem.completedAt,
    });
    const approvalDecisionItem = store.createItem({
      id: `it_approval_decision_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'approval-decision',
      actor: localActor,
      causationId: approvalRequestItem.id,
      status: 'completed',
      approvalRequestId: approval.id,
      decision: 'granted',
      createdAt: userItem.createdAt,
      completedAt: userItem.completedAt,
    });
    const resolvedApproval = store.updateApproval(approval.id, {
      status: 'granted',
      resolvedAt: approvalDecisionItem.completedAt,
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
    const artifactBody = '# Canonical artifact body\n\nOnly the content file owns these bytes.';
    const artifact = store.createArtifact({
      id: `ar_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Reload artifact',
      status: 'ready',
      summary: 'Artifact survives canonical reload.',
      version: 1,
      content: { format: 'markdown', body: artifactBody },
      ...turnOutputArtifactProof(
        thread.id,
        turn.id,
        'artifact-create-canonical-reload',
        artifactBody
      ),
      createdAt: userItem.createdAt,
      updatedAt: userItem.createdAt,
    });
    const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    const artifactMetadataPath = join(workspaceRoot, 'artifacts', artifact.id, 'artifact.json');
    const artifactContentPath = join(
      workspaceRoot,
      'artifacts',
      artifact.id,
      'files',
      'content.md'
    );
    const eventLogPath = join(
      workspaceRoot,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'runtime',
      'events.jsonl'
    );
    const agentSessionEvent = store.emitTurnEvent(turn.id, {
      event: 'agent.session.updated',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'agent-session-updated', agentSession },
    });
    const initialEventLog = existsSync(eventLogPath) ? readFileSync(eventLogPath, 'utf8') : '';
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
    const forbiddenLegacyStorePaths = store
      .listWorkspaces()
      .map((persistedWorkspace) =>
        join(dataRoot, 'workspaces', persistedWorkspace.id, 'store.json')
      );
    const artifactMetadata = JSON.parse(readFileSync(artifactMetadataPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const finalEventLog = existsSync(eventLogPath) ? readFileSync(eventLogPath, 'utf8') : '';

    expect.soft(artifactMetadata).toEqual({
      ...artifact,
      content: { format: artifact.content.format },
    });
    expect.soft(JSON.stringify(artifactMetadata)).not.toContain(artifact.content.body);
    expect.soft(readFileSync(artifactContentPath, 'utf8')).toBe(artifact.content.body);
    expect.soft(initialEventLog).toBe(`${JSON.stringify(agentSessionEvent)}\n`);
    expect.soft(finalEventLog).toBe(`${initialEventLog}${JSON.stringify(artifactEvent)}\n`);

    expect(forbiddenLegacyStorePaths.some((path) => existsSync(path))).toBe(false);

    const restarted = new FsStore({ dataRoot });

    expect(restarted.getWorkspace(workspace.id)).toEqual(store.getWorkspace(workspace.id));
    expect(restarted.getWorkspaceResources(workspace.id).knowledge).toContainEqual(knowledge);
    expect(restarted.getKnowledgeSource(workspace.id, knowledgeSource.id)).toEqual(knowledgeSource);
    expect(restarted.readKnowledgeSourceMaterial(workspace.id, knowledgeSource.id)).toBe(
      knowledgeSourceContent
    );
    expect(restarted.getThread(workspace.id, thread.id)).toEqual(persistedThread);
    expect(restarted.getTurn(workspace.id, thread.id, turn.id)).toEqual(completedTurn);
    expect(restarted.listThreadItems(workspace.id, thread.id)).toEqual(completedTurn.items);
    expect(restarted.getApproval(approval.id)).toEqual(resolvedApproval);
    expect(restarted.getAgentSession(agentSession.id)).toEqual(agentSession);
    expect(restarted.getArtifact(workspace.id, artifact.id)).toEqual(artifact);
    expect(restarted.getTurnEvents(turn.id)).toEqual([agentSessionEvent, artifactEvent]);
  });

  it('reloads only the last one hundred appended turn events', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-event-window-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Event window workspace');
    const thread = store.createThread(workspace.id, 'Event window thread');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Append bounded replay events',
      localActor
    );

    for (let index = 0; index < 105; index += 1) {
      store.emitTurnEvent(turn.id, {
        event: 'turn.started',
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        data: { type: 'turn-started', turnId: turn.id, status: 'running' },
      });
    }

    const restarted = new FsStore({ dataRoot });
    const events = restarted.getTurnEvents(turn.id);

    expect(events).toHaveLength(100);
    expect(events[0]?.sequence).toBe(6);
    expect(events.at(-1)?.sequence).toBe(105);
  });

  it('removes stale knowledge records', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-stale-knowledge-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Stale knowledge workspace');
    const knowledge = store.createKnowledgeEntry(workspace.id, {
      kind: 'project-context',
      title: 'Delete this knowledge',
      content: 'This canonical page must be removed.',
    });
    const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    const knowledgePath = join(workspaceRoot, 'knowledge', 'pages', `${knowledge.id}.md`);

    store.deleteKnowledgeEntry(workspace.id, knowledge.id);

    expect(existsSync(knowledgePath)).toBe(false);
  });

  it('preserves a workspace-authored knowledge schema during unrelated persistence', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-custom-schema-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Custom schema workspace');
    const schemaPath = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'knowledge',
      'schema',
      'workspace-schema.yaml'
    );
    const customSchema = 'schema_version: "custom-test"\nallowed_types: ["KnowledgePage"]\n';

    writeFileSync(schemaPath, customSchema);
    store.createThread(workspace.id, 'Unrelated persistence');

    expect(readFileSync(schemaPath, 'utf8')).toBe(customSchema);
  });

  it('rejects path-bearing canonical record ids before they escape their family root', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-path-id-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Safe path workspace');
    const thread = store.createThread(workspace.id, 'Safe path thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Reject unsafe artifact id', localActor);
    const artifactBody = 'Must not escape.';
    const escapedPath = join(dataRoot, 'workspaces', workspace.id, 'escaped_artifact');

    expect(() =>
      store.createArtifact({
        id: '../../escaped_artifact',
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        kind: 'summary',
        title: 'Unsafe artifact',
        status: 'ready',
        summary: null,
        version: 1,
        content: { format: 'text', body: artifactBody },
        ...turnOutputArtifactProof(
          thread.id,
          turn.id,
          'artifact-create-unsafe-path-fixture',
          artifactBody
        ),
        createdAt: turn.startedAt ?? timestamp,
        updatedAt: turn.startedAt ?? timestamp,
      })
    ).toThrow(/safe path segment/);
    expect(existsSync(escapedPath)).toBe(false);
  });

  it('rejects symbolic links for canonical artifact bodies and source materials', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-canonical-symlink-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Canonical symlink workspace');
    const thread = store.createThread(workspace.id, 'Canonical symlink thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Reject canonical symlinks', localActor);
    const artifactBody = 'Canonical artifact body.';
    const artifact = store.createArtifact({
      id: `ar_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Canonical artifact',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body: artifactBody },
      ...turnOutputArtifactProof(
        thread.id,
        turn.id,
        'artifact-create-before-symlink-corruption',
        artifactBody
      ),
      createdAt: turn.startedAt ?? timestamp,
      updatedAt: turn.startedAt ?? timestamp,
    });
    const source = store.createKnowledgeSource(
      {
        id: `ks_${turn.id}`,
        workspaceId: workspace.id,
        kind: 'upload',
        title: 'Canonical source',
        uri: null,
        contentDigest: 'sha256:canonical-source',
        originatingThreadId: thread.id,
        originatingTurnId: turn.id,
        originatingFileId: null,
        createdAt: turn.startedAt ?? timestamp,
        updatedAt: turn.startedAt ?? timestamp,
      },
      'Canonical source material.'
    );
    const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    const outsidePath = join(dataRoot, 'outside-canonical-content.txt');
    const artifactBodyPath = join(workspaceRoot, 'artifacts', artifact.id, 'files', 'content.txt');
    const sourceMaterialPath = join(
      workspaceRoot,
      'sources',
      'materials',
      source.id,
      'content.txt'
    );

    writeFileSync(outsidePath, 'Outside canonical content.');
    rmSync(artifactBodyPath);
    symlinkSync(outsidePath, artifactBodyPath);
    expect(() => new FsStore({ dataRoot })).toThrow(/symbolic link|regular file/);

    rmSync(artifactBodyPath);
    writeFileSync(artifactBodyPath, artifact.content.body);
    rmSync(sourceMaterialPath);
    symlinkSync(outsidePath, sourceMaterialPath);
    expect(() => store.readKnowledgeSourceMaterial(workspace.id, source.id)).toThrow(
      /symbolic link|regular file/
    );
  });

  it('repairs a pending approval gate from its canonical request item', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-approval-request-recovery-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Approval request recovery workspace');
    const thread = store.createThread(workspace.id, 'Approval request recovery thread');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Recover the pending approval gate',
      localActor
    );
    const approval = store.createApproval({
      id: `ap_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Recover approval request',
      description: 'The request item must recover its turn projection.',
      createdAt: turn.startedAt ?? timestamp,
      resolvedAt: null,
    });
    const requestItem = store.createItem({
      id: `it_approval_request_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'approval-request',
      status: 'in_progress',
      approvalRequestId: approval.id,
      title: approval.title,
      description: approval.description,
      kind: approval.kind,
      createdAt: approval.createdAt,
      completedAt: null,
    });

    const restarted = new FsStore({ dataRoot });
    const recoveredTurn = restarted.getTurn(workspace.id, thread.id, turn.id);

    expect(restarted.getApproval(approval.id)).toEqual(approval);
    expect(recoveredTurn).toMatchObject({
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: approval.id,
        itemId: requestItem.id,
      },
    });
    expect(
      JSON.parse(
        readFileSync(
          join(
            dataRoot,
            'workspaces',
            workspace.id,
            'threads',
            thread.id,
            'turns',
            turn.id,
            'turn.json'
          ),
          'utf8'
        )
      )
    ).toMatchObject({ status: 'awaiting_human', humanGate: recoveredTurn.humanGate });
  });

  it('clears a stale approval gate from its canonical decision item', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-approval-decision-recovery-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Approval decision recovery workspace');
    const thread = store.createThread(workspace.id, 'Approval decision recovery thread');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Recover the approval decision',
      localActor
    );
    const approval = store.createApproval({
      id: `ap_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'permission',
      status: 'pending',
      title: 'Recover approval decision',
      description: 'The decision item must clear its stale turn gate.',
      createdAt: turn.startedAt ?? timestamp,
      resolvedAt: null,
    });
    const requestItem = store.createItem({
      id: `it_approval_request_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: approval.id,
      title: approval.title,
      description: approval.description,
      kind: approval.kind,
      createdAt: approval.createdAt,
      completedAt: approval.createdAt,
    });

    store.updateTurn(turn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: approval.id,
        itemId: requestItem.id,
      },
    });
    store.createItem({
      id: `it_approval_decision_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'approval-decision',
      actor: localActor,
      causationId: requestItem.id,
      status: 'completed',
      approvalRequestId: approval.id,
      decision: 'granted',
      createdAt: approval.createdAt,
      completedAt: approval.createdAt,
    });

    const restarted = new FsStore({ dataRoot });

    expect(restarted.getApproval(approval.id)).toMatchObject({
      status: 'granted',
      resolvedAt: approval.createdAt,
    });
    expect(restarted.getTurn(workspace.id, thread.id, turn.id)).toMatchObject({
      status: 'running',
      humanGate: null,
    });
  });

  it('rejects an approval gate without a canonical request item', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-orphan-approval-gate-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Orphan approval gate workspace');
    const thread = store.createThread(workspace.id, 'Orphan approval gate thread');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Reject an orphan approval gate',
      localActor
    );

    store.updateTurn(turn.id, {
      status: 'awaiting_human',
      humanGate: {
        kind: 'approval',
        approvalRequestId: `ap_${turn.id}`,
        itemId: `it_approval_request_${turn.id}`,
      },
    });

    expect(() => new FsStore({ dataRoot })).toThrow(/approval gate.*request item/i);
  });

  it('does not reopen a terminal turn for an unresolved approval request', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-terminal-approval-request-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Terminal approval request workspace');
    const thread = store.createThread(workspace.id, 'Terminal approval request thread');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Reject terminal approval recovery',
      localActor
    );
    const approvalId = `ap_${turn.id}`;

    store.createItem({
      id: `it_approval_request_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'approval-request',
      status: 'in_progress',
      approvalRequestId: approvalId,
      title: 'Unresolved terminal approval',
      description: 'A terminal turn must not be reopened.',
      kind: 'permission',
      createdAt: turn.startedAt ?? timestamp,
      completedAt: null,
    });
    store.updateTurn(turn.id, {
      status: 'failed',
      completedAt: turn.startedAt ?? timestamp,
      error: { code: 'interrupted', message: 'The turn failed before recovery.' },
    });

    expect(() => new FsStore({ dataRoot })).toThrow(/pending approval.*terminal turn/i);
  });

  it('repairs only an incomplete final item-log fragment', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-truncated-item-log-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Truncated item log workspace');
    const thread = store.createThread(workspace.id, 'Truncated item log thread');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Repair the final item fragment',
      localActor
    );
    const item = store.createItem({
      id: `it_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'in_progress',
      text: 'Valid item revision.',
      createdAt: turn.startedAt ?? timestamp,
      completedAt: null,
    });
    const itemsPath = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'items.jsonl'
    );
    const validLog = readFileSync(itemsPath, 'utf8');

    appendFileSync(itemsPath, '{"id":"truncated');
    const restarted = new FsStore({ dataRoot });

    expect(restarted.listThreadItems(workspace.id, thread.id)).toEqual([item]);
    expect(readFileSync(itemsPath, 'utf8')).toBe(validLog);

    writeFileSync(itemsPath, `${validLog}{"id":"broken"\n${JSON.stringify(item)}\n`);
    expect(() => new FsStore({ dataRoot })).toThrow();

    writeFileSync(itemsPath, `${validLog}not-json`);
    expect(() => new FsStore({ dataRoot })).toThrow();
  });

  it('normalizes a valid final item revision before future appends', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-item-log-newline-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Item log newline workspace');
    const thread = store.createThread(workspace.id, 'Item log newline thread');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Normalize the final item row',
      localActor
    );
    const item = store.createItem({
      id: `it_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'in_progress',
      text: 'Valid item revision.',
      createdAt: turn.startedAt ?? timestamp,
      completedAt: null,
    });
    const itemsPath = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'items.jsonl'
    );

    writeFileSync(itemsPath, JSON.stringify(item));
    const restarted = new FsStore({ dataRoot });
    const updated = restarted.updateItem(item.id, {
      status: 'completed',
      completedAt: item.createdAt,
    });

    const normalizedLog = readFileSync(itemsPath, 'utf8');
    expect(normalizedLog.endsWith('\n')).toBe(true);
    expect(normalizedLog.trimEnd().split('\n').map(JSON.parse)).toEqual([item, updated]);
  });

  it('repairs an incomplete final event-log fragment', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-truncated-event-log-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Truncated event log workspace');
    const thread = store.createThread(workspace.id, 'Truncated event log thread');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Repair the final event fragment',
      localActor
    );
    const event = store.emitTurnEvent(turn.id, {
      event: 'turn.started',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'turn-started', turnId: turn.id, status: 'running' },
    });
    const eventPath = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'runtime',
      'events.jsonl'
    );
    const validLog = readFileSync(eventPath, 'utf8');

    appendFileSync(eventPath, '{"event":"truncated');
    const restarted = new FsStore({ dataRoot });

    expect(restarted.getTurnEvents(turn.id)).toEqual([event]);
    expect(readFileSync(eventPath, 'utf8')).toBe(validLog);
  });

  it('rejects canonical writes through an artifact directory link', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-artifact-parent-link-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Artifact parent link workspace');
    const thread = store.createThread(workspace.id, 'Artifact parent link thread');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Reject the linked artifact root',
      localActor
    );
    const artifactId = `ar_linked_${turn.id}`;
    const artifactBody = 'Must not escape through the linked parent.';
    const outsideRoot = join(dataRoot, 'outside-artifact-root');
    const linkedRoot = join(dataRoot, 'workspaces', workspace.id, 'artifacts', artifactId);

    mkdirSync(outsideRoot);
    symlinkSync(outsideRoot, linkedRoot);

    expect(() =>
      store.createArtifact({
        id: artifactId,
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        kind: 'summary',
        title: 'Linked artifact',
        status: 'ready',
        summary: null,
        version: 1,
        content: { format: 'text', body: artifactBody },
        ...turnOutputArtifactProof(
          thread.id,
          turn.id,
          'artifact-create-linked-parent-fixture',
          artifactBody
        ),
        createdAt: turn.startedAt ?? timestamp,
        updatedAt: turn.startedAt ?? timestamp,
      })
    ).toThrow(/symbolic link/);
    expect(existsSync(join(outsideRoot, 'artifact.json'))).toBe(false);
    expect(existsSync(join(outsideRoot, 'files'))).toBe(false);
  });

  it('rejects immutable item revision changes on write and reload', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-item-identity-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Immutable item workspace');
    const thread = store.createThread(workspace.id, 'Immutable item thread');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Protect immutable item identity',
      localActor
    );
    const item = store.createItem({
      id: `it_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Immutable item revision.',
      createdAt: turn.startedAt ?? timestamp,
      completedAt: turn.startedAt ?? timestamp,
    });
    const itemsPath = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'items.jsonl'
    );

    expect(() => store.updateItem(item.id, { createdAt: '2026-07-07T00:00:00.000Z' })).toThrow(
      /immutable identity/
    );
    appendFileSync(
      itemsPath,
      `${JSON.stringify({ ...item, type: 'user-message', actor: localActor })}\n`
    );
    expect(() => new FsStore({ dataRoot })).toThrow(/immutable identity/);
  });

  it('rejects embedded canonical bodies that duplicate append logs or artifact files', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-embedded-canonical-body-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Embedded canonical body workspace');
    const thread = store.createThread(workspace.id, 'Embedded canonical body thread');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Reject embedded canonical bodies',
      localActor
    );
    const item = store.createItem({
      id: `it_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      actor: localActor,
      status: 'completed',
      text: 'Canonical item body.',
      createdAt: turn.startedAt ?? timestamp,
      completedAt: turn.startedAt ?? timestamp,
    });
    const artifactBody = 'Canonical artifact body.';
    const artifact = store.createArtifact({
      id: `ar_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Canonical artifact body',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body: artifactBody },
      ...turnOutputArtifactProof(
        thread.id,
        turn.id,
        'artifact-create-before-embedded-body-corruption',
        artifactBody
      ),
      createdAt: turn.startedAt ?? timestamp,
      updatedAt: turn.startedAt ?? timestamp,
    });
    const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    const turnPath = join(workspaceRoot, 'threads', thread.id, 'turns', turn.id, 'turn.json');
    const artifactPath = join(workspaceRoot, 'artifacts', artifact.id, 'artifact.json');
    const turnMetadata = JSON.parse(readFileSync(turnPath, 'utf8')) as Record<string, unknown>;
    const artifactMetadata = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<
      string,
      unknown
    >;

    writeFileSync(turnPath, `${JSON.stringify({ ...turnMetadata, items: [item] }, null, 2)}\n`);
    expect(() => new FsStore({ dataRoot })).toThrow(/must not embed items/);

    writeFileSync(turnPath, `${JSON.stringify(turnMetadata, null, 2)}\n`);
    writeFileSync(
      artifactPath,
      `${JSON.stringify(
        { ...artifactMetadata, content: { format: 'text', body: 'Duplicated body.' } },
        null,
        2
      )}\n`
    );
    expect(() => new FsStore({ dataRoot })).toThrow(/must not embed content body/);
  });

  it('rejects turn events whose nested payload crosses canonical lineage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-event-payload-lineage-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Event payload lineage workspace');
    const thread = store.createThread(workspace.id, 'Event payload lineage thread');
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Reject nested event lineage',
      localActor
    );
    const event = store.emitTurnEvent(turn.id, {
      event: 'turn.started',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'turn-started', turnId: turn.id, status: 'running' },
    });
    const eventPath = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'runtime',
      'events.jsonl'
    );

    writeFileSync(
      eventPath,
      `${JSON.stringify({ ...event, data: { ...event.data, turnId: 'tu_other' } })}\n`
    );
    expect(() => new FsStore({ dataRoot })).toThrow(/nested payload lineage/);
  });

  it('rejects global ids claimed by records in two workspaces', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-global-collision-'));
    const store = new FsStore({ dataRoot });
    const firstWorkspace = store.createWorkspace('First collision workspace');
    const firstThread = store.createThread(firstWorkspace.id, 'First collision thread');
    const secondWorkspace = store.createWorkspace('Second collision workspace');
    store.createThread(secondWorkspace.id, 'Second collision thread');
    const duplicateRoot = join(
      dataRoot,
      'workspaces',
      secondWorkspace.id,
      'threads',
      firstThread.id
    );

    mkdirSync(duplicateRoot, { recursive: true });
    writeFileSync(
      join(duplicateRoot, 'thread.json'),
      `${JSON.stringify({ ...firstThread, workspaceId: secondWorkspace.id }, null, 2)}\n`
    );

    expect(() => new FsStore({ dataRoot })).toThrow(
      `Duplicate global thread id: ${firstThread.id}`
    );
  });

  it('rejects duplicate-current AgentSessions during canonical reload', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-duplicate-current-session-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Duplicate current AgentSession workspace');
    const thread = store.createThread(workspace.id, 'Duplicate current AgentSession thread');
    const current = store.createAgentSession({
      id: 'as_reload_current_first',
      agentId: 'agent_codex_host',
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'idle',
      message: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const duplicate = {
      ...current,
      id: 'as_reload_current_second',
      status: 'ready' as const,
    };
    const duplicateRoot = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'runtime',
      'agent-sessions',
      duplicate.id
    );

    mkdirSync(duplicateRoot, { recursive: true });
    writeFileSync(join(duplicateRoot, 'session.json'), `${JSON.stringify(duplicate, null, 2)}\n`);

    expect(() => new FsStore({ dataRoot })).toThrow();
  });

  it('rejects canonical record directories missing required records', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-missing-identity-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Missing identity workspace');
    const thread = store.createThread(workspace.id, 'Missing identity thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Missing identity turn', localActor);
    const artifactBody = 'Artifact body.';
    const artifact = store.createArtifact({
      id: `ar_${turn.id}`,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Missing identity artifact',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body: artifactBody },
      ...turnOutputArtifactProof(
        thread.id,
        turn.id,
        'artifact-create-before-missing-record-corruption',
        artifactBody
      ),
      createdAt: turn.startedAt ?? timestamp,
      updatedAt: turn.startedAt ?? timestamp,
    });
    const session = store.createAgentSession({
      id: `as_${turn.id}`,
      agentId: 'agent_codex_host',
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'busy',
      message: null,
      createdAt: turn.startedAt ?? timestamp,
      updatedAt: turn.startedAt ?? timestamp,
    });
    const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
    const paths = [
      join(workspaceRoot, 'workspace.json'),
      join(workspaceRoot, 'threads', thread.id, 'thread.json'),
      join(workspaceRoot, 'threads', thread.id, 'turns', turn.id, 'turn.json'),
      join(workspaceRoot, 'threads', thread.id, 'turns', turn.id, 'items.jsonl'),
      join(workspaceRoot, 'artifacts', artifact.id, 'artifact.json'),
      join(workspaceRoot, 'runtime', 'agent-sessions', session.id, 'session.json'),
    ];

    for (const path of paths) {
      const content = readFileSync(path);

      rmSync(path);
      expect(() => new FsStore({ dataRoot })).toThrow(/missing .+\.jsonl?/i);
      writeFileSync(path, content);
    }
  });

  it.each([
    ['missing Turn.triggerActor', 'turn', null, 'triggerActor', undefined],
    [
      'invalid Turn.triggerActor',
      'turn',
      null,
      'triggerActor',
      { kind: 'automation', id: 'automation_invalid' },
    ],
    ['missing user-message actor', 'item', 'user-message', 'actor', undefined],
    [
      'invalid user-message actor',
      'item',
      'user-message',
      'actor',
      { kind: 'automation', id: 'automation_invalid' },
    ],
    ['missing approval-decision actor', 'item', 'approval-decision', 'actor', undefined],
    [
      'invalid approval-decision actor',
      'item',
      'approval-decision',
      'actor',
      { kind: 'automation', id: 'automation_invalid', responsibleUserId: 'user_local' },
    ],
    [
      'missing user-input-request responsible user',
      'item',
      'user-input-request',
      'responsibleUserId',
      undefined,
    ],
    [
      'mismatched user-input-request responsible user',
      'item',
      'user-input-request',
      'responsibleUserId',
      'user_other',
    ],
    ['missing user-input-response actor', 'item', 'user-input-response', 'actor', undefined],
    [
      'invalid user-input-response actor',
      'item',
      'user-input-response',
      'actor',
      { kind: 'automation', id: 'automation_invalid', responsibleUserId: 'user_local' },
    ],
  ] as const)('rejects a canonical Workspace with %s', (_name, recordKind, itemType, field, invalidValue) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-invalid-attribution-'));
    const store = new FsStore({ dataRoot });
    const workspaceId = `ws_attribution_${itemType ?? 'turn'}`;
    const input = workspaceImportPayload(workspaceId, 'th_attribution', 'it_attribution');
    store.importWorkspaceSnapshot(input);
    const turn = input.turns[0]!;

    const turnRoot = join(
      dataRoot,
      'workspaces',
      workspaceId,
      'threads',
      turn.threadId,
      'turns',
      turn.id
    );
    const recordPath = join(turnRoot, recordKind === 'turn' ? 'turn.json' : 'items.jsonl');
    if (recordKind === 'turn') {
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
      if (invalidValue === undefined) {
        delete record[field];
      } else {
        record[field] = invalidValue;
      }
      writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    } else {
      const records = readFileSync(recordPath, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const record = records[0]!;
      record.type = itemType;
      if (itemType === 'approval-decision') {
        Object.assign(record, {
          actor: localActor,
          causationId: 'it_approval_request_attribution',
          approvalRequestId: 'apr_attribution',
          decision: 'granted',
        });
      } else if (itemType === 'user-input-request') {
        Object.assign(record, {
          responsibleUserId: localActor.id,
          userInputRequestId: 'uir_attribution',
          prompt: 'Provide attributable input.',
          questions: [
            {
              id: 'question_attribution',
              header: 'Attribution',
              question: 'Continue?',
              options: null,
              isOther: true,
              isSecret: false,
            },
          ],
        });
      } else if (itemType === 'user-input-response') {
        Object.assign(record, {
          actor: localActor,
          causationId: 'it_user_input_request_attribution',
          userInputRequestId: 'uir_attribution',
          answers: { question_attribution: ['Yes'] },
        });
      }
      if (invalidValue === undefined) {
        delete record[field];
      } else {
        record[field] = invalidValue;
      }
      writeFileSync(
        recordPath,
        `${records.map((candidate) => JSON.stringify(candidate)).join('\n')}\n`
      );
    }

    expect(() => new FsStore({ dataRoot })).toThrow();
  });

  it.each([
    ['stale turn items', /Turn items/],
    ['non-contiguous events', /Turn event .* invalid lineage/],
    ['batch duplicate thread', /Duplicate .*thread/i],
    ['null-thread AgentSession', /AgentSession .* invalid lineage/],
    ['orphan turn-bound artifact', /artifact-reference/i],
  ] as const)('rejects imported workspace history with %s', (violation, expectedError) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-invalid-import-history-'));
    const store = new FsStore({ dataRoot });
    const workspaceId = `ws_${violation.replaceAll(' ', '_')}`;
    const input = workspaceImportPayload(
      workspaceId,
      `th_${violation.replaceAll(' ', '_')}`,
      `it_${violation.replaceAll(' ', '_')}`
    );
    const turn = input.turns[0]!;

    switch (violation) {
      case 'stale turn items':
        input.turns = [{ ...turn, items: [] }];
        break;
      case 'non-contiguous events':
        input.turnEvents = [
          [
            turn.id,
            [
              {
                protocolVersion: PROTOCOL_VERSION,
                event: 'turn.started',
                sequence: 2,
                requestId: null,
                timestamp,
                workspaceId,
                threadId: turn.threadId,
                turnId: turn.id,
                data: { type: 'turn-started', turnId: turn.id, status: 'running' },
              },
            ],
          ],
        ];
        break;
      case 'batch duplicate thread':
        input.threads = [...input.threads, input.threads[0]!];
        break;
      case 'null-thread AgentSession':
        input.agentSessions = [
          {
            id: 'as_null_thread_import',
            agentId: 'agent_codex_host',
            workspaceId,
            threadId: null,
            status: 'idle',
            message: null,
            sandboxSummary: null,
            configVersion: null,
            environmentPackageSnapshotId: null,
            policySnapshotId: null,
            sessionCompatibilityKey: null,
            stale: false,
            workspaceRoots: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ];
        break;
      case 'orphan turn-bound artifact': {
        const artifactBody = 'This Artifact has no Item lineage.';
        input.artifacts = [
          {
            id: 'ar_orphan_turn_bound_import',
            workspaceId,
            threadId: turn.threadId,
            turnId: turn.id,
            kind: 'summary',
            title: 'Orphan imported artifact',
            status: 'ready',
            summary: null,
            version: 1,
            content: { format: 'text', body: artifactBody },
            ...turnOutputArtifactProof(
              turn.threadId,
              turn.id,
              'artifact-create-orphan-import-fixture',
              artifactBody
            ),
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ];
        break;
      }
    }

    expect(() => store.importWorkspaceSnapshot(input)).toThrow(expectedError);
  });

  it('rolls back imported records when persistence fails', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-import-rollback-'));
    const store = new FsStore({ dataRoot });
    const workspaceId = 'ws_blocked';
    const threadId = 'th_blocked';
    const workspacePath = join(dataRoot, 'workspaces', workspaceId);

    mkdirSync(join(dataRoot, 'workspaces'), { recursive: true });
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
    const stagingPath = join(dataRoot, 'workspaces', '.staging');

    writeFileSync(stagingPath, 'not a directory');

    expect(() =>
      store.importWorkspaceSnapshot(workspaceImportPayload(workspaceId, 'th_staged', 'it_staged'))
    ).toThrow();

    expect(existsSync(join(dataRoot, 'workspaces', workspaceId))).toBe(false);
    expect(() => store.getWorkspace(workspaceId)).toThrow(`Workspace not found: ${workspaceId}`);
  });

  it('runs imported workspace side effects inside the staging root', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-import-staged-effects-'));
    const store = new FsStore({ dataRoot });
    const workspaceId = 'ws_staged_effects';
    const finalRoot = join(dataRoot, 'workspaces', workspaceId);
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

  it('derives approval state immediately after importing canonical history', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-import-approval-state-'));
    const store = new FsStore({ dataRoot });
    const input = workspaceImportPayload(
      'ws_import_approval_state',
      'th_import_approval_state',
      'it_import_approval_message'
    );
    const turn = input.turns[0]!;
    const approvalItem = ItemSchema.parse({
      id: 'it_import_approval_request',
      workspaceId: input.workspace.id,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'approval-request',
      status: 'in_progress',
      approvalRequestId: 'apr_imported',
      title: 'Approve imported work',
      description: 'Confirm the imported canonical history.',
      kind: 'permission',
      createdAt: timestamp,
      completedAt: null,
    });

    store.importWorkspaceSnapshot({
      ...input,
      turns: [
        TurnSchema.parse({
          ...turn,
          items: [...turn.items, approvalItem],
          status: 'awaiting_human',
          humanGate: {
            kind: 'approval',
            approvalRequestId: approvalItem.approvalRequestId,
            itemId: approvalItem.id,
          },
          completedAt: null,
          durationMs: null,
        }),
      ],
      itemRevisions: [...input.itemRevisions, approvalItem],
    });

    expect(store.getApproval(approvalItem.approvalRequestId)).toMatchObject({
      id: approvalItem.approvalRequestId,
      workspaceId: input.workspace.id,
      threadId: turn.threadId,
      turnId: turn.id,
      status: 'pending',
    });
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

    expect(existsSync(join(dataRoot, 'workspaces', workspaceId))).toBe(false);
    expect(() => store.getWorkspace(workspaceId)).toThrow(`Workspace not found: ${workspaceId}`);
  });

  it('cleans orphaned import staging roots on startup', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-import-staging-cleanup-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Staging cleanup workspace');
    const stagingRoot = join(dataRoot, 'workspaces', '.staging', 'ws_orphaned');

    mkdirSync(stagingRoot, { recursive: true });
    writeFileSync(join(stagingRoot, 'orphaned-import'), 'discarded');

    const restarted = new FsStore({ dataRoot });

    expect(restarted.getWorkspace(workspace.id)).toEqual(workspace);
    expect(existsSync(stagingRoot)).toBe(false);
  });

  it('rejects canonical replay events missing protocol versions', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-removed-event-version-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Removed event protocol version');
    const thread = store.createThread(workspace.id, 'Replay event thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Replay event turn', localActor);
    const eventLogPath = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'turns',
      turn.id,
      'runtime',
      'events.jsonl'
    );

    store.emitTurnEvent(turn.id, {
      event: 'turn.started',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      data: { type: 'turn-started', turnId: turn.id, status: 'running' },
    });

    const event = JSON.parse(readFileSync(eventLogPath, 'utf8')) as Record<string, unknown>;

    delete event.protocolVersion;
    writeFileSync(eventLogPath, `${JSON.stringify(event)}\n`);

    expect(() => new FsStore({ dataRoot })).toThrow(/protocolVersion/);
  });
});
