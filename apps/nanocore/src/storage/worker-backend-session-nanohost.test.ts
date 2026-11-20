// openkit-test-platform: posix
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it, onTestFinished } from 'vitest';
import {
  getWorkerBackendSession,
  listWorkerBackendSessions,
  markWorkerBackendWorkspaceHandoffComplete,
  transitionWorkerBackendSessionState,
  type WorkerBackendSessionRecord,
} from '../runtime/worker-backend-session-records.js';
import { nanoHostStoreDescriptor } from './nanohost-store-descriptor.js';

const migrationsFolder = fileURLToPath(
  new URL('../../drizzle/extensions/nanohost/', import.meta.url)
);
const original: WorkerBackendSessionRecord = {
  attemptId: 'fixture-attempt-a',
  workspaceId: 'fixture-workspace',
  threadId: 'fixture-thread-a',
  turnId: 'fixture-turn-a',
  agentSessionId: 'fixture-agent-session-a',
  packageSnapshotId: 'fixture-package-a',
  backendKind: 'nanohost',
  deploymentId: 'fixture-deployment',
  backendVersion: 'fixture-backend-v1',
  runtimeTargetId: 'fixture-target',
  originPhysicalEpoch: 'a'.repeat(64),
  backendLineage: {
    buildArgumentsDigest: `sha256:${'b'.repeat(64)}`,
    buildContextDigest: `sha256:${'c'.repeat(64)}`,
    buildInputDigest: `sha256:${'d'.repeat(64)}`,
    resultingImageDigest: `sha256:${'e'.repeat(64)}`,
  },
  sandboxBindingRef: 'fixture-sandbox-binding-a',
  backendSessionId: 'fixture-native-session-a',
  stagingDirectoryRef: 'server/runtime/worker-backend-sessions/fixture-package-a',
  transientProviderInstanceId: 'fixture-provider-a',
  workspaceHandoffState: 'pending',
  state: 'cleanup-pending',
  physicalCleanedAt: null,
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:01.000Z',
};
const sibling: WorkerBackendSessionRecord = {
  ...original,
  attemptId: 'fixture-attempt-b',
  threadId: 'fixture-thread-b',
  turnId: 'fixture-turn-b',
  agentSessionId: 'fixture-agent-session-b',
  packageSnapshotId: 'fixture-package-b',
  backendLineage: { imageRef: `sha256:${'f'.repeat(64)}` },
  sandboxBindingRef: 'fixture-sandbox-binding-b',
  backendSessionId: 'fixture-native-session-b',
  stagingDirectoryRef: 'server/runtime/worker-backend-sessions/fixture-package-b',
  transientProviderInstanceId: null,
};

/** Seeds physical evidence using the extension schema without creating a Core attempt. */
function seedNativeSessions(sqlite: Database.Database) {
  const insert = sqlite.prepare(`INSERT INTO worker_backend_sessions (
    attempt_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
    backend_kind, deployment_id, backend_version, runtime_target_id, origin_physical_epoch,
    backend_lineage_json, sandbox_binding_ref, backend_session_id, staging_directory_ref,
    transient_provider_instance_id, workspace_handoff_state, state, physical_cleaned_at,
    created_at, updated_at
  ) VALUES (
    @attemptId, @workspaceId, @threadId, @turnId, @agentSessionId, @packageSnapshotId,
    @backendKind, @deploymentId, @backendVersion, @runtimeTargetId, @originPhysicalEpoch,
    @backendLineageJson, @sandboxBindingRef, @backendSessionId, @stagingDirectoryRef,
    @transientProviderInstanceId, @workspaceHandoffState, @state, @physicalCleanedAt,
    @createdAt, @updatedAt
  )`);
  for (const { backendLineage, ...session } of [sibling, original]) {
    insert.run({ ...session, backendLineageJson: JSON.stringify(backendLineage) });
  }
}

it('reopens exact NanoHost backend sessions and records cleanup and handoff independently', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-backend-sessions-'));
  const path = join(root, 'server/extensions', nanoHostStoreDescriptor.owner, 'state.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  let sqlite = new Database(path);
  onTestFinished(() => {
    if (sqlite.open) sqlite.close();
    rmSync(root, { force: true, recursive: true });
  });
  migrate(drizzle(sqlite), { migrationsFolder });
  sqlite.transaction(() => seedNativeSessions(sqlite)).immediate();
  sqlite.close();

  sqlite = new Database(path, { fileMustExist: true });
  const owner = { sqlite };
  expect(
    sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name"
      )
      .pluck()
      .all()
  ).toStrictEqual(nanoHostStoreDescriptor.requiredTables);
  expect(getWorkerBackendSession(owner, original.attemptId)).toStrictEqual(original);
  expect(listWorkerBackendSessions(owner)).toStrictEqual([original, sibling]);

  const cleanup = (attemptId: string, timestamp: string) =>
    sqlite
      .transaction(() =>
        transitionWorkerBackendSessionState(
          { sqlite },
          {
            attemptId,
            fromState: 'cleanup-pending',
            toState: 'physical-cleaned',
            now: () => timestamp,
          }
        )
      )
      .immediate();
  const handoff = (attemptId: string, timestamp: string) =>
    sqlite
      .transaction(() =>
        markWorkerBackendWorkspaceHandoffComplete({ sqlite }, { attemptId, now: () => timestamp })
      )
      .immediate();

  const cleanupAt = '2026-11-20T00:00:02.000Z';
  const physicallyCleaned = {
    ...original,
    state: 'physical-cleaned',
    physicalCleanedAt: cleanupAt,
    updatedAt: cleanupAt,
  };
  expect(cleanup(original.attemptId, cleanupAt)).toStrictEqual(physicallyCleaned);
  expect(listWorkerBackendSessions(owner)).toStrictEqual([physicallyCleaned, sibling]);

  const handoffAt = '2026-11-20T00:00:03.000Z';
  const handedOff = {
    ...physicallyCleaned,
    workspaceHandoffState: 'complete',
    updatedAt: handoffAt,
  };
  expect(handoff(original.attemptId, handoffAt)).toStrictEqual(handedOff);
  expect(listWorkerBackendSessions(owner)).toStrictEqual([handedOff, sibling]);

  // The sibling commits handoff first. Its later cleanup preserves the completed handoff.
  const siblingHandoff = { ...sibling, workspaceHandoffState: 'complete', updatedAt: handoffAt };
  expect(handoff(sibling.attemptId, handoffAt)).toStrictEqual(siblingHandoff);
  expect(listWorkerBackendSessions(owner)).toStrictEqual([handedOff, siblingHandoff]);
  const siblingCleanupAt = '2026-11-20T00:00:04.000Z';
  const siblingCleaned = {
    ...siblingHandoff,
    state: 'physical-cleaned',
    physicalCleanedAt: siblingCleanupAt,
    updatedAt: siblingCleanupAt,
  };
  expect(cleanup(sibling.attemptId, siblingCleanupAt)).toStrictEqual(siblingCleaned);
  const settled = [handedOff, siblingCleaned];
  expect(listWorkerBackendSessions(owner)).toStrictEqual(settled);

  sqlite.close();
  sqlite = new Database(path, { fileMustExist: true });
  const reopened = { sqlite };
  expect(listWorkerBackendSessions(reopened)).toStrictEqual(settled);
  const retryAt = '2026-11-20T00:00:05.000Z';
  expect(() => cleanup(original.attemptId, retryAt)).toThrow(
    /^Worker backend session state changed before transition\.$/
  );
  expect(listWorkerBackendSessions(reopened)).toStrictEqual(settled);
  expect(() => handoff(original.attemptId, retryAt)).toThrow(
    /^Worker backend workspace handoff changed before publication\.$/
  );
  expect(listWorkerBackendSessions(reopened)).toStrictEqual(settled);

  sqlite.close();
  sqlite = new Database(path, { fileMustExist: true, readonly: true });
  expect(listWorkerBackendSessions({ sqlite })).toStrictEqual(settled);
});
