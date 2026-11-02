import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { policyDigest } from '../policy/statements.js';
import { readVaultRequesterAuthority } from '../runtime/worker-credential-authority.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import {
  advanceActiveVaultReferenceVersion,
  createVaultReference,
  createVaultReferenceWithInsertEvidence,
  getVaultReference,
  rebindWorkspaceVaultReference,
} from '../vault/vault-references.js';
import { createVaultInjectionPlan, getVaultInjectionPlan } from '../vault-injection-plans.js';
import {
  createVaultInjectionReceipt,
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
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { importUnboundWorkspaceVaultReference } from './test-support/vault-retained-fixtures.js';
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
  it.each([
    'unchanged',
    'requester-disabled',
    'competing-receipt',
  ] as const)('decides the original requester and unique active receipt after FIFO predecessors (%s)', async (change) => {
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
      expect(listVaultInjectionReceipts(f.db)).toHaveLength(change === 'competing-receipt' ? 2 : 1);
      expect(
        listVaultInjectionReceipts(f.db).every((row) => row.revocationStatus === 'active')
      ).toBe(true);
      expect(
        listVaultInjectionReceipts(f.db).find((row) => row.receiptId === receipt.receiptId)
      ).toEqual(receipt);
    }
  });
});

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
] as const)('refuses public Workspace grant %s after %s withdrawal before native BEGIN', async (action, withdrawal) => {
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
  recordWorkspaceOwnerMembership({ coreDb: f.db, workspaceId: workspace.id, ownerUserId: userId });
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
});
