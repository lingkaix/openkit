import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import {
  allocateEntityId,
  RequestIdSchema,
  workspaceIdForOwner,
  writeRetainedV1,
} from '@openkit/protocol';
import {
  buildWorkerCanonicalTerminalEventRecord,
  type WorkerLineage,
  type WorkerRuntimeNativeOriginIndexEntry,
  WorkerRuntimeNativeOriginIndexEntrySchema,
  WorkerRuntimeRawStreamManifestSchema,
} from '@openkit/worker-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultWorkerControlGateway } from '../app.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { GatewayUnsupportedFeatureError } from '../llm/pi-ai-client.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from '../mode-entry-routes.js';
import { OperationError } from '../operation-error.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import {
  ControlStoreWorkerError,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { publishImmutableProductJson } from '../storage/immutable-content.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  recordAgentEnvironmentPackageSnapshot,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';
import { requireSchedulerExecutionAttempt } from './execution-attempt-records.js';
import { commandInputHash } from './idempotent-command.js';
import {
  dispatchNanoHostHarnessOperation,
  settleNanoHostHarnessOperation,
} from './nanohost-harness-records.js';
import type { NanoHostSessionEffectRequest } from './nanohost-session-dispatch.js';
import { createConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import {
  getWorkerCheckpoint,
  listRecoverableWorkerCheckpoints,
  upsertWorkerCheckpoint,
} from './worker-checkpoints.js';
import * as workerControlRecords from './worker-control-records.js';
import {
  classifyClosedWorkerApprovalGate,
  clearWorkerCheckpointAfterTerminalState,
  recoverWorkerCheckpointStopReason,
} from './worker-recovery.js';
import { importWorkerRuntimeProvenance } from './worker-runtime-provenance.js';

/**
 * Runs the real native Worker owners against one fixed-effect receiver double.
 * @param outcome Original decided Worker outcome.
 * @param retained Whether the receiver proves a reusable native binding.
 * @param options Native terminal fault and publication-order interventions.
 * @returns Original admitted package, released attempt, retained products and cleanup.
 */
async function createCheckpointCloseoutFixture(
  outcome: 'failed' | 'completed' | 'interrupted',
  retained = true,
  options: {
    readonly repairSessionPublication?: boolean;
    readonly executionPublication?: 'before-closeout' | 'before-terminal';
    readonly requestId?: string;
  } = {}
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-checkpoint-closeout-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId,
  });
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  applyScopedMigrations(workspaceDb);
  recordTestNativeRuntimeTarget(coreDb);
  const setup = createTestAgentSetup({ requiredCapabilities: ['trusted-worker-inference-relay'] });
  admitTestNativeEnvironment(coreDb, setup.manifest);
  const requestId = options.requestId ?? '00000000-0000-4000-8000-000000000501';
  const input = 'Recover exact worker closeout';
  const turnId = allocateEntityId('tu');
  const threadId = 'th_00000000-0000-7000-8000-000000000001';
  const inputHash = commandInputHash({ requestId, workspaceId, threadId, input });
  const scope = {
    actorId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId,
    threadId,
  };
  const createdAt = new Date().toISOString();
  const turn = await store.createTurn(
    workspaceId,
    threadId,
    input,
    {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    },
    null,
    {
      turnId,
      // Retained runtime correlation does not assert a current public command receipt.
      ...(RequestIdSchema.safeParse(requestId).success
        ? {
            commandReceipt: {
              key: commandRequestKey('conversation.submit', requestId, scope),
              command: 'conversation.submit',
              requestId,
              scope,
              inputHash: inputHash,
              responseKind: 'turn',
              createdAt,
              expiresAt: commandRequestExpiresAt(createdAt),
            },
            commandReceiptResponse: {
              kind: 'turn',
              id: turnId,
              conversationMetadata: {
                targetRef: 'new-task-worker',
                logicalModelId: null,
                receivingWorkspaceId: workspaceId,
                receivingThreadId: threadId,
                downstream: { kind: 'task', turnId },
                resultKind: 'worker-turn',
                status: 202,
              },
            },
          }
        : {}),
    }
  );
  await store.updateTurn(turn.id, { agentId: setup.manifest.id });
  const agentSessionId = 'as_00000000-0000-73c3-bedd-d6971f391e97';
  const attemptId = testEntityId('attempt', `checkpoint:${turn.id}`);
  const snapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
  const bindingRef = `binding:${turn.id}`;
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: 'queue_checkpoint_closeout',
    requestId,
    triggerActor: turn.triggerActor,
    requestedAgentId: setup.manifest.id,
    workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    turnInput: input,
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId,
    agentSessionId,
    inputRef: snapshotId,
    bindingRef,
    sessionCompatibilityKey: 'fixture-compatibility',
    now: () => new Date().toISOString(),
  });
  const gateway = createDefaultWorkerControlGateway(coreDb);
  const lineage = {
    workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    agentSessionId,
    packageSnapshotId: snapshotId,
    requestId,
  };
  const commit = 'e'.repeat(40);
  const peerProcessKey = randomBytes(32);
  let terminalRecord: ReturnType<typeof buildWorkerCanonicalTerminalEventRecord> | undefined;
  let finalWaitEntered = false;
  let signalFinalWait!: () => void;
  const finalWaitReady = new Promise<void>((resolve) => {
    signalFinalWait = resolve;
  });
  const waitForFinalStatus = workerControlRecords.waitForWorkerControlFinalStatus;
  const observingFinalWait = vi
    .spyOn(workerControlRecords, 'waitForWorkerControlFinalStatus')
    .mockImplementation((...args) => {
      finalWaitEntered = true;
      signalFinalWait();
      return waitForFinalStatus(...args);
    });
  const runtime = createConfiguredWorkerLifecycleRuntime({
    fileAdmission: new FileStorageAdmission(dataRoot, () => 0n),
    readRuntimeConfig: () => loadRuntimeConfig(dataRoot),
    coreDb,
    store,
    env: {},
    workerControlGateway: gateway,
    nanoHostSessionDispatch: {
      async effect(first, second) {
        const request = second ?? (first as NanoHostSessionEffectRequest);
        switch (request.kind) {
          case 'image.acquire':
            return { digest: `sha256:${'a'.repeat(64)}` };
          case 'image.inspect':
            return {
              digest: request.input.imageDigest,
              environmentDefaults: {
                defaultsDigest:
                  'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
                values: {},
              },
              platform: { architecture: 'amd64', os: 'linux' },
              storageLayout: {
                family: 'openkit-worker',
                uid: 1000,
                gid: 1000,
                version: '1',
                workingDirectory: '/tmp/openkit-bootstrap',
                targets: [
                  { target: '/openkit/threads' },
                  { target: '/sandbox' },
                  { target: '/workspace' },
                ],
              },
            };
          case 'sandbox.create': {
            const storage = request.input.storage as { targets: readonly object[] };
            return {
              sandboxId: request.input.sandboxId,
              state: 'created',
              storage: {
                ...storage,
                targets: storage.targets.map((target) => ({ ...target, initialized: true })),
              },
            };
          }
          case 'bridge.open':
            return { accepted: true, integrationReady: true, state: 'open' };
          case 'reference.import':
            return { state: 'imported' };
          case 'workspace.collect':
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
          case 'file.export': {
            if (!terminalRecord)
              throw new Error('Transcript export preceded accepted terminal evidence.');
            const bytes = Buffer.from(
              String(request.input.relativePath).endsWith('events.jsonl')
                ? `${JSON.stringify(terminalRecord)}\n`
                : ''
            );
            // The collector removes the complete private parent directory after consumption.
            const stagingPath = join(mkdtempSync(join(dataRoot, 'receiver-export-')), 'content');
            writeFileSync(stagingPath, bytes);
            return { stagingPath, byteLength: bytes.length, sha256: runtimeSha256(bytes) };
          }
          case 'bridge.close':
          case 'sandbox.delete':
            return { state: 'deleted' };
          default:
            throw new Error(`Unexpected receiver effect ${request.kind}.`);
        }
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected receiver route.');
      },
    },
  });
  const complete = store.completeTurn.bind(store);
  let publicationStart = 0;
  let terminalFaultObserved = false;
  let retainedTerminal: { path: string; bytes: Buffer } | undefined;
  const publishing = vi
    .spyOn(store, 'completeTurn')
    .mockImplementation(async (id, patch, publication) => {
      if (id !== turn.id || publicationStart) return complete(id, patch, publication);
      publicationStart = (store.getTurnEvents(id).at(-1)?.sequence ?? 0) + 1;
      const busy = store.getAgentSession(agentSessionId);
      const event = {
        event: 'agent.session.updated' as const,
        data: { type: 'agent-session-updated' as const, agentSession: busy },
        requestId,
        workspaceId,
        threadId: turn.threadId,
        turnId: id,
      };
      if (options.executionPublication === 'before-closeout') {
        const acknowledged = await store.persistTurnEvent(id, event);
        store.emitTurnEvent(id, acknowledged);
      }
      if (options.executionPublication === 'before-terminal') {
        publication = {
          ...publication,
          precedingEvents: [...(publication?.precedingEvents ?? []), event],
        };
      }
      if (options.repairSessionPublication) {
        // Capture every committed row, including revisions, receipts, Audit and execution steps.
        const committedTuple = () =>
          JSON.stringify({
            turn: store.getTurnById(id),
            session: store.getAgentSession(agentSessionId),
            events: store.getTurnEvents(id),
            databases: [workspaceDb, coreDb].map((db) =>
              (
                db.sqlite
                  .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                  )
                  .all() as { name: string }[]
              ).map(({ name }) => ({
                name,
                rows: db.sqlite
                  .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
                  .all()
                  .map((row) => JSON.stringify(row))
                  .sort(),
              }))
            ),
          });
        const before = committedTuple();
        const trigger = `CREATE TRIGGER fixture_terminal_refusal BEFORE UPDATE ON control_turns WHEN NEW.id = '${id}' AND NEW.status IN ('completed','failed','interrupted') BEGIN SELECT RAISE(ABORT, 'fixture-terminal-refusal'); END`;
        workspaceDb.sqlite.exec(trigger);
        const installedTrigger = workspaceDb.sqlite.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'fixture_terminal_refusal'"
        );
        expect(installedTrigger.get()).toEqual({ sql: trigger });
        try {
          const refused = await complete(id, patch, publication).then(
            () => {
              throw new Error('The installed terminal SQL trigger must refuse publication.');
            },
            (error: unknown) => error
          );
          expect(refused).toBeInstanceOf(ControlStoreWorkerError);
          expect(refused).toMatchObject({ code: 'constraint', commit: 'not-committed' });
          expect(committedTuple()).toBe(before);
          terminalFaultObserved = true;
        } finally {
          workspaceDb.sqlite.exec('DROP TRIGGER fixture_terminal_refusal');
        }
        expect(installedTrigger.get()).toBeUndefined();
      }
      const committed = await complete(id, patch, publication);
      if (options.repairSessionPublication) {
        const terminalEvents = store
          .getTurnEvents(id)
          .filter((entry) => entry.event === 'turn.completed');
        expect(terminalEvents).toHaveLength(1);
        expect(store.getCommandRequest('conversation.submit', requestId, scope)).toMatchObject({
          response: { kind: 'turn', id },
          inputHash: inputHash,
        });
      }
      return committed;
    });
  let done = false;
  let failure: unknown;
  let cancellation: Promise<void> | undefined;
  let finalAuthorization = '';
  const running = runtime.turnExecutor
    .startTurn(store, turn.id, input, {
      attemptId,
      agentSessionId,
      agentSetup: setup,
      requestId,
      sandboxBindingRef: bindingRef,
      triggerActor: turn.triggerActor,
      workspaceRoots: [
        {
          id: 'repo',
          access: 'read-write',
          sourceKind: 'remote-git',
          sourceCommit: commit,
          workerPath: '/workspace/openkit',
        },
      ],
      workspaceSourceRefs: { repo: 'repo' },
      workspaceDataSourceCatalog: {
        schemaVersion: 1,
        sources: [
          {
            id: 'repo',
            displayName: 'Repository',
            kind: 'git',
            locator: { commit, url: 'https://example.invalid/repo.git' },
            access: 'read-write',
            allowedSlotKinds: ['worktree'],
            sensitivity: 'internal',
            status: 'active',
          },
        ],
      },
    })
    .catch((error: unknown) => {
      failure = error;
    })
    .finally(() => {
      done = true;
    });
  try {
    const deadline = Date.now() + 25_000;
    while (!done && Date.now() < deadline) {
      const integrations = coreDb.sqlite
        .prepare('SELECT sandbox_integration_binding_ref AS ref FROM sandbox_runtime_records')
        .all() as { ref: string }[];
      for (const integration of integrations) {
        const queued = dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: integration.ref,
        });
        if (!queued) continue;
        const command = await runtime.acceptNanoHostHarnessCommand(queued);
        const native = { nativeHandleState: 'ready', nativeHandleDigest: 'c'.repeat(64) };
        const body =
          command.operation === 'session.close'
            ? { state: 'closed', privateState: 'absent', childState: 'absent' }
            : command.operation === 'session.open'
              ? {
                  state: 'open',
                  maxActiveTurns: command.body.maxActiveTurns,
                  ...native,
                  workspaceGitBaseline: {
                    commit,
                    tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  },
                }
              : command.operation === 'turn.start'
                ? { state: 'started', ...native }
                : command.operation === 'turn.interrupt'
                  ? { state: 'interrupted', childState: 'absent' }
                  : {
                      state: retained || outcome === 'completed' ? 'open' : 'failed',
                      childState: 'absent',
                      cleanupState: 'clean',
                      ...native,
                    };
        const result = {
          disposition: 'succeeded' as const,
          body,
          harnessInstanceId: command.harnessInstanceId,
          operationId: command.operationId,
          schemaVersion: 2 as const,
          sequence: command.sequence,
        };
        settleNanoHostHarnessOperation(coreDb, {
          result,
          sandboxIntegrationBindingRef: integration.ref,
          timestamp: new Date().toISOString(),
        });
        await runtime.acceptNanoHostHarnessResult(result);
        if (command.operation === 'turn.start') {
          // The real final waiter follows native deliver-start and delivery-prove ACKs.
          await Promise.race([
            finalWaitReady,
            running,
            delay(Math.max(1, deadline - Date.now()), undefined, { ref: false }),
          ]);
          if (failure) throw failure;
          expect(finalWaitEntered).toBe(true);
          const authorization = `Bearer ${command.body.workerControlToken}`;
          finalAuthorization = authorization;
          gateway.recordHeartbeat({
            authorization,
            lineage,
            schemaVersion: 2,
            sequence: 0,
            operation: 'heartbeat',
            body: {
              status: 'starting',
              message: null,
              processKeyHash: createHash('sha256').update(peerProcessKey).digest('base64url'),
            },
          });
          if (outcome === 'failed') {
            const app = createApp({
              coreDb,
              store,
              turnExecutor: runtime.turnExecutor,
              workerControlGateway: gateway,
              llmGatewayDispatcher: {
                async createResponses(
                  ...args: Parameters<LLMGatewayProviderDispatcher['createResponses']>
                ) {
                  const source = args[2]!.transport!.rawOutput!;
                  // The modeled upstream settles its error frame before Gateway closeout.
                  const settled = source.sourceStarted();
                  source.sourceEvent();
                  settled();
                  throw new GatewayUnsupportedFeatureError('Modeled receiver refusal.');
                },
              } as unknown as LLMGatewayProviderDispatcher,
            });
            const refusal = await app.request('/api/worker-inference/v1/responses', {
              method: 'POST',
              headers: {
                authorization: `Bearer ${command.body.inferenceToken}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ model: setup.logicalModels.preferredLogicalModelId, input }),
            });
            expect(refusal.status).toBe(400);
            expect(await refusal.json()).toMatchObject({
              error: { code: 'unsupported_gateway_feature' },
            });
          }
          if (outcome === 'interrupted') {
            cancellation = runtime.turnExecutor.interruptTurn!(store, turn.id, { requestId });
            continue;
          }
        }
        // An interrupted final follows the actual dispatched and accepted interrupt result.
        if (command.operation === 'turn.start' || command.operation === 'turn.interrupt') {
          const status =
            outcome === 'completed' ? 'completed' : outcome === 'failed' ? 'failed' : 'interrupted';
          const stopReason =
            outcome === 'completed' ? 'completed' : outcome === 'failed' ? 'error' : 'aborted';
          terminalRecord = buildWorkerCanonicalTerminalEventRecord({
            lineage,
            sequence: 1,
            data: { status, stopReason, evidenceManifestDigests: {} },
          });
          gateway.recordFinalStatus({
            authorization: finalAuthorization,
            lineage,
            sequence: 1,
            status,
            stopReason,
          });
        }
      }
      if (!done) await Promise.race([running, delay(1)]);
    }
    expect(done, 'Native Worker lifecycle must settle inside the existing test bound.').toBe(true);
    await running;
    await cancellation;
    if (failure) throw failure;
    expect(terminalFaultObserved).toBe(Boolean(options.repairSessionPublication));
    expect(publicationStart).toBeGreaterThan(0);
  } finally {
    publishing.mockRestore();
    observingFinalWait.mockRestore();
  }
  const attempt = requireSchedulerExecutionAttempt(coreDb, attemptId);
  expect(attempt).toMatchObject({ phase: 'closed', fenceRef: expect.any(String) });
  const environmentPackage = requireAgentEnvironmentPackageSnapshot(
    workspaceDb,
    workspaceId,
    snapshotId
  ).snapshot;
  const checkpoint = await upsertWorkerCheckpoint(workspaceDb, {
    workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    workerSessionId: agentSessionId,
    requestId,
    requestInputHash: inputHash,
    iteration: 0,
    stage:
      outcome === 'failed' ? 'failed' : outcome === 'interrupted' ? 'aborted' : 'running_worker',
    stopReason: outcome === 'failed' ? 'error' : outcome === 'interrupted' ? 'aborted' : null,
  });
  if (options.repairSessionPublication) {
    // A stopped retained repair is separate from the real atomic fault/retry above.
    // Preserve terminal bytes and actual release; only historical Session projections move.
    const events = store.getTurnEvents(turn.id);
    const terminal = events.find((event) => event.data.type === 'turn-completed')!;
    const closeout = events.findLast((event) => event.data.type === 'agent-session-updated')!;
    const busy = events.findLast(
      (event) =>
        event.sequence < publicationStart &&
        event.data.type === 'agent-session-updated' &&
        event.data.agentSession.status === 'busy'
    );
    if (!busy || closeout.data.type !== 'agent-session-updated')
      throw new Error('Retained repair requires actual busy and decided Session observations.');
    const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId });
    const terminalEntry = workspaceDb.sqlite.prepare(
      "SELECT * FROM control_product_entries WHERE kind = 'event' AND turn_id = ? AND sequence = ?"
    );
    const descriptor = terminalEntry.get(turn.id, terminal.sequence) as { content_json: string };
    const path = join(
      scope.contentMount.root,
      JSON.parse(descriptor.content_json).reference.locator.path
    );
    const bytes = readFileSync(path);
    retainedTerminal = { path, bytes };
    await shutdownControlStoreWorkerClient();
    for (const event of [
      { ...busy, sequence: closeout.sequence },
      { ...closeout, sequence: terminal.sequence + 1 },
    ]) {
      const content = await publishImmutableProductJson(
        scope.contentMount,
        scope.owner,
        join(dataRoot, 'fixture-staging'),
        writeRetainedV1(event)
      );
      workspaceDb.sqlite
        .prepare(
          "INSERT INTO control_product_entries (kind,turn_id,sequence,id,revision,schema_version,content_json,identity_json) VALUES ('event',?,?,?,1,1,?,?) ON CONFLICT(kind,turn_id,sequence) DO UPDATE SET content_json = excluded.content_json"
        )
        .run(
          turn.id,
          event.sequence,
          `${turn.id}:${event.sequence}`,
          JSON.stringify(content),
          JSON.stringify({ threadId: turn.threadId, turnId: turn.id })
        );
    }
    expect(terminalEntry.get(turn.id, terminal.sequence)).toEqual(descriptor);
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(store.getTurnEvents(turn.id).find((event) => event.event === 'turn.completed')).toEqual(
      terminal
    );
    expect(store.getTurnEvents(turn.id).at(-1)?.data).toEqual(closeout.data);
  }
  return {
    coreDb,
    workspaceDb,
    store,
    checkpoint,
    attempt,
    environmentPackage,
    agentSessionId,
    publicationStart,
    retainedTerminal,
    closeoutEvents: (reader = store) =>
      reader.getTurnEvents(turn.id).filter((event) => event.sequence >= publicationStart),
    close: async () => {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    },
  };
}

/** Verifies the original native admission receipt required by conversation checkpoint recovery. */
async function verifyCloseoutConversationReceipt(
  f: Awaited<ReturnType<typeof createCheckpointCloseoutFixture>>
): Promise<void> {
  const { checkpoint, store } = f;
  expect(
    store.getCommandRequest('conversation.submit', checkpoint.requestId, {
      actorId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: checkpoint.workspaceId,
      threadId: checkpoint.threadId,
    })
  ).toMatchObject({
    command: 'conversation.submit',
    requestId: checkpoint.requestId,
    inputHash: checkpoint.requestInputHash,
    scope: {
      actorId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: checkpoint.workspaceId,
      threadId: checkpoint.threadId,
    },
    response: {
      kind: 'turn',
      id: checkpoint.turnId,
      conversationMetadata: {
        targetRef: 'new-task-worker',
        logicalModelId: null,
        receivingWorkspaceId: checkpoint.workspaceId,
        receivingThreadId: checkpoint.threadId,
        downstream: { kind: 'task', turnId: checkpoint.turnId },
        resultKind: 'worker-turn',
        status: 202,
      },
    },
  });
}

/**
 * Opens a migrated workspace database for worker recovery tests.
 *
 * @returns Migrated workspace database handle after native scope acknowledgement.
 */
async function createWorkspaceDb(): Promise<WorkspaceDb> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-recovery-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  applyScopedMigrations(workspaceDb);
  await openTestNativeWorkspace(workspaceDb);
  return workspaceDb;
}

/**
 * Creates one exact runtime stream and matching native-origin row.
 *
 * @param lineage Authoritative outer worker lineage.
 * @param streamRef Safe synthetic stream reference.
 * @param sourceKind Primary or runtime-thread stream class.
 * @param record Exact pinned Codex JSON frame.
 * @param origin Restricted native-origin fields for the frame.
 * @returns Exact bytes, manifest row, and native-origin index row.
 */
function createRecoveryRuntimeStream(
  lineage: WorkerLineage,
  streamRef: string,
  sourceKind: 'primary' | 'runtime-thread',
  record: Record<string, unknown>,
  origin: Partial<WorkerRuntimeNativeOriginIndexEntry>
) {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  const entry = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
    adapterVersion: '0.153.4',
    byteLength: bytes.byteLength,
    byteOffset: 0,
    eventKind: record.type,
    frameSequence: 0,
    frameSha256: runtimeSha256(bytes),
    lineage,
    ...origin,
    parseStatus: 'parsed',
    runtimeFamily: 'codex',
    schemaVersion: 1,
    streamRef,
  });
  return {
    bytes,
    entry,
    manifest: {
      bytes: bytes.byteLength,
      captureStatus: 'complete' as const,
      frameCount: 1,
      sha256: runtimeSha256(bytes),
      sourceKind,
      stableTerminal: true,
      streamRef,
    },
  };
}

/**
 * Imports one minimal valid retained runtime forest for checkpoint recovery tests.
 *
 * @param workspaceDb Workspace database that owns the retained provenance.
 * @returns Outer turn id plus stable raw evidence paths and original stream bytes.
 */
async function createRetainedRecoveryProvenance(workspaceDb: WorkspaceDb) {
  const store = await createDemoStore();
  const turn = await store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Recover retained runtime provenance',
    {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    }
  );
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup({
        requiredCapabilities: ['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'],
      }),
      agentSessionId: 'as_00000000-0000-7463-af29-ca2c8a8a0308',
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-13T00:00:00.000Z',
      requestId: 'req_recovery_provenance',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0' },
      turn,
      turnInput: 'Recover retained runtime provenance',
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    })
  );
  recordAgentEnvironmentPackageSnapshot(workspaceDb, {
    createdAt: '2026-07-13T00:00:01.000Z',
    environmentPackage,
  });
  const lineage: WorkerLineage = {
    agentSessionId: environmentPackage.scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: environmentPackage.scope.requestId ?? null,
    threadId: environmentPackage.scope.threadId,
    turnId: environmentPackage.scope.turnId,
    workspaceId: environmentPackage.scope.workspaceId,
  };
  const nativeThreadId = '019f0000-0000-7000-8000-000000000101';
  const nativeSessionId = '019f0000-0000-7000-8000-000000000110';
  const streams = [
    createRecoveryRuntimeStream(
      lineage,
      'stream-0000.jsonl',
      'primary',
      { thread_id: nativeThreadId, type: 'thread.started' },
      { nativeThreadId }
    ),
    createRecoveryRuntimeStream(
      lineage,
      'stream-0001.jsonl',
      'runtime-thread',
      {
        payload: {
          cwd: '/private/runtime-provenance',
          id: nativeThreadId,
          session_id: nativeSessionId,
          source: 'exec',
          timestamp: '2026-07-13T00:00:00.000Z',
        },
        timestamp: '2026-07-13T00:00:00.000Z',
        type: 'session_meta',
      },
      { nativeSessionId, nativeThreadId }
    ),
  ];
  const captureRoot = mkdtempSync(join(tmpdir(), 'openkit-recovery-provenance-capture-'));
  const rawStreamsRoot = join(captureRoot, 'raw');
  const streamManifestPath = join(captureRoot, 'raw-streams.json');
  const nativeOriginIndexPath = join(captureRoot, 'native-origin-index.jsonl');
  const manifest = WorkerRuntimeRawStreamManifestSchema.parse({
    adapterVersion: '0.153.4',
    captureStatus: 'complete',
    lineage,
    primaryStreamRef: 'stream-0000.jsonl',
    runtimeFamily: 'codex',
    schemaVersion: 1,
    streams: streams.map((stream) => stream.manifest),
  });
  mkdirSync(rawStreamsRoot, { recursive: true });
  writeFileSync(streamManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    nativeOriginIndexPath,
    `${streams.map((stream) => JSON.stringify(stream.entry)).join('\n')}\n`
  );
  for (const stream of streams) {
    writeFileSync(join(rawStreamsRoot, stream.manifest.streamRef), stream.bytes);
  }
  const workspaceRoot = join(workspaceDb.dataRoot, 'workspaces', workspaceDb.workspaceId);
  const imported = await importWorkerRuntimeProvenance({
    backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
    capture: { nativeOriginIndexPath, rawStreamsRoot, streamManifestPath },
    collectedAt: '2026-07-13T00:00:02.000Z',
    environmentPackage,
    workspaceDb,
    workspaceRoot,
  });
  expect(imported.complete).toBe(true);
  const stableStreamPath = join(
    workspaceRoot,
    'evidence',
    'backend',
    imported.rawBundleId,
    'raw',
    streams[0].manifest.streamRef
  );
  return {
    agentSessionId: environmentPackage.scope.agentSessionId,
    stableStreamBytes: streams[0].bytes,
    stableStreamPath,
    turnId: turn.id,
  };
}

/** Computes the canonical prefixed SHA-256 digest for retained runtime bytes. */
function runtimeSha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('worker recovery materialization', () => {
  it.each([
    ['advanced pointer', 'completed', 'completed'],
    ['absent current pointer', 'completed', 'completed'],
    ['advanced pointer', 'failed', 'error'],
    ['absent current pointer', 'failed', 'error'],
    [
      'missing original package',
      'completed',
      'Worker checkpoint is missing its environment package.',
    ],
    [
      'corrupt original package',
      'completed',
      'Worker checkpoint is missing its environment package.',
    ],
    [
      'foreign attempt package',
      'completed',
      'Worker environment package contradicts its checkpoint lineage.',
    ],
    [
      'absent attempt package',
      'completed',
      'Worker environment package contradicts its checkpoint lineage.',
    ],
  ] as const)('resolves historical attempt lineage with %s after %s', async (scenario, outcome, expected) => {
    const f = await createCheckpointCloseoutFixture(outcome);
    try {
      const turn = await f.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Later package',
        {
          kind: 'user',
          id: 'usr_00000000-0000-7000-8000-000000000001',
        }
      );
      // This stopped import supplies only competing retained-package selection history.
      // It claims no later native execution, terminal publication or release proof.
      await shutdownControlStoreWorkerClient();
      const retainedTurn = {
        ...turn,
        agentId: 'agent_codex_host',
        agentSessionId: f.agentSessionId,
        status: 'completed' as const,
      };
      const retainedRow = f.workspaceDb.sqlite
        .prepare('SELECT record_json FROM control_turns WHERE id = ?')
        .get(turn.id) as { record_json: string };
      f.workspaceDb.sqlite
        .prepare(
          'UPDATE control_turns SET status = ?, agent_session_id = ?, record_json = ?, revision = revision + 1 WHERE id = ?'
        )
        .run(
          retainedTurn.status,
          f.agentSessionId,
          JSON.stringify({ ...JSON.parse(retainedRow.record_json), ...retainedTurn }),
          turn.id
        );
      const environmentPackage = resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup(),
        agentSessionId: f.agentSessionId,
        backend: { kind: 'openshell' },
        createdAt: new Date().toISOString(),
        requestId: '00000000-0000-4000-8000-000000000502',
        triggerActor: turn.triggerActor,
        turn: retainedTurn,
        turnInput: 'Later package',
        workspaceRoots: [],
      });
      recordAgentEnvironmentPackageSnapshot(f.workspaceDb, {
        environmentPackage,
        createdAt: environmentPackage.createdAt,
      });
      const terminal = f.store
        .getTurnEvents(f.checkpoint.turnId)
        .find((event) => event.event === 'turn.completed')!;
      await f.store.updateAgentSession(f.agentSessionId, {
        environmentPackageSnapshotId:
          scenario === 'absent current pointer' ? null : environmentPackage.snapshotId,
        status: 'closed',
        updatedAt: new Date(Date.parse(terminal.timestamp) + 1000).toISOString(),
      });
      const originalPath = join(
        f.workspaceDb.dataRoot,
        'workspaces',
        f.checkpoint.workspaceId,
        'runtime',
        'agent-sessions',
        f.agentSessionId,
        'aep-snapshots',
        `${f.environmentPackage.snapshotId}.json`
      );
      if (scenario === 'missing original package') unlinkSync(originalPath);
      if (scenario === 'corrupt original package') writeFileSync(originalPath, '{}');
      if (scenario === 'foreign attempt package' || scenario === 'absent attempt package') {
        f.coreDb.sqlite
          .prepare('UPDATE scheduler_execution_attempts SET input_ref = ? WHERE attempt_id = ?')
          .run(
            scenario === 'absent attempt package' ? null : environmentPackage.snapshotId,
            f.attempt.attemptId
          );
      }
      const reloaded = await createDemoStore({ dataRoot: f.workspaceDb.dataRoot });
      const recover = () =>
        recoverWorkerCheckpointStopReason(f.coreDb, reloaded, f.workspaceDb, f.checkpoint);
      if (expected === 'completed' || expected === 'error') expect(recover()).toBe(expected);
      else expect(recover).toThrow(expected);
      expect(reloaded.getAgentSession(f.agentSessionId).environmentPackageSnapshotId).toBe(
        scenario === 'absent current pointer' ? null : environmentPackage.snapshotId
      );
      expect(
        getWorkerCheckpoint(
          f.workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          f.checkpoint.turnId
        )
      ).toEqual(f.checkpoint);
    } finally {
      await f.close();
    }
  });

  it('recovers Subject A: failed Turn with a live-closeout retained idle AgentSession', async () => {
    const f = await createCheckpointCloseoutFixture('failed');
    try {
      expect(f.store.getTurnById(f.checkpoint.turnId)).toMatchObject({
        status: 'failed',
        error: { code: 'unsupported_gateway_feature' },
      });
      expect(f.store.getAgentSession(f.agentSessionId).status).toBe('idle');
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toBe('error');
    } finally {
      await f.close();
    }
  });

  it('recovers Subject B: completed Turn with an AgentSession closed after its terminal event', async () => {
    const f = await createCheckpointCloseoutFixture('completed');
    try {
      const terminal = f.store
        .getTurnEvents(f.checkpoint.turnId)
        .find((event) => event.event === 'turn.completed')!;
      await f.store.updateAgentSession(f.agentSessionId, {
        status: 'closed',
        updatedAt: new Date(Date.parse(terminal.timestamp) + 1000).toISOString(),
      });
      expect(f.checkpoint).toMatchObject({ stage: 'running_worker', stopReason: null });
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toBe('completed');
    } finally {
      await f.close();
    }
  });

  it.each([
    ['failed', 'error'],
    ['completed', 'completed'],
  ] as const)('recovers %s publication repair after a real failed write and owner retry', async (outcome, stopReason) => {
    const f = await createCheckpointCloseoutFixture(outcome, false, {
      repairSessionPublication: true,
    });
    try {
      const retainedEvents = f.store.getTurnEvents(f.checkpoint.turnId);
      const descriptors = f.workspaceDb.sqlite.prepare(
        'SELECT * FROM control_product_entries WHERE turn_id = ? ORDER BY kind, sequence'
      );
      const retainedDescriptors = descriptors.all(f.checkpoint.turnId);
      expect(
        f
          .closeoutEvents()
          .map((event) => `${event.sequence - f.publicationStart + 1}:${event.event}`)
      ).toEqual(['1:agent.session.updated', '2:turn.completed', '3:agent.session.updated']);
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toBe(stopReason);
      const reloaded = await createDemoStore({ dataRoot: f.workspaceDb.dataRoot });
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, reloaded, f.workspaceDb, f.checkpoint)
      ).toBe(stopReason);
      expect(reloaded.getTurnEvents(f.checkpoint.turnId)).toEqual(retainedEvents);
      expect(descriptors.all(f.checkpoint.turnId)).toEqual(retainedDescriptors);
      expect(readFileSync(f.retainedTerminal!.path).equals(f.retainedTerminal!.bytes)).toBe(true);
    } finally {
      await f.close();
    }
  });

  it.each([
    ['repaired closeout', true, false],
    ['ordinary closeout before terminal', false, true],
    ['ordinary closeout after terminal', false, false],
  ] as const)('preserves recovery_required for a later nonterminal publication after %s', async (_scenario, repairSessionPublication, beforeTerminal) => {
    const f = await createCheckpointCloseoutFixture('completed', false, {
      repairSessionPublication,
      executionPublication: beforeTerminal ? 'before-terminal' : undefined,
    });
    try {
      const { checkpoint, store } = f;
      if (!beforeTerminal) {
        const session = store
          .getTurnEvents(checkpoint.turnId)
          .findLast((event) => event.data.type === 'agent-session-updated')!;
        if (session.data.type !== 'agent-session-updated')
          throw new Error('Missing fixture closeout publication.');
        // A live native publication correctly refuses this contradiction. Import only
        // stopped retained corruption so the cold recovery reader remains the subject.
        await shutdownControlStoreWorkerClient();
        const contradictoryEvent = {
          ...session,
          sequence: store.getTurnEvents(checkpoint.turnId).at(-1)!.sequence + 1,
          timestamp: new Date().toISOString(),
          data: {
            type: 'agent-session-updated' as const,
            agentSession: { ...session.data.agentSession, status: 'busy' as const },
          },
        };
        const scope = nativeProductScope(f.workspaceDb.dataRoot, {
          kind: 'workspace',
          workspaceId: checkpoint.workspaceId,
        });
        const content = await publishImmutableProductJson(
          scope.contentMount,
          scope.owner,
          join(f.workspaceDb.dataRoot, 'fixture-staging'),
          writeRetainedV1(contradictoryEvent)
        );
        f.workspaceDb.sqlite
          .prepare(
            "INSERT INTO control_product_entries (kind,turn_id,sequence,id,revision,schema_version,content_json,identity_json) VALUES ('event',?,?,?,1,1,?,?)"
          )
          .run(
            checkpoint.turnId,
            contradictoryEvent.sequence,
            `${checkpoint.turnId}:${contradictoryEvent.sequence}`,
            JSON.stringify(content),
            JSON.stringify({ threadId: checkpoint.threadId, turnId: checkpoint.turnId })
          );
      }
      await verifyCloseoutConversationReceipt(f);
      const cold = await createDemoStore({ dataRoot: f.workspaceDb.dataRoot });
      expect(cold.getAgentSession(f.agentSessionId).status).toBe('idle');
      expect(
        f
          .closeoutEvents(cold)
          .map((event) =>
            event.data.type === 'agent-session-updated'
              ? `${event.sequence - f.publicationStart + 1}:${event.data.agentSession.status}`
              : `${event.sequence - f.publicationStart + 1}:${event.event}`
          )
      ).toEqual(
        beforeTerminal
          ? ['1:idle', '2:busy', '3:turn.completed']
          : repairSessionPublication
            ? ['1:busy', '2:turn.completed', '3:idle', '4:busy']
            : ['1:idle', '2:turn.completed', '3:busy']
      );
      const result = await classifyDirectTaskCheckpointAfterSchedulerRecovery({
        coreDb: f.coreDb,
        workspaceDb: f.workspaceDb,
        store: cold,
        checkpoint,
      }).catch((error: Error) => error.message);
      expect({
        result,
        checkpoint: getWorkerCheckpoint(
          f.workspaceDb,
          checkpoint.workspaceId,
          checkpoint.threadId,
          checkpoint.turnId
        ),
      }).toEqual({
        result: 'Worker AgentSession publication contradicts its checkpoint lineage.',
        checkpoint,
      });
    } finally {
      await f.close();
    }
  });

  it.each([
    false,
    true,
  ])('accepts an earlier execution publication before closeout with repair=%s', async (repairSessionPublication) => {
    const f = await createCheckpointCloseoutFixture('completed', false, {
      repairSessionPublication,
      executionPublication: 'before-closeout',
    });
    try {
      const cold = await createDemoStore({ dataRoot: f.workspaceDb.dataRoot });
      expect(
        f
          .closeoutEvents(cold)
          .map((event) =>
            event.data.type === 'agent-session-updated'
              ? `${event.sequence - f.publicationStart + 1}:${event.data.agentSession.status}`
              : `${event.sequence - f.publicationStart + 1}:${event.event}`
          )
      ).toEqual(
        repairSessionPublication
          ? ['1:busy', '2:busy', '3:turn.completed', '4:idle']
          : ['1:busy', '2:idle', '3:turn.completed']
      );
      expect(recoverWorkerCheckpointStopReason(f.coreDb, cold, f.workspaceDb, f.checkpoint)).toBe(
        'completed'
      );
    } finally {
      await f.close();
    }
  });

  it.each([
    'changed completion timestamp',
    'changed message',
    'changed sandbox summary',
    'duplicate closeout publication',
    'changed terminal completion',
    'unsupported success reason',
  ] as const)('rejects an unproved reordered repair with %s', async (scenario) => {
    const f = await createCheckpointCloseoutFixture('completed', false, {
      repairSessionPublication: true,
    });
    try {
      const events = structuredClone(f.store.getTurnEvents(f.checkpoint.turnId));
      const terminal = events.find((event) => event.data.type === 'turn-completed')!;
      const session = events.findLast((event) => event.data.type === 'agent-session-updated')!;
      // The fixture already supplies valid retained repair order before this contradiction.
      if (terminal.data.type !== 'turn-completed' || session.data.type !== 'agent-session-updated')
        throw new Error('Missing repaired fixture publications.');
      switch (scenario) {
        case 'changed completion timestamp':
          session.data.agentSession.updatedAt = new Date(
            Date.parse(session.timestamp) - 1000
          ).toISOString();
          break;
        case 'changed message':
          session.data.agentSession.message = 'A different decided message.';
          break;
        case 'changed sandbox summary':
          session.data.agentSession.sandboxSummary = {
            access: 'none',
            workspaceRootRefs: [],
            summary: 'A different projection.',
          };
          break;
        case 'duplicate closeout publication':
          events.push({ ...session, sequence: session.sequence + 1 });
          break;
        case 'changed terminal completion':
          terminal.data.turn.completedAt = new Date(
            Date.parse(session.data.agentSession.updatedAt) - 1000
          ).toISOString();
          break;
        case 'unsupported success reason':
          terminal.data.stopReason = 'length';
          break;
      }
      vi.spyOn(f.store, 'getTurnEvents').mockReturnValue(events);
      expect(() =>
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toThrow('Worker AgentSession publication contradicts its checkpoint lineage.');
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  });

  // Real recovery setup shares gate CPU; exact retained identities and disposition are the oracle.
  it.each([
    'failed',
    'completed',
  ] as const)('requires recovery when both %s publications name the same wrong request', async (outcome) => {
    const f = await createCheckpointCloseoutFixture(outcome);
    try {
      const events = structuredClone(f.store.getTurnEvents(f.checkpoint.turnId));
      for (const event of events) event.requestId = '00000000-0000-4000-8000-000000000502';
      vi.spyOn(f.store, 'getTurnEvents').mockReturnValue(events);
      expect(() =>
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toThrow('Worker product terminal event contradicts its command owner.');
      await verifyCloseoutConversationReceipt(f);
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          coreDb: f.coreDb,
          store: f.store,
          workspaceDb: f.workspaceDb,
          checkpoint: f.checkpoint,
        })
      ).rejects.toThrow('Worker product terminal event contradicts its command owner.');
      expect(
        getWorkerCheckpoint(
          f.workspaceDb,
          f.checkpoint.workspaceId,
          f.checkpoint.threadId,
          f.checkpoint.turnId
        )
      ).toEqual(f.checkpoint);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  }, 60_000);

  it.each([
    'failed',
    'completed',
  ] as const)('joins %s publications to a projected non-UUID command request', async (outcome) => {
    const f = await createCheckpointCloseoutFixture(outcome, true, {
      requestId: 'req_checkpoint_closeout',
    });
    try {
      expect(f.store.getTurnEvents(f.checkpoint.turnId)[0]?.requestId).not.toBe(
        f.checkpoint.requestId
      );
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toBe(outcome === 'failed' ? 'error' : 'completed');
    } finally {
      await f.close();
    }
  });

  it('keeps ordinary completed closeout distinct from an earlier busy AgentSession publication', async () => {
    const f = await createCheckpointCloseoutFixture('completed');
    try {
      const events = structuredClone(f.store.getTurnEvents(f.checkpoint.turnId));
      const session = events.findLast((event) => event.data.type === 'agent-session-updated')!;
      if (session.data.type !== 'agent-session-updated')
        throw new Error('Missing fixture AgentSession publication.');
      session.data.agentSession.status = 'busy';
      session.data.agentSession.updatedAt = session.data.agentSession.createdAt;
      vi.spyOn(f.store, 'getTurnEvents').mockReturnValue(events);
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toBe('completed');
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  });

  it.each([
    ['failed', false, 'failed', 'error'],
    ['interrupted', false, 'interrupted', 'aborted'],
    ['interrupted', true, 'idle', 'aborted'],
    ['completed', true, 'idle', 'completed'],
  ] as const)('recovers %s closeout with retention=%s and published %s', async (outcome, retained, status, stopReason) => {
    const f = await createCheckpointCloseoutFixture(outcome, retained);
    try {
      expect(f.store.getAgentSession(f.agentSessionId).status).toBe(status);
      expect(
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, f.checkpoint)
      ).toBe(stopReason);
    } finally {
      await f.close();
    }
  });

  it.each([
    ['failed', false],
    ['completed', false],
    ['failed', true],
    ['completed', true],
  ] as const)('finishes the conversation checkpoint through its existing owner after %s closeout with publication repair=%s', async (outcome, repairSessionPublication) => {
    const f = await createCheckpointCloseoutFixture(outcome, !repairSessionPublication, {
      repairSessionPublication,
    });
    try {
      const { checkpoint, store } = f;
      const terminal = store
        .getTurnEvents(checkpoint.turnId)
        .find((event) => event.event === 'turn.completed')!;
      if (outcome === 'completed')
        await store.updateAgentSession(f.agentSessionId, {
          status: 'closed',
          updatedAt: new Date(Date.parse(terminal.timestamp) + 1000).toISOString(),
        });
      await verifyCloseoutConversationReceipt(f);
      const before = JSON.stringify({
        turn: store.getTurnById(checkpoint.turnId),
        session: store.getAgentSession(f.agentSessionId),
        events: store.getTurnEvents(checkpoint.turnId),
        attempts: f.coreDb.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').all(),
      });
      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          coreDb: f.coreDb,
          workspaceDb: f.workspaceDb,
          store,
          checkpoint,
        })
      ).resolves.toBe('complete');
      expect(
        getWorkerCheckpoint(
          f.workspaceDb,
          checkpoint.workspaceId,
          checkpoint.threadId,
          checkpoint.turnId
        )
      ).toBeNull();
      expect(listRecoverableWorkerCheckpoints(f.workspaceDb, checkpoint.workspaceId)).toEqual([]);
      expect(
        JSON.stringify({
          turn: store.getTurnById(checkpoint.turnId),
          session: store.getAgentSession(f.agentSessionId),
          events: store.getTurnEvents(checkpoint.turnId),
          attempts: f.coreDb.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').all(),
        })
      ).toBe(before);
    } finally {
      await f.close();
    }
  });

  const closeoutContradiction = 'Worker generic closeout contradicts its canonical StopReason.';
  const publicationContradiction =
    'Worker AgentSession publication contradicts its checkpoint lineage.';
  const incompleteExecution = 'Worker checkpoint has no complete execution closeout.';
  const missingTerminal = 'Worker checkpoint has no exact product terminal event.';
  it.each([
    ['Turn status disagrees', closeoutContradiction],
    ['terminal Turn status disagrees', closeoutContradiction],
    ['no terminal event', missingTerminal],
    ['duplicate terminal event', missingTerminal],
    [
      'checkpoint StopReason disagrees with terminal event',
      'Worker checkpoint contradicts its product terminal event.',
    ],
    ['attempt still open', incompleteExecution],
    ['attempt has no fence', incompleteExecution],
    ['attempt has no operation', incompleteExecution],
    ['impossible published AgentSession', closeoutContradiction],
    ['AgentSession changed before terminal', closeoutContradiction],
    ['AgentSession changed at terminal', closeoutContradiction],
    ['post-terminal publication changes the decided completion', publicationContradiction],
    ['AgentSession publication has later timestamp', publicationContradiction],
    ['AgentSession publication missing for retained failure', closeoutContradiction],
    ['AgentSession publication has wrong owner', publicationContradiction],
    ['AgentSession publication has wrong agent', publicationContradiction],
    ['AgentSession publication has wrong Thread', publicationContradiction],
    ['AgentSession publication has wrong request', publicationContradiction],
    [
      'terminal event has wrong Turn',
      'Worker product terminal event contradicts its checkpoint lineage.',
    ],
    ['checkpoint has wrong AgentSession', 'Worker checkpoint has no exact AgentSession owner.'],
    ['checkpoint has wrong request', 'Worker scheduler admission contradicts its command owner.'],
  ])('fails closed when %s', async (scenario, expectedError) => {
    const f = await createCheckpointCloseoutFixture('failed');
    const events = structuredClone(f.store.getTurnEvents(f.checkpoint.turnId));
    const terminal = events.find((event) => event.data.type === 'turn-completed')!;
    const session = events.findLast((event) => event.data.type === 'agent-session-updated')!;
    if (terminal.data.type !== 'turn-completed' || session.data.type !== 'agent-session-updated')
      throw new Error('Fixture lacks production terminal publications.');
    let checkpoint = f.checkpoint;
    try {
      switch (scenario) {
        case 'Turn status disagrees':
          vi.spyOn(f.store, 'getTurn').mockReturnValue({
            ...f.store.getTurnById(checkpoint.turnId),
            status: 'completed',
          });
          break;
        case 'terminal Turn status disagrees':
          terminal.data.turn.status = 'completed';
          break;
        case 'no terminal event':
          events.splice(events.indexOf(terminal), 1);
          break;
        case 'duplicate terminal event':
          events.push(structuredClone(terminal));
          break;
        case 'checkpoint StopReason disagrees with terminal event':
          checkpoint = { ...checkpoint, stage: 'aborted', stopReason: 'aborted' };
          break;
        case 'attempt still open':
          f.coreDb.sqlite.prepare("UPDATE scheduler_execution_attempts SET phase = 'open'").run();
          break;
        case 'attempt has no fence':
          f.coreDb.sqlite.prepare('UPDATE scheduler_execution_attempts SET fence_ref = NULL').run();
          break;
        case 'attempt has no operation':
          f.coreDb.sqlite
            .prepare('UPDATE scheduler_execution_attempts SET operation_id = NULL')
            .run();
          break;
        case 'impossible published AgentSession':
          session.data.agentSession.status = 'busy';
          break;
        case 'AgentSession changed before terminal':
        case 'AgentSession changed at terminal':
          await f.store.updateAgentSession(f.agentSessionId, {
            status: 'closed',
            updatedAt: new Date(
              Date.parse(terminal.timestamp) -
                (scenario === 'AgentSession changed before terminal' ? 1 : 0)
            ).toISOString(),
          });
          break;
        case 'post-terminal publication changes the decided completion':
          session.sequence = terminal.sequence + 1;
          session.timestamp = new Date(Date.parse(terminal.timestamp) + 1000).toISOString();
          session.data.agentSession.updatedAt = session.timestamp;
          break;
        case 'AgentSession publication has later timestamp':
          session.timestamp = new Date(Date.parse(terminal.timestamp) + 1).toISOString();
          break;
        case 'AgentSession publication missing for retained failure':
          events.splice(events.indexOf(session), 1);
          break;
        case 'AgentSession publication has wrong owner':
          session.data.agentSession.id = 'as_00000000-0000-7b63-aa35-e1566fde2219';
          break;
        case 'AgentSession publication has wrong agent':
          session.data.agentSession.agentId = 'agent_foreign';
          break;
        case 'AgentSession publication has wrong Thread':
          session.data.agentSession.threadId = 'th_00000000-0000-7856-9931-7f8680874d49';
          break;
        case 'AgentSession publication has wrong request':
          session.requestId = '00000000-0000-4000-8000-000000000502';
          break;
        case 'terminal event has wrong Turn':
          terminal.data.turn.id = 'tu_00000000-0000-7c16-9c53-35e89f566c39';
          break;
        case 'checkpoint has wrong AgentSession':
          checkpoint = {
            ...checkpoint,
            workerSessionId: 'as_00000000-0000-7b63-aa35-e1566fde2219',
          };
          break;
        case 'checkpoint has wrong request':
          checkpoint = { ...checkpoint, requestId: '00000000-0000-4000-8000-000000000502' };
          break;
      }
      vi.spyOn(f.store, 'getTurnEvents').mockReturnValue(events);
      expect(() =>
        recoverWorkerCheckpointStopReason(f.coreDb, f.store, f.workspaceDb, checkpoint)
      ).toThrow(expectedError);
      expect(
        getWorkerCheckpoint(
          f.workspaceDb,
          f.checkpoint.workspaceId,
          f.checkpoint.threadId,
          f.checkpoint.turnId
        )
      ).toEqual(f.checkpoint);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  });

  it.each([
    ['granted', 'completed', 'completed'],
    ['denied', 'interrupted', 'aborted'],
  ] as const)('classifies a %s human worker approval after a policy grant and terminal closeout', async (decision, turnStatus, stopReason) => {
    const store = await createDemoStore();
    const turn = await store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Close a worker approval',
      {
        id: 'usr_00000000-0000-7000-8000-000000000001',
        kind: 'user',
      }
    );
    // A prior policy grant is durable evidence, not the later human Gate response.
    const policyApproval = store.createApproval({
      createdAt: '2026-09-03T00:00:00.000Z',
      description: 'Automatically approve publication.',
      id: 'ap_policy_push',
      kind: 'permission',
      resolvedAt: '2026-09-03T00:00:00.000Z',
      status: 'granted',
      threadId: turn.threadId,
      title: 'Approve push',
      turnId: turn.id,
      workspaceId: workspaceIdForOwner(turn.owner),
    });
    await store.createItem({
      approvalRequestId: policyApproval.id,
      completedAt: policyApproval.createdAt,
      createdAt: policyApproval.createdAt,
      description: policyApproval.description,
      id: 'it_00000000-0000-7027-9e4c-3a19493a1c80',
      kind: policyApproval.kind,
      status: 'completed',
      threadId: turn.threadId,
      title: policyApproval.title,
      turnId: turn.id,
      type: 'approval-request',
      owner: { kind: 'workspace', workspaceId: workspaceIdForOwner(turn.owner) },
    });
    await store.createItem({
      actor: { id: 'nanocore-repo-push-policy', kind: 'system', responsibleUserId: null },
      approvalRequestId: policyApproval.id,
      causationId: 'it_00000000-0000-7027-9e4c-3a19493a1c80',
      completedAt: policyApproval.createdAt,
      createdAt: policyApproval.createdAt,
      decision: 'granted',
      id: 'it_00000000-0000-7768-ab8d-e4c1bd990e58',
      decidedAt: policyApproval.createdAt,
      status: 'completed',
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'approval-decision',
      owner: { kind: 'workspace', workspaceId: workspaceIdForOwner(turn.owner) },
    });
    const approval = store.createApproval({
      createdAt: '2026-09-04T00:00:00.000Z',
      description: 'Approve the exact worker effect.',
      id: `ap_worker_${decision}`,
      kind: 'permission',
      resolvedAt: null,
      status: 'pending',
      threadId: turn.threadId,
      title: 'Approve worker effect',
      turnId: turn.id,
      workspaceId: workspaceIdForOwner(turn.owner),
    });
    const request = await store.createItem({
      approvalRequestId: approval.id,
      completedAt: '2026-09-04T00:00:00.000Z',
      createdAt: '2026-09-04T00:00:00.000Z',
      description: approval.description,
      id: testEntityId('it', `it_worker_${decision}_request`),
      kind: approval.kind,
      status: 'completed',
      threadId: turn.threadId,
      title: approval.title,
      turnId: turn.id,
      type: 'approval-request',
      owner: { kind: 'workspace', workspaceId: workspaceIdForOwner(turn.owner) },
    });
    const response = await store.createItem({
      actor: { id: 'usr_00000000-0000-7000-8000-000000000001', kind: 'user' },
      approvalRequestId: approval.id,
      causationId: '00000000-0000-4000-8000-000000000401',
      completedAt: '2026-09-04T00:01:00.000Z',
      createdAt: '2026-09-04T00:01:00.000Z',
      decision,
      id: testEntityId('it', `it_worker_${decision}_decision`),
      decidedAt: '2026-09-04T00:01:00.000Z',
      status: 'completed',
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'approval-decision',
      owner: { kind: 'workspace', workspaceId: workspaceIdForOwner(turn.owner) },
    });
    store.updateApproval(approval.id, {
      resolvedAt: '2026-09-04T00:01:00.000Z',
      status: decision,
    });
    const closedTurn = await store.updateTurn(turn.id, {
      completedAt: '2026-09-04T00:01:00.000Z',
      status: turnStatus,
    });
    const terminalEvent = await store.persistTurnEvent(turn.id, {
      data: { stopReason, turn: closedTurn, type: 'turn-completed' },
      event: 'turn.completed',
      requestId: '00000000-0000-4000-8000-000000000401',
      threadId: turn.threadId,
      turnId: turn.id,
      workspaceId: workspaceIdForOwner(turn.owner),
    });
    store.emitTurnEvent(turn.id, terminalEvent);

    expect(classifyClosedWorkerApprovalGate(store, closedTurn)).toEqual({
      requestItemId: request.id,
      responseItemId: response.id,
      responseRequestId: '00000000-0000-4000-8000-000000000401',
      stopReason,
    });
  });

  it('cleans checkpoints only after terminal worker state is durably saved', async () => {
    const workspaceDb = await createWorkspaceDb();

    try {
      await upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-76bd-938b-691bf839bfd7',
        requestId: 'req_turn_completed',
        requestInputHash: 'sha256:tu_00000000-0000-76bd-938b-691bf839bfd7',
        stage: 'completed',
        iteration: 4,
        now: () => '2026-05-31T00:00:00.000Z',
      });
      await upsertWorkerCheckpoint(workspaceDb, {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: 'tu_00000000-0000-79b8-b38a-2e414f9643c2',
        requestId: 'req_turn_running',
        requestInputHash: 'sha256:tu_00000000-0000-79b8-b38a-2e414f9643c2',
        stage: 'running_worker',
        iteration: 1,
        now: () => '2026-05-31T00:00:00.000Z',
      });

      expect(
        await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-79b8-b38a-2e414f9643c2',
        })
      ).toBe(false);
      expect(
        getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'tu_00000000-0000-79b8-b38a-2e414f9643c2'
        )
      ).not.toBeNull();
      expect(
        await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-76bd-938b-691bf839bfd7',
        })
      ).toBe(true);
      expect(
        getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'tu_00000000-0000-76bd-938b-691bf839bfd7'
        )
      ).toBeNull();
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('refuses to clear a matching session when required provenance was never retained', async () => {
    const workspaceDb = await createWorkspaceDb();

    try {
      const store = await createDemoStore();
      const turn = await store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Missing retained runtime provenance',
        {
          kind: 'user',
          id: 'usr_00000000-0000-7000-8000-000000000001',
        }
      );
      const environmentPackage = AgentEnvironmentPackageSchema.parse(
        resolveAgentEnvironmentPackage({
          agentSetup: createTestAgentSetup({
            requiredCapabilities: [
              'trusted-worker-inference-relay',
              'worker.runtime-provenance.v1',
            ],
          }),
          agentSessionId: 'as_00000000-0000-7957-aadd-772e5050de60',
          backend: { kind: 'openshell' },
          createdAt: '2026-07-13T00:00:00.000Z',
          requestId: 'req_recovery_provenance_missing',
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7e68-be9b-ac7521cb7be0' },
          turn,
          turnInput: 'Missing retained runtime provenance',
          workspaceCwd: '/workspace/repo',
          workspaceRoots: [],
        })
      );
      recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        createdAt: '2026-07-13T00:00:01.000Z',
        environmentPackage,
      });
      const checkpoint = await upsertWorkerCheckpoint(workspaceDb, {
        iteration: 1,
        now: () => '2026-07-13T00:00:03.000Z',
        requestId: `req_${turn.id}`,
        requestInputHash: `sha256:${turn.id}`,
        stage: 'completed',
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        workerSessionId: environmentPackage.scope.agentSessionId,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });

      await expect(
        clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: turn.id,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        })
      ).rejects.toThrow('Required retained runtime provenance is missing.');
      await expect(
        clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: turn.id,
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        })
      ).rejects.toMatchObject({ code: 'recovery_retry_failed', status: 400 });
      expect(
        getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          turn.id
        )
      ).toEqual(checkpoint);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });

  it('re-verifies retained required provenance before clearing a terminal checkpoint', async () => {
    const workspaceDb = await createWorkspaceDb();

    try {
      const retained = await createRetainedRecoveryProvenance(workspaceDb);
      const checkpoint = () =>
        upsertWorkerCheckpoint(workspaceDb, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: retained.turnId,
          requestId: `req_${retained.turnId}`,
          requestInputHash: `sha256:${retained.turnId}`,
          stage: 'completed',
          iteration: 1,
          workerSessionId: retained.agentSessionId,
          now: () => '2026-07-13T00:00:03.000Z',
        });
      const clear = () =>
        clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: retained.turnId,
        });

      await checkpoint();
      await expect(clear()).resolves.toBe(true);
      expect(
        getWorkerCheckpoint(
          workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          retained.turnId
        )
      ).toBeNull();

      await checkpoint();
      writeFileSync(
        retained.stableStreamPath,
        Buffer.concat([retained.stableStreamBytes, Buffer.from('tampered')])
      );
      await expect.soft(clear()).rejects.toThrow(/provenance/i);
      await expect.soft(clear()).rejects.toBeInstanceOf(OperationError);
      await expect
        .soft(clear())
        .rejects.toMatchObject({ code: 'recovery_retry_failed', status: 400 });
      expect
        .soft(
          getWorkerCheckpoint(
            workspaceDb,
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001',
            retained.turnId
          )
        )
        .not.toBeNull();

      await checkpoint();
      writeFileSync(retained.stableStreamPath, retained.stableStreamBytes);
      unlinkSync(retained.stableStreamPath);
      await expect.soft(clear()).rejects.toThrow(/provenance/i);
      await expect.soft(clear()).rejects.toBeInstanceOf(OperationError);
      await expect
        .soft(clear())
        .rejects.toMatchObject({ code: 'recovery_retry_failed', status: 400 });
      expect
        .soft(
          getWorkerCheckpoint(
            workspaceDb,
            'ws_00000000-0000-7000-8000-000000000001',
            'th_00000000-0000-7000-8000-000000000001',
            retained.turnId
          )
        )
        .not.toBeNull();
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
    }
  });
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
