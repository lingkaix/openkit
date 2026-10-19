import { expect, it } from 'vitest';
import {
  CorrectMaterialRangeRequestSchema,
  RecordEvaluationJudgementRequestSchema,
} from './evaluation-judgement-operations.js';

it('keeps caller assessment separate from trusted attribution and applied revision authority', () => {
  const input = {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    requestId: 'human-assessment',
    judgement: {
      kind: 'accept',
      target: {
        kind: 'artifact-version',
        artifactId: 'ar_00000000-0000-7000-8000-000000000001',
        artifactVersion: 1,
        contentDigest: `sha256:${'a'.repeat(64)}`,
      },
      choice: null,
    },
  };
  expect(RecordEvaluationJudgementRequestSchema.parse(input)).toMatchObject({
    ...input,
    judgement: { ...input.judgement, note: null, extensions: {} },
  });
  expect(
    RecordEvaluationJudgementRequestSchema.safeParse({
      ...input,
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    }).success
  ).toBe(false);
  const correction = {
    workspaceId: input.workspaceId,
    requestId: 'human-correction',
    target: {
      kind: 'material-range',
      materialId: 'mat_00000000-0000-7000-8000-000000000001',
      revisionId: 'mrev_00000000-0000-7000-8000-000000000001',
      contentDigest: input.judgement.target.contentDigest,
      start: 1,
      end: 3,
      originalText: '😀',
    },
    replacementText: 'Done',
    decision: 'apply',
  };
  expect(CorrectMaterialRangeRequestSchema.parse(correction)).toMatchObject(correction);
  expect(
    CorrectMaterialRangeRequestSchema.safeParse({
      ...correction,
      resultingRevision: { revisionId: correction.target.revisionId },
    }).success
  ).toBe(false);
});
