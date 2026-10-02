import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_OPERATION_DEFINITIONS,
  KERNEL_OPERATION_DEFINITIONS,
  operationHttpPath,
  operationModelInput,
  operationToolName,
} from './operation-definitions.js';

describe('operation definitions', () => {
  it('derives model views from complete schemas without bound identities', () => {
    for (const [id, definition] of Object.entries(KERNEL_OPERATION_DEFINITIONS)) {
      expect(operationHttpPath(id)).toBe(`/api/app/operations/${id}`);
      expect(operationToolName(id)).toBe(id.replaceAll('.', '_').replaceAll('-', '_'));
      expect(definition.inputSchema.safeParse({}).success).toBe(false);
      const model = operationModelInput(definition.inputSchema, ['workspaceId', 'requestId']);
      expect(model.shape).not.toHaveProperty('workspaceId');
      expect(model.shape).not.toHaveProperty('requestId');
      for (const [key, schema] of Object.entries(model.shape)) {
        expect(schema).toBe(
          definition.inputSchema.shape[key as keyof typeof definition.inputSchema.shape]
        );
      }
    }
    expect(new Set(Object.keys(KERNEL_OPERATION_DEFINITIONS).map(operationToolName)).size).toBe(
      Object.keys(KERNEL_OPERATION_DEFINITIONS).length
    );
  });
});

it('derives Artifact model views with bound identity omitted and content and feedback refinements retained', () => {
  const imported = operationModelInput(
    ARTIFACT_OPERATION_DEFINITIONS['artifact.import'].inputSchema,
    ['workspaceId', 'requestId']
  );
  expect(imported.shape.content).toBe(
    ARTIFACT_OPERATION_DEFINITIONS['artifact.import'].inputSchema.shape.content
  );
  expect(imported.shape.requestId).toBeUndefined();
  expect(
    imported.safeParse({
      title: 'Exact JSON',
      mediaType: 'application/json',
      content: 'invalid json',
      contentDigest: `sha256:${'a'.repeat(64)}`,
    }).success
  ).toBe(false);
  expect(
    imported.safeParse({
      title: 'Exact JSON',
      mediaType: 'application/json',
      content: '{"ok":true}',
      contentDigest: `sha256:${'a'.repeat(64)}`,
    }).success
  ).toBe(true);
  const decision = operationModelInput(
    ARTIFACT_OPERATION_DEFINITIONS['artifact.review.decide'].inputSchema,
    ['workspaceId', 'requestId']
  );
  expect(
    decision.safeParse({ artifactId: 'ar_review', artifactVersion: 1, decision: 'redo' }).success
  ).toBe(false);
  expect(
    decision.safeParse({
      artifactId: 'ar_review',
      artifactVersion: 1,
      decision: 'redo',
      feedback: 'Try again.',
    }).success
  ).toBe(true);
});
