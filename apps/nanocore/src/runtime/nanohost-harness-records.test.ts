import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
} from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createNanoHostHarnessRuntime,
  dispatchNanoHostHarnessOperation,
  listNanoHostMeasuredHarnessIdentities,
  markNanoHostHarnessOperationUnknown,
  openNanoHostAgentSessionBinding,
  queueNanoHostHarnessOperation,
  readNanoHostMeasuredHarnessIdentity,
  readNanoHostThreadAgentSessionBinding,
  removeNanoHostSandboxRuntimeForHarness,
  settleNanoHostHarnessOperation,
} from './nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import { recordWorkerControlAcceptedRecord } from './worker-control-records.js';

const now = '2098-08-21T00:00:00.000Z';
const physicalEpoch = 'e'.repeat(64);

describe('private NanoHost Harness records', () => {
  it('retains two compatibility-keyed Harnesses in one Sandbox', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-multi-harness-records-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      for (const [adapterId, adapterVersion, harnessInstanceId, compatibilityKey] of [
        ['codex', '0.153.4', 'harness-codex', 'b'.repeat(64)],
        ['opencode', '1.18.1', 'harness-opencode', 'c'.repeat(64)],
      ] as const) {
        createNanoHostHarnessRuntime(coreDb, {
          adapterId,
          adapterVersion,
          harnessBindingRef: `binding-${harnessInstanceId}`,
          harnessCompatibilityKey: compatibilityKey,
          harnessInstanceId,
          imageDigest: `sha256:${'f'.repeat(64)}`,
          originPhysicalEpoch: physicalEpoch,
          sandboxBindingRef: 'sandbox-binding-shared',
          sandboxCompatibilityKey: 'a'.repeat(64),
          sandboxIntegrationBindingRef: 'integration-binding-shared',
          sandboxRuntimeId: 'sandbox-runtime-shared',
          runtimeTargetId: 'nanohost-a1',
          timestamp: now,
        });
      }

      expect(
        coreDb.sqlite
          .prepare(
            'SELECT adapter_id AS adapterId, harness_compatibility_key AS harnessCompatibilityKey FROM harness_instance_records ORDER BY adapter_id'
          )
          .all()
      ).toEqual([
        { adapterId: 'codex', harnessCompatibilityKey: 'b'.repeat(64) },
        { adapterId: 'opencode', harnessCompatibilityKey: 'c'.repeat(64) },
      ]);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('expires a never-polled command from its enqueue time and never delivers it late', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-enqueue-budget-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-expiry',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-expiry',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-expiry',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-expiry',
        sandboxRuntimeId: 'sandbox-runtime-expiry',
        runtimeTargetId: 'nanohost-a1',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {},
        harnessInstanceId: 'harness-expiry',
        operation: 'harness.drain',
        timestamp: '2026-08-21T00:00:01.000Z',
      });
      expect(
        dispatchNanoHostHarnessOperation(coreDb, {
          now: () => '2026-08-21T00:05:01.000Z',
          sandboxIntegrationBindingRef: 'integration-binding-expiry',
        })
      ).toBeNull();
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT operation_state AS operationState, lifecycle_state AS lifecycleState FROM harness_instance_records WHERE harness_instance_id = ?'
          )
          .get('harness-expiry')
      ).toEqual({ lifecycleState: 'failed', operationState: 'unknown' });
      expect(
        dispatchNanoHostHarnessOperation(coreDb, {
          now: () => '2026-08-21T00:05:02.000Z',
          sandboxIntegrationBindingRef: 'integration-binding-expiry',
        })
      ).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses Sandbox publication when the pre-effect physical Epoch is no longer current', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-sandbox-epoch-race-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      const replacement = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-a1',
        identityId: 'nanohost-a1',
        observedAt: '2098-08-21T00:00:01.000Z',
        targetId: 'nanohost-a1',
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        ...replacement,
        freshEmpty: true,
        observedAt: '2098-08-21T00:00:02.000Z',
        physicalEpoch: 'f'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      expect(() =>
        createNanoHostHarnessRuntime(coreDb, {
          adapterId: 'codex',
          adapterVersion: '0.153.4',
          harnessBindingRef: 'harness-binding-old-epoch',
          harnessCompatibilityKey: 'd'.repeat(64),
          harnessInstanceId: 'harness-old-epoch',
          imageDigest: `sha256:${'f'.repeat(64)}`,
          originPhysicalEpoch: physicalEpoch,
          sandboxBindingRef: 'sandbox-binding-old-epoch',
          sandboxCompatibilityKey: 'a'.repeat(64),
          sandboxIntegrationBindingRef: 'integration-binding-old-epoch',
          sandboxRuntimeId: 'sandbox-runtime-old-epoch',
          runtimeTargetId: 'nanohost-a1',
          timestamp: '2098-08-21T00:00:03.000Z',
        })
      ).toThrow(/publication physical Epoch is not current/i);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps Sandbox, Harness, AgentSession, and Turn projections distinct', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-records-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-1',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-1',
        sandboxRuntimeId: 'sandbox-runtime-1',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'agent-session-1',
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-1',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      expect
        .soft(() =>
          openNanoHostAgentSessionBinding(coreDb, {
            agentSessionCompatibilityKey: 'c'.repeat(64),
            agentSessionId: 'agent-session-same-thread',
            agentSessionRuntimeBindingId: 'agent-session-binding-same-thread',
            effectiveSetupGeneration: 1,
            harnessInstanceId: 'harness-1',
            threadId: 'thread-1',
            timestamp: now,
            workspaceId: 'workspace-1',
          })
        )
        .toThrow();
      expect(
        readNanoHostThreadAgentSessionBinding(coreDb, {
          threadId: 'thread-1',
          workspaceId: 'workspace-1',
        })
      ).toEqual({ agentSessionId: 'agent-session-1' });
      expect(
        readNanoHostThreadAgentSessionBinding(coreDb, {
          threadId: 'thread-missing',
          workspaceId: 'workspace-1',
        })
      ).toBeNull();
      expect
        .soft(
          coreDb.sqlite
            .prepare(
              'SELECT agent_session_id FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?'
            )
            .get('agent-session-binding-same-thread')
        )
        .toBeUndefined();
      expect(() =>
        openNanoHostAgentSessionBinding(coreDb, {
          agentSessionCompatibilityKey: 'c'.repeat(64),
          agentSessionId: 'agent-session-2',
          agentSessionRuntimeBindingId: 'agent-session-binding-2',
          effectiveSetupGeneration: 1,
          harnessInstanceId: 'harness-1',
          threadId: 'thread-2',
          timestamp: now,
          workspaceId: 'workspace-1',
        })
      ).not.toThrow();

      expect(
        coreDb.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sandbox_runtime_records', 'harness_instance_records', 'agent_session_runtime_bindings') ORDER BY name"
          )
          .all()
      ).toEqual([
        { name: 'agent_session_runtime_bindings' },
        { name: 'harness_instance_records' },
        { name: 'sandbox_runtime_records' },
      ]);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT open_session_count AS openSessionCount, max_active_turns AS maxActiveTurns FROM harness_instance_records'
          )
          .get()
      ).toEqual({ maxActiveTurns: 1, openSessionCount: 2 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT agent_session_id AS agentSessionId, native_handle_state AS nativeHandleState FROM agent_session_runtime_bindings ORDER BY agent_session_id'
          )
          .all()
      ).toEqual([
        { agentSessionId: 'agent-session-1', nativeHandleState: 'pending' },
        { agentSessionId: 'agent-session-2', nativeHandleState: 'pending' },
      ]);
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_execution_leases'"
          )
          .get()
      ).toBeUndefined();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'closed',
    'failed',
  ] as const)('keeps an unproved %s native inspect on the Thread uniqueness selector', (state) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-unproved-inspect-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-1',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-1',
        sandboxRuntimeId: 'sandbox-runtime-1',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'agent-session-1',
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-1',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      seedLease(coreDb);
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          aepRef: 'sandbox://aep/1',
          agentSessionId: 'agent-session-1',
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
          contextPackageId: 'context-package-1',
          contextRef: 'sandbox://context/1',
          deadline: '2099-01-01T00:00:00.000Z',
          leaseId: 'lease-1',
          packageSnapshotId: 'package-snapshot-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          turnSequence: 0,
          workspaceId: 'workspace-1',
        },
        harnessInstanceId: 'harness-1',
        operation: 'turn.start',
        timestamp: now,
      });
      const started = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
      });
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        result: {
          body: { nativeHandleDigest: null, nativeHandleState: 'pending', state: 'started' },
          disposition: 'succeeded',
          harnessInstanceId: 'harness-1',
          operationId: started!.operationId,
          schemaVersion: 2,
          sequence: 0,
        },
        timestamp: now,
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: 'agent-session-1',
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
        },
        harnessInstanceId: 'harness-1',
        operation: 'session.inspect',
        timestamp: now,
      });
      const inspect = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
      });
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        result: {
          body: {
            childState: 'running',
            cleanupState: 'pending',
            nativeHandleDigest: null,
            nativeHandleState: 'pending',
            state,
          },
          disposition: 'succeeded',
          harnessInstanceId: 'harness-1',
          operationId: inspect!.operationId,
          schemaVersion: 2,
          sequence: 1,
        },
        timestamp: now,
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT agent_session_id AS agentSessionId, lifecycle_state AS lifecycleState,
                      current_turn_id AS currentTurnId, current_lease_id AS currentLeaseId,
                      cleanup_state AS cleanupState
               FROM agent_session_runtime_bindings
               WHERE agent_session_runtime_binding_id = ?`
          )
          .get('agent-session-binding-1')
      ).toEqual({
        agentSessionId: 'agent-session-1',
        cleanupState: 'clean',
        currentLeaseId: 'lease-1',
        currentTurnId: 'turn-1',
        lifecycleState: state,
      });
      expect(() =>
        openNanoHostAgentSessionBinding(coreDb, {
          agentSessionCompatibilityKey: 'c'.repeat(64),
          agentSessionId: 'agent-session-2',
          agentSessionRuntimeBindingId: 'agent-session-binding-2',
          effectiveSetupGeneration: 1,
          harnessInstanceId: 'harness-1',
          threadId: 'thread-1',
          timestamp: now,
          workspaceId: 'workspace-1',
        })
      ).toThrow('NanoHost Harness already has a current AgentSession for this Thread.');
      expect(
        readNanoHostThreadAgentSessionBinding(coreDb, {
          threadId: 'thread-1',
          workspaceId: 'workspace-1',
        })
      ).toEqual({ agentSessionId: 'agent-session-1' });
      coreDb.sqlite
        .prepare(
          `INSERT INTO agent_session_runtime_bindings (
               agent_session_runtime_binding_id, harness_instance_id, agent_session_id,
               workspace_id, thread_id, agent_session_compatibility_key,
               effective_setup_generation, native_handle_state, native_handle_digest,
               lifecycle_state, current_turn_id, current_lease_id, next_turn_sequence, cleanup_state,
               created_at, updated_at, image_digest
             ) VALUES (?, 'harness-1', ?, 'workspace-1', 'thread-1', ?, 1, 'pending', NULL,
                       'opening', NULL, NULL, 0, 'clean', ?, ?, ?)`
        )
        .run(
          'agent-session-binding-2',
          'agent-session-2',
          'c'.repeat(64),
          now,
          now,
          `sha256:${'f'.repeat(64)}`
        );
      expect(() =>
        readNanoHostThreadAgentSessionBinding(coreDb, {
          threadId: 'thread-1',
          workspaceId: 'workspace-1',
        })
      ).toThrow('NanoHost Harness already has a current AgentSession for this Thread.');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'succeeded',
    'refused',
  ] as const)('binds token hashes and settles exact %s results with closed diagnostics', (disposition) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-sequence-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-1',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-1',
        sandboxRuntimeId: 'sandbox-runtime-1',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'agent-session-1',
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-1',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      seedLease(coreDb);
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          aepRef: 'sandbox://aep/1',
          agentSessionId: 'agent-session-1',
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
          contextPackageId: 'context-package-1',
          contextRef: 'sandbox://context/1',
          deadline: '2099-01-01T00:00:00.000Z',
          leaseId: 'lease-1',
          packageSnapshotId: 'package-snapshot-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          turnSequence: 0,
          workspaceId: 'workspace-1',
        },
        harnessInstanceId: 'harness-1',
        operation: 'turn.start',
        timestamp: now,
      });

      const workerControlToken = Buffer.alloc(32, 1).toString('base64url');
      const inferenceToken = Buffer.alloc(32, 2).toString('base64url');
      const capabilityToken = Buffer.alloc(32, 3).toString('base64url');
      const tokens = [workerControlToken, inferenceToken, capabilityToken];
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
        routeToken: () => tokens.shift()!,
      });
      expect(command).toMatchObject({
        body: {
          capabilityToken,
          inferenceToken,
          workerControlToken,
        },
        operation: 'turn.start',
        schemaVersion: 2,
        sequence: 0,
      });
      expect(command?.operationId).toMatch(/^[0-9a-f]{64}$/);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT worker_control_token_hash AS workerControlTokenHash, worker_inference_token_hash AS workerInferenceTokenHash, worker_capability_token_hash AS workerCapabilityTokenHash FROM scheduler_session_leases WHERE lease_id = ?'
          )
          .get('lease-1')
      ).toEqual({
        workerControlTokenHash: createHash('sha256')
          .update(Buffer.from(workerControlToken, 'base64url'))
          .digest('hex'),
        workerInferenceTokenHash: createHash('sha256')
          .update(Buffer.from(inferenceToken, 'base64url'))
          .digest('hex'),
        workerCapabilityTokenHash: createHash('sha256')
          .update(Buffer.from(capabilityToken, 'base64url'))
          .digest('hex'),
      });
      const durableHarness = JSON.stringify(
        coreDb.sqlite.prepare('SELECT * FROM harness_instance_records').get()
      );
      expect(durableHarness).not.toContain(workerControlToken);
      expect(durableHarness).not.toContain(inferenceToken);
      expect(durableHarness).not.toContain(capabilityToken);
      expect(
        dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
        })
      ).toBeNull();

      const result = {
        body:
          disposition === 'succeeded'
            ? { nativeHandleDigest: null, nativeHandleState: 'pending', state: 'started' }
            : {
                reasonCode: 'dependency_failed',
                startupFailure: {
                  stage: 'workspace_materialization',
                  reason: 'retained_baseline_unavailable',
                },
              },
        disposition,
        harnessInstanceId: 'harness-1',
        operationId: command!.operationId,
        schemaVersion: 2 as const,
        sequence: 0,
      };
      const explanation = {
        code: 'git_fetch_http_refused',
        stage: 'workspace_materialization',
        operation: 'git.fetch',
        dependency: 'git_remote',
        producer: 'worker-shim',
        observedAt: '2026-09-22T00:00:00.000Z',
        basis: 'direct_observation',
        subprocess: 'exit',
        httpStatus: 403,
        enforcement: 'unavailable',
        evidence: { availability: 'partial', outputTruncated: false },
      } as const;
      for (const startupFailure of [
        {
          stage: 'workspace_materialization',
          reason: 'git_fetch_http_refused',
          explanation: { ...explanation, observedAt: `2026-09-22T00:00:00.${'0'.repeat(20000)}Z` },
        },
        { stage: 'workspace_materialization', reason: 'git_fetch_tls_failed', explanation },
        {
          stage: 'workspace_materialization',
          reason: 'git_fetch_http_refused',
          explanation: { ...explanation, stderr: 'secret-canary' },
        },
        { stage: 'workspace_materialization', reason: 'secret-canary' },
        { stage: 'unknown_stage', reason: 'failed' },
        { stage: 'workspace_materialization', reason: 'failed', message: 'secret-canary' },
      ]) {
        expect(() =>
          settleNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: 'integration-binding-1',
            result: {
              ...result,
              disposition: 'refused',
              body: { reasonCode: 'dependency_failed', startupFailure },
            },
            timestamp: now,
          })
        ).toThrow('startup failure is invalid');
      }
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        result,
        timestamp: now,
      });
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        result,
        timestamp: now,
      });
      expect(() =>
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result: { ...result, body: { reasonCode: 'busy' }, disposition: 'refused' },
          timestamp: now,
        })
      ).toThrow(/conflict|replay|result/i);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT next_sequence AS nextSequence, operation_state AS operationState FROM harness_instance_records'
          )
          .get()
      ).toEqual({ nextSequence: 1, operationState: 'settled' });

      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: 'agent-session-1',
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
        },
        harnessInstanceId: 'harness-1',
        operation: 'session.inspect',
        timestamp: now,
      });
      const inspect = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
      });
      markNanoHostHarnessOperationUnknown(coreDb, {
        harnessBindingRef: 'harness-binding-1',
        operationId: inspect!.operationId,
        timestamp: now,
      });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT drain_state AS drainState, lifecycle_state AS lifecycleState, operation_state AS operationState FROM harness_instance_records'
          )
          .get()
      ).toEqual({ drainState: 'draining', lifecycleState: 'failed', operationState: 'unknown' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('removes only the closed AgentSession binding and decrements open_session_count', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-session-close-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-1',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-1',
        sandboxRuntimeId: 'sandbox-runtime-1',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'agent-session-1',
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-1',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'c'.repeat(64),
        agentSessionId: 'agent-session-2',
        agentSessionRuntimeBindingId: 'agent-session-binding-2',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-2',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: 'agent-session-1',
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
        },
        harnessInstanceId: 'harness-1',
        operation: 'session.close',
        timestamp: now,
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
      });
      expect(() =>
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result: {
            body: { childState: 'absent', privateState: 'absent', state: 'closed' },
            disposition: 'succeeded',
            harnessInstanceId: 'harness-1',
            operationId: command!.operationId,
            schemaVersion: 2,
            sequence: 0,
          },
          timestamp: now,
        })
      ).not.toThrow();

      expect(
        coreDb.sqlite
          .prepare(
            'SELECT agent_session_id AS agentSessionId FROM agent_session_runtime_bindings ORDER BY agent_session_id'
          )
          .all()
      ).toEqual([{ agentSessionId: 'agent-session-2' }]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT open_session_count AS openSessionCount, drain_state AS drainState,
                    lifecycle_state AS lifecycleState FROM harness_instance_records`
          )
          .get()
      ).toEqual({ drainState: 'accepting', lifecycleState: 'open', openSessionCount: 1 });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT lifecycle_state AS lifecycleState, health_state AS healthState,
                    drain_state AS drainState, cleanup_state AS cleanupState FROM sandbox_runtime_records`
          )
          .get()
      ).toEqual({
        cleanupState: 'clean',
        drainState: 'accepting',
        healthState: 'ready',
        lifecycleState: 'open',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('accepts identical session.close result replay after the next session.open is queued', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-close-replay-queued-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-1',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-1',
        sandboxRuntimeId: 'sandbox-runtime-1',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'agent-session-1',
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-1',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: 'agent-session-1',
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
        },
        harnessInstanceId: 'harness-1',
        operation: 'session.close',
        timestamp: now,
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
      });
      const closeResult = {
        body: { childState: 'absent', privateState: 'absent', state: 'closed' },
        disposition: 'succeeded' as const,
        harnessInstanceId: 'harness-1',
        operationId: command!.operationId,
        schemaVersion: 2 as const,
        sequence: 0,
      };
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        result: closeResult,
        timestamp: now,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'c'.repeat(64),
        agentSessionId: 'agent-session-2',
        agentSessionRuntimeBindingId: 'agent-session-binding-2',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-2',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          adapterId: 'codex',
          agentSessionCompatibilityKey: 'c'.repeat(64),
          agentSessionId: 'agent-session-2',
          agentSessionRuntimeBindingId: 'agent-session-binding-2',
          effectiveSetupGeneration: 1,
          storageRef: 'storage-1',
          threadId: 'thread-2',
          workSlotRef: 'work-slot-2',
          workspaceId: 'workspace-1',
        },
        harnessInstanceId: 'harness-1',
        operation: 'session.open',
        timestamp: now,
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT operation AS operation, operation_id AS operationId,
                    operation_state AS operationState FROM harness_instance_records
             WHERE harness_instance_id = ?`
          )
          .get('harness-1')
      ).toEqual({ operation: 'session.open', operationId: null, operationState: 'queued' });
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        result: closeResult,
        timestamp: now,
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT operation AS operation, operation_id AS operationId,
                    operation_state AS operationState FROM harness_instance_records
             WHERE harness_instance_id = ?`
          )
          .get('harness-1')
      ).toEqual({ operation: 'session.open', operationId: null, operationState: 'queued' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records unknown session.close without inferring binding removal', () => {
    const coreDb = openCoreDb(
      mkdtempSync(join(tmpdir(), 'openkit-harness-session-close-unknown-'))
    );
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-1',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-1',
        sandboxRuntimeId: 'sandbox-runtime-1',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'agent-session-1',
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-1',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'c'.repeat(64),
        agentSessionId: 'agent-session-2',
        agentSessionRuntimeBindingId: 'agent-session-binding-2',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-2',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: 'agent-session-1',
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
        },
        harnessInstanceId: 'harness-1',
        operation: 'session.close',
        timestamp: now,
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
      });
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        result: {
          body: { reasonCode: 'outcome_unknown' },
          disposition: 'unknown',
          harnessInstanceId: 'harness-1',
          operationId: command!.operationId,
          schemaVersion: 2,
          sequence: 0,
        },
        timestamp: now,
      });

      expect(
        coreDb.sqlite
          .prepare(
            `SELECT open_session_count AS openSessionCount, drain_state AS drainState,
                    lifecycle_state AS lifecycleState, operation_state AS operationState
             FROM harness_instance_records`
          )
          .get()
      ).toEqual({
        drainState: 'draining',
        lifecycleState: 'failed',
        openSessionCount: 2,
        operationState: 'unknown',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT lifecycle_state AS lifecycleState, health_state AS healthState,
                    drain_state AS drainState, cleanup_state AS cleanupState FROM sandbox_runtime_records`
          )
          .get()
      ).toEqual({
        cleanupState: 'unknown',
        drainState: 'draining',
        healthState: 'unknown',
        lifecycleState: 'failed',
      });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT agent_session_id AS agentSessionId FROM agent_session_runtime_bindings ORDER BY agent_session_id'
          )
          .all()
      ).toEqual([{ agentSessionId: 'agent-session-1' }, { agentSessionId: 'agent-session-2' }]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps pinned_goal_id nullable on sandbox_runtime_records and keeps session.open and turn.start free of pin fields', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-goal-pin-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      const sandboxColumns = coreDb.sqlite
        .prepare('PRAGMA table_info(sandbox_runtime_records)')
        .all() as { name: string; notnull: number }[];
      expect(sandboxColumns.map((column) => column.name)).toContain('pinned_goal_id');
      expect(sandboxColumns.find((column) => column.name === 'pinned_goal_id')?.notnull).toBe(0);

      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-1',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-1',
        sandboxRuntimeId: 'sandbox-runtime-1',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'agent-session-1',
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-1',
        timestamp: now,
        workspaceId: 'workspace-1',
      });

      const sessionOpenBody = {
        adapterId: 'codex',
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'agent-session-1',
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        storageRef: 'storage-1',
        threadId: 'thread-1',
        workSlotRef: 'work-slot-1',
        workspaceId: 'workspace-1',
      };
      queueNanoHostHarnessOperation(coreDb, {
        body: sessionOpenBody,
        harnessInstanceId: 'harness-1',
        operation: 'session.open',
        timestamp: now,
      });
      const sessionOpenCommand = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
      });
      expect(Object.keys(sessionOpenCommand?.body ?? {}).sort()).toEqual(
        Object.keys(sessionOpenBody).sort()
      );
      expect(sessionOpenCommand?.body).not.toHaveProperty('goalId');
      expect(sessionOpenCommand?.body).not.toHaveProperty('pin');
      expect(sessionOpenCommand?.body).not.toHaveProperty('pinnedGoalId');
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        result: {
          body: {
            maxActiveTurns: 1,
            nativeHandleDigest: null,
            nativeHandleState: 'pending',
            state: 'open',
          },
          disposition: 'succeeded',
          harnessInstanceId: 'harness-1',
          operationId: sessionOpenCommand!.operationId,
          schemaVersion: 2,
          sequence: 0,
        },
        timestamp: now,
      });

      seedLease(coreDb);
      const turnStartBody = {
        aepRef: 'sandbox://aep/1',
        agentSessionId: 'agent-session-1',
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        contextPackageId: 'context-package-1',
        contextRef: 'sandbox://context/1',
        deadline: '2099-01-01T00:00:00.000Z',
        leaseId: 'lease-1',
        packageSnapshotId: 'package-snapshot-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        turnSequence: 0,
        workspaceId: 'workspace-1',
      };
      queueNanoHostHarnessOperation(coreDb, {
        body: turnStartBody,
        harnessInstanceId: 'harness-1',
        operation: 'turn.start',
        timestamp: now,
      });
      const queuedTurnStart = JSON.parse(
        (
          coreDb.sqlite
            .prepare('SELECT command_body_json AS commandBodyJson FROM harness_instance_records')
            .get() as { commandBodyJson: string }
        ).commandBodyJson
      ) as Record<string, unknown>;
      expect(Object.keys(queuedTurnStart).sort()).toEqual(Object.keys(turnStartBody).sort());
      expect(queuedTurnStart).not.toHaveProperty('goalId');
      expect(queuedTurnStart).not.toHaveProperty('pin');
      expect(queuedTurnStart).not.toHaveProperty('pinnedGoalId');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('requires a closed interrupt purpose before queuing the Harness operation', () => {
    const coreDb = openActiveTurnDb('openkit-harness-interrupt-purpose-');
    try {
      const body = interruptBody();
      for (const invalidBody of [
        body,
        { ...body, purpose: 'unknown' },
        { ...body, extra: 'forbidden', purpose: 'interrupt' },
      ]) {
        expect(() =>
          queueNanoHostHarnessOperation(coreDb, {
            body: invalidBody,
            harnessInstanceId: 'harness-1',
            operation: 'turn.interrupt',
            timestamp: now,
          })
        ).toThrow();
        expect(harnessOperation(coreDb)).toEqual({ operation: 'turn.start', state: 'settled' });
      }

      queueNanoHostHarnessOperation(coreDb, {
        body: { ...body, purpose: 'interrupt' },
        harnessInstanceId: 'harness-1',
        operation: 'turn.interrupt',
        timestamp: now,
      });
      expect(harnessOperation(coreDb)).toEqual({ operation: 'turn.interrupt', state: 'queued' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('admits one human-gate stop only for the exact current binding and live lease lineage', () => {
    const coreDb = openActiveTurnDb('openkit-harness-human-gate-lineage-');
    try {
      const body = { ...interruptBody(), purpose: 'human-gate' };
      const expectRejected = (reason: string) => {
        expect(
          () =>
            queueNanoHostHarnessOperation(coreDb, {
              body,
              harnessInstanceId: 'harness-1',
              operation: 'turn.interrupt',
              timestamp: now,
            }),
          reason
        ).toThrow();
        expect(harnessOperation(coreDb)).toEqual({ operation: 'turn.start', state: 'settled' });
      };
      for (const [column, wrongValue, originalValue] of [
        ['current_turn_id', 'turn-other', 'turn-1'],
        ['current_lease_id', 'lease-other', 'lease-1'],
      ] as const) {
        coreDb.sqlite
          .prepare(
            `UPDATE agent_session_runtime_bindings SET ${column} = ? WHERE agent_session_runtime_binding_id = ?`
          )
          .run(wrongValue, 'agent-session-binding-1');
        expectRejected(column);
        coreDb.sqlite
          .prepare(
            `UPDATE agent_session_runtime_bindings SET ${column} = ? WHERE agent_session_runtime_binding_id = ?`
          )
          .run(originalValue, 'agent-session-binding-1');
      }

      for (const [column, wrongValue, originalValue] of [
        ['workspace_id', 'workspace-other', 'workspace-1'],
        ['thread_id', 'thread-other', 'thread-1'],
        ['turn_id', 'turn-other', 'turn-1'],
        ['agent_session_id', 'agent-session-other', 'agent-session-1'],
        ['package_snapshot_id', 'package-snapshot-other', 'package-snapshot-1'],
        ['status', 'released', 'acquired'],
      ] as const) {
        coreDb.sqlite
          .prepare(`UPDATE scheduler_session_leases SET ${column} = ? WHERE lease_id = ?`)
          .run(wrongValue, 'lease-1');
        expectRejected(column);
        coreDb.sqlite
          .prepare(`UPDATE scheduler_session_leases SET ${column} = ? WHERE lease_id = ?`)
          .run(originalValue, 'lease-1');
      }

      recordFinalStatus(coreDb, 'completed', 'completed');
      expectRejected('accepted final status');
      coreDb.sqlite
        .prepare("DELETE FROM worker_control_records WHERE operation = 'final_status'")
        .run();

      queueNanoHostHarnessOperation(coreDb, {
        body,
        harnessInstanceId: 'harness-1',
        operation: 'turn.interrupt',
        timestamp: now,
      });
      expect(() =>
        queueNanoHostHarnessOperation(coreDb, {
          body,
          harnessInstanceId: 'harness-1',
          operation: 'turn.interrupt',
          timestamp: now,
        })
      ).toThrow(/unsettled/i);
      recordFinalStatus(coreDb, 'blocked', 'ask_user');
      expect(harnessOperation(coreDb)).toEqual({ operation: 'turn.interrupt', state: 'queued' });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM harness_instance_records').get()
      ).toEqual({ count: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('copies measured image digest onto a new binding and retains it after sandbox_runtime_records deletion', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-measured-identity-')));
    const imageDigest = `sha256:${'f'.repeat(64)}`;
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-1',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-1',
        sandboxRuntimeId: 'sandbox-runtime-1',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'agent-session-1',
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-1',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT image_digest AS imageDigest FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?'
          )
          .get('agent-session-binding-1')
      ).toEqual({ imageDigest });
      removeNanoHostSandboxRuntimeForHarness(coreDb, 'harness-1');
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 0 });
      expect(readNanoHostMeasuredHarnessIdentity(coreDb, 'agent-session-binding-1')).toBe(
        imageDigest
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('copies measured image digest onto a binding that reuses an existing Harness', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-measured-reuse-')));
    const imageDigest = `sha256:${'f'.repeat(64)}`;
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-1',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-1',
        sandboxRuntimeId: 'sandbox-runtime-1',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'agent-session-1',
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-1',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'c'.repeat(64),
        agentSessionId: 'agent-session-2',
        agentSessionRuntimeBindingId: 'agent-session-binding-2',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-2',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT agent_session_runtime_binding_id AS bindingId, image_digest AS imageDigest
             FROM agent_session_runtime_bindings ORDER BY agent_session_runtime_binding_id`
          )
          .all()
      ).toEqual([
        { bindingId: 'agent-session-binding-1', imageDigest },
        { bindingId: 'agent-session-binding-2', imageDigest },
      ]);
      removeNanoHostSandboxRuntimeForHarness(coreDb, 'harness-1');
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 0 });
      expect(readNanoHostMeasuredHarnessIdentity(coreDb, 'agent-session-binding-1')).toBe(
        imageDigest
      );
      expect(readNanoHostMeasuredHarnessIdentity(coreDb, 'agent-session-binding-2')).toBe(
        imageDigest
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records a new measured digest for a rebound derived binding id so grouping false-splits', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-measured-split-')));
    const digestA = `sha256:${'a'.repeat(64)}`;
    const digestB = `sha256:${'b'.repeat(64)}`;
    const bindingInput = {
      agentSessionCompatibilityKey: 'b'.repeat(64),
      agentSessionId: 'agent-session-1',
      agentSessionRuntimeBindingId: 'agent-session-binding-1',
      effectiveSetupGeneration: 1,
      harnessInstanceId: 'harness-1',
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
    } as const;
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: digestA,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-1',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-1',
        sandboxRuntimeId: 'sandbox-runtime-1',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      openNanoHostAgentSessionBinding(coreDb, { ...bindingInput, timestamp: now });
      removeNanoHostSandboxRuntimeForHarness(coreDb, 'harness-1');
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: digestB,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-1',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-1',
        sandboxRuntimeId: 'sandbox-runtime-1',
        runtimeTargetId: 'nanohost-a1',
        timestamp: '2098-08-21T00:00:01.000Z',
      });
      expect(() =>
        openNanoHostAgentSessionBinding(coreDb, {
          ...bindingInput,
          timestamp: '2098-08-21T00:00:01.000Z',
        })
      ).not.toThrow();
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 1 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings').get()
      ).toEqual({ count: 1 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT image_digest AS imageDigest FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?'
          )
          .get('agent-session-binding-1')
      ).toEqual({ imageDigest: digestB });
      expect(readNanoHostMeasuredHarnessIdentity(coreDb, 'agent-session-binding-1')).toBe(digestB);
      expect(listNanoHostMeasuredHarnessIdentities(coreDb, 'agent-session-binding-1')).toEqual([
        digestA,
        digestB,
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not collapse two binaries that share an author label into one measured identity', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-measured-no-merge-')));
    const digestA = `sha256:${'a'.repeat(64)}`;
    const digestB = `sha256:${'b'.repeat(64)}`;
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: digestA,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-1',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-1',
        sandboxRuntimeId: 'sandbox-runtime-1',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-2',
        harnessCompatibilityKey: 'e'.repeat(64),
        harnessInstanceId: 'harness-2',
        imageDigest: digestB,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-2',
        sandboxCompatibilityKey: 'c'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-2',
        sandboxRuntimeId: 'sandbox-runtime-2',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: 'agent-session-1',
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: 'thread-1',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'f'.repeat(64),
        agentSessionId: 'agent-session-2',
        agentSessionRuntimeBindingId: 'agent-session-binding-2',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-2',
        threadId: 'thread-2',
        timestamp: now,
        workspaceId: 'workspace-1',
      });
      expect(readNanoHostMeasuredHarnessIdentity(coreDb, 'agent-session-binding-1')).toBe(digestA);
      expect(readNanoHostMeasuredHarnessIdentity(coreDb, 'agent-session-binding-2')).toBe(digestB);
      expect(readNanoHostMeasuredHarnessIdentity(coreDb, 'agent-session-binding-1')).not.toBe(
        readNanoHostMeasuredHarnessIdentity(coreDb, 'agent-session-binding-2')
      );
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/** Returns the exact private interrupt body before its closed purpose discriminator. */
function interruptBody(): Readonly<Record<string, unknown>> {
  return {
    agentSessionId: 'agent-session-1',
    agentSessionRuntimeBindingId: 'agent-session-binding-1',
    leaseId: 'lease-1',
    turnId: 'turn-1',
  };
}

/** Reads the single Harness operation slot used by interrupt compare-and-set checks. */
function harnessOperation(coreDb: ReturnType<typeof openCoreDb>): {
  operation: string;
  state: string;
} {
  const row = coreDb.sqlite
    .prepare(
      'SELECT operation, operation_state AS state FROM harness_instance_records WHERE harness_instance_id = ?'
    )
    .get('harness-1');
  return row as { operation: string; state: string };
}

/** Records one accepted final status for the active fixture lineage. */
function recordFinalStatus(
  coreDb: ReturnType<typeof openCoreDb>,
  status: 'blocked' | 'completed',
  stopReason: 'ask_user' | 'completed'
): void {
  recordWorkerControlAcceptedRecord(coreDb, {
    acceptedAt: now,
    lineage: {
      agentSessionId: 'agent-session-1',
      packageSnapshotId: 'package-snapshot-1',
      requestId: 'request-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      workspaceId: 'workspace-1',
    },
    operation: 'final_status',
    record: { sequence: 1, status, stopReason },
    recordKey: '1',
    sequence: 1,
  });
}

/** Creates one settled turn.start whose binding and lease identify an active Turn. */
function openActiveTurnDb(prefix: string): ReturnType<typeof openCoreDb> {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), prefix)));
  applyMigrations(coreDb);
  seedRuntimeTarget(coreDb);
  createNanoHostHarnessRuntime(coreDb, {
    adapterId: 'codex',
    adapterVersion: '0.153.4',
    harnessBindingRef: 'harness-binding-1',
    harnessCompatibilityKey: 'd'.repeat(64),
    harnessInstanceId: 'harness-1',
    imageDigest: `sha256:${'f'.repeat(64)}`,
    originPhysicalEpoch: physicalEpoch,
    sandboxBindingRef: 'sandbox-binding-1',
    sandboxCompatibilityKey: 'a'.repeat(64),
    sandboxIntegrationBindingRef: 'integration-binding-1',
    sandboxRuntimeId: 'sandbox-runtime-1',
    runtimeTargetId: 'nanohost-a1',
    timestamp: now,
  });
  openNanoHostAgentSessionBinding(coreDb, {
    agentSessionCompatibilityKey: 'b'.repeat(64),
    agentSessionId: 'agent-session-1',
    agentSessionRuntimeBindingId: 'agent-session-binding-1',
    effectiveSetupGeneration: 1,
    harnessInstanceId: 'harness-1',
    threadId: 'thread-1',
    timestamp: now,
    workspaceId: 'workspace-1',
  });
  seedAdmissionBackedLease(coreDb);
  queueNanoHostHarnessOperation(coreDb, {
    body: {
      aepRef: 'sandbox://aep/1',
      agentSessionId: 'agent-session-1',
      agentSessionRuntimeBindingId: 'agent-session-binding-1',
      contextPackageId: 'context-package-1',
      contextRef: 'sandbox://context/1',
      deadline: '2099-01-01T00:00:00.000Z',
      leaseId: 'lease-1',
      packageSnapshotId: 'package-snapshot-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      turnSequence: 0,
      workspaceId: 'workspace-1',
    },
    harnessInstanceId: 'harness-1',
    operation: 'turn.start',
    timestamp: now,
  });
  const tokens = [1, 2, 3].map((value) => Buffer.alloc(32, value).toString('base64url'));
  const command = dispatchNanoHostHarnessOperation(coreDb, {
    sandboxIntegrationBindingRef: 'integration-binding-1',
    now: () => now,
    routeToken: () => tokens.shift()!,
  });
  settleNanoHostHarnessOperation(coreDb, {
    sandboxIntegrationBindingRef: 'integration-binding-1',
    result: {
      body: { nativeHandleDigest: null, nativeHandleState: 'pending', state: 'started' },
      disposition: 'succeeded',
      harnessInstanceId: 'harness-1',
      operationId: command!.operationId,
      schemaVersion: 2,
      sequence: 0,
    },
    timestamp: now,
  });
  return coreDb;
}

/** Creates the complete admission, placement, and lease lineage for an active Turn. */
function seedAdmissionBackedLease(coreDb: ReturnType<typeof openCoreDb>): void {
  createSchedulerAdmissionEntry(coreDb, {
    now: () => now,
    priorityClass: 'interactive',
    queueEntryId: 'queue-1',
    requestId: 'request-1',
    requestedAgentId: 'agent-1',
    requiredPoolConstraints: ['openshell.local'],
    threadId: 'thread-1',
    triggerActor: { id: 'user-1', kind: 'user' },
    turnId: 'turn-1',
    turnInput: 'Wait for a human decision',
    workspaceId: 'workspace-1',
  });
  createSchedulerPlacementPlan(coreDb, {
    degradedOptionalFeatures: [],
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    now: () => now,
    planId: 'plan-1',
    plannedLeaseDurationMs: 900_000,
    policyDecisionIds: [],
    queueEntryId: 'queue-1',
    schedulerEpoch: 1,
    selectedPoolId: 'pool-1',
    selectedTargetId: 'nanohost-a1',
  });
  createSchedulerSessionLease(coreDb, {
    agentSessionId: 'agent-session-1',
    expiresAt: '2099-01-01T00:00:00.000Z',
    heartbeatDeadline: '2099-01-01T00:00:00.000Z',
    leaseId: 'lease-1',
    now: () => now,
    packageSnapshotId: 'package-snapshot-1',
    planId: 'plan-1',
    sandboxTokenBindingRef: 'turn-route-binding-1',
    startupDeadline: '2099-01-01T00:00:00.000Z',
  });
}

/** Seeds the existing Turn execution lease used by one private `turn.start`. */
function seedLease(coreDb: ReturnType<typeof openCoreDb>): void {
  coreDb.sqlite
    .prepare(
      `INSERT INTO scheduler_session_leases (
         lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
         package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
         heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
         sandbox_binding_ref, backend_anchor_state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'acquired', ?, ?, ?, ?, 0, 1, ?, 'anchored')`
    )
    .run(
      'lease-1',
      'plan-1',
      'workspace-1',
      'thread-1',
      'turn-1',
      'agent-session-1',
      'package-snapshot-1',
      'pool-1',
      'nanohost-a1',
      now,
      '2099-01-01T00:00:00.000Z',
      '2099-01-01T00:00:00.000Z',
      '2099-01-01T00:00:00.000Z',
      'turn-route-binding-1'
    );
}

/** Seeds the configured RuntimeTarget that owns one private Sandbox projection. */
function seedRuntimeTarget(coreDb: ReturnType<typeof openCoreDb>): void {
  coreDb.sqlite
    .prepare(
      `INSERT INTO nanohost_runtime_targets (
         target_id, identity_id, deployment_id, connection_generation,
         predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
       ) VALUES ('nanohost-a1', 'nanohost-a1', 'deployment-a1', 1, 1, 1, 1, ?, ?, 1)`
    )
    .run(physicalEpoch, now);
}
