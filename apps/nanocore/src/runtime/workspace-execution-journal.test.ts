import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import { controlStoreFor } from '../storage/control-store.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { createExecutionStepJournalReader } from './execution-journal.js';
import type { ExecutionJournalSpan, ExecutionStepControl } from './execution-step-journal.js';

/** Encodes the retained v1 typed values, not a telemetry projection or an execution grant. */
function retained(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
}

/** Gives the reader a lossless diagnostic envelope, including non-authoritative Worker markers. */
function span(id: number): ExecutionJournalSpan {
  return {
    traceId: '1'.repeat(32),
    spanId: id.toString(16).padStart(16, '0'),
    traceState: 'vendor=workspace-reader',
    flags: 1,
    name: 'Workspace invocation',
    kind: 'INTERNAL',
    startTimeUnixNano: 1_760_000_000_123_456_789n,
    endTimeUnixNano: null,
    status: { code: 'UNSET' },
    attributes: [
      { key: 'minimum', value: { type: 'int', value: -9_223_372_036_854_775_808n } },
      { key: 'maximum', value: { type: 'int', value: 9_223_372_036_854_775_807n } },
      { key: 'double', value: { type: 'double', value: 1 } },
      { key: 'empty', value: { type: 'empty' } },
      { key: 'bytes', value: { type: 'bytes', value: [0, 128, 255] } },
      {
        key: 'nested',
        value: {
          type: 'array',
          value: [
            {
              type: 'kvlist',
              value: [{ key: 'text', value: { type: 'string', value: 'bounded' } }],
            },
          ],
        },
      },
      { key: 'openkit.report.origin', value: { type: 'string', value: 'worker' } },
      { key: 'openkit.report.verified', value: { type: 'boolean', value: false } },
    ],
    droppedAttributesCount: 2,
    events: [
      {
        timeUnixNano: 1_760_000_000_123_456_790n,
        name: 'first',
        attributes: [],
        droppedAttributesCount: 3,
      },
      {
        timeUnixNano: 1_760_000_000_123_456_791n,
        name: 'second',
        attributes: [],
        droppedAttributesCount: 0,
      },
    ],
    droppedEventsCount: 4,
    links: [],
    droppedLinksCount: 5,
    instrumentationScope: {
      name: 'openkit.workspace-journal-reader',
      version: '1',
      schemaUrl: 'https://opentelemetry.io/schemas/1.36.0',
      attributes: [{ key: 'scope', value: { type: 'bytes', value: [128] } }],
      droppedAttributesCount: 6,
    },
    resource: {
      schemaUrl: 'https://opentelemetry.io/schemas/1.36.0',
      attributes: [{ key: 'service.name', value: { type: 'string', value: 'reader-fixture' } }],
      droppedAttributesCount: 7,
    },
  };
}

/** Uses native migrations and awaited canonical work owners; the native writer drains before root removal. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-journal-'));
  const core = openCoreDb(root);
  let db: ReturnType<typeof openWorkspaceDb>;
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    if (db?.sqlite.open) db.sqlite.close();
    if (core.sqlite.open) core.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(core);
  const actor: ExecutionStepControl['actor'] = { kind: 'user', id: ensureLocalUser(core) };
  const store = new FsStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Journal reader', {
    producer: actor,
    requestId: randomUUID(),
    instructionReference: 'test:workspace-journal',
  });
  const thread = await store.createThread(workspace.id, 'Journal work');
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    'Read retained invocation history.',
    actor
  );
  db = openWorkspaceDb(root, workspace.id);
  applyScopedMigrations(db);
  const owner = { kind: 'workspace' as const, workspaceId: workspace.id };
  const ref = { owner, executionId: turn.id };
  return {
    actor,
    turn,
    thread,
    ref,
    get db() {
      return db;
    },
    get reader() {
      return createExecutionStepJournalReader(db, owner);
    },
    requireSchema() {
      const tables = db.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('control_executions', 'control_execution_steps') ORDER BY name"
        )
        .all();
      expect(tables).toEqual([{ name: 'control_execution_steps' }, { name: 'control_executions' }]);
    },
    reopen() {
      db.sqlite.close();
      db = openWorkspaceDb(root, workspace.id);
    },
  };
}

/** Seeds native retained rows to test constraints/readers only; this is not an ordinary producer, live clock witness or settlement-cohort proof. */
function history(f: Awaited<ReturnType<typeof fixture>>) {
  const rootSpan = span(1);
  const deadline = BigInt(Date.now() + 60_000) * 1_000_000n + 789n;
  const clock = {
    processWitness: 'terminated-reader-fixture',
    admittedUnixNano: 1_760_000_000_123_456_789n,
    admittedMonotonicNano: 123n,
  };
  const exclusion = [`thread:${f.thread.id}`];
  const rows = [1, 2, 3].map((id) => {
    const state =
      id === 1 ? ('intent' as const) : id === 2 ? ('unknown' as const) : ('completed' as const);
    const control: ExecutionStepControl = {
      definitionVersion: 'workspace-worker-turn/v1',
      kind: id === 3 ? 'inspect-cleanup' : 'open-session',
      target:
        id === 3
          ? null
          : { backendKind: 'nanohost', targetId: `reader-target-${id}`, allocationRef: null },
      workId: f.turn.id,
      operationId: null,
      attemptId: null,
      invocationId: `reader-invocation-${id}`,
      actor: f.actor,
      inputRefs: [`turn:${f.turn.id}`],
      outputRefs: [],
      fingerprint: 'b'.repeat(64),
      permittingDecisionRef: null,
      authorityRefs: [],
      retryDeclarationRef: null,
      retryPermitted: false,
      deadlineUnixNano: deadline,
      physicalFenceRefs: [],
    };
    const stepSpan: ExecutionJournalSpan = {
      ...span(id + 1),
      parentSpanId: id === 2 ? span(2).spanId : rootSpan.spanId,
      endTimeUnixNano: state === 'intent' ? null : 1_760_000_000_246_913_578n,
      status:
        state === 'unknown'
          ? { code: 'ERROR', description: 'Outcome remains unknown.' }
          : state === 'completed'
            ? { code: 'OK' }
            : { code: 'UNSET' },
      links:
        id === 3
          ? [
              {
                traceId: rootSpan.traceId,
                spanId: span(3).spanId,
                flags: 1,
                traceState: 'vendor=inspection',
                attributes: [],
                droppedAttributesCount: 8,
              },
            ]
          : [],
    };
    const invocation = {
      parent:
        id === 2
          ? { ref: { execution: f.ref, stepId: 'step-1' }, deadlineUnixNano: deadline }
          : null,
      carriage: {
        operation: id === 3 ? 'session.inspect' : 'session.open',
        requestId: `reader-request-${id}`,
        sequence: id - 1,
        bindingRef: `reader-binding-${id}`,
      },
      clock,
    };
    return {
      id,
      state,
      control,
      span: stepSpan,
      invocation,
      ref: { execution: f.ref, stepId: `step-${id}` },
    };
  });
  controlStoreFor(f.db.sqlite).write((sql) => {
    sql
      .prepare(`INSERT INTO control_executions
      (id,schema_version,owner_json,work_id,definition_version,input_fingerprint,phase,revision,terminal_cause,exclusion_refs_json,span_json)
      VALUES (?,1,?,?,'workspace-worker-turn/v1',?,'open',4,NULL,?,?)`)
      .run(
        f.ref.executionId,
        retained(f.ref.owner),
        f.turn.id,
        'a'.repeat(64),
        retained(exclusion),
        retained(rootSpan)
      );
    for (const row of rows)
      sql
        .prepare(`INSERT INTO control_execution_steps
      (execution_id,step_id,schema_version,ordinal,parent_step_id,state,invocation_id,control_json,invocation_json,span_json,inspected_execution_id,inspected_step_id)
      VALUES (?,?,1,?,?,?,?,?,?,?,?,?)`)
        .run(
          f.ref.executionId,
          row.ref.stepId,
          row.id,
          row.id === 2 ? 'step-1' : null,
          row.state,
          row.control.invocationId,
          retained(row.control),
          retained(row.invocation),
          retained(row.span),
          row.id === 3 ? f.ref.executionId : null,
          row.id === 3 ? 'step-2' : null
        );
  });
  return { rows, rootSpan, exclusion, deadline, clock };
}

describe('Workspace execution journal native constraints and persisted views', () => {
  it('T1 rejects invocation reuse and an absent control parent in the real Workspace schema', async () => {
    const f = await fixture();
    f.requireSchema();
    history(f);
    const before = f.db.sqlite.serialize();
    // Exercise native constraints on existing valid rows; never create a substitute schema or ledger.
    expect(() =>
      f.db.sqlite
        .prepare(`INSERT INTO control_execution_steps
      (execution_id,step_id,schema_version,ordinal,parent_step_id,state,invocation_id,control_json,invocation_json,span_json,inspected_execution_id,inspected_step_id)
      SELECT execution_id,'duplicate-invocation',schema_version,4,NULL,state,invocation_id,control_json,invocation_json,span_json,NULL,NULL
      FROM control_execution_steps WHERE step_id = 'step-1'`)
        .run()
    ).toThrow();
    expect(() =>
      f.db.sqlite
        .prepare(
          "UPDATE control_execution_steps SET parent_step_id = 'absent-parent' WHERE step_id = 'step-1'"
        )
        .run()
    ).toThrow();
    expect(f.db.sqlite.serialize().equals(before)).toBe(true);
  });

  it('T1 isolates native scope/version constraints and missing or corrupt authority', async () => {
    const f = await fixture();
    f.requireSchema();
    history(f);
    const reader = f.reader;
    expect((await reader.readExecution(f.ref)).workId).toBe(f.turn.id);
    expect(() => createExecutionStepJournalReader(f.db, { kind: 'server' })).toThrow();
    expect(() =>
      createExecutionStepJournalReader(f.db, {
        kind: 'workspace',
        workspaceId: testEntityId('ws', 'other-reader-owner'),
      })
    ).toThrow();
    await expect(
      reader.readExecution({ ...f.ref, executionId: 'missing-execution' })
    ).rejects.toThrow();
    const before = f.db.sqlite.prepare('SELECT * FROM control_executions').all();
    expect(() =>
      f.db.sqlite.prepare('UPDATE control_executions SET schema_version = 2').run()
    ).toThrow();
    expect(() =>
      f.db.sqlite
        .prepare(
          "UPDATE control_execution_steps SET state = 'invented-state' WHERE step_id = 'step-1'"
        )
        .run()
    ).toThrow();
    expect(f.db.sqlite.prepare('SELECT * FROM control_executions').all()).toEqual(before);
    // Native constraints allow descriptive JSON; a malformed required descriptor still must fail in the reader.
    f.db.sqlite
      .prepare(
        "UPDATE control_executions SET span_json = json_set(span_json, '$.resource.droppedAttributesCount', 'corrupt')"
      )
      .run();
    await expect(reader.readExecution(f.ref)).rejects.toThrow();
  });

  it('T4 preserves independent targets and immutable unknown child history', async () => {
    const f = await fixture();
    f.requireSchema();
    const h = history(f);
    f.reopen();
    const reader = f.reader;
    expect((await reader.readInvocation(h.rows[0]!.ref)).control.target).toEqual({
      backendKind: 'nanohost',
      targetId: 'reader-target-1',
      allocationRef: null,
    });
    expect((await reader.readInvocation(h.rows[1]!.ref)).control.target).toEqual({
      backendKind: 'nanohost',
      targetId: 'reader-target-2',
      allocationRef: null,
    });
    const before = await reader.readEndedSteps(f.ref);
    expect(() =>
      f.db.sqlite
        .prepare("UPDATE control_execution_steps SET state = 'completed' WHERE step_id = 'step-2'")
        .run()
    ).toThrow();
    expect(await reader.readEndedSteps(f.ref)).toStrictEqual(before);
    expect((await reader.readExecution(f.ref)).exclusionRefs).toEqual(h.exclusion);
    expect((await reader.readInvocation(h.rows[1]!.ref)).parent).toStrictEqual(
      h.rows[1]!.invocation.parent
    );
    expect((await reader.readInvocation(h.rows[2]!.ref)).control.target).toBeNull();
  });

  it('T5 cannot turn a retired clock or diagnostic marker into renewed allowance', async () => {
    const f = await fixture();
    f.requireSchema();
    const h = history(f);
    f.reopen();
    for (const row of h.rows) {
      const invocation = await f.reader.readInvocation(row.ref);
      expect(invocation.remainingMs).toBe(0);
      expect(invocation.clock).toStrictEqual(h.clock);
      expect(invocation.control.deadlineUnixNano).toBe(h.deadline);
      expect(invocation.control.retryPermitted).toBe(false);
      expect(invocation.control.physicalFenceRefs).toEqual([]);
    }
    expect((await f.reader.readExecution(f.ref)).exclusionRefs).toEqual(h.exclusion);
  });

  it('T6 retains exact typed open, ended and linked reader views after cold reopen without writes', async () => {
    const f = await fixture();
    f.requireSchema();
    const h = history(f);
    f.reopen();
    const reader = f.reader;
    const bytes = f.db.sqlite.serialize();
    const changes = f.db.sqlite.prepare('SELECT total_changes() AS count').get();
    const expected = h.rows.slice(1).map((row) => ({
      ref: row.ref,
      state: row.state,
      control: row.control,
      rootSpanId: h.rootSpan.spanId,
      span: row.span,
    }));
    for (let repeat = 0; repeat < 2; repeat += 1) {
      expect(await reader.readExecution(f.ref)).toStrictEqual({
        ref: f.ref,
        definitionVersion: 'workspace-worker-turn/v1',
        workId: f.turn.id,
        fingerprint: 'a'.repeat(64),
        phase: 'open',
        revision: 4,
        terminalCause: null,
        exclusionRefs: h.exclusion,
        span: h.rootSpan,
        openSteps: [h.rows[0]!.ref],
      });
      expect(await reader.readEndedSteps(f.ref)).toStrictEqual(expected);
      expect(await reader.readLinkedInspections(h.rows[1]!.ref)).toStrictEqual([
        { inspectedStep: h.rows[1]!.ref, inspection: expected[1] },
      ]);
      expect((await reader.readInvocation(h.rows[0]!.ref)).state).toBe('intent');
    }
    expect(f.db.sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(f.db.sqlite.serialize().equals(bytes)).toBe(true);
  });
});
