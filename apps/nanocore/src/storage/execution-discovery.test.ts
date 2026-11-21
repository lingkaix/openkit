import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it, vi } from 'vitest';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { settleCoreIdleJournal } from '../runtime/core-journal-records.js';
import {
  closeSchedulerExecutionAttemptWithFence,
  markSchedulerExecutionAttemptClosing,
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from '../runtime/execution-attempt-records.js';
import * as journalOwner from '../runtime/execution-journal.js';
import {
  CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
  createExecutionStepJournalReader,
  executionJournalProcessWitness,
  hasIdleCleanupExecution,
  settleExecutionJournalStep,
  writeExecutionJournalIntent,
} from '../runtime/execution-journal.js';
import { ExecutionReconciler } from '../runtime/execution-reconciler.js';
import type {
  ExecutionJournalIntent,
  ExecutionJournalSpan,
} from '../runtime/execution-step-journal.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { createNanoHostEffectRequest } from '../runtime/nanohost-effect-identity.js';
import {
  createNanoHostHarnessRuntime,
  drainNanoHostSandboxAdmission,
} from '../runtime/nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  mutateNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target-records.js';
import { createNanoHostSessionDispatch } from '../runtime/nanohost-session-dispatch.js';
import {
  admitWorkerImageEnvironment,
  insertWorkerImageSettlementInTransaction,
  readWorkerImageSettlement,
} from '../runtime/worker-image-settlements-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { createTestQueueEntry } from '../test-support/scheduler-admissions.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import type { NanoHostCoreReads } from './control-kernel-port.js';
import { controlStoreFor } from './control-store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { ensureLayout } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import { createNanoHostCoreReads } from './nanohost-core-reads.js';
import type { AdmittedNanoHostTransportStorage } from './nanohost-transport-owner.js';

/** Supplies journal primitive inputs only; no resident, receiver result or physical authority. */
function discoveryIntent(index: number): ExecutionJournalIntent {
  const requestId = index.toString(16).padStart(64, '0');
  const definitionVersion = CORE_IDLE_CLEANUP_EXECUTION_DEFINITION;
  const span: ExecutionJournalSpan & { endTimeUnixNano: null } = {
    traceId: requestId.slice(-32),
    spanId: (index * 2).toString(16).padStart(16, '0'),
    flags: 0,
    name: 'candidate discovery fixture',
    kind: 'INTERNAL',
    startTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
    endTimeUnixNano: null,
    status: { code: 'UNSET' },
    attributes: [],
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    instrumentationScope: {
      name: 'openkit.candidate-discovery-test',
      attributes: [],
      droppedAttributesCount: 0,
    },
    resource: { attributes: [], droppedAttributesCount: 0 },
  };
  return {
    execution: {
      ref: { owner: { kind: 'server' }, executionId: `retired-idle-${requestId}` },
      definitionVersion,
      workId: requestId,
      fingerprint: 'a'.repeat(64),
      exclusionRefs: [],
      span,
    },
    stepId: `effect:${requestId}`,
    parentStepId: null,
    parent: null,
    inspectedStep: null,
    carriage: {
      operation: 'bridge.close',
      requestId,
      sequence: null,
      bindingRef: null,
    },
    control: {
      definitionVersion,
      kind: 'inspect-cleanup',
      target: null,
      workId: requestId,
      operationId: requestId,
      attemptId: null,
      invocationId: `discovery:${requestId}`,
      actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      inputRefs: [],
      outputRefs: [],
      fingerprint: 'b'.repeat(64),
      permittingDecisionRef: null,
      authorityRefs: [],
      retryDeclarationRef: null,
      retryPermitted: false,
      deadlineUnixNano: null,
      physicalFenceRefs: [],
    },
    span: {
      ...span,
      spanId: (index * 2 + 1).toString(16).padStart(16, '0'),
      parentSpanId: span.spanId,
    },
  };
}

const emptyDrainingOwner: NanoHostCoreReads = {
  readTarget: () => ({ state: 'ready', value: null }),
  readBackendSession: () => ({ state: 'ready', value: null }),
  readResident: () => ({ state: 'ready', value: null }),
  listDrainingResidents: () => ({ state: 'ready', value: { bindings: [], next: null } }),
};

describe('Core execution candidate discovery', () => {
  it('rediscovers a commit queued as the last empty page completes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-execution-finishing-wake-'));
    const db = openCoreDb(dataRoot);
    const advanceIdleCleanup = vi.fn(async () => {});
    const reconciler = new ExecutionReconciler({
      coreDb: db,
      nanoHost: emptyDrainingOwner,
      advanceIdleCleanup,
    });
    const prepared = discoveryIntent(1);
    const committed: ExecutionJournalIntent = {
      ...prepared,
      carriage: { ...prepared.carriage, operation: 'workspace.collect' },
      control: { ...prepared.control, kind: 'collect' },
    };
    const read = journalOwner.listExecutionCandidates;
    const discovered: string[] = [];
    let queued = false;
    let projection: journalOwner.ExecutionCandidate | undefined;
    const discovery = vi
      .spyOn(journalOwner, 'listExecutionCandidates')
      .mockImplementation((...args) => {
        const actual = read(...args);
        // Scheduling-only projection: the real collect invocation grants no physical authority.
        const page = projection ? { candidates: [projection], next: null } : actual;
        discovered.push(...page.candidates.map(({ ref }) => ref.execution.executionId));
        if (page.next === null && page.candidates.length === 0 && !queued) {
          queued = true;
          queueMicrotask(() => {
            const invocation = controlStoreFor(db.sqlite).write(() =>
              writeExecutionJournalIntent(db, committed)
            );
            projection = { ref: invocation.ref, revision: 1 };
            reconciler.wake();
          });
        }
        return page;
      });
    try {
      applyMigrations(db);
      await reconciler.runOnce();
      // DX Global Dispatch: wake must survive the interval between scan exhaustion and pass release.
      // A second runOnce would hide a lost automatic follow-up in that completion interval.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(queued).toBe(true);
      expect(discovered).toContain(committed.execution.ref.executionId);
      expect(advanceIdleCleanup).not.toHaveBeenCalled();
    } finally {
      await reconciler.stop();
      discovery.mockRestore();
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('rediscovers work committed during a pass and after scan exhaustion', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-execution-wake-'));
    const db = openCoreDb(dataRoot);
    const advanceIdleCleanup = vi.fn(async () => {});
    const reconciler = new ExecutionReconciler({
      coreDb: db,
      nanoHost: emptyDrainingOwner,
      advanceIdleCleanup,
    });
    const read = journalOwner.listExecutionCandidates;
    const discovered: string[] = [];
    const projections: journalOwner.ExecutionCandidate[] = [];
    let injected = false;
    let continued = false;
    const collection = (index: number): ExecutionJournalIntent => {
      const intent = discoveryIntent(index);
      return {
        ...intent,
        carriage: { ...intent.carriage, operation: 'workspace.collect' },
        control: { ...intent.control, kind: 'collect' },
      };
    };
    const earlier = collection(2);
    const exhausted = collection(3);
    const commitProjection = (intent: ExecutionJournalIntent) => {
      const invocation = controlStoreFor(db.sqlite).write(() =>
        writeExecutionJournalIntent(db, intent)
      );
      projections.push({ ref: invocation.ref, revision: 1 });
    };
    const discovery = vi
      .spyOn(journalOwner, 'listExecutionCandidates')
      .mockImplementation((...args) => {
        read(...args);
        // These projections isolate invalidation scheduling, not pending-resident selection.
        const page = { candidates: [...projections], next: continued ? null : 'scheduling-cut' };
        continued = true;
        discovered.push(...page.candidates.map(({ ref }) => ref.execution.executionId));
        if (args[1] !== null && args[1] !== undefined && !injected) {
          injected = true;
          commitProjection(earlier);
          reconciler.wake();
        }
        return page;
      });
    try {
      applyMigrations(db);
      commitProjection(collection(1));
      await reconciler.runOnce();
      // DX Global Dispatch: a commit during selection invalidates the active pass.
      expect(injected).toBe(true);
      expect(discovered).toContain(earlier.execution.ref.executionId);

      discovered.length = 0;
      commitProjection(exhausted);
      reconciler.wake();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(discovered).toContain(exhausted.execution.ref.executionId);
      expect(advanceIdleCleanup).not.toHaveBeenCalled();
    } finally {
      await reconciler.stop();
      discovery.mockRestore();
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('advances only the pending resident without reading poisoned completed history', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-execution-pending-selection-'));
    ensureLayout(dataRoot);
    const db = openCoreDb(dataRoot);
    const nanoHostPath = join(dataRoot, 'server/extensions/nanohost/state.sqlite');
    mkdirSync(dirname(nanoHostPath), { recursive: true });
    const writer = new Database(nanoHostPath);
    const readerDb = new Database(nanoHostPath, { readonly: true, fileMustExist: true });
    const owner = { sqlite: writer };
    function read<Value>(query: (sqlite: Database.Database) => Value) {
      return { state: 'ready', value: query(readerDb) } as const;
    }
    const nanoHost = createNanoHostCoreReads({ read });
    const advanceIdleCleanup = vi.fn(async () => {});
    const reconciler = new ExecutionReconciler({ coreDb: db, nanoHost, advanceIdleCleanup });
    const sessionAuthority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ coreDb: db, sessionAuthority });
    const connected = Promise.withResolvers<object>();
    const server = createHttp2Server((request, response) => {
      connected.resolve(readNanoHostPhysicalConnectionContext(request)!);
      response.writeHead(204).end();
    });
    let physicalConnection: object | undefined;
    let client: ReturnType<typeof connectHttp2> | undefined;
    try {
      applyMigrations(db);
      writer.pragma('foreign_keys = ON');
      migrate(drizzle(writer), {
        migrationsFolder: fileURLToPath(
          new URL('../../drizzle/extensions/nanohost/', import.meta.url)
        ),
      });
      const ownerUserId = ensureLocalUser(db);
      const store = await createDemoStore({ dataRoot });
      recordWorkspaceOwnerMembership({ coreDb: db, ownerUserId, workspaceId: DEMO_WORKSPACE_ID });
      const { manifest } = createTestAgentSetup();
      const createdAt = new Date().toISOString();
      const requestId = testEntityId('tu', 'pending_selection_request').slice(3);
      const text = 'Keep only current resident cleanup eligible for selection.';
      const entry = await createTestQueueEntry(db, {
        backendId: 'nanohost',
        queueEntryId: 'queue:pending-selection',
        requestId,
        requestedAgentId: manifest.id,
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: DEMO_THREAD_ID,
        turnId: testEntityId('tu', 'pending_selection'),
        text,
        triggerActor: { kind: 'user', id: ownerUserId },
      });
      const scope = {
        workspaceId: entry.workspaceId,
        threadId: entry.threadId,
        actorId: ownerUserId,
      };
      await store.createTurn(
        entry.workspaceId,
        entry.threadId,
        text,
        entry.triggerActor,
        undefined,
        {
          turnId: entry.turnId,
          status: 'pending',
          agentId: manifest.id,
          executorKind: 'worker',
          commandReceipt: {
            key: commandRequestKey('turn.start', requestId, scope),
            command: 'turn.start',
            requestId,
            scope,
            inputHash: commandInputHash({
              queueEntryId: entry.queueEntryId,
              turnInput: text,
            }),
            responseKind: 'turn',
            createdAt,
            expiresAt: commandRequestExpiresAt(createdAt),
          },
        }
      );
      const attemptId = testEntityId('attempt', 'pending_selection');
      const agentSessionId = testEntityId('as', 'pending_selection');
      const packageSnapshotId = 'aepsnap_pending_selection';
      const sandboxBindingRef = 'sandbox-binding:pending-selection';
      const prepared = recordTestExecutionAttempt(db, {
        entry,
        attemptId,
        agentSessionId,
        inputRef: packageSnapshotId,
        bindingRef: sandboxBindingRef,
        sessionCompatibilityKey: 'pending-selection',
        now: () => createdAt,
        operationId: 'pending-selection-submit',
      });
      const originalTurn = await store.completeTurn(entry.turnId, {
        status: 'completed',
        completedAt: createdAt,
      });
      const attempt = controlStoreFor(db.sqlite).write(() => {
        markSchedulerExecutionAttemptClosing(db, { attemptId, cause: 'terminal-publication' });
        return closeSchedulerExecutionAttemptWithFence(db, {
          correlation: schedulerExecutionCorrelation(prepared),
          fenceRef: 'fence:pending-selection',
          proof: {
            terminalHandoff: true,
            output: true,
            evidence: true,
            outsideWorkspaceCollection: true,
            integrationDrain: true,
            routesRevoked: true,
          },
        });
      });
      const originPhysicalEpoch = 'e'.repeat(64);
      const imageDigest = `sha256:${'a'.repeat(64)}`;
      const target = {
        targetId: 'pending-selection-target',
        identityId: 'pending-selection-owner',
        deploymentId: 'pending-selection-deployment',
      };
      const { connectionGeneration } = writer
        .transaction(() =>
          allocateNanoHostRuntimeTargetConnectionGeneration(owner, {
            ...target,
            observedAt: createdAt,
          })
        )
        .immediate();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing discovery fixture address.');
      client = connectHttp2(`http://127.0.0.1:${address.port}`);
      client.request({ ':method': 'POST', ':path': '/' }).end();
      physicalConnection = await connected.promise;
      sessionAuthority.admit({
        connectionGeneration,
        identityId: target.identityId,
        physicalConnection,
      });
      const unused = async (): Promise<never> => {
        throw new Error('Unexpected transport route in the discovery fixture.');
      };
      const nativeStorage: AdmittedNanoHostTransportStorage = {
        owner: {
          read,
          transport: unused,
          harnessLifecycle: unused,
          async transitionRuntimeTarget(_kernel, original) {
            expect(original.retirement).toBeNull();
            expect(original.input.kind).toBe('ready');
            return {
              state: 'ready',
              value: writer
                .transaction(() => mutateNanoHostRuntimeTarget(owner, original.input))
                .immediate(),
            };
          },
        },
        kernel: {
          reserveHolderIntent: unused,
          fenceNanoHostEpoch: unused,
          inspectNanoHostEpochFence: unused,
        },
      };
      await dispatch.readiness!(
        physicalConnection,
        Buffer.from(JSON.stringify({ physicalEpoch: originPhysicalEpoch })),
        { ...target, coreDb: db, nativeStorage }
      );
      const sandboxCompatibilityKey = 'b'.repeat(64);
      const sandboxId = `nh-${sandboxCompatibilityKey.slice(0, 16)}`;
      const identity = {
        agentSessionId,
        backendKind: 'openshell' as const,
        backendSessionId: `${sandboxId}-${'c'.repeat(16)}`,
        deploymentId: target.deploymentId,
        packageSnapshotId,
        runtimeTargetId: target.targetId,
        stagingDirectoryRef: `server/runtime/worker-backend-sessions/${packageSnapshotId}`,
        transientProviderInstanceId: null,
      };
      const authored = {
        authoredArtifactId: testEntityId('ar', 'discovery-image'),
        authoredArtifactVersion: 1 as const,
        authoredContentDigest: commandInputHash({ imageDigest }),
        inputDigest: commandInputHash({ imageDigest }),
      };
      writer
        .transaction(() => {
          insertWorkerImageSettlementInTransaction(owner, {
            ...authored,
            requestId: 'd'.repeat(64),
            operation: 'image.acquire',
            outcome: { kind: 'success', imageDigest },
          });
          admitWorkerImageEnvironment(owner, authored, {
            imageDigest,
            defaultsDigest: commandInputHash({}),
            values: {},
          });
          createNanoHostHarnessRuntime(owner, {
            adapterId: 'codex',
            adapterVersion: 'fixture',
            harnessBindingRef: 'harness-binding:pending-selection',
            harnessCompatibilityKey: 'f'.repeat(64),
            harnessInstanceId: 'harness:pending-selection',
            imageDigest,
            originPhysicalEpoch,
            runtimeTargetId: identity.runtimeTargetId,
            sandboxBindingRef,
            sandboxCompatibilityKey,
            sandboxIntegrationBindingRef: 'integration-binding:pending-selection',
            sandboxRuntimeId: 'sandbox:pending-selection',
            timestamp: createdAt,
          });
          // The fixture begins with an original backend session emitted by materialization.
          // Its subsequent selection reads the actual admitted record through the owner codec.
          writer
            .prepare(`INSERT INTO worker_backend_sessions (
          attempt_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
          backend_kind, deployment_id, backend_version, backend_session_id, runtime_target_id,
          origin_physical_epoch, backend_lineage_json, sandbox_binding_ref, staging_directory_ref,
          workspace_handoff_state, state, created_at, updated_at
        ) VALUES (
          @attemptId, @workspaceId, @threadId, @turnId, @agentSessionId, @packageSnapshotId,
          @backendKind, @deploymentId, 'fixture', @backendSessionId, @runtimeTargetId,
          @originPhysicalEpoch, @backendLineage, @sandboxBindingRef, @stagingDirectoryRef,
          'complete', 'cleanup-pending', @createdAt, @createdAt
        )`)
            .run({
              ...identity,
              attemptId,
              workspaceId: entry.workspaceId,
              threadId: entry.threadId,
              turnId: entry.turnId,
              originPhysicalEpoch,
              backendLineage: JSON.stringify({ imageRef: imageDigest }),
              sandboxBindingRef,
              createdAt,
            });
        })
        .immediate();
      writer
        .transaction(() => {
          drainNanoHostSandboxAdmission(owner, { sandboxBindingRef, originPhysicalEpoch });
        })
        .immediate();
      expect(
        read((sqlite) => readWorkerImageSettlement({ sqlite }, 'd'.repeat(64))).value
      ).toMatchObject({ outcome: { kind: 'success', imageDigest } });

      const reader = createExecutionStepJournalReader(db, { kind: 'server' });
      const post = (operation: 'bridge.close' | 'sandbox.delete', index: number) => {
        const request = createNanoHostEffectRequest(identity, attemptId, operation, { sandboxId });
        const requestId = request.requestId!;
        const draft = discoveryIntent(index);
        const execution = {
          owner: { kind: 'server' as const },
          executionId: `idle-cleanup:${requestId}`,
        };
        const intent: ExecutionJournalIntent = {
          ...draft,
          execution: { ...draft.execution, ref: execution, workId: requestId },
          stepId: `effect:${requestId}`,
          carriage: { operation, requestId, sequence: null, bindingRef: sandboxBindingRef },
          control: {
            ...draft.control,
            workId: requestId,
            operationId: requestId,
            attemptId,
            invocationId: `effect:${requestId}`,
            actor: entry.triggerActor,
            target: {
              backendKind: identity.backendKind,
              targetId: identity.runtimeTargetId,
              allocationRef: sandboxBindingRef,
            },
            authorityRefs: [sandboxBindingRef],
            physicalFenceRefs: [originPhysicalEpoch],
            deadlineUnixNano: draft.span.startTimeUnixNano + 300_000_000_000n,
          },
        };
        const pending = dispatch.effect({
          ...request,
          async beforeDelivery() {
            controlStoreFor(db.sqlite).write(() => {
              expect(requireSchedulerExecutionAttempt(db, attemptId)).toEqual(attempt);
              expect(nanoHost.readBackendSession({ attemptId })).toMatchObject({
                state: 'ready',
                value: { ...identity, attemptId, originPhysicalEpoch },
              });
              expect(nanoHost.readResident(sandboxBindingRef)).toEqual({
                state: 'ready',
                value: {
                  binding: sandboxBindingRef,
                  origin: originPhysicalEpoch,
                  target: identity.runtimeTargetId,
                  drain: 'draining',
                },
              });
              writeExecutionJournalIntent(db, intent, executionJournalProcessWitness());
            });
          },
          async consumeResult(result) {
            expect(result).toEqual({ sandboxId, state: 'closed' });
            controlStoreFor(db.sqlite).write(() =>
              settleCoreIdleJournal(
                db,
                intent,
                'completed',
                commandInputHash(result),
                executionJournalProcessWitness()
              )
            );
          },
        });
        return { pending, requestId, ref: { execution, stepId: intent.stepId } };
      };
      const bridge = post('bridge.close', 1000);
      const bridgeCommand = await dispatch.poll(physicalConnection, 'bridge.close');
      expect(bridgeCommand).toMatchObject({ requestId: bridge.requestId, sandboxId });
      await dispatch.result(physicalConnection, 'bridge.close', {
        requestId: bridge.requestId,
        sandboxId,
        state: 'closed',
      });
      await expect(bridge.pending).resolves.toEqual({ sandboxId, state: 'closed' });
      const root = await reader.readExecution(bridge.ref.execution);
      const completed = await reader.readInvocation(bridge.ref);
      expect(root.phase).toBe('closed');
      expect(completed.state).toBe('completed');
      expect(
        (await reader.readLinkedInspections(bridge.ref)).some(
          ({ inspection }) =>
            inspection.state === 'completed' && inspection.control.kind === 'consume-receipt'
        )
      ).toBe(true);
      const anchor = nanoHost.readBackendSession({ attemptId });
      if (anchor.state !== 'ready' || !anchor.value)
        throw new Error('Missing admitted backend session.');
      expect(hasIdleCleanupExecution(db, anchor.value)).toBe(true);

      // Disallow only the original delete intent before the dispatcher can deliver a second effect.
      db.sqlite.exec(`CREATE TRIGGER reject_discovery_delete_intent
        BEFORE INSERT ON control_execution_steps
        WHEN json_extract(NEW.invocation_json, '$.carriage.operation') = 'sandbox.delete'
        BEGIN SELECT RAISE(ABORT, 'injected discovery pre-delete cut'); END`);
      const deletion = post('sandbox.delete', 1001);
      const rejected = expect(deletion.pending).rejects.toThrow(
        'injected discovery pre-delete cut'
      );
      await expect(dispatch.poll(physicalConnection, 'sandbox.delete')).rejects.toThrow(
        'injected discovery pre-delete cut'
      );
      await rejected;
      expect(await dispatch.poll(physicalConnection, 'sandbox.delete')).toBeNull();
      db.sqlite.exec('DROP TRIGGER reject_discovery_delete_intent');

      // Journal primitives model retired storage history only, never accepted Native authority.
      const historical = [];
      for (let index = 1; index <= 160; index += 1) {
        const intent = discoveryIntent(index);
        const original = controlStoreFor(db.sqlite).write(() =>
          writeExecutionJournalIntent(db, intent)
        );
        const historicalRoot = await reader.readExecution(original.ref.execution);
        controlStoreFor(db.sqlite).write(() =>
          settleExecutionJournalStep(db, {
            ref: original.ref,
            expectedExecutionRevision: historicalRoot.revision,
            state: 'completed',
            outputRefs: [],
            span: {
              ...intent.span,
              endTimeUnixNano: intent.span.startTimeUnixNano + 1n,
              status: { code: 'OK' },
            },
            nextPhase: 'closed',
            terminalCause: null,
            exclusionRefs: [],
          })
        );
        historical.push(original.ref);
      }
      const poisoned = historical[0]!;
      // A missing original is unreadable without disabling immutable-outcome or JSON guards.
      const missing = db.sqlite
        .prepare('DELETE FROM control_execution_steps WHERE execution_id = ? AND step_id = ?')
        .run(poisoned.execution.executionId, poisoned.stepId);
      expect(missing.changes).toBe(1);
      await expect(reader.readInvocation(poisoned)).rejects.toThrow();
      expect((await reader.readExecution(poisoned.execution)).phase).toBe('closed');

      // DX Global Dispatch and Physical Receipt Consumption: select current draining work only.
      await expect(reconciler.runOnce()).resolves.toBeUndefined();
      expect(advanceIdleCleanup).toHaveBeenCalledExactlyOnceWith({
        candidate: { ref: bridge.ref, revision: root.revision },
        identity,
        action: 'delete',
        originPhysicalEpoch,
        sandboxBindingRef,
      });
      expect(await reader.readInvocation(bridge.ref)).toEqual(completed);
      expect(hasIdleCleanupExecution(db, anchor.value)).toBe(true);
      expect(store.getTurnById(entry.turnId)).toEqual(originalTurn);
      expect(requireSchedulerExecutionAttempt(db, attemptId)).toEqual(attempt);
      expect(await dispatch.poll(physicalConnection, 'bridge.close')).toBeNull();
      expect(await dispatch.poll(physicalConnection, 'sandbox.delete')).toBeNull();
    } finally {
      await reconciler.stop();
      if (physicalConnection) await sessionAuthority.closePhysicalConnection(physicalConnection);
      client?.destroy();
      if (server.listening) {
        const closed = once(server, 'close');
        server.close();
        await closed;
      }
      await shutdownControlStoreWorkerClient();
      readerDb.close();
      writer.close();
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
