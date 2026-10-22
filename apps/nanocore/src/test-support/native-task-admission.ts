/// <reference lib="es2024.promise" />
import { createHash } from 'node:crypto';
import fs, { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { workspaceIdForOwner } from '@openkit/protocol';
import { buildWorkerCanonicalTerminalEventRecord as terminalEvent } from '@openkit/worker-protocol';
import { expect, vi } from 'vitest';
import { createDefaultWorkerControlGateway } from '../app.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import { createExecutionStepJournalReader } from '../runtime/execution-journal.js';
import type { ExecutionJournalRef } from '../runtime/execution-step-journal.js';
import {
  dispatchNanoHostHarnessOperation,
  settleNanoHostHarnessOperation,
} from '../runtime/nanohost-harness-records.js';
import type { NanoHostSessionEffectRequest } from '../runtime/nanohost-session-dispatch.js';
import { createConfiguredWorkerLifecycleRuntime } from '../runtime/turn-executor-factory.js';
import { getWorkerCheckpoint } from '../runtime/worker-checkpoints.js';
import { getWorkerControlAcceptedFinalStatus as readFinal } from '../runtime/worker-control-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { type openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { recordTestNativeRuntimeTarget } from './native-environment.js';

/**
 * Models the peer; native owners fence delivery and release; interrupted finals follow real commands.
 * @param coreDb Caller-owned migrated Core database for the original execution.
 * @param store Caller-created Demo store sharing the same data root.
 * @returns Native executor, shared file admission, gateway and observer restoration.
 */
export function createNativeTaskAdmissionFixture(
  coreDb: ReturnType<typeof openCoreDb>,
  store: FsStore
) {
  recordTestNativeRuntimeTarget(coreDb);
  const fileAdmission = new FileStorageAdmission(coreDb.dataRoot, () => 1_000_000_000n);
  const workerControlGateway = createDefaultWorkerControlGateway(coreDb);
  const completion = Promise.withResolvers<void>();
  const launched = Promise.withResolvers<void>();
  const observedExecution = Promise.withResolvers<void>();
  let nativeInput = '';
  let nativeLineage: Parameters<typeof workerControlGateway.recordFinalStatus>[0]['lineage'];
  const nativeEvents: unknown[] = [];
  const journalRefs = new Map<string, ExecutionJournalRef>();
  const writeIntent = store.writeWorkspaceExecutionJournalIntent.bind(store);
  const journalObservation = vi
    .spyOn(store, 'writeWorkspaceExecutionJournalIntent')
    .mockImplementation(async (...args) => {
      const invocation = await writeIntent(...args);
      journalRefs.set(args[1].execution.workId, invocation.ref.execution);
      return invocation;
    });
  void launched.promise.catch(() => undefined);
  let peerState = 'new';
  let integrationBindingRef: string | undefined;
  const unsupported = () => Promise.reject(new Error('Native peer operation is not admitted.'));
  const runtime = createConfiguredWorkerLifecycleRuntime({
    coreDb,
    store,
    fileAdmission,
    workerControlGateway,
    env: {},
    readRuntimeConfig: () =>
      createInMemoryRuntimeConfigSnapshot({
        dataRoot: coreDb.dataRoot,
        workspaceConfigs: loadRuntimeConfig(coreDb.dataRoot).workspaceConfigs,
      }),
    nanoHostSessionDispatch: {
      async effect(requestOrConnection: object, carried?: NanoHostSessionEffectRequest) {
        const request = carried ?? (requestOrConnection as NanoHostSessionEffectRequest);
        if (request.kind === 'image.acquire') return { digest: request.input.imageReference };
        if (request.kind === 'image.inspect')
          return {
            digest: request.input.imageDigest,
            environmentDefaults: {
              defaultsDigest: `sha256:${createHash('sha256').update('{}').digest('hex')}`,
              values: {},
            },
            platform: { architecture: 'amd64', os: 'linux' },
            storageLayout: {
              family: 'openkit-worker',
              gid: 1000,
              uid: 1000,
              version: '1',
              workingDirectory: '/tmp/openkit-bootstrap',
              targets: ['/openkit/threads', '/sandbox', '/workspace'].map((target) => ({ target })),
            },
          };
        if (request.kind === 'sandbox.create') {
          const storage = request.input.storage as { targets: object[] };
          return {
            sandboxId: request.input.sandboxId,
            state: 'created',
            storage: {
              ...storage,
              targets: storage.targets.map((target) => ({ ...target, initialized: true })),
            },
          };
        }
        if (request.kind === 'bridge.open') {
          const ref = request.input.sandboxIntegrationBindingRef;
          if (typeof ref !== 'string' || !ref)
            throw new Error('Native bridge request lacks its actual Integration binding.');
          integrationBindingRef = ref;
          return { accepted: true, integrationReady: true, state: 'open' };
        }
        if (request.kind === 'reference.import') return { state: 'imported' };
        if (request.kind === 'workspace.collect')
          return request.input.mode === 'baseline'
            ? {
                requestId: request.requestId,
                outcome: 'baseline',
                head: {
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                },
              }
            : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
        if (request.kind === 'file.export') {
          if (!nativeLineage) throw new Error('Native trial has no submitted Turn.');
          const relativePath = String(request.input.relativePath);
          const records = relativePath.endsWith('/events.jsonl')
            ? nativeEvents
            : relativePath.endsWith('/items.jsonl')
              ? [
                  {
                    schemaVersion: 1,
                    kind: 'item',
                    sequence: 1,
                    lineage: nativeLineage,
                    item: { type: 'assistant-message', status: 'completed', text: nativeInput },
                  },
                ]
              : undefined;
          if (!records) throw new Error('Unexpected native trial export.');
          const bytes = Buffer.from(`${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
          const stagingPath = join(mkdtempSync(join(coreDb.dataRoot, 'peer-')), 'capture');
          fs.writeFileSync(stagingPath, bytes);
          return {
            stagingPath,
            byteLength: bytes.length,
            sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          };
        }
        if (request.kind === 'bridge.close' || request.kind === 'sandbox.delete')
          return { state: 'deleted' };
        throw new Error(`Unexpected native Mode trial effect: ${request.kind}`);
      },
      poll: async () => null,
      async result() {},
      route: unsupported,
      fileExportResult: unsupported,
      workspaceCollectResult: unsupported,
      imageBuildInput: unsupported,
    },
  });
  const executionBackend = runtime.turnExecutor.executionBackend;
  if (!executionBackend) throw new Error('Native admission fixture requires its actual backend.');
  const release = executionBackend.release.bind(executionBackend);
  const executor = Object.assign(runtime.turnExecutor, {
    completion,
    launched,
    finished: { promise: observedExecution.promise.catch(() => undefined) },
    checkpointAtLaunch: null as ReturnType<typeof getWorkerCheckpoint>,
    execution: observedExecution.promise,
    failCloseout: false,
    releaseResults: [] as Awaited<ReturnType<typeof release>>[],
    launches: 0,
    inputs: [] as string[],
  });
  const releaseSpy = vi.spyOn(executionBackend, 'release').mockImplementation(async (...args) => {
    const result = await release(...args);
    executor.releaseResults.push(result);
    if (executor.failCloseout && result.state === 'released' && result.fenceRef)
      throw new Error('Controlled release response loss.');
    return result;
  });
  const start = executor.startTurn.bind(executor);
  const startObservation = vi
    .spyOn(executor, 'startTurn')
    .mockImplementation(async (ownerStore, turnId, input, context) => {
      nativeInput = input;
      executor.launches += 1;
      executor.inputs.push(input);
      let settled = false;
      const execution = start(ownerStore, turnId, input, context).finally(() => {
        settled = true;
      });
      void execution.catch((error: unknown) => {
        launched.reject(error);
        completion.resolve();
      });
      let failure: unknown;
      let acceptedStart = false;
      let finalSequence = 0;
      let interrupt: Promise<void> | undefined;
      let reportFinal: ((interrupted: boolean) => void) | undefined;
      const peer = (async () => {
        while (!settled) {
          for (const integrationRef of integrationBindingRef ? [integrationBindingRef] : []) {
            const command = dispatchNanoHostHarnessOperation(coreDb, {
              sandboxIntegrationBindingRef: integrationRef,
            });
            if (!command) continue;
            let commandSettled = false;
            try {
              const wire = runtime.acceptNanoHostHarnessCommand(command);
              const ready = { nativeHandleState: 'ready', nativeHandleDigest: 'a'.repeat(64) };
              const operations: Record<string, [string, string, Record<string, unknown>]> = {
                'session.open': [
                  'new',
                  'open',
                  { state: 'open', maxActiveTurns: command.body.maxActiveTurns, ...ready },
                ],
                'turn.start': ['open', 'running', { state: 'started', ...ready }],
                'session.inspect': [
                  'completed',
                  'completed',
                  { state: 'open', childState: 'absent', cleanupState: 'clean', ...ready },
                ],
                'session.close': [
                  'completed',
                  'closed',
                  { state: 'closed', privateState: 'absent', childState: 'absent' },
                ],
                'turn.interrupt': ['running', 'running', { state: 'interrupted' }],
              };
              const [required, next, body] = operations[command.operation] ?? [];
              if (!body || peerState !== required)
                throw new Error(`Native peer state does not admit ${command.operation}.`);
              if (command.operation === 'turn.start') {
                const turn = ownerStore.getTurnById(turnId);
                nativeLineage = {
                  agentSessionId: String(command.body.agentSessionId),
                  packageSnapshotId: String(command.body.packageSnapshotId),
                  requestId: context?.requestId ?? null,
                  workspaceId: workspaceIdForOwner(turn.owner),
                  threadId: turn.threadId,
                  turnId,
                };
                const db = openWorkspaceDb(coreDb.dataRoot, nativeLineage.workspaceId);
                try {
                  const checkpoint = getWorkerCheckpoint(db, db.workspaceId, turn.threadId, turnId);
                  executor.checkpointAtLaunch = checkpoint;
                  const ref = journalRefs.get(turnId);
                  if (!ref) throw new Error('Native launch lacks its acknowledged journal.');
                  const reader = createExecutionStepJournalReader(db, ref.owner);
                  const root = await reader.readExecution(ref);
                  expect(root).toMatchObject({ phase: 'open', workId: turnId });
                  const open = await Promise.all(
                    root.openSteps.map((step) => reader.readInvocation(step))
                  );
                  const ended = await reader.readEndedSteps(ref);
                  expect([...open, ...ended].map((step) => step.control.kind)).toEqual(
                    expect.arrayContaining(['materialize', 'terminal-publication', 'release'])
                  );
                } finally {
                  db.sqlite.close();
                }
                reportFinal = (interrupted) => {
                  const status = interrupted ? 'interrupted' : 'completed';
                  const stopReason = interrupted ? 'aborted' : 'completed';
                  const data = { status, stopReason, evidenceManifestDigests: {} } as const;
                  const sequence = ++finalSequence;
                  nativeEvents.push(terminalEvent({ lineage: nativeLineage, sequence, data }));
                  expect(
                    workerControlGateway.recordFinalStatus({
                      authorization: `Bearer ${wire.body.workerControlToken}`,
                      tokenFamily: 'worker-control',
                      lineage: nativeLineage,
                      sequence,
                      ...data,
                    }).accepted
                  ).toBe(true);
                  peerState = 'completed';
                };
              }
              peerState = next!;
              const result = {
                schemaVersion: 2 as const,
                harnessInstanceId: command.harnessInstanceId,
                operationId: command.operationId,
                sequence: command.sequence,
                disposition: 'succeeded' as const,
                body,
              };
              settleNanoHostHarnessOperation(coreDb, {
                result,
                sandboxIntegrationBindingRef: integrationRef,
                timestamp: new Date().toISOString(),
              });
              commandSettled = true;
              runtime.acceptNanoHostHarnessResult(result);
              if (command.operation === 'turn.start') {
                acceptedStart = true;
                launched.resolve();
                await completion.promise;
                if (!settled) reportFinal!(false);
              } else if (command.operation === 'turn.interrupt') reportFinal!(true);
            } catch (error) {
              failure ??= error;
              launched.reject(failure);
              if (!commandSettled) {
                settleNanoHostHarnessOperation(coreDb, {
                  sandboxIntegrationBindingRef: integrationRef,
                  result: {
                    schemaVersion: 2,
                    harnessInstanceId: command.harnessInstanceId,
                    operationId: command.operationId,
                    sequence: command.sequence,
                    disposition: 'unknown',
                    body: { reasonCode: 'outcome_unknown' },
                  },
                  timestamp: new Date().toISOString(),
                });
                runtime.failNanoHostHarnessDelivery(command, failure);
              } else if (acceptedStart && !readFinal(coreDb, nativeLineage)) {
                interrupt ??= executor.interruptTurn(ownerStore, turnId).catch(() => undefined);
              }
            }
          }
          if (!settled) await setImmediate();
        }
        await interrupt;
        if (failure) throw failure;
      })();
      const joined = Promise.allSettled([execution, peer]).then((results) => {
        if (failure) throw failure;
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      });
      observedExecution.resolve(joined);
      await joined;
    });
  return {
    executor,
    fileAdmission,
    workerControlGateway,
    restore() {
      startObservation.mockRestore();
      releaseSpy.mockRestore();
      journalObservation.mockRestore();
    },
  };
}
