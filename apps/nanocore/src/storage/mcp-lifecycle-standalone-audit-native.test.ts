// openkit-test-platform: posix
// The real stdio fixture and process-death oracle require POSIX process-group and ESRCH semantics.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type { OperationId } from '@openkit/app-api-schemas';
import { resolveWorkspaceMcpServer } from '@openkit/config-schema';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents, listWorkspaceAuditEvents } from '../audit-events.js';
import { importWorkspaceLightAppDefinition } from '../catalog/light-app-catalog.js';
import { loadResourceCatalog } from '../catalog/resource-catalog.js';
import { FsStore } from '../lib/store.js';
import {
  createDefaultWorkerMcpGateway,
  type WorkerMcpGatewayServerInput,
} from '../runtime/worker-mcp-gateway.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createMcpHttpStub } from '../test-support/mcp-http-stub.js';
import { operationRequest } from '../test-support/operation-request.js';
import { closeTestCoreDb, createTestCoreDb, createTestWorkspaceDb } from '../test-support/store.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { commandInputHash } from './control-store-input.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { ControlStandaloneAuditInputSchema } from './standalone-audit-codecs.js';

// Node 24 supplies waitAsync; the package's standard library target is ES2023.
declare global {
  interface Atomics {
    waitAsync(
      array: Int32Array,
      index: number,
      value: number
    ):
      | { async: false; value: 'not-equal' | 'timed-out' }
      | { async: true; value: Promise<'ok' | 'timed-out'> };
  }
}

// L2: real Gateway/preview -> original standalone Audit -> physical native INSERT/FULL/ACK.
// Core Storage / SQLite Layers and Core Evidence / Audit own these predicates.
// This is the existing public server-mcp standalone observer, scoped to one unique target.
const instrument = vi.hoisted(() => ({
  gate: new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT),
  target: new SharedArrayBuffer(4096),
  workers: [] as NativeWorker[],
  contacts: [] as number[],
  sent: [] as Array<{ worker: number; value: unknown }>,
  received: [] as Array<{ worker: number; value: unknown }>,
}));

vi.mock('node:child_process', async (load) => {
  const actual = await load<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: new Proxy(actual.spawn, {
      apply(target, receiver, args: unknown[]) {
        const child = Reflect.apply(target, receiver, args);
        if (
          Array.isArray(args[1]) &&
          args[1].some((arg) => typeof arg === 'string' && arg.endsWith('/mcp-stdio-stub.mjs'))
        )
          instrument.contacts.push(child.pid ?? 0);
        return child;
      },
    }),
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
        const index = instrument.workers.length;
        const prelude = String.raw`
          const {workerData}=require('node:worker_threads');
          const Database=require(workerData.auditSqlModule);
          const gate=workerData.auditGate;
          const originalPrepare=Database.prototype.prepare;
          const originalExec=Database.prototype.exec;
          const inserted=new WeakSet();
          function target() {
            const raw=Buffer.from(workerData.auditTarget).toString('utf8').replace(/\u0000+$/, '');
            return raw ? JSON.parse(raw) : null;
          }
          function matches(row,t) {
            return row && t && row.action===t.action && row.outcome===t.outcome && row.resource===t.resource;
          }
          Database.prototype.prepare=function(sql) {
            const statement=originalPrepare.call(this,sql);
            if (!/^\s*INSERT\s+INTO\s+audit_events\b/i.test(sql)) return statement;
            const run=statement.run.bind(statement);
            statement.run=(...args)=>{
              const result=run(...args);
              const rowid=originalPrepare.call(this,'SELECT last_insert_rowid() AS id').get().id;
              const row=originalPrepare.call(this,
                'SELECT action,outcome,resource FROM audit_events WHERE rowid=?').get(rowid);
              if (matches(row,target())) {
                inserted.add(this);
                if (Atomics.load(gate,5)===2 && Atomics.compareExchange(gate,1,1,0)===1) {
                  Atomics.store(gate,4,workerData.auditWorkerIndex);
                  Atomics.store(gate,0,2); Atomics.notify(gate,0);
                  // Real INSERT ran; the existing native savepoint/transaction must roll it back.
                  throw new Error('injected failure after real original Audit INSERT');
                }
              }
              return result;
            };
            return statement;
          };
          Database.prototype.exec=function(sql) {
            if (/^\s*(BEGIN|ROLLBACK)\b/i.test(sql)) inserted.delete(this);
            const result=originalExec.call(this,sql);
            if (!/^\s*COMMIT\s*;?\s*$/i.test(sql) || !inserted.has(this)) return result;
            inserted.delete(this);
            const t=target();
            const row=t && originalPrepare.call(this,
              'SELECT 1 FROM audit_events WHERE action=? AND outcome=? AND resource=?').get(t.action,t.outcome,t.resource);
            if (!row || Atomics.compareExchange(gate,1,1,0)!==1) return result;
            Atomics.store(gate,3,this.pragma('synchronous',{simple:true}));
            Atomics.store(gate,4,workerData.auditWorkerIndex);
            Atomics.store(gate,0,1); Atomics.notify(gate,0);
            Atomics.wait(gate,2,0);
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
            auditSqlModule: require.resolve('better-sqlite3'),
            auditGate: new Int32Array(instrument.gate),
            auditTarget: new Uint8Array(instrument.target),
            auditWorkerIndex: index,
          },
        });
        instrument.workers.push(this);
        this.on('message', (value: unknown) => {
          if (
            typeof value === 'object' &&
            value !== null &&
            'operation' in value &&
            value.operation === 'standalone-audit'
          )
            instrument.received.push({ worker: index, value });
        });
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const value: unknown = args[0];
        if (
          typeof value === 'object' &&
          value !== null &&
          'operation' in value &&
          value.operation === 'standalone-audit'
        )
          instrument.sent.push({ worker: instrument.workers.indexOf(this), value });
        return super.postMessage(...args);
      }
    },
  };
});

const STDIO = fileURLToPath(new URL('../test-support/mcp-stdio-stub.mjs', import.meta.url));
type State = 'starting' | 'ready' | 'inactive' | 'failed' | 'degraded';
type Outcome<T> = { value: T } | { error: unknown };

/** Observes a rejection at creation, so fault and cleanup paths cannot detach it. */
function outcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}

/** Releases the one existing native hold, including failing-test cleanup. */
function release() {
  const gate = new Int32Array(instrument.gate);
  Atomics.store(gate, 1, 0);
  Atomics.store(gate, 2, 1);
  Atomics.notify(gate, 2);
}

/** Selects one original row in an otherwise private, single-invocation physical fixture. */
function arm(action: string, resource: string, result = 'succeeded', mode: 1 | 2 = 1) {
  const gate = new Int32Array(instrument.gate);
  gate.fill(0);
  const bytes = new Uint8Array(instrument.target);
  bytes.fill(0);
  bytes.set(new TextEncoder().encode(JSON.stringify({ action, resource, outcome: result })));
  Atomics.store(gate, 5, mode);
  Atomics.store(gate, 1, 1);
}

/** Requires the real boundary; an actual earlier terminal result is an explicit OLD observation. */
async function held<T>(pending: Promise<Outcome<T>>, mode: 1 | 2 = 1) {
  const gate = new Int32Array(instrument.gate);
  const signal = Promise.resolve(Atomics.waitAsync(gate, 0, 0).value).then(() => 'held' as const);
  const first = await Promise.race([signal, pending.then((result) => ({ result }))]);
  if (first !== 'held' && !(mode === 2 && Atomics.load(gate, 0) === 2)) {
    const result = first.result;
    let status: number | undefined;
    let code: unknown;
    if ('value' in result && result.value instanceof Response) {
      status = result.value.status;
      const body: unknown = await result.value
        .clone()
        .json()
        .catch(() => undefined);
      if (record(body)) code = body.code;
    } else if ('error' in result && record(result.error)) {
      status = typeof result.error.status === 'number' ? result.error.status : undefined;
      code = result.error.code;
    }
    console.info(
      'MCP_AUTHOR_EARLY_BOUNDARY',
      JSON.stringify({
        nativeBoundary: Atomics.load(gate, 0),
        spawnAttempts: instrument.contacts.length,
        outcome: 'value' in result ? 'result' : 'refusal',
        status,
        code,
      })
    );
    const detail = 'value' in first.result ? 'completed public result' : 'completed public refusal';
    throw new Error(
      `Actual ${detail} preceded the required native Audit boundary; later assertions are unreached.`
    );
  }
  expect(Atomics.load(gate, 0)).toBe(mode);
  if (mode === 1) {
    expect(Atomics.load(gate, 3)).toBe(2);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled, 'The public outcome must still await its covering native ACK.').toBe(false);
  }
  return instrument.workers[Atomics.load(gate, 4)]!;
}

/** Narrows an observed wire value without a cast or fabricated native response. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Binds an original committed row to the actual sender, receiver, request ID and covering ACK. */
function nativeFor(eventId: string) {
  const sent = instrument.sent.find(
    ({ value }) =>
      record(value) &&
      record(value.input) &&
      record(value.input.event) &&
      value.input.event.id === eventId
  );
  expect(
    sent,
    'The exact original row must be the native request, not an unrelated later COMMIT.'
  ).toBeDefined();
  if (!sent || !record(sent.value)) throw new Error('Exact native request was not observed.');
  const message = sent.value;
  return {
    message,
    worker: sent.worker,
    replies: () =>
      instrument.received.filter(
        ({ worker, value }) => worker === sent.worker && record(value) && value.id === message.id
      ),
  };
}

/** Composes real canonical identity, optional Workspace and the actual public operation boundary. */
async function fixture(workspace = false) {
  release();
  instrument.contacts.length = 0;
  const root = mkdtempSync(join(tmpdir(), 'mcp-lifecycle-native-'));
  const coreDb = createTestCoreDb(root);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot: root });
  let workspaceDb: ReturnType<typeof createTestWorkspaceDb> | undefined;
  const vault = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(root, 'server/vault'),
  });
  vault.unlock({ masterKey: randomBytes(32) });
  const app = createAppWithLocalIdentity({
    coreDb,
    dataRoot: root,
    store,
    localUserId: userId,
    mode: 'local',
    vaultUnlockState: vault,
  });
  const id = `lifecycle-${randomUUID()}`;
  const pidFile = join(root, 'server.pid');
  const callsFile = join(root, 'calls.log');
  const pending: Promise<unknown>[] = [];
  const closures: Array<() => Promise<void>> = [];
  /** Retains finite work until its real terminal outcome and cleanup. */
  function track<T>(promise: Promise<T>): Promise<T> {
    const observed = promise.finally(() => {
      // Existing public rows distinguish a reached lifecycle state from a setup-only outcome.
      console.info(
        'MCP_AUTHOR_TERMINAL',
        JSON.stringify({
          actions: rows().map((event) => event.action),
          spawnAttempts: instrument.contacts.length,
          nativeBoundary: Atomics.load(new Int32Array(instrument.gate), 0),
        })
      );
    });
    pending.push(observed);
    return observed;
  }
  onTestFinished(async () => {
    release();
    for (const close of closures.reverse()) await close();
    await Promise.allSettled(pending);
    await shutdownControlStoreWorkerClient();
    vault.lock();
    if (workspaceDb) closeTestCoreDb(workspaceDb);
    closeTestCoreDb(coreDb);
    rmSync(root, { recursive: true, force: true });
  });
  const ws = workspace ? await store.createWorkspace('Real MCP consumer') : undefined;
  if (ws) {
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: ws.id, ownerUserId: userId });
    workspaceDb = createTestWorkspaceDb(root, ws.id);
  }
  const contactStart = instrument.contacts.length;
  const contacts = () => instrument.contacts.slice(contactStart);
  const send = (operation: OperationId, input: object) =>
    track(
      Promise.resolve(
        app.request(...operationRequest(operation, {}, { body: JSON.stringify(input) }))
      )
    );
  const ok = async (operation: OperationId, input: object) => {
    const response = await send(operation, input);
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    expect(response.status).toBeGreaterThanOrEqual(200);
    return response.json();
  };
  const coreEvents = () => listServerAuditEvents(coreDb);
  const rows = () =>
    (workspaceDb && ws ? listWorkspaceAuditEvents(workspaceDb, ws.id) : coreEvents()).filter(
      (event) => event.resource === `mcp-server:${id}`
    );
  const gateway = (withCore = true) => {
    const result = createDefaultWorkerMcpGateway(withCore ? coreDb : undefined);
    closures.push(() => result.close());
    return result;
  };
  const server = (environment: Record<string, string> = {}) =>
    resolveWorkspaceMcpServer({
      catalog: {
        schemaVersion: 1,
        servers: [
          {
            id,
            enabled: true,
            allowedTools: ['echo'],
            credentialBindings: [],
            pinnedSchemaSnapshotId: null,
            packageRootDigest: null,
            schemaPolicy: 'tracking',
            timeoutMs: 2000,
            transport: {
              kind: 'stdio',
              command: process.execPath,
              args: [STDIO, callsFile],
              cwd: null,
              environment: {},
              environmentValues: { OPENKIT_MCP_SERVER_PID_FILE: pidFile, ...environment },
            },
          },
        ],
      },
      serverId: id,
    });
  const input = (environment: Record<string, string> = {}): WorkerMcpGatewayServerInput => {
    if (!ws) throw new Error('This invocation requires a real Workspace.');
    return { workspaceId: ws.id, server: server(environment) };
  };
  const preview = async (
    options: { exit?: boolean; credentials?: boolean; endpoint?: string } = {}
  ) => {
    const created = await ok('administration.server-mcp-create', {
      requestId: randomUUID(),
      id,
      displayName: 'Lifecycle fixture',
      allowedTools: [],
      expectedRevision: 0,
      declaration: options.endpoint
        ? { kind: 'http', endpoint: options.endpoint }
        : {
            kind: 'stdio',
            command: process.execPath,
            args: [STDIO, callsFile],
            environment: {
              OPENKIT_MCP_SERVER_PID_FILE: pidFile,
              ...(options.exit ? { OPENKIT_MCP_INIT_EXIT: '1' } : {}),
            },
            environmentSlots: options.credentials
              ? { LIFECYCLE_PRIVATE_SECRET: { credentialSlot: 'private' } }
              : {},
          },
    });
    const bindings: Array<{
      slot: string;
      vaultGrantId: string;
      sink: { kind: 'env'; name: string };
    }> = [];
    let referenceId: string | undefined;
    if (options.credentials) {
      const reference = await ok('vault.server-mcp-secret-create', {
        requestId: randomUUID(),
        material: randomUUID(),
      });
      referenceId = reference.referenceId;
      const grant = await ok('vault.server-mcp-grant-create', {
        requestId: randomUUID(),
        referenceId,
      });
      bindings.push({
        slot: 'private',
        vaultGrantId: grant.grantId,
        sink: { kind: 'env', name: 'LIFECYCLE_PRIVATE_SECRET' },
      });
    }
    const body = {
      catalogScope: { kind: 'server' },
      mcpId: id,
      versionDigest: created.versionDigest,
      expectedRevision: 1,
      expectedBindingRevision: null,
      timeoutMs: 5000,
      credentialBindings: bindings,
    };
    return {
      referenceId,
      start: () => track(outcome(send('administration.mcp-discovery-preview', body))),
    };
  };
  return {
    root,
    coreDb,
    userId,
    store,
    ws,
    workspaceDb,
    id,
    pidFile,
    callsFile,
    vault,
    send,
    ok,
    coreEvents,
    rows,
    gateway,
    input,
    preview,
    track,
    closures,
    contacts,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Preserves the original actor/request from the separate admitted preview-start producer. */
function previewIdentity(f: Fixture) {
  const started = f
    .coreEvents()
    .filter(
      (event) =>
        event.action === 'administration.mcp-discovery-preview' && event.outcome === 'succeeded'
    );
  // The separate operation records both start and completion under this same original invocation.
  expect(started.length).toBeGreaterThan(0);
  expect(new Set(started.map((event) => event.requestId))).toEqual(
    new Set([started[0]!.requestId])
  );
  expect(started[0]!.actor).toEqual({ kind: 'user', id: f.userId });
  expect(started[0]!.requestId).toEqual(expect.any(String));
  return started[0]!.requestId;
}

/** Checks all original event facts, rather than a new permission/receipt tuple or synthetic actor. */
function original(f: Fixture, state: State, preview: boolean, credentials = false) {
  const events = f.rows().filter((event) => event.action === `mcp.server.lifecycle.${state}`);
  expect(events).toHaveLength(1);
  const event = events[0]!;
  const failed = state === 'failed' || state === 'degraded';
  if (state === 'starting')
    expect(f.contacts(), 'Actual spawn, not only its later PID witness, must await Audit.').toEqual(
      []
    );
  expect(event).toMatchObject({
    workspaceId: preview ? null : f.ws!.id,
    actor: preview ? { kind: 'user', id: f.userId } : null,
    requestId: preview ? previewIdentity(f) : null,
    category: 'capability',
    resource: `mcp-server:${f.id}`,
    severity: failed ? 'warning' : 'info',
    outcome: failed ? 'failed' : 'succeeded',
    errorCode: failed ? 'mcp-server-unavailable' : null,
    summary: `${preview ? 'Temporary MCP preview server' : `MCP server ${f.id}`} entered ${state}${credentials && state === 'starting' ? ' with gateway-only credentials' : ''}.`,
  });
  for (const key of [
    'agentId',
    'agentSessionId',
    'capabilityCallId',
    'permissionDecisionId',
    'vaultGrantId',
  ] as const)
    expect(event[key]).toBeNull();
  const serialized = JSON.stringify(event);
  expect(serialized).not.toContain(f.root);
  expect(serialized).not.toContain(STDIO);
  expect(serialized).not.toContain('LIFECYCLE_PRIVATE_SECRET');
  return event;
}

/** Proves the exact selected row has no receiver ACK while the physical owner remains held. */
function beforeAck(eventId: string) {
  const native = nativeFor(eventId);
  expect(native.worker).toBe(Atomics.load(new Int32Array(instrument.gate), 4));
  expect(native.replies()).toEqual([]);
  return native;
}

/** Requires the real covering success reply, on the same Worker and request. */
function acknowledged(native: ReturnType<typeof nativeFor>) {
  expect(native.replies()).toHaveLength(1);
  expect(native.replies()[0]!.value).toMatchObject({
    status: 'ok',
    operation: 'standalone-audit',
    result: null,
  });
}

/** Reads the real cold committed prefix after the actual writer has closed or exited. */
async function cold(f: Fixture) {
  await shutdownControlStoreWorkerClient();
  if (f.ws) {
    const db = createTestWorkspaceDb(f.root, f.ws.id);
    try {
      return listWorkspaceAuditEvents(db, f.ws.id).filter(
        (event) => event.resource === `mcp-server:${f.id}`
      );
    } finally {
      closeTestCoreDb(db);
    }
  }
  const db = createTestCoreDb(f.root);
  try {
    return listServerAuditEvents(db).filter((event) => event.resource === `mcp-server:${f.id}`);
  } finally {
    closeTestCoreDb(db);
  }
}

it.each([
  'ack',
  'rollback',
  'lost-ack',
] as const)('calibrates the exact Core INSERT/COMMIT/FULL/receiver gate 0: %s', async (mode) => {
  const f = await fixture();
  const requestId = randomUUID();
  const action = 'administration.server-mcp-create';
  const resource = `mcp-command:${commandInputHash({ name: action, scope: { actorId: f.userId, coreId: 'server' }, requestId })}`;
  arm(action, resource, 'unknown', mode === 'rollback' ? 2 : 1);
  const result = f.track(
    outcome(
      f.send(action, {
        requestId,
        id: f.id,
        displayName: 'Calibration',
        allowedTools: [],
        expectedRevision: 0,
        declaration: { kind: 'http', endpoint: 'https://example.test/mcp' },
      })
    )
  );
  const worker = await held(result, mode === 'rollback' ? 2 : 1);
  const selected = () => f.coreEvents().filter((event) => event.resource === resource);
  if (mode === 'rollback') {
    const done = await result;
    expect(done).toHaveProperty('value');
    if (!('value' in done)) throw done.error;
    // Server MCP Administration retains inspection-required 409; Gateway starts separately own 503.
    expect(done.value.status).toBe(409);
    expect(await done.value.clone().json()).toMatchObject({ code: 'recovery_required' });
    expect(selected()).toEqual([]);
    expect(loadResourceCatalog(f.root, { kind: 'server' }).mcp.entries).toEqual([]);
    return;
  }
  expect(selected()).toHaveLength(1);
  expect(selected()[0]).toMatchObject({
    requestId,
    actor: { kind: 'user', id: f.userId },
    action,
    outcome: 'unknown',
  });
  const native = beforeAck(selected()[0]!.id);
  if (mode === 'lost-ack') await worker.terminate();
  else release();
  const done = await result;
  if (!('value' in done)) throw done.error;
  if (mode === 'ack') {
    expect(done.value.status, await done.value.clone().text()).toBe(200);
    acknowledged(native);
    const parsed = ControlStandaloneAuditInputSchema.parse(native.message.input);
    expect(
      ControlStandaloneAuditInputSchema.safeParse({
        ...parsed,
        event: { ...parsed.event, actor: null },
      }).success
    ).toBe(false);
  } else {
    expect(done.value.status).toBe(409);
    expect(await done.value.clone().json()).toMatchObject({ code: 'recovery_required' });
    expect(native.replies()).toEqual([]);
    expect(loadResourceCatalog(f.root, { kind: 'server' }).mcp.entries).toEqual([]);
    await shutdownControlStoreWorkerClient();
    const db = createTestCoreDb(f.root);
    try {
      expect(listServerAuditEvents(db).filter((event) => event.resource === resource)).toEqual(
        selected()
      );
    } finally {
      closeTestCoreDb(db);
    }
  }
});

it('calibrates the same gate 0 on a real published Workspace standalone stage and receiver', async () => {
  const f = await fixture(true);
  const workspaceId = f.ws!.id;
  const base = {
    dataRoot: f.root,
    workspaceId,
    entryId: 'notes',
    displayName: 'Notes',
    producer: { kind: 'user' as const, id: f.userId },
    createdAt: new Date().toISOString(),
  };
  const definition = {
    format: 'openkit.light-app' as const,
    schemaVersion: 1 as const,
    title: 'First',
    purpose: 'Fixture notes',
    collections: [
      {
        name: 'notes',
        type: 'base' as const,
        description: 'Notes',
        indexes: [],
        fields: [{ name: 'body', type: 'text' as const, required: false, description: 'Body' }],
      },
    ],
  };
  const first = importWorkspaceLightAppDefinition({
    ...base,
    expectedRevision: 0,
    definition,
    selectDefault: true,
  }).version;
  const second = importWorkspaceLightAppDefinition({
    ...base,
    expectedRevision: 1,
    definition: { ...definition, title: 'Second' },
    parentDigest: first.digest,
  }).version;
  const requestId = randomUUID();
  arm('catalog.light-app-select', `light-app-definition:${workspaceId}`);
  const result = f.track(
    outcome(
      f.send('catalog.light-app-select', {
        workspaceId,
        requestId,
        expectedRevision: 2,
        entryId: 'notes',
        digest: second.digest,
        expectedCurrentDigest: first.digest,
      })
    )
  );
  await held(result);
  const events = listWorkspaceAuditEvents(f.workspaceDb!, workspaceId).filter(
    (event) => event.requestId === requestId
  );
  expect(events).toHaveLength(1);
  const native = beforeAck(events[0]!.id);
  release();
  const done = await result;
  if (!('value' in done)) throw done.error;
  expect(done.value.status, await done.value.clone().text()).toBe(200);
  acknowledged(native);
});

it('keeps real Workspace starting FULL-acknowledged before contact and original null attribution through closure', async () => {
  const f = await fixture(true);
  const gateway = f.gateway();
  const input = f.input();
  arm('mcp.server.lifecycle.starting', `mcp-server:${f.id}`);
  const result = f.track(outcome(gateway.listTools(input)));
  await held(result);
  const native = beforeAck(original(f, 'starting', false).id);
  expect(existsSync(f.pidFile)).toBe(false);
  expect(existsSync(f.callsFile)).toBe(false);
  release();
  expect(await result).toMatchObject({ value: { tools: [{ name: 'echo' }] } });
  acknowledged(native);
  original(f, 'ready', false);
  await gateway.closeServer(input);
  original(f, 'inactive', false);
  expect(f.coreEvents().filter((event) => event.resource === `mcp-server:${f.id}`)).toEqual([]);
});

it('preserves actual Core preview actor/request and no synthetic Workspace through real startup and closure', async () => {
  const f = await fixture();
  const preview = await f.preview();
  const before = loadResourceCatalog(f.root, { kind: 'server' });
  arm('mcp.server.lifecycle.starting', `mcp-server:${f.id}`);
  const result = preview.start();
  await held(result);
  const native = beforeAck(original(f, 'starting', true).id);
  expect(existsSync(f.pidFile)).toBe(false);
  release();
  const done = await result;
  if (!('value' in done)) throw done.error;
  expect(done.value.status, await done.value.clone().text()).toBe(200);
  acknowledged(native);
  original(f, 'ready', true);
  original(f, 'inactive', true);
  expect(await f.store.listWorkspaces()).toEqual([]);
  expect(loadResourceCatalog(f.root, { kind: 'server' })).toEqual(before);
  expect(existsSync(f.callsFile)).toBe(false);
});

it.each([
  'failed',
  'degraded',
] as const)('retains Workspace original %s and effect truth at the real failure boundary', async (state) => {
  const f = await fixture(true);
  const gateway = f.gateway();
  const input = f.input(state === 'failed' ? { OPENKIT_MCP_INIT_EXIT: '1' } : {});
  if (state === 'degraded') await gateway.listTools(input);
  arm(`mcp.server.lifecycle.${state}`, `mcp-server:${f.id}`, 'failed');
  const result = f.track<Outcome<unknown>>(
    state === 'failed'
      ? outcome(gateway.listTools(input))
      : outcome(gateway.callTool({ ...input, toolName: 'echo', arguments: { message: 'crash' } }))
  );
  await held(result);
  const native = beforeAck(original(f, state, false).id);
  expect(existsSync(f.pidFile)).toBe(true);
  if (state === 'degraded') expect(readFileSync(f.callsFile, 'utf8')).toContain('crash');
  release();
  expect(await result).toMatchObject({
    error:
      state === 'failed'
        ? { code: 'mcp-server-unavailable', status: 503 }
        : {
            code: 'mcp-call-failed',
            status: 503,
            upstreamEffect: expect.stringMatching(/^(contacted|unknown)$/),
          },
  });
  acknowledged(native);
  expect(gateway.getServerHealth(input)).toBe(state);
});

it.each([
  'failed',
  'degraded',
] as const)('retains Core preview original %s under its actual administrator and invocation', async (state) => {
  const f = await fixture();
  const upstream = state === 'degraded' ? await createMcpHttpStub({ listError: true }) : undefined;
  if (upstream) f.closures.push(() => upstream.close());
  const preview = await f.preview({
    exit: state === 'failed',
    ...(upstream ? { endpoint: upstream.url } : {}),
  });
  arm(`mcp.server.lifecycle.${state}`, `mcp-server:${f.id}`, 'failed');
  const result = preview.start();
  await held(result);
  const native = beforeAck(original(f, state, true).id);
  if (upstream)
    expect(upstream.observed.some((request) => request.endsWith('|tools/list'))).toBe(true);
  else expect(existsSync(f.pidFile)).toBe(true);
  release();
  const done = await result;
  if (!('value' in done)) throw done.error;
  expect(done.value.status).toBe(503);
  acknowledged(native);
  expect(await f.store.listWorkspaces()).toEqual([]);
});

it.each([
  'rollback',
  'lost-ack',
] as const)('refuses credential transport after a real starting Audit %s without inventing rollback', async (mode) => {
  const f = await fixture();
  const preview = await f.preview({ credentials: true });
  arm(
    'mcp.server.lifecycle.starting',
    `mcp-server:${f.id}`,
    'succeeded',
    mode === 'rollback' ? 2 : 1
  );
  const result = preview.start();
  const worker = await held(result, mode === 'rollback' ? 2 : 1);
  if (mode === 'lost-ack') {
    const event = original(f, 'starting', true, true);
    const native = beforeAck(event.id);
    await worker.terminate();
    expect(native.replies()).toEqual([]);
  }
  const done = await result;
  if (!('value' in done)) throw done.error;
  expect(done.value.status).toBe(503);
  expect(f.contacts()).toEqual([]);
  expect(existsSync(f.pidFile)).toBe(false);
  expect(existsSync(f.callsFile)).toBe(false);
  const retained = await cold(f);
  expect(retained.filter((event) => event.action === 'mcp.server.lifecycle.starting')).toHaveLength(
    mode === 'rollback' ? 0 : 1
  );
});

it('refuses material withdrawn during the held starting Audit before any credential-bearing contact', async () => {
  const f = await fixture();
  const preview = await f.preview({ credentials: true });
  arm('mcp.server.lifecycle.starting', `mcp-server:${f.id}`);
  const result = preview.start();
  await held(result);
  const native = beforeAck(original(f, 'starting', true, true).id);
  expect(existsSync(f.pidFile)).toBe(false);
  if (!preview.referenceId) throw new Error('Real credential reference was not created.');
  const revoked = f.vault.backend().revoke({ referenceId: preview.referenceId });
  expect(revoked.revoked).toBe(true);
  release();
  const done = await result;
  if (!('value' in done)) throw done.error;
  expect(done.value.status).toBe(403);
  acknowledged(native);
  expect(f.contacts()).toEqual([]);
  expect(existsSync(f.pidFile)).toBe(false);
  expect(existsSync(f.callsFile)).toBe(false);
});

it('preserves a contacted Tool result and cold committed ready prefix after loss of its Audit ACK', async () => {
  const f = await fixture(true);
  const gateway = f.gateway();
  const input = f.input();
  arm('mcp.server.lifecycle.ready', `mcp-server:${f.id}`);
  const result = f.track(
    outcome(
      gateway.callTool({ ...input, toolName: 'echo', arguments: { message: 'actual-effect' } })
    )
  );
  const worker = await held(result);
  const event = original(f, 'ready', false);
  beforeAck(event.id);
  expect(readFileSync(f.callsFile, 'utf8')).toContain('actual-effect');
  await worker.terminate();
  expect(await result).toMatchObject({
    value: { structuredContent: { message: 'actual-effect' } },
  });
  expect(gateway.getServerHealth(input)).toBe('ready');
  const retained = await cold(f);
  expect(retained).toContainEqual(event);
  expect(retained.some((row) => row.action === 'mcp.server.lifecycle.starting')).toBe(true);
});

it('joins Workspace closure across a held start and never accepts its late child or ready result', async () => {
  const f = await fixture(true);
  const gateway = f.gateway();
  const input = f.input();
  arm('mcp.server.lifecycle.starting', `mcp-server:${f.id}`);
  const result = f.track(outcome(gateway.listTools(input)));
  await held(result);
  beforeAck(original(f, 'starting', false).id);
  const closing = f.track(gateway.closeWorkspace(f.ws!.id));
  let closed = false;
  void closing.then(
    () => {
      closed = true;
    },
    () => {
      closed = true;
    }
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(closed).toBe(false);
  expect(existsSync(f.pidFile)).toBe(false);
  release();
  await closing;
  expect(await result).toMatchObject({ error: { code: 'mcp-server-unavailable', status: 503 } });
  expect(f.contacts()).toEqual([]);
  expect(existsSync(f.pidFile)).toBe(false);
  expect(f.rows().some((event) => event.action === 'mcp.server.lifecycle.ready')).toBe(false);
});

it('joins the original idle timer inactive publication after actual physical child closure', async () => {
  const f = await fixture(true);
  const clock = vi.spyOn(globalThis, 'setTimeout');
  onTestFinished(() => clock.mockRestore());
  const gateway = f.gateway();
  const input = f.input();
  await gateway.listTools(input);
  const pid = Number(readFileSync(f.pidFile, 'utf8'));
  const index = clock.mock.calls.findIndex((call) => call[1] === 60_000);
  expect(index, 'The existing owner must register its original idle bound.').toBeGreaterThanOrEqual(
    0
  );
  const scheduled = clock.mock.calls[index]!;
  const timer = clock.mock.results[index]!;
  if (timer.type !== 'return' || typeof scheduled[0] !== 'function')
    throw new Error('The real idle timer registration was not observable.');
  clearTimeout(timer.value);
  clock.mockRestore();
  arm('mcp.server.lifecycle.inactive', `mcp-server:${f.id}`);
  // Inject expiry through the actual registered callback; SDK and teardown clocks remain real.
  // This proves callback ownership, not elapsed time or health/idle interleaving.
  Reflect.apply(scheduled[0], undefined, scheduled.slice(2));
  // The original timer has fired. Public close must join its existing teardown, not detach Audit.
  const closing = f.track(outcome(gateway.close()));
  await held(closing);
  beforeAck(original(f, 'inactive', false).id);
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  release();
  expect(await closing).toHaveProperty('value');
  expect(gateway.getServerHealth(input)).toBe('inactive');
});

it('retains distinct no-Core truth without granting a credential-bearing start', async () => {
  const f = await fixture(true);
  const gateway = f.gateway(false);
  const input = f.input();
  expect(await gateway.listTools(input)).toMatchObject({ tools: [{ name: 'echo' }] });
  await gateway.closeServer(input);
  expect(f.rows()).toEqual([]);
  rmSync(f.pidFile, { force: true });
  const contacts = f.contacts().length;
  await expect(
    gateway.listTools({
      ...input,
      credentials: { environment: { LIFECYCLE_PRIVATE_SECRET: randomUUID() } },
    })
  ).rejects.toMatchObject({ code: 'mcp-server-unavailable', status: 503 });
  expect(f.contacts()).toHaveLength(contacts);
  expect(existsSync(f.pidFile)).toBe(false);
  expect(f.rows()).toEqual([]);
});

// Core Evidence / Audit and MCP Tool Supply / NanoCore Lifecycle: concurrent observations of
// one health change retain one historical transition and cannot publish health before its ACK.
it('coalesces concurrent healthy publication under one original health identity without early ready', async () => {
  const f = await fixture(true);
  const { Client } = await import('@modelcontextprotocol/client');
  const sdk = vi.spyOn(Client.prototype, 'listTools');
  onTestFinished(() => sdk.mockRestore());
  const upstream = await createMcpHttpStub();
  f.closures.push(() => upstream.close());
  const gateway = f.gateway();
  const input: WorkerMcpGatewayServerInput = {
    workspaceId: f.ws!.id,
    server: resolveWorkspaceMcpServer({
      catalog: {
        schemaVersion: 1,
        servers: [
          {
            id: f.id,
            enabled: true,
            allowedTools: ['echo'],
            credentialBindings: [],
            pinnedSchemaSnapshotId: null,
            packageRootDigest: null,
            schemaPolicy: 'tracking',
            timeoutMs: 2000,
            transport: { kind: 'http', endpoint: upstream.url, headers: {} },
          },
        ],
      },
      serverId: f.id,
    }),
  };
  arm('mcp.server.lifecycle.ready', `mcp-server:${f.id}`);
  const settled = [false, false];
  const results = [gateway.listTools(input), gateway.listTools(input)].map((pending, index) =>
    f.track(
      outcome(pending).then((result) => {
        settled[index] = true;
        return result;
      })
    )
  );
  const joined = f.track(outcome(Promise.all(results)));
  await held(joined);
  // Only the real SDK responses admit this concurrency observation; they are not fabricated
  // public successes and are not the product deciding count.
  expect(sdk.mock.results, 'Both SDK responses must reach the observation seam.').toHaveLength(2);
  await Promise.all(
    sdk.mock.results.map((result) => {
      if (result.type !== 'return') throw new Error('The real SDK response was not observable.');
      return result.value;
    })
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled, 'Neither healthy caller may finish before the covering ready ACK.').toEqual([
    false,
    false,
  ]);
  expect(gateway.getServerHealth(input)).not.toBe('ready');
  const event = original(f, 'ready', false);
  const native = beforeAck(event.id);
  release();
  for (const result of await Promise.all(results))
    expect(result).toMatchObject({ value: { tools: [{ name: 'echo' }] } });
  acknowledged(native);
  expect(gateway.getServerHealth(input)).toBe('ready');
  expect(original(f, 'ready', false)).toEqual(event);
  expect(f.coreEvents().filter((row) => row.resource === `mcp-server:${f.id}`)).toEqual([]);
});

// MCP Tool Supply / Credential Injection and Core Storage / SQLite Layers: unchanged shared
// health is not a credential effect grant, and lost ACK never proves rollback or no SQL effect.
it('covers two distinct credential session keys with the original starting ACK before either contact', async () => {
  const f = await fixture();
  const created = await f.ok('administration.server-mcp-create', {
    requestId: randomUUID(),
    id: f.id,
    displayName: 'Concurrent lifecycle fixture',
    allowedTools: [],
    expectedRevision: 0,
    declaration: {
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO, f.callsFile],
      environment: { OPENKIT_MCP_SERVER_PID_FILE: f.pidFile },
      environmentSlots: {
        LIFECYCLE_FIRST_SECRET: { credentialSlot: 'first' },
        LIFECYCLE_SECOND_SECRET: { credentialSlot: 'second' },
      },
    },
  });
  const bindings: Array<{
    slot: string;
    vaultGrantId: string;
    sink: { kind: 'env'; name: string };
  }> = [];
  for (const slot of ['first', 'second']) {
    const reference = await f.ok('vault.server-mcp-secret-create', {
      requestId: randomUUID(),
      material: randomUUID(),
    });
    const grant = await f.ok('vault.server-mcp-grant-create', {
      requestId: randomUUID(),
      referenceId: reference.referenceId,
    });
    bindings.push({
      slot,
      vaultGrantId: grant.grantId,
      sink: { kind: 'env', name: `LIFECYCLE_${slot.toUpperCase()}_SECRET` },
    });
  }
  const module = await import('../runtime/worker-mcp-gateway.js');
  const factory = module.createDefaultWorkerMcpGateway;
  type Selection = {
    gateway: ReturnType<typeof factory>;
    input: WorkerMcpGatewayServerInput;
    before: ReturnType<ReturnType<typeof factory>['getServerHealth']>;
  };
  let observe: ((selection: Selection) => void) | undefined;
  const observed = new Promise<Selection>((resolve) => {
    observe = resolve;
  });
  // Transparent observation of existing public methods: actual factory/context, original input,
  // original Gateway method and actual result all pass through; no new caller input is selected.
  const factorySpy = vi
    .spyOn(module, 'createDefaultWorkerMcpGateway')
    .mockImplementation((...args) => {
      const gateway = factory(...args);
      const list = gateway.listTools.bind(gateway);
      gateway.listTools = (input) => {
        observe?.({ gateway, input, before: gateway.getServerHealth(input) });
        return list(input);
      };
      f.closures.push(() => gateway.close());
      return gateway;
    });
  onTestFinished(() => factorySpy.mockRestore());
  arm('mcp.server.lifecycle.starting', `mcp-server:${f.id}`);
  const first = f.track(
    outcome(
      f.send('administration.mcp-discovery-preview', {
        catalogScope: { kind: 'server' },
        mcpId: f.id,
        versionDigest: created.versionDigest,
        expectedRevision: 1,
        expectedBindingRevision: null,
        timeoutMs: 5000,
        credentialBindings: bindings,
      })
    )
  );
  const selection = await Promise.race([observed, first.then(() => null)]);
  if (!selection) throw new Error('The admitted original preview did not reach its real Gateway.');
  const { gateway, input, before } = selection;
  const environment = input.credentials?.environment;
  if (!environment) throw new Error('The actual authorized environment material was not resolved.');
  expect(Object.keys(environment)).toHaveLength(2);
  const secondInput: WorkerMcpGatewayServerInput = {
    ...input,
    credentials: {
      ...input.credentials,
      environment: Object.fromEntries(Object.entries(environment).reverse()),
    },
  };
  // The published key hashes private JSON; order alone separates these two keys without changing
  // a single authorized value, binding, catalog, actor, target, material version or scope.
  expect(JSON.stringify(secondInput.credentials) !== JSON.stringify(input.credentials)).toBe(true);
  expect(secondInput.server).toBe(input.server);
  expect(secondInput.workspaceId).toBe(input.workspaceId);
  const worker = await held(first);
  const event = original(f, 'starting', true, true);
  const native = beforeAck(event.id);
  expect(gateway.getServerHealth(input)).toBe(before);
  let secondSettled = false;
  const second = f.track(
    outcome(gateway.listTools(secondInput)).then((result) => {
      secondSettled = true;
      return result;
    })
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(secondSettled).toBe(false);
  expect(gateway.getServerHealth(secondInput)).toBe(before);
  // The existing observer records actual spawn synchronously, without private environment data.
  expect(f.contacts().length).toBe(0);
  await worker.terminate();
  expect(native.replies()).toEqual([]);
  const [previewResult, secondResult] = await Promise.all([first, second]);
  if (!('value' in previewResult)) throw previewResult.error;
  expect(previewResult.value.status).toBe(503);
  expect(secondResult).toMatchObject({ error: { code: 'mcp-server-unavailable', status: 503 } });
  expect(f.contacts().length).toBe(0);
  expect((await cold(f)).find((row) => row.id === event.id)).toEqual(event);
  expect(await f.store.listWorkspaces()).toEqual([]);
});

// MCP Tool Supply / Worker-Side Access: a cached connection is not current authority.
// Core Evidence / Usage: a known pre-contact refusal cannot consume a Tool unit.
it('refuses a real cached healthy Worker Tool call after current authority changes without contact or usage', async () => {
  const { Client } = await import('@modelcontextprotocol/client');
  const { createInMemoryRuntimeConfigSnapshot, createRuntimeConfigManager, loadRuntimeConfig } =
    await import('../config/runtime-config.js');
  const { ProviderRegistry } = await import('../providers/registry.js');
  const { createTestAgentSetup, createTestGatewayConfig } = await import(
    '../test-support/agent-environment.js'
  );
  const { createNativeTaskAdmissionFixture } = await import(
    '../test-support/native-task-admission.js'
  );
  const { admitTestNativeEnvironment } = await import('../test-support/native-environment.js');
  const { isCanonicalUserActive } = await import('../auth/user-lifecycle.js');
  const { TurnStartValidationError } = await import('../operation-error.js');
  const { listArtifactReviews } = await import('../artifact-reviews.js');
  const { getWorkerControlAcceptedFinalStatus } = await import(
    '../runtime/worker-control-records.js'
  );
  const { listWorkspaceCapabilityCalls, listWorkspaceUsageRecords } = await import(
    '../capability/usage-ledger.js'
  );
  release();
  const root = mkdtempSync(join(tmpdir(), 'mcp-cached-current-authority-'));
  const coreDb = createTestCoreDb(root);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot: root });
  const upstream = await createMcpHttpStub({ protocolEra: '2026-07-28' });
  const gateway = createDefaultWorkerMcpGateway(coreDb);
  const connections = vi.spyOn(Client.prototype, 'connect');
  const sdkCalls = vi.spyOn(Client.prototype, 'callTool');
  let native: Awaited<ReturnType<typeof createNativeTaskAdmissionFixture>> | undefined;
  let workspaceDb: ReturnType<typeof createTestWorkspaceDb> | undefined;
  let revokedPublication: { turnId: string; inventory: () => string } | undefined;
  // Core Identity85 / Policy60,313,321-335: settle accepted effects, but never import a
  // disabled actor's new output. Task91/93/99 forbids inventing successful closeout.
  onTestFinished(async () => {
    const failures: unknown[] = [];
    if (native) {
      let beforeImport: string | undefined;
      try {
        beforeImport = revokedPublication?.inventory();
      } catch (error) {
        failures.push(error);
      }
      native.executor.completion.resolve();
      if (native.executor.launches > 0) {
        const completion = await outcome(native.executor.execution);
        try {
          if (revokedPublication) {
            expect(beforeImport).toBeDefined();
            if (!('error' in completion))
              throw new Error('Revoked native publication unexpectedly completed.');
            // This one boundary requires its exact exported closed class and safe projection.
            // All other errors, including AggregateError, are rethrown, not filtered by code.
            if (!(completion.error instanceof TurnStartValidationError)) throw completion.error;
            expect(completion.error.constructor).toBe(TurnStartValidationError);
            expect(completion.error).toMatchObject({
              code: 'workspace_access_denied',
              status: 403,
              message: 'Workspace access denied.',
            });
            expect(isCanonicalUserActive(coreDb, userId)).toBe(false);
            expect(revokedPublication.inventory()).toBe(beforeImport);
            const final = getWorkerControlAcceptedFinalStatus(
              coreDb,
              native.executor.nativeLineage!
            );
            expect(final).toMatchObject({ status: 'completed', stopReason: 'completed' });
            expect(store.getTurnById(revokedPublication.turnId).status).not.toBe('completed');
            console.info(
              'G1_REVOKED_PUBLICATION',
              JSON.stringify({
                errorClass: completion.error.name,
                code: completion.error.code,
                status: completion.error.status,
                canonicalActive: false,
                scopedOutputAndReceiptsUnchanged: true,
                acceptedNativeFinalPreserved: true,
                successfulTaskCloseout: false,
              })
            );
          } else if ('error' in completion) {
            throw completion.error;
          }
        } catch (error) {
          // Collect for propagation only; every remaining physical owner must still join.
          failures.push(error);
        }
      }
      await native.restore().catch((error: unknown) => {
        failures.push(error);
      });
    }
    await gateway.close().catch((error: unknown) => {
      failures.push(error);
    });
    await upstream.close().catch((error: unknown) => {
      failures.push(error);
    });
    connections.mockRestore();
    sdkCalls.mockRestore();
    await shutdownControlStoreWorkerClient().catch((error: unknown) => {
      failures.push(error);
    });
    for (const db of [workspaceDb, coreDb]) {
      if (!db) continue;
      try {
        closeTestCoreDb(db);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, 'Real G1 owner cleanup failed.');
    console.info('G1_CLEANUP_JOINED', JSON.stringify({ unexpectedFailures: failures.length }));
  });
  const workspace = await store.createWorkspace('Cached current authority');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = await store.createThread(workspace.id, 'Real cached Worker');
  workspaceDb = createTestWorkspaceDb(root, workspace.id);
  const catalog = {
    schemaVersion: 1 as const,
    servers: [
      {
        id: 'echo',
        enabled: true,
        allowedTools: ['echo'],
        credentialBindings: [],
        pinnedSchemaSnapshotId: null,
        packageRootDigest: null,
        schemaPolicy: 'tracking' as const,
        timeoutMs: 2000,
        transport: { kind: 'http' as const, endpoint: upstream.url, headers: {} },
      },
    ],
  };
  const setup = createTestAgentSetup({
    mcpIds: ['echo'],
    requiredCapabilities: ['trusted-worker-inference-relay'],
  });
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot: root,
    gatewayConfig: createTestGatewayConfig(),
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        displayName: 'G1 local peer',
        kind: 'local',
        models: ['openai/gpt-5.2'],
      },
    ]),
    workspaceConfigs: loadRuntimeConfig(root).workspaceConfigs,
    agentManifests: [setup.manifest],
    workspaceMcpServerCatalogs: [
      { catalog, path: join(root, 'catalog.json'), workspaceId: workspace.id },
    ],
  });
  native = await createNativeTaskAdmissionFixture(coreDb, store, {
    readRuntimeConfig: () => snapshot,
  });
  admitTestNativeEnvironment(coreDb, setup.manifest);
  const app = createAppWithLocalIdentity({
    coreDb,
    dataRoot: root,
    store,
    localUserId: userId,
    mode: 'local',
    workerMcpGateway: gateway,
    fileAdmission: native.fileAdmission,
    turnExecutor: native.executor,
    workerControlGateway: native.workerControlGateway,
    runtimeConfigManager: createRuntimeConfigManager({ dataRoot: null, initialSnapshot: snapshot }),
  });
  const started = await app.request(
    ...operationRequest(
      'task.start',
      { workspaceId: workspace.id, threadId: thread.id },
      {
        body: JSON.stringify({ input: 'Use the real cached Tool', requestId: randomUUID() }),
      }
    )
  );
  expect(started.status, await started.clone().text()).toBe(202);
  const admitted = await started.json();
  const execution = native.executionFor(admitted.turn.id);
  await execution.launched.promise;
  await native.waitForStartup(admitted.turn.id);
  const pkg = native.workerControlGateway.authenticatePackageToken(
    `Bearer ${native.executor.capabilityToken}`,
    { tokenFamily: 'capability' }
  );
  expect(pkg.scope).toMatchObject({
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: admitted.turn.id,
    triggerActor: { kind: 'user', id: userId },
  });
  const call = async (id: number, message: string) => {
    const response = await app.request('/api/worker-capabilities/mcp/echo', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${native!.executor.capabilityToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message } },
      }),
    });
    return response.json();
  };
  const originalCall = gateway.callTool.bind(gateway);
  let warmInput: Parameters<typeof gateway.callTool>[0] | undefined;
  let changeAuthority = false;
  let interposed = false;
  const dispatch = vi.spyOn(gateway, 'callTool').mockImplementation(async (input) => {
    if (!changeAuthority) {
      warmInput = input;
      return originalCall(input);
    }
    if (!warmInput) throw new Error('The genuine warm call was not reached.');
    // Only original session fields decide this premise; operation arguments/signals are not keys.
    const identity = (value: WorkerMcpGatewayServerInput) =>
      JSON.stringify({
        workspaceId: value.workspaceId,
        server: value.server,
        credentials: value.credentials,
      });
    expect(
      identity(input) === identity(warmInput),
      'The original cached session identity must be reused.'
    ).toBe(true);
    expect(
      gateway.getServerHealth(input),
      'The cached healthy premise must be real and reached.'
    ).toBe('ready');
    expect(isCanonicalUserActive(coreDb, userId)).toBe(true);
    const disabled = await app.request(
      ...operationRequest(
        'user.disable',
        { targetUserId: userId },
        {
          body: JSON.stringify({ requestId: randomUUID() }),
        }
      )
    );
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    expect((await disabled.json()).user.status).toBe('disabled');
    expect(isCanonicalUserActive(coreDb, userId)).toBe(false);
    expect(
      gateway.getServerHealth(input),
      'A fresh-connect refusal is not this cached regression.'
    ).toBe('ready');
    interposed = true;
    // Real consumer, unchanged input and result: no injected authorization error or future callback.
    return originalCall(input);
  });
  onTestFinished(() => dispatch.mockRestore());
  expect(await call(1, 'real warm success')).toMatchObject({
    result: { content: [{ text: 'real warm success' }] },
  });
  if (!warmInput) throw new Error('The actual warm Gateway invocation was not observed.');
  expect(gateway.getServerHealth(warmInput)).toBe('ready');
  // The ordinary fixture records actual HTTP requests; handler markers belong only to its
  // separate schema-fault mode. This sole-Tool endpoint must observe real tools/call traffic.
  const contacts = () =>
    upstream.observed.filter((event) => event.endsWith('|POST|tools/call')).length;
  const usage = () =>
    listWorkspaceUsageRecords(workspaceDb!, workspace.id).filter(
      (record) => record.category === 'tool' && record.providerRef === 'echo'
    );
  const calls = () =>
    listWorkspaceCapabilityCalls(workspaceDb!, workspace.id).filter(
      (record) => record.operation === 'mcp.call-tool'
    );
  const oldCalls = calls();
  expect(oldCalls).toHaveLength(1);
  expect(oldCalls[0]).toMatchObject({ status: 'succeeded' });
  const oldUsage = usage();
  expect(oldUsage).toEqual([
    expect.objectContaining({ quantity: 1, unit: 'tool_calls', capabilityCallId: oldCalls[0]!.id }),
  ]);
  const oldContacts = contacts();
  expect(oldContacts).toBeGreaterThan(0);
  const oldConnections = connections.mock.calls.length;
  const oldSdkCalls = sdkCalls.mock.calls.length;
  const warmClient = sdkCalls.mock.contexts.at(-1);
  expect(warmClient).toBeDefined();
  changeAuthority = true;
  const response = await call(2, 'must never contact this Tool');
  expect(interposed, 'Both warm cache and genuine authority refusal must be reached.').toBe(true);
  const terminal = calls().filter((record) => !oldCalls.some((prior) => prior.id === record.id));
  console.info(
    'G1_CACHED_AUTHORITY',
    JSON.stringify({
      interposed,
      canonicalActive: isCanonicalUserActive(coreDb, userId),
      newContacts: contacts() - oldContacts,
      newConnections: connections.mock.calls.length - oldConnections,
      sdkReused: sdkCalls.mock.contexts.slice(oldSdkCalls).some((client) => client === warmClient),
      errorCode: response.error?.data?.code,
      errorStatus: response.error?.data?.status,
      terminalStatuses: terminal.map((record) => record.status),
      newToolUsage: usage().length - oldUsage.length,
    })
  );
  // Soft product checks preserve all reached evidence instead of hiding quantity behind status RED.
  expect.soft(response).toMatchObject({
    error: { message: 'MCP tool call was denied.', data: { code: 'mcp-denied', status: 403 } },
  });
  expect.soft(response.result).toBeUndefined();
  expect.soft(JSON.stringify(response)).not.toContain('must never contact this Tool');
  expect.soft(contacts()).toBe(oldContacts);
  expect.soft(connections.mock.calls.length).toBe(oldConnections);
  expect.soft(usage()).toEqual(oldUsage);
  expect.soft(usage().reduce((total, record) => total + record.quantity, 0)).toBe(1);
  expect.soft(terminal).toEqual([
    expect.objectContaining({
      status: 'denied',
      errorCode: 'mcp-denied',
      completedAt: expect.any(String),
    }),
  ]);
  expect.soft(response.error?.data?.details?.upstreamEffect).not.toBe('unknown');
  expect.soft(response.error?.data?.details?.upstreamEffect).not.toBe('contacted');
  if (terminal.length === 1)
    expect
      .soft(
        listWorkspaceAuditEvents(workspaceDb, workspace.id).filter(
          (event) =>
            event.capabilityCallId === terminal[0]!.id && event.action === 'capability.finish'
        )
      )
      .toHaveLength(1);
  // Enable this separate fixture assertion only after every original G1 deciding observation.
  // Snapshot only scoped output and canonical admission/interrupt receipts, not technical status.
  revokedPublication = {
    turnId: admitted.turn.id,
    inventory: () =>
      JSON.stringify({
        items: store
          .listAllItems()
          .filter(
            (item) =>
              item.turnId === admitted.turn.id &&
              ['assistant-message', 'artifact'].includes(item.type)
          ),
        artifacts: store.listArtifacts(workspace.id),
        reviews: listArtifactReviews(workspaceDb!),
        receipts: store
          .listCommandRequests(workspace.id)
          .filter(
            (receipt) => receipt.command === 'task.start' || receipt.command === 'turn.interrupt'
          ),
      }),
  };
});

// F2 observes actual initialization publication and the original physical cleanup owner.
// No Tool entry can prove that already materialized credentials left that owned process.
it('retains the original credential teardown fence when an initialized call resumes before Tool entry', async () => {
  const { Client } = await import('@modelcontextprotocol/client');
  const { createHash } = await import('node:crypto');
  const f = await fixture(true);
  if (!f.ws) throw new Error('The F2 consumer requires its real Workspace.');
  const gateway = f.gateway();
  const descendantFile = join(f.root, 'f2-descendant.json');
  const credential = 'f2-owned-process-fixture-canary';
  const input = {
    ...f.input(),
    credentials: {
      environment: {
        OPENKIT_MCP_DESCENDANT_PID_FILE: descendantFile,
        OPENKIT_MCP_DESCENDANT_SECRET: credential,
      },
    },
  };
  const initialized = Promise.withResolvers<void>();
  const publication = Promise.withResolvers<void>();
  const actualConnect = Client.prototype.connect;
  let initializationFulfilled = false;
  let activeSettled = false;
  let connectCount = 0;
  let sdkCallMethodEntries = 0;
  const connected = vi.spyOn(Client.prototype, 'connect').mockImplementation(async function (
    this: import('@modelcontextprotocol/client').Client,
    ...args
  ) {
    connectCount++;
    const result = await actualConnect.apply(this, args);
    // This is a real SDK fulfillment, not a fabricated response or readiness setter.
    expect(this.getServerVersion()?.name).toBe('openkit-stdio-stub');
    initializationFulfilled = true;
    initialized.resolve();
    await publication.promise;
    return result;
  });
  const actualCall = Client.prototype.callTool;
  const sdkCalls = vi.spyOn(Client.prototype, 'callTool').mockImplementation(
    new Proxy(actualCall, {
      apply(target, receiver, args: unknown[]) {
        sdkCallMethodEntries++;
        return Reflect.apply(target, receiver, args);
      },
    })
  );
  const kill = process.kill.bind(process);
  let groupId = 0;
  let serverPid = 0;
  let descendantPid = 0;
  let refuse = true;
  let phase: 'refusal' | 'retry' = 'refusal';
  const deliveries: Array<{ pid: number; signal: unknown; phase: string; refused: boolean }> = [];
  const signals = vi.spyOn(process, 'kill').mockImplementation(
    new Proxy(kill, {
      apply(target, receiver, args: unknown[]) {
        const pid = Number(args[0]);
        const signal = args[1];
        const selected =
          groupId > 0 &&
          ((pid === -groupId && (signal === 'SIGTERM' || signal === 'SIGKILL')) ||
            (pid === groupId && signal === 'SIGTERM'));
        if (selected) {
          deliveries.push({ pid, signal, phase, refused: refuse });
          if (refuse) throw Object.assign(new Error('owned F2 signal refused'), { code: 'EPERM' });
        }
        // Every presence probe and unrelated process operation remains genuine.
        return Reflect.apply(target, receiver, args);
      },
    })
  );
  const calls = () => (existsSync(f.callsFile) ? readFileSync(f.callsFile, 'utf8') : '');
  const active = outcome(
    gateway.callTool({
      ...input,
      arguments: { message: 'f2-pre-tool-teardown' },
      toolName: 'echo',
    })
  ).then((result) => {
    activeSettled = true;
    return result;
  });
  let teardown: Outcome<void> | undefined;
  let activeResult: Outcome<unknown> | undefined;
  let fenceBefore: Outcome<unknown> | undefined;
  let fenceAfter: Outcome<unknown> | undefined;
  let originalRetryProved = false;
  try {
    await Promise.race([
      initialized.promise,
      active.then(() => {
        throw new Error('F2 initialization publication was not reached.');
      }),
    ]);
    expect(initializationFulfilled).toBe(true);
    expect(activeSettled).toBe(false);
    expect(calls()).toBe('');
    const receipt: unknown = JSON.parse(readFileSync(descendantFile, 'utf8'));
    if (
      !record(receipt) ||
      typeof receipt.pid !== 'number' ||
      typeof receipt.supervisorPid !== 'number'
    ) {
      throw new Error('The real original descendant receipt is unavailable.');
    }
    descendantPid = receipt.pid;
    groupId = receipt.supervisorPid;
    serverPid = Number(readFileSync(f.pidFile, 'utf8'));
    expect(receipt.credentialDigest).toBe(createHash('sha256').update(credential).digest('hex'));
    expect(Number.isSafeInteger(groupId) && groupId > 0).toBe(true);
    expect(f.contacts()).toEqual([groupId]);
    expect(kill(-groupId, 0)).toBe(true);
    expect(kill(descendantPid, 0)).toBe(true);
    expect(kill(serverPid, 0)).toBe(true);

    teardown = await outcome(gateway.closeWorkspace(f.ws.id));
    expect(teardown).toMatchObject({
      error: expect.objectContaining({
        message: 'MCP stdio process group remained addressable after SIGKILL.',
      }),
    });
    expect(
      deliveries.some(
        (entry) => entry.refused && entry.pid === -groupId && entry.signal === 'SIGTERM'
      )
    ).toBe(true);
    expect(
      deliveries.some(
        (entry) => entry.refused && entry.pid === -groupId && entry.signal === 'SIGKILL'
      )
    ).toBe(true);
    expect(kill(-groupId, 0)).toBe(true);
    expect(kill(descendantPid, 0)).toBe(true);
    expect(activeSettled).toBe(false);
    fenceBefore = await outcome(gateway.listTools(input));
    expect(fenceBefore).toMatchObject({
      error: { code: 'recovery_required', status: 409, credentialsMaterialized: true },
    });
    expect(connectCount).toBe(1);
    expect(f.rows().some((event) => event.action === 'mcp.server.lifecycle.inactive')).toBe(false);

    // Resume the original real fulfillment only after its actual cleanup has rejected.
    publication.resolve();
    activeResult = await active;
    expect.soft(activeResult).toMatchObject({
      error: {
        code: 'recovery_required',
        status: 409,
        credentialsMaterialized: true,
      },
    });
    expect.soft(calls()).toBe('');
    fenceAfter = await outcome(gateway.listTools(input));
    expect.soft(fenceAfter).toMatchObject({
      error: { code: 'recovery_required', status: 409, credentialsMaterialized: true },
    });
    expect.soft(connectCount).toBe(1);
    expect.soft(f.contacts()).toEqual([groupId]);
    expect(kill(-groupId, 0)).toBe(true);
    expect(kill(descendantPid, 0)).toBe(true);
    expect
      .soft(f.rows().some((event) => event.action === 'mcp.server.lifecycle.inactive'))
      .toBe(false);
    expect.soft(JSON.stringify(f.rows())).not.toContain(credential);

    refuse = false;
    phase = 'retry';
    await gateway.closeWorkspace(f.ws.id);
    expect(
      deliveries.some(
        (entry) => entry.phase === 'retry' && !entry.refused && entry.pid === -groupId
      )
    ).toBe(true);
    for (const pid of [serverPid, descendantPid, -groupId]) {
      expect(() => kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    }
    expect(gateway.getServerHealth(input)).toBe('inactive');
    expect(f.rows().some((event) => event.action === 'mcp.server.lifecycle.inactive')).toBe(true);
    expect(connectCount).toBe(1);
    expect(f.contacts()).toEqual([groupId]);
    originalRetryProved = true;
  } finally {
    refuse = false;
    phase = 'retry';
    publication.resolve();
    // Keep every real result observed and release only the original owner's processes.
    await active;
    try {
      await gateway.closeWorkspace(f.ws.id);
      await gateway.close();
    } finally {
      signals.mockRestore();
      connected.mockRestore();
      sdkCalls.mockRestore();
    }
    console.info(
      'F2_OWNER_WITNESS',
      JSON.stringify({
        initializationFulfilled,
        teardown:
          teardown === undefined ? 'missing' : 'error' in teardown ? 'rejected' : 'fulfilled',
        activeError:
          activeResult && 'error' in activeResult && record(activeResult.error)
            ? {
                code: activeResult.error.code,
                status: activeResult.error.status,
                credentialsMaterialized: activeResult.error.credentialsMaterialized,
                upstreamEffect: activeResult.error.upstreamEffect,
              }
            : null,
        fenceBefore:
          fenceBefore && 'error' in fenceBefore && record(fenceBefore.error)
            ? fenceBefore.error.code
            : null,
        fenceAfter:
          fenceAfter && 'error' in fenceAfter && record(fenceAfter.error)
            ? fenceAfter.error.code
            : null,
        refusedOriginalSignals: deliveries.filter((entry) => entry.refused).length,
        retryOriginalSignals: deliveries.filter((entry) => !entry.refused).length,
        connectCount,
        sdkCallMethodEntries,
        actualChildToolRequests: calls() === '' ? 0 : calls().trim().split('\n').length,
        originalRetryProved,
      })
    );
  }
});
