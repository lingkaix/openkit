// openkit-test-platform: posix
// The refusal helper preserves raw symbolic-link targets under the POSIX contract.
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ItemSchema, PROTOCOL_VERSION, writeRetainedV1 } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { FsStore } from '../lib/store.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import { ensureLayout } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
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
async function createBoundaryFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-file-record-boundary-'));
  const store = createTestStore({ dataRoot });
  const firstWorkspace = await store.createWorkspace('First boundary workspace');
  const firstThread = await store.createThread(firstWorkspace.id, 'First boundary thread');
  const firstTurn = await store.createTurn(
    firstWorkspace.id,
    firstThread.id,
    'First boundary turn',
    {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    }
  );
  const secondWorkspace = await store.createWorkspace('Second boundary workspace');
  const secondThread = await store.createThread(secondWorkspace.id, 'Second boundary thread');
  const secondTurn = await store.createTurn(
    secondWorkspace.id,
    secondThread.id,
    'Second boundary turn',
    {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    }
  );

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

/** Admits public Source requests with real current authority; the caller cannot choose a Source ID. */
function sourceBoundaryApp(f: Awaited<ReturnType<typeof createBoundaryFixture>>) {
  const coreDb = openCoreDb(f.dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  for (const scope of [f.first, f.second])
    recordWorkspaceOwnerMembership({
      coreDb,
      workspaceId: scope.workspace.id,
      ownerUserId: userId,
    });
  onTestFinished(() => coreDb.sqlite.close());
  return createApp({ coreDb, dataRoot: f.dataRoot, store: f.store });
}

/** Fresh import supplies actual User attribution; no materialized page directory initializes content. */
async function createNotebookBoundaryFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-file-record-notebook-'));
  onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
  const source = new FsStore();
  const workspace = await source.createWorkspace('Notebook boundary workspace');
  const store = createTestStore({ dataRoot });
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

/**
 * Validates one retained fault in a fresh admission lifetime without resetting process state.
 *
 * Copies exact authority, seeds an independent healthy sibling, and checks refusal and preservation.
 * Each copy has a new root identity, so later faults cannot reuse an earlier refusal.
 *
 * @param dataRoot Source fixture containing the injected fault.
 * @param workspaceId Owning Workspace that must be quarantined.
 * @returns Reopened Store and isolated root for additional native readback checks.
 */
async function expectLocalWorkspaceRefusal(dataRoot: string, workspaceId: string) {
  const restartRoot = mkdtempSync(join(tmpdir(), 'openkit-local-refusal-'));
  onTestFinished(() => rmSync(restartRoot, { recursive: true, force: true }));
  const seed = new FsStore({ dataRoot: restartRoot });
  const sibling = await seed.createWorkspace('Healthy refusal control');
  const siblingThread = await seed.createThread(sibling.id, 'Retained sibling thread');
  const siblingBefore = seed.getWorkspace(sibling.id);
  cpSync(dataRoot, restartRoot, { recursive: true, verbatimSymlinks: true });

  /** Records every directory, link target and file byte, including the absence of deleted entries. */
  function snapshot(root: string): Record<string, Buffer | string> {
    const entries: Record<string, Buffer | string> = {};
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const key = join(prefix, entry.name);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          entries[key] = 'directory';
          visit(path, key);
        } else {
          entries[key] = entry.isSymbolicLink() ? `link:${readlinkSync(path)}` : readFileSync(path);
        }
      }
    };
    visit(root);
    return entries;
  }

  const refusedRoot = join(restartRoot, 'workspaces', workspaceId);
  const before = snapshot(refusedRoot);
  const reopened = new FsStore({ dataRoot: restartRoot });
  expect(scopeAdmissionFailures(restartRoot)).toContainEqual(
    expect.objectContaining({ scope: 'workspace', id: workspaceId })
  );
  expect(() => reopened.getWorkspace(workspaceId)).toThrow(
    expect.objectContaining({ code: 'recovery_required' })
  );
  expect(() => reopened.createThread(workspaceId, 'Must remain refused')).toThrow(
    expect.objectContaining({ code: 'recovery_required' })
  );
  expect(reopened.getWorkspace(sibling.id)).toEqual(siblingBefore);
  expect(reopened.getThread(sibling.id, siblingThread.id)).toEqual(siblingThread);
  const progress = await reopened.createThread(sibling.id, 'Healthy sibling progress');
  expect(new FsStore({ dataRoot: restartRoot }).getThread(sibling.id, progress.id)).toEqual(
    progress
  );
  expect(snapshot(refusedRoot)).toEqual(before);
  expect(snapshot(join(dataRoot, 'workspaces', workspaceId))).toEqual(before);
  return { store: reopened, dataRoot: restartRoot };
}

describe('workspace file-record write and load boundaries', () => {
  // Fresh navigation and body-only normalization belong to notebook-initialization.test.ts, under the Notebook owner's Content, Revisions And History section.
  it('preserves the authored Git index during Thread writes without adopting materialized bytes', async () => {
    const f = await createNotebookBoundaryFixture();
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
    await f.store.createThread(f.workspace.id, 'Do not adopt the materialized index');

    expect(f.notebook.publishedRevision()).toBe(revision);
    expect(f.notebook.readRevision(revision).files['index.md']).toBe(authored);
    expect(readFileSync(indexPath, 'utf8')).toBe(materialized);
    const reopened = new FsStore({ dataRoot: f.dataRoot });
    expect(reopened.listThreads(f.workspace.id)).toEqual(f.store.listThreads(f.workspace.id));
    expect(f.notebook.publishedRevision()).toBe(revision);
    expect(readFileSync(indexPath, 'utf8')).toBe(materialized);

    rmSync(indexPath);
    await reopened.createThread(f.workspace.id, 'Do not recreate a materialized index');
    expect(existsSync(indexPath)).toBe(false);
    expect(f.notebook.publishedRevision()).toBe(revision);
    expect(f.notebook.readRevision(revision).files['index.md']).toBe(authored);
  });

  it('does not repair corrupt published Git from materialized pages during Thread writes', async () => {
    const f = await createNotebookBoundaryFixture();
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
    await expectLocalWorkspaceRefusal(f.dataRoot, f.workspace.id);
    expect(readFileSync(publishedPath, 'utf8')).toBe(corruptRef);
    expect(readFileSync(indexPath, 'utf8')).toBe(authored);
  });

  it.each([
    '---\nokf_version: ["0.2"]\n---\n# Invalid scalar\n',
    '---\nokf_version: "0.1"\n---\n# Conflicting version\n',
    '---\nokf_version: "0.2"\n# Unclosed frontmatter\n',
  ])('rejects an invalid initial root index before publishing the Workspace', async (content) => {
    const f = await createNotebookBoundaryFixture();
    const originalWorkspaces = f.store.listWorkspaces();
    const files = { 'index.md': content };

    expect(() => f.initialize(files)).toThrow('Notebook invalid request.');
    expect(files['index.md']).toBe(content);
    expect(existsSync(f.workspaceRoot)).toBe(false);
    expect(f.store.listWorkspaces()).toEqual(originalWorkspaces);
    expect(new FsStore({ dataRoot: f.dataRoot }).listWorkspaces()).toEqual(originalWorkspaces);
  });
  it('does not fall back to owner-nested workspace records when the canonical root is absent', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-file-record-no-fallback-'));
    const seedStore = createTestStore({ dataRoot });
    const workspace = await seedStore.createWorkspace('Legacy nested workspace');
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
  ] as const)('rejects a cross-workspace duplicate %s id without replacing its owner', async (family) => {
    const f = await createBoundaryFixture();
    const { first, second, store } = f;
    const firstTimestamp = first.turn.startedAt ?? new Date().toISOString();
    const secondTimestamp = second.turn.startedAt ?? new Date().toISOString();

    switch (family) {
      case 'AgentSession': {
        const id = 'as_00000000-0000-7b0f-96e7-3f6551c1efa7';
        const original = await store.createAgentSession({
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
        const app = sourceBoundaryApp(f);
        const originalMaterial = 'The first workspace owns this source material.';
        const created = await app.request(
          ...operationRequest(
            'knowledge.source.register',
            { workspaceId: first.workspace.id },
            {
              body: JSON.stringify({
                requestId: randomUUID(),
                kind: 'upload',
                title: 'Original source',
                content: originalMaterial,
                originatingThreadId: first.thread.id,
                originatingTurnId: first.turn.id,
              }),
            }
          )
        );
        expect(created.status, await created.clone().text()).toBe(200);
        const { source: original } = await created.json();
        const attempted = await app.request(
          ...operationRequest(
            'knowledge.source.register',
            { workspaceId: second.workspace.id },
            {
              body: JSON.stringify({
                id: original.id,
                requestId: randomUUID(),
                kind: 'upload',
                title: 'Replacement source',
                content: 'The second workspace must not replace this material.',
                originatingThreadId: second.thread.id,
                originatingTurnId: second.turn.id,
              }),
            }
          )
        );
        expect(attempted.status).toBe(400);
        expect(store.listKnowledgeSources(first.workspace.id)).toEqual([original]);
        expect(store.listKnowledgeSources(second.workspace.id)).toEqual([]);
        expect(
          readFileSync(
            join(first.root, 'knowledge', 'raw', 'sources', original.id, 'original'),
            'utf8'
          )
        ).toBe(originalMaterial);
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
  ] as const)('rejects an item revision that changes or violates %s', async (violation) => {
    const { dataRoot, first, second, store } = await createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const original = await store.createItem({
      id: 'it_00000000-0000-7c6d-b3b1-e8c48c8b327a',
      owner: { kind: 'workspace', workspaceId: first.workspace.id },
      threadId: first.thread.id,
      turnId: first.turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'The original item is immutable.',
      createdAt: timestamp,
      completedAt: timestamp,
    });

    const operation = async () => {
      switch (violation) {
        case 'id':
          await store.updateItem(original.id, {
            id: 'it_00000000-0000-75cc-9039-96ddac89d51f',
          } as never);
          break;
        case 'type':
          await store.createItem({
            id: original.id,
            owner: { kind: 'workspace', workspaceId: first.workspace.id },
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
          await store.updateItem(original.id, { workspaceId: second.workspace.id } as never);
          break;
        case 'threadId':
          await store.updateItem(original.id, { threadId: second.thread.id } as never);
          break;
        case 'turnId':
          await store.updateItem(original.id, { turnId: second.turn.id } as never);
          break;
        case 'createdAt':
          await store.updateItem(original.id, { createdAt: '2030-01-01T00:00:00.000Z' });
          break;
        case 'invalid create schema':
          await store.createItem({
            ...original,
            id: 'it_00000000-0000-7c32-92fd-418f5c9c8e1c',
            status: 'not-an-item-status',
          } as never);
          break;
        case 'invalid update schema':
          await store.updateItem(original.id, { status: 'not-an-item-status' } as never);
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
  ])('rejects a valid item revision that changes immutable $name', async ({
    original,
    changed,
    currentResponsibleUserId,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-item-attribution-boundary-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Item attribution boundary');
    const thread = await store.createThread(workspace.id, 'Item attribution boundary');
    const triggerActor = { kind: 'user', id: currentResponsibleUserId } as const;
    const turn = await store.createTurn(
      workspace.id,
      thread.id,
      'Protect immutable item attribution',
      triggerActor
    );
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const item = ItemSchema.parse({
      id: 'it_00000000-0000-7fc4-aae8-dd5cf69e5992',
      owner: { kind: 'workspace', workspaceId: workspace.id },
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
            owner: { kind: 'workspace', workspaceId: workspace.id },
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
      `${supportingRequest ? `${JSON.stringify(writeRetainedV1(supportingRequest))}\n` : ''}${JSON.stringify(writeRetainedV1(item))}\n${JSON.stringify(writeRetainedV1(changedItem))}\n`
    );
    await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
  });

  it('rejects a foreign-user response when reloading canonical Turn items', async () => {
    const { dataRoot, first, store } = await createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const request = await store.createItem({
      id: 'it_00000000-0000-77d0-8f57-fa3818abb424',
      owner: { kind: 'workspace', workspaceId: first.workspace.id },
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
      owner: { kind: 'workspace', workspaceId: first.workspace.id },
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
      `${JSON.stringify(writeRetainedV1(response))}\n`
    );

    await expectLocalWorkspaceRefusal(dataRoot, first.workspace.id);
  });

  it('leaves item read models unchanged when the canonical append fails', async () => {
    const { first, store } = await createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const original = await store.createItem({
      id: 'it_00000000-0000-72d9-a1ba-fc94cc09ebec',
      owner: { kind: 'workspace', workspaceId: first.workspace.id },
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
  ] as const)('rejects a turn update that changes immutable %s without altering memory or reload', async (field) => {
    const { dataRoot, first, second, store } = await createBoundaryFixture();
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
  ] as const)('rejects an AgentSession update that changes immutable %s without altering memory or reload', async (field) => {
    const { dataRoot, first, second, store } = await createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const session = await store.createAgentSession({
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

  it('rejects a second current AgentSession for the same Thread without a projection', async () => {
    const { dataRoot, first, store } = await createBoundaryFixture();
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

  it('creates a successor AgentSession after the predecessor becomes terminal', async () => {
    const { first, store } = await createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const predecessor = await store.createAgentSession({
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

  it('does not reopen a terminal AgentSession', async () => {
    const { dataRoot, first, store } = await createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    const session = await store.createAgentSession({
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
  ] as const)('rejects a new %s with %s before mutation', async (family, violation) => {
    const f = await createBoundaryFixture();
    const { dataRoot, first, second, store } = f;
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

    const operation = async () => {
      if (family === 'AgentSession') {
        await store.createAgentSession({
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
        await store.createArtifact({
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
      const app = sourceBoundaryApp(f);
      return app.request(
        ...operationRequest(
          'knowledge.source.register',
          { workspaceId: first.workspace.id },
          {
            body: JSON.stringify({
              requestId: randomUUID(),
              kind: 'upload',
              title: 'Invalid create lineage',
              content: 'This record must not be retained.',
              originatingThreadId: threadId,
              ...(turnId ? { originatingTurnId: turnId } : {}),
            }),
          }
        )
      );
    };

    if (family === 'knowledge source') {
      const response = await operation();
      expect(response?.status).toBe(violation === 'missing turn' ? 404 : 403);
      expect(store.listKnowledgeSources(first.workspace.id)).toEqual([]);
      expect(existsSync(join(first.root, 'knowledge', 'raw', 'sources'))).toBe(false);
    } else expect.soft(operation).toThrow();
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
  ] as const)('rejects a persisted %s event whose nested payload lineage differs from its envelope', async (family) => {
    const { dataRoot, first, second, store } = await createBoundaryFixture();
    const timestamp = second.turn.startedAt ?? new Date().toISOString();
    let event: Parameters<FsStore['emitTurnEvent']>[1];
    let ownRecordPath: string;
    let readSecond: (candidate: FsStore) => unknown;

    switch (family) {
      case 'item': {
        const item = store.createItem({
          id: 'it_00000000-0000-78f6-9e01-ea1ec12708fe',
          owner: { kind: 'workspace', workspaceId: second.workspace.id },
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
          data: { type: 'item-created', item: { ...item, text: 'Non-owning foreign snapshot.' } },
        };
        ownRecordPath = join(
          second.root,
          'threads',
          second.thread.id,
          'turns',
          second.turn.id,
          'items.jsonl'
        );
        readSecond = (candidate) =>
          candidate.listThreadItems(second.workspace.id, second.thread.id);
        break;
      }

      case 'artifact': {
        const artifact = await store.createArtifact({
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
          data: {
            type: 'artifact-created',
            artifact: { ...artifact, title: 'Non-owning foreign snapshot' },
          },
        };
        ownRecordPath = join(second.root, 'artifacts', artifact.id, 'artifact.json');
        readSecond = (candidate) => candidate.getArtifact(second.workspace.id, artifact.id);
        break;
      }

      case 'AgentSession': {
        const agentSession = await store.createAgentSession({
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
          data: {
            type: 'agent-session-updated',
            agentSession: { ...agentSession, message: 'Non-owning foreign snapshot.' },
          },
        };
        ownRecordPath = join(
          second.root,
          'runtime',
          'agent-sessions',
          agentSession.id,
          'session.json'
        );
        readSecond = (candidate) => candidate.getAgentSession(agentSession.id);
        break;
      }
    }

    const ownBytes = readFileSync(ownRecordPath);
    const expectedSecond = readSecond(store);
    expect(readSecond(new FsStore({ dataRoot }))).toEqual(expectedSecond);
    expect(relative(second.root, ownRecordPath)).not.toMatch(/^\.\./);
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
      `${JSON.stringify(
        writeRetainedV1({
          ...event,
          protocolVersion: PROTOCOL_VERSION,
          requestId: event.requestId ?? null,
          sequence: 1,
          timestamp: new Date().toISOString(),
        })
      )}\n`
    );
    const refused = await expectLocalWorkspaceRefusal(dataRoot, first.workspace.id);
    expect(readSecond(refused.store)).toEqual(expectedSecond);
    expect(readFileSync(join(refused.dataRoot, relative(dataRoot, ownRecordPath)))).toEqual(
      ownBytes
    );
    const progress = await refused.store.createThread(
      second.workspace.id,
      'Second owner remains writable'
    );
    const reopened = new FsStore({ dataRoot: refused.dataRoot });
    expect(reopened.getThread(second.workspace.id, progress.id)).toEqual(progress);
    expect(readSecond(reopened)).toEqual(expectedSecond);
    expect(readFileSync(join(refused.dataRoot, relative(dataRoot, ownRecordPath)))).toEqual(
      ownBytes
    );
    expect(readFileSync(join(refused.dataRoot, relative(dataRoot, eventLogPath)))).toEqual(
      readFileSync(eventLogPath)
    );
  });

  it.each([
    'artifact',
    'AgentSession',
  ] as const)('rejects a persisted event that references a missing %s record', async (family) => {
    const { dataRoot, first, store } = await createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();
    let event: Parameters<FsStore['emitTurnEvent']>[1];
    let recordRoot: string;

    if (family === 'artifact') {
      const artifact = await store.createArtifact({
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
      const agentSession = await store.createAgentSession({
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

    const refused = await expectLocalWorkspaceRefusal(dataRoot, first.workspace.id);
    expect(existsSync(recordRoot)).toBe(false);
    expect(existsSync(join(refused.dataRoot, relative(dataRoot, recordRoot)))).toBe(false);
  });

  it.each([
    'turn items',
    'artifact body',
  ] as const)('fails closed when canonical %s are also embedded in metadata JSON', async (duplicateAuthority) => {
    const { dataRoot, first, store } = await createBoundaryFixture();
    const timestamp = first.turn.startedAt ?? new Date().toISOString();

    if (duplicateAuthority === 'turn items') {
      const item = store.createItem({
        id: 'it_00000000-0000-7456-9649-697d49ec361e',
        owner: { kind: 'workspace', workspaceId: first.workspace.id },
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
      const artifact = await store.createArtifact({
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

    await expectLocalWorkspaceRefusal(dataRoot, first.workspace.id);
  });
});
