import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListHumanAttentionResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createPolicyApprovalGate } from './approval-gates.js';

describe('policy approval gates', () => {
  it('creates a durable approval gate and exposes it through Action Center', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-policy-approval-'));
    const coreDb = openCoreDb(dataRoot);
    const workspaceDb = openWorkspaceDb(dataRoot, LOCAL_USER_ID, 'ws_demo');
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Policy approval');
    const turn = store.createTurn('ws_demo', thread.id, 'Use a protected resource');

    try {
      applyMigrations(coreDb);
      applyScopedMigrations(workspaceDb);

      const gate = createPolicyApprovalGate({
        approvalId: 'ap_policy_gate',
        approvalItemId: 'it_policy_gate',
        decisionId: 'pd_policy_gate',
        description: 'Policy requires approval before using the protected resource.',
        reasonCode: 'approval_required',
        resourceSummary: { kind: 'vault-reference', id: 'vault_demo' },
        store,
        subjectSummary: { kind: 'agent', id: 'agent_demo' },
        title: 'Approve protected resource use',
        turnId: turn.id,
        workspaceDb,
        workspaceId: 'ws_demo',
      });

      expect(gate).toEqual({
        approvalId: 'ap_policy_gate',
        approvalItemId: 'it_policy_gate',
        decisionId: 'pd_policy_gate',
      });
      expect(store.getTurnById(turn.id)).toMatchObject({
        humanGate: {
          approvalRequestId: 'ap_policy_gate',
          itemId: 'it_policy_gate',
          kind: 'approval',
        },
        status: 'awaiting_human',
      });
      expect(
        store.listThreadItems('ws_demo', thread.id).find((item) => item.id === 'it_policy_gate')
      ).toMatchObject({ status: 'completed', completedAt: expect.any(String) });
      expect(permissionDecision(workspaceDb, 'pd_policy_gate')).toMatchObject({
        action: 'repo.push',
        approval_id: 'ap_policy_gate',
        policy_engine_version: 'nanocore-approval-policy:v1',
        required_approval_kind: 'permission',
        result: 'require_approval',
      });

      const app = createApp({ store });
      const res = await app.request('/api/app/workspaces/ws_demo/action-center');
      const rows = ListHumanAttentionResponseSchema.parse(await res.json()).items;

      expect(rows).toContainEqual(
        expect.objectContaining({
          id: 'approval:ap_policy_gate',
          itemId: 'it_policy_gate',
          kind: 'approval',
          title: 'Approve protected resource use',
        })
      );

      expect(() =>
        createPolicyApprovalGate({
          approvalId: 'ap_duplicate_policy_gate',
          approvalItemId: 'it_duplicate_policy_gate',
          decisionId: 'pd_duplicate_policy_gate',
          description: 'Do not create a second Gate on an awaiting-human Turn.',
          reasonCode: 'approval_required',
          resourceSummary: { kind: 'vault-reference', id: 'vault_demo' },
          store,
          subjectSummary: { kind: 'agent', id: 'agent_demo' },
          title: 'Duplicate protected resource use',
          turnId: turn.id,
          workspaceDb,
          workspaceId: 'ws_demo',
        })
      ).toThrow('Git push approval requires one exact running Turn owner.');
      expect(permissionDecision(workspaceDb, 'pd_duplicate_policy_gate')).toBeUndefined();
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});

/**
 * Reads one permission decision row.
 *
 * @param workspaceDb Workspace database handle.
 * @param decisionId Permission decision id.
 * @returns Permission decision row.
 */
function permissionDecision(
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  decisionId: string
):
  | {
      action: string;
      approval_id: string | null;
      policy_engine_version: string;
      required_approval_kind: string | null;
      result: string;
    }
  | undefined {
  return workspaceDb.sqlite
    .prepare(
      `SELECT action, approval_id, policy_engine_version, required_approval_kind, result
       FROM permission_decisions
       WHERE decision_id = ?`
    )
    .get(decisionId) as
    | {
        action: string;
        approval_id: string | null;
        policy_engine_version: string;
        required_approval_kind: string | null;
        result: string;
      }
    | undefined;
}
