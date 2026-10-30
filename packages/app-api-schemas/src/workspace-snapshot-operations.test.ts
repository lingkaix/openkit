import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import * as schemas from './index.js';

const workspaceId = allocateEntityId('ws');
const backupId = allocateEntityId('wsbak');
const requestId = '63ce66ae-ec8b-4e58-a9db-38df9dd87947';
const selector = { workspaceId, backupId };
const operationIds = [
  'workspace.backup-capture',
  'workspace.backup-verify',
  'workspace.backup-download',
  'workspace.backup-restore',
  'workspace.move-out',
  'workspace.move-in',
  'workspace.recovery-inspect',
  'workspace.recovery-finish',
  'workspace.recovery-abandon',
  'workspace.move-reactivate',
] as const;

/** C-a and restore are active; six recovery verbs retain their per-verb W preparation. */
describe('Workspace snapshot operation contract', () => {
  it('composes exactly four snapshot handlers and leaves six recovery definitions uncomposed', () => {
    const composed = new Set<string>([
      'workspace.backup-capture',
      'workspace.backup-verify',
      'workspace.backup-download',
      'workspace.backup-restore',
    ]);
    const definitions = schemas.WORKSPACE_SNAPSHOT_OPERATION_DEFINITIONS;
    expect(Object.keys(definitions).sort()).toEqual([...operationIds].sort());
    for (const id of operationIds) {
      expect(Object.hasOwn(schemas.OPERATION_DEFINITIONS, id)).toBe(composed.has(id));
      expect(definitions[id].scope).toEqual({ kind: 'server' });
      expect(definitions[id].policyOperation).toBe('api.call');
      expect([...definitions[id].credentials].sort()).toEqual(
        ['local-user', 'user-session', 'deployment-administrator'].sort()
      );
    }
  });

  it('keeps bundle transfer binary and the remaining lifecycle definitions JSON', () => {
    const definitions = schemas.WORKSPACE_SNAPSHOT_OPERATION_DEFINITIONS;
    for (const id of operationIds) {
      expect(definitions[id].binding).toBe(
        id === 'workspace.backup-download' || id === 'workspace.move-in' ? 'streaming' : 'json'
      );
    }
    expect(definitions['workspace.move-in'].binaryRequestBody?.mediaType).toBe(
      'application/octet-stream'
    );
  });

  it('selects backup bytes by typed identities and refuses public filesystem selectors', () => {
    const input =
      schemas.WORKSPACE_SNAPSHOT_OPERATION_DEFINITIONS['workspace.backup-verify'].inputSchema;
    expect(input.parse(selector)).toEqual(selector);
    for (const invalid of [
      { ...selector, dataRoot: '/private/data' },
      { ...selector, bundleRoot: '/private/bundle' },
      { ...selector, backupId: '../bundle' },
      { ...selector, backupId: workspaceId },
      { ...selector, workspaceId: backupId },
    ]) {
      expect(input.safeParse(invalid).success).toBe(false);
    }
  });

  it('retains explicit safety acknowledgements, revision and the existing MOVE-in disposition', () => {
    const definitions = schemas.WORKSPACE_SNAPSHOT_OPERATION_DEFINITIONS;
    const restore = { ...selector, requestId, acknowledgeLostSafety: false };
    expect(definitions['workspace.backup-restore'].inputSchema.parse(restore)).toEqual(restore);
    expect(
      definitions['workspace.backup-restore'].inputSchema.safeParse({ ...selector, requestId })
        .success
    ).toBe(false);
    expect(
      definitions['workspace.backup-restore'].inputSchema.safeParse({
        ...restore,
        requestId: 'new',
      }).success
    ).toBe(false);
    const reactivate = {
      ...selector,
      expectedRevision: 1,
      acknowledgeTargetFenced: true,
      acknowledgeCopiesRetired: true,
    };
    expect(definitions['workspace.move-reactivate'].inputSchema.parse(reactivate)).toEqual(
      reactivate
    );
    for (const field of [
      'expectedRevision',
      'acknowledgeTargetFenced',
      'acknowledgeCopiesRetired',
    ] as const) {
      const incomplete = { ...reactivate, [field]: undefined };
      expect(
        definitions['workspace.move-reactivate'].inputSchema.safeParse(incomplete).success
      ).toBe(false);
    }
    const report = {
      command: 'move-in',
      disposition: 'imported',
      workspaceId,
      droppedSourceMemberIds: [],
      restrictedRecovery: false,
      nextAction: 'none',
    };
    expect(definitions['workspace.move-in'].outputSchema.parse(report)).toEqual(report);
  });
});
