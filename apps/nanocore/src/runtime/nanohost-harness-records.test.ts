import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  acknowledgeTestExternalWorkspaceConsumer,
  queueTestPreparedHarnessOperation as queueNanoHostHarnessOperation,
  recordTestExecutionAttempt,
} from '../test-support/execution-attempt.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  copyNanoHostMeasuredHarnessIdentity,
  createNanoHostHarnessRuntime,
  deriveNanoHostAgentSessionCompatibilityKey,
  dispatchNanoHostHarnessOperation,
  drainNanoHostHarnessAdmission,
  drainNanoHostSandboxAdmission,
  hasConsumedNanoHostHarnessResult,
  inspectNanoHostAgentSessionContinuity,
  listNanoHostMeasuredHarnessIdentities,
  markNanoHostHarnessOperationUnknown,
  openNanoHostAgentSessionBinding,
  prepareNanoHostHarnessOperation,
  readNanoHostMeasuredHarnessIdentity,
  readNanoHostThreadAgentSessionBinding,
  removeNanoHostSandboxRuntimeForHarness,
  settleNanoHostHarnessOperation,
} from './nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import { recordWorkerBackendSessionMaterializing } from './worker-backend-sessions.js';
import { recordWorkerControlAcceptedRecord } from './worker-control-records.js';

const now = '2098-08-21T00:00:00.000Z';
const physicalEpoch = 'e'.repeat(64);

describe('Workspace invocation deadline and exclusion controls', () => {
  it('T2 refuses changed queued input and preserves the original Thread exclusion', () => {
    const db = openOpeningBindingDb('openkit-harness-input-exclusion-');
    try {
      seedSubmittedAttempt(db);
      const input = {
        body: concurrentTurnStartBody(1),
        harnessInstanceId: 'harness-1',
        operation: 'turn.start' as const,
        timestamp: now,
      };
      expect(queueNanoHostHarnessOperation(db, input)).toBe(0);
      const before = db.sqlite.serialize();
      expect(() =>
        queueNanoHostHarnessOperation(db, {
          ...input,
          body: { ...input.body, deadline: '2100-01-01T00:00:00.000Z' },
        })
      ).toThrow('NanoHost Harness already has an unsettled operation.');
      expect(() =>
        openNanoHostAgentSessionBinding(db, {
          agentSessionCompatibilityKey: 'b'.repeat(64),
          agentSessionId: testEntityId('as', 'journal-conflicting-session'),
          agentSessionRuntimeBindingId: 'journal-conflicting-binding',
          effectiveSetupGeneration: 1,
          harnessInstanceId: 'harness-1',
          threadId: testEntityId('th', 'thread-1'),
          timestamp: now,
          workspaceId: testEntityId('ws', 'workspace-1'),
        })
      ).toThrow();
      expect(db.sqlite.serialize().equals(before)).toBe(true);
      expect(harnessOperation(db)).toEqual({ operation: 'turn.start', state: 'queued' });
    } finally {
      db.sqlite.close();
    }
  });

  it('T3 retains the native receiver receipt across cold competing dispatch before Workspace consumption', () => {
    let db = openOpeningBindingDb('openkit-harness-unconsumed-receipt-');
    const root = db.dataRoot;
    try {
      queueNanoHostHarnessOperation(db, {
        body: sessionOpenBody(),
        harnessInstanceId: 'harness-1',
        operation: 'session.open',
        timestamp: now,
      });
      const command = dispatchNanoHostHarnessOperation(db, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      })!;
      expect(command.operation).toBe('session.open');
      const result = {
        schemaVersion: 2 as const,
        harnessInstanceId: command.harnessInstanceId,
        operationId: command.operationId,
        sequence: command.sequence,
        disposition: 'succeeded' as const,
        body: {
          state: 'open',
          nativeHandleState: 'pending',
          nativeHandleDigest: null,
          maxActiveTurns: 1,
        },
      };
      // Commit only the real receiver boundary, then lose its reply before any Workspace consumer is called.
      expect(
        settleNanoHostHarnessOperation(db, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result,
          timestamp: now,
        })
      ).toBe('settled');
      const receipt = db.sqlite
        .prepare(
          "SELECT result_json AS bytes, result_fingerprint AS fingerprint FROM harness_instance_records WHERE harness_instance_id = 'harness-1'"
        )
        .get() as { bytes: string; fingerprint: string };
      expect(JSON.parse(receipt.bytes)).toEqual(result);
      expect(receipt.fingerprint).toBe(createHash('sha256').update(receipt.bytes).digest('hex'));
      db.sqlite.close();
      db = openCoreDb(root);
      try {
        queueNanoHostHarnessOperation(db, {
          body: {},
          harnessInstanceId: 'harness-1',
          operation: 'harness.drain',
          timestamp: now,
        });
      } catch (error) {
        // Refusal may happen at enqueue rather than dispatch, but must concern the unconsumed operation.
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/unsettled|consum|receipt|acknowledg/i);
      }
      const successor = dispatchNanoHostHarnessOperation(db, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      });
      expect.soft(successor !== null).toBe(false);
      expect
        .soft(
          db.sqlite
            .prepare(
              "SELECT result_json AS bytes, result_fingerprint AS fingerprint FROM harness_instance_records WHERE harness_instance_id = 'harness-1'"
            )
            .get()
        )
        .toEqual(receipt);
    } finally {
      if (db.sqlite.open) db.sqlite.close();
    }
  });

  it('T4 lets an independent Workspace Harness progress without changing an unknown sibling', () => {
    const db = openActiveTurnDb('openkit-harness-unknown-sibling-');
    onTestFinished(() => rmSync(db.dataRoot, { recursive: true, force: true }));
    try {
      queueNanoHostHarnessOperation(db, {
        body: { ...interruptBody(), purpose: 'interrupt' },
        harnessInstanceId: 'harness-1',
        operation: 'turn.interrupt',
        timestamp: now,
      });
      const command = dispatchNanoHostHarnessOperation(db, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      })!;
      markNanoHostHarnessOperationUnknown(db, {
        harnessBindingRef: 'harness-binding-1',
        operationId: command.operationId,
        timestamp: now,
      });
      const before = db.sqlite
        .prepare(
          "SELECT * FROM agent_session_runtime_bindings WHERE harness_instance_id = 'harness-1'"
        )
        .all();
      expect(before).toHaveLength(1);
      createNanoHostHarnessRuntime(db, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        maxActiveTurns: 1,
        harnessBindingRef: 'journal-sibling-harness-binding',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'journal-sibling-harness',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'journal-sibling-sandbox-binding',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'journal-sibling-integration',
        sandboxRuntimeId: 'journal-sibling-sandbox',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      const sibling = {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: testEntityId('as', 'journal-sibling-session'),
        agentSessionRuntimeBindingId: 'journal-sibling-session-binding',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'journal-sibling-harness',
        threadId: testEntityId('th', 'journal-sibling-thread'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'journal-sibling-workspace'),
      };
      openNanoHostAgentSessionBinding(db, sibling);
      queueNanoHostHarnessOperation(db, {
        body: {
          ...sessionOpenBody(),
          agentSessionId: sibling.agentSessionId,
          agentSessionRuntimeBindingId: sibling.agentSessionRuntimeBindingId,
          threadId: sibling.threadId,
          workspaceId: sibling.workspaceId,
        },
        harnessInstanceId: sibling.harnessInstanceId,
        operation: 'session.open',
        timestamp: now,
      });
      const delivered = dispatchNanoHostHarnessOperation(db, {
        sandboxIntegrationBindingRef: 'journal-sibling-integration',
        now: () => now,
      })!;
      expect(delivered.operation).toBe('session.open');
      expect(
        settleNanoHostHarnessOperation(db, {
          sandboxIntegrationBindingRef: 'journal-sibling-integration',
          result: {
            schemaVersion: 2,
            harnessInstanceId: delivered.harnessInstanceId,
            operationId: delivered.operationId,
            sequence: delivered.sequence,
            disposition: 'succeeded',
            body: {
              state: 'open',
              nativeHandleState: 'pending',
              nativeHandleDigest: null,
              maxActiveTurns: 1,
            },
          },
          timestamp: now,
        })
      ).toBe('settled');
      expect(harnessOperation(db)).toEqual({ operation: 'turn.interrupt', state: 'unknown' });
      expect(
        db.sqlite
          .prepare(
            "SELECT * FROM agent_session_runtime_bindings WHERE harness_instance_id = 'harness-1'"
          )
          .all()
      ).toEqual(before);
      expect(
        db.sqlite
          .prepare(
            "SELECT active_turn_count AS count FROM harness_instance_records WHERE harness_instance_id = 'harness-1'"
          )
          .get()
      ).toEqual({ count: 1 });
      expect(
        db.sqlite
          .prepare(
            "SELECT lifecycle_state AS state FROM agent_session_runtime_bindings WHERE harness_instance_id = 'journal-sibling-harness'"
          )
          .get()
      ).toEqual({ state: 'open' });
    } finally {
      db.sqlite.close();
    }
  });

  it('T4 keeps unknown exclusion after an empty poll and a late interrupt acknowledgement', () => {
    const db = openActiveTurnDb('openkit-harness-unknown-exclusion-');
    onTestFinished(() => rmSync(db.dataRoot, { recursive: true, force: true }));
    try {
      queueNanoHostHarnessOperation(db, {
        body: { ...interruptBody(), purpose: 'interrupt' },
        harnessInstanceId: 'harness-1',
        operation: 'turn.interrupt',
        timestamp: now,
      });
      const command = dispatchNanoHostHarnessOperation(db, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      })!;
      expect(command.operation).toBe('turn.interrupt');
      markNanoHostHarnessOperationUnknown(db, {
        harnessBindingRef: 'harness-binding-1',
        operationId: command.operationId,
        timestamp: now,
      });
      const before = db.sqlite.prepare('SELECT * FROM agent_session_runtime_bindings').all();
      expect(before).toHaveLength(1);
      expect(
        dispatchNanoHostHarnessOperation(db, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          now: () => now,
        })
      ).toBeNull();
      try {
        settleNanoHostHarnessOperation(db, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          timestamp: now,
          result: {
            schemaVersion: 2,
            harnessInstanceId: command.harnessInstanceId,
            operationId: command.operationId,
            sequence: command.sequence,
            disposition: 'succeeded',
            body: { state: 'interrupted' },
          },
        });
      } catch (error) {
        // The old receiver refuses late results. A future bounded linked consumer may accept this acknowledgement, but cannot turn it into stop proof.
        expect(error).toMatchObject({
          message: 'NanoHost Harness result does not match the dispatched operation.',
        });
      }
      expect(harnessOperation(db)).toEqual({ operation: 'turn.interrupt', state: 'unknown' });
      expect(db.sqlite.prepare('SELECT * FROM agent_session_runtime_bindings').all()).toEqual(
        before
      );
      expect(
        db.sqlite.prepare('SELECT active_turn_count AS count FROM harness_instance_records').get()
      ).toEqual({ count: 1 });
    } finally {
      db.sqlite.close();
    }
  });
});

describe('private NanoHost Harness records', () => {
  it('preserves historical command bytes and native correlation across cold dispatch', () => {
    const nativeEnvironment = { a: 'e\u0301', Z: '\u00e9' };
    const identities = {
      agentSessionId: 'as_01a17954-0338-78b0-9e29-db2975371867',
      threadId: 'th_01a17954-0338-7ad5-a6c8-bef8d9e81e8a',
      workspaceId: 'ws_01a17954-0338-79ca-9b0a-47bc7cb51cdc',
    };
    let coreDb = openOpeningBindingDb(
      'openkit-harness-historical-command-',
      {
        agentId: 'fixture-native-environment',
        defaultsDigest: `sha256:${'a'.repeat(64)}`,
        imageDigest: `sha256:${'f'.repeat(64)}`,
        values: nativeEnvironment,
      },
      identities
    );
    try {
      const credentials = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
      const input = {
        body: { ...sessionOpenBody(), ...identities, nativeEnvironment },
        harnessInstanceId: 'harness-1',
        operation: 'session.open' as const,
        timestamp: now,
      };
      const prepared = prepareNanoHostHarnessOperation(coreDb, {
        ...input,
        loopbackCredential: () => credentials.shift()!.toString('base64url'),
      });
      queueNanoHostHarnessOperation(coreDb, { ...input, prepared });
      // Captured from this owner's real producer at 4a8a9d649; mixed-case names distinguish the old encoding.
      const historical = {
        bytes:
          '{"adapterId":"codex","agentSessionCompatibilityKey":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",' +
          '"agentSessionId":"as_01a17954-0338-78b0-9e29-db2975371867","agentSessionRuntimeBindingId":"agent-session-binding-1",' +
          '"capabilityLoopbackCredentialHash":"6c1d63bbdab437c54368cbbd8886a886a79ad977297e265eebf1f5f5f01533b9",' +
          '"effectiveSetupGeneration":1,"inferenceLoopbackCredentialHash":"56d5fa7333f6d747db42c239407e5da4c32f4c79f35d092b134fd35a402d9c5c",' +
          '"nativeEnvironment":{"a":"e\u0301","Z":"\u00e9"},"resume":null,' +
          '"threadId":"th_01a17954-0338-7ad5-a6c8-bef8d9e81e8a","workspaceId":"ws_01a17954-0338-79ca-9b0a-47bc7cb51cdc"}',
        fingerprint: 'c5ccabf7580bd70076cc2fde82da22f9c611c20926926b1ff671aaaf02051b2a',
        operationId: '658ec7b38c0c7517df4007d9a0a2aa65782a736aaf3b969c916eefd6530ec4b5',
        sequence: 0,
      };
      // Owner-module retained-state injection follows valid owner setup; new producers may use a new encoding.
      coreDb.sqlite
        .prepare(
          `UPDATE harness_instance_records
           SET command_body_json = ?, command_fingerprint = ?, operation_id = ?
           WHERE harness_instance_id = 'harness-1'`
        )
        .run(historical.bytes, historical.fingerprint, historical.operationId);
      const readCommand = () =>
        coreDb.sqlite
          .prepare(
            `SELECT command_body_json AS bytes, command_fingerprint AS fingerprint,
                    operation_id AS operationId, operation_sequence AS sequence
             FROM harness_instance_records WHERE harness_instance_id = 'harness-1'`
          )
          .get();
      const root = coreDb.dataRoot;
      coreDb.sqlite.close();
      coreDb = openCoreDb(root);
      // Schema Evolution, Canonical Structured Values And Exact Bytes binds the original raw proof.
      expect(readCommand()).toEqual(historical);
      expect(createHash('sha256').update(historical.bytes).digest('hex')).toBe(
        historical.fingerprint
      );
      coreDb.sqlite
        .prepare('UPDATE harness_instance_records SET command_body_json = ?')
        .run(`${historical.bytes}\n`);
      expect(() =>
        dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          now: () => now,
        })
      ).toThrow(/corrupt|fingerprint/);
      coreDb.sqlite
        .prepare('UPDATE harness_instance_records SET command_body_json = ?')
        .run(historical.bytes);
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      });
      // NanoHost acceptance predicate 46 preserves the already recorded operation identity and sequence.
      expect(command).toEqual({
        body: JSON.parse(historical.bytes),
        harnessInstanceId: 'harness-1',
        operation: 'session.open',
        operationId: historical.operationId,
        schemaVersion: 2,
        sequence: historical.sequence,
      });
      expect(readCommand()).toEqual(historical);
      const result = {
        body: {
          maxActiveTurns: 1,
          nativeHandleDigest: null,
          nativeHandleState: 'pending',
          state: 'open',
        },
        disposition: 'succeeded',
        harnessInstanceId: 'harness-1',
        operationId: historical.operationId,
        schemaVersion: 2,
        sequence: historical.sequence,
      } as const;
      const settle = () =>
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result,
          timestamp: now,
        });
      expect(settle()).toBe('settled');
      const receipt = coreDb.sqlite
        .prepare(
          'SELECT result_json AS bytes, result_fingerprint AS fingerprint FROM harness_instance_records'
        )
        .get() as { bytes: string; fingerprint: string };
      coreDb.sqlite.close();
      coreDb = openCoreDb(root);
      expect(settle()).toBe('replayed');
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT result_json AS bytes, result_fingerprint AS fingerprint FROM harness_instance_records'
          )
          .get()
      ).toEqual(receipt);
      expect(readCommand()).toEqual(historical);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('logs only fixed slow-stage fields at the 100 ms boundary', () => {
    const coreDb = openOpeningBindingDb('openkit-harness-slow-stage-');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(110);
    const input = {
      body: sessionOpenBody(),
      harnessInstanceId: 'harness-1',
      operation: 'session.open' as const,
      timestamp: now,
      diagnosticCanary: 'private-content /private/path token-canary',
    };
    try {
      expect(queueNanoHostHarnessOperation(coreDb, input)).toBe(0);
      expect(log).toHaveBeenCalledExactlyOnceWith(expect.any(String));
      const record = JSON.parse(log.mock.calls[0]![0] as string);
      expect(record).toEqual({
        stage: 'harness-enqueue',
        durationMs: 100,
        timestamp: expect.any(String),
        harnessInstanceId: 'harness-1',
      });
      expect(Number.isFinite(Date.parse(record.timestamp))).toBe(true);

      log.mockClear();
      clock.mockReturnValueOnce(0).mockReturnValueOnce(99.999);
      expect(() => queueNanoHostHarnessOperation(coreDb, input)).toThrow('unsettled operation');
      expect(log).not.toHaveBeenCalled();

      clock.mockReturnValueOnce(0).mockReturnValueOnce(100);
      log.mockImplementation(() => {
        throw new Error('diagnostic-sink-canary');
      });
      expect(() => queueNanoHostHarnessOperation(coreDb, input)).toThrow('unsettled operation');
    } finally {
      clock.mockRestore();
      log.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('refuses an unknown Harness format before decoding or replacing its command', () => {
    const coreDb = openOpeningBindingDb('openkit-harness-format-');
    try {
      queueNanoHostHarnessOperation(coreDb, {
        body: sessionOpenBody(),
        harnessInstanceId: 'harness-1',
        operation: 'session.open',
        timestamp: now,
      });
      coreDb.sqlite.exec(
        "UPDATE harness_instance_records SET schema_version = 2, command_body_json = '{'"
      );
      const before = coreDb.sqlite.serialize();
      expect(() =>
        dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          now: () => now,
        })
      ).toThrow('Unsupported retained record format.');
      expect(() =>
        queueNanoHostHarnessOperation(coreDb, {
          body: {},
          harnessInstanceId: 'harness-1',
          operation: 'harness.drain',
          timestamp: now,
        })
      ).toThrow('Unsupported retained record format.');
      expect(() =>
        drainNanoHostHarnessAdmission(coreDb, {
          harnessBindingRef: 'harness-binding-1',
          timestamp: now,
        })
      ).toThrow('Unsupported retained record format.');
      expect(coreDb.sqlite.serialize().equals(before)).toBe(true);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses an unknown AgentSession binding before decoding environment or granting reuse', () => {
    const coreDb = openOpeningBindingDb('openkit-harness-binding-format-');
    try {
      coreDb.sqlite.exec(
        "UPDATE agent_session_runtime_bindings SET schema_version = 2, native_environment_json = '{'"
      );
      const before = coreDb.sqlite.serialize();
      expect(() =>
        queueNanoHostHarnessOperation(coreDb, {
          body: sessionOpenBody(),
          harnessInstanceId: 'harness-1',
          operation: 'session.open',
          timestamp: now,
        })
      ).toThrow('Unsupported retained record format.');
      expect(() =>
        readNanoHostThreadAgentSessionBinding(coreDb, {
          workspaceId: testEntityId('ws', 'workspace-1'),
          threadId: testEntityId('th', 'thread-1'),
        })
      ).toThrow('Unsupported retained record format.');
      expect(() =>
        copyNanoHostMeasuredHarnessIdentity(coreDb, {
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
          imageDigest: `sha256:${'f'.repeat(64)}`,
          timestamp: now,
        })
      ).toThrow('Unsupported retained record format.');
      expect(coreDb.sqlite.serialize().equals(before)).toBe(true);
    } finally {
      coreDb.sqlite.close();
    }
  });

  // Twenty durable Turn admissions need fixture time under parallel gates; capacity assertions stay exact.
  it('runs twenty Thread-bound Turns in one Harness and releases only the inspected sibling', () => {
    const coreDb = openActiveTurnDb('twenty-thread-turns-', 20);
    try {
      // Test the active bound separately from the independent open-resident bound.
      coreDb.sqlite.exec('UPDATE harness_instance_records SET max_open_sessions = 21');
      for (let index = 2; index <= 21; index += 1) {
        openNanoHostAgentSessionBinding(coreDb, {
          agentSessionCompatibilityKey: 'b'.repeat(64),
          agentSessionId: testEntityId('as', `agent-session-${index}`),
          agentSessionRuntimeBindingId: `agent-session-binding-${index}`,
          effectiveSetupGeneration: 1,
          harnessInstanceId: 'harness-1',
          threadId: testEntityId('th', `thread-${index}`),
          timestamp: now,
          workspaceId: testEntityId('ws', 'workspace-1'),
        });
        seedSubmittedAttempt(coreDb, index);
        const start = () =>
          queueNanoHostHarnessOperation(coreDb, {
            body: concurrentTurnStartBody(index),
            harnessInstanceId: 'harness-1',
            operation: 'turn.start',
            timestamp: now,
          });
        if (index === 21) {
          expect(start).toThrow('active-Turn capacity is exhausted');
          break;
        }
        const sequence = start();
        const command = dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          now: () => now,
        })!;
        expect(sequence).toBe(command.sequence);
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          timestamp: now,
          result: {
            schemaVersion: 2,
            harnessInstanceId: 'harness-1',
            operationId: command.operationId,
            sequence: command.sequence,
            disposition: 'succeeded',
            body: { state: 'started', nativeHandleState: 'pending', nativeHandleDigest: null },
          },
        });
        consumeFixtureWorkspaceResult(coreDb, index);
      }
      expect(
        coreDb.sqlite
          .prepare('SELECT active_turn_count AS count FROM harness_instance_records')
          .get()
      ).toEqual({ count: 20 });
      // The last start belongs to Thread 20, not the addressed Thread 1.
      queueNanoHostHarnessOperation(coreDb, {
        body: { ...interruptBody(), purpose: 'interrupt' },
        harnessInstanceId: 'harness-1',
        operation: 'turn.interrupt',
        timestamp: now,
      });
      const interrupted = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      })!;
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        timestamp: now,
        result: {
          schemaVersion: 2,
          harnessInstanceId: 'harness-1',
          operationId: interrupted.operationId,
          sequence: interrupted.sequence,
          disposition: 'succeeded',
          body: { state: 'interrupted' },
        },
      });
      consumeFixtureWorkspaceResult(coreDb);
      expect(
        coreDb.sqlite
          .prepare('SELECT active_turn_count AS count FROM harness_instance_records')
          .get()
      ).toEqual({ count: 20 });
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: testEntityId('as', 'agent-session-1'),
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
        },
        harnessInstanceId: 'harness-1',
        operation: 'session.inspect',
        timestamp: now,
      });
      const inspection = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      })!;
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        timestamp: now,
        result: {
          schemaVersion: 2,
          harnessInstanceId: 'harness-1',
          operationId: inspection.operationId,
          sequence: inspection.sequence,
          disposition: 'succeeded',
          body: {
            state: 'open',
            childState: 'running',
            cleanupState: 'clean',
            nativeHandleState: 'ready',
            nativeHandleDigest: 'c'.repeat(64),
          },
        },
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT active_turn_count AS count FROM harness_instance_records')
          .get()
      ).toEqual({ count: 19 });
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM agent_session_runtime_bindings WHERE lifecycle_state = 'active'"
          )
          .get()
      ).toEqual({ count: 19 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT current_attempt_id AS attempt FROM agent_session_runtime_bindings WHERE agent_session_id = ?'
          )
          .get(testEntityId('as', 'agent-session-20'))
      ).toEqual({ attempt: testEntityId('attempt', 'lease-20') });
    } finally {
      coreDb.sqlite.close();
    }
  }, 60_000);

  it('admits idle sibling continuity and keeps exact live-attempt refusal', () => {
    const coreDb = openActiveTurnDb('openkit-harness-idle-sibling-');
    try {
      const scope = {
        agentSessionId: testEntityId('as', 'agent-session-2'),
        threadId: testEntityId('th', 'thread-2'),
        workspaceId: testEntityId('ws', 'workspace-1'),
      };
      const binding = {
        ...scope,
        agentSessionCompatibilityKey: deriveNanoHostAgentSessionCompatibilityKey({
          adapterId: 'codex',
          adapterVersion: '0.153.4',
          harnessCompatibilityKey: 'd'.repeat(64),
          sessionCompatibilityKey: `sha256:${'b'.repeat(64)}`,
          threadId: scope.threadId,
        }),
        agentSessionRuntimeBindingId: 'agent-session-binding-2',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        timestamp: now,
      };
      openNanoHostAgentSessionBinding(coreDb, binding);
      const { harnessInstanceId, timestamp, ...openBinding } = binding;
      queueNanoHostHarnessOperation(coreDb, {
        body: { ...sessionOpenBody(), ...openBinding },
        harnessInstanceId,
        operation: 'session.open',
        timestamp,
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      })!;
      const ready = { nativeHandleState: 'ready', nativeHandleDigest: 'c'.repeat(64) };
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        timestamp,
        result: {
          schemaVersion: 2,
          harnessInstanceId,
          operationId: command.operationId,
          sequence: command.sequence,
          disposition: 'succeeded',
          body: { state: 'open', maxActiveTurns: 1, ...ready },
        },
      });
      // Deliberate count fault: exact live-attempt refusal must remain independent.
      coreDb.sqlite.exec('UPDATE harness_instance_records SET active_turn_count = 0');
      const active = {
        ...scope,
        agentSessionId: testEntityId('as', 'agent-session-1'),
        threadId: testEntityId('th', 'thread-1'),
      };
      expect(() => inspectNanoHostAgentSessionContinuity(coreDb, active)).toThrow();
      coreDb.sqlite.exec('UPDATE harness_instance_records SET active_turn_count = 1');
      expect(
        inspectNanoHostAgentSessionContinuity(coreDb, {
          ...scope,
          agentSessionCompatibilityKey: `sha256:${'b'.repeat(64)}`,
        })
      ).toMatchObject({ reusable: true });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('reserves the shared Sandbox bound while another runtime Harness start is still queued', () => {
    const coreDb = openActiveTurnDb('cross-harness-queued-capacity-', 2);
    try {
      createNanoHostHarnessRuntime(coreDb, {
        maxActiveTurns: 2,
        adapterId: 'pi',
        adapterVersion: '1.0.2',
        harnessBindingRef: 'harness-binding-2',
        harnessCompatibilityKey: 'c'.repeat(64),
        harnessInstanceId: 'harness-2',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: 'sandbox-binding-1',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-1',
        sandboxRuntimeId: 'sandbox-runtime-1',
        runtimeTargetId: 'nanohost-a1',
        timestamp: now,
      });
      for (const index of [2, 3]) {
        openNanoHostAgentSessionBinding(coreDb, {
          agentSessionCompatibilityKey: 'b'.repeat(64),
          agentSessionId: testEntityId('as', `agent-session-${index}`),
          agentSessionRuntimeBindingId: `agent-session-binding-${index}`,
          effectiveSetupGeneration: 1,
          harnessInstanceId: index === 2 ? 'harness-2' : 'harness-1',
          threadId: testEntityId('th', `thread-${index}`),
          workspaceId: testEntityId('ws', 'workspace-1'),
          timestamp: now,
        });
        seedSubmittedAttempt(coreDb, index);
      }
      expect(
        queueNanoHostHarnessOperation(coreDb, {
          body: concurrentTurnStartBody(2),
          harnessInstanceId: 'harness-2',
          operation: 'turn.start',
          timestamp: now,
        })
      ).toBe(0);
      const third = () =>
        queueNanoHostHarnessOperation(coreDb, {
          body: concurrentTurnStartBody(3),
          harnessInstanceId: 'harness-1',
          operation: 'turn.start',
          timestamp: now,
        });
      expect(third).toThrow('Sandbox active-Turn capacity is exhausted');
      expect(harnessOperation(coreDb)).toEqual({ operation: 'turn.start', state: 'settled' });
      const second = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      })!;
      expect(second.harnessInstanceId).toBe('harness-2');
      expect(third).toThrow('Sandbox active-Turn capacity is exhausted');
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        timestamp: now,
        result: {
          schemaVersion: 2,
          harnessInstanceId: 'harness-2',
          operationId: second.operationId,
          sequence: second.sequence,
          disposition: 'succeeded',
          body: { state: 'started', nativeHandleState: 'pending', nativeHandleDigest: null },
        },
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT SUM(active_turn_count) AS active FROM harness_instance_records')
          .get()
      ).toEqual({ active: 2 });
      expect(third).toThrow('Sandbox active-Turn capacity is exhausted');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('admits a positive aggregate Sandbox active-Turn bound above one', () => {
    const coreDb = openOpeningBindingDb('sandbox-concurrent-capacity-');
    try {
      expect(() =>
        coreDb.sqlite.exec('UPDATE sandbox_runtime_records SET max_active_turns = 8')
      ).not.toThrow();
      expect(() =>
        coreDb.sqlite.exec('UPDATE sandbox_runtime_records SET max_active_turns = 0')
      ).toThrow();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('carries the exact Core attempt id in the unchanged private leaseId field for start and interrupt', () => {
    const coreDb = openActiveTurnDb('route-b-attempt-wire-');
    try {
      const table = coreDb.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
        )
        .get();
      const rows = table
        ? (coreDb.sqlite
            .prepare('SELECT * FROM scheduler_execution_attempts WHERE turn_id = ?')
            .all(testEntityId('tu', 'turn-1')) as Record<string, unknown>[])
        : [];
      expect(rows).toHaveLength(1);
      const attemptId = rows[0]!.attempt_id;
      const started = coreDb.sqlite
        .prepare(
          "SELECT command_body_json AS body FROM harness_instance_records WHERE operation = 'turn.start'"
        )
        .get() as { body: string };
      expect(JSON.parse(started.body)).toMatchObject({
        leaseId: attemptId,
        turnId: testEntityId('tu', 'turn-1'),
      });
      expect(
        coreDb.sqlite
          .prepare(`SELECT current_attempt_id AS currentAttemptId,
        current_turn_id AS currentTurnId, lifecycle_state AS lifecycleState
        FROM agent_session_runtime_bindings WHERE agent_session_id = ?`)
          .get(testEntityId('as', 'agent-session-1'))
      ).toEqual({
        currentAttemptId: attemptId,
        currentTurnId: testEntityId('tu', 'turn-1'),
        lifecycleState: 'active',
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: { ...interruptBody(), leaseId: attemptId, purpose: 'interrupt' },
        harnessInstanceId: 'harness-1',
        operation: 'turn.interrupt',
        timestamp: now,
      });
      const interrupted = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      });
      expect(interrupted!.body).toMatchObject({
        leaseId: attemptId,
        turnId: testEntityId('tu', 'turn-1'),
      });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM harness_instance_records').get()
      ).toEqual({ count: 1 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('admits only workspace materialization startup failures at session open', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-open-refusal-')));
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
        agentSessionId: testEntityId('as', 'agent-session-1'),
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-1'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });

      queueNanoHostHarnessOperation(coreDb, {
        body: {
          adapterId: 'codex',
          agentSessionCompatibilityKey: 'b'.repeat(64),
          agentSessionId: testEntityId('as', 'agent-session-1'),
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
          effectiveSetupGeneration: 1,
          resume: null,
          threadId: testEntityId('th', 'thread-1'),
          workspaceId: testEntityId('ws', 'workspace-1'),
        },
        harnessInstanceId: 'harness-1',
        operation: 'session.open',
        timestamp: now,
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      })!;
      const result = {
        body: {
          reasonCode: 'dependency_failed',
          startupFailure: {
            stage: 'workspace_materialization',
            reason: 'git_fetch_http_refused',
            explanation: {
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
            },
          },
        },
        disposition: 'refused' as const,
        harnessInstanceId: 'harness-1',
        operationId: command.operationId,
        schemaVersion: 2 as const,
        sequence: command.sequence,
      };
      const settle = (body: Record<string, unknown>) =>
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result: { ...result, body },
          timestamp: now,
        });
      expect(() =>
        settle({ ...result.body, startupFailure: { stage: 'runtime_supply', reason: 'failed' } })
      ).toThrow('startup failure is invalid');
      expect(() => settle({ ...result.body, reasonCode: 'busy' })).toThrow(
        'startup failure is invalid'
      );
      expect(() =>
        settle({
          ...result.body,
          note: 'ignored',
          startupFailure: {
            ...result.body.startupFailure,
            note: 'ignored',
            explanation: {
              ...result.body.startupFailure.explanation,
              note: 'ignored',
              evidence: { ...result.body.startupFailure.explanation.evidence, note: 'ignored' },
            },
          },
        })
      ).not.toThrow();
      const stored = coreDb.sqlite
        .prepare('SELECT result_json, result_fingerprint FROM harness_instance_records')
        .get() as { result_json: string; result_fingerprint: string };
      expect(JSON.parse(stored.result_json)).toEqual(result);
      expect(stored.result_fingerprint).toBe(
        createHash('sha256').update(stored.result_json).digest('hex')
      );
      expect(() => settle(result.body)).not.toThrow();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retains three compatibility-keyed Harnesses and refuses a new Harness after exact Sandbox drain', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-multi-harness-records-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      for (const [adapterId, adapterVersion, harnessInstanceId, compatibilityKey] of [
        ['codex', '0.153.4', 'harness-codex', 'b'.repeat(64)],
        ['opencode', '1.18.1', 'harness-opencode', 'c'.repeat(64)],
        ['pi', '0.85.1', 'harness-pi', 'd'.repeat(64)],
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
        { adapterId: 'pi', harnessCompatibilityKey: 'd'.repeat(64) },
      ]);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT adapter_id AS adapterId, capabilities_json AS capabilities FROM harness_instance_records ORDER BY adapter_id'
          )
          .all()
      ).toEqual([
        // Every resident binding follows one lifecycle, so no adapter carries a continuity mode.
        { adapterId: 'codex', capabilities: '[]' },
        { adapterId: 'opencode', capabilities: '[]' },
        { adapterId: 'pi', capabilities: '[]' },
      ]);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 1 });
      expect(
        coreDb.sqlite
          .prepare(`SELECT COUNT(h.harness_instance_id) AS count,
          s.max_harnesses AS maxHarnesses FROM sandbox_runtime_records s
          JOIN harness_instance_records h ON h.sandbox_runtime_id = s.sandbox_runtime_id
          WHERE s.sandbox_runtime_id = ?`)
          .get('sandbox-runtime-shared')
      ).toEqual({ count: 3, maxHarnesses: 8 });
      const readyTarget = coreDb.sqlite.prepare(`SELECT ready, fresh_empty AS freshEmpty,
        predecessor_fenced AS predecessorFenced, physical_epoch AS physicalEpoch
        FROM nanohost_runtime_targets WHERE target_id = ?`);
      expect(readyTarget.get('nanohost-a1')).toEqual({
        ready: 1,
        freshEmpty: 1,
        predecessorFenced: 1,
        physicalEpoch,
      });
      // Sandbox termination stops admission across the Integration, including a new Harness.
      drainNanoHostSandboxAdmission(coreDb, {
        sandboxBindingRef: 'sandbox-binding-shared',
        originPhysicalEpoch: physicalEpoch,
      });
      expect(
        coreDb.sqlite
          .prepare(`SELECT lifecycle_state AS lifecycleState,
        health_state AS healthState, drain_state AS drainState, cleanup_state AS cleanupState
        FROM sandbox_runtime_records WHERE sandbox_runtime_id = ?`)
          .get('sandbox-runtime-shared')
      ).toEqual({
        lifecycleState: 'open',
        healthState: 'ready',
        drainState: 'draining',
        cleanupState: 'clean',
      });
      const before = coreDb.sqlite.serialize();
      expect(() =>
        createNanoHostHarnessRuntime(coreDb, {
          adapterId: 'codex',
          adapterVersion: '0.153.5',
          harnessBindingRef: 'binding-harness-late',
          harnessCompatibilityKey: '9'.repeat(64),
          harnessInstanceId: 'harness-late',
          imageDigest: `sha256:${'f'.repeat(64)}`,
          originPhysicalEpoch: physicalEpoch,
          sandboxBindingRef: 'sandbox-binding-shared',
          sandboxCompatibilityKey: 'a'.repeat(64),
          sandboxIntegrationBindingRef: 'integration-binding-shared',
          sandboxRuntimeId: 'sandbox-runtime-shared',
          runtimeTargetId: 'nanohost-a1',
          timestamp: now,
        })
      ).toThrow();
      expect(coreDb.sqlite.serialize().equals(before)).toBe(true);
      expect(readyTarget.get('nanohost-a1')).toEqual({
        ready: 1,
        freshEmpty: 1,
        predecessorFenced: 1,
        physicalEpoch,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'codex',
    'pi',
    'opencode',
    'deepseek',
  ])('keys %s native continuity by its opaque adapter identity', (adapterId) => {
    const input = {
      adapterId,
      adapterVersion: 'fixture-version',
      harnessCompatibilityKey: 'b'.repeat(64),
      sessionCompatibilityKey: `sha256:${'c'.repeat(64)}`,
      threadId: testEntityId('th', 'thread-mode-fixture'),
    };
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          nativeConversation: {
            adapterId,
            adapterVersion: input.adapterVersion,
            harnessCompatibilityKey: input.harnessCompatibilityKey,
          },
          sessionCompatibilityKey: input.sessionCompatibilityKey,
          threadId: input.threadId,
        })
      )
      .digest('hex');
    expect(deriveNanoHostAgentSessionCompatibilityKey(input)).toBe(expected);
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

  it('keeps v1 Harness and AgentSession projections distinct from Sandbox and Turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-harness-records-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const coreDb = openCoreDb(root);
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
        agentSessionId: testEntityId('as', 'agent-session-1'),
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-1'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT schema_version AS schemaVersion FROM harness_instance_records')
          .get()
      ).toEqual({ schemaVersion: 1 });
      expect(
        coreDb.sqlite
          .prepare('SELECT schema_version AS schemaVersion FROM agent_session_runtime_bindings')
          .get()
      ).toEqual({ schemaVersion: 1 });
      expect
        .soft(() =>
          openNanoHostAgentSessionBinding(coreDb, {
            agentSessionCompatibilityKey: 'c'.repeat(64),
            agentSessionId: testEntityId('as', 'agent-session-same-thread'),
            agentSessionRuntimeBindingId: 'agent-session-binding-same-thread',
            effectiveSetupGeneration: 1,
            harnessInstanceId: 'harness-1',
            threadId: testEntityId('th', 'thread-1'),
            timestamp: now,
            workspaceId: testEntityId('ws', 'workspace-1'),
          })
        )
        .toThrow();
      expect(
        readNanoHostThreadAgentSessionBinding(coreDb, {
          threadId: testEntityId('th', 'thread-1'),
          workspaceId: testEntityId('ws', 'workspace-1'),
        })
      ).toEqual({ agentSessionId: testEntityId('as', 'agent-session-1') });
      expect(
        readNanoHostThreadAgentSessionBinding(coreDb, {
          threadId: testEntityId('th', 'thread-missing'),
          workspaceId: testEntityId('ws', 'workspace-1'),
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
          agentSessionId: testEntityId('as', 'agent-session-2'),
          agentSessionRuntimeBindingId: 'agent-session-binding-2',
          effectiveSetupGeneration: 1,
          harnessInstanceId: 'harness-1',
          threadId: testEntityId('th', 'thread-2'),
          timestamp: now,
          workspaceId: testEntityId('ws', 'workspace-1'),
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
      ).toEqual({ maxActiveTurns: 20, openSessionCount: 2 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT agent_session_id AS agentSessionId, native_handle_state AS nativeHandleState FROM agent_session_runtime_bindings ORDER BY agent_session_id'
          )
          .all()
      ).toEqual([
        { agentSessionId: testEntityId('as', 'agent-session-1'), nativeHandleState: 'pending' },
        { agentSessionId: testEntityId('as', 'agent-session-2'), nativeHandleState: 'pending' },
      ]);
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tu_00000000-0000-72f1-bbf1-0357e359bf5e'"
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
        agentSessionId: testEntityId('as', 'agent-session-1'),
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-1'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });
      seedSubmittedAttempt(coreDb);
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          aepRef: 'sandbox://aep/1',
          agentSessionId: testEntityId('as', 'agent-session-1'),
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
          contextPackageId: 'context-package-1',
          contextRef: 'sandbox://context/1',
          deadline: '2099-01-01T00:00:00.000Z',
          leaseId: testEntityId('attempt', 'lease-1'),
          packageSnapshotId: 'package-snapshot-1',
          threadId: testEntityId('th', 'thread-1'),
          turnId: testEntityId('tu', 'turn-1'),
          turnSequence: 0,
          workspaceId: testEntityId('ws', 'workspace-1'),
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
      consumeFixtureWorkspaceResult(coreDb);
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: testEntityId('as', 'agent-session-1'),
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
                      current_turn_id AS currentTurnId, current_attempt_id AS currentAttemptId,
                      cleanup_state AS cleanupState
               FROM agent_session_runtime_bindings
               WHERE agent_session_runtime_binding_id = ?`
          )
          .get('agent-session-binding-1')
      ).toEqual({
        agentSessionId: testEntityId('as', 'agent-session-1'),
        cleanupState: 'clean',
        currentAttemptId: testEntityId('attempt', 'lease-1'),
        currentTurnId: testEntityId('tu', 'turn-1'),
        lifecycleState: state,
      });
      expect(() =>
        openNanoHostAgentSessionBinding(coreDb, {
          agentSessionCompatibilityKey: 'c'.repeat(64),
          agentSessionId: testEntityId('as', 'agent-session-2'),
          agentSessionRuntimeBindingId: 'agent-session-binding-2',
          effectiveSetupGeneration: 1,
          harnessInstanceId: 'harness-1',
          threadId: testEntityId('th', 'thread-1'),
          timestamp: now,
          workspaceId: testEntityId('ws', 'workspace-1'),
        })
      ).toThrow('NanoHost Harness already has a current AgentSession for this Thread.');
      expect(
        readNanoHostThreadAgentSessionBinding(coreDb, {
          threadId: testEntityId('th', 'thread-1'),
          workspaceId: testEntityId('ws', 'workspace-1'),
        })
      ).toEqual({ agentSessionId: testEntityId('as', 'agent-session-1') });
      coreDb.sqlite
        .prepare(
          `INSERT INTO agent_session_runtime_bindings (
               agent_session_runtime_binding_id, harness_instance_id, agent_session_id,
               workspace_id, thread_id, agent_session_compatibility_key,
               effective_setup_generation, native_handle_state, native_handle_digest,
               lifecycle_state, current_turn_id, current_attempt_id, next_turn_sequence, cleanup_state,
               created_at, updated_at, image_digest
             ) VALUES (?, 'harness-1', ?, ?, ?, ?, 1, 'pending', NULL,
                       'opening', NULL, NULL, 0, 'clean', ?, ?, ?)`
        )
        .run(
          'agent-session-binding-2',
          testEntityId('as', 'agent-session-2'),
          testEntityId('ws', 'workspace-1'),
          testEntityId('th', 'thread-1'),
          'c'.repeat(64),
          now,
          now,
          `sha256:${'f'.repeat(64)}`
        );
      expect(() =>
        readNanoHostThreadAgentSessionBinding(coreDb, {
          threadId: testEntityId('th', 'thread-1'),
          workspaceId: testEntityId('ws', 'workspace-1'),
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
        agentSessionId: testEntityId('as', 'agent-session-1'),
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-1'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });
      seedSubmittedAttempt(coreDb);
      const workerControlToken = Buffer.alloc(32, 1).toString('base64url');
      const inferenceToken = Buffer.alloc(32, 2).toString('base64url');
      const capabilityToken = Buffer.alloc(32, 3).toString('base64url');
      const tokens = [workerControlToken, inferenceToken, capabilityToken];
      const operationInput = {
        body: {
          aepRef: 'sandbox://aep/1',
          agentSessionId: testEntityId('as', 'agent-session-1'),
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
          contextPackageId: 'context-package-1',
          contextRef: 'sandbox://context/1',
          deadline: '2099-01-01T00:00:00.000Z',
          leaseId: testEntityId('attempt', 'lease-1'),
          packageSnapshotId: 'package-snapshot-1',
          threadId: testEntityId('th', 'thread-1'),
          turnId: testEntityId('tu', 'turn-1'),
          turnSequence: 0,
          workspaceId: testEntityId('ws', 'workspace-1'),
        },
        harnessInstanceId: 'harness-1',
        operation: 'turn.start',
        timestamp: now,
      } satisfies Parameters<typeof prepareNanoHostHarnessOperation>[1];
      const prepared = prepareNanoHostHarnessOperation(coreDb, {
        ...operationInput,
        routeToken: () => tokens.shift()!,
      });
      queueNanoHostHarnessOperation(coreDb, { ...operationInput, prepared });

      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      });
      expect(command).toEqual(prepared.command);
      expect({ ...prepared.command, body: prepared.wireBody }).toMatchObject({
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
      const attempt = observeExecutionAttempts(coreDb).find(
        (row) => row.turn_id === testEntityId('tu', 'turn-1')
      );
      expect(attempt).toMatchObject({
        worker_control_token_hash: createHash('sha256')
          .update(Buffer.from(workerControlToken, 'base64url'))
          .digest('hex'),
        worker_inference_token_hash: createHash('sha256')
          .update(Buffer.from(inferenceToken, 'base64url'))
          .digest('hex'),
        worker_capability_token_hash: createHash('sha256')
          .update(Buffer.from(capabilityToken, 'base64url'))
          .digest('hex'),
      });
      expect(
        new Set([
          attempt?.worker_control_token_hash,
          attempt?.worker_inference_token_hash,
          attempt?.worker_capability_token_hash,
        ]).size
      ).toBe(3);
      for (const token of [workerControlToken, inferenceToken, capabilityToken])
        expect(JSON.stringify(attempt)).not.toContain(token);
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
        { stage: 'workspace_materialization', reason: 'secret-canary' },
        { stage: 'unknown_stage', reason: 'failed' },
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
        result:
          disposition === 'refused'
            ? {
                ...result,
                note: 'ignored',
                body: {
                  ...result.body,
                  note: 'ignored',
                  startupFailure: {
                    stage: 'workspace_materialization',
                    reason: 'retained_baseline_unavailable',
                    note: 'ignored',
                  },
                },
              }
            : result,
        timestamp: now,
      });
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        result,
        timestamp: now,
      });
      const receipt = coreDb.sqlite
        .prepare('SELECT result_json FROM harness_instance_records')
        .get() as { result_json: string };
      expect(JSON.parse(receipt.result_json)).toEqual(result);
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

      // docs/specs/20261019-durable_execution_and_control_store.md:301-305 requires receipt retention and blocked dispatch.
      // Enqueue still accepts settled state without clearing its receipt (nanohost-harness-records.ts:877-905).
      expect(
        queueNanoHostHarnessOperation(coreDb, {
          body: {
            agentSessionId: testEntityId('as', 'agent-session-1'),
            agentSessionRuntimeBindingId: 'agent-session-binding-1',
          },
          harnessInstanceId: 'harness-1',
          operation: 'session.inspect',
          timestamp: now,
        })
      ).toBe(1);
      const inspect = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
      });
      expect(inspect).toBeNull();
      expect(
        coreDb.sqlite.prepare('SELECT result_json FROM harness_instance_records').get()
      ).toEqual(receipt);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('removes only the closed AgentSession binding and decrements open_session_count', () => {
    let coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-session-close-')));
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
        agentSessionId: testEntityId('as', 'agent-session-1'),
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-1'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'c'.repeat(64),
        agentSessionId: testEntityId('as', 'agent-session-2'),
        agentSessionRuntimeBindingId: 'agent-session-binding-2',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-2'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: testEntityId('as', 'agent-session-1'),
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
        },
        harnessInstanceId: 'harness-1',
        operation: 'session.close',
        timestamp: now,
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
      });
      const result = {
        body: { childState: 'absent', privateState: 'absent', state: 'closed' },
        disposition: 'succeeded',
        harnessInstanceId: 'harness-1',
        operationId: command!.operationId,
        schemaVersion: 2,
        sequence: command!.sequence,
      } as const;
      const settle = () =>
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result,
          timestamp: now,
        });
      expect(settle).not.toThrow();

      expect(
        coreDb.sqlite
          .prepare(
            'SELECT agent_session_id AS agentSessionId FROM agent_session_runtime_bindings ORDER BY agent_session_id'
          )
          .all()
      ).toEqual([{ agentSessionId: testEntityId('as', 'agent-session-2') }]);
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
      // DX Physical Receipt Consumption: idle close consumes through Core, without a Turn.
      expect(hasConsumedNanoHostHarnessResult(coreDb, result)).toBe(true);
      const retained = coreDb.sqlite
        .prepare('SELECT result_json, result_fingerprint FROM harness_instance_records')
        .get() as { result_json: string; result_fingerprint: string };
      const root = coreDb.dataRoot;
      coreDb.sqlite.close();
      coreDb = openCoreDb(root);
      expect(hasConsumedNanoHostHarnessResult(coreDb, result)).toBe(true);
      expect(settle()).toBe('replayed');
      expect(
        readNanoHostThreadAgentSessionBinding(coreDb, {
          workspaceId: testEntityId('ws', 'workspace-1'),
          threadId: testEntityId('th', 'thread-1'),
        })
      ).toBeNull();
      const sibling = {
        workspaceId: testEntityId('ws', 'workspace-1'),
        threadId: testEntityId('th', 'thread-2'),
      };
      expect(readNanoHostThreadAgentSessionBinding(coreDb, sibling)).toEqual({
        agentSessionId: testEntityId('as', 'agent-session-2'),
      });
      // Fault injection changes a real settled receipt; it creates no successful setup fact.
      const receipt = JSON.parse(retained.result_json) as Record<string, unknown>;
      const writeFault = (value: Record<string, unknown>, fingerprint?: string) => {
        const bytes = JSON.stringify(value);
        coreDb.sqlite
          .prepare('UPDATE harness_instance_records SET result_json = ?, result_fingerprint = ?')
          .run(bytes, fingerprint ?? createHash('sha256').update(bytes).digest('hex'));
      };
      // Both false and a refusal exception mean the invalid receipt was not acknowledged.
      const consumed = (
        incoming: Parameters<typeof hasConsumedNanoHostHarnessResult>[1] = result
      ) => {
        try {
          return hasConsumedNanoHostHarnessResult(coreDb, incoming);
        } catch {
          return false;
        }
      };
      const { consumerContext: _namespace, ...withoutNamespace } = receipt;
      writeFault(withoutNamespace);
      expect(consumed()).toBe(false);
      writeFault({
        ...receipt,
        consumerContext: {
          workspaceId: testEntityId('ws', 'other-workspace'),
          threadId: sibling.threadId,
        },
      });
      expect(consumed()).toBe(false);
      writeFault(receipt);
      expect(consumed({ ...result, body: { ...result.body, privateState: 'present' } })).toBe(
        false
      );
      writeFault(receipt, '0'.repeat(64));
      expect(consumed()).toBe(false);
      expect(readNanoHostThreadAgentSessionBinding(coreDb, sibling)).toEqual({
        agentSessionId: testEntityId('as', 'agent-session-2'),
      });
      coreDb.sqlite
        .prepare('UPDATE harness_instance_records SET result_json = ?, result_fingerprint = ?')
        .run(retained.result_json, retained.result_fingerprint);
      expect(consumed()).toBe(true);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    1, 2,
  ])('Q171 compute neutrality case 5: retry provider mutation deduplicates before replay — closed binding %i', (closedSession) => {
    const coreDb = openActiveTurnDb('openkit-harness-close-occupancy-');
    try {
      recordFinalStatus(coreDb, 'failed', 'error');
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'c'.repeat(64),
        agentSessionId: testEntityId('as', 'agent-session-2'),
        agentSessionRuntimeBindingId: 'agent-session-binding-2',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-2'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: testEntityId('as', `agent-session-${closedSession}`),
          agentSessionRuntimeBindingId: `agent-session-binding-${closedSession}`,
        },
        harnessInstanceId: 'harness-1',
        operation: 'session.close',
        timestamp: now,
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
      });
      const result = {
        body: { childState: 'absent', privateState: 'absent', state: 'closed' },
        disposition: 'succeeded',
        harnessInstanceId: 'harness-1',
        operationId: command!.operationId,
        schemaVersion: 2,
        sequence: command!.sequence,
      } as const;
      expect(
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result: { ...result, note: 'ignored', body: { ...result.body, note: 'ignored' } },
          timestamp: now,
        })
      ).toBe('settled');
      const stored = coreDb.sqlite
        .prepare('SELECT result_json, result_fingerprint FROM harness_instance_records')
        .get() as { result_json: string; result_fingerprint: string };
      const retained = JSON.parse(stored.result_json) as Record<string, unknown>;
      const { consumerContext, consumption, ...retainedResult } = retained;
      // DX Physical Receipt Consumption retains the removed binding's namespace and Core idle proof.
      expect(retainedResult).toEqual(result);
      expect(consumerContext).toEqual({
        workspaceId: testEntityId('ws', 'workspace-1'),
        threadId: testEntityId('th', `thread-${closedSession}`),
      });
      // Session 1 still owns Turn occupancy; session 2 is idle and consumes in the Core transaction.
      expect(consumption !== undefined).toBe(closedSession === 2);
      expect(hasConsumedNanoHostHarnessResult(coreDb, result)).toBe(closedSession === 2);
      expect(stored.result_fingerprint).toBe(
        createHash('sha256').update(stored.result_json).digest('hex')
      );
      const retainedBytes = JSON.stringify({
        ...retained,
        note: 'retained extension',
        body: { ...result.body, note: 'retained extension' },
      });
      coreDb.sqlite
        .prepare('UPDATE harness_instance_records SET result_json = ?, result_fingerprint = ?')
        .run(retainedBytes, createHash('sha256').update(retainedBytes).digest('hex'));
      expect(
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result: { ...result, note: 'ignored', body: { ...result.body, note: 'ignored' } },
          timestamp: now,
        })
      ).toBe('replayed');
      expect(
        (
          coreDb.sqlite.prepare('SELECT result_json FROM harness_instance_records').get() as {
            result_json: string;
          }
        ).result_json
      ).toBe(retainedBytes);
      coreDb.sqlite
        .prepare('UPDATE harness_instance_records SET result_fingerprint = ?')
        .run('0'.repeat(64));
      expect(() =>
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result,
          timestamp: now,
        })
      ).toThrow(/fingerprint/);
      coreDb.sqlite
        .prepare('UPDATE harness_instance_records SET result_fingerprint = ?')
        .run(createHash('sha256').update(retainedBytes).digest('hex'));
      expect(() =>
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result: { ...result, body: { ...result.body, childState: 'running' } },
          timestamp: now,
        })
      ).toThrow(/replay|conflict/);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT active_turn_count AS activeTurnCount, open_session_count AS openSessionCount,
                    operation_state AS operationState FROM harness_instance_records`
          )
          .get()
      ).toEqual({
        activeTurnCount: closedSession === 1 ? 0 : 1,
        openSessionCount: 1,
        operationState: 'settled',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT agent_session_id AS agentSessionId, current_turn_id AS currentTurnId,
                    current_attempt_id AS currentAttemptId FROM agent_session_runtime_bindings`
          )
          .all()
      ).toEqual([
        closedSession === 1
          ? {
              agentSessionId: testEntityId('as', 'agent-session-2'),
              currentTurnId: null,
              currentAttemptId: null,
            }
          : {
              agentSessionId: testEntityId('as', 'agent-session-1'),
              currentTurnId: testEntityId('tu', 'turn-1'),
              currentAttemptId: testEntityId('attempt', 'lease-1'),
            },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'refused',
    'unknown',
  ] as const)('preserves active binding occupancy after %s session.close', (disposition) => {
    const coreDb = openActiveTurnDb('openkit-harness-close-unproved-');
    try {
      recordFinalStatus(coreDb, 'failed', 'error');
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: testEntityId('as', 'agent-session-1'),
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
          body: {
            reasonCode: disposition === 'unknown' ? 'outcome_unknown' : 'cleanup_required',
          },
          disposition,
          harnessInstanceId: 'harness-1',
          operationId: command!.operationId,
          schemaVersion: 2,
          sequence: command!.sequence,
        },
        timestamp: now,
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT active_turn_count AS activeTurnCount, open_session_count AS openSessionCount
               FROM harness_instance_records`
          )
          .get()
      ).toEqual({ activeTurnCount: 1, openSessionCount: 1 });
      // cleanup_required fences admission without releasing the Turn. Unknown already drains.
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT drain_state AS drainState, lifecycle_state AS lifecycleState
               FROM harness_instance_records`
          )
          .get()
      ).toEqual({ drainState: 'draining', lifecycleState: 'failed' });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT current_turn_id AS currentTurnId, current_attempt_id AS currentAttemptId
               FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?`
          )
          .get('agent-session-binding-1')
      ).toEqual({
        currentTurnId: testEntityId('tu', 'turn-1'),
        currentAttemptId: testEntityId('attempt', 'lease-1'),
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      expected: { active: 0, lifecycleState: 'open', turnId: null },
      inspection: { cleanupState: 'clean', ready: true, state: 'open' },
      interruptFirst: false,
      name: 'releases the Turn slot on a clean open inspection',
    },
    {
      expected: { active: 0, lifecycleState: 'failed', turnId: null },
      inspection: { cleanupState: 'clean', ready: false, state: 'failed' },
      interruptFirst: false,
      name: 'releases the Turn slot on a clean failed inspection',
    },
    {
      expected: { active: 1, lifecycleState: 'failed', turnId: testEntityId('tu', 'turn-1') },
      inspection: { cleanupState: 'unknown', ready: false, state: 'failed' },
      interruptFirst: false,
      name: 'retains the Turn slot on an inspection without clean state',
    },
    {
      expected: { active: 1, lifecycleState: 'active', turnId: testEntityId('tu', 'turn-1') },
      inspection: null,
      interruptFirst: true,
      name: 'retains the Turn slot after a successful interrupt',
    },
    {
      expected: { active: 0, lifecycleState: 'open', turnId: null },
      inspection: { cleanupState: 'clean', ready: true, state: 'open' },
      interruptFirst: true,
      name: 'releases an interrupted Turn only at the clean inspection',
    },
  ] as const)('$name', ({ expected, inspection, interruptFirst }) => {
    const coreDb = openActiveTurnDb('openkit-harness-turn-barrier-');
    // Session credentials outlive each Turn; stopping a Turn cannot mint or revoke a binding credential.
    const inferenceDigest = createHash('sha256')
      .update('resident-inference-loopback')
      .digest('hex');
    const capabilityDigest = createHash('sha256')
      .update('resident-capability-loopback')
      .digest('hex');
    coreDb.sqlite
      .prepare(`UPDATE agent_session_runtime_bindings
      SET inference_loopback_credential_digest = ?, capability_loopback_credential_digest = ?
      WHERE agent_session_runtime_binding_id = ?`)
      .run(inferenceDigest, capabilityDigest, 'agent-session-binding-1');
    const settle = (
      operation: 'session.inspect' | 'turn.interrupt',
      commandBody: Readonly<Record<string, unknown>>,
      resultBody: Readonly<Record<string, unknown>>
    ) => {
      queueNanoHostHarnessOperation(coreDb, {
        body: commandBody,
        harnessInstanceId: 'harness-1',
        operation,
        timestamp: now,
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
      });
      expect(
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result: {
            body: resultBody,
            disposition: 'succeeded',
            harnessInstanceId: 'harness-1',
            operationId: command!.operationId,
            schemaVersion: 2,
            sequence: command!.sequence,
          },
          timestamp: now,
        })
      ).toBe('settled');
      if (operation === 'turn.interrupt') consumeFixtureWorkspaceResult(coreDb);
    };
    try {
      if (interruptFirst) {
        settle(
          'turn.interrupt',
          { ...interruptBody(), purpose: 'interrupt' },
          { childState: 'running', state: 'interrupted' }
        );
      }
      recordFinalStatus(coreDb, 'failed', 'error');
      if (inspection) {
        settle(
          'session.inspect',
          {
            agentSessionId: testEntityId('as', 'agent-session-1'),
            agentSessionRuntimeBindingId: 'agent-session-binding-1',
          },
          {
            childState: 'running',
            cleanupState: inspection.cleanupState,
            nativeHandleDigest: inspection.ready ? 'e'.repeat(64) : null,
            nativeHandleState: inspection.ready ? 'ready' : 'absent',
            state: inspection.state,
          }
        );
      }
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT h.active_turn_count AS active, b.lifecycle_state AS lifecycleState,
                    b.current_turn_id AS turnId
             FROM agent_session_runtime_bindings b
             JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id`
          )
          .get()
      ).toEqual(expected);
      expect(
        coreDb.sqlite
          .prepare(`SELECT h.open_session_count AS openSessions,
        b.inference_loopback_credential_digest AS inferenceDigest,
        b.capability_loopback_credential_digest AS capabilityDigest
        FROM agent_session_runtime_bindings b JOIN harness_instance_records h
        ON h.harness_instance_id = b.harness_instance_id`)
          .get()
      ).toEqual({
        openSessions: 1,
        inferenceDigest,
        capabilityDigest,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    { state: 'closed', queued: false, retainedCollision: true },
    { state: 'open', queued: false, retainedCollision: true },
    { state: 'closed', queued: true, retainedCollision: true },
    { state: 'open', queued: true, retainedCollision: true },
    { state: 'closed', queued: true, retainedCollision: false },
    { state: 'open', queued: true, retainedCollision: false },
  ])('keeps $state inspection core on replay (queued=$queued, retained collision=$retainedCollision)', ({
    state,
    queued,
    retainedCollision,
  }) => {
    const coreDb = openOpeningBindingDb('openkit-harness-inspection-replay-');
    try {
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: testEntityId('as', 'agent-session-1'),
          agentSessionRuntimeBindingId: 'agent-session-binding-1',
        },
        harnessInstanceId: 'harness-1',
        operation: 'session.inspect',
        timestamp: now,
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      })!;
      const body = {
        state,
        nativeHandleState: state === 'closed' ? 'absent' : 'pending',
        nativeHandleDigest: null,
        childState: 'absent',
        cleanupState: 'clean',
      };
      const collision = state === 'closed' ? { privateState: 'absent' } : { maxActiveTurns: 1 };
      const result = {
        body,
        disposition: 'succeeded' as const,
        harnessInstanceId: 'harness-1',
        operationId: command.operationId,
        schemaVersion: 2 as const,
        sequence: command.sequence,
      };
      const settle = (replayBody: Record<string, unknown>) =>
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result: { ...result, body: replayBody },
          timestamp: now,
        });
      expect(settle(body)).toBe('settled');
      const retainedBytes = JSON.stringify({
        ...result,
        body: {
          ...body,
          ...(retainedCollision ? collision : {}),
          note: 'retained inert addition',
        },
      });
      coreDb.sqlite
        .prepare('UPDATE harness_instance_records SET result_json = ?, result_fingerprint = ?')
        .run(retainedBytes, createHash('sha256').update(retainedBytes).digest('hex'));
      if (queued)
        queueNanoHostHarnessOperation(coreDb, {
          body: {},
          harnessInstanceId: 'harness-1',
          operation: 'harness.drain',
          timestamp: now,
        });
      // Buffer.equals compares every SQLite byte without deep equality enumerating byte indexes.
      const before = coreDb.sqlite.serialize();
      const extended = { ...body, ...collision, note: 'different inert addition' };
      expect(settle(extended)).toBe('replayed');
      if (queued && retainedCollision) {
        // The close/open interpretation still requires the colliding core on incoming replay.
        expect(() => settle(body)).toThrow(/result.*match|conflict/i);
      } else {
        // Even a collision in incoming metadata cannot affect the trusted predecessor reader.
        expect(settle(body)).toBe('replayed');
      }
      expect(coreDb.sqlite.serialize().equals(before)).toBe(true);
      for (const cleanupState of ['unknown', 'future']) {
        expect(() => settle({ ...extended, cleanupState })).toThrow();
        expect(coreDb.sqlite.serialize().equals(before)).toBe(true);
      }
      for (const missing of [
        'cleanupState',
        'childState',
        'nativeHandleState',
        'nativeHandleDigest',
      ]) {
        const incomplete: Record<string, unknown> = { ...extended };
        delete incomplete[missing];
        expect(() => settle(incomplete)).toThrow();
        expect(coreDb.sqlite.serialize().equals(before)).toBe(true);
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'plain',
    'workspace',
  ] as const)('acknowledges a lost %s refusal receipt with a queued successor and exact retained consumption', (kind) => {
    const coreDb = openOpeningBindingDb('openkit-harness-refusal-replay-');
    try {
      queueNanoHostHarnessOperation(coreDb, {
        body: sessionOpenBody(),
        harnessInstanceId: 'harness-1',
        operation: 'session.open',
        timestamp: now,
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      })!;
      const body: Record<string, unknown> =
        kind === 'plain'
          ? { reasonCode: 'busy' }
          : {
              reasonCode: 'dependency_failed',
              startupFailure: { stage: 'workspace_materialization', reason: 'git_fetch_failed' },
            };
      const result = {
        body,
        disposition: 'refused' as const,
        harnessInstanceId: 'harness-1',
        operationId: command.operationId,
        schemaVersion: 2 as const,
        sequence: command.sequence,
      };
      const settle = (replayBody: Record<string, unknown>) =>
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result: { ...result, body: replayBody },
          timestamp: now,
        });
      expect(settle(body)).toBe('settled');
      const consumption = consumeFixtureWorkspaceResult(coreDb);
      expect(consumption).toMatchObject({
        operationId: command.operationId,
        sequence: command.sequence,
        consumerReceipt: expect.any(String),
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {},
        harnessInstanceId: 'harness-1',
        operation: 'harness.drain',
        timestamp: now,
      });
      const before = coreDb.sqlite.serialize();
      expect(settle(body)).toBe('replayed');
      expect(
        settle({
          ...body,
          note: 'ignored',
          ...(kind === 'workspace'
            ? {
                startupFailure: {
                  ...(body.startupFailure as Record<string, unknown>),
                  note: 'ignored',
                },
              }
            : {}),
        })
      ).toBe('replayed');
      expect(coreDb.sqlite.serialize().equals(before)).toBe(true);
      expect(readFixtureWorkspaceConsumption(coreDb)).toEqual(consumption);
      const changedBodies = [
        { ...body, reasonCode: 'conflict' },
        { ...body, reasonCode: 'future' },
        ...(kind === 'workspace'
          ? [
              {
                ...body,
                startupFailure: {
                  stage: 'workspace_materialization',
                  reason: 'git_checkout_failed',
                },
              },
              { ...body, startupFailure: { stage: 'native_spawn', reason: 'git_fetch_failed' } },
              { reasonCode: 'dependency_failed' },
            ]
          : []),
      ];
      for (const changed of changedBodies) {
        expect(() => settle(changed)).toThrow();
        expect(coreDb.sqlite.serialize().equals(before)).toBe(true);
        expect(readFixtureWorkspaceConsumption(coreDb)).toEqual(consumption);
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses an unmatched queued predecessor without rewriting its fingerprint-valid receipt', () => {
    const coreDb = openOpeningBindingDb('openkit-harness-unmatched-replay-');
    try {
      queueNanoHostHarnessOperation(coreDb, {
        body: {},
        harnessInstanceId: 'harness-1',
        operation: 'harness.drain',
        timestamp: now,
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        now: () => now,
      })!;
      const result = {
        body: { state: 'draining', activeTurns: 0, openSessions: 0 },
        disposition: 'succeeded' as const,
        harnessInstanceId: 'harness-1',
        operationId: command.operationId,
        schemaVersion: 2 as const,
        sequence: command.sequence,
      };
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        result,
        timestamp: now,
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {},
        harnessInstanceId: 'harness-1',
        operation: 'harness.drain',
        timestamp: now,
      });
      // Exact drain replay and changed core use this receiver owner, without a synthetic consumer.
      const beforeReplay = coreDb.sqlite.serialize();
      const replay = (body: Record<string, unknown>) =>
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result: { ...result, body },
          timestamp: now,
        });
      expect(replay({ ...result.body, note: 'ignored replay addition' })).toBe('replayed');
      expect(coreDb.sqlite.serialize().equals(beforeReplay)).toBe(true);
      expect(() => replay({ ...result.body, activeTurns: 1 })).toThrow();
      expect(coreDb.sqlite.serialize().equals(beforeReplay)).toBe(true);
      const bytes = JSON.stringify({ ...result, body: { state: 'future' } });
      coreDb.sqlite
        .prepare('UPDATE harness_instance_records SET result_json = ?, result_fingerprint = ?')
        .run(bytes, createHash('sha256').update(bytes).digest('hex'));
      const before = coreDb.sqlite.serialize();
      expect(() =>
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result,
          timestamp: now,
        })
      ).toThrow();
      expect(coreDb.sqlite.serialize().equals(before)).toBe(true);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    false,
    true,
  ])('checks queued session.close replay without selector priority (inspection collision=%s)', (inspectionCollision) => {
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
        agentSessionId: testEntityId('as', 'agent-session-1'),
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-1'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: testEntityId('as', 'agent-session-1'),
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
        agentSessionId: testEntityId('as', 'agent-session-2'),
        agentSessionRuntimeBindingId: 'agent-session-binding-2',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-2'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          adapterId: 'codex',
          agentSessionCompatibilityKey: 'c'.repeat(64),
          agentSessionId: testEntityId('as', 'agent-session-2'),
          agentSessionRuntimeBindingId: 'agent-session-binding-2',
          effectiveSetupGeneration: 1,
          resume: null,
          threadId: testEntityId('th', 'thread-2'),
          workspaceId: testEntityId('ws', 'workspace-1'),
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
      ).toEqual({
        operation: 'session.open',
        operationId: expect.stringMatching(/^[0-9a-f]{64}$/),
        operationState: 'queued',
      });
      if (inspectionCollision) {
        const bytes = JSON.stringify({
          ...closeResult,
          body: {
            ...closeResult.body,
            nativeHandleState: 'absent',
            nativeHandleDigest: null,
            cleanupState: 'clean',
          },
        });
        coreDb.sqlite
          .prepare('UPDATE harness_instance_records SET result_json = ?, result_fingerprint = ?')
          .run(bytes, createHash('sha256').update(bytes).digest('hex'));
      }
      const before = coreDb.sqlite.serialize();
      const replay = () =>
        settleNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
          result: closeResult,
          timestamp: now,
        });
      if (inspectionCollision) expect(replay).toThrow(/result.*match|conflict/i);
      else expect(replay()).toBe('replayed');
      expect(coreDb.sqlite.serialize().equals(before)).toBe(true);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT operation AS operation, operation_id AS operationId,
                    operation_state AS operationState FROM harness_instance_records
             WHERE harness_instance_id = ?`
          )
          .get('harness-1')
      ).toEqual({
        operation: 'session.open',
        operationId: expect.stringMatching(/^[0-9a-f]{64}$/),
        operationState: 'queued',
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
        agentSessionId: testEntityId('as', 'agent-session-1'),
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-1'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'c'.repeat(64),
        agentSessionId: testEntityId('as', 'agent-session-2'),
        agentSessionRuntimeBindingId: 'agent-session-binding-2',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-2'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: testEntityId('as', 'agent-session-1'),
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
      ).toEqual([
        { agentSessionId: testEntityId('as', 'agent-session-1') },
        { agentSessionId: testEntityId('as', 'agent-session-2') },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('omits Goal pinning from Sandbox records, session.open and turn.start', () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-harness-goal-pin-')));
    try {
      applyMigrations(coreDb);
      seedRuntimeTarget(coreDb);
      const sandboxColumns = coreDb.sqlite
        .prepare('PRAGMA table_info(sandbox_runtime_records)')
        .all() as { name: string; notnull: number }[];
      expect(sandboxColumns.map((column) => column.name)).not.toContain('pinned_goal_id');

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
        agentSessionId: testEntityId('as', 'agent-session-1'),
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-1'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });

      const sessionOpenBody = {
        adapterId: 'codex',
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId: testEntityId('as', 'agent-session-1'),
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        resume: null,
        threadId: testEntityId('th', 'thread-1'),
        workspaceId: testEntityId('ws', 'workspace-1'),
      };
      const preparedOpen = prepareNanoHostHarnessOperation(coreDb, {
        body: sessionOpenBody,
        harnessInstanceId: 'harness-1',
        operation: 'session.open',
        timestamp: now,
      });
      queueNanoHostHarnessOperation(coreDb, {
        prepared: preparedOpen,
        body: sessionOpenBody,
        harnessInstanceId: 'harness-1',
        operation: 'session.open',
        timestamp: now,
      });
      const sessionOpenCommand = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
      });
      expect(Object.keys(preparedOpen.wireBody).sort()).toEqual(
        [
          ...Object.keys(sessionOpenBody),
          'capabilityLoopbackCredential',
          'inferenceLoopbackCredential',
        ].sort()
      );
      expect(sessionOpenCommand?.body).not.toHaveProperty('goalId');
      expect(sessionOpenCommand?.body).not.toHaveProperty('pin');
      expect(sessionOpenCommand?.body).not.toHaveProperty('pinnedGoalId');
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
        result: {
          body: {
            maxActiveTurns: 20,
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
      consumeFixtureWorkspaceResult(coreDb);

      seedSubmittedAttempt(coreDb);
      const turnStartBody = {
        aepRef: 'sandbox://aep/1',
        agentSessionId: testEntityId('as', 'agent-session-1'),
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        contextPackageId: 'context-package-1',
        contextRef: 'sandbox://context/1',
        deadline: '2099-01-01T00:00:00.000Z',
        leaseId: testEntityId('attempt', 'lease-1'),
        packageSnapshotId: 'package-snapshot-1',
        threadId: testEntityId('th', 'thread-1'),
        turnId: testEntityId('tu', 'turn-1'),
        turnSequence: 0,
        workspaceId: testEntityId('ws', 'workspace-1'),
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
      expect(Object.keys(queuedTurnStart).sort()).toEqual(
        [
          ...Object.keys(turnStartBody),
          'capabilityTokenHash',
          'inferenceTokenHash',
          'workerControlTokenHash',
        ].sort()
      );
      expect(queuedTurnStart).not.toHaveProperty('goalId');
      expect(queuedTurnStart).not.toHaveProperty('pin');
      expect(queuedTurnStart).not.toHaveProperty('pinnedGoalId');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('prepares two distinct fresh loopback credentials at session.open and persists only their digests', () => {
    const coreDb = openOpeningBindingDb('openkit-harness-loopback-credentials-');
    const inference = Buffer.alloc(32, 1).toString('base64url');
    const capability = Buffer.alloc(32, 2).toString('base64url');
    try {
      // A repeated draw is redrawn so the two credentials always differ.
      const draws = [inference, inference, capability];
      const operationInput = {
        body: sessionOpenBody(),
        harnessInstanceId: 'harness-1',
        operation: 'session.open',
        timestamp: now,
      } satisfies Parameters<typeof prepareNanoHostHarnessOperation>[1];
      const prepared = prepareNanoHostHarnessOperation(coreDb, {
        ...operationInput,
        loopbackCredential: () => draws.shift() ?? 'unexpected',
      });
      queueNanoHostHarnessOperation(coreDb, { ...operationInput, prepared });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-binding-1',
      });

      expect(command).toEqual(prepared.command);
      expect(prepared.wireBody).toMatchObject({
        capabilityLoopbackCredential: capability,
        inferenceLoopbackCredential: inference,
      });
      expect(draws).toEqual([]);
      const digest = (credential: string) =>
        createHash('sha256').update(credential, 'utf8').digest('hex');
      const durable = coreDb.sqlite
        .prepare(
          `SELECT h.command_body_json AS commandBody,
                  b.inference_loopback_credential_digest AS inferenceDigest,
                  b.capability_loopback_credential_digest AS capabilityDigest
           FROM harness_instance_records h
           JOIN agent_session_runtime_bindings b ON b.harness_instance_id = h.harness_instance_id`
        )
        .get() as { capabilityDigest: string; commandBody: string; inferenceDigest: string };
      expect(durable.inferenceDigest).toBe(digest(inference));
      expect(durable.capabilityDigest).toBe(digest(capability));
      expect(JSON.parse(durable.commandBody)).toMatchObject({
        capabilityLoopbackCredentialHash: digest(capability),
        inferenceLoopbackCredentialHash: digest(inference),
      });
      expect(durable.commandBody).not.toContain(inference);
      expect(durable.commandBody).not.toContain(capability);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('accepts only a null resume or one exact locator and digest pair on session.open', () => {
    const coreDb = openOpeningBindingDb('openkit-harness-resume-pair-');
    try {
      for (const resume of [
        { locator: testEntityId('as', 'agent-session-0') },
        { digest: 'not-a-digest', locator: testEntityId('as', 'agent-session-0') },
        {
          digest: 'a'.repeat(64),
          extra: 'forbidden',
          locator: testEntityId('as', 'agent-session-0'),
        },
        testEntityId('as', 'agent-session-0'),
      ]) {
        expect(() =>
          queueNanoHostHarnessOperation(coreDb, {
            body: { ...sessionOpenBody(), resume },
            harnessInstanceId: 'harness-1',
            operation: 'session.open',
            timestamp: now,
          })
        ).toThrow();
      }
      const { resume: _resume, ...withoutResume } = sessionOpenBody();
      expect(() =>
        queueNanoHostHarnessOperation(coreDb, {
          body: withoutResume,
          harnessInstanceId: 'harness-1',
          operation: 'session.open',
          timestamp: now,
        })
      ).toThrow();

      const resume = { digest: 'a'.repeat(64), locator: testEntityId('as', 'agent-session-0') };
      queueNanoHostHarnessOperation(coreDb, {
        body: { ...sessionOpenBody(), resume },
        harnessInstanceId: 'harness-1',
        operation: 'session.open',
        timestamp: now,
      });
      expect(
        dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-binding-1',
        })?.body
      ).toMatchObject({ resume });
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
        // The human-gate stop was retired with bounded Turns; interrupt is the only purpose.
        { ...body, purpose: 'human-gate' },
        { ...body, command: 'forbidden', purpose: 'interrupt' },
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

  it('admits one interrupt only for the exact current binding and live lease lineage', () => {
    const coreDb = openActiveTurnDb('openkit-harness-interrupt-lineage-');
    try {
      const body = { ...interruptBody(), purpose: 'interrupt' };
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
        ['current_turn_id', testEntityId('tu', 'turn-other'), testEntityId('tu', 'turn-1')],
        [
          'current_attempt_id',
          testEntityId('attempt', 'lease-other'),
          testEntityId('attempt', 'lease-1'),
        ],
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
        ['workspace_id', testEntityId('ws', 'workspace-other'), testEntityId('ws', 'workspace-1')],
        ['thread_id', testEntityId('th', 'thread-other'), testEntityId('th', 'thread-1')],
        ['turn_id', testEntityId('tu', 'turn-other'), testEntityId('tu', 'turn-1')],
        [
          'agent_session_id',
          testEntityId('as', 'agent-session-other'),
          testEntityId('as', 'agent-session-1'),
        ],
        ['input_ref', 'package-snapshot-other', 'package-snapshot-1'],
        ['phase', 'closed', 'open'],
      ] as const) {
        coreDb.sqlite
          .prepare(`UPDATE scheduler_execution_attempts SET ${column} = ? WHERE attempt_id = ?`)
          .run(wrongValue, testEntityId('attempt', 'lease-1'));
        expectRejected(column);
        coreDb.sqlite
          .prepare(`UPDATE scheduler_execution_attempts SET ${column} = ? WHERE attempt_id = ?`)
          .run(originalValue, testEntityId('attempt', 'lease-1'));
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
      recordFinalStatus(coreDb, 'completed', 'completed');
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
        agentSessionId: testEntityId('as', 'agent-session-1'),
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-1'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
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
        agentSessionId: testEntityId('as', 'agent-session-1'),
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-1'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'c'.repeat(64),
        agentSessionId: testEntityId('as', 'agent-session-2'),
        agentSessionRuntimeBindingId: 'agent-session-binding-2',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-2'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
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
      agentSessionId: testEntityId('as', 'agent-session-1'),
      agentSessionRuntimeBindingId: 'agent-session-binding-1',
      effectiveSetupGeneration: 1,
      harnessInstanceId: 'harness-1',
      threadId: testEntityId('th', 'thread-1'),
      workspaceId: testEntityId('ws', 'workspace-1'),
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
        agentSessionId: testEntityId('as', 'agent-session-1'),
        agentSessionRuntimeBindingId: 'agent-session-binding-1',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-1',
        threadId: testEntityId('th', 'thread-1'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'f'.repeat(64),
        agentSessionId: testEntityId('as', 'agent-session-2'),
        agentSessionRuntimeBindingId: 'agent-session-binding-2',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-2',
        threadId: testEntityId('th', 'thread-2'),
        timestamp: now,
        workspaceId: testEntityId('ws', 'workspace-1'),
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

/** Returns one submitted fixture Turn's exact start lineage without minted route credentials. */
function concurrentTurnStartBody(index: number): Readonly<Record<string, unknown>> {
  return {
    aepRef: `sandbox://aep/${index}`,
    contextRef: `sandbox://context/${index}`,
    agentSessionId: testEntityId('as', `agent-session-${index}`),
    agentSessionRuntimeBindingId: `agent-session-binding-${index}`,
    contextPackageId: `context-package-${index}`,
    deadline: '2099-01-01T00:00:00.000Z',
    leaseId: testEntityId('attempt', `lease-${index}`),
    packageSnapshotId: `package-snapshot-${index}`,
    threadId: testEntityId('th', `thread-${index}`),
    turnId: testEntityId('tu', `turn-${index}`),
    turnSequence: 0,
    workspaceId: testEntityId('ws', 'workspace-1'),
  };
}

/** Returns the exact private interrupt body before its closed purpose discriminator. */
function interruptBody(): Readonly<Record<string, unknown>> {
  return {
    agentSessionId: testEntityId('as', 'agent-session-1'),
    agentSessionRuntimeBindingId: 'agent-session-binding-1',
    leaseId: testEntityId('attempt', 'lease-1'),
    turnId: testEntityId('tu', 'turn-1'),
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
  status: 'completed' | 'failed',
  stopReason: 'completed' | 'error'
): void {
  recordWorkerControlAcceptedRecord(coreDb, {
    acceptedAt: now,
    lineage: {
      agentSessionId: testEntityId('as', 'agent-session-1'),
      packageSnapshotId: 'package-snapshot-1',
      requestId: 'request-1',
      threadId: testEntityId('th', 'thread-1'),
      turnId: testEntityId('tu', 'turn-1'),
      workspaceId: testEntityId('ws', 'workspace-1'),
    },
    operation: 'final_status',
    record: { sequence: 1, status, stopReason },
    recordKey: '1',
    sequence: 1,
  });
}

/** Returns the queued `session.open` body for the fixture's opening binding. */
function sessionOpenBody(): Readonly<Record<string, unknown>> {
  return {
    adapterId: 'codex',
    agentSessionCompatibilityKey: 'b'.repeat(64),
    agentSessionId: testEntityId('as', 'agent-session-1'),
    agentSessionRuntimeBindingId: 'agent-session-binding-1',
    effectiveSetupGeneration: 1,
    resume: null,
    threadId: testEntityId('th', 'thread-1'),
    workspaceId: testEntityId('ws', 'workspace-1'),
  };
}

/** Creates one Harness with an opening binding, optionally using exact recorded history identities. */
function openOpeningBindingDb(
  prefix: string,
  nativeEnvironment?: Parameters<typeof openNanoHostAgentSessionBinding>[1]['nativeEnvironment'],
  identities?: Pick<
    Parameters<typeof openNanoHostAgentSessionBinding>[1],
    'agentSessionId' | 'threadId' | 'workspaceId'
  >
): ReturnType<typeof openCoreDb> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  seedRuntimeTarget(coreDb);
  createNanoHostHarnessRuntime(coreDb, {
    maxActiveTurns: 1,
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
    nativeEnvironment,
    agentSessionCompatibilityKey: 'b'.repeat(64),
    agentSessionId: identities?.agentSessionId ?? testEntityId('as', 'agent-session-1'),
    agentSessionRuntimeBindingId: 'agent-session-binding-1',
    effectiveSetupGeneration: 1,
    harnessInstanceId: 'harness-1',
    threadId: identities?.threadId ?? testEntityId('th', 'thread-1'),
    timestamp: now,
    workspaceId: identities?.workspaceId ?? testEntityId('ws', 'workspace-1'),
  });
  return coreDb;
}

/** Creates one settled turn.start whose binding and lease identify an active Turn. */
function openActiveTurnDb(prefix: string, maxActiveTurns = 1): ReturnType<typeof openCoreDb> {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), prefix)));
  applyMigrations(coreDb);
  seedRuntimeTarget(coreDb);
  createNanoHostHarnessRuntime(coreDb, {
    maxActiveTurns,
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
    agentSessionId: testEntityId('as', 'agent-session-1'),
    agentSessionRuntimeBindingId: 'agent-session-binding-1',
    effectiveSetupGeneration: 1,
    harnessInstanceId: 'harness-1',
    threadId: testEntityId('th', 'thread-1'),
    timestamp: now,
    workspaceId: testEntityId('ws', 'workspace-1'),
  });
  seedSubmittedAttempt(coreDb);
  const tokens = [1, 2, 3].map((value) => Buffer.alloc(32, value).toString('base64url'));
  queueNanoHostHarnessOperation(coreDb, {
    body: {
      aepRef: 'sandbox://aep/1',
      agentSessionId: testEntityId('as', 'agent-session-1'),
      agentSessionRuntimeBindingId: 'agent-session-binding-1',
      contextPackageId: 'context-package-1',
      contextRef: 'sandbox://context/1',
      deadline: '2099-01-01T00:00:00.000Z',
      leaseId: testEntityId('attempt', 'lease-1'),
      packageSnapshotId: 'package-snapshot-1',
      threadId: testEntityId('th', 'thread-1'),
      turnId: testEntityId('tu', 'turn-1'),
      turnSequence: 0,
      workspaceId: testEntityId('ws', 'workspace-1'),
    },
    harnessInstanceId: 'harness-1',
    operation: 'turn.start',
    timestamp: now,
    routeToken: () => tokens.shift()!,
  });
  const command = dispatchNanoHostHarnessOperation(coreDb, {
    sandboxIntegrationBindingRef: 'integration-binding-1',
    now: () => now,
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
  consumeFixtureWorkspaceResult(coreDb);
  return coreDb;
}

/** Establishes exact authorized submitted Native attempt lineage for private Harness operations. */
function seedSubmittedAttempt(coreDb: ReturnType<typeof openCoreDb>, index = 1): void {
  const ownerUserId = 'usr_00000000-0000-7bb1-ad15-a58cc38146bf';
  coreDb.sqlite
    .prepare(`INSERT INTO users
    (id, display_name, email, email_verified, created_at, updated_at, kind, status)
    VALUES (?, 'Harness fixture', 'harness@example.invalid', 0, ?, ?, 'human', 'active') ON CONFLICT(id) DO NOTHING`)
    .run(ownerUserId, Date.parse(now), Date.parse(now));
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: testEntityId('ws', 'workspace-1'),
    ownerUserId,
  });
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    now: () => now,
    queueEntryId: `queue-${index}`,
    requestId: `request-${index}`,
    requestedAgentId: 'agent-1',
    threadId: testEntityId('th', `thread-${index}`),
    triggerActor: { id: 'usr_00000000-0000-7bb1-ad15-a58cc38146bf', kind: 'user' },
    turnId: testEntityId('tu', `turn-${index}`),
    turnInput: 'Wait for a human decision',
    workspaceId: testEntityId('ws', 'workspace-1'),
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: testEntityId('attempt', `lease-${index}`),
    agentSessionId: testEntityId('as', `agent-session-${index}`),
    inputRef: `package-snapshot-${index}`,
    bindingRef: testEntityId('tu', `turn-route-binding-${index}`),
    sessionCompatibilityKey: 'b'.repeat(64),
    operationId: `submit:turn-${index}`,
    now: () => now,
  });
  recordWorkerBackendSessionMaterializing(coreDb, {
    identity: {
      agentSessionId: testEntityId('as', `agent-session-${index}`),
      backendKind: 'nanohost',
      backendSessionId: `nanohost-sandbox-fixture-${index}`,
      deploymentId: 'deployment-a1',
      packageSnapshotId: `package-snapshot-${index}`,
      runtimeTargetId: 'nanohost-a1',
      stagingDirectoryRef: `worker-staging/fixture-${index}`,
      transientProviderInstanceId: null,
    },
    backendVersion: null,
    backendLineage: {
      kind: 'reference',
      imageRef: `ghcr.io/openkit/worker@sha256:${'f'.repeat(64)}`,
    },
    lineage: {
      workspaceId: testEntityId('ws', 'workspace-1'),
      threadId: testEntityId('th', `thread-${index}`),
      turnId: testEntityId('tu', `turn-${index}`),
    },
    now: () => now,
    sandboxBindingRef: testEntityId('tu', `turn-route-binding-${index}`),
  });
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

/** Reads attempt evidence without a legacy grant projection or simulated lifecycle. */
function observeExecutionAttempts(
  coreDb: ReturnType<typeof openCoreDb>
): Record<string, unknown>[] {
  const present = coreDb.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
    )
    .get();
  return present
    ? (coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
        .all() as Record<string, unknown>[])
    : [];
}

/** Reads actual retained Core consumer proof for owner-module replay assertions. */
function readFixtureWorkspaceConsumption(coreDb: ReturnType<typeof openCoreDb>) {
  const row = coreDb.sqlite
    .prepare(
      "SELECT result_json AS bytes FROM harness_instance_records WHERE harness_instance_id = 'harness-1'"
    )
    .get() as { bytes: string };
  return (JSON.parse(row.bytes) as { consumption: Record<string, unknown> }).consumption;
}

/** Explicit external consumer double for the known Core fixture namespace only. */
function consumeFixtureWorkspaceResult(coreDb: ReturnType<typeof openCoreDb>, turnIndex = 1) {
  acknowledgeTestExternalWorkspaceConsumer(coreDb, {
    harnessInstanceId: 'harness-1',
    harnessBindingRef: 'harness-binding-1',
    workspaceId: testEntityId('ws', 'workspace-1'),
    turnId: testEntityId('tu', `turn-${turnIndex}`),
    timestamp: now,
  });
  return readFixtureWorkspaceConsumption(coreDb);
}
