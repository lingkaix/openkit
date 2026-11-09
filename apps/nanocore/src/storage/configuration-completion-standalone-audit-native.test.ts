import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { ProviderProfileSchema } from '@openkit/config-schema';
import { type AuditEvent, deriveEntityId, isEntityId, writeRetainedV1 } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents, prepareAuditEvent } from '../audit-events.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import { createAdministrationConfiguration } from '../config/administration-configuration.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { FsStore } from '../lib/store.js';
import { listServerPermissionDecisions } from '../policy/permission-decisions.js';
import { policyDigest } from '../policy/statements.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, createTestStore } from '../test-support/store.js';
import { ControlScalarTextSchema, readControlScalarText } from './control-store-input.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { ControlStandaloneAuditInputSchema } from './standalone-audit-codecs.js';

// L2, Core Storage/SQLite Layers and Core Evidence/Audit Invariants: real file owner,
// Core INSERT/FULL/receiver, then the original immutable Artifact and separate receipt.
// The earlier server-permission decision + linked Audit remains one native pair.
const observation = vi.hoisted(() => ({
  gate: new SharedArrayBuffer(20 * Int32Array.BYTES_PER_ELEMENT),
  target: new SharedArrayBuffer(4096),
  forward: undefined as (() => boolean) | undefined,
  worker: undefined as NativeWorker | undefined,
  trace: [] as string[],
}));

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      private selected: number | undefined;
      private permission: number | undefined;
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        // Keep the genuine native SQL and receiver. No successful durable row is fabricated.
        // String.raw is essential: SQL regex escapes must survive the generated prelude.
        const prelude = String.raw`
          const {workerData} = require('node:worker_threads');
          const Database = require(workerData.auditSqlModule);
          const fs = require('node:fs');
          const crypto = require('node:crypto');
          const gate = workerData.auditGate;
          const readTarget = () => JSON.parse(Buffer.from(workerData.auditTarget).toString('utf8').replace(/\0.*$/s, ''));
          const prepare = Database.prototype.prepare;
          const exec = Database.prototype.exec;
          let touched = false;
          let pairSeen = false;
          Database.prototype.prepare = function(sql) {
            const statement = prepare.call(this, sql);
            const match = sql.match(/INSERT\s+INTO\s+audit_events\s*\(([^)]+)\)/i);
            if (!match) return statement;
            const columns = match[1].split(',').map(value => value.trim());
            const run = statement.run.bind(statement);
            const db = this;
            statement.run = function(...args) {
              if (Atomics.load(gate, 0) !== 1) return run(...args);
              const target = readTarget();
              if (args[columns.indexOf('request_id')] !== target.requestId ||
                  args[columns.indexOf('action')] !== target.action) return run(...args);
              Atomics.add(gate, 1, 1);
              touched = true;
              const prior = prepare.call(db, 'SELECT audit_event_id FROM audit_events WHERE request_id=? AND action=?').all(target.requestId, target.action);
              const physical = crypto.createHash('sha256').update(fs.readFileSync(target.filePath)).digest('hex');
              const valid = db.name === target.corePath && prior.length === 0 &&
                physical === target.digest && Atomics.load(gate, 9) === 1;
              Atomics.store(gate, 3, valid ? 1 : -1);
              if (!valid) throw new Error('Selected native INSERT has incorrect physical predecessor proof.');
              const result = run(...args);
              Atomics.add(gate, 2, 1);
              return result;
            };
            return statement;
          };
          Database.prototype.exec = function(sql) {
            const result = exec.call(this, sql);
            if (!/^COMMIT$/i.test(sql) || Atomics.load(gate, 0) !== 1) return result;
            const target = readTarget();
            if (this.name !== target.corePath) return result;
            if (!pairSeen) {
              const decisions = prepare.call(this, "SELECT decision_id, audit_event_id FROM permission_decisions WHERE json_extract(context_summary_json, '$.requestId')=?").all(target.requestId);
              const audits = prepare.call(this, "SELECT audit_event_id, permission_decision_id FROM audit_events WHERE request_id=? AND action='permission.decision'").all(target.requestId);
              if (decisions.length || audits.length) {
                pairSeen = true;
                Atomics.store(gate, 16, decisions.length);
                Atomics.store(gate, 17, decisions.length === 1 && audits.length === 1 &&
                  audits[0].audit_event_id === decisions[0].audit_event_id &&
                  audits[0].permission_decision_id === decisions[0].decision_id ? 0 : 1);
                Atomics.store(gate, 18, this.pragma('synchronous', {simple:true}));
              }
            }
            if (touched) {
              touched = false;
              Atomics.add(gate, 4, 1);
              Atomics.store(gate, 5, this.pragma('synchronous', {simple:true}));
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
            auditGate: new Int32Array(observation.gate),
            auditTarget: new Uint8Array(observation.target),
          },
        });
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>): void {
        const gate = new Int32Array(observation.gate);
        if (Atomics.load(gate, 0) === 1) {
          const target = JSON.parse(
            new TextDecoder().decode(observation.target).replace(/\0.*$/s, '')
          );
          const value = args[0] as {
            id?: number;
            database?: string;
            operation?: string;
            content?: ArrayBuffer;
            input?: {
              kind?: string;
              stage?: { decision?: { contextSummary?: { requestId?: string } } };
            };
          };
          if (value.operation === 'standalone-audit') {
            const input = ControlStandaloneAuditInputSchema.parse(
              JSON.parse(
                readControlScalarText(ControlScalarTextSchema.parse(value.input), value.content)
              )
            );
            if (
              input.event.requestId === target.requestId &&
              input.event.action === target.action
            ) {
              expect(value.database).toBe(`core:${target.corePath}`);
              this.selected = value.id;
              observation.worker = this;
              Atomics.add(gate, 7, 1);
            }
          }
          if (
            value.operation === 'capability' &&
            value.input?.kind === 'server-permission' &&
            value.input.stage?.decision?.contextSummary?.requestId === target.requestId
          ) {
            this.permission = value.id;
            Atomics.add(gate, 14, 1);
          }
        }
        super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const value = args[0] as { id?: number; status?: string; operation?: string } | undefined;
        const gate = new Int32Array(observation.gate);
        if (event === 'message' && value && Atomics.load(gate, 0) === 1) {
          if (
            value.id === this.permission &&
            value.operation === 'capability' &&
            value.status === 'ok'
          ) {
            Atomics.add(gate, 15, 1);
            observation.trace.push('permission-ack');
          }
          if (this.selected !== undefined && value.id === this.selected) {
            expect(observation.forward).toBeUndefined();
            Atomics.store(gate, 11, value.status === 'ok' ? 1 : 2);
            Atomics.add(gate, 6, 1);
            observation.trace.push('held-receiver');
            observation.forward = () => super.emit(event, ...args);
            return true;
          }
        }
        return super.emit(event, ...args);
      }
    },
  };
});

/** Computes independent physical bytes, not a later producer-returned revision or SQL result. */
function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Arms exactly one original action/request and its file/reload predecessor, without a COMMIT ordinal. */
function arm(target: {
  requestId: string;
  action: string;
  filePath: string;
  digest: string;
  corePath: string;
}) {
  new Int32Array(observation.gate).fill(0);
  const bytes = new TextEncoder().encode(JSON.stringify(target));
  expect(bytes.length).toBeLessThan(observation.target.byteLength);
  new Uint8Array(observation.target).fill(0);
  new Uint8Array(observation.target).set(bytes);
  observation.trace.length = 0;
  observation.forward = undefined;
  observation.worker = undefined;
  Atomics.store(new Int32Array(observation.gate), 0, 1);
}

/** Forwards only the actual selected receiver reply; failed-test cleanup cannot strand native work. */
function release(): void {
  const forward = observation.forward;
  observation.forward = undefined;
  observation.trace.push('ack-forward');
  forward?.();
}

/** A real early completion/refusal wins; elapsed time alone never proves the desired boundary. */
async function held(result: Promise<unknown>, snapshot?: () => unknown): Promise<void> {
  const gate = new Int32Array(observation.gate);
  let stopped = false;
  const reached = (async () => {
    const deadline = Date.now() + 5000;
    while (!stopped && Atomics.load(gate, 6) !== 1 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    return Atomics.load(gate, 6) === 1
      ? 'receiver'
      : stopped
        ? 'cancelled'
        : 'missing-boundary-at-five-seconds';
  })();
  try {
    const observed = await Promise.race([
      reached,
      result.then(
        () => 'completed-before-native-receiver',
        () => 'refused-before-native-receiver'
      ),
    ]);
    console.info(
      'Configuration boundary observation',
      JSON.stringify({
        observed,
        gate: Array.from(gate),
        trace: observation.trace,
        subject: snapshot?.(),
      })
    );
    expect(
      observed,
      'Exact native INSERT/FULL/receiver is required; early OLD completion/refusal is not admission.'
    ).toBe('receiver');
  } finally {
    stopped = true;
    await reached;
  }
}

/** Reaches genuine private Home, proposal, file and Artifact state through existing public owners. */
async function fixture(
  family: 'provider' | 'policy' = 'provider',
  mode: 'applied' | 'failed' | 'unknown' = 'applied'
) {
  release();
  new Int32Array(observation.gate).fill(0);
  const dataRoot = mkdtempSync(join(tmpdir(), 'configuration-completion-audit-'));
  const coreDb = createTestCoreDb(dataRoot);
  const handles = [coreDb];
  const pending: Promise<unknown>[] = [];
  onTestFinished(async () => {
    release();
    await Promise.allSettled(pending);
    Atomics.store(new Int32Array(observation.gate), 0, 0);
    await shutdownControlStoreWorkerClient();
    for (const handle of handles) if (handle.sqlite.open) handle.sqlite.close();
    vi.restoreAllMocks();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const userId = ensureLocalUser(coreDb);
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const actor: Actor = {
    kind: 'token',
    userId,
    tokenId: token.tokenId,
    tokenScope: 'server-admin',
    tokenWorkspaceIds: [],
  };
  const store = createTestStore({ dataRoot });
  const workspaceId = (await store.ensureQuickChatWorkspace(userId)).id;
  const thread = await store.createThread(
    workspaceId,
    'Configuration completion',
    undefined,
    'administration',
    { visibility: 'private', privateOwnerUserId: userId }
  );
  const turn = await store.createTurn(
    workspaceId,
    thread.id,
    'Confirm exact candidate',
    { kind: 'user', id: userId },
    null
  );
  const home = { threadId: thread.id, turnId: turn.id, requestId: randomUUID() };
  const provider = {
    id: 'codex',
    vendor: 'openai-codex',
    kind: 'oauth',
    displayName: 'Original',
    models: ['gpt-5'],
    modelMetadata: { 'gpt-5': { limit: { context: 200000, output: 10000 }, tool_call: true } },
    extensions: {
      openkit: { subscriptionAccount: { accountSlotId: 'primary' } },
      private: { note: 'fixture-private-provider-note' },
    },
  };
  mkdirSync(join(dataRoot, 'config/providers'), { recursive: true });
  writeFileSync(join(dataRoot, 'config/server.jsonc'), JSON.stringify({ schemaVersion: 1 }));
  writeFileSync(
    join(dataRoot, 'config/providers/catalog.provider.jsonc'),
    JSON.stringify(writeRetainedV1(provider))
  );
  writeFileSync(
    join(dataRoot, 'config/gateway.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      logicalModels: [
        {
          id: 'reasoning',
          displayName: 'Reasoning',
          contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
          routes: [{ id: 'primary', providerProfileId: 'codex', providerModel: 'gpt-5' }],
        },
      ],
      defaultLogicalModelId: 'reasoning',
    })
  );
  const manager = createRuntimeConfigManager({ dataRoot });
  const files = new RuntimeConfigFileService({
    dataRoot,
    userId,
    workspaceIds: [workspaceId],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const reload = vi.fn(async () => {
    observation.trace.push('reload');
    expect(coreDb.sqlite.inTransaction).toBe(false);
    try {
      if (mode === 'failed')
        throw new Error('Deliberate reload failure after returned file publication.');
      return await manager.reload({ mode: 'safe', dryRun: false });
    } finally {
      Atomics.store(new Int32Array(observation.gate), 9, 1);
      observation.trace.push('reload-settled');
    }
  });
  const options = {
    actor,
    coreDb,
    store,
    files,
    reload,
    inflightCommands: new WeakMap(),
    runtimeConfig: () => {
      if (mode === 'unknown' && Atomics.load(new Int32Array(observation.gate), 9) === 1)
        throw new Error('Deliberate historical Policy inspection failure.');
      return manager.current();
    },
    repositoryWorkspaceDb: () => {
      throw new Error('Inactive Policy fixture has no retained Worker dependency.');
    },
  };
  const service = createAdministrationConfiguration(options);
  const fileId = family === 'policy' ? 'server.jsonc' : 'providers/catalog.provider.jsonc';
  const expectedRevision = files.readFile(fileId).file.revision!;
  const proposal = await service.propose(
    family === 'provider'
      ? {
          targetFamily: 'provider',
          targetId: 'codex',
          expectedRevision,
          changes: { displayName: 'Revised' },
        }
      : {
          targetFamily: 'policy',
          targetId: 'server',
          expectedRevision,
          changes: {
            rationale: 'Retain an inactive exact human rule.',
            proposed: {
              schemaVersion: 1,
              statements: [
                {
                  id: 'completion-rule',
                  kind: 'permission',
                  effect: 'require_approval',
                  grant: { kind: 'ordinary' },
                  author: { kind: 'human', id: userId },
                  authority: { kind: 'human', userId },
                  authoredAt: '2026-10-18T00:00:00Z',
                  state: 'inactive',
                  scope: {
                    subjects: [{ kind: 'human', id: userId }],
                    actions: ['tool.use'],
                    resources: [
                      { kind: 'mcp-tool', workspaceId, serverId: 'issues', toolName: 'read' },
                    ],
                  },
                  lifetime: {
                    anchor: {
                      owner: { kind: 'workspace', workspaceId },
                      kind: 'workspace',
                      id: workspaceId,
                    },
                    uses: 1,
                  },
                },
              ],
            },
          },
        },
    home
  );
  const artifact = store.getArtifact(workspaceId, proposal.candidate.artifactId);
  if (artifact.content.format !== 'json')
    throw new Error('Expected actual immutable candidate JSON.');
  const candidate = JSON.parse(artifact.content.body);
  const expectedBytes =
    family === 'provider'
      ? `${JSON.stringify(writeRetainedV1(ProviderProfileSchema.parse({ ...provider, displayName: 'Revised' })), null, 2)}\n`
      : `${JSON.stringify({ schemaVersion: 1, policy: { mediation: candidate.after } }, null, 2)}\n`;
  const request = {
    requestId: randomUUID(),
    candidate: proposal.candidate,
    confirmation: proposal.confirmation,
  };
  const outcomeId = deriveEntityId('ar', ['configuration_result', { userId, request }]);
  const markerId = deriveEntityId('it', [
    'configuration_apply',
    { actorId: userId, requestId: request.requestId },
  ]);
  const scope = { actorId: userId, workspaceId, threadId: thread.id };
  const action = family === 'policy' ? 'policy.write' : 'administration.configuration.apply';
  const filePath = join(dataRoot, 'config', fileId);
  const write = files.updateFile.bind(files);
  const writes = vi.spyOn(files, 'updateFile').mockImplementation((...args) => {
    observation.trace.push('file');
    expect(coreDb.sqlite.inTransaction).toBe(false);
    return write(...args);
  });
  const publish = store.createArtifact.bind(store);
  const publications = vi.spyOn(store, 'createArtifact').mockImplementation((...args) => {
    observation.trace.push('artifact');
    return publish(...args);
  });
  const record = store.recordCommandRequest.bind(store);
  const receipts = vi.spyOn(store, 'recordCommandRequest').mockImplementation((...args) => {
    observation.trace.push('receipt');
    return record(...args);
  });
  const mainInsert = { attempts: 0 };
  const prepare = coreDb.sqlite.prepare.bind(coreDb.sqlite);
  vi.spyOn(coreDb.sqlite, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (/INSERT\s+INTO\s+audit_events/i.test(sql)) {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, 'run').mockImplementation((...args: unknown[]) => {
        if (args.includes(request.requestId) && args.includes(action)) {
          mainInsert.attempts += 1;
          observation.trace.push('old-main-insert');
        }
        return run(...args);
      });
    }
    return statement;
  });
  const target = {
    requestId: request.requestId,
    action,
    filePath,
    digest: hash(expectedBytes),
    corePath: coreDb.sqlite.name,
  };
  return {
    ...options,
    service,
    family,
    mode,
    candidate,
    request,
    expectedRevision,
    expectedBytes,
    filePath,
    action,
    target,
    pending,
    mainInsert,
    writes,
    publications,
    receipts,
    outcomeId,
    markerId,
    scope,
    workspaceId,
    home,
    events: () =>
      listServerAuditEvents(coreDb).filter(
        (event) => event.action === action && event.requestId === request.requestId
      ),
    receipt: () =>
      store.getCommandRequest('administration.configuration.apply', request.requestId, scope),
    snapshot: () => ({
      mainInsertAttempts: mainInsert.attempts,
      fileWrites: writes.mock.calls.length,
      reloads: reload.mock.calls.length,
      physicalMatch: readFileSync(filePath, 'utf8') === expectedBytes,
      selectedEvents: listServerAuditEvents(coreDb).filter(
        (event) => event.action === action && event.requestId === request.requestId
      ),
      markerCount: store
        .listThreadItems(workspaceId, thread.id)
        .filter((item) => item.id === markerId).length,
      outcomePublished: store.listArtifacts(workspaceId).some((row) => row.id === outcomeId),
      receipt: store.getCommandRequest(
        'administration.configuration.apply',
        request.requestId,
        scope
      ),
    }),
    marker: () =>
      store.listThreadItems(workspaceId, thread.id).filter((item) => item.id === markerId),
    async cold() {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      const coldCore = openCoreDb(dataRoot);
      handles.push(coldCore);
      const coldStore = new FsStore({ dataRoot });
      return {
        coreDb: coldCore,
        store: coldStore,
        events: listServerAuditEvents(coldCore).filter(
          (event) => event.action === action && event.requestId === request.requestId
        ),
        service: createAdministrationConfiguration({
          ...options,
          coreDb: coldCore,
          store: coldStore,
          inflightCommands: new WeakMap(),
        }),
      };
    },
  };
}

/** Checks original retained defaults, attribution and the actual earlier Policy pair, not new authority. */
function exactEvent(
  f: Awaited<ReturnType<typeof fixture>>,
  event: AuditEvent,
  outcome: 'succeeded' | 'failed' | 'unknown',
  startedAt: number
) {
  expect(isEntityId('aud', event.id)).toBe(true);
  expect(event).toMatchObject({
    action: f.action,
    actor: { kind: 'user', id: f.actor.userId },
    requestId: f.request.requestId,
    resource: f.family === 'policy' ? 'policy:server' : 'provider:codex',
    category: 'system',
    severity: 'info',
    outcome,
    workspaceId: null,
    threadId: null,
    turnId: null,
    itemId: null,
    capabilityCallId: null,
    agentId: null,
    agentSessionId: null,
    subject: null,
    resourceRevision: null,
    errorCode: null,
    vaultGrantId: null,
  });
  expect(event.authentication).toBeUndefined();
  expect(event.notebookAdmission).toBeUndefined();
  expect(event.policyInvocation).toBeUndefined();
  expect(event.createdAt).toEqual(expect.any(String));
  expect(event.occurredAt).toEqual(expect.any(String));
  expect(Date.parse(event.createdAt!)).toBeGreaterThanOrEqual(startedAt);
  expect(Date.parse(event.occurredAt!)).toBeGreaterThanOrEqual(startedAt);
  expect(Date.parse(event.createdAt!)).toBeLessThanOrEqual(Date.now());
  expect(Date.parse(event.occurredAt!)).toBeLessThanOrEqual(Date.now());
  // Config/Identity: startup-captured Provider registry metadata remains restart-required.
  expect(event.summary).toBe(
    `Candidate ${f.request.candidate.contentDigest}; base ${f.expectedRevision}; persisted true; reload ${f.mode === 'failed' ? 'failed' : 'applied'}; restart required ${f.family === 'provider'}.`
  );
  expect(JSON.stringify(event)).not.toContain('fixture-private-provider-note');
  if (f.family === 'policy') {
    const decisions = listServerPermissionDecisions(f.coreDb).filter(
      (row) => (row.contextSummary as { requestId?: string }).requestId === f.request.requestId
    );
    expect(decisions).toHaveLength(1);
    const decision = decisions[0]!;
    expect(decision).toMatchObject({
      action: 'workspace.configure',
      result: 'allow',
      enforcementPoint: 'policy.write@decide',
    });
    const linked = listServerAuditEvents(f.coreDb).filter(
      (row) => row.id === decision.auditEventId
    );
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({
      action: 'permission.decision',
      permissionDecisionId: decision.decisionId,
      requestId: f.request.requestId,
    });
    expect(event.permissionDecisionId).toBe(decision.decisionId);
    expect(event.policyWriteOutcome).toMatchObject({
      candidate: {
        artifactId: f.request.candidate.artifactId,
        version: f.request.candidate.artifactVersion,
        digest: f.request.candidate.contentDigest,
      },
      decider: { kind: 'human', id: f.actor.userId },
      validation: 'valid',
      approval: {
        proposalDigest: f.request.candidate.contentDigest,
        policyRevision: f.candidate.policyProposal.baseRevision,
        authorizationRevision: decision.mediation?.authorizationRevision,
      },
      persistedRevision: policyDigest(f.candidate.after),
      activeRevision: outcome === 'unknown' ? null : policyDigest(f.candidate.after),
      outcome: outcome === 'unknown' ? 'unknown' : 'active',
    });
    expect(event.policyWriteOutcome?.approval.authorizationRevision).toMatch(
      /^[a-f0-9]{64}$|^sha256:[a-f0-9]{64}$/
    );
    expect(new Int32Array(observation.gate).slice(14, 19)).toEqual(new Int32Array([1, 1, 1, 0, 2]));
    expect(observation.trace.indexOf('permission-ack')).toBeLessThan(
      observation.trace.indexOf('file')
    );
  } else {
    expect(event.permissionDecisionId).toBeNull();
    expect(event.policyWriteOutcome).toBeUndefined();
  }
}

for (const wrongProof of [false, true]) {
  it(`calibrates real native Core INSERT/FULL/receiver with ${wrongProof ? 'rejected wrong' : 'accepted exact'} physical proof`, async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const event = prepareAuditEvent({
      workspaceId: null,
      actor: { kind: 'user', id: f.actor.userId },
      requestId,
      action: 'app.update.start',
      category: 'system',
      resource: `app-update:${requestId}`,
      outcome: 'succeeded',
      summary: 'Native observer calibration.',
    });
    arm({
      ...f.target,
      requestId,
      action: event.action,
      digest: wrongProof ? '0'.repeat(64) : hash(readFileSync(f.filePath)),
    });
    Atomics.store(new Int32Array(observation.gate), 9, 1);
    let settled = false;
    const result = getControlStoreWorkerClient()
      .standaloneAudit(f.coreDb, { stage: 'app.update.start', event })
      .finally(() => {
        settled = true;
      });
    f.pending.push(result);
    await held(result);
    const gate = new Int32Array(observation.gate);
    expect(settled).toBe(false);
    expect(Atomics.load(gate, 1)).toBe(1);
    expect(Atomics.load(gate, 3)).toBe(wrongProof ? -1 : 1);
    expect(Atomics.load(gate, 2)).toBe(wrongProof ? 0 : 1);
    expect(Atomics.load(gate, 11)).toBe(wrongProof ? 2 : 1);
    if (!wrongProof) {
      expect(Atomics.load(gate, 4)).toBe(1);
      expect(Atomics.load(gate, 5)).toBe(2);
    }
    release();
    if (wrongProof) await expect(result).rejects.toMatchObject({ commit: 'not-committed' });
    else await result;
    const cold = await f.cold();
    expect(listServerAuditEvents(cold.coreDb).filter((row) => row.requestId === requestId)).toEqual(
      wrongProof ? [] : [event]
    );
    expect(Atomics.load(gate, 7)).toBe(1);
  });
}

for (const scenario of [
  { family: 'provider', mode: 'applied', outcome: 'succeeded' },
  { family: 'policy', mode: 'applied', outcome: 'succeeded' },
  { family: 'provider', mode: 'failed', outcome: 'failed' },
  { family: 'policy', mode: 'unknown', outcome: 'unknown' },
] as const) {
  it(`${scenario.family} ${scenario.mode} preserves original later Core outcome before Artifact/receipt/result`, async () => {
    const f = await fixture(scenario.family, scenario.mode);
    arm(f.target);
    const startedAt = Date.now();
    let settled = false;
    const result = f.service.apply(f.request).finally(() => {
      settled = true;
    });
    f.pending.push(result);
    await held(result, f.snapshot);
    const gate = new Int32Array(observation.gate);
    expect(settled).toBe(false);
    expect(Array.from(gate.slice(1, 8))).toEqual([1, 1, 1, 1, 2, 1, 1]);
    expect(f.mainInsert.attempts).toBe(0);
    expect(readFileSync(f.filePath, 'utf8')).toBe(f.expectedBytes);
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(f.marker()).toHaveLength(1);
    expect(f.publications).not.toHaveBeenCalled();
    expect(f.receipts).not.toHaveBeenCalled();
    expect(f.store.listArtifacts(f.workspaceId).some((row) => row.id === f.outcomeId)).toBe(false);
    expect(f.receipt()).toBeNull();
    const events = f.events();
    expect(events).toHaveLength(1);
    exactEvent(f, events[0]!, scenario.outcome, startedAt);
    expect(f.coreDb.sqlite.inTransaction).toBe(false);
    release();
    const response = await result;
    expect(response).toEqual({
      candidate: f.request.candidate,
      persisted: true,
      revision: f.files.readFile(
        f.family === 'policy' ? 'server.jsonc' : 'providers/catalog.provider.jsonc'
      ).file.revision,
      reload: scenario.mode === 'failed' ? 'failed' : 'applied',
      restartRequired: f.family === 'provider',
    });
    const outcome = f.store.getArtifact(f.workspaceId, f.outcomeId);
    expect(outcome).toMatchObject({
      version: 1,
      origin: {
        kind: 'turn-output',
        threadId: f.home.threadId,
        turnId: f.home.turnId,
        requestId: f.request.requestId,
      },
    });
    if (outcome.content.format !== 'json') throw new Error('Expected immutable outcome JSON.');
    expect(JSON.parse(outcome.content.body)).toEqual(response);
    expect(outcome.contentDigest).toBe(`sha256:${hash(outcome.content.body)}`);
    expect(f.receipt()).toMatchObject({
      command: 'administration.configuration.apply',
      requestId: f.request.requestId,
      response: { kind: 'artifact', id: f.outcomeId },
    });
    expect(observation.trace.indexOf('ack-forward')).toBeLessThan(
      observation.trace.indexOf('artifact')
    );
    expect(observation.trace.indexOf('artifact')).toBeLessThan(
      observation.trace.indexOf('receipt')
    );
    expect(await f.service.apply(f.request)).toEqual(response);
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(f.events()).toEqual(events);
    const cold = await f.cold();
    expect(cold.events).toEqual(events);
    expect(cold.store.getArtifact(f.workspaceId, f.outcomeId)).toEqual(outcome);
    expect(
      cold.store.getCommandRequest(
        'administration.configuration.apply',
        f.request.requestId,
        f.scope
      )
    ).toMatchObject({ response: { id: f.outcomeId } });
    expect(await cold.service.apply(f.request)).toEqual(response);
    expect(Atomics.load(gate, 7)).toBe(1);
  });
}

for (const lostAck of [false, true]) {
  it(`${lostAck ? 'Policy committed unknown' : 'provider real INSERT refusal'} retains file/reload and start-marker recovery without Artifact/receipt/repost`, async () => {
    const f = await fixture(lostAck ? 'policy' : 'provider');
    if (!lostAck)
      f.coreDb.sqlite.exec(
        `CREATE TRIGGER refuse_configuration_completion BEFORE INSERT ON audit_events WHEN NEW.request_id='${f.request.requestId}' AND NEW.action='administration.configuration.apply' BEGIN SELECT RAISE(ABORT, 'Deliberate configuration outcome refusal'); END`
      );
    arm(f.target);
    const startedAt = Date.now();
    const result = f.service.apply(f.request);
    f.pending.push(result);
    await held(result, f.snapshot);
    const gate = new Int32Array(observation.gate);
    expect(Atomics.load(gate, 1)).toBe(1);
    expect(Atomics.load(gate, 2)).toBe(lostAck ? 1 : 0);
    expect(Atomics.load(gate, 3)).toBe(1);
    expect(Atomics.load(gate, 11)).toBe(lostAck ? 1 : 2);
    expect(readFileSync(f.filePath, 'utf8')).toBe(f.expectedBytes);
    expect(f.mainInsert.attempts).toBe(0);
    const events = f.events();
    if (lostAck) {
      expect(Atomics.load(gate, 4)).toBe(1);
      expect(Atomics.load(gate, 5)).toBe(2);
      expect(events).toHaveLength(1);
      exactEvent(f, events[0]!, 'succeeded', startedAt);
      observation.forward = undefined; // Drop only the genuine committed reply; never synthesize another.
      await observation.worker!.terminate();
    } else {
      expect(events).toEqual([]);
      release();
    }
    await expect(result).rejects.toMatchObject({ commit: lostAck ? 'unknown' : 'not-committed' });
    expect(f.publications).not.toHaveBeenCalled();
    expect(f.receipts).not.toHaveBeenCalled();
    expect(f.receipt()).toBeNull();
    expect(f.marker()).toHaveLength(1);
    expect(f.store.listArtifacts(f.workspaceId).some((row) => row.id === f.outcomeId)).toBe(false);
    const cold = await f.cold();
    expect(cold.events).toEqual(events);
    expect(readFileSync(f.filePath, 'utf8')).toBe(f.expectedBytes);
    expect(
      cold.store
        .listThreadItems(f.workspaceId, f.home.threadId)
        .filter((row) => row.id === f.markerId)
    ).toHaveLength(1);
    expect(cold.store.listArtifacts(f.workspaceId).some((row) => row.id === f.outcomeId)).toBe(
      false
    );
    expect(
      cold.store.getCommandRequest(
        'administration.configuration.apply',
        f.request.requestId,
        f.scope
      )
    ).toBeNull();
    // Public configuration fail() keeps the closed code separate from its fixed safe message.
    await expect(cold.service.apply(f.request)).rejects.toMatchObject({
      code: 'configuration_recovery_required',
      status: 409,
      message: 'Configuration request cannot be applied; inspect the current target and candidate.',
    });
    expect(f.writes).toHaveBeenCalledTimes(1);
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(Atomics.load(gate, 7)).toBe(1);
    expect(
      listServerAuditEvents(cold.coreDb).filter(
        (row) => row.action === f.action && row.requestId === f.request.requestId
      )
    ).toEqual(events);
    if (lostAck)
      expect(
        listServerPermissionDecisions(cold.coreDb).filter(
          (row) => (row.contextSummary as { requestId?: string }).requestId === f.request.requestId
        )
      ).toHaveLength(1);
  });
}
