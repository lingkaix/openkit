import { describe, expect, it } from 'vitest';
import {
  EVALUATION_OPERATION_DEFINITIONS,
  OPERATION_DEFINITIONS,
  operationHttpPath,
  operationToolName,
} from './index.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const candidate = {
  artifactId: 'ar_00000000-0000-7000-8000-000000000001',
  artifactVersion: 1,
  contentDigest: `sha256:${'a'.repeat(64)}`,
};

describe('candidate-set ordinary operation contracts', () => {
  it('composes four JSON definitions with bounded tool names and closed caller-owned inputs', () => {
    for (const [id, definition] of Object.entries(EVALUATION_OPERATION_DEFINITIONS)) {
      expect(OPERATION_DEFINITIONS[id as keyof typeof EVALUATION_OPERATION_DEFINITIONS]).toBe(
        definition
      );
      expect(definition.binding).toBe('json');
      expect(id).toMatch(/^[a-z]+\.[a-z]+(?:-[a-z]+)*$/);
      expect(operationToolName(id).length).toBeLessThanOrEqual(40);
      expect(operationHttpPath(id)).toBe(`/api/app/operations/${id}`);
    }
    const create = EVALUATION_OPERATION_DEFINITIONS['evaluation.candidate-set-create'].inputSchema;
    const input = {
      workspaceId,
      requestId: 'ordered-set',
      candidates: [candidate, { ...candidate, artifactVersion: 2 }],
    };
    expect(create.parse(input)).toEqual(input);
    expect(
      create.safeParse({ ...input, actor: { kind: 'user', id: 'caller-owned-actor' } }).success
    ).toBe(false);
    expect(create.safeParse({ ...input, candidates: [candidate] }).success).toBe(false);
    const select = EVALUATION_OPERATION_DEFINITIONS['evaluation.candidate-set-select'].inputSchema;
    expect(
      select.parse({
        workspaceId,
        candidateSetId: 'ordered-set',
        requestId: 'choose-one',
        choice: candidate,
      })
    ).not.toHaveProperty('actor');
    expect(
      select.safeParse({
        workspaceId,
        candidateSetId: 'ordered-set',
        requestId: 'choose-one',
        choice: candidate,
        recordedAt: '2026-10-17T00:00:00.000Z',
      }).success
    ).toBe(false);
  });
});
