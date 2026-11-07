import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  DecideServerKnowledgeProposalRequestSchema,
  DecideServerKnowledgeProposalResponseSchema,
  ListServerThreadsResponseSchema,
  ReadServerKnowledgeProposalRequestSchema,
  ReadServerThreadResponseSchema,
  SERVER_THREAD_OPERATION_DEFINITIONS,
  ServerKnowledgeMaintainRequestSchema,
  ServerKnowledgeProposalSchema,
  ServerKnowledgeReviewSchema,
  ServerKnowledgeTellRequestSchema,
} from './index.js';

const workspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const turnId = allocateEntityId('tu');
const userId = allocateEntityId('usr');
const requestId = '11111111-1111-4111-8111-111111111111';
const timestamp = '2026-10-16T00:00:00.000Z';
const digest = `sha256:${'a'.repeat(64)}`;
const proposalId = `kp_${'b'.repeat(64)}`;

const serverThread = {
  id: threadId,
  owner: { kind: 'server' as const },
  name: 'Server Knowledge Maintenance',
  preview: 'Maintenance run',
  status: 'active' as const,
  entryPath: 'conversation' as const,
  visibility: 'server' as const,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const serverTurn = {
  id: turnId,
  owner: { kind: 'server' as const },
  threadId,
  triggerActor: { kind: 'user' as const, id: userId },
  items: [],
  error: null,
  configVersion: 1,
  startedAt: timestamp,
  completedAt: timestamp,
  durationMs: 25,
  status: 'completed' as const,
};

const baseReview = {
  proposalId,
  baseRevision: 'rev-1',
  candidateRevision: 'rev-2',
  reviewId: 'kr_00000000-0000-7000-8000-000000000001',
  requestId,
  decision: 'accepted' as const,
  actor: { kind: 'user' as const, id: userId },
  proposalDigest: digest,
  changedPageIds: ['architecture/overview'],
  contentDigest: digest,
  targetAbsentAtDecision: null,
  decidedAt: timestamp,
  ownerScope: { kind: 'server' as const },
};

describe('server thread and server knowledge schemas', () => {
  it('omits workspaceId from server knowledge maintain and tell requests while enforcing unique page and source selectors', () => {
    const maintain = ServerKnowledgeMaintainRequestSchema.parse({
      requestId,
      instruction: 'Consolidate deployment notes',
      pageIds: ['ops/runbook'],
    });
    expect(maintain.instruction).toBe('Consolidate deployment notes');
    expect(
      ServerKnowledgeMaintainRequestSchema.safeParse({
        workspaceId,
        requestId,
        instruction: 'Consolidate deployment notes',
      }).success
    ).toBe(false);
    expect(
      ServerKnowledgeMaintainRequestSchema.safeParse({
        requestId,
        instruction: 'Consolidate deployment notes',
        pageIds: ['ops/runbook', 'ops/runbook'],
      }).success
    ).toBe(false);

    const tell = ServerKnowledgeTellRequestSchema.parse({
      requestId,
      content: 'Primary region is eu-central-1',
    });
    expect(tell.sources).toEqual([]);
    expect(
      ServerKnowledgeTellRequestSchema.safeParse({
        workspaceId,
        requestId,
        content: 'Primary region is eu-central-1',
      }).success
    ).toBe(false);
  });

  it('refuses workspace-owned threads or turns in ReadServerThreadResponseSchema and ListServerThreadsResponseSchema', () => {
    expect(
      ReadServerThreadResponseSchema.parse({
        thread: serverThread,
        turns: [serverTurn],
      }).thread.owner
    ).toEqual({ kind: 'server' });

    expect(
      ReadServerThreadResponseSchema.safeParse({
        thread: { ...serverThread, owner: { kind: 'workspace', workspaceId } },
        turns: [serverTurn],
      }).success
    ).toBe(false);

    expect(
      ReadServerThreadResponseSchema.safeParse({
        thread: serverThread,
        turns: [{ ...serverTurn, owner: { kind: 'workspace', workspaceId } }],
      }).success
    ).toBe(false);

    expect(ListServerThreadsResponseSchema.parse({ items: [serverThread] }).items).toHaveLength(1);
    expect(
      ListServerThreadsResponseSchema.safeParse({
        items: [{ ...serverThread, owner: { kind: 'workspace', workspaceId } }],
      }).success
    ).toBe(false);
  });

  it('requires ServerKnowledgeProposalSchema to carry a server ownerScope and exactly one complete candidate shape', () => {
    const validMultiPage = {
      id: proposalId,
      operation: 'notebook-change' as const,
      ownerScope: { kind: 'server' as const },
      baseRevision: 'rev-1',
      candidateRevision: 'rev-2',
      changes: [{ path: 'ops/runbook.md', content: '# Runbook\n' }],
      contentDigest: digest,
      sourceReferences: [`turn:${turnId}`],
      rationale: 'Record runbook steps',
      producer: { kind: 'user' as const, id: userId },
      status: 'pending' as const,
      createdAt: timestamp,
    };
    expect(ServerKnowledgeProposalSchema.parse(validMultiPage).ownerScope).toEqual({
      kind: 'server',
    });

    expect(
      ServerKnowledgeProposalSchema.safeParse({
        ...validMultiPage,
        workspaceId,
      }).success
    ).toBe(false);

    expect(
      ServerKnowledgeProposalSchema.safeParse({
        ...validMultiPage,
        knowledgePageId: 'ops/runbook',
      }).success
    ).toBe(false);
  });

  it('requires ServerKnowledgeReviewSchema and DecideServerKnowledgeProposalResponseSchema to name either knowledgePageId or changedPageIds', () => {
    expect(
      DecideServerKnowledgeProposalResponseSchema.parse({
        review: baseReview,
        notebookRevision: 'rev-2',
      }).review.ownerScope
    ).toEqual({ kind: 'server' });

    expect(
      ServerKnowledgeReviewSchema.safeParse({
        ...baseReview,
        knowledgePageId: 'architecture/overview',
      }).success
    ).toBe(false);

    const { changedPageIds: _omitted, ...neitherCandidate } = baseReview;
    expect(ServerKnowledgeReviewSchema.safeParse(neitherCandidate).success).toBe(false);
  });

  it('enforces proposalId format and path-bound offset on ReadServerKnowledgeProposalRequestSchema and DecideServerKnowledgeProposalRequestSchema', () => {
    expect(ReadServerKnowledgeProposalRequestSchema.parse({ proposalId }).offset).toBe(0);
    expect(
      ReadServerKnowledgeProposalRequestSchema.parse({
        proposalId,
        path: 'ops/runbook.md',
        offset: 128,
      }).offset
    ).toBe(128);

    expect(
      ReadServerKnowledgeProposalRequestSchema.safeParse({
        proposalId,
        offset: 64,
      }).success
    ).toBe(false);

    expect(
      ReadServerKnowledgeProposalRequestSchema.safeParse({
        proposalId: 'kp_invalid',
      }).success
    ).toBe(false);

    expect(
      SERVER_THREAD_OPERATION_DEFINITIONS['knowledge.server.proposal.decide'].inputSchema.parse({
        proposalId,
        requestId,
        proposalDigest: digest,
        baseRevision: 'rev-1',
        candidateRevision: 'rev-2',
        decision: 'rejected',
      }).decision
    ).toBe('rejected');

    expect(
      DecideServerKnowledgeProposalRequestSchema.safeParse({
        proposalId,
        requestId,
        proposalDigest: 'sha256:not-hex',
        baseRevision: 'rev-1',
        candidateRevision: 'rev-2',
        decision: 'rejected',
      }).success
    ).toBe(false);
  });
});
