// openkit-test-platform: posix
// The refusal helper preserves raw symbolic-link targets under the POSIX contract.
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveEntityId, formatReferenceUri } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';
import { scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { updateOkfFrontmatter } from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestStore } from '../test-support/store.js';
import { captureWorkspaceSourceFixture } from '../test-support/workspace-source.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { publishImmutableProductJson, readImmutableProductJson } from './immutable-content.js';
import { applyMigrations } from './migrate.js';
import {
  loadWorkspaceFileRecords,
  nativeProductScope,
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
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    return rmSync(restartRoot, { recursive: true, force: true });
  });
  const seed = createTestStore({ dataRoot: restartRoot });
  const sibling = await seed.createWorkspace('Healthy refusal control');
  const siblingThread = await seed.createThread(sibling.id, 'Retained sibling thread');
  const siblingBefore = seed.getWorkspace(sibling.id);
  // Exclude the live native writer before copying its SQLite authority.
  await shutdownControlStoreWorkerClient();
  cpSync(dataRoot, restartRoot, { recursive: true, verbatimSymlinks: true });

  /** Preserves raw native SQL schema/values and exact other bytes; WAL/SHM are bookkeeping. */
  function snapshot(root: string): Record<string, Buffer | string> {
    const entries: Record<string, Buffer | string> = {};
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const key = join(prefix, entry.name);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          entries[key] = 'directory';
          visit(path, key);
        } else if (entry.isSymbolicLink()) {
          entries[key] = `link:${readlinkSync(path)}`;
        } else if (key === join('db', 'workspace.sqlite')) {
          const sqlite = new Database(path, { readonly: true, fileMustExist: true });
          try {
            entries[key] = sqlite.transaction(() => {
              const schema = sqlite
                .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
                .all();
              const tables = sqlite
                .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
                .all() as { name: string }[];
              const rows = tables.map(({ name }) => [
                name,
                sqlite
                  .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
                  .raw(true)
                  .safeIntegers(true)
                  .all()
                  .map((row) =>
                    JSON.stringify(row, (_key, value) =>
                      typeof value === 'bigint' ? { integer: value.toString() } : value
                    )
                  )
                  .sort(),
              ]);
              return Buffer.from(JSON.stringify({ schema, rows }));
            })();
          } finally {
            sqlite.close();
          }
        } else if (
          key !== join('db', 'workspace.sqlite-wal') &&
          key !== join('db', 'workspace.sqlite-shm')
        ) {
          entries[key] = readFileSync(path);
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
  await expect(reopened.createThread(workspaceId, 'Must remain refused')).rejects.toThrow(
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

describe('descriptive canonical history extensions', () => {
  it('preserves immutable Proposal bytes, ordered Review annotations and Source history on rewrite', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-knowledge-history-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Knowledge');
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId: workspace.id });
    onTestFinished(async () => {
      coreDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
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
    const sourceBytes = serializeKnowledgePageFixture(
      {
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
    const refused = await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
    expect(
      loadWorkspaceFileRecords(refused.dataRoot).map(({ workspace }) => workspace.id)
    ).not.toContain(workspace.id);
  });
  it('reads, updates and reopens Workspace, Actor, Item, Artifact and AgentSession history', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-history-extensions-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('History');
    const thread = await store.createThread(workspace.id, 'History');
    const turn = await store.createTurn(workspace.id, thread.id, 'Request', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
    await store.createItem({
      id: 'it_00000000-0000-7107-a6b6-12de9088d8ca',
      owner: { kind: 'workspace', workspaceId: workspace.id },
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
    await store.createAgentSession({
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
    const artifactPath = join(
      root,
      'artifacts',
      'ar_00000000-0000-780c-b09d-92983bad1f5b',
      'artifact.json'
    );
    const sessionId = 'as_00000000-0000-74db-9692-cadae15b58fb';
    const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId: workspace.id });
    /** Reads original native source JSON; the public view must not forward its annotations. */
    function metadata(
      table: 'control_workspaces' | 'control_turns' | 'control_agent_sessions',
      id: string
    ) {
      const db = openWorkspaceDb(dataRoot, workspace.id);
      try {
        return (
          db.sqlite.prepare(`SELECT record_json FROM ${table} WHERE id=?`).get(id) as {
            record_json: string;
          }
        ).record_json;
      } finally {
        db.sqlite.close();
      }
    }
    /** Injects descriptive retained metadata without publishing another authority. */
    function annotateMetadata(
      table: 'control_workspaces' | 'control_turns' | 'control_agent_sessions',
      id: string,
      nested: readonly string[] = []
    ) {
      const raw = JSON.parse(metadata(table, id));
      let target = raw;
      for (const key of nested) target = target[key];
      target.futureNote = 'retained';
      const db = openWorkspaceDb(dataRoot, workspace.id);
      try {
        db.sqlite
          .prepare(`UPDATE ${table} SET record_json=? WHERE id=?`)
          .run(JSON.stringify(raw), id);
      } finally {
        db.sqlite.close();
      }
    }
    const item = store.listThreadItems(workspace.id, thread.id)[0]!;
    const snapshots = [
      { event: 'workspace.updated', data: { type: 'workspace-updated', workspace } },
      { event: 'turn.updated', data: { type: 'turn-updated', turn: store.getTurnById(turn.id) } },
      { event: 'item.created', data: { type: 'item-created', item } },
    ];
    for (const snapshot of snapshots) {
      const envelope = await store.persistTurnEvent(turn.id, {
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        ...snapshot,
      } as Parameters<FsStore['persistTurnEvent']>[1]);
      store.emitTurnEvent(turn.id, envelope);
    }
    await shutdownControlStoreWorkerClient();
    for (const [table, id, nested] of [
      ['control_workspaces', workspace.id, []],
      ['control_turns', turn.id, []],
      ['control_turns', turn.id, ['triggerActor']],
      ['control_agent_sessions', sessionId, []],
      ['control_agent_sessions', sessionId, ['sandboxSummary']],
      ['control_agent_sessions', sessionId, ['retainedStorage']],
      ['control_agent_sessions', sessionId, ['workspaceRoots', '0']],
      ['control_agent_sessions', sessionId, ['workspaceRoots', '1']],
    ] as const)
      annotateMetadata(table, id, nested);
    for (const nested of [[], ['origin'], ['origin', 'actor'], ['content']] as const)
      annotate(artifactPath, nested);
    const db = openWorkspaceDb(dataRoot, workspace.id);
    try {
      const rows = db.sqlite
        .prepare(
          'SELECT kind,sequence,content_json FROM control_product_entries WHERE turn_id=? ORDER BY kind,sequence'
        )
        .all(turn.id) as Array<{ kind: 'item' | 'event'; sequence: number; content_json: string }>;
      for (const row of rows) {
        const value = readImmutableProductJson(
          scope.contentMount,
          scope.owner,
          JSON.parse(row.content_json)
        ) as Record<string, unknown>;
        value.futureNote = 'retained';
        if (row.kind === 'item') (value.actor as Record<string, unknown>).futureNote = 'retained';
        else {
          const data = value.data as Record<string, unknown>;
          data.futureNote = 'retained';
          const snapshot = (data.workspace ?? data.turn ?? data.item) as Record<string, unknown>;
          snapshot.futureNote = 'retained';
          if (snapshot.triggerActor) {
            (snapshot.triggerActor as Record<string, unknown>).futureNote = 'retained';
            for (const nested of snapshot.items as Array<{ actor: Record<string, unknown> }>)
              nested.actor.futureNote = 'retained';
          }
          if (snapshot.actor) (snapshot.actor as Record<string, unknown>).futureNote = 'retained';
          // A field owned by another event variant remains descriptive here.
          if (row.sequence === 1) data.turn = { futureNote: 'retained' };
        }
        const content = await publishImmutableProductJson(
          scope.contentMount,
          scope.owner,
          join(root, 'runtime', 'staging'),
          value
        );
        // Explicit retained-fixture annotation: new immutable bytes precede its SQL reference.
        db.sqlite
          .prepare(
            'UPDATE control_product_entries SET content_json=? WHERE turn_id=? AND kind=? AND sequence=?'
          )
          .run(JSON.stringify(content), turn.id, row.kind, row.sequence);
      }
    } finally {
      db.sqlite.close();
    }
    const retained = openWorkspaceDb(dataRoot, workspace.id);
    const entriesBefore = retained.sqlite
      .prepare('SELECT * FROM control_product_entries WHERE turn_id=? ORDER BY kind,sequence')
      .all(turn.id);
    retained.sqlite.close();
    const loaded = loadWorkspaceFileRecords(dataRoot).find(
      (entry) => entry.workspace.id === workspace.id
    )!;
    expect(JSON.stringify(loaded)).not.toContain('futureNote');
    const reopenedStore = new FsStore({ dataRoot });
    await reopenedStore.updateWorkspace(workspace.id, { status: 'archived' });
    const reopened = loadWorkspaceFileRecords(dataRoot).find(
      (entry) => entry.workspace.id === workspace.id
    )!;
    expect(reopened.workspace.status).toBe('archived');
    expect(JSON.stringify(reopened)).not.toContain('futureNote');
    expect(metadata('control_workspaces', workspace.id)).toContain('futureNote');
    expect(metadata('control_turns', turn.id)).toContain('futureNote');
    expect(metadata('control_agent_sessions', sessionId)).toContain('futureNote');
    expect(readFileSync(artifactPath, 'utf8')).toContain('futureNote');
    await shutdownControlStoreWorkerClient();
    const preserved = openWorkspaceDb(dataRoot, workspace.id);
    try {
      expect(
        preserved.sqlite
          .prepare('SELECT * FROM control_product_entries WHERE turn_id=? ORDER BY kind,sequence')
          .all(turn.id)
      ).toEqual(entriesBefore);
      const damaged = JSON.parse(metadata('control_agent_sessions', sessionId));
      damaged.status = 'future';
      preserved.sqlite
        .prepare('UPDATE control_agent_sessions SET record_json=? WHERE id=?')
        .run(JSON.stringify(damaged), sessionId);
    } finally {
      preserved.sqlite.close();
    }
    const refused = await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
    expect(
      loadWorkspaceFileRecords(refused.dataRoot).map(({ workspace }) => workspace.id)
    ).not.toContain(workspace.id);
  });
});

describe('retained Item Actor annotations on native revision', () => {
  it('accepts an unchanged human identity and still refuses a different actor id', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-item-actor-revision-'));
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Actor revision');
    const thread = await store.createThread(workspace.id, 'Actor revision');
    const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
    const turn = await store.createTurn(workspace.id, thread.id, 'Retained request', actor);
    const item = await store.createItem({
      id: 'it_00000000-0000-7107-a6b6-12de9088d8cb',
      owner: { kind: 'workspace', workspaceId: workspace.id },
      threadId: thread.id,
      turnId: turn.id,
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt!,
      type: 'user-message',
      actor,
      text: 'Original request body',
      status: 'completed',
    });
    await shutdownControlStoreWorkerClient();
    const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId: workspace.id });
    const entries = () => {
      const db = new Database(scope.path, { fileMustExist: true, readonly: true });
      try {
        return (
          db
            .prepare(
              "SELECT * FROM control_product_entries WHERE turn_id=? AND kind='item' ORDER BY sequence"
            )
            .all(turn.id) as Array<{ sequence: number; content_json: string }>
        ).map((row) => {
          const content = JSON.parse(row.content_json);
          return {
            row,
            bytes: readFileSync(join(scope.contentMount.root, content.reference.locator.path)),
            value: readImmutableProductJson(scope.contentMount, scope.owner, content) as Record<
              string,
              unknown
            >,
          };
        });
      } finally {
        db.close();
      }
    };
    const original = entries();
    expect(original).toHaveLength(1);
    const annotated = {
      ...original[0]!.value,
      actor: { ...actor, futureNote: 'retained source annotation' },
    };
    const content = await publishImmutableProductJson(
      scope.contentMount,
      scope.owner,
      join(dataRoot, 'workspaces', workspace.id, 'runtime', 'staging'),
      annotated
    );
    // Seed trusted retained data with new immutable bytes before its stopped SQL reference.
    const fixtureDb = openWorkspaceDb(dataRoot, workspace.id);
    try {
      expect(
        fixtureDb.sqlite
          .prepare(
            "UPDATE control_product_entries SET content_json=? WHERE turn_id=? AND kind='item' AND sequence=?"
          )
          .run(JSON.stringify(content), turn.id, original[0]!.row.sequence).changes
      ).toBe(1);
    } finally {
      fixtureDb.sqlite.close();
    }
    const retained = entries();
    expect(retained[0]!.value.actor).toEqual({
      ...actor,
      futureNote: 'retained source annotation',
    });
    const reopened = new FsStore({ dataRoot });
    expect(reopened.getTurnById(turn.id).items).toEqual([item]);
    expect(JSON.stringify(reopened.getTurnById(turn.id))).not.toContain('futureNote');
    await expect(
      reopened.updateItem(item.id, { text: 'Revised request body' })
    ).resolves.toMatchObject({
      id: item.id,
      actor,
      text: 'Revised request body',
    });
    await shutdownControlStoreWorkerClient();
    const revised = entries();
    expect(revised).toHaveLength(2);
    expect(revised.slice(0, retained.length)).toEqual(retained);
    expect(
      readFileSync(
        join(
          scope.contentMount.root,
          JSON.parse(original[0]!.row.content_json).reference.locator.path
        )
      )
    ).toEqual(original[0]!.bytes);
    const latest = new FsStore({ dataRoot });
    expect(latest.getTurnById(turn.id).items).toEqual([{ ...item, text: 'Revised request body' }]);
    expect(JSON.stringify(latest.getTurnById(turn.id))).not.toContain('futureNote');
    const filesBeforeRefusal = readdirSync(scope.contentMount.root, { recursive: true }).sort();
    await expect(
      latest.updateItem(item.id, {
        actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000002' },
      })
    ).rejects.toThrow(`Item attribution cannot change: ${item.id}.`);
    await shutdownControlStoreWorkerClient();
    expect(entries()).toEqual(revised);
    expect(readdirSync(scope.contentMount.root, { recursive: true }).sort()).toEqual(
      filesBeforeRefusal
    );
    expect(new FsStore({ dataRoot }).getTurnById(turn.id).items).toEqual([
      { ...item, text: 'Revised request body' },
    ]);
  });
});
