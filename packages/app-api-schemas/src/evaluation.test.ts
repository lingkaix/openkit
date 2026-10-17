import { describe, expect, it } from 'vitest';
import { CandidateSetRecordSchema, JudgementRecordSchema } from './evaluation.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' };
const candidate = {
  artifactId: 'ar_00000000-0000-7000-8000-000000000001',
  artifactVersion: 1,
  contentDigest: `sha256:${'a'.repeat(64)}`,
};
const secondCandidate = {
  ...candidate,
  artifactVersion: 2,
  contentDigest: `sha256:${'b'.repeat(64)}`,
};
const judgement = {
  formatVersion: 1,
  workspaceId,
  requestId: 'selection-one',
  actor,
  recordedAt: '2026-10-17T12:00:00.000Z',
  kind: 'select',
  target: { kind: 'candidate-set', candidateSetId: 'comparison-one' },
  choice: candidate,
  note: null,
  extensions: { display: { label: 'Human preference' } },
};

describe('evaluation retained shapes', () => {
  it('retains exact attributable selections and rejects unknown core or contradictory membership', () => {
    expect(
      JudgementRecordSchema.safeParse({ ...judgement, kind: 'automatic-winner' }).success
    ).toBe(false);
    expect(JudgementRecordSchema.parse(judgement)).toEqual(judgement);
    const set = {
      formatVersion: 1,
      workspaceId,
      candidateSetId: 'comparison-one',
      createdBy: actor,
      createdAt: judgement.recordedAt,
      candidates: [candidate, secondCandidate],
      selections: [judgement],
      extensions: {},
    };
    expect(CandidateSetRecordSchema.parse(set)).toEqual(set);
    expect(
      CandidateSetRecordSchema.safeParse({ ...set, candidates: [candidate, candidate] }).success
    ).toBe(false);
    expect(
      CandidateSetRecordSchema.safeParse({
        ...set,
        selections: [{ ...judgement, choice: { ...candidate, artifactVersion: 3 } }],
      }).success
    ).toBe(false);
    expect(
      JudgementRecordSchema.safeParse({
        ...judgement,
        actor: { kind: 'agent', id: 'judge', responsibleUserId: actor.id },
      }).success
    ).toBe(false);
  });

  it('retains UTF-16 original range and correction result without widening the target kind', () => {
    const correction = {
      ...judgement,
      requestId: 'correction-one',
      kind: 'correct',
      target: {
        kind: 'material-range',
        materialId: 'mat_00000000-0000-7000-8000-000000000001',
        revisionId: 'mrev_00000000-0000-7000-8000-000000000001',
        contentDigest: candidate.contentDigest,
        offsetUnit: 'utf-16',
        start: 1,
        end: 3,
        originalText: '😀',
      },
      choice: { replacementText: 'Done', outcome: 'reject', resultingRevision: null },
    };
    expect(
      JudgementRecordSchema.safeParse({ ...correction, target: judgement.target }).success
    ).toBe(false);
    expect(JudgementRecordSchema.parse(correction)).toEqual(correction);
    expect(
      JudgementRecordSchema.safeParse({
        ...correction,
        choice: { ...correction.choice, outcome: 'apply' },
      }).success
    ).toBe(false);
  });
});
