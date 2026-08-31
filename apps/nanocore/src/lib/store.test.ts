import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { AgentSessionSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createPendingUserTurnRecord } from '../goal-steering-authority.js';
import { openUserDb, openWorkspaceDb } from '../storage/db.js';
import { userDbPath, workspaceDbPath } from '../storage/fs-layout.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { parseCanonicalWorkspaceHistory } from '../storage/workspace-file-records.js';
import { createDemoWorkspaceForUser, FsStore } from './store.js';

const LOCAL_ACTOR = { kind: 'user', id: 'user_local' } as const;

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
 * Creates one valid workspace-only direct-import Artifact for store tests.
 *
 * @param store Store that owns the Artifact.
 * @param workspaceId Owning Workspace id.
 * @param requestId Import command request id.
 * @param claimedDigest Optional caller digest used to exercise validation.
 * @param status Optional imported Artifact status used to exercise shape validation.
 * @returns Created imported Artifact.
 */
function createImportedArtifact(
  store: FsStore,
  workspaceId: string,
  requestId: string,
  claimedDigest?: string,
  status: 'ready' | 'draft' = 'ready'
) {
  const acceptedAt = '2026-07-18T00:00:00.000Z';
  const body = `Imported by ${requestId}.`;
  const contentDigest = claimedDigest ?? artifactDigest(body);

  return store.createArtifact({
    id: `ar_${requestId}`,
    workspaceId,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: 'Imported Artifact',
    status,
    summary: null,
    version: 1,
    content: { format: 'text', body },
    contentDigest,
    lastMutationRequestId: requestId,
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: requestId,
      sourceDigest: contentDigest,
      actor: { kind: 'user', id: 'user_local' },
      requestId,
      recordedAt: acceptedAt,
    },
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  });
}

describe('FsStore persistence', () => {
  it('keeps Turn and human-input attribution immutable', () => {
    const store = new FsStore();
    store.ensureQuickChatWorkspace(LOCAL_ACTOR.id);
    const thread = store.createThread('ws_quick_chat', 'Attribution ownership');
    const turn = store.createTurn('ws_quick_chat', thread.id, 'Record exact actor', LOCAL_ACTOR);
    const createdAt = turn.startedAt ?? new Date().toISOString();
    const message = store.createItem({
      id: 'it_attribution_message',
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      actor: LOCAL_ACTOR,
      text: 'Record exact actor',
      createdAt,
      completedAt: createdAt,
    });
    const request = store.createItem({
      id: 'it_attribution_request',
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'user-input-request',
      status: 'completed',
      responsibleUserId: LOCAL_ACTOR.id,
      userInputRequestId: 'uir_attribution',
      prompt: 'Answer once.',
      questions: [
        {
          id: 'answer',
          header: 'Answer',
          question: 'Answer once.',
          options: null,
          isOther: false,
          isSecret: false,
        },
      ],
      createdAt,
      completedAt: createdAt,
    });
    expect(() =>
      store.createItem({
        id: 'it_attribution_foreign_response',
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'user-input-response',
        status: 'completed',
        actor: { kind: 'user', id: 'user_other' },
        causationId: 'request_foreign',
        userInputRequestId: 'uir_attribution',
        answers: { answer: ['no'] },
        createdAt,
        completedAt: createdAt,
      })
    ).toThrow('User-input response has invalid responsible user');
    const response = store.createItem({
      id: 'it_attribution_response',
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'user-input-response',
      status: 'completed',
      actor: LOCAL_ACTOR,
      causationId: 'request_attribution',
      userInputRequestId: 'uir_attribution',
      answers: { answer: ['yes'] },
      createdAt,
      completedAt: createdAt,
    });

    expect(turn.triggerActor).toEqual(LOCAL_ACTOR);
    expect(() =>
      store.createItem({ ...message, actor: { kind: 'user', id: 'user_other' } })
    ).toThrow('Item attribution cannot change');
    expect(() =>
      store.updateItem(message.id, { actor: { kind: 'user', id: 'user_other' } })
    ).toThrow('Item attribution cannot change');
    expect(() => store.updateItem(request.id, { responsibleUserId: 'user_other' })).toThrow(
      'Item attribution cannot change'
    );
    expect(() => store.updateItem(response.id, { causationId: 'request_other' })).toThrow(
      'Item attribution cannot change'
    );
  });

  it('seeds only Quick Chat for a new user', () => {
    const store = new FsStore();
    store.ensureQuickChatWorkspace(LOCAL_ACTOR.id);
    const workspaces = store.listWorkspaces();

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({
      id: 'ws_quick_chat',
      name: 'Quick Chat',
      kind: 'quick-chat',
    });
  });

  it('creates new user workspaces without a duplicate runtime catalog', () => {
    const store = new FsStore();
    const workspace = store.createWorkspace('Runnable workspace');
    const resources = store.getWorkspaceResources(workspace.id);

    expect(workspace).not.toHaveProperty('defaults');
    expect(resources.models).toEqual([]);
    expect(resources.agents).toEqual([]);
  });

  it('uses an explicit Turn start timestamp without changing the default clock path', () => {
    const store = new FsStore();
    store.ensureQuickChatWorkspace(LOCAL_ACTOR.id);
    const thread = store.createThread('ws_quick_chat', 'Turn timestamp ownership');
    const beforeDefault = Date.now();
    const defaultTurn = store.createTurn(
      'ws_quick_chat',
      thread.id,
      'Use the store clock',
      LOCAL_ACTOR
    );
    const afterDefault = Date.now();
    const explicitStartedAt = '2026-07-18T03:00:00.000Z';
    const explicitTurn = store.createTurn(
      'ws_quick_chat',
      thread.id,
      'Use the accepted command time',
      LOCAL_ACTOR,
      null,
      { turnId: 'tu_explicit_started_at', startedAt: explicitStartedAt }
    );

    expect(new Date(defaultTurn.startedAt!).getTime()).toBeGreaterThanOrEqual(beforeDefault);
    expect(new Date(defaultTurn.startedAt!).getTime()).toBeLessThanOrEqual(afterDefault);
    expect(explicitTurn.startedAt).toBe(explicitStartedAt);
  });

  it('reserves portable-import Approval identities for historical rows', () => {
    const store = new FsStore();
    store.ensureQuickChatWorkspace(LOCAL_ACTOR.id);
    const thread = store.createThread('ws_quick_chat', 'Reserved approval identity');
    const turn = store.createTurn(
      'ws_quick_chat',
      thread.id,
      'Do not create imported authority',
      LOCAL_ACTOR
    );

    expect(() =>
      store.createApproval({
        createdAt: turn.startedAt ?? new Date().toISOString(),
        description: 'Imported Approval identities cannot authorize target effects.',
        id: 'apr_imported_ws_quick_chat_1',
        kind: 'permission',
        resolvedAt: null,
        status: 'pending',
        threadId: thread.id,
        title: 'Reserved Approval identity',
        turnId: turn.id,
        workspaceId: 'ws_quick_chat',
      })
    ).toThrow('Approval id uses the reserved portable-import authority namespace.');
  });

  it('records exact immutable provenance and one deterministic producing-Turn reference', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-artifact-reference-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Artifact lineage workspace');
    const thread = store.createThread(workspace.id, 'Artifact lineage thread');
    const turn = store.createTurn(workspace.id, thread.id, 'Create an Artifact', LOCAL_ACTOR);
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const requestId = 'artifact-create-lineage-1';
    const body = 'Artifact version one.';
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
      content: { format: 'text', body },
      contentDigest: artifactDigest(body),
      lastMutationRequestId: requestId,
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: turn.id,
        requestId,
      },
      createdAt: timestamp,
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
        lastMutationRequestId: requestId,
      }),
    ]);
    expect(
      new FsStore({ dataRoot })
        .listWorkspaceItemRevisions(workspace.id)
        .filter((item) => item.type === 'artifact-reference' && item.artifactId === artifact.id)
    ).toEqual(lineage);
  });

  it('requires completed exact projections while preserving one historical v1 proof', () => {
    const store = new FsStore();
    const workspace = store.createWorkspace('Artifact revision lineage workspace');
    const thread = store.createThread(workspace.id, 'Artifact revision lineage thread');
    const producingTurn = store.createTurn(
      workspace.id,
      thread.id,
      'Create version one',
      LOCAL_ACTOR
    );
    const createdAt = producingTurn.startedAt ?? '2026-07-18T00:00:00.000Z';
    const versionOneBody = 'Artifact version one.';
    const artifact = store.createArtifact({
      id: 'ar_revision_lineage',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: producingTurn.id,
      kind: 'summary',
      title: 'Revision lineage',
      status: 'draft',
      summary: null,
      version: 1,
      content: { format: 'text', body: versionOneBody },
      contentDigest: artifactDigest(versionOneBody),
      lastMutationRequestId: 'artifact-create-revision-lineage',
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: producingTurn.id,
        requestId: 'artifact-create-revision-lineage',
      },
      createdAt,
      updatedAt: createdAt,
    });
    const communicatingTurn = store.createTurn(
      workspace.id,
      thread.id,
      'Communicate version two',
      LOCAL_ACTOR
    );
    const currentRequestId = 'artifact-save-revision-lineage';
    const currentReferenceId = `it_artifact_${createHash('sha256')
      .update(JSON.stringify([artifact.id, communicatingTurn.id]), 'utf8')
      .digest('hex')
      .slice(0, 24)}`;
    const currentReference = {
      id: currentReferenceId,
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: communicatingTurn.id,
      type: 'artifact-reference' as const,
      status: 'completed' as const,
      artifactId: artifact.id,
      artifactVersion: 2,
      title: artifact.title,
      summary: artifact.summary,
      lastMutationRequestId: currentRequestId,
      createdAt,
      completedAt: createdAt,
    };
    const versionTwoBody = 'Artifact version two.';
    const versionTwo = {
      ...artifact,
      version: 2,
      content: { format: 'text' as const, body: versionTwoBody },
      contentDigest: artifactDigest(versionTwoBody),
      lastMutationRequestId: currentRequestId,
      updatedAt: createdAt,
    };
    const history = {
      workspace,
      threads: [thread],
      turns: [
        store.getTurnById(producingTurn.id),
        { ...communicatingTurn, items: [currentReference] },
      ],
      itemRevisions: [...store.listWorkspaceItemRevisions(workspace.id), currentReference],
      artifacts: [versionTwo],
      agentSessions: [],
      turnEvents: [],
    };

    expect(parseCanonicalWorkspaceHistory(history).artifacts).toEqual([versionTwo]);
    const historicalReference = store
      .listWorkspaceItemRevisions(workspace.id)
      .find((item) => item.type === 'artifact-reference' && item.artifactId === artifact.id);
    if (!historicalReference || historicalReference.type !== 'artifact-reference') {
      throw new Error('Expected one producing Artifact reference.');
    }
    const invalidProofs = [
      {
        name: 'failed current reference',
        producing: historicalReference,
        current: { ...currentReference, status: 'failed' as const },
      },
      {
        name: 'in-progress current reference',
        producing: historicalReference,
        current: { ...currentReference, status: 'in_progress' as const },
      },
      {
        name: 'failed producing reference',
        producing: { ...historicalReference, status: 'failed' as const },
        current: currentReference,
      },
      {
        name: 'non-v1 producing reference',
        producing: { ...historicalReference, artifactVersion: 2 },
        current: currentReference,
      },
      {
        name: 'forged producing request proof',
        producing: { ...historicalReference, lastMutationRequestId: 'forged-producing-request' },
        current: currentReference,
      },
      {
        name: 'forged current title',
        producing: historicalReference,
        current: { ...currentReference, title: 'Forged current title' },
      },
      {
        name: 'forged current summary',
        producing: historicalReference,
        current: { ...currentReference, summary: 'Forged current summary' },
      },
      {
        name: 'non-deterministic current identity',
        producing: historicalReference,
        current: { ...currentReference, id: 'it_wrong_artifact_reference' },
      },
    ];

    for (const invalid of invalidProofs) {
      expect(
        () =>
          parseCanonicalWorkspaceHistory({
            ...history,
            turns: [
              { ...store.getTurnById(producingTurn.id), items: [invalid.producing] },
              { ...communicatingTurn, items: [invalid.current] },
            ],
            itemRevisions: [invalid.producing, invalid.current],
          }),
        invalid.name
      ).toThrow();
    }
  });

  it('does not invent an Item for a workspace-only Artifact', () => {
    const store = new FsStore();
    const workspace = store.createWorkspace('Workspace-only artifact');
    let error: unknown;
    try {
      createImportedArtifact(
        store,
        workspace.id,
        'artifact-import-wrong-digest',
        `sha256:${'0'.repeat(64)}`
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: 'source_digest_mismatch', status: 400 });
    expect(store.listArtifacts(workspace.id)).toEqual([]);
    error = undefined;
    try {
      createImportedArtifact(
        store,
        workspace.id,
        'artifact-import-invalid-shape',
        undefined,
        'draft'
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'invalid_request', status: 400 });
    expect(store.listArtifacts(workspace.id)).toEqual([]);
    createImportedArtifact(store, workspace.id, 'artifact-import-workspace-only');

    expect(store.listAllItems()).toEqual([]);
  });

  it('introduces one imported Artifact through deterministic completed Core-local Turns', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-artifact-introduction-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Artifact introduction workspace');
    const thread = store.createThread(workspace.id, 'Artifact introduction thread');
    const busyThread = store.createThread(workspace.id, 'Busy Artifact introduction thread');
    const artifact = createImportedArtifact(store, workspace.id, 'artifact-import-introduction');
    const firstInput = {
      workspaceId: workspace.id,
      threadId: thread.id,
      artifactId: artifact.id,
      expectedArtifactVersion: 1,
      requestId: 'artifact-introduction-1',
      acceptedAt: '2026-07-18T00:01:00.000Z',
      turnId: 'tu_artifact_introduction_1',
      triggerActor: LOCAL_ACTOR,
    } as const;
    const secondInput = {
      ...firstInput,
      requestId: 'artifact-introduction-2',
      acceptedAt: '2026-07-18T00:02:00.000Z',
      turnId: 'tu_artifact_introduction_2',
    } as const;

    store.createTurn(workspace.id, busyThread.id, 'Keep this Thread active', LOCAL_ACTOR);
    let error: unknown;
    try {
      store.introduceArtifact({
        ...firstInput,
        threadId: busyThread.id,
        turnId: 'tu_artifact_introduction_busy',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'thread_busy', status: 409 });
    expect(store.listThreadTurns(workspace.id, busyThread.id)).toHaveLength(1);

    const firstIntroduction = store.introduceArtifact(firstInput);
    const secondIntroduction = store.introduceArtifact(secondInput);

    expect(firstIntroduction).toEqual({
      artifactId: artifact.id,
      artifactVersion: 1,
      turnId: firstInput.turnId,
      itemId: expect.any(String),
    });
    expect(secondIntroduction).toEqual({
      artifactId: artifact.id,
      artifactVersion: 1,
      turnId: secondInput.turnId,
      itemId: expect.any(String),
    });
    expect(firstIntroduction.itemId).not.toBe(secondIntroduction.itemId);
    error = undefined;
    try {
      store.introduceArtifact(firstInput);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'recovery_required', status: 409 });

    const references = store
      .listAllItems()
      .filter((item) => item.type === 'artifact-reference' && item.artifactId === artifact.id);
    const firstReference = references[0]!;

    expect(store.getArtifact(workspace.id, artifact.id)).toEqual(artifact);
    expect(references).toEqual([
      expect.objectContaining({
        id: firstIntroduction.itemId,
        turnId: firstInput.turnId,
        artifactVersion: 1,
        lastMutationRequestId: firstInput.requestId,
      }),
      expect.objectContaining({
        id: secondIntroduction.itemId,
        turnId: secondInput.turnId,
        artifactVersion: 1,
        lastMutationRequestId: secondInput.requestId,
      }),
    ]);
    expect(store.listThreadTurns(workspace.id, thread.id)).toMatchObject([
      { id: firstInput.turnId, status: 'completed', completedAt: firstInput.acceptedAt },
      { id: secondInput.turnId, status: 'completed', completedAt: secondInput.acceptedAt },
    ]);

    expect(() => new FsStore({ dataRoot })).not.toThrow();

    const duplicate = {
      ...firstReference,
      id: 'it_artifact_introduction_duplicate',
      lastMutationRequestId: 'artifact-introduction-duplicate',
    };
    const turnRoot = join(
      dataRoot,
      'workspaces',
      workspace.id,
      'threads',
      thread.id,
      'turns',
      firstInput.turnId
    );

    writeFileSync(
      join(turnRoot, 'items.jsonl'),
      `${JSON.stringify(firstReference)}\n${JSON.stringify(duplicate)}\n`
    );

    expect(() => new FsStore({ dataRoot })).toThrow(/duplicate artifact-reference Items for Turn/);

    writeFileSync(join(turnRoot, 'items.jsonl'), `${JSON.stringify(firstReference)}\n`);
    expect(() => new FsStore({ dataRoot })).not.toThrow();
  });

  it('does not retain a turn when its owning thread is missing', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });
    const orphanTurnId = 'tu_missing_thread';

    seedDemoWorkspace(store);

    expect(() =>
      store.createTurn('ws_demo', 'th_missing', 'Reject this turn', LOCAL_ACTOR, null, {
        turnId: orphanTurnId,
      })
    ).toThrow('Thread not found: th_missing');

    let inMemoryOrphan: ReturnType<FsStore['getTurnById']> | null = null;
    try {
      inMemoryOrphan = store.getTurnById(orphanTurnId);
    } catch {}

    const validThread = store.createThread('ws_demo', 'Persist after rejected turn');
    store.createTurn('ws_demo', validThread.id, 'Persist valid work', LOCAL_ACTOR);

    const restarted = new FsStore({ dataRoot });
    let restartedOrphan: ReturnType<FsStore['getTurnById']> | null = null;
    try {
      restartedOrphan = restarted.getTurnById(orphanTurnId);
    } catch {}

    expect.soft(inMemoryOrphan).toBeNull();
    expect.soft(restartedOrphan).toBeNull();
  });

  it('restores thread, turn, event, knowledge, artifact, and AgentSession history after restart', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });
    seedDemoWorkspace(store);
    const thread = store.createThread('ws_demo', 'Persistent thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Persist this work', LOCAL_ACTOR);
    const knowledgeEntry = store.createKnowledgeEntry('ws_demo', {
      kind: 'project-context',
      title: 'Persisted knowledge',
      content: 'Knowledge survived restart.',
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
    const artifactBody = 'History survived restart.';
    const artifactRequestId = 'artifact-create-persisted';
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
      content: { format: 'markdown', body: artifactBody },
      contentDigest: artifactDigest(artifactBody),
      lastMutationRequestId: artifactRequestId,
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: turn.id,
        requestId: artifactRequestId,
      },
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

    const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
    const artifactProjectionPath = join(workspaceRoot, 'artifacts', artifact.id, 'artifact.json');
    const artifactContentPath = join(
      workspaceRoot,
      'artifacts',
      artifact.id,
      'files',
      'content.md'
    );
    const knowledgeProjectionPath = join(
      workspaceRoot,
      'knowledge',
      'pages',
      `${knowledgeEntry.id}.md`
    );
    const knowledgeSourceProjectionPath = join(
      workspaceRoot,
      'sources',
      'registry',
      `${knowledgeSource.id}.json`
    );
    const knowledgeSourceMaterialPath = join(
      workspaceRoot,
      'sources',
      'materials',
      knowledgeSource.id,
      'content.txt'
    );
    const agentSessionProjectionPath = join(
      workspaceRoot,
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
    expect(JSON.parse(readFileSync(knowledgeSourceProjectionPath, 'utf8'))).toEqual(
      knowledgeSource
    );
    expect(readFileSync(knowledgeSourceMaterialPath, 'utf8')).toBe(knowledgeSourceContent);
    expect(JSON.parse(readFileSync(agentSessionProjectionPath, 'utf8'))).toEqual(agentSession);
    expect(restarted.listThreads('ws_demo').map((item) => item.id)).toContain(thread.id);
    expect(restarted.getTurn('ws_demo', thread.id, turn.id).id).toBe(turn.id);
    expect(restarted.getKnowledgeEntry('ws_demo', knowledgeEntry.id)).toEqual(knowledgeEntry);
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
        .agents.map((agent) => agent.id)
        .sort()
    ).toEqual([]);
  });

  it('projects AgentSession events before returning or notifying listeners', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });
    seedDemoWorkspace(store);
    const thread = store.createThread('ws_demo', 'Product-safe session events');
    const turn = store.createTurn('ws_demo', thread.id, 'Emit a product-safe session', LOCAL_ACTOR);
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
      command: 'conversation.submit',
      requestId: '0190f4c8-0000-7000-8000-000000000501',
      scope: { workspaceId: workspace.id },
      inputHash: 'sha256:live',
      response: {
        kind: 'turn',
        id: 'tu_chat',
        conversationMetadata: {
          downstream: null,
          logicalModelId: 'reasoning',
          receivingThreadId: 'th_chat',
          receivingWorkspaceId: workspace.id,
          resultKind: 'provider-answer',
          status: 200,
          targetRef: 'internal-role:assistant',
        },
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
      restarted.getCommandRequest('conversation.submit', '0190f4c8-0000-7000-8000-000000000501', {
        workspaceId: workspace.id,
      })?.response
    ).toEqual({
      kind: 'turn',
      id: 'tu_chat',
      conversationMetadata: {
        downstream: null,
        logicalModelId: 'reasoning',
        receivingThreadId: 'th_chat',
        receivingWorkspaceId: workspace.id,
        resultKind: 'provider-answer',
        status: 200,
        targetRef: 'internal-role:assistant',
      },
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

  it('retains an expired steering send receipt only while its exact pending owner exists', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });
    seedDemoWorkspace(store);
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const requestId = '0190f4c8-0000-7000-8000-000000000506';
    const scope = { workspaceId: 'ws_demo', threadId: 'th_demo' };

    try {
      const pending = createPendingUserTurnRecord(workspaceDb, {
        workspaceId: scope.workspaceId,
        threadId: scope.threadId,
        goalId: 'go_receipt_retention',
        activeTurnId: 'tu_receipt_retention',
        requestId,
        input: { kind: 'message' },
        receivedAt: '2000-01-01T00:00:00.000Z',
      });
      store.recordCommandRequest(
        {
          command: 'goal.steering.send',
          requestId,
          scope,
          inputHash: 'sha256:pending-steering',
          response: { kind: 'pending_user_turn', id: pending.pendingTurnId },
          createdAt: '2000-01-01T00:00:00.000Z',
          expiresAt: '2000-01-08T00:00:00.000Z',
        },
        workspaceDb
      );

      expect(
        store.getCommandRequest('goal.steering.send', requestId, scope, workspaceDb)
      ).toMatchObject({
        response: { kind: 'pending_user_turn', id: pending.pendingTurnId },
      });

      workspaceDb.sqlite
        .prepare(
          'DELETE FROM pending_user_turn_records WHERE workspace_id = ? AND thread_id = ? AND pending_turn_id = ?'
        )
        .run(scope.workspaceId, scope.threadId, pending.pendingTurnId);

      expect(
        store.getCommandRequest('goal.steering.send', requestId, scope, workspaceDb)
      ).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('rejects extra receipt metadata outside conversation.submit', () => {
    const store = new FsStore();

    expect(() =>
      store.recordCommandRequest({
        command: 'thread.create',
        requestId: '0190f4c8-0000-7000-8000-000000000503',
        scope: { workspaceId: 'ws_quick_chat' },
        inputHash: 'sha256:forbidden-snapshot',
        response: {
          kind: 'thread',
          id: 'th_forbidden',
          conversationMetadata: { state: 'queued' },
        },
      })
    ).toThrow('Only conversation.submit may store extra command receipt metadata.');
    expect(() =>
      store.recordCommandRequest({
        command: 'thread.create',
        requestId: '0190f4c8-0000-7000-8000-000000000504',
        scope: { workspaceId: 'ws_quick_chat' },
        inputHash: 'sha256:forbidden-response-field',
        response: {
          kind: 'thread',
          id: 'th_forbidden_field',
          snapshot: { state: 'queued' },
        },
      } as Parameters<FsStore['recordCommandRequest']>[0])
    ).toThrow('Command receipt response contains unsupported fields.');
    expect(() =>
      store.recordCommandRequest({
        command: 'conversation.submit',
        requestId: '0190f4c8-0000-7000-8000-000000000505',
        scope: { workspaceId: 'ws_quick_chat' },
        inputHash: 'sha256:invalid-chat-metadata',
        response: {
          kind: 'turn',
          id: 'tu_invalid_chat_metadata',
          conversationMetadata: { downstream: null, resultKind: 'answered', status: 200 },
        },
      })
    ).toThrow('conversation.submit command receipt metadata is invalid.');
    expect(store.listCommandRequests()).toEqual([]);
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
    expect(existsSync(join(dataRoot, 'workspaces', workspaceId))).toBe(false);
  });

  it('homes durable command idempotency in its user or workspace database', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });
    seedDemoWorkspace(store);
    const userDb = openUserDb(dataRoot, 'user_local');
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
      scope: { userId: 'user_local' },
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
        path: workspaceDbPath(dataRoot, 'ws_demo'),
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

    const fileBackedRecordsRoot = join(dataRoot, 'workspaces');
    expect.soft(findStorageFilesContaining(fileBackedRecordsRoot, workspaceRequestId)).toEqual([]);
    expect.soft(findStorageFilesContaining(fileBackedRecordsRoot, userRequestId)).toEqual([]);
  });

  it('does not serialize dynamic execution resources under workspace storage', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-store-'));
    const store = new FsStore({ dataRoot });
    seedDemoWorkspace(store);
    const marker = 'runtime_only_test_marker';
    const resources = store.getWorkspaceResources('ws_demo');

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
      id: `agent_${marker}`,
      name: 'Runtime-only test agent',
      kind: 'coder',
      status: 'enabled',
      modelId: `model_${marker}`,
      skillIds: [`skill_${marker}`],
      profiles: [],
      defaultProfileId: null,
      capabilities: [],
      sandboxSummary: null,
      health: {
        status: 'unknown',
        message: null,
        checkedAt: null,
      },
    });

    expect(findStorageFilesContaining(join(dataRoot, 'workspaces', 'ws_demo'), marker)).toEqual([]);
  });

  it('clamps derived turn duration when completion time is earlier than start time', () => {
    const store = new FsStore();
    seedDemoWorkspace(store);
    const thread = store.createThread('ws_demo', 'Clock drift thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Close under clock drift', LOCAL_ACTOR);

    const updated = store.updateTurn(turn.id, {
      completedAt: '2000-01-01T00:00:00.000Z',
      status: 'failed',
    });

    expect(updated.durationMs).toBe(0);
  });
});
