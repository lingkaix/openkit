import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from '../capability/usage-ledger.js';
import {
  listExportableWorkspacePermissionDecisions,
  prepareControlPermissionDecision,
} from '../policy/permission-decisions.js';
import { readWorkerRawOutput } from '../runtime/worker-raw-output.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { ControlCapabilityCommandInputSchema } from './control-store-capability.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';

const coalescing = vi.hoisted(() => ({ gate: undefined as SharedArrayBuffer | undefined }));

// Keep the native entry, SQL and transport. Only the existing 5 ms scheduling callback is held.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (coalescing.gate === undefined) {
          super(filename, options);
          return;
        }
        const prelude = `
          const { workerData } = require('node:worker_threads');
          const gate = new Int32Array(workerData.coalescingGate);
          const schedule = globalThis.setTimeout;
          const cancel = globalThis.clearTimeout;
          const held = new Map();
          globalThis.setTimeout = function(callback, delay, ...args) {
            if (delay !== 5 || Atomics.load(gate, 0) !== 1)
              return schedule(callback, delay, ...args);
            const timer = schedule(() => {}, 2147483647);
            held.set(timer, () => callback(...args));
            Atomics.add(gate, 1, 1);
            return timer;
          };
          globalThis.clearTimeout = function(timer) {
            held.delete(timer);
            return cancel(timer);
          };
          // Release is cleanup only. Native setImmediate work remains available while timers are held.
          setInterval(() => {
            if (Atomics.load(gate, 0) === 1) return;
            const callbacks = [...held];
            held.clear();
            for (const [timer, callback] of callbacks) {
              cancel(timer);
              Atomics.add(gate, 2, 1);
              callback();
            }
          }, 1).unref();
        `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: { ...options?.workerData, coalescingGate: coalescing.gate },
        });
      }
    },
  };
});

const roots: string[] = [];
const databases: WorkspaceDb[] = [];
let client: ReturnType<typeof getControlStoreWorkerClient> | undefined;

afterEach(async () => {
  if (coalescing.gate !== undefined) Atomics.store(new Int32Array(coalescing.gate), 0, 0);
  await client?.shutdown();
  coalescing.gate = undefined;
  client = undefined;
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Prepares private dormant ledgers through the native tuple owner with Main restricted to reads. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'control-capability-'));
  roots.push(root);
  const workspaceId = allocateEntityId('ws');
  const db = openWorkspaceDb(root, workspaceId);
  databases.push(db);
  applyScopedMigrations(db, undefined, 'pre-knowledge');
  // Establish the real initiator and Workspace ownership before Main becomes query-only.
  const coreDb = createTestCoreDb(root);
  let actor: { kind: 'user'; id: string };
  try {
    const userId = ensureLocalUser(coreDb);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId });
    actor = { kind: 'user', id: userId };
  } finally {
    closeTestCoreDb(coreDb);
  }

  /** Creates real inference proof for one exact Turn and awaits its actual admission acknowledgement. */
  async function inference(
    scope = {
      workspaceId,
      threadId: allocateEntityId('th'),
      turnId: allocateEntityId('tu'),
    }
  ) {
    const writer = await open();
    const call = await writer.capability(workspaceId, {
      kind: 'admit',
      workspaceId,
      now: new Date().toISOString(),
      initializeRaw: true,
      context: {
        threadId: scope.threadId,
        turnId: scope.turnId,
        authorityActor: actor,
        family: 'llm',
        operation: 'chat_completions',
        capabilityId: 'llm.gateway.use',
        redactionClass: 'metadata-only',
        serviceRef: 'worker-inference-gateway',
      },
    });
    if (!call || typeof call !== 'object' || !('id' in call))
      throw new Error('Native inference admission did not return its original Call.');
    return { scope, callId: call.id, attemptId: randomUUID() };
  }

  /** Opens the existing worker against the migrated private scope with Main restricted to reads. */
  async function open() {
    db.sqlite.pragma('query_only = ON');
    client = getControlStoreWorkerClient();
    await client.open({
      database: workspaceId,
      path: db.sqlite.name,
      create: false,
      initialize: 'workspace',
      productOwner: { kind: 'workspace', workspaceId },
      dataRoot: root,
    });
    return client;
  }

  return { root, db, workspaceId, actor, inference, open };
}

type Inference = Awaited<ReturnType<ReturnType<typeof fixture>['inference']>>;

/** Supplies only trusted value-free source positions; no native response or durable proof is fabricated. */
function position(
  inference: Inference,
  field: 'text' | 'tool-arguments' | 'reasoning',
  fromBytePosition: number,
  bytePosition: number
) {
  return { attemptId: inference.attemptId, partId: 0, field, fromBytePosition, bytePosition };
}

/** Reads original owner bytes to distinguish complete savepoint rollback from a partial watermark write. */
function proof(db: WorkspaceDb, callId: string) {
  return db.sqlite
    .prepare('SELECT extensions_json FROM capability_calls WHERE call_id = ?')
    .pluck()
    .get(callId);
}

describe('dormant native CapabilityCall raw observation boundary', () => {
  it('acknowledges raw settle with its retained prefix while the writer coalescing timer is held', async () => {
    coalescing.gate = new SharedArrayBuffer(12);
    const gate = new Int32Array(coalescing.gate);
    const f = fixture();
    const inference = await f.inference();
    const writer = await f.open();
    await writer.capability(f.workspaceId, {
      kind: 'raw-observe',
      ...inference.scope,
      callId: inference.callId,
      positions: [position(inference, 'text', 0, 7)],
    });

    Atomics.store(gate, 0, 1);
    let outcome: PromiseSettledResult<unknown> | undefined;
    const settling = writer
      .capability(f.workspaceId, {
        kind: 'raw-settle',
        ...inference.scope,
        callId: inference.callId,
        complete: true,
      })
      .then(
        (value) => {
          outcome = { status: 'fulfilled', value };
        },
        (reason) => {
          outcome = { status: 'rejected', reason };
        }
      );
    try {
      // DX Write And Space Budget: barriers never deliberately wait for the 5 ms writer timer.
      // The normal waitFor guard bounds the check; no elapsed-time threshold decides acceptance.
      await vi.waitFor(() => {
        expect(
          outcome,
          `Raw settle must ACK before timer release; native held timers: ${Atomics.load(gate, 1)}.`
        ).toEqual({ status: 'fulfilled', value: null });
      });
      expect(Atomics.load(gate, 2)).toBe(0);
      expect(readWorkerRawOutput(f.db, inference.scope)).toEqual({
        rawOutputBytes: 7,
        exhausted: false,
      });
      const retained = listWorkspaceCapabilityCalls(f.db, f.workspaceId).find(
        (call) => call.id === inference.callId
      );
      expect(retained?.extensions?.['openkit.worker/rawOutput']).toMatchObject({
        byteLength: 7,
        coverage: 'complete',
      });
      expect(retained?.status).toBe('running');
    } finally {
      Atomics.store(gate, 0, 0);
      await settling;
    }
  });

  it('returns the final Turn aggregate and the total new charge for all positions in one command', async () => {
    const f = fixture();
    const inference = await f.inference();
    const writer = await f.open();
    const command = { kind: 'raw-observe' as const, ...inference.scope, callId: inference.callId };
    await expect(
      writer.capability(f.workspaceId, {
        ...command,
        positions: [position(inference, 'text', 0, 2)],
      })
    ).resolves.toEqual({ rawOutputBytes: 2, chargedBytes: 2, exhausted: false });

    expect(readWorkerRawOutput(f.db, inference.scope)).toEqual({
      rawOutputBytes: 2,
      exhausted: false,
    });
    // COORD13:1x requires reuse for this measured read; no SQL spelling or call order is fixed.
    const preparing = vi.spyOn(f.db.sqlite, 'prepare');
    try {
      expect(readWorkerRawOutput(f.db, inference.scope)).toEqual({
        rawOutputBytes: 2,
        exhausted: false,
      });
      expect(preparing).not.toHaveBeenCalled();
      expect(f.db.sqlite.inTransaction).toBe(false);
    } finally {
      preparing.mockRestore();
    }

    // Raw-Output Accounting owns the aggregate; DX owns committed visibility after native ACK.
    await expect(
      writer.capability(f.workspaceId, {
        ...command,
        positions: [
          position(inference, 'text', 2, 11),
          position(inference, 'tool-arguments', 0, 5),
          position(inference, 'reasoning', 0, 3),
        ],
      })
    ).resolves.toEqual({ rawOutputBytes: 19, chargedBytes: 17, exhausted: false });
    expect(readWorkerRawOutput(f.db, inference.scope)).toEqual({
      rawOutputBytes: 19,
      exhausted: false,
    });
  });

  it('rolls back a late gap and refuses queued same-Turn successors while sibling scopes commit', async () => {
    const f = fixture();
    const failed = await f.inference();
    const successor = await f.inference(failed.scope);
    const sibling = await f.inference();
    const other = fixture();
    const otherInference = await other.inference();
    const originals = [proof(f.db, failed.callId), proof(f.db, successor.callId)];
    const writer = await f.open();
    await other.open();

    // DX savepoints and accepted plan item 26 require local rollback and Turn-scoped failure isolation.
    const results = await Promise.allSettled([
      writer.capability(f.workspaceId, {
        kind: 'raw-observe',
        ...failed.scope,
        callId: failed.callId,
        positions: [position(failed, 'text', 0, 7), position(failed, 'tool-arguments', 1, 5)],
      }),
      writer.capability(f.workspaceId, {
        kind: 'raw-observe',
        ...successor.scope,
        callId: successor.callId,
        positions: [position(successor, 'text', 0, 11)],
      }),
      writer.capability(f.workspaceId, {
        kind: 'raw-observe',
        ...sibling.scope,
        callId: sibling.callId,
        positions: [position(sibling, 'text', 0, 3)],
      }),
      writer.capability(other.workspaceId, {
        kind: 'raw-observe',
        ...otherInference.scope,
        callId: otherInference.callId,
        positions: [position(otherInference, 'text', 0, 5)],
      }),
    ]);

    expect(results[0]).toMatchObject({
      status: 'rejected',
      reason: { commit: 'not-committed' },
    });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { commit: 'not-committed' },
    });
    expect(results[2]).toEqual({
      status: 'fulfilled',
      value: { rawOutputBytes: 3, chargedBytes: 3, exhausted: false },
    });
    expect(results[3]).toEqual({
      status: 'fulfilled',
      value: { rawOutputBytes: 5, chargedBytes: 5, exhausted: false },
    });
    expect([proof(f.db, failed.callId), proof(f.db, successor.callId)]).toEqual(originals);
    expect(readWorkerRawOutput(f.db, failed.scope)).toEqual({
      rawOutputBytes: 0,
      exhausted: false,
    });
    expect(readWorkerRawOutput(f.db, sibling.scope).rawOutputBytes).toBe(3);
    expect(readWorkerRawOutput(other.db, otherInference.scope).rawOutputBytes).toBe(5);
  });
});

it('retains an exact binary Knowledge answer after reopen and refuses a corrupted finish tuple', async () => {
  const f = fixture();
  const writer = await f.open();
  const admit = async () => {
    const call = await writer.capability(f.workspaceId, {
      kind: 'admit',
      workspaceId: f.workspaceId,
      now: new Date().toISOString(),
      context: {
        authorityActor: null,
        family: 'knowledge',
        operation: 'knowledge.ask',
        capabilityId: 'knowledge.ask',
        redactionClass: 'metadata-only',
      },
    });
    if (!call || typeof call !== 'object' || !('context' in call))
      throw new Error('Native Knowledge admission did not return its original Call.');
    return call;
  };
  const accepted = await admit();
  const refused = await admit();
  const answer = '\uFEFF' + '"\\\0\r\n\uFEFF🙂'.repeat(131_072);
  const expected = Buffer.from(answer, 'utf8');
  expect(expected.byteLength).toBeGreaterThan(1_048_576);
  const tuple = () =>
    [
      'SELECT * FROM capability_calls WHERE call_id = ?',
      'SELECT * FROM usage_records WHERE capability_call_id = ? ORDER BY usage_id',
      'SELECT * FROM audit_events WHERE capability_call_id = ? ORDER BY created_at',
    ].map((sql) => f.db.sqlite.prepare(sql).all(refused.id));
  const before = tuple();
  const finish = (call: typeof accepted) => {
    const now = new Date().toISOString();
    return writer.capability(f.workspaceId, {
      kind: 'usage-finish',
      workspaceId: f.workspaceId,
      call,
      finish: { status: 'succeeded', deliveredKnowledgeAnswer: answer, now },
      usage: { records: [{ category: 'tool', unit: 'capability_calls', quantity: 1 }], now },
    });
  };
  let corrupt = false;
  let frames = 0;
  let corruptedByteChanged = false;
  let corruptedFrameForwarded = false;
  const post = Worker.prototype.postMessage;
  // Inspect and corrupt only the real transferred frame; native SQL and acknowledgements stay real.
  const intercepted = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker['postMessage']>
  ) {
    const message = args[0];
    if (message.operation === 'capability' && message.content instanceof ArrayBuffer) {
      const { content, ...metadata } = message;
      ++frames;
      expect(content.byteLength).toBe(expected.byteLength);
      expect(Buffer.byteLength(JSON.stringify(metadata), 'utf8')).toBeLessThanOrEqual(1_048_576);
      expect(Array.isArray(args[1]) && args[1].length === 1 && args[1][0] === content).toBe(true);
      if (corrupt) {
        const bytes = new Uint8Array(content);
        const original = bytes[3];
        bytes.set([expected[3]! ^ 1], 3); // Valid UTF-8; declared length/digest stay unchanged.
        corruptedByteChanged = bytes[3] !== original;
        const result = post.apply(this, args);
        corruptedFrameForwarded = true;
        return result;
      }
    }
    return post.apply(this, args);
  });
  try {
    await expect(finish(accepted)).resolves.toHaveLength(1);
    corrupt = true;
    await expect(finish(refused)).rejects.toMatchObject({ commit: 'not-committed' });
    // A spy throw caught by client admission must not substitute for a native corruption refusal.
    expect(corruptedByteChanged).toBe(true);
    expect(corruptedFrameForwarded).toBe(true);
    expect(frames).toBe(2);
    expect(tuple()).toEqual(before);
  } finally {
    intercepted.mockRestore();
  }
  await writer.shutdown();
  f.db.sqlite.close();
  const reopened = openWorkspaceDb(f.root, f.workspaceId);
  databases.push(reopened);
  reopened.sqlite.pragma('query_only = ON');
  const calls = listWorkspaceCapabilityCalls(reopened, f.workspaceId);
  const retained = calls.find((call) => call.id === accepted.id)!;
  const delivery = retained.extensions?.['openkit.knowledge/delivery'] as { answer: string };
  // DX exact-byte retention and the original Call jointly decide publication, not the wire spy.
  expect(Buffer.from(delivery.answer, 'utf8').equals(expected)).toBe(true);
  expect(retained.status).toBe('succeeded');
  const rejected = calls.find((call) => call.id === refused.id)!;
  expect(rejected.status).toBe('running');
  expect(rejected.extensions?.['openkit.knowledge/delivery']).toBeUndefined();
});

it('commits a final no-contact refusal tuple and rolls it back on an actual native finish refusal', async () => {
  const f = fixture();
  const callId = allocateEntityId('cap');
  const allowId = allocateEntityId('pd');
  const refusalId = allocateEntityId('pd');
  const actor = f.actor;
  const now = new Date();
  const preparedDecision = (result: 'allow' | 'deny', decisionId: string) =>
    prepareControlPermissionDecision({
      workspaceDb: f.db,
      workspaceId: f.workspaceId,
      ownerScope: 'workspace',
      decisionId,
      policyEngineVersion: 'native-refusal-fixture:v1',
      policySnapshotId: 'native-refusal-policy',
      subjectSummary: { responsibleUserId: actor.id },
      action: 'tool.use',
      resourceSummary: { serverId: 'echo', toolName: 'echo' },
      contextSummary: {
        capabilityCallId: callId,
        ...(result === 'deny'
          ? { upstreamContacted: false, originEvaluationDecisionId: allowId }
          : {}),
      },
      result,
      reasonCode:
        result === 'deny' ? 'mcp_approval_submission_refused' : 'mcp_approval_grant_reauthorized',
      enforcementPoint: 'approval.respond',
      auditActor: actor,
      now,
    });
  // Fault setup precedes the sole native writer. ABORT preserves savepoint isolation.
  // The trigger fires only after this Call's actual terminal SQL update has executed.
  f.db.sqlite.exec(`
    CREATE TRIGGER sec2a_refuse_native_finish
    AFTER UPDATE OF completed_at ON capability_calls
    WHEN NEW.call_id = '${callId}' AND NEW.completed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'sec2a native finish refusal'); END
  `);
  const writer = await f.open();
  const admitted = await writer.capability(f.workspaceId, {
    kind: 'admit',
    workspaceId: f.workspaceId,
    callId,
    now: now.toISOString(),
    decision: preparedDecision('allow', allowId),
    context: {
      authorityActor: actor,
      family: 'mcp',
      operation: 'mcp.call-tool',
      capabilityId: 'mcp.call-tool',
      redactionClass: 'metadata-only',
      serviceRef: 'mcp-tool:echo',
    },
  });
  if (!admitted || typeof admitted !== 'object' || !('context' in admitted))
    throw new Error('Native MCP admission did not return its original Call.');
  const tuple = () => ({
    calls: listWorkspaceCapabilityCalls(f.db, f.workspaceId),
    decisions: listExportableWorkspacePermissionDecisions(f.db, f.workspaceId),
    audit: listWorkspaceAuditEvents(f.db, f.workspaceId),
    usage: listWorkspaceUsageRecords(f.db, f.workspaceId),
  });
  const before = tuple();
  expect(before.decisions).toEqual([
    expect.objectContaining({ decisionId: allowId, result: 'allow' }),
  ]);
  const decision = preparedDecision('deny', refusalId);
  const finish = async () =>
    writer.capability(
      f.workspaceId,
      ControlCapabilityCommandInputSchema.parse({
        kind: 'usage-finish',
        workspaceId: f.workspaceId,
        call: admitted,
        decision,
        finish: { status: 'failed', errorCode: 'credentials-invalid', now: now.toISOString() },
      })
    );
  // The original schema rejects the new participant. After admission is implemented,
  // only the actual native SQL constraint is sufficient proof of this rollback path.
  await expect(finish()).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
  expect(tuple()).toEqual(before);

  // The definite refusal permits a fresh submission. Exclude native writes during fault removal.
  await writer.close(f.workspaceId);
  f.db.sqlite.pragma('query_only = OFF');
  f.db.sqlite.exec('DROP TRIGGER sec2a_refuse_native_finish');
  // A second cut detects a separately committed Call when the decision is recorded later.
  // Together the cuts prove rollback without prescribing the participant order.
  f.db.sqlite.exec(`
    CREATE TRIGGER sec2a_refuse_native_decision_audit
    AFTER INSERT ON audit_events
    WHEN NEW.permission_decision_id = '${refusalId}' AND NEW.action = 'permission.decision'
    BEGIN SELECT RAISE(ABORT, 'sec2a native decision Audit refusal'); END
  `);
  f.db.sqlite.pragma('query_only = ON');
  await f.open();
  await expect(finish()).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
  expect(tuple()).toEqual(before);

  await writer.close(f.workspaceId);
  f.db.sqlite.pragma('query_only = OFF');
  f.db.sqlite.exec('DROP TRIGGER sec2a_refuse_native_decision_audit');
  f.db.sqlite.pragma('query_only = ON');
  await f.open();
  await expect(finish()).resolves.toBeNull();
  const after = tuple();
  expect(after.calls).toEqual([expect.objectContaining({ id: callId, status: 'failed' })]);
  expect(after.usage).toEqual([]);
  expect(after.decisions.find((row) => row.decisionId === allowId)).toEqual(before.decisions[0]);
  expect(after.decisions).toHaveLength(2);
  expect(after.decisions.find((row) => row.decisionId === refusalId)).toMatchObject({
    result: 'deny',
    contextSummary: { capabilityCallId: callId, upstreamContacted: false },
  });
  expect(after.audit.filter((row) => row.permissionDecisionId === allowId)).toEqual(
    before.audit.filter((row) => row.permissionDecisionId === allowId)
  );
  expect(after.audit.filter((row) => row.permissionDecisionId === refusalId)).toEqual([
    expect.objectContaining({
      action: 'permission.decision',
      capabilityCallId: callId,
      outcome: 'denied',
    }),
  ]);
  expect(after.audit.filter((row) => row.action === 'capability.finish')).toEqual([
    expect.objectContaining({ capabilityCallId: callId, outcome: 'failed' }),
  ]);
});
