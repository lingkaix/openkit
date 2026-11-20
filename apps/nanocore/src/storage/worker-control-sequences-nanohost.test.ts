// openkit-test-platform: posix
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it, onTestFinished } from 'vitest';
import type { WorkerControlSequenceRecorderInput } from '../runtime/worker-control-gateway.js';
import {
  createWorkerControlSequenceRecorder,
  matchesAcceptedWorkerControlSequence,
} from '../runtime/worker-control-sequences.js';
import { nanoHostStoreDescriptor } from './nanohost-store-descriptor.js';

const migrationsFolder = fileURLToPath(
  new URL('../../drizzle/extensions/nanohost/', import.meta.url)
);
const original: WorkerControlSequenceRecorderInput = {
  lineage: {
    workspaceId: 'fixture-workspace',
    threadId: 'fixture-thread',
    turnId: 'fixture-turn',
    agentSessionId: 'fixture-session',
    packageSnapshotId: 'fixture-package',
    requestId: 'fixture-request',
  },
  operation: 'supply_refresh_ack',
  sequence: 3,
  fingerprint: '{"status":"applied","sequence":3,"refreshId":"fixture-refresh"}',
};
const equivalent = {
  ...original,
  fingerprint: '{"refreshId":"fixture-refresh","sequence":3,"status":"applied"}',
};
const conflicting = {
  ...original,
  fingerprint: '{"refreshId":"fixture-refresh","sequence":3,"status":"rejected"}',
};
const older = { ...original, sequence: 2, fingerprint: '{"sequence":2}' };
const later = { ...original, sequence: 7, fingerprint: '{"sequence":7}' };

it('reopens NanoHost fingerprints and isolates exact replay, refusal and stream progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-control-sequences-'));
  const path = join(root, 'server/extensions', nanoHostStoreDescriptor.owner, 'state.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  let sqlite = new Database(path);
  onTestFinished(() => {
    if (sqlite.open) sqlite.close();
    rmSync(root, { force: true, recursive: true });
  });
  migrate(drizzle(sqlite), { migrationsFolder });

  const accept = (input: WorkerControlSequenceRecorderInput) =>
    sqlite.transaction(() => createWorkerControlSequenceRecorder({ sqlite }).accept(input))();
  const rows = () =>
    sqlite
      .prepare(
        'SELECT * FROM worker_control_sequence_fingerprints ORDER BY agent_session_id, package_snapshot_id, operation, sequence'
      )
      .all();

  expect(accept(original)).toEqual({
    status: 'accepted',
    duplicate: false,
    nextExpectedSequence: 4,
  });
  expect(accept(later)).toEqual({ status: 'accepted', duplicate: false, nextExpectedSequence: 8 });
  const recorded = rows();
  expect(recorded[0]).toEqual({
    workspace_id: original.lineage.workspaceId,
    thread_id: original.lineage.threadId,
    turn_id: original.lineage.turnId,
    agent_session_id: original.lineage.agentSessionId,
    package_snapshot_id: original.lineage.packageSnapshotId,
    request_id: original.lineage.requestId,
    operation: original.operation,
    sequence: original.sequence,
    fingerprint: original.fingerprint,
    accepted_at: expect.any(String),
  });
  sqlite.close();

  sqlite = new Database(path, { fileMustExist: true, readonly: true });
  expect(
    sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name"
      )
      .pluck()
      .all()
  ).toEqual(nanoHostStoreDescriptor.requiredTables);
  expect(matchesAcceptedWorkerControlSequence({ sqlite }, equivalent)).toBe(true);
  expect(matchesAcceptedWorkerControlSequence({ sqlite }, conflicting)).toBe(false);
  expect(matchesAcceptedWorkerControlSequence({ sqlite }, older)).toBeNull();
  expect(rows()).toEqual(recorded);
  sqlite.close();

  sqlite = new Database(path, { fileMustExist: true });
  expect(accept(equivalent)).toEqual({
    status: 'accepted',
    duplicate: true,
    nextExpectedSequence: 8,
  });
  expect(accept(conflicting)).toMatchObject({
    status: 'conflict',
    code: 'worker_control_sequence_conflict',
  });
  expect(accept(older)).toMatchObject({ status: 'stale', code: 'worker_control_sequence_stale' });
  expect(rows()).toEqual(recorded);

  const malformed = { ...later, fingerprint: '{' };
  expect(
    sqlite
      .prepare(
        `UPDATE worker_control_sequence_fingerprints SET fingerprint = ?
         WHERE agent_session_id = ? AND package_snapshot_id = ? AND operation = ? AND sequence = ?`
      )
      .run(
        malformed.fingerprint,
        later.lineage.agentSessionId,
        later.lineage.packageSnapshotId,
        later.operation,
        later.sequence
      ).changes
  ).toBe(1);
  const damaged = rows();
  expect(matchesAcceptedWorkerControlSequence({ sqlite }, malformed)).toBe(false);
  expect(accept(malformed)).toMatchObject({
    status: 'conflict',
    code: 'worker_control_sequence_conflict',
  });
  expect(rows()).toEqual(damaged);

  for (const independent of [
    { ...older, operation: 'heartbeat' },
    { ...older, lineage: { ...older.lineage, agentSessionId: 'fixture-other-session' } },
    { ...older, lineage: { ...older.lineage, packageSnapshotId: 'fixture-other-package' } },
  ]) {
    expect(accept(independent)).toEqual({
      status: 'accepted',
      duplicate: false,
      nextExpectedSequence: 3,
    });
  }
  expect(accept(equivalent)).toEqual({
    status: 'accepted',
    duplicate: true,
    nextExpectedSequence: 8,
  });
  expect(matchesAcceptedWorkerControlSequence({ sqlite }, malformed)).toBe(false);
});
