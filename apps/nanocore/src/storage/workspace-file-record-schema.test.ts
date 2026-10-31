// openkit-test-platform: posix
// The refusal helper preserves raw symbolic-link targets under the POSIX contract.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';
import { scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { readWorkspaceNotebookSelection } from '../knowledge/notebook-workspace-selection.js';
import { parseOkfDocument, updateOkfFrontmatter } from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  createFixture,
  decide,
  replaceRetainedProposalReviews,
  retainedProposalState,
} from '../test-support/knowledge-proposal-authority.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestStore } from '../test-support/store.js';
import { captureWorkspaceSourceFixture } from '../test-support/workspace-source.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  prepareWorkspaceKnowledgeSelection,
  readControlKnowledgeProposal,
} from './control-store-knowledge.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';

const TIMESTAMP = '2026-07-12T00:00:00.000Z';
const PROPOSAL_REQUEST_ID = '00000000-0000-4000-8000-000000000117';
const VERIFIED_EXTERNAL_REFERENCE = `turn:${testEntityId('tu', 'canonical-record-fixture')}`;

/**
 * Creates one strict immutable Proposal for canonical corruption tests.
 *
 * @param store Scoped retained authority under test.
 * @param workspaceId Workspace that owns the Proposal.
 * @returns Persisted Proposal record.
 */
async function createStrictKnowledgeProposal(store: FsStore, workspaceId: string) {
  const canonicalPageBytes = [
    '---',
    'type: "KnowledgePage"',
    'title: "Canonical proposal"',
    'schema_version: "openkit-scope-knowledge-schema-v4"',
    'openkit_status: "active"',
    'status: "stable"',
    `scope: {kind: workspace, workspaceId: ${workspaceId}}`,
    'requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]',
    'openkit_entry_id: "canonical-proposal"',
    `source_refs: ${JSON.stringify([VERIFIED_EXTERNAL_REFERENCE])}`,
    'review_state: "accepted"',
    'sensitivity: "normal"',
    'freshness: "current"',
    `created_at: "${TIMESTAMP}"`,
    `updated_at: "${TIMESTAMP}"`,
    '---',
    'Canonical proposal bytes.',
    '',
  ].join('\n');

  const dataRoot = store.getDataRoot()!;
  const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  const selection = readWorkspaceNotebookSelection({
    workspaceDb,
    workspaceRoot,
    knowledgeBaseId: readDefaultKnowledgeBaseId({
      dataRoot,
      scope: { kind: 'workspace', workspaceId },
    }),
  });
  workspaceDb.sqlite.close();
  const proposal = await store.createKnowledgeProposal({
    workspaceId,
    requestId: PROPOSAL_REQUEST_ID,
    baseRevision: selection.head.notebookCommit,
    knowledgePageId: 'canonical-proposal',
    canonicalPageBytes,
    contentDigest: `sha256:${createHash('sha256').update(canonicalPageBytes).digest('hex')}`,
    sourceReferences: [VERIFIED_EXTERNAL_REFERENCE],
    rationale: 'Exercise canonical Proposal loading.',
    confidence: 1,
    verifiedExternalReferences: [VERIFIED_EXTERNAL_REFERENCE],
    producer: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    createdAt: TIMESTAMP,
  });
  const retainedDb = openWorkspaceDb(dataRoot, workspaceId);
  try {
    const retained = readControlKnowledgeProposal(retainedDb, proposal.id);
    if (!retained) throw new Error('Strict Proposal fixture was not retained.');
    return {
      proposal,
      path: join(
        dataRoot,
        'workspaces',
        workspaceId,
        'knowledge',
        'content',
        retained.proposal.documentContent.reference.locator.path
      ),
    };
  } finally {
    retainedDb.sqlite.close();
  }
}

/**
 * Rebinds one immutable Proposal descriptor to independently authored retained bytes.
 *
 * The fixture preserves the production digest-derived path and SQL descriptor invariant instead
 * of mutating bytes behind an already retained immutable reference.
 */
function replaceRetainedProposalDocument(input: {
  content: string;
  dataRoot: string;
  path: string;
  proposalId: string;
  workspaceId: string;
}): string {
  const bytes = Buffer.from(input.content, 'utf8');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const relativePath = `sha256/${digest.slice('sha256:'.length)}`;
  const replacementPath = join(dirname(input.path), digest.slice('sha256:'.length));
  writeFileSync(replacementPath, bytes, { flag: 'wx', mode: 0o444 });

  const workspaceDb = openWorkspaceDb(input.dataRoot, input.workspaceId);
  try {
    const row = workspaceDb.sqlite
      .prepare('SELECT record_json FROM knowledge_notebook_proposals WHERE proposal_id = ?')
      .get(input.proposalId) as { record_json: string } | undefined;
    if (!row) throw new Error('Strict Proposal fixture metadata was not retained.');
    const record = JSON.parse(row.record_json) as {
      documentContent: {
        byteLength: number;
        reference: { contentDigest: string; locator: { path: string } };
      };
    };
    record.documentContent.byteLength = bytes.byteLength;
    record.documentContent.reference.contentDigest = digest;
    record.documentContent.reference.locator.path = relativePath;
    const result = workspaceDb.sqlite
      .prepare('UPDATE knowledge_notebook_proposals SET record_json = ? WHERE proposal_id = ?')
      .run(JSON.stringify(record), input.proposalId);
    if (result.changes !== 1) throw new Error('Strict Proposal fixture metadata was not replaced.');
  } finally {
    workspaceDb.sqlite.close();
  }
  return replacementPath;
}

/**
 * Creates one native Workspace lineage for canonical record validation tests.
 *
 * @returns Store, data root, workspace, thread, turn, and workspace root.
 */
async function createCanonicalRecordFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-canonical-record-schema-'));
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Canonical record schema workspace');
  const thread = await store.createThread(workspace.id, 'Canonical record schema thread');
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    'Validate canonical record schemas',
    {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    }
  );

  return {
    dataRoot,
    store,
    workspace,
    thread,
    turn,
    workspaceRoot: join(dataRoot, 'workspaces', workspace.id),
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

describe('workspace canonical record schemas', () => {
  it('reloads native proposal metadata without changing its canonical bytes', async () => {
    const { dataRoot, store, workspace } = await createCanonicalRecordFixture();
    const { proposal, path } = await createStrictKnowledgeProposal(store, workspace.id);
    const content = readFileSync(path, 'utf8');

    const restarted = new FsStore({ dataRoot });
    await restarted.createThread(workspace.id, 'Persist native proposal metadata');

    expect(restarted.getKnowledgeProposal(proposal.id)).toEqual(proposal);
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('rejects a knowledge proposal missing its required created_at field', async () => {
    const { dataRoot, store, workspace } = await createCanonicalRecordFixture();
    const { path } = await createStrictKnowledgeProposal(store, workspace.id);

    chmodSync(path, 0o600);
    try {
      writeFileSync(path, readFileSync(path, 'utf8').replace(`created_at: "${TIMESTAMP}"\n`, ''));
    } finally {
      chmodSync(path, 0o444);
    }

    await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
  });

  it('ignores an embedded Proposal status while preserving its source bytes', async () => {
    const { dataRoot, store, workspace } = await createCanonicalRecordFixture();
    const { proposal, path } = await createStrictKnowledgeProposal(store, workspace.id);
    const content = readFileSync(path, 'utf8');

    const extended = content.replace(
      'review_required: true',
      'review_required: true\nstatus: "accepted"'
    );
    const extendedPath = replaceRetainedProposalDocument({
      content: extended,
      dataRoot,
      path,
      proposalId: proposal.id,
      workspaceId: workspace.id,
    });

    const reopened = new FsStore({ dataRoot });
    expect(reopened.getKnowledgeProposal(proposal.id)).toEqual(proposal);
    expect(reopened.getKnowledgeProposal(proposal.id)).not.toHaveProperty('status');
    await reopened.createThread(workspace.id, 'Preserve ignored status');
    expect(readFileSync(extendedPath, 'utf8')).toBe(extended);
  });

  it('rejects a knowledge proposal review with invalid persisted fields', async () => {
    const f = await createFixture('canonical-invalid-review');
    await decide(f, 'rejected', 'canonical-invalid-review-decision');
    const decisions = JSON.parse(retainedProposalState(f, f.proposal.id).reviewsJson) as Array<
      Record<string, unknown>
    >;
    decisions[0]!.decision = 'not-a-review-decision';
    decisions[0]!.decidedAt = 'not-a-timestamp';
    replaceRetainedProposalReviews(f, f.proposal.id, JSON.stringify(decisions));

    await expectLocalWorkspaceRefusal(f.dataRoot, f.workspaceId);
  });

  it.each([
    'invalid kind',
    'missing capturedAt',
    'null original digest',
    'foreign scope',
  ])('rejects a knowledge source with %s', async (violation) => {
    const { dataRoot, store, workspace, workspaceRoot } = await createCanonicalRecordFixture();
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    onTestFinished(() => coreDb.sqlite.close());
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    const content = 'Original schema fixture evidence.';
    const source = await captureWorkspaceSourceFixture({
      dataRoot,
      store,
      coreDb,
      userId,
      content,
      source: {
        id: 'ks_00000000-0000-7f61-8145-5542ffc8eec0',
        workspaceId: workspace.id,
        kind: 'upload',
        title: 'Invalid source schema',
        uri: null,
        contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
        originatingThreadId: null,
        originatingTurnId: null,
        originatingFileId: null,
        capturedAt: TIMESTAMP,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    });
    const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
    try {
      const selection = readWorkspaceNotebookSelection({
        workspaceDb,
        workspaceRoot,
        knowledgeBaseId: readDefaultKnowledgeBaseId({
          dataRoot,
          scope: { kind: 'workspace', workspaceId: workspace.id },
        }),
      });
      const notebook = selection.notebook;
      const baseRevision = selection.head.notebookCommit;
      const pointer = notebook.readSourcePointers(baseRevision)[source.id]!;
      const parsed = parseOkfDocument({ path: `sources/${source.id}.md`, content: pointer });
      if (!parsed.ok) throw new Error('Healthy Source fixture must have valid frontmatter.');
      const invalid =
        violation === 'invalid kind'
          ? updateOkfFrontmatter({
              path: `sources/${source.id}.md`,
              content: pointer,
              updates: { sourceKind: 'not-a-source-kind' },
            })
          : violation === 'missing capturedAt'
            ? pointer.replace(/^capturedAt:.*\n/m, '')
            : updateOkfFrontmatter({
                path: `sources/${source.id}.md`,
                content: pointer,
                updates:
                  violation === 'foreign scope'
                    ? {
                        scope: {
                          kind: 'workspace',
                          workspaceId: testEntityId('ws', 'foreign-source-owner'),
                        },
                      }
                    : {
                        contentRef: {
                          ...(parsed.document.frontmatter.contentRef as Record<string, unknown>),
                          contentDigest: null,
                        },
                      },
              });
      expect(invalid).not.toBe(pointer);
      // Explicit test-owned retained-field corruption, not a governed Source edit.
      const candidateRevision = notebook.prepareSourcePointers({
        baseRevision,
        changes: { [source.id]: invalid },
        metadata: notebook.inspectRevision(baseRevision).metadata,
      });
      const nextHead = await prepareWorkspaceKnowledgeSelection({
        db: workspaceDb,
        workspaceRoot,
        notebook,
        knowledgeBaseId: selection.head.knowledgeBaseId,
        notebookCommit: candidateRevision,
        schemaText: selection.scopeSchemaText,
      });
      await store.commitWorkspaceKnowledge({
        workspaceDb,
        expectedHead: selection.head,
        nextHead,
        audits: [],
        revalidatePublication: () => {
          const current = readWorkspaceNotebookSelection({
            workspaceDb,
            workspaceRoot,
            knowledgeBaseId: selection.head.knowledgeBaseId,
          });
          if (!isDeepStrictEqual(current.head, selection.head))
            throw new Error('Fixture Workspace Knowledge head changed.');
        },
      });
    } finally {
      workspaceDb.sqlite.close();
    }

    if (violation === 'foreign scope') {
      expect(() => new FsStore({ dataRoot })).toThrow();
    } else {
      await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
    }
  });

  it.each([
    'environmentPackageSnapshotId',
    'sessionCompatibilityKey',
    'policySnapshotId',
  ])('rejects an AgentSession missing required %s', async (field) => {
    const { dataRoot, store, workspace, thread } = await createCanonicalRecordFixture();
    const session = await store.createAgentSession({
      id: 'as_00000000-0000-78b0-aef0-27ad15cf38f1',
      agentId: 'agent_codex_host',
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'busy',
      message: null,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    await shutdownControlStoreWorkerClient();
    const db = openWorkspaceDb(dataRoot, workspace.id);
    try {
      const row = db.sqlite
        .prepare('SELECT record_json FROM control_agent_sessions WHERE id=?')
        .get(session.id) as { record_json: string };
      const record = JSON.parse(row.record_json) as Record<string, unknown>;
      delete record[field];
      db.sqlite
        .prepare('UPDATE control_agent_sessions SET record_json=? WHERE id=?')
        .run(JSON.stringify(record), session.id);
    } finally {
      db.sqlite.close();
    }

    await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
  });

  it('stores only a scalar environment package snapshot reference in an AgentSession', async () => {
    const { dataRoot, store, workspace, thread } = await createCanonicalRecordFixture();
    const session = await store.createAgentSession({
      id: 'as_00000000-0000-7262-a704-19543c73f9a3',
      agentId: 'agent_codex_host',
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'busy',
      message: null,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    const db = openWorkspaceDb(dataRoot, workspace.id);
    let record: Record<string, unknown>;
    try {
      const row = db.sqlite
        .prepare('SELECT record_json FROM control_agent_sessions WHERE id=?')
        .get(session.id) as { record_json: string };
      record = JSON.parse(row.record_json);
    } finally {
      db.sqlite.close();
    }

    expect(record).toMatchObject({
      environmentPackageSnapshotId: null,
      policySnapshotId: null,
      sessionCompatibilityKey: null,
    });
    expect(record).not.toHaveProperty('environmentPackageSnapshot');
  });
});
