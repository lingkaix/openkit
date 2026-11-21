// openkit-test-platform: posix
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonText } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { commandInputHash } from '../runtime/idempotent-command.js';
import {
  createNanoHostHarnessRuntime,
  openNanoHostAgentSessionBinding,
} from '../runtime/nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  getNanoHostRuntimeTarget,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target-records.js';
import {
  bindNanoHostWorkerRoutes,
  getWorkerBackendSession,
  listWorkerBackendSessions,
  markWorkerBackendWorkspaceHandoffComplete,
  readNanoHostSubmissionPlacement,
  readNanoHostWorkerRouteBinding,
  transitionWorkerBackendSessionState,
  type WorkerBackendSessionRecord,
} from '../runtime/worker-backend-session-records.js';
import type { ExecutionGrant } from './control-kernel-port.js';
import { createNanoHostCoreReads } from './nanohost-core-reads.js';
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
  const observations = createNanoHostCoreReads({
    read: (query) => ({ state: 'ready', value: query(sqlite) }),
  });
  expect(observations.readBackendSession({ attemptId: original.attemptId })).toStrictEqual({
    state: 'ready',
    value: handedOff,
  });
  expect(
    observations.readBackendSession({ packageSnapshotId: sibling.packageSnapshotId })
  ).toStrictEqual({
    state: 'ready',
    value: siblingCleaned,
  });
});

it('matches only the original materialized RuntimeTarget generation for a first Core submit grant and retains its exact routes', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-submit-placement-'));
  const path = join(root, 'state.sqlite');
  let sqlite = new Database(path);
  onTestFinished(() => {
    if (sqlite.open) sqlite.close();
    rmSync(root, { force: true, recursive: true });
  });
  migrate(drizzle(sqlite), { migrationsFolder });
  const identityId = 'original-native-identity';
  const targetInput = {
    deploymentId: original.deploymentId,
    identityId,
    targetId: original.runtimeTargetId,
    observedAt: original.createdAt,
  };
  const ready = (target: ReturnType<typeof allocateNanoHostRuntimeTargetConnectionGeneration>) =>
    upsertNanoHostRuntimeTarget(
      { sqlite },
      {
        ...target,
        freshEmpty: true,
        predecessorFenced: true,
        ready: true,
        physicalEpoch: original.originPhysicalEpoch,
      }
    );
  sqlite
    .transaction(() => {
      seedNativeSessions(sqlite);
      sqlite
        .prepare(`UPDATE worker_backend_sessions
      SET state = 'materialized', backend_kind = 'openshell', transient_provider_instance_id = NULL
      WHERE attempt_id = ?`)
        .run(original.attemptId);
      ready(allocateNanoHostRuntimeTargetConnectionGeneration({ sqlite }, targetInput));
    })
    .immediate();

  const expected = {
    workspaceId: original.workspaceId,
    threadId: original.threadId,
    agentSessionId: original.agentSessionId,
    runtimeTargetId: original.runtimeTargetId,
    deploymentId: original.deploymentId,
    physicalEpoch: original.originPhysicalEpoch,
    identityId,
  };
  const grant: ExecutionGrant = {
    attemptId: original.attemptId,
    turnId: original.turnId,
    backendId: 'nanohost',
    bindingRef: original.sandboxBindingRef,
    inputRef: original.packageSnapshotId,
    generation: '1',
    operationId: commandInputHash({
      attemptId: original.attemptId,
      inputRef: original.packageSnapshotId,
      operation: 'submit',
    }),
    execution: { owner: { kind: 'server' }, executionId: original.attemptId },
    deadline: '2026-11-20T00:10:00.000Z',
  };
  const inspect = (value = grant, placement = expected) =>
    readNanoHostSubmissionPlacement({ sqlite }, value, placement);
  expect(inspect()).toBeNull();
  sqlite
    .transaction(() =>
      markWorkerBackendWorkspaceHandoffComplete({ sqlite }, { attemptId: original.attemptId })
    )
    .immediate();
  sqlite.close();
  sqlite = new Database(path, { fileMustExist: true });
  expect(inspect()).toMatchObject({
    attemptId: original.attemptId,
    packageSnapshotId: original.packageSnapshotId,
    workspaceHandoffState: 'complete',
  });
  expect(inspect({ ...grant, operationId: 'changed-submit' })).toBeNull();
  expect(inspect({ ...grant, bindingRef: sibling.sandboxBindingRef })).toBeNull();
  expect(inspect({ ...grant, turnId: sibling.turnId })).toBeNull();
  expect(inspect(grant, { ...expected, threadId: sibling.threadId })).toBeNull();
  expect(inspect(grant, { ...expected, physicalEpoch: 'b'.repeat(64) })).toBeNull();

  const command = {
    harnessInstanceId: 'original-harness',
    operationId: '7'.repeat(64),
    sequence: 9,
  };
  const bindingId = 'original-agent-session-binding';
  const originalBody = {
    leaseId: grant.attemptId,
    packageSnapshotId: grant.inputRef,
    turnId: grant.turnId,
    deadline: grant.deadline,
    threadId: expected.threadId,
    workspaceId: expected.workspaceId,
    agentSessionId: expected.agentSessionId,
    agentSessionRuntimeBindingId: bindingId,
    workerControlTokenHash: 'a'.repeat(64),
    inferenceTokenHash: 'b'.repeat(64),
    capabilityTokenHash: 'c'.repeat(64),
  };
  const stageCommand = (operationId: string, body: typeof originalBody) => {
    const json = canonicalJsonText(body);
    const digest = sha256Hex(json);
    sqlite
      .prepare(`UPDATE harness_instance_records
      SET operation = 'turn.start', operation_state = 'queued',
          operation_id = ?, operation_sequence = ?, command_body_json = ?, command_fingerprint = ?
      WHERE harness_instance_id = ?`)
      .run(operationId, command.sequence, json, digest, command.harnessInstanceId);
  };
  sqlite
    .transaction(() => {
      sqlite
        .prepare("UPDATE worker_backend_sessions SET state = 'launching' WHERE attempt_id = ?")
        .run(grant.attemptId);
      createNanoHostHarnessRuntime(
        { sqlite },
        {
          adapterId: 'pi',
          adapterVersion: 'fixture',
          harnessBindingRef: 'original-harness-binding',
          harnessCompatibilityKey: 'b'.repeat(64),
          harnessInstanceId: command.harnessInstanceId,
          imageDigest: `sha256:${'a'.repeat(64)}`,
          originPhysicalEpoch: expected.physicalEpoch,
          runtimeTargetId: expected.runtimeTargetId,
          sandboxBindingRef: original.sandboxBindingRef,
          sandboxCompatibilityKey: 'c'.repeat(64),
          sandboxIntegrationBindingRef: 'original-sandbox-integration',
          sandboxRuntimeId: 'original-sandbox',
          timestamp: targetInput.observedAt,
        }
      );
      openNanoHostAgentSessionBinding(
        { sqlite },
        {
          agentSessionCompatibilityKey: 'd'.repeat(64),
          agentSessionId: expected.agentSessionId,
          agentSessionRuntimeBindingId: bindingId,
          effectiveSetupGeneration: 1,
          harnessInstanceId: command.harnessInstanceId,
          threadId: expected.threadId,
          workspaceId: expected.workspaceId,
          timestamp: targetInput.observedAt,
        }
      );
      stageCommand(command.operationId, originalBody);
    })
    .immediate();
  const bind = (request = command) =>
    sqlite
      .transaction(() => bindNanoHostWorkerRoutes({ sqlite }, grant, expected, request))
      .immediate();
  expect(() => bind({ ...command, sequence: 10 })).toThrow('no exact queued command');
  expect(readNanoHostWorkerRouteBinding({ sqlite }, grant)).toBeNull();
  expect(bind()).toBe('bound-now');
  expect(bind()).toBe('already-bound');
  const receipt = {
    version: 1,
    operationId: grant.operationId,
    generation: grant.generation,
    deadline: grant.deadline,
    control: originalBody.workerControlTokenHash,
    inference: originalBody.inferenceTokenHash,
    capability: originalBody.capabilityTokenHash,
    harnessInstanceId: command.harnessInstanceId,
    harnessOperationId: command.operationId,
    harnessSequence: command.sequence,
  };
  expect(readNanoHostWorkerRouteBinding({ sqlite }, grant)).toEqual(receipt);

  stageCommand(command.operationId, { ...originalBody, workerControlTokenHash: 'd'.repeat(64) });
  expect(() => bind()).toThrow('conflicts with the original');
  const successorOperationId = '8'.repeat(64);
  const successor = { ...command, operationId: successorOperationId };
  stageCommand(successorOperationId, { ...originalBody, workerControlTokenHash: 'd'.repeat(64) });
  expect(() => bind(successor)).toThrow('conflicts with the original');

  // The same physical Epoch can be observed by a successor connection. Its generation is distinct.
  sqlite
    .transaction(() =>
      ready(
        allocateNanoHostRuntimeTargetConnectionGeneration(
          { sqlite },
          { ...targetInput, observedAt: '2026-11-20T00:00:02.000Z' }
        )
      )
    )
    .immediate();
  expect(getNanoHostRuntimeTarget({ sqlite }, original.runtimeTargetId)?.connectionGeneration).toBe(
    2
  );
  expect(inspect()).toBeNull();
  expect(() => bind(successor)).toThrow('no current submission');
  sqlite.close();
  sqlite = new Database(path, { fileMustExist: true, readonly: true });
  expect(readNanoHostWorkerRouteBinding({ sqlite }, grant)).toEqual(receipt);
  expect(readNanoHostWorkerRouteBinding({ sqlite }, { ...grant, generation: '2' })).toBeNull();
});
