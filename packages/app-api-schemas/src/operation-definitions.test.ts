import { describe, expect, it } from 'vitest';
import {
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
