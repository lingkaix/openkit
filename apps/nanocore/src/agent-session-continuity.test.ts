import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeAgentSessionRecoveryOptions,
  listAvailableSessionSnapshots,
  recordSessionSnapshot,
  selectAgentSessionContinuity,
} from './agent-session-continuity.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';

/** Creates one migrated Core database for continuity tests. */
function createCoreDb() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-agent-session-continuity-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

describe('agent session continuity', () => {
  it('stores session snapshot records without secret-shaped columns', () => {
    const coreDb = createCoreDb();

    try {
      const columns = coreDb.sqlite.prepare('PRAGMA table_info(session_snapshots)').all() as Array<{
        name: string;
      }>;

      expect(columns.map((column) => column.name)).toEqual([
        'snapshot_id',
        'agent_session_id',
        'workspace_id',
        'thread_id',
        'turn_id',
        'aep_snapshot_id',
        'snapshot_kind',
        'backend_handle_ref',
        'session_compatibility_key',
        'content_digest',
        'created_at',
        'expires_at',
        'status',
      ]);
      expect(
        columns.some((column) =>
          /prompt|argument|result|secret|token|credential|password|env|backend_native/i.test(
            column.name
          )
        )
      ).toBe(false);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records and lists available compatible snapshots', () => {
    const coreDb = createCoreDb();

    try {
      recordSessionSnapshot(coreDb, {
        aepSnapshotId: 'aepsnap_1',
        agentSessionId: 'as_1',
        backendHandleRef: 'snapshot-handle:1',
        contentDigest: 'sha256:content',
        createdAt: '2026-07-08T00:00:00.000Z',
        expiresAt: '2026-07-15T00:00:00.000Z',
        sessionCompatibilityKey: 'sha256:compatible',
        snapshotId: 'ss_1',
        snapshotKind: 'runtime-handle',
        status: 'available',
        threadId: 'th_1',
        turnId: 'turn_1',
        workspaceId: 'ws_1',
      });
      recordSessionSnapshot(coreDb, {
        aepSnapshotId: 'aepsnap_2',
        agentSessionId: 'as_2',
        backendHandleRef: 'snapshot-handle:2',
        contentDigest: null,
        createdAt: '2026-07-08T00:00:00.000Z',
        expiresAt: '2026-07-09T00:00:00.000Z',
        sessionCompatibilityKey: 'sha256:other',
        snapshotId: 'ss_2',
        snapshotKind: 'backend-snapshot',
        status: 'available',
        threadId: 'th_1',
        turnId: 'turn_2',
        workspaceId: 'ws_1',
      });

      expect(
        listAvailableSessionSnapshots(coreDb, {
          now: '2026-07-08T12:00:00.000Z',
          sessionCompatibilityKey: 'sha256:compatible',
          threadId: 'th_1',
          workspaceId: 'ws_1',
        })
      ).toMatchObject([{ snapshotId: 'ss_1', snapshotKind: 'runtime-handle' }]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('selects session continuity using strict V1 precedence', () => {
    const selection = selectAgentSessionContinuity({
      now: '2026-07-08T00:00:00.000Z',
      requestedCompatibilityKey: 'sha256:compatible',
      resumeHandles: [
        {
          agentSessionId: 'as_resume',
          sessionCompatibilityKey: 'sha256:compatible',
          status: 'suspended',
        },
      ],
      snapshots: [
        {
          expiresAt: '2026-07-15T00:00:00.000Z',
          sessionCompatibilityKey: 'sha256:compatible',
          snapshotId: 'ss_1',
          status: 'available',
        },
      ],
      liveSessions: [
        {
          agentSessionId: 'as_stale',
          reusable: true,
          sessionCompatibilityKey: 'sha256:other',
          status: 'idle',
        },
        {
          agentSessionId: 'as_live',
          reusable: true,
          sessionCompatibilityKey: 'sha256:compatible',
          status: 'ready',
        },
      ],
    });

    expect(selection.selected).toEqual({ agentSessionId: 'as_live', kind: 'live-session' });
    expect(selection.rejectedCandidates).toContainEqual({
      candidateId: 'as_stale',
      candidateKind: 'live-session',
      reason: 'compatibility-key-mismatch',
    });
  });

  it('falls back to a fresh session when no candidate matches', () => {
    expect(
      selectAgentSessionContinuity({
        now: '2026-07-08T00:00:00.000Z',
        requestedCompatibilityKey: 'sha256:compatible',
        liveSessions: [],
        resumeHandles: [],
        snapshots: [],
      }).selected
    ).toEqual({ kind: 'fresh-session' });
  });

  it('computes recovery options from lease outcomes', () => {
    expect(
      computeAgentSessionRecoveryOptions({
        hasEligibleSnapshot: false,
        leaseStatus: 'failed',
        releaseReason: 'startup-timeout',
      })
    ).toMatchObject({
      defaultOption: 'retry_fresh_session',
      options: ['retry_fresh_session', 'mark_turn_failed'],
      sessionTransition: 'failed',
    });

    expect(
      computeAgentSessionRecoveryOptions({
        hasEligibleSnapshot: true,
        leaseStatus: 'lost',
        releaseReason: 'worker-lost',
      })
    ).toMatchObject({
      defaultOption: 'retry_fresh_session',
      options: [
        'retry_fresh_session',
        'restore_from_snapshot',
        'mark_turn_failed',
        'request_human_decision',
      ],
      sessionTransition: 'failed',
    });
  });
});
