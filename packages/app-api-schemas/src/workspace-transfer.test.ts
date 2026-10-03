import { describe, expect, it } from 'vitest';
import { operationModelInput, PRODUCT_OPERATION_DEFINITIONS } from './operation-definitions.js';
import { WorkspaceImportDryRunRequestSchema, WorkspaceImportRequestSchema } from './storage.js';
import { WORKSPACE_TRANSFER_OPERATION_DEFINITIONS } from './workspace-transfer.js';

/** Definition and derived model views keep the archive owner's exact handle refinements. */
describe('Workspace JSON transfer definitions', () => {
  it('composes exactly three operations and reuses the complete import schemas', () => {
    expect(Object.keys(WORKSPACE_TRANSFER_OPERATION_DEFINITIONS)).toEqual([
      'workspace.export',
      'workspace.import-dry-run',
      'workspace.import',
    ]);
    for (const [id, definition] of Object.entries(WORKSPACE_TRANSFER_OPERATION_DEFINITIONS))
      expect(
        PRODUCT_OPERATION_DEFINITIONS[id as keyof typeof WORKSPACE_TRANSFER_OPERATION_DEFINITIONS]
      ).toBe(definition);
    expect(WORKSPACE_TRANSFER_OPERATION_DEFINITIONS['workspace.import-dry-run'].inputSchema).toBe(
      WorkspaceImportDryRunRequestSchema
    );
    expect(WORKSPACE_TRANSFER_OPERATION_DEFINITIONS['workspace.import'].inputSchema).toBe(
      WorkspaceImportRequestSchema
    );
  });
  it('keeps strict inputs, safe handles and trusted identity exclusions in the model view', () => {
    const model = operationModelInput(WorkspaceImportRequestSchema, ['requestId']);
    expect(model.shape.exportId).toBe(WorkspaceImportRequestSchema.shape.exportId);
    expect(model.safeParse({ sourceWorkspaceId: 'ws_demo', exportId: 'wsexp_demo' }).success).toBe(
      true
    );
    for (const exportId of ['.', '..', '../foreign', '/server/path'])
      expect(model.safeParse({ sourceWorkspaceId: 'ws_demo', exportId }).success).toBe(false);
    expect(
      model.safeParse({
        sourceWorkspaceId: 'ws_demo',
        exportId: 'wsexp_demo',
        ownerUserId: 'other',
      }).success
    ).toBe(false);
  });
});
