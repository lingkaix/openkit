import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { controlStoreFor } from '../storage/control-store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  admitRepairCallEntryInDb,
  CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION,
  CORE_REPAIR_EXECUTION_DEFINITION,
  commitRepairReservationStep,
  commitRepairTerminalAuditInDb,
  createExecutionStepJournalReader,
  inspectRepairReservationStep,
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

  it('deducts one repair slot and atomically settles the original terminal Audit', async () => {
    const f = journalFixture();
    const allocation = {
      kind: 'repair.model-call',
      scope: 'server',
      unit: 'model-call',
      window: 'utc-day',
      limit: 1,
    } as const;
    const prepare = (n: number) => {
      const draft = f.intent(n);
      const execution = {
        ...draft.execution,
        ref: { ...draft.execution.ref, executionId: `repair-${n}` },
        definitionVersion: CORE_REPAIR_EXECUTION_DEFINITION,
      };
      const entry: ExecutionJournalIntent = {
        ...draft,
        execution,
        control: {
          ...draft.control,
          definitionVersion: execution.definitionVersion,
          kind: 'admit',
          attemptId: `repair-attempt-${n}`,
          permittingDecisionRef: testEntityId('pd', `repair-decision-${n}`),
          authorityRefs: ['role:repair'],
        },
        carriage: { ...draft.carriage, operation: 'repair.model-call' },
      };
      const choice = {
        callId: `repair-call-${n}`,
        routeRef: 'route:repair',
        allocationRef: 'allocation:server',
        policyRevision: `sha256:${'b'.repeat(64)}`,
        inputDigest: 'a'.repeat(64),
      };
      const open = (qualified: boolean) =>
        controlStoreFor(f.db.sqlite).write(() =>
          admitRepairCallEntryInDb(f.db, entry, choice, () => qualified)
        );
      expect(open(false)).toEqual({ state: 'unknown' });
      const admitted = open(true);
      if (admitted.state !== 'settled')
        throw new Error('Fixture did not admit the original repair.');
      expect(open(false)).toEqual(admitted);
      const intent = admitted.receipt;
      const proposal: ExecutionJournalIntent = {
        ...entry,
        stepId: `reserve-${n}`,
        inspectedStep: intent.target.entryStep,
        control: { ...entry.control, kind: 'reserve', invocationId: intent.requestId },
        span: {
          ...openSpan(n + 20),
          parentSpanId: execution.span.spanId,
          links: [
            {
              traceId: entry.span.traceId,
              spanId: entry.span.spanId,
              flags: 0,
              attributes: [],
              droppedAttributesCount: 0,
            },
          ],
        },
      };
      return { intent, proposal, entry, choice };
    };
    const prepared = [prepare(1), prepare(2)] as const;
    const [{ intent: original, proposal: originalProposal, entry, choice }] = prepared;
    f.reopen();
    const admit = (draft = entry, input = choice, qualified = true) =>
      controlStoreFor(f.db.sqlite).write(() =>
        admitRepairCallEntryInDb(f.db, draft, input, () => qualified)
      );
    expect(admit(entry, choice, false)).toEqual({ state: 'settled', receipt: original });
    expect(
      admit({
        ...entry,
        execution: {
          ...entry.execution,
          ref: { ...entry.execution.ref, executionId: 'substituted-repair' },
        },
        stepId: 'substituted-entry',
        control: {
          ...entry.control,
          attemptId: 'substituted-attempt',
          invocationId: 'substituted-invocation',
        },
      })
    ).toEqual({ state: 'conflict' });
    const otherActor = { kind: 'user' as const, id: testEntityId('usr', 'different-repair-user') };
    expect(admit({ ...entry, control: { ...entry.control, actor: otherActor } })).toEqual({
      state: 'conflict',
    });
    expect(admit(entry, { ...choice, routeRef: 'route:replacement' })).toEqual({
      state: 'conflict',
    });
    expect(admit(entry, { ...choice, inputDigest: 'c'.repeat(64) })).toEqual({ state: 'conflict' });
    expect(
      f.db.sqlite.prepare('SELECT 1 FROM control_executions WHERE id=?').get('substituted-repair')
    ).toBeUndefined();
    expect(
      controlStoreFor(f.db.sqlite).write(() =>
        commitRepairReservationStep(f.db, original, originalProposal, () => null, true)
      )
    ).toEqual({ state: 'unknown' });
    expect(
      controlStoreFor(f.db.sqlite).write(() =>
        commitRepairReservationStep(
          f.db,
          original,
          originalProposal,
          () => ({
            allocationRef: original.target.allocationRef,
            policyRevision: `sha256:${'c'.repeat(64)}`,
            allocation,
          }),
          true
        )
      )
    ).toEqual({ state: 'unknown' });
    expect(inspectRepairReservationStep(f.db, original, true)).toEqual({ state: 'absent' });
    const results = await Promise.all(
      prepared.map(async ({ intent, proposal }) =>
        controlStoreFor(f.db.sqlite).write(() =>
          commitRepairReservationStep(
            f.db,
            intent,
            proposal,
            (entry) => ({
              allocationRef: entry.target.allocationRef,
              policyRevision: entry.expectedGeneration,
              allocation,
            }),
            true
          )
        )
      )
    );
    const winner = results[0];
    expect(winner).toMatchObject({ state: 'reserved-now' });
    expect(results[1]).toEqual({ state: 'refused', reason: 'budget' });

    f.reopen();
    expect(inspectRepairReservationStep(f.db, original, true)).toEqual({
      ...winner,
      state: 'reserved',
    });
    expect(
      inspectRepairReservationStep(f.db, { ...original, inputDigest: 'changed' }, true)
    ).toEqual({ state: 'conflict' });
    expect(inspectRepairReservationStep(f.db, prepared[1]!.intent, false)).toEqual({
      state: 'refused',
      reason: 'budget',
    });
    const endedBeforeTerminal = await f.reader.readEndedSteps(original.target.entryStep.execution);
    expect(endedBeforeTerminal.map(({ control }) => control.kind)).toEqual(['admit', 'reserve']);
    if (winner?.state !== 'reserved-now') throw new Error('Repair fixture did not reserve.');
    const { reservation } = winner;
    const reserveSpan = prepared[0]!.proposal.span;
    const terminal: ExecutionJournalIntent = {
      ...prepared[0]!.proposal,
      stepId: 'candidate-terminal',
      inspectedStep: reservation.result.step,
      control: { ...prepared[0]!.proposal.control, kind: 'terminal-publication' },
      span: {
        ...openSpan(50),
        parentSpanId: prepared[0]!.proposal.execution.span.spanId,
        links: [
          {
            traceId: reserveSpan.traceId,
            spanId: reserveSpan.spanId,
            flags: 0,
            attributes: [],
            droppedAttributesCount: 0,
          },
        ],
      },
    };
    const outcome = { disposition: 'unknown', inputTokens: 18 } as const;
    const settle = (draft = terminal) =>
      f.db.sqlite.transaction(() =>
        commitRepairTerminalAuditInDb(f.db, reservation, draft, outcome)
      )();
    const contradictory = [
      { ...terminal, control: { ...terminal.control, actor: otherActor } },
      { ...terminal, control: { ...terminal.control, attemptId: 'substituted-attempt' } },
      {
        ...terminal,
        control: {
          ...terminal.control,
          permittingDecisionRef: testEntityId('pd', 'different-repair-decision'),
        },
      },
      { ...terminal, execution: prepared[1]!.proposal.execution },
      { ...terminal, inspectedStep: original.target.entryStep },
    ];
    for (const draft of contradictory) expect(settle(draft)).toEqual({ state: 'conflict' });
    f.db.sqlite.exec(`CREATE TRIGGER fixture_refuse_terminal BEFORE INSERT ON control_execution_steps
      WHEN NEW.step_id LIKE 'repair-terminal:%' BEGIN SELECT RAISE(ABORT, 'fixture refuse terminal'); END`);
    expect(settle).toThrow('fixture refuse terminal');
    expect(listServerAuditEvents(f.db)).toEqual([]);
    expect(inspectRepairReservationStep(f.db, original, false).state).toBe('reserved');
    f.db.sqlite.exec('DROP TRIGGER fixture_refuse_terminal');

    const recorded = settle();
    expect(recorded.state).toBe('settled');
    expect(settle()).toEqual(recorded);
    const divergent = f.db.sqlite.transaction(() =>
      commitRepairTerminalAuditInDb(f.db, reservation, terminal, {
        disposition: 'succeeded',
        inputTokens: 18,
      })
    )();
    expect(divergent).toEqual({ state: 'conflict' });
    f.reopen();
    if (recorded.state !== 'settled') throw new Error('Fixture did not persist terminal Audit.');
    expect(settle()).toEqual(recorded);
    for (const draft of contradictory) expect(settle(draft)).toEqual({ state: 'conflict' });
    expect(inspectRepairReservationStep(f.db, original, false)).toEqual({
      state: 'terminal',
      auditEventId: recorded.receipt,
    });
    expect(listServerAuditEvents(f.db)).toEqual([
      expect.objectContaining({
        id: recorded.receipt,
        action: 'repair.model-call',
        outcome: 'unknown',
        resource: `repair-call:${original.target.callId}`,
        permissionDecisionId: terminal.control.permittingDecisionRef,
      }),
    ]);
    const terminalStep = await f.reader.readInvocation({
      execution: original.target.entryStep.execution,
      stepId: `repair-terminal:${original.requestId}`,
    });
    expect(terminalStep.carriage.repairTerminal).toEqual({ version: 1, outcome });
    expect(terminalStep.control.outputRefs).toContain(recorded.receipt);

    const originalReserve = await f.reader.readInvocation(reservation.result.step);
    const midnight = new Date(Number(originalReserve.clock.admittedUnixNano / 1_000_000n));
    midnight.setUTCHours(24, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(midnight);
      const reserve = ({ intent, proposal }: ReturnType<typeof prepare>) =>
        controlStoreFor(f.db.sqlite).write(() =>
          commitRepairReservationStep(
            f.db,
            intent,
            proposal,
            (originalEntry) => ({
              allocationRef: originalEntry.target.allocationRef,
              policyRevision: originalEntry.expectedGeneration,
              allocation,
            }),
            true
          )
        );
      const nextDay = reserve(prepare(3));
      if (nextDay.state !== 'reserved-now') throw new Error('The UTC allowance did not roll over.');
      const { execution, stepId } = nextDay.reservation.result.step;
      const trigger = f.db.sqlite
        .prepare("SELECT sql FROM sqlite_schema WHERE name='control_execution_steps_settle_once'")
        .pluck()
        .get();
      if (typeof trigger !== 'string') throw new Error('Fixture needs the immutable step trigger.');
      f.db.sqlite.transaction(() => {
        f.db.sqlite.exec('DROP TRIGGER control_execution_steps_settle_once');
        f.db.sqlite
          .prepare(`UPDATE control_execution_steps
            SET invocation_json=json_set(invocation_json, '$.clock.admittedUnixNano', 'unreadable')
            WHERE execution_id=? AND step_id=?`)
          .run(execution.executionId, stepId);
        f.db.sqlite.exec(trigger);
      })();
      f.reopen();
      expect(f.db.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
      const blocked = prepare(4);
      expect(reserve(blocked)).toEqual({ state: 'unknown' });
      expect(inspectRepairReservationStep(f.db, blocked.intent, true)).toEqual({ state: 'absent' });
    } finally {
      vi.useRealTimers();
    }
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
