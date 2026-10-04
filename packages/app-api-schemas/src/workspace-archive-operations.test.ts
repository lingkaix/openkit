import { describe, expect, it } from 'vitest';
import { OPERATION_DEFINITIONS, operationMcpEligible } from './operation-definitions.js';

describe('retained Workspace archive definitions', () => {
  it.each([
    'workspace.archive-download',
    'workspace.archive-import-dry-run',
    'workspace.archive-import',
  ])('declares %s as a streaming-only contract', (id) => {
    const definition = Object.entries(OPERATION_DEFINITIONS).find(([key]) => key === id)?.[1];
    expect(definition).toBeDefined();
    expect(definition?.binding).toBe('streaming');
    expect(definition && operationMcpEligible(definition)).toBe(false);
  });
});
