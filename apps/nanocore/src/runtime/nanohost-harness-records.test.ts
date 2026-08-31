import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createNanoHostHarnessRuntime,
  dispatchNanoHostHarnessOperation,
  markNanoHostHarnessOperationUnknown,
  openNanoHostAgentSessionBinding,
  queueNanoHostHarnessOperation,
  settleNanoHostHarnessOperation,
} from './nanohost-harness-records.js';

const now = '2026-08-21T00:00:00.000Z';

describe('private NanoHost Harness records', () => {
  it('retains two compatibility-keyed Harnesses in one Sandbox', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-multi-harness-records-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      for (const [adapterId, adapterVersion, harnessInstanceId, compatibilityKey] of [
        ['codex', '0.144.1', 'harness-codex', 'b'.repeat(64)],
        ['opencode', '1.18.1', 'harness-opencode', 'c'.repeat(64)],
      ] as const) {
        createNanoHostHarnessRuntime(coreDb, {
          adapterId,
          adapterVersion,
          harnessBindingRef: `binding-${harnessInstanceId}`,
          harnessCompatibilityKey: compatibilityKey,
          harnessInstanceId,
          imageDigest: `sha256:${'f'.repeat(64)}`,
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

  it('keeps Sandbox, Harness, AgentSession, and Turn projections distinct', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-records-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: `sha256:${'f'.repeat(64)}`,
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

  it('binds token hashes at dispatch, never redelivers, and settles only exact results', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-sequence-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: `sha256:${'f'.repeat(64)}`,
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
      const tokens = [workerControlToken, inferenceToken];
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
        routeToken: () => tokens.shift()!,
      });
      expect(command).toMatchObject({
        body: {
          inferenceToken,
          workerControlToken,
        },
        operation: 'turn.start',
        schemaVersion: 1,
        sequence: 0,
      });
      expect(command?.operationId).toMatch(/^[0-9a-f]{64}$/);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT worker_control_token_hash AS workerControlTokenHash, worker_inference_token_hash AS workerInferenceTokenHash FROM scheduler_session_leases WHERE lease_id = ?'
          )
          .get('lease-1')
      ).toEqual({
        workerControlTokenHash: createHash('sha256')
          .update(Buffer.from(workerControlToken, 'base64url'))
          .digest('hex'),
        workerInferenceTokenHash: createHash('sha256')
          .update(Buffer.from(inferenceToken, 'base64url'))
          .digest('hex'),
      });
      const durableHarness = JSON.stringify(
        coreDb.sqlite.prepare('SELECT * FROM harness_instance_records').get()
      );
      expect(durableHarness).not.toContain(workerControlToken);
      expect(durableHarness).not.toContain(inferenceToken);
      expect(
        dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
        })
      ).toBeNull();

      const result = {
        body: { nativeHandleDigest: null, nativeHandleState: 'pending', state: 'started' },
        disposition: 'succeeded' as const,
        harnessInstanceId: 'harness-1',
        operationId: command!.operationId,
        schemaVersion: 1 as const,
        sequence: 0,
      };
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
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: `sha256:${'f'.repeat(64)}`,
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
            schemaVersion: 1,
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

  it('records unknown session.close without inferring binding removal', () => {
    const coreDb = openCoreDb(
      mkdtempSync(join(tmpdir(), 'openkit-harness-session-close-unknown-'))
    );
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: `sha256:${'f'.repeat(64)}`,
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
          schemaVersion: 1,
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
        adapterVersion: '0.144.1',
        harnessBindingRef: 'harness-binding-1',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-1',
        imageDigest: `sha256:${'f'.repeat(64)}`,
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
        threadId: 'thread-1',
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
          schemaVersion: 1,
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
});

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
         predecessor_fenced, ready, fresh_empty, observed_at, slot_count
       ) VALUES ('nanohost-a1', 'nanohost-a1', 'deployment-a1', 1, 1, 1, 1, ?, 1)`
    )
    .run(now);
}
