// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireDataRootLock } from '../bootstrap/lock.js';
import { isScopeAdmitted, scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { restoreWorkspaceRecoveryAdmission } from '../bootstrap/workspace-recovery.js';
import { FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recoveryJournalFact, recoveryJournalFacts } from '../test-support/recovery-journal.js';
import {
  publishWorkspaceOwnerMembership,
  recordWorkspaceOwnerMembership,
} from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { commandInputHash } from './control-store-input.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { inventoryRegularFiles } from './data-root-backup.js';
import * as databases from './db.js';
import { coreDbPath, readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import { createWorkspaceBackup, WORKSPACE_BACKUP_POLICY } from './workspace-backup.js';
import {
  inspectWorkspaceRecovery,
  moveOutWorkspace,
  reactivateWorkspace,
} from './workspace-move.js';
import * as admissions from './workspace-recovery-journal.js';

const workspaceId = DEMO_WORKSPACE_ID;
const roots: string[] = [];

type Stage = 'revoke' | 'workspace' | 'report';
const interception = vi.hoisted(() => ({
  selected: undefined as
    | {
        database: string;
        path: string;
        backupId: string;
        workspaceId: string;
        stage: Stage;
        expectedRevision: number;
        expectedCoreRevision: number;
        proofHash: string;
        originalProof: string;
        originalAuditCount: number;
        boundary: 'before' | 'after';
        gate: SharedArrayBuffer;
      }
    | undefined,
  worker: undefined as NativeWorker | undefined,
  replied: false,
}));
const physical = vi.hoisted(() => ({
  retirePath: undefined as string | undefined,
  completed: 0,
  failure: undefined as Error | undefined,
}));

// A failure at the acknowledgement crossing follows the actual physical
// owner's completed unlink and parent-directory sync, never an invented receipt.
vi.mock('@openkit/storage', async (load) => {
  const actual = await load<typeof import('@openkit/storage')>();
  return {
    ...actual,
    async removeDurableFile(input: Parameters<typeof actual.removeDurableFile>[0]) {
      const result = await actual.removeDurableFile(input);
      if (input.destinationPath === physical.retirePath) {
        physical.completed++;
        throw physical.failure;
      }
      return result;
    },
  };
});

// The selected request runs the real native entry and SQLite body. Only the
// original COMMIT is held; no callback, replacement wire or success is supplied.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const selected = interception.selected;
        if (!selected) {
          super(filename, options);
          return;
        }
        const prelude = `
        const recoveryJournalFact = ${recoveryJournalFact.toString()};
          const { workerData } = require('node:worker_threads');
          const Database = require(workerData.databaseModule);
          const execute = Database.prototype.exec;
          const gate = new Int32Array(workerData.gate);
          Database.prototype.exec = function(sql) {
            const selected = /^COMMIT$/i.test(sql) && this.name === workerData.path &&
              Atomics.load(gate, 2) === 1 && Atomics.load(gate, 0) === 0;
            const observe = () => {
              let complete;
              if (workerData.stage === 'workspace') {
                const row = this.prepare('SELECT revision,record_json FROM control_workspaces WHERE id=?').get(workerData.workspaceId);
                const audit = this.prepare("SELECT count(*) AS count FROM audit_events WHERE action='workspace.reactivate' AND resource=? AND summary=?")
                  .get('workspace:' + workerData.workspaceId, 'Reactivated after retiring ' + workerData.backupId + '.');
                complete = row?.revision === workerData.expectedRevision + 1 &&
                  !JSON.parse(row.record_json).movedOut && audit.count === workerData.originalAuditCount + 1;
              } else {
                const row = recoveryJournalFact(this, workerData.backupId, require('node:path').resolve(this.name,'../../..'), require('node:fs').readFileSync, require('node:crypto').createHash);
                const original = JSON.parse(workerData.originalProof);
                const expected = workerData.stage === 'revoke' ? original : {
                  ...original, result: {...original.result,command:'reactivate',disposition:'reactivated',currentRevision:workerData.expectedRevision + 1,nextAction:'none'}
                };
                complete = row?.state === 'abandoned' &&
                  row.revision === workerData.expectedCoreRevision + (workerData.stage === 'revoke' ? 1 : 0) &&
                  row.proof_json === JSON.stringify(expected);
              }
              const transaction = this.inTransaction;
              const full = this.pragma('synchronous', { simple: true });
              if (!complete || full !== 2 || transaction !== (workerData.boundary === 'before'))
                throw new Error('The selected reactivation COMMIT did not contain its original whole stage.');
              Atomics.store(gate, 3, full);
              Atomics.store(gate, 4, transaction ? 1 : 0);
              Atomics.store(gate, 5, 1);
              // Readiness follows all tuple, durability and transaction checks.
              Atomics.store(gate, 0, 1);
              Atomics.wait(gate, 1, 0);
            };
            if (selected && workerData.boundary === 'before') observe();
            const result = execute.call(this, sql);
            if (selected && workerData.boundary === 'after') observe();
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
            ...options?.workerData,
            ...selected,
            databaseModule: require.resolve('better-sqlite3'),
          },
        });
        const post = this.postMessage.bind(this);
        this.postMessage = (message, ...args) => {
          if (
            message.operation === 'recovery-source-reactivation' &&
            message.database === selected.database &&
            message.input?.backupId === selected.backupId &&
            message.input?.workspaceId === selected.workspaceId &&
            message.input?.stage === selected.stage &&
            message.input?.expectedRevision === selected.expectedRevision &&
            message.input?.expectedCoreRevision === selected.expectedCoreRevision &&
            message.input?.proofHash === selected.proofHash
          ) {
            if (interception.worker) throw new Error('Duplicate selected reactivation post.');
            interception.worker = this;
            Atomics.store(new Int32Array(selected.gate), 2, 1);
            this.on('message', (reply) => {
              if (reply.id === message.id) interception.replied = true;
            });
          }
          return post(message, ...args);
        };
      }
    },
  };
});

afterEach(async () => {
  if (interception.selected) {
    const gate = new Int32Array(interception.selected.gate);
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
  }
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  interception.selected = undefined;
  interception.worker = undefined;
  interception.replied = false;
  physical.retirePath = undefined;
  physical.completed = 0;
  physical.failure = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Observes an existing owner without creating layout or changing the selected records. */
function rows(path: string, table: string): Record<string, unknown>[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** Uses the real capture and MOVE producers to establish a transferable stopped source. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stopped-reactivation-'));
  roots.push(root);
  const dataRoot = join(root, 'source');
  await createDemoStore({ dataRoot });
  const core = databases.openCoreDb(dataRoot);
  const userId = ensureLocalUser(core);
  recordWorkspaceOwnerMembership({ coreDb: core, workspaceId, ownerUserId: userId });
  core.sqlite.close();
  await shutdownControlStoreWorkerClient();
  const stagingParent = join(root, 'capture-staging');
  mkdirSync(stagingParent);
  const bundleRoot = join(root, 'bundle');
  const backupId = allocateEntityId('wsbak');
  const capture = await createWorkspaceBackup({
    ...WORKSPACE_BACKUP_POLICY,
    source: { kind: 'stopped-data-root', dataRoot },
    workspaceId,
    expectedSourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
    backupId,
    purpose: 'move',
    bundleRoot,
    stagingParent,
    admission: new FileStorageAdmission(root, () => 0n),
    expectedRelease: { version: 'stopped-reactivation-test', buildId: 'original-owner-fixture' },
  });
  expect(capture.disposition).toBe('prepared');
  const moved = await moveOutWorkspace({
    dataRoot,
    workspaceId,
    backupId,
    bundleRoot,
    expectedRevision: capture.manifest.capturedRevision,
    expectedRelease: capture.manifest.release,
  });
  expect(moved).toMatchObject({ command: 'move-out', disposition: 'moved-out' });
  expect(moved.currentRevision).toBe(capture.manifest.capturedRevision + 1);
  expect(existsSync(join(bundleRoot, 'seal.json'))).toBe(true);
  await shutdownControlStoreWorkerClient();
  return {
    root,
    dataRoot,
    backupId,
    bundleRoot,
    capture,
    input: {
      dataRoot,
      workspaceId,
      backupId,
      expectedRevision: moved.currentRevision!,
      acknowledgeTargetFenced: true as const,
      acknowledgeCopiesRetired: true as const,
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Copies all database sidecars before opening an observer, so observation cannot checkpoint the source. */
function snapshot(f: Fixture) {
  const copy = mkdtempSync(join(f.root, 'cold-observer-'));
  const corePath = coreDbPath(f.dataRoot);
  const workspacePath = workspaceDbPath(f.dataRoot, workspaceId);
  cpSync(dirname(corePath), join(copy, 'core'), { recursive: true });
  cpSync(dirname(workspacePath), join(copy, 'workspace'), { recursive: true });
  const observer = new Database(join(copy, 'core/core.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  const core = recoveryJournalFacts(observer, f.dataRoot);
  observer.close();
  const workspace = rows(join(copy, 'workspace', 'workspace.sqlite'), 'control_workspaces');
  const audit = rows(join(copy, 'workspace', 'workspace.sqlite'), 'audit_events');
  return {
    core,
    owned: core.find((row) => row.admission_id === f.backupId)!,
    workspace,
    audit,
    bundle: inventoryRegularFiles(f.bundleRoot),
  };
}
type Snapshot = ReturnType<typeof snapshot>;

/** Original stopped-reactivation prefixes: Core revoke, durable seal retirement, Workspace+Audit, report. */
function assertPrefix(
  f: Fixture,
  original: Snapshot,
  actual: Snapshot,
  prefix: 'initial' | 'revoked' | 'retired' | 'workspace' | 'report',
  revocations = prefix === 'initial' ? 0 : 1
) {
  const originalProof = JSON.parse(original.owned.proof_json as string);
  const active = prefix === 'workspace' || prefix === 'report';
  expect(actual.core.filter((row) => row.admission_id !== f.backupId)).toEqual(
    original.core.filter((row) => row.admission_id !== f.backupId)
  );
  expect(actual.owned).toEqual({
    ...original.owned,
    ...(revocations > 0
      ? {
          state: 'abandoned',
          revision: (original.owned.revision as number) + revocations,
          updated_at: expect.any(String),
        }
      : {}),
    proof_json: prefix === 'report' ? expect.any(String) : original.owned.proof_json,
  });
  expect(JSON.parse(actual.owned.proof_json as string)).toEqual(
    prefix === 'report'
      ? {
          ...originalProof,
          result: {
            ...originalProof.result,
            command: 'reactivate',
            disposition: 'reactivated',
            currentRevision: f.input.expectedRevision + 1,
            nextAction: 'none',
          },
        }
      : originalProof
  );
  expect(actual.workspace).toEqual(
    original.workspace.map((row) => {
      if (!active || row.id !== workspaceId) return row;
      const record = JSON.parse(row.record_json as string);
      expect(record.movedOut.backupId).toBe(f.backupId);
      delete record.movedOut;
      return {
        ...row,
        revision: (row.revision as number) + 1,
        record_json: JSON.stringify(record),
      };
    })
  );
  expect(
    actual.audit.filter((row) =>
      original.audit.some((old) => old.audit_event_id === row.audit_event_id)
    )
  ).toEqual(original.audit);
  const added = actual.audit.filter(
    (row) => !original.audit.some((old) => old.audit_event_id === row.audit_event_id)
  );
  expect(added).toHaveLength(active ? 1 : 0);
  if (active)
    expect(added[0]).toMatchObject({
      workspace_id: workspaceId,
      action: 'workspace.reactivate',
      resource: `workspace:${workspaceId}`,
      outcome: 'succeeded',
      summary: `Reactivated after retiring ${f.backupId}.`,
    });
  // The expected effect removes exactly seal.json. Every other retained bundle
  // path, byte length and digest is compared, including newly introduced paths.
  expect(actual.bundle).toEqual(
    prefix === 'initial' || prefix === 'revoked'
      ? original.bundle
      : original.bundle.filter((entry) => entry.path !== 'seal.json')
  );
}

/** Removes only the deliberate SQL fault; lifecycle data remains owned by the real producer. */
function faultTrigger(path: string, sql: string) {
  const db = new Database(path, { fileMustExist: true });
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  return () => {
    const writer = new Database(path, { fileMustExist: true });
    try {
      writer.exec('DROP TRIGGER reactivation_fault');
    } finally {
      writer.close();
    }
  };
}

/** Inspection is explicit; retries retain the original repeated revocation and exactly one Workspace Audit. */
async function inspectRetryReplay(
  f: Fixture,
  original: Snapshot,
  prefix: 'initial' | 'revoked' | 'retired' | 'workspace' | 'report'
) {
  const moved = prefix !== 'workspace' && prefix !== 'report';
  await expect(
    inspectWorkspaceRecovery({
      dataRoot: f.dataRoot,
      workspaceId,
      selection: { kind: 'capture', backupId: f.backupId },
    })
  ).resolves.toMatchObject({
    command: 'inspect',
    disposition: moved ? 'moved-out' : 'abandoned',
    currentRevision: f.input.expectedRevision + (moved ? 0 : 1),
    nextAction: 'none',
  });
  const report = await reactivateWorkspace(f.input);
  expect(report).toMatchObject({
    command: 'reactivate',
    disposition: 'reactivated',
    currentRevision: f.input.expectedRevision + 1,
    nextAction: 'none',
  });
  const revocations = prefix === 'initial' || !moved ? 1 : 2;
  const terminal = snapshot(f);
  assertPrefix(f, original, terminal, 'report', revocations);
  await expect(reactivateWorkspace(f.input)).resolves.toEqual(report);
  expect(snapshot(f)).toEqual(terminal);
  await expect(
    reactivateWorkspace({ ...f.input, expectedRevision: f.input.expectedRevision - 1 })
  ).rejects.toMatchObject({ code: 'request-conflict' });
  expect(snapshot(f)).toEqual(terminal);
}

describe('Stopped source reactivation ownership and durable prefixes', () => {
  it.each(['unsupported-current-marker', 'unreadable-proof'] as const)(
    'boot contains %s to its addressed Workspace while Core and a healthy sibling remain usable',
    async (fault) => {
      const f = await fixture();
      await expect(reactivateWorkspace(f.input)).resolves.toMatchObject({
        disposition: 'reactivated',
      });
      const store = new FsStore({ dataRoot: f.dataRoot });
      const healthy = await store.createWorkspace('Healthy recovery sibling');
      await shutdownControlStoreWorkerClient();
      const core = databases.openCoreDb(f.dataRoot);
      try {
        const ownerUserId = ensureLocalUser(core);
        // createDemoStore also seeds the real personal Workspace; boot requires its registration.
        const personalId = quickChatWorkspaceIdForUser(ownerUserId, f.dataRoot);
        expect(store.getWorkspace(personalId).id).toBe(personalId);
        for (const id of [personalId, healthy.id])
          recordWorkspaceOwnerMembership({ coreDb: core, workspaceId: id, ownerUserId });
        expect(
          core.sqlite
            .prepare('SELECT status FROM workspace_registry WHERE workspace_id=?')
            .pluck()
            .get(healthy.id)
        ).toBe('active');
        expect(admissions.readRecoveryExecution(core, f.backupId)).toMatchObject({
          workspace_id: workspaceId,
          state: 'abandoned',
          proof: { result: { disposition: 'reactivated' } },
        });
        const latest = core.sqlite
          .prepare(`SELECT s.* FROM control_execution_steps s
          WHERE json_extract(s.invocation_json,'$.carriage.requestId')=?
          ORDER BY json_extract(s.invocation_json,'$.carriage.sequence') DESC LIMIT 1`)
          .get(f.backupId) as { execution_id: string; step_id: string; control_json: string };
        const control = JSON.parse(latest.control_json);
        const descriptor = JSON.parse(control.inputRefs[0]);
        const proofPath = join(
          f.dataRoot,
          'server/evidence/backend',
          descriptor.reference.locator.path
        );
        const proofBytes = readFileSync(proofPath);
        if (fault === 'unsupported-current-marker') {
          core.sqlite.transaction(() => {
            const triggers = [
              'control_executions_identity_immutable',
              'control_execution_steps_settle_once',
            ].map((name) => {
              const row = core.sqlite
                .prepare('SELECT sql FROM sqlite_schema WHERE name=?')
                .get(name) as { sql: string };
              core.sqlite.exec(`DROP TRIGGER ${name}`);
              return row.sql;
            });
            try {
              core.sqlite
                .prepare('UPDATE control_executions SET definition_version=? WHERE id=?')
                .run('core-workspace-recovery/v99', latest.execution_id);
              core.sqlite
                .prepare(
                  'UPDATE control_execution_steps SET control_json=? WHERE execution_id=? AND step_id=?'
                )
                .run(
                  JSON.stringify({ ...control, definitionVersion: 'core-workspace-recovery/v99' }),
                  latest.execution_id,
                  latest.step_id
                );
            } finally {
              for (const sql of triggers) core.sqlite.exec(sql);
            }
          })();
          expect(readFileSync(proofPath)).toEqual(proofBytes);
        } else {
          // Remove only the original current Core body; keep every journal binding intact.
          rmSync(proofPath);
          expect(existsSync(proofPath)).toBe(false);
        }
        expect(
          core.sqlite
            .prepare(`SELECT name FROM sqlite_schema WHERE type='trigger' AND name IN (?,?)`)
            .all('control_executions_identity_immutable', 'control_execution_steps_settle_once')
        ).toHaveLength(2);
        expect(() => admissions.readRecoveryExecution(core, f.backupId)).toThrowError();
        expect(isScopeAdmitted(f.dataRoot, 'workspace', healthy.id)).toBe(true);
        // Repeated census must neither reopen the opaque scope nor infer a recovery origin.
        for (let pass = 0; pass < 2; pass++) {
          expect(() => restoreWorkspaceRecoveryAdmission(core)).not.toThrow();
          expect(scopeAdmissionFailures(f.dataRoot)).toEqual([
            { scope: 'workspace', id: workspaceId, check: 'recovery' },
          ]);
          expect(isScopeAdmitted(f.dataRoot, 'workspace', workspaceId)).toBe(false);
          expect(
            getControlStoreWorkerClient().enterWorkspaceMutation(f.dataRoot, workspaceId)
          ).toBeNull();
          expect(
            getControlStoreWorkerClient().tryResumeWorkspaceRecovery(
              f.dataRoot,
              workspaceId,
              { captureId: f.backupId },
              () => []
            )
          ).toEqual({
            status: 'busy',
          });
          expect(isScopeAdmitted(f.dataRoot, 'workspace', healthy.id)).toBe(true);
          const release = getControlStoreWorkerClient().enterWorkspaceMutation(
            f.dataRoot,
            healthy.id
          );
          expect(release).toBeTypeOf('function');
          release?.();
        }
        await expect(store.createThread(workspaceId, 'Must stay refused')).rejects.toThrow();
        await expect(
          store.createThread(healthy.id, 'Healthy native publication')
        ).resolves.toMatchObject({ owner: { kind: 'workspace', workspaceId: healthy.id } });
        const additional = await store.createWorkspace('Core registry still writable');
        await publishWorkspaceOwnerMembership({
          coreDb: core,
          workspaceId: additional.id,
          ownerUserId,
        });
        expect(
          core.sqlite
            .prepare('SELECT status FROM workspace_registry WHERE workspace_id=?')
            .pluck()
            .get(additional.id)
        ).toBe('active');
        expect(() => admissions.readRecoveryExecution(core, f.backupId)).toThrowError();
      } finally {
        core.sqlite.close();
      }
    },
    120_000
  );

  it('refuses an unsupported latest recovery definition instead of replaying an older closed root', async () => {
    const f = await fixture();
    const original = rows(coreDbPath(f.dataRoot), 'control_executions');
    expect(original.every((root) => root.phase === 'closed')).toBe(true);
    await expect(reactivateWorkspace(f.input)).resolves.toMatchObject({
      disposition: 'reactivated',
    });
    await shutdownControlStoreWorkerClient();
    const core = databases.openCoreDb(f.dataRoot);
    try {
      const current = admissions.readRecoveryExecution(core, f.backupId)!;
      expect(current).toMatchObject({
        state: 'abandoned',
        proof: { result: { disposition: 'reactivated' } },
      });
      const latest = core.sqlite
        .prepare(`SELECT s.* FROM control_execution_steps s
        WHERE json_extract(s.invocation_json,'$.carriage.requestId')=?
        ORDER BY json_extract(s.invocation_json,'$.carriage.sequence') DESC LIMIT 1`)
        .get(f.backupId) as { execution_id: string; step_id: string; control_json: string };
      expect(original.some((root) => root.id === latest.execution_id)).toBe(false);
      const root = core.sqlite
        .prepare('SELECT * FROM control_executions WHERE id=?')
        .get(latest.execution_id) as Record<string, unknown>;
      expect(root.phase).toBe('closed');
      const control = JSON.parse(latest.control_json);
      const descriptor = JSON.parse(control.inputRefs[0]);
      const proofPath = join(
        f.dataRoot,
        'server/evidence/backend',
        descriptor.reference.locator.path
      );
      const proofBytes = readFileSync(proofPath);
      // Only the latest current marker changes. This is retained corruption,
      // not an upgrade corpus or a caller-produced recovery admission.
      core.sqlite.transaction(() => {
        const triggers = [
          'control_executions_identity_immutable',
          'control_execution_steps_settle_once',
        ].map((name) => {
          const row = core.sqlite
            .prepare('SELECT sql FROM sqlite_schema WHERE name=?')
            .get(name) as { sql: string };
          core.sqlite.exec(`DROP TRIGGER ${name}`);
          return row.sql;
        });
        try {
          core.sqlite
            .prepare('UPDATE control_executions SET definition_version=? WHERE id=?')
            .run('core-workspace-recovery/v99', latest.execution_id);
          core.sqlite
            .prepare(
              'UPDATE control_execution_steps SET control_json=? WHERE execution_id=? AND step_id=?'
            )
            .run(
              JSON.stringify({ ...control, definitionVersion: 'core-workspace-recovery/v99' }),
              latest.execution_id,
              latest.step_id
            );
        } finally {
          for (const sql of triggers) core.sqlite.exec(sql);
        }
      })();
      const changedRoot = core.sqlite
        .prepare('SELECT * FROM control_executions WHERE id=?')
        .get(latest.execution_id);
      const changedStep = core.sqlite
        .prepare('SELECT * FROM control_execution_steps WHERE execution_id=? AND step_id=?')
        .get(latest.execution_id, latest.step_id);
      expect(changedRoot).toEqual({ ...root, definition_version: 'core-workspace-recovery/v99' });
      expect(changedStep).toEqual({
        ...latest,
        control_json: JSON.stringify({
          ...control,
          definitionVersion: 'core-workspace-recovery/v99',
        }),
      });
      expect(readFileSync(proofPath)).toEqual(proofBytes);
      expect(
        core.sqlite
          .prepare(`SELECT name FROM sqlite_schema WHERE type='trigger' AND name IN (?,?)`)
          .all('control_executions_identity_immutable', 'control_execution_steps_settle_once')
      ).toHaveLength(2);
      expect(() => admissions.readRecoveryExecution(core, f.backupId)).toThrowError(
        expect.objectContaining({ code: 'recovery-required' })
      );
    } finally {
      core.sqlite.close();
    }
  }, 120_000);

  it('reactivates the real moved-out source while every Main Core and Workspace connection is query-only', async () => {
    const f = await fixture();
    const corePath = coreDbPath(f.dataRoot);
    const workspacePath = workspaceDbPath(f.dataRoot, workspaceId);
    const beforeCore = (() => {
      const db = new Database(corePath, { readonly: true, fileMustExist: true });
      try {
        return recoveryJournalFacts(db, f.dataRoot);
      } finally {
        db.close();
      }
    })();
    const beforeWorkspace = rows(workspacePath, 'control_workspaces');
    const beforeAudit = rows(workspacePath, 'audit_events');
    const ownedBefore = beforeCore.find((row) => row.admission_id === f.backupId)!;
    expect(ownedBefore.state).toBe('finished');
    const proofBefore = JSON.parse(ownedBefore.proof_json as string);
    const sealBefore = readFileSync(join(f.bundleRoot, 'seal.json'));
    expect(sealBefore.length).toBeGreaterThan(0);

    const observed = new Set<string>();
    const mainWriteFailures: Array<{ code: string; sql: string }> = [];
    const queryOnly = (db: Database.Database) => {
      if (db.name !== corePath && db.name !== workspacePath) return;
      db.pragma('query_only = ON');
      expect(db.pragma('query_only', { simple: true })).toBe(1);
      observed.add(db.name);
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
        const statement = prepare(sql);
        if (/^INSERT INTO control_executions/i.test(sql)) {
          const run = statement.run.bind(statement);
          vi.spyOn(statement, 'run').mockImplementation((...parameters: unknown[]) => {
            try {
              return run(...parameters);
            } catch (error) {
              mainWriteFailures.push({ code: (error as { code: string }).code, sql });
              throw error;
            }
          });
        }
        return statement;
      }) as typeof db.prepare);
    };
    const openCore = databases.openExistingCoreDbWithIntegrityCheck;
    vi.spyOn(databases, 'openExistingCoreDbWithIntegrityCheck').mockImplementation((dataRoot) => {
      const result = openCore(dataRoot);
      queryOnly(result.sqlite);
      return result;
    });
    const openRecovery = admissions.openRecoveryDatabase;
    vi.spyOn(admissions, 'openRecoveryDatabase').mockImplementation((path) => {
      const result = openRecovery(path);
      queryOnly(result);
      return result;
    });
    const openWorkspace = databases.openWorkspaceReadDb;
    vi.spyOn(databases, 'openWorkspaceReadDb').mockImplementation((dataRoot, id) => {
      const result = openWorkspace(dataRoot, id);
      queryOnly(result.sqlite);
      return result;
    });

    const outcome = await reactivateWorkspace(f.input).then(
      (report) => ({ report }),
      (error: unknown) => ({ error })
    );
    expect([...observed].sort()).toEqual([corePath, workspacePath].sort());
    expect(mainWriteFailures).toEqual([]);
    expect(outcome).toMatchObject({
      report: {
        command: 'reactivate',
        disposition: 'reactivated',
        workspaceId,
        currentRevision: f.input.expectedRevision + 1,
        nextAction: 'none',
      },
    });
    const afterCore = (() => {
      const db = new Database(corePath, { readonly: true, fileMustExist: true });
      try {
        return recoveryJournalFacts(db, f.dataRoot);
      } finally {
        db.close();
      }
    })();
    const ownedAfter = afterCore.find((row) => row.admission_id === f.backupId)!;
    expect(afterCore.filter((row) => row.admission_id !== f.backupId)).toEqual(
      beforeCore.filter((row) => row.admission_id !== f.backupId)
    );
    expect(ownedAfter).toEqual({
      ...ownedBefore,
      state: 'abandoned',
      revision: (ownedBefore.revision as number) + 1,
      updated_at: expect.any(String),
      proof_json: expect.any(String),
    });
    expect(JSON.parse(ownedAfter.proof_json as string)).toEqual({
      ...proofBefore,
      result: {
        ...proofBefore.result,
        command: 'reactivate',
        disposition: 'reactivated',
        currentRevision: f.input.expectedRevision + 1,
        nextAction: 'none',
      },
    });
    const beforeRow = beforeWorkspace.find((row) => row.id === workspaceId)!;
    const record = JSON.parse(beforeRow.record_json as string);
    expect(record.movedOut.backupId).toBe(f.backupId);
    delete record.movedOut;
    expect(rows(workspacePath, 'control_workspaces')).toEqual(
      beforeWorkspace.map((row) =>
        row.id === workspaceId
          ? { ...row, revision: (row.revision as number) + 1, record_json: JSON.stringify(record) }
          : row
      )
    );
    const afterAudit = rows(workspacePath, 'audit_events');
    expect(
      afterAudit.filter((row) =>
        beforeAudit.some((old) => old.audit_event_id === row.audit_event_id)
      )
    ).toEqual(beforeAudit);
    const added = afterAudit.filter(
      (row) => !beforeAudit.some((old) => old.audit_event_id === row.audit_event_id)
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      action: 'workspace.reactivate',
      resource: `workspace:${workspaceId}`,
      outcome: 'succeeded',
      summary: `Reactivated after retiring ${f.backupId}.`,
    });
    expect(existsSync(join(f.bundleRoot, 'seal.json'))).toBe(false);
  }, 120_000);

  it('preserves relative-root reactivation and commits the original Workspace revision and Audit with Main Workspace handles query-only', async () => {
    const f = await fixture();
    const original = snapshot(f);
    const observed = new Set<string>();
    const select = (db: Database.Database) => {
      if (resolve(db.name) !== workspaceDbPath(f.dataRoot, workspaceId)) return;
      db.pragma('query_only = ON');
      expect(db.pragma('query_only', { simple: true })).toBe(1);
      observed.add(resolve(db.name));
    };
    const openRecovery = admissions.openRecoveryDatabase;
    vi.spyOn(admissions, 'openRecoveryDatabase').mockImplementation((path) => {
      const db = openRecovery(path);
      select(db);
      return db;
    });
    const openWorkspace = databases.openWorkspaceReadDb;
    vi.spyOn(databases, 'openWorkspaceReadDb').mockImplementation((dataRoot, id) => {
      const db = openWorkspace(dataRoot, id);
      select(db.sqlite);
      return db;
    });
    const relativeRoot = relative(process.cwd(), f.dataRoot);
    expect(resolve(relativeRoot)).toBe(f.dataRoot);
    await expect(
      reactivateWorkspace({ ...f.input, dataRoot: relativeRoot })
    ).resolves.toMatchObject({
      command: 'reactivate',
      disposition: 'reactivated',
      currentRevision: f.input.expectedRevision + 1,
      nextAction: 'none',
    });
    expect([...observed]).toEqual([workspaceDbPath(f.dataRoot, workspaceId)]);
    assertPrefix(f, original, snapshot(f), 'report');
  }, 120_000);

  it.each(['revoke', 'workspace', 'report'] as const)(
    'rolls back the whole original %s SQL stage on a late native SQL fault and retains only preceding durable prefixes',
    async (stage) => {
      const f = await fixture();
      const original = snapshot(f);
      const remove =
        stage === 'workspace'
          ? faultTrigger(
              workspaceDbPath(f.dataRoot, workspaceId),
              `
          CREATE TRIGGER reactivation_fault AFTER INSERT ON audit_events
          WHEN NEW.action='workspace.reactivate'
          BEGIN SELECT RAISE(ABORT,'deliberate late Workspace Audit fault'); END`
            )
          : faultTrigger(
              coreDbPath(f.dataRoot),
              stage === 'revoke'
                ? `
          CREATE TRIGGER reactivation_fault AFTER UPDATE OF phase ON control_executions
          WHEN NEW.definition_version='core-workspace-recovery/v1' AND OLD.phase='open' AND NEW.phase='closed' AND NEW.terminal_cause LIKE 'abandoned:%' AND EXISTS (SELECT 1 FROM control_execution_steps WHERE execution_id=NEW.id AND json_extract(invocation_json,'$.carriage.requestId')='${f.backupId}')
          BEGIN SELECT RAISE(ABORT,'deliberate late Core revocation fault'); END`
                : `
          CREATE TRIGGER reactivation_fault AFTER INSERT ON control_execution_steps
          WHEN json_extract(NEW.control_json,'$.definitionVersion')='core-workspace-recovery/v1' AND json_extract(NEW.invocation_json,'$.carriage.requestId')='${f.backupId}' AND json_extract(NEW.invocation_json,'$.carriage.sequence')=(SELECT MAX(json_extract(invocation_json,'$.carriage.sequence'))+1 FROM control_execution_steps WHERE execution_id<>NEW.execution_id AND json_extract(invocation_json,'$.carriage.requestId')='${f.backupId}') AND (SELECT terminal_cause FROM control_executions WHERE id=NEW.inspected_execution_id) LIKE 'abandoned:%'
          BEGIN SELECT RAISE(ABORT,'deliberate late Core result fault'); END`
            );
      const client = getControlStoreWorkerClient();
      const actual = client.recoverySourceReactivation.bind(client);
      let selectedFailure: unknown;
      let selectedCalls = 0;
      const publication = vi
        .spyOn(client, 'recoverySourceReactivation')
        .mockImplementation(async (...args) => {
          if (args[1].stage === stage) selectedCalls++;
          try {
            return await actual(...args);
          } catch (error) {
            if (args[1].stage === stage) selectedFailure = error;
            throw error;
          }
        });
      try {
        await expect(reactivateWorkspace(f.input)).rejects.toMatchObject({
          code: 'recovery-required',
        });
        expect(selectedCalls).toBe(1);
        expect(selectedFailure).toMatchObject({ code: 'constraint', commit: 'not-committed' });
        const prefix =
          stage === 'revoke' ? 'initial' : stage === 'workspace' ? 'retired' : 'workspace';
        assertPrefix(f, original, snapshot(f), prefix);
        remove();
        publication.mockRestore();
        await inspectRetryReplay(f, original, prefix);
      } finally {
        publication.mockRestore();
        // Removal is deliberately idempotent only for fixture cleanup, never for a lifecycle retry.
        const path =
          stage === 'workspace' ? workspaceDbPath(f.dataRoot, workspaceId) : coreDbPath(f.dataRoot);
        const db = new Database(path, { fileMustExist: true });
        try {
          db.exec('DROP TRIGGER IF EXISTS reactivation_fault');
        } finally {
          db.close();
        }
      }
    },
    120_000
  );

  it('retains revocation and the real durable seal retirement when its acknowledgement crossing fails before Workspace SQL', async () => {
    const f = await fixture();
    const original = snapshot(f);
    physical.retirePath = join(f.bundleRoot, 'seal.json');
    physical.failure = new Error(
      'Deliberate failure after the actual seal unlink and directory sync.'
    );
    try {
      await expect(reactivateWorkspace(f.input)).rejects.toMatchObject({
        code: 'recovery-required',
      });
      expect(physical.completed).toBe(1);
      assertPrefix(f, original, snapshot(f), 'retired');
    } finally {
      physical.retirePath = undefined;
    }
    await inspectRetryReplay(f, original, 'retired');
  }, 120_000);

  it.each([
    ['revoke', 'before'],
    ['workspace', 'before'],
    ['report', 'before'],
    ['revoke', 'after'],
    ['workspace', 'after'],
    ['report', 'after'],
  ] as const)(
    'preserves the exact %s prefix when the actual native host terminates %s its original COMMIT without replying',
    async (stage, boundary) => {
      const f = await fixture();
      const original = snapshot(f);
      const gate = new Int32Array(new SharedArrayBuffer(24));
      const path =
        stage === 'workspace' ? workspaceDbPath(f.dataRoot, workspaceId) : coreDbPath(f.dataRoot);
      interception.selected = {
        database: `${stage === 'workspace' ? 'workspace' : 'core'}:${path}`,
        path,
        backupId: f.backupId,
        workspaceId,
        stage,
        expectedRevision: f.input.expectedRevision,
        expectedCoreRevision: (original.owned.revision as number) + (stage === 'revoke' ? 0 : 1),
        proofHash: commandInputHash(JSON.parse(original.owned.proof_json as string)),
        originalProof: original.owned.proof_json as string,
        originalAuditCount: original.audit.filter(
          (row) =>
            row.action === 'workspace.reactivate' &&
            row.resource === `workspace:${workspaceId}` &&
            row.summary === `Reactivated after retiring ${f.backupId}.`
        ).length,
        boundary,
        gate: gate.buffer as SharedArrayBuffer,
      };
      const client = getControlStoreWorkerClient();
      const actual = client.recoverySourceReactivation.bind(client);
      let nativeFailure: unknown;
      let selectedCalls = 0;
      const publication = vi
        .spyOn(client, 'recoverySourceReactivation')
        .mockImplementation(async (...args) => {
          if (args[1].stage === stage) selectedCalls++;
          try {
            return await actual(...args);
          } catch (error) {
            if (args[1].stage === stage) nativeFailure = error;
            throw error;
          }
        });
      let settled = false;
      const command = reactivateWorkspace(f.input).then(
        (report) => {
          settled = true;
          return { report };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        }
      );
      try {
        while (Atomics.load(gate, 0) === 0 && !settled) await nextTurn();
        expect(Atomics.load(gate, 0), 'The actual selected native COMMIT was not observed.').toBe(
          1
        );
        expect(selectedCalls).toBe(1);
        expect(Atomics.load(gate, 3)).toBe(2);
        expect(Atomics.load(gate, 4)).toBe(boundary === 'before' ? 1 : 0);
        expect(Atomics.load(gate, 5)).toBe(1);
        expect(settled).toBe(false);
        expect(interception.replied).toBe(false);
        expect(() => acquireDataRootLock(f.dataRoot, { bootId: randomUUID() })).toThrow();
        const prefix =
          stage === 'revoke'
            ? boundary === 'before'
              ? 'initial'
              : 'revoked'
            : stage === 'workspace'
              ? boundary === 'before'
                ? 'retired'
                : 'workspace'
              : boundary === 'before'
                ? 'workspace'
                : 'report';
        assertPrefix(f, original, snapshot(f), prefix);
        expect(interception.worker).toBeDefined();
        // Never post to the synchronously held Worker. Real termination ends
        // the request, and production cleanup must join before releasing root.
        await interception.worker!.terminate();
        expect(await command).toHaveProperty('error');
        expect(nativeFailure).toMatchObject({ code: 'unavailable', commit: 'unknown' });
        expect(interception.replied).toBe(false);
        assertPrefix(f, original, snapshot(f), prefix);
        const lock = acquireDataRootLock(f.dataRoot, { bootId: randomUUID() });
        lock.release();
        interception.selected = undefined;
        await shutdownControlStoreWorkerClient();
        publication.mockRestore();
        await inspectRetryReplay(f, original, prefix);
      } finally {
        Atomics.store(gate, 1, 1);
        Atomics.notify(gate, 1);
        await command;
        publication.mockRestore();
      }
    },
    120_000
  );
});
