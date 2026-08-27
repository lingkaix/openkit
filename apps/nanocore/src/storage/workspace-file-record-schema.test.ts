import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FsStore } from '../lib/store.js';

const TIMESTAMP = '2026-07-12T00:00:00.000Z';
const PROPOSAL_REQUEST_ID = '00000000-0000-4000-8000-000000000117';
const REVIEW_REQUEST_ID = '00000000-0000-4000-8000-000000000118';
const VERIFIED_EXTERNAL_REFERENCE = 'turn:canonical-record-fixture';

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
    'schema_version: "openkit-workspace-knowledge-schema-v1"',
    'status: "active"',
    'scope: "workspace"',
    'openkit_entry_id: "canonical-proposal"',
    'openkit_entry_kind: "project-context"',
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
    knowledgePageId: 'canonical-proposal',
    canonicalPageBytes,
    contentDigest: `sha256:${createHash('sha256').update(canonicalPageBytes).digest('hex')}`,
    sourceReferences: [VERIFIED_EXTERNAL_REFERENCE],
    rationale: 'Exercise canonical Proposal loading.',
    confidence: 1,
    verifiedExternalReferences: [VERIFIED_EXTERNAL_REFERENCE],
    producer: { kind: 'user', id: 'user_local' },
    createdAt: TIMESTAMP,
  });
}

/**
 * Creates one file-backed workspace lineage for canonical record validation tests.
 *
 * @returns Store, data root, workspace, thread, turn, and workspace root.
 */
function createCanonicalRecordFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-canonical-record-schema-'));
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Canonical record schema workspace');
  const thread = store.createThread(workspace.id, 'Canonical record schema thread');
  const turn = store.createTurn(workspace.id, thread.id, 'Validate canonical record schemas', {
    kind: 'user',
    id: 'user_local',
  });

  return {
    dataRoot,
    store,
    workspace,
    thread,
    turn,
    workspaceRoot: join(dataRoot, 'workspaces', workspace.id),
  };
}

describe('workspace canonical record schemas', () => {
  it('rejects a knowledge proposal missing its required created_at field', () => {
    const { dataRoot, store, workspace, workspaceRoot } = createCanonicalRecordFixture();
    const proposal = createStrictKnowledgeProposal(store, workspace.id);
    const path = join(workspaceRoot, 'knowledge', 'proposals', `${proposal.id}.md`);

    writeFileSync(path, readFileSync(path, 'utf8').replace(`created_at: "${TIMESTAMP}"\n`, ''));

    expect(() => new FsStore({ dataRoot })).toThrow();
  });

  it('rejects a knowledge proposal with embedded decision status', () => {
    const { dataRoot, store, workspace, workspaceRoot } = createCanonicalRecordFixture();
    const proposal = createStrictKnowledgeProposal(store, workspace.id);
    const path = join(workspaceRoot, 'knowledge', 'proposals', `${proposal.id}.md`);
    const content = readFileSync(path, 'utf8');

    writeFileSync(
      path,
      content.replace('review_required: true', 'review_required: true\nstatus: "pending"')
    );

    expect(() => new FsStore({ dataRoot })).toThrow();
  });

  it('rejects a knowledge proposal review with invalid persisted fields', () => {
    const { dataRoot, store, workspace, workspaceRoot } = createCanonicalRecordFixture();
    const proposal = createStrictKnowledgeProposal(store, workspace.id);
    store.recordKnowledgeProposalReviewDecision({
      proposalId: proposal.id,
      workspaceId: workspace.id,
      decision: 'rejected',
      requestId: REVIEW_REQUEST_ID,
      verifiedExternalReferences: [VERIFIED_EXTERNAL_REFERENCE],
      actor: { kind: 'user', id: 'user_local' },
      decidedAt: TIMESTAMP,
    });
    const path = join(workspaceRoot, 'knowledge', 'reviews', `${proposal.id}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8')) as {
      decisions: Array<Record<string, unknown>>;
    };
    record.decisions[0]!.decision = 'not-a-review-decision';
    record.decisions[0]!.decidedAt = 'not-a-timestamp';

    writeFileSync(path, `${JSON.stringify(record)}\n`);

    expect(() => new FsStore({ dataRoot })).toThrow();
  });

  it.each([
    'invalid kind',
    'missing capturedAt',
  ])('rejects a knowledge source with %s', (violation) => {
    const { dataRoot, store, workspace, workspaceRoot } = createCanonicalRecordFixture();
    const source = store.createKnowledgeSource({
      id: 'ks_invalid_schema',
      workspaceId: workspace.id,
      kind: 'upload',
      title: 'Invalid source schema',
      uri: null,
      contentDigest: 'sha256:invalid-source-schema',
      originatingThreadId: null,
      originatingTurnId: null,
      originatingFileId: null,
      capturedAt: TIMESTAMP,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    const path = join(workspaceRoot, 'sources', 'registry', `${source.id}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

    if (violation === 'invalid kind') {
      record.kind = 'not-a-source-kind';
    } else {
      delete record.capturedAt;
    }
    writeFileSync(path, `${JSON.stringify(record)}\n`);

    expect(() => new FsStore({ dataRoot })).toThrow();
  });

  it.each([
    'environmentPackageSnapshotId',
    'sessionCompatibilityKey',
    'policySnapshotId',
  ])('rejects an AgentSession missing required %s', (field) => {
    const { dataRoot, store, workspace, thread, workspaceRoot } = createCanonicalRecordFixture();
    const session = store.createAgentSession({
      id: 'as_invalid_schema',
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

    expect(() => new FsStore({ dataRoot })).toThrow();
  });

  it('stores only a scalar environment package snapshot reference in an AgentSession', () => {
    const { store, workspace, thread, workspaceRoot } = createCanonicalRecordFixture();
    const session = store.createAgentSession({
      id: 'as_scalar_aep_reference',
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
