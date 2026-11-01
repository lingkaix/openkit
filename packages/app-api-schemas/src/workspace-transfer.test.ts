import { describe, expect, it } from 'vitest';
import { PRODUCT_OPERATION_DEFINITIONS } from './operation-definitions.js';
import { WORKSPACE_TRANSFER_OPERATION_DEFINITIONS } from './workspace-transfer.js';

/** Definition views keep the retained export owner's exact handle. */
describe('Workspace JSON transfer definitions', () => {
  it('composes workspace.export and joins it to the product catalog', () => {
    expect(Object.keys(WORKSPACE_TRANSFER_OPERATION_DEFINITIONS)).toEqual(['workspace.export']);
    for (const [id, definition] of Object.entries(WORKSPACE_TRANSFER_OPERATION_DEFINITIONS))
      expect(
        PRODUCT_OPERATION_DEFINITIONS[id as keyof typeof WORKSPACE_TRANSFER_OPERATION_DEFINITIONS]
      ).toBe(definition);
  });
});
