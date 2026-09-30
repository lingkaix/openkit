import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import type {
  WorkerCanonicalEventRecord,
  WorkerCapabilityCallSummary,
} from '@openkit/worker-protocol';
import { WorkerObservationDataSchema } from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { CodexRuntimeCapture } from '../../../../packages/worker-shim/src/codex-runtime-capture.js';
import {
  RuntimeSemanticCapture,
  runtimeOriginRef,
} from '../../../../packages/worker-shim/src/runtime-capture.js';
import { WorkerTranscriptWriter } from '../../../../packages/worker-shim/src/transcript.js';
import { compactWorkspaceEvidenceBundles, readWorkObservationBody } from '../evidence-bundles.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { readThreadRuntimeActivity, readWorkObservations } from '../storage/work-observations.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import {
  hashWorkerRouteToken,
  WorkerControlGateway,
  type WorkerControlGatewayError,
  type WorkerControlLineage,
} from './worker-control-gateway.js';
import { createWorkerControlAcceptedRecordRecorder } from './worker-control-records.js';
import { createWorkerControlSequenceRecorder } from './worker-control-sequences.js';

/**
 * Creates an OpenShell-targeted package fixture for worker control tests.
 *
 * @param suffix Stable suffix used to create a distinct complete lineage.
 * @returns Package fixture and lineage expected by the control gateway.
 */
function createWorkerControlFixture(
  suffix = '1',
  dataRoot?: string
): {
  environmentPackage: AgentEnvironmentPackage;
  lineage: WorkerControlLineage;
} {
  const store = createDemoStore(dataRoot ? { dataRoot } : {});
  if (dataRoot) store.setLiveCaptureCoverage({ scope: 'server', value: 'on' });
  const turn = store.createTurn(
    'ws_demo',
    'th_demo',
    'Control worker',
    {
      kind: 'user',
      id: 'user_local',
    },
    null,
    { turnId: `tu_control_${suffix}` }
  );
  const environmentPackage = resolveAgentEnvironmentPackage({
    captureCoverage: store.getTurnCaptureCoverage(turn.id)!,
    agentSetup: createTestAgentSetup(),
    agentSessionId: `as_control_${suffix}`,
    triggerActor: { kind: 'user', id: 'user_local' },
    backend: {
      kind: 'openshell',
    },
    createdAt: '2026-06-16T00:00:00.000Z',
    requestId: `req_control_${suffix}`,
    turn,
    workspaceCwd: '/workspace/repo',
    workspaceRoots: [],
  });

  if (dataRoot) {
    store.createAgentSession({
      id: `as_control_${suffix}`,
      agentId: environmentPackage.agent.agentId,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      status: 'busy',
      message: null,
      createdAt: turn.startedAt!,
      updatedAt: turn.startedAt!,
    });
    store.updateTurn(turn.id, { agentSessionId: `as_control_${suffix}` });
  }
  return {
    environmentPackage: AgentEnvironmentPackageSchema.parse(environmentPackage),
    lineage: {
      agentSessionId: `as_control_${suffix}`,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: `req_control_${suffix}`,
      threadId: 'th_demo',
      turnId: turn.id,
      workspaceId: 'ws_demo',
    },
  };
}

const WORKER_CONTROL_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WORKER_INFERENCE_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const WORKER_CAPABILITY_TOKEN = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

/** Registers one accepted session with a non-secret binding and distinct raw route tokens. */
function registerAcceptedWorkerSession(
  gateway: WorkerControlGateway,
  environmentPackage: AgentEnvironmentPackage,
  sandboxBindingRef: string
) {
  return gateway.registerSession(environmentPackage, {
    sandboxBindingRef,
    workerCapabilityToken: WORKER_CAPABILITY_TOKEN,
    workerControlToken: WORKER_CONTROL_TOKEN,
    workerInferenceToken: WORKER_INFERENCE_TOKEN,
  });
}

/**
 * Creates a canonical worker event record for gateway append tests.
 *
 * @param lineage Worker lineage bound to the active package snapshot.
 * @param sequence Worker event sequence.
 * @param delta Text delta carried by the event.
 * @returns Canonical worker event record.
 */
function createEventRecord(
  lineage: WorkerControlLineage,
  sequence: number,
  delta = 'hello'
): WorkerCanonicalEventRecord {
  return {
    event: {
      data: {
        delta,
        itemId: 'candidate_item_1',
      },
      type: 'item.delta',
    },
    kind: 'event',
    lineage,
    schemaVersion: 1,
    sequence,
  };
}

/**
 * Creates a product-safe capability summary record for gateway tests.
 *
 * @param lineage Worker lineage bound to the active package snapshot.
 * @param sequence Worker sequence.
 * @returns Capability summary record.
 */
function createCapabilitySummary(
  lineage: WorkerControlLineage,
  sequence: number
): WorkerCapabilityCallSummary {
  return {
    capabilityCallId: 'capability_1',
    diagnostics: [],
    family: 'knowledge.search',
    inputSummary: 'Search project knowledge.',
    lineage,
    outputSummary: 'Returned one entry.',
    schemaVersion: 1,
    sequence,
    status: 'succeeded',
  };
}

/** Builds one canonical non-initial heartbeat request for direct gateway tests. */
function heartbeatRequest(
  authorization: string,
  lineage: WorkerControlLineage,
  sequence: number,
  message?: string
) {
  return {
    authorization,
    body: { ...(message ? { message } : {}), status: 'running' as const },
    lineage,
    operation: 'heartbeat' as const,
    schemaVersion: 2 as const,
    sequence,
  };
}

describe('WorkerControlGateway', () => {
  it('persists rejected tool arguments and results under their exact expected observations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-rejected-observation-'));
    const fixture = createWorkerControlFixture('rejected-observation', root);
    const coreDb = openCoreDb(root);
    applyMigrations(coreDb);
    const workspaceDb = openWorkspaceDb(root, fixture.lineage.workspaceId);
    const gateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
      sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
      acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
    });
    registerAcceptedWorkerSession(gateway, fixture.environmentPackage, 'binding:rejected');
    const writer = new WorkerTranscriptWriter({
      lineage: fixture.lineage,
      sessionDir: join(root, 'worker-session'),
      appendEvent: async (record) => {
        gateway.appendEvent({
          authorization: `Bearer ${WORKER_CONTROL_TOKEN}`,
          lineage: fixture.lineage,
          record,
        });
      },
    });
    const capture = new RuntimeSemanticCapture({
      packageSnapshotId: fixture.lineage.packageSnapshotId,
      captureCoverage: { scope: 'server', value: 'on' },
      credentialValues: ['known-secret-value'],
      emit: (record, body) => writer.writeObservation(record, body),
    });
    try {
      for (const boundary of ['runtime.tool.arguments', 'runtime.tool.result'] as const) {
        for (const [index, text] of ['known-', 'secret-value'].entries()) {
          await capture.emit(
            'source',
            {
              kind: 'tool',
              runtimeOriginRef: null,
              callRef: 'same-call',
              phase: index ? 'completed' : 'updated',
            },
            {
              bytes: Buffer.from(JSON.stringify({ text })),
              mediaType: 'application/json',
              boundary,
            }
          );
        }
      }
      await capture.flushCompleted();
      const rows = readWorkObservations(workspaceDb, fixture.lineage);
      const observed = rows
        .filter((row) => row.type === 'runtime.observed')
        .map((row) => ({ row, data: WorkerObservationDataSchema.parse(row.payload) }))
        .filter(({ data }) => data.fact.kind === 'tool' && data.fact.callRef === 'same-call');
      const expected = observed.filter(({ data }) => data.content.state === 'expected');
      expect(expected).toHaveLength(4);
      expect(
        expected.map(({ data }) => data.content.state === 'expected' && data.content.boundary)
      ).toEqual([
        'runtime.tool.arguments',
        'runtime.tool.arguments',
        'runtime.tool.result',
        'runtime.tool.result',
      ]);
      const unavailable = observed.filter(
        ({ data }) =>
          data.content.state === 'unavailable' && data.content.reason === 'credential-excluded'
      );
      expect(unavailable).toHaveLength(4);
      expect(unavailable.map(({ row }) => row.parent).sort()).toEqual(
        expected.map(({ row }) => row.id).sort()
      );
      expect(rows.some((row) => row.type === 'content.published')).toBe(false);
      expect(JSON.stringify(rows)).not.toContain('known-secret-value');
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unavailability anchor to earlier content-free metadata in the same package', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-rejected-anchor-'));
    const fixture = createWorkerControlFixture('rejected-anchor', root);
    const coreDb = openCoreDb(root);
    applyMigrations(coreDb);
    const workspaceDb = openWorkspaceDb(root, fixture.lineage.workspaceId);
    const gateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
      sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
      acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
    });
    registerAcceptedWorkerSession(gateway, fixture.environmentPackage, 'binding:rejected-anchor');
    const send = (sequence: number, data: ReturnType<typeof WorkerObservationDataSchema.parse>) =>
      gateway.appendEvent({
        authorization: `Bearer ${WORKER_CONTROL_TOKEN}`,
        lineage: fixture.lineage,
        record: {
          kind: 'event',
          schemaVersion: 1,
          lineage: fixture.lineage,
          sequence,
          event: { type: 'observation.recorded', data },
        },
      });
    const fact = {
      kind: 'tool' as const,
      runtimeOriginRef: null,
      callRef: 'same-call',
      phase: 'updated' as const,
    };
    try {
      const progress = WorkerObservationDataSchema.parse({
        observationId: 'obs_progress',
        sourceRef: 'source',
        sourceSequence: 0,
        observedAt: '2026-09-22T00:00:00.000Z',
        fact,
        content: { state: 'not-applicable' },
      });
      expect(send(0, progress).accepted).toBe(true);
      const before = readWorkObservations(workspaceDb, fixture.lineage);
      expect(before).toHaveLength(1);
      const invalid = WorkerObservationDataSchema.parse({
        observationId: 'obs_unavailable',
        sourceRef: 'source',
        sourceSequence: 1,
        observedAt: '2026-09-22T00:00:01.000Z',
        fact,
        content: {
          state: 'unavailable',
          reason: 'credential-excluded',
          expectedObservationId: progress.observationId,
        },
      });
      expect(() => send(1, invalid)).toThrow();
      expect(readWorkObservations(workspaceDb, fixture.lineage)).toEqual(before);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { gapRejected: false, label: 'persisted gap' },
    { gapRejected: true, label: 'rejected gap append' },
  ])('keeps native outcome separate from a $label after a source ancestry fault', async ({
    gapRejected,
  }) => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-ancestry-outcome-'));
    const fixture = createWorkerControlFixture('ancestry-outcome', root);
    const coreDb = openCoreDb(root);
    applyMigrations(coreDb);
    const workspaceDb = openWorkspaceDb(root, fixture.lineage.workspaceId);
    const committed: unknown[] = [];
    const gateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
      onFinalStatusCommitted: (input) => committed.push(input),
      sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
      acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
    });
    registerAcceptedWorkerSession(gateway, fixture.environmentPackage, 'binding:ancestry-outcome');
    let gapAppendAttempted = false;
    const writer = new WorkerTranscriptWriter({
      lineage: fixture.lineage,
      sessionDir: join(root, 'worker-session'),
      appendEvent: async (record) => {
        if (
          record.event.type === 'observation.recorded' &&
          record.event.data.fact.kind === 'coverage' &&
          record.event.data.fact.coverage === 'unavailable'
        ) {
          gapAppendAttempted = true;
          if (gapRejected) throw new Error('injected required gap append rejection');
        }
        gateway.appendEvent({
          authorization: `Bearer ${WORKER_CONTROL_TOKEN}`,
          lineage: fixture.lineage,
          record,
        });
      },
    });
    const home = join(root, 'native-home');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    const capture = await CodexRuntimeCapture.create(
      {
        packageSnapshotId: fixture.lineage.packageSnapshotId,
        captureCoverage: { scope: 'server', value: 'on' },
        credentialValues: [],
        emit: (record, body) => writer.writeObservation(record, body),
      },
      home,
      '0.153.4'
    );
    try {
      writeFileSync(
        join(home, 'sessions', 'rollout-root.jsonl'),
        `${JSON.stringify({ type: 'session_meta', payload: { id: 'root', session_id: 'root', cli_version: '0.153.4' } })}\n`
      );
      const frame = (value: unknown) => `${JSON.stringify(value)}\n`;
      await capture.writeStdout(Buffer.from(frame({ type: 'thread.started', thread_id: 'root' })));
      const fault = Buffer.from(
        frame({
          type: 'item.completed',
          item: {
            type: 'collab_tool_call',
            id: 'self-spawn',
            tool: 'spawn_agent',
            sender_thread_id: 'root',
            receiver_thread_ids: ['root'],
            status: 'completed',
          },
        })
      );
      if (gapRejected) {
        await expect(capture.writeStdout(fault)).rejects.toThrow(
          'injected required gap append rejection'
        );
        expect(gapAppendAttempted).toBe(true);
        await expect(capture.finalize()).rejects.toThrow('injected required gap append rejection');
        expect(
          readWorkObservations(workspaceDb, fixture.lineage).some(
            (row) =>
              row.type === 'runtime.observed' &&
              (row.payload.fact as { coverage?: string }).coverage === 'unavailable'
          )
        ).toBe(false);
      } else {
        await capture.writeStdout(fault);
        expect(gapAppendAttempted).toBe(true);
        expect(
          readWorkObservations(workspaceDb, fixture.lineage).some(
            (row) =>
              row.type === 'runtime.observed' &&
              (row.payload.fact as { coverage?: string }).coverage === 'unavailable'
          )
        ).toBe(true);
        await capture.finalize();
        const terminal = await writer.writeTerminalOutcome({
          status: 'completed',
          stopReason: 'completed',
        });
        gateway.recordFinalStatus({
          authorization: `Bearer ${WORKER_CONTROL_TOKEN}`,
          lineage: fixture.lineage,
          sequence: terminal.sequence,
          status: 'completed',
          stopReason: 'completed',
        });
        expect(committed).toEqual([
          expect.objectContaining({ eventType: 'turn.completed', lineage: fixture.lineage }),
        ]);
      }
    } finally {
      await capture.invalidate();
      if (gapRejected) await writer.writeTerminalOutcome({ status: 'failed', stopReason: 'error' });
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains live nested Codex producer content through the real codec, restart, publication and timeline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-live-observation-'));
    const fixture = createWorkerControlFixture('capture', root);
    let coreDb = openCoreDb(root);
    applyMigrations(coreDb);
    const makeGateway = () => {
      const gateway = new WorkerControlGateway({
        resolveTokenBinding: () => ({ status: 'accepted' }),
        sequenceRecorder: createWorkerControlSequenceRecorder(coreDb),
        acceptedRecordRecorder: createWorkerControlAcceptedRecordRecorder(coreDb),
      });
      registerAcceptedWorkerSession(gateway, fixture.environmentPackage, 'binding:capture');
      return gateway;
    };
    let gateway = makeGateway();
    const bytes = Buffer.from('Preserved outward response 世界\n'.repeat(2000));
    const chunkSize = 48 * 1024;
    const replayFrames: WorkerCanonicalEventRecord[] = [];
    let restartedAfterStaging = false;
    let retriedPublication = false;
    const send = (record: unknown) =>
      gateway.appendEvent({
        authorization: `Bearer ${WORKER_CONTROL_TOKEN}`,
        lineage: fixture.lineage,
        record,
      });
    let workspaceDb = openWorkspaceDb(root, fixture.lineage.workspaceId);
    const sessionDir = join(root, 'worker-session');
    const home = join(root, 'native-home');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    const writer = new WorkerTranscriptWriter({
      lineage: fixture.lineage,
      sessionDir,
      appendEvent: async (record) => {
        if (record.event.type === 'observation.content.chunk') {
          replayFrames.push(record);
          if (record.event.data.chunkIndex === 1 && !retriedPublication) {
            coreDb.sqlite.exec(
              "CREATE TRIGGER fail_receipt BEFORE INSERT ON worker_control_records BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END"
            );
            expect(() => send(record)).toThrow('injected receipt failure');
            coreDb.sqlite.exec('DROP TRIGGER fail_receipt');
            coreDb.sqlite.close();
            coreDb = openCoreDb(root);
            gateway = makeGateway();
            retriedPublication = true;
          }
        }
        send(record);
        if (record.event.type === 'observation.content.chunk' && !restartedAfterStaging) {
          expect(
            readWorkObservations(workspaceDb, fixture.lineage).some(
              (row) => row.type === 'content.published'
            )
          ).toBe(false);
          coreDb.sqlite.close();
          coreDb = openCoreDb(root);
          gateway = makeGateway();
          expect(send(record).accepted).toBe(true);
          restartedAfterStaging = true;
        }
      },
    });
    let captureFailure: unknown;
    const capture = await CodexRuntimeCapture.create(
      {
        packageSnapshotId: fixture.lineage.packageSnapshotId,
        captureCoverage: { scope: 'server', value: 'on' },
        credentialValues: [],
        emit: (record, body) =>
          writer.writeObservation(record, body).catch((error: unknown) => {
            captureFailure = error;
            throw error;
          }),
      },
      home,
      '0.153.4'
    );
    // Same pinned rollout metadata and native frame shapes as worker-shim's nested live fixture.
    const lines = (...records: unknown[]) =>
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    const meta = (id: string, parent?: string) => ({
      type: 'session_meta',
      payload: {
        id,
        session_id: 'root',
        cli_version: '0.153.4',
        ...(parent
          ? {
              parent_thread_id: parent,
              source: {
                subagent: {
                  thread_spawn: { parent_thread_id: parent, depth: parent === 'root' ? 1 : 2 },
                },
              },
            }
          : {}),
      },
    });
    try {
      writeFileSync(join(home, 'sessions', 'rollout-root.jsonl'), lines(meta('root')));
      await capture.writeStdout(
        Buffer.from(
          lines(
            { type: 'thread.started', thread_id: 'root' },
            {
              type: 'item.completed',
              item: {
                type: 'collab_tool_call',
                id: 'spawn-one',
                tool: 'spawn_agent',
                sender_thread_id: 'root',
                receiver_thread_ids: ['child'],
                status: 'completed',
                agents_states: { child: { status: 'running', message: null } },
              },
            }
          )
        )
      );
      writeFileSync(
        join(home, 'sessions', 'rollout-child.jsonl'),
        lines(meta('child', 'root'), {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            channel: 'final',
            content: [{ type: 'output_text', text: bytes.toString('utf8') }],
          },
        })
      );
      writeFileSync(
        join(home, 'sessions', 'rollout-grandchild.jsonl'),
        lines(meta('grandchild', 'child'), {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            channel: 'final',
            content: [{ type: 'output_text', text: 'Nested outward result' }],
          },
        })
      );
      const grandchildRef = runtimeOriginRef(fixture.lineage.packageSnapshotId, 'grandchild');
      await vi.waitFor(
        () => {
          if (captureFailure) throw captureFailure;
          const rows = readWorkObservations(workspaceDb, fixture.lineage);
          const message = rows.find(
            (row) =>
              (row.payload.fact as { runtimeOriginRef?: string; kind?: string } | undefined)
                ?.runtimeOriginRef === grandchildRef &&
              (row.payload.fact as { kind?: string }).kind === 'assistant'
          );
          expect(
            rows.some((row) => row.type === 'content.published' && row.parent === message?.id)
          ).toBe(true);
        },
        { timeout: 5000 }
      );
      await capture.invalidate();
      expect(writer.eventTranscriptSealed).toBe(false);
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM worker_control_records WHERE operation = 'final_status'"
          )
          .get()
      ).toEqual({ count: 0 });
      expect(restartedAfterStaging && retriedPublication).toBe(true);
      workspaceDb.sqlite.close();
      workspaceDb = openWorkspaceDb(root, fixture.lineage.workspaceId);
      const rows = readWorkObservations(workspaceDb, fixture.lineage);
      const initial = rows.find(
        (row) =>
          (row.payload.fact as { kind?: string; runtimeOriginRef?: string } | undefined)?.kind ===
            'assistant' &&
          (row.payload.fact as { runtimeOriginRef?: string }).runtimeOriginRef ===
            runtimeOriginRef(fixture.lineage.packageSnapshotId, 'child')
      )!;
      const publication = rows.find(
        (row) => row.type === 'content.published' && row.parent === initial.id
      )!;
      const ref = publication.refs![0]!;
      expect(
        readWorkObservationBody(workspaceDb, {
          ...fixture.lineage,
          bundleId: ref.locator,
          createdAt: initial.ts,
          sha256: ref.digest!,
        })
      ).toEqual(bytes);
      expect(send(replayFrames[0]!).accepted).toBe(true);
      expect(readWorkObservations(workspaceDb, fixture.lineage)).toEqual(rows);
      const activity = readThreadRuntimeActivity(workspaceDb, {
        threadId: fixture.lineage.threadId,
        turnIds: [fixture.lineage.turnId],
      })[0]!;
      expect(
        activity.entries.some(
          (entry) =>
            entry.label === 'Child 2: response completed' && entry.text === 'Nested outward result'
        )
      ).toBe(true);
      expect(
        activity.entries.some(
          (entry) => entry.text === bytes.toString('utf8').slice(0, 1000) && entry.textTruncated
        )
      ).toBe(true);
      expect(activity.entries.filter((entry) => entry.kind === 'child-started')).toHaveLength(2);
      const receipts = JSON.stringify(
        coreDb.sqlite.prepare('SELECT record_json FROM worker_control_records').all()
      );
      const fingerprints = JSON.stringify(
        coreDb.sqlite.prepare('SELECT fingerprint FROM worker_control_sequence_fingerprints').all()
      );
      for (const persisted of [
        receipts,
        fingerprints,
        JSON.stringify(gateway.getSessionSnapshot(fixture.lineage.packageSnapshotId)),
      ]) {
        expect(persisted).not.toContain('Preserved outward response');
        expect(persisted).not.toContain(bytes.subarray(0, chunkSize).toString('base64'));
      }
      expect(readFileSync(join(sessionDir, 'events.jsonl'), 'utf8')).not.toContain(
        'observation.content.chunk'
      );
      const changed = structuredClone(replayFrames[0]!);
      if (changed.event.type !== 'observation.content.chunk')
        throw new Error('Missing codec content frame');
      changed.event.data.data = Buffer.from('different').toString('base64');
      expect(() => send(changed)).toThrow(/different content/);
      compactWorkspaceEvidenceBundles({
        workspaceDb,
        workspaceId: fixture.lineage.workspaceId,
        olderThan: '9999-01-01T00:00:00.000Z',
      });
      expect(send(replayFrames[0]!).accepted).toBe(true);
      expect(
        readWorkObservationBody(workspaceDb, {
          ...fixture.lineage,
          bundleId: ref.locator,
          createdAt: initial.ts,
          sha256: ref.digest!,
        })
      ).toBeNull();
    } finally {
      await capture.invalidate();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('authenticates sandbox tokens and records live heartbeat plus artifact notices', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_control_1',
      now: () => '2026-06-16T00:00:01.000Z',
    });
    const registration = gateway.registerSession(environmentPackage);

    const heartbeat = gateway.recordHeartbeat(
      heartbeatRequest(`Bearer ${registration.token}`, lineage, 1, 'Codex worker is running.')
    );
    const artifact = gateway.recordArtifactNotice({
      artifact: {
        mediaType: 'text/markdown',
        path: '/openkit/artifacts/report.md',
        title: 'Worker report',
      },
      authorization: `Bearer ${registration.token}`,
      lineage,
      sequence: 2,
    });
    const snapshot = gateway.getSessionSnapshot(environmentPackage.snapshotId);

    expect(heartbeat).toMatchObject({
      lastHeartbeatAt: '2026-06-16T00:00:01.000Z',
      status: 'running',
    });
    expect(artifact).toMatchObject({
      artifactId: expect.stringMatching(/^worker-artifact-/),
      title: 'Worker report',
    });
    expect(snapshot).toMatchObject({
      artifacts: [expect.objectContaining({ title: 'Worker report' })],
      heartbeat: expect.objectContaining({ status: 'running' }),
      packageSnapshotId: environmentPackage.snapshotId,
    });
    expect(gateway.getSessionSnapshotByAgentSessionId(lineage.agentSessionId)).toMatchObject({
      agentSessionId: lineage.agentSessionId,
      heartbeat: expect.objectContaining({ status: 'running' }),
      packageSnapshotId: environmentPackage.snapshotId,
    });
    expect(JSON.stringify(snapshot)).not.toContain('token_control_1');
  });

  it('revokes a registered session and its sandbox token', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_control_revoke_1',
    });
    const registration = gateway.registerSession(environmentPackage);

    expect(gateway.unregisterSession(environmentPackage.snapshotId)).toBe(true);
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)).toBeNull();
    expect(() =>
      gateway.recordHeartbeat(heartbeatRequest(`Bearer ${registration.token}`, lineage, 1))
    ).toThrow('missing a valid sandbox token');
    expect(gateway.unregisterSession(environmentPackage.snapshotId)).toBe(false);
  });

  it('invalidates the prior token when the same package snapshot is registered again', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const tokens = ['token_control_old_1', 'token_control_new_1'];
    const gateway = new WorkerControlGateway({
      createToken: () => tokens.shift() ?? 'unexpected_control_token',
    });
    const firstRegistration = gateway.registerSession(environmentPackage);
    const secondRegistration = gateway.registerSession(environmentPackage);

    expect(() =>
      gateway.recordHeartbeat(heartbeatRequest(`Bearer ${firstRegistration.token}`, lineage, 1))
    ).toThrow('missing a valid sandbox token');
    expect(
      gateway.recordHeartbeat(heartbeatRequest(`Bearer ${secondRegistration.token}`, lineage, 1))
    ).toMatchObject({ sequence: 1, status: 'running' });
  });

  it('exposes no worker command queue; private Harness turn.interrupt is the only interrupt', () => {
    const gateway = new WorkerControlGateway();
    const fixture = createWorkerControlFixture();
    gateway.registerSession(fixture.environmentPackage);

    for (const retired of [
      'enqueueApprovalResult',
      'enqueueInterrupt',
      'pollCommands',
      'acknowledgeCommand',
    ]) {
      expect(gateway, retired).not.toHaveProperty(retired);
    }
    expect(gateway.getSessionSnapshot(fixture.environmentPackage.snapshotId)).not.toHaveProperty(
      'commands'
    );
  });

  it('accepts canonical event append records and exposes them in the session snapshot', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_control_1',
      now: () => '2026-06-16T00:00:01.000Z',
    });
    const registration = gateway.registerSession(environmentPackage);

    const response = gateway.appendEvent({
      authorization: `Bearer ${registration.token}`,
      lineage,
      record: createEventRecord(lineage, 3),
    });
    const snapshot = gateway.getSessionSnapshot(environmentPackage.snapshotId);

    expect(response).toEqual({
      accepted: true,
      diagnostics: [],
      nextExpectedSequence: 4,
      schemaVersion: 2,
    });
    expect(snapshot?.events).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ type: 'item.delta' }),
        sequence: 3,
      }),
    ]);
  });

  it('records supply refresh acknowledgements in the session snapshot', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_control_1',
      now: () => '2026-06-16T00:00:01.000Z',
    });
    const registration = gateway.registerSession(environmentPackage);

    const ack = gateway.recordSupplyRefreshAck({
      authorization: `Bearer ${registration.token}`,
      lineage,
      refreshId: 'refresh_1',
      sequence: 4,
      status: 'applied',
    });

    expect(ack).toMatchObject({
      acknowledgedAt: '2026-06-16T00:00:01.000Z',
      refreshId: 'refresh_1',
      sequence: 4,
      status: 'applied',
    });
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.supplyRefreshAcks).toEqual([
      expect.objectContaining({ refreshId: 'refresh_1', status: 'applied' }),
    ]);
  });

  it('records capability summaries in the session snapshot', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);

    const response = gateway.recordCapabilitySummary({
      authorization: `Bearer ${registration.token}`,
      lineage,
      summary: createCapabilitySummary(lineage, 5),
    });

    expect(response).toEqual({
      accepted: true,
      diagnostics: [],
      nextExpectedSequence: 6,
      schemaVersion: 2,
    });
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.capabilitySummaries).toEqual([
      expect.objectContaining({ capabilityCallId: 'capability_1', status: 'succeeded' }),
    ]);
  });

  it('does not project knowledge proposal summaries in the session snapshot', () => {
    const { environmentPackage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    gateway.registerSession(environmentPackage);

    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)).not.toHaveProperty(
      'knowledgeProposalSummaries'
    );
  });

  it('deduplicates exact sequenced control operation retries', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);

    const authorization = `Bearer ${registration.token}`;

    gateway.recordHeartbeat(heartbeatRequest(authorization, lineage, 1));
    gateway.recordHeartbeat(heartbeatRequest(authorization, lineage, 1));
    gateway.recordArtifactNotice({
      artifact: { path: '/openkit/artifacts/report.md', title: 'Worker report' },
      authorization,
      lineage,
      sequence: 2,
    });
    gateway.recordArtifactNotice({
      artifact: { path: '/openkit/artifacts/report.md', title: 'Worker report' },
      authorization,
      lineage,
      sequence: 2,
    });
    gateway.recordSupplyRefreshAck({
      authorization,
      lineage,
      refreshId: 'refresh_1',
      sequence: 3,
      status: 'applied',
    });
    gateway.recordSupplyRefreshAck({
      authorization,
      lineage,
      refreshId: 'refresh_1',
      sequence: 3,
      status: 'applied',
    });
    gateway.recordCapabilitySummary({
      authorization,
      lineage,
      summary: createCapabilitySummary(lineage, 4),
    });
    gateway.recordCapabilitySummary({
      authorization,
      lineage,
      summary: createCapabilitySummary(lineage, 4),
    });
    const snapshot = gateway.getSessionSnapshot(environmentPackage.snapshotId);

    expect(snapshot?.heartbeat).toMatchObject({ sequence: 1, status: 'running' });
    expect(snapshot?.artifacts).toHaveLength(1);
    expect(snapshot?.supplyRefreshAcks).toHaveLength(1);
    expect(snapshot?.capabilitySummaries).toHaveLength(1);
  });

  it('retries heartbeat projection before durably recording or publishing its snapshot', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const observations: string[] = [];
    let projectionAttempts = 0;
    let gateway!: WorkerControlGateway;

    gateway = new WorkerControlGateway({
      acceptedRecordRecorder: {
        record: () => {
          observations.push(
            gateway.getSessionSnapshot(environmentPackage.snapshotId)?.heartbeat
              ? 'record:published'
              : 'record:pending'
          );
        },
      },
      createToken: () => 'token_control_1',
      now: () => '2026-06-16T00:00:02.000Z',
      onHeartbeatAccepted: () => {
        projectionAttempts += 1;
        observations.push(
          gateway.getSessionSnapshot(environmentPackage.snapshotId)?.heartbeat
            ? 'hook:published'
            : 'hook:pending'
        );

        if (projectionAttempts === 1) {
          throw new Error('heartbeat projection unavailable');
        }
      },
    });
    const registration = registerAcceptedWorkerSession(
      gateway,
      environmentPackage,
      'lease-binding:heartbeat_projection'
    );
    const heartbeat = heartbeatRequest(`Bearer ${registration.token}`, lineage, 1);

    expect(() => gateway.recordHeartbeat(heartbeat)).toThrow('heartbeat projection unavailable');
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.heartbeat).toBeNull();
    expect(gateway.recordHeartbeat(heartbeat)).toMatchObject({ sequence: 1, status: 'running' });
    expect(observations).toEqual(['hook:pending', 'hook:pending', 'record:pending']);
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.heartbeat).toMatchObject({
      sequence: 1,
      status: 'running',
    });
  });

  it('rejects stale or conflicting sequenced control operations', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);
    const authorization = `Bearer ${registration.token}`;

    gateway.recordSupplyRefreshAck({
      authorization,
      lineage,
      refreshId: 'refresh_1',
      sequence: 3,
      status: 'applied',
    });

    expect(() =>
      gateway.recordSupplyRefreshAck({
        authorization,
        lineage,
        refreshId: 'refresh_1',
        sequence: 3,
        status: 'rejected',
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_sequence_conflict',
        status: 409,
      }) as WorkerControlGatewayError
    );
    expect(() =>
      gateway.recordSupplyRefreshAck({
        authorization,
        lineage,
        refreshId: 'refresh_older',
        sequence: 2,
        status: 'applied',
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_sequence_stale',
        status: 409,
      }) as WorkerControlGatewayError
    );
  });

  it('deduplicates exact canonical event append retries', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);
    const record = createEventRecord(lineage, 3);

    gateway.appendEvent({
      authorization: `Bearer ${registration.token}`,
      lineage,
      record,
    });
    const retry = gateway.appendEvent({
      authorization: `Bearer ${registration.token}`,
      lineage,
      record,
    });

    expect(retry).toMatchObject({ accepted: true, nextExpectedSequence: 4 });
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toHaveLength(1);
  });

  it('retries canonical event persistence before publishing its snapshot', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const persistedRecords: unknown[] = [];
    let persistenceAttempts = 0;
    const gateway = new WorkerControlGateway({
      acceptedRecordRecorder: {
        record: (record) => {
          persistenceAttempts += 1;

          if (persistenceAttempts === 1) {
            throw new Error('event persistence unavailable');
          }

          persistedRecords.push(record);
        },
      },
      createToken: () => 'token_control_1',
    });
    const registration = gateway.registerSession(environmentPackage);
    const request = {
      authorization: `Bearer ${registration.token}`,
      lineage,
      record: createEventRecord(lineage, 3),
    };

    expect(() => gateway.appendEvent(request)).toThrow('event persistence unavailable');
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toEqual([]);
    expect(gateway.appendEvent(request)).toMatchObject({
      accepted: true,
      nextExpectedSequence: 4,
    });
    expect(persistenceAttempts).toBe(2);
    expect(persistedRecords).toEqual([
      expect.objectContaining({
        operation: 'event_append',
        record: request.record,
        recordKey: '3',
        sequence: 3,
      }),
    ]);
    expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)?.events).toEqual([
      request.record,
    ]);
  });

  it('rejects stale or conflicting canonical event append sequences', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);

    gateway.appendEvent({
      authorization: `Bearer ${registration.token}`,
      lineage,
      record: createEventRecord(lineage, 3),
    });

    expect(() =>
      gateway.appendEvent({
        authorization: `Bearer ${registration.token}`,
        lineage,
        record: createEventRecord(lineage, 3, 'different'),
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_sequence_conflict',
        status: 409,
      }) as WorkerControlGatewayError
    );
    expect(() =>
      gateway.appendEvent({
        authorization: `Bearer ${registration.token}`,
        lineage,
        record: createEventRecord(lineage, 2),
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_sequence_stale',
        status: 409,
      }) as WorkerControlGatewayError
    );
  });

  it('rejects canonical event records whose embedded lineage does not match the request', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);

    expect(() =>
      gateway.appendEvent({
        authorization: `Bearer ${registration.token}`,
        lineage,
        record: createEventRecord({ ...lineage, threadId: 'th_other' }, 3),
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_lineage_mismatch',
        status: 403,
      }) as WorkerControlGatewayError
    );
  });

  it('rejects missing tokens and mismatched worker lineage', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({ createToken: () => 'token_control_1' });
    const registration = gateway.registerSession(environmentPackage);

    expect(() =>
      gateway.recordHeartbeat(heartbeatRequest('Bearer wrong', lineage, 1))
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_unauthorized',
        status: 401,
      }) as WorkerControlGatewayError
    );
    expect(() =>
      gateway.recordHeartbeat(
        heartbeatRequest(`Bearer ${registration.token}`, { ...lineage, threadId: 'th_other' }, 1)
      )
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_lineage_mismatch',
        status: 403,
      }) as WorkerControlGatewayError
    );
  });

  it('checks registered sandbox tokens against a durable lease binding resolver', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const resolvedBindings: Array<{ sandboxBindingRef: string; lineage: WorkerControlLineage }> =
      [];
    const gateway = new WorkerControlGateway({
      createToken: () => 'lease-binding:control_1',
      resolveTokenBinding: (input) => {
        resolvedBindings.push(input);

        return { status: 'accepted' };
      },
    });
    const registration = registerAcceptedWorkerSession(
      gateway,
      environmentPackage,
      'lease-binding:control_1'
    );

    gateway.recordHeartbeat(heartbeatRequest(`Bearer ${registration.token}`, lineage, 1));

    expect(resolvedBindings).toEqual([
      {
        lineage,
        sandboxBindingRef: 'lease-binding:control_1',
        token: WORKER_CONTROL_TOKEN,
        tokenFamily: 'worker-control',
      },
    ]);
  });

  it('authenticates a package from its bearer token and server-owned lineage only', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const resolvedBindings: Array<{ sandboxBindingRef: string; lineage: WorkerControlLineage }> =
      [];
    const gateway = new WorkerControlGateway({
      createToken: () => 'lease-binding:inference_1',
      resolveTokenBinding: (input) => {
        resolvedBindings.push(input);

        return { status: 'accepted' };
      },
    });
    const registration = registerAcceptedWorkerSession(
      gateway,
      environmentPackage,
      'lease-binding:inference_1'
    );

    expect(gateway.authenticatePackageToken(`Bearer ${registration.token}`)).toEqual(
      environmentPackage
    );
    expect(
      gateway.authenticatePackageToken(`Bearer ${registration.workerCapabilityToken}`, {
        tokenFamily: 'capability',
      })
    ).toEqual(environmentPackage);
    expect(() =>
      gateway.authenticatePackageToken(`Bearer ${registration.workerInferenceToken}`, {
        tokenFamily: 'capability',
      })
    ).toThrowError(expect.objectContaining({ code: 'worker_control_unauthorized' }) as Error);
    expect(resolvedBindings).toEqual([
      {
        lineage,
        sandboxBindingRef: 'lease-binding:inference_1',
        token: WORKER_CONTROL_TOKEN,
        tokenFamily: 'worker-control',
      },
      {
        lineage,
        sandboxBindingRef: 'lease-binding:inference_1',
        token: WORKER_CAPABILITY_TOKEN,
        tokenFamily: 'capability',
      },
    ]);
  });

  it('hydrates token-only package authentication when a durable session is restored', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
    });

    gateway.restoreSession({
      environmentPackage,
      lineage,
      registeredAt: '2026-06-16T00:00:01.000Z',
      sandboxBindingRef: 'lease-binding:restored_inference_1',
      workerCapabilityTokenHash: hashWorkerRouteToken(WORKER_CAPABILITY_TOKEN),
      workerControlTokenHash: hashWorkerRouteToken(WORKER_CONTROL_TOKEN),
      workerInferenceTokenHash: hashWorkerRouteToken(WORKER_INFERENCE_TOKEN),
    });

    expect(gateway.authenticatePackageToken(`Bearer ${WORKER_CONTROL_TOKEN}`)).toEqual(
      environmentPackage
    );
  });

  it('fails token-only package authentication without a live hydrated package', () => {
    const { lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
    });

    gateway.restoreSession({
      lineage,
      registeredAt: '2026-06-16T00:00:01.000Z',
      sandboxBindingRef: 'lease-binding:restored_without_package_1',
      workerCapabilityTokenHash: hashWorkerRouteToken(WORKER_CAPABILITY_TOKEN),
      workerControlTokenHash: hashWorkerRouteToken(WORKER_CONTROL_TOKEN),
      workerInferenceTokenHash: hashWorkerRouteToken(WORKER_INFERENCE_TOKEN),
    });

    expect(() => gateway.authenticatePackageToken('Bearer invalid')).toThrowError(
      expect.objectContaining({ code: 'worker_control_unauthorized', status: 401 }) as Error
    );
    expect(() => gateway.authenticatePackageToken(`Bearer ${WORKER_CONTROL_TOKEN}`)).toThrowError(
      expect.objectContaining({
        code: 'worker_control_package_unavailable',
        status: 409,
      }) as Error
    );
  });

  it('requires a durable scheduler lease for token-only package authentication', () => {
    const { environmentPackage } = createWorkerControlFixture();
    const gateways = [
      new WorkerControlGateway({ createToken: () => 'lease-binding:without_resolver' }),
      new WorkerControlGateway({
        createToken: () => 'manual_process_token',
        resolveTokenBinding: () => ({ status: 'accepted' }),
      }),
    ];

    for (const gateway of gateways) {
      const registration = gateway.registerSession(environmentPackage);

      expect(() => gateway.authenticatePackageToken(`Bearer ${registration.token}`)).toThrowError(
        expect.objectContaining({
          code: 'worker_control_lease_binding_required',
          status: 403,
        }) as WorkerControlGatewayError
      );
    }
  });

  it('rejects a restored package whose lineage differs from the token session', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway();

    expect(() =>
      gateway.restoreSession({
        environmentPackage,
        lineage: { ...lineage, requestId: 'req_other' },
        registeredAt: '2026-06-16T00:00:01.000Z',
        sandboxBindingRef: 'lease-binding:restore_mismatch_1',
        workerCapabilityTokenHash: hashWorkerRouteToken(WORKER_CAPABILITY_TOKEN),
        workerControlTokenHash: hashWorkerRouteToken(WORKER_CONTROL_TOKEN),
        workerInferenceTokenHash: hashWorkerRouteToken(WORKER_INFERENCE_TOKEN),
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_package_restore_mismatch',
        status: 409,
      }) as WorkerControlGatewayError
    );
  });

  it('binds worker control only to its distinct raw token and durable hash family', () => {
    const source = readFileSync(new URL('./worker-control-gateway.ts', import.meta.url), 'utf8');

    expect(source).toContain('workerControlTokenHash');
    expect(source).toContain('workerInferenceTokenHash');
    expect(source).toContain('timingSafeEqual');
    expect(source).not.toContain('const token = options.sandboxBindingRef');
    expect(source).not.toContain('Sandbox-local bearer token injected through runtime secrets.');
  });

  it('rejects registered sandbox tokens when the durable lease binding is not live', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const gateway = new WorkerControlGateway({
      createToken: () => 'lease-binding:control_1',
      resolveTokenBinding: () => ({ status: 'rejected', reason: 'lease-not-live' }),
    });
    const registration = registerAcceptedWorkerSession(
      gateway,
      environmentPackage,
      'lease-binding:control_1'
    );

    expect(() =>
      gateway.recordHeartbeat(heartbeatRequest(`Bearer ${registration.token}`, lineage, 1))
    ).toThrowError(
      expect.objectContaining({
        code: 'worker_control_lease_not_live',
        status: 403,
      }) as WorkerControlGatewayError
    );
  });

  it('passes owner-independent lineage to final-status lifecycle hooks', () => {
    const { environmentPackage, lineage } = createWorkerControlFixture();
    const acceptedInputs: unknown[] = [];
    const committedInputs: unknown[] = [];
    const gateway = new WorkerControlGateway({
      createToken: () => 'lease-binding:final_status_1',
      onFinalStatusAccepted: (input) => acceptedInputs.push(input),
      onFinalStatusCommitted: (input) => committedInputs.push(input),
      resolveFinalStatusTokenBinding: () => ({ replayOnly: false, status: 'accepted' }),
    });
    const registration = registerAcceptedWorkerSession(
      gateway,
      environmentPackage,
      'lease-binding:final_status_1'
    );

    gateway.recordFinalStatus({
      authorization: `Bearer ${registration.token}`,
      lineage,
      sequence: 7,
      status: 'completed',
      stopReason: 'completed',
    });

    const expectedInput = {
      eventType: 'turn.completed',
      lineage,
      sandboxBindingRef: 'lease-binding:final_status_1',
    };
    expect(acceptedInputs).toEqual([expectedInput]);
    expect(committedInputs).toEqual([expectedInput]);
  });
});
