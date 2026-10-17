import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ItemSchema, PROTOCOL_VERSION } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';

import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { FsStore } from '../lib/store.js';
import { ensureLayout } from './fs-layout.js';
import { parseCanonicalWorkspaceHistory } from './workspace-file-records.js';

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
 * Creates two independent workspace turn lineages under one temporary data root.
 *
 * @returns Store plus the two workspace, thread, turn, and filesystem lineages.
 */
function createBoundaryFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-file-record-boundary-'));
  const store = new FsStore({ dataRoot });
  const firstWorkspace = store.createWorkspace('First boundary workspace');
  const firstThread = store.createThread(firstWorkspace.id, 'First boundary thread');
  const firstTurn = store.createTurn(firstWorkspace.id, firstThread.id, 'First boundary turn', {
    kind: 'user',
    id: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const secondWorkspace = store.createWorkspace('Second boundary workspace');
  const secondThread = store.createThread(secondWorkspace.id, 'Second boundary thread');
  const secondTurn = store.createTurn(secondWorkspace.id, secondThread.id, 'Second boundary turn', {
    kind: 'user',
    id: 'usr_00000000-0000-7000-8000-000000000001',
  });

  return {
    dataRoot,
    store,
    first: {
      workspace: firstWorkspace,
      thread: firstThread,
      turn: firstTurn,
      root: join(dataRoot, 'workspaces', firstWorkspace.id),
    },
    second: {
      workspace: secondWorkspace,
      thread: secondThread,
      turn: secondTurn,
      root: join(dataRoot, 'workspaces', secondWorkspace.id),
    },
  };
}

/** Fresh import supplies actual User attribution; no materialized page directory initializes content. */
function createNotebookBoundaryFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-file-record-notebook-'));
  onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
  const source = new FsStore();
  const workspace = source.createWorkspace('Notebook boundary workspace');
  const store = new FsStore({ dataRoot });
  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  const repositoryPath = join(workspaceRoot, 'knowledge', 'notebook.git');
  return {
    dataRoot,
    workspace,
    store,
    workspaceRoot,
    repositoryPath,
    notebook: new KnowledgeNotebook({ repositoryPath }),
    initialize: (files: Record<string, string>) =>
      store.importWorkspaceSnapshot({
        workspace,
        threads: [],
        turns: [],
        knowledge: [],
        itemRevisions: [],
        artifacts: [],
        agentSessions: [],
        turnEvents: [],
        initialNotebookFiles: files,
        notebookInitialization: {
          requestId: randomUUID(),
          producer: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          instructionReference: 'fixture:workspace-import',
        },
      }),
  };
}

describe('workspace file-record write and load boundaries', () => {
  // Fresh navigation and body-only normalization belong to notebook-initialization.test.ts, under the Notebook owner's Content, Revisions And History section.
  it('preserves the authored Git index during Thread writes without adopting materialized bytes', () => {
    const f = createNotebookBoundaryFixture();
    const authored = '---\nokf_version: "0.2"\n---\n# Team knowledge\n\nKeep this navigation.\n';
    f.initialize({ 'index.md': authored });
    const revision = f.notebook.publishedRevision();
    const pagesRoot = join(f.workspaceRoot, 'knowledge', 'pages');
    const indexPath = join(pagesRoot, 'index.md');

    expect(f.notebook.readRevision(revision).files['index.md']).toBe(authored);
    expect(existsSync(indexPath)).toBe(false);
    mkdirSync(pagesRoot, { recursive: true });
    const materialized = '# Materialized navigation is not content authority.\n';
    writeFileSync(indexPath, materialized);
    f.store.createThread(f.workspace.id, 'Do not adopt the materialized index');

    expect(f.notebook.publishedRevision()).toBe(revision);
    expect(f.notebook.readRevision(revision).files['index.md']).toBe(authored);
    expect(readFileSync(indexPath, 'utf8')).toBe(materialized);
    const reopened = new FsStore({ dataRoot: f.dataRoot });
    expect(reopened.listThreads(f.workspace.id)).toEqual(f.store.listThreads(f.workspace.id));
    expect(f.notebook.publishedRevision()).toBe(revision);
    expect(readFileSync(indexPath, 'utf8')).toBe(materialized);

    rmSync(indexPath);
    reopened.createThread(f.workspace.id, 'Do not recreate a materialized index');
    expect(existsSync(indexPath)).toBe(false);
    expect(f.notebook.publishedRevision()).toBe(revision);
    expect(f.notebook.readRevision(revision).files['index.md']).toBe(authored);
  });

  it('does not repair corrupt published Git from materialized pages during Thread writes', () => {
    const f = createNotebookBoundaryFixture();
    const authored = '---\nokf_version: "0.2"\n---\n# Retained navigation\n';
    f.initialize({ 'index.md': authored });
    const indexPath = join(f.workspaceRoot, 'knowledge', 'pages', 'index.md');
    mkdirSync(join(f.workspaceRoot, 'knowledge', 'pages'), { recursive: true });
    writeFileSync(indexPath, authored);
    const publishedPath = join(f.repositoryPath, 'refs', 'heads', 'published');
    const corruptRef = `${'0'.repeat(40)}\n`;
    writeFileSync(publishedPath, corruptRef);

    expect(() => f.store.createThread(f.workspace.id, 'Do not repair the Notebook')).toThrow(
      'Notebook recovery required.'
    );

    expect(() => f.notebook.publishedRevision()).toThrow('Notebook recovery required.');
    expect(() => new FsStore({ dataRoot: f.dataRoot })).toThrow('Notebook recovery required.');
    expect(readFileSync(publishedPath, 'utf8')).toBe(corruptRef);
    expect(readFileSync(indexPath, 'utf8')).toBe(authored);
  });

  it.each([
    '---\nokf_version: ["0.2"]\n---\n# Invalid scalar\n',
    '---\nokf_version: "0.1"\n---\n# Conflicting version\n',
    '---\nokf_version: "0.2"\n# Unclosed frontmatter\n',
  ])('rejects an invalid initial root index before publishing the Workspace', (content) => {
    const f = createNotebookBoundaryFixture();
    const originalWorkspaces = f.store.listWorkspaces();
    const files = { 'index.md': content };

    expect(() => f.initialize(files)).toThrow('Notebook invalid request.');
    expect(files['index.md']).toBe(content);
    expect(existsSync(f.workspaceRoot)).toBe(false);
    expect(f.store.listWorkspaces()).toEqual(originalWorkspaces);
    expect(new FsStore({ dataRoot: f.dataRoot }).listWorkspaces()).toEqual(originalWorkspaces);
  });
  it('does not fall back to owner-nested workspace records when the canonical root is absent', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-file-record-no-fallback-'));
    const seedStore = new FsStore({ dataRoot });
    const workspace = seedStore.createWorkspace('Legacy nested workspace');
    const canonicalRoot = join(dataRoot, 'workspaces', workspace.id);
    const ownerNestedRoot = join(
      dataRoot,
      'users',
      'usr_00000000-0000-7000-8000-000000000001',
      'workspaces',
      workspace.id
    );

    mkdirSync(join(dataRoot, 'users', 'usr_00000000-0000-7000-8000-000000000001', 'workspaces'), {
      recursive: true,
    });
    renameSync(canonicalRoot, ownerNestedRoot);

    expect(existsSync(canonicalRoot)).toBe(false);
    expect(existsSync(join(ownerNestedRoot, 'workspace-record.json'))).toBe(true);

    expect(() => ensureLayout(dataRoot)).toThrow(/owner-nested Workspace tree/);
    expect(
      new FsStore({ dataRoot }).listWorkspaces().map((candidate) => candidate.id)
    ).not.toContain(workspace.id);
  });

  it.each([
    'AgentSession',
    'artifact',
    'knowledge source',
  ] as const)('rejects a cross-workspace duplicate %s id without replacing its owner', (family) => {
    const { first, second, store } = createBoundaryFixture();
    const firstTimestamp = first.turn.startedAt ?? new Date().toISOString();
    const secondTimestamp = second.turn.startedAt ?? new Date().toISOString();

    switch (family) {
      case 'AgentSession': {
        const id = 'as_00000000-0000-7b0f-96e7-3f6551c1efa7';
        const original = store.createAgentSession({
          id,
          agentId: 'agent_codex_host',
          workspaceId: first.workspace.id,
          threadId: first.thread.id,
          status: 'busy',
          message: null,
          createdAt: firstTimestamp,
          updatedAt: firstTimestamp,
        });

        expect
          .soft(() =>
            store.createAgentSession({
              id,
              agentId: 'agent_codex_host',
              workspaceId: second.workspace.id,
              threadId: second.thread.id,
              status: 'busy',
              message: null,
              createdAt: secondTimestamp,
              updatedAt: secondTimestamp,
            })
          )
          .toThrow();
        expect.soft(store.getAgentSession(id)).toEqual(original);
        expect
          .soft(existsSync(join(first.root, 'runtime', 'agent-sessions', id, 'session.json')))
          .toBe(true);
        break;
      }

      case 'artifact': {
        const id = 'ar_00000000-0000-7466-96a2-e0274de2cc84';
        const original = store.createArtifact({
          id,
          workspaceId: first.workspace.id,
          threadId: first.thread.id,
          turnId: first.turn.id,
          kind: 'summary',
          title: 'Original artifact',
          status: 'ready',
          summary: 'The first workspace owns this artifact.',
          version: 1,
          content: { format: 'markdown', body: '# Original artifact' },
          contentDigest: artifactDigest('# Original artifact'),
          lastMutationRequestId: 'req_ar_cross_workspace_boundary_original',
          origin: {
            kind: 'turn-output',
            threadId: first.thread.id,
            turnId: first.turn.id,
            requestId: 'req_ar_cross_workspace_boundary_original',
          },
          createdAt: firstTimestamp,
          updatedAt: firstTimestamp,
        });

        expect
          .soft(() =>
            store.createArtifact({
              id,
              workspaceId: second.workspace.id,
              threadId: second.thread.id,
              turnId: second.turn.id,
              kind: 'summary',
              title: 'Replacement artifact',
              status: 'ready',
              summary: 'The second workspace must not replace the owner.',
              version: 1,
              content: { format: 'markdown', body: '# Replacement artifact' },
              contentDigest: artifactDigest('# Replacement artifact'),
              lastMutationRequestId: 'req_ar_cross_workspace_boundary_replacement',
              origin: {
                kind: 'turn-output',
                threadId: second.thread.id,
                turnId: second.turn.id,
                requestId: 'req_ar_cross_workspace_boundary_replacement',
              },
              createdAt: secondTimestamp,
              updatedAt: secondTimestamp,
            })
          )
          .toThrow();
        expect.soft(store.listArtifacts(first.workspace.id)).toContainEqual(original);
        expect.soft(existsSync(join(first.root, 'artifacts', id, 'artifact.json'))).toBe(true);
        break;
      }

      case 'knowledge source': {
        const id = 'ks_00000000-0000-7d9a-90f6-cb95212c42e2';
        const originalMaterial = 'The first workspace owns this source material.';
        const original = store.createKnowledgeSource(
          {
            id,
            workspaceId: first.workspace.id,
            kind: 'upload',
            title: 'Original source',
            uri: null,
            contentDigest: 'sha256:original-source',
            originatingThreadId: first.thread.id,
            originatingTurnId: first.turn.id,
            originatingFileId: 'file_original_source',
            capturedAt: firstTimestamp,
            createdAt: firstTimestamp,
            updatedAt: firstTimestamp,
          },
          originalMaterial
        );

        expect
          .soft(() =>
            store.createKnowledgeSource(
              {
                id,
                workspaceId: second.workspace.id,
                kind: 'upload',
                title: 'Replacement source',
                uri: null,
                contentDigest: 'sha256:replacement-source',
                originatingThreadId: second.thread.id,
                originatingTurnId: second.turn.id,
                originatingFileId: 'file_replacement_source',
                capturedAt: secondTimestamp,
                createdAt: secondTimestamp,
                updatedAt: secondTimestamp,
              },
              'The second workspace must not replace this material.'
            )
          )
          .toThrow();
        expect.soft(store.listKnowledgeSources(first.workspace.id)).toContainEqual(original);
        expect
          .soft(readFileSync(join(first.root, 'sources', 'materials', id, 'content.txt'), 'utf8'))
          .toBe(originalMaterial);
        break;
      }
    }
  });

  it.each([
    'id',
    'type',
    'workspaceId',
    'threadId',
    'turnId',
    'createdAt',
    'invalid create schema',
    'invalid update schema',
  ] as const)('rejects an item revision that changes or violates %s', (violation) => {
    const { dataRoot, first, second, store } = createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const original = store.createItem({
      id: 'it_00000000-0000-7c6d-b3b1-e8c48c8b327a',
      workspaceId: first.workspace.id,
      threadId: first.thread.id,
      turnId: first.turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'The original item is immutable.',
      createdAt: timestamp,
      completedAt: timestamp,
    });

    const operation = () => {
      switch (violation) {
        case 'id':
          store.updateItem(original.id, { id: 'it_00000000-0000-75cc-9039-96ddac89d51f' } as never);
          break;
        case 'type':
          store.createItem({
            id: original.id,
            workspaceId: first.workspace.id,
            threadId: first.thread.id,
            turnId: first.turn.id,
            type: 'status',
            status: 'completed',
            level: 'info',
            title: 'Changed item type',
            summary: null,
            createdAt: timestamp,
            completedAt: timestamp,
          });
          break;
        case 'workspaceId':
          store.updateItem(original.id, { workspaceId: second.workspace.id } as never);
          break;
        case 'threadId':
          store.updateItem(original.id, { threadId: second.thread.id } as never);
          break;
        case 'turnId':
          store.updateItem(original.id, { turnId: second.turn.id } as never);
          break;
        case 'createdAt':
          store.updateItem(original.id, { createdAt: '2030-01-01T00:00:00.000Z' });
          break;
        case 'invalid create schema':
          store.createItem({
            ...original,
            id: 'it_00000000-0000-7c32-92fd-418f5c9c8e1c',
            status: 'not-an-item-status',
          } as never);
          break;
        case 'invalid update schema':
          store.updateItem(original.id, { status: 'not-an-item-status' } as never);
          break;
      }
    };

    expect.soft(operation).toThrow();
    expect.soft(store.listThreadItems(first.workspace.id, first.thread.id)).toEqual([original]);
    expect.soft(() => new FsStore({ dataRoot })).not.toThrow();
  });

  it.each([
    {
      name: 'user-message actor',
      currentResponsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      original: {
        type: 'user-message',
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        text: 'Original user message.',
      },
      changed: { actor: { kind: 'user', id: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' } },
    },
    {
      name: 'approval-decision actor',
      currentResponsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      original: {
        type: 'approval-decision',
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        causationId: 'req_approval_original',
        approvalRequestId: 'apr_attribution_boundary',
        decision: 'granted',
        decidedAt: '2026-01-01T00:00:00.000Z',
      },
      changed: { actor: { kind: 'user', id: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' } },
    },
    {
      name: 'approval-decision causationId',
      currentResponsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      original: {
        type: 'approval-decision',
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        causationId: 'req_approval_original',
        approvalRequestId: 'apr_attribution_boundary',
        decision: 'granted',
        decidedAt: '2026-01-01T00:00:00.000Z',
      },
      changed: { causationId: 'req_approval_changed' },
    },
    {
      name: 'user-input-request responsibleUserId',
      currentResponsibleUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
      original: {
        type: 'user-input-request',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
        userInputRequestId: 'uir_attribution_boundary',
        prompt: 'Confirm the immutable attribution.',
        questions: [
          {
            id: 'question_attribution_boundary',
            header: 'Attribution',
            question: 'Continue?',
            options: null,
            isOther: true,
            isSecret: false,
          },
        ],
      },
      changed: { responsibleUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' },
    },
    {
      name: 'user-input-response actor',
      currentResponsibleUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
      original: {
        type: 'user-input-response',
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        causationId: 'req_user_input_original',
        userInputRequestId: 'uir_attribution_boundary',
        answers: { question_attribution_boundary: ['Yes'] },
        answeredAt: '2026-01-01T00:00:00.000Z',
      },
      changed: { actor: { kind: 'user', id: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' } },
    },
    {
      name: 'user-input-response causationId',
      currentResponsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      original: {
        type: 'user-input-response',
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        causationId: 'req_user_input_original',
        userInputRequestId: 'uir_attribution_boundary',
        answers: { question_attribution_boundary: ['Yes'] },
        answeredAt: '2026-01-01T00:00:00.000Z',
      },
      changed: { causationId: 'req_user_input_changed' },
    },
  ])('rejects a valid item revision that changes immutable $name', ({
    original,
    changed,
    currentResponsibleUserId,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-item-attribution-boundary-'));
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Item attribution boundary');
    const thread = store.createThread(workspace.id, 'Item attribution boundary');
    const triggerActor = { kind: 'user', id: currentResponsibleUserId } as const;
    const turn = store.createTurn(
      workspace.id,
      thread.id,
      'Protect immutable item attribution',
      triggerActor
    );
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const item = ItemSchema.parse({
      id: 'it_00000000-0000-7fc4-aae8-dd5cf69e5992',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      status: 'completed',
      createdAt: timestamp,
      completedAt: timestamp,
      ...original,
    });
    const changedItem = ItemSchema.parse({ ...item, ...changed });
    const supportingRequest =
      changedItem.type === 'user-input-response'
        ? ItemSchema.parse({
            id: 'it_00000000-0000-7562-879d-36174aa716fa',
            workspaceId: workspace.id,
            threadId: thread.id,
            turnId: turn.id,
            type: 'user-input-request',
            responsibleUserId: currentResponsibleUserId,
            status: 'completed',
            userInputRequestId: changedItem.userInputRequestId,
            prompt: 'Support the response attribution revision.',
            questions: [
              {
                id: 'question_attribution_boundary',
                header: 'Attribution',
                question: 'Continue?',
                options: null,
                isOther: true,
                isSecret: false,
              },
            ],
            createdAt: timestamp,
            completedAt: timestamp,
          })
        : null;
    const currentItems = supportingRequest ? [supportingRequest, changedItem] : [changedItem];
    const itemRevisions = supportingRequest
      ? [supportingRequest, item, changedItem]
      : [item, changedItem];

    expect(() =>
      parseCanonicalWorkspaceHistory({
        workspace,
        threads: [thread],
        turns: [{ ...turn, items: currentItems }],
        itemRevisions,
        artifacts: [],
        agentSessions: [],
        turnEvents: [],
      })
    ).toThrow(/attribution cannot change/);

    appendFileSync(
      join(
        dataRoot,
        'workspaces',
        workspace.id,
        'threads',
        thread.id,
        'turns',
        turn.id,
        'items.jsonl'
      ),
      `${supportingRequest ? `${JSON.stringify(supportingRequest)}\n` : ''}${JSON.stringify(item)}\n${JSON.stringify(changedItem)}\n`
    );
    expect(() => new FsStore({ dataRoot })).toThrow(/attribution cannot change/);
  });

  it('rejects a foreign-user response when reloading canonical Turn items', () => {
    const { dataRoot, first, store } = createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const request = store.createItem({
      id: 'it_00000000-0000-77d0-8f57-fa3818abb424',
      workspaceId: first.workspace.id,
      threadId: first.thread.id,
      turnId: first.turn.id,
      type: 'user-input-request',
      responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      status: 'completed',
      userInputRequestId: 'uir_reload_foreign_response',
      prompt: 'Confirm the responsible user.',
      questions: [
        {
          id: 'question_reload_foreign_response',
          header: 'Responsible user',
          question: 'Continue?',
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
      createdAt: timestamp,
      completedAt: timestamp,
    });
    const response = ItemSchema.parse({
      id: 'it_00000000-0000-7d43-84e8-cc9f1f1a67e0',
      workspaceId: first.workspace.id,
      threadId: first.thread.id,
      turnId: first.turn.id,
      type: 'user-input-response',
      actor: { kind: 'user', id: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' },
      causationId: 'req_reload_foreign_response',
      status: 'completed',
      userInputRequestId: request.userInputRequestId,
      answers: { question_reload_foreign_response: ['Yes'] },
      answeredAt: timestamp,
      createdAt: timestamp,
      completedAt: timestamp,
    });

    appendFileSync(
      join(first.root, 'threads', first.thread.id, 'turns', first.turn.id, 'items.jsonl'),
      `${JSON.stringify(response)}\n`
    );

    expect(() => new FsStore({ dataRoot })).toThrow(/responsible user/);
  });

  it('leaves item read models unchanged when the canonical append fails', () => {
    const { first, store } = createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const original = store.createItem({
      id: 'it_00000000-0000-72d9-a1ba-fc94cc09ebec',
      workspaceId: first.workspace.id,
      threadId: first.thread.id,
      turnId: first.turn.id,
      type: 'assistant-message',
      status: 'in_progress',
      text: 'The durable revision is still in progress.',
      createdAt: timestamp,
      completedAt: null,
    });
    const itemsPath = join(
      first.root,
      'threads',
      first.thread.id,
      'turns',
      first.turn.id,
      'items.jsonl'
    );

    rmSync(itemsPath);
    mkdirSync(itemsPath);

    expect(() =>
      store.updateItem(original.id, {
        status: 'completed',
        text: 'This failed append must not enter memory.',
        completedAt: timestamp,
      })
    ).toThrow();
    expect.soft(store.listThreadItems(first.workspace.id, first.thread.id)).toEqual([original]);
    expect
      .soft(store.getTurn(first.workspace.id, first.thread.id, first.turn.id).items)
      .toEqual([original]);
  });

  it.each([
    'id',
    'workspaceId',
    'threadId',
    'startedAt',
  ] as const)('rejects a turn update that changes immutable %s without altering memory or reload', (field) => {
    const { dataRoot, first, second, store } = createBoundaryFixture();
    const patch =
      field === 'id'
        ? { id: 'tu_00000000-0000-7d05-b7b7-98b9d4579c71' }
        : field === 'workspaceId'
          ? { workspaceId: second.workspace.id }
          : field === 'threadId'
            ? { threadId: second.thread.id }
            : { startedAt: '2030-01-01T00:00:00.000Z' };

    expect.soft(() => store.updateTurn(first.turn.id, patch)).toThrow();
    expect
      .soft(store.getTurn(first.workspace.id, first.thread.id, first.turn.id))
      .toEqual(first.turn);
    expect
      .soft(store.listThreadTurns(second.workspace.id, second.thread.id))
      .toEqual([second.turn]);
    expect(() => {
      const reloaded = new FsStore({ dataRoot });
      expect(reloaded.getTurn(first.workspace.id, first.thread.id, first.turn.id)).toEqual(
        first.turn
      );
      expect(reloaded.listThreadTurns(second.workspace.id, second.thread.id)).toEqual([
        second.turn,
      ]);
    }).not.toThrow();
  });

  it.each([
    'id',
    'workspaceId',
    'threadId',
    'createdAt',
  ] as const)('rejects an AgentSession update that changes immutable %s without altering memory or reload', (field) => {
    const { dataRoot, first, second, store } = createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const session = store.createAgentSession({
      id: 'as_00000000-0000-76dd-90ec-52fddf601ff7',
      agentId: 'agent_codex_host',
      workspaceId: first.workspace.id,
      threadId: first.thread.id,
      status: 'busy',
      message: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const patch =
      field === 'id'
        ? { id: 'as_00000000-0000-7436-a03e-9057e5ce1f82' }
        : field === 'workspaceId'
          ? { workspaceId: second.workspace.id }
          : field === 'threadId'
            ? { threadId: second.thread.id }
            : { createdAt: '2030-01-01T00:00:00.000Z' };

    expect.soft(() => store.updateAgentSession(session.id, patch)).toThrow();
    expect.soft(store.getAgentSession(session.id)).toEqual(session);
    expect(() => {
      const reloaded = new FsStore({ dataRoot });
      expect(reloaded.getAgentSession(session.id)).toEqual(session);
    }).not.toThrow();
  });

  it('rejects a second current AgentSession for the same Thread without a projection', () => {
    const { dataRoot, first, store } = createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const firstSession = store.createAgentSession({
      id: 'as_00000000-0000-747a-8276-9839920addd4',
      agentId: 'agent_codex_host',
      workspaceId: first.workspace.id,
      threadId: first.thread.id,
      status: 'busy',
      message: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const secondSessionId = 'as_00000000-0000-70e6-a30a-3a20e4fcde16';

    expect
      .soft(() =>
        store.createAgentSession({
          id: secondSessionId,
          agentId: 'agent_codex_host',
          workspaceId: first.workspace.id,
          threadId: first.thread.id,
          status: 'idle',
          message: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      )
      .toThrow();
    expect
      .soft(store.listThreadAgentSessions(first.workspace.id, first.thread.id))
      .toEqual([firstSession]);
    expect.soft(() => store.getAgentSession(secondSessionId)).toThrow();
    expect
      .soft(
        existsSync(join(first.root, 'runtime', 'agent-sessions', secondSessionId, 'session.json'))
      )
      .toBe(false);
    expect
      .soft(new FsStore({ dataRoot }).listThreadAgentSessions(first.workspace.id, first.thread.id))
      .toEqual([firstSession]);
  });

  it('creates a successor AgentSession after the predecessor becomes terminal', () => {
    const { first, store } = createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const predecessor = store.createAgentSession({
      id: 'as_00000000-0000-7cfe-9caa-d56ef5ebfb5d',
      agentId: 'agent_codex_host',
      workspaceId: first.workspace.id,
      threadId: first.thread.id,
      status: 'idle',
      message: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const closedPredecessor = store.updateAgentSession(predecessor.id, { status: 'closed' });
    const successor = store.createAgentSession({
      id: 'as_00000000-0000-7e61-83f5-32cd2f5b5f35',
      agentId: 'agent_codex_host',
      workspaceId: first.workspace.id,
      threadId: first.thread.id,
      status: 'created',
      message: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(store.listThreadAgentSessions(first.workspace.id, first.thread.id)).toEqual([
      closedPredecessor,
      successor,
    ]);
  });

  it('does not reopen a terminal AgentSession', () => {
    const { dataRoot, first, store } = createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const session = store.createAgentSession({
      id: 'as_00000000-0000-7914-bbcc-ec35419944b8',
      agentId: 'agent_codex_host',
      workspaceId: first.workspace.id,
      threadId: first.thread.id,
      status: 'busy',
      message: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const terminal = store.updateAgentSession(session.id, { status: 'interrupted' });

    expect.soft(() => store.updateAgentSession(session.id, { status: 'ready' })).toThrow();
    expect.soft(store.getAgentSession(session.id)).toEqual(terminal);
    expect.soft(new FsStore({ dataRoot }).getAgentSession(session.id)).toEqual(terminal);
  });

  it.each([
    ['AgentSession', 'missing thread'],
    ['AgentSession', 'cross-workspace thread'],
    ['artifact', 'missing thread'],
    ['artifact', 'missing turn'],
    ['artifact', 'cross-workspace lineage'],
    ['knowledge source', 'missing thread'],
    ['knowledge source', 'missing turn'],
    ['knowledge source', 'cross-workspace lineage'],
  ] as const)('rejects a new %s with %s before mutation', (family, violation) => {
    const { dataRoot, first, second, store } = createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const threadId =
      violation === 'missing thread'
        ? 'th_00000000-0000-7444-aba1-895da857a04e'
        : violation.includes('cross-workspace')
          ? second.thread.id
          : first.thread.id;
    const turnId =
      violation === 'missing turn'
        ? 'tu_00000000-0000-72bf-9b0b-cd9581385489'
        : violation === 'cross-workspace lineage'
          ? second.turn.id
          : null;
    const id =
      family === 'AgentSession'
        ? 'as_00000000-0000-7d39-83f3-8b9ab89088f6'
        : family === 'artifact'
          ? 'ar_00000000-0000-7079-8b12-81b344b6a5e1'
          : 'ks_00000000-0000-7c89-a9fd-b9379d38d369';

    const operation = () => {
      if (family === 'AgentSession') {
        store.createAgentSession({
          id,
          agentId: 'agent_codex_host',
          workspaceId: first.workspace.id,
          threadId,
          status: 'busy',
          message: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        return;
      }
      if (family === 'artifact') {
        const artifactTurnId = turnId ?? first.turn.id;
        store.createArtifact({
          id,
          workspaceId: first.workspace.id,
          threadId,
          turnId: artifactTurnId,
          kind: 'summary',
          title: 'Invalid create lineage',
          status: 'ready',
          summary: null,
          version: 1,
          content: { format: 'text', body: 'This record must not be retained.' },
          contentDigest: artifactDigest('This record must not be retained.'),
          lastMutationRequestId: 'req_ar_invalid_create_lineage_create',
          origin: {
            kind: 'turn-output',
            threadId,
            turnId: artifactTurnId,
            requestId: 'req_ar_invalid_create_lineage_create',
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        return;
      }
      store.createKnowledgeSource({
        id,
        workspaceId: first.workspace.id,
        kind: 'upload',
        title: 'Invalid create lineage',
        uri: null,
        contentDigest: 'sha256:invalid-create-lineage',
        originatingThreadId: threadId,
        originatingTurnId: turnId,
        originatingFileId: null,
        capturedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    };

    expect.soft(operation).toThrow();
    expect.soft(() => store.getAgentSession(id)).toThrow();
    expect
      .soft(store.listArtifacts(first.workspace.id))
      .not.toContainEqual(expect.objectContaining({ id }));
    expect
      .soft(store.listKnowledgeSources(first.workspace.id))
      .not.toContainEqual(expect.objectContaining({ id }));
    expect(() => new FsStore({ dataRoot })).not.toThrow();
  });

  it.each([
    'item',
    'artifact',
    'AgentSession',
  ] as const)('rejects a persisted %s event whose nested payload lineage differs from its envelope', (family) => {
    const { dataRoot, first, second, store } = createBoundaryFixture();
    const timestamp = second.turn.startedAt ?? new Date().toISOString();
    let event: Parameters<FsStore['emitTurnEvent']>[1];

    switch (family) {
      case 'item': {
        const item = store.createItem({
          id: 'it_00000000-0000-78f6-9e01-ea1ec12708fe',
          workspaceId: second.workspace.id,
          threadId: second.thread.id,
          turnId: second.turn.id,
          type: 'assistant-message',
          status: 'completed',
          text: 'This item belongs to the second lineage.',
          createdAt: timestamp,
          completedAt: timestamp,
        });
        event = {
          event: 'item.created',
          workspaceId: first.workspace.id,
          threadId: first.thread.id,
          turnId: first.turn.id,
          data: { type: 'item-created', item },
        };
        break;
      }

      case 'artifact': {
        const artifact = store.createArtifact({
          id: 'ar_00000000-0000-7393-a5cd-4fbe2a969e4c',
          workspaceId: second.workspace.id,
          threadId: second.thread.id,
          turnId: second.turn.id,
          kind: 'summary',
          title: 'Cross-lineage event artifact',
          status: 'ready',
          summary: null,
          version: 1,
          content: { format: 'text', body: 'This artifact belongs elsewhere.' },
          contentDigest: artifactDigest('This artifact belongs elsewhere.'),
          lastMutationRequestId: 'req_ar_cross_lineage_event_create',
          origin: {
            kind: 'turn-output',
            threadId: second.thread.id,
            turnId: second.turn.id,
            requestId: 'req_ar_cross_lineage_event_create',
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        event = {
          event: 'artifact.created',
          workspaceId: first.workspace.id,
          threadId: first.thread.id,
          turnId: first.turn.id,
          data: { type: 'artifact-created', artifact },
        };
        break;
      }

      case 'AgentSession': {
        const agentSession = store.createAgentSession({
          id: 'as_00000000-0000-7fee-91c8-74b960d30b20',
          agentId: 'agent_codex_host',
          workspaceId: second.workspace.id,
          threadId: second.thread.id,
          status: 'busy',
          message: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        event = {
          event: 'agent.session.updated',
          workspaceId: first.workspace.id,
          threadId: first.thread.id,
          turnId: first.turn.id,
          data: { type: 'agent-session-updated', agentSession },
        };
        break;
      }
    }

    expect.soft(() => store.emitTurnEvent(first.turn.id, event)).toThrow();
    expect.soft(store.getTurnEvents(first.turn.id)).toEqual([]);

    const eventLogPath = join(
      first.root,
      'threads',
      first.thread.id,
      'turns',
      first.turn.id,
      'runtime',
      'events.jsonl'
    );
    writeFileSync(
      eventLogPath,
      `${JSON.stringify({
        ...event,
        protocolVersion: PROTOCOL_VERSION,
        requestId: event.requestId ?? null,
        sequence: 1,
        timestamp: new Date().toISOString(),
      })}\n`
    );
    expect.soft(() => new FsStore({ dataRoot })).toThrow();
  });

  it.each([
    'artifact',
    'AgentSession',
  ] as const)('rejects a persisted event that references a missing %s record', (family) => {
    const { dataRoot, first, store } = createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    let event: Parameters<FsStore['emitTurnEvent']>[1];
    let recordRoot: string;

    if (family === 'artifact') {
      const artifact = store.createArtifact({
        id: 'ar_00000000-0000-70b9-84c0-0dc43cac0400',
        workspaceId: first.workspace.id,
        threadId: first.thread.id,
        turnId: first.turn.id,
        kind: 'summary',
        title: 'Missing event artifact',
        status: 'ready',
        summary: null,
        version: 1,
        content: { format: 'text', body: 'Remove the canonical artifact after the event.' },
        contentDigest: artifactDigest('Remove the canonical artifact after the event.'),
        lastMutationRequestId: 'req_ar_missing_event_state_create',
        origin: {
          kind: 'turn-output',
          threadId: first.thread.id,
          turnId: first.turn.id,
          requestId: 'req_ar_missing_event_state_create',
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      event = {
        event: 'artifact.created',
        workspaceId: first.workspace.id,
        threadId: first.thread.id,
        turnId: first.turn.id,
        data: { type: 'artifact-created', artifact },
      };
      recordRoot = join(first.root, 'artifacts', artifact.id);
    } else {
      const agentSession = store.createAgentSession({
        id: 'as_00000000-0000-7a30-87a3-5ec55741b8c7',
        agentId: 'agent_codex_host',
        workspaceId: first.workspace.id,
        threadId: first.thread.id,
        status: 'busy',
        message: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      event = {
        event: 'agent.session.updated',
        workspaceId: first.workspace.id,
        threadId: first.thread.id,
        turnId: first.turn.id,
        data: { type: 'agent-session-updated', agentSession },
      };
      recordRoot = join(first.root, 'runtime', 'agent-sessions', agentSession.id);
    }

    store.emitTurnEvent(first.turn.id, event);
    rmSync(recordRoot, { recursive: true });

    expect(() => new FsStore({ dataRoot })).toThrow(
      family === 'artifact'
        ? /Artifact reference .* has invalid lineage/i
        : /references missing .*state/i
    );
  });

  it.each([
    'turn items',
    'artifact body',
  ] as const)('fails closed when canonical %s are also embedded in metadata JSON', (duplicateAuthority) => {
    const { dataRoot, first, store } = createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();

    if (duplicateAuthority === 'turn items') {
      const item = store.createItem({
        id: 'it_00000000-0000-7456-9649-697d49ec361e',
        workspaceId: first.workspace.id,
        threadId: first.thread.id,
        turnId: first.turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'This item belongs only in items.jsonl.',
        createdAt: timestamp,
        completedAt: timestamp,
      });
      const turnPath = join(
        first.root,
        'threads',
        first.thread.id,
        'turns',
        first.turn.id,
        'turn.json'
      );
      const turnRecord = JSON.parse(readFileSync(turnPath, 'utf8')) as { items?: unknown[] };
      turnRecord.items = [item];
      writeFileSync(turnPath, `${JSON.stringify(turnRecord, null, 2)}\n`);
    } else {
      const artifact = store.createArtifact({
        id: 'ar_00000000-0000-78bf-b0ac-55525ed5cf3c',
        workspaceId: first.workspace.id,
        threadId: first.thread.id,
        turnId: first.turn.id,
        kind: 'summary',
        title: 'Split artifact body',
        status: 'ready',
        summary: null,
        version: 1,
        content: { format: 'markdown', body: '# Canonical body file' },
        contentDigest: artifactDigest('# Canonical body file'),
        lastMutationRequestId: 'req_ar_embedded_body_boundary_create',
        origin: {
          kind: 'turn-output',
          threadId: first.thread.id,
          turnId: first.turn.id,
          requestId: 'req_ar_embedded_body_boundary_create',
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const artifactPath = join(first.root, 'artifacts', artifact.id, 'artifact.json');
      const artifactRecord = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
        content?: { body?: string; format?: string };
      };
      artifactRecord.content = {
        format: artifact.content.format,
        body: '# Embedded duplicate body',
      };
      writeFileSync(artifactPath, `${JSON.stringify(artifactRecord, null, 2)}\n`);
    }

    expect(() => new FsStore({ dataRoot })).toThrow();
  });
});
