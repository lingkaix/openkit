import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { controlStoreFor } from '../storage/control-store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION,
  createExecutionStepJournalReader,
  settleExecutionJournalStep,
  writeExecutionJournalIntent,
} from './execution-journal.js';
import type {
  ExecutionJournalAdmission,
  ExecutionJournalIntent,
  ExecutionJournalSettlement,
  ExecutionJournalSpan,
} from './execution-step-journal.js';

// These contracts require the real migration and implementation tracked in docs/changes/202610201240000000-core_execution_journal/plan.md.
// Until then, typecheck only: unavailable methods or tables are blockers, not behavioral RED.
// No readiness skip or substitute journal is permitted; ordinary producer ordering/atomicity needs its own crossing.

/** Exercises every retained AnyValue kind without converting bigint or narrowing span metadata. */
function openSpan(id: number): ExecutionJournalSpan & { endTimeUnixNano: null } {
  const time = BigInt(Date.now()) * 1_000_000n + 123n;
  return {
    traceId: '1'.repeat(32),
    spanId: id.toString(16).padStart(16, '0'),
    traceState: 'vendor=journal-fixture',
    flags: 1,
    name: 'administrative image preparation',
    kind: 'INTERNAL',
    startTimeUnixNano: time,
    endTimeUnixNano: null,
    status: { code: 'UNSET' },
    attributes: [
      { key: 'empty', value: { type: 'empty' } },
      { key: 'text', value: { type: 'string', value: 'bounded diagnostic' } },
      { key: 'flag', value: { type: 'boolean', value: false } },
      { key: 'minimum', value: { type: 'int', value: -9_223_372_036_854_775_808n } },
      { key: 'maximum', value: { type: 'int', value: 9_223_372_036_854_775_807n } },
      { key: 'unsafe-number', value: { type: 'int', value: 9_007_199_254_740_993n } },
      { key: 'double-one', value: { type: 'double', value: 1.0 } },
      { key: 'binary', value: { type: 'bytes', value: [0, 128, 255] } },
      {
        key: 'nested',
        value: {
          type: 'array',
          value: [
            { type: 'int', value: 1n },
            { type: 'kvlist', value: [{ key: 'item', value: { type: 'boolean', value: true } }] },
          ],
        },
      },
    ],
    droppedAttributesCount: 2,
    events: [
      { timeUnixNano: time + 1n, name: 'first', attributes: [], droppedAttributesCount: 1 },
      { timeUnixNano: time + 2n, name: 'second', attributes: [], droppedAttributesCount: 0 },
    ],
    droppedEventsCount: 3,
    links: [
      {
        traceId: '2'.repeat(32),
        spanId: '2'.repeat(16),
        traceState: 'vendor=linked',
        flags: 1,
        attributes: [{ key: 'ordinal', value: { type: 'int', value: 2n } }],
        droppedAttributesCount: 4,
      },
      {
        traceId: '3'.repeat(32),
        spanId: '3'.repeat(16),
        flags: 0,
        attributes: [],
        droppedAttributesCount: 0,
      },
    ],
    droppedLinksCount: 5,
    instrumentationScope: {
      name: 'openkit.independent-journal-fixture',
      version: '1',
      schemaUrl: 'https://opentelemetry.io/schemas/1.36.0',
      attributes: [{ key: 'scope', value: { type: 'bytes', value: [128] } }],
      droppedAttributesCount: 6,
    },
    resource: {
      schemaUrl: 'https://opentelemetry.io/schemas/1.36.0',
      attributes: [{ key: 'service.name', value: { type: 'string', value: 'journal-fixture' } }],
      droppedAttributesCount: 7,
    },
  };
}

/** Supplies explicit primitive inputs, not actor authorization, receiver proof or an administrative producer. */
function journalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-execution-journal-'));
  let db = openCoreDb(root);
  onTestFinished(() => {
    if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(db);
  const execution: ExecutionJournalAdmission = {
    ref: { owner: { kind: 'server' }, executionId: 'independent-image-preparation' },
    definitionVersion: 'core-image-acquire/v1',
    workId: testEntityId('tu', 'journal-primitive-work'),
    fingerprint: 'a'.repeat(64),
    exclusionRefs: ['fixture:retained-exclusion:v1'],
    span: openSpan(1),
  };
  const deadline = BigInt(Date.now() + 60_000) * 1_000_000n + 789n;
  return {
    root,
    execution,
    get db() {
      return db;
    },
    get reader() {
      return createExecutionStepJournalReader(db, { kind: 'server' });
    },
    reopen() {
      db.sqlite.close();
      db = openCoreDb(root);
    },
    intent(id = 1): ExecutionJournalIntent {
      return {
        execution,
        stepId: `step-${id}`,
        parentStepId: null,
        parent: null,
        inspectedStep: null,
        carriage: {
          operation: 'image.acquire',
          requestId: id.toString(16).padStart(64, '0'),
          sequence: null,
          bindingRef: null,
        },
        control: {
          definitionVersion: execution.definitionVersion,
          kind: 'resolve-setup',
          target: {
            backendKind: 'nanohost',
            targetId: 'fixture-selected-target',
            allocationRef: null,
          },
          workId: execution.workId,
          operationId: null,
          attemptId: null,
          invocationId: `independent-invocation-${id}`,
          actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
          inputRefs: ['fixture:immutable-image-input:v1'],
          outputRefs: [],
          fingerprint: 'b'.repeat(64),
          permittingDecisionRef: null,
          authorityRefs: ['fixture:admitted-authority:v1'],
          retryDeclarationRef: null,
          retryPermitted: false,
          deadlineUnixNano: deadline,
          physicalFenceRefs: [],
        },
        span: { ...openSpan(id + 1), parentSpanId: execution.span.spanId },
      };
    },
  };
}

/** Selects the actual persisted revision; a prepared end is not a receipt or an effect result. */
async function ending(
  fixture: ReturnType<typeof journalFixture>,
  intent: ExecutionJournalIntent,
  state: ExecutionJournalSettlement['state'] = 'completed'
): Promise<ExecutionJournalSettlement> {
  const execution = await fixture.reader.readExecution(intent.execution.ref);
  return {
    ref: { execution: intent.execution.ref, stepId: intent.stepId },
    expectedExecutionRevision: execution.revision,
    state,
    outputRefs: ['fixture:retained-result:v1'],
    span: {
      ...intent.span,
      endTimeUnixNano: intent.span.startTimeUnixNano + 123_456_789n,
      status:
        state === 'unknown'
          ? { code: 'ERROR', description: 'Effect outcome remains unknown.' }
          : { code: 'OK' },
      attributes:
        state === 'unknown'
          ? [
              ...intent.span.attributes,
              { key: 'openkit.outcome.uncertain', value: { type: 'boolean', value: true } },
            ]
          : intent.span.attributes,
    },
    nextPhase: 'open',
    terminalCause: null,
    exclusionRefs: intent.execution.exclusionRefs,
  };
}

describe('persisted execution journal contracts', () => {
  it('round-trips exact typed root, invocation and ended span without a Workspace', async () => {
    expect(CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION).toBe('core-image-acquire/v1');
    const f = journalFixture();
    const intent = f.intent();
    const admitted = controlStoreFor(f.db.sqlite).write(() =>
      writeExecutionJournalIntent(f.db, intent)
    );
    expect(admitted.control).toStrictEqual(intent.control);
    expect(admitted.carriage).toStrictEqual(intent.carriage);
    expect(admitted.clock.processWitness).not.toBe('');
    expect(typeof admitted.clock.admittedUnixNano).toBe('bigint');
    expect(typeof admitted.clock.admittedMonotonicNano).toBe('bigint');
    expect(admitted.remainingMs).toBeGreaterThan(0);
    expect(admitted.remainingMs).toBeLessThanOrEqual(60_001);
    expect(await f.reader.readExecution(intent.execution.ref)).toMatchObject({
      span: intent.execution.span,
      openSteps: [admitted.ref],
    });
    const outcome = await ending(f, intent);
    const ended = controlStoreFor(f.db.sqlite).write(() =>
      settleExecutionJournalStep(f.db, outcome)
    );
    expect(ended.span).toStrictEqual(outcome.span);
    expect(ended.rootSpanId).toBe(intent.execution.span.spanId);
    expect(ended.control).toStrictEqual({ ...intent.control, outputRefs: outcome.outputRefs });
    f.reopen();
    expect(await f.reader.readEndedSteps(intent.execution.ref)).toStrictEqual([ended]);
    expect(await f.reader.readEndedSteps(intent.execution.ref)).toStrictEqual([ended]);
    expect(await f.reader.readInvocation(admitted.ref)).toMatchObject({
      state: 'completed',
      clock: admitted.clock,
      remainingMs: 0,
    });
    expect(await f.reader.readExecution(intent.execution.ref)).toMatchObject({
      span: intent.execution.span,
      openSteps: [],
    });
    expect(
      readdirSync(f.root, { recursive: true }).filter((path) => String(path).endsWith('.sqlite'))
    ).toEqual([join('server', 'db', 'core.sqlite')]);
  });

  it('refuses changed input under the original invocation without changing its retained authority', async () => {
    const f = journalFixture();
    const intent = f.intent();
    const first = controlStoreFor(f.db.sqlite).write(() =>
      writeExecutionJournalIntent(f.db, intent)
    );
    const before = await f.reader.readExecution(intent.execution.ref);
    expect(() =>
      controlStoreFor(f.db.sqlite).write(() =>
        writeExecutionJournalIntent(f.db, {
          ...intent,
          control: { ...intent.control, fingerprint: 'c'.repeat(64) },
        })
      )
    ).toThrow();
    expect(await f.reader.readExecution(intent.execution.ref)).toStrictEqual(before);
    const after = await f.reader.readInvocation(first.ref);
    expect(after.control).toStrictEqual(first.control);
    expect(after.clock).toStrictEqual(first.clock);
    expect(after.remainingMs).toBeLessThanOrEqual(first.remainingMs);
    expect(await f.reader.readEndedSteps(intent.execution.ref)).toEqual([]);
  });

  it('retains concurrent per-step targets and conditions settlement on the current execution revision', async () => {
    const f = journalFixture();
    const first = f.intent();
    const second = f.intent(2);
    const local = { ...second, control: { ...second.control, target: null } };
    const a = controlStoreFor(f.db.sqlite).write(() => writeExecutionJournalIntent(f.db, first));
    const b = controlStoreFor(f.db.sqlite).write(() => writeExecutionJournalIntent(f.db, local));
    f.reopen();
    const currentSteps = (await f.reader.readExecution(first.execution.ref)).openSteps;
    expect(currentSteps).toHaveLength(2);
    expect(currentSteps).toEqual(expect.arrayContaining([a.ref, b.ref]));
    expect((await f.reader.readInvocation(a.ref)).control.target).toEqual(first.control.target);
    expect((await f.reader.readInvocation(b.ref)).control.target).toBeNull();
    const endA = await ending(f, first);
    const staleB = await ending(f, local);
    controlStoreFor(f.db.sqlite).write(() => settleExecutionJournalStep(f.db, endA));
    expect(() =>
      controlStoreFor(f.db.sqlite).write(() => settleExecutionJournalStep(f.db, staleB))
    ).toThrow();
    expect((await f.reader.readInvocation(b.ref)).state).toBe('intent');
    expect((await f.reader.readExecution(first.execution.ref)).openSteps).toEqual([b.ref]);
    const currentB = await ending(f, local);
    controlStoreFor(f.db.sqlite).write(() => settleExecutionJournalStep(f.db, currentB));
    expect((await f.reader.readExecution(first.execution.ref)).openSteps).toEqual([]);
    expect(await f.reader.readEndedSteps(first.execution.ref)).toHaveLength(2);
  });

  it('keeps a nested unknown child immutable when the parent completes and late inspection is linked', async () => {
    const f = journalFixture();
    const parent = f.intent();
    const parentInvocation = controlStoreFor(f.db.sqlite).write(() =>
      writeExecutionJournalIntent(f.db, parent)
    );
    const child: ExecutionJournalIntent = {
      ...f.intent(2),
      parentStepId: parent.stepId,
      parent: { ref: parentInvocation.ref, deadlineUnixNano: parent.control.deadlineUnixNano },
      span: { ...openSpan(3), parentSpanId: parent.span.spanId },
    };
    const childInvocation = controlStoreFor(f.db.sqlite).write(() =>
      writeExecutionJournalIntent(f.db, child)
    );
    const unknownInput = await ending(f, child, 'unknown');
    const unknown = controlStoreFor(f.db.sqlite).write(() =>
      settleExecutionJournalStep(f.db, unknownInput)
    );
    const completedParent = await ending(f, parent);
    const endedParent = controlStoreFor(f.db.sqlite).write(() =>
      settleExecutionJournalStep(f.db, completedParent)
    );
    const inspectionInput = f.intent(3);
    const inspection: ExecutionJournalIntent = {
      ...inspectionInput,
      inspectedStep: childInvocation.ref,
      control: { ...inspectionInput.control, kind: 'inspect-cleanup' },
      carriage: { ...inspectionInput.carriage, operation: 'image.inspect' },
      span: {
        ...openSpan(4),
        parentSpanId: f.execution.span.spanId,
        links: [
          {
            traceId: unknown.span.traceId,
            spanId: unknown.span.spanId,
            flags: 1,
            attributes: [],
            droppedAttributesCount: 0,
          },
        ],
      },
    };
    controlStoreFor(f.db.sqlite).write(() => writeExecutionJournalIntent(f.db, inspection));
    const inspectionEnd = await ending(f, inspection);
    const inspected = controlStoreFor(f.db.sqlite).write(() =>
      settleExecutionJournalStep(f.db, inspectionEnd)
    );
    f.reopen();
    expect(await f.reader.readLinkedInspections(childInvocation.ref)).toStrictEqual([
      { inspectedStep: childInvocation.ref, inspection: inspected },
    ]);
    expect(await f.reader.readEndedSteps(parent.execution.ref)).toStrictEqual([
      endedParent,
      unknown,
      inspected,
    ]);
    expect(
      (await f.reader.readEndedSteps(parent.execution.ref)).find(
        (step) => step.ref.stepId === child.stepId
      )
    ).toStrictEqual(unknown);
    expect(await f.reader.readInvocation(childInvocation.ref)).toMatchObject({
      state: 'unknown',
      parent: child.parent,
      remainingMs: 0,
      control: { deadlineUnixNano: child.control.deadlineUnixNano },
    });
    const rewrite = await ending(f, child);
    expect(() =>
      controlStoreFor(f.db.sqlite).write(() => settleExecutionJournalStep(f.db, rewrite))
    ).toThrow();
    expect((await f.reader.readExecution(parent.execution.ref)).exclusionRefs).toEqual(
      f.execution.exclusionRefs
    );
    expect(
      (await f.reader.readEndedSteps(parent.execution.ref)).find(
        (step) => step.ref.stepId === child.stepId
      )
    ).toStrictEqual(unknown);
  });

  it('reads original intent after a fresh process opens Core without granting a restarted allowance', () => {
    const f = journalFixture();
    const intent = f.intent();
    const original = controlStoreFor(f.db.sqlite).write(() =>
      writeExecutionJournalIntent(f.db, intent)
    );
    expect(original.remainingMs).toBeGreaterThan(0);
    f.db.sqlite.close();
    const source = `
      import { openCoreDb } from ${JSON.stringify(new URL('../storage/db.ts', import.meta.url).href)};
      import { createExecutionStepJournalReader } from ${JSON.stringify(new URL('./execution-journal.ts', import.meta.url).href)};
      const db = openCoreDb(process.argv[1]);
      try {
        const reader = createExecutionStepJournalReader(db, { kind: 'server' });
        const ref = { execution: { owner: { kind: 'server' }, executionId: process.argv[2] }, stepId: process.argv[3] };
        const invocation = await reader.readInvocation(ref);
        console.log(JSON.stringify({ state: invocation.state, remainingMs: invocation.remainingMs, clock: invocation.clock, deadline: invocation.control.deadlineUnixNano }, (_, value) => typeof value === 'bigint' ? value.toString() : value));
      } finally { db.sqlite.close(); }
    `;
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        source,
        f.root,
        intent.execution.ref.executionId,
        intent.stepId,
      ],
      { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 15_000 }
    );
    expect(JSON.parse(output)).toEqual({
      state: 'intent',
      remainingMs: 0,
      clock: {
        processWitness: original.clock.processWitness,
        admittedUnixNano: original.clock.admittedUnixNano.toString(),
        admittedMonotonicNano: original.clock.admittedMonotonicNano.toString(),
      },
      deadline: original.control.deadlineUnixNano?.toString(),
    });
  });
});
