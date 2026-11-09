/// <reference lib="es2024.sharedmemory" />
import { createHash, randomUUID } from 'node:crypto';
import fs, { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { CATALOG_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import {
  createCatalogOperationImplementations,
  prepareCatalogSkillDecision,
} from '../catalog/catalog-operations.js';
import {
  catalogDocumentPath,
  createMcpConfig,
  loadWorkspaceResourceCatalog,
  submitWorkspaceSkillCandidate,
  validateCatalogTree,
} from '../catalog/resource-catalog.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb, createTestWorkspaceDb } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  ControlStoreWorkerError,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { ensureWorkspaceLayout } from './fs-layout.js';

// L2: Core Storage / SQLite Layers; Core Evidence / Audit Invariants; MCP Catalog / Storage.
// Actual physical publication -> original standalone event -> real refresh/result/borrowed close.
const fault = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  messages: [] as unknown[],
  gate: new SharedArrayBuffer(12 * Int32Array.BYTES_PER_ELEMENT),
  targets: new SharedArrayBuffer(4096),
  publicationSha: new SharedArrayBuffer(64),
}));

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const index = fault.workers.length;
        // Call through real SQL. Observe INSERT refusal separately from a committed new row.
        const prelude = String.raw`
          const {workerData} = require('node:worker_threads');
          const {readFileSync} = require('node:fs');
          const {createHash} = require('node:crypto');
          const Database = require(workerData.auditSqlModule);
          const exec = Database.prototype.exec, prepare = Database.prototype.prepare;
          const gate = workerData.auditGate, before = new WeakMap(), inserted = new WeakMap(), published = new WeakMap();
          const targets = () => JSON.parse(Buffer.from(workerData.auditTargets).toString('utf8').split('\0')[0]);
          const hash = bytes => createHash('sha256').update(bytes).digest('hex');
          function ids(db, target) {
            if (!prepare.call(db, "SELECT 1 FROM sqlite_master WHERE name='audit_events'").get()) return [];
            return prepare.call(db, 'SELECT audit_event_id AS id FROM audit_events WHERE action=? AND request_id=? AND resource=?')
              .all(target.action, target.requestId, target.resource).map(row => row.id);
          }
          function publication(target) {
            try {
              const bytes = readFileSync(target.publication.path), sha = hash(bytes), catalog = JSON.parse(bytes);
              const p = target.publication;
              if (catalog.revision !== p.revision || (p.knownHash && p.knownHash !== sha)) return false;
              if (p.section) {
                const group = catalog[p.section], entry = group.entries.find(row => row.id === p.entryId);
                if (!entry || !group.versions.some(row => row.entryId === p.entryId && row.digest === p.digest)) return false;
                if (p.currentDigest !== undefined && entry.currentVersionDigest !== p.currentDigest) return false;
                if (p.availability && entry.availability !== p.availability) return false;
                if (p.binding) {
                  const binding = group.bindings.find(row => row.entryId === p.entryId);
                  if (!binding || !Object.entries(p.binding).every(([key,value]) => JSON.stringify(binding[key]) === JSON.stringify(value))) return false;
                }
                if (p.section === 'plugins' && !group.installations.some(row => row.pluginId === p.entryId && row.versionDigest === p.digest)) return false;
              }
              for (const file of p.files || []) if (hash(readFileSync(file.path)) !== file.sha256) return false;
              new Uint8Array(workerData.auditPublicationSha).set(Buffer.from(sha, 'ascii'));
              return true;
            } catch { return false; }
          }
          Database.prototype.prepare = function(sql) {
            const statement = prepare.call(this, sql);
            if (/INSERT\s+INTO\s+audit_events\b/i.test(sql)) {
              const run = statement.run;
              statement.run = function(...args) {
                const selected = targets();
                try { return run.apply(this, args); }
                finally {
                  selected.forEach((target, slot) => {
                    if (args.includes(target.action) && args.includes(target.requestId) && args.includes(target.resource))
                      Atomics.store(gate, slot * 6 + 5, 1);
                  });
                }
              };
            }
            return statement;
          };
          Database.prototype.exec = function(sql) {
            const selected = targets();
            if (sql === 'SAVEPOINT control_transition') {
              before.set(this, selected.map(target => new Set(ids(this, target))));
              // This read precedes actual native INSERT, not merely delivery of the COMMIT hold.
              published.set(this, selected.map(target => publication(target)));
            }
            const result = exec.call(this, sql);
            if (sql === 'RELEASE control_transition' && before.has(this))
              inserted.set(this, selected.map((target, slot) => ids(this, target).some(id => !before.get(this)[slot].has(id))));
            if (/^COMMIT$/i.test(sql) && inserted.has(this)) {
              const changed = inserted.get(this); inserted.delete(this);
              selected.forEach((target, slot) => {
                const base = slot * 6;
                if (changed[slot] && Atomics.compareExchange(gate, base + 1, 1, 0) === 1) {
                  Atomics.store(gate, base + 3, this.pragma('synchronous', {simple:true}));
                  Atomics.store(gate, base + 4, workerData.auditWorkerIndex);
                  Atomics.store(gate, base, published.get(this)?.[slot] === true ? 1 : -2);
                  Atomics.notify(gate, base);
                  Atomics.wait(gate, base + 2, 0);
                }
              });
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
            auditSqlModule: require.resolve('better-sqlite3'),
            auditGate: new Int32Array(fault.gate),
            auditTargets: fault.targets,
            auditPublicationSha: fault.publicationSha,
            auditWorkerIndex: index,
          },
        });
        fault.workers.push(this);
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        // Snapshot the actual header and material before the real post transfers its buffers.
        fault.messages.push(structuredClone(args[0]));
        return super.postMessage(...args);
      }
    },
  };
});

const actions = [
  'catalog.mcp-create',
  'catalog.mcp-stage-version',
  'catalog.mcp-remove',
  'catalog.mcp-select',
  'catalog.mcp-binding',
  'catalog.plugin-import',
] as const;
type Action = (typeof actions)[number];
const endpoint1 = 'https://private-locator-sentinel.invalid/v1';
const endpoint2 = 'https://private-locator-sentinel.invalid/v2';
const pluginBytes = JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'native-plugin',
  version: '1.0.0',
  description: 'private-package-sentinel',
});
const pluginTree = [
  {
    kind: 'file' as const,
    path: 'plugin.json',
    contentBase64: Buffer.from(pluginBytes).toString('base64'),
  },
];
const pluginDigest = validateCatalogTree(pluginTree).digest;

/** Compute the public MCP identity contract independently of the exercised mutation. */
function mcpDigest(endpoint: string) {
  return `sha256:${createHash('sha256')
    .update('openkit-mcp-config-v1\0')
    .update(
      JSON.stringify({
        declaration: { endpoint, headers: {}, kind: 'http' },
        packageRootDigest: null,
      })
    )
    .digest('hex')}`;
}

interface Publication {
  path: string;
  revision: number;
  knownHash?: string;
  section?: 'mcp' | 'plugins';
  entryId?: string;
  digest?: string;
  currentDigest?: string;
  availability?: string;
  binding?: { enabled: boolean; revision: number; allowedTools?: string[] };
  files?: Array<{ path: string; sha256: string }>;
}

/** Same selector and gate position 1 for both calibration controls and every subject. */
function arm(action: string, requestId: string, resource: string, publication: Publication) {
  new Int32Array(fault.gate).fill(0);
  new Uint8Array(fault.publicationSha).fill(0);
  const targets = new Uint8Array(fault.targets);
  targets.fill(0);
  targets.set(
    Buffer.from(
      JSON.stringify([
        {
          action: 'not-selected',
          requestId: 'not-selected',
          resource: 'not-selected',
          publication,
        },
        { action, requestId, resource, publication },
      ])
    )
  );
  Atomics.store(new Int32Array(fault.gate), 7, 1);
}

/** Release and cancel a losing wait; never keep a Main posting pause across an await. */
function release() {
  const gate = new Int32Array(fault.gate);
  for (const base of [0, 6]) {
    Atomics.store(gate, base + 1, 0);
    Atomics.store(gate, base + 2, 1);
    Atomics.notify(gate, base + 2);
    if (Atomics.compareExchange(gate, base, 0, -1) === 0) Atomics.notify(gate, base);
  }
}

/** Count only this original request, not legitimate close/shutdown protocol traffic. */
function targetPosts(requestId: string) {
  return fault.messages.filter((message) =>
    JSON.stringify(message, (_key, value: unknown) =>
      value instanceof Uint8Array
        ? Buffer.from(value).toString('utf8')
        : value instanceof ArrayBuffer
          ? Buffer.from(value).toString('utf8')
          : value
    ).includes(requestId)
  ).length;
}

/** Capture actual completion/rejection before deliberate Worker termination. */
function observed<T>(pending: Promise<T>) {
  return pending.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

/** Existing opaque lifecycle builders own schema setup and cleanup; all product state uses real owners. */
async function fixture() {
  release();
  new Uint8Array(fault.targets).fill(0);
  new Uint8Array(fault.targets).set(Buffer.from('[]'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'catalog-mutation-native-'));
  const coreDb = createTestCoreDb(dataRoot);
  const borrowed: ReturnType<typeof createTestWorkspaceDb>[] = [];
  const pending: Promise<unknown>[] = [];
  let reader: ReturnType<typeof createTestWorkspaceDb> | undefined;
  const allocation = vi.spyOn(fs, 'mkdtempSync');
  syncBuiltinESMExports();
  onTestFinished(async () => {
    release();
    await Promise.allSettled(pending);
    await shutdownControlStoreWorkerClient();
    for (const db of borrowed) closeTestCoreDb(db);
    if (reader) closeTestCoreDb(reader);
    closeTestCoreDb(coreDb);
    allocation.mockRestore();
    syncBuiltinESMExports();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Catalog native Audit');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  reader = createTestWorkspaceDb(dataRoot, workspace.id);
  const owner = { kind: 'workspace' as const, workspaceId: workspace.id };
  const seed = createMcpConfig({
    dataRoot,
    owner,
    id: 'native-mcp',
    expectedRevision: 0,
    createdAt: new Date().toISOString(),
    declaration: { kind: 'http', endpoint: endpoint1 },
    displayName: 'Synthetic MCP',
    allowedTools: ['initial-tool'],
    selectCurrent: true,
  });
  expect(seed.version.digest).toBe(mcpDigest(endpoint1));
  const manager = createRuntimeConfigManager({ dataRoot });
  const reload = vi.spyOn(manager, 'reload'); // Call-through: real candidate validation and publication.
  onTestFinished(() => reload.mockRestore());
  const repositoryWorkspaceDb = (workspaceId: string) => {
    const db = createTestWorkspaceDb(dataRoot, workspaceId);
    borrowed.push(db);
    return db;
  };
  const dependencies = {
    dataRoot,
    coreDb,
    store,
    repositoryWorkspaceDb,
    runtimeConfigManager: manager,
  };
  const context: AdmittedOperationContext = {
    kind: 'public',
    actor: { kind: 'local', userId },
    actorRef: { kind: 'user', id: userId },
    scope: { kind: 'workspace', workspaceId: workspace.id },
  };
  const api = createCatalogOperationImplementations(dependencies);
  const path = catalogDocumentPath(dataRoot, workspace.id);
  const catalog = () => loadWorkspaceResourceCatalog(dataRoot, workspace.id);
  const events = () => listWorkspaceAuditEvents(reader!, workspace.id);
  const scratch = () =>
    allocation.mock.calls.flatMap(([prefix], index) =>
      String(prefix) === join(tmpdir(), 'openkit-plugin-upload-')
        ? [String(allocation.mock.results[index]?.value)]
        : []
    );
  return {
    dataRoot,
    coreDb,
    store,
    workspaceId: workspace.id,
    userId,
    owner,
    context,
    dependencies,
    api,
    path,
    catalog,
    events,
    borrowed,
    reload,
    scratch,
    start<T>(run: () => Promise<T>) {
      const result = observed(Promise.resolve().then(run));
      pending.push(result);
      return result;
    },
    async coldEvents() {
      await shutdownControlStoreWorkerClient();
      const cold = createTestWorkspaceDb(dataRoot, workspace.id);
      try {
        return listWorkspaceAuditEvents(cold, workspace.id);
      } finally {
        closeTestCoreDb(cold);
      }
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Build six public inputs before dispatch, preserving each original action and resource identity. */
function scenario(f: Fixture, action: Action, stale = false) {
  if (action === 'catalog.mcp-select')
    createMcpConfig({
      dataRoot: f.dataRoot,
      owner: f.owner,
      id: 'native-mcp',
      expectedRevision: 1,
      createdAt: new Date().toISOString(),
      declaration: { kind: 'http', endpoint: endpoint2 },
      displayName: 'Synthetic MCP',
      selectCurrent: false,
    });
  const prior = f.catalog();
  const requestId = randomUUID();
  const common = {
    workspaceId: f.workspaceId,
    requestId,
    expectedRevision: stale ? 0 : prior.revision,
  };
  const publication: Publication = {
    path: f.path,
    revision: prior.revision + 1,
    section: 'mcp',
    entryId: 'native-mcp',
    digest: mcpDigest(endpoint1),
    currentDigest: mcpDigest(endpoint1),
  };
  let resource = 'mcp:native-mcp';
  let run: () => Promise<unknown>;
  switch (action) {
    case 'catalog.mcp-create': {
      const input = CATALOG_OPERATION_DEFINITIONS[action].inputSchema.parse({
        ...common,
        id: 'new-mcp',
        displayName: 'New MCP',
        allowedTools: ['binding-payload-sentinel'],
        declaration: { kind: 'http', endpoint: endpoint2 },
      });
      publication.entryId = 'new-mcp';
      publication.digest = mcpDigest(endpoint2);
      publication.currentDigest = publication.digest;
      run = () => f.api[action](input, f.context);
      resource = `mcp:new-mcp@${publication.digest}`;
      break;
    }
    case 'catalog.mcp-stage-version': {
      const input = CATALOG_OPERATION_DEFINITIONS[action].inputSchema.parse({
        ...common,
        mcpId: 'native-mcp',
        displayName: 'Staged MCP',
        allowedTools: ['binding-payload-sentinel'],
        declaration: { kind: 'http', endpoint: endpoint2 },
      });
      publication.digest = mcpDigest(endpoint2);
      run = () => f.api[action](input, f.context);
      resource = `mcp:native-mcp@${publication.digest}`;
      break;
    }
    case 'catalog.mcp-remove': {
      const input = CATALOG_OPERATION_DEFINITIONS[action].inputSchema.parse({
        ...common,
        mcpId: 'native-mcp',
      });
      publication.availability = 'removed';
      publication.binding = { enabled: false, revision: 2 };
      run = () => f.api[action](input, f.context);
      break;
    }
    case 'catalog.mcp-select': {
      const input = CATALOG_OPERATION_DEFINITIONS[action].inputSchema.parse({
        ...common,
        mcpId: 'native-mcp',
        digest: mcpDigest(endpoint2),
        expectedCurrentDigest: mcpDigest(endpoint1),
      });
      publication.digest = mcpDigest(endpoint2);
      publication.currentDigest = publication.digest;
      run = () => f.api[action](input, f.context);
      resource = `mcp:native-mcp@${publication.digest}`;
      break;
    }
    case 'catalog.mcp-binding': {
      const input = CATALOG_OPERATION_DEFINITIONS[action].inputSchema.parse({
        ...common,
        mcpId: 'native-mcp',
        bindingRevision: 1,
        enabled: true,
        allowedTools: ['binding-payload-sentinel'],
        schemaPolicy: 'tracking',
      });
      publication.binding = {
        enabled: true,
        revision: 2,
        allowedTools: ['binding-payload-sentinel'],
      };
      run = () => f.api[action](input, f.context);
      break;
    }
    case 'catalog.plugin-import': {
      const input = CATALOG_OPERATION_DEFINITIONS[action].inputSchema.parse({
        ...common,
        pluginId: 'native-plugin',
        tree: pluginTree,
      });
      publication.section = 'plugins';
      publication.entryId = 'native-plugin';
      publication.digest = pluginDigest;
      delete publication.currentDigest;
      publication.files = [
        {
          path: join(
            ensureWorkspaceLayout(f.dataRoot, f.workspaceId).catalogPluginSnapshots,
            'native-plugin',
            pluginDigest.slice(7),
            'plugin.json'
          ),
          sha256: createHash('sha256').update(pluginBytes).digest('hex'),
        },
      ];
      run = () => f.api[action](input, f.context);
      resource = `plugin:native-plugin@${pluginDigest}`;
      break;
    }
  }
  return { action, requestId, resource, publication, run, prior, startedAt: Date.now() };
}
type Scenario = ReturnType<typeof scenario>;

/** A post-effect public result is a decisive OLD witness, never a substitute for native admission. */
async function held<T>(f: Fixture, result: Promise<T>) {
  const gate = new Int32Array(fault.gate);
  const wait = Atomics.waitAsync(gate, 6, 0);
  const outcome = await Promise.race([
    Promise.resolve(wait.value).then(() => 'held'),
    result.then(() => 'settled'),
  ]);
  if (outcome !== 'held')
    console.error(
      JSON.stringify(
        {
          completion: await result,
          observation: 'catalog-mutation-before-native-ack',
          outcome,
          revision: f.catalog().revision,
          catalogSha256: createHash('sha256').update(readFileSync(f.path)).digest('hex'),
          events: f.events().map((event) => ({
            action: event.action,
            resource: event.resource,
            requestId: event.requestId,
            resourceRevision: event.resourceRevision,
          })),
          borrowedOpen: f.borrowed.map((db) => db.sqlite.open),
          reloads: f.reload.mock.calls.length,
          nativeInsertAttempt: Atomics.load(gate, 11),
          full: Atomics.load(gate, 9),
        },
        (_key, value: unknown) =>
          value instanceof Error ? { name: value.name, message: value.message } : value
      )
    );
  expect(
    outcome,
    'The published Catalog effect must await its actual native FULL/ACK before refresh, result and borrowed close.'
  ).toBe('held');
  expect(
    Atomics.load(gate, 6),
    'Exact expected physical publication must precede actual native SQL.'
  ).toBe(1);
  expect(Atomics.load(gate, 11)).toBe(1);
  expect(Atomics.load(gate, 9)).toBe(2);
  expect(Buffer.from(fault.publicationSha).toString('ascii')).toBe(
    createHash('sha256').update(readFileSync(f.path)).digest('hex')
  );
  const worker = fault.workers[Atomics.load(gate, 10)];
  expect(worker?.threadId).toBeGreaterThan(0);
  expect(Atomics.load(gate, 0)).toBe(0);
  return worker!;
}

/** Original owner facts, complete allowlisted event, historical time and redaction; no receipt oracle. */
function originalEvent(f: Fixture, s: Scenario) {
  const rows = f.events().filter((event) => event.requestId === s.requestId);
  expect(rows).toHaveLength(1);
  const event = rows[0]!;
  expect(event).toEqual({
    id: expect.stringMatching(/^aud_/),
    workspaceId: f.workspaceId,
    threadId: null,
    turnId: null,
    itemId: null,
    capabilityCallId: null,
    permissionDecisionId: null,
    vaultGrantId: null,
    requestId: s.requestId,
    actor: { kind: 'user', id: f.userId },
    authentication: { credentialKind: 'local', credentialId: null },
    subject: null,
    agentId: null,
    agentSessionId: null,
    category: 'command',
    action: s.action,
    resource: s.resource,
    resourceRevision: s.publication.revision,
    outcome: 'succeeded',
    severity: 'info',
    summary: 'Catalog mutation completed.',
    errorCode: null,
    createdAt: expect.any(String),
    occurredAt: expect.any(String),
  });
  for (const time of [event.createdAt, event.occurredAt]) {
    if (typeof time !== 'string') throw new Error('Original Audit timestamp is missing.');
    expect(Date.parse(time)).toBeGreaterThanOrEqual(s.startedAt);
    expect(Date.parse(time)).toBeLessThanOrEqual(Date.now());
  }
  for (const privateValue of [
    'private-locator-sentinel',
    'binding-payload-sentinel',
    'private-package-sentinel',
    pluginTree[0]!.contentBase64,
    f.dataRoot,
    ...f.scratch(),
  ])
    expect(JSON.stringify(event)).not.toContain(privateValue);
  return event;
}

it.each([
  { label: 'positive', correct: true },
  { label: 'negative', correct: false },
])(
  '$label calibrates actual existing admission with SAME target 1 and gate 1',
  async ({ correct }) => {
    const f = await fixture();
    const tree = [
      {
        kind: 'file' as const,
        path: 'SKILL.md',
        contentBase64: Buffer.from(
          '---\nname: native-control\ndescription: Real control.\n---\nSynthetic only.\n'
        ).toString('base64'),
      },
    ];
    const submitted = submitWorkspaceSkillCandidate({
      baseDigest: null,
      createdAt: new Date().toISOString(),
      entryId: 'native-control',
      expectedRevision: f.catalog().revision,
      dataRoot: f.dataRoot,
      workspaceId: f.workspaceId,
      tree,
      producer: { kind: 'user', id: f.userId },
      summary: 'Observer calibration only.',
    });
    const requestId = randomUUID();
    const publication = {
      path: f.path,
      revision: f.catalog().revision,
      knownHash: correct
        ? createHash('sha256').update(readFileSync(f.path)).digest('hex')
        : '0'.repeat(64),
    };
    arm(
      'catalog.skill-candidate-decide.admit',
      requestId,
      `skill-candidate:${submitted.candidate.id}`,
      publication
    );
    const result = f.start(() =>
      prepareCatalogSkillDecision(
        f.dependencies,
        {
          candidateId: submitted.candidate.id,
          decision: 'rejected',
          expectedRevision: f.catalog().revision,
          operation: 'catalog.skill-candidate-decide',
          requestId,
          workspaceId: f.workspaceId,
        },
        f.context
      )
    );
    if (correct) await held(f, result);
    else {
      await expect(held(f, result)).rejects.toThrow(
        'Exact expected physical publication must precede actual native SQL'
      );
      expect(Atomics.load(new Int32Array(fault.gate), 6)).toBe(-2);
      expect(Atomics.load(new Int32Array(fault.gate), 9)).toBe(2);
      expect(Atomics.load(new Int32Array(fault.gate), 11)).toBe(1);
      expect(fault.workers[Atomics.load(new Int32Array(fault.gate), 10)]?.threadId).toBeGreaterThan(
        0
      );
    }
    expect(
      f.events().filter((event) => event.action === 'catalog.skill-candidate-decide.admit')
    ).toHaveLength(1);
    expect(targetPosts(requestId)).toBe(1);
    expect(f.reload).not.toHaveBeenCalled();
    release();
    expect((await result).ok).toBe(true);
  }
);

it.each(actions)(
  '%s publishes exact original completion before native FULL and ACK before refresh/result/close',
  async (action) => {
    const f = await fixture(),
      s = scenario(f, action);
    arm(action, s.requestId, s.resource, s.publication);
    const result = f.start(s.run);
    await held(f, result);
    expect(f.catalog().revision).toBe(s.publication.revision);
    expect(f.borrowed).toHaveLength(1);
    expect(f.borrowed[0]!.sqlite.open).toBe(true);
    expect(f.reload).not.toHaveBeenCalled();
    const event = originalEvent(f, s),
      bytes = readFileSync(f.path);
    if (action === 'catalog.plugin-import') {
      expect(f.scratch()).toHaveLength(1);
      expect(fs.existsSync(f.scratch()[0]!)).toBe(true);
      expect(readFileSync(s.publication.files![0]!.path, 'utf8')).toBe(pluginBytes);
    }
    release();
    const outcome = await result;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value).toMatchObject({ revision: s.publication.revision });
    expect(f.reload).toHaveBeenCalledExactlyOnceWith({ dryRun: false, mode: 'safe' });
    expect(f.borrowed[0]!.sqlite.open).toBe(false);
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(f.events().find((row) => row.id === event.id)).toEqual(event);
    for (const path of f.scratch()) expect(fs.existsSync(path)).toBe(false);
    expect(await f.coldEvents()).toEqual(f.events());
  }
);

it('lost Plugin ACK retains the original physical package and cold prefix without refresh, repost or repair', async () => {
  const f = await fixture(),
    s = scenario(f, 'catalog.plugin-import');
  arm(s.action, s.requestId, s.resource, s.publication);
  const result = f.start(s.run),
    worker = await held(f, result);
  originalEvent(f, s);
  const bytes = readFileSync(f.path),
    physical = statSync(f.path, { bigint: true }),
    prefix = f.events(),
    posts = targetPosts(s.requestId);
  expect(posts).toBe(1);
  expect(f.scratch()).toHaveLength(1);
  expect(fs.existsSync(f.scratch()[0]!)).toBe(true);
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.borrowed[0]!.sqlite.open).toBe(true);
  await worker.terminate();
  const outcome = await result;
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error).toBeInstanceOf(Error);
  expect(targetPosts(s.requestId)).toBe(posts);
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.borrowed[0]!.sqlite.open).toBe(false);
  expect(readFileSync(f.path)).toEqual(bytes);
  expect(statSync(f.path, { bigint: true })).toMatchObject({
    ino: physical.ino,
    mtimeNs: physical.mtimeNs,
  });
  expect(readFileSync(s.publication.files![0]!.path, 'utf8')).toBe(pluginBytes);
  expect(f.events()).toEqual(prefix);
  expect(await f.coldEvents()).toEqual(prefix);
  expect(readFileSync(f.path)).toEqual(bytes);
  expect(targetPosts(s.requestId)).toBe(posts);
  for (const path of f.scratch()) expect(fs.existsSync(path)).toBe(false);
});

it('real binding INSERT refusal preserves publication and cold empty prefix without refresh or repeat', async () => {
  const f = await fixture(),
    s = scenario(f, 'catalog.mcp-binding');
  // Notebook initialization is legitimate prior evidence; only the target Audit prefix is empty.
  const prefix = f.events();
  const db = createTestWorkspaceDb(f.dataRoot, f.workspaceId);
  // Explicit fault only after genuine setup; the real SQLite writer rejects this exact event.
  db.sqlite.exec(
    `CREATE TRIGGER synthetic_catalog_refusal BEFORE INSERT ON audit_events WHEN NEW.action='catalog.mcp-binding' AND NEW.request_id='${s.requestId}' BEGIN SELECT RAISE(ABORT,'synthetic-catalog-refusal'); END`
  );
  onTestFinished(() => closeTestCoreDb(db));
  arm(s.action, s.requestId, s.resource, s.publication);
  const result = await f.start(s.run);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    // The native owner redacts SQLite causes; typed certainty and the INSERT gate prove refusal.
    expect(result.error).toBeInstanceOf(ControlStoreWorkerError);
    expect(result.error).toMatchObject({
      message: 'Control database writer operation failed.',
      code: 'constraint',
      commit: 'not-committed',
    });
  }
  expect(f.catalog().revision).toBe(s.publication.revision);
  expect(f.catalog().mcp.bindings.find((row) => row.entryId === 'native-mcp')).toMatchObject(
    s.publication.binding!
  );
  console.error(
    JSON.stringify({
      observation: 'real-refusal-after-publication',
      revision: f.catalog().revision,
      nativeInsertAttempt: Atomics.load(new Int32Array(fault.gate), 11),
      reloads: f.reload.mock.calls.length,
      borrowedOpen: f.borrowed.map((row) => row.sqlite.open),
      auditRows: f.events().length,
    })
  );
  expect(
    Atomics.load(new Int32Array(fault.gate), 11),
    'Refusal must be the actual selected native INSERT, not Main SQL or decoder failure.'
  ).toBe(1);
  const bytes = readFileSync(f.path),
    physical = statSync(f.path, { bigint: true }),
    posts = targetPosts(s.requestId);
  expect(posts).toBe(1);
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.borrowed[0]!.sqlite.open).toBe(false);
  expect(f.events()).toEqual(prefix);
  expect(await f.coldEvents()).toEqual(prefix);
  expect(readFileSync(f.path)).toEqual(bytes);
  expect(statSync(f.path, { bigint: true })).toMatchObject({
    ino: physical.ino,
    mtimeNs: physical.mtimeNs,
  });
  expect(targetPosts(s.requestId)).toBe(posts);
});

it('stale Plugin CAS keeps physical bytes and original conflict while cleaning its actual private scratch', async () => {
  const f = await fixture(),
    s = scenario(f, 'catalog.plugin-import', true);
  const bytes = readFileSync(f.path),
    physical = statSync(f.path, { bigint: true }),
    prefix = f.events();
  arm(s.action, s.requestId, s.resource, s.publication);
  const result = await f.start(s.run);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatchObject({ code: 'conflict', status: 409 });
  expect(f.scratch()).toHaveLength(1);
  expect(fs.existsSync(f.scratch()[0]!)).toBe(false);
  expect(readFileSync(f.path)).toEqual(bytes);
  expect(statSync(f.path, { bigint: true })).toMatchObject({
    ino: physical.ino,
    mtimeNs: physical.mtimeNs,
  });
  expect(f.events()).toEqual(prefix);
  expect(await f.coldEvents()).toEqual(prefix);
  expect(f.reload).not.toHaveBeenCalled();
  expect(f.borrowed[0]!.sqlite.open).toBe(false);
  expect(Atomics.load(new Int32Array(fault.gate), 11)).toBe(0);
});
