import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { commandRequestKey } from '../lib/store.js';
import {
  createExecutionStepJournalReader,
  WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION,
  writeExecutionJournalIntent,
} from '../runtime/execution-journal.js';
import type {
  ExecutionJournalAdmission,
  ExecutionJournalIntent,
  ExecutionJournalSpan,
} from '../runtime/execution-step-journal.js';
import { StoredGoalV1Schema } from '../runtime/goal-retained-v1.js';
import type {
  ControlProductContentMount,
  ControlTerminalResult,
  ControlTerminalTransition,
} from './control-store-products.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { coreDbPath, workspaceDbPath } from './fs-layout.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

const ts = '2026-10-20T00:00:00.000Z';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type BodyMode = 'apply' | 'rollback' | 'generic-entries' | 'generic-products';

/** Runs the actual synchronous SQL body on a real dedicated thread; no writer guard, SQL owner or receipt is mocked. */
function nativeBody(
  root: string,
  input: ControlTerminalTransition,
  mount: ControlProductContentMount,
  mode: BodyMode,
  prepareInput = input
): Promise<ControlTerminalResult> {
  const require = createRequire(import.meta.url);
  const loader = pathToFileURL(require.resolve('tsx/esm/api')).href;
  const origin = import.meta.url;
  const nativeEntry = new URL('./control-store-worker.ts', origin).href;
  const products = new URL('./control-store-products.ts', origin).href;
  const dbEntry = new URL('./db.ts', origin).href;
  const worker = new Worker(
    `
    const {parentPort, workerData, isMainThread} = require('node:worker_threads');
    (async () => {
      const {register} = await import(${JSON.stringify(loader)});
      const source = register({namespace: 'terminal-owner-test'});
      // Initialize the real production worker graph once. No database is opened through its transport.
      await source.import(${JSON.stringify(nativeEntry)}, ${JSON.stringify(origin)});
      const p = await source.import(${JSON.stringify(products)}, ${JSON.stringify(origin)});
      const handles = await source.import(${JSON.stringify(dbEntry)}, ${JSON.stringify(origin)});
      const {root, input, mount, mode, prepareInput} = workerData;
      const db = input.owner.kind === 'server' ? handles.openCoreDb(root) : handles.openWorkspaceDb(root, input.owner.workspaceId);
      try {
        if (mode === 'generic-entries') p.prepareControlEntries(input.owner, mount, input.entries);
        const prepared = mode === 'generic-products' ? null : await p.prepareControlTerminal(db, prepareInput, mount);
        const result = db.sqlite.transaction(() => {
          db.sqlite.exec('SAVEPOINT terminal_body');
          const result = mode === 'generic-products'
            ? p.applyControlProducts(db.sqlite, input.owner, [input.turn], [])
            : p.applyControlTerminal(db, input, prepared);
          db.sqlite.exec('RELEASE terminal_body');
          if (mode === 'rollback') throw new Error('outer rollback');
          return result;
        })();
        parentPort.postMessage({ok: true, result, isMainThread});
      } finally { db.sqlite.close(); }
    })().catch(error => parentPort.postMessage({ok: false, message: error.stack, isMainThread}));
  `,
    { eval: true, workerData: { root, input, mount, mode, prepareInput } }
  );
  return new Promise((resolve, reject) => {
    let replied = false;
    worker.once('message', (message) => {
      replied = true;
      expect(message.isMainThread).toBe(false);
      if (message.ok) resolve(message.result);
      else reject(new Error(message.message));
      void worker.terminate();
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!replied) reject(new Error(`Native terminal worker exited without a result: ${code}`));
    });
  });
}

/** Uses real scoped DDL and immutable digest bytes. No production writer guard is replaced. */
function fixture(kind: 'server' | 'workspace' = 'server') {
  const root = mkdtempSync(join(tmpdir(), 'terminal-owner-'));
  const owner =
    kind === 'server'
      ? { kind: 'server' as const }
      : { kind: 'workspace' as const, workspaceId: allocateEntityId('ws') };
  const db = owner.kind === 'server' ? openCoreDb(root) : openWorkspaceDb(root, owner.workspaceId);
  cleanups.push(() => {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  if (db.scope === 'core') applyMigrations(db);
  else applyScopedMigrations(db);
  mkdirSync(join(root, 'content'));
  const mount = {
    root: join(root, 'content'),
    knowledgeBaseId: allocateEntityId('kb'),
    mount: 'private',
  };
  const threadId = allocateEntityId('th');
  const turnId = allocateEntityId('tu');
  const thread = {
    schemaVersion: 1,
    id: threadId,
    owner,
    name: 'Terminal',
    preview: 'Terminal result',
    status: 'active',
    entryPath: 'conversation',
    visibility: kind === 'server' ? 'server' : 'workspace',
    createdAt: ts,
    updatedAt: ts,
  };
  const turn = {
    schemaVersion: 1,
    id: turnId,
    owner,
    threadId,
    agentSessionId: null,
    triggerActor: { kind: 'system', id: 'terminal-test', responsibleUserId: null },
    error: null,
    configVersion: null,
    startedAt: ts,
    completedAt: ts,
    durationMs: 0,
    status: 'completed',
    captureCoverage: { scope: kind === 'server' ? 'server' : 'workspace', value: 'on' },
    annotation: { retained: true },
  };
  if (owner.kind === 'workspace')
    db.sqlite.prepare('INSERT INTO control_workspaces VALUES (?,1,1,?)').run(
      owner.workspaceId,
      JSON.stringify({
        schemaVersion: 1,
        id: owner.workspaceId,
        kind: 'general',
        status: 'active',
        createdAt: ts,
        updatedAt: ts,
      })
    );
  db.sqlite
    .prepare('INSERT INTO control_threads VALUES (?,?,?,1,1,?)')
    .run(
      threadId,
      owner.kind === 'server' ? null : owner.workspaceId,
      'active',
      JSON.stringify(thread)
    );
  const event = {
    schemaVersion: 1,
    protocolVersion: '1.0',
    ...(owner.kind === 'server' ? { owner } : { workspaceId: owner.workspaceId }),
    threadId,
    turnId,
    requestId: null,
    timestamp: ts,
    sequence: 1,
    event: 'turn.completed',
    data: { type: 'turn-completed', stopReason: 'completed', turn: { ...turn, items: [] } },
  };
  const bytes = Buffer.from(JSON.stringify(event));
  writeFileSync(join(mount.root, 'event.json'), bytes);
  const entry = {
    kind: 'event' as const,
    turnId,
    sequence: 1,
    expectedRevision: 0,
    content: {
      reference: {
        knowledgeBaseId: mount.knowledgeBaseId,
        contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        locator: { ownerScope: owner, mount: mount.mount, path: 'event.json' },
        availability: 'available' as const,
        range: null,
      },
      byteLength: bytes.length,
      mediaType: 'application/json',
    },
  };
  const input: ControlTerminalTransition = {
    owner,
    turn: { kind: 'turn', expectedRevision: 0, record: turn },
    products: [],
    entries: [entry],
    reap: { reason: 'completed', inferredBy: 'native-terminal-test' },
    evidence: [],
    evidenceContent: [],
    command: null,
    execution: null,
  };
  const apply = (value = input, mode: BodyMode = 'apply', prepareInput = value) =>
    nativeBody(root, value, mount, mode, prepareInput);
  return { root, db, owner, turnId, threadId, turn, input, mount, apply };
}

/** Writes invocation-owned immutable test bytes; production preparation must verify and synchronize them. */
function content(f: ReturnType<typeof fixture>, value: unknown, path: string) {
  const bytes = Buffer.from(JSON.stringify(value));
  writeFileSync(join(f.mount.root, path), bytes, { flag: 'wx' });
  return {
    reference: {
      knowledgeBaseId: f.mount.knowledgeBaseId,
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      locator: { ownerScope: f.owner, mount: f.mount.mount, path },
      availability: 'available' as const,
      range: null,
    },
    byteLength: bytes.length,
    mediaType: 'application/json',
  };
}

/** Supplies the original terminal command identity and local Audit, not a second terminal ledger. */
function withCommand(f: ReturnType<typeof fixture>): ControlTerminalTransition {
  const scope =
    f.owner.kind === 'server' ? { coreId: 'server' } : { workspaceId: f.owner.workspaceId };
  const requestId = randomUUID();
  return {
    ...f.input,
    command: {
      receipt: {
        key: commandRequestKey('conversation.submit', requestId, scope),
        command: 'conversation.submit',
        requestId,
        scope,
        inputHash: `sha256:${'a'.repeat(64)}`,
        response: { kind: 'turn', id: f.turnId },
        createdAt: ts,
        expiresAt: '2026-10-27T00:00:00.000Z',
      },
      audit: {
        id: allocateEntityId('aud'),
        workspaceId: f.owner.kind === 'server' ? null : f.owner.workspaceId,
        threadId: f.threadId,
        turnId: f.turnId,
        itemId: null,
        capabilityCallId: null,
        permissionDecisionId: null,
        vaultGrantId: null,
        requestId,
        actor: null,
        subject: null,
        agentId: null,
        agentSessionId: null,
        category: 'command',
        action: 'conversation.submit',
        resource: `turn:${f.turnId}`,
        resourceRevision: null,
        outcome: 'succeeded',
        severity: 'info',
        summary: 'Terminal command',
        errorCode: null,
        createdAt: ts,
        occurredAt: ts,
      },
    },
  };
}

/** Supplies local runtime metadata only; it is not backend effect or physical-release proof. */
function terminalEvidence(f: ReturnType<typeof fixture>, controlSummary: string) {
  if (f.owner.kind !== 'workspace') throw new Error('Workspace fixture required');
  return {
    id: 'rte_terminal',
    workspaceId: f.owner.workspaceId,
    threadId: f.threadId,
    turnId: f.turnId,
    goalId: null,
    taskId: null,
    agentSessionId: null,
    backendType: null,
    backendVersion: null,
    placement: 'unknown' as const,
    phase: 'checkpoint' as const,
    summary: 'Local terminal publication',
    policyDigest: null,
    workerImage: null,
    sandboxSummary: null,
    capabilitySummary: null,
    uploadManifest: [],
    downloadManifest: [],
    transcriptSummary: null,
    workspaceChangeSummary: null,
    controlSummary,
    outcome: 'succeeded' as const,
    exitCode: null,
    signal: null,
    stopReason: null,
    errorCode: null,
    errorMessage: null,
    redactedStdoutSummary: null,
    redactedStderrSummary: null,
    evidenceBundleIds: [],
    contentDigests: [f.input.entries[0]!.content.reference.contentDigest],
    requiredFeatures: ['runtime.evidence.v1'],
    createdAt: ts,
    startedAt: ts,
    completedAt: ts,
    collectedAt: ts,
  };
}

/** Seeds an unpublished local Workspace journal through its actual owner-qualified primitive, never alternate DDL or an external effect. */
async function terminalExecution(f: ReturnType<typeof fixture>) {
  if (f.owner.kind !== 'workspace') throw new Error('Workspace fixture required');
  const now = BigInt(Date.now()) * 1_000_000n;
  const span = (id: number): ExecutionJournalSpan & { endTimeUnixNano: null } => ({
    traceId: '1'.repeat(32),
    spanId: id.toString(16).padStart(16, '0'),
    flags: 1,
    name: 'Local native terminal fixture',
    kind: 'INTERNAL',
    startTimeUnixNano: now,
    endTimeUnixNano: null,
    status: { code: 'UNSET' },
    attributes: [],
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    instrumentationScope: {
      name: 'openkit.native-terminal-test',
      attributes: [],
      droppedAttributesCount: 0,
    },
    resource: { attributes: [], droppedAttributesCount: 0 },
  });
  const admission: ExecutionJournalAdmission = {
    ref: { owner: f.owner, executionId: 'terminal-execution' },
    definitionVersion: WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION,
    workId: f.turnId,
    fingerprint: 'a'.repeat(64),
    exclusionRefs: ['fixture:pending-cleanup'],
    span: span(1),
  };
  const intent = (
    kind: 'terminal-publication' | 'inspect-cleanup',
    id: number
  ): ExecutionJournalIntent => ({
    execution: admission,
    stepId: kind,
    parentStepId: null,
    parent: null,
    inspectedStep: null,
    carriage: {
      operation: kind,
      requestId: id.toString(16).padStart(64, '0'),
      sequence: null,
      bindingRef: null,
    },
    control: {
      definitionVersion: admission.definitionVersion,
      kind,
      target: { backendKind: 'nanohost', targetId: 'fixture-local-target', allocationRef: null },
      workId: f.turnId,
      operationId: null,
      attemptId: null,
      invocationId: `fixture-${kind}`,
      actor: { kind: 'system', id: 'terminal-test', responsibleUserId: null },
      inputRefs: ['fixture:local-terminal-input'],
      outputRefs: [],
      fingerprint: 'b'.repeat(64),
      permittingDecisionRef: null,
      authorityRefs: ['fixture:owning-workspace'],
      retryDeclarationRef: null,
      retryPermitted: false,
      deadlineUnixNano: now + 60_000_000_000n,
      physicalFenceRefs: [],
    },
    span: { ...span(id), parentSpanId: admission.span.spanId },
  });
  f.db.sqlite.transaction(() => {
    writeExecutionJournalIntent(f.db, intent('terminal-publication', 2));
    writeExecutionJournalIntent(f.db, intent('inspect-cleanup', 3));
  })();
  const reader = createExecutionStepJournalReader(f.db, f.owner);
  const root = await reader.readExecution(admission.ref);
  return {
    admission,
    reader,
    descriptor: {
      executionId: admission.ref.executionId,
      terminalStepId: 'terminal-publication',
      expectedRevision: root.revision,
      cleanupStepId: 'inspect-cleanup',
    },
  };
}

/** Creates the existing retained Goal/Task association through actual native tables and their frozen schema. */
function linkGoal(f: ReturnType<typeof fixture>) {
  if (f.owner.kind !== 'workspace') throw new Error('Workspace fixture required');
  const goalId = 'goal_terminal';
  const userId = allocateEntityId('usr');
  const goalThreadId = allocateEntityId('th');
  const thread = JSON.parse(
    (
      f.db.sqlite.prepare('SELECT record_json FROM control_threads WHERE id=?').get(f.threadId) as {
        record_json: string;
      }
    ).record_json
  );
  f.db.sqlite
    .prepare('INSERT INTO control_threads VALUES (?,?,?,1,1,?)')
    .run(
      goalThreadId,
      f.owner.workspaceId,
      'active',
      JSON.stringify({ ...thread, id: goalThreadId })
    );
  const goal = StoredGoalV1Schema.parse({
    goalId,
    workspaceId: f.owner.workspaceId,
    threadId: goalThreadId,
    responsibleUserId: userId,
    intent: 'Complete the task',
    intentRevision: 0,
    responsibleActorContext: { userId, kind: 'local' },
    intentHistory: [],
    proposedPlanVersionId: null,
    activePlanVersionId: null,
    disposition: null,
    changeRevision: 0,
    consideredRevision: 0,
    createdAt: ts,
    updatedAt: ts,
  });
  f.db.sqlite
    .prepare('INSERT INTO goals (goal_id,thread_id,payload_json,schema_version) VALUES (?,?,?,1)')
    .run(goalId, goalThreadId, JSON.stringify(goal));
  f.db.sqlite
    .prepare(
      'INSERT INTO goal_card_tasks (thread_id,goal_id,card_id,payload_json,schema_version) VALUES (?,?,?,?,1)'
    )
    .run(
      f.threadId,
      goalId,
      'card_terminal',
      JSON.stringify({
        goalId,
        cardId: 'card_terminal',
        threadId: f.threadId,
        planVersionId: 'plan_terminal',
        cardRevision: 0,
      })
    );
  const revision = () =>
    JSON.parse(
      (
        f.db.sqlite.prepare('SELECT payload_json FROM goals WHERE goal_id=?').get(goalId) as {
          payload_json: string;
        }
      ).payload_json
    ).changeRevision;
  return { revision };
}

describe('complete native terminal owner', () => {
  for (const kind of ['server', 'workspace'] as const) {
    it(`keeps the complete ${kind} terminal rollback/receipt tuple and ordered close across asynchronous native preparation`, async () => {
      const f = fixture(kind);
      const client = getControlStoreWorkerClient();
      cleanups.push(shutdownControlStoreWorkerClient);
      const path =
        f.owner.kind === 'server'
          ? coreDbPath(f.root)
          : workspaceDbPath(f.root, f.owner.workspaceId);
      const database = `${kind === 'server' ? 'core' : 'workspace'}:${path}`;
      const binding = {
        database,
        path,
        dataRoot: f.root,
        create: false,
        initialize: kind === 'server' ? ('core' as const) : ('workspace' as const),
        productOwner: f.owner,
        contentMount: f.mount,
      };
      const input = withCommand(f);
      f.db.sqlite.exec(
        "CREATE TRIGGER refuse_terminal_receipt BEFORE INSERT ON idempotency_requests BEGIN SELECT RAISE(ABORT, 'terminal receipt refused'); END"
      );
      await client.open(binding);
      const terminal = client.terminal(database, input);
      const closed = client.close(database);
      await expect(terminal).rejects.toMatchObject({
        code: 'constraint',
        commit: 'not-committed',
        message: 'Control database writer operation failed.',
      });
      await closed;
      for (const table of [
        'control_turns',
        'control_product_entries',
        'control_work_observations',
        'idempotency_requests',
        'audit_events',
      ])
        expect(f.db.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
      f.db.sqlite.exec('DROP TRIGGER refuse_terminal_receipt');
      await client.open(binding);
      // Metadata creation is revision 1; the same-savepoint reap seals its observation feature at revision 2.
      await expect(client.terminal(database, input)).resolves.toMatchObject({
        turnId: f.turnId,
        revision: 2,
        replayed: false,
        response: { kind: 'turn', id: f.turnId },
        execution: null,
        reap: { sequence: 1 },
      });
      await expect(client.terminal(database, input)).resolves.toMatchObject({
        turnId: f.turnId,
        revision: 2,
        replayed: true,
        reap: { sequence: 1 },
      });
      await client.close(database);
      const cold =
        f.owner.kind === 'server'
          ? openCoreDb(f.root)
          : openWorkspaceDb(f.root, f.owner.workspaceId);
      try {
        expect(
          cold.sqlite.prepare('SELECT status,revision FROM control_turns WHERE id=?').get(f.turnId)
        ).toEqual({ status: 'completed', revision: 2 });
        expect(
          cold.sqlite.prepare('SELECT count(*) AS n FROM control_product_entries').get()
        ).toEqual({ n: 1 });
        expect(
          cold.sqlite.prepare('SELECT count(*) AS n FROM control_work_observations').get()
        ).toEqual({ n: 1 });
        expect(cold.sqlite.prepare('SELECT count(*) AS n FROM idempotency_requests').get()).toEqual(
          { n: 1 }
        );
        expect(cold.sqlite.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({
          n: 1,
        });
      } finally {
        cold.sqlite.close();
      }
    }, 30_000);
  }

  it('drains accepted asynchronous terminal preparation in both native owners before shutdown acknowledgement', async () => {
    const scopes = [fixture('server'), fixture('workspace')];
    const client = getControlStoreWorkerClient();
    cleanups.push(shutdownControlStoreWorkerClient);
    const databases: string[] = [];
    for (const f of scopes) {
      const path =
        f.owner.kind === 'server'
          ? coreDbPath(f.root)
          : workspaceDbPath(f.root, f.owner.workspaceId);
      const database = `${f.owner.kind === 'server' ? 'core' : 'workspace'}:${path}`;
      databases.push(database);
      await client.open({
        database,
        path,
        dataRoot: f.root,
        create: false,
        initialize: f.owner.kind === 'server' ? 'core' : 'workspace',
        productOwner: f.owner,
        contentMount: f.mount,
      });
    }
    const writes = scopes.map((f, i) => client.terminal(databases[i]!, withCommand(f)));
    const shutdown = shutdownControlStoreWorkerClient();
    const committed = await Promise.all(writes);
    await shutdown;
    for (const [i, f] of scopes.entries()) {
      expect(committed[i]).toMatchObject({
        turnId: f.turnId,
        revision: 2,
        replayed: false,
        reap: { sequence: 1 },
      });
      expect(
        f.db.sqlite.prepare('SELECT status,revision FROM control_turns WHERE id=?').get(f.turnId)
      ).toEqual({ status: 'completed', revision: 2 });
      expect(f.db.sqlite.prepare('SELECT count(*) AS n FROM idempotency_requests').get()).toEqual({
        n: 1,
      });
    }
  }, 30_000);

  it('commits the actual Workspace journal terminal, Task/Goal, evidence, reap and original receipt together without releasing physical exclusion', async () => {
    const f = fixture('workspace');
    if (f.owner.kind !== 'workspace') throw new Error('Workspace fixture required');
    const goal = linkGoal(f);
    const journal = await terminalExecution(f);
    const input = {
      ...withCommand(f),
      evidence: [terminalEvidence(f, 'Local native terminal; cleanup remains pending')],
      execution: journal.descriptor,
    };
    const beforeRoots = f.db.sqlite.prepare('SELECT * FROM control_executions').all();
    const beforeSteps = f.db.sqlite
      .prepare('SELECT * FROM control_execution_steps ORDER BY step_id')
      .all();
    f.db.sqlite.exec(
      "CREATE TRIGGER reject_terminal_closing BEFORE UPDATE OF phase ON control_executions WHEN NEW.phase='closing' BEGIN SELECT RAISE(ABORT, 'private final journal trigger'); END"
    );
    const client = getControlStoreWorkerClient();
    cleanups.push(shutdownControlStoreWorkerClient);
    const path = workspaceDbPath(f.root, f.owner.workspaceId);
    const database = `workspace:${path}`;
    await client.open({
      database,
      path,
      dataRoot: f.root,
      create: false,
      initialize: 'workspace',
      productOwner: f.owner,
      contentMount: f.mount,
    });
    await expect(client.terminal(database, input)).rejects.toMatchObject({
      code: 'constraint',
      commit: 'not-committed',
      message: 'Control database writer operation failed.',
    });
    for (const table of [
      'control_turns',
      'control_product_entries',
      'control_work_observations',
      'task_turn_terminal_facts',
      'runtime_evidence',
      'idempotency_requests',
      'audit_events',
    ])
      expect(f.db.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(goal.revision()).toBe(0);
    expect(f.db.sqlite.prepare('SELECT * FROM control_executions').all()).toEqual(beforeRoots);
    expect(
      f.db.sqlite.prepare('SELECT * FROM control_execution_steps ORDER BY step_id').all()
    ).toEqual(beforeSteps);
    f.db.sqlite.exec('DROP TRIGGER reject_terminal_closing');
    const committed = await client.terminal(database, input);
    expect(committed.execution).toEqual({
      executionId: journal.admission.ref.executionId,
      revision: journal.descriptor.expectedRevision + 1,
      phase: 'closing',
    });
    expect(goal.revision()).toBe(1);
    const decidedSteps = f.db.sqlite
      .prepare('SELECT * FROM control_execution_steps ORDER BY step_id')
      .all();
    expect(
      f.db.sqlite
        .prepare('SELECT state FROM control_execution_steps WHERE step_id=?')
        .get('terminal-publication')
    ).toEqual({ state: 'completed' });
    expect(
      f.db.sqlite
        .prepare('SELECT state FROM control_execution_steps WHERE step_id=?')
        .get('inspect-cleanup')
    ).toEqual({ state: 'intent' });
    expect(
      f.db.sqlite.prepare('SELECT phase,exclusion_refs_json FROM control_executions').get()
    ).toEqual({
      phase: 'closing',
      exclusion_refs_json: JSON.stringify(journal.admission.exclusionRefs),
    });
    const replay = await client.terminal(database, input);
    expect(replay).toEqual({ ...committed, replayed: true });
    expect(goal.revision()).toBe(1);
    expect(
      f.db.sqlite.prepare('SELECT * FROM control_execution_steps ORDER BY step_id').all()
    ).toEqual(decidedSteps);
    await expect(client.terminal(database, { ...input, execution: null })).rejects.toMatchObject({
      code: 'precondition',
      commit: 'not-committed',
    });
    await client.close(database);
    const cold = openWorkspaceDb(f.root, f.owner.workspaceId);
    try {
      for (const table of [
        'control_turns',
        'control_product_entries',
        'control_work_observations',
        'task_turn_terminal_facts',
        'runtime_evidence',
        'idempotency_requests',
        'audit_events',
      ])
        expect(cold.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
      const root = await createExecutionStepJournalReader(cold, f.owner).readExecution(
        journal.admission.ref
      );
      expect(root.phase).toBe('closing');
      expect(root.exclusionRefs).toEqual(journal.admission.exclusionRefs);
    } finally {
      cold.sqlite.close();
    }
  }, 30_000);

  it('runs on an actual native thread and commits service terminal, event and first reap in one tuple', async () => {
    const f = fixture();
    const result = await f.apply();
    expect(result.turnId).toBe(f.turnId);
    expect(result.reap).toEqual({ id: `turn.reap:${f.turnId}`, sequence: 1 });
    expect(
      f.db.sqlite.prepare('SELECT status FROM control_turns WHERE id=?').get(f.turnId)
    ).toEqual({ status: 'completed' });
    expect(f.db.sqlite.prepare('SELECT count(*) AS n FROM control_product_entries').get()).toEqual({
      n: 1,
    });
    expect(f.db.sqlite.prepare('SELECT count(*) AS n FROM control_executions').get()).toEqual({
      n: 0,
    });
    const replay = await f.apply();
    expect(replay.replayed).toBe(true);
    expect(replay.revision).toBe(result.revision);
  });
  it('rolls back terminal, ordered event and reap under its caller savepoint', async () => {
    const f = fixture();
    await expect(f.apply(f.input, 'rollback')).rejects.toThrow('outer rollback');
    for (const table of ['control_turns', 'control_product_entries', 'control_work_observations'])
      expect(f.db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });
  it('keeps generic terminal preparation, terminal metadata and terminal reopening guards hard', async () => {
    const f = fixture();
    await expect(f.apply(f.input, 'generic-entries')).rejects.toThrow(
      'Control product transition precondition failed.'
    );
    await expect(f.apply(f.input, 'generic-products')).rejects.toThrow(
      'Control product transition precondition failed.'
    );
    await f.apply();
    const reopened = {
      ...f.input,
      turn: {
        ...f.input.turn,
        expectedRevision: 2,
        record: { ...f.turn, status: 'running', completedAt: null },
      },
    };
    await expect(f.apply(reopened, 'generic-products')).rejects.toThrow(
      'Control product transition precondition failed.'
    );
  });
  it('rejects stale prepared candidates and changed sealed outcomes', async () => {
    const f = fixture();
    const changed = { ...f.input, reap: { reason: 'changed', inferredBy: 'changed' } };
    await expect(f.apply(changed, 'apply', f.input)).rejects.toThrow(
      'Control product transition precondition failed.'
    );
    await f.apply();
    await expect(
      f.apply({ ...f.input, turn: { ...f.input.turn, record: { ...f.turn, status: 'failed' } } })
    ).rejects.toThrow();
  });
  it('joins Task fact, Goal wake, receipt, event and reap to the caller rollback, then advances the Goal once', async () => {
    const f = fixture('workspace');
    const goal = linkGoal(f);
    const input = withCommand(f);
    await expect(f.apply(input, 'rollback')).rejects.toThrow('outer rollback');
    expect(goal.revision()).toBe(0);
    for (const table of [
      'task_turn_terminal_facts',
      'control_work_observations',
      'control_product_entries',
      'idempotency_requests',
      'audit_events',
    ])
      expect(f.db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    await f.apply(input);
    expect(goal.revision()).toBe(1);
    const fact = f.db.sqlite.prepare('SELECT payload_json FROM task_turn_terminal_facts').get() as {
      payload_json: string;
    };
    const annotated = JSON.stringify({ ...JSON.parse(fact.payload_json), futureNote: 'retained' });
    f.db.sqlite.prepare('UPDATE task_turn_terminal_facts SET payload_json=?').run(annotated);
    expect((await f.apply(input)).replayed).toBe(true);
    expect(goal.revision()).toBe(1);
    expect(f.db.sqlite.prepare('SELECT payload_json FROM task_turn_terminal_facts').get()).toEqual({
      payload_json: annotated,
    });
  });
  it('refuses a changed prepared descriptor, an event-only tuple and unknown required terminal semantics', async () => {
    const f = fixture();
    await expect(
      f.apply({
        ...f.input,
        turn: { ...f.input.turn, record: { ...f.turn, requiredFeatures: ['unknown.required'] } },
      })
    ).rejects.toThrow();
    await expect(f.apply({ ...f.input, entries: [] })).rejects.toThrow();
    const entry = f.input.entries[0]!;
    const changed = {
      ...f.input,
      entries: [
        { ...entry, content: { ...entry.content, byteLength: entry.content.byteLength + 1 } },
      ],
    };
    await expect(f.apply(changed, 'apply', f.input)).rejects.toThrow(
      'Control product transition precondition failed.'
    );
    expect(f.db.sqlite.prepare('SELECT count(*) AS n FROM control_turns').get()).toEqual({ n: 0 });
  });
  it('fills absent sealed metadata without replacing its original terminal event or changing a populated field', async () => {
    const f = fixture();
    const event = JSON.parse(readFileSync(join(f.mount.root, 'event.json'), 'utf8'));
    event.data.turn.durationMs = null;
    const original = {
      ...f.input,
      turn: { ...f.input.turn, record: { ...f.turn, durationMs: null } },
      entries: [{ ...f.input.entries[0]!, content: content(f, event, 'event-unfilled.json') }],
    };
    const first = await f.apply(original);
    const filled = {
      ...original,
      turn: {
        ...original.turn,
        expectedRevision: first.revision,
        record: { ...f.turn, durationMs: 0 },
      },
    };
    const result = await f.apply(filled);
    expect(result.revision).toBe(first.revision + 1);
    expect((await f.apply(filled)).revision).toBe(result.revision);
    await expect(
      f.apply({
        ...filled,
        turn: {
          ...filled.turn,
          expectedRevision: result.revision,
          record: { ...f.turn, durationMs: 1 },
        },
      })
    ).rejects.toThrow('Control product transition precondition failed.');
    expect(f.db.sqlite.prepare('SELECT count(*) AS n FROM control_product_entries').get()).toEqual({
      n: 1,
    });
  });
  it('does not rewrite companion projections on exact terminal replay', async () => {
    const f = fixture();
    const thread = JSON.parse(
      (
        f.db.sqlite
          .prepare('SELECT record_json FROM control_threads WHERE id=?')
          .get(f.threadId) as { record_json: string }
      ).record_json
    );
    const input = {
      ...f.input,
      products: [
        {
          kind: 'thread' as const,
          expectedRevision: 1,
          record: { ...thread, name: 'Final projection' },
        },
      ],
    };
    await f.apply(input);
    expect((await f.apply(input)).replayed).toBe(true);
    expect(
      f.db.sqlite.prepare('SELECT revision FROM control_threads WHERE id=?').get(f.threadId)
    ).toEqual({ revision: 2 });
  });
  it('commits actual Item bytes and their matching terminal snapshot, then refuses a new revision of that sealed Item', async () => {
    const f = fixture();
    const item = {
      schemaVersion: 1,
      id: allocateEntityId('it'),
      owner: f.owner,
      threadId: f.threadId,
      turnId: f.turnId,
      type: 'assistant-message',
      status: 'completed',
      text: 'Decided result',
      createdAt: ts,
      completedAt: ts,
    };
    const itemEntry = {
      kind: 'item' as const,
      turnId: f.turnId,
      sequence: 1,
      expectedRevision: 0,
      content: content(f, item, 'item.json'),
    };
    const event = JSON.parse(readFileSync(join(f.mount.root, 'event.json'), 'utf8'));
    event.data.turn.items = [item];
    const eventEntry = {
      ...f.input.entries[0]!,
      content: content(f, event, 'event-with-item.json'),
    };
    const input = { ...f.input, entries: [itemEntry, eventEntry] };
    await f.apply(input);
    expect(
      f.db.sqlite
        .prepare('SELECT kind,sequence,id FROM control_product_entries ORDER BY kind')
        .all()
    ).toEqual([
      { kind: 'event', sequence: 1, id: `${f.turnId}:1` },
      { kind: 'item', sequence: 1, id: item.id },
    ]);
    const changedItem = { ...item, text: 'New work after sealing' };
    const lateEvent = {
      ...event,
      sequence: 2,
      data: { ...event.data, turn: { ...event.data.turn, items: [changedItem] } },
    };
    const late = {
      ...input,
      entries: [
        {
          ...itemEntry,
          sequence: 2,
          expectedRevision: 1,
          content: content(f, changedItem, 'late-item.json'),
        },
        { ...eventEntry, sequence: 2, content: content(f, lateEvent, 'late-event.json') },
      ],
    };
    await expect(f.apply(late)).rejects.toThrow('Control product transition precondition failed.');
    expect(f.db.sqlite.prepare('SELECT count(*) AS n FROM control_product_entries').get()).toEqual({
      n: 2,
    });
    expect((await f.apply(input)).replayed).toBe(true);
  });
  it('joins runtime evidence metadata to rollback and keeps its immutable replay conflict', async () => {
    const f = fixture('workspace');
    if (f.owner.kind !== 'workspace') throw new Error('Workspace fixture required');
    const record = terminalEvidence(f, 'No native execution');
    const input = { ...f.input, evidence: [record] };
    await expect(f.apply(input, 'rollback')).rejects.toThrow('outer rollback');
    expect(f.db.sqlite.prepare('SELECT count(*) AS n FROM runtime_evidence').get()).toEqual({
      n: 0,
    });
    await f.apply(input);
    expect(f.db.sqlite.prepare('SELECT count(*) AS n FROM runtime_evidence').get()).toEqual({
      n: 1,
    });
    await expect(
      f.apply({ ...input, evidence: [{ ...record, summary: 'Changed decided evidence' }] })
    ).rejects.toThrow('Runtime evidence replay conflict');
    expect(f.db.sqlite.prepare('SELECT summary FROM runtime_evidence').get()).toEqual({
      summary: record.summary,
    });
  });
  it('commits and replays the original receipt and Audit, and refuses a changed request hash', async () => {
    const f = fixture();
    const input = withCommand(f);
    expect((await f.apply(input)).response).toEqual({ kind: 'turn', id: f.turnId });
    expect((await f.apply(input)).replayed).toBe(true);
    expect(f.db.sqlite.prepare('SELECT count(*) AS n FROM idempotency_requests').get()).toEqual({
      n: 1,
    });
    expect(f.db.sqlite.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({ n: 1 });
    const changed = {
      ...input,
      command: {
        ...input.command!,
        receipt: { ...input.command!.receipt, inputHash: `sha256:${'b'.repeat(64)}` },
      },
    };
    await expect(f.apply(changed)).rejects.toThrow();
  });
  it('refuses an original terminal receipt that points to another Turn before any tuple survives', async () => {
    const f = fixture();
    const input = withCommand(f);
    input.command!.receipt.response.id = allocateEntityId('tu');
    await expect(f.apply(input)).rejects.toThrow(/preconditions?/i);
    for (const table of [
      'control_turns',
      'control_product_entries',
      'control_work_observations',
      'idempotency_requests',
      'audit_events',
    ])
      expect(f.db.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  });

  it('composes Workspace service terminal with the actual observation owner without inventing execution', async () => {
    const f = fixture('workspace');
    expect((await f.apply()).reap?.sequence).toBe(1);
    expect(f.db.sqlite.prepare('SELECT count(*) AS n FROM task_turn_terminal_facts').get()).toEqual(
      { n: 0 }
    );
  });
});
