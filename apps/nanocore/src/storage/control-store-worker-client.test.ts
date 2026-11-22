// openkit-test-platform: posix
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { Worker } from 'node:worker_threads';
import type {
  JsonOperationId,
  LightAppSchemaInput,
  ServerEvidenceBundleRecord,
} from '@openkit/app-api-schemas';
import {
  allocateEntityId,
  canonicalJsonText,
  type Item,
  KernelAuditEventSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { sha256CanonicalJson } from '@openkit/protocol/digest';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareCommunicationOwner,
  prepareNanoHostOwner,
  readNanoHostRestartCensus,
} from '../app.js';
import { observeAppUpdatePreflight } from '../app-update/preflight.js';
import { auditEventFromRow, listSqliteAuditEvents, prepareAuditEvent } from '../audit-events.js';
import type { ControlNanoHostTransportInput } from '../auth/nanohost-transport-codecs.js';
import { listNanoHostTransportTokenRecords } from '../auth/nanohost-transport-token-store.js';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import { openCommunicationDiscordChannel } from '../channels/discord-owner.js';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import {
  createLightApp,
  createRecord,
  getLightApp,
  getRecord,
  type KernelCommandContext,
  updateRecord,
} from '../generative-kernel/commands.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { recordProductPermissionDecision } from '../policy/permission-decisions.js';
import { readPermissionDecisionRowV1 } from '../policy/retained-records-v1.js';
import { inspectCoreHarnessConsumption } from '../runtime/core-journal-records.js';
import {
  bindSchedulerExecutionAttemptSession,
  createSchedulerExecutionAttempt,
  finalizeSchedulerExecutionAttemptInput,
  recordSchedulerExecutionOperation,
  requireSchedulerExecutionAttempt,
} from '../runtime/execution-attempt-records.js';
import {
  admitKernelSchedulerGrantInDb,
  CORE_SCHEDULER_EXECUTION_DEFINITION,
} from '../runtime/execution-journal.js';
import type { ExecutionJournalIntent } from '../runtime/execution-step-journal.js';
import {
  hasQueuedNanoHostHarnessOperation,
  prepareNanoHostHarnessOperation,
} from '../runtime/nanohost-harness-records.js';
import { stageSchedulerStartInput } from '../runtime/scheduler-input-staging.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-session-records.js';
import { prepareWorkerStorageContributor } from '../runtime/worker-storage-binding-records.js';
import { recordWorkspaceBackendHandoff } from '../runtime/workspace-backend-handoff.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from '../runtime/workspace-materializer.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { readRetainedBodyBytes } from '../test-support/retained-body-observation.js';
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import { openTestServerWork } from '../test-support/server-work-store.js';
import { initializeTestCore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { lightAppDbPath, openExistingAppDb } from './app-db.js';
import { commandRequestKey, getCommandRequestRecord } from './command-request-records.js';
import { requireChannelStorage } from './communication-inbound.js';
import { communicationOwner } from './communication-owner.js';
import type { ControlKernelStore } from './control-kernel-port.js';
import { admitCoreScheduler } from './control-store-admission.js';
import { WorkspaceQueueInputRefSchema } from './control-store-admission-codecs.js';
import { commandInputHash, frameControlScalarText } from './control-store-input.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  readAdmittedNanoHostAttempt,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  CONTROL_WORKER_LIMITS,
  type ControlSqlStatement,
  type ControlWorkerRequest,
} from './control-store-worker-protocol.js';
import { createDataRootAdminOperationImplementations } from './data-root-admin-operations.js';
import * as dataRootBackup from './data-root-backup.js';
import {
  bindCoreSqlite,
  openCoreDb,
  openCoreReadDb,
  openUserDb,
  openUserReadDb,
  openWorkspaceDb,
  serverStoragePath,
} from './db.js';
import {
  coreDbPath,
  ensureLayout,
  ensureUserLayout,
  ensureWorkspaceLayout,
  readDataRootLayoutMarker,
  userDbPath,
  workspaceDbPath,
} from './fs-layout.js';
import { applyMigrations, applyScopedMigrations, hasPendingUserMigrations } from './migrate.js';
import { createNanoHostCoreReads } from './nanohost-core-reads.js';
import {
  type NanoHostRuntimeTargetEpochKernel,
  vaultEpochFenceOccurrence,
} from './nanohost-epoch-invalidation.js';
import {
  inspectNanoHostRuntimeTargetTransition,
  prepareNanoHostRuntimeTargetTransition,
  readNanoHostEpochInvalidation,
  readPendingNanoHostEpochRetirement,
} from './nanohost-epoch-invalidation-native.js';
import { nanoHostStoreDescriptor } from './nanohost-store-descriptor.js';
import type { ControlRuntimeTargetInput } from './runtime-target-codecs.js';
import { readServerCallUsageIds } from './server-work-call.js';
import {
  inspectServerWorkContainmentEvidence,
  publishContainmentEvidenceHandoff,
} from './server-work-evidence.js';
import {
  isServerWorkPublished,
  readServerWorkIntent,
  readServerWorkLocalReceipt,
  readStagedServerWork,
} from './server-work-intents.js';
import type { ServerCallAdmission, ServerWorkIntent } from './server-work-port.js';
import { serverWorkStorageDescriptor } from './server-work-schema.js';
import { storageReceipt, storageRequestId } from './storage-owner.js';
import { advanceThreadReadReceipt, readThreadReadReceipt } from './thread-read-receipts.js';
import { nativeProductScope } from './workspace-file-records.js';
import { listWorkspaceMaterializationRecords } from './workspace-handoff-read.js';

/** These roots have no independently admitted file publishers outside their native fixture. */
function pauseFixturePublishers(): Promise<() => void> {
  return Promise.resolve(() => {});
}

const interception = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  gate: undefined as SharedArrayBuffer | undefined,
  point: 'before' as 'before' | 'after' | 'open-ack',
  coreReadProbe: undefined as { path: string; reads: Int32Array } | undefined,
}));

// This fixture wraps the actual entry, not a fake SQL service or a production fault option.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (interception.gate !== undefined) {
          const prelude = `
            const {parentPort, workerData} = require('node:worker_threads');
            const Database = require(workerData.databaseModule);
            const original = Database.prototype.exec;
            const probe = workerData.coreReadProbe;
            if (probe) {
              const prepare = Database.prototype.prepare;
              Database.prototype.prepare = function(sql) {
                if (this.name === probe.path && /^\\s*(?:SELECT|WITH)\\b/i.test(sql)) {
                  Atomics.add(probe.reads, 0, 1);
                }
                return prepare.call(this, sql);
              };
            }
            function hold(path, sqlite) {
              if (workerData.gate.length > 3 && Atomics.load(workerData.gate, 3) !== workerData.index) return;
              if (workerData.gate.length > 4) {
                const length = Atomics.load(workerData.gate, 4);
                const selected = String.fromCharCode(...workerData.gate.slice(5, 5 + length));
                if (path !== selected) return;
              }
              if (workerData.gate.length > 4 && Atomics.load(workerData.gate, 2) === 2) {
                let synchronous = -1;
                try { synchronous = Number(sqlite.pragma('synchronous', {simple:true})); } catch {}
                Atomics.store(workerData.gate, workerData.gate.length - 1, synchronous);
              }
              if (workerData.gate.length > 2 && Atomics.load(workerData.gate, 2) === 1) {
                Atomics.add(workerData.gate, 0, 1);
                Atomics.wait(workerData.gate, 1, 0);
              } else if (Atomics.compareExchange(workerData.gate, 0, 0, 1) === 0) {
                Atomics.wait(workerData.gate, 1, 0);
              }
            }
            const post = parentPort.postMessage.bind(parentPort);
            parentPort.postMessage = function(message, ...args) {
              if (workerData.point === 'open-ack' && message.status === 'ok' && message.operation === 'open') hold();
              return post(message, ...args);
            };
            Database.prototype.exec = function(sql) {
              const commit = /^COMMIT$/i.test(sql);
              if (commit && workerData.point === 'before') hold(this.name, this);
              const result = original.call(this, sql);
              if (commit && workerData.point === 'after') hold(this.name, this);
              return result;
            };
          `;
          const entry = options?.eval
            ? String(filename)
            : `import(${JSON.stringify(String(filename))});`;
          const require = createRequire(import.meta.url);
          super(prelude + entry, {
            ...options,
            eval: true,
            workerData: {
              databaseModule: require.resolve('better-sqlite3'),
              gate: new Int32Array(interception.gate),
              point: interception.point,
              index: interception.workers.length,
              coreReadProbe: interception.coreReadProbe,
            },
          });
        } else {
          super(filename, options);
        }
        interception.workers.push(this);
      }
    },
  };
});

const roots: string[] = [];
let client: ReturnType<typeof getControlStoreWorkerClient> | undefined;
const nativeHandles: (ReturnType<typeof openCoreDb> | ReturnType<typeof openWorkspaceDb>)[] = [];

/** Uses the real worker and current User journal in a private database, never a product fixture default. */
async function fixture(point?: 'before' | 'after', layout: 'private' | 'data-root' = 'private') {
  const root = mkdtempSync(join(tmpdir(), 'control-client-'));
  roots.push(root);
  if (layout === 'data-root') {
    ensureLayout(root);
    ensureUserLayout(root, FIXTURE_LOCAL_USER_ID);
  }
  const path =
    layout === 'data-root' ? userDbPath(root, FIXTURE_LOCAL_USER_ID) : join(root, 'user.sqlite');
  if (point !== undefined) {
    interception.gate = new SharedArrayBuffer(8);
    interception.point = point;
  }
  client = getControlStoreWorkerClient();
  await client.open({ database: 'user', path, create: true, initialize: 'user' });
  return {
    client,
    path,
    root,
    gate: interception.gate === undefined ? undefined : new Int32Array(interception.gate),
  };
}

/** Opens actual scope journals through the public client; the accepted DX reference fixes four Workspace hosts. */
async function poolFixture(size = 4, point?: 'before' | 'after' | 'open-ack') {
  const root = mkdtempSync(join(tmpdir(), 'control-pool-'));
  roots.push(root);
  ensureLayout(root);
  if (point !== undefined) {
    interception.gate = new SharedArrayBuffer(12);
    interception.point = point;
    Atomics.store(new Int32Array(interception.gate), 0, 1); // Leave initialization outside the fault.
  }
  const writer = getControlStoreWorkerClient();
  client = writer;
  const scopes = new Map<
    number,
    {
      database: string;
      path: string;
      create: boolean;
      initialize: 'workspace';
      productOwner: { kind: 'workspace'; workspaceId: string };
      dataRoot: string;
    }
  >();
  const scope = (index: number) => {
    let value = scopes.get(index);
    if (value === undefined) {
      const workspaceId = allocateEntityId('ws');
      ensureWorkspaceLayout(root, workspaceId);
      const path = workspaceDbPath(root, workspaceId);
      value = {
        database: `workspace:${path}`,
        path,
        create: true,
        initialize: 'workspace',
        productOwner: { kind: 'workspace', workspaceId },
        dataRoot: root,
      };
      scopes.set(index, value);
    }
    return value;
  };
  for (let index = 0; index < size; index += 1) await writer.open(scope(index));
  return {
    client: writer,
    root,
    scope,
    gate: interception.gate === undefined ? undefined : new Int32Array(interception.gate),
  };
}

/** Publishes real Workspace and Material commands; no completed receipt or Material row is assembled by the test. */
async function productPoolFixture() {
  const root = mkdtempSync(join(tmpdir(), 'control-product-pool-'));
  roots.push(root);
  initializeTestCore(root);
  const coreDb = openCoreDb(root);
  nativeHandles.push(coreDb);
  const userId = ensureLocalUser(coreDb);
  initializeDefaultKnowledgeBaseId({
    dataRoot: root,
    scope: { kind: 'server' },
    knowledgeBaseId: allocateEntityId('kb'),
  });
  const store = new FsStore({ dataRoot: root });
  const workspaces = [];
  client = getControlStoreWorkerClient();
  for (let index = 0; index < 4; index += 1) {
    const workspace = await store.createWorkspace(`Pool ${index}`);
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    const scope = nativeProductScope(root, { kind: 'workspace', workspaceId: workspace.id });
    await client.open({
      database: `workspace:${scope.path}`,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    workspaces.push(workspace);
  }
  const invoke = createOperationInvocation({
    coreDb,
    store,
    dataRoot: root,
    inflightCommands: new WeakMap(),
    repositoryWorkspaceDb: (id) => {
      if (!workspaces.some((workspace) => workspace.id === id))
        throw new Error('Fixture Workspace is not admitted.');
      return openWorkspaceDb(root, id);
    },
  });
  const call = <K extends JsonOperationId>(workspaceId: string, id: K, input: object) =>
    invoke(id, { workspaceId, ...input }, { kind: 'public', actor: { kind: 'session', userId } });
  return { client, root, workspaces, call, coreDb, userId, store };
}

/** Reuses the existing native journal receipt table to observe this transport's real COMMIT boundary. */
function nativeRequest(id: string): ControlSqlStatement[] {
  return [
    {
      mode: 'run',
      sql: "INSERT INTO idempotency_requests (request_key, command_name, request_id, scope_json, input_hash, response_kind, response_id, created_at, expires_at) VALUES (?, 'fixture', ?, '{}', 'fixture', 'thread', 'fixture', 'fixture', 'fixture')",
      parameters: [id, id],
      expectChanges: 1,
    },
  ];
}

/** Reads the native request identity without another writer or an outcome guess. */
function nativeRequests(path: string): string[] {
  const reader = new Database(path, { readonly: true, fileMustExist: true });
  try {
    reader.pragma('query_only = ON');
    return reader
      .prepare('SELECT request_id FROM idempotency_requests ORDER BY request_id')
      .pluck()
      .all() as string[];
  } finally {
    reader.close();
  }
}

/** A scalar metadata insert in an already owned native table, not a new product contract. */
function metadata(id: string): ControlSqlStatement[] {
  return [
    {
      mode: 'run',
      sql: "INSERT INTO thread_read_receipts (workspace_id, thread_id, item_ids_json) VALUES ('fixture', ?, '[]')",
      parameters: [id],
      expectChanges: 1,
    },
  ];
}

/** Waits without blocking the main thread or choosing a shorter product deadline. */
async function waitForHold(gate: Int32Array): Promise<void> {
  while (Atomics.load(gate, 0) === 0) await nextTurn();
}

/** Releases only this fixture's native COMMIT gate. */
function release(gate?: Int32Array): void {
  if (gate === undefined) return;
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
}

/** Inspects committed truth through an independent short read-only connection. */
function count(path: string): number {
  const reader = new Database(path, { readonly: true, fileMustExist: true });
  try {
    reader.pragma('query_only = ON');
    return reader.prepare('SELECT count(*) FROM thread_read_receipts').pluck().get() as number;
  } finally {
    reader.close();
  }
}

afterEach(async () => {
  if (interception.gate !== undefined) release(new Int32Array(interception.gate));
  await client?.shutdown();
  client = undefined;
  for (const db of nativeHandles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  interception.gate = undefined;
  interception.coreReadProbe = undefined;
  interception.workers.length = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real split owner writer and its admitted Core receipt handle. */
async function communicationWorkerFixture(holdCoreCommit = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'control-communication-')));
  roots.push(root);
  ensureLayout(root);
  initializeTestCore(root);
  const coreDb = openCoreDb(root);
  nativeHandles.push(coreDb);
  const userId = ensureLocalUser(coreDb);
  const writer = getControlStoreWorkerClient();
  client = writer;
  const corePath = coreDbPath(root);
  const coreOpen = {
    database: `core:${corePath}`,
    path: corePath,
    create: false,
    initialize: 'core' as const,
    productOwner: { kind: 'server' as const },
    dataRoot: root,
  };
  const gate = holdCoreCommit ? new Int32Array(new SharedArrayBuffer(4 * 4)) : undefined;
  if (gate) {
    // Arm only after boot and challenge publication; worker zero owns Core.
    interception.gate = gate.buffer as SharedArrayBuffer;
    interception.point = 'after';
    Atomics.store(gate, 0, 1);
  }
  await writer.open(coreOpen);

  const kernel = writer.communicationKernel(coreDb);
  const input = { coreDb, mode: 'local' as const };
  await expect(prepareCommunicationOwner(input)).resolves.toEqual({
    state: 'unavailable',
    owner: 'control-kernel',
    reason: 'missing',
  });
  expect(existsSync(serverStoragePath(root, 'communication'))).toBe(false);
  await expect(writer.provisionServerOwner(root, communicationOwner)).resolves.toEqual({
    state: 'ready',
    owner: 'communication',
  });
  const bound = await prepareCommunicationOwner({ ...input, kernel });
  if (bound.state !== 'ready') throw new Error(`Communication binding failed: ${bound.reason}`);
  return {
    root,
    writer,
    binding: bound.value,
    coreDb,
    kernel,
    userId,
    coreOpen,
    gate,
    reopen: () => prepareCommunicationOwner({ ...input, kernel }),
  };
}

async function signedCommunicationFixture(holdCoreCommit = false) {
  const fixture = await communicationWorkerFixture(holdCoreCommit);
  const { binding, userId } = fixture;
  const actor = { kind: 'local' as const, userId };
  const applicationId = '123456789012345678';
  const externalAccountId = '223456789012345678';
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('hex');
  const compose = (owner: typeof binding, kernel: typeof fixture.kernel) =>
    requireChannelStorage(
      openCommunicationDiscordChannel({
        storage: owner.owners.communication.storage,
        deploymentId: owner.owners.deploymentId,
        kernel,
        applicationId,
        publicKey,
        appBaseUrl: 'https://openkit.invalid',
        requestLink: () => null,
        resolveActor: (candidate) => (candidate === userId ? actor : null),
        inspectPending: () => {
          throw new Error('Pairing must not inspect a Pending Request.');
        },
        inspectPendingDecision: () => null,
        invoke: async () => {
          throw new Error('Pairing must not post a Pending Request.');
        },
      })
    );
  const channel = compose(binding, fixture.kernel);
  const run = async <Value>(effect: () => Promise<Value>) =>
    requireChannelStorage(await binding.withProducer(effect));
  const { challenge } = await run(() => channel.beginPairing(actor));
  const body = Buffer.from(
    JSON.stringify({
      id: '123456789012345679',
      application_id: applicationId,
      type: 2,
      version: 1,
      context: 1,
      channel: { id: '323456789012345678', type: 1 },
      user: { id: externalAccountId },
      data: {
        id: '423456789012345678',
        type: 1,
        name: 'openkit',
        options: [
          { name: 'pair', type: 1, options: [{ name: 'challenge', type: 3, value: challenge }] },
        ],
      },
    })
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp), body]),
    keys.privateKey
  ).toString('hex');
  const signedPair = { body, timestamp, signature };
  const pair = () => run(() => channel.handleSignedInteraction(signedPair));
  return { ...fixture, actor, channel, compose, externalAccountId, pair, run, signedPair };
}

it('pairs and unbinds a signed DM through both native owners and relays each original Audit once', async () => {
  const { actor, binding, channel, coreDb, externalAccountId, pair, run, userId } =
    await signedCommunicationFixture();

  await expect(pair()).resolves.toMatchObject({
    data: { content: expect.stringContaining('paired') },
  });
  expect(
    requireChannelStorage(binding.owners.communication.storage.readBinding(userId))
  ).toMatchObject({
    externalAccountId,
  });
  await expect(pair()).resolves.toMatchObject({
    data: { content: expect.stringContaining('already handled') },
  });
  await run(() => channel.revoke(actor));
  expect(
    requireChannelStorage(binding.owners.communication.storage.readBinding(userId))
  ).toBeNull();
  const originalEvents = requireChannelStorage(
    binding.owners.attention.read((sqlite) =>
      sqlite
        .prepare(
          "SELECT event_json FROM communication_intents WHERE kind = 'relay-pairing-audit' ORDER BY sequence"
        )
        .pluck()
        .all()
        .map((json) => KernelAuditEventSchema.parse(JSON.parse(json as string)))
    )
  );
  expect(originalEvents).toHaveLength(2);
  await vi.waitFor(() => {
    const entries = coreDb.sqlite
      .prepare(
        "SELECT action FROM audit_events WHERE action IN ('channel.pairing.bind', 'channel.pairing.unbind') ORDER BY action"
      )
      .pluck()
      .all();
    expect(entries).toEqual(['channel.pairing.bind', 'channel.pairing.unbind']);
    const readEvent = coreDb.sqlite.prepare('SELECT * FROM audit_events WHERE audit_event_id = ?');
    for (const original of originalEvents) {
      expect(auditEventFromRow(readEvent.get(original.id))).toEqual(original);
    }
  });
});

it('keeps a signed DM read-only on replay after the Core FULL reservation ACK is lost', async () => {
  const fixture = await signedCommunicationFixture(true);
  const gate = fixture.gate!;
  Atomics.store(gate, 0, 0);
  const first = fixture.pair();
  const reservations = () =>
    fixture.coreDb.sqlite
      .prepare("SELECT count(*) FROM idempotency_requests WHERE command_name = 'channel.inbound'")
      .pluck()
      .get();
  try {
    await waitForHold(gate);
    expect(reservations()).toBe(1);
    expect(
      requireChannelStorage(
        fixture.binding.owners.communication.storage.readBinding(fixture.userId)
      )
    ).toBeNull();
    await interception.workers[0]!.terminate();
  } finally {
    release(gate);
  }
  await expect(first).resolves.toMatchObject({
    data: { content: expect.stringContaining('Inspect') },
  });

  await shutdownControlStoreWorkerClient();
  interception.gate = undefined;
  const writer = getControlStoreWorkerClient();
  client = writer;
  await writer.open(fixture.coreOpen);
  const kernel = writer.communicationKernel(fixture.coreDb);
  const reopened = requireChannelStorage(
    await prepareCommunicationOwner({
      coreDb: fixture.coreDb,
      mode: 'local',
      kernel,
    })
  );
  const channel = fixture.compose(reopened, kernel);
  const posted = vi.spyOn(Worker.prototype, 'postMessage');
  try {
    const reply = requireChannelStorage(
      await reopened.withProducer(() => channel.handleSignedInteraction(fixture.signedPair))
    );
    expect(reply).toMatchObject({ data: { content: expect.stringContaining('Inspect') } });
    expect(
      posted.mock.calls
        .filter(([request]) => request.operation === 'communication-kernel')
        .map(([request]) => request.input.kind)
    ).toEqual(['inspect']);
  } finally {
    posted.mockRestore();
  }
  expect(reservations()).toBe(1);
  expect(
    requireChannelStorage(reopened.owners.communication.storage.readBinding(fixture.userId))
  ).toBeNull();
  expect(
    fixture.coreDb.sqlite
      .prepare("SELECT count(*) FROM audit_events WHERE action = 'channel.pairing.bind'")
      .pluck()
      .get()
  ).toBe(0);
});

it('joins the Communication producer before the common cut and refuses a closed Workspace', async () => {
  const { root, writer, binding, userId } = await communicationWorkerFixture();
  const { attention } = binding.owners;
  const workspaceId = allocateEntityId('ws');
  const selection = {
    source: {
      kind: 'approval-request' as const,
      workspaceId,
      threadId: allocateEntityId('th'),
      requestId: 'ap_communication_binding',
    },
    recipientUserId: userId,
  };
  const held = { state: 'unavailable', owner: 'communication', reason: 'recovery-required' };

  writer.restoreWorkspaceMutationsClosed(root, workspaceId);
  const probe = vi.fn(async () => undefined);
  await expect(attention.withWorkspace(workspaceId, probe)).resolves.toEqual(held);
  expect(probe).not.toHaveBeenCalled();
  writer.reopenWorkspaceMutations(root, workspaceId);

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = attention.withWorkspace(workspaceId, async () => {
    entered.resolve();
    await release.promise;
    return attention.enqueue(selection);
  });
  await entered.promise;
  const acquired = vi.fn();
  const cut = writer.pauseForDataRootBackup().then((resume) => {
    acquired();
    return resume;
  });
  try {
    await expect(binding.withProducer(probe)).resolves.toEqual(held);
    expect(acquired).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  await expect(original).resolves.toMatchObject({
    state: 'ready',
    value: { state: 'ready', value: { source: selection.source, status: 'queued' } },
  });
  const resume = await cut;
  try {
    expect(acquired).toHaveBeenCalledOnce();
    await expect(binding.withProducer(probe)).resolves.toEqual(held);
  } finally {
    resume();
  }
  await expect(binding.withProducer(probe)).resolves.toMatchObject({ state: 'ready' });
  expect(probe).toHaveBeenCalledOnce();
  await writer.closeServerOwner(root, 'communication');
  expect(attention.read(() => true)).toEqual(held);
  expect(existsSync(serverStoragePath(root, 'communication'))).toBe(true);
});

it('replays a Communication Attention selector beyond the ordinary worker metadata limit', async () => {
  const { root, writer, binding, userId, reopen } = await communicationWorkerFixture();
  const requestId = `apr_${'"\\\n\u0000\uFEFF😀'.repeat(110_000)}`;
  expect(Buffer.byteLength(requestId)).toBeGreaterThan(1_048_576);
  const selection = {
    source: {
      kind: 'approval-request' as const,
      workspaceId: allocateEntityId('ws'),
      threadId: allocateEntityId('th'),
      requestId,
    },
    recipientUserId: userId,
  };
  const enqueue = (owner: typeof binding) =>
    owner.withProducer(() => owner.owners.attention.enqueue(selection));
  const [original, concurrent] = await Promise.all([enqueue(binding), enqueue(binding)]);
  if (original.state !== 'ready' || original.value.state !== 'ready')
    throw new Error('Expected the exact large Attention enqueue to be ready.');
  if (concurrent.state !== 'ready' || concurrent.value.state !== 'ready')
    throw new Error('Expected the exact concurrent enqueue to be ready.');
  expect(original.value.value.id).toBe(concurrent.value.value.id);
  expect(sha256CanonicalJson(original.value.value.source)).toBe(
    sha256CanonicalJson(selection.source)
  );
  await writer.closeServerOwner(root, 'communication');
  const again = await reopen();
  if (again.state !== 'ready') throw new Error('Expected Communication to reopen.');
  const replay = await enqueue(again.value);
  if (replay.state !== 'ready' || replay.value.state !== 'ready')
    throw new Error('Expected the exact large selector to replay.');
  expect(replay.value.value.id).toBe(original.value.value.id);
  expect(sha256CanonicalJson(replay.value.value.source)).toBe(
    sha256CanonicalJson(selection.source)
  );
});

it('reads the live Communication expiry policy in the real writer after the retention drain', async () => {
  const { binding, userId } = await communicationWorkerFixture();
  const actor = { kind: 'local' as const, userId };
  const { communication } = binding.owners;
  const selection = { kind: 'expire' as const };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const oldProducer = binding.withProducer(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  binding.setExpiryAgeMs(1_000);
  const retained = communication.runRetention(actor, randomUUID(), selection);
  try {
    binding.setExpiryAgeMs(undefined);
  } finally {
    release.resolve();
  }
  await oldProducer;
  await expect(retained).resolves.toEqual({
    state: 'unavailable',
    owner: 'communication',
    reason: 'disabled',
  });
  binding.setExpiryAgeMs(1_000);
  await expect(communication.runRetention(actor, randomUUID(), selection)).resolves.toMatchObject({
    state: 'ready',
    value: { challenges: 0, auditEventId: expect.any(String) },
  });
});

const serverWorkReaders = {
  readServerCallUsageIds,
  inspectServerWorkContainmentEvidence,
  publishContainmentEvidenceHandoff,
  readServerWorkIntent,
  readServerWorkLocalReceipt,
  readStagedServerWork,
  isServerWorkPublished,
};
const serverWorkDisabled = { state: 'unavailable', owner: 'server-work', reason: 'disabled' };
const serverWorkHeld = { state: 'unavailable', owner: 'server-work', reason: 'recovery-required' };
const serverWorkAck = { state: 'ready', value: undefined };

async function serverWorkWorkerFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'control-server-work-')));
  roots.push(root);
  ensureLayout(root);
  const path = serverStoragePath(root, 'server-work');
  const gate = new Int32Array(new SharedArrayBuffer(4 * (6 + path.length)));
  interception.gate = gate.buffer as SharedArrayBuffer;
  interception.point = 'after';
  Atomics.store(gate, 2, 2);
  Atomics.store(gate, 3, 1);
  Atomics.store(gate, 4, path.length);
  for (let index = 0; index < path.length; index++)
    Atomics.store(gate, 5 + index, path.charCodeAt(index));
  Atomics.store(gate, 0, 1);

  const writer = getControlStoreWorkerClient();
  client = writer;
  const corePath = coreDbPath(root);
  await writer.open({
    database: `core:${corePath}`,
    path: corePath,
    create: true,
    initialize: 'core',
    productOwner: { kind: 'server' },
    dataRoot: root,
  });
  await expect(writer.bindServerWorkOwner(root)).resolves.toEqual({
    state: 'unavailable',
    owner: 'server-work',
    reason: 'missing',
  });
  expect(existsSync(path)).toBe(false);
  await expect(writer.provisionServerOwner(root, serverWorkStorageDescriptor)).resolves.toEqual({
    state: 'ready',
    owner: 'server-work',
  });
  await writer.closeServerOwner(root, 'server-work');
  return { writer, root, corePath, gate };
}

function originalServerCall(occurrenceKey = 'original-call') {
  const actor = { kind: 'system', id: 'fixture-actor', responsibleUserId: null } as const;
  const callId = allocateEntityId('cap');
  const payload = JSON.stringify({
    kind: 'server-admit',
    callId,
    now: '2026-11-21T00:00:00.000Z',
    context: {
      owner: { kind: 'server' },
      authorityActor: actor,
      capabilityId: 'llm.responses',
      family: 'llm',
      operation: 'responses.create',
      redactionClass: 'metadata-only',
    },
  });
  const occurrence = {
    deploymentId: 'fixture-deployment',
    sourceOwner: 'server-work',
    verb: 'admit-call',
    occurrenceKey,
  } as const;
  const intent: ServerCallAdmission = {
    ...occurrence,
    requestId: storageRequestId(occurrence),
    expectedGeneration: null,
    inputDigest: frameControlScalarText(payload).digest,
    target: {
      actor,
      callId,
      credentialRef: null,
      recordRef: 'fixture-draft',
      routeRef: 'fixture-pinned-route',
      budgetRef: null,
      threadId: null,
      turnId: null,
    },
  };
  const decision = {
    disposition: 'applied',
    result: { decisionRef: 'fixture-core-audit' },
  } as const;
  return { intent, payload, decision, receipt: storageReceipt(intent, decision) };
}

const containmentBundle: ServerEvidenceBundleRecord = {
  id: 'fixture-original-containment',
  owner: { kind: 'server' },
  threadId: null,
  turnId: null,
  goalId: null,
  agentSessionId: null,
  backendType: null,
  sourceKind: 'security-containment',
  summary: 'Original containment handoff.',
  rawEvidenceRefs: [],
  redactedEvidenceRefs: [{ kind: 'audit-event', ref: 'fixture-original-audit' }],
  contentDigests: [],
  retentionClass: 'workspace-audit',
  sensitivityClass: 'restricted',
  importStatus: 'collected',
  requiredFeatures: [],
  createdAt: '2026-11-21T00:00:00.000Z',
};

describe('admitted Server work owner worker', () => {
  it.each([
    { length: 8, backing: 'inline' },
    { length: 80_000, backing: 'file-backed' },
  ])(
    'retries a public $backing Server Turn completion after loss of the Core FULL ACK',
    async ({ length, backing }) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'control-server-terminal-')));
      roots.push(root);
      initializeTestCore(root);
      const core = openCoreDb(root);
      nativeHandles.push(core);
      const actor = { kind: 'user' as const, id: ensureLocalUser(core) };
      const gate = new Int32Array(new SharedArrayBuffer(4 * 4));
      interception.gate = gate.buffer as SharedArrayBuffer;
      interception.point = 'after';
      Atomics.store(gate, 0, 1);
      const opening = await openTestServerWork(core);
      client = getControlStoreWorkerClient();
      let terminal: ServerWorkIntent | undefined;
      const post = Worker.prototype.postMessage;
      const capture = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
        this: NativeWorker,
        ...args: Parameters<NativeWorker['postMessage']>
      ) {
        const message = args[0] as ControlWorkerRequest;
        if (
          message.operation === 'server-work-kernel' &&
          message.input.kind === 'decide' &&
          message.input.intent.verb === 'settle-turn'
        ) {
          terminal = message.input.intent;
          Atomics.store(gate, 0, 0);
        }
        return post.apply(this, args);
      });
      let turnId: string;
      let item: Item;
      let completion: { readonly status: 'completed'; readonly completedAt: string };
      try {
        const thread = await opening.store.createServerThread(
          'Native Server terminal',
          undefined,
          undefined,
          { actor, credentialRef: null }
        );
        const turn = await opening.store.createServerTurn(
          thread.id,
          'Original Server work.',
          actor
        );
        turnId = turn.id;
        item = await opening.store.createServerItem({
          id: allocateEntityId('it'),
          owner: thread.owner,
          threadId: thread.id,
          turnId: turn.id,
          type: 'assistant-message',
          text: 'a'.repeat(length),
          status: 'completed',
          createdAt: turn.startedAt!,
          completedAt: turn.startedAt!,
        });
        completion = { status: 'completed', completedAt: new Date().toISOString() };
        Atomics.store(gate, 0, 0);
        const completing = opening.store.completeTurn(turn.id, completion);
        const result = completing.then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        );
        await Promise.race([
          waitForHold(gate),
          result.then(() => {
            throw new Error('Terminal returned before the original Core FULL commit.');
          }),
        ]);
        expect(terminal).toMatchObject({ verb: 'settle-turn', target: { turnId } });
        expect(opening.store.getServerTurnById(turnId).status).toBe('running');
        expect(
          core.sqlite
            .prepare("SELECT count(*) FROM audit_events WHERE action = 'server-work.settle-turn'")
            .pluck()
            .get()
        ).toBe(1);
        await interception.workers[0]!.terminate();
        expect(await result).toHaveProperty('error');
      } finally {
        capture.mockRestore();
        release(gate);
        opening.reader.close();
      }
      expect(terminal).toBeDefined();
      await shutdownControlStoreWorkerClient();
      interception.gate = undefined;
      const reopened = await openTestServerWork(core);
      client = getControlStoreWorkerClient();
      try {
        const staged = readStagedServerWork(reopened.reader.sqlite, terminal!.requestId);
        expect(staged?.intent).toEqual(terminal);
        expect(staged?.receipt).toBeNull();
        const [terminalDraft] = JSON.parse(staged!.payload).entries;
        expect(Boolean(terminalDraft.publication)).toBe(backing === 'file-backed');
        const readTurn = () => reopened.store.getServerTurnById(turnId!);
        const retry = () => reopened.store.completeTurn(turnId!, completion!);
        await expect(
          reopened.store.completeTurn(turnId!, { ...completion!, status: 'interrupted' })
        ).rejects.toThrow();
        const originalItem = item!;
        if (originalItem.type !== 'assistant-message')
          throw new Error('Expected the retained Item.');
        await expect(
          reopened.store.completeTurn(turnId!, completion!, {
            items: [{ ...originalItem, text: `b${'a'.repeat(length - 1)}` }],
          })
        ).rejects.toThrow();
        expect(readTurn().status).toBe('running');
        expect(reopened.store.getServerTurnTranscript(turnId!)).toEqual([]);
        const completed = await retry();
        await expect(retry()).resolves.toEqual(completed);
        expect(readTurn()).toEqual(completed);
        expect(completed).toMatchObject({ status: 'completed', items: [item!] });
        expect(reopened.store.getServerTurnTranscript(turnId!).map((event) => event.event)).toEqual(
          ['turn.completed']
        );
        expect(
          readStagedServerWork(reopened.reader.sqlite, terminal!.requestId)?.receipt
        ).toMatchObject({
          intent: terminal,
          disposition: 'applied',
        });
        expect(
          core.sqlite
            .prepare("SELECT count(*) FROM audit_events WHERE action = 'server-work.settle-turn'")
            .pluck()
            .get()
        ).toBe(1);
      } finally {
        reopened.reader.close();
      }
    }
  );

  it('inspects the original in Core while Server work is closed and refuses a foreign deployment', async () => {
    const f = await serverWorkWorkerFixture();
    const db = openCoreReadDb(f.root);
    try {
      const kernel = f.writer.serverWorkKernel(db);
      const { intent } = originalServerCall();
      const current = {
        ...intent,
        deploymentId: readDataRootLayoutMarker(f.root).deploymentId,
      };
      const foreign = { ...intent, deploymentId: allocateEntityId('dep') };
      await expect(
        kernel.inspectServerWork({ ...current, requestId: storageRequestId(current) })
      ).resolves.toEqual({ state: 'ready', value: { state: 'absent' } });
      await expect(
        kernel.inspectServerWork({ ...foreign, requestId: storageRequestId(foreign) })
      ).resolves.toEqual({ state: 'ready', value: { state: 'conflict' } });
      await expect(
        kernel.decideServerWork({ ...current, requestId: storageRequestId(current) })
      ).resolves.toEqual({
        state: 'unavailable',
        owner: 'control-kernel',
        reason: 'recovery-required',
      });
    } finally {
      db.sqlite.close();
    }
  });

  it('refuses a root backup through the lifetime of an accepted Server work producer', async () => {
    const f = await serverWorkWorkerFixture();
    const bound = await f.writer.bindServerWorkOwner(f.root, serverWorkReaders);
    if (bound.state !== 'ready') throw new Error('Expected admitted Server work.');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const producer = bound.value.withProducer(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      await expect(f.writer.pauseForDataRootBackup()).rejects.toMatchObject({ code: 'busy' });
    } finally {
      release.resolve();
      await producer;
    }
    const resume = await f.writer.pauseForDataRootBackup();
    const refused = vi.fn(async () => undefined);
    try {
      await expect(bound.value.withProducer(refused)).resolves.toEqual(serverWorkHeld);
      expect(refused).not.toHaveBeenCalled();
    } finally {
      resume();
    }
  });

  it('opens existing-only and gates missing Core bindings before posting', async () => {
    const f = await serverWorkWorkerFixture();
    const bound = await f.writer.bindServerWorkOwner(f.root, serverWorkReaders);
    if (bound.state !== 'ready') throw new Error('Expected admitted Server work.');
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const { intent, payload, receipt } = originalServerCall();
    await expect(bound.value.stage(intent, payload)).resolves.toEqual(serverWorkDisabled);
    await expect(bound.value.claimCallContact(receipt)).resolves.toEqual(serverWorkDisabled);
    await expect(bound.value.publishContainment(containmentBundle.id)).resolves.toEqual({
      state: 'unavailable',
      owner: 'control-kernel',
      reason: 'disabled',
    });
    expect(posted.mock.calls.some(([message]) => message.operation === 'server-work-owner')).toBe(
      false
    );
    await expect(bound.value.readStaged(intent.requestId)).resolves.toEqual({
      state: 'ready',
      value: null,
    });
  });

  it('uses the exact admitted Core handoff and covers Server evidence at FULL', async () => {
    const f = await serverWorkWorkerFixture();
    let original = containmentBundle;
    const readContainmentEvidenceHandoff: NonNullable<
      NonNullable<
        Parameters<typeof f.writer.bindServerWorkOwner>[2]
      >['readContainmentEvidenceHandoff']
    > = (core, id) => {
      expect(core.sqlite.name).toBe(f.corePath);
      expect(core.sqlite.readonly).toBe(true);
      return id === containmentBundle.id ? original : null;
    };
    const bound = await f.writer.bindServerWorkOwner(f.root, serverWorkReaders, {
      readContainmentEvidenceHandoff,
    });
    if (bound.state !== 'ready') throw new Error('Expected admitted Server work.');
    const postMessage = Worker.prototype.postMessage;
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    await expect(bound.value.publishContainment('absent-handoff')).resolves.toEqual({
      state: 'ready',
      value: { state: 'unknown' },
    });
    expect(posted.mock.calls.some(([message]) => message.operation === 'server-work-owner')).toBe(
      false
    );

    posted.mockImplementationOnce(function (this: NativeWorker, message: ControlWorkerRequest) {
      if (message.operation !== 'server-work-owner') throw new Error('Expected local Server work.');
      return postMessage.call(this, { ...message, openingRequestId: message.openingRequestId + 1 });
    });
    await expect(bound.value.publishContainment(containmentBundle.id)).resolves.toEqual(
      serverWorkHeld
    );
    posted.mockRestore();

    Atomics.store(f.gate, 0, 0);
    let acknowledged = false;
    const publication = bound.value.publishContainment(containmentBundle.id).then((result) => {
      acknowledged = true;
      return result;
    });
    try {
      await waitForHold(f.gate);
      expect(acknowledged).toBe(false);
      expect(Atomics.load(f.gate, f.gate.length - 1)).toBe(2);
    } finally {
      release(f.gate);
    }
    await expect(publication).resolves.toEqual({ state: 'ready', value: { state: 'published' } });
    await expect(bound.value.publishContainment(containmentBundle.id)).resolves.toEqual({
      state: 'ready',
      value: { state: 'published' },
    });
    original = { ...containmentBundle, summary: 'A divergent handoff for the same ID.' };
    await expect(bound.value.publishContainment(containmentBundle.id)).resolves.toEqual({
      state: 'ready',
      value: { state: 'conflict' },
    });
    await f.writer.closeServerOwner(f.root, 'server-work');
    await expect(bound.value.publishContainment(containmentBundle.id)).resolves.toEqual(
      serverWorkHeld
    );
  });

  it('covers fresh, replayed and lost FULL Call claims', async () => {
    const f = await serverWorkWorkerFixture();
    const { intent, payload, decision, receipt } = originalServerCall();
    const originalReceiptIds = new Set<string>();
    const inspectServerWork: ControlKernelStore['inspectServerWork'] = async (original) => ({
      state: 'ready',
      value: originalReceiptIds.has(original.requestId)
        ? { state: 'settled', receipt: storageReceipt(original, decision) }
        : { state: 'unknown' },
    });
    const bound = await f.writer.bindServerWorkOwner(f.root, serverWorkReaders, {
      inspectServerWork,
    });
    if (bound.state !== 'ready') throw new Error('Expected admitted Server work.');
    const divergent: ServerWorkIntent = { ...intent, verb: 'settle-usage' };
    await expect(bound.value.stage(divergent, payload)).resolves.toEqual(serverWorkHeld);
    await expect(bound.value.stage(intent, payload)).resolves.toEqual({
      state: 'ready',
      value: intent,
    });
    await expect(bound.value.readStaged(intent.requestId)).resolves.toEqual({
      state: 'ready',
      value: { intent, payload, receipt: null },
    });
    await expect(bound.value.settle(receipt)).resolves.toEqual(serverWorkHeld);
    await expect(bound.value.claimCallContact(receipt)).resolves.toEqual(serverWorkHeld);
    originalReceiptIds.add(intent.requestId);
    await expect(
      bound.value.settle({ ...receipt, receiptDigest: `sha256:${'f'.repeat(64)}` })
    ).resolves.toEqual(serverWorkHeld);
    await expect(bound.value.settle(receipt)).resolves.toEqual(serverWorkAck);

    Atomics.store(f.gate, 0, 0);
    let acknowledged = false;
    const claim = bound.value.claimCallContact(receipt).then((result) => {
      acknowledged = true;
      return result;
    });
    try {
      await waitForHold(f.gate);
      expect(acknowledged).toBe(false);
      expect(Atomics.load(f.gate, f.gate.length - 1)).toBe(2);
    } finally {
      release(f.gate);
    }
    await expect(claim).resolves.toEqual({ state: 'ready', value: { state: 'claimed-now' } });
    await f.writer.closeServerOwner(f.root, 'server-work');
    const reopened = await f.writer.bindServerWorkOwner(f.root, serverWorkReaders, {
      inspectServerWork,
    });
    if (reopened.state !== 'ready') throw new Error('Expected retained Server work.');
    await expect(reopened.value.claimCallContact(receipt)).resolves.toEqual({
      state: 'ready',
      value: { state: 'inspect-original' },
    });

    const lost = originalServerCall('lost-contact-ack');
    originalReceiptIds.add(lost.intent.requestId);
    await expect(reopened.value.stage(lost.intent, lost.payload)).resolves.toEqual({
      state: 'ready',
      value: lost.intent,
    });
    await expect(reopened.value.settle(lost.receipt)).resolves.toEqual(serverWorkAck);
    Atomics.store(f.gate, 0, 0);
    Atomics.store(f.gate, 1, 0);
    const lostClaim = reopened.value.claimCallContact(lost.receipt);
    try {
      await waitForHold(f.gate);
      const read = new Database(serverStoragePath(f.root, 'server-work'), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(
          read
            .prepare('SELECT contact_claimed FROM server_work_intents WHERE request_id = ?')
            .pluck()
            .get(lost.intent.requestId)
        ).toBe(1);
      } finally {
        read.close();
      }
      await interception.workers[1]!.terminate();
    } finally {
      release(f.gate);
    }
    await expect(lostClaim).resolves.toEqual({
      state: 'ready',
      value: { state: 'inspect-original' },
    });
  });
});

const nanoHostReaders = {
  getWorkerBackendSession,
  hasQueuedNanoHostHarnessOperation,
  isEnrollmentAdministrator: isCurrentDeploymentAdministrator,
  listNanoHostTransportTokenRecords,
  prepareNanoHostRuntimeTargetTransition,
  readNanoHostEpochInvalidation,
  inspectNanoHostRuntimeTargetTransition,
  readPendingNanoHostEpochRetirement,
};

/** Uses the shipped journals and intercepts only the NanoHost file's real FULL commit. */
async function nanoHostWorkerFixture(
  serving: Parameters<ReturnType<typeof getControlStoreWorkerClient>['bindNanoHostOwner']>[2] = {
    enabled: () => true,
  },
  seed?: (path: string) => void,
  coreReads?: Int32Array
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'control-nanohost-')));
  roots.push(root);
  ensureLayout(root);
  const corePath = coreDbPath(root);
  if (coreReads) interception.coreReadProbe = { path: corePath, reads: coreReads };
  const path = serverStoragePath(root, 'nanohost');
  const database = `server-owner:${path}`;
  const gate = new Int32Array(new SharedArrayBuffer(4 * (6 + path.length)));
  interception.gate = gate.buffer as SharedArrayBuffer;
  interception.point = 'after';
  Atomics.store(gate, 2, 2);
  Atomics.store(gate, 3, 1);
  Atomics.store(gate, 4, path.length);
  for (let index = 0; index < path.length; index++)
    Atomics.store(gate, 5 + index, path.charCodeAt(index));
  // Leave explicit provisioning outside the fault.
  Atomics.store(gate, 0, 1);

  const writer = getControlStoreWorkerClient();
  client = writer;
  const coreKey = `core:${corePath}`;
  await writer.open({
    database: coreKey,
    path: corePath,
    create: true,
    initialize: 'core',
    productOwner: { kind: 'server' },
    dataRoot: root,
  });
  await expect(
    writer.bindNanoHostOwner(root, nanoHostReaders, { enabled: () => false })
  ).resolves.toEqual({
    state: 'unavailable',
    owner: 'nanohost',
    reason: 'disabled',
  });
  await expect(writer.bindNanoHostOwner(root, nanoHostReaders, serving)).resolves.toEqual({
    state: 'unavailable',
    owner: 'nanohost',
    reason: 'missing',
  });
  expect(existsSync(path)).toBe(false);
  await expect(writer.provisionServerOwner(root, nanoHostStoreDescriptor)).resolves.toEqual({
    state: 'ready',
    owner: 'nanohost',
  });
  await writer.closeServerOwner(root, 'nanohost');

  seed?.(path);
  const bound = await writer.bindNanoHostOwner(root, nanoHostReaders, serving);
  if (bound.state !== 'ready') throw new Error('Expected the existing NanoHost owner to bind.');
  return { writer, root, path, database, gate, owner: bound.value, coreKey, corePath, serving };
}

async function prepareNanoHostTarget(
  owner: Awaited<ReturnType<typeof nanoHostWorkerFixture>>['owner'],
  input: ControlRuntimeTargetInput
) {
  const prepared = await owner.prepareRuntimeTarget(input, crypto.randomUUID());
  if (prepared.state !== 'ready') throw new Error('Expected the original NanoHost target tuple.');
  return prepared.value;
}

function expectNanoHostTablesAbsent(path: string, ...tables: string[]) {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const table = sqlite.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?"
    );
    for (const name of tables) {
      // This base still creates the NanoHost tables in Core. Absence and an empty table both
      // prove the fixture wrote no Core rows; any row is a failure.
      if (table.pluck().get(name) === undefined) continue;
      if (!/^[A-Za-z_]+$/.test(name)) throw new Error(`Unexpected table name: ${name}`);
      expect(sqlite.prepare(`SELECT COUNT(*) FROM "${name}"`).pluck().get(), name).toBe(0);
    }
  } finally {
    sqlite.close();
  }
}

const nanoHostTarget = {
  kind: 'allocate',
  targetId: 'fixture-target',
  identityId: 'fixture-identity',
  deploymentId: 'fixture-deployment',
  observedAt: '2026-11-21T00:00:00.000Z',
} as const;
const nanoHostReady = {
  ...nanoHostTarget,
  kind: 'ready',
  connectionGeneration: 1,
  predecessorFenced: true,
  ready: true,
  freshEmpty: true,
  physicalEpoch: 'a'.repeat(64),
} as const;
const nanoHostPlacement = {
  deploymentId: nanoHostTarget.deploymentId,
  runtimeTargetId: nanoHostTarget.targetId,
  physicalEpoch: nanoHostReady.physicalEpoch,
  generation: '1',
};
const nanoHostOccurrence = vaultEpochFenceOccurrence(nanoHostPlacement);
const nanoHostFenceTarget = {
  runtimeTargetId: nanoHostPlacement.runtimeTargetId,
  physicalEpoch: nanoHostPlacement.physicalEpoch,
  holderReceiptIds: ['holder-a', 'holder-b'],
};
const nanoHostIntent = {
  ...nanoHostOccurrence,
  requestId: storageRequestId(nanoHostOccurrence),
  expectedGeneration: nanoHostPlacement.generation,
  inputDigest: sha256CanonicalJson(nanoHostFenceTarget),
  target: nanoHostFenceTarget,
};
const nanoHostReceipt = storageReceipt(nanoHostIntent, {
  disposition: 'applied',
  result: { fencedHolderReceiptIds: ['holder-b', 'holder-a'] },
});
const nanoHostHeld = { state: 'unavailable', owner: 'nanohost', reason: 'recovery-required' };
const nanoHostAck = { state: 'ready', value: undefined };

const nanoHostKernelHeld = {
  state: 'unavailable',
  owner: 'control-kernel',
  reason: 'recovery-required',
};
const nanoHostUnknownKernel: NanoHostRuntimeTargetEpochKernel = {
  async reserveHolderIntent() {
    return { state: 'ready', value: null };
  },
  async inspectNanoHostEpochFence() {
    return { state: 'ready', value: { state: 'unknown' } };
  },
  async fenceNanoHostEpoch() {
    throw new Error('Unknown receipt cannot authorize a new fence.');
  },
};

describe('admitted NanoHost owner worker', () => {
  it('holds mixed Core Harness, backend and storage mutations before their physical SQL', async () => {
    const coreReads = new Int32Array(new SharedArrayBuffer(4));
    const f = await nanoHostWorkerFixture(undefined, undefined, coreReads);
    const refusal = { code: 'owner-recovery-required', commit: 'not-committed' };
    await expect(
      f.writer.harnessLifecycle(f.coreKey, {
        kind: 'sandbox.restore-admission',
        sandboxRuntimeId: 'original-sandbox',
      })
    ).rejects.toMatchObject(refusal);
    await expect(
      f.writer.harnessLifecycle(f.coreKey, {
        kind: 'operation.dispatch',
        sandboxIntegrationBindingRef: 'original-integration',
      })
    ).rejects.toMatchObject(refusal);
    const beforeLaunch = Atomics.load(coreReads, 0);
    await expect(
      f.writer.backendSession(f.coreKey, {
        kind: 'launching',
        attemptId: allocateEntityId('attempt'),
      })
    ).rejects.toMatchObject(refusal);
    expect(Atomics.load(coreReads, 0) - beforeLaunch).toBe(0);
    await expect(
      f.writer.workerStorageBinding(f.coreKey, {
        kind: 'purge-pending',
        storageRef: 'original-storage',
        expectedRevision: 1,
        schedulerRows: [],
      })
    ).rejects.toMatchObject(refusal);
    expectNanoHostTablesAbsent(
      f.corePath,
      'harness_instance_records',
      'worker_backend_sessions',
      'worker_storage_bindings'
    );
  });

  it('holds the original Core Login observation before the Native binding read', async () => {
    const f = await nanoHostWorkerFixture();
    // Reopen through Vault's existing Core product descriptor and its content mount.
    await f.writer.close(f.coreKey);
    const core = openCoreDb(f.root);
    nativeHandles.push(core);
    const runtimeBinding = 'original-runtime-binding';
    const now = nanoHostTarget.observedAt;
    await expect(
      f.writer.vault(core, 'reference-login-observe', {
        context: {
          workspaceId: DEMO_WORKSPACE_ID,
          threadId: DEMO_THREAD_ID,
          agentSessionId: allocateEntityId('as'),
          agentSessionRuntimeBindingId: runtimeBinding,
          packageSnapshotId: 'original-package',
          turnId: allocateEntityId('tu'),
          leaseId: allocateEntityId('attempt'),
          turnSequence: 0,
          runtimeTargetId: nanoHostTarget.targetId,
          physicalEpoch: 'a'.repeat(64),
          connectionGeneration: 1,
        },
        referenceId: allocateEntityId('vault'),
        grantId: 'original-grant',
        planId: 'original-plan',
        receiptId: 'original-receipt',
        materialGeneration: 1,
        accountId: 'original-test-account',
        now: () => now,
        observations: {
          state: 'unknown',
          windows: [],
          source: 'native-read',
          observedAt: now,
          bindingId: runtimeBinding,
          materialGeneration: 1,
        },
      })
    ).rejects.toMatchObject({ code: 'owner-recovery-required', commit: 'not-committed' });
  });

  it('places rejected Worker evidence only on the admitted Native owner and holds retired openings', async () => {
    const f = await nanoHostWorkerFixture();
    const row = {
      rejectionId: randomUUID(),
      workspaceId: allocateEntityId('ws'),
      threadId: allocateEntityId('th'),
      turnId: allocateEntityId('tu'),
      agentSessionId: allocateEntityId('as'),
      packageSnapshotId: 'original-package',
      requestId: null,
      route: '/worker/heartbeat',
      operation: 'heartbeat',
      errorCode: 'worker_control_lease_not_live',
      httpStatus: 403,
      message: 'The original lease is closed.',
      rejectedAt: nanoHostTarget.observedAt,
    };
    await expect(f.writer.runtimeTarget(f.coreKey, nanoHostTarget)).rejects.toMatchObject({
      code: 'owner-recovery-required',
      commit: 'not-committed',
    });
    await expect(
      f.writer.executionAttempt(f.coreKey, {
        kind: 'native-reconnect-arm',
        attemptId: allocateEntityId('attempt'),
        classifiedAt: nanoHostTarget.observedAt,
        expectedRecoveryDeadline: null,
      })
    ).rejects.toMatchObject({
      code: 'owner-recovery-required',
      commit: 'not-committed',
    });
    await expect(f.writer.workerControlEvidence(f.coreKey, row)).resolves.toBeUndefined();
    expect(
      f.owner.read((sqlite) =>
        sqlite.prepare('SELECT rejection_id FROM worker_control_rejected_evidence').pluck().all()
      )
    ).toEqual({ state: 'ready', value: [row.rejectionId] });
    expectNanoHostTablesAbsent(f.corePath, 'worker_control_rejected_evidence');
    await f.writer.closeServerOwner(f.root, 'nanohost');
    await expect(f.writer.workerControlEvidence(f.coreKey, row)).rejects.toMatchObject({
      code: 'owner-recovery-required',
      commit: 'not-committed',
    });
  });

  it.each(['live Native materialization', 'self-check final replay'])(
    'uses the original Core preparation for %s',
    async (path) => {
      const selfCheck = path === 'self-check final replay';
      vi.stubEnv('OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR', selfCheck ? '1' : '0');
      try {
        let workspaceHandoff = false;
        const f = await nanoHostWorkerFixture({
          enabled: () => true,
          verifyWorkspaceHandoff: () => workspaceHandoff,
        });
        const core = openCoreDb(f.root);
        nativeHandles.push(core);
        const workspaceId = DEMO_WORKSPACE_ID;
        const ownerUserId = ensureLocalUser(core);
        recordWorkspaceOwnerMembership({ coreDb: core, workspaceId, ownerUserId });
        const triggerActor = { kind: 'user' as const, id: ownerUserId };
        if (!selfCheck) ensureWorkspaceLayout(f.root, workspaceId);
        const workspace = selfCheck ? null : openWorkspaceDb(f.root, workspaceId);
        if (workspace) {
          nativeHandles.push(workspace);
          applyScopedMigrations(workspace);
          const scope = nativeProductScope(f.root, { kind: 'workspace', workspaceId });
          await f.writer.open({
            database: `workspace:${scope.path}`,
            path: scope.path,
            dataRoot: f.root,
            create: false,
            initialize: 'workspace',
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          });
        }
        const pkg = workspace
          ? await recordTestAgentEnvironmentPackage(workspace, {
              suffix: 'worker_submission',
              triggerActor,
              workspaceInputIds: ['repo'],
            })
          : null;
        const turnId = pkg?.scope.turnId ?? allocateEntityId('tu');
        const threadId = pkg?.scope.threadId ?? DEMO_THREAD_ID;
        const agentSessionId = pkg?.scope.agentSessionId ?? allocateEntityId('as');
        const packageSnapshotId = pkg?.snapshotId ?? 'self-check-package-original';
        const sandboxBindingRef = 'self-check-sandbox-original';
        const when = new Date().toISOString();
        const entry = createSchedulerAdmissionEntry(core, {
          queueEntryId: 'self-check-worker-route',
          backendId: 'nanohost',
          triggerActor,
          workspaceId,
          threadId,
          turnId,
          inputRef: schedulerFixtureInput(workspaceId, turnId, 'Native self-check worker route.'),
          requestedAgentId: 'agent_worker',
        });
        const attempt = createSchedulerExecutionAttempt(core, {
          entry,
          preparationInput: { admission: entry },
          now: () => when,
        });
        await f.writer.executionAttempt(f.coreKey, {
          kind: 'bind-session',
          attemptId: attempt.attemptId,
          agentSessionId,
          observedAt: when,
        });
        await f.writer.executionAttempt(f.coreKey, {
          kind: 'finalize-input',
          attemptId: attempt.attemptId,
          inputRef: packageSnapshotId,
          bindingRef: sandboxBindingRef,
          observedAt: when,
        });
        const deploymentId = readDataRootLayoutMarker(f.root).deploymentId;
        const kernel = f.writer.nanoHostEpochKernel(core);
        for (const target of [nanoHostTarget, nanoHostReady]) {
          const command = await prepareNanoHostTarget(f.owner, { ...target, deploymentId });
          await expect(f.owner.transitionRuntimeTarget(kernel, command)).resolves.toMatchObject({
            state: 'ready',
          });
        }

        const materializing = {
          kind: 'materializing',
          identity: {
            agentSessionId,
            backendKind: 'openshell',
            backendSessionId: `self-check_${packageSnapshotId}`,
            deploymentId,
            packageSnapshotId,
            runtimeTargetId: nanoHostTarget.targetId,
            stagingDirectoryRef: 'self-check-workspace-staging',
            transientProviderInstanceId: null,
          },
          backendVersion: pkg ? '0.0.80' : null,
          backendLineage: { kind: 'reference', imageRef: 'fixture-image' },
          lineage: { threadId, turnId, workspaceId },
          sandboxBindingRef,
          observedAt: when,
        } as const;
        await expect(
          f.writer.backendSession(f.coreKey, {
            ...materializing,
            sandboxBindingRef: 'different-binding',
          })
        ).rejects.toMatchObject({ code: 'owner-recovery-required', commit: 'not-committed' });
        expect(
          f.owner.read((sqlite) =>
            sqlite.prepare('SELECT attempt_id FROM worker_backend_sessions').all()
          )
        ).toEqual({ state: 'ready', value: [] });
        if (!selfCheck) Atomics.store(f.gate, 0, 0);
        const materialized = f.writer.backendSession(f.coreKey, materializing);
        try {
          if (!selfCheck) {
            await waitForHold(f.gate);
            expect(f.owner.readRuntimeTarget(nanoHostTarget.targetId)).toMatchObject({
              state: 'ready',
              value: { connectionGeneration: 1, ready: true, deploymentId },
            });
            expect(f.owner.read(() => true)).toMatchObject({ state: 'unavailable' });
          }
        } finally {
          release(f.gate);
        }
        await expect(materialized).resolves.toMatchObject({
          attemptId: attempt.attemptId,
          state: 'materializing',
        });
        expect(
          f.owner.read((sqlite) =>
            sqlite.prepare('SELECT attempt_id FROM worker_backend_sessions').all()
          )
        ).toEqual({ state: 'ready', value: [{ attempt_id: attempt.attemptId }] });
        const backend = { attemptId: attempt.attemptId, observedAt: when };
        if (!selfCheck) {
          const attachment = {
            kind: 'create-and-reserve' as const,
            workspaceId,
            threadId,
            agentSessionId,
            responsibleUserId: ownerUserId,
            purpose: 'work' as const,
            storageRef: 'original-live-attachment',
            runtimeTargetId: nanoHostTarget.targetId,
            deploymentId,
            layout: {
              family: 'openkit-worker',
              version: '1',
              uid: 1000,
              gid: 1000,
              workingDirectory: '/workspace',
              platform: { architecture: 'amd64', os: 'linux' },
              targets: [{ target: '/workspace' }],
            },
            expectedRevision: 1,
            now: when,
          };
          const contributor = prepareWorkerStorageContributor(
            { storageRef: attachment.storageRef, workspaceId, contributors: [] },
            attachment,
            when,
            1
          );
          const guard = vi.fn(() => true);
          Atomics.store(f.gate, 1, 0);
          Atomics.store(f.gate, 0, 0);
          const reserving = f.owner.writeStorageAttachment(
            { ...attachment, authorizedContributorRefs: [contributor.contributorRef] },
            { attemptId: attempt.attemptId, verifyBeforePost: guard }
          );
          try {
            await waitForHold(f.gate);
            expect(f.owner.readRuntimeTarget(nanoHostTarget.targetId)).toMatchObject({
              state: 'ready',
              value: { connectionGeneration: 1, ready: true, deploymentId },
            });
            expect(f.owner.read(() => true)).toMatchObject({ state: 'unavailable' });
          } finally {
            release(f.gate);
          }
          await expect(reserving).resolves.toMatchObject({ state: 'reserved' });
          expect(guard).toHaveBeenCalledTimes(1);
          await expect(
            f.writer.backendSession(f.coreKey, {
              kind: 'transition',
              fromState: 'materializing',
              toState: 'launching',
              ...backend,
            })
          ).rejects.toMatchObject({ code: 'owner-recovery-required', commit: 'not-committed' });
          await expect(
            f.writer.backendSession(f.coreKey, {
              kind: 'transition',
              fromState: 'materializing',
              toState: 'materialized',
              ...backend,
            })
          ).resolves.toMatchObject({ state: 'materialized', workspaceHandoffState: 'pending' });
          await expect(
            f.writer.backendSession(f.coreKey, { kind: 'handoff', ...backend })
          ).rejects.toMatchObject({ code: 'precondition', commit: 'not-committed' });
          workspaceHandoff = true;
          await expect(
            f.writer.backendSession(f.coreKey, { kind: 'handoff', ...backend })
          ).resolves.toMatchObject({ state: 'materialized', workspaceHandoffState: 'complete' });
          if (!workspace || !pkg) throw new Error('Expected the original Workspace package.');
          await expect(f.owner.firstSubmission(backend)).rejects.toThrow(
            'The original execution grant is unavailable.'
          );
          expect(requireSchedulerExecutionAttempt(core, attempt.attemptId).operationId).toBeNull();
          const inputSnapshots = buildWorkspaceInputSnapshots({
            backendCapabilities: ['trusted-worker-inference-relay'],
            backendKind: 'openshell',
            createdAt: when,
            environmentPackage: pkg,
          });
          await recordWorkspaceBackendHandoff(
            workspace,
            inputSnapshots,
            buildWorkspaceMaterializationRecords({
              createdAt: when,
              inputSnapshots,
              materialization: {
                backendKind: 'openshell',
                backendStatus: { health: 'ready', version: materializing.backendVersion! },
                packageSnapshotId,
                requiredCapabilities: pkg.backend.requiredCapabilities,
                sandbox: { name: materializing.identity.backendSessionId, state: 'created' },
                workspaceInputs: pkg.workspace.inputs.map(({ id, target }) => ({ id, target })),
              },
            })
          );
          Atomics.store(f.gate, 3, 0);
          Atomics.store(f.gate, 4, f.corePath.length);
          for (let index = 0; index < f.corePath.length; index++)
            Atomics.store(f.gate, 5 + index, f.corePath.charCodeAt(index));
          Atomics.store(f.gate, 1, 0);
          Atomics.store(f.gate, 0, 0);
          const submission = f.owner.firstSubmission(backend);
          let acknowledged = false;
          void submission.then(
            () => {
              acknowledged = true;
            },
            () => {}
          );
          try {
            await waitForHold(f.gate);
            expect(Atomics.load(f.gate, f.gate.length - 1)).toBe(2);
            expect(acknowledged).toBe(false);
            expect(requireSchedulerExecutionAttempt(core, attempt.attemptId).operationId).toBe(
              commandInputHash({
                attemptId: attempt.attemptId,
                inputRef: packageSnapshotId,
                operation: 'submit',
              })
            );
            await expect(f.writer.pauseForDataRootBackup()).rejects.toMatchObject({
              code: 'busy',
              commit: 'not-committed',
            });
            await expect(f.owner.firstSubmission(backend)).rejects.toMatchObject({
              code: 'busy',
              commit: 'not-committed',
            });
          } finally {
            release(f.gate);
          }
          const original = await submission;
          expect(original.state).toBe('admitted-now');
          await expect(f.owner.firstSubmission(backend)).resolves.toEqual({
            state: 'inspect-original',
            attempt: original.attempt,
          });
          expectNanoHostTablesAbsent(f.corePath, 'worker_backend_sessions');
          await f.writer.closeServerOwner(f.root, 'nanohost');
          expect(f.owner.readRuntimeTarget(nanoHostTarget.targetId)).toMatchObject({
            state: 'unavailable',
          });
          return;
        }
        await f.writer.backendSession(f.coreKey, { kind: 'handoff', ...backend });
        await f.writer.backendSession(f.coreKey, {
          kind: 'transition',
          fromState: 'materializing',
          toState: 'materialized',
          ...backend,
        });

        core.sqlite
          .prepare(
            "UPDATE scheduler_execution_attempts SET disposition='accepted', operation_id=? WHERE attempt_id=?"
          )
          .run(
            commandInputHash({
              attemptId: attempt.attemptId,
              inputRef: packageSnapshotId,
              operation: 'submit',
            }),
            attempt.attemptId
          );
        const final = {
          kind: 'simulator-final',
          attemptId: attempt.attemptId,
          acceptedAt: when,
          lineage: {
            agentSessionId,
            packageSnapshotId,
            threadId,
            turnId,
            workspaceId,
            requestId: null,
          },
        } as const;
        const original = await f.writer.executionAttempt(f.coreKey, final);
        expect(original).toMatchObject({ attemptId: attempt.attemptId, disposition: 'accepted' });
        await expect(f.writer.executionAttempt(f.coreKey, final)).resolves.toEqual(original);
        vi.stubEnv('OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR', '0');
        await expect(f.writer.executionAttempt(f.coreKey, final)).rejects.toMatchObject({
          code: 'owner-recovery-required',
          commit: 'not-committed',
        });
        expect(
          f.owner.read((sqlite) =>
            sqlite.prepare('SELECT operation, record_key FROM worker_control_records').all()
          )
        ).toEqual({ state: 'ready', value: [{ operation: 'final_status', record_key: '1' }] });
        expectNanoHostTablesAbsent(f.corePath, 'worker_backend_sessions', 'worker_control_records');
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it('joins the restart window and preflight hold to the original Core grant and current Native opening', async () => {
    const workspaceId = allocateEntityId('ws');
    const threadId = allocateEntityId('th');
    const turnId = allocateEntityId('tu');
    const agentSessionId = allocateEntityId('as');
    const attemptId = allocateEntityId('attempt');
    const inputRef = 'joined-recovery-package';
    const bindingRef = 'joined-recovery-binding';
    const operationId = commandInputHash({ attemptId, inputRef, operation: 'submit' });
    const started = new Date().toISOString();
    const now = () => started;
    const f = await nanoHostWorkerFixture();
    const core = openCoreDb(f.root);
    nativeHandles.push(core);
    const ownerUserId = ensureLocalUser(core);
    recordWorkspaceOwnerMembership({ coreDb: core, workspaceId, ownerUserId });
    const entry = createSchedulerAdmissionEntry(core, {
      backendId: 'nanohost',
      queueEntryId: 'joined-recovery-queue',
      triggerActor: { kind: 'user', id: ownerUserId },
      requestedAgentId: 'agent_worker',
      workspaceId,
      threadId,
      turnId,
      inputRef: schedulerFixtureInput(workspaceId, turnId, 'The original admitted input'),
    });
    createSchedulerExecutionAttempt(core, {
      entry,
      attemptId,
      preparationInput: { admission: entry },
      now,
    });
    bindSchedulerExecutionAttemptSession(core, { attemptId, agentSessionId, now });
    finalizeSchedulerExecutionAttemptInput(core, { attemptId, inputRef, bindingRef, now });
    const attempt = recordSchedulerExecutionOperation(core, {
      attemptId,
      operationId,
      submission: true,
      now,
    });
    if (!attempt.deadline) throw new Error('Fixture did not submit its exact attempt.');
    const grant = {
      execution: { owner: { kind: 'server' as const }, executionId: attemptId },
      backendId: 'nanohost',
      operationId,
      attemptId,
      turnId,
      inputRef,
      bindingRef,
      generation: '1',
      deadline: attempt.deadline,
    };
    const recoveryDeadline = new Date(
      Math.min(Date.parse(grant.deadline), Date.parse(started) + 300_000)
    ).toISOString();
    const startupDeadline = new Date(Date.parse(started) + 15_000).toISOString();
    const recovery = {
      version: 1,
      sessionCompatibilityKey: 'joined-worker',
      startupDeadline,
      heartbeatDeadline: startupDeadline,
      heartbeatTimeoutMs: 15_000,
      lastAcceptedHeartbeatAt: started,
      lastWorkerSequence: 1,
      workerProcessKeyHash: 'a'.repeat(43),
      recoveryState: null,
      recoveryDeadline: null,
    };
    const seed = () => {
      const sqlite = new Database(f.path, { fileMustExist: true });
      try {
        sqlite
          .prepare(`INSERT INTO worker_backend_sessions (
          attempt_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
          backend_kind, deployment_id, backend_session_id, staging_directory_ref,
          workspace_handoff_state, state, created_at, updated_at, runtime_target_id,
          origin_physical_epoch, backend_lineage_json, sandbox_binding_ref, worker_route_binding_json,
          worker_recovery_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'openshell', ?, 'joined-backend', 'joined-staging',
                  'complete', 'launching', ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            attemptId,
            workspaceId,
            threadId,
            turnId,
            agentSessionId,
            inputRef,
            readDataRootLayoutMarker(f.root).deploymentId,
            started,
            started,
            nanoHostTarget.targetId,
            nanoHostReady.physicalEpoch,
            JSON.stringify({ imageRef: 'registry.invalid/worker' }),
            bindingRef,
            canonicalJsonText({
              version: 1,
              operationId,
              generation: '1',
              deadline: grant.deadline,
              control: 'a'.repeat(64),
              inference: 'b'.repeat(64),
              capability: 'c'.repeat(64),
              harnessInstanceId: 'joined-harness',
              harnessOperationId: 'd'.repeat(64),
              harnessSequence: 1,
            }),
            canonicalJsonText(recovery)
          );
      } finally {
        sqlite.close();
      }
    };
    await f.writer.closeServerOwner(f.root, 'nanohost');
    seed();
    const selected = await prepareNanoHostOwner(core, f.serving);
    if (selected.state !== 'ready') throw new Error('Expected the acknowledged NanoHost owner.');
    expect(readNanoHostRestartCensus(core, selected, started)).toEqual(nanoHostHeld);

    const rootSpan = {
      traceId: '1'.repeat(32),
      spanId: '1'.repeat(16),
      flags: 1,
      name: 'Joined worker attempt',
      kind: 'INTERNAL' as const,
      startTimeUnixNano: BigInt(Date.parse(started)) * 1_000_000n,
      endTimeUnixNano: null,
      status: { code: 'UNSET' as const },
      attributes: [],
      droppedAttributesCount: 0,
      events: [],
      droppedEventsCount: 0,
      links: [],
      droppedLinksCount: 0,
      instrumentationScope: { name: 'openkit.fixture', attributes: [], droppedAttributesCount: 0 },
      resource: { attributes: [], droppedAttributesCount: 0 },
    };
    const proposal: ExecutionJournalIntent = {
      execution: {
        ref: grant.execution,
        definitionVersion: CORE_SCHEDULER_EXECUTION_DEFINITION,
        workId: turnId,
        fingerprint: entry.inputHash,
        exclusionRefs: [`turn:${turnId}`],
        span: rootSpan,
      },
      stepId: 'original-submission',
      parentStepId: null,
      parent: null,
      inspectedStep: null,
      carriage: { operation: 'turn.start', requestId: operationId, sequence: null, bindingRef },
      control: {
        definitionVersion: CORE_SCHEDULER_EXECUTION_DEFINITION,
        kind: 'admit',
        target: null,
        workId: turnId,
        operationId,
        attemptId,
        invocationId: operationId,
        actor: entry.triggerActor,
        inputRefs: [inputRef],
        outputRefs: [],
        fingerprint: entry.inputHash,
        permittingDecisionRef: null,
        authorityRefs: [],
        retryDeclarationRef: null,
        retryPermitted: false,
        deadlineUnixNano: BigInt(Date.parse(grant.deadline)) * 1_000_000n,
        physicalFenceRefs: [],
      },
      span: { ...rootSpan, spanId: '2'.repeat(16), parentSpanId: rootSpan.spanId },
    };
    expect(
      core.sqlite.transaction(() =>
        admitKernelSchedulerGrantInDb(core, proposal, grant, () => true, true)
      )()
    ).toMatchObject({ state: 'settled', receipt: grant });
    expect(readNanoHostRestartCensus(core, selected, started)).toEqual({
      state: 'ready',
      value: [],
    });
    const readCurrent = (owner: typeof selected.value.owner) =>
      owner.read((sqlite) =>
        readAdmittedNanoHostAttempt(core, sqlite, requireSchedulerExecutionAttempt(core, attemptId))
      );
    const initial = readCurrent(selected.value.owner);
    if (initial.state !== 'ready') throw new Error('Expected the exact Native observation.');
    const arm = {
      lease: initial.value.lease,
      expectedSession: initial.value.session,
      expectedRecovery: initial.value.proof,
      kind: 'arm-reconnect',
      classifiedAt: started,
      observedAt: started,
    } as const;
    await expect(
      selected.value.owner.classifyRecovery({
        ...arm,
        lease: { ...arm.lease, grant: { ...arm.lease.grant, generation: '2' } },
      })
    ).resolves.toMatchObject({ state: 'unavailable', reason: 'recovery-required' });
    expect(readCurrent(selected.value.owner)).toEqual(initial);
    await expect(selected.value.owner.classifyRecovery(arm)).resolves.toMatchObject({
      state: 'ready',
      value: { attemptId, state: 'launching' },
    });
    expect(readNanoHostRestartCensus(core, selected, started)).toEqual({
      state: 'ready',
      value: [expect.objectContaining({ grant })],
    });
    expect(readNanoHostRestartCensus(core, selected, recoveryDeadline)).toEqual({
      state: 'ready',
      value: [],
    });

    const observed = readCurrent(selected.value.owner);
    if (observed.state !== 'ready') throw new Error('Expected the exact Native observation.');
    const { lease, session, proof } = observed.value;
    const close = { lease, session, proof, cause: 'native-cleanup', observedAt: started };
    await expect(
      selected.value.owner.closeRecovery({
        ...close,
        proof: { ...proof, lastWorkerSequence: 2 },
      })
    ).resolves.toMatchObject({ state: 'unavailable', reason: 'recovery-required' });
    expect(requireSchedulerExecutionAttempt(core, attemptId).phase).toBe('open');
    await expect(selected.value.owner.closeRecovery(close)).resolves.toMatchObject({
      state: 'ready',
      value: { attemptId, phase: 'closing', terminalCause: 'native-cleanup' },
    });
    const retained = requireSchedulerExecutionAttempt(core, attemptId);
    await expect(
      selected.value.owner.closeRecovery({ ...close, observedAt: recoveryDeadline })
    ).resolves.toEqual({ state: 'ready', value: retained });
    await expect(
      selected.value.owner.closeRecovery({ ...close, cause: 'other-observation' })
    ).resolves.toMatchObject({ state: 'unavailable', reason: 'recovery-required' });
    expect(requireSchedulerExecutionAttempt(core, attemptId)).toEqual(retained);
    const store = new FsStore({ dataRoot: f.root });
    const preflight = () =>
      observeAppUpdatePreflight({ coreDb: core, store, inflightCommands: new WeakMap() });
    expect(preflight()).toMatchObject({ state: 'busy', counts: { closingAttempts: 1 } });
    await f.writer.closeServerOwner(f.root, 'nanohost');
    expect(preflight()).toMatchObject({ state: 'busy', counts: { closingAttempts: 1 } });
    const reopened = await prepareNanoHostOwner(core, f.serving);
    if (reopened.state !== 'ready') throw new Error('Expected the original NanoHost owner.');
    expect(readNanoHostRestartCensus(core, selected, started)).toEqual(nanoHostHeld);
    const pending = readCurrent(reopened.value.owner);
    if (pending.state !== 'ready') throw new Error('Expected the original recovery observation.');
    await expect(
      reopened.value.owner.classifyRecovery({
        lease: pending.value.lease,
        expectedSession: pending.value.session,
        expectedRecovery: pending.value.proof,
        kind: 'needs-evidence',
        observedAt: started,
      })
    ).resolves.toMatchObject({ state: 'ready', value: { attemptId } });
    expect(preflight()).toMatchObject({ state: 'idle', counts: { closingAttempts: 0 } });
  });

  it('covers the original NanoHost restart fence with the actual Core worker receipt', async () => {
    const f = await nanoHostWorkerFixture();
    const core = openCoreReadDb(f.root);
    try {
      const kernel = f.writer.nanoHostEpochKernel(core);
      const deploymentId = readDataRootLayoutMarker(f.root).deploymentId;
      const allocation = await prepareNanoHostTarget(f.owner, { ...nanoHostTarget, deploymentId });
      await expect(f.owner.transitionRuntimeTarget(kernel, allocation)).resolves.toMatchObject({
        state: 'ready',
        value: { connectionGeneration: 1, ready: false },
      });
      const readiness = await prepareNanoHostTarget(f.owner, { ...nanoHostReady, deploymentId });
      await expect(f.owner.transitionRuntimeTarget(kernel, readiness)).resolves.toMatchObject({
        state: 'ready',
        value: { connectionGeneration: 1, ready: true },
      });

      const placement = { ...nanoHostPlacement, deploymentId };
      await expect(kernel.reserveHolderIntent(placement)).resolves.toEqual(nanoHostKernelHeld);
      const restart = await prepareNanoHostTarget(f.owner, {
        kind: 'restart',
        observedAt: '2026-11-21T00:00:01.000Z',
      });
      expect(restart.retirement).toEqual(placement);
      const closed = await f.owner.transitionRuntimeTarget(
        {
          ...kernel,
          async reserveHolderIntent(original) {
            await expect(
              f.writer.pauseForDataRootBackup().then((resume) => resume())
            ).rejects.toMatchObject({ code: 'busy', commit: 'not-committed' });
            return kernel.reserveHolderIntent(original);
          },
        },
        restart
      );
      expect(closed).toMatchObject({ state: 'ready', value: { ready: false } });
      await expect(f.owner.transitionRuntimeTarget(kernel, restart)).resolves.toEqual(closed);

      const requestId = storageRequestId(vaultEpochFenceOccurrence(placement));
      const staged = await f.owner.readEpochInvalidation(requestId);
      expect(staged).toMatchObject({ state: 'ready', value: { target: { holderReceiptIds: [] } } });
      if (staged.state !== 'ready' || !staged.value)
        throw new Error('The admitted restart did not retain its original fence.');
      await f.writer.closeServerOwner(f.root, 'nanohost');
      await expect(kernel.inspectNanoHostEpochFence(staged.value)).resolves.toMatchObject({
        state: 'ready',
        value: {
          state: 'settled',
          receipt: {
            disposition: 'applied',
            intent: staged.value,
            result: { fencedHolderReceiptIds: [] },
          },
        },
      });
    } finally {
      core.sqlite.close();
    }
  });

  it('ACKs local transport at FULL and leaves deciding administrator authority and both Audit tuples on Core', async () => {
    const f = await nanoHostWorkerFixture();
    const input: Extract<ControlNanoHostTransportInput, { kind: 'enroll' }> = {
      kind: 'enroll',
      record: {
        tokenId: 'fixture-token',
        tokenHash: `sha256:${'b'.repeat(64)}`,
        ownerNanoHostIdentityId: nanoHostTarget.identityId,
        deploymentId: nanoHostTarget.deploymentId,
        responsibleServerAdminActorId: 'fixture-admin',
        expiresAt: '2026-12-01T00:00:00.000Z',
        now: new Date(nanoHostTarget.observedAt),
      },
    };
    const precondition = { code: 'precondition', commit: 'not-committed' };
    await expect(
      f.owner.transport({ ...input, actor: { kind: 'local', userId: 'fixture-admin' } })
    ).rejects.toMatchObject(precondition);
    await expect(f.owner.listTransportTokens()).resolves.toEqual({ state: 'ready', value: [] });

    Atomics.store(f.gate, 0, 0);
    let acknowledged = false;
    const enrollment = f.owner.transport(input).then((outcome) => {
      acknowledged = true;
      return outcome;
    });
    const drain = await (async () => {
      try {
        await waitForHold(f.gate);
        expect(Atomics.load(f.gate, f.gate.length - 1)).toBe(2);
        expect(acknowledged).toBe(false);
        await expect(f.owner.listTransportTokens()).resolves.toEqual(nanoHostHeld);
        let drained = false;
        const captured = f.writer.pauseForDataRootBackup(f.database).then((resume) => {
          drained = true;
          return resume;
        });
        await expect(f.writer.checkpoint(f.coreKey)).resolves.toBeDefined();
        expect(drained).toBe(false);
        return { captured };
      } finally {
        release(f.gate);
      }
    })();
    const resume = await drain.captured;
    resume();
    const enrolled = await enrollment;
    if (enrolled.kind !== 'record' || !enrolled.record)
      throw new Error('Expected a committed NanoHost enrollment.');
    expect(enrolled.record).toMatchObject({ tokenId: input.record.tokenId, status: 'active' });
    expect(enrolled.record).not.toHaveProperty('tokenHash');
    await expect(f.owner.listTransportTokens()).resolves.toEqual({
      state: 'ready',
      value: [enrolled.record],
    });

    await expect(
      f.owner.transport({
        kind: 'lifecycle-audit',
        action: 'nanohost.transport.enroll',
        record: enrolled.record,
        actorUserId: null,
      })
    ).rejects.toMatchObject(precondition);
    await expect(
      f.owner.transport({
        kind: 'decommission-audit',
        identityId: nanoHostTarget.identityId,
        deploymentId: nanoHostTarget.deploymentId,
        actorUserId: 'fixture-admin',
        newlyRevokedCount: 0,
        retainedTokenCount: 1,
        tokenLineage: '',
      })
    ).rejects.toMatchObject(precondition);
    await expect(f.writer.runtimeTarget(f.database, nanoHostTarget)).rejects.toMatchObject(
      precondition
    );

    expectNanoHostTablesAbsent(
      f.corePath,
      'nanohost_transport_tokens',
      'nanohost_integration_identities'
    );
    const core = new Database(f.corePath, { readonly: true, fileMustExist: true });
    try {
      expect(core.prepare('SELECT count(*) FROM audit_events').pluck().get()).toBe(0);
    } finally {
      core.close();
    }
  });

  it('keeps the current Core administrator check ordered through the Native enrollment ACK', async () => {
    const f = await nanoHostWorkerFixture();
    const core = openCoreDb(f.root);
    nativeHandles.push(core);
    const administrator = ensureLocalUser(core);
    const enrollment = (userId: string) =>
      f.owner.enrollTransport({
        kind: 'enroll',
        actor: { kind: 'local', userId },
        record: {
          tokenId: allocateEntityId('nhtok'),
          tokenHash: `sha256:${'b'.repeat(64)}`,
          ownerNanoHostIdentityId: nanoHostTarget.identityId,
          deploymentId: readDataRootLayoutMarker(f.root).deploymentId,
          responsibleServerAdminActorId: userId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    await expect(enrollment(allocateEntityId('usr'))).rejects.toMatchObject({
      code: 'deployment_admin_required',
      status: 403,
    });
    expect(await f.owner.listTransportTokens()).toEqual({ state: 'ready', value: [] });

    Atomics.store(f.gate, 0, 0);
    const committed = enrollment(administrator);
    let checkpoint: ReturnType<typeof f.writer.checkpoint> | undefined;
    try {
      await waitForHold(f.gate);
      const posted = vi.spyOn(interception.workers[0]!, 'postMessage');
      checkpoint = f.writer.checkpoint(f.coreKey);
      await expect(f.writer.pauseForDataRootBackup()).rejects.toMatchObject({
        code: 'busy',
        commit: 'not-committed',
      });
      expect(posted).not.toHaveBeenCalled();
    } finally {
      release(f.gate);
    }
    await expect(committed).resolves.toMatchObject({
      kind: 'record',
      record: { responsibleServerAdminActorId: administrator, status: 'active' },
    });
    await expect(checkpoint).resolves.toBeDefined();
  });

  it('admits only local serving tuples and rechecks original proof before dispatch', async () => {
    const workspaceId = allocateEntityId('ws');
    const materialization = {
      id: 'materialization-original',
      inputSnapshotId: 'snapshot-original',
      workspaceId,
      backendKind: 'managed-sandbox',
      packageSnapshotId: 'package-original',
      workerSessionId: 'backend-session-original',
      strategy: 'filesystem',
      materializedRootRef: 'root-ref',
      base: { commit: null, contentDigest: 'contents' },
      policyDigest: 'policy-digest',
      readinessEvidence: [{ kind: 'materialized', ref: 'proof-ref' }],
      createdAt: nanoHostTarget.observedAt,
    } as const;
    const image = {
      kind: 'settlement',
      value: {
        requestId: 'e'.repeat(64),
        operation: 'image.build',
        authoredArtifactId: allocateEntityId('ar'),
        authoredArtifactVersion: 1,
        authoredContentDigest: `sha256:${'c'.repeat(64)}`,
        inputDigest: `sha256:${'d'.repeat(64)}`,
        outcome: { kind: 'success', imageDigest: `sha256:${'f'.repeat(64)}` },
      },
    } as const;
    const activation = {
      kind: 'environment',
      candidate: {
        authoredArtifactId: image.value.authoredArtifactId,
        authoredArtifactVersion: image.value.authoredArtifactVersion,
        authoredContentDigest: image.value.authoredContentDigest,
        inputDigest: image.value.inputDigest,
      },
      environment: {
        imageDigest: image.value.outcome.imageDigest,
        defaultsDigest: `sha256:${createHash('sha256').update('{}').digest('hex')}`,
        values: {},
      },
    } as const;
    let enabled = true;
    let imageAuthorized = false;
    let workspace: ReturnType<typeof openWorkspaceDb> | undefined;
    const f = await nanoHostWorkerFixture(
      {
        enabled: () => enabled,
        verifyImagePublication: (input) =>
          imageAuthorized &&
          (isDeepStrictEqual(input, image) || isDeepStrictEqual(input, activation)),
        verifyStorageBinding: (input) =>
          input.kind === 'create-and-reserve' &&
          input.workspaceId === workspaceId &&
          input.storageRef === 'storage-original',
        verifyWorkspaceHandoff: (session) =>
          workspace !== undefined &&
          session.workspaceId === workspaceId &&
          listWorkspaceMaterializationRecords(workspace, workspaceId).some(
            (record) =>
              isDeepStrictEqual(record, materialization) &&
              record.packageSnapshotId === session.packageSnapshotId &&
              record.workerSessionId === session.backendSessionId
          ),
      },
      (path) => {
        const sqlite = new Database(path, { fileMustExist: true });
        try {
          sqlite
            .prepare(`INSERT INTO worker_backend_sessions
          (attempt_id, workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id,
            backend_kind, deployment_id, backend_session_id, staging_directory_ref,
            workspace_handoff_state, state, created_at, updated_at, runtime_target_id,
            origin_physical_epoch, backend_lineage_json, sandbox_binding_ref)
          VALUES (?, ?, 'thread-original', 'turn-original', 'session-original', 'package-original',
            'nanohost', ?, 'backend-session-original', 'staging-original', 'pending',
            'materializing', ?, ?, ?, ?, ?, 'sandbox-binding-original')`)
            .run(
              'attempt-original',
              workspaceId,
              nanoHostTarget.deploymentId,
              nanoHostTarget.observedAt,
              nanoHostTarget.observedAt,
              nanoHostTarget.targetId,
              nanoHostReady.physicalEpoch,
              JSON.stringify({ imageRef: 'fixture-image' })
            );
        } finally {
          sqlite.close();
        }
      }
    );

    const invalid = { code: 'invalid-request', commit: 'not-committed' };
    await expect(
      Reflect.apply(f.owner.harnessLifecycle, undefined, [
        { kind: 'sandbox.restore-admission', sandboxRuntimeId: 'sandbox-original' },
      ])
    ).rejects.toMatchObject(invalid);
    await expect(
      Reflect.apply(f.owner.backendSession, undefined, [
        { kind: 'launching', attemptId: 'attempt-original' },
      ])
    ).rejects.toMatchObject(invalid);
    await expect(
      Reflect.apply(f.owner.workerStorageBinding, undefined, [
        {
          kind: 'purge-pending',
          storageRef: 'storage-original',
          expectedRevision: 1,
          schedulerRows: [],
        },
      ])
    ).rejects.toMatchObject(invalid);
    await expect(
      Reflect.apply(f.owner.workerImage, undefined, [
        {
          ...image,
          value: { ...image.value, operation: 'image.acquire' },
        },
      ])
    ).rejects.toMatchObject(invalid);
    const precondition = { code: 'precondition', commit: 'not-committed' };
    await expect(f.owner.workerImage(image)).rejects.toMatchObject(precondition);

    const resume = await f.writer.pauseForDataRootBackup(f.database);
    try {
      imageAuthorized = true;
      const deferred = f.owner.workerImage(image);
      const refused = expect(deferred).rejects.toMatchObject(precondition);
      imageAuthorized = false;
      resume();
      await refused;
    } finally {
      resume();
    }
    imageAuthorized = true;
    Atomics.store(f.gate, 0, 0);
    const imageWrite = f.owner.workerImage(image);
    try {
      await waitForHold(f.gate);
      expect(Atomics.load(f.gate, f.gate.length - 1)).toBe(2);
      expect(f.owner.read(() => 'unacknowledged')).toEqual(nanoHostHeld);
    } finally {
      release(f.gate);
    }
    await expect(imageWrite).resolves.toBeUndefined();
    expect(
      f.owner.read((sqlite) =>
        sqlite
          .prepare('SELECT image_digest FROM worker_image_settlements WHERE request_id = ?')
          .pluck()
          .get(image.value.requestId)
      )
    ).toEqual({ state: 'ready', value: image.value.outcome.imageDigest });

    const allocation = await prepareNanoHostTarget(f.owner, nanoHostTarget);
    await expect(
      f.owner.transitionRuntimeTarget(nanoHostUnknownKernel, allocation)
    ).resolves.toMatchObject({ state: 'ready' });
    const ready = await prepareNanoHostTarget(f.owner, nanoHostReady);
    await expect(
      f.owner.transitionRuntimeTarget(nanoHostUnknownKernel, ready)
    ).resolves.toMatchObject({
      state: 'ready',
    });
    Atomics.store(f.gate, 1, 0);
    Atomics.store(f.gate, 0, 0);
    const activating = f.owner.workerImage(activation);
    try {
      await waitForHold(f.gate);
      expect(f.owner.readRuntimeTarget(nanoHostTarget.targetId)).toMatchObject({
        state: 'ready',
        value: { ready: true, physicalEpoch: nanoHostReady.physicalEpoch, connectionGeneration: 1 },
      });
      expect(f.owner.read(() => 'unacknowledged')).toEqual(nanoHostHeld);
    } finally {
      release(f.gate);
    }
    await expect(activating).resolves.toBeUndefined();
    await expect(
      f.owner.harnessLifecycle({
        kind: 'runtime.create',
        adapterId: 'codex',
        adapterVersion: 'fixture',
        harnessBindingRef: 'harness-binding',
        harnessCompatibilityKey: 'b'.repeat(64),
        harnessInstanceId: 'harness-original',
        imageDigest: image.value.outcome.imageDigest,
        originPhysicalEpoch: nanoHostReady.physicalEpoch,
        runtimeTargetId: nanoHostTarget.targetId,
        sandboxBindingRef: 'sandbox-binding-original',
        sandboxCompatibilityKey: 'c'.repeat(64),
        sandboxIntegrationBindingRef: 'sandbox-integration',
        sandboxRuntimeId: 'sandbox-original',
        timestamp: nanoHostTarget.observedAt,
      })
    ).resolves.toBeUndefined();
    expect(
      f.owner.read((sqlite) =>
        sqlite.prepare('SELECT harness_instance_id FROM harness_instance_records').pluck().get()
      )
    ).toEqual({ state: 'ready', value: 'harness-original' });

    const handoff = { kind: 'handoff', attemptId: 'attempt-original' } as const;
    await expect(
      f.owner.backendSession({
        kind: 'transition',
        attemptId: handoff.attemptId,
        fromState: 'materializing',
        toState: 'materialized',
      })
    ).resolves.toMatchObject({ state: 'materialized', workspaceHandoffState: 'pending' });
    await expect(
      Reflect.apply(f.owner.backendSession, undefined, [
        {
          kind: 'transition',
          attemptId: handoff.attemptId,
          fromState: 'materialized',
          toState: 'launching',
        },
      ])
    ).rejects.toMatchObject(invalid);
    await expect(f.owner.backendSession(handoff)).rejects.toMatchObject(precondition);
    ensureWorkspaceLayout(f.root, workspaceId);
    workspace = openWorkspaceDb(f.root, workspaceId);
    nativeHandles.push(workspace);
    applyScopedMigrations(workspace);
    await recordWorkspaceBackendHandoff(
      workspace,
      [
        {
          id: materialization.inputSnapshotId,
          workspaceId,
          resourceId: 'resource-original',
          resourceKind: 'filesystem',
          strategy: 'filesystem',
          pathScope: ['source'],
          writableRoots: [],
          ignoredPaths: [],
          generatedFiles: [],
          base: materialization.base,
          backend: { kind: 'managed-sandbox', label: 'Fixture', capabilitySummary: [] },
          createdAt: materialization.createdAt,
        },
      ],
      [{ ...materialization, readinessEvidence: [...materialization.readinessEvidence] }]
    );
    await expect(f.owner.backendSession(handoff)).resolves.toMatchObject({
      attemptId: handoff.attemptId,
      workspaceHandoffState: 'complete',
    });

    const storage = {
      kind: 'create-and-reserve' as const,
      now: nanoHostTarget.observedAt,
      expectedRevision: 1,
      layout: {
        family: 'openkit-worker',
        version: '1',
        uid: 1000,
        gid: 1000,
        workingDirectory: '/tmp/openkit-bootstrap',
        platform: { architecture: 'amd64', os: 'linux' },
        targets: [{ target: '/workspace' }, { target: '/sandbox' }],
      },
      purpose: 'work' as const,
      responsibleUserId: FIXTURE_LOCAL_USER_ID,
      storageRef: 'storage-original',
      threadId: 'thread-original',
      workspaceId,
      agentSessionId: 'session-original',
      runtimeTargetId: nanoHostTarget.targetId,
      deploymentId: nanoHostTarget.deploymentId,
    };
    await expect(
      f.owner.workerStorageBinding({ ...storage, authorizedContributorRefs: [] })
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    const contributor = prepareWorkerStorageContributor(
      { storageRef: storage.storageRef, workspaceId, contributors: [] },
      storage,
      storage.now,
      1
    );
    await expect(
      f.owner.workerStorageBinding({
        ...storage,
        authorizedContributorRefs: [contributor.contributorRef],
      })
    ).resolves.toMatchObject({ storageRef: 'storage-original', state: 'reserved' });

    enabled = false;
    const query = vi.fn();
    expect(f.owner.read(query)).toEqual({
      state: 'unavailable',
      owner: 'nanohost',
      reason: 'disabled',
    });
    expect(query).not.toHaveBeenCalled();
    await expect(f.owner.workerImage(image)).rejects.toMatchObject({
      code: 'unavailable',
      commit: 'not-committed',
    });
    expectNanoHostTablesAbsent(f.corePath, 'worker_image_settlements', 'worker_backend_sessions');
  });

  it('holds a live epoch until exact applied coverage and rejects retired storage and target generations', async () => {
    const f = await nanoHostWorkerFixture();
    const firstAllocation = await prepareNanoHostTarget(f.owner, nanoHostTarget);
    const postMessage = Worker.prototype.postMessage;
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    // A valid wire tuple with a different acknowledged OPEN id cannot mutate this file.
    posted.mockImplementationOnce(function (this: NativeWorker, message: ControlWorkerRequest) {
      if (message.operation !== 'nanohost-owner')
        throw new Error('Expected a real NanoHost owner request.');
      return postMessage.call(this, { ...message, openingRequestId: message.openingRequestId + 1 });
    });
    await expect(
      f.owner.transitionRuntimeTarget(nanoHostUnknownKernel, firstAllocation)
    ).resolves.toEqual(nanoHostHeld);
    const first = await f.owner.transitionRuntimeTarget(nanoHostUnknownKernel, firstAllocation);
    expect(first).toMatchObject({
      state: 'ready',
      value: { connectionGeneration: 1, ready: false },
    });
    expect(posted.mock.calls.at(-1)?.[0]).toMatchObject({
      operation: 'nanohost-owner',
      mutation: { kind: 'runtime-target', input: firstAllocation },
    });
    posted.mockClear();
    await expect(
      f.owner.transitionRuntimeTarget(nanoHostUnknownKernel, firstAllocation)
    ).resolves.toEqual(first);
    await expect(
      f.owner.transitionRuntimeTarget(nanoHostUnknownKernel, {
        ...firstAllocation,
        input: { ...nanoHostTarget, observedAt: '2026-11-21T00:00:01.000Z' },
      })
    ).resolves.toEqual(nanoHostHeld);
    expect(posted).not.toHaveBeenCalled();
    posted.mockRestore();
    const firstReady = await prepareNanoHostTarget(f.owner, nanoHostReady);
    await expect(
      f.owner.transitionRuntimeTarget(nanoHostUnknownKernel, firstReady)
    ).resolves.toMatchObject({
      state: 'ready',
      value: { ready: true, physicalEpoch: nanoHostPlacement.physicalEpoch },
    });
    const readinessBeforeRetirement = await prepareNanoHostTarget(f.owner, nanoHostReady);

    const successor = await prepareNanoHostTarget(f.owner, nanoHostTarget);
    expect(successor.retirement).toEqual(nanoHostPlacement);
    let applied = false;
    const kernel: NanoHostRuntimeTargetEpochKernel = {
      ...nanoHostUnknownKernel,
      async reserveHolderIntent(input) {
        expect(input).toEqual(nanoHostPlacement);
        await expect(f.owner.readPendingEpochRetirement()).resolves.toEqual({
          state: 'ready',
          value: nanoHostPlacement,
        });
        return { state: 'ready', value: nanoHostIntent };
      },
      async inspectNanoHostEpochFence(input) {
        expect(input).toEqual(nanoHostIntent);
        return {
          state: 'ready',
          value: applied ? { state: 'settled', receipt: nanoHostReceipt } : { state: 'unknown' },
        };
      },
    };
    await expect(f.owner.transitionRuntimeTarget(kernel, successor)).resolves.toEqual(
      nanoHostKernelHeld
    );
    await expect(f.owner.readEpochInvalidation(nanoHostIntent.requestId)).resolves.toEqual({
      state: 'ready',
      value: nanoHostIntent,
    });
    const partialReceipt = storageReceipt(nanoHostIntent, {
      disposition: 'applied',
      result: { fencedHolderReceiptIds: ['holder-a'] },
    });
    await expect(f.owner.settleEpochInvalidation(partialReceipt)).resolves.toEqual(nanoHostHeld);
    await expect(f.owner.transitionRuntimeTarget(kernel, successor)).resolves.toEqual(
      nanoHostKernelHeld
    );
    applied = true;
    const successorResult = await f.owner.transitionRuntimeTarget(kernel, successor);
    expect(successorResult).toMatchObject({
      state: 'ready',
      value: { connectionGeneration: 2, ready: false },
    });
    await expect(
      f.owner.settleEpochInvalidation({
        ...nanoHostReceipt,
        receiptDigest: 'divergent-receipt',
      })
    ).resolves.toEqual(nanoHostHeld);
    await expect(f.owner.readPendingEpochRetirement()).resolves.toEqual({
      state: 'ready',
      value: null,
    });
    await expect(
      f.owner.transitionRuntimeTarget(kernel, readinessBeforeRetirement)
    ).resolves.toEqual(nanoHostHeld);
    await expect(f.owner.prepareRuntimeTarget(nanoHostReady, crypto.randomUUID())).resolves.toEqual(
      nanoHostHeld
    );
    await expect(f.owner.beginEpochRetirement(nanoHostPlacement)).resolves.toEqual(nanoHostHeld);

    const closing = f.writer.closeServerOwner(f.root, 'nanohost');
    expect(f.owner.read((reader) => reader.open)).toEqual(nanoHostHeld);
    await expect(f.owner.transitionRuntimeTarget(kernel, successor)).resolves.toEqual(nanoHostHeld);
    await closing;
    const reopened = await f.writer.bindNanoHostOwner(f.root, nanoHostReaders, f.serving);
    if (reopened.state !== 'ready')
      throw new Error('Expected the retained NanoHost owner to reopen.');
    expect(f.owner.read((reader) => reader.open)).toEqual(nanoHostHeld);
    await expect(f.owner.transitionRuntimeTarget(kernel, successor)).resolves.toEqual(nanoHostHeld);
    const currentReads = createNanoHostCoreReads(reopened.value);
    const retiredReads = createNanoHostCoreReads(f.owner);
    expect(currentReads.readTarget(nanoHostTarget.targetId)).toMatchObject({
      state: 'ready',
      value: { connectionGeneration: 2, ready: false },
    });
    expect(retiredReads.readTarget(nanoHostTarget.targetId)).toEqual(nanoHostHeld);
    await expect(
      reopened.value.transitionRuntimeTarget(nanoHostUnknownKernel, successor)
    ).resolves.toEqual(successorResult);

    const successorReady = await prepareNanoHostTarget(reopened.value, {
      ...nanoHostReady,
      connectionGeneration: 2,
      physicalEpoch: 'c'.repeat(64),
    });
    await expect(
      reopened.value.transitionRuntimeTarget(kernel, successorReady)
    ).resolves.toMatchObject({ state: 'ready', value: { connectionGeneration: 2, ready: true } });
    expectNanoHostTablesAbsent(f.corePath, 'nanohost_runtime_targets');
  });

  it('lets exact RuntimeTarget and Harness polls proceed while completion awaits serving FULL', async () => {
    const f = await nanoHostWorkerFixture();
    for (const target of [nanoHostTarget, nanoHostReady]) {
      const original = await prepareNanoHostTarget(f.owner, target);
      await expect(
        f.owner.transitionRuntimeTarget(nanoHostUnknownKernel, original)
      ).resolves.toMatchObject({
        state: 'ready',
      });
    }
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const poll = () =>
      f.owner.harnessTurnLifecycle.dispatch({
        sandboxIntegrationBindingRef: 'sandbox-integration',
      });
    const completion = vi.fn(() => true);
    const authority = vi.fn(() => f.owner.read(() => 'admitted'));
    let joined:
      | ReturnType<typeof f.owner.afterWorkerControlAcknowledgement<ReturnType<typeof authority>>>
      | undefined;
    Atomics.store(f.gate, 0, 0);
    const writing = f.owner.harnessLifecycle({
      kind: 'runtime.create',
      adapterId: 'codex',
      adapterVersion: 'fixture',
      harnessBindingRef: 'harness-binding',
      harnessCompatibilityKey: 'b'.repeat(64),
      harnessInstanceId: 'harness-original',
      imageDigest: `sha256:${'c'.repeat(64)}`,
      originPhysicalEpoch: nanoHostReady.physicalEpoch,
      runtimeTargetId: nanoHostTarget.targetId,
      sandboxBindingRef: 'sandbox-binding',
      sandboxCompatibilityKey: 'd'.repeat(64),
      sandboxIntegrationBindingRef: 'sandbox-integration',
      sandboxRuntimeId: 'sandbox-original',
      timestamp: nanoHostTarget.observedAt,
    });
    try {
      await waitForHold(f.gate);
      expect(f.owner.readRuntimeTarget(nanoHostTarget.targetId)).toMatchObject({
        state: 'ready',
        value: { connectionGeneration: 1, ready: true },
      });
      expect(f.owner.read(() => true)).toMatchObject({ state: 'unavailable' });
      expect(f.owner.readWorkerCompletion(completion)).toEqual({ state: 'pending' });
      expect(completion).not.toHaveBeenCalled();
      await expect(poll()).resolves.toBeNull();

      const cancelled = new AbortController();
      const stopped = f.owner.afterWorkerControlAcknowledgement(authority, cancelled.signal);
      const reason = new Error('Worker request disconnected.');
      cancelled.abort(reason);
      await expect(stopped).rejects.toBe(reason);
      expect(authority).not.toHaveBeenCalled();

      // If the owner loses its bound, break the test's wait before releasing the real writer.
      const watchdog = AbortSignal.timeout(6500);
      await expect(
        f.owner.afterWorkerControlAcknowledgement(authority, watchdog)
      ).rejects.toMatchObject({ code: 'busy', commit: 'not-committed' });
      expect(authority).not.toHaveBeenCalled();
      joined = f.owner.afterWorkerControlAcknowledgement(authority);
      expect(authority).not.toHaveBeenCalled();
    } finally {
      release(f.gate);
    }
    await expect(writing).resolves.toBeUndefined();
    await expect(joined).resolves.toEqual({ state: 'ready', value: 'admitted' });
    expect(authority).toHaveBeenCalledTimes(1);
    expect(f.owner.readWorkerCompletion(completion)).toEqual({ state: 'ready', value: true });
    expect(completion).toHaveBeenCalledTimes(1);

    await expect(poll()).resolves.toBeNull();
    expect(posted.mock.calls.map(([frame]) => frame)).not.toContainEqual(
      expect.objectContaining({
        operation: 'nanohost-owner',
        mutation: expect.objectContaining({
          kind: 'harness-turn-lifecycle',
          input: expect.objectContaining({ kind: 'operation.dispatch' }),
        }),
      })
    );
  });

  it('commits the original Core idle close receipt before the Native FULL acknowledgement', async () => {
    const f = await nanoHostWorkerFixture();
    const core = openCoreReadDb(f.root);
    try {
      const selected = await prepareNanoHostOwner(core, f.serving);
      if (selected.state !== 'ready') throw new Error('Expected the admitted NanoHost owner.');
      const { owner } = selected.value;
      const { harnessTurnLifecycle: lifecycle } = owner;
      for (const target of [nanoHostTarget, nanoHostReady]) {
        const original = await prepareNanoHostTarget(owner, target);
        await expect(
          owner.transitionRuntimeTarget(nanoHostUnknownKernel, original)
        ).resolves.toMatchObject({ state: 'ready' });
      }

      const timestamp = new Date().toISOString();
      const harnessBindingRef = 'idle-close-harness-binding';
      const harnessInstanceId = 'idle-close-harness';
      const sandboxIntegrationBindingRef = 'idle-close-integration';
      await owner.harnessLifecycle({
        kind: 'runtime.create',
        adapterId: 'codex',
        adapterVersion: 'fixture',
        harnessBindingRef,
        harnessCompatibilityKey: 'b'.repeat(64),
        harnessInstanceId,
        imageDigest: `sha256:${'c'.repeat(64)}`,
        originPhysicalEpoch: nanoHostReady.physicalEpoch,
        runtimeTargetId: nanoHostTarget.targetId,
        sandboxBindingRef: 'idle-close-sandbox-binding',
        sandboxCompatibilityKey: 'd'.repeat(64),
        sandboxIntegrationBindingRef,
        sandboxRuntimeId: 'idle-close-sandbox',
        timestamp,
      });
      const consumer = {
        workspaceId: allocateEntityId('ws'),
        threadId: allocateEntityId('th'),
        agentSessionId: allocateEntityId('as'),
        agentSessionRuntimeBindingId: 'idle-close-agent-session',
      };
      await owner.harnessLifecycle({
        kind: 'session-binding.open',
        ...consumer,
        agentSessionCompatibilityKey: 'e'.repeat(64),
        effectiveSetupGeneration: 1,
        harnessInstanceId,
        timestamp,
      });
      const request = {
        harnessInstanceId,
        operation: 'session.close' as const,
        body: {
          agentSessionId: consumer.agentSessionId,
          agentSessionRuntimeBindingId: consumer.agentSessionRuntimeBindingId,
        },
        timestamp,
      };
      const prepared = owner.read((sqlite) =>
        prepareNanoHostHarnessOperation(core, request, { sqlite })
      );
      if (prepared.state !== 'ready') throw new Error('Expected the original idle close.');
      await lifecycle.queue({ ...request, prepared: prepared.value });
      const dispatched = await lifecycle.dispatch({ sandboxIntegrationBindingRef });
      expect(dispatched).toMatchObject({ operation: 'session.close' });
      if (!dispatched) throw new Error('Expected the original idle close dispatch.');
      const result = {
        schemaVersion: 2 as const,
        harnessInstanceId,
        operationId: dispatched.operationId,
        sequence: dispatched.sequence,
        disposition: 'succeeded' as const,
        body: { state: 'closed', privateState: 'absent', childState: 'absent' },
      };
      const key = {
        harnessBindingRef,
        operationId: result.operationId,
        sequence: result.sequence,
        resultFingerprint: sha256CanonicalJson(result),
      };
      const settlementInput = { sandboxIntegrationBindingRef, timestamp, result };
      expect(inspectCoreHarnessConsumption(core, key)).toBeNull();

      Atomics.store(f.gate, 0, 0);
      const settlement = lifecycle.settle(settlementInput);
      // An unexpected refusal must still release the Native test gate.
      void settlement.catch(() => undefined);
      const receipt = { consumer: canonicalJsonText(consumer), acknowledgedAt: timestamp };
      try {
        await waitForHold(f.gate);
        expect(inspectCoreHarnessConsumption(core, key)).toEqual(receipt);
      } finally {
        release(f.gate);
      }
      await expect(settlement).resolves.toBe('settled');
      const replayClock = new Date(Date.parse(timestamp) + 1000).toISOString();
      await expect(lifecycle.settle({ ...settlementInput, timestamp: replayClock })).resolves.toBe(
        'replayed'
      );
      await lifecycle.acknowledge({
        result,
        harnessBindingRef,
        consumerReceipt: receipt.consumer,
        timestamp: replayClock,
      });
      expect(inspectCoreHarnessConsumption(core, key)).toEqual(receipt);
    } finally {
      core.sqlite.close();
    }
  });

  it('holds a successor when the original local settlement commits but loses its ACK', async () => {
    const f = await nanoHostWorkerFixture();
    const allocation = await prepareNanoHostTarget(f.owner, nanoHostTarget);
    await f.owner.transitionRuntimeTarget(nanoHostUnknownKernel, allocation);
    const ready = await prepareNanoHostTarget(f.owner, nanoHostReady);
    await f.owner.transitionRuntimeTarget(nanoHostUnknownKernel, ready);
    const successor = await prepareNanoHostTarget(f.owner, nanoHostTarget);
    await expect(f.owner.beginEpochRetirement(nanoHostPlacement)).resolves.toEqual(nanoHostAck);
    await expect(f.owner.stageEpochInvalidation(nanoHostIntent)).resolves.toEqual(nanoHostAck);

    Atomics.store(f.gate, 0, 0);
    const settlement = f.owner.settleEpochInvalidation(nanoHostReceipt);
    try {
      await waitForHold(f.gate);
      expect(f.owner.readRuntimeTarget(nanoHostTarget.targetId)).toMatchObject({
        state: 'unavailable',
      });
      const completion = vi.fn(() => true);
      expect(f.owner.readWorkerCompletion(completion)).toMatchObject({ state: 'unavailable' });
      expect(completion).not.toHaveBeenCalled();
      await expect(
        f.owner.transitionRuntimeTarget(nanoHostUnknownKernel, successor)
      ).resolves.toEqual(nanoHostHeld);
      const read = new Database(f.path, { readonly: true, fileMustExist: true });
      try {
        const row = read
          .prepare(
            'SELECT connection_generation, vault_epoch_fence_json FROM nanohost_runtime_targets'
          )
          .get() as { connection_generation: number; vault_epoch_fence_json: string };
        expect(row.connection_generation).toBe(1);
        expect(JSON.parse(row.vault_epoch_fence_json).receipt).toEqual(nanoHostReceipt);
      } finally {
        read.close();
      }
      await interception.workers[1]!.terminate();
    } finally {
      release(f.gate);
    }
    await expect(settlement).resolves.toEqual(nanoHostHeld);
    await expect(f.owner.readEpochInvalidation(nanoHostIntent.requestId)).resolves.toEqual(
      nanoHostHeld
    );
    await expect(
      f.owner.transitionRuntimeTarget(nanoHostUnknownKernel, successor)
    ).resolves.toEqual(nanoHostHeld);
    await expect(f.writer.bindNanoHostOwner(f.root, nanoHostReaders, f.serving)).resolves.toEqual(
      nanoHostHeld
    );
    await expect(f.writer.checkpoint(f.coreKey)).resolves.toBeDefined();
  });
});

describe('control writer parent admission', () => {
  it('hides a recovered deletion fence while preserving exact continuation and capture reads', async () => {
    const f = await poolFixture(1);
    const workspaceId = f.scope(0).productOwner.workspaceId;
    const capture = f.client.tryFreezeWorkspace(f.root, workspaceId, () => []);
    expect(capture.status).toBe('frozen');
    expect(f.client.isWorkspaceLifecycleClosed(f.root, workspaceId)).toBe(false);
    if (capture.status !== 'frozen') throw new Error('Expected the idle Workspace to freeze.');
    capture.release();

    const captureOrigin = { captureId: allocateEntityId('wsbak') };
    f.client.restoreWorkspaceRecoveryClosed(f.root, workspaceId, captureOrigin);
    expect(f.client.isWorkspaceLifecycleClosed(f.root, workspaceId)).toBe(false);
    f.client.reopenWorkspaceMutations(f.root, workspaceId, 'capture');

    const deletionOrigin = { deletionRequestId: randomUUID(), revision: 1 };
    f.client.restoreWorkspaceRecoveryClosed(f.root, workspaceId, deletionOrigin);
    expect(f.client.isWorkspaceLifecycleClosed(f.root, workspaceId)).toBe(true);
    expect(f.client.enterWorkspaceMutation(f.root, workspaceId)).toBeNull();
    expect(
      f.client.tryResumeWorkspaceRecovery(
        f.root,
        workspaceId,
        { ...deletionOrigin, deletionRequestId: randomUUID() },
        () => []
      ).status
    ).toBe('busy');
    const resumed = f.client.tryResumeWorkspaceRecovery(
      f.root,
      workspaceId,
      deletionOrigin,
      () => []
    );
    expect(resumed.status).toBe('frozen');
    if (resumed.status !== 'frozen') throw new Error('Expected the exact deletion to resume.');
    resumed.release();
    expect(f.client.isWorkspaceLifecycleClosed(f.root, workspaceId)).toBe(true);
  });

  it('owns the actual App producer before schema and JSON preparation', async () => {
    const f = await productPoolFixture();
    const workspaceId = f.workspaces[0]!.id;
    const context: KernelCommandContext = {
      store: f.store,
      inflightCommands: new WeakMap(),
      dataRoot: f.root,
      workspaceId,
      actor: { kind: 'user', id: f.userId },
      requestId: randomUUID(),
    };
    const app = await createLightApp(context, {
      format: 'openkit.light-app',
      schemaVersion: 1,
      title: 'Preparation ownership',
      purpose: 'Retain the original native producer through preparation.',
      collections: [
        {
          name: 'entries',
          type: 'base',
          description: 'Original entries.',
          fields: [{ name: 'note', type: 'text', required: true, description: 'Retained text.' }],
          indexes: [],
        },
      ],
    });
    const cuts: string[] = [];
    const appKernel = f.client.appKernel.bind(f.client);
    const observed = vi
      .spyOn(f.client, 'appKernel')
      .mockImplementation((database, input, capacity) =>
        appKernel(
          database,
          {
            ...input,
            get change() {
              const cut = f.client.tryFreezeWorkspace(f.root, workspaceId, () => []);
              cuts.push(cut.status);
              if (cut.status === 'frozen') cut.release();
              return input.change;
            },
          },
          capacity
        )
      );
    try {
      const record = await createRecord(
        { ...context, requestId: randomUUID() },
        app.appId,
        'entries',
        app.schemaRevision,
        { note: 'Original native preparation.' }
      );
      expect(record.data).toEqual({ note: 'Original native preparation.' });
      expect(cuts.length).toBeGreaterThan(0);
      expect(cuts.every((status) => status === 'busy')).toBe(true);
      const after = f.client.tryFreezeWorkspace(f.root, workspaceId, () => []);
      if (after.status === 'frozen') after.release();
      expect(after.status).toBe('frozen');
      const [database, prepared] = observed.mock.calls[0]!;
      const capacity = f.client.reserveAppRollback(database, 64);
      const released = vi.spyOn(capacity, 'release');
      const cut = f.client.tryFreezeWorkspace(f.root, workspaceId, () => []);
      expect(cut.status).toBe('frozen');
      try {
        await expect(appKernel(database, prepared, capacity)).rejects.toMatchObject({
          code: 'workspace_frozen',
          status: 409,
        });
        expect(released).toHaveBeenCalledTimes(1);
      } finally {
        if (cut.status === 'frozen') cut.release();
        capacity.release();
        released.mockRestore();
      }
    } finally {
      observed.mockRestore();
    }
  });

  it('derives the Core journal target from the same single snapshot it posts', async () => {
    const f = await poolFixture(2);
    initializeTestCore(f.root);
    const coreDb = openCoreDb(f.root);
    nativeHandles.push(coreDb);
    const manager = createRuntimeConfigManager({ dataRoot: f.root });
    await manager.bindNativePolicyPublication(coreDb);
    const original = f.scope(0).productOwner.workspaceId;
    const alternate = f.scope(1).productOwner.workspaceId;
    const scope = nativeProductScope(f.root, { kind: 'server' });
    const database = `core:${scope.path}`;
    let reads = 0;
    let postedWorkspace: string | undefined;
    let postedStatus: string | undefined;
    const post = Worker.prototype.postMessage;
    const observed = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      const message = args[0];
      if (message?.operation === 'core-journal' && message.input.kind === 'containment-intent') {
        postedWorkspace = message.input.lineage.workspaceId;
        const cut = f.client.tryFreezeWorkspace(
          f.root,
          message.input.lineage.workspaceId,
          () => []
        );
        postedStatus = cut.status;
        if (cut.status === 'frozen') cut.release();
      }
      return Reflect.apply(post, this, args);
    });
    try {
      await expect(
        f.client.coreJournal(database, {
          kind: 'containment-intent',
          policy: { schemaVersion: 1, statements: [] },
          get lineage() {
            reads++;
            return {
              workspaceId: reads === 1 ? original : alternate,
              threadId: allocateEntityId('th'),
              turnId: allocateEntityId('tu'),
              agentSessionId: allocateEntityId('as'),
              packageSnapshotId: 'journal-snapshot',
            };
          },
        })
      ).resolves.toBeNull();
      expect(reads).toBe(1);
      expect(postedWorkspace).toBe(original);
      expect(postedStatus).toBe('busy');
      const cut = f.client.tryFreezeWorkspace(f.root, original, () => []);
      if (cut.status === 'frozen') cut.release();
      expect(cut.status).toBe('frozen');
    } finally {
      observed.mockRestore();
    }
  });

  it('retains a native child ACK after its original closeout lease parent returns', async () => {
    const f = await poolFixture(1, 'before');
    const scope = f.scope(0);
    let child: Promise<unknown> | undefined;
    let cut: ReturnType<typeof f.client.tryFreezeWorkspace> | undefined;
    try {
      // Isolate lease bookkeeping with an existing transport journal write, not Worker permission.
      const parent = f.client.runWorkerCloseout(
        f.root,
        scope.productOwner.workspaceId,
        async () => {
          Atomics.store(f.gate!, 0, 0);
          child = f.client.write(scope.database, nativeRequest('unawaited-native-child'));
          await waitForHold(f.gate!);
        }
      );
      expect(parent).not.toBeNull();
      await parent;
      expect(nativeRequests(scope.path)).toEqual([]);
      cut = f.client.tryFreezeWorkspace(f.root, scope.productOwner.workspaceId, () => []);
      expect(cut.status).toBe('busy');
    } finally {
      if (cut?.status === 'frozen') cut.release();
      release(f.gate);
      await child;
    }
    expect(nativeRequests(scope.path)).toEqual(['unawaited-native-child']);
    const afterAck = f.client.tryFreezeWorkspace(f.root, scope.productOwner.workspaceId, () => []);
    expect(afterAck.status).toBe('frozen');
    if (afterAck.status === 'frozen') afterAck.release();
  });

  it('owns a standalone Workspace write through its original native ACK', async () => {
    const f = await poolFixture(1, 'before');
    const scope = f.scope(0);
    Atomics.store(f.gate!, 0, 0);
    const write = f.client.write(scope.database, nativeRequest('standalone-native-write'));
    let cut: ReturnType<typeof f.client.tryFreezeWorkspace> | undefined;
    try {
      await waitForHold(f.gate!);
      expect(nativeRequests(scope.path)).toEqual([]);
      cut = f.client.tryFreezeWorkspace(f.root, scope.productOwner.workspaceId, () => []);
      expect(cut.status).toBe('busy');
    } finally {
      if (cut?.status === 'frozen') cut.release();
      release(f.gate);
      await write;
    }
    expect(nativeRequests(scope.path)).toEqual(['standalone-native-write']);
    const afterAck = f.client.tryFreezeWorkspace(f.root, scope.productOwner.workspaceId, () => []);
    expect(afterAck.status).toBe('frozen');
    if (afterAck.status === 'frozen') afterAck.release();
  });

  it('owns a standalone physical close until its real native ACK is delivered', async () => {
    const f = await poolFixture(1);
    const scope = f.scope(0);
    const reached = Promise.withResolvers<void>();
    const emit = Worker.prototype.emit;
    let resume: (() => void) | undefined;
    const replies = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
      event,
      ...args
    ) {
      if (event === 'message' && args[0]?.operation === 'close' && !resume) {
        resume = () => {
          emit.call(this, event, ...args);
        };
        reached.resolve();
        return true;
      }
      return emit.call(this, event, ...args);
    });
    const closing = f.client.close(scope.database);
    let cut: ReturnType<typeof f.client.tryFreezeWorkspace> | undefined;
    try {
      await reached.promise;
      cut = f.client.tryFreezeWorkspace(f.root, scope.productOwner.workspaceId, () => []);
      expect(cut.status).toBe('busy');
    } finally {
      if (cut?.status === 'frozen') cut.release();
      resume?.();
      await closing;
      replies.mockRestore();
    }
    const afterAck = f.client.tryFreezeWorkspace(f.root, scope.productOwner.workspaceId, () => []);
    expect(afterAck.status).toBe('frozen');
    if (afterAck.status === 'frozen') afterAck.release();
  });

  it('owns direct Turn publication before JSON and before its first native post', async () => {
    const f = await poolFixture(1);
    const scope = f.scope(0);
    const reached = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let jsonCut: string | undefined;
    const input = {
      toJSON() {
        const cut = f.client.tryFreezeWorkspace(f.root, scope.productOwner.workspaceId, () => []);
        jsonCut = cut.status;
        if (cut.status === 'frozen') cut.release();
        return { id: 'native-preparation-owner' };
      },
    };
    const publication = f.client.runTurnPublication(
      scope,
      [allocateEntityId('tu')],
      input,
      async () => {
        reached.resolve();
        await resume.promise;
        return f.client.write(scope.database, nativeRequest('native-preparation-owner'));
      }
    );
    let cut: ReturnType<typeof f.client.tryFreezeWorkspace> | undefined;
    try {
      await reached.promise;
      expect(jsonCut).toBe('busy');
      expect(nativeRequests(scope.path)).toEqual([]);
      cut = f.client.tryFreezeWorkspace(f.root, scope.productOwner.workspaceId, () => []);
      expect(cut.status).toBe('busy');
    } finally {
      if (cut?.status === 'frozen') cut.release();
      resume.resolve();
      await publication;
    }
    expect(nativeRequests(scope.path)).toEqual(['native-preparation-owner']);
    const afterAck = f.client.tryFreezeWorkspace(f.root, scope.productOwner.workspaceId, () => []);
    expect(afterAck.status).toBe('frozen');
    if (afterAck.status === 'frozen') afterAck.release();
  });

  it('retains the original parent alongside a distinct publication target through preparation and ACK', async () => {
    const f = await poolFixture(2, 'before');
    const original = f.scope(0);
    const target = f.scope(1);
    const reached = Promise.withResolvers<void>();
    const resumePreparation = Promise.withResolvers<void>();
    const cuts: (() => void)[] = [];
    let publication: Promise<unknown> | undefined;
    Atomics.store(f.gate!, 0, 0);
    try {
      const parent = f.client.runWorkerCloseout(
        f.root,
        original.productOwner.workspaceId,
        async () => {
          publication = f.client.runTurnPublication(
            target,
            [allocateEntityId('tu')],
            {},
            async () => {
              reached.resolve();
              await resumePreparation.promise;
              return f.client.write(target.database, nativeRequest('distinct-publication-target'));
            }
          );
          await reached.promise;
        }
      );
      expect(parent).not.toBeNull();
      await parent;
      for (const workspaceId of [
        original.productOwner.workspaceId,
        target.productOwner.workspaceId,
      ]) {
        const cut = f.client.tryFreezeWorkspace(f.root, workspaceId, () => []);
        if (cut.status === 'frozen') cuts.push(cut.release);
        expect(cut.status).toBe('busy');
      }
      resumePreparation.resolve();
      await waitForHold(f.gate!);
      for (const workspaceId of [
        original.productOwner.workspaceId,
        target.productOwner.workspaceId,
      ]) {
        const cut = f.client.tryFreezeWorkspace(f.root, workspaceId, () => []);
        if (cut.status === 'frozen') cuts.push(cut.release);
        expect(cut.status).toBe('busy');
      }
      release(f.gate);
      await publication;
      expect(nativeRequests(target.path)).toEqual(['distinct-publication-target']);
      for (const workspaceId of [
        original.productOwner.workspaceId,
        target.productOwner.workspaceId,
      ]) {
        const cut = f.client.tryFreezeWorkspace(f.root, workspaceId, () => []);
        if (cut.status === 'frozen') cuts.push(cut.release);
        expect(cut.status).toBe('frozen');
      }
    } finally {
      for (const end of cuts) end();
      resumePreparation.resolve();
      release(f.gate);
      await publication;
    }
  });

  it('retains unknown child backing and the original deletion fence across native restart', async () => {
    const posts = vi.spyOn(Worker.prototype, 'postMessage');
    const f = await poolFixture(1, 'after');
    const scope = f.scope(0);
    let outcome: Promise<unknown> | undefined;
    let deletion: Promise<void> | undefined;
    let closed = false;
    try {
      const parent = f.client.runWorkerCloseout(
        f.root,
        scope.productOwner.workspaceId,
        async () => {
          Atomics.store(f.gate!, 0, 0);
          outcome = f.client.write(scope.database, nativeRequest('unknown-native-child')).then(
            () => ({ accepted: true }),
            (error: unknown) => error
          );
          await waitForHold(f.gate!);
        }
      );
      expect(parent).not.toBeNull();
      await parent;
      deletion = f.client
        .closeWorkspaceMutations(f.root, scope.productOwner.workspaceId)
        .then(() => {
          closed = true;
        });
      const call = posts.mock.calls.findIndex(
        ([message]) => message.operation === 'write' && message.database === scope.database
      );
      expect(call).toBeGreaterThanOrEqual(0);
      await nextTurn();
      expect(closed).toBe(false);
      await (posts.mock.contexts[call] as NativeWorker).terminate();
      expect(await outcome).toMatchObject({ code: 'unavailable', commit: 'unknown' });
      // Known physical disposal releases the IO unit, never the original deletion fence.
      await deletion;
      expect(closed).toBe(true);
      await f.client.shutdown();
      const restarted = getControlStoreWorkerClient();
      client = restarted;
      expect(restarted.isWorkspaceLifecycleClosed(f.root, scope.productOwner.workspaceId)).toBe(
        true
      );
      expect(restarted.enterWorkspaceMutation(f.root, scope.productOwner.workspaceId)).toBeNull();
      expect(nativeRequests(scope.path)).toEqual(['unknown-native-child']);
    } finally {
      release(f.gate);
      await f.client.shutdown();
      await deletion;
    }
  });

  it('seals recovery only after accepted Item publications and hashes the closed tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'control-recovery-seal-'));
    roots.push(root);
    interception.gate = new SharedArrayBuffer(8);
    interception.point = 'before';
    const gate = new Int32Array(interception.gate);
    Atomics.store(gate, 0, 1);
    client = getControlStoreWorkerClient();
    const store = await createDemoStore({ dataRoot: root });
    const turn = await store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Private recovery', {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    });
    const scope = nativeProductScope(root, turn.owner);
    const database = `workspace:${scope.path}`;
    const tree = join(root, 'workspaces', DEMO_WORKSPACE_ID);
    const publish = (text: string) =>
      store.createItem({
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text,
        createdAt: turn.startedAt!,
        completedAt: turn.startedAt!,
      });
    Atomics.store(gate, 0, 0);
    const first = publish('Complete immutable recovery content.\n'.repeat(2048));
    await waitForHold(gate);
    const second = publish('Accepted after the first publication, before its acknowledgement.');
    await nextTurn();
    let settled = false;
    const sealing = client.sealRecovery(database).then((digest) => {
      settled = true;
      return digest;
    });
    let settledWhileHeld: boolean;
    try {
      await nextTurn();
      settledWhileHeld = settled;
    } finally {
      release(gate);
    }
    await Promise.allSettled([first, second, sealing]);
    expect(settledWhileHeld).toBe(false);
    const items = await Promise.all([first, second]);
    const digest = await sealing;
    // Same-Deployment Restore seals the complete post-close inventory before placement.
    const expected = createHash('sha256')
      .update(JSON.stringify(dataRootBackup.inventoryRegularFiles(tree)))
      .digest('hex');
    expect(digest).toBe(expected);
    expect(store.listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)).toEqual(items);
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      productOwner: scope.owner,
      contentMount: scope.contentMount,
      create: false,
      initialize: 'workspace',
    });
    const later = await publish('A new explicit opening can publish after the seal.');
    expect(store.listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)).toEqual([...items, later]);
  });

  it('closes only after accepted same-Turn Item publications are durable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'control-close-publication-'));
    roots.push(root);
    interception.gate = new SharedArrayBuffer(8);
    interception.point = 'after';
    const gate = new Int32Array(interception.gate);
    Atomics.store(gate, 0, 1);
    client = getControlStoreWorkerClient();
    const store = await createDemoStore({ dataRoot: root });
    const turn = await store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Private close', {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    });
    const scope = nativeProductScope(root, turn.owner);
    const database = `workspace:${scope.path}`;
    const publish = (text: string) =>
      store.createItem({
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text,
        createdAt: turn.startedAt!,
        completedAt: turn.startedAt!,
      });
    Atomics.store(gate, 0, 0);
    const first = publish('Complete immutable close content.\n'.repeat(2048));
    await waitForHold(gate);
    const second = publish('Accepted after the first publication, before its acknowledgement.');
    await nextTurn();
    let closed = false;
    const closing = client.close(database).then(() => {
      closed = true;
    });
    let closedWhileHeld: boolean;
    try {
      await nextTurn();
      closedWhileHeld = closed;
    } finally {
      release(gate);
    }
    const outcomes = await Promise.allSettled([first, second, closing]);
    expect(closedWhileHeld).toBe(false);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    const items = await Promise.all([first, second]);
    await closing;
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      productOwner: scope.owner,
      contentMount: scope.contentMount,
      create: false,
      initialize: 'workspace',
    });
    expect(store.listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)).toEqual(items);
    const reader = new Database(scope.path, { readonly: true, fileMustExist: true });
    try {
      reader.pragma('query_only = ON');
      const retained = reader
        .prepare(
          "SELECT content_json FROM control_product_entries WHERE kind='item' AND turn_id=? ORDER BY sequence"
        )
        .pluck()
        .all(turn.id) as string[];
      expect(retained).toHaveLength(items.length);
      expect(
        retained.map((json) => readRetainedBodyBytes(scope.contentMount.root, JSON.parse(json)))
      ).toEqual(items.map((item) => Buffer.from(JSON.stringify(writeRetainedV1(item)), 'utf8')));
    } finally {
      reader.close();
    }
  });

  it('reports a post-close recovery seal refusal and permits an explicit fresh opening', async () => {
    const root = mkdtempSync(join(tmpdir(), 'control-recovery-seal-refusal-'));
    roots.push(root);
    client = getControlStoreWorkerClient();
    const store = await createDemoStore({ dataRoot: root });
    const turn = await store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Private recovery', {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    });
    const scope = nativeProductScope(root, turn.owner);
    const database = `workspace:${scope.path}`;
    const tree = join(root, 'workspaces', DEMO_WORKSPACE_ID);
    const before = store.listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID);
    const inode = statSync(scope.path).ino;
    expect(dataRootBackup.inventoryRegularFiles(tree).length).toBeGreaterThan(0);
    // Fault injection follows valid owner setup; inventory and sealing must refuse this link.
    const link = join(tree, 'forbidden-recovery-link');
    symlinkSync(scope.path, link);
    await expect(client.sealRecovery(database)).resolves.toBeNull();
    expect(statSync(scope.path).ino).toBe(inode);
    rmSync(link);
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      productOwner: scope.owner,
      contentMount: scope.contentMount,
      create: false,
      initialize: 'workspace',
    });
    const item = await store.createItem({
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Explicitly reopened after a seal refusal.',
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt!,
    });
    expect(store.listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)).toEqual([...before, item]);
    expect(statSync(scope.path).ino).toBe(inode);
  });

  it.each(['before', 'after'] as const)(
    'keeps healthy Workspace ACKs independent of a sibling held %s COMMIT and its lost host',
    async (point) => {
      const posted = vi.spyOn(Worker.prototype, 'postMessage');
      const f = await poolFixture(2, point);
      const original = f.scope(0);
      const healthy = f.scope(1);
      Atomics.store(f.gate!, 0, 0);
      const write = f.client
        .write(original.database, nativeRequest('original'))
        .catch((error: unknown) => error);
      try {
        await waitForHold(f.gate!);
        expect(nativeRequests(original.path)).toEqual(point === 'after' ? ['original'] : []);
        // This must finish while the other native thread is still blocked, without a shorter test deadline.
        await expect(
          f.client.write(healthy.database, nativeRequest('healthy'))
        ).resolves.toHaveLength(1);
        expect(nativeRequests(healthy.path)).toEqual(['healthy']);
        expect(Atomics.load(f.gate!, 1)).toBe(0);
        const call = posted.mock.calls.findIndex(
          ([request]) => request.database === original.database && request.operation === 'write'
        );
        const failedHost = posted.mock.contexts[call] as NativeWorker;
        await failedHost.terminate();
        expect(await write).toMatchObject({ code: 'unavailable', commit: 'unknown' });
        await expect(
          f.client.write(original.database, nativeRequest('no-retry'))
        ).rejects.toMatchObject({
          code: 'unavailable',
          commit: 'not-committed',
        });
        await expect(
          f.client.write(healthy.database, nativeRequest('later'))
        ).resolves.toHaveLength(1);
        expect(nativeRequests(original.path)).toEqual(point === 'after' ? ['original'] : []);
        expect(nativeRequests(healthy.path)).toEqual(['healthy', 'later']);
        expect(
          posted.mock.calls.filter(
            ([request]) => request.database === original.database && request.operation === 'write'
          )
        ).toHaveLength(1);
      } finally {
        release(f.gate);
      }
    }
  );

  it.each([false, true])(
    'excludes canonical and hardlink aliases process-wide with held fresh ACK = %s',
    async (held) => {
      const f = await poolFixture(4, held ? 'open-ack' : undefined);
      const original = f.scope(held ? 4 : 0);
      let opening: Promise<unknown> | undefined;
      if (held) {
        Atomics.store(f.gate!, 0, 0);
        opening = f.client.open(original);
        await waitForHold(f.gate!);
      }
      try {
        // In the held case these real initialized bytes exist before the successful open reply is delivered.
        expect(nativeRequests(original.path)).toEqual([]);
        const canonicalAlias = join(f.root, 'canonical-alias.sqlite');
        const hardlink = join(f.root, 'hardlink-alias.sqlite');
        symlinkSync(original.path, canonicalAlias);
        linkSync(original.path, hardlink);
        for (const [index, path] of [original.path, canonicalAlias, hardlink].entries()) {
          await expect(
            f.client.open({
              database: `alias-${index}`,
              path,
              create: false,
              initialize: 'workspace',
            })
          ).rejects.toMatchObject({ code: 'invalid-request', commit: 'not-committed' });
        }
      } finally {
        release(f.gate);
        await opening;
      }
    }
  );

  it('admits only one writer when a fresh target races its pre-existing dangling leaf symlink', async () => {
    const f = await poolFixture(4, 'open-ack');
    const target = f.scope(4);
    const alias = join(f.root, 'dangling.sqlite');
    symlinkSync(target.path, alias);
    expect(existsSync(target.path)).toBe(false);
    Atomics.store(f.gate!, 0, 0);
    const observe = (open: Promise<unknown>) =>
      open.then(
        () => ({ status: 'ok' as const }),
        (error: unknown) => ({ status: 'error' as const, error })
      );
    const resume = await f.client.pauseForDataRootBackup();
    const opens: ReturnType<typeof observe>[] = [];
    try {
      try {
        // Hold posting so both parent admissions see the target absent, regardless of Worker scheduling.
        opens.push(
          observe(
            f.client.open({
              database: 'dangling-alias',
              path: alias,
              create: true,
              initialize: 'workspace',
            })
          ),
          observe(
            f.client.open({
              database: target.database,
              path: target.path,
              create: true,
              initialize: 'workspace',
            })
          )
        );
        expect(existsSync(target.path)).toBe(false);
      } finally {
        resume();
      }
      await waitForHold(f.gate!);
      expect(nativeRequests(target.path)).toEqual([]);
      // The real initialized winner's successful ACK is held; only a truthful loser can settle now.
      expect(await Promise.race(opens)).toMatchObject({
        status: 'error',
        error: { code: 'invalid-request', commit: 'not-committed' },
      });
    } finally {
      release(f.gate);
    }
    const results = await Promise.all(opens);
    expect(results.filter((result) => result.status === 'ok')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'error')).toHaveLength(1);
  });

  it('settles an accepted producer and shutdown when its idle host exits before the causal write', async () => {
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const f = await poolFixture(2);
    const original = f.scope(0);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const observe = <T>(value: Promise<T>) =>
      value.then(
        (result) => ({ status: 'ok' as const, result }),
        (error: unknown) => ({ status: 'error' as const, error })
      );
    const producer = observe(
      f.client.runOperation(async () => {
        enter();
        await barrier;
        return f.client.write(original.database, nativeRequest('causal-after-loss'));
      })
    );
    await entered;
    const shutdown = observe(f.client.shutdown());
    try {
      const call = posted.mock.calls.findIndex(
        ([request]) => request.database === original.database && request.operation === 'open'
      );
      await (posted.mock.contexts[call] as NativeWorker).terminate();
    } finally {
      resume();
    }
    const produced = await producer;
    const stopped = await shutdown;
    // This shutdown has settled; do not await the same expected rejection again in afterEach.
    if (f.client.isClosed) client = undefined;
    expect(f.client.isClosed).toBe(true);
    expect(produced).toMatchObject({
      status: 'error',
      error: { code: 'unavailable', commit: 'not-committed' },
    });
    expect(stopped).toMatchObject({ status: 'error', error: expect.any(AggregateError) });
    if (
      produced.status !== 'error' ||
      stopped.status !== 'error' ||
      !(stopped.error instanceof AggregateError)
    )
      throw new Error('Shutdown must report the rejected accepted producer.');
    expect(stopped.error.errors).toHaveLength(1);
    expect(stopped.error.errors[0]).toBe(produced.error);
    expect(nativeRequests(original.path)).toEqual([]);
    expect(
      posted.mock.calls.filter(
        ([request]) => request.database === original.database && request.operation === 'write'
      )
    ).toHaveLength(0);
  });

  it('drains only matching posted ACKs and defers matching posts while a sibling progresses', async () => {
    const f = await poolFixture(2, 'after');
    const target = f.scope(0);
    const sibling = f.scope(1);
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const holds: Promise<() => void>[] = [];
    let acquired = false;
    Atomics.store(f.gate!, 0, 0);
    const original = f.client.write(target.database, nativeRequest('before-hold'));
    const originalSettled = Promise.allSettled([original]);
    let deferred: Promise<unknown> | undefined;
    try {
      await waitForHold(f.gate!);
      const pause = f.client.pauseForDataRootBackup(target.database).then((resume) => {
        acquired = true;
        return resume;
      });
      holds.push(pause);
      deferred = f.client.write(target.database, nativeRequest('during-hold'));
      void deferred.catch(() => {});
      await expect(
        f.client.write(sibling.database, nativeRequest('healthy'))
      ).resolves.toHaveLength(1);
      expect(acquired).toBe(false);
      expect(nativeRequests(target.path)).toEqual(['before-hold']);
      expect(
        posted.mock.calls.filter(
          ([request]) => request.database === target.database && request.operation === 'write'
        )
      ).toHaveLength(1);
      release(f.gate);
      await original;
      const resume = await pause;
      expect(acquired).toBe(true);
      expect(nativeRequests(target.path)).toEqual(['before-hold']);
      resume();
      await deferred;

      // Re-arm the same real ACK gate on the sibling; it must not join the target's drain.
      Atomics.store(f.gate!, 0, 0);
      Atomics.store(f.gate!, 1, 0);
      const siblingWrite = f.client.write(sibling.database, nativeRequest('sibling-held'));
      void siblingWrite.catch(() => {});
      try {
        await waitForHold(f.gate!);
        const targetPause = f.client.pauseForDataRootBackup(target.database);
        holds.push(targetPause);
        await targetPause;
        expect(Atomics.load(f.gate!, 1)).toBe(0);
        expect(nativeRequests(sibling.path)).toContain('sibling-held');
      } finally {
        release(f.gate);
        await Promise.allSettled([siblingWrite]);
      }
      await expect(siblingWrite).resolves.toHaveLength(1);
    } finally {
      release(f.gate);
      for (const hold of holds) (await hold)();
      await originalSettled;
      await Promise.allSettled(deferred === undefined ? [] : [deferred]);
    }
  });

  it('refuses a scoped hold on a failed channel without replaying posted or deferred writes', async () => {
    const f = await poolFixture(2, 'after');
    const target = f.scope(0);
    const sibling = f.scope(1);
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    Atomics.store(f.gate!, 0, 0);
    const original = f.client
      .write(target.database, nativeRequest('committed-before-loss'))
      .catch((error: unknown) => error);
    let pause: Promise<unknown> | undefined;
    let deferred: Promise<unknown> | undefined;
    try {
      await waitForHold(f.gate!);
      pause = f.client.pauseForDataRootBackup(target.database).catch((error: unknown) => error);
      deferred = f.client
        .write(target.database, nativeRequest('never-posted'))
        .catch((error: unknown) => error);
      const call = posted.mock.calls.findIndex(
        ([request]) => request.database === target.database && request.operation === 'write'
      );
      await (posted.mock.contexts[call] as NativeWorker).terminate();
      expect(await original).toMatchObject({ code: 'unavailable', commit: 'unknown' });
      expect(await pause).toMatchObject({ code: 'unavailable' });
      expect(await deferred).toMatchObject({ code: 'unavailable', commit: 'not-committed' });
      await expect(f.client.pauseForDataRootBackup(target.database)).rejects.toMatchObject({
        code: 'unavailable',
      });
      await expect(
        f.client.write(sibling.database, nativeRequest('healthy-after-loss'))
      ).resolves.toHaveLength(1);
      expect(nativeRequests(target.path)).toEqual(['committed-before-loss']);
      expect(
        posted.mock.calls.filter(
          ([request]) => request.database === target.database && request.operation === 'write'
        )
      ).toHaveLength(1);
      expect(getControlStoreWorkerClient()).toBe(f.client);
    } finally {
      release(f.gate);
      const held = await pause;
      if (typeof held === 'function') held();
      await Promise.allSettled(deferred === undefined ? [original] : [original, deferred]);
    }
  });

  it('orders same-database holds FIFO and excludes later holds behind the global backup', async () => {
    const f = await poolFixture(3);
    const target = f.scope(0);
    const sibling = f.scope(1);
    const other = f.scope(2);
    const holds: Promise<() => void>[] = [];
    const queued: Promise<unknown>[] = [];
    const first = f.client.pauseForDataRootBackup(target.database);
    holds.push(first);
    const releaseFirst = await first;
    let secondAcquired = false;
    let globalAcquired = false;
    let laterTargetAcquired = false;
    let laterSiblingAcquired = false;
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    try {
      const second = f.client.pauseForDataRootBackup(target.database).then((resume) => {
        secondAcquired = true;
        return resume;
      });
      holds.push(second);
      const independent = f.client.pauseForDataRootBackup(sibling.database);
      holds.push(independent);
      const releaseIndependent = await independent;
      expect(secondAcquired).toBe(false);
      const global = f.client.pauseForDataRootBackup().then((resume) => {
        globalAcquired = true;
        return resume;
      });
      holds.push(global);
      const laterTarget = f.client.pauseForDataRootBackup(target.database).then((resume) => {
        laterTargetAcquired = true;
        return resume;
      });
      holds.push(laterTarget);
      const laterSibling = f.client.pauseForDataRootBackup(sibling.database).then((resume) => {
        laterSiblingAcquired = true;
        return resume;
      });
      holds.push(laterSibling);
      const otherWrite = f.client.write(other.database, nativeRequest('after-global'));
      queued.push(otherWrite);
      void otherWrite.catch(() => {});
      releaseFirst();
      const releaseSecond = await second;
      expect(globalAcquired).toBe(false);
      // Calling the old release twice must not release its current same-database successor.
      releaseFirst();
      const targetWrite = f.client.write(target.database, nativeRequest('after-local'));
      queued.push(targetWrite);
      void targetWrite.catch(() => {});
      await nextTurn();
      expect(posted.mock.calls.filter(([request]) => request.operation === 'write')).toHaveLength(
        0
      );
      releaseSecond();
      await nextTurn();
      expect(globalAcquired).toBe(false);
      releaseIndependent();
      const resumeGlobal = await global;
      expect(laterTargetAcquired).toBe(false);
      expect(laterSiblingAcquired).toBe(false);
      expect(posted.mock.calls.filter(([request]) => request.operation === 'write')).toHaveLength(
        0
      );
      resumeGlobal();
      await Promise.all([laterTarget, laterSibling]);
      await expect(otherWrite).resolves.toHaveLength(1);
      expect(
        posted.mock.calls.filter(
          ([request]) => request.database === target.database && request.operation === 'write'
        )
      ).toHaveLength(0);
    } finally {
      // Creation order is safe on assertion failure: each release lets its queued successor settle.
      for (const hold of holds) (await hold)();
      await Promise.allSettled(queued);
    }
    await expect(Promise.all(queued)).resolves.toHaveLength(2);
    expect(nativeRequests(target.path)).toEqual(['after-local']);
    expect(nativeRequests(other.path)).toEqual(['after-global']);
  });

  it('pauses every routed Workspace and server host during a global backup capture', async () => {
    const f = await productPoolFixture();
    roots.push(`${f.root}.backups`);
    const scopes = f.workspaces.map((workspace) => ({
      database: `workspace:${workspaceDbPath(f.root, workspace.id)}`,
      path: workspaceDbPath(f.root, workspace.id),
    }));
    const server = {
      database: `server:${coreDbPath(f.root)}`,
      path: coreDbPath(f.root),
      create: false,
      initialize: 'core' as const,
      productOwner: { kind: 'server' as const },
      dataRoot: f.root,
    };
    await f.client.open(server);
    scopes.push(server);
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const capture = dataRootBackup.writeHotDataRootBackup;
    const waiting: Promise<unknown>[] = [];
    let during = -1;
    vi.spyOn(dataRootBackup, 'writeHotDataRootBackup').mockImplementationOnce((input) => {
      for (const scope of scopes)
        waiting.push(
          f.client.write(scope.database, [
            {
              mode: 'get',
              sql: 'SELECT 1 AS value',
              parameters: [],
            },
          ])
        );
      during = posted.mock.calls.filter(([request]) => request.operation === 'write').length;
      return capture(input);
    });
    await createDataRootAdminOperationImplementations(f.root, undefined, pauseFixturePublishers)[
      'backup.create'
    ]();
    await expect(Promise.all(waiting)).resolves.toHaveLength(5);
    expect(during).toBe(0);
    const hosts = posted.mock.calls.flatMap(([request], index) =>
      request.operation === 'write' ? [posted.mock.contexts[index]] : []
    );
    expect(hosts).toHaveLength(5);
    expect(new Set(hosts).size).toBe(5);
  });

  it('bounds Material binary admission per database before posting and preserves sibling service', async () => {
    interception.gate = new SharedArrayBuffer(16);
    interception.point = 'before';
    const gate = new Int32Array(interception.gate);
    Atomics.store(gate, 0, 1); // Setup remains outside the real COMMIT holds.
    Atomics.store(gate, 3, -1); // Select the actual target host only after its scope is open.
    const f = await productPoolFixture();
    const materials = [];
    for (let index = 0; index < 5; index += 1) {
      const workspaceId = f.workspaces[0]!.id;
      const { materialId } = await f.call(workspaceId, 'material.create', {
        requestId: `create-${index}`,
        title: `Material ${index}`,
        kind: 'text',
        sensitivity: 'internal',
      });
      materials.push({ workspaceId, materialId });
    }
    const knowledgeWorkspaceId = f.workspaces[0]!.id;
    const knowledgeDatabase = `workspace:${
      nativeProductScope(f.root, {
        kind: 'workspace',
        workspaceId: knowledgeWorkspaceId,
      }).path
    }`;
    const knowledgeCall = await f.client.capability(knowledgeDatabase, {
      kind: 'admit',
      workspaceId: knowledgeWorkspaceId,
      now: new Date().toISOString(),
      context: {
        authorityActor: null,
        family: 'knowledge',
        operation: 'knowledge.ask',
        capabilityId: 'knowledge.ask',
        redactionClass: 'metadata-only',
      },
    });
    if (!knowledgeCall || typeof knowledgeCall !== 'object' || !('context' in knowledgeCall))
      throw new Error('Native Knowledge admission did not return its original Call.');
    const finishKnowledge = () =>
      f.client.capability(knowledgeDatabase, {
        kind: 'usage-finish',
        workspaceId: knowledgeWorkspaceId,
        call: knowledgeCall,
        finish: {
          status: 'succeeded',
          deliveredKnowledgeAnswer: 'x',
          now: new Date().toISOString(),
        },
      });
    const save = (index: number, content: string) => {
      const { workspaceId, materialId } = materials[index]!;
      return f.call(workspaceId, 'material.revision-save', {
        requestId: `save-${index}`,
        materialId,
        expectedRevisionId: null,
        content,
        contentDigest: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
      });
    };
    const post = Worker.prototype.postMessage;
    const targetPost = vi.spyOn(Worker.prototype, 'postMessage');
    await f.client.write(knowledgeDatabase, [
      { mode: 'get', sql: 'SELECT 1 AS value', parameters: [] },
    ]);
    const targetCall = targetPost.mock.calls.findIndex(
      ([request]) => request.database === knowledgeDatabase
    );
    const targetHost = interception.workers.indexOf(
      targetPost.mock.contexts[targetCall] as NativeWorker
    );
    expect(targetHost).toBeGreaterThanOrEqual(0);
    Atomics.store(gate, 3, targetHost);
    targetPost.mockRestore();
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    let materialPosts = 0;
    const posted = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: NativeWorker,
      ...args: Parameters<NativeWorker['postMessage']>
    ) {
      post.apply(this, args);
      if (args[0]?.operation === 'material' && ++materialPosts === 4) admit();
    });
    // The accepted per-database binary budget is 64 MiB; four valid 16 MiB saves fill it exactly.
    expect(CONTROL_WORKER_LIMITS.materialPendingBytes).toBe(67_108_864);
    Atomics.store(gate, 0, 0);
    Atomics.store(gate, 2, 1); // Hold the target COMMIT so no reply frees its binary reservation.
    const accepted = Array.from({ length: 4 }, (_, index) => save(index, 'a'.repeat(16_777_216)));
    const settled = Promise.allSettled(accepted);
    try {
      await admitted;
      const materialRequests = posted.mock.calls.filter(
        ([request]) => request.operation === 'material'
      );
      expect(materialRequests).toHaveLength(4);
      await waitForHold(gate);
      await expect(save(4, 'x')).rejects.toMatchObject({ code: 'busy', commit: 'not-committed' });
      const capabilityPosts = posted.mock.calls.filter(
        ([request]) => request.operation === 'capability'
      ).length;
      await expect(finishKnowledge()).rejects.toMatchObject({
        code: 'busy',
        commit: 'not-committed',
      });
      expect(
        posted.mock.calls.filter(([request]) => request.operation === 'capability')
      ).toHaveLength(capabilityPosts);
      expect(
        posted.mock.calls.filter(([request]) => request.operation === 'material')
      ).toHaveLength(4);
      const siblingDatabase = `workspace:${workspaceDbPath(f.root, f.workspaces[1]!.id)}`;
      await expect(
        f.client.write(siblingDatabase, [{ mode: 'get', sql: 'SELECT 1 AS value', parameters: [] }])
      ).resolves.toMatchObject([{ mode: 'get', row: { value: 1n } }]);
      expect(Atomics.load(gate, 1)).toBe(0);
    } finally {
      release(gate);
      await settled;
    }
    await expect(Promise.all(accepted)).resolves.toHaveLength(4);
    // The fifth request becomes admissible only after the original reservations settle.
    await expect(save(4, 'x')).resolves.toHaveProperty('revisionId');
    await finishKnowledge();
  });

  // COORD21:55 r2-FIX-3 P1: eight TOTAL pending per physical database/Turn, including preparation.
  it('bounds a physical Turn before preparation while peer Turns and effect admission keep service', async () => {
    const f = await productPoolFixture();
    const database = `workspace:${workspaceDbPath(f.root, f.workspaces[0]!.id)}`;
    const sibling = `workspace:${workspaceDbPath(f.root, f.workspaces[1]!.id)}`;
    const aliasPath = join(f.root, 'publication-alias.sqlite');
    symlinkSync(workspaceDbPath(f.root, f.workspaces[0]!.id), aliasPath);
    const alias = `workspace:${aliasPath}`;
    const opening = {
      database,
      path: workspaceDbPath(f.root, f.workspaces[0]!.id),
      dataRoot: f.root,
      create: false,
      initialize: 'workspace',
      productOwner: { kind: 'workspace', workspaceId: f.workspaces[0]!.id },
    } as const;
    const turn = allocateEntityId('tu');
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const prepare = vi.fn(async (input: { id: string }) => {
      if (input.id === 'hot-0') {
        entered();
        await held;
      }
      return f.client.write(database, nativeRequest(input.id));
    });
    const accepted = [f.client.runTurnPublication(opening, [turn], { id: 'hot-0' }, prepare)];
    const settled: Promise<unknown>[] = [Promise.allSettled(accepted)];
    let excess: Promise<unknown> | undefined;
    try {
      await preparing;
      for (let index = 1; index < 8; index += 1)
        accepted.push(
          f.client.runTurnPublication(
            index % 2 ? { ...opening, database: alias, path: aliasPath } : opening,
            [turn],
            { id: `hot-${index}` },
            prepare
          )
        );
      settled.push(Promise.allSettled(accepted));
      const rejectedPrepare = vi.fn(async () => f.client.write(database, nativeRequest('excess')));
      excess = f.client
        .runTurnPublication(
          { ...opening, database: alias, path: aliasPath },
          [turn],
          {},
          rejectedPrepare
        )
        .then(
          () => ({ code: 'unexpected-accept' }),
          (error: unknown) => error
        );
      const disposition = await Promise.race([
        excess,
        nextTurn().then(() => ({ code: 'still-pending' })),
      ]);
      expect.soft(disposition).toMatchObject({ code: 'busy', commit: 'not-committed' });
      expect.soft(rejectedPrepare).not.toHaveBeenCalled();
      expect.soft(prepare).toHaveBeenCalledTimes(1);
      await f.client.runTurnPublication(opening, [allocateEntityId('tu')], { id: 'peer' }, prepare);
      await f.client.runTurnPublication(
        {
          ...opening,
          database: sibling,
          path: workspaceDbPath(f.root, f.workspaces[1]!.id),
          productOwner: { kind: 'workspace', workspaceId: f.workspaces[1]!.id },
        },
        [turn],
        {},
        () => f.client.write(sibling, nativeRequest('sibling'))
      );
      const workspaceId = f.workspaces[0]!.id;
      const call = await f.client.capability(database, {
        kind: 'admit',
        workspaceId,
        now: new Date().toISOString(),
        context: {
          authorityActor: null,
          family: 'knowledge',
          operation: 'knowledge.ask',
          capabilityId: 'knowledge.ask',
          redactionClass: 'metadata-only',
        },
      });
      expect(call).toHaveProperty('context');
      expect(nativeRequests(database.slice('workspace:'.length))).toEqual(['peer']);
      expect(nativeRequests(sibling.slice('workspace:'.length))).toEqual(['sibling']);
    } finally {
      resume();
      await Promise.all(settled);
      await excess;
    }
    await expect(Promise.all(accepted)).resolves.toHaveLength(8);
    expect.soft(nativeRequests(database.slice('workspace:'.length))).not.toContain('excess');
    // Refusal must not install a rejected tail that poisons later valid work.
    await expect(
      f.client.runTurnPublication(opening, [turn], { id: 'later' }, prepare)
    ).resolves.toHaveLength(1);
    expect(nativeRequests(database.slice('workspace:'.length))).toContain('later');
  });

  // P1 checks distinct affected Turns atomically; a refused tuple cannot consume or poison its free selector.
  it('admits distinct multi-Turn selectors atomically without double charging repeated selectors', async () => {
    const f = await poolFixture(1);
    const database = f.scope(0).database;
    const hot = allocateEntityId('tu'),
      cold = allocateEntityId('tu');
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const hotPrepare = vi.fn(async (id: string) => {
      await held;
      return f.client.write(database, nativeRequest(id));
    });
    const hotWork = Array.from({ length: 8 }, (_, index) =>
      f.client.runTurnPublication(f.scope(0), [hot], `hot-${index}`, hotPrepare)
    );
    const hotSettled = Promise.allSettled(hotWork);
    const rejectedPrepare = vi.fn(async () => {
      throw new Error('A refused tuple must not prepare.');
    });
    const candidate = f.client
      .runTurnPublication(f.scope(0), [cold, hot], {}, rejectedPrepare)
      .then(
        () => ({ code: 'unexpected-accept' }),
        (error: unknown) => error
      );
    const coldPrepare = vi.fn(async (id: string) => {
      await held;
      return f.client.write(database, nativeRequest(id));
    });
    const coldWork = Array.from({ length: 8 }, (_, index) =>
      f.client.runTurnPublication(f.scope(0), [cold, cold], `cold-${index}`, coldPrepare)
    );
    const coldSettled = Promise.allSettled(coldWork);
    const overflowPrepare = vi.fn(async () => f.client.write(database, nativeRequest('overflow')));
    const overflow = f.client.runTurnPublication(f.scope(0), [cold], {}, overflowPrepare).then(
      () => ({ code: 'unexpected-accept' }),
      (error: unknown) => error
    );
    try {
      expect
        .soft(await Promise.race([candidate, nextTurn().then(() => ({ code: 'still-pending' }))]))
        .toMatchObject({ code: 'busy', commit: 'not-committed' });
      expect
        .soft(await Promise.race([overflow, nextTurn().then(() => ({ code: 'still-pending' }))]))
        .toMatchObject({ code: 'busy', commit: 'not-committed' });
      expect.soft(hotPrepare).toHaveBeenCalledTimes(1);
      expect.soft(coldPrepare).toHaveBeenCalledTimes(1);
      expect.soft(rejectedPrepare).not.toHaveBeenCalled();
      expect.soft(overflowPrepare).not.toHaveBeenCalled();
    } finally {
      resume();
      await Promise.all([hotSettled, coldSettled, candidate, overflow]);
    }
    expect((await hotSettled).map((result) => result.status)).toEqual(Array(8).fill('fulfilled'));
    expect((await coldSettled).map((result) => result.status)).toEqual(Array(8).fill('fulfilled'));
    expect(nativeRequests(f.scope(0).path)).toHaveLength(16);
  });

  it('never acknowledges a write held before COMMIT', async () => {
    const f = await fixture('before');
    let acknowledged = false;
    const write = f.client.write('user', metadata('held')).then((result) => {
      acknowledged = true;
      return result;
    });
    try {
      await waitForHold(f.gate!);
      expect(acknowledged).toBe(false);
      expect(count(f.path)).toBe(0);
    } finally {
      release(f.gate);
    }
    await write;
    expect(count(f.path)).toBe(1);
  });

  it('reports a lost reply as unknown even when the original receipt committed', async () => {
    const f = await fixture('after');
    const write = f.client
      .write('user', [
        {
          mode: 'run',
          sql: "INSERT INTO idempotency_requests (request_key, command_name, request_id, scope_json, input_hash, response_kind, response_id, created_at, expires_at) VALUES ('original-key', 'fixture', 'original-request', '{}', 'original-hash', 'thread', 'fixture', 'fixture', 'fixture')",
          parameters: [],
        },
      ])
      .catch((error: unknown) => error);
    await waitForHold(f.gate!);
    const reader = new Database(f.path, { readonly: true, fileMustExist: true });
    try {
      reader.pragma('query_only = ON');
      expect(
        reader
          .prepare('SELECT input_hash FROM idempotency_requests WHERE request_key = ?')
          .pluck()
          .get('original-key')
      ).toBe('original-hash');
    } finally {
      reader.close();
    }
    await interception.workers[0]!.terminate();
    expect(await write).toMatchObject({ code: 'unavailable', commit: 'unknown' });
    expect(getControlStoreWorkerClient()).toBe(f.client);
    await expect(f.client.write('user', metadata('not-replayed'))).rejects.toMatchObject({
      commit: 'not-committed',
    });
    expect(interception.workers).toHaveLength(1);
  });

  it('reopens and exactly replays an execution-attempt transition after its FULL reply is lost', async () => {
    const root = mkdtempSync(join(tmpdir(), 'control-attempt-lost-ack-'));
    roots.push(root);
    ensureLayout(root);
    const coreDb = openCoreDb(root);
    nativeHandles.push(coreDb);
    applyMigrations(coreDb);
    const ownerUserId = ensureLocalUser(coreDb);
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId });
    const entry = createSchedulerAdmissionEntry(coreDb, {
      queueEntryId: 'queue-attempt-lost-ack',
      backendId: 'nanohost',
      triggerActor: { kind: 'user', id: ownerUserId },
      workspaceId,
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-7000-8000-000000000001',
      inputRef: schedulerFixtureInput(
        workspaceId,
        'tu_00000000-0000-7000-8000-000000000001',
        'Retain one exact attempt transition across a lost FULL reply.'
      ),
      requestedAgentId: 'agent_worker',
    });
    const attempt = createSchedulerExecutionAttempt(coreDb, {
      entry,
      attemptId: 'attempt_00000000-0000-7000-8000-000000000001',
      preparationInput: { admission: entry },
      now: () => '2026-11-01T00:05:00.000Z',
    });
    const scope = nativeProductScope(root, { kind: 'server' });
    const database = `core:${scope.path}`;
    interception.gate = new SharedArrayBuffer(8);
    interception.point = 'after';
    const gate = new Int32Array(interception.gate);
    client = getControlStoreWorkerClient();
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    const command = {
      kind: 'bind-session' as const,
      attemptId: attempt.attemptId,
      agentSessionId: 'as_00000000-0000-7000-8000-000000000001',
      observedAt: '2026-11-01T00:05:01.000Z',
    };
    const original = client.executionAttempt(database, command).catch((error: unknown) => error);
    await waitForHold(gate);
    const committed = requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
    expect(committed).toMatchObject({
      agentSessionId: command.agentSessionId,
      updatedAt: command.observedAt,
    });
    await interception.workers[0]!.terminate();
    await expect(original).resolves.toMatchObject({ code: 'unavailable', commit: 'unknown' });

    interception.gate = undefined;
    await shutdownControlStoreWorkerClient();
    client = getControlStoreWorkerClient();
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    await expect(client.executionAttempt(database, command)).resolves.toEqual(committed);
    expect(requireSchedulerExecutionAttempt(coreDb, attempt.attemptId)).toEqual(committed);
  });

  it('fails closed on an unsupported reply rather than satisfying a pending command', async () => {
    const f = await fixture('before');
    const write = f.client.write('user', metadata('unknown')).catch((error: unknown) => error);
    await waitForHold(f.gate!);
    interception.workers[0]!.emit('message', {
      version: 99,
      id: 1,
      status: 'ok',
      operation: 'write',
      results: [],
    });
    expect(await write).toMatchObject({ commit: 'unknown' });
    expect(getControlStoreWorkerClient()).toBe(f.client);
  });

  it('holds backup copying until native acknowledgement and captures the complete Item closure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'control-backup-'));
    roots.push(root, `${root}.backups`);
    interception.gate = new SharedArrayBuffer(8);
    interception.point = 'before';
    const gate = new Int32Array(interception.gate);
    Atomics.store(gate, 0, 1); // Setup commits are outside the controlled publication.
    client = getControlStoreWorkerClient();
    const store = await createDemoStore({ dataRoot: root });
    const turn = await store.createTurn(
      DEMO_WORKSPACE_ID,
      DEMO_THREAD_ID,
      'Capture the acknowledged result.',
      { kind: 'user', id: FIXTURE_LOCAL_USER_ID }
    );
    const capture = vi.spyOn(dataRootBackup, 'writeHotDataRootBackup');
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    Atomics.store(gate, 0, 0);
    let acknowledged = false;
    const publication = store
      .createItem({
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'Exact immutable backup bytes.\n',
        createdAt: turn.startedAt!,
        completedAt: turn.startedAt!,
      })
      .then((item) => {
        acknowledged = true;
        return item;
      });
    await waitForHold(gate);
    expect(posted).toHaveBeenCalled();
    expect(acknowledged).toBe(false);
    const operations = createDataRootAdminOperationImplementations(
      root,
      undefined,
      pauseFixturePublishers
    );
    const backup = operations['backup.create']();
    let copiesWhileHeld = -1;
    let destinationWhileHeld = true;
    try {
      await nextTurn();
      copiesWhileHeld = capture.mock.calls.length;
      destinationWhileHeld = existsSync(`${root}.backups`);
    } finally {
      release(gate);
    }
    // Settle both real owners so a failed ordering check leaves no in-flight request.
    await Promise.allSettled([publication, backup]);
    expect(copiesWhileHeld).toBe(0);
    expect(destinationWhileHeld).toBe(false);
    const item = await publication;
    const result = await backup;
    expect(acknowledged).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    const backupRoot = join(`${root}.backups`, result.backupId);
    const verified = dataRootBackup.verifyDataRootBackupManifest({ backupRoot });
    expect(verified.manifest).toEqual(result.manifest);
    expect(operations['backup.verify']({ backupId: result.backupId }).manifest).toEqual(
      result.manifest
    );
    expect(
      new FsStore({ dataRoot: backupRoot }).listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)
    ).toEqual([item]);
    for (const path of [coreDbPath(backupRoot), workspaceDbPath(backupRoot, DEMO_WORKSPACE_ID)]) {
      const reader = new Database(path, { readonly: true, fileMustExist: true });
      try {
        expect(reader.pragma('quick_check', { simple: true })).toBe('ok');
      } finally {
        reader.close();
      }
    }
    const reader = new Database(workspaceDbPath(backupRoot, DEMO_WORKSPACE_ID), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const entries = reader
        .prepare('SELECT content_json FROM control_product_entries ORDER BY sequence')
        .pluck()
        .all() as string[];
      expect(entries.length).toBeGreaterThan(0);
      const scope = nativeProductScope(backupRoot, turn.owner);
      for (const json of entries) {
        const content = JSON.parse(json);
        const bytes = readRetainedBodyBytes(scope.contentMount.root, content);
        expect(bytes.length).toBe(content.byteLength);
        expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(
          content.reference.contentDigest
        );
      }
    } finally {
      reader.close();
    }
  });

  it('bounds capture waiters before posting and commits them only after backup resumes', async () => {
    const f = await fixture(undefined, 'data-root');
    roots.push(`${f.root}.backups`);
    const posted = vi.spyOn(interception.workers[0]!, 'postMessage');
    const capture = dataRootBackup.writeHotDataRootBackup;
    const operations = createDataRootAdminOperationImplementations(
      f.root,
      undefined,
      pauseFixturePublishers
    );
    const accepted: Promise<unknown>[] = [];
    let excess: Promise<unknown> | undefined;
    let postedDuringCapture = -1;
    let rowsDuringCapture = -1;
    vi.spyOn(dataRootBackup, 'writeHotDataRootBackup').mockImplementationOnce((input) => {
      accepted.push(f.client.write('user', metadata('after-capture')));
      for (let index = 1; index < CONTROL_WORKER_LIMITS.pendingTransitions; index += 1) {
        accepted.push(
          f.client.write('user', [{ mode: 'get', sql: 'SELECT 1 AS value', parameters: [] }])
        );
      }
      excess = f.client.write('user', metadata('excess')).catch((error: unknown) => error);
      postedDuringCapture = posted.mock.calls.length;
      rowsDuringCapture = count(f.path);
      return capture(input);
    });
    const result = await operations['backup.create']();
    await Promise.all(accepted);
    expect(postedDuringCapture).toBe(0);
    expect(rowsDuringCapture).toBe(0);
    expect(await excess).toMatchObject({ code: 'busy', commit: 'not-committed' });
    expect(
      count(userDbPath(join(`${f.root}.backups`, result.backupId), FIXTURE_LOCAL_USER_ID))
    ).toBe(0);
    expect(count(f.path)).toBe(1);
    expect(posted.mock.calls.filter(([request]) => request.operation === 'write')).toHaveLength(
      CONTROL_WORKER_LIMITS.pendingTransitions
    );
    expect(interception.workers).toHaveLength(1);
  });

  it('resumes native commands after a real backup capture failure', async () => {
    const f = await fixture(undefined, 'data-root');
    roots.push(`${f.root}.backups`);
    writeFileSync(`${f.root}.backups`, 'The private backup destination is a file.');
    const posted = vi.spyOn(interception.workers[0]!, 'postMessage');
    const capture = dataRootBackup.writeHotDataRootBackup;
    let waiting: Promise<unknown> | undefined;
    let postedDuringCapture = -1;
    vi.spyOn(dataRootBackup, 'writeHotDataRootBackup').mockImplementationOnce((input) => {
      waiting = f.client.write('user', metadata('resumed'));
      postedDuringCapture = posted.mock.calls.length;
      return capture(input);
    });
    await expect(
      createDataRootAdminOperationImplementations(f.root, undefined, pauseFixturePublishers)[
        'backup.create'
      ]()
    ).rejects.toMatchObject({ code: 'data_root_backup_failed', status: 400 });
    expect(await waiting).toMatchObject([{ mode: 'run', changes: 1 }]);
    expect(postedDuringCapture).toBe(0);
    await expect(f.client.write('user', metadata('later'))).resolves.toMatchObject([
      { mode: 'run', changes: 1 },
    ]);
    expect(count(f.path)).toBe(2);
  });

  it('keeps posted loss unknown and unposted backup waiters not committed without replay', async () => {
    const f = await fixture('after', 'data-root');
    roots.push(`${f.root}.backups`);
    const posted = vi.spyOn(interception.workers[0]!, 'postMessage');
    const original = f.client
      .write('user', metadata('committed-before-lost-ack'))
      .catch((error: unknown) => error);
    await waitForHold(f.gate!);
    expect(count(f.path)).toBe(1);
    const capture = vi.spyOn(dataRootBackup, 'writeHotDataRootBackup');
    const nativePauseEntered = Promise.withResolvers<void>();
    const pause = f.client.pauseForDataRootBackup.bind(f.client);
    vi.spyOn(f.client, 'pauseForDataRootBackup').mockImplementationOnce((...args) => {
      const acquiring = pause(...args);
      nativePauseEntered.resolve();
      return acquiring;
    });
    const backup = createDataRootAdminOperationImplementations(
      f.root,
      undefined,
      pauseFixturePublishers
    )
      ['backup.create']()
      .catch((error: unknown) => error);
    await nativePauseEntered.promise;
    const waiting = f.client
      .write('user', metadata('never-posted'))
      .catch((error: unknown) => error);
    await interception.workers[0]!.terminate();
    expect(await original).toMatchObject({ code: 'unavailable', commit: 'unknown' });
    expect(await waiting).toMatchObject({ code: 'unavailable', commit: 'not-committed' });
    expect(await backup).toMatchObject({ code: 'data_root_backup_failed', status: 400 });
    expect(capture).not.toHaveBeenCalled();
    expect(posted.mock.calls.filter(([request]) => request.operation === 'write')).toHaveLength(1);
    expect(count(f.path)).toBe(1);
    expect(getControlStoreWorkerClient()).toBe(f.client);
    await expect(f.client.write('user', metadata('no-retry'))).rejects.toMatchObject({
      code: 'unavailable',
      commit: 'not-committed',
    });
    expect(interception.workers).toHaveLength(1);
  });

  it('retains closed initialization errors without exposing native diagnostic data', async () => {
    const f = await fixture();
    const bad = join(f.root, 'bad.sqlite');
    writeFileSync(bad, 'private invalid database marker');
    await expect(
      f.client.open({ database: 'bad', path: bad, create: false, initialize: 'user' })
    ).rejects.toMatchObject({ code: 'integrity' });
    await expect(
      f.client.open({
        database: 'bad-scope',
        path: join(f.root, 'unopened.sqlite'),
        create: true,
        initialize: 'app' as never,
      })
    ).rejects.toMatchObject({ code: 'invalid-request', commit: 'not-committed' });
    await expect(f.client.write('user', metadata('healthy'))).resolves.toHaveLength(1);
  });
});

// Core Storage / Snapshot Cut And Capture Protection: a drain alone cannot authorize a moving cut.
// These tests qualify the native Core/User/Workspace/App SQL join, not mutable file-owner closure.
describe('typed global capture cut across native physical owners', () => {
  it.each(['Core', 'User', 'Workspace'] as const)(
    'captures one exact typed cut after the held %s FULL ACK and excludes later native mutations',
    async (heldScope) => {
      // Extra test-owned slots select an exact physical DB even when User and Workspace share a host.
      interception.gate = new SharedArrayBuffer(4 * (5 + 4096));
      interception.point = 'before';
      const gate = new Int32Array(interception.gate);
      Atomics.store(gate, 0, 1);
      Atomics.store(gate, 3, -1); // No setup host is selected for a COMMIT hold.
      const f = await productPoolFixture();
      roots.push(`${f.root}.backups`);
      const workspace = f.workspaces[0]!;
      const actor = { kind: 'user' as const, id: f.userId };
      const turns: Array<Awaited<ReturnType<FsStore['createTurn']>>> = [];
      for (const name of [
        'First queued work',
        'Later queued work',
        'Read membership',
        'Item publication',
      ]) {
        const thread = await f.store.createThread(workspace.id, name);
        turns.push(await f.store.createTurn(workspace.id, thread.id, name, actor));
      }
      const userTurn = turns[2]!;
      const itemTurn = turns[3]!;
      const stamp = new Date().toISOString();
      const message = (
        turn: (typeof turns)[number],
        text: string
      ): Extract<Item, { type: 'assistant-message' }> => ({
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text,
        createdAt: stamp,
        completedAt: stamp,
      });
      const eligible = [
        message(userTurn, 'Actually displayed first reply.\r\n'),
        message(userTurn, 'Actually displayed later reply. 🚀'),
      ];
      for (const item of eligible) await f.store.createItem(item);
      const workspaceItems = [
        message(itemTurn, 'Included native Item bytes.\r\n'),
        message(itemTurn, 'Later native Item bytes. 🚀'),
      ];
      const coreScope = nativeProductScope(f.root, { kind: 'server' });
      const coreDatabase = `core:${coreScope.path}`;
      await f.client.open({
        database: coreDatabase,
        path: coreScope.path,
        dataRoot: f.root,
        create: false,
        initialize: 'core',
        productOwner: coreScope.owner,
        contentMount: coreScope.contentMount,
      });
      const userDb = await f.client.openInitializedUserReadDb(f.root, f.userId);
      const coreCommands = await Promise.all(
        turns.slice(0, 2).map(async (turn, index) => {
          const scope = { workspaceId: workspace.id, threadId: turn.threadId, turnId: turn.id };
          const requestId = randomUUID();
          const text =
            index === 0
              ? 'Include this original Core admission.\r\n'
              : 'Exclude this later Core admission. 🚀';
          const inputRef = WorkspaceQueueInputRefSchema.parse(
            await stageSchedulerStartInput(f.root, scope, requestId, text)
          );
          return {
            mode: 'create' as const,
            entry: {
              ...scope,
              backendId: 'nanohost',
              queueEntryId: `typed-capture-${index}-${randomUUID()}`,
              requestId,
              requestedAgentId: 'agent_worker',
              timestamp: stamp,
              triggerActor: actor,
              inputRef,
            },
          };
        })
      );
      const userDatabase = `user:${userDbPath(f.root, f.userId)}`;
      const workspaceDatabase = `workspace:${workspaceDbPath(f.root, workspace.id)}`;
      const selectors = {
        Core: { operation: 'transition', database: coreDatabase },
        User: { operation: 'thread-read-membership', database: userDatabase },
        Workspace: { operation: 'item', database: workspaceDatabase },
      };
      f.coreDb.sqlite.pragma('query_only = ON');
      const initialPosted = Promise.withResolvers<void>();
      const captureEntered = Promise.withResolvers<void>();
      const releaseCapture = Promise.withResolvers<void>();
      const initialRoles = new Set<string>();
      const frames: Array<{ operation: string; database: string; id: number }> = [];
      let initialPhase = true;
      let armed = false;
      const originalPost = Worker.prototype.postMessage;
      vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
        this: Worker,
        ...args
      ) {
        const request = args[0] as {
          operation?: string;
          database?: string;
          id?: number;
          transition?: { kind?: string };
        };
        for (const [role, selector] of Object.entries(selectors)) {
          if (
            request.operation !== selector.operation ||
            request.database !== selector.database ||
            (role === 'Core' && request.transition?.kind !== 'scheduler-work')
          )
            continue;
          if (typeof request.id !== 'number')
            throw new Error('Typed native frame has no request identity.');
          frames.push({ operation: request.operation, database: request.database, id: request.id });
          if (initialPhase) {
            initialRoles.add(role);
            if (role === heldScope && !armed) {
              const index = interception.workers.indexOf(this);
              if (index < 0) throw new Error('Typed mutation used an unobserved native host.');
              const selectedPath = realpathSync(
                {
                  Core: coreScope.path,
                  User: userDbPath(f.root, f.userId),
                  Workspace: workspaceDbPath(f.root, workspace.id),
                }[heldScope]
              );
              if (selectedPath.length > gate.length - 5)
                throw new Error('Owned test path does not fit its COMMIT selector.');
              for (let position = 0; position < selectedPath.length; position++)
                Atomics.store(gate, 5 + position, selectedPath.charCodeAt(position));
              Atomics.store(gate, 4, selectedPath.length);
              Atomics.store(gate, 3, index); // Exact actual host and DB, including shared-host routing.
              Atomics.store(gate, 0, 0);
              armed = true;
            }
            if (initialRoles.size === 3) initialPosted.resolve();
          }
        }
        return Reflect.apply(originalPost, this, args);
      });
      const pauseEntered = Promise.withResolvers<void>();
      let actualPauseAcquired = false;
      const pause = f.client.pauseForDataRootBackup.bind(f.client);
      vi.spyOn(f.client, 'pauseForDataRootBackup').mockImplementationOnce(async (...args) => {
        const acquiring = pause(...args);
        pauseEntered.resolve(); // The original global pause was called while the native gate is held.
        const resume = await acquiring;
        actualPauseAcquired = true; // Genuine original drain and global hold already own the cut.
        captureEntered.resolve();
        await releaseCapture.promise;
        return resume; // Exact original release; no copy/manifest result is substituted.
      });
      vi.spyOn(dataRootBackup, 'writeHotDataRootBackup');
      const tracked: Promise<unknown>[] = [];
      const track = <T>(promise: Promise<T>) => {
        tracked.push(promise);
        void promise.catch(() => {}); // Observe early failures without replacing the original result.
        return promise;
      };
      let userClosed = false;
      let backupRoot: string | undefined;
      try {
        const initialCore = track(admitCoreScheduler(f.coreDb, coreCommands[0]!));
        const initialUser = track(
          advanceThreadReadReceipt(userDb, workspace.id, userTurn.threadId, [eligible[0]!.id])
        );
        const initialWorkspace = track(f.store.createItem(workspaceItems[0]!));
        void Promise.all([initialCore, initialUser, initialWorkspace]).catch(initialPosted.reject);
        await initialPosted.promise; // All three actual typed frames are posted before the capture request.
        await waitForHold(gate);
        expect(armed).toBe(true);
        expect(initialRoles).toEqual(new Set(['Core', 'User', 'Workspace']));
        const settled = new Set<string>();
        for (const [name, pending] of [
          ['Core', initialCore],
          ['User', initialUser],
          ['Workspace', initialWorkspace],
        ] as const)
          void pending.then(
            () => {
              settled.add(name);
            },
            () => {}
          );
        expect(settled.has(heldScope)).toBe(false);
        if (heldScope === 'Core')
          expect(() =>
            requireSchedulerAdmissionEntry(f.coreDb, coreCommands[0]!.entry.queueEntryId)
          ).toThrow();
        if (heldScope === 'User')
          expect(readThreadReadReceipt(userDb, workspace.id, userTurn.threadId)).toEqual([]);
        if (heldScope === 'Workspace')
          expect(f.store.listThreadItems(workspace.id, itemTurn.threadId)).toEqual([]);
        const operations = createDataRootAdminOperationImplementations(
          f.root,
          undefined,
          pauseFixturePublishers
        );
        const backup = track(operations['backup.create']());
        await Promise.race([
          pauseEntered.promise,
          backup.then(() => {
            throw new Error('Backup bypassed the actual global pause entry.');
          }),
        ]);
        await nextTurn();
        expect(actualPauseAcquired).toBe(false); // Independent of the wrapper's later copy barrier.
        expect(vi.mocked(dataRootBackup.writeHotDataRootBackup)).not.toHaveBeenCalled();
        expect(existsSync(`${f.root}.backups`)).toBe(false);
        release(gate);
        await Promise.race([
          captureEntered.promise,
          backup.then(() => {
            throw new Error('Backup bypassed its actual copy boundary.');
          }),
        ]);
        expect(actualPauseAcquired).toBe(true);
        const queue = await initialCore;
        expect(queue.kind).toBe('queue');
        if (queue.kind !== 'queue')
          throw new Error('Core typed admission did not retain its queue entry.');
        expect(await initialUser).toEqual([eligible[0]!.id]);
        expect(await initialWorkspace).toEqual(workspaceItems[0]);
        expect(
          requireSchedulerAdmissionEntry(f.coreDb, coreCommands[0]!.entry.queueEntryId)
        ).toEqual(queue.entry);
        expect(readThreadReadReceipt(userDb, workspace.id, userTurn.threadId)).toEqual([
          eligible[0]!.id,
        ]);
        expect(f.store.listThreadItems(workspace.id, itemTurn.threadId)).toEqual([
          workspaceItems[0],
        ]);
        initialPhase = false;
        const firstFrames = frames.slice();
        expect(firstFrames).toHaveLength(3);
        expect(new Set(firstFrames.map((frame) => frame.id)).size).toBe(3);
        const lateEntered = new Set<string>();
        const allLateEntered = Promise.withResolvers<void>();
        const entered = (name: string) => {
          lateEntered.add(name);
          if (lateEntered.size === 3) allLateEntered.resolve();
        };
        const transition = f.client.transition.bind(f.client);
        vi.spyOn(f.client, 'transition').mockImplementation((...args) => {
          const result = transition(...args);
          if (args[0] === coreDatabase && 'kind' in args[1] && args[1].kind === 'scheduler-work')
            entered('Core');
          return result;
        });
        const membership = f.client.threadReadMembership.bind(f.client);
        vi.spyOn(f.client, 'threadReadMembership').mockImplementation((...args) => {
          const result = membership(...args);
          entered('User');
          return result;
        });
        const append = f.client.appendItem.bind(f.client);
        vi.spyOn(f.client, 'appendItem').mockImplementation((...args) => {
          const result = append(...args);
          entered('Workspace');
          return result;
        });
        let laterAcknowledged = 0;
        const laterCore = track(
          admitCoreScheduler(f.coreDb, coreCommands[1]!).then((value) => {
            laterAcknowledged++;
            return value;
          })
        );
        const laterUser = track(
          advanceThreadReadReceipt(userDb, workspace.id, userTurn.threadId, [eligible[1]!.id]).then(
            (value) => {
              laterAcknowledged++;
              return value;
            }
          )
        );
        const laterWorkspace = track(
          f.store.createItem(workspaceItems[1]!).then((value) => {
            laterAcknowledged++;
            return value;
          })
        );
        void Promise.all([laterCore, laterUser, laterWorkspace]).catch(allLateEntered.reject);
        await allLateEntered.promise; // Original request functions ran; a pending Promise alone is not the oracle.
        expect(laterAcknowledged).toBe(0);
        expect(frames).toEqual(firstFrames);
        expect(readThreadReadReceipt(userDb, workspace.id, userTurn.threadId)).toEqual([
          eligible[0]!.id,
        ]);
        expect(f.store.listThreadItems(workspace.id, itemTurn.threadId)).toEqual([
          workspaceItems[0],
        ]);
        expect(() =>
          requireSchedulerAdmissionEntry(f.coreDb, coreCommands[1]!.entry.queueEntryId)
        ).toThrow();
        releaseCapture.resolve();
        const captured = await backup;
        backupRoot = join(`${f.root}.backups`, captured.backupId);
        const verified = dataRootBackup.verifyDataRootBackupManifest({ backupRoot });
        expect(verified.manifest).toEqual(captured.manifest);
        const reader = new Database(coreDbPath(backupRoot), {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const core = bindCoreSqlite(reader, backupRoot);
          expect(requireSchedulerAdmissionEntry(core, queue.entry.queueEntryId)).toEqual(
            queue.entry
          );
          expect(() =>
            requireSchedulerAdmissionEntry(core, coreCommands[1]!.entry.queueEntryId)
          ).toThrow();
        } finally {
          reader.close();
        }
        const capturedUser = openUserReadDb(backupRoot, f.userId);
        try {
          expect(hasPendingUserMigrations(capturedUser.sqlite)).toBe(false);
          expect(readThreadReadReceipt(capturedUser, workspace.id, userTurn.threadId)).toEqual([
            eligible[0]!.id,
          ]);
        } finally {
          capturedUser.sqlite.close();
        }
        expect(
          new FsStore({ dataRoot: backupRoot }).listThreadItems(workspace.id, itemTurn.threadId)
        ).toEqual([workspaceItems[0]]);
        const laterQueue = await laterCore;
        expect(laterQueue.kind).toBe('queue');
        if (laterQueue.kind !== 'queue')
          throw new Error('Later Core admission failed after capture release.');
        expect(await laterUser).toEqual(eligible.map((item) => item.id).sort());
        expect(await laterWorkspace).toEqual(workspaceItems[1]);
        expect(laterAcknowledged).toBe(3);
        expect(frames).toHaveLength(6);
        expect(new Set(frames.map((frame) => frame.id)).size).toBe(6);
        userDb.sqlite.close();
        userClosed = true;
        await shutdownControlStoreWorkerClient();
        closeWorkspaceProductReadHandles(f.root);
        const cold = new FsStore({ dataRoot: f.root });
        expect(cold.listThreadItems(workspace.id, itemTurn.threadId)).toEqual(workspaceItems);
        const liveCoreReader = new Database(coreDbPath(f.root), {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const core = bindCoreSqlite(liveCoreReader, f.root);
          expect(requireSchedulerAdmissionEntry(core, queue.entry.queueEntryId)).toEqual(
            queue.entry
          );
          expect(requireSchedulerAdmissionEntry(core, laterQueue.entry.queueEntryId)).toEqual(
            laterQueue.entry
          );
        } finally {
          liveCoreReader.close();
        }
        const coldUser = openUserReadDb(f.root, f.userId);
        try {
          expect(readThreadReadReceipt(coldUser, workspace.id, userTurn.threadId)).toEqual(
            eligible.map((item) => item.id).sort()
          );
        } finally {
          coldUser.sqlite.close();
        }
      } finally {
        release(gate);
        releaseCapture.resolve();
        await Promise.allSettled(tracked);
        if (!userClosed) userDb.sqlite.close();
        closeWorkspaceProductReadHandles(f.root);
        if (backupRoot) closeWorkspaceProductReadHandles(backupRoot);
      }
    }
  );

  it('keeps a genuinely first User opening outside the captured cut until the global hold releases', async () => {
    const f = await productPoolFixture();
    roots.push(`${f.root}.backups`);
    const workspace = f.workspaces[0]!;
    const thread = await f.store.createThread(workspace.id, 'First User during capture');
    const turn = await f.store.createTurn(workspace.id, thread.id, 'Original unread reply', {
      kind: 'user',
      id: f.userId,
    });
    const item = await f.store.createItem({
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text: 'Read only after the original native opening ACK.\r\n',
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt!,
    });
    const path = userDbPath(f.root, f.userId);
    expect(existsSync(path)).toBe(false); // Canonical User authority and directories exist; its DB genuinely does not.
    const captureEntered = Promise.withResolvers<void>();
    const releaseCapture = Promise.withResolvers<void>();
    const openEntered = Promise.withResolvers<void>();
    const pause = f.client.pauseForDataRootBackup.bind(f.client);
    vi.spyOn(f.client, 'pauseForDataRootBackup').mockImplementationOnce(async (...args) => {
      const resume = await pause(...args);
      captureEntered.resolve();
      await releaseCapture.promise;
      return resume;
    });
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const nativeOpen = f.client.open.bind(f.client);
    vi.spyOn(f.client, 'open').mockImplementation((...args) => {
      const result = nativeOpen(...args);
      if (args[0].path === path) openEntered.resolve();
      return result; // Same native request, binding, original Promise and failure.
    });
    const operations = createDataRootAdminOperationImplementations(
      f.root,
      undefined,
      pauseFixturePublishers
    );
    const backup = operations['backup.create']();
    void backup.catch(() => {});
    let firstUser: Promise<string[]> | undefined;
    let backupRoot: string | undefined;
    let acknowledged = false;
    try {
      await Promise.race([
        captureEntered.promise,
        backup.then(() => {
          throw new Error('Backup bypassed its actual copy boundary.');
        }),
      ]);
      firstUser = f.client.openInitializedUserReadDb(f.root, f.userId).then(async (reader) => {
        acknowledged = true;
        try {
          return await advanceThreadReadReceipt(reader, workspace.id, thread.id, [item.id]);
        } finally {
          reader.sqlite.close();
        }
      });
      void firstUser.catch(() => {});
      await Promise.race([
        openEntered.promise,
        firstUser.then(() => {
          throw new Error('User mutation bypassed its native first opening.');
        }),
      ]);
      expect(acknowledged).toBe(false);
      expect(existsSync(path)).toBe(false);
      expect(
        posted.mock.calls.filter(
          ([request]) => request.operation === 'open' && request.path === path
        )
      ).toEqual([]);
      releaseCapture.resolve();
      const captured = await backup;
      backupRoot = join(`${f.root}.backups`, captured.backupId);
      expect(dataRootBackup.verifyDataRootBackupManifest({ backupRoot }).manifest).toEqual(
        captured.manifest
      );
      expect(existsSync(userDbPath(backupRoot, f.userId))).toBe(false);
      expect(
        captured.manifest.contentInventory.some(
          (entry) => entry.path === `users/${f.userId}/db/user.sqlite`
        )
      ).toBe(false);
      expect(await firstUser).toEqual([item.id]);
      expect(acknowledged).toBe(true);
      expect(
        posted.mock.calls.filter(
          ([request]) => request.operation === 'open' && request.path === path
        )
      ).toHaveLength(1);
      await shutdownControlStoreWorkerClient();
      closeWorkspaceProductReadHandles(f.root);
      const coldUser = openUserReadDb(f.root, f.userId);
      try {
        expect(hasPendingUserMigrations(coldUser.sqlite)).toBe(false);
        expect(readThreadReadReceipt(coldUser, workspace.id, thread.id)).toEqual([item.id]);
      } finally {
        coldUser.sqlite.close();
      }
      expect(new FsStore({ dataRoot: f.root }).listThreadItems(workspace.id, thread.id)).toEqual([
        item,
      ]);
    } finally {
      releaseCapture.resolve();
      await Promise.allSettled(firstUser ? [backup, firstUser] : [backup]);
      closeWorkspaceProductReadHandles(f.root);
      if (backupRoot) closeWorkspaceProductReadHandles(backupRoot);
    }
  });

  it.each(['before', 'after'] as const)(
    'captures the physical App tuple only after its original native reply held %s COMMIT and blocks later App publication',
    async (point) => {
      // Reuse the same bounded physical-path gate; mode2 samples actual FULL in its last slot.
      interception.gate = new SharedArrayBuffer(4 * (5 + 4096));
      interception.point = point;
      const gate = new Int32Array(interception.gate);
      Atomics.store(gate, 0, 1);
      Atomics.store(gate, 3, -1);
      const f = await productPoolFixture();
      roots.push(`${f.root}.backups`);
      const workspace = f.workspaces[0]!;
      const context: KernelCommandContext = {
        store: f.store,
        inflightCommands: new WeakMap(),
        dataRoot: f.root,
        workspaceId: workspace.id,
        actor: { kind: 'user', id: f.userId },
        requestId: randomUUID(),
      };
      const schema: LightAppSchemaInput = {
        format: 'openkit.light-app',
        schemaVersion: 1,
        title: 'Physical App capture',
        purpose:
          'Retain a real App record, Audit and original command receipt across a global SQL cut.',
        collections: [
          {
            name: 'entries',
            type: 'base',
            description: 'Captured entries.',
            fields: [
              { name: 'note', type: 'text', required: true, description: 'Retained exact text.' },
            ],
            indexes: [],
          },
        ],
      };
      const app = await createLightApp(context, schema);
      const seed = await createRecord(
        { ...context, requestId: randomUUID() },
        app.appId,
        'entries',
        app.schemaRevision,
        { note: 'Original published App record.\r\n' }
      );
      const path = lightAppDbPath(f.root, workspace.id, app.appId);
      const physicalPath = realpathSync(path);
      const database = `app:${path}`;
      expect(existsSync(path)).toBe(true);
      const initialRequestId = randomUUID(),
        laterRequestId = randomUUID();
      const scope = { workspaceId: workspace.id, appId: app.appId };
      const firstData = { note: 'Included exact App value.\r\n' };
      const laterData = { note: 'Excluded from capture; later live value. 🚀' };
      const recordAt = (root: string) =>
        getRecord(root, workspace.id, app.appId, 'entries', seed.id, app.schemaRevision);
      const receiptAt = (root: string, requestId: string) =>
        getCommandRequestRecord(
          root,
          scope,
          commandRequestKey('kernel.records.update', requestId, scope),
          new Date().toISOString()
        );
      const auditsAt = (root: string, requestId: string) => {
        const reader = openExistingAppDb(root, workspace.id, app.appId);
        try {
          expect(reader.sqlite.readonly).toBe(true);
          expect(reader.sqlite.pragma('query_only', { simple: true })).toBe(1);
          return listSqliteAuditEvents(reader.sqlite).filter(
            (event) => event.requestId === requestId
          );
        } finally {
          reader.sqlite.close();
        }
      };
      expect(recordAt(f.root)).toEqual(seed);
      expect(receiptAt(f.root, initialRequestId)).toBeNull();
      expect(receiptAt(f.root, laterRequestId)).toBeNull();
      f.coreDb.sqlite.pragma('query_only = ON'); // Legitimate setup-handle counterfactual; no serving Main claim.
      Atomics.store(gate, 2, 2);
      const frames: Array<{ worker: number; id: number; operation: string; database: string }> = [];
      const replies: Array<{ worker: number; id: number; operation: string; status: string }> = [];
      const removeListeners: Array<() => void> = [];
      const observedWorkers = new WeakSet<Worker>();
      let armed = false;
      const initialPosted = Promise.withResolvers<void>();
      const originalPost = Worker.prototype.postMessage;
      vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
        this: Worker,
        ...args
      ) {
        const request = args[0] as { operation?: string; database?: string; id?: number };
        if (request.operation === 'app-kernel' && request.database === database) {
          const worker = interception.workers.indexOf(this);
          if (worker < 0 || typeof request.id !== 'number')
            throw new Error('App frame has no actual native host/identity.');
          frames.push({ worker, id: request.id, operation: request.operation, database });
          if (!observedWorkers.has(this)) {
            observedWorkers.add(this);
            const onReply = (value: unknown) => {
              if (value === null || typeof value !== 'object') return;
              const reply = value as { id?: number; operation?: string; status?: string };
              if (
                reply.operation === 'app-kernel' &&
                typeof reply.id === 'number' &&
                (reply.status === 'ok' || reply.status === 'error') &&
                frames.some((frame) => frame.worker === worker && frame.id === reply.id)
              )
                replies.push({
                  worker,
                  id: reply.id,
                  operation: reply.operation,
                  status: reply.status,
                });
            };
            this.on('message', onReply);
            removeListeners.push(() => this.off('message', onReply));
          }
          if (!armed) {
            if (physicalPath.length > gate.length - 6)
              throw new Error('App path leaves no bounded FULL sample slot.');
            for (let position = 0; position < physicalPath.length; position++)
              Atomics.store(gate, 5 + position, physicalPath.charCodeAt(position));
            Atomics.store(gate, 4, physicalPath.length);
            Atomics.store(gate, 3, worker);
            Atomics.store(gate, 0, 0);
            armed = true;
            initialPosted.resolve();
          }
        }
        return Reflect.apply(originalPost, this, args);
      });
      const captureEntered = Promise.withResolvers<void>();
      const releaseCapture = Promise.withResolvers<void>();
      const pauseEntered = Promise.withResolvers<void>();
      let actualPauseAcquired = false;
      const pause = f.client.pauseForDataRootBackup.bind(f.client);
      vi.spyOn(f.client, 'pauseForDataRootBackup').mockImplementationOnce(async (...args) => {
        expect(args).toEqual([]); // The actual capture uses the global hold, not an App-only hold.
        const acquiring = pause(...args);
        pauseEntered.resolve(); // The original global pause was called while the native gate is held.
        const resume = await acquiring;
        actualPauseAcquired = true;
        captureEntered.resolve();
        await releaseCapture.promise;
        return resume;
      });
      vi.spyOn(dataRootBackup, 'writeHotDataRootBackup');
      const tracked: Promise<unknown>[] = [];
      const track = <T>(promise: Promise<T>) => {
        tracked.push(promise);
        void promise.catch(() => {});
        return promise;
      };
      let initialAcknowledged = false,
        laterAcknowledged = false;
      let backupRoot: string | undefined;
      try {
        const initial = track(
          updateRecord({ ...context, requestId: initialRequestId }, app.appId, 'entries', seed.id, {
            schemaRevision: app.schemaRevision,
            expectedRecordRevision: seed.revision,
            data: firstData,
          }).then((value) => {
            initialAcknowledged = true;
            return value;
          })
        );
        await Promise.race([
          initialPosted.promise,
          initial.then(() => {
            throw new Error('App mutation returned without its actual native posting boundary.');
          }),
        ]);
        await Promise.race([
          waitForHold(gate),
          initial.then(() => {
            throw new Error('App mutation returned before its held native COMMIT boundary.');
          }),
        ]);
        expect(armed).toBe(true);
        expect(Atomics.load(gate, gate.length - 1)).toBe(2); // Actual selected native App connection is FULL.
        expect(initialAcknowledged).toBe(false);
        expect(frames).toHaveLength(1);
        expect(replies).toEqual([]);
        const heldRecord = recordAt(f.root);
        const heldReceipt = receiptAt(f.root, initialRequestId);
        const heldAudits = auditsAt(f.root, initialRequestId);
        if (point === 'before') {
          expect(heldRecord).toEqual(seed);
          expect(heldReceipt).toBeNull();
          expect(heldAudits).toEqual([]);
        } else {
          expect(heldRecord.data).toEqual(firstData);
          expect(heldRecord.revision).toBe(seed.revision + 1);
          expect(heldReceipt).toMatchObject({
            command: 'kernel.records.update',
            requestId: initialRequestId,
            response: { kind: 'light_app_record', id: seed.id },
          });
          expect(heldAudits).toHaveLength(1);
        }
        const operations = createDataRootAdminOperationImplementations(
          f.root,
          undefined,
          pauseFixturePublishers
        );
        const backup = track(operations['backup.create']());
        await Promise.race([
          pauseEntered.promise,
          backup.then(() => {
            throw new Error('Backup bypassed the actual global pause entry.');
          }),
        ]);
        await nextTurn();
        expect(actualPauseAcquired).toBe(false); // Independent of the wrapper's later copy barrier.
        expect(vi.mocked(dataRootBackup.writeHotDataRootBackup)).not.toHaveBeenCalled();
        expect(existsSync(`${f.root}.backups`)).toBe(false);
        expect(initialAcknowledged).toBe(false);
        expect(replies).toEqual([]);
        release(gate);
        await Promise.race([
          captureEntered.promise,
          backup.then(() => {
            throw new Error('Backup bypassed the actual global App drain/copy boundary.');
          }),
        ]);
        expect(actualPauseAcquired).toBe(true);
        const originalRecord = await initial;
        expect(initialAcknowledged).toBe(true);
        expect(recordAt(f.root)).toEqual(originalRecord);
        expect(originalRecord.data).toEqual(firstData);
        expect(originalRecord.revision).toBe(seed.revision + 1);
        const originalReceipt = receiptAt(f.root, initialRequestId);
        expect(originalReceipt).toMatchObject({
          command: 'kernel.records.update',
          requestId: initialRequestId,
          response: { kind: 'light_app_record', id: seed.id },
        });
        const originalAudits = auditsAt(f.root, initialRequestId);
        expect(originalAudits).toHaveLength(1);
        expect(originalAudits[0]).toMatchObject({
          action: 'kernel.records.update',
          outcome: 'succeeded',
          requestId: initialRequestId,
        });
        if (point === 'after') {
          expect(originalRecord).toEqual(heldRecord);
          expect(originalReceipt).toEqual(heldReceipt);
          expect(originalAudits).toEqual(heldAudits);
        }
        expect(replies).toEqual([
          { worker: frames[0]!.worker, id: frames[0]!.id, operation: 'app-kernel', status: 'ok' },
        ]);
        const committedApp = getLightApp(f.root, workspace.id, app.appId);
        const firstFrames = frames.slice();
        const lateEntered = Promise.withResolvers<void>();
        const open = f.client.open.bind(f.client);
        vi.spyOn(f.client, 'open').mockImplementation((...args) => {
          const result = open(...args);
          if (args[0].path === path) lateEntered.resolve();
          return result;
        });
        const later = track(
          updateRecord({ ...context, requestId: laterRequestId }, app.appId, 'entries', seed.id, {
            schemaRevision: app.schemaRevision,
            expectedRecordRevision: originalRecord.revision,
            data: laterData,
          }).then((value) => {
            laterAcknowledged = true;
            return value;
          })
        );
        void later.catch(lateEntered.reject);
        await lateEntered.promise; // The real public producer entered its existing App native opening path.
        await nextTurn();
        expect(laterAcknowledged).toBe(false);
        expect(frames).toEqual(firstFrames);
        expect(replies).toHaveLength(1);
        expect(recordAt(f.root)).toEqual(originalRecord);
        expect(receiptAt(f.root, initialRequestId)).toEqual(originalReceipt);
        expect(receiptAt(f.root, laterRequestId)).toBeNull();
        expect(auditsAt(f.root, initialRequestId)).toEqual(originalAudits);
        expect(auditsAt(f.root, laterRequestId)).toEqual([]);
        releaseCapture.resolve();
        const captured = await backup;
        backupRoot = join(`${f.root}.backups`, captured.backupId);
        expect(dataRootBackup.verifyDataRootBackupManifest({ backupRoot }).manifest).toEqual(
          captured.manifest
        );
        expect(
          captured.manifest.contentInventory.some(
            (entry) =>
              entry.path === `workspaces/${workspace.id}/light-apps/${app.appId}/data.sqlite`
          )
        ).toBe(true);
        expect(getLightApp(backupRoot, workspace.id, app.appId)).toEqual(committedApp);
        expect(recordAt(backupRoot)).toEqual(originalRecord);
        expect(receiptAt(backupRoot, initialRequestId)).toEqual(originalReceipt);
        expect(receiptAt(backupRoot, laterRequestId)).toBeNull();
        expect(auditsAt(backupRoot, initialRequestId)).toEqual(originalAudits);
        expect(auditsAt(backupRoot, laterRequestId)).toEqual([]);
        const laterRecord = await later;
        expect(laterAcknowledged).toBe(true);
        expect(laterRecord.data).toEqual(laterData);
        expect(laterRecord.revision).toBe(originalRecord.revision + 1);
        expect(frames).toHaveLength(2);
        expect(new Set(frames.map((frame) => frame.id)).size).toBe(2);
        expect(replies).toEqual(
          frames.map((frame) => ({
            worker: frame.worker,
            id: frame.id,
            operation: 'app-kernel',
            status: 'ok',
          }))
        );
        const laterReceipt = receiptAt(f.root, laterRequestId);
        expect(laterReceipt).toMatchObject({
          command: 'kernel.records.update',
          requestId: laterRequestId,
          response: { kind: 'light_app_record', id: seed.id },
        });
        const laterAudits = auditsAt(f.root, laterRequestId);
        expect(laterAudits).toHaveLength(1);
        expect(laterAudits[0]).toMatchObject({
          action: 'kernel.records.update',
          outcome: 'succeeded',
          requestId: laterRequestId,
        });
        f.coreDb.sqlite.close();
        await shutdownControlStoreWorkerClient();
        closeWorkspaceProductReadHandles(f.root);
        expect(recordAt(f.root)).toEqual(laterRecord);
        expect(receiptAt(f.root, initialRequestId)).toEqual(originalReceipt);
        expect(receiptAt(f.root, laterRequestId)).toEqual(laterReceipt);
        expect(auditsAt(f.root, initialRequestId)).toEqual(originalAudits);
        expect(auditsAt(f.root, laterRequestId)).toEqual(laterAudits);
        expect(recordAt(backupRoot)).toEqual(originalRecord);
        expect(receiptAt(backupRoot, initialRequestId)).toEqual(originalReceipt);
        expect(receiptAt(backupRoot, laterRequestId)).toBeNull();
      } finally {
        release(gate);
        releaseCapture.resolve();
        await Promise.allSettled(tracked);
        for (const remove of removeListeners) remove();
        if (f.coreDb.sqlite.open) f.coreDb.sqlite.close();
        closeWorkspaceProductReadHandles(f.root);
        if (backupRoot) closeWorkspaceProductReadHandles(backupRoot);
      }
    }
  );
});

// A real native COMMIT hold decides User publication timing; awaiting a promise alone cannot prove it.
describe('User Policy covering FULL acknowledgement', () => {
  it.each(['before', 'after'] as const)(
    'holds the User decision tuple and participant Audit return %s their covering COMMIT',
    async (point) => {
      const root = mkdtempSync(join(tmpdir(), 'control-user-policy-full-'));
      roots.push(root);
      const userId = FIXTURE_LOCAL_USER_ID;
      const userDb = openUserDb(root, userId);
      try {
        applyScopedMigrations(userDb);
        userDb.sqlite.pragma('query_only = ON');
        interception.gate = new SharedArrayBuffer(8);
        interception.point = point;
        const gate = new Int32Array(interception.gate);
        Atomics.store(gate, 0, 1); // Open and initialization stay outside the measured COMMIT.
        client = getControlStoreWorkerClient();
        const database = `user:${userDbPath(root, userId)}`;
        await client.open({
          database,
          path: userDbPath(root, userId),
          create: false,
          initialize: 'user',
        });
        // SQLite value 2 is FULL on the actual native writer connection, not this Main reader.
        await expect(
          client.write(database, [
            {
              mode: 'get',
              sql: 'SELECT synchronous AS synchronization FROM pragma_synchronous',
              parameters: [],
            },
          ])
        ).resolves.toMatchObject([{ mode: 'get', row: { synchronization: 2n } }]);
        const decisionId = allocateEntityId('pd');
        const digest = `sha256:${'a'.repeat(64)}`;
        const actor = { kind: 'user' as const, id: userId };
        const event = prepareAuditEvent({
          workspaceId: null,
          action: 'policy.participant',
          category: 'approval',
          outcome: 'succeeded',
          summary: 'Completed User Policy observation.',
          actor,
          policyInvocation: {
            binding: { id: 'user-observer', digest },
            operation: 'vault.binding-replace',
            stage: 'completed',
            mode: 'observe',
            policyRevision: digest,
            authorizationRevision: digest,
            proposalDigest: digest,
            subject: {
              principal: { kind: 'human', id: userId },
              onBehalfOf: null,
              actor,
              process: null,
              credentialKind: 'local',
              responsibleHumanId: userId,
            },
            participant: { id: 'test', version: digest },
            inputDigest: digest,
            outputDigest: digest,
            outcome: 'completed',
            startedAt: '2026-10-18T00:00:00Z',
            completedAt: '2026-10-18T00:00:01Z',
            capabilityCallId: null,
          },
          now: new Date('2026-10-18T00:00:01Z'),
        });
        for (const kind of ['decision', 'participant'] as const) {
          Atomics.store(gate, 1, 0);
          Atomics.store(gate, 0, 0);
          let returned = false;
          const pending = Promise.resolve()
            .then(() =>
              kind === 'decision'
                ? recordProductPermissionDecision({
                    userDb,
                    decisionId,
                    ownerScope: 'user',
                    workspaceId: null,
                    policyEngineVersion: 'nanocore-policy:v1',
                    policySnapshotId: digest,
                    subjectSummary: { kind: 'human', id: userId },
                    action: 'vault.use',
                    resourceSummary: {
                      kind: 'container',
                      container: { kind: 'user', id: userId, owner: { kind: 'user', userId } },
                    },
                    contextSummary: {},
                    result: 'allow',
                    reasonCode: 'granted',
                    enforcementPoint: 'vault.binding-replace@decide',
                    auditActor: actor,
                  })
                : client!.userCapability(userDb, { kind: 'user-participant-audit', userId, event })
            )
            .then((value) => {
              returned = true;
              return value;
            });
          try {
            await Promise.race([
              waitForHold(gate),
              pending.then(() => {
                throw new Error('User publication returned before the real native COMMIT hold.');
              }),
            ]);
            await nextTurn();
            expect(returned).toBe(false);
            expect(Atomics.load(gate, 1)).toBe(0);
            const reader = new Database(userDbPath(root, userId), {
              readonly: true,
              fileMustExist: true,
            });
            try {
              reader.pragma('query_only = ON');
              const rows = reader
                .prepare('SELECT * FROM permission_decisions')
                .all()
                .map(readPermissionDecisionRowV1);
              const events = listSqliteAuditEvents(reader);
              expect(rows).toHaveLength(kind === 'decision' && point === 'before' ? 0 : 1);
              expect(events).toHaveLength(
                (kind === 'participant' ? 1 : 0) + (point === 'after' ? 1 : 0)
              );
              if (rows.length)
                expect(events.find((value) => value.id === rows[0]!.auditEventId)).toMatchObject({
                  permissionDecisionId: decisionId,
                  workspaceId: null,
                });
              if (kind === 'participant' && point === 'after')
                expect(events.find((value) => value.id === event.id)).toEqual(event);
            } finally {
              reader.close();
            }
          } finally {
            release(gate);
            await Promise.allSettled([pending]);
          }
          await pending;
          expect(returned).toBe(true);
        }
        const rows = userDb.sqlite
          .prepare('SELECT * FROM permission_decisions')
          .all()
          .map(readPermissionDecisionRowV1);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ decisionId, ownerScope: 'user', workspaceId: null });
        const events = listSqliteAuditEvents(userDb.sqlite);
        expect(events).toHaveLength(2);
        expect(events.find((value) => value.id === rows[0]!.auditEventId)).toMatchObject({
          permissionDecisionId: decisionId,
          outcome: 'succeeded',
          workspaceId: null,
        });
        expect(events.find((value) => value.id === event.id)).toEqual(event);
      } finally {
        if (interception.gate !== undefined) release(new Int32Array(interception.gate));
        userDb.sqlite.close();
      }
    }
  );
});
