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
import { requireAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import * as attempts from '../runtime/execution-attempt-records.js';
import { createExecutionStepJournalReader } from '../runtime/execution-journal.js';
import type { ExecutionJournalRef } from '../runtime/execution-step-journal.js';
import {
  dispatchNanoHostHarnessOperation,
  settleNanoHostHarnessOperation,
} from '../runtime/nanohost-harness-records.js';
import type { NanoHostSessionEffectRequest } from '../runtime/nanohost-session-dispatch.js';
import { runSchedulerDispatchLoop } from '../runtime/scheduler-dispatch-loop.js';
import { createConfiguredWorkerLifecycleRuntime } from '../runtime/turn-executor-factory.js';
import type { TurnExecutor } from '../runtime/types.js';
import { getWorkerCheckpoint } from '../runtime/worker-checkpoints.js';
import { getWorkerControlAcceptedFinalStatus as readFinal } from '../runtime/worker-control-records.js';
import { WorkerGovernanceCapacityUnavailableError } from '../runtime/worker-governance-backend.js';
import type { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { type openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { recordTestNativeRuntimeTarget } from './native-environment.js';

/**
 * Models the peer; native owners fence delivery and release; interrupted finals follow real commands.
 * @param coreDb Caller-owned migrated Core database for this fixture lifetime.
 * @param store Caller-created Demo store sharing the same data root.
 * @param options Shared runtime configuration and optional outside peer Git checkout report.
 * @param outside Opaque outside peer facts retained across sequential stopped controllers.
 * @returns Outside facts, native executor, per-Turn gates, effects, runtime, admission, gateway and stop.
 */
export function createNativeTaskAdmissionFixture(
  coreDb: ReturnType<typeof openCoreDb>,
  store: FsStore,
  options: Pick<
    NonNullable<Parameters<typeof createConfiguredWorkerLifecycleRuntime>[0]>,
    'readRuntimeConfig'
  > & {
    /** Outside checkout HEAD/tree; Core verifies its commit against the admitted source pin. */
    workspaceGitBaseline?: { commit: string; tree: string };
  } = {},
  outside = {
    bindings: new Map<string, Map<string, { state: string; turnId: string | null }>>(),
    integrationBindingRef: undefined as string | undefined,
    transcripts: new Map<
      string,
      { input: string; events: unknown[]; lineage: Parameters<typeof readFinal>[1] }
    >(),
    effects: [] as NanoHostSessionEffectRequest[],
    peerFaults: {
      failedFinal: false,
      failFileExport: false,
      closeRefusal: undefined as 'cleanup_required' | 'conflict' | undefined,
      failedExportPaths: [] as string[],
    },
  }
) {
  recordTestNativeRuntimeTarget(coreDb);
  const fileAdmission = new FileStorageAdmission(coreDb.dataRoot, () => 1_000_000_000n);
  const workerControlGateway = createDefaultWorkerControlGateway(coreDb);
  const completion = Promise.withResolvers<void>();
  const launched = Promise.withResolvers<void>();
  const observedExecution = Promise.withResolvers<void>();
  type Lineage = Parameters<typeof workerControlGateway.recordFinalStatus>[0]['lineage'];
  type Gate = ReturnType<typeof Promise.withResolvers<void>>;
  const executions = new Map<
    string,
    {
      completion: Gate;
      launched: Gate;
      observed: Gate;
      execution?: Promise<void>;
      input: string;
      context?: Parameters<TurnExecutor['startTurn']>[3];
      ownerStore?: FsStore;
      lineage?: Lineage;
      events: unknown[];
      settled: boolean;
      started: boolean;
      acceptedStart?: boolean;
      reportFinal?: (interrupted: boolean) => void;
      reported?: boolean;
      failure?: unknown;
      interrupt?: Promise<void>;
      delivery?: Promise<void>;
    }
  >();
  /** Keeps separate ephemeral gates for the exact Turn that its real admission will execute. */
  const executionFor = (turnId: string) => {
    if (stopped) throw new Error('Native peer is stopped.');
    let turn = executions.get(turnId);
    if (!turn) {
      store.getTurnById(turnId);
      turn = {
        completion: executions.size ? Promise.withResolvers<void>() : completion,
        launched: executions.size ? Promise.withResolvers<void>() : launched,
        observed: executions.size ? Promise.withResolvers<void>() : observedExecution,
        input: '',
        events: [],
        settled: false,
        started: false,
      };
      void turn.launched.promise.catch(() => undefined);
      executions.set(turnId, turn);
    }
    return turn;
  };
  let stopped = false;
  let peerFailure: unknown;
  // The outside peer retains accepted facts across sequential stopped Core controllers.
  const { bindings, transcripts, effects, peerFaults } = outside;
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
  const unsupported = () => Promise.reject(new Error('Native peer operation is not admitted.'));
  const runtime = createConfiguredWorkerLifecycleRuntime({
    coreDb,
    store,
    fileAdmission,
    workerControlGateway,
    env: {},
    readRuntimeConfig:
      options.readRuntimeConfig ??
      (() =>
        createInMemoryRuntimeConfigSnapshot({
          dataRoot: coreDb.dataRoot,
          workspaceConfigs: loadRuntimeConfig(coreDb.dataRoot).workspaceConfigs,
        })),
    nanoHostSessionDispatch: {
      async effect(requestOrConnection: object, carried?: NanoHostSessionEffectRequest) {
        if (stopped) throw new Error('Native peer is stopped.');
        const request = carried ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request);
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
          outside.integrationBindingRef = ref;
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
          const transcript = [...transcripts.values()].find(
            (candidate) => candidate.lineage.packageSnapshotId === request.input.packageSnapshotId
          );
          if (!transcript) throw new Error('Native trial has no submitted Turn.');
          const { lineage: nativeLineage, events: nativeEvents, input: nativeInput } = transcript;
          if (peerFaults.failFileExport && readFinal(coreDb, nativeLineage)?.status === 'failed') {
            peerFaults.failedExportPaths.push(String(request.input.relativePath));
            throw new Error('Controlled required native export loss.');
          }
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
        if (request.kind === 'bridge.close' || request.kind === 'sandbox.delete') {
          outside.integrationBindingRef = undefined;
          return { state: 'deleted' };
        }
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
    nativeLineage: null as Lineage | null,
    releaseResults: [] as Awaited<ReturnType<typeof release>>[],
    launches: 0,
    capabilityToken: '',
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
      if (stopped || peerFailure) throw peerFailure ?? new Error('Native peer is stopped.');
      const turn = executionFor(turnId);
      const previous = turn.context?.attemptId;
      const refused =
        turn.settled &&
        !turn.lineage &&
        previous &&
        context?.attemptId &&
        previous !== context.attemptId &&
        attempts.isSchedulerExecutionBusyRefusal(
          attempts.requireSchedulerExecutionAttempt(coreDb, previous)
        );
      if (turn.started && !refused)
        throw new Error('Native peer already observed this Turn execution.');
      Object.assign(turn, { ownerStore, input, context, started: true, settled: false });
      executor.launches += 1;
      executor.inputs.push(input);
      const execution = start(ownerStore, turnId, input, context).finally(() => {
        turn.settled = true;
      });
      void execution.catch((error: unknown) => {
        if (error instanceof WorkerGovernanceCapacityUnavailableError && !turn.lineage) return;
        turn.observed.resolve(joined);
        turn.launched.reject(error);
        turn.completion.resolve();
      });
      const joined = execution.finally(async () => {
        await turn.delivery;
        await turn.interrupt;
        if (turn.failure) throw turn.failure;
      });
      turn.execution = joined;
      await joined;
    });
  /** Retains the first peer fault and requests the existing interrupt owner after accepted launch. */
  const failTurn = (turn: ReturnType<typeof executionFor>, error: unknown) => {
    turn.failure ??= error;
    turn.launched.reject(turn.failure);
    if (
      !stopped &&
      !turn.settled &&
      turn.acceptedStart &&
      turn.lineage &&
      !readFinal(coreDb, turn.lineage)
    )
      turn.interrupt ??= executor
        .interruptTurn(turn.ownerStore!, turn.lineage.turnId)
        .catch(() => undefined);
  };
  const peer = (async () => {
    while (!stopped) {
      for (const integrationRef of outside.integrationBindingRef
        ? [outside.integrationBindingRef]
        : []) {
        if (stopped) break;
        const command = dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: integrationRef,
        });
        if (!command) continue;
        let commandSettled = false;
        let turn: ReturnType<typeof executionFor> | undefined;
        try {
          const wire = runtime.acceptNanoHostHarnessCommand(command);
          const agentSessionId = command.body.agentSessionId;
          if (typeof agentSessionId !== 'string') throw new Error('Native command lacks Session.');
          let harness = bindings.get(command.harnessInstanceId);
          if (!harness) {
            harness = new Map();
            bindings.set(command.harnessInstanceId, harness);
          }
          let binding = harness.get(agentSessionId);
          if (!binding && command.operation === 'session.open') {
            binding = { state: 'new', turnId: null };
            harness.set(agentSessionId, binding);
          }
          if (!binding) throw new Error('Native command lacks its opened Session.');
          turn = executions.get(String(command.body.turnId ?? binding.turnId));
          const ready = { nativeHandleState: 'ready', nativeHandleDigest: 'a'.repeat(64) };
          const operations: Record<string, [string[], string, Record<string, unknown>]> = {
            'session.open': [
              ['new'],
              'open',
              {
                state: 'open',
                maxActiveTurns: command.body.maxActiveTurns,
                ...ready,
                ...(options.workspaceGitBaseline
                  ? { workspaceGitBaseline: options.workspaceGitBaseline }
                  : {}),
              },
            ],
            'turn.start': [['open', 'completed'], 'running', { state: 'started', ...ready }],
            'session.inspect': [
              ['open', 'completed'],
              binding.state,
              { state: 'open', childState: 'absent', cleanupState: 'clean', ...ready },
            ],
            'session.close': [
              ['open', 'completed'],
              'closed',
              { state: 'closed', privateState: 'absent', childState: 'absent' },
            ],
            'turn.interrupt': [['running'], 'running', { state: 'interrupted' }],
          };
          const [required, next, body] = operations[command.operation] ?? [];
          if (!body || !required!.includes(binding.state))
            throw new Error(`Native peer state does not admit ${command.operation}.`);
          if (command.operation === 'turn.start') {
            const turnId = command.body.turnId;
            if (turn?.acceptedStart || transcripts.has(String(turnId)))
              throw new Error('Native peer refuses Turn replay.');
            if (typeof turnId !== 'string' || !turn?.started || !turn.ownerStore)
              throw new Error('Native command lacks its actual Turn execution.');
            const product = turn.ownerStore.getTurnById(turnId);
            const nativeLineage: Lineage = {
              agentSessionId,
              packageSnapshotId: String(command.body.packageSnapshotId),
              requestId: turn.context?.requestId ?? null,
              workspaceId: workspaceIdForOwner(product.owner),
              threadId: product.threadId,
              turnId,
            };
            turn.lineage = nativeLineage;
            binding.turnId = turnId;
            const db = openWorkspaceDb(coreDb.dataRoot, nativeLineage.workspaceId);
            try {
              const checkpoint = getWorkerCheckpoint(db, db.workspaceId, product.threadId, turnId);
              executor.checkpointAtLaunch = checkpoint;
              const ref = journalRefs.get(turnId);
              if (!ref) throw new Error('Native launch lacks its acknowledged journal.');
              const reader = createExecutionStepJournalReader(db, ref.owner);
              const root = await reader.readExecution(ref);
              if (stopped) return;
              expect(root).toMatchObject({ phase: 'open', workId: turnId });
              const open = await Promise.all(
                root.openSteps.map((step) => reader.readInvocation(step))
              );
              if (stopped) return;
              const ended = await reader.readEndedSteps(ref);
              if (stopped) return;
              expect([...open, ...ended].map((step) => step.control.kind)).toEqual(
                expect.arrayContaining(['materialize', 'terminal-publication', 'release'])
              );
            } finally {
              db.sqlite.close();
            }
            const original = turn;
            const originalBinding = binding;
            original.reportFinal = (interrupted) => {
              if (stopped || original.settled || !original.acceptedStart || original.reported)
                return;
              original.reported = true;
              const status = interrupted
                ? 'interrupted'
                : peerFaults.failedFinal
                  ? 'failed'
                  : 'completed';
              const stopReason = interrupted
                ? 'aborted'
                : peerFaults.failedFinal
                  ? 'error'
                  : 'completed';
              const data = { status, stopReason, evidenceManifestDigests: {} } as const;
              const sequence = original.events.length + 1;
              original.events.push(terminalEvent({ lineage: nativeLineage, sequence, data }));
              expect(
                workerControlGateway.recordFinalStatus({
                  authorization: `Bearer ${wire.body.workerControlToken}`,
                  tokenFamily: 'worker-control',
                  lineage: nativeLineage,
                  sequence,
                  ...data,
                }).accepted
              ).toBe(true);
              originalBinding.state = 'completed';
            };
            original.delivery = original.completion.promise
              .then(() => original.reportFinal!(false))
              .catch((error: unknown) => failTurn(original, error));
          }
          const closeRefusal =
            command.operation === 'session.close' ? peerFaults.closeRefusal : undefined;
          if (!closeRefusal) binding.state = next!;
          const result = {
            schemaVersion: 2 as const,
            harnessInstanceId: command.harnessInstanceId,
            operationId: command.operationId,
            sequence: command.sequence,
            disposition: closeRefusal ? ('refused' as const) : ('succeeded' as const),
            body: closeRefusal ? { reasonCode: closeRefusal } : body,
          };
          settleNanoHostHarnessOperation(coreDb, {
            result,
            sandboxIntegrationBindingRef: integrationRef,
            timestamp: new Date().toISOString(),
          });
          commandSettled = true;
          runtime.acceptNanoHostHarnessResult(result);
          if (command.operation === 'turn.start') {
            turn!.acceptedStart = true;
            // Export history retains peer data, without the stopped controller's gates or callbacks.
            transcripts.set(turn!.lineage!.turnId, {
              input: turn!.input,
              events: turn!.events,
              lineage: turn!.lineage!,
            });
            turn!.observed.resolve(turn!.execution!);
            executor.nativeLineage = turn!.lineage!;
            executor.capabilityToken = String(wire.body.capabilityToken);
            turn!.launched.resolve();
          } else if (command.operation === 'turn.interrupt') {
            if (!turn?.lineage) throw new Error('Native interrupt lacks its original execution.');
            // Interrupt uses the original launch credential and lineage, never a new final identity.
            turn.reportFinal!(true);
            turn.completion.resolve();
          }
        } catch (error) {
          if (stopped) return;
          if (turn) failTurn(turn, error);
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
            runtime.failNanoHostHarnessDelivery(command, error);
          }
        }
      }
      if (!stopped) await setImmediate();
    }
  })();
  void peer.catch((error: unknown) => {
    peerFailure ??= error;
    stopped = true;
    for (const turn of executions.values()) {
      turn.failure ??= peerFailure;
      turn.launched.reject(peerFailure);
      turn.completion.resolve();
    }
  });
  return {
    outside,
    executor,
    effects: effects as readonly NanoHostSessionEffectRequest[],
    fileAdmission,
    peerFaults,
    workerControlGateway,
    runtime,
    executionFor(turnId: string) {
      const turn = executionFor(turnId);
      return {
        completion: turn.completion,
        launched: turn.launched,
        execution: turn.observed.promise,
      };
    },
    /**
     * Joins real native admission after the caller publishes its pending Turn and receipt.
     * @param entry Actual scheduler entry already published through the canonical Store owner.
     * @param input Exact attempt, expected Session and offered Session identity.
     * @returns Acknowledged attempt/package, actual work and explicit completion/cleanup joins.
     */
    async admitTurn(
      entry: ReturnType<typeof createSchedulerAdmissionEntry>,
      input: { attemptId: string; agentSessionId: string; candidateAgentSessionId: string }
    ) {
      const configuration = options.readRuntimeConfig?.();
      if (!configuration) throw new Error('Native admission requires its runtime configuration.');
      const { workspaceId, threadId, turnId } = entry;
      const turn = executionFor(turnId);
      const dispatch = runSchedulerDispatchLoop({
        coreDb,
        store,
        turnExecutor: executor,
        executionBackend,
        agentManifests: configuration.agentManifests,
        gatewayConfig: configuration.gatewayConfig,
        providerRegistry: configuration.providerRegistry,
        workspaceMcpServerCatalogs: configuration.workspaceMcpServerCatalogs,
        maxDispatches: 1,
        createAttemptId: () => input.attemptId,
        createAgentSessionId: () => input.candidateAgentSessionId,
      });
      const cleanup = async () => {
        turn.completion.resolve();
        await dispatch.catch(() => undefined);
        // Native acceptance owns observed; a refused call still owns its invocation join.
        await turn.execution?.catch(() => undefined);
      };
      try {
        await Promise.race([
          turn.launched.promise,
          dispatch.then((result) => {
            if (!result.startedTurns.length)
              throw new Error('Native admission returned without its Turn.');
            return turn.launched.promise;
          }),
        ]);
        const attempt = await vi.waitFor(() => {
          const current = attempts.requireSchedulerExecutionAttempt(coreDb, input.attemptId);
          expect(current).toMatchObject({
            workspaceId,
            threadId,
            turnId,
            agentSessionId: input.agentSessionId,
            phase: 'open',
            disposition: 'accepted',
          });
          return current;
        });
        const db = openWorkspaceDb(coreDb.dataRoot, workspaceId);
        try {
          return {
            attempt,
            pkg: requireAgentEnvironmentPackageSnapshot(db, workspaceId, attempt.inputRef!)
              .snapshot,
            execution: turn.observed.promise,
            async complete() {
              turn.completion.resolve();
              await turn.observed.promise;
              return await dispatch;
            },
            cleanup,
          };
        } finally {
          db.sqlite.close();
        }
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
    /** Stops this controller after caller joins work; returns its existing pump completion. */
    restore() {
      stopped = true;
      startObservation.mockRestore();
      releaseSpy.mockRestore();
      journalObservation.mockRestore();
      return peer;
    },
  };
}
