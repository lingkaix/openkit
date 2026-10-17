import { describe, expect, it } from 'vitest';
import {
  ReadKnowledgeProposalRequestSchema,
  ReadKnowledgeProposalResponseSchema,
} from './knowledge-proposal-preview.js';

const tuple = {
  proposalId: `kp_${'a'.repeat(64)}`,
  proposalDigest: `sha256:${'b'.repeat(64)}`,
  baseRevision: 'base',
  candidateRevision: 'candidate',
  paths: ['note.md'],
};

describe('exact Proposal preview contract', () => {
  it('admits only a saved Proposal selector and bounded complete inventory or chunk projections', () => {
    const request = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      proposalId: tuple.proposalId,
    };
    expect(ReadKnowledgeProposalRequestSchema.parse(request).offset).toBe(0);
    for (const invalid of [
      { ...request, path: '../secret.md' },
      { ...request, offset: 1 },
      { ...request, path: 'note.md', offset: -1 },
      { ...request, revision: 'arbitrary' },
    ])
      expect(ReadKnowledgeProposalRequestSchema.safeParse(invalid).success).toBe(false);
    expect(ReadKnowledgeProposalResponseSchema.parse(tuple)).toEqual(tuple);
    expect(
      ReadKnowledgeProposalResponseSchema.parse({
        ...tuple,
        path: 'note.md',
        before: null,
        after: '',
        nextOffset: null,
      })
    ).toMatchObject({ before: null, after: '' });
    for (const invalid of [
      { ...tuple, path: 'other.md', before: null, after: '', nextOffset: null },
      { ...tuple, before: '' },
      { ...tuple, path: 'note.md', before: '', after: 'x'.repeat(4097), nextOffset: 4096 },
      { ...tuple, baseRevision: 'x'.repeat(65536) },
    ])
      expect(ReadKnowledgeProposalResponseSchema.safeParse(invalid).success).toBe(false);
  });
});
