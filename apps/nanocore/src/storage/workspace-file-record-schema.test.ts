import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FsStore } from '../lib/store.js';

const TIMESTAMP = '2026-07-12T00:00:00.000Z';

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
  it.each([
    ['created_at', `created_at: "${TIMESTAMP}"`, 'created_at: "not-a-timestamp"'],
    ['updated_at', `updated_at: "${TIMESTAMP}"`, 'updated_at: "not-a-timestamp"'],
  ])('rejects a knowledge proposal with an invalid required %s field', (_, before, after) => {
    const { dataRoot, store, workspace, workspaceRoot } = createCanonicalRecordFixture();
    const proposal = store.createKnowledgeProposal({
      id: 'kp_invalid_schema',
      workspaceId: workspace.id,
      title: 'Invalid proposal schema',
      summary: 'This proposal must fail closed after persisted corruption.',
      status: 'pending',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    const path = join(workspaceRoot, 'knowledge', 'proposals', `${proposal.id}.md`);

    writeFileSync(path, readFileSync(path, 'utf8').replace(before, after));

    expect(() => new FsStore({ dataRoot })).toThrow();
  });

  it('rejects a knowledge proposal with embedded decision status', () => {
    const { dataRoot, store, workspace, workspaceRoot } = createCanonicalRecordFixture();
    const proposal = store.createKnowledgeProposal({
      id: 'kp_embedded_status',
      workspaceId: workspace.id,
      title: 'Embedded decision status',
      summary: 'The review record alone owns decision status.',
      status: 'pending',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    const path = join(workspaceRoot, 'knowledge', 'proposals', `${proposal.id}.md`);
    const content = readFileSync(path, 'utf8');

    writeFileSync(
      path,
      content.includes('\nstatus:')
        ? content
        : content.replace(
            'requested_operation: "review_summary"',
            'requested_operation: "review_summary"\nstatus: "pending"'
          )
    );

    expect(() => new FsStore({ dataRoot })).toThrow();
  });

  it('rejects a knowledge proposal review with invalid persisted fields', () => {
    const { dataRoot, store, workspace, workspaceRoot } = createCanonicalRecordFixture();
    const proposal = store.createKnowledgeProposal({
      id: 'kp_invalid_review_schema',
      workspaceId: workspace.id,
      title: 'Invalid proposal review schema',
      summary: 'The review record must be schema-validated on reload.',
      status: 'pending',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    store.recordKnowledgeProposalReviewDecision({
      proposalId: proposal.id,
      workspaceId: workspace.id,
      status: 'accepted',
      requestId: null,
      message: null,
      decidedAt: TIMESTAMP,
    });
    const path = join(workspaceRoot, 'knowledge', 'reviews', `${proposal.id}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

    writeFileSync(
      path,
      `${JSON.stringify({ ...record, status: 'not-a-review-status', decidedAt: 'not-a-timestamp' })}\n`
    );

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
  ])('rejects an agent session missing required %s', (field) => {
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

  it('stores only a scalar environment package snapshot reference in an agent session', () => {
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
