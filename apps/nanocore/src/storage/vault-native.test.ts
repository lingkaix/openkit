import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import type { Actor } from '../auth/identity.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { policyDigest } from '../policy/statements.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  assertCurrentWorkerCredentialAuthority,
  readVaultRequesterAuthority,
} from '../runtime/worker-credential-authority.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  resolveAgentEnvironmentPackage,
  resolveAgentSessionCompatibilityKey,
} from '../test-support/prepared-agent-environment.js';
import { createVaultGrant, getVaultGrant } from '../vault/vault-grants.js';
import {
  advanceActiveVaultReferenceVersion,
  createVaultReference,
  createVaultReferenceWithInsertEvidence,
  getVaultReference,
  rebindWorkspaceVaultReference,
} from '../vault/vault-references.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { createVaultInjectionPlan, getVaultInjectionPlan } from '../vault-injection-plans.js';
import {
  type CreateVaultInjectionReceiptInput,
  createVaultInjectionReceipt,
  getVaultInjectionReceipt,
  listVaultInjectionReceipts,
} from '../vault-injection-receipts.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  CONTROL_WORKER_LIMITS,
  CONTROL_WORKER_VERSION,
  controlWorkerInputBytes,
  isControlWorkerRequest,
} from './control-store-worker-protocol.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { importUnboundWorkspaceVaultReference } from './test-support/vault-retained-fixtures.js';
import {
  ControlVaultInputSchema,
  HarnessLoginMetadataSchema,
  HarnessLoginObservationsSchema,
  mapVaultReferenceRow,
  type VaultReferenceRow,
} from './vault-native-codecs.js';
import { nativeProductScope } from './workspace-file-records.js';

const interception = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  replies: [] as Array<() => void>,
  gate: undefined as SharedArrayBuffer | undefined,
}));

// This wraps real SQLite and reply delivery in the actual Worker; it replaces no product writer.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const reply = args[0] as { operation?: string; status?: string } | undefined;
        const gate = interception.gate && new Int32Array(interception.gate);
        if (
          event === 'message' &&
          reply?.operation === 'vault' &&
          reply.status === 'ok' &&
          gate &&
          Atomics.load(gate, 6) === 1 &&
          Atomics.compareExchange(gate, 7, 0, 1) === 0
        ) {
          interception.replies.push(() => {
            super.emit(event, ...args);
          });
          return true;
        }
        return super.emit(event, ...args);
      }

      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (!interception.gate) {
          super(filename, options);
          interception.workers.push(this);
          return;
        }
        const require = createRequire(import.meta.url);
        const prelude = `
          const {workerData, parentPort} = require('node:worker_threads');
          const Database = require(workerData.databaseModule);
          const originalExec = Database.prototype.exec;
          const gate = workerData.gate;
          function hold(point) {
            if (Atomics.load(gate, 0) === point &&
                Atomics.compareExchange(gate, 1, 0, 1) === 0)
              Atomics.wait(gate, 2, 0);
          }
          parentPort.on('message', value => {
            if (value.operation === 'vault') Atomics.add(gate, 5, 1);
          });
          Database.prototype.exec = function(sql) {
            if (/^BEGIN(?:\\s|$)/i.test(sql)) hold(1);
            if (/^COMMIT$/i.test(sql)) {
              Atomics.store(gate, 4, this.pragma('synchronous', {simple: true}));
              hold(2);
            }
            const result = originalExec.call(this, sql);
            if (/^COMMIT$/i.test(sql)) {
              Atomics.add(gate, 3, 1);
              hold(3);
            }
            return result;
          };
        `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            databaseModule: require.resolve('better-sqlite3'),
            gate: new Int32Array(interception.gate),
          },
        });
        interception.workers.push(this);
      }
    },
  };
});

const fixtures: Array<{
  gate: Int32Array;
  joinOperations(): Promise<void>;
  close(): void;
  mainWrites(): number;
}> = [];
const referenceId = 'vault_00000000-0000-7a76-a462-96e7448d3d9c';
const workspaceId = 'ws_00000000-0000-73c3-900f-8d310e4ba201';
const clock = '2026-08-08T00:00:00.000Z';

/** Opens real storage before arming faults or Main DML denial; no backend material is involved. */
async function fixture(unbound = false) {
  const root = mkdtempSync(join(tmpdir(), 'vault-boundary-'));
  const db = openCoreDb(root);
  const gateBuffer = new SharedArrayBuffer(32);
  const gate = new Int32Array(gateBuffer);
  const pending = new Set<Promise<unknown>>();
  let mainWrites = 0;
  fixtures.push({
    gate,
    mainWrites: () => mainWrites,
    async joinOperations() {
      while (pending.size) await Promise.all([...pending]);
    },
    close() {
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    },
  });
  applyMigrations(db);
  if (unbound)
    importUnboundWorkspaceVaultReference(db, {
      referenceId,
      workspaceId,
      displayName: 'Retained native reference',
      secretKind: 'provider-api-key',
      backendKind: 'encrypted-file',
      now: () => clock,
    });
  interception.gate = gateBuffer;
  const scope = nativeProductScope(root, { kind: 'server' });
  await getControlStoreWorkerClient().open({
    database: `core:${scope.path}`,
    path: scope.path,
    create: false,
    initialize: 'core',
    dataRoot: root,
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  const prepare = db.sqlite.prepare.bind(db.sqlite);
  const exec = db.sqlite.exec.bind(db.sqlite);
  const deny = (sql: string) => {
    if (
      /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql) &&
      /\bvault_references\b/iu.test(sql)
    ) {
      mainWrites++;
      throw new Error('Vault reference mutation executed on Main.');
    }
  };
  vi.spyOn(db.sqlite, 'prepare').mockImplementation((sql) => {
    deny(sql);
    return prepare(sql);
  });
  vi.spyOn(db.sqlite, 'exec').mockImplementation((sql) => {
    deny(sql);
    return exec(sql);
  });
  return {
    db,
    gate,
    commits: () => Atomics.load(gate, 3),
    submissions: () => Atomics.load(gate, 5),
    // Only the Storage-owned fixture changes the retained row while BEGIN has not executed.
    fixtureSql: (sql: string): Database.Statement => prepare(sql),
    start<T>(work: () => Promise<T>) {
      let settled = false;
      const result = Promise.resolve()
        .then(work)
        .then(
          (value) => {
            settled = true;
            return { ok: true as const, value };
          },
          (error: unknown) => {
            settled = true;
            return { ok: false as const, error };
          }
        );
      pending.add(result);
      void result.then(() => pending.delete(result));
      return { result, settled: () => settled };
    },
  };
}

/** Releases native execution separately from the original Main acknowledgement delivery. */
function releaseNative(gate: Int32Array): void {
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
}

function deliverReplies(): void {
  for (const deliver of interception.replies.splice(0)) deliver();
}

afterEach(async () => {
  for (const f of fixtures) {
    Atomics.store(f.gate, 0, 0);
    Atomics.store(f.gate, 6, 0);
    releaseNative(f.gate);
  }
  deliverReplies();
  for (const f of fixtures) await f.joinOperations();
  await shutdownControlStoreWorkerClient();
  for (const worker of interception.workers.splice(0)) await worker.terminate();
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    const writes = f.mainWrites();
    f.close();
    expect(writes).toBe(0);
  }
  interception.gate = undefined;
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Holds before BEGIN, before COMMIT, or after actual COMMIT and before any reply. */
function arm(f: Fixture, point: 1 | 2 | 3, holdReply = false): void {
  Atomics.store(f.gate, 0, point);
  Atomics.store(f.gate, 1, 0);
  Atomics.store(f.gate, 2, 0);
  Atomics.store(f.gate, 6, holdReply ? 1 : 0);
  Atomics.store(f.gate, 7, 0);
}

/** Uses only the original test deadline; early operation settlement fails the boundary oracle. */
async function reached(
  f: Fixture,
  operation: { settled(): boolean },
  point: 'native' | 'reply' = 'native'
): Promise<void> {
  const index = point === 'native' ? 1 : 7;
  while (Atomics.load(f.gate, index) === 0 && !operation.settled()) await nextTurn();
  expect(Atomics.load(f.gate, index)).toBe(1);
  expect(operation.settled()).toBe(false);
}

function createInput() {
  return {
    referenceId,
    ownerScope: 'server' as const,
    displayName: 'Native reference',
    secretKind: 'provider-api-key',
    backendKind: 'encrypted-file',
    now: () => clock,
  };
}

describe('Vault native ownership', () => {
  it('creates a reference through the public owner while Main DML is denied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vault-native-'));
    const db = openCoreDb(root);
    const restore: Array<() => void> = [];
    try {
      applyMigrations(db);
      const scope = nativeProductScope(root, { kind: 'server' });
      await getControlStoreWorkerClient().open({
        database: `core:${scope.path}`,
        path: scope.path,
        create: false,
        initialize: 'core',
        dataRoot: root,
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });

      // Deny the deciding Main write only after valid setup and the real Worker open ACK.
      let mainWrites = 0;
      const denyMainWrite = (sql: string) => {
        if (
          /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql) &&
          /\bvault_references\b/iu.test(sql)
        ) {
          mainWrites++;
          throw new Error('Vault reference mutation executed on Main.');
        }
      };
      const prepare = db.sqlite.prepare.bind(db.sqlite);
      const exec = db.sqlite.exec.bind(db.sqlite);
      const prepareSpy = vi.spyOn(db.sqlite, 'prepare').mockImplementation((sql) => {
        denyMainWrite(sql);
        return prepare(sql);
      });
      restore.push(() => prepareSpy.mockRestore());
      const execSpy = vi.spyOn(db.sqlite, 'exec').mockImplementation((sql) => {
        denyMainWrite(sql);
        return exec(sql);
      });
      restore.push(() => execSpy.mockRestore());

      const referenceId = 'vault_00000000-0000-7a76-a462-96e7448d3d9c';
      const now = '2026-08-08T00:00:00.000Z';
      // Storage owns the native writer and covering FULL acknowledgement; material stays absent.
      const created = await createVaultReferenceWithInsertEvidence(db, {
        referenceId,
        ownerScope: 'server',
        displayName: 'Native reference',
        secretKind: 'provider-api-key',
        backendKind: 'encrypted-file',
        now: () => now,
      });

      expect(created).toEqual({
        inserted: true,
        reference: {
          referenceId,
          ownerScope: 'server',
          workspaceId: null,
          userId: null,
          displayName: 'Native reference',
          secretKind: 'provider-api-key',
          backendKind: 'encrypted-file',
          backendLocator: null,
          status: 'active',
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
      });
      expect(getVaultReference(db, referenceId)).toEqual(created.reference);
      expect(mainWrites).toBe(0);
    } finally {
      await shutdownControlStoreWorkerClient();
      for (const reset of restore.reverse()) reset();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Vault native commit boundaries', () => {
  it('withholds the public result until actual FULL COMMIT and its covering acknowledgement', async () => {
    const f = await fixture();
    const before = f.commits();
    arm(f, 2, true);
    const pending = f.start(() => createVaultReferenceWithInsertEvidence(f.db, createInput()));
    await reached(f, pending);
    expect(f.submissions()).toBe(1);
    expect(Atomics.load(f.gate, 4)).toBe(2);
    expect(f.commits()).toBe(before);
    expect(getVaultReference(f.db, referenceId)).toBeNull();

    releaseNative(f.gate);
    await reached(f, pending, 'reply');
    const committed = getVaultReference(f.db, referenceId);
    expect(committed).toMatchObject({ referenceId, currentVersion: 1, status: 'active' });
    expect(f.commits()).toBe(before + 1);
    expect(pending.settled()).toBe(false);

    deliverReplies();
    expect(await pending.result).toEqual({
      ok: true,
      value: { inserted: true, reference: committed },
    });
    expect(f.submissions()).toBe(1);
  });

  it('keeps an actual committed reference unknown when its acknowledgement is lost without retry', async () => {
    const f = await fixture();
    const before = f.commits();
    arm(f, 3);
    const pending = f.start(() => createVaultReferenceWithInsertEvidence(f.db, createInput()));
    await reached(f, pending);
    const committed = getVaultReference(f.db, referenceId);
    expect(committed).toMatchObject({ referenceId, currentVersion: 1, status: 'active' });
    expect(Atomics.load(f.gate, 4)).toBe(2);
    expect(f.commits()).toBe(before + 1);
    expect(f.submissions()).toBe(1);

    const worker = interception.workers.at(-1);
    expect(worker).toBeDefined();
    await worker!.terminate();
    const outcome = await pending.result;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('The lost covering acknowledgement reported success.');
    expect(outcome.error).toBeInstanceOf(ControlStoreWorkerError);
    expect(outcome.error).toMatchObject({ commit: 'unknown' });
    expect(getVaultReference(f.db, referenceId)).toEqual(committed);
    expect(f.commits()).toBe(before + 1);
    expect(f.submissions()).toBe(1);
  });

  it('uses the current stored version after waiting before BEGIN without overwriting its newer row', async () => {
    const f = await fixture();
    await createVaultReference(f.db, createInput());
    arm(f, 1);
    const pending = f.start(() =>
      advanceActiveVaultReferenceVersion(f.db, {
        referenceId,
        currentVersion: 2,
        now: () => '2026-08-08T00:01:00.000Z',
      })
    );
    await reached(f, pending);
    expect(f.submissions()).toBe(2);
    // This is a fixture change to the same authoritative database, not another product admission.
    f.fixtureSql(
      'UPDATE vault_references SET current_version = 3, updated_at = ? WHERE reference_id = ?'
    ).run('2026-08-08T00:02:00.000Z', referenceId);
    const current = getVaultReference(f.db, referenceId);
    expect(current).toMatchObject({ currentVersion: 3, updatedAt: '2026-08-08T00:02:00.000Z' });
    releaseNative(f.gate);
    expect(await pending.result).toMatchObject({
      ok: false,
      error: { message: `Vault reference version must advance by exactly one: ${referenceId}` },
    });
    expect(getVaultReference(f.db, referenceId)).toEqual(current);
    expect(f.submissions()).toBe(2);
  });

  it('refuses rebind after the retained reference becomes bound before BEGIN', async () => {
    const f = await fixture(true);
    expect(getVaultReference(f.db, referenceId)).toMatchObject({
      workspaceId,
      status: 'unbound',
      currentVersion: 0,
    });
    arm(f, 1);
    const pending = f.start(() =>
      rebindWorkspaceVaultReference(f.db, {
        workspaceId,
        referenceId,
        backendKind: 'encrypted-file',
        backendLocator: 'synthetic-stale-binding',
        currentVersion: 1,
        now: () => '2026-08-08T00:01:00.000Z',
      })
    );
    await reached(f, pending);
    expect(f.submissions()).toBe(1);
    f.fixtureSql(
      `UPDATE vault_references SET status = 'active', backend_locator = ?,
        current_version = 2, updated_at = ? WHERE reference_id = ?`
    ).run('synthetic-current-binding', '2026-08-08T00:02:00.000Z', referenceId);
    const current = getVaultReference(f.db, referenceId);
    expect(current).toMatchObject({
      status: 'active',
      backendLocator: 'synthetic-current-binding',
      currentVersion: 2,
    });
    releaseNative(f.gate);
    expect(await pending.result).toMatchObject({
      ok: false,
      error: { message: `Workspace vault reference is not unbound: ${referenceId}` },
    });
    expect(getVaultReference(f.db, referenceId)).toEqual(current);
    expect(f.submissions()).toBe(1);
  });
});

// Core Storage owns these durable metadata transitions; this fixture claims no physical removal.
describe('Vault native binding withdrawal currentness', () => {
  it.each(['unchanged', 'requester-disabled', 'competing-receipt'] as const)(
    'decides the original requester and unique active receipt after FIFO predecessors (%s)',
    async (change) => {
      const f = await fixture();
      const userId = ensureLocalUser(f.db);
      recordWorkspaceOwnerMembership({ coreDb: f.db, workspaceId, ownerUserId: userId });
      await createVaultReference(f.db, {
        ...createInput(),
        ownerScope: 'workspace',
        workspaceId,
      });
      const grant = await createVaultGrant(f.db, {
        grantId: 'grant_00000000-0000-7a76-a462-96e7448d3d9c',
        vaultReferenceId: referenceId,
        ownerScope: 'workspace',
        workspaceId,
        allowedInjectionPaths: ['runtime-file'],
        lifetime: 'workspace',
        now: () => clock,
      });
      const plan = await createVaultInjectionPlan(f.db, {
        planId: 'plan_native_withdraw',
        grantId: grant.grantId,
        injectionVisibility: 'runtime-file',
        targetPath: '/sandbox/synthetic-withdrawal',
        expirationBehavior: 'Deny expired use.',
        revocationBehavior: 'Close the affected binding.',
        redactionRule: 'Exclude material.',
        backendCapabilityRequirement: 'runtime-file',
        now: () => clock,
      });
      const receiptInput = {
        receiptId: 'receipt_native_withdraw',
        planId: plan.planId,
        grantId: grant.grantId,
        agentSessionId: 'as_00000000-0000-7a76-a462-96e7448d3d9c',
        backendSummary: 'Synthetic completed delivery metadata.',
        injectedAt: clock,
        revocationStatus: 'active' as const,
      };
      const receipt = await createVaultInjectionReceipt(f.db, receiptInput);
      const requester = {
        kind: 'public' as const,
        actor: { kind: 'local' as const, userId },
        actorRef: { kind: 'user' as const, id: userId },
      };
      // The real requester owner produces the captured revision before any competing mutation.
      const coreAuthority = {
        workspaceId,
        requester,
        revision: policyDigest(
          readVaultRequesterAuthority(f.db, workspaceId, requester, 'vault.use', true)
        ),
      };
      arm(f, 1);
      const predecessor =
        change === 'competing-receipt'
          ? f.start(() =>
              createVaultInjectionReceipt(f.db, {
                ...receiptInput,
                receiptId: 'receipt_native_competing',
              })
            )
          : undefined;
      if (predecessor) await reached(f, predecessor);
      const withdrawal = f.start(() =>
        getControlStoreWorkerClient().vault(f.db, 'binding-revoke-withdraw', {
          receiptId: receipt.receiptId,
          planId: plan.planId,
          agentSessionId: receiptInput.agentSessionId,
          plan,
          coreAuthority,
        })
      );
      if (predecessor) {
        // Posting behind an already held native request preserves the actual FIFO predecessor.
        await nextTurn();
        expect(withdrawal.settled()).toBe(false);
      } else {
        await reached(f, withdrawal);
        if (change === 'requester-disabled') {
          f.db.sqlite.transaction(() => {
            expect(disableCanonicalUser(f.db, userId)?.changed).toBe(true);
          })();
        }
      }
      releaseNative(f.gate);
      if (predecessor) expect(await predecessor.result).toMatchObject({ ok: true });
      const result = await withdrawal.result;
      if (change === 'unchanged') {
        expect(result).toEqual({ ok: true, value: null });
        expect(getVaultInjectionPlan(f.db, plan.planId)?.status).toBe('revoked');
        expect(listVaultInjectionReceipts(f.db)).toEqual([
          { ...receipt, revocationStatus: 'stale-session' },
        ]);
      } else {
        expect(result).toMatchObject({ ok: false, error: { commit: 'not-committed' } });
        expect(getVaultInjectionPlan(f.db, plan.planId)).toEqual(plan);
        expect(listVaultInjectionReceipts(f.db)).toHaveLength(
          change === 'competing-receipt' ? 2 : 1
        );
        expect(
          listVaultInjectionReceipts(f.db).every((row) => row.revocationStatus === 'active')
        ).toBe(true);
        expect(
          listVaultInjectionReceipts(f.db).find((row) => row.receiptId === receipt.receiptId)
        ).toEqual(receipt);
      }
    }
  );
});

it('joins Provider receipt generations at the actual sequential native decision', async () => {
  const f = await fixture();
  const localUserId = ensureLocalUser(f.db);
  const timestamp = new Date().toISOString();
  const store = await createDemoStore({ dataRoot: f.db.dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb: f.db,
    ownerUserId: localUserId,
    workspaceId: DEMO_WORKSPACE_ID,
  });
  const agentSessionId = allocateEntityId('as');
  const originalReference = await createVaultReference(f.db, {
    ...createInput(),
    backendKind: 'encrypted-file',
    now: () => timestamp,
  });
  const grant = await createVaultGrant(f.db, {
    grantId: allocateEntityId('grant'),
    vaultReferenceId: originalReference.referenceId,
    ownerScope: 'server',
    lifetime: 'agent-session',
    targetAgentSessionId: agentSessionId,
    targetAgentId: 'agent_codex_host',
    allowedInjectionPaths: ['backend-provider'],
    expiresAt: '2099-01-01T00:00:00.000Z',
    now: () => timestamp,
  });
  // This is a resolved direct-server declaration, not an authored Workspace requirement.
  const providerDeclaration = {
    id: 'native_generation_provider',
    vaultGrantId: grant.grantId,
    visibility: 'sandbox-provider' as const,
    provider: {
      instanceId: 'native-generation',
      type: 'github_mcp',
      credentialKey: 'GITHUB_TOKEN',
      profileId: 'github_mcp',
    },
  };
  const setup = createTestAgentSetup({
    imageRef: `sha256:${'a'.repeat(64)}`,
    requiredCapabilities: ['trusted-worker-inference-relay'],
    credentialDeclarations: [providerDeclaration],
  });
  await store.createAgentSession({
    id: agentSessionId,
    agentId: setup.manifest.id,
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: DEMO_THREAD_ID,
    status: 'idle',
    message: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const createdTurn = await store.createTurn(
    DEMO_WORKSPACE_ID,
    DEMO_THREAD_ID,
    'Native Provider generation one',
    { kind: 'user', id: localUserId },
    null,
    { startedAt: timestamp }
  );
  const turn = await store.updateTurn(createdTurn.id, {
    agentId: setup.manifest.id,
    agentSessionId,
  });
  const entry = createSchedulerAdmissionEntry(f.db, {
    backendId: 'nanohost',
    triggerActor: turn.triggerActor,
    profileRef: 'profile_worker',
    queueEntryId: `queue_${turn.id}`,
    requestId: randomUUID(),
    requestedAgentId: setup.manifest.id,
    threadId: turn.threadId,
    turnId: turn.id,
    turnInput: 'Native Provider generation one',
    workspaceId: DEMO_WORKSPACE_ID,
    now: () => timestamp,
  });
  const unlock = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(f.db.dataRoot, 'vault-generation'),
  });
  const workspaceDb = openWorkspaceDb(f.db.dataRoot, DEMO_WORKSPACE_ID);
  let ownerStage = 'primary-preparation';
  try {
    unlock.unlock({ masterKey: Buffer.alloc(32, 37) });
    const storedMaterial = unlock.backend().store({
      referenceId: originalReference.referenceId,
      material: 'synthetic-native-provider-generation-one',
      metadata: { ownerScope: 'server' },
    });
    expect(storedMaterial.currentVersion).toBe(1);
    expect(originalReference.currentVersion).toBe(1);
    const resolverInput = {
      agentSetup: setup,
      agentSessionId,
      coreDb: f.db,
      turn,
      triggerActor: turn.triggerActor,
      workspaceRoots: [],
      backend: { kind: 'openshell' as const },
      vaultBackend: () => unlock.backend(),
      createdAt: timestamp,
      now: () => timestamp,
    };
    const attempt = recordTestExecutionAttempt(f.db, {
      entry,
      attemptId: allocateEntityId('attempt'),
      agentSessionId,
      inputRef: `aepsnap_${turn.id}_${agentSessionId}`,
      bindingRef: `lease-binding:${turn.id}`,
      sessionCompatibilityKey: resolveAgentSessionCompatibilityKey(resolverInput),
      now: () => timestamp,
    });
    // Collect the actual MAIN producer's pending completion input. Neither sink publishes a
    // canonical receipt or supplies permission, and neither is a queue/advance stand-in.
    const pending: CreateVaultInjectionReceiptInput[] = [];
    let supplied = 0;
    const environmentPackage = await resolveAgentEnvironmentPackage({
      ...resolverInput,
      providerCredentialSink: (credential) => {
        expect(credential.providerInstanceId).toBe(providerDeclaration.provider.instanceId);
        expect(credential.credentialKey).toBe(providerDeclaration.provider.credentialKey);
        supplied += 1;
      },
      credentialReceiptSink: (receipt) => {
        pending.push(receipt);
      },
    });
    expect(supplied).toBe(1);
    expect(pending).toHaveLength(1);
    const receipt = pending[0];
    if (!receipt) throw new Error('The original producer completion input is absent.');
    const ledger = recordAgentEnvironmentPackageSnapshot(workspaceDb, {
      environmentPackage,
      createdAt: timestamp,
    });
    expect(ledger.snapshotId).toBe(environmentPackage.snapshotId);
    expect(ledger.agentSessionId).toBe(agentSessionId);
    assertCurrentWorkerCredentialAuthority(f.db, environmentPackage);
    const originalPlan = getVaultInjectionPlan(f.db, receipt.planId);
    if (!originalPlan) throw new Error('The original native Provider plan is absent.');
    expect(originalPlan).toMatchObject({
      grantId: grant.grantId,
      packageSnapshotId: environmentPackage.snapshotId,
      injectionVisibility: 'backend-provider',
      targetEnvVarName: providerDeclaration.provider.credentialKey,
    });
    expect(receipt.grantId).toBe(grant.grantId);
    expect(receipt.agentSessionId).toBe(agentSessionId);
    expect(getVaultGrant(f.db, originalPlan.grantId)).toEqual(grant);
    expect(grant.targetAgentSessionId).toBe(environmentPackage.scope.agentSessionId);
    const workerAuthority = {
      consumer: {
        snapshotId: environmentPackage.snapshotId,
        scope: {
          workspaceId: environmentPackage.scope.workspaceId,
          threadId: environmentPackage.scope.threadId,
          turnId: environmentPackage.scope.turnId,
          agentSessionId: environmentPackage.scope.agentSessionId,
          triggerActor: environmentPackage.scope.triggerActor,
        },
        agent: { agentId: environmentPackage.agent.agentId },
      },
      declarations: environmentPackage.credentials.declarations,
    };
    expect(listVaultInjectionReceipts(f.db)).toEqual([]);
    const rotated = unlock.backend().rotate({
      referenceId: originalReference.referenceId,
      material: 'synthetic-native-provider-generation-two',
    });
    expect(rotated.currentVersion).toBe(2);
    const client = getControlStoreWorkerClient();
    const advanced = await client.vault(f.db, 'reference-advance', {
      referenceId: originalReference.referenceId,
      currentVersion: 2,
      now: () => timestamp,
    });
    expect(advanced).toMatchObject({
      referenceId: originalReference.referenceId,
      currentVersion: 2,
    });
    expect(getVaultReference(f.db, originalReference.referenceId)?.currentVersion).toBe(2);
    const staleAuthority = {
      ...workerAuthority,
      materialVersion: originalReference.currentVersion,
    };
    const staleRecord = { ...receipt, workerAuthority: staleAuthority };
    // Parent enables ONLY the accepted transient codec field for OLD. No unknown-field
    // decoder failure is a verdict; this request must reach the real original native body.
    expect(
      ControlVaultInputSchema.safeParse({ kind: 'receipt-create', record: staleRecord }).success
    ).toBe(true);
    const beforeStale = f.submissions();
    const stale = await f.start(() => client.vault(f.db, 'receipt-create', staleRecord)).result;
    expect(f.submissions()).toBe(beforeStale + 1);
    if (stale.ok) expect(getVaultInjectionReceipt(f.db, receipt.receiptId)).toEqual(stale.value);
    // FIRST deciding assertion: OLD must actually commit this stale canonical receipt.
    expect(getVaultInjectionReceipt(f.db, receipt.receiptId)).toBeNull();
    expect(stale.ok).toBe(false);

    // The remaining arms run only after the actual generation refusal frontier on NEW.
    ownerStage = 'other-grant-create';
    const otherGrant = await createVaultGrant(f.db, {
      grantId: allocateEntityId('grant'),
      vaultReferenceId: originalReference.referenceId,
      ownerScope: 'server',
      lifetime: 'agent-session',
      targetAgentSessionId: agentSessionId,
      targetAgentId: setup.manifest.id,
      allowedInjectionPaths: ['backend-provider'],
      expiresAt: grant.expiresAt,
      now: () => timestamp,
    });
    ownerStage = 'wrong-key-plan-create';
    const wrongKeyPlan = await createVaultInjectionPlan(f.db, {
      planId: `plan_wrong_key_${randomUUID()}`,
      grantId: grant.grantId,
      packageSnapshotId: environmentPackage.snapshotId,
      injectionVisibility: 'backend-provider',
      targetEnvVarName: 'OTHER_TOKEN',
      backendCapabilityRequirement: originalPlan.backendCapabilityRequirement,
      expirationBehavior: originalPlan.expirationBehavior,
      revocationBehavior: originalPlan.revocationBehavior,
      redactionRule: originalPlan.redactionRule,
      now: () => timestamp,
    });
    const currentAuthority = { ...workerAuthority, materialVersion: 2 };
    const refusals = [
      { label: 'missing-version', record: { ...receipt, workerAuthority } },
      { label: 'missing-worker-authority', record: receipt },
      {
        label: 'missing-parent-plan',
        record: {
          ...receipt,
          planId: `plan_missing_${randomUUID()}`,
          workerAuthority: currentAuthority,
        },
      },
      {
        label: 'different-real-grant',
        record: { ...receipt, grantId: otherGrant.grantId, workerAuthority: currentAuthority },
      },
      {
        label: 'different-real-plan-key',
        record: { ...receipt, planId: wrongKeyPlan.planId, workerAuthority: currentAuthority },
      },
    ];
    for (const { label, record } of refusals) {
      ownerStage = label;
      expect(
        ControlVaultInputSchema.safeParse({ kind: 'receipt-create', record }).success,
        label
      ).toBe(true);
      const before = f.submissions();
      const result = await f.start(() => client.vault(f.db, 'receipt-create', record)).result;
      expect(f.submissions(), label).toBe(before + 1);
      expect(result.ok, label).toBe(false);
      expect(getVaultInjectionReceipt(f.db, receipt.receiptId), label).toBeNull();
    }
    ownerStage = 'first-current-receipt';
    const firstCurrentRecord = { ...receipt, workerAuthority: currentAuthority };
    expect(
      ControlVaultInputSchema.safeParse({ kind: 'receipt-create', record: firstCurrentRecord })
        .success
    ).toBe(true);
    const beforeFirstCurrent = f.submissions();
    const firstCurrent = await f.start(() =>
      client.vault(f.db, 'receipt-create', firstCurrentRecord)
    ).result;
    expect(f.submissions()).toBe(beforeFirstCurrent + 1);
    expect(firstCurrent.ok).toBe(true);
    if (!firstCurrent.ok) throw firstCurrent.error;
    expect(firstCurrent.value).toMatchObject({
      receiptId: receipt.receiptId,
      planId: originalPlan.planId,
      grantId: grant.grantId,
      agentSessionId,
      revocationStatus: 'active',
    });
    expect(getVaultInjectionReceipt(f.db, receipt.receiptId)).toEqual(firstCurrent.value);
    expect(listVaultInjectionReceipts(f.db)).toEqual([firstCurrent.value]);
    expect(getVaultReference(f.db, originalReference.referenceId)?.currentVersion).toBe(2);
    expect(getVaultGrant(f.db, grant.grantId)).toEqual(grant);
    expect(getVaultInjectionPlan(f.db, originalPlan.planId)).toEqual(originalPlan);
    // No Harness/SDK/Worker operation was ever submitted; all prefix native calls are joined.
    expect(attempt.operationId).toBeNull();
  } catch (error) {
    if (error instanceof ControlStoreWorkerError)
      throw new Error(`Native generation fixture owner stage: ${ownerStage}.`, { cause: error });
    throw error;
  } finally {
    unlock.lock();
    workspaceDb.sqlite.close();
  }
}, 30_000);

// COORD04:04 retains the original receipt bound while the complete session projection is counted as pending bytes.
describe('Vault session authority envelope admission', () => {
  it('admits a large complete authority projection while preserving receipt and full-request accounting bounds', () => {
    const agentSessionId = 'as_00000000-0000-7a76-a462-96e7448d3d9c';
    const grantId = 'grant_00000000-0000-7a76-a462-96e7448d3d9c';
    const receipt = {
      receiptId: 'receipt_session_envelope',
      planId: 'plan_session_envelope',
      grantId,
      agentSessionId,
      backendSummary: 'Synthetic completed private delivery.',
      injectedAt: clock,
      revocationStatus: 'active',
    };
    // This is a protocol shape fixture only. It does not claim any durable grant or successful sink.
    const workerAuthority = {
      consumer: {
        snapshotId: 'snapshot_session_envelope',
        scope: {
          workspaceId,
          threadId: 'th_00000000-0000-7a76-a462-96e7448d3d9c',
          turnId: 'tu_00000000-0000-7a76-a462-96e7448d3d9c',
          agentSessionId,
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7a76-a462-96e7448d3d9c' },
        },
        agent: { agentId: 'agent_session_envelope' },
      },
      declarations: Array.from({ length: 8192 }, (_, index) => ({
        id: `static_file_${index}`,
        vaultGrantId: grantId,
        visibility: 'runtime-file',
        targetPath: `/sandbox/synthetic-session-envelope/${index}`,
      })),
    };
    const frame = {
      version: CONTROL_WORKER_VERSION,
      id: 1,
      operation: 'vault',
      database: 'core:synthetic-session-envelope',
      input: { kind: 'receipt-create', record: { ...receipt, workerAuthority } },
    };
    expect(Buffer.byteLength(JSON.stringify(workerAuthority))).toBeGreaterThan(1024 * 1024);
    expect(isControlWorkerRequest(frame)).toBe(true);
    expect(controlWorkerInputBytes(frame as Parameters<typeof controlWorkerInputBytes>[0])).toBe(
      Buffer.byteLength(JSON.stringify(frame))
    );
    expect(
      controlWorkerInputBytes(frame as Parameters<typeof controlWorkerInputBytes>[0])
    ).toBeGreaterThan(1024 * 1024);
    expect(
      controlWorkerInputBytes(frame as Parameters<typeof controlWorkerInputBytes>[0])
    ).toBeLessThan(64 * 1024 * 1024);
    expect(CONTROL_WORKER_LIMITS.pendingBytes).toBe(64 * 1024 * 1024);
    const oversizedReceipt = { ...receipt, backendSummary: 'x'.repeat(1024 * 1024) };
    expect(
      isControlWorkerRequest({
        ...frame,
        input: { kind: 'receipt-create', record: { ...oversizedReceipt, workerAuthority } },
      })
    ).toBe(false);
    expect(
      isControlWorkerRequest({
        ...frame,
        input: { kind: 'receipt-create', record: oversizedReceipt },
      })
    ).toBe(false);
    expect(
      isControlWorkerRequest({
        ...frame,
        input: { kind: 'receipt-create', record: receipt },
      })
    ).toBe(true);
  });
});

// core/policy.md:56,82 and durable_execution_and_control_store.md:61 require deciding current issuer facts.
it.each([
  ['create', 'token'],
  ['create', 'administrator'],
  ['narrow', 'token'],
  ['narrow', 'administrator'],
] as const)(
  'refuses public Workspace grant %s after %s withdrawal before native BEGIN',
  async (action, withdrawal) => {
    const { createOpenKitAccessTokenRecord, revokeOpenKitAccessTokenRecord } = await import(
      '../auth/access-token-store.js'
    );
    const { Worker } = await import('node:worker_threads');
    const { FsStore } = await import('../lib/store.js');
    const { createOperationInvocation } = await import('../operation-composition.js');
    const { WorkspaceMutationAdmission } = await import('../workspace-mutation-admission.js');
    const { createVaultUnlockState } = await import('../vault/vault-unlock-state.js');
    const { listVaultGrants } = await import('../vault/vault-grants.js');
    const { listSqliteAuditEvents } = await import('../audit-events.js');
    const { openWorkspaceDb } = await import('./db.js');
    const { applyScopedMigrations } = await import('./migrate.js');
    const f = await fixture();
    const userId = ensureLocalUser(f.db);
    const token = createOpenKitAccessTokenRecord(f.db, {
      ownerUserId: userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00Z',
    });
    const actor = {
      kind: 'token',
      userId,
      tokenId: token.tokenId,
      tokenScope: 'server-admin',
    } as const;
    const store = new FsStore({ dataRoot: f.db.dataRoot });
    const workspace = await store.createWorkspace('Late issuer withdrawal');
    recordWorkspaceOwnerMembership({
      coreDb: f.db,
      workspaceId: workspace.id,
      ownerUserId: userId,
    });
    const unlock = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(f.db.dataRoot, 'synthetic-vault'),
    });
    unlock.unlock({ masterKey: Buffer.alloc(32, 19) });
    const invoke = createOperationInvocation({
      coreDb: f.db,
      dataRoot: f.db.dataRoot,
      store,
      repositoryWorkspaceDb: (id: string) => {
        const db = openWorkspaceDb(f.db.dataRoot, id);
        applyScopedMigrations(db, undefined, 'pre-knowledge');
        return db;
      },
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      inflightCommands: new WeakMap(),
      vaultUnlockState: unlock,
    });
    const call = (operation: string, input: unknown) =>
      invoke(operation as never, input as never, { kind: 'public', actor }) as Promise<
        Record<string, unknown>
      >;
    let operation: ReturnType<typeof f.start> | undefined;
    try {
      const reference = await call('vault.secret-create', {
        workspaceId: workspace.id,
        secretKind: 'mcp-credential',
        material: 'synthetic-late-issuer',
      });
      const old = await call('vault.grant-create', {
        workspaceId: workspace.id,
        referenceId: reference.referenceId,
        injectionPath: 'runtime-file',
      });
      const grantsBefore = listVaultGrants(f.db);
      const successfulAuditIds = () =>
        listSqliteAuditEvents(f.db.sqlite)
          .filter(
            (event) =>
              event.outcome === 'succeeded' &&
              ['vault.workspace_grant', 'vault.workspace_narrow-grant'].includes(event.action)
          )
          .map((event) => event.id);
      const auditBefore = successfulAuditIds();
      const nativeRefusals: string[] = [];
      const emit = Worker.prototype.emit;
      const refusalSpy = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
        this: InstanceType<typeof Worker>,
        event: string | symbol,
        ...args: unknown[]
      ) {
        const reply = args[0] as { status?: string; commit?: string } | undefined;
        if (event === 'message' && reply?.status === 'error' && reply.commit)
          nativeRefusals.push(reply.commit);
        return emit.call(this, event, ...args);
      });
      arm(f, 1);
      operation = f.start(() =>
        action === 'create'
          ? call('vault.grant-create', {
              workspaceId: workspace.id,
              referenceId: reference.referenceId,
              injectionPath: 'runtime-file',
            })
          : call('vault.grant-narrow', {
              workspaceId: workspace.id,
              grantId: old.grantId,
              constraints: { expiresAt: '2998-01-01T00:00:00.000Z' },
            })
      );
      await reached(f, operation);
      // These are the actual identity owners. BEGIN is still held, so no competing writer is blocked.
      if (withdrawal === 'token') revokeOpenKitAccessTokenRecord(f.db, token.tokenId);
      else f.db.sqlite.transaction(() => disableCanonicalUser(f.db, userId))();
      releaseNative(f.gate);
      const result = await operation.result;
      // Public refusal plus complete durable equality is the deciding not-committed oracle.
      expect(result.ok).toBe(false);
      expect(nativeRefusals).toEqual(['not-committed']);
      refusalSpy.mockRestore();
      if (result.ok) throw new Error('Withdrawn issuer published a successful grant mutation.');
      expect(result.error).toHaveProperty('status');
      expect([403, 409]).toContain((result.error as { status: number }).status);
      expect(listVaultGrants(f.db)).toEqual(grantsBefore);
      expect(listVaultGrants(f.db).find((grant) => grant.grantId === old.grantId)).toEqual(
        grantsBefore.find((grant) => grant.grantId === old.grantId)
      );
      expect(successfulAuditIds()).toEqual(auditBefore);
    } finally {
      releaseNative(f.gate);
      await operation?.result;
      unlock.lock();
    }
  }
);

// Core Vault and Durable Control Store: the existing grant-revoke owner decides after FIFO,
// and grant/plan/receipt projection changes share its savepoint and covering FULL ACK.
describe('native User reference owner withdrawal', () => {
  it.each([
    'full-ack-and-cold-read',
    'projection-rollback',
    'requester-disabled',
    'token-revoked',
    'reference-owner-changed',
    'grant-workspace-changed',
  ] as const)(
    'preserves current owner authority and the original withdrawal tuple (%s)',
    async (scenario) => {
      const f = await fixture();
      const localUserId = ensureLocalUser(f.db);
      const auth = createBetterAuth(f.db, { env: {} });
      const { user } = await auth.api.signUpEmail({
        body: {
          name: 'Native reference owner',
          email: `${randomUUID()}@example.invalid`,
          password: randomUUID(),
        },
      });
      let actor: Actor = { kind: 'session', userId: user.id };
      let tokenId: string | undefined;
      if (scenario === 'token-revoked') {
        const token = createOpenKitAccessTokenRecord(f.db, {
          ownerUserId: user.id,
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: '2999-01-01T00:00:00.000Z',
        });
        tokenId = token.tokenId;
        actor = { kind: 'token', userId: user.id, tokenId, tokenScope: 'server-admin' };
      }
      recordWorkspaceOwnerMembership({ coreDb: f.db, workspaceId, ownerUserId: localUserId });
      const otherWorkspaceId = 'ws_00000000-0000-73c3-900f-8d310e4ba202';
      recordWorkspaceOwnerMembership({
        coreDb: f.db,
        workspaceId: otherWorkspaceId,
        ownerUserId: localUserId,
      });
      const reference = await createVaultReference(f.db, {
        ...createInput(),
        ownerScope: 'user',
        userId: user.id,
      });
      const grant = await createVaultGrant(f.db, {
        grantId: 'grant_00000000-0000-7a76-a462-96e7448d3d9c',
        vaultReferenceId: referenceId,
        ownerScope: 'workspace',
        workspaceId,
        allowedInjectionPaths: ['gateway-only'],
        lifetime: 'workspace',
      });
      const untouched = await createVaultGrant(f.db, {
        ...grant,
        grantId: 'grant_00000000-0000-7a76-a462-96e7448d3d9d',
        workspaceId: otherWorkspaceId,
      });
      const plan = await createVaultInjectionPlan(f.db, {
        planId: 'plan_native_user_withdrawal',
        grantId: grant.grantId,
        injectionVisibility: 'gateway-only',
        expirationBehavior: 'Deny expired use.',
        revocationBehavior: 'Close affected connection.',
        redactionRule: 'Exclude material.',
        backendCapabilityRequirement: 'gateway-only',
      });
      const receipt = await createVaultInjectionReceipt(f.db, {
        receiptId: 'receipt_native_user_withdrawal',
        planId: plan.planId,
        grantId: grant.grantId,
        agentSessionId: 'as_00000000-0000-7a76-a462-96e7448d3d9c',
        backendSummary: 'Synthetic acknowledged connection.',
        injectedAt: clock,
        revocationStatus: 'active',
      });
      if (scenario === 'projection-rollback')
        f.db.sqlite.exec(`CREATE TRIGGER reject_user_withdrawal_projection
        BEFORE UPDATE ON vault_injection_receipts
        BEGIN SELECT RAISE(ABORT, 'Synthetic withdrawal projection failure'); END`);
      const commits = f.commits();
      const success = scenario === 'full-ack-and-cold-read';
      arm(f, success ? 2 : 1, success);
      const pending = f.start(() =>
        getControlStoreWorkerClient().vault(f.db, 'grant-revoke', {
          grantId: grant.grantId,
          // These are current records from the real owners, never an earlier allow Boolean.
          publicMutation: { actor, workspaceId, reference },
        })
      );
      try {
        await reached(f, pending);
        if (scenario === 'requester-disabled')
          f.db.sqlite.transaction(() => disableCanonicalUser(f.db, user.id))();
        else if (scenario === 'token-revoked') revokeOpenKitAccessTokenRecord(f.db, tokenId!);
        else if (scenario === 'reference-owner-changed')
          f.fixtureSql('UPDATE vault_references SET user_id = ? WHERE reference_id = ?').run(
            localUserId,
            referenceId
          );
        else if (scenario === 'grant-workspace-changed')
          f.fixtureSql('UPDATE vault_grants SET workspace_id = ? WHERE grant_id = ?').run(
            otherWorkspaceId,
            grant.grantId
          );
        // Storage owns the deliberate post-admission changes above. Product Main stays query-only.
        f.db.sqlite.pragma('query_only = ON');
        if (success) {
          expect(Atomics.load(f.gate, 4)).toBe(2); // SQLite FULL, read in the actual writer before COMMIT.
          expect(getVaultGrant(f.db, grant.grantId)).toEqual(grant);
          expect(getVaultInjectionPlan(f.db, plan.planId)).toEqual(plan);
          expect(listVaultInjectionReceipts(f.db)).toEqual([receipt]);
        }
        releaseNative(f.gate);
        if (success) {
          await reached(f, pending, 'reply');
          expect(f.commits() - commits).toBe(1);
          expect(getVaultGrant(f.db, grant.grantId)).toEqual({ ...grant, status: 'revoked' });
          expect(getVaultInjectionPlan(f.db, plan.planId)).toEqual({ ...plan, status: 'revoked' });
          expect(listVaultInjectionReceipts(f.db)).toEqual([
            { ...receipt, revocationStatus: 'revoked' },
          ]);
          expect(pending.settled()).toBe(false);
          deliverReplies();
          expect(await pending.result).toEqual({
            ok: true,
            value: { ...grant, status: 'revoked' },
          });
          await shutdownControlStoreWorkerClient();
          const cold = openCoreDb(f.db.dataRoot);
          try {
            expect(getVaultGrant(cold, grant.grantId)).toEqual({ ...grant, status: 'revoked' });
            expect(getVaultInjectionPlan(cold, plan.planId)).toEqual({
              ...plan,
              status: 'revoked',
            });
            expect(listVaultInjectionReceipts(cold)).toEqual([
              { ...receipt, revocationStatus: 'revoked' },
            ]);
            expect(getVaultGrant(cold, untouched.grantId)).toEqual(untouched);
            expect(getVaultReference(cold, referenceId)).toEqual(reference);
          } finally {
            cold.sqlite.close();
          }
        } else {
          expect(await pending.result).toMatchObject({
            ok: false,
            error: { commit: 'not-committed' },
          });
          if (scenario === 'projection-rollback')
            expect(await pending.result).toMatchObject({
              ok: false,
              error: { code: 'constraint', commit: 'not-committed' },
            });
          expect(getVaultGrant(f.db, grant.grantId)).toEqual(
            scenario === 'grant-workspace-changed'
              ? { ...grant, workspaceId: otherWorkspaceId }
              : grant
          );
          expect(getVaultInjectionPlan(f.db, plan.planId)).toEqual(plan);
          expect(listVaultInjectionReceipts(f.db)).toEqual([receipt]);
          expect(getVaultGrant(f.db, untouched.grantId)).toEqual(untouched);
        }
      } finally {
        releaseNative(f.gate);
        deliverReplies();
        await pending.result;
      }
    }
  );
});

/** Reuses the physical SQLite/FULL/reply instrument with a real fixed-User operation composition. */
async function nativeLoginFixture() {
  const f = await fixture();
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { FsStore } = await import('../lib/store.js');
  const { createRuntimeConfigManager } = await import('../config/runtime-config.js');
  const { PolicyInterception } = await import('../policy/interception.js');
  const { createOperationInvocation } = await import('../operation-composition.js');
  const { WorkspaceMutationAdmission } = await import('../workspace-mutation-admission.js');
  const { createVaultUnlockState } = await import('../vault/vault-unlock-state.js');
  const { openUserDb, openWorkspaceDb } = await import('./db.js');
  const { applyScopedMigrations } = await import('./migrate.js');
  const localUserId = ensureLocalUser(f.db);
  const { user } = await createBetterAuth(f.db, { env: {} }).api.signUpEmail({
    body: {
      name: 'Native Login owner',
      email: `${randomUUID()}@example.invalid`,
      password: randomUUID(),
    },
  });
  const actor: Actor = { kind: 'session', userId: user.id };
  const input = {
    ...createInput(),
    backendKind: 'encrypted-file' as const,
    ownerScope: 'user' as const,
    userId: user.id,
    login: {
      provider: 'codex' as const,
      accountId: 'synthetic-native-account',
      quarantined: false,
    },
  };
  const login = await createVaultReference(f.db, input);
  expect(
    login,
    'O1 prerequisite: real native owner must retain explicit Login metadata'
  ).toMatchObject({ login: input.login });
  const userDb = openUserDb(f.db.dataRoot, user.id);
  applyScopedMigrations(userDb);
  userDb.sqlite.close();
  mkdirSync(join(f.db.dataRoot, 'config'), { recursive: true });
  writeFileSync(join(f.db.dataRoot, 'config/server.jsonc'), JSON.stringify({ schemaVersion: 1 }));
  const invoke = createOperationInvocation({
    coreDb: f.db,
    dataRoot: f.db.dataRoot,
    store: new FsStore({ dataRoot: f.db.dataRoot }),
    repositoryUserDb: (id) => openUserDb(f.db.dataRoot, id),
    repositoryWorkspaceDb: (id) => openWorkspaceDb(f.db.dataRoot, id),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    inflightCommands: new WeakMap(),
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot: f.db.dataRoot }),
    policyInterception: new PolicyInterception({
      id: 'native-login-test',
      version: `sha256:${'2'.repeat(64)}`,
      invoke: async () => ({ decision: 'allow' }),
    }),
    vaultUnlockState: createVaultUnlockState({
      backendKind: 'encrypted-file' as const,
      storeDir: join(f.db.dataRoot, 'vault'),
    }),
  });
  const call = (operation = 'vault.login-quarantine', caller: Actor = actor) =>
    invoke(operation as never, { referenceId: login.referenceId } as never, {
      kind: 'public',
      actor: caller,
    });
  // User Policy can use another pool member. Kill the exact Worker sent the Vault request.
  const { Worker } = await import('node:worker_threads');
  const postMessage = Worker.prototype.postMessage;
  let vaultWorker: NativeWorker | undefined;
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: NativeWorker,
    ...args: Parameters<NativeWorker['postMessage']>
  ) {
    if ((args[0] as { operation?: string } | undefined)?.operation === 'vault') vaultWorker = this;
    return Reflect.apply(postMessage, this, args);
  });
  return { ...f, actor, localUserId, login, call, vaultWorker: () => vaultWorker };
}

/** Arms only on the real Vault-family submission, after all awaited User Policy work. No private arm name is selected. */
function interceptLoginVault(f: Fixture, point: 1 | 2 | 3, holdReply = false) {
  const client = getControlStoreWorkerClient();
  const original = client.vault;
  let calls = 0;
  let beforeCommit = -1;
  let beforeSubmissions = -1;
  vi.spyOn(client, 'vault').mockImplementation((async (
    ...args: Parameters<typeof client.vault>
  ) => {
    calls++;
    if (calls === 1) {
      beforeCommit = f.commits();
      beforeSubmissions = f.submissions();
      arm(f, point, holdReply);
    }
    return Reflect.apply(original, client, args);
  }) as typeof client.vault);
  return {
    calls: () => calls,
    beforeCommit: () => beforeCommit,
    beforeSubmissions: () => beforeSubmissions,
  };
}

/** The public result cannot reveal physical timing; this gray-box check observes the actual native owner. */
describe('Login metadata native acknowledgement and currentness', () => {
  it('withholds operation success before FULL COMMIT and before its covering reply, then survives cold reopen', async () => {
    const f = await nativeLoginFixture();
    const boundary = interceptLoginVault(f, 2, true);
    f.db.sqlite.pragma('query_only = ON');
    const pending = f.start(() => f.call());
    try {
      await reached(f, pending);
      expect(Atomics.load(f.gate, 4)).toBe(2);
      expect(f.commits()).toBe(boundary.beforeCommit());
      expect(getVaultReference(f.db, f.login.referenceId)).toEqual(f.login);
      releaseNative(f.gate);
      await reached(f, pending, 'reply');
      const committed = getVaultReference(f.db, f.login.referenceId)!;
      expect(committed).toMatchObject({
        login: { quarantined: true },
        currentVersion: 1,
        status: 'active',
      });
      expect(f.commits()).toBe(boundary.beforeCommit() + 1);
      expect(pending.settled()).toBe(false);
      deliverReplies();
      expect(await pending.result).toEqual({
        ok: true,
        value: {
          referenceId: f.login.referenceId,
          provider: 'codex',
          status: 'active',
          currentVersion: 1,
          quarantined: true,
          observations: null,
        },
      });
      expect(boundary.calls()).toBe(1);
      expect(f.submissions() - boundary.beforeSubmissions()).toBe(1);
      await shutdownControlStoreWorkerClient();
      const cold = openCoreDb(f.db.dataRoot);
      try {
        expect(getVaultReference(cold, f.login.referenceId)).toEqual(committed);
      } finally {
        cold.sqlite.close();
      }
    } catch (failure) {
      // Failure-only evidence separates an early public success from an early refusal.
      // Capture the boundary before inspecting the already-settled real operation result.
      const settled = pending.settled();
      const diagnostic = {
        settled,
        gate: Array.from({ length: f.gate.length }, (_, index) => Atomics.load(f.gate, index)),
        vaultCalls: boundary.calls(),
        commits: { beforeVault: boundary.beforeCommit(), observed: f.commits() },
        submissions: { beforeVault: boundary.beforeSubmissions(), observed: f.submissions() },
        retainedQuarantined:
          getVaultReference(f.db, f.login.referenceId)?.login?.quarantined ?? null,
      };
      let outcome: unknown = { state: 'pending' };
      if (settled) {
        const actual = await pending.result;
        if (actual.ok) {
          const view = actual.value as unknown as Record<string, unknown> | null;
          outcome = {
            ok: true,
            view: {
              referenceId:
                view?.referenceId === f.login.referenceId ? f.login.referenceId : 'unexpected',
              provider: view?.provider === 'codex' ? 'codex' : 'unexpected',
              status:
                typeof view?.status === 'string' &&
                ['active', 'revoked', 'unbound'].includes(view.status)
                  ? view.status
                  : 'unexpected',
              currentVersion: Number.isSafeInteger(view?.currentVersion)
                ? view?.currentVersion
                : 'unexpected',
              quarantined: typeof view?.quarantined === 'boolean' ? view.quarantined : 'unexpected',
              observations: view?.observations === null ? null : 'unexpected',
            },
          };
        } else {
          const error = actual.error as { code?: unknown; status?: unknown } | null;
          outcome = {
            ok: false,
            error: {
              code:
                typeof error?.code === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(error.code)
                  ? error.code
                  : 'unavailable',
              status:
                typeof error?.status === 'number' &&
                Number.isInteger(error.status) &&
                error.status >= 100 &&
                error.status <= 599
                  ? error.status
                  : null,
            },
          };
        }
      }
      console.error(
        'Login acknowledgement failure diagnostic',
        JSON.stringify({ ...diagnostic, outcome })
      );
      throw failure;
    } finally {
      releaseNative(f.gate);
      deliverReplies();
      await pending.result;
    }
  });

  it('reports incomplete after physical commit with lost acknowledgement and never replays the mutation', async () => {
    const f = await nativeLoginFixture();
    const boundary = interceptLoginVault(f, 3);
    const pending = f.start(() => f.call());
    try {
      await reached(f, pending);
      const committed = getVaultReference(f.db, f.login.referenceId);
      expect(committed).toMatchObject({ login: { quarantined: true }, currentVersion: 1 });
      expect(Atomics.load(f.gate, 4)).toBe(2);
      expect(f.commits()).toBe(boundary.beforeCommit() + 1);
      const worker = f.vaultWorker();
      expect(worker).toBeDefined();
      await worker!.terminate();
      const outcome = await pending.result;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Lost Login acknowledgement returned success.');
      expect(outcome.error).toMatchObject({ status: 409 });
      expect(getVaultReference(f.db, f.login.referenceId)).toEqual(committed);
      expect(boundary.calls()).toBe(1);
      expect(f.submissions() - boundary.beforeSubmissions()).toBe(1);
    } finally {
      releaseNative(f.gate);
      deliverReplies();
      await pending.result;
    }
  });

  it.each([
    'requester-disabled',
    'token-revoked',
    'owner-changed',
    'version-changed',
    'reference-revoked',
    'reference-unbound',
  ] as const)(
    'rechecks exact captured authority after native FIFO admission (%s)',
    async (change) => {
      const f = await nativeLoginFixture();
      let actor: Actor = f.actor;
      let tokenId: string | undefined;
      if (change === 'token-revoked') {
        const token = createOpenKitAccessTokenRecord(f.db, {
          ownerUserId: f.actor.userId,
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: '2999-01-01T00:00:00.000Z',
        });
        tokenId = token.record.tokenId;
        actor = { kind: 'token', userId: f.actor.userId, tokenId, tokenScope: 'server-admin' };
      }
      const boundary = interceptLoginVault(f, 1);
      const pending = f.start(() => f.call('vault.login-quarantine', actor));
      try {
        await reached(f, pending);
        if (change === 'requester-disabled')
          f.db.sqlite.transaction(() => disableCanonicalUser(f.db, f.actor.userId))();
        else if (change === 'token-revoked') revokeOpenKitAccessTokenRecord(f.db, tokenId!);
        else if (change === 'owner-changed')
          f.fixtureSql('UPDATE vault_references SET user_id = ? WHERE reference_id = ?').run(
            f.localUserId,
            f.login.referenceId
          );
        else if (change === 'version-changed')
          f.fixtureSql(
            'UPDATE vault_references SET current_version = 2 WHERE reference_id = ?'
          ).run(f.login.referenceId);
        else if (change === 'reference-unbound')
          f.fixtureSql(
            "UPDATE vault_references SET status = 'unbound', current_version = 0 WHERE reference_id = ?"
          ).run(f.login.referenceId);
        else
          f.fixtureSql("UPDATE vault_references SET status = 'revoked' WHERE reference_id = ?").run(
            f.login.referenceId
          );
        const current = getVaultReference(f.db, f.login.referenceId);
        f.db.sqlite.pragma('query_only = ON');
        releaseNative(f.gate);
        const outcome = await pending.result;
        expect(outcome.ok).toBe(false);
        expect(getVaultReference(f.db, f.login.referenceId)).toEqual(current);
        expect(boundary.calls()).toBe(1);
        expect(f.submissions() - boundary.beforeSubmissions()).toBe(1);
      } finally {
        releaseNative(f.gate);
        deliverReplies();
        await pending.result;
      }
    }
  );
});

/** Additional metadata facts must remain current at the same real public-to-native crossing. */
describe('Login release retained lifecycle and metadata currentness', () => {
  it('refuses actual public release of a previously unbound Login without promoting or changing it', async () => {
    const f = await nativeLoginFixture();
    await f.call('vault.login-quarantine');
    const quarantined = getVaultReference(f.db, f.login.referenceId)!;
    expect(quarantined).toMatchObject({ status: 'active', login: { quarantined: true } });
    // There is no User Login import producer in this cut. Only this owner fixture injects unbound state after valid publication.
    f.fixtureSql(
      "UPDATE vault_references SET status = 'unbound', current_version = 0, backend_locator = NULL WHERE reference_id = ?"
    ).run(f.login.referenceId);
    const retained = getVaultReference(f.db, f.login.referenceId)!;
    expect(retained).toMatchObject({
      status: 'unbound',
      currentVersion: 0,
      backendLocator: null,
      login: { quarantined: true },
    });
    f.db.sqlite.pragma('query_only = ON');
    await expect(f.call('vault.login-release')).rejects.toHaveProperty('status');
    expect(getVaultReference(f.db, f.login.referenceId)).toEqual(retained);
  });

  it('refuses a captured release after another real public release changes quarantine first', async () => {
    const f = await nativeLoginFixture();
    await f.call('vault.login-quarantine');
    const client = getControlStoreWorkerClient();
    const original = client.vault;
    let captured = false;
    let calls = 0;
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(client, 'vault').mockImplementation((async (
      ...args: Parameters<typeof client.vault>
    ) => {
      calls++;
      if (calls === 1) {
        captured = true;
        await held;
      }
      return Reflect.apply(original, client, args);
    }) as typeof client.vault);
    const stale = f.start(() => f.call('vault.login-release'));
    try {
      // Hold the real crossing after selection; a second real owner request becomes the predecessor.
      // The original test deadline bounds this wait, as in the existing native instrument.
      while (!captured && !stale.settled()) await nextTurn();
      expect(captured).toBe(true);
      expect(stale.settled()).toBe(false);
      await expect(f.call('vault.login-release')).resolves.toMatchObject({ quarantined: false });
      const current = getVaultReference(f.db, f.login.referenceId);
      expect(current).toMatchObject({ login: { quarantined: false } });
      f.db.sqlite.pragma('query_only = ON');
      resume();
      expect((await stale.result).ok).toBe(false);
      expect(getVaultReference(f.db, f.login.referenceId)).toEqual(current);
      expect(calls).toBe(2);
    } finally {
      resume();
      await stale.result;
    }
  });

  it.each(['account-equality-changed', 'subtype-removed'] as const)(
    'refuses stale public release after native FIFO admission (%s)',
    async (change) => {
      const f = await nativeLoginFixture();
      await f.call('vault.login-quarantine');
      expect(getVaultReference(f.db, f.login.referenceId)).toMatchObject({
        login: { quarantined: true },
      });
      const boundary = interceptLoginVault(f, 1);
      const pending = f.start(() => f.call('vault.login-release'));
      try {
        await reached(f, pending);
        // Faults change only the newly selected metadata. Existing status/version/owner/credential tests remain primary.
        if (change === 'account-equality-changed')
          f.fixtureSql(
            'UPDATE vault_references SET login_account_id = ? WHERE reference_id = ?'
          ).run('synthetic-successor-equality', f.login.referenceId);
        else
          f.fixtureSql(
            'UPDATE vault_references SET login_provider = NULL, login_account_id = NULL, login_quarantined = NULL WHERE reference_id = ?'
          ).run(f.login.referenceId);
        const current = getVaultReference(f.db, f.login.referenceId);
        const retained = f.db.sqlite
          .prepare('SELECT * FROM vault_references WHERE reference_id = ?')
          .get(f.login.referenceId);
        f.db.sqlite.pragma('query_only = ON');
        releaseNative(f.gate);
        const outcome = await pending.result;
        expect(outcome.ok).toBe(false);
        expect(getVaultReference(f.db, f.login.referenceId)).toEqual(current);
        expect(
          f.db.sqlite
            .prepare('SELECT * FROM vault_references WHERE reference_id = ?')
            .get(f.login.referenceId)
        ).toEqual(retained);
        expect(boundary.calls()).toBe(1);
        expect(f.submissions() - boundary.beforeSubmissions()).toBe(1);
      } finally {
        releaseNative(f.gate);
        deliverReplies();
        await pending.result;
      }
    }
  );
});

import { createApp } from '../test-support/app.js';

/** Real public request/review and native User Login creation precede every armed storage fault. */
async function nativeLoginShareFixture(useAdminBearer = false) {
  const f = await fixture();
  const { allocateEntityId } = await import('@openkit/protocol');
  const { operationRequest } = await import('../test-support/operation-request.js');
  const { createVaultUnlockState } = await import('../vault/vault-unlock-state.js');
  const { FsStore } = await import('../lib/store.js');
  ensureLocalUser(f.db);
  const { user } = await createBetterAuth(f.db, { env: {} }).api.signUpEmail({
    body: {
      name: 'Native share owner',
      email: `${randomUUID()}@example.invalid`,
      password: randomUUID(),
    },
  });
  const unlock = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(f.db.dataRoot, 'vault-share'),
  });
  unlock.unlock({ masterKey: Buffer.alloc(32, 23) });
  const store = new FsStore({ dataRoot: f.db.dataRoot });
  const localApp = createApp({
    coreDb: f.db,
    dataRoot: f.db.dataRoot,
    store,
    vaultUnlockState: unlock,
  });
  const sessionId = allocateEntityId('auth');
  const ownerApp = createApp({
    coreDb: f.db,
    dataRoot: f.db.dataRoot,
    store,
    vaultUnlockState: unlock,
    mode: 'server',
    auth: {
      api: { getSession: async () => ({ session: { id: sessionId }, user: { id: user.id } }) },
      handler: async () => Response.json({}),
    },
  });
  const send = (
    app: typeof localApp,
    operation: string,
    body: Record<string, unknown>,
    secret?: string
  ) =>
    app.request(
      ...operationRequest(
        operation as import('@openkit/app-api-schemas').OperationId,
        {},
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(secret ? { authorization: `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify(body),
        }
      )
    );
  const workspace = await send(localApp, 'workspace.create', {
    name: 'Native share target',
    requestId: randomUUID(),
  });
  expect(workspace.status).toBe(201);
  const workspaceId = (await workspace.json()).id as string;
  const invitationResponse = await send(localApp, 'workspace.invitation-create', {
    workspaceId,
    inviteeEmail: user.email,
    requestId: randomUUID(),
  });
  expect(invitationResponse.status).toBe(201);
  const { invitation } = await invitationResponse.json();
  expect(
    (
      await send(ownerApp, 'workspace.my-invitation-accept', {
        invitationId: invitation.invitationId,
        expectedRevision: invitation.revision,
        requestId: randomUUID(),
      })
    ).status
  ).toBe(200);
  const threadResponse = await send(ownerApp, 'thread.create', {
    workspaceId,
    name: 'Native exact share review',
    visibility: 'workspace',
    requestId: randomUUID(),
  });
  expect(threadResponse.status).toBe(200);
  const threadId = (await threadResponse.json()).id as string;
  const referenceId = allocateEntityId('vault');
  unlock.backend().store({
    referenceId,
    material: 'synthetic-native-share-material',
    metadata: { ownerScope: 'user', userId: user.id },
  });
  const reference = await createVaultReference(f.db, {
    referenceId,
    ownerScope: 'user',
    userId: user.id,
    displayName: 'Native share Login',
    secretKind: 'opaque',
    backendKind: 'encrypted-file',
    login: { provider: 'codex', accountId: 'synthetic-native-share-account', quarantined: false },
  });
  expect(reference).toMatchObject({
    status: 'active',
    currentVersion: 1,
    ownerScope: 'user',
    userId: user.id,
    login: { provider: 'codex' },
  });
  const terms = {
    referenceId,
    ownerScope: 'workspace',
    lifetime: 'workspace',
    injectionPath: 'runtime-token',
  };
  const raised = await send(ownerApp, 'vault.grant-request', {
    workspaceId,
    threadId,
    terms,
    requestId: randomUUID(),
  });
  expect(
    raised.status,
    'Expected feature baseline is unsupported runtime-token, after valid native Login setup'
  ).toBe(200);
  const request = await raised.json();
  const decidingToken = useAdminBearer
    ? createOpenKitAccessTokenRecord(f.db, {
        ownerUserId: user.id,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      })
    : undefined;
  const reviewApp = decidingToken
    ? createApp({
        coreDb: f.db,
        dataRoot: f.db.dataRoot,
        store,
        vaultUnlockState: unlock,
        mode: 'server',
        auth: { api: { getSession: async () => null }, handler: async () => Response.json({}) },
      })
    : ownerApp;
  expect(
    (
      await send(
        reviewApp,
        'approval.respond',
        {
          workspaceId,
          threadId,
          turnId: request.raisingTurnId,
          approvalRequestId: request.approvalRequestId,
          decision: 'granted',
          requestId: randomUUID(),
        },
        decidingToken?.secret
      )
    ).status
  ).toBe(200);
  const issue = async () => {
    const response = await send(
      reviewApp,
      'vault.grant-issue',
      { workspaceId, threadId, approvalRequestId: request.approvalRequestId },
      decidingToken?.secret
    );
    return { status: response.status, body: await response.json() };
  };
  return { ...f, user, workspaceId, reference, request, unlock, decidingToken, issue };
}

// Accepted Vault publication plus Durable Control Store FULL ACK: reuse the actual existing
// native SQLite/reply instrument. No new private operation selector or returned-result double.
describe('User Login share native publication', () => {
  it('withholds success through FULL COMMIT and covering reply, then survives a cold Core read', async () => {
    const f = await nativeLoginShareFixture();
    const boundary = interceptLoginVault(f, 2, true);
    f.db.sqlite.pragma('query_only = ON');
    const pending = f.start(f.issue);
    try {
      await reached(f, pending);
      expect(Atomics.load(f.gate, 4)).toBe(2);
      expect(f.commits()).toBe(boundary.beforeCommit());
      expect(f.db.sqlite.prepare('SELECT * FROM vault_grants').all()).toEqual([]);
      releaseNative(f.gate);
      await reached(f, pending, 'reply');
      const rows = f.db.sqlite
        .prepare<[], { grant_id: string }>('SELECT grant_id FROM vault_grants')
        .all();
      expect(rows).toHaveLength(1);
      const committed = getVaultGrant(f.db, rows[0]!.grant_id)!;
      expect(committed).toMatchObject({
        vaultReferenceId: f.reference.referenceId,
        ownerScope: 'workspace',
        workspaceId: f.workspaceId,
        lifetime: 'workspace',
        allowedInjectionPaths: ['runtime-token'],
        approvalId: f.request.approvalRequestId,
      });
      expect(getVaultReference(f.db, f.reference.referenceId)).toEqual(f.reference);
      expect(pending.settled()).toBe(false);
      expect(f.commits()).toBe(boundary.beforeCommit() + 1);
      deliverReplies();
      expect(await pending.result).toMatchObject({
        ok: true,
        value: {
          status: 200,
          body: { grantId: committed.grantId, disposition: 'approved-executed' },
        },
      });
      await shutdownControlStoreWorkerClient();
      const cold = openCoreDb(f.db.dataRoot);
      try {
        expect(getVaultGrant(cold, committed.grantId)).toEqual(committed);
        expect(getVaultReference(cold, f.reference.referenceId)).toEqual(f.reference);
      } finally {
        cold.sqlite.close();
      }
    } finally {
      releaseNative(f.gate);
      deliverReplies();
      await pending.result;
      f.unlock.lock();
    }
  });

  it.each([
    'owner-disabled',
    'membership-removed',
    'version',
    'revoked',
    'unbound',
    'account',
    'ordinary',
    'token-revoked',
  ] as const)('rechecks %s after FIFO without a grant or fabricated success', async (change) => {
    const f = await nativeLoginShareFixture(change === 'token-revoked');
    interceptLoginVault(f, 1);
    const pending = f.start(f.issue);
    try {
      await reached(f, pending);
      if (change === 'owner-disabled')
        f.db.sqlite.transaction(() => disableCanonicalUser(f.db, f.user.id))();
      else if (change === 'token-revoked')
        revokeOpenKitAccessTokenRecord(f.db, f.decidingToken!.tokenId);
      else if (change === 'membership-removed') {
        const { getWorkspaceMember, leaveWorkspace } = await import('../workspace-sharing.js');
        const member = getWorkspaceMember(f.db, f.workspaceId, f.user.id);
        expect(member).toMatchObject({ status: 'active', userId: f.user.id });
        if (!member)
          throw new Error('The admitted Login owner must have a destination membership.');
        // Use the canonical non-owner leave transition, including its required removal timestamp.
        const removed = f.db.sqlite.transaction(() =>
          leaveWorkspace({
            coreDb: f.db,
            workspaceId: f.workspaceId,
            memberUserId: f.user.id,
            expectedRevision: member.revision,
          })
        )();
        expect(removed).toMatchObject({
          kind: 'removed',
          member: { status: 'removed', revision: member.revision + 1 },
        });
      } else if (change === 'version')
        f.fixtureSql(
          'UPDATE vault_references SET current_version = current_version + 1 WHERE reference_id = ?'
        ).run(f.reference.referenceId);
      else if (change === 'revoked')
        f.fixtureSql("UPDATE vault_references SET status = 'revoked' WHERE reference_id = ?").run(
          f.reference.referenceId
        );
      else if (change === 'unbound')
        f.fixtureSql(
          "UPDATE vault_references SET status = 'unbound', current_version = 0 WHERE reference_id = ?"
        ).run(f.reference.referenceId);
      else if (change === 'account')
        f.fixtureSql('UPDATE vault_references SET login_account_id = ? WHERE reference_id = ?').run(
          'synthetic-native-account-successor',
          f.reference.referenceId
        );
      else
        f.fixtureSql(
          'UPDATE vault_references SET login_provider = NULL, login_account_id = NULL, login_quarantined = NULL WHERE reference_id = ?'
        ).run(f.reference.referenceId);
      const current = getVaultReference(f.db, f.reference.referenceId);
      f.db.sqlite.pragma('query_only = ON');
      releaseNative(f.gate);
      const outcome = await pending.result;
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw outcome.error;
      expect(outcome.value.status).toBeGreaterThanOrEqual(400);
      expect(getVaultReference(f.db, f.reference.referenceId)).toEqual(current);
      expect(f.db.sqlite.prepare('SELECT * FROM vault_grants').all()).toEqual([]);
      expect(
        f.db.sqlite
          .prepare(
            "SELECT * FROM audit_events WHERE action = 'vault.grant-issue' AND outcome = 'succeeded'"
          )
          .all()
      ).toEqual([]);
      expect(f.db.sqlite.prepare('SELECT * FROM vault_injection_receipts').all()).toEqual([]);
    } finally {
      releaseNative(f.gate);
      await pending.result;
      f.unlock.lock();
    }
  });
});

/** Acquisition publication repeats current initiating authority in the actual native writer. */
describe('User Login reference creation authority fences', () => {
  it.each(['disabled-owner', 'revoked-administrator'] as const)(
    'refuses %s after native admission and before reference creation',
    async (change) => {
      const f = await nativeLoginFixture();
      let actor: Actor = f.actor;
      let tokenId: string | undefined;
      if (change === 'revoked-administrator') {
        const { record } = createOpenKitAccessTokenRecord(f.db, {
          ownerUserId: f.actor.userId,
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: '2999-01-01T00:00:00.000Z',
        });
        tokenId = record.tokenId;
        actor = { kind: 'token', userId: f.actor.userId, tokenId, tokenScope: 'server-admin' };
      }
      const nextReferenceId = allocateEntityId('vault');
      const input = {
        ...createInput(),
        referenceId: nextReferenceId,
        ownerScope: 'user' as const,
        backendKind: f.login.backendKind,
        userId: actor.userId,
        secretKind: 'codex-auth-json',
        login: f.login.login!,
        publicMutation: { actor },
      };
      const beforeCommits = f.commits();
      const beforeSubmissions = f.submissions();
      arm(f, 1);
      const pending = f.start(() => createVaultReference(f.db, input));
      try {
        await reached(f, pending);
        if (change === 'disabled-owner')
          expect(
            f.db.sqlite.transaction(() => disableCanonicalUser(f.db, actor.userId))()
          ).not.toBeNull();
        else
          expect(revokeOpenKitAccessTokenRecord(f.db, tokenId!)).toMatchObject({
            status: 'revoked',
          });
        f.db.sqlite.pragma('query_only = ON');
        releaseNative(f.gate);
        const outcome = await pending.result;
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error('Current authority was lost before native publication.');
        expect(outcome.error).toBeInstanceOf(ControlStoreWorkerError);
        expect(outcome.error).toMatchObject({ commit: 'not-committed' });
        expect(getVaultReference(f.db, nextReferenceId)).toBeNull();
        expect(getVaultReference(f.db, f.login.referenceId)).toEqual(f.login);
        // The request rolls back its savepoint; the enclosing FULL batch still commits.
        expect(Atomics.load(f.gate, 4)).toBe(2);
        expect(f.commits()).toBe(beforeCommits + 1);
        expect(f.submissions() - beforeSubmissions).toBe(1);
      } finally {
        releaseNative(f.gate);
        deliverReplies();
        await pending.result;
      }
    }
  );

  it('refuses a privileged initiating actor creating a Login for a different User', async () => {
    const f = await nativeLoginFixture();
    const actor: Actor = { kind: 'local', userId: f.localUserId };
    const input = {
      ...createInput(),
      referenceId: allocateEntityId('vault'),
      ownerScope: 'user' as const,
      backendKind: f.login.backendKind,
      userId: actor.userId,
      secretKind: 'codex-auth-json',
      login: f.login.login!,
      publicMutation: { actor },
    };
    f.db.sqlite.pragma('query_only = ON');
    const control = await createVaultReference(f.db, input);
    expect(control).toMatchObject({
      ownerScope: 'user',
      userId: actor.userId,
      login: f.login.login,
    });
    const foreignReferenceId = allocateEntityId('vault');
    expect(f.actor.userId).not.toBe(actor.userId);
    const beforeCommits = f.commits();
    const beforeSubmissions = f.submissions();
    const pending = f.start(() =>
      createVaultReference(f.db, {
        ...input,
        referenceId: foreignReferenceId,
        userId: f.actor.userId,
      })
    );
    const outcome = await pending.result;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Acquisition changed the initiating User owner.');
    expect(outcome.error).toBeInstanceOf(ControlStoreWorkerError);
    expect(outcome.error).toMatchObject({ commit: 'not-committed' });
    expect(getVaultReference(f.db, foreignReferenceId)).toBeNull();
    expect(getVaultReference(f.db, control.referenceId)).toEqual(control);
    expect(getVaultReference(f.db, f.login.referenceId)).toEqual(f.login);
    // The request rolls back its savepoint; the enclosing FULL batch still commits.
    expect(Atomics.load(f.gate, 4)).toBe(2);
    expect(f.commits()).toBe(beforeCommits + 1);
    expect(f.submissions() - beforeSubmissions).toBe(1);
  });
});

describe('retained Login quota metadata codec boundary', () => {
  // The approved private projections extend retained metadata, not creation or quarantine authority.
  // These checks prove codec meaning only; they do not attest a native observation or a use grant.
  const login = {
    provider: 'codex',
    accountId: 'synthetic-codec-account',
    quarantined: false,
  };
  const observedAt = '2026-11-09T00:00:00.000Z';
  const observations = {
    state: 'available',
    windows: [
      {
        kind: 'primary',
        usedPercent: 2_147_483_647,
        durationMinutes: 525_600,
        resetsAt: observedAt,
      },
      { kind: 'secondary', usedPercent: 0, durationMinutes: null, resetsAt: null },
    ],
    source: 'native-read',
    observedAt,
    bindingId: 'b'.repeat(512),
    materialGeneration: Number.MAX_SAFE_INTEGER,
  };

  // Freeze F2: only retained JSON carries the format marker; SQL NULL still means unknown.
  it('reads retained v1 observations without changing their semantic or public shape', async () => {
    const f = await nativeLoginFixture();
    const row = f
      .fixtureSql('SELECT * FROM vault_references WHERE reference_id=?')
      .get(f.login.referenceId) as VaultReferenceRow;
    expect(row.login_observations_json).toBeNull();
    expect(isDeepStrictEqual(mapVaultReferenceRow(row), f.login)).toBe(true);
    expect(isDeepStrictEqual(getVaultReference(f.db, f.login.referenceId), f.login)).toBe(true);
    const retained = JSON.stringify({ ...observations, schemaVersion: 1 });
    // This owner-module input tests decoding only; it creates no native observation authority.
    const decoded = mapVaultReferenceRow({ ...row, login_observations_json: retained });
    expect(
      isDeepStrictEqual(decoded, { ...f.login, login: { ...f.login.login, observations } })
    ).toBe(true);
    expect(decoded.login?.observations).not.toHaveProperty('schemaVersion');
    expect(HarnessLoginObservationsSchema.safeParse(observations).success).toBe(true);
    expect(
      HarnessLoginObservationsSchema.safeParse({ ...observations, schemaVersion: 1 }).success
    ).toBe(false);
    expect(isDeepStrictEqual(getVaultReference(f.db, f.login.referenceId), f.login)).toBe(true);
    expect(
      f
        .fixtureSql('SELECT login_observations_json FROM vault_references WHERE reference_id=?')
        .get(f.login.referenceId)
    ).toEqual({ login_observations_json: null });
  });

  it.each(['missing', 'future', 'text', 'null', 'boolean', 'future-invalid-fields'] as const)(
    'refuses %s retained observation format before semantic decoding',
    async (marker) => {
      const f = await nativeLoginFixture();
      const row = f
        .fixtureSql('SELECT * FROM vault_references WHERE reference_id=?')
        .get(f.login.referenceId) as VaultReferenceRow;
      const retained: Record<string, unknown> = { ...observations };
      if (marker === 'future' || marker === 'future-invalid-fields') retained.schemaVersion = 2;
      else if (marker === 'text') retained.schemaVersion = '1';
      else if (marker === 'null') retained.schemaVersion = null;
      else if (marker === 'boolean') retained.schemaVersion = true;
      if (marker === 'future-invalid-fields') retained.state = 'unsupported-state';
      const text = JSON.stringify(retained);
      let failure: unknown;
      try {
        mapVaultReferenceRow({ ...row, login_observations_json: text });
      } catch (error) {
        failure = error;
      }
      expect(failure instanceof TypeError).toBe(true);
      expect(String(failure) === 'TypeError: Unsupported retained record format.').toBe(true);
      expect(String(failure).includes(login.accountId)).toBe(false);
      expect(isDeepStrictEqual(getVaultReference(f.db, f.login.referenceId), f.login)).toBe(true);
      expect(
        f
          .fixtureSql('SELECT login_observations_json FROM vault_references WHERE reference_id=?')
          .get(f.login.referenceId)
      ).toEqual({ login_observations_json: null });
    }
  );

  it('keeps a legacy Login without observations usable', () => {
    expect(HarnessLoginMetadataSchema.safeParse(login).success).toBe(true);
  });

  it.each(['unknown', 'available', 'exhausted'])(
    'admits the retained %s state with its exact bounded private fields',
    (state) => {
      // State comes from ordinaryUsageAllowed, independently of window percentages or reset hints.
      expect(
        HarnessLoginMetadataSchema.safeParse({
          ...login,
          observations: {
            ...observations,
            state,
            windows: state === 'unknown' ? [] : observations.windows,
          },
        }).success
      ).toBe(true);
    }
  );

  it('refuses quota fields outside the approved numeric, text and window bounds', () => {
    const primary = observations.windows[0];
    const invalid = [
      { ...observations, windows: [{ ...primary, usedPercent: -1 }] },
      { ...observations, windows: [{ ...primary, usedPercent: 2_147_483_648 }] },
      { ...observations, windows: [{ ...primary, usedPercent: 0.5 }] },
      { ...observations, windows: [{ ...primary, durationMinutes: 0 }] },
      { ...observations, windows: [{ ...primary, durationMinutes: 525_601 }] },
      { ...observations, windows: [{ ...primary, durationMinutes: 1.5 }] },
      { ...observations, windows: [{ ...primary, resetsAt: '2026-11-09T00:00:00Z' }] },
      { ...observations, observedAt: '2026-11-09T00:00:00Z' },
      { ...observations, bindingId: '' },
      { ...observations, bindingId: 'b'.repeat(513) },
      { ...observations, bindingId: 'binding\n' },
      { ...observations, bindingId: 'binding\r' },
      { ...observations, bindingId: 'binding\0' },
      { ...observations, materialGeneration: 0 },
      { ...observations, materialGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...observations, materialGeneration: 1.5 },
      { ...observations, windows: [...observations.windows, primary] },
      { ...observations, windows: [primary, primary] },
    ];
    for (const value of invalid) {
      expect(HarnessLoginMetadataSchema.safeParse({ ...login, observations: value }).success).toBe(
        false
      );
    }
  });

  it('refuses unknown meanings and secret or provider payload fields before stripping', () => {
    const invalid = [
      { ...observations, state: 'healthy' },
      { ...observations, source: 'notification' },
      { ...observations, windows: [{ ...observations.windows[0], kind: 'other' }] },
      { ...observations, accessToken: 'synthetic-not-material' },
      { ...observations, accountId: login.accountId },
      { ...observations, windows: [{ ...observations.windows[0], limitName: 'untrusted' }] },
      { ...observations, observedAt: undefined },
      { ...observations, bindingId: undefined },
      { ...observations, materialGeneration: undefined },
    ];
    for (const value of invalid) {
      expect(HarnessLoginMetadataSchema.safeParse({ ...login, observations: value }).success).toBe(
        false
      );
    }
  });

  it('does not let reference creation submit retained observations', async () => {
    const f = await nativeLoginFixture();
    const record = {
      referenceId: f.login.referenceId,
      ownerScope: f.login.ownerScope,
      userId: f.login.userId,
      workspaceId: f.login.workspaceId,
      displayName: f.login.displayName,
      secretKind: f.login.secretKind,
      backendKind: f.login.backendKind,
      backendLocator: f.login.backendLocator,
      login: f.login.login,
      publicMutation: { actor: f.actor },
    };
    expect(ControlVaultInputSchema.safeParse({ kind: 'reference-create', record }).success).toBe(
      true
    );
    expect(
      ControlVaultInputSchema.safeParse({
        kind: 'reference-create',
        record: { ...record, login: { ...f.login.login, observations } },
      }).success
    ).toBe(false);
    expect(
      ControlVaultInputSchema.safeParse({
        kind: 'reference-create',
        record: { ...record, observations },
      }).success
    ).toBe(false);
  });

  it('keeps quarantine authority separate from observations in its retained reference snapshot', async () => {
    const f = await nativeLoginFixture();
    const record = {
      referenceId: f.login.referenceId,
      quarantined: true,
      publicMutation: { actor: f.actor, reference: f.login },
    };
    expect(
      ControlVaultInputSchema.safeParse({ kind: 'reference-login-state', record }).success
    ).toBe(true);
    expect(
      ControlVaultInputSchema.safeParse({
        kind: 'reference-login-state',
        record: { ...record, observations },
      }).success
    ).toBe(false);
    expect(
      ControlVaultInputSchema.safeParse({
        kind: 'reference-login-state',
        record: {
          ...record,
          publicMutation: { ...record.publicMutation, observations },
        },
      }).success
    ).toBe(false);
    expect(
      ControlVaultInputSchema.safeParse({
        kind: 'reference-login-state',
        record: {
          ...record,
          publicMutation: {
            ...record.publicMutation,
            reference: { ...f.login, login: { ...f.login.login, observations } },
          },
        },
      }).success
    ).toBe(true);
  });
});

// A completion receipt cannot be created from a User Login plan without native binding proof.
// Owners: core/vault.md Injection Contract and Lifecycle And Failure Semantics;
// specs/20260703-vault_secret_injection.md Harness Subscription Logins.
describe('User Login native receipt proof', () => {
  it('refuses a canonical User Codex Login receipt without loginBinding at the native writer', async () => {
    const f = await nativeLoginShareFixture();
    try {
      const issued = await f.issue();
      expect(issued.status).toBe(200);
      expect(issued.body).toMatchObject({ disposition: 'approved-executed' });
      const grant = getVaultGrant(f.db, issued.body.grantId);
      expect(grant).not.toBeNull();
      if (!grant) throw new Error('Reviewed Login grant was not published.');
      expect(grant).toMatchObject({
        issuance: 'target',
        vaultReferenceId: f.reference.referenceId,
        ownerScope: 'workspace',
        workspaceId: f.workspaceId,
        allowedInjectionPaths: ['runtime-token'],
        approvalId: f.request.approvalRequestId,
      });
      // Read the family through the stored grant, not eligibility or a secret-kind heuristic.
      expect(getVaultReference(f.db, grant.vaultReferenceId)).toMatchObject({
        referenceId: f.reference.referenceId,
        ownerScope: 'user',
        userId: f.user.id,
        login: { provider: 'codex' },
      });

      // A real metadata Session supplies receipt actor linkage without claiming an
      // AEP, accepted runtime, physical Login completion or an installed handler.
      const { FsStore } = await import('../lib/store.js');
      const store = new FsStore({ dataRoot: f.db.dataRoot });
      const thread = await store.createThread(f.workspaceId, 'Unproven Login receipt');
      const timestamp = new Date().toISOString();
      const session = await store.createAgentSession({
        id: allocateEntityId('as'),
        workspaceId: f.workspaceId,
        threadId: thread.id,
        agentId: 'agent_codex_host',
        status: 'ready',
        message: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      expect(store.getAgentSession(session.id)).toEqual(session);
      expect(session.environmentPackageSnapshotId).toBeNull();
      expect(session.nativeHandleDigest).toBeNull();
      const plan = await createVaultInjectionPlan(f.db, {
        planId: 'plan_native_user_login_without_proof',
        grantId: grant.grantId,
        injectionVisibility: 'runtime-token',
        expirationBehavior: 'Deny expired use.',
        revocationBehavior: 'Close the affected binding.',
        redactionRule: 'Exclude material.',
        backendCapabilityRequirement: 'runtime-token',
      });
      expect(getVaultInjectionPlan(f.db, plan.planId)).toEqual(plan);
      expect(plan).toMatchObject({
        grantId: grant.grantId,
        injectionVisibility: 'runtime-token',
        status: 'active',
      });
      expect(listVaultInjectionReceipts(f.db)).toEqual([]);
      const attemptedReceipt = {
        receiptId: 'receipt_native_user_login_without_proof',
        planId: plan.planId,
        grantId: grant.grantId,
        agentSessionId: session.id,
        backendSummary: 'Attempted Login receipt without native binding proof.',
        injectedAt: timestamp,
        expiresAt: grant.expiresAt,
        revocationStatus: 'active' as const,
      };
      expect(
        ControlVaultInputSchema.safeParse({
          kind: 'receipt-create',
          record: attemptedReceipt,
        }).success
      ).toBe(true);

      const { Worker } = await import('node:worker_threads');
      const posted = vi.spyOn(Worker.prototype, 'postMessage');
      const beforeSubmissions = f.submissions();
      const beforeCommits = f.commits();
      const pending = f.start(() =>
        getControlStoreWorkerClient().vault(f.db, 'receipt-create', attemptedReceipt)
      );
      const outcome = await pending.result;
      const targetFrames = posted.mock.calls.filter(
        ([value]) =>
          isControlWorkerRequest(value) &&
          value.operation === 'vault' &&
          value.input.kind === 'receipt-create' &&
          value.input.record.receiptId === attemptedReceipt.receiptId
      );
      expect(targetFrames).toHaveLength(1);
      const target = targetFrames[0]![0];
      expect(isControlWorkerRequest(target)).toBe(true);
      if (
        !isControlWorkerRequest(target) ||
        target.operation !== 'vault' ||
        target.input.kind !== 'receipt-create'
      ) {
        throw new Error('The original receipt command was not posted to native.');
      }
      expect(target.database).toBe(
        `core:${nativeProductScope(f.db.dataRoot, { kind: 'server' }).path}`
      );
      expect(target.input.record).not.toHaveProperty('loginBinding');
      expect(target.input.record).toMatchObject(attemptedReceipt);
      expect(f.submissions() - beforeSubmissions).toBe(1);
      // A native savepoint refusal still settles under its covering FULL batch;
      // a parser, Main setup or missing actor-linkage failure does not qualify.
      expect(Atomics.load(f.gate, 4)).toBe(2);
      expect(f.commits()).toBe(beforeCommits + 1);
      // Keep the persisted-state observations visible under the parent's permissive
      // guard fault: actual accepted receipt publication must make this same test fail.
      expect.soft(getVaultInjectionReceipt(f.db, attemptedReceipt.receiptId)).toBeNull();
      expect.soft(listVaultInjectionReceipts(f.db)).toEqual([]);
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'precondition', commit: 'not-committed' },
      });
      if (outcome.ok)
        throw new Error('Native accepted a User Login receipt without binding proof.');
      expect(outcome.error).toBeInstanceOf(ControlStoreWorkerError);
    } finally {
      f.unlock.lock();
    }
  });
});
