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
import { describe, expect, it, onTestFinished } from 'vitest';
import { scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { parseOkfDocument, updateOkfFrontmatter } from '../knowledge/okf.js';
import { FsStore } from '../lib/store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestStore } from '../test-support/store.js';
import { captureWorkspaceSourceFixture } from '../test-support/workspace-source.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

const TIMESTAMP = '2026-07-12T00:00:00.000Z';
const PROPOSAL_REQUEST_ID = '00000000-0000-4000-8000-000000000117';
const REVIEW_REQUEST_ID = '00000000-0000-4000-8000-000000000118';
const VERIFIED_EXTERNAL_REFERENCE = `turn:${testEntityId('tu', 'canonical-record-fixture')}`;

/**
 * Creates one strict immutable Proposal for canonical corruption tests.
 *
 * @param store File-backed authority under test.
 * @param workspaceId Workspace that owns the Proposal.
 * @returns Persisted Proposal record.
 */
function createStrictKnowledgeProposal(store: FsStore, workspaceId: string) {
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

  return store.createKnowledgeProposal({
    workspaceId,
    requestId: PROPOSAL_REQUEST_ID,
    baseRevision: new KnowledgeNotebook({
      repositoryPath: join(
        store.getDataRoot()!,
        'workspaces',
        workspaceId,
        'knowledge',
        'notebook.git'
      ),
    }).publishedRevision(),
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
}

/**
 * Creates one file-backed workspace lineage for canonical record validation tests.
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

describe('workspace canonical record schemas', () => {
  it('reloads native proposal metadata without changing its canonical bytes', async () => {
    const { dataRoot, store, workspace, workspaceRoot } = await createCanonicalRecordFixture();
    const proposal = createStrictKnowledgeProposal(store, workspace.id);
    const path = join(workspaceRoot, 'knowledge', 'proposals', `${proposal.id}.md`);
    const content = readFileSync(path, 'utf8');

    const restarted = new FsStore({ dataRoot });
    await restarted.createThread(workspace.id, 'Persist native proposal metadata');

    expect(restarted.getKnowledgeProposal(proposal.id)).toEqual(proposal);
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it('rejects a knowledge proposal missing its required created_at field', async () => {
    const { dataRoot, store, workspace, workspaceRoot } = await createCanonicalRecordFixture();
    const proposal = createStrictKnowledgeProposal(store, workspace.id);
    const path = join(workspaceRoot, 'knowledge', 'proposals', `${proposal.id}.md`);

    writeFileSync(path, readFileSync(path, 'utf8').replace(`created_at: "${TIMESTAMP}"\n`, ''));

    await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
  });

  it('ignores an embedded Proposal status while preserving its source bytes', async () => {
    const { dataRoot, store, workspace, workspaceRoot } = await createCanonicalRecordFixture();
    const proposal = createStrictKnowledgeProposal(store, workspace.id);
    const path = join(workspaceRoot, 'knowledge', 'proposals', `${proposal.id}.md`);
    const content = readFileSync(path, 'utf8');

    const extended = content.replace(
      'review_required: true',
      'review_required: true\nstatus: "accepted"'
    );
    writeFileSync(path, extended);

    const reopened = new FsStore({ dataRoot });
    expect(reopened.getKnowledgeProposal(proposal.id)).toEqual(proposal);
    expect(reopened.getKnowledgeProposal(proposal.id)).not.toHaveProperty('status');
    await reopened.createThread(workspace.id, 'Preserve ignored status');
    expect(readFileSync(path, 'utf8')).toBe(extended);
  });

  it('rejects a knowledge proposal review with invalid persisted fields', async () => {
    const { dataRoot, store, workspace, workspaceRoot } = await createCanonicalRecordFixture();
    const proposal = createStrictKnowledgeProposal(store, workspace.id);
    store.recordKnowledgeProposalReviewDecision({
      proposalId: proposal.id,
      workspaceId: workspace.id,
      decision: 'rejected',
      requestId: REVIEW_REQUEST_ID,
      baseRevision: proposal.baseRevision,
      candidateRevision: proposal.candidateRevision,
      proposalDigest: `sha256:${createHash('sha256')
        .update(readFileSync(join(workspaceRoot, 'knowledge', 'proposals', `${proposal.id}.md`)))
        .digest('hex')}`,
      verifiedExternalReferences: [VERIFIED_EXTERNAL_REFERENCE],
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      decidedAt: TIMESTAMP,
    });
    const path = join(workspaceRoot, 'knowledge', 'reviews', `${proposal.id}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8')) as {
      decisions: Array<Record<string, unknown>>;
    };
    record.decisions[0]!.decision = 'not-a-review-decision';
    record.decisions[0]!.decidedAt = 'not-a-timestamp';

    writeFileSync(path, `${JSON.stringify(record)}\n`);

    await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
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
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(workspaceRoot, 'knowledge', 'notebook.git'),
    });
    const baseRevision = notebook.publishedRevision();
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
    notebook.publish({ baseRevision, candidateRevision });

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
    const { dataRoot, store, workspace, thread, workspaceRoot } =
      await createCanonicalRecordFixture();
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
    const path = join(workspaceRoot, 'runtime', 'agent-sessions', session.id, 'session.json');
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

    delete record[field];
    writeFileSync(path, `${JSON.stringify(record)}\n`);

    await expectLocalWorkspaceRefusal(dataRoot, workspace.id);
  });

  it('stores only a scalar environment package snapshot reference in an AgentSession', async () => {
    const { store, workspace, thread, workspaceRoot } = await createCanonicalRecordFixture();
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
    const record = JSON.parse(
      readFileSync(
        join(workspaceRoot, 'runtime', 'agent-sessions', session.id, 'session.json'),
        'utf8'
      )
    ) as Record<string, unknown>;

    expect(record).toMatchObject({
      environmentPackageSnapshotId: null,
      policySnapshotId: null,
      sessionCompatibilityKey: null,
    });
    expect(record).not.toHaveProperty('environmentPackageSnapshot');
  });
});
