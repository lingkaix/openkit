import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { expect, it, onTestFinished, vi } from 'vitest';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import {
  CatalogConflictError,
  CatalogForbiddenError,
  CatalogIntegrityError,
  CatalogRetentionError,
  type CatalogTreeFile,
  catalogDocumentPath,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  readWorkspaceSkillSnapshot,
  selectWorkspaceSkillDefault,
} from '../catalog/resource-catalog.js';
import { createSkillManagementCommands } from '../catalog/skill-management-commands.js';
import { recordWorkspaceEvidenceBundle } from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import type { InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

// Real command/SQL/file owners surround only acquisition and refresh callbacks.
const faults = vi.hoisted(() => ({
  readonlyMain: false,
  sqliteFault: false,
  workers: [] as NativeWorker[],
  posts: [] as unknown[],
  gate: new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT),
  request: new SharedArrayBuffer(36),
}));

vi.mock('./db.js', async (load) => {
  const actual = await load<typeof import('./db.js')>();
  const observe = <
    T extends
      | ReturnType<typeof actual.openCoreDb>
      | ReturnType<typeof actual.openUserDb>
      | ReturnType<typeof actual.openWorkspaceDb>,
  >(
    db: T
  ): T => {
    if (faults.readonlyMain) db.sqlite.pragma('query_only = ON');
    const prepare = db.sqlite.prepare.bind(db.sqlite);
    db.sqlite.prepare = ((sql: string) => {
      const statement = prepare(sql);
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        try {
          return run(...args);
        } catch (error) {
          const actualError = error as { code?: string; message?: string };
          if (
            actualError.code?.startsWith('SQLITE_CONSTRAINT') &&
            actualError.message === 'Skill command fault'
          )
            faults.sqliteFault = true;
          if (actualError.code?.startsWith('SQLITE_READONLY'))
            console.info('Original Main Skill command SQLite refused', {
              scope: db.scope,
              sqlOperation: /^\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase(),
              code: actualError.code,
            });
          throw error;
        }
      };
      return statement;
    }) as typeof db.sqlite.prepare;
    return db;
  };
  return {
    ...actual,
    openCoreDb: (...args: Parameters<typeof actual.openCoreDb>) =>
      observe(actual.openCoreDb(...args)),
    openUserDb: (...args: Parameters<typeof actual.openUserDb>) =>
      observe(actual.openUserDb(...args)),
    openWorkspaceDb: (...args: Parameters<typeof actual.openWorkspaceDb>) =>
      observe(actual.openWorkspaceDb(...args)),
  };
});

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const index = faults.workers.length;
        const prelude = `
        const { workerData } = require('node:worker_threads');
        const Database = require(workerData.receiptModule);
        const prepare = Database.prototype.prepare;
        const exec = Database.prototype.exec;
        const maintenance = new WeakSet();
        const gate = workerData.receiptGate;
        const requestId = () => Buffer.from(workerData.receiptRequest).toString('ascii');
        const retained = (db) => prepare.call(db, "SELECT 1 FROM idempotency_requests WHERE request_id=? AND command_name LIKE 'catalog.skill-%'").get(requestId());
        const actions = (db) => prepare.call(db, 'SELECT action FROM audit_events WHERE request_id=? ORDER BY rowid').all(requestId()).map(row => row.action);
        Database.prototype.prepare = function(sql) {
          const statement = prepare.call(this, sql);
          const deletion = /^DELETE\\s+FROM\\s+idempotency_requests/i.test(sql.trim());
          if (deletion || /^INSERT.*INTO\\s+(?:idempotency_requests|audit_events)/i.test(sql.trim())) {
            const db = this;
            const run = statement.run;
            statement.run = function(...args) {
              try {
                const value = run.apply(this, args);
                if (deletion && retained(db)) maintenance.add(db);
                return value;
              } catch (error) {
                if (error.code?.startsWith('SQLITE_CONSTRAINT') && error.message === 'Skill command fault') Atomics.store(gate, 3, 1);
                throw error;
              }
            };
          }
          return statement;
        };
        Database.prototype.exec = function(sql) {
          const value = exec.call(this, sql);
          if (!/^COMMIT$/i.test(sql) || !Atomics.load(gate, 1)) return value;
          if (!prepare.call(this, "SELECT 1 FROM sqlite_master WHERE name='audit_events'").get()) return value;
          const stage = Atomics.load(gate, 1);
          const admitted = actions(this).some(action => action.endsWith('.admit'));
          const completed = actions(this).some(action => !action.endsWith('.admit'));
          const recorded = retained(this);
          if (((stage === 1 && admitted && !completed && !recorded) || (stage === 2 && completed && !recorded) || (stage === 3 && recorded && !maintenance.has(this)) || (stage === 4 && recorded && maintenance.has(this))) && Atomics.compareExchange(gate, 0, 0, 1) === 0) {
            Atomics.store(gate, 4, this.pragma('synchronous', {simple:true}));
            Atomics.store(gate, 5, workerData.receiptWorker);
            Atomics.wait(gate, 2, 0);
          }
          return value;
        };
      `;
        super(
          prelude +
            (options?.eval ? String(filename) : `import(${JSON.stringify(String(filename))});`),
          {
            ...options,
            eval: true,
            workerData: {
              ...options?.workerData,
              receiptModule: require.resolve('better-sqlite3'),
              receiptGate: new Int32Array(faults.gate),
              receiptRequest: new Uint8Array(faults.request),
              receiptWorker: index,
            },
          }
        );
        faults.workers.push(this);
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        faults.posts.push(args[0]);
        return super.postMessage(...args);
      }
    },
  };
});

type Kind = 'import' | 'select' | 'pin' | 'remove' | 'purge';
const kinds = ['import', 'select', 'pin', 'remove', 'purge'] as const;
const release = () => {
  const gate = new Int32Array(faults.gate);
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
};
const observed = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );
const tree = (body: string): CatalogTreeFile[] => [
  {
    kind: 'file',
    path: 'SKILL.md',
    contentBase64: Buffer.from(
      `---\nname: Example Skill\ndescription: Preserve exact command effects.\n---\n${body}\n`
    ).toString('base64'),
  },
  {
    kind: 'file',
    path: 'assets/exact.bin',
    contentBase64: Buffer.from([0, 255, 17, 42]).toString('base64'),
  },
];
/** Uses real canonical authority, two owner-produced Skill versions and one genuine pin receipt. */
async function fixture(kind: Kind) {
  release();
  new Int32Array(faults.gate).fill(0);
  faults.readonlyMain = false;
  faults.sqliteFault = false;
  const dataRoot = mkdtempSync(join(tmpdir(), 'skill-catalog-native-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Skill command owner');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const userDb = openUserDb(dataRoot, userId);
  applyScopedMigrations(userDb);
  onTestFinished(async () => {
    release();
    faults.readonlyMain = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
    await shutdownControlStoreWorkerClient();
    for (const db of [workspaceDb, userDb, coreDb]) if (db.sqlite.open) db.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const base = {
    dataRoot,
    workspaceId: workspace.id,
    id: 'example',
    displayName: 'Example Skill',
    producer: { kind: 'user' as const, id: userId },
    createdAt: new Date().toISOString(),
  };
  const first = importWorkspaceSkill({
    ...base,
    expectedRevision: 0,
    activate: true,
    tree: tree('Original A'),
  });
  const second = importWorkspaceSkill({
    ...base,
    expectedRevision: 1,
    activate: false,
    tree: tree('Retained B'),
  });
  const context: AdmittedOperationContext = {
    kind: 'public',
    actor: { kind: 'local', userId },
    actorRef: { kind: 'user', id: userId },
    scope: { kind: 'workspace', workspaceId: workspace.id },
  };
  const after = vi.fn(async (_workspaceId: string) => {});
  const acquire = vi.fn(async () => ({ tree: tree('Imported C') }));
  const makeOwner = (selectedStore = store, hook = after) =>
    createSkillManagementCommands(
      {
        coreDb,
        dataRoot,
        store: selectedStore,
        inflightCommands: new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>(),
        repositoryWorkspaceDb: (id) => openWorkspaceDb(dataRoot, id),
      },
      hook
    );
  const owner = makeOwner();
  const peerId = randomUUID();
  await owner.mutateSkill(
    'catalog.skill-pin',
    {
      workspaceId: workspace.id,
      requestId: peerId,
      expectedRevision: 2,
      skillId: 'example',
      digest: first.version.digest,
      expectedPinDigest: null,
    },
    context
  );
  after.mockClear();
  const requestId = randomUUID();
  new Uint8Array(faults.request).set(new TextEncoder().encode(requestId));
  const operation = `catalog.skill-${kind}` as const;
  const common = { workspaceId: workspace.id, requestId, expectedRevision: 3 };
  const call = (selectedOwner = owner) => {
    if (kind === 'import')
      return selectedOwner.importSkill(
        {
          ...common,
          id: 'example',
          displayName: 'Example Skill',
          activate: false,
          tree: tree('Imported C'),
        },
        context,
        acquire
      );
    if (kind === 'select')
      return selectedOwner.mutateSkill(
        'catalog.skill-select',
        {
          ...common,
          skillId: 'example',
          digest: second.version.digest,
          expectedCurrentDigest: first.version.digest,
        },
        context
      );
    if (kind === 'pin')
      return selectedOwner.mutateSkill(
        'catalog.skill-pin',
        {
          ...common,
          skillId: 'example',
          digest: second.version.digest,
          expectedPinDigest: first.version.digest,
        },
        context
      );
    if (kind === 'remove')
      return selectedOwner.mutateSkill(
        'catalog.skill-remove',
        { ...common, skillId: 'example' },
        context
      );
    return selectedOwner.mutateSkill(
      'catalog.skill-purge',
      { ...common, skillId: 'example', digest: second.version.digest },
      context
    );
  };
  const rows = (id = requestId) =>
    workspaceDb.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(id);
  const audits = () =>
    workspaceDb.sqlite
      .prepare('SELECT * FROM audit_events WHERE request_id=? ORDER BY rowid')
      .all(requestId) as Array<{
      action: string;
      audit_event_id: string;
      actor_json: string;
      resource_revision: number | null;
    }>;
  const files = () => {
    const catalog = loadWorkspaceResourceCatalog(dataRoot, workspace.id);
    return {
      catalog: readFileSync(catalogDocumentPath(dataRoot, workspace.id), 'utf8'),
      payloads: Object.fromEntries(
        catalog.skills.versions.map((version) => [
          `${version.entryId}@${version.digest}`,
          version.contentState === 'purged'
            ? null
            : readWorkspaceSkillSnapshot({
                dataRoot,
                workspaceId: workspace.id,
                entryId: version.entryId,
                digest: version.digest,
              }).entries,
        ])
      ),
    };
  };
  const queryOnly = () => {
    faults.readonlyMain = true;
    for (const db of [coreDb, userDb, workspaceDb]) {
      db.sqlite.pragma('query_only = ON');
      expect(db.sqlite.pragma('query_only', { simple: true })).toBe(1);
    }
  };
  const trigger = (stage: 'admission' | 'completion' | 'receipt' | 'prune') => {
    const sql =
      stage === 'admission' || stage === 'completion'
        ? `BEFORE INSERT ON audit_events WHEN NEW.request_id='${requestId}' AND NEW.action='${operation}${stage === 'admission' ? '.admit' : ''}'`
        : stage === 'receipt'
          ? `BEFORE INSERT ON idempotency_requests WHEN NEW.request_id='${requestId}'`
          : `BEFORE DELETE ON idempotency_requests WHEN OLD.request_id='${peerId}'`;
    workspaceDb.sqlite.exec(
      `CREATE TRIGGER refuse_skill_stage ${sql} BEGIN SELECT RAISE(ABORT,'Skill command fault'); END`
    );
  };
  const cold = async () => {
    await shutdownControlStoreWorkerClient();
    return makeOwner(
      new FsStore({ dataRoot }),
      vi.fn(async () => {})
    );
  };
  return {
    kind,
    dataRoot,
    coreDb,
    userDb,
    workspaceDb,
    userId,
    store,
    workspace,
    first: first.version.digest,
    second: second.version.digest,
    requestId,
    peerId,
    operation,
    context,
    owner,
    after,
    acquire,
    call,
    rows,
    audits,
    files,
    queryOnly,
    trigger,
    cold,
  };
}

it.each(['import', 'pin', 'purge'] as const)(
  'keeps %s bytes unchanged when the original admission Audit refuses',
  async (kind) => {
    const f = await fixture(kind);
    const before = f.files();
    f.trigger('admission');
    await expect(f.call()).rejects.toBeDefined();
    expect(faults.sqliteFault || Atomics.load(new Int32Array(faults.gate), 3) === 1).toBe(true);
    expect(f.files()).toEqual(before);
    expect(f.audits()).toEqual([]);
    expect(f.rows()).toEqual([]);
    expect(f.after).not.toHaveBeenCalled();
    await f.cold();
    expect(f.files()).toEqual(before);
  }
);
it.each(['import', 'pin', 'purge'] as const)(
  'retains the original %s file effect and admission when completion Audit refuses',
  async (kind) => {
    const f = await fixture(kind);
    const before = f.files();
    f.trigger('completion');
    await expect(f.call()).rejects.toBeInstanceOf(CatalogIntegrityError);
    expect(faults.sqliteFault || Atomics.load(new Int32Array(faults.gate), 3) === 1).toBe(true);
    const product = f.files();
    expect(product).not.toEqual(before);
    expect(f.audits().map((e) => e.action)).toEqual([`${f.operation}.admit`]);
    expect(f.rows()).toEqual([]);
    expect(f.after).not.toHaveBeenCalled();
    const cold = await f.cold();
    expect(f.files()).toEqual(product);
    await expect(f.call(cold)).rejects.toBeInstanceOf(CatalogIntegrityError);
    expect(f.files()).toEqual(product);
    expect(f.rows()).toEqual([]);
  }
);
it.each(kinds)(
  'retains exact %s Audits and file effects when the original late receipt INSERT refuses',
  async (kind) => {
    const f = await fixture(kind);
    const before = f.files();
    f.trigger('receipt');
    await expect(f.call()).rejects.toBeInstanceOf(CatalogIntegrityError);
    expect(faults.sqliteFault || Atomics.load(new Int32Array(faults.gate), 3) === 1).toBe(true);
    const product = f.files();
    expect(product).not.toEqual(before);
    const audits = f.audits();
    expect(audits.map((e) => e.action)).toEqual([`${f.operation}.admit`, f.operation]);
    expect(f.after).toHaveBeenCalledTimes(1);
    expect(f.rows()).toEqual([]);
    const cold = await f.cold();
    expect(f.files()).toEqual(product);
    await expect(f.call(cold)).rejects.toBeInstanceOf(CatalogIntegrityError);
    expect(f.audits()).toEqual(audits);
    expect(f.rows()).toEqual([]);
    expect(f.files()).toEqual(product);
    expect(f.after).toHaveBeenCalledTimes(1);
  }
);
it.each(['import', 'pin', 'purge'] as const)(
  'keeps the original %s receipt committed before its separate prune refusal',
  async (kind) => {
    const f = await fixture(kind);
    const peer = f.rows(f.peerId);
    expect(peer).toHaveLength(1);
    const expiry = Date.parse((peer[0] as { expires_at: string }).expires_at);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(expiry - 60000));
      f.after.mockImplementationOnce(async () => {
        f.trigger('prune');
        vi.setSystemTime(new Date(expiry + 60000));
      });
      await expect(f.call()).rejects.toBeInstanceOf(CatalogIntegrityError);
      const receipt = f.rows();
      expect(receipt).toHaveLength(1);
      expect(faults.sqliteFault || Atomics.load(new Int32Array(faults.gate), 3) === 1).toBe(true);
      expect(f.rows(f.peerId)).toEqual(peer);
      const product = f.files();
      const audits = f.audits();
      f.workspaceDb.sqlite.exec('DROP TRIGGER refuse_skill_stage');
      const cold = await f.cold();
      await expect(f.call(cold)).resolves.toBeDefined();
      expect(f.files()).toEqual(product);
      expect(f.audits()).toEqual(audits);
      expect(f.rows()).toEqual(receipt);
      expect(f.after).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }
);
it('samples the original Skill receipt maintenance clock after afterMutation', async () => {
  const f = await fixture('pin');
  const peer = f.rows(f.peerId);
  const expiry = Date.parse((peer[0] as { expires_at: string }).expires_at);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date(expiry - 60000));
    f.after.mockImplementationOnce(async () => {
      expect(f.audits().map((e) => e.action)).toEqual([`${f.operation}.admit`, f.operation]);
      expect(f.rows()).toEqual([]);
      vi.setSystemTime(new Date(expiry + 60000));
    });
    await f.call();
    expect(f.rows()).toHaveLength(1);
    expect(f.rows(f.peerId)).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
it('keeps both Audits and files without a receipt when the original runtime refresh refuses', async () => {
  const f = await fixture('pin');
  f.after.mockRejectedValueOnce(new Error('Runtime refresh refused.'));
  await expect(f.call()).rejects.toBeInstanceOf(CatalogIntegrityError);
  expect(f.audits().map((e) => e.action)).toEqual([`${f.operation}.admit`, f.operation]);
  expect(f.rows()).toEqual([]);
  const product = f.files();
  const cold = await f.cold();
  await expect(f.call(cold)).rejects.toBeInstanceOf(CatalogIntegrityError);
  expect(f.files()).toEqual(product);
  expect(f.after).toHaveBeenCalledTimes(1);
});

it.each(kinds)(
  'publishes %s with Main query-only and its exact original receipt and Audit provenance',
  async (kind) => {
    const f = await fixture(kind);
    f.queryOnly();
    const result = await f.call();
    const rows = f.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      command_name: f.operation,
      response_kind: kind === 'import' ? 'skill_version' : 'skill_catalog',
      response_id:
        kind === 'import'
          ? JSON.stringify([
              (result as { version: { entryId: string } }).version.entryId,
              (result as { version: { digest: string } }).version.digest,
            ])
          : f.workspace.id,
    });
    expect(JSON.parse((rows[0] as { scope_json: string }).scope_json)).toEqual({
      workspaceId: f.workspace.id,
      actorId: f.userId,
    });
    const audits = f.audits();
    expect(audits.map((e) => e.action)).toEqual([`${f.operation}.admit`, f.operation]);
    for (const e of audits)
      expect(JSON.parse(e.actor_json)).toEqual({ kind: 'user', id: f.userId });
    if (kind === 'pin')
      expect(
        loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).skills.pins[0]!.pinAuditRef
      ).toBe(audits[0]!.audit_event_id);
    expect(f.after).toHaveBeenCalledTimes(1);
    for (const db of [f.coreDb, f.userDb])
      expect(
        db.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(f.requestId)
      ).toEqual([]);
    const product = f.files();
    const posts = faults.posts.length;
    await f.call();
    expect(faults.posts).toHaveLength(posts);
    const cold = await f.cold();
    await f.call(cold);
    expect(f.files()).toEqual(product);
    expect(f.rows()).toEqual(rows);
    expect(f.audits()).toEqual(audits);
    expect(f.after).toHaveBeenCalledTimes(1);
  }
);
it.each(kinds)(
  'retains every real %s FULL prefix without automatic effect replay after lost ACK',
  async (kind) => {
    for (const stage of [1, 2, 3, 4] as const) {
      const f = await fixture(kind);
      f.queryOnly();
      const before = f.files();
      const gate = new Int32Array(faults.gate);
      Atomics.store(gate, 1, stage);
      let settled = false;
      const pending = observed(
        f.call().finally(() => {
          settled = true;
        })
      );
      await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
      expect(settled).toBe(false);
      expect(Atomics.load(gate, 4)).toBe(2);
      const product = f.files();
      const audits = f.audits();
      const receipts = f.rows();
      expect(audits).toHaveLength(stage === 1 ? 1 : 2);
      expect(receipts).toHaveLength(stage < 3 ? 0 : 1);
      if (stage === 1) expect(product).toEqual(before);
      else expect(product).not.toEqual(before);
      expect(f.after).toHaveBeenCalledTimes(stage < 3 ? 0 : 1);
      const posts = faults.posts.length;
      await faults.workers[Atomics.load(gate, 5)]!.terminate();
      expect((await pending).ok).toBe(false);
      expect(faults.posts).toHaveLength(posts);
      expect(f.files()).toEqual(product);
      expect(f.audits()).toEqual(audits);
      expect(f.rows()).toEqual(receipts);
      release();
      const cold = await f.cold();
      if (stage >= 3) {
        await f.call(cold);
        expect(f.files()).toEqual(product);
        expect(f.audits()).toEqual(audits);
        expect(f.rows()).toEqual(receipts);
      } else if (stage === 1 && kind !== 'purge') {
        await f.call(cold);
        expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id).revision).toBe(4);
        expect(f.rows()).toHaveLength(1);
      } else {
        await expect(f.call(cold)).rejects.toBeInstanceOf(CatalogIntegrityError);
        expect(f.files()).toEqual(product);
        expect(f.rows()).toEqual([]);
      }
    }
  }
);
it.each(['import', 'pin', 'purge'] as const)(
  'refuses %s file mutation after real admission ACK crosses current administrator loss',
  async (kind) => {
    const f = await fixture(kind);
    f.queryOnly();
    const before = f.files();
    const gate = new Int32Array(faults.gate);
    Atomics.store(gate, 1, 1);
    const result = observed(f.call());
    await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
    expect(f.files()).toEqual(before);
    expect(f.rows()).toEqual([]);
    const revoker = openCoreDb(f.dataRoot);
    revoker.sqlite.pragma('query_only = OFF');
    try {
      revoker.sqlite.transaction(() => disableCanonicalUser(revoker, f.userId))();
    } finally {
      revoker.sqlite.close();
    }
    release();
    expect(await result).toMatchObject({ ok: false, error: expect.any(CatalogForbiddenError) });
    expect(f.files()).toEqual(before);
    expect(f.audits().map((e) => e.action)).toEqual([`${f.operation}.admit`]);
    expect(f.rows()).toEqual([]);
    expect(f.after).not.toHaveBeenCalled();
  }
);
it('refuses a Skill catalog CAS lost during a real admission ACK wait', async () => {
  const f = await fixture('select');
  f.queryOnly();
  const gate = new Int32Array(faults.gate);
  Atomics.store(gate, 1, 1);
  const result = observed(f.call());
  await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
  const winner = selectWorkspaceSkillDefault({
    dataRoot: f.dataRoot,
    workspaceId: f.workspace.id,
    entryId: 'example',
    expectedRevision: 3,
    expectedCurrentDigest: f.first,
    digest: f.first,
  });
  const bytes = f.files();
  release();
  expect(await result).toMatchObject({ ok: false, error: expect.any(CatalogConflictError) });
  expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspace.id)).toEqual(winner);
  expect(f.files()).toEqual(bytes);
  expect(f.rows()).toEqual([]);
  expect(f.after).not.toHaveBeenCalled();
});
it('retains purge bytes when a real evidence reference arrives during admission ACK', async () => {
  const f = await fixture('purge');
  f.queryOnly();
  const before = f.files();
  const gate = new Int32Array(faults.gate);
  Atomics.store(gate, 1, 1);
  const result = observed(f.call());
  await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1), { timeout: 5000 });
  expect(f.files()).toEqual(before);
  const referenceId = randomUUID();
  const writer = openWorkspaceDb(f.dataRoot, f.workspace.id);
  writer.sqlite.pragma('query_only = OFF');
  try {
    recordWorkspaceEvidenceBundle(writer, {
      id: referenceId,
      workspaceId: f.workspace.id,
      threadId: null,
      goalId: null,
      turnId: null,
      agentSessionId: null,
      backendType: null,
      sourceKind: 'skill-comparison',
      summary: 'Real retained Skill reference.',
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [],
      contentDigests: [f.second],
      retentionClass: 'legal-hold',
      sensitivityClass: 'product-safe',
      importStatus: 'collected',
      requiredFeatures: [],
      createdAt: new Date().toISOString(),
    });
  } finally {
    writer.sqlite.close();
  }
  release();
  expect(await result).toMatchObject({ ok: false, error: expect.any(CatalogRetentionError) });
  expect(f.files()).toEqual(before);
  expect(f.audits().map((e) => e.action)).toEqual([`${f.operation}.admit`]);
  expect(f.rows()).toEqual([]);
  expect(f.after).not.toHaveBeenCalled();
});
