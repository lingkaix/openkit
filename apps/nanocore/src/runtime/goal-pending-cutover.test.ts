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
    const db = openWorkspaceDb(mkdtempSync(join(tmpdir(), 'goal-pending-')), 'ws_goal');
    applyScopedMigrations(db);
    try {
      const now = '2026-10-03T00:00:00.000Z';
      const input = {
        requestId: 'ap_goal',
        workspaceId: 'ws_goal',
        threadId: 'th_goal',
        raisingTurnId: 'tu_goal',
        requestItemId: 'it_goal',
        kind: 'approval',
        requesterKind: 'coordinator',
        agentId: 'goal-coordinator',
        responsibleUserId: 'user_local',
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
        grantCommandIntentRequest(db.sqlite, raised.requestId, { kind: 'user', id: 'admin' }, now)
      ).toMatchObject({
        requesterKind: 'coordinator',
        resolution: 'granted',
        claim: 'unclaimed',
        disposition: null,
        decidingActor: { kind: 'user', id: 'admin' },
      });
      expect(isReadyOutcome(readPendingRequest(db.sqlite, raised.requestId)!)).toBe(true);
      expect(claimCommandIntentGrant(db.sqlite, raised.requestId, now)?.claim).toBe('claimed');
      expect(claimCommandIntentGrant(db.sqlite, raised.requestId, now)).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });
});
