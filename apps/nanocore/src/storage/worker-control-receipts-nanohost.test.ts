// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerCanonicalEventRecord, WorkerLineage } from '@openkit/worker-protocol';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';
import {
  getWorkerControlAcceptedFinalStatus,
  listWorkerControlAcceptedEvents,
  writeWorkerControlAcceptedRecord,
} from '../runtime/worker-control-records.js';
import { listWorkerControlRejectedEvidenceForWorkspace } from '../runtime/worker-control-rejected-evidence.js';

const lineage: WorkerLineage = {
  agentSessionId: 'as_00000000-0000-7e3a-a966-bbf1c9a21fcc',
  packageSnapshotId: 'aepsnap_events_1',
  requestId: 'req_events_1',
  threadId: 'th_00000000-0000-7ccc-992e-e88b1e35ca99',
  turnId: 'tu_00000000-0000-7056-a6b5-80ab0aaa7f63',
  workspaceId: 'ws_00000000-0000-708d-8de8-225685139ab1',
};

it('reopens exact Worker receipts and keeps evidence scoped to their original owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-worker-receipts-'));
  const path = join(root, 'state.sqlite');
  const acceptedAt = '2026-11-20T00:00:00.000Z';
  const heartbeat: WorkerCanonicalEventRecord = {
    kind: 'event',
    schemaVersion: 1,
    sequence: 1,
    lineage,
    event: { type: 'worker.heartbeat', data: { status: 'running' } },
  };
  const final = {
    lineage,
    operation: 'final_status',
    recordKey: 'final',
    record: { status: 'completed', stopReason: 'completed' },
    acceptedAt,
  };
  let sqlite = new Database(path);
  try {
    migrate(drizzle(sqlite), {
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle/extensions/nanohost/', import.meta.url)
      ),
    });
    sqlite.transaction(() => {
      writeWorkerControlAcceptedRecord(
        { sqlite },
        {
          lineage,
          operation: 'event_append',
          recordKey: String(heartbeat.sequence),
          sequence: heartbeat.sequence,
          record: heartbeat,
          acceptedAt,
        }
      );
      writeWorkerControlAcceptedRecord({ sqlite }, final);
      // Seed the existing worker-entry rejection tuple for the owner-local reader.
      sqlite
        .prepare(`INSERT INTO worker_control_rejected_evidence (
        rejection_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
        request_id, route, operation, error_code, http_status, message, rejected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'worker-control', 'event_append', 'lineage-mismatch', 403,
        'Worker control lineage did not match.', ?)`)
        .run(
          'fixture-rejection',
          lineage.workspaceId,
          lineage.threadId,
          lineage.turnId,
          lineage.agentSessionId,
          lineage.packageSnapshotId,
          lineage.requestId,
          acceptedAt
        );
    })();

    sqlite.close();
    sqlite = new Database(path, { fileMustExist: true });
    expect(listWorkerControlAcceptedEvents({ sqlite }, lineage)).toEqual([heartbeat]);
    const otherRequest = { ...lineage, requestId: 'req_other' };
    expect(listWorkerControlAcceptedEvents({ sqlite }, otherRequest)).toEqual([]);
    expect(getWorkerControlAcceptedFinalStatus({ sqlite }, otherRequest)).toBeNull();
    expect(() =>
      sqlite.transaction(() =>
        writeWorkerControlAcceptedRecord(
          { sqlite },
          {
            ...final,
            record: { status: 'failed', stopReason: 'error' },
          }
        )
      )()
    ).toThrow('worker receipt identity conflict');
    const replay = { ...final, acceptedAt: '2026-11-20T00:00:01.000Z' };
    sqlite.transaction(() => writeWorkerControlAcceptedRecord({ sqlite }, replay))();
    expect(getWorkerControlAcceptedFinalStatus({ sqlite }, lineage)).toEqual({
      ...final.record,
      acceptedAt,
    });
    expect(
      listWorkerControlRejectedEvidenceForWorkspace({ sqlite }, lineage.workspaceId)
    ).toMatchObject([
      {
        ...lineage,
        rejectionId: 'fixture-rejection',
        operation: 'event_append',
        httpStatus: 403,
        rejectedAt: acceptedAt,
      },
    ]);
    expect(listWorkerControlRejectedEvidenceForWorkspace({ sqlite }, 'ws_other')).toEqual([]);
  } finally {
    if (sqlite.open) sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
