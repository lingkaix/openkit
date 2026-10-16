import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  claimCommandIntentGrant,
  grantCommandIntentRequest,
  isReadyOutcome,
  type RaisePendingRequestInput,
  raisePendingRequest,
  readPendingRequest,
} from './pending-requests.js';

describe('Coordinator command-intent approvals', () => {
  it('keeps the Coordinator an agent requester without an AgentSession and grants without execution', () => {
    const db = openWorkspaceDb(
      mkdtempSync(join(tmpdir(), 'goal-pending-')),
      'ws_00000000-0000-7509-8702-098e8909b075'
    );
    applyScopedMigrations(db);
    try {
      const now = '2026-10-03T00:00:00.000Z';
      const input = {
        requestId: 'ap_goal',
        workspaceId: 'ws_00000000-0000-7509-8702-098e8909b075',
        threadId: 'th_00000000-0000-7bc1-aed1-ff6f35ab7b65',
        raisingTurnId: 'tu_00000000-0000-748d-8622-d33db859c534',
        requestItemId: 'it_00000000-0000-7da3-b08c-1a4235667c94',
        kind: 'approval',
        requesterKind: 'coordinator',
        agentId: 'goal-coordinator',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
        governedIntent: {
          operation: 'goal.plan.approve',
          goalId: 'g_1',
          planVersionId: 'p_1',
          digest: 'sha256:exact',
        },
        approval: {
          kind: 'permission',
          title: 'Approve exact Plan',
          description: 'One exact commitment.',
        },
        now,
      } as unknown as RaisePendingRequestInput;
      const raised = raisePendingRequest(db.sqlite, input).record;
      expect(raised.requesterKind).toBe('coordinator');
      expect(raised.agentSessionId).toBeNull();
      expect(
        grantCommandIntentRequest(
          db.sqlite,
          raised.requestId,
          { kind: 'user', id: 'usr_00000000-0000-7e66-bb42-be696dd8b8a2' },
          now
        )
      ).toMatchObject({
        requesterKind: 'coordinator',
        resolution: 'granted',
        claim: 'unclaimed',
        disposition: null,
        decidingActor: { kind: 'user', id: 'usr_00000000-0000-7e66-bb42-be696dd8b8a2' },
      });
      expect(isReadyOutcome(readPendingRequest(db.sqlite, raised.requestId)!)).toBe(true);
      expect(claimCommandIntentGrant(db.sqlite, raised.requestId, now)?.claim).toBe('claimed');
      expect(claimCommandIntentGrant(db.sqlite, raised.requestId, now)).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });
});
