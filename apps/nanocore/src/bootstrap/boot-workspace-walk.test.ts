import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlStoreWorkerError } from '../storage/control-store-worker-error.js';
import { withinBootWorkspaceBoundary } from './boot-workspace-walk.js';
import { isScopeAdmitted, scopeAdmissionFailures } from './readiness.js';

const WORKSPACE_ID = 'ws_00000000-0000-7000-8000-000000000001';
const roots: string[] = [];

/** Creates an empty rooted admission scope; typed writer results need no retained file. */
function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openkit-boot-walk-'));
  roots.push(root);
  return root;
}

describe('Boot Workspace walk boundary', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each(['unavailable', 'busy'] as const)(
    'stops the walk on a shared writer %s result without holding the current Workspace',
    async (code) => {
      const root = dataRoot();
      const failure = new ControlStoreWorkerError(code, 'not-committed');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await expect(
          withinBootWorkspaceBoundary(
            { dataRoot: root, workspaceId: WORKSPACE_ID, stage: 'pending-request-recovery' },
            () => {
              throw failure;
            }
          )
        ).rejects.toBe(failure);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
      expect(isScopeAdmitted(root, 'workspace', WORKSPACE_ID)).toBe(true);
      expect(scopeAdmissionFailures(root)).toEqual([]);
    }
  );

  it('holds the current Workspace on the writer domain refusal that names it', async () => {
    const root = dataRoot();
    const refusal = new ControlStoreWorkerError('precondition', 'not-committed', {
      operation: 'pending',
      code: 'recovery_required',
      message: 'Pending request Turn association is incomplete.',
      status: 409,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(
        await withinBootWorkspaceBoundary(
          { dataRoot: root, workspaceId: WORKSPACE_ID, stage: 'pending-request-recovery' },
          () => {
            throw refusal;
          }
        )
      ).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        `Boot recovery held Workspace ${WORKSPACE_ID} during pending-request-recovery.`,
        'Control database writer operation failed.'
      );
    } finally {
      warn.mockRestore();
    }
    expect(scopeAdmissionFailures(root)).toEqual([
      {
        scope: 'workspace',
        id: WORKSPACE_ID,
        check: 'recovery',
        stage: 'pending-request-recovery',
      },
    ]);
  });
});
